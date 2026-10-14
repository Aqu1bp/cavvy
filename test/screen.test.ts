// The full-window renderer: the live region is pinned to the bottom, output
// scrolls into the scrollback, and a resize lays everything out again once.

import { afterEach, describe, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import { VT } from "./helpers/vt";

isolate();
const { Screen } = await import("../src/ui/screen");

const realWrite = process.stdout.write;
const saved = { columns: process.stdout.columns, rows: process.stdout.rows };

function setSize(rows: number, cols: number) {
    Object.defineProperty(process.stdout, "columns", { value: cols, configurable: true, writable: true });
    Object.defineProperty(process.stdout, "rows", { value: rows, configurable: true, writable: true });
}

/** A Screen that writes into a VT of the given size instead of the real terminal. */
function harness(rows: number, cols: number) {
    setSize(rows, cols);
    const vt = new VT(rows, cols);
    process.stdout.write = ((s: string | Uint8Array) => (vt.feed(typeof s === "string" ? s : new TextDecoder().decode(s)), true)) as typeof process.stdout.write;
    const screen = new Screen();
    (screen as any).interactive = true;
    const resize = async (r: number, c: number) => {
        vt.resize(r, c);
        setSize(r, c);
        (screen as any).onResize();
        await Bun.sleep(80);
    };
    return { vt, screen, resize };
}

afterEach(() => {
    process.stdout.write = realWrite;
    setSize(saved.rows as number, saved.columns as number);
});

// Narrower than every screen below, so it's never cut to fit.
const LIVE = ["", "─".repeat(20), "> type here", "─".repeat(20), "  footer"];

describe("full-window renderer", () => {
    test("the live region sits on the bottom rows, under the output", () => {
        const { vt, screen } = harness(12, 40);
        screen.print(["first", "second"]);
        screen.setLive(LIVE);
        screen.flushNow();
        const s = vt.screen();
        expect(s.slice(0, 2)).toEqual(["first", "second"]);
        expect(s.slice(2, 7).every((l) => l === "")).toBe(true);
        expect(s.slice(7)).toEqual(LIVE);
    });

    test("the flowing part of the live region goes right under the output, the blank space after it", () => {
        const { vt, screen } = harness(12, 40);
        screen.print(["first", "second"]);
        screen.setLive(["", "streaming", "", "spinner", ...LIVE], 2);
        screen.flushNow();
        const s = vt.screen();
        expect(s.slice(0, 4)).toEqual(["first", "second", "", "streaming"]);
        expect(s.slice(4, 5).every((l) => l === "")).toBe(true);
        expect(s.slice(5)).toEqual(["", "spinner", ...LIVE]);
    });

    test("a live region taller than the screen loses its top, and the blank space stays after what flows", () => {
        const { vt, screen } = harness(10, 40);
        screen.setLive(["", "a", "b", "c", "d", "e", "", "s1", "s2", "s3", "s4", "p"], 6);
        screen.flushNow();
        expect(vt.screen()).toEqual(["c", "d", "e", "", "", "s1", "s2", "s3", "s4", "p"]);
    });

    test("output fills the screen, then scrolls into the scrollback; the live region stays at the bottom", () => {
        const { vt, screen } = harness(12, 40);
        screen.setLive(LIVE);
        for (let i = 0; i < 30; i++) {
            screen.print(`line ${i}`);
            screen.flushNow();
        }
        expect(vt.screen().slice(-5)).toEqual(LIVE);
        expect(vt.screen()[6]).toBe("line 29");
        const all = vt.all();
        for (let i = 0; i < 30; i++) expect(all.filter((l) => l === `line ${i}`).length).toBe(1);
    });

    test("when the live region shrinks after the screen scrolled, it still ends on the last row", () => {
        const { vt, screen } = harness(12, 40);
        for (let i = 0; i < 20; i++) screen.print(`line ${i}`);
        screen.setLive([...Array.from({ length: 6 }, (_, i) => `busy ${i}`), ...LIVE]);
        screen.flushNow();
        screen.print("done");
        screen.setLive(LIVE);
        screen.flushNow();
        const s = vt.screen();
        expect(s.slice(-5)).toEqual(LIVE);
        expect(s).toContain("done");
        expect(s.filter((l) => l.startsWith("busy"))).toEqual([]);
    });

    test("a resize clears everything and lays it out again at the new width, once", async () => {
        const { vt, screen, resize } = harness(14, 60);
        screen.print((cols) => ["╭" + "─".repeat(cols - 3) + "╮"]);
        screen.print("word ".repeat(20).trim());
        screen.setLive(LIVE);
        screen.flushNow();
        await resize(14, 30);
        let all = vt.all();
        expect(all[0]).toBe("╭" + "─".repeat(27) + "╮");
        expect(all.filter((l) => l.startsWith("╭")).length).toBe(1);
        expect(all.join(" ").split("word").length - 1).toBe(20);
        expect(all.every((l) => l.length <= 30)).toBe(true);
        expect(vt.screen().slice(-5)).toEqual(LIVE);
        await resize(20, 80);
        all = vt.all();
        expect(all[0]).toBe("╭" + "─".repeat(77) + "╮");
        expect(all.filter((l) => l.startsWith("╭")).length).toBe(1);
        expect(vt.screen().slice(-5)).toEqual(LIVE);
    });

    test("nothing is drawn while the size is changing", async () => {
        const { vt, screen } = harness(12, 40);
        screen.setLive(LIVE);
        screen.flushNow();
        setSize(12, 30);
        (screen as any).onResize();
        const before = vt.screen().join("\n");
        screen.print("during the drag");
        screen.flushNow();
        expect(vt.screen().join("\n")).toBe(before);
        await Bun.sleep(80);
        expect(vt.screen()).toContain("during the drag");
    });

    test("replaced entries are what a resize lays out", async () => {
        const { vt, screen, resize } = harness(12, 40);
        const a = screen.print("streamed one");
        const b = screen.print("streamed two");
        screen.flushNow();
        screen.replace([a, b], (cols) => [`whole reply at ${cols}`]);
        expect(vt.screen().slice(0, 2)).toEqual(["streamed one", "streamed two"]);
        await resize(12, 36);
        expect(vt.all().filter((l) => l.includes("streamed") || l.includes("whole reply"))).toEqual(["whole reply at 36"]);
    });

    test("long lines are wrapped here, so the rows add up and nothing scrolls off early", () => {
        const { vt, screen } = harness(12, 40);
        screen.print("x".repeat(100));
        screen.setLive(LIVE);
        screen.flushNow();
        expect(vt.scrollback).toEqual([]);
        const s = vt.screen();
        expect(s.slice(0, 3)).toEqual(["x".repeat(40), "x".repeat(40), "x".repeat(20)]);
        expect(s.slice(3, 7).every((l) => l === "")).toBe(true);
        expect(s.slice(7)).toEqual(LIVE);
    });

    test("stopping mid-turn (a crash) leaves the live lines right under the output", () => {
        const { vt, screen } = harness(12, 40);
        (screen as any).started = true;
        screen.print("only line");
        screen.setLive(["spinner"]);
        screen.flushNow();
        screen.stop();
        expect(vt.screen().slice(0, 2)).toEqual(["only line", "spinner"]);
    });

    test("the kitty keyboard flag is pushed on start, and popped on stop and while a child process has the terminal", async () => {
        const out: string[] = [];
        process.stdout.write = ((s: string | Uint8Array) => (out.push(typeof s === "string" ? s : new TextDecoder().decode(s)), true)) as typeof process.stdout.write;
        // No real terminal here: stub what start/stop/suspend ask of stdin and stdout.
        const stubs: [any, string][] = [...["setRawMode", "setEncoding", "on", "off", "resume", "pause"].map((k) => [process.stdin, k] as [any, string]), [process.stdout, "on"], [process.stdout, "off"]];
        const saved = stubs.map(([o, k]) => Object.getOwnPropertyDescriptor(o, k));
        for (const [o, k] of stubs) o[k] = () => o;
        try {
            const screen = new Screen();
            (screen as any).interactive = true;
            screen.start(() => {});
            expect(out.join("")).toContain("\x1b[?2004h\x1b[>1u");
            out.length = 0;
            let during = "";
            await screen.suspend(() => void (during = out.join("")));
            expect(during).toContain("\x1b[?2004l\x1b[<u");
            expect(during).not.toContain("\x1b[>1u");
            expect(out.join("").slice(during.length)).toContain("\x1b[?2004h\x1b[>1u");
            out.length = 0;
            screen.stop();
            expect(out.join("")).toContain("\x1b[?2004l\x1b[<u");
            // A second stop (process exit after a crash handler) writes nothing more.
            out.length = 0;
            screen.stop();
            expect(out).toEqual([]);
        } finally {
            stubs.forEach(([o, k], i) => (saved[i] ? Object.defineProperty(o, k, saved[i]!) : delete o[k]));
        }
    });

    test("on stop the output isn't followed by the gap", () => {
        const { vt, screen } = harness(12, 40);
        (screen as any).started = true;
        screen.print("only line");
        screen.setLive(LIVE);
        screen.flushNow();
        screen.setLive([]);
        screen.print("goodbye");
        screen.stop();
        expect(vt.r).toBe(2);
        expect(vt.screen().slice(0, 2)).toEqual(["only line", "goodbye"]);
    });
});
