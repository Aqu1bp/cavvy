import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { Tool, ToolContext, ToolState } from "../src/tools/types";
import type { WakeInput } from "../src/agent/wakes";

const iso = isolate();
const { SecretStore } = await import("../src/agent/secrets");
const { BashOutputTool, KillShellTool, killAllShells } = await import("../src/tools/bash");
const { MonitorTool, MAX_MONITORS, FLOOD_LINES } = await import("../src/tools/monitor");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { PermissionChecker } = await import("../src/permissions/checker");
const { WakeQueue, stopWatchers } = await import("../src/agent/wakes");
const { runHooks } = await import("../src/agent/hooks");

const dirs: string[] = [];
const states: ToolState[] = [];
afterAll(async () => {
    for (const state of states) await killAllShells({ state });
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    iso.cleanup();
});

type Wake = { source: string; key?: string; label: string; text: string; at: number };

function setup(o: { wakes?: boolean; secret?: string; undelivered?: boolean } = {}) {
    const dir = realpathSync(tempDir("harness-monitor-"));
    dirs.push(dir);
    const secrets = new SecretStore();
    if (o.secret) secrets.set("MONITOR_TOKEN", o.secret);
    const state: ToolState = { cwd: dir, projectRoot: dir, fileState: new Map(), todos: [], shells: new Map(), secrets };
    states.push(state);
    const woken: Wake[] = [];
    const dropped: string[] = [];
    // The real queue, noting what goes in (and taking back what's dropped). Delivered at once
    // (an agent took it) unless `undelivered`: then it waits in the queue, like when the user stopped the agent.
    const sink = new (class extends WakeQueue {
        override push(w: WakeInput) {
            woken.push({ ...w, at: Date.now() });
            if (o.undelivered) super.push(w);
        }
        override drop(key: string) {
            dropped.push(key);
            for (let i = woken.length - 1; i >= 0; i--) if (woken[i]!.key === key) woken.splice(i, 1);
            super.drop(key);
        }
    })();
    state.wakes = sink;
    state.watchers = new Map();
    const ctx = { state, settings: {}, signal: new AbortController().signal, mode: () => "default", setMode() {}, ui: {}, wakes: o.wakes === false ? undefined : sink } as ToolContext;
    return { dir, ctx, state, woken, dropped };
}

async function start(ctx: ToolContext, command: string, description = "test events", timeout_ms?: number) {
    const input = { command, description, ...(timeout_ms ? { timeout_ms } : {}) };
    const err = await MonitorTool.validate!(input, ctx);
    if (err) throw new Error(err);
    const r = await MonitorTool.run(input, ctx);
    const id = /\b(monitor_\d+)\b/.exec(r.content)![1]!;
    return { id, result: r, shell: ctx.state.shells.get(id)! };
}

async function until(cond: () => boolean, ms = 10_000) {
    for (const end = Date.now() + ms; Date.now() < end; ) {
        if (cond()) return;
        await Bun.sleep(10);
    }
    throw new Error("timed out waiting");
}

const node = (dir: string, body: string) => {
    const file = join(dir, `emit-${Math.random().toString(36).slice(2)}.cjs`);
    writeFileSync(file, `const pause = (ms) => new Promise(r => setTimeout(r, ms));\nconst out = (s) => new Promise(r => process.stdout.write(s, r));\nconst err = (s) => new Promise(r => process.stderr.write(s, r));\n(async () => { ${body} })();`);
    return `'${process.execPath}' --no-env-file '${file}'`;
};

