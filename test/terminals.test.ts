import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { parseTabs, restoreTabs } from "../gui/src/lib/terminal";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const { Terminals, terminalEnv, terminalSize } = await import("../src/server/terminals");
import type { ServerEvent } from "../src/server/protocol";

// A plain shell with an empty home: none of the user's own startup files run. Named, not /bin/sh
// (bash on macOS, dash on Ubuntu): dash has job control, and so Ctrl-C and resizes reach the
// foreground job, only when the PTY is its controlling terminal, where bash would hide its absence.
const SHELL = "/bin/dash";
const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
beforeAll(() => {
    process.env.SHELL = SHELL;
    process.env.HOME = tempDir("terminal-home-");
    // zsh, in the test below, offers to set itself up where it finds no startup files.
    writeFileSync(join(process.env.HOME, ".zshrc"), "");
});
afterAll(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    iso.cleanup();
});

async function until(check: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Terminal timed out"); await Bun.sleep(20); }
}
/** A window's connection; with `window`, the window's key. */
function client(window?: string) {
    const events: ServerEvent[] = [];
    const data = () => events.filter((e) => e.type === "terminal.data");
    return { events, window, send: (event: ServerEvent) => events.push(event), output: () => data().map((e) => e.data).join(""), pos: () => data().at(-1)?.pos };
}
const gone = (pid: number) => { try { process.kill(pid, 0); return false; } catch { return true; } };

