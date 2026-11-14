// Themes: what an agent or a person writes is checked before it's shown, every palette a theme makes keeps the
// window's text at WCAG AA, the veil over a scene is enough wherever text can sit, a scene moves only on the
// compositor and on the window's 50 ms grid, and the tools save, show and explain.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { BUILTINS } from "../src/themes/builtin";
import { contrast, mix, over, parseHex, type Rgb } from "../src/themes/color";
import { checkTheme, lookFor, onlyScheme, svgProblem, withNamespace, type Theme } from "../src/themes/format";
import { palette, veilFor, veilMap, WINDOW_TEXT } from "../src/themes/palette";
import { listThemes, removeTheme, restoreTheme, saveTheme } from "../src/themes/store";
import { STEP_MS } from "../gui/src/lib/stream-clock";
import { layerAnimation, poseAt } from "../gui/src/lib/theme-motion";

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#123"/></svg>';
const minimal = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "Test",
    dark: { colors: { background: "#101418", text: "#eef2f6", accent: "#6aa0ff" }, layers: [{ svg: SVG }] },
    ...over,
});

describe("checking a theme", () => {
    test("every built-in passes the check agents' themes go through", async () => {
        for (const b of BUILTINS) {
            const t = await b.load();
            const { theme, problems } = checkTheme(JSON.parse(JSON.stringify(t)));
            expect(`${b.id}: ${problems.join("; ")}`).toBe(`${b.id}: `);
            expect(theme!.name).toBe(b.name);
            expect((["light", "dark"] as const).filter((s) => t[s])).toEqual(b.schemes);
        }
    });

    test("a minimal theme passes, with the namespace an image needs added", () => {
        const { theme } = checkTheme(minimal({ dark: { colors: { background: "#101418", text: "#eef2f6" }, layers: [{ svg: "<svg viewBox='0 0 1 1'></svg>" }] } }));
        expect(theme!.dark!.layers![0]!.svg).toContain('xmlns="http://www.w3.org/2000/svg"');
    });

    test("lists every problem at once, so one round of fixes can take them all", () => {
        const { theme, problems } = checkTheme({ name: "", dark: { colors: { background: "red", text: "#eee" }, layers: [{ svg: "<div/>", motion: { duration: 0, keyframes: [{ x: 1 }] } }], extra: 1 } });
        expect(theme).toBeUndefined();
        expect(problems).toContainEqual("name must be a short name");
        expect(problems).toContainEqual("dark.colors.background must be a hex colour like #1a1b26");
        expect(problems.some((p) => p.startsWith("dark.layers[0].svg isn't one"))).toBe(true);
        expect(problems.some((p) => p.startsWith("dark.layers[0].motion.duration"))).toBe(true);
        expect(problems.some((p) => p.startsWith("dark.layers[0].motion.keyframes must be"))).toBe(true);
        expect(problems.some((p) => p.includes('"extra"'))).toBe(true);
    });

    test("text that doesn't stand out from its background is refused, with the ratio", () => {
        const { problems } = checkTheme(minimal({ dark: { colors: { background: "#101418", text: "#4a5058" } } }));
        expect(problems[0]).toMatch(/^dark: text on the background is \d\.\d:1; it needs at least 5\.5:1/);
    });

    test("a light background under dark is put where it belongs", () => {
        const { problems } = checkTheme(minimal({ dark: { colors: { background: "#f4f4f4", text: "#111111" } } }));
        expect(problems).toContainEqual('dark: the background #f4f4f4 is light; put it under "light"');
    });

    test("an SVG that would load or run something is refused, saying why", () => {
        expect(svgProblem('<svg><script>alert(1)</script></svg>')).toContain("<script>");
        expect(svgProblem('<svg><image href="https://example.com/a.png"/></svg>')).toContain("outside itself");
        expect(svgProblem('<svg><rect style="fill:url(https://x)"/></svg>')).toContain("url()");
        expect(svgProblem('<svg><rect onload="x()"/></svg>')).toContain("event handler");
        expect(svgProblem('<svg><foreignObject/></svg>')).toContain("foreignObject");
        expect(svgProblem('<svg><script/></svg>')).toContain("<script>");
        expect(svgProblem('<svg><rect fill="url(#g)"/><use href="#a"/><image href="data:image/png;base64,AA"/></svg>')).toBeUndefined();
    });

    test("an SVG that would animate itself is refused: an image runs it every frame, out of the window's reach", () => {
        for (const svg of [
            '<svg><rect><animate attributeName="x" dur="1s" repeatCount="indefinite"/></rect></svg>',
            '<svg><rect><set attributeName="fill" to="#fff"/></rect></svg>',
            '<svg><g><s:animateTransform type="rotate"/></g></svg>',
            "<svg><style>@keyframes a{to{opacity:0}} rect{animation:a 1s infinite}</style><rect/></svg>",
            '<svg><rect style="transition: opacity 1s"/></svg>',
            "<svg><style>rect{\\61nimation:a 1s}</style><rect/></svg>",
        ]) expect(svgProblem(svg)).toBeDefined();
    });

    test("a crafted SVG can't keep the check busy (each check is a scan, not a pattern that backtracks)", () => {
        const comments = "<!--a-->".repeat(60) + "<x></svg>";
        const tags = "<svg ".repeat(24_000);
        const started = performance.now();
        expect(svgProblem(comments)).toContain("isn't one <svg>");
        withNamespace(tags);
        checkTheme(minimal({ dark: { colors: { background: "#101418", text: "#eef2f6" }, layers: [{ svg: tags }] } }));
        expect(performance.now() - started).toBeLessThan(500);
        // Comments before the root are still fine.
        expect(svgProblem("<?xml version=\"1.0\"?><!-- a --><!-- b --><svg viewBox='0 0 1 1'></svg>")).toBeUndefined();
        expect(withNamespace("<!-- <svg> --><svg viewBox='0 0 1 1'></svg>")).toBe('<!-- <svg> --><svg xmlns="http://www.w3.org/2000/svg" viewBox=\'0 0 1 1\'></svg>');
    });

    test("keyframes timed with at must start at 0, end at 1 and go forward", () => {
        const motion = (keyframes: unknown[]) => minimal({ dark: { colors: { background: "#101418", text: "#eef2f6" }, layers: [{ svg: SVG, motion: { duration: 4, keyframes } }] } });
        expect(checkTheme(motion([{ at: 0 }, { at: 1 }])).problems).toEqual([]);
        expect(checkTheme(motion([{ at: 0 }, { at: 0.5 }, {}])).problems.some((p) => p.includes('give every keyframe an "at"'))).toBe(true);
        expect(checkTheme(motion([{ at: 0.2 }, { at: 1 }])).problems.some((p) => p.includes("first"))).toBe(true);
        expect(checkTheme(motion([{ at: 0 }, { at: 0.6 }, { at: 0.4 }, { at: 1 }])).problems.some((p) => p.includes("later than"))).toBe(true);
    });

    test("a theme with one look is made for that scheme, and lends it to the other", () => {
        const t = checkTheme(minimal()).theme!;
        expect(onlyScheme(t)).toBe("dark");
        expect(lookFor(t, "light").scheme).toBe("dark");
    });
});

