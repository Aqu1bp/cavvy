// What you said, in the conversation (UserPrompt in gui/src/components/TurnView.tsx, styled by
// transcript.css): a bubble at the right as wide as its text, what came with it above it, and its
// time, Copy and Rewind under it, laid over the gap on hover or focus.
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRules } from "./helpers/contrast";
import { clock, promptTime, shortPrompt } from "../gui/src/lib/format";

const gui = join(import.meta.dir, "../gui/src");
const css = (file: string) => parseRules(readFileSync(join(gui, "styles", file), "utf8"));
const decl = (rules: ReturnType<typeof css>, selector: string, property: string) => rules.findLast((r) => r.selectors.includes(selector) && r.decls.has(property))?.decls.get(property);

test("the component: structure, every kind of prompt, and when Rewind and the time show", async () => {
    const fixture = fileURLToPath(new URL("./fixtures/gui-user-prompt.ts", import.meta.url));
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", "test", fixture], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, output: code ? stdout + stderr : "" }).toEqual({ code: 0, output: "" });
});

describe("promptTime", () => {
    const at = new Date(2026, 9, 22, 9, 41).getTime();
    test("today: the time alone", () => {
        expect(promptTime(at, new Date(2026, 9, 22, 23, 0).getTime())).toBe(clock(at));
    });
    test("another day: the day before the time; another year: the year too", () => {
        const yesterday = promptTime(at, new Date(2026, 9, 23, 8, 0).getTime());
        expect(yesterday).toBe(new Date(at).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }));
        expect(yesterday).not.toContain("2026");
        expect(promptTime(at, new Date(2027, 0, 2).getTime())).toContain("2026");
    });
    test("the computer's time zone moving: times in the new one, though the formatters are kept", () => {
        const was = process.env.TZ;
        const noon = Date.UTC(2026, 9, 22, 12, 0);
        try {
            process.env.TZ = "UTC";
            const utc = clock(noon);
            expect(utc).toBe(new Date(noon).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
            process.env.TZ = "Asia/Kolkata";
            expect(clock(noon)).toBe(new Date(noon).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" }));
            expect(clock(noon)).not.toBe(utc);
        } finally {
            if (was === undefined) delete process.env.TZ;
            else process.env.TZ = was;
        }
    });
});

test("shortPrompt: one line of under 60 characters", () => {
    expect(shortPrompt("status?")).toBe(true);
    expect(shortPrompt("x".repeat(59))).toBe(true);
    expect(shortPrompt("x".repeat(60))).toBe(false);
    expect(shortPrompt("a\nb")).toBe(false);
});

test("the bubble's styles: at the right, as wide as its text, its actions over the gap and shown by opacity alone", () => {
    const t = css("transcript.css");
    expect(decl(t, ".user-row", "align-self")).toBe("flex-end");
    expect(decl(t, ".user-row", "max-width")).toBe("min(82%, 600 * var(--sp))");
    expect(decl(t, ".user-row", "position")).toBe("relative");
    expect(decl(t, ".user-row > .user-bubble", "border-radius")).toBe("calc(20 * var(--sp)) calc(20 * var(--sp)) calc(6 * var(--sp)) calc(20 * var(--sp))");
    expect(decl(t, ".user-row > .user-bubble.short", "border-radius")).toBe("calc(18 * var(--sp)) calc(18 * var(--sp)) calc(6 * var(--sp)) calc(18 * var(--sp))");
    expect(decl(t, ".user-bubble", "background")).toBe("var(--bubble)");
    // Absolutely placed under the bubble: showing them moves nothing.
    expect(decl(t, ".user-actions", "position")).toBe("absolute");
    expect(decl(t, ".user-actions", "top")).toBe("100%");
    expect(decl(t, ".user-actions", "opacity")).toBe("0");
    expect(decl(t, ".user-actions", "transition")).toBe("opacity 140ms");
    expect(decl(t, ".user-row:hover .user-actions", "opacity")).toBe("1");
    expect(decl(t, ".user-actions:focus-within", "opacity")).toBe("1");
    // Its margin is the gap they're laid over.
    expect(decl(t, ".user-row", "margin-bottom")).toBe("calc(22 * var(--sp))");
});

test("--bubble is a token in both themes", () => {
    const tokens = css("tokens.css");
    expect(decl(tokens, '[data-theme="light"]', "--bubble")).toMatch(/^#[0-9a-f]{6}$/);
    expect(decl(tokens, '[data-theme="dark"]', "--bubble")).toMatch(/^#[0-9a-f]{6}$/);
});
