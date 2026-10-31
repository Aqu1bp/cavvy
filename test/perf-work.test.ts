// What a reply and a turn cost, counted rather than timed, so a slow runner doesn't change the answer.
import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { withinBudget } from "./helpers/perf-budget";
import { MarkdownRenderer } from "../gui/src/lib/markdown";
import { offStep, onStep } from "../gui/src/lib/stream-clock";
import { STREAM_DEMO } from "../scripts/mock-llm";
import { Marked } from "../gui/node_modules/marked/lib/marked.esm.js";

test("a turn in a real server stays within its budgets", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/perf-server.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "--no-env-file", "test", fixture], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
}, 180_000);

test("a streaming reply's Markdown is parsed about once, not again with each chunk", () => {
    let parsed = 0;
    const lexer = Marked.prototype.lexer;
    Marked.prototype.lexer = function (this: unknown, src: string, ...rest: unknown[]) { parsed += src.length; return (lexer as any).call(this, src, ...rest); } as any;
    try {
        const text = Array.from({ length: 4 }, () => STREAM_DEMO).join("\n\n");
        const renderer = new MarkdownRenderer();
        // The sizes a model's chunks come in, about 4 to 40 characters.
        for (let at = 0, n = 0; at < text.length; at += 4 + (n++ * 7) % 37) renderer.segments(text.slice(0, at), true);
        renderer.segments(text, false);
        withinBudget("markdownParsedPerCharacter", Math.round((parsed / text.length) * 10) / 10);
    } finally {
        Marked.prototype.lexer = lexer;
    }
});

test("however many things are streaming, the page wakes for them 30 times a second at most", () => {
    const real = { raf: globalThis.requestAnimationFrame, caf: globalThis.cancelAnimationFrame, timeout: globalThis.setTimeout, clear: globalThis.clearTimeout, now: performance.now };
    let now = 1000, wakes = 0, frame: ((t: number) => void) | undefined, id = 0;
    const timers = new Map<number, { at: number; fn: () => void }>();
    globalThis.requestAnimationFrame = ((fn: (t: number) => void) => { frame = fn; return 1; }) as any;
    globalThis.cancelAnimationFrame = (() => { frame = undefined; }) as any;
    globalThis.setTimeout = ((fn: () => void, ms = 0) => { timers.set(++id, { at: now + ms, fn }); return id; }) as any;
    globalThis.clearTimeout = ((t: number) => { timers.delete(t); }) as any;
    performance.now = () => now;
    const a = () => onStep(a), b = () => onStep(b);
    try {
        onStep(a);
        onStep(b);
        // A second of a 120 Hz display.
        for (const end = now + 1000; now < end; now += 1000 / 120) {
            for (const [t, { at, fn }] of timers) if (at <= now) { timers.delete(t); fn(); }
            const f = frame;
            frame = undefined;
            if (f) { wakes++; f(now); }
        }
    } finally {
        offStep(a);
        offStep(b);
        Object.assign(globalThis, { requestAnimationFrame: real.raf, cancelAnimationFrame: real.caf, setTimeout: real.timeout, clearTimeout: real.clear });
        performance.now = real.now;
    }
    expect(wakes).toBeGreaterThan(24);
    withinBudget("streamClockWakesPerSecond", wakes);
});