/** The text colours a palette lays straight on the window. */
const windowText = (vars: Record<string, string>) => WINDOW_TEXT.map((n) => vars[n]).filter((v): v is string => Boolean(v?.startsWith("#"))).map(parseHex);

describe("a theme's palette", () => {
    test("keeps all the window's text at AA on the background, in every built-in look and both contrasts", async () => {
        for (const b of BUILTINS) {
            const t = await b.load();
            for (const scheme of b.schemes) {
                for (const high of [false, true]) {
                    const p = palette(t[scheme]!, scheme, { high });
                    for (const name of WINDOW_TEXT) {
                        const v = p.vars[name];
                        if (!v) continue;
                        expect(`${b.id}/${scheme}/${name}: ${contrast(parseHex(v), p.background).toFixed(2)}`).toMatch(/: ([5-9]|\d\d|4\.[5-9])/);
                    }
                }
            }
        }
    });

    test("in any look the check lets through, the window's text reads as shown (rounded to hex), with room to spare on a scene", () => {
        let seed = 7;
        const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
        const hex = () => `#${Array.from({ length: 3 }, () => Math.floor(rand() * 256).toString(16).padStart(2, "0")).join("")}`;
        let tried = 0;
        while (tried < 1500) {
            const scheme = rand() < 0.5 ? "light" : "dark";
            const look = { colors: { background: hex(), text: hex(), accent: hex() } };
            if (checkTheme({ name: "R", [scheme]: look }).problems.length) continue;
            tried++;
            const p = palette(look, scheme);
            for (const name of WINDOW_TEXT) {
                const v = p.vars[name];
                if (v) expect(`${look.colors.background}/${look.colors.text}/${name}: ${contrast(parseHex(v), p.background) >= 4.5}`).toEndWith("true");
            }
            // A scene of the background's own colour needs no veil.
            expect(veilFor(p.text, p.background, [p.background])).toBe(0);
            expect(contrast(parseHex(p.vars["--accent-ink"]!), parseHex(look.colors.accent))).toBeGreaterThanOrEqual(4.5);
        }
        // The look that once needed a 96% veil over its own background.
        const p = palette({ colors: { background: "#98ca27", text: "#1f4134" } }, "light");
        expect(veilFor(p.text, p.background, [p.background])).toBe(0);
    });

    test("moves a status colour that wouldn't read toward the text, keeping its hue as far as it can", () => {
        // A mid-dark green background: the dark scheme's green "ok" can't read on it as it is.
        const p = palette({ colors: { background: "#2f4a35", text: "#f2f7f2" } }, "dark");
        const ok = parseHex(p.vars["--ok"]!);
        expect(contrast(ok, p.background)).toBeGreaterThanOrEqual(4.5);
        expect(ok.g).toBeGreaterThan(ok.r);
    });

    test("leaves the user's accent alone when the theme picks none", () => {
        expect(palette({ colors: { background: "#101418", text: "#eef2f6" } }, "dark").vars["--accent"]).toBeUndefined();
        expect(palette({ colors: { background: "#101418", text: "#eef2f6", accent: "#6aa0ff" } }, "dark").vars["--accent"]).toBe("#6aa0ff");
    });

    test("a scene makes the window's glass clear (the scene is its ground); colours alone keep it see-through as set", () => {
        const look = { colors: { background: "#101418", text: "#eef2f6" } };
        expect(palette({ ...look, layers: [{ svg: SVG }] }, "dark").vars["--win-tint"]).toBe("transparent");
        expect(palette(look, "dark", { glass: "tinted" }).vars["--win-tint"]).toBe("rgba(16, 20, 24, 0.92)");
    });
});

