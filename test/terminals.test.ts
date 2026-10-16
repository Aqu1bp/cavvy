import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { isolate } from "./helpers/isolate";
const iso = isolate();
const { Terminals, terminalSize } = await import("../src/server/terminals");
import type { ServerEvent } from "../src/server/protocol";
afterAll(() => iso.cleanup());

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
        const oldShell = process.env.SHELL; process.env.SHELL = "/bin/sh";
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
        } finally { shells.stop(); if (oldShell === undefined) delete process.env.SHELL; else process.env.SHELL = oldShell; }
    });
    test("another window cannot write, resize or close; disconnect closes owned shells only", async () => {
        const shells = new Terminals(); const owner = client(); const other = client();
        try {
            shells.open(owner, "owned", iso.home, 80, 24);
            shells.open(other, "other", iso.home, 80, 24);
            expect(() => shells.write(other, "owned", "exit\n")).toThrow("not open");
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
            shells.write(owner, "hangup", "sleep 30 & echo __pid__$!; wait\n");
            await until(() => /__pid__(\d+)/.test(owner.output()));
            const pid = Number(owner.output().match(/__pid__(\d+)/)![1]);
            shells.close(owner, "hangup");
            await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } });
        } finally { shells.stop(); }
    });
});