describe("events", () => {
    test("lines close together are one notification; lines apart are separate ones", async () => {
        const { ctx, woken, dir } = setup();
        const { id, shell } = await start(ctx, node(dir, `await out("a\\n"); await pause(20); await out("b\\n"); await pause(700); await out("c\\n"); await pause(5000);`));
        await until(() => woken.length >= 2);
        expect(woken[0]!.text).toContain("a\nb\n");
        expect(woken[0]!.text).not.toContain("c\n");
        expect(woken[1]!.text).toContain("c\n");
        expect(woken[0]!).toMatchObject({ source: "monitor", key: `monitor:${id}`, label: "Monitor · test events" });
        expect(woken[0]!.text).toContain("not from the user");
        expect(shell.monitor!.events).toBe(3);
        await KillShellTool.run({ shell_id: id }, ctx);
    });

    test("stdout is the event stream; stderr isn't, but BashOutput has both", async () => {
        const { ctx, woken, dir } = setup();
        const { id } = await start(ctx, node(dir, `await err("warning on stderr\\n"); await out("event on stdout\\n"); await pause(5000);`));
        await until(() => woken.length >= 1);
        await Bun.sleep(300);
        expect(woken.length).toBe(1);
        expect(woken[0]!.text).toContain("event on stdout");
        expect(woken[0]!.text).not.toContain("warning on stderr");
        const out = await BashOutputTool.run({ bash_id: id }, ctx);
        expect(out.content).toContain("warning on stderr");
        expect(out.content).toContain("event on stdout");
        expect(out.content).toContain("<status>running</status>");
        await KillShellTool.run({ shell_id: id }, ctx);
    });

    test("blank lines are no event; colors are stripped; a progress bar shows its last state", async () => {
        const { ctx, woken } = setup();
        await start(ctx, `printf '\\n   \\n\\033[31mred\\033[0m\\n10%%\\r50%%\\r100%%\\n'`);
        await until(() => woken.some((w) => w.text.includes("ended")));
        const all = woken.map((w) => w.text).join("\n");
        expect(all).toContain("\nred\n");
        expect(all).not.toContain("\x1b[");
        expect(all).toContain("\n100%\n");
        expect(all).not.toContain("50%");
        expect(all).toContain("after 2 events");
    });

    test("progress frames aren't events: CRLF lines are, and a bar's last frame is at exit", async () => {
        const { ctx, woken } = setup();
        const { shell } = await start(ctx, `printf 'one\\r\\ntwo\\r\\n'; for i in $(seq 1 400); do printf '%s%%\\r' $i; done`);
        await until(() => woken.some((w) => w.text.includes("ended")));
        const all = woken.map((w) => w.text).join("\n");
        // 400 redraws would have flooded it.
        expect(shell.monitor!.events).toBe(3);
        expect(all).toContain("one\ntwo\n400%\n");
        expect(all).toContain("exited with code 0 after 3 events");
    });

    test("secrets are redacted in notifications", async () => {
        const secret = "hN8sR4uY2cF7jM9Qz";
        const { ctx, woken } = setup({ secret });
        await start(ctx, `echo "token=$MONITOR_TOKEN"`);
        await until(() => woken.some((w) => w.text.includes("ended")));
        const all = JSON.stringify(woken);
        expect(all).not.toContain(secret.slice(0, 8));
        expect(all).toContain("[REDACTED MONITOR_TOKEN]");
    });

    test("a long line is cut; a line over 64 KiB becomes a placeholder", async () => {
        const { ctx, woken, dir } = setup();
        await start(ctx, node(dir, `await out("x".repeat(5000) + "\\n"); await out("y".repeat(70000) + "\\n");`));
        await until(() => woken.some((w) => w.text.includes("ended")));
        const all = woken.map((w) => w.text).join("\n");
        expect(all).toContain(`${"x".repeat(1000)}… [4000 more characters]`);
        expect(all).not.toContain("y".repeat(1001));
        expect(all).toContain("[Output line omitted: exceeds 64 KiB]");
        expect(all.length).toBeLessThan(6000);
    });

    test("a burst is capped per notification and says how many lines it left out", async () => {
        const { ctx, woken, id } = await (async () => {
            const s = setup();
            const m = await start(s.ctx, `for i in $(seq 1 100); do echo "line $i"; done; sleep 5`);
            return { ...s, id: m.id };
        })();
        await until(() => woken.length >= 1);
        const t = woken[0]!.text;
        expect(t).toContain("line 1\n");
        expect(t).toContain("line 40\n");
        expect(t).not.toContain("line 41\n");
        expect(t).toContain(`(+60 more lines: read them with BashOutput bash_id "${id}")`);
        await KillShellTool.run({ shell_id: id }, ctx);
    });
});

