// Themes: what an agent or a person writes is checked before it's shown, every palette a theme makes keeps the
// window's text at WCAG AA, the veil over a scene is enough wherever text can sit, a scene moves only on the
// compositor and on the window's 50 ms grid, and the tools save, show and explain.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { ServerEvent } from "../src/server/protocol";
import { BUILTINS } from "../src/themes/builtin";
import { contrast, mix, over, parseHex, type Rgb } from "../src/themes/color";
import { checkTheme, lookFor, onlyScheme, svgProblem, withNamespace, type Theme } from "../src/themes/format";
import { CellColors, palette, veilCells, veilFor, WINDOW_TEXT } from "../src/themes/palette";
import { listThemes, removeTheme, restoreTheme, saveTheme } from "../src/themes/store";
import { STEP_MS } from "../gui/src/lib/stream-clock";
import { FRAMES, frameFor, gridOf, layerAnimation, poseAt, sceneFrames, SMOOTH_MS } from "../gui/src/lib/theme-motion";

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
        // Quoted, in an attribute or in CSS, a reference to itself is still one.
        expect(svgProblem(`<svg><rect fill="url('#g')"/><style>rect{fill:url( "#g" )}</style></svg>`)).toBeUndefined();
        expect(svgProblem(`<svg><rect fill="url('https://x')"/></svg>`)).toContain("url()");
    });

    test("an SVG that would animate itself is refused: an image runs it every frame, out of the window's reach", () => {
        for (const svg of [
            '<svg><rect><animate attributeName="x" dur="1s" repeatCount="indefinite"/></rect></svg>',
            '<svg><rect><set attributeName="fill" to="#fff"/></rect></svg>',
            '<svg><g><s:animateTransform type="rotate"/></g></svg>',
            "<svg><style>@keyframes a{to{opacity:0}} rect{animation:a 1s infinite}</style><rect/></svg>",
            '<svg><rect style="transition: opacity 1s"/></svg>',
            "<svg><style>rect{\\61nimation:a 1s}</style><rect/></svg>",
            // Spelled past a plain search: character references, a CSS escape that isn't hex, a comment before the colon.
            "<svg><style>@&#107;eyframes a{to{opacity:0}}</style><rect/></svg>",
            '<svg><rect style="&#97;nimation: a 1s infinite"/></svg>',
            '<svg><rect style="&#x61;nimation: a 1s infinite"/></svg>',
            "<svg><style>@\\keyframes a{to{opacity:0}}</style></svg>",
            "<svg><style>rect{a\\nimation:a 1s}</style><rect/></svg>",
            "<svg><style>rect{animation/**/:a 1s}</style><rect/></svg>",
            "<svg><svg:style>rect{-webkit-animation:a 1s}</svg:style><rect/></svg>",
            '<svg><image href="data:image/svg+xml,%3Csvg%3E%3C/svg%3E"/></svg>',
            '<!DOCTYPE svg [<!ENTITY a "animation">]><svg><rect style="&a;:x 1s"/></svg>',
            '<?xml-stylesheet href="data:text/css,rect{animation:a 1s}"?><svg><rect/></svg>',
            // Prefixes \w doesn't cover, references with leading zeros, animated images under another type.
            '<svg xmlns:s.v="http://www.w3.org/2000/svg"><rect><s.v:animate attributeName="x" dur="1s"/></rect></svg>',
            "<svg><rect><\u00e9:animate attributeName='x' dur='1s'/></rect></svg>",
            "<svg><\u00e9:style>@keyframes a{to{opacity:0}}</\u00e9:style></svg>",
            "<svg><style>@k&#00000101;yframes a{to{opacity:0}}</style></svg>",
            '<svg><rect style="anim&#00000097;tion: a 1s"/></svg>',
            '<svg><rect style="anim&#x00000061;tion: a 1s"/></svg>',
            '<svg><image href="data:image/png;base64,R0lGODlhAQABAAAAACw="/></svg>',
            '<svg><image href="data:;base64,R0lGODlhAQABAAAAACw="/></svg>',
            `<svg><image href="data:image/png;base64,${btoa("\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x08acTL\0\0\0\x02")}"/></svg>`,
            `<svg><image href="data:image/webp;base64,${btoa("RIFF\0\0\0\0WEBPVP8X\0\0\0\0ANIM")}"/></svg>`,
            '<svg><image href="data:image%2Fsvg+xml,%3Csvg%3E%3C/svg%3E"/></svg>',
            `<svg><image href="data:image/png;name=${"x".repeat(201)};base64,R0lGODlhAQABAAAAACw="/></svg>`,
        ]) expect(svgProblem(svg)).toBeDefined();
    });

    test("words that only look like animation are fine outside CSS", () => {
        for (const svg of [
            `<svg><image href="data:image/png;base64,${btoa("\x89PNG\r\n\x1a\n\0\0\0\rIHDR\0\0\0\x01IDAT")}"/></svg>`,
            '<svg xmlns:xlink="http://www.w3.org/1999/xlink"><use xlink:href="#a"/></svg>',
            '<svg><defs><radialGradient id="transition-glow"/></defs><rect class="animation" fill="url(#transition-glow)"/></svg>',
            "<svg><text x='10' y='20'>Animation: transition</text></svg>",
            "<svg><style>.transition-glow{fill:#fff}</style><rect class='transition-glow'/></svg>",
        ]) expect(svgProblem(svg)).toBeUndefined();
    });

    test("a crafted SVG can't keep the check busy (each check is a scan, not a pattern that backtracks)", () => {
        const comments = "<!--a-->".repeat(60) + "<x></svg>";
        const tags = "<svg ".repeat(24_000);
        const started = performance.now();
        expect(svgProblem(comments)).toContain("isn't one <svg>");
        withNamespace(tags);
        for (const body of ["data:".repeat(24_000), "<a".repeat(60_000), "&#0000".repeat(20_000), "<style>".repeat(17_000), "<style>/*".repeat(13_000), ' style="'.repeat(14_000), "&#x61".repeat(24_000)]) svgProblem(`<svg>${body}</svg>`);
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
        const cells = Array.from({ length: cols * rows }, () => new CellColors());
        pixels.forEach((c, i) => cells[Math.floor(Math.floor(i / w) / (h / rows)) * cols + Math.floor((i % w) / (w / cols))]!.add(c.r, c.g, c.b));
        for (const c of cells) c.endPose();
        const map = veilCells(text, bg, cells, cols, rows);
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
        expect(Math.max(...at.map((t) => poseAtPhase(t)(fade).opacity))).toBe(1);
        expect(phases([{ svg: SVG }])).toEqual([0]);
        // Six flashes, each at its peak somewhere: every one is seen at full.
        const flashes = Array.from({ length: 6 }, (_, i) => ({ svg: SVG, motion: { duration: 4, loop: "repeat" as const, keyframes: [{ at: 0, opacity: 0 }, { at: 0.1 + i * 0.12, opacity: 1 }, { at: 0.12 + i * 0.12, opacity: 0 }, { at: 1, opacity: 0 }] } }));
        const seen = phases(flashes);
        for (const f of flashes) expect(Math.max(...seen.map((t) => poseAtPhase(t)(f).opacity))).toBeCloseTo(1, 5);
    });

    test("a fast mover is posed every stretch of its path, delays counted", async () => {
        const { phases, poseAtPhase } = await import("../gui/src/lib/theme-draw");
        const star = { svg: SVG, x: -100, y: 300, width: 60, height: 20, motion: { duration: 3, loop: "repeat" as const, easing: "linear" as const, keyframes: [{ x: 0 }, { x: 2000 }] } };
        const xs = phases([star]).map((t) => poseAtPhase(t)(star).x);
        for (let i = 1; i < xs.length; i++) expect(xs[i]! - xs[i - 1]!).toBeLessThanOrEqual(100);
        // Two copies a half cycle apart are posed apart, as the window runs them.
        const half = { ...star, motion: { ...star.motion, delay: -1.5 } };
        expect(poseAtPhase(0)(half).x).toBeCloseTo(1000, 0);
        expect(poseAtPhase(0)(star).x).toBe(0);
        // There and back: a cycle is two passes.
        const swing = { svg: SVG, motion: { duration: 2, easing: "linear" as const, keyframes: [{ x: 0 }, { x: 100 }] } };
        expect(poseAtPhase(0.5)(swing).x).toBeCloseTo(100, 5);
        expect(poseAtPhase(0.75)(swing).x).toBeCloseTo(50, 5);
    });

    test("a cell's veil covers what passes through it in any pose", () => {
        const text = [parseHex("#e8e8e8")];
        const bg = parseHex("#0c1014");
        const fill = (c: Rgb, n: number) => Array.from({ length: n }, () => c);
        const cell = (bright: number) => {
            const c = new CellColors();
            for (let pose = 0; pose < 8; pose++) {
                for (let i = 0; i < 100; i++) (pose === 3 && i < bright ? c.add(255, 255, 255) : c.add(12, 16, 20));
                c.endPose();
            }
            return c;
        };
        // In one pose of eight, a tenth of the cell: veiled. One pixel of a hundred: let through, as in a still scene.
        expect(veilCells(text, bg, [cell(10)], 1, 1)[0]).toBeGreaterThan(0.3);
        expect(veilCells(text, bg, [cell(1)], 1, 1)[0]).toBe(0);
        expect(veilCells(text, bg, [cell(10)], 1, 1)[0]).toBe(veilFor(text, bg, [...fill(parseHex("#ffffff"), 10), ...fill(bg, 90)]));
    });

    test("is transform and opacity only, in whole steps of its frame, starting and stretching on its grid", () => {
        for (const frame of FRAMES) for (const duration of [0.5, 1.6, 3.2, 7, 13.7, 240]) {
            const grid = gridOf(frame);
            // Every frame is a whole number of 60 a second's, every grid of the frame and of the window's steps.
            expect((frame / SMOOTH_MS) % 1).toBeCloseTo(0, 9);
            expect((grid / frame) % 1).toBeCloseTo(0, 9);
            expect(grid % STEP_MS).toBe(0);
            const a = layerAnimation({ duration, keyframes: [{ x: -10 }, { x: 10, opacity: 0.5 }], delay: -3.33 }, "t", 1, frame);
            expect(a.durationMs % grid).toBe(0);
            const steps = Number(/steps\((\d+)\)/.exec(a.animation)![1]);
            const stops = a.keyframes.match(/[\d.]+%\{/g)!.length - 1;
            expect((a.durationMs / stops) % grid).toBe(0);
            expect(a.durationMs / stops / steps).toBeCloseTo(frame, 9);
            const delay = Number(/ (-?\d+)ms infinite/.exec(a.animation)![1]);
            expect(Math.abs(delay % grid)).toBe(0);
            for (const m of a.keyframes.matchAll(/([a-z-]+):/g)) expect(["transform", "opacity"]).toContain(m[1]!);
            expect(a.animation).toContain("infinite");
        }
    });

    test("a keyframe between two of its stops still shows: a flash isn't sampled away", () => {
        // Dark, a flash at 0.1 of a 6 s pass, dark again by 0.14: the stops fall every 0.25 s (1/24 of the pass).
        const flash = { duration: 6, loop: "repeat" as const, easing: "linear" as const, keyframes: [{ at: 0, opacity: 0 }, { at: 0.08, opacity: 0 }, { at: 0.1, opacity: 1 }, { at: 0.14, opacity: 0 }, { at: 1, opacity: 0 }] };
        const opacities = [...layerAnimation(flash, "f").keyframes.matchAll(/opacity:([\d.]+)/g)].map((m) => Number(m[1]));
        expect(Math.max(...opacities)).toBe(1);
    });

    test("steps each layer as seldom as it can without its steps showing", async () => {
        const layers = async (id: string) => {
            const t = await BUILTINS.find((b) => b.id === id)!.load();
            return (t.light ?? t.dark)!.layers!.filter((l) => l.motion);
        };
        // A window covering a 1512 × 982 screen at 2x: about 2 device pixels to a stage unit.
        const px = 2;
        const meadow = await layers("meadow");
        // The seeds blow across: 60 a second. The clouds drift and the grass sways: a few times a second is enough.
        expect(meadow.filter((l) => l.width === 40).every((l) => frameFor(l, px) === SMOOTH_MS)).toBe(true);
        expect(meadow.filter((l) => l.width === 1600).every((l) => frameFor(l, px) >= 100)).toBe(true);
        expect(meadow.filter((l) => l.width! >= 240 && l.width! <= 420).every((l) => frameFor(l, px) >= 100)).toBe(true);
        const rain = await layers("night-rain");
        // The rain falls a sheet's height in seconds; the lights breathe.
        expect(rain.filter((l) => l.height === 2000).every((l) => frameFor(l, px) === SMOOTH_MS)).toBe(true);
        expect(rain.filter((l) => l.height === 670).every((l) => frameFor(l, px) >= 100)).toBe(true);
        // A turn counts as far as the edge goes, a fade by how much it fades in a step.
        const turn = (duration: number) => frameFor({ svg: "", width: 1000, height: 1000, motion: { duration, keyframes: [{ rotate: 0 }, { rotate: 10 }] } }, px);
        expect(turn(600)).toBe(200);
        expect(turn(10)).toBe(100 / 3);
        expect(turn(4)).toBe(SMOOTH_MS);
        expect(frameFor({ svg: "", motion: { duration: 10, keyframes: [{ opacity: 0.9 }, { opacity: 1 }] } }, px)).toBe(200);
        expect(frameFor({ svg: "", motion: { duration: 10, keyframes: [{ opacity: 0.5 }, { opacity: 1 }] } }, px)).toBe(100);
        expect(frameFor({ svg: "", motion: { duration: 2, keyframes: [{ opacity: 0 }, { opacity: 1 }] } }, px)).toBe(SMOOTH_MS);
        expect(frameFor({ svg: "" }, px)).toBe(200);
        // 30 a second and 20 don't step together: in a scene with both, the 20s go to 30.
        const at = (speed: number): Layer => ({ svg: "", motion: { duration: 10, easing: "linear", keyframes: [{ x: 0 }, { x: speed * 10 }] } });
        // (A unit a second is 2 pixels a second here: at 20 a second, up to 10 units a second moves a pixel a step.)
        expect(frameFor(at(9), px)).toBe(STEP_MS);
        expect(frameFor(at(14), px)).toBe(100 / 3);
        expect(frameFor(at(4), px)).toBe(100);
        expect(sceneFrames([at(9), at(14), at(4)], px)).toEqual([100 / 3, 100 / 3, 100]);
        expect(sceneFrames([at(9), at(4)], px)).toEqual([STEP_MS, 100]);
        // Smaller, a step moves fewer pixels: in a gallery tile a layer steps less often than in the window.
        expect(frameFor(at(30), px)).toBe(SMOOTH_MS);
        expect(frameFor(at(30), 0.3)).toBe(100);
        // A layer drawn four screen pixels to each of its own may step one of its own: as often as a sharp one a quarter as fast.
        expect(frameFor(at(30), px, 4)).toBe(STEP_MS);
        expect(sceneFrames([at(30), at(30)], px, [4])).toEqual([STEP_MS, SMOOTH_MS]);
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

    test("ThemeSet takes a theme a script wrote to a file, only from the project or the temp folder, and never says what a file holds", async () => {
        const { themeSet } = await tools();
        const ui = { showTheme: async () => ({ sent: 1, report: { request: "r", shown: true, scheme: "dark" as const } }) };
        const project = mkdtempSync(join(tmpdir(), "cavvy-project-"));
        const state = { cwd: project, projectRoot: project };
        writeFileSync(join(project, "rain.json"), JSON.stringify({ ...minimal({ name: "From File" }), dark: { ...(minimal().dark as object), layers: [{ copy: "night-rain:dark:0" }] } }));
        const ok = await themeSet({ id: "from-file", file: "rain.json" }, { ui, state });
        expect(ok.isError).toBeUndefined();
        expect(JSON.parse(readFileSync(join(home, "themes", "from-file.json"), "utf8")).dark.layers[0].svg).toContain("<svg");
        // Outside: the repository's own package.json; and a link in the project that points out of it.
        const outside = join(import.meta.dir, "..", "package.json");
        expect((await themeSet({ id: "x", file: outside }, { ui, state })).text).toContain("must be in the project or the temp folder");
        symlinkSync(outside, join(project, "linked.json"));
        expect((await themeSet({ id: "x", file: "linked.json" }, { ui, state })).text).toContain("must be in the project or the temp folder");
        writeFileSync(join(project, "secret.json"), "API_TOKEN=sk-live-abc123");
        const bad = await themeSet({ id: "x", file: join(project, "secret.json") }, { ui, state });
        expect(bad.isError).toBe(true);
        expect(bad.text).not.toContain("sk-live");
        expect(bad.text).not.toContain("API_TOKEN");
        // Some other JSON file: said not to be a theme, and nothing of it said back.
        writeFileSync(join(project, "providers.json"), JSON.stringify({ custom: [{ baseUrl: "http://127.0.0.1:1/v1" }], agents: {} }));
        const other = await themeSet({ id: "x", file: "providers.json" }, { ui, state });
        expect(other.text).toBe("Not saved: file isn't a theme (it has no light or dark look).");
        writeFileSync(join(project, "notes.txt"), "{}");
        expect((await themeSet({ id: "x", file: "notes.txt" }, { ui, state })).text).toContain(".json");
        expect((await themeSet({ id: "x", file: "missing.json" }, { ui, state })).text).toContain("no file");
        expect((await themeSet({ id: "x", file: "rain.json", theme: minimal() }, { ui, state })).text).toBe("Give theme or file, not both.");
        rmSync(project, { recursive: true, force: true });
    });

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

    test("a window on a server still shows this computer's themes: it counts, says what it shows and is sent them", async () => {
        const { Engine } = await import("../src/server/engine");
        const engine = new Engine({ listModels: async () => [] });
        expect(engine.themeShowing()).toBeUndefined();
        const heard: ServerEvent[] = [];
        // Its connection here, as lib/machines.ts makes it: the window's key, and the server it's on.
        const onServer = { send: (e: ServerEvent) => heard.push(e), subs: new Set<string>(), window: "w1", machine: "vps" };
        engine.clients.add(onServer);
        // Hasn't said what it shows: none.
        expect(engine.themeWindows()).toBe(1);
        expect(engine.themeShowing()).toEqual({ id: null });
        await engine.handle(onServer, "themes.showing", { id: "orbit", scheme: "dark" });
        expect(engine.themeShowing()).toEqual({ id: "orbit", scheme: "dark" });
        const shown = engine.showTheme("night-rain", undefined, undefined, 2000);
        const apply = heard.find((e) => e.type === "theme.apply") as Extract<ServerEvent, { type: "theme.apply" }> | undefined;
        expect(apply?.id).toBe("night-rain");
        await engine.handle(onServer, "themes.report", { request: apply!.request, shown: true, scheme: "dark" });
        expect((await shown).report?.shown).toBe(true);
        // A connection with no window (the terminal, a script) isn't one.
        engine.clients.delete(onServer);
        engine.clients.add({ send() {}, subs: new Set<string>() });
        expect(engine.themeWindows()).toBe(0);
    });

    test("ThemeList starts with the theme the windows show, so the agent needn't ask", async () => {
        const { themeList } = await tools();
        saveTheme("listed", checkTheme(minimal({ name: "Listed" })).theme!, join(home, "themes"));
        const first = async (now: { id: string | null; scheme?: "light" | "dark" } | undefined) => (await themeList({}, { ui: { themeShowing: () => now } })).text.split("\n")[0];
        expect(await first({ id: "night-rain", scheme: "dark" })).toBe("Showing now: night-rain (Night Rain), its dark look.");
        expect(await first({ id: "listed", scheme: "dark" })).toBe("Showing now: listed (Listed), its dark look.");
        expect(await first({ id: null, scheme: "light" })).toBe("Showing now: no theme (Cavvy's own light look).");
        // A window that hasn't said: it has no theme (one with a theme says as it starts).
        expect(await first({ id: null })).toBe("Showing now: no theme (Cavvy's own look).");
        expect(await first(undefined)).toBe("No Cavvy window is open, so no theme is showing.");
        // Where there are no windows to ask (the terminal), it says nothing of it.
        expect((await themeList({}, { ui: {} })).text.split("\n")[0]).toBe("Built in (can't be changed; copy one under a new id):");
    });

    test("saving over a theme the user made says so and hands the window the old one for Undo; refining its own doesn't", async () => {
        const { themeSet } = await tools();
        const calls: unknown[][] = [];
        const ui = { showTheme: async (...a: unknown[]) => (calls.push(a), { sent: 1, report: { request: "r", shown: true, scheme: "dark" as const } }) };
        const file = join(home, "themes", "handmade.json");
        const mine = JSON.stringify({ name: "My Handmade", dark: { colors: { background: "#101418", text: "#eef2f6" } } });
        writeFileSync(file, mine);
        const theme = (name: string) => ({ name, dark: { colors: { background: "#140c1f", text: "#efe8f8" } } });
        const first = await themeSet({ id: "handmade", theme: theme("Agent Version") }, { ui });
        expect(first.text).toContain('It replaced "My Handmade"');
        expect(first.text).toContain("Undo");
        expect(calls[0]![2]).toEqual({ name: "My Handmade", text: mine });
        // The agent refining what it saved: quiet.
        const again = await themeSet({ id: "handmade", theme: theme("Agent Version 2") }, { ui });
        expect(again.text).not.toContain("replaced");
        expect(calls[1]![2]).toBeUndefined();
        // Undo puts the user's back, over the agent's.
        restoreTheme("handmade", mine, join(home, "themes"), true);
        expect(readFileSync(file, "utf8")).toBe(mine);
        // A new theme replaces nothing.
        const fresh = await themeSet({ id: "brand-new", theme: theme("New") }, { ui });
        expect(fresh.text).not.toContain("replaced");
        // A long id is told it's too long.
        expect((await themeSet({ id: "a".repeat(49) }, { ui })).text).toContain("at most 48");
        // Another session saving over this one's theme: the user gets Undo for that too.
        const other = { showTheme: ui.showTheme };
        const second = await themeSet({ id: "brand-new", theme: theme("Another Session's") }, { ui: other });
        expect(second.text).toContain('It replaced "New"');
        // With no window to undo it in, the user's theme stays.
        writeFileSync(file, mine);
        const blind = await themeSet({ id: "handmade", theme: theme("Agent Version 3") }, { ui: { ...ui, themeWindows: () => 0 } });
        expect(blind.isError).toBe(true);
        expect(blind.text).toContain("another id");
        expect(readFileSync(file, "utf8")).toBe(mine);
    });

    test("a theme near the size limit counts the same saved as sent, so it doesn't break when read back", () => {
        const theme = (n: number) => minimal({ dark: { colors: { background: "#101418", text: "#eef2f6" }, layers: Array.from({ length: 8 }, () => ({ svg: `<svg viewBox="0 0 1 1"><desc>${"x".repeat(n)}</desc></svg>` })) } });
        // Just under, namespace and all: saved, and reads back whole.
        const under = checkTheme(theme(99_900));
        expect(under.theme).toBeDefined();
        const dir = mkdtempSync(join(tmpdir(), "themes-size-"));
        try {
            saveTheme("big", under.theme!, dir);
            expect(listThemes(dir)[0]!.problems).toBeUndefined();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        // Over once the namespace is counted: refused, saying so.
        expect(checkTheme(theme(99_960)).problems.join()).toContain("xmlns");
        // One layer at the per-layer limit as sent: the same.
        const one = (n: number) => minimal({ dark: { colors: { background: "#101418", text: "#eef2f6" }, layers: [{ svg: `<svg viewBox="0 0 1 1"><desc>${"x".repeat(n)}</desc></svg>` }] } });
        expect(checkTheme(one(120_000 - 42)).problems.join()).toContain("with the xmlns");
        const fits = checkTheme(one(120_000 - 42 - 40));
        expect(fits.theme).toBeDefined();
        const dir2 = mkdtempSync(join(tmpdir(), "themes-size-"));
        try {
            saveTheme("one", fits.theme!, dir2);
            expect(listThemes(dir2)[0]!.problems).toBeUndefined();
        } finally {
            rmSync(dir2, { recursive: true, force: true });
        }
    });

    test("the guide names the tools as the agent has them", async () => {
        const { themeList, themeServerTools } = await import("../src/themes/tools");
        const api = (await themeList({})).text;
        expect(api).not.toMatch(/theme_set|theme_list/);
        expect(api).toContain("ThemeSet");
        const list = themeServerTools(async (_tool, input) => ({ text: (await themeList(input)).text })).find((t) => t.name === "theme_list")!;
        const served = (await list.call({}, { signal: new AbortController().signal, meta: {} })).text;
        expect(served).not.toMatch(/ThemeSet|ThemeList/);
        expect(served).toContain("theme_set");
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
        // Every problem at once: a bad copy doesn't hide the rest, and later layers keep their numbers.
        const both = await themeSet({ id: "bad-copy", theme: { name: "B", dark: { colors: { background: "#101418", text: "#eef2f6" }, layers: [{ copy: "nope:dark:0" }, { svg: "<svg><script/></svg>" }] } } }, { ui });
        expect(both.text).toContain("layers[0].copy");
        expect(both.text).toContain("dark.layers[1]");
        // A source that's there but broken says so.
        writeFileSync(join(home, "themes", "broken-src.json"), JSON.stringify({ name: "Broken", dark: { colors: { background: "#ffffff", text: "#000000" } } }));
        const from = await themeSet({ id: "bad-copy", theme: { name: "B", dark: { colors: { background: "#101418", text: "#eef2f6" }, layers: [{ copy: "broken-src:dark:0" }] } } }, { ui });
        expect(from.text).toContain('theme "broken-src" doesn\'t check out');
        expect(existsSync(join(home, "themes", "bad-copy.json"))).toBe(false);
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
