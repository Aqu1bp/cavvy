import { afterAll, expect, test } from "bun:test";
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
