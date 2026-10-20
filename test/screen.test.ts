// The full-window renderer: the live region is pinned to the bottom, output
// scrolls into the scrollback, a turn's end brings it back down to the prompt,
// and a resize lays everything out again once.

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

    test("at the end of a turn, the output comes back down to the prompt, which sits on the bottom rows", () => {
        const { vt, screen } = harness(12, 40);
        for (let i = 0; i < 20; i++) screen.print(`line ${i}`);
        screen.setLive([...Array.from({ length: 6 }, (_, i) => `busy ${i}`), ...LIVE]);
        screen.flushNow();
        screen.print("done");
        screen.setLive(LIVE);
        screen.flushNow();
        const before = vt.scrollback.length;
        screen.settle();
        screen.flushNow();
        const s = vt.screen();
        expect(s.slice(-LIVE.length)).toEqual(LIVE);
        expect(s.slice(0, 12 - LIVE.length)).toEqual(["line 14", "line 15", "line 16", "line 17", "line 18", "line 19", "done"]);
        // Nothing more went to the scrollback: the rows brought back were already there.
        expect(vt.scrollback.length).toBe(before);
        // And the next output follows on as usual.
        screen.print("next");
        screen.flushNow();
        expect(vt.screen().slice(-LIVE.length - 2, -LIVE.length)).toEqual(["done", "next"]);
    });

    test("rows brought back by settling don't go to the scrollback twice: not when a dialog opens and closes, not over turns", () => {
        const { vt, screen } = harness(12, 40);
        for (let i = 0; i < 20; i++) screen.print(`line ${i}`);
        screen.setLive(LIVE);
        screen.flushNow();
        const dialog = [...Array.from({ length: 6 }, (_, i) => `option ${i}`), ...LIVE];
        const busy = ["", "spinner", ...LIVE];
        for (let round = 0; round < 3; round++) {
            screen.setLive(dialog);
            screen.flushNow();
            screen.setLive(LIVE);
            screen.settle();
            screen.flushNow();
            screen.setLive(busy);
            screen.flushNow();
            screen.print(`reply ${round}`);
            screen.setLive(LIVE);
            screen.settle();
            screen.flushNow();
        }
        const rows = [...Array.from({ length: 20 }, (_, i) => `line ${i}`), "reply 0", "reply 1", "reply 2"];
        const ours = (ls: string[]) => ls.filter((l) => /^(line|reply) /.test(l));
        // The scrollback has each row once, in order; the screen shows the newest rows right above the prompt,
        // so only its top rows (brought back by the last settle) are also the scrollback's last ones.
        const back = ours(vt.scrollback);
        expect(back).toEqual(rows.slice(0, back.length));
        const shown = ours(vt.screen());
        expect(shown).toEqual(rows.slice(-shown.length));
        expect(shown.length).toBe(12 - LIVE.length);
        expect(back.length + shown.length - rows.length).toBe((screen as any).restored);
        expect(vt.screen().slice(-LIVE.length)).toEqual(LIVE);
    });

    test("after settling, rows on screen are dropped as painted, even when the entry behind them was replaced since", () => {
        const { vt, screen } = harness(12, 40);
        const busy = Array.from({ length: 11 }, (_, i) => `busy ${i}`);
        const live = Array.from({ length: 5 }, (_, i) => `live ${i}`);
        const e = screen.print(Array.from({ length: 20 }, (_, i) => `streamed ${i}`));
        screen.setLive(busy);
        screen.flushNow();
        screen.setLive(live);
        screen.settle();
        screen.flushNow();
        screen.replace([e], ["whole reply"]);
        screen.setLive(busy);
        screen.flushNow();
        // The last row printed is still right above the live region, which starts where `top` says.
        expect(vt.screen()[0]).toBe("streamed 19");
        expect(vt.screen()[1]).toBe("busy 0");
        expect((screen as any).top).toBe(1);
    });

    test("settling brings back rows as they were painted, not as an entry replaced since would lay out", () => {
        const { vt, screen } = harness(12, 40);
        const e = screen.print(Array.from({ length: 20 }, (_, i) => `painted ${i}`));
        screen.setLive(Array.from({ length: 11 }, (_, i) => `busy ${i}`));
        screen.flushNow();
        screen.replace([e], Array.from({ length: 20 }, (_, i) => `replacement ${i}`));
        screen.setLive(Array.from({ length: 5 }, (_, i) => `live ${i}`));
        screen.settle();
        screen.flushNow();
        expect(vt.screen().slice(0, 7)).toEqual(Array.from({ length: 7 }, (_, i) => `painted ${13 + i}`));
        // Six of them came back from the scrollback; the seventh never left the screen.
        expect((screen as any).restored).toBe(6);
        expect(vt.scrollback.slice(-6)).toEqual(Array.from({ length: 6 }, (_, i) => `painted ${13 + i}`));
    });

    test("output printed with no live region scrolls the copies away, and they aren't dropped again", () => {
        const { vt, screen } = harness(12, 40);
        screen.print(Array.from({ length: 20 }, (_, i) => `line ${i}`));
        screen.setLive(Array.from({ length: 8 }, (_, i) => `live ${i}`));
        screen.flushNow();
        screen.setLive(["prompt"]);
        screen.settle();
        screen.flushNow();
        screen.setLive([]);
        screen.print(Array.from({ length: 12 }, (_, i) => `new ${i}`));
        screen.flushNow();
        expect((screen as any).restored).toBe(0);
        screen.setLive(Array.from({ length: 8 }, (_, i) => `live ${i}`));
        screen.flushNow();
        const all = vt.all().filter((l) => l.startsWith("new "));
        expect(all).toEqual(Array.from({ length: 12 }, (_, i) => `new ${i}`));
    });

    test("printing nothing draws nothing: no newline scrolls a row into the scrollback", () => {
        const { vt, screen } = harness(12, 40);
        screen.print(Array.from({ length: 20 }, (_, i) => `old ${i}`));
        screen.setLive(Array.from({ length: 11 }, (_, i) => `busy ${i}`));
        screen.flushNow();
        screen.setLive(Array.from({ length: 5 }, (_, i) => `live ${i}`));
        screen.settle();
        screen.flushNow();
        const before = [...vt.scrollback];
        screen.print([]);
        screen.flushNow();
        expect(vt.scrollback).toEqual(before);
        screen.setLive(Array.from({ length: 11 }, (_, i) => `busy ${i}`));
        screen.flushNow();
        const olds = vt.scrollback.filter((l) => l.startsWith("old "));
        expect(new Set(olds).size).toBe(olds.length);
    });

    test("settling with no live region (stopping) leaves the output where it is", () => {
        const { vt, screen } = harness(12, 40);
        for (let i = 0; i < 20; i++) screen.print(`line ${i}`);
        screen.setLive([...Array.from({ length: 6 }, (_, i) => `busy ${i}`), ...LIVE]);
        screen.flushNow();
        const before = vt.scrollback.length;
        screen.setLive([]);
        screen.settle();
        screen.flushNow();
        expect(vt.scrollback.length).toBe(before);
        expect((screen as any).top).toBeLessThan(12);
    });

    test("with nothing out of sight above, settling leaves the gap above the prompt, which stays on the bottom rows", () => {
        const { vt, screen } = harness(12, 40);
        screen.print(["first", "second"]);
        screen.setLive(["", "spinner", ...LIVE]);
        screen.flushNow();
        screen.setLive(LIVE);
        screen.settle();
        screen.flushNow();
        const s = vt.screen();
        expect(s.slice(0, 2)).toEqual(["first", "second"]);
        expect(s.slice(2, 7).every((l) => l === "")).toBe(true);
        expect(s.slice(7)).toEqual(LIVE);
        expect(vt.scrollback).toEqual([]);
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