describe("embedded terminals", () => {
    test("large pastes preserve Unicode across RPC boundaries", async () => {
        const { terminalInputChunks } = await import("../gui/src/lib/terminal");
        const input = "x".repeat(16383) + "😀" + "y".repeat(16382) + "🚀";
        const chunks = [...terminalInputChunks(input)];
        expect(chunks.every((s) => s.length <= 16384)).toBe(true);
        expect(chunks.map((s) => Buffer.from(s).toString()).join("")).toBe(input);
    });
    test("rejects invalid dimensions", () => {
        for (const [cols, rows] of [[0, 24], [80, 0], [501, 24], [80, 301], [1.5, 24], [NaN, 24], [80, Infinity], ["80", 24]]) expect(() => terminalSize(cols, rows)).toThrow();
        expect(terminalSize(80, 24)).toEqual({ cols: 80, rows: 24 });
    });
    test("user shells preserve inherited account selectors while login commands keep only their selected one", async () => {
        const shells = new Terminals();
        const command = 'printf "__selectors__%s|%s__end__\\n" "${CLAUDE_CONFIG_DIR-unset}" "${CODEX_HOME-unset}"';
        // isolate() supplies inherited selectors for the user-operated shell.
        expect(process.env.CLAUDE_CONFIG_DIR).toBeTruthy();
        expect(process.env.CODEX_HOME).toBeTruthy();
        try {
            const setup = client();
            shells.open(setup, "setup-env", iso.home, 80, 24, { input: `${command}\nexit\n` });
            shells.arm(setup, "setup-env");
            await until(() => setup.events.some((e) => e.type === "terminal.exit"));
            expect(setup.output()).toContain(`__selectors__${process.env.CLAUDE_CONFIG_DIR}|${process.env.CODEX_HOME}__end__`);
            for (const selector of ["CLAUDE_CONFIG_DIR", "CODEX_HOME"]) {
                const login = client();
                shells.open(login, `login-${selector.replaceAll("_", "-")}`, iso.home, 80, 24, {
                    command: { argv: ["/bin/sh", "-c", command], env: { [selector]: iso.home } },
                });
                await until(() => login.events.some((e) => e.type === "terminal.exit"));
                expect(login.output()).toContain(selector === "CLAUDE_CONFIG_DIR"
                    ? `__selectors__${iso.home}|unset__end__`
                    : `__selectors__unset|${iso.home}__end__`);
            }
        } finally { shells.stop(); }
    });
    test("terminal selectors preserve unset, empty, relative and absolute values exactly", async () => {
        const keys = ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME"];
        const old = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
        const { childEnv } = await import("../src/util/env");
        try {
            for (const value of [undefined, "", "relative/profile", iso.home]) {
                for (const key of keys) {
                    if (value === undefined) delete process.env[key]; else process.env[key] = value;
                }
                for (const key of keys) {
                    expect(terminalEnv()[key]).toBe(value);
                    expect(Object.hasOwn(terminalEnv(), key)).toBe(value !== undefined);
                    expect(terminalEnv(false)[key]).toBeUndefined();
                    expect(childEnv({ [key]: "cannot-reintroduce" })[key]).toBeUndefined();
                }
            }
        } finally { for (const [k, v] of Object.entries(old)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    });
    test("closing terminals keep their cwd reserved until process cleanup finishes", async () => {
        const shells = new Terminals(); const owner = client();
        try {
            shells.open(owner, "reserved-root", iso.home, 80, 24);
            expect(shells.projectRoots()).toContain(iso.home);
            shells.close(owner, "reserved-root");
            expect(shells.projectRoots()).toContain(iso.home);
            await shells.stop();
            expect(shells.projectRoots()).toEqual([]);
        } finally { await shells.stop(); }
    });
    test("a real PTY has the selected cwd, interactive input, resize, Ctrl-C and exit status", async () => {
        const shells = new Terminals(); const owner = client();
        try {
            shells.open(owner, "terminal-1", iso.home, 90, 28);
            shells.write(owner, "terminal-1", "printf '__cwd__'; pwd; test -t 0 && printf '__tty__\\n'\n");
            await until(() => owner.output().includes(`__cwd__${realpathSync(iso.home)}`) && owner.output().includes("__tty__\r\n"));
            shells.resize(owner, "terminal-1", 104, 31);
            shells.write(owner, "terminal-1", "stty size\n");
            await until(() => owner.output().includes("31 104\r\n"));
            shells.write(owner, "terminal-1", "printf '__%s__\\n' sleeping; sleep 30\n");
            await until(() => owner.output().includes("__sleeping__\r\n"));
            shells.write(owner, "terminal-1", "\x03");
            shells.write(owner, "terminal-1", "printf '__after_interrupt__\\n'\n");
            await until(() => owner.output().includes("__after_interrupt__\r\n"));
            shells.write(owner, "terminal-1", "exit 7\n");
            await until(() => owner.events.some((e) => e.type === "terminal.exit" && e.exitCode === 7));
            expect(() => shells.write(owner, "terminal-1", "x")).toThrow("not open");
        } finally { shells.stop(); }
    });
    test("the PTY is the controlling terminal of each shell, and of a login command, so Ctrl-C reaches the foreground job", async () => {
        const shells = new Terminals();
        try {
            // macOS has all three; Ubuntu has dash and bash.
            for (const shell of ["/bin/dash", "/bin/bash", "/bin/zsh"].filter((path) => existsSync(path))) {
                process.env.SHELL = shell;
                const owner = client(); const id = `ctty-${shell.split("/").at(-1)}`;
                shells.open(owner, id, iso.home, 80, 24);
                shells.write(owner, id, "(exec 3</dev/tty) && printf '__%s__\\n' ctty; printf '__%s__\\n' sleeping; sleep 30\n");
                await until(() => owner.output().includes("__sleeping__\r\n"));
                expect(owner.output()).toContain("__ctty__\r\n");
                shells.write(owner, id, "\x03");
                shells.write(owner, id, "printf '__%s__\\n' interrupted\n");
                await until(() => owner.output().includes("__interrupted__\r\n"));
                shells.close(owner, id);
            }
            const login = client();
            shells.open(login, "ctty-login", iso.home, 80, 24, { command: { argv: ["/bin/sh", "-c", "(exec 3</dev/tty) && printf '__%s__\\n' ctty"], env: {} } });
            await until(() => login.events.some((e) => e.type === "terminal.exit"));
            expect(login.output()).toContain("__ctty__\r\n");
        } finally {
            process.env.SHELL = SHELL;
            await shells.stop();
        }
    }, 20_000);
    test("a Ctrl-C the window sends as the terminal opens, before the shell has started, doesn't stop the shell", async () => {
        const shells = new Terminals(); const owner = client();
        try {
            shells.open(owner, "early-ctrl-c", iso.home, 80, 24);
            shells.write(owner, "early-ctrl-c", "\x03");
            shells.write(owner, "early-ctrl-c", "printf '__%s__\\n' alive\n");
            await until(() => owner.output().includes("__alive__\r\n"));
            expect(owner.events.some((e) => e.type === "terminal.exit")).toBe(false);
        } finally { await shells.stop(); }
    });
    test("a command's last output, written just before it exits, arrives before its exit", async () => {
        // On Linux the PTY can still hold it when the process has exited: in CI, 5 of 300 such
        // commands had lost it when its exit was reported, before the terminal waited for the PTY's end.
        const shells = new Terminals();
        try {
            for (let i = 0; i < 100; i++) {
                const owner = client();
                shells.open(owner, `fast-${i}`, iso.home, 80, 24, { command: { argv: ["/bin/sh", "-c", "printf '__%s__' fast"], env: {} } });
                await until(() => owner.events.some((e) => e.type === "terminal.exit"));
                expect(owner.output()).toContain("__fast__");
                shells.close(owner, `fast-${i}`);
            }
        } finally { await shells.stop(); }
    }, 30_000);
    test("another window cannot write, resize or close; a connection without a window key closes its own shells only as it goes", async () => {
        const shells = new Terminals(); const owner = client(); const other = client();
        try {
            shells.open(owner, "owned", iso.home, 80, 24);
            shells.open(other, "other", iso.home, 80, 24);
            shells.write(owner, "owned", "echo __pid__$$\n");
            await until(() => /__pid__\d+/.test(owner.output()));
            const pid = Number(owner.output().match(/__pid__(\d+)/)![1]);
            expect(() => shells.write(other, "owned", "exit\n")).toThrow("not open");
            // An expected refusal, not a server error.
            try { shells.write(other, "owned", "x"); } catch (e) { expect((e as { code?: string }).code).toBe("terminal_not_open"); }
            expect(() => shells.resize(other, "owned", 80, 24)).toThrow("not open");
            expect(() => shells.close(other, "owned")).toThrow("not open");
            expect(() => shells.open(owner, "owned", iso.home, 80, 24)).toThrow("duplicate");
            expect(() => shells.write(owner, "owned", "x".repeat(65_537))).toThrow("too large");
            shells.drop(owner);
            expect(() => shells.write(owner, "owned", "x")).toThrow("not open");
            // Nothing can come back for it: it's stopped, and nobody can attach to it.
            await until(() => gone(pid));
            expect(() => shells.attach(owner, "owned")).toThrow("not open");
            shells.write(other, "other", "printf '__still_running__\\n'\n");
            await until(() => other.output().includes("__still_running__\r\n"));
            expect(owner.events.some((e) => e.type === "terminal.data" && e.id === "other")).toBe(false);
            shells.stop();
            expect(() => shells.write(other, "other", "x")).toThrow("not open");
        } finally { shells.stop(); }
    });
    test("closing a terminal hangs up its foreground job", async () => {
        const shells = new Terminals(); const owner = client();
        try {
            shells.open(owner, "hangup", iso.home, 80, 24);
            // One per line: bash 3.2 (macOS's /bin/sh) takes "$!;" for history expansion.
            shells.write(owner, "hangup", "sleep 30 &\necho __pid__$!\nwait\n");
            await until(() => /__pid__(\d+)/.test(owner.output()));
            const pid = Number(owner.output().match(/__pid__(\d+)/)![1]);
            shells.close(owner, "hangup");
            await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
        } finally { shells.stop(); }
    }, 20_000);
    test("output the window hasn't drawn is held back, keeping its latest part, until it catches up", async () => {
        const shells = new Terminals(); const owner = client();
        const done = join(tempDir("terminal-flood-"), "done");
        const sent = () => owner.output().length;
        try {
            shells.open(owner, "flood", iso.home, 80, 24);
            // Markers printed as "__%s__" so the shell's echo of the command doesn't match.
            shells.write(owner, "flood", `yes | head -c 3000000; touch '${done}'; printf '__%s__\\n' end\n`);
            await until(() => existsSync(done));
            await Bun.sleep(200);
            // Nothing was acked: what was sent stops near the limit.
            expect(sent()).toBeGreaterThan(900_000);
            expect(sent()).toBeLessThan(1_100_000);
            expect(owner.output()).not.toContain("__end__");
            // Another window's ack counts for nothing.
            const other = client();
            shells.ack(other, "flood", sent());
            await Bun.sleep(50);
            expect(owner.output()).not.toContain("__end__");
            expect(() => shells.ack(owner, "flood", -1)).toThrow("Invalid");
            shells.ack(owner, "flood", sent());
            await until(() => owner.output().includes("__end__\r\n"));
            expect(owner.output()).toMatch(/\[[\d,]+ characters of output skipped while the terminal caught up\]/);
            expect(sent()).toBeLessThan(1_400_000);
            // Caught up, it flows again.
            shells.ack(owner, "flood", sent());
            shells.write(owner, "flood", "printf '__%s__\\n' again\n");
            await until(() => owner.output().includes("__again__\r\n"));
            // Acks for one that has gone are ignored.
            shells.close(owner, "flood");
            shells.ack(owner, "flood", 10);
        } finally { shells.stop(); }
    }, 20_000);
    test("a shell gets the user's environment, not the agent tools' or the outer terminal's", () => {
        const keys = ["TMUX", "TERM_PROGRAM", "ITERM_SESSION_ID", "VSCODE_PID", "PAGER", "GIT_PAGER", "GIT_TERMINAL_PROMPT"] as const;
        const before = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
        try {
            Object.assign(process.env, { TMUX: "/tmp/tmux-1/default,1,0", TERM_PROGRAM: "iTerm.app", ITERM_SESSION_ID: "w0", VSCODE_PID: "1", PAGER: "less -R" });
            delete process.env.GIT_PAGER;
            delete process.env.GIT_TERMINAL_PROMPT;
            const env = terminalEnv();
            for (const k of ["TMUX", "ITERM_SESSION_ID", "VSCODE_PID", "GIT_PAGER", "GIT_TERMINAL_PROMPT", "HARNESS"]) expect(env[k]).toBeUndefined();
            expect(env.PAGER).toBe("less -R");
            expect(env.TERM_PROGRAM).toBe("Harness");
            expect(env.TERM).toBe("xterm-256color");
        } finally { for (const k of keys) if (before[k] === undefined) delete process.env[k]; else process.env[k] = before[k]; }
    });
});

describe("terminals that outlive their window's connection", () => {
    const KEY = "0123456789abcdef0123456789abcdef";
    const OTHER = "fedcba9876543210fedcba9876543210";
    const pidOf = async (c: ReturnType<typeof client>) => {
        await until(() => /__pid__\d+/.test(c.output()));
        return Number(c.output().match(/__pid__(\d+)/)![1]);
    };

    test("a dropped connection leaves the shell running; the window's key attaches to it again, with its output; no other key or connection can", async () => {
        const shells = new Terminals(); const first = client(KEY);
        try {
            shells.open(first, "kept", iso.home, 80, 24);
            shells.write(first, "kept", "printf '__%s__\\n' before; echo __pid__$$\n");
            await until(() => first.output().includes("__before__\r\n"));
            const pid = await pidOf(first);
            shells.drop(first);
            await Bun.sleep(200);
            expect(gone(pid)).toBe(false);
            expect(() => shells.write(first, "kept", "x")).toThrow("not open");
            // A wrong key, or none: not listed, and refused.
            for (const stranger of [client(OTHER), client()]) {
                expect(shells.list(stranger)).toEqual([]);
                for (const call of [() => shells.attach(stranger, "kept"), () => shells.write(stranger, "kept", "exit\n"), () => shells.resize(stranger, "kept", 80, 24), () => shells.close(stranger, "kept"), () => shells.arm(stranger, "kept")]) {
                    expect(call).toThrow("not open");
                }
            }
            const back = client(KEY);
            expect(shells.list(back)).toEqual([{ id: "kept", cwd: iso.home }]);
            // Listed, not attached: not typed into yet.
            expect(() => shells.write(back, "kept", "x")).toThrow("not open");
            expect(shells.attach(back, "kept")).toEqual({ id: "kept", cwd: iso.home });
            const replay = back.events[0]!;
            expect(replay).toMatchObject({ type: "terminal.data", id: "kept", reset: true });
            expect(back.output()).toContain("__before__\r\n");
            shells.write(back, "kept", "printf '__%s__\\n' after\n");
            await until(() => back.output().includes("__after__\r\n"));
            expect(first.output()).not.toContain("__after__");
            // Closing the tab stops it.
            shells.close(back, "kept");
            await until(() => gone(pid));
            expect(shells.list(back)).toEqual([]);
        } finally { shells.stop(); }
    });

    test("a reconnect that says how much it has gets only the rest; one whose part has left the buffer gets all that's kept, after a reset, within the bound", async () => {
        const shells = new Terminals(); const first = client(KEY);
        const done = join(tempDir("terminal-away-"), "done");
        try {
            shells.open(first, "rest", iso.home, 80, 24);
            shells.write(first, "rest", "printf '__%s__\\n' one\n");
            await until(() => first.output().includes("__one__\r\n"));
            await Bun.sleep(100);
            const have = first.pos()!;
            shells.write(first, "rest", "sleep 0.3; printf '__%s__\\n' two\n");
            // Gone before the command's echo arrives, let alone its output.
            shells.drop(first);
            await Bun.sleep(700);
            const again = client(KEY);
            shells.attach(again, "rest", have);
            expect(again.events).toHaveLength(1);
            expect(again.events[0]).not.toHaveProperty("reset");
            expect(again.output()).not.toContain("__one__");
            expect(again.output()).toContain("__two__\r\n");
            expect(again.output().startsWith("sleep 0.3")).toBe(true);
            // Nothing new: nothing sent.
            await Bun.sleep(100);
            const now = client(KEY);
            shells.attach(now, "rest", again.pos());
            expect(now.events).toHaveLength(0);
            expect(() => shells.attach(now, "rest", -1)).toThrow("Invalid");
            // Far more than is kept, while away: what's kept is bounded, and starts at a line.
            shells.write(now, "rest", `yes 0123456789 | head -c 3000000; touch '${done}'; printf '__%s__\\n' end\n`);
            shells.drop(now);
            await until(() => existsSync(done));
            await Bun.sleep(300);
            const late = client(KEY);
            shells.attach(late, "rest", have);
            expect(late.events).toHaveLength(1);
            expect(late.events[0]).toMatchObject({ reset: true });
            expect(late.output().length).toBeLessThanOrEqual(1_250_000 + 65_536);
            expect(late.output().length).toBeGreaterThan(900_000);
            expect(late.output().slice(0, 12)).toBe("0123456789\r\n");
            expect(late.output().includes("__end__\r\n")).toBe(true);
            expect(late.output().includes("__two__")).toBe(false);
            // Claiming more than there is: everything kept.
            const odd = client(KEY);
            shells.attach(odd, "rest", late.pos()! + 10);
            expect(odd.events[0]).toMatchObject({ reset: true });
        } finally { shells.stop(); }
    }, 20_000);

    test("flow control after reattaching: the replay counts, held output keeps its latest part, and acks release it", async () => {
        const shells = new Terminals(); const first = client(KEY);
        const done = join(tempDir("terminal-reflood-"), "done");
        try {
            shells.open(first, "reflood", iso.home, 80, 24);
            shells.drop(first);
            const back = client(KEY);
            shells.attach(back, "reflood");
            shells.write(back, "reflood", `yes | head -c 3000000; touch '${done}'; printf '__%s__\\n' end\n`);
            await until(() => existsSync(done));
            await Bun.sleep(200);
            const sent = () => back.output().length;
            expect(sent()).toBeGreaterThan(900_000);
            expect(sent()).toBeLessThan(1_100_000);
            expect(back.output()).not.toContain("__end__");
            // The connection it was taken from has no say.
            shells.ack(first, "reflood", sent());
            await Bun.sleep(50);
            expect(back.output()).not.toContain("__end__");
            shells.ack(back, "reflood", sent());
            await until(() => back.output().includes("__end__\r\n"));
            expect(back.output()).toMatch(/\[[\d,]+ characters of output skipped while the terminal caught up\]/);
            expect(back.events.filter((e) => e.type === "terminal.data").at(-1)).toMatchObject({ reset: true });
            expect(sent()).toBeLessThan(1_400_000);
        } finally { shells.stop(); }
    }, 20_000);

    test("the newest connection with the key takes it; the old one is told, can't use it, and its late close leaves it be", async () => {
        const shells = new Terminals(); const old = client(KEY);
        try {
            shells.open(old, "moving", iso.home, 80, 24);
            shells.write(old, "moving", "echo __pid__$$\n");
            const pid = await pidOf(old);
            const reloaded = client(KEY);
            shells.attach(reloaded, "moving", old.pos());
            expect(old.events.at(-1)).toEqual({ type: "terminal.moved", id: "moving" });
            for (const call of [() => shells.write(old, "moving", "exit\n"), () => shells.resize(old, "moving", 80, 24), () => shells.close(old, "moving")]) expect(call).toThrow("not open");
            // The old socket's close arrives after the reloaded window attached.
            shells.drop(old);
            shells.write(reloaded, "moving", "printf '__%s__\\n' still\n");
            await until(() => reloaded.output().includes("__still__\r\n"));
            expect(gone(pid)).toBe(false);
            expect(old.output()).not.toContain("__still__");
        } finally { shells.stop(); }
    });

    test("a window that doesn't come back in time: its shells are stopped", async () => {
        const shells = new Terminals({ graceMs: 300 }); const first = client(KEY);
        try {
            shells.open(first, "expiring", iso.home, 80, 24);
            shells.write(first, "expiring", "sleep 30 &\necho __pid__$$ __job__$!\nwait\n");
            await until(() => /__job__\d+/.test(first.output()));
            const pid = await pidOf(first);
            const job = Number(first.output().match(/__job__(\d+)/)![1]);
            shells.drop(first);
            await until(() => gone(pid) && gone(job));
            const back = client(KEY);
            expect(shells.list(back)).toEqual([]);
            expect(() => shells.attach(back, "expiring")).toThrow("not open");
            // Attaching in time stops the clock.
            shells.open(back, "saved", iso.home, 80, 24);
            shells.drop(back);
            const again = client(KEY);
            shells.attach(again, "saved");
            await Bun.sleep(600);
            expect(shells.list(again)).toEqual([{ id: "saved", cwd: iso.home }]);
        } finally { shells.stop(); }
    });

    test("a shell that exits while its window is away comes back with its output and exit code, and counts toward the limit until closed", async () => {
        const shells = new Terminals(); const first = client(KEY);
        try {
            shells.open(first, "exits", iso.home, 80, 24);
            shells.write(first, "exits", "sleep 0.3; printf '__%s__\\n' bye; exit 3\n");
            shells.drop(first);
            await Bun.sleep(900);
            const back = client(KEY);
            expect(shells.list(back)).toEqual([{ id: "exits", cwd: iso.home, exitCode: 3 }]);
            expect(shells.attach(back, "exits")).toEqual({ id: "exits", cwd: iso.home, exitCode: 3 });
            expect(back.output()).toContain("__bye__\r\n");
            expect(() => shells.write(back, "exits", "x")).toThrow("not open");
            for (let i = 1; i < 12; i++) shells.open(back, `more-${i}`, iso.home, 80, 24);
            expect(() => shells.open(back, "twelfth", iso.home, 80, 24)).toThrow("Close a terminal");
            // Another window has its own twelve.
            shells.open(client(OTHER), "elsewhere", iso.home, 80, 24);
            shells.close(back, "exits");
            shells.open(back, "twelfth", iso.home, 80, 24);
        } finally { shells.stop(); }
    }, 15_000);

    test("a full-screen program is told to draw itself again when its window attaches", async () => {
        const shells = new Terminals(); const first = client(KEY);
        try {
            shells.open(first, "fullscreen", iso.home, 80, 24);
            // A stand-in for vim: the alternate screen, and a redraw on every SIGWINCH. (A script, so the
            // foreground job is the program itself, as for vim, not the loop's `sleep`.)
            const program = join(tempDir("terminal-fullscreen-"), "program.sh");
            writeFileSync(program, "trap 'printf \"__%s__\\\\n\" redraw' WINCH\nprintf '\\033[?1049h'\nwhile :; do sleep 0.05; done\n");
            shells.write(first, "fullscreen", `sh '${program}'\n`);
            await until(() => first.output().includes("\x1b[?1049h"));
            shells.drop(first);
            const back = client(KEY);
            shells.attach(back, "fullscreen");
            await until(() => back.output().includes("__redraw__"));
        } finally { shells.stop(); }
    });
});

describe("a window's tabs across a reload", () => {
    test("what was saved, against what the server still has", () => {
        const saved = parseTabs(JSON.stringify({ next: 4, open: true, selected: "t1", tabs: [
            { id: "t1", cwd: "/p", number: 1, terminal: "t1" },
            { id: "t2", cwd: "/p", number: 2, terminal: "x2", script: { id: "s", name: "dev" } },
            { id: "t3", cwd: "/q", number: 3, terminal: "t3" },
            { id: "bad id!", cwd: "/p", number: 9, terminal: "t9" },
        ] }));
        expect(saved.tabs.map((t) => t.id)).toEqual(["t1", "t2", "t3"]);
        expect(saved).toMatchObject({ next: 4, open: true, selected: "t1" });
        const back = restoreTabs(saved, [{ id: "x2", cwd: "/p" }, { id: "t3", cwd: "/q" }, { id: "setup", cwd: "/w", script: { id: "u", name: "setup" } }]);
        // t1's shell has gone; x2 keeps its tab and its script's name; the server's own gets a tab.
        expect(back.tabs).toEqual([
            { id: "t2", cwd: "/p", number: 2, terminal: "x2", script: { id: "s", name: "dev" } },
            { id: "t3", cwd: "/q", number: 3, terminal: "t3" },
            { id: "setup", cwd: "/w", number: 4, terminal: "setup", script: { id: "u", name: "setup" } },
        ]);
        expect(back.next).toBe(5);
        for (const raw of [null, "", "{", "[]", JSON.stringify({ tabs: "no" })]) expect(parseTabs(raw)).toEqual({ tabs: [], next: 1, open: false });
    });
});

describe("terminal cleanup and replay boundaries", () => {
    // Feed exact PTY read boundaries without shell echo or timing changing the controls.
    function replayFixture() {
        const shells = new Terminals();
        const owner = client("scanner");
        const entry = {
            window: owner.window, out: "", outState: "ground", discard: false,
            total: 0, sent: 0, unacked: 0, holding: false, alt: false, tail: "",
            cwd: iso.home, exitCode: 0,
        };
        const internal = shells as any;
        internal.shells.set("scanner", entry);
        return {
            entry, owner,
            record: (text: string) => internal.record(entry, text),
            attach: () => shells.attach(owner, "scanner"),
            send: () => internal.sendRest("scanner", entry),
        };
    }

    test.each([
        { name: "RIS", end: "\x1bc" },
        { name: "CSI", end: "\x1b[31m" },
        { name: "another OSC", end: "\x1b]0;replacement\x07" },
        { name: "ST", end: "\x1b\\" },
        { name: "BEL", end: "\x07" },
        { name: "CAN", end: "\x18" },
        { name: "SUB", end: "\x1a" },
        { name: "C1 ST", end: "\x9c" },
    ])("replay and later output survive an oversized OSC ended by $name", ({ end }) => {
        const osc = "\x1b]0;" + "x".repeat(1_300_000);
        const whole = replayFixture();
        whole.record(osc + end + "VISIBLE\r\n");
        whole.attach();
        expect(whole.owner.output()).toBe("VISIBLE\r\n");
        whole.record("LATER\r\n");
        whole.send();
        expect(whole.owner.output()).toBe("VISIBLE\r\nLATER\r\n");

        const split = replayFixture();
        split.record(osc);
        split.attach();
        expect(split.owner.events[0]).toMatchObject({ reset: true, data: "" });
        // Includes a read ending at ESC: its next character starts a new escape.
        for (const char of end.slice(0, -1)) { split.record(char); split.send(); }
        split.record(end.slice(-1) + "VISIBLE\r\n");
        split.send();
        split.record("LATER\r\n");
        split.send();
        expect(split.owner.output()).toBe("VISIBLE\r\nLATER\r\n");
        expect(split.owner.pos()).toBe(osc.length + end.length + "VISIBLE\r\nLATER\r\n".length);
    });

    test.each(["\x1b]0;", "\x1bP1;2|"])("an oversized unterminated string %j retains only parser state across reads", (start) => {
        const replay = replayFixture();
        replay.record(start + "x".repeat(1_300_000));
        expect(replay.entry.out.length).toBe(0);
        for (let i = 0; i < 30; i++) {
            replay.record("payload\n".repeat(8192));
            expect(replay.entry.out.length).toBe(0);
        }
        replay.record("\x1b");
        expect(replay.entry.out.length).toBe(0);
        replay.record("\\VISIBLE\r\n");
        replay.attach();
        expect(replay.owner.output()).toBe("VISIBLE\r\n");
    });

    test("the total cap includes detached and exited terminals from other windows", () => {
        const shells = new Terminals();
        // Exercise the global admission check without launching 48 interactive shells.
        const entries = (shells as unknown as { shells: Map<string, { window: string; exitCode?: number }> }).shells;
        for (let i = 0; i < 48; i++) entries.set(String(i), { window: `window-${i}`, ...(i % 2 ? { exitCode: 0 } : {}) });
        expect(() => shells.open(client("new-window"), "new", iso.home, 80, 24)).toThrow("Close a terminal");
        entries.clear();
    });

    test("shutdown waits for a HUP-ignoring shell, including a tab already closing", async () => {
        const shells = new Terminals(); const owner = client("cleanup");
        try {
            shells.open(owner, "stubborn", iso.home, 80, 24);
            shells.write(owner, "stubborn", "trap '' HUP; printf '__ready__%s\\n' $$\n");
            await until(() => /__ready__\d+/.test(owner.output()));
            const pid = Number(owner.output().match(/__ready__(\d+)/)![1]);
            shells.close(owner, "stubborn");
            await shells.stop();
            expect(gone(pid)).toBe(true);
        } finally { await shells.stop(); }
    });

    test.each([
        { name: "OSC", start: "\\033]0;", end: "\\007" },
        { name: "DCS with embedded BEL", start: "\\033P1;2|\\007", end: "\\033\\\\" },
    ])("an oversized $name is discarded through its terminator on replay", async ({ start, end }) => {
        const shells = new Terminals(); const owner = client("ansi");
        const done = join(tempDir("terminal-ansi-"), "done");
        try {
            shells.open(owner, "ansi", iso.home, 80, 24);
            shells.write(owner, "ansi", `printf '${start}'; yes control | head -c 1500000; touch '${done}'\n`);
            shells.drop(owner);
            await until(() => existsSync(done));
            await Bun.sleep(100);
            const firstBack = client("ansi");
            shells.attach(firstBack, "ansi");
            expect(firstBack.events[0]).toMatchObject({ reset: true, data: "" });
            shells.drop(firstBack);
            const back = client("ansi");
            shells.attach(back, "ansi", firstBack.pos());
            expect(back.events[0]).toMatchObject({ reset: true, data: "" });
            shells.write(back, "ansi", `printf '${end}__%s__\\n' safe\n`);
            await until(() => back.output().includes("__safe__\r\n"));
            expect(back.output()).not.toContain("control");
            expect(back.output()).not.toContain("printf");
        } finally { await shells.stop(); }
    }, 15_000);

    test("a killed server leaves no HUP-ignoring terminal shell", async () => {
        const fixture = join(tempDir("terminal-parent-"), "parent.ts");
        const module = new URL("../src/server/terminals.ts", import.meta.url).pathname;
        writeFileSync(fixture, `import { Terminals } from ${JSON.stringify(module)};
            const shells = new Terminals();
            const owner = { send(e: any) { if (e.type === 'terminal.data') process.stdout.write(e.data); } };
            shells.open(owner, 'guarded', process.cwd(), 80, 24);
            shells.write(owner, 'guarded', "trap '' HUP; printf '__guarded__%s\\\\n' $$\\n");
            setInterval(() => {}, 1000);
        `);
        const parent = Bun.spawn([process.execPath, "--no-env-file", fixture], { cwd: iso.home, env: { ...process.env, SHELL: "/bin/sh" }, stdout: "pipe", stderr: "ignore" });
        let output = ""; let pid = 0;
        const reading = (async () => { for await (const chunk of parent.stdout) output += new TextDecoder().decode(chunk); })();
        try {
            await until(() => /__guarded__\d+/.test(output));
            pid = Number(output.match(/__guarded__(\d+)/)![1]);
            parent.kill("SIGKILL");
            await parent.exited;
            await until(() => gone(pid));
        } finally {
            parent.kill("SIGKILL");
            await parent.exited;
            if (pid && !gone(pid)) process.kill(pid, "SIGKILL");
            await reading;
        }
    }, 15_000);
});
