import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import type { ServerEvent } from "../src/server/protocol";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { saveScript } = await import("../src/server/scripts");
afterAll(() => iso.cleanup());

const client = (window?: string) => ({ window, subs: new Set<string>(), send() {} });
const KEY = "0123456789abcdef0123456789abcdef";

test("a close from a reloaded window cancels a script still looking up its command", async () => {
    const engine = new Engine();
    const old = client(KEY), back = client(KEY), stranger = client("fedcba9876543210fedcba9876543210");
    for (const c of [old, back, stranger]) engine.clients.add(c);
    const cwd = tempDir("terminal-cancel-");
    const { script } = await saveScript(cwd, { name: "Dev", command: "echo must-not-run" });
    try {
        const opening = engine.handle(old, "scripts.run", { id: "pending", cwd, script: script.id, cols: 80, rows: 24 }).catch((e) => e);
        // A reconnect's attach can arrive before the old connection creates its shell.
        const attaching = engine.handle(back, "terminal.attach", { id: "pending" }).catch((e) => e);
        const wrongClose = engine.handle(stranger, "terminal.close", { id: "pending" }).catch((e) => e);
        // Keep the lookup pending until all requests have been dispatched; filesystem
        // speed must not decide whether this tests cancellation or live-shell takeover.
        const closing = engine.handle(back, "terminal.close", { id: "pending" });
        expect(await attaching).toMatchObject({ code: "terminal_not_open" });
        expect(await wrongClose).toMatchObject({ code: "terminal_not_open" });
        expect(await closing).toBeNull();
        expect(await opening).toMatchObject({ code: "terminal_not_open" });
        expect(await engine.handle(back, "terminal.list", {})).toEqual([]);
        // No cancellation tombstone survives the original lookup.
        expect((engine as any).openingTerminals.size).toBe(0);
    } finally { await engine.stop(); }
});

test("shutdown cancels script lookups before they can create a terminal", async () => {
    const engine = new Engine();
    const owner = client(KEY);
    engine.clients.add(owner);
    const cwd = tempDir("terminal-stop-lookup-");
    const { script } = await saveScript(cwd, { name: "Dev", command: "echo must-not-run" });
    const opening = engine.handle(owner, "scripts.run", { id: "pending-stop", cwd, script: script.id, cols: 80, rows: 24 }).catch((e) => e);
    await engine.stop();
    expect(await opening).toMatchObject({ code: "terminal_not_open" });
    expect((engine as any).terminals.list(owner)).toEqual([]);
});


async function until(check: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Login terminal timed out"); await Bun.sleep(20); }
}

test("persisted login keeps its server-built account environment, never replays secrets, and restores exited", async () => {
    const { saveAgentConfig } = await import("../src/providers/registry");
    const dir = tempDir("terminal-login-");
    const bin = join(dir, "fake-login");
    const folder = join(dir, "original-account");
    // No real CLI, credentials, network or shell startup files. The fixture's own
    // files prove PID/environment continuity even when its output is discarded.
    writeFileSync(bin, `#!/bin/sh
root="$1"
shift
if [ "$1" != auth ] || [ "$2" != login ]; then printf '{"loggedIn":false}\\n'; exit 0; fi
printf '%s|%s\\n' "$$" "$CLAUDE_CONFIG_DIR" >> "$root/starts"
printf 'secret-before\\n'
while [ ! -f "$root/away" ]; do sleep 0.02; done
printf 'secret-away\\n'
touch "$root/printed"
IFS= read -r line
printf 'env=%s\\n' "$CLAUDE_CONFIG_DIR"
while [ ! -f "$root/finish" ]; do sleep 0.02; done
printf 'secret-exit\\n'
exit 7
`);
    chmodSync(bin, 0o700);
    saveAgentConfig("claude-code", { path: bin, args: [dir], accounts: [{ id: "work", name: "Work", folder, managed: false }] });
    const engine = new Engine({ listModels: async () => [] });
    const viewer = () => {
        const events: ServerEvent[] = [];
        return { window: KEY, subs: new Set<string>(), events, send(e: ServerEvent) { events.push(e); },
            output: () => events.filter((e) => e.type === "terminal.data").map((e) => e.data).join("") };
    };
    const first = viewer(), back = viewer(), exited = viewer();
    for (const c of [first, back, exited]) engine.clients.add(c);
    try {
        // Untrusted environment/argv fields must not reach the login process.
        await engine.handle(first, "terminal.open", { id: "login", cwd: dir, cols: 80, rows: 24,
            login: { provider: "claude-code", accountId: "work", env: { CLAUDE_CONFIG_DIR: "client-injected" } },
            command: { argv: ["not-the-cli"], env: { CLAUDE_CONFIG_DIR: "client-injected" } } } as any);
        await until(() => first.output().includes("secret-before"));
        const original = readFileSync(join(dir, "starts"), "utf8");
        expect(original.trim().split("|")[1]).toBe(folder);
        engine.dropClient(first);
        // A later config change cannot alter an already-running login's env.
        saveAgentConfig("claude-code", { accounts: [{ id: "work", name: "Changed", folder: join(dir, "changed-account"), managed: false }] });
        writeFileSync(join(dir, "away"), "");
        await until(() => existsSync(join(dir, "printed")));
        await Bun.sleep(50);
        const listed = await engine.handle(back, "terminal.list", {});
        expect(listed).toHaveLength(1);
        expect(listed[0]?.login).toEqual({ provider: "claude-code", accountId: "work", name: "Work" });
        expect(JSON.stringify(listed)).not.toContain(folder);
        expect(await engine.handle(back, "terminal.attach", { id: "login", have: 0, login: { provider: "codex", accountId: "default" }, env: { CLAUDE_CONFIG_DIR: "client-injected" } } as any)).toEqual(listed[0]!);
        expect(back.events).toEqual([{ type: "terminal.data", id: "login", data: "", reset: true, pos: expect.any(Number) }]);
        await engine.handle(back, "terminal.write", { id: "login", data: "show\n" });
        await until(() => back.output().includes(`env=${folder}`));
        expect(back.output()).not.toContain("secret-");
        expect(readFileSync(join(dir, "starts"), "utf8")).toBe(original);
        engine.dropClient(back);
        writeFileSync(join(dir, "finish"), "");
        await until(() => (engine as any).terminals.list(exited)[0]?.exitCode === 7);
        const info = await engine.handle(exited, "terminal.attach", { id: "login" });
        expect(info.exitCode).toBe(7);
        expect(info.login).toEqual(listed[0]!.login);
        expect(exited.output()).toBe("");
        await expect(engine.handle(exited, "terminal.write", { id: "login", data: "again\n" })).rejects.toMatchObject({ code: "terminal_not_open" });
        expect(readFileSync(join(dir, "starts"), "utf8")).toBe(original);
    } finally { await engine.stop(); }
});
