import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const { Terminals, terminalEnv, terminalSize } = await import("../src/server/terminals");
import type { ServerEvent } from "../src/server/protocol";

// A plain shell with an empty home: none of the user's own startup files run.
const saved = { SHELL: process.env.SHELL, HOME: process.env.HOME };
beforeAll(() => { process.env.SHELL = "/bin/sh"; process.env.HOME = tempDir("terminal-home-"); });
afterAll(() => {
    for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
    iso.cleanup();
});

async function until(check: () => boolean) {
    const deadline = Date.now() + 5000;
    while (!check()) { if (Date.now() > deadline) throw new Error("Terminal timed out"); await Bun.sleep(20); }
}
function client() {
    const events: ServerEvent[] = [];
    return { events, send: (event: ServerEvent) => events.push(event), output: () => events.filter((e) => e.type === "terminal.data").map((e) => e.data).join("") };
}

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
    test("a real PTY has the selected cwd, interactive input, resize, Ctrl-C and exit status", async () => {
        const shells = new Terminals(); const owner = client();
        try {
            shells.open(owner, "terminal-1", iso.home, 90, 28);
            shells.write(owner, "terminal-1", "printf '__cwd__'; pwd; test -t 0 && printf '__tty__\\n'\n");
            await until(() => owner.output().includes(`__cwd__${realpathSync(iso.home)}`) && owner.output().includes("__tty__\r\n"));
            shells.resize(owner, "terminal-1", 104, 31);
            shells.write(owner, "terminal-1", "stty size\n");
            await until(() => owner.output().includes("31 104\r\n"));
            shells.write(owner, "terminal-1", "sleep 30\n");
            await Bun.sleep(100);
            shells.write(owner, "terminal-1", "\x03");
            shells.write(owner, "terminal-1", "printf '__after_interrupt__\\n'\n");
            await until(() => owner.output().includes("__after_interrupt__\r\n"));
            shells.write(owner, "terminal-1", "exit 7\n");
            await until(() => owner.events.some((e) => e.type === "terminal.exit" && e.exitCode === 7));
            expect(() => shells.write(owner, "terminal-1", "x")).toThrow("not open");
        } finally { shells.stop(); }
    });
    test("another window cannot write, resize or close; disconnect closes owned shells only", async () => {
        const shells = new Terminals(); const owner = client(); const other = client();
        try {
            shells.open(owner, "owned", iso.home, 80, 24);
            shells.open(other, "other", iso.home, 80, 24);
            expect(() => shells.write(other, "owned", "exit\n")).toThrow("not open");
            // An expected refusal, not a server error.
            try { shells.write(other, "owned", "x"); } catch (e) { expect((e as { code?: string }).code).toBe("terminal_not_open"); }
            expect(() => shells.resize(other, "owned", 80, 24)).toThrow("not open");
            expect(() => shells.close(other, "owned")).toThrow("not open");
            expect(() => shells.open(owner, "owned", iso.home, 80, 24)).toThrow("duplicate");
            expect(() => shells.write(owner, "owned", "x".repeat(65_537))).toThrow("too large");
            shells.drop(owner);
            expect(() => shells.write(owner, "owned", "x")).toThrow("not open");
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