describe("how it ends", () => {
    test("exit: pending lines go out with the exit code, in one notification", async () => {
        const { ctx, woken, state } = setup();
        const { id } = await start(ctx, `echo done-line`);
        await until(() => state.shells.get(id)!.exitCode !== null && woken.length > 0);
        await Bun.sleep(300);
        expect(woken.length).toBe(1);
        expect(woken[0]!.text).toContain("done-line");
        expect(woken[0]!.text).toContain("exited with code 0 after 1 event.");
        expect(woken[0]!.label).toBe("Monitor · test events · ended");
    });

    test("failure: the notice has the code and the last stderr lines", async () => {
        const { ctx, woken } = setup();
        await start(ctx, `for i in $(seq 1 15); do echo "err $i" >&2; done; exit 3`);
        await until(() => woken.length > 0);
        const t = woken[0]!.text;
        expect(t).toContain("exited with code 3 after 0 events");
        expect(t).toContain("err 15");
        expect(t).toContain("err 6");
        expect(t).not.toContain("err 5\n");
        expect(woken[0]!.label).toContain("exited 3");
    });

    test("killed by a signal: 128 + its number, and its name", async () => {
        const { ctx, woken, state } = setup();
        const { id } = await start(ctx, `kill -KILL $$`);
        await until(() => woken.length > 0);
        expect(woken[0]!.text).toContain("its command was killed by SIGKILL after 0 events");
        expect(state.shells.get(id)!.exitCode).toBe(137);
        expect(woken[0]!.label).toBe("Monitor · test events · was killed by SIGKILL");
    });

    test("KillShell after it ended keeps the notice of how it ended", async () => {
        const { ctx, woken, state, dropped } = setup({ undelivered: true });
        const { id } = await start(ctx, `echo last words; exit 1`);
        await until(() => state.shells.get(id)!.exitCode !== null && woken.length > 0);
        await KillShellTool.run({ shell_id: id }, ctx);
        expect(dropped).not.toContain(`monitor:${id}`);
        expect(state.wakes!.pending().map((w) => w.text).join("\n")).toContain("exited with code 1");
    });

    test("a command that isn't there ends with 127", async () => {
        const { ctx, woken } = setup();
        await start(ctx, `definitely-not-a-command-xyz`);
        await until(() => woken.length > 0);
        expect(woken[0]!.text).toContain("exited with code 127");
        expect(woken[0]!.text).toMatch(/not found/);
    });

    test("expiry kills it and says so once, with what was still pending", async () => {
        const { ctx, woken, state } = setup();
        const { id, result } = await start(ctx, `echo first; sleep 60`, "slow thing", 1000);
        expect(result.display?.summary).toBe(`Watching as ${id} · expires in 1s`);
        await until(() => state.shells.get(id)!.exitCode !== null, 8000);
        await Bun.sleep(100);
        const texts = woken.map((w) => w.text).join("\n");
        expect(texts).toContain("first");
        expect(texts).toContain(`Monitor ${id} (slow thing) expired after 1s with 1 event.`);
        expect(woken.filter((w) => w.label.endsWith("expired")).length).toBe(1);
    });

    test("timeout is clamped and the cap is reported", async () => {
        const { ctx } = setup();
        const { id, result } = await start(ctx, `sleep 30`, "capped", 99_999_999);
        expect(result.content).toContain("expires in 30m");
        expect(result.content).toContain("is over the limit");
        const sh = ctx.state.shells.get(id)!;
        expect(sh.monitor!.expiresAt - sh.startedAt).toBe(1_800_000);
        await KillShellTool.run({ shell_id: id }, ctx);
    });

    test("KillShell stops it without a notification and drops what wasn't delivered", async () => {
        const { ctx, woken, dropped, dir } = setup();
        const { id, shell } = await start(ctx, node(dir, `for (let i = 0; i < 50; i++) { await out("tick " + i + "\\n"); await pause(30); }`));
        await until(() => shell.monitor!.events > 0);
        const r = await KillShellTool.run({ shell_id: id }, ctx);
        expect(r.content).toContain(`Killed ${id}`);
        await Bun.sleep(400);
        expect(dropped).toContain(`monitor:${id}`);
        expect(woken.length).toBe(0);
        expect(ctx.state.shells.has(id)).toBe(false);
    });

    test("stopWatchers (/clear, resume, close) stops monitors quietly and forgets them", async () => {
        const { ctx, woken, state } = setup();
        const a = await start(ctx, `sleep 30`);
        expect(state.watchers!.get(a.id)).toMatchObject({ kind: "monitor", label: "test events" });
        stopWatchers(state);
        await until(() => a.shell.exitCode !== null);
        await Bun.sleep(200);
        expect(woken.length).toBe(0);
        expect(state.shells.has(a.id)).toBe(false);
    });

    test("a monitor that ended is no longer a watcher", async () => {
        const { ctx, woken, state } = setup();
        const a = await start(ctx, `echo hi`);
        await until(() => woken.length > 0);
        expect(state.watchers!.has(a.id)).toBe(false);
    });

    test("when its command exits, what the command left running in the background is stopped too", async () => {
        const { ctx, woken, dir } = setup();
        const late = join(dir, "late-write");
        await start(ctx, `(sleep 1; touch '${late}') >/dev/null 2>&1 & exit 0`);
        await until(() => woken.some((w) => w.text.includes("exited with code 0")));
        await Bun.sleep(1800);
        expect(existsSync(late)).toBe(false);
    });

    test("closing the session stops every monitor quietly", async () => {
        const { ctx, woken, state } = setup();
        const a = await start(ctx, `sleep 30`);
        const b = await start(ctx, `tail -f /dev/null`);
        await killAllShells({ state });
        await until(() => a.shell.exitCode !== null && b.shell.exitCode !== null);
        await Bun.sleep(200);
        expect(woken.length).toBe(0);
    });
});