describe("the veil over a scene", () => {
    const bg = parseHex("#101418");
    const text = [parseHex("#eef2f6"), parseHex("#9aa3ad")];
    const fill = (c: Rgb, n: number) => Array.from({ length: n }, () => c);

    test("a scene as dark as the background needs none; a bright one needs enough for every colour to read", () => {
        expect(veilFor(text, bg, fill(parseHex("#0c1014"), 100))).toBe(0);
        const v = veilFor(text, bg, fill(parseHex("#e0e0e0"), 100));
        expect(v).toBeGreaterThan(0.5);
        for (const t of text) expect(contrast(t, over(bg, v, parseHex("#e0e0e0")))).toBeGreaterThanOrEqual(4.5);
    });

    test("a sliver of bright pixels (a firefly, a star) doesn't veil the whole scene", () => {
        expect(veilFor(text, bg, [...fill(parseHex("#0c1014"), 99), parseHex("#ffffff")])).toBe(0);
    });

    test("as a map, every point between two cells' centres is covered at least as much as its own cell needs", () => {
        // A bright band down the left quarter, dark elsewhere.
        const w = 40;
        const h = 20;
        const pixels: Rgb[] = [];
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) pixels.push(x < 10 ? parseHex("#d8d8d8") : parseHex("#0c1014"));
        const cols = 8;
        const rows = 4;
        const map = veilMap(text, bg, pixels, w, h, cols, rows);
        const need = veilFor(text, bg, fill(parseHex("#d8d8d8"), 10));
        // Cells over the band and next to it are covered as much as the band needs; the far side is clear.
        expect(map[0]).toBeGreaterThanOrEqual(need);
        expect(map[2]).toBeGreaterThanOrEqual(need);
        expect(map[cols - 1]).toBe(0);
        // Bilinear between neighbouring centres never dips below either's own need.
        for (let c = 0; c < cols - 1; c++) {
            for (const k of [0.25, 0.5, 0.75]) {
                const blended = map[c]! * (1 - k) + map[c + 1]! * k;
                const own = (cell: number) => (cell * (w / cols) < 10 ? need : 0);
                expect(blended).toBeGreaterThanOrEqual(Math.max(own(c) * (k <= 0.5 ? 1 : 0), own(c + 1) * (k >= 0.5 ? 1 : 0)));
            }
        }
    });
});