describe("limits", () => {
    test("while a notification waits undelivered, new lines join it instead of queueing more", async () => {
        const { ctx, woken, dir, state } = setup({ undelivered: true });
        state.wakes!.pause();
        const { id, shell } = await start(ctx, node(dir, `for (let i = 1; i <= 40; i++) await out("event " + i + "\\n"); for (let i = 41; i <= 45; i++) { await pause(300); await out("event " + i + "\\n"); }`));
        await until(() => shell.exitCode !== null);
        await Bun.sleep(100);
        const pending = state.wakes!.pending();
        expect(pending.length).toBe(1);
        expect(pending[0]!.key).toBe(`monitor:${id}`);
        // The first 40 lines, a count of the rest, and how it ended: bounded however long it waited.
        expect(pending[0]!.text).toContain("event 1\n");
        expect(pending[0]!.text).toContain("event 40\n");
        expect(pending[0]!.text).not.toContain("event 41\n");
        expect(pending[0]!.text).toContain("(+5 more lines");
        expect(pending[0]!.text).toContain("exited with code 0 after 45 events");
        expect(pending[0]!.label).toBe("Monitor · test events · ended");
        // Each later batch replaced the waiting one: one push per batch, one notification left.
        expect(woken.length).toBe(1);
    });

    test("a firehose is stopped within the first window, with one notice", async () => {
        const { ctx, woken } = setup();
        const t0 = Date.now();
        const { shell, id } = await start(ctx, `yes "spam line"`);
        await until(() => shell.exitCode !== null, 8000);
        expect(Date.now() - t0).toBeLessThan(5000);
        await Bun.sleep(300);
        const stops = woken.filter((w) => w.label.includes("too much output"));
        expect(stops.length).toBe(1);
        expect(stops[0]!.text).toContain(`Monitor ${id} (test events) was stopped`);
        expect(stops[0]!.text).toContain("tighter filter");
        // Events up to the limit, nothing read after it.
        expect(shell.monitor!.events).toBe(FLOOD_LINES + 1);
    });

    test(`at most ${MAX_MONITORS} run at once`, async () => {
        const { ctx } = setup();
        const ids: string[] = [];
        for (let i = 0; i < MAX_MONITORS; i++) ids.push((await start(ctx, `sleep 30`, `watch ${i}`)).id);
        const err = await MonitorTool.validate!({ command: "sleep 1", description: "one too many" }, ctx);
        expect(err).toContain(`${MAX_MONITORS} monitors are already running`);
        expect(err).toContain("watch 0");
        await KillShellTool.run({ shell_id: ids[0]! }, ctx);
        expect(await MonitorTool.validate!({ command: "sleep 1", description: "fits now" }, ctx)).toBeUndefined();
        for (const id of ids.slice(1)) await KillShellTool.run({ shell_id: id }, ctx);
    });

    test("input checks: a description is required; no wakes, no monitor", async () => {
        const { ctx } = setup();
        expect(await MonitorTool.validate!({ command: "x", description: "  " }, ctx)).toContain("description");
        expect(await MonitorTool.validate!({ command: " ", description: "d" }, ctx)).toContain("command");
        expect(await MonitorTool.validate!({ command: "x", description: "d", allowedHosts: ["https://x.com/a"] }, ctx)).toContain("allowedHosts");
        const none = setup({ wakes: false });
        expect(await MonitorTool.validate!({ command: "x", description: "d" }, none.ctx)).toContain("Monitor isn't available here");
    });

    test("title shows what it watches", () => {
        expect(MonitorTool.title({ command: "tail -f a.log", description: "errors in a.log" })).toBe("Monitor(errors in a.log)");
    });
});

describe("permissions: a Monitor command is checked like the same Bash command", () => {
    test("PreToolUse hooks for Bash run for Monitor too", async () => {
        const dir = realpathSync(tempDir("harness-monitor-hook-"));
        dirs.push(dir);
        const settings = { hooks: { PreToolUse: [{ matcher: "Bash", command: "echo no shell for you >&2; exit 2" }] } };
        const h = await runHooks(settings as never, "PreToolUse", { tool_name: "Monitor", tool_input: { command: "tail -f x" } }, dir);
        expect(h.blocked).toBe("no shell for you");
        const re = await runHooks({ hooks: { PreToolUse: [{ matcher: "Bash|Write", command: "exit 2" }] } } as never, "PreToolUse", { tool_name: "Monitor" }, dir);
        expect(re.blocked).toBeDefined();
        const other = await runHooks({ hooks: { PreToolUse: [{ matcher: "Write", command: "exit 2" }] } } as never, "PreToolUse", { tool_name: "Monitor" }, dir);
        expect(other.blocked).toBeUndefined();
    });

    const tool = BUILTIN_TOOLS.find((t) => t.name === "Monitor") as Tool<any>;
    const mk = (perms: { allow?: string[]; deny?: string[]; ask?: string[] }) => {
        const dir = realpathSync(tempDir("harness-monitor-perm-"));
        dirs.push(dir);
        return { checker: new PermissionChecker(() => ({ permissions: { allow: [], deny: [], ask: [], ...perms } }), dir), dir };
    };
    const input = (command: string) => ({ command, description: "d" });

    test("Bash allow and deny rules cover it", () => {
        const { checker, dir } = mk({ allow: ["Bash(tail:*)"], deny: ["Bash(rm:*)"] });
        expect(checker.check(tool, input("tail -f app.log"), "default", dir).behavior).toBe("allow");
        expect(checker.check(tool, input("rm -rf build"), "bypassPermissions", dir).behavior).toBe("deny");
        expect(checker.check(tool, input("npm run watch"), "default", dir).behavior).toBe("ask");
    });

    test("Monitor rules work too", () => {
        const { checker, dir } = mk({ deny: ["Monitor"] });
        expect(checker.check(tool, input("tail -f app.log"), "bypassPermissions", dir).behavior).toBe("deny");
        const b = mk({ allow: ["Monitor(tail:*)"] });
        expect(b.checker.check(tool, input("tail -f app.log"), "default", b.dir).behavior).toBe("allow");
    });

    test("plan mode allows read-only commands only; dangerous ones ask", () => {
        const { checker, dir } = mk({});
        expect(checker.check(tool, input("rm -rf build"), "plan", dir).behavior).toBe("deny");
        expect(checker.check(tool, input("tail -f app.log | grep --line-buffered ERROR"), "plan", dir).behavior).not.toBe("deny");
        expect(checker.check(tool, input("rm -rf /"), "bypassPermissions", dir)).toMatchObject({ behavior: "ask", dangerous: true });
    });

    test("an approval offers a Bash rule for the command", () => {
        const { checker, dir } = mk({});
        const d = checker.check(tool, input("npm run watch"), "default", dir);
        expect(d.suggestions?.some((s) => s.startsWith("Bash("))).toBe(true);
    });
});