describe("a scene's motion", () => {
    test("the veil is measured at every keyframe and through the loop, not only at rest", async () => {
        const { phases, poseAtPhase } = await import("../gui/src/lib/theme-draw");
        const fade = { svg: SVG, motion: { duration: 10, keyframes: [{ at: 0, opacity: 0 }, { at: 0.05, opacity: 1 }, { at: 0.9, opacity: 1 }, { at: 1, opacity: 0 }] } };
        const at = phases([{ svg: SVG }, fade]);
        expect(at).toContain(0.05);
        expect(at).toContain(0.5);
        expect(Math.max(...at.map((t) => poseAtPhase(t)(fade).opacity))).toBe(1);
        expect(phases([{ svg: SVG }])).toEqual([0]);
        expect(phases(Array.from({ length: 40 }, (_, i) => ({ svg: SVG, motion: { duration: 5, keyframes: [{ at: 0 }, { at: (i + 1) / 50 }, { at: 1 }] } }))).length).toBeLessThanOrEqual(16);
    });

    test("is transform and opacity only, in whole steps of the window's grid, from a start on it", () => {
        for (const duration of [0.5, 1.6, 3.2, 7, 13.7, 240]) {
            const a = layerAnimation({ duration, keyframes: [{ x: -10 }, { x: 10, opacity: 0.5 }], delay: -3.33 }, "t");
            expect(a.durationMs % STEP_MS).toBe(0);
            const steps = Number(/steps\((\d+)\)/.exec(a.animation)![1]);
            const stops = a.keyframes.match(/[\d.]+%\{/g)!.length - 1;
            expect((a.durationMs / stops) % STEP_MS).toBe(0);
            expect(a.durationMs / stops / steps).toBe(STEP_MS);
            const delay = Number(/ (-?\d+)ms infinite/.exec(a.animation)![1]);
            expect(Math.abs(delay % STEP_MS)).toBe(0);
            for (const m of a.keyframes.matchAll(/([a-z-]+):/g)) expect(["transform", "opacity"]).toContain(m[1]!);
            expect(a.animation).toContain("infinite");
        }
    });

    test("eases into and out of each keyframe, and keeps to the timed ones", () => {
        const m = { duration: 10, keyframes: [{ at: 0, y: 0 }, { at: 0.2, y: 100 }, { at: 1, y: 100 }] };
        expect(poseAt(m, 0.1).y).toBeCloseTo(50, 5);
        expect(poseAt(m, 0.05).y).toBeLessThan(25);
        expect(poseAt(m, 0.6).y).toBe(100);
    });

    test("the built-ins' moving layers each fit a modest box (each is a texture the GPU keeps)", async () => {
        for (const b of BUILTINS) {
            const t = await b.load();
            for (const s of b.schemes) {
                for (const l of t[s]!.layers ?? []) {
                    if (!l.motion) continue;
                    expect((l.width ?? 1600) * (l.height ?? 1000)).toBeLessThanOrEqual(1600 * 2000);
                }
            }
        }
    });
});

describe("the theme files", () => {
    test("saved, listed, deleted and put back; a file that doesn't check out is listed with why", () => {
        const dir = mkdtempSync(join(tmpdir(), "cavvy-themes-"));
        try {
            const theme = checkTheme(minimal()).theme as Theme;
            saveTheme("mine", theme, dir);
            writeFileSync(join(dir, "broken.json"), "{ nope");
            writeFileSync(join(dir, "glowworms.json"), JSON.stringify(theme));
            const list = listThemes(dir);
            expect(list.map((e) => e.id)).toEqual(["broken", "glowworms", "mine"]);
            expect(list[0]!.problems![0]).toStartWith("isn't JSON");
            expect(list[1]!.problems![0]).toContain("built-in");
            expect(list[2]!.theme!.name).toBe("Test");
            const text = removeTheme("mine", dir)!;
            expect(existsSync(join(dir, "mine.json"))).toBe(false);
            restoreTheme("mine", text, dir);
            expect(JSON.parse(readFileSync(join(dir, "mine.json"), "utf8")).name).toBe("Test");
            expect(removeTheme("../escape", dir)).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe("the theme tools", () => {
    const home = mkdtempSync(join(tmpdir(), "cavvy-home-"));
    const was = process.env.CAVVY_HOME;
    beforeAll(() => {
        process.env.CAVVY_HOME = home;
    });
    afterAll(() => {
        if (was === undefined) delete process.env.CAVVY_HOME;
        else process.env.CAVVY_HOME = was;
        rmSync(home, { recursive: true, force: true });
    });

    async function tools() {
        return import("../src/themes/tools");
    }

    test("without a window to show it in, ThemeSet says so and saves nothing", async () => {
        const { themeSet } = await tools();
        const r = await themeSet({ id: "x", theme: minimal() }, { ui: {} });
        expect(r.isError).toBe(true);
        expect(existsSync(join(home, "themes", "x.json"))).toBe(false);
    });

    test("a theme with problems isn't saved or shown; the answer lists what to fix", async () => {
        const { themeSet } = await tools();
        const shown: unknown[] = [];
        const r = await themeSet({ id: "bad", theme: { name: "Bad", dark: { colors: { background: "#101418", text: "#333" } } } }, { ui: { showTheme: async (...a) => (shown.push(a), { sent: 1 }) } });
        expect(r.isError).toBe(true);
        expect(r.text).toStartWith("Not saved. To fix:\n- dark: text on the background");
        expect(shown).toEqual([]);
        expect(existsSync(join(home, "themes", "bad.json"))).toBe(false);
    });

    test("a good one is saved, shown with its entry, and the window's report is put in words", async () => {
        const { themeSet } = await tools();
        const shown: unknown[][] = [];
        const r = await themeSet({ id: "night", theme: JSON.stringify(minimal()) }, {
            ui: { showTheme: async (...a) => (shown.push(a), { sent: 1, report: { request: "r", shown: true, scheme: "dark", veil: 0.42, veilMost: 0.8, failed: [2] } }) },
        });
        expect(r.isError).toBeUndefined();
        expect(shown[0]![0]).toBe("night");
        expect((shown[0]![1] as { theme: Theme }).theme.name).toBe("Test");
        expect(r.text).toContain('Showing "Test" (dark).');
        expect(r.text).toContain("42% on average, 80% where the scene is busiest");
        expect(r.text).toContain("Layers [2] couldn't be drawn");
        expect(r.text).toContain("dark look only");
        expect(JSON.parse(readFileSync(join(home, "themes", "night.json"), "utf8")).name).toBe("Test");
    });

    test("the window's picture of it goes to the agent as an image", async () => {
        const { ThemeSetTool } = await tools();
        const ui = { showTheme: async () => ({ sent: 1, report: { request: "r", shown: true, scheme: "dark" as const, picture: "AAAA" } }) };
        const r = await ThemeSetTool.run({ id: "pictured", theme: minimal() }, { ui } as never);
        expect(r.images).toEqual([{ type: "image", mediaType: "image/jpeg", data: "AAAA" }]);
        expect(r.content).toContain("The picture is the window with it on");
        const without = await ThemeSetTool.run({ id: "pictured" }, { ui: { showTheme: async () => ({ sent: 1, report: { request: "r", shown: true, scheme: "dark" as const } }) } } as never);
        expect(without.images).toBeUndefined();
        expect(without.content).not.toContain("picture");
    });

    test("a built-in can be shown but not overwritten; none turns the theme off", async () => {
        const { themeSet } = await tools();
        const shown: unknown[] = [];
        const ui = { showTheme: async (id: string | null) => (shown.push(id), { sent: 1, report: { request: "r", shown: true, scheme: "dark" as const } }) };
        expect((await themeSet({ id: "orbit", theme: minimal() }, { ui })).text).toContain("is a built-in theme");
        expect((await themeSet({ id: "orbit" }, { ui })).text).toContain('Showing "Orbit"');
        expect((await themeSet({ id: "none" }, { ui })).text).toBe("The theme is off.");
        expect(shown).toEqual(["orbit", null]);
        expect((await themeSet({ id: "missing" }, { ui })).text).toContain('No theme "missing"');
    });

    test("with no window open the theme is still saved, and the answer says where to find it", async () => {
        const { themeSet } = await tools();
        const r = await themeSet({ id: "later", theme: minimal() }, { ui: { showTheme: async () => ({ sent: 0 }) } });
        expect(r.text).toContain("No Cavvy window is open");
        expect(existsSync(join(home, "themes", "later.json"))).toBe(true);
    });

    test("ThemeList names the built-ins and the user's own, and says how to make one", async () => {
        const { themeList } = await tools();
        saveTheme("listed", checkTheme(minimal({ name: "Listed" })).theme!, join(home, "themes"));
        const all = (await themeList({})).text;
        for (const b of BUILTINS) expect(all).toContain(`- ${b.id}: ${b.name}`);
        expect(all).toContain("- listed: Listed (dark)");
        expect(all).toContain("How to make a Cavvy theme");
    });

    test("a theme's JSON comes without its long layers, which can be read one at a time or reused by reference", async () => {
        const { themeList, themeSet } = await tools();
        const full = await BUILTINS.find((b) => b.id === "night-rain")!.load();
        const one = (await themeList({ id: "night-rain" })).text;
        expect(one.length).toBeLessThan(15_000);
        const short = JSON.parse(one) as Theme;
        expect(short.dark!.colors).toEqual(full.dark!.colors);
        const long = full.dark!.layers!.findIndex((l) => l.svg.length > 1500);
        expect(short.dark!.layers![long]!.svg).toContain(`"night-rain:dark:${long}"`);
        expect((await themeList({ id: "night-rain", layer: `dark.${long}` })).text).toBe(full.dark!.layers![long]!.svg);
        expect((await themeList({ id: "night-rain", layer: "dark.99" })).isError).toBe(true);
        // Night Rain in purple: its colours changed, its layers reused as they are, one moved.
        const ui = { showTheme: async () => ({ sent: 1, report: { request: "r", shown: true, scheme: "dark" as const } }) };
        const layers = full.dark!.layers!.map((_, i) => ({ copy: `night-rain:dark:${i}`, ...(i === long ? { x: 40 } : {}) }));
        const r = await themeSet({ id: "purple-rain", theme: { name: "Purple Rain", dark: { colors: { background: "#140c1f", text: "#efe8f8", accent: "#b48cff" }, layers } } }, { ui });
        expect(r.isError).toBeUndefined();
        const saved = JSON.parse(readFileSync(join(home, "themes", "purple-rain.json"), "utf8")) as Theme;
        expect(saved.dark!.layers![0]!.svg).toBe(full.dark!.layers![0]!.svg);
        expect(saved.dark!.layers![long]!.x).toBe(40);
        const bad = await themeSet({ id: "bad-copy", theme: { name: "B", dark: { colors: { background: "#101418", text: "#eef2f6" }, layers: [{ copy: "nope:dark:0" }, { copy: "night-rain" }] } } }, { ui });
        expect(bad.text).toContain("layers[0].copy");
        expect(bad.text).toContain("layers[1].copy must be");
    });
});

test("mixing toward the text keeps a colour's hue as far as contrast allows", () => {
    const c = mix(parseHex("#ff0000"), parseHex("#000000"), 0.5);
    expect(c).toEqual({ r: 127.5, g: 0, b: 0 });
});

describe("the first paint (theme-boot.js)", () => {
    const BOOT = readFileSync(join(import.meta.dir, "../gui/public/theme-boot.js"), "utf8");
    function boot(store: Record<string, string>, dark: boolean) {
        const dataset: Record<string, string> = {};
        const style: Record<string, string> = {};
        const { runInNewContext } = require("vm") as typeof import("vm");
        runInNewContext(BOOT, {
            document: { documentElement: { dataset, style: { setProperty: (k: string, v: string) => (style[k] = v) } } },
            localStorage: { getItem: (k: string) => store[k] ?? null },
            matchMedia: () => ({ matches: dark }),
        });
        return { dataset, style };
    }
    const cache = JSON.stringify({ id: "glowworms", only: "dark", scened: true, vars: { dark: { "--fg": "#e2f1f2", "--win-tint": "transparent" } } });

    test("paints the theme's colours, in the one scheme it's made for, before the app loads", () => {
        const { dataset, style } = boot({ "cavvy.prefs": JSON.stringify({ scheme: "light", themeId: "glowworms" }), "cavvy.theme": cache }, false);
        expect(dataset.theme).toBe("dark");
        expect(dataset.themeOnly).toBe("dark");
        expect(dataset.themed).toBe("scene");
        expect(style["--fg"]).toBe("#e2f1f2");
    });

    test("paints nothing of a theme that isn't the one chosen", () => {
        const { dataset, style } = boot({ "cavvy.prefs": JSON.stringify({ scheme: "light", themeId: "orbit" }), "cavvy.theme": cache }, false);
        expect(dataset.theme).toBe("light");
        expect(dataset.themed).toBeUndefined();
        expect(style["--fg"]).toBeUndefined();
    });
});
