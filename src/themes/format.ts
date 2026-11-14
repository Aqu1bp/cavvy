// A theme as it's written down: a name, and a look for light windows, dark windows or both. A look is three colours
// (the rest of the palette is worked out from them: palette.ts) and a scene of SVG layers behind the window, which
// Cavvy moves itself. Layers are still pictures: what moves them is a short list of keyframes Cavvy turns into
// animations the compositor draws on its own, on the window's shared 50 ms grid (gui/src/lib/stream-clock.ts), so
// no theme, whoever wrote it, can make the window paint for every frame.
//
// Here: the shape, its limits, and the check that turns what an agent or a person wrote into a theme or a list of
// what to fix. Built-in themes go through the same check (test/themes.test.ts).

import { contrast, isHex, parseHex } from "./color";

/** The scene's own units: layers are placed on a 1600 × 1000 stage, which is scaled to cover the window. */
export const STAGE = { width: 1600, height: 1000 } as const;

export const LIMITS = {
    name: 40,
    layers: 60,
    svg: 120_000,
    total: 800_000,
    keyframes: 16,
    durationS: [0.5, 600] as const,
} as const;

/** The window's state a layer can show in: while the session on screen works, or while it doesn't. */
export type LayerWhen = "working" | "idle";

export interface Keyframe {
    /** Where in the loop, 0–1; left out, keyframes are spread evenly. */
    at?: number;
    x?: number;
    y?: number;
    rotate?: number;
    scale?: number;
    opacity?: number;
}

export interface Motion {
    /** Seconds for one pass through the keyframes. */
    duration: number;
    keyframes: Keyframe[];
    /** "alternate" (default) goes back and forth; "repeat" starts over from the first keyframe. */
    loop?: "alternate" | "repeat";
    /** "ease" (default) slows into and out of each keyframe; "linear" moves evenly. */
    easing?: "ease" | "linear";
    /** Seconds; a negative delay starts part of the way through, so copies of a layer don't move in step. */
    delay?: number;
}

export interface Layer {
    /** One SVG document: drawn as an image, so it can't run scripts or load anything. */
    svg: string;
    x?: number;
    y?: number;
    width?: number;
    height?: number;
    opacity?: number;
    /** Where rotate and scale turn about, as fractions of the layer's box: [0.5, 0.5] (default) is its centre. */
    origin?: [number, number];
    motion?: Motion;
    when?: LayerWhen;
}

export interface ThemeColors {
    /** The window's colour. */
    background: string;
    /** Text. */
    text: string;
    /** Buttons, links, focus. Left out, the user's own accent stays. */
    accent?: string;
}

export interface Look {
    colors: ThemeColors;
    /** Painted back to front. None: the theme only colours the window, which stays see-through. */
    layers?: Layer[];
    /** How much of the window's colour lies over the scene at least, 0–1. Cavvy raises it where text needs it. */
    veil?: number;
}

export interface Theme {
    name: string;
    light?: Look;
    dark?: Look;
}

export type Scheme = "light" | "dark";

/** One of the user's themes as a window lists it: the theme, or why it can't be shown. */
export interface ThemeEntry {
    id: string;
    theme?: Theme;
    problems?: string[];
}

/** A theme's id: a file name, and what tools and settings call it by. */
export const ID = /^[a-z0-9][a-z0-9-]{0,47}$/;

/** What the theme's text must reach on its own background (WCAG AA for body text). */
export const TEXT_CONTRAST = 4.5;

export interface Checked {
    theme?: Theme;
    problems: string[];
}

const num = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Where the root <svg> tag starts, past an XML declaration and comments, or -1. A scan, not a pattern: a pattern over repeated comments backtracks for ages on a crafted file. */
function rootAt(t: string): number {
    let i = 0;
    const skip = () => {
        while (i < t.length && /\s/.test(t[i]!)) i++;
    };
    skip();
    if (t.startsWith("<?xml", i)) {
        const end = t.indexOf(">", i);
        if (end < 0) return -1;
        i = end + 1;
        skip();
    }
    while (t.startsWith("<!--", i)) {
        const end = t.indexOf("-->", i + 4);
        if (end < 0) return -1;
        i = end + 3;
        skip();
    }
    return /^<svg[\s>]/i.test(t.slice(i, i + 5)) ? i : -1;
}

/** Why an SVG can't be a layer, or undefined. It's drawn as an image either way: these are told so nothing is silently missing. */
export function svgProblem(svg: string): string | undefined {
    const raw = svg.trim();
    if (rootAt(raw) < 0 || !/<\/svg>\s*$/i.test(raw)) return "isn't one <svg>…</svg> document";
    if (/<!(?:DOCTYPE|ENTITY)/i.test(raw)) return "has a DOCTYPE or ENTITY, which a layer doesn't need";
    if (/<\?xml-stylesheet/i.test(raw)) return "has an xml-stylesheet, which a layer doesn't need: use <style>";
    // As the image's parser reads it: a character reference can spell a word the checks below look for.
    const t = decodeRefs(raw);
    if (/<script[\s/>]/i.test(t)) return "has a <script>, which an image never runs";
    if (/<foreignObject[\s/>]/i.test(t)) return "has a <foreignObject>, which isn't drawn";
    if (/\son[a-z]+\s*=/i.test(t)) return "has an event handler attribute, which an image never runs";
    if (/(?:href|src)\s*=\s*["']\s*(?!#|data:)/i.test(t)) return "links to something outside itself, which an image can't load: use #ids or data: URLs";
    if (/url\(\s*["']?\s*(?!#|data:)/i.test(t)) return "has a url() outside itself, which an image can't load: use url(#id)";
    if (/@import/i.test(t)) return "has an @import, which an image can't load";
    // An image runs these on its own, every frame and out of the window's reach: motion goes in the layer's "motion".
    if (new RegExp(`<${PREFIX}(?:animate\\w*|set|discard)[\\s/>]`, "i").test(t)) return "animates itself (<animate>, <set>): move the layer with \"motion\" instead";
    const embedded = embedsMoving(t);
    if (embedded) return embedded;
    for (const css of styles(t)) {
        // An escape can spell any word in CSS.
        if (css.includes("\\")) return "has a backslash in its CSS, which a layer doesn't need";
        const plain = withoutComments(css);
        if (/@[\w-]*keyframes|(?:animation|transition)[\w-]*\s*:/i.test(plain)) return "animates itself with CSS: move the layer with \"motion\" instead";
    }
    return undefined;
}

/** An element's namespace prefix, if it has one: any name XML allows, which is more than \w. */
const PREFIX = `(?:[^\\s<>/:="'&]+:)?`;

/**
 * Whether an image embedded in the SVG (a data: URL anywhere: href, url()) can animate: an SVG by its type, and by
 * its bytes a GIF, an animated PNG, WebP or AVIF, whatever type the URL claims (the browser goes by the bytes).
 */
function embedsMoving(t: string): string | undefined {
    const moving = "has an SVG, GIF or animated image inside it, which animates itself: draw it in the layer";
    // The type and its parameters are read up to 200 characters (a scan that can't run long); a longer one is refused.
    for (const m of t.matchAll(/data:([^,"'()]{0,201})(?:,([^"'()]*))?/gi)) {
        if (m[1]!.length > 200 || m[2] === undefined) {
            if (m[1]!.length > 200) return "has a data: URL with a type over 200 characters";
            continue;
        }
        const meta = percentDecoded(m[1]!).toLowerCase();
        if (meta.includes("svg")) return moving;
        let bytes: string;
        try {
            bytes = meta.includes(";base64") ? atob(percentDecoded(m[2]!).replace(/\s+/g, "")) : percentDecoded(m[2]!);
        } catch {
            continue; // not base64: the browser can't decode it either
        }
        const head = bytes.slice(0, 64);
        if (head.startsWith("GIF8") || head.trimStart().startsWith("<")) return moving;
        if (head.startsWith("\x89PNG") && bytes.includes("acTL")) return moving;
        if (head.startsWith("RIFF") && head.slice(8, 12) === "WEBP" && bytes.includes("ANIM")) return moving;
        if (/^....ftyp(?:avis|msf1)/.test(head)) return moving;
    }
    return undefined;
}

/** %XX escapes as the bytes (characters 0–255) they stand for. */
function percentDecoded(s: string): string {
    return s.replace(/%([0-9a-f]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
}

/** The text with XML character references (&#97; &#x61;) as the characters they stand for. */
function decodeRefs(t: string): string {
    // Any number of leading zeros, as the parser reads them.
    return t.replace(/&#(?:x0*([0-9a-f]{1,6})|0*([0-9]{1,7}));/gi, (ref, hex: string | undefined, dec: string | undefined) => {
        const code = hex ? parseInt(hex, 16) : Number(dec);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ref;
    });
}

/** The CSS in an SVG: each <style> element's text and each style="…" attribute's value. Linear in the text. */
function styles(t: string): string[] {
    const out: string[] = [];
    const open = new RegExp(`<${PREFIX}style(?=[\\s>/])`, "gi");
    const close = new RegExp(`<\\/${PREFIX}style\\s*>`, "gi");
    let m: RegExpExecArray | null;
    while ((m = open.exec(t))) {
        close.lastIndex = open.lastIndex;
        const end = close.exec(t);
        out.push(t.slice(open.lastIndex, end ? end.index : t.length));
        if (!end) break;
        open.lastIndex = close.lastIndex;
    }
    for (const a of t.matchAll(/\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) out.push(a[1] ?? a[2] ?? "");
    return out;
}

/** CSS with its /* comments *\/ taken out (a comment can sit between a property and its colon). */
function withoutComments(css: string): string {
    let out = "";
    let at = 0;
    for (;;) {
        const start = css.indexOf("/*", at);
        if (start < 0) return out + css.slice(at);
        out += css.slice(at, start) + " ";
        const end = css.indexOf("*/", start + 2);
        if (end < 0) return out;
        at = end + 2;
    }
}

/** The SVG with the namespace it needs to be drawn as an image. */
export function withNamespace(svg: string): string {
    const t = svg.trim();
    const at = rootAt(t);
    if (at < 0) return t;
    const end = t.indexOf(">", at);
    const tag = t.slice(at, end < 0 ? t.length : end);
    return /\sxmlns\s*=/i.test(tag) ? t : `${t.slice(0, at)}<svg xmlns="http://www.w3.org/2000/svg"${t.slice(at + 4)}`;
}

function checkMotion(m: unknown, at: string, problems: string[]): Motion | undefined {
    if (m === undefined) return undefined;
    if (!m || typeof m !== "object") return void problems.push(`${at}.motion must be an object`), undefined;
    const o = m as Record<string, unknown>;
    const [lo, hi] = LIMITS.durationS;
    if (!num(o.duration) || o.duration < lo || o.duration > hi) problems.push(`${at}.motion.duration must be ${lo}–${hi} seconds`);
    if (o.loop !== undefined && o.loop !== "alternate" && o.loop !== "repeat") problems.push(`${at}.motion.loop must be "alternate" or "repeat"`);
    if (o.easing !== undefined && o.easing !== "ease" && o.easing !== "linear") problems.push(`${at}.motion.easing must be "ease" or "linear"`);
    if (o.delay !== undefined && (!num(o.delay) || Math.abs(o.delay) > hi)) problems.push(`${at}.motion.delay must be a number of seconds`);
    const frames = o.keyframes;
    if (!Array.isArray(frames) || frames.length < 2 || frames.length > LIMITS.keyframes) {
        problems.push(`${at}.motion.keyframes must be 2–${LIMITS.keyframes} keyframes`);
        return undefined;
    }
    const out: Keyframe[] = [];
    let last = -1;
    frames.forEach((f, i) => {
        const k = `${at}.motion.keyframes[${i}]`;
        if (!f || typeof f !== "object") return void problems.push(`${k} must be an object`);
        const r = f as Record<string, unknown>;
        const frame: Keyframe = {};
        for (const [key, min, max] of [["x", -3200, 3200], ["y", -3200, 3200], ["rotate", -3600, 3600], ["scale", 0.05, 8], ["opacity", 0, 1], ["at", 0, 1]] as const) {
            if (r[key] === undefined) continue;
            if (!num(r[key]) || (r[key] as number) < min || (r[key] as number) > max) problems.push(`${k}.${key} must be ${min}–${max}`);
            else frame[key] = r[key] as number;
        }
        for (const key of Object.keys(r)) if (!["x", "y", "rotate", "scale", "opacity", "at"].includes(key)) problems.push(`${k} has "${key}": a keyframe takes x, y, rotate, scale, opacity and at`);
        if (frame.at !== undefined) {
            if (frame.at <= last) problems.push(`${k}.at must be later than the keyframe before`);
            last = frame.at;
        }
        out.push(frame);
    });
    const timed = out.filter((f) => f.at !== undefined).length;
    if (timed && timed !== out.length) problems.push(`${at}.motion.keyframes: give every keyframe an "at", or none`);
    if (timed && (out[0]!.at !== 0 || out[out.length - 1]!.at !== 1)) problems.push(`${at}.motion.keyframes: the first "at" must be 0 and the last 1`);
    return { duration: o.duration as number, keyframes: out, loop: o.loop === "repeat" ? "repeat" : "alternate", easing: o.easing === "linear" ? "linear" : "ease", delay: num(o.delay) ? o.delay : 0 };
}

function checkLayer(l: unknown, at: string, problems: string[]): Layer | undefined {
    if (!l || typeof l !== "object") return void problems.push(`${at} must be an object`), undefined;
    const o = l as Record<string, unknown>;
    if (typeof o.svg !== "string" || !o.svg.trim()) return void problems.push(`${at}.svg must be an SVG document`), undefined;
    // Counted as saved, with the namespace Cavvy adds (as the file is read back). Too long: said, and not looked into further.
    const saved = withNamespace(o.svg);
    const long = saved.length > LIMITS.svg;
    if (long) problems.push(`${at}.svg is ${saved.length} characters, with the xmlns Cavvy adds; at most ${LIMITS.svg}`);
    const bad = long ? undefined : svgProblem(o.svg);
    if (bad) problems.push(`${at}.svg ${bad}`);
    const layer: Layer = { svg: saved };
    for (const [key, min, max] of [["x", -3200, 4800], ["y", -3200, 4200], ["width", 1, 6400], ["height", 1, 6400], ["opacity", 0, 1]] as const) {
        if (o[key] === undefined) continue;
        if (!num(o[key]) || (o[key] as number) < min || (o[key] as number) > max) problems.push(`${at}.${key} must be ${min}–${max}`);
        else layer[key] = o[key] as number;
    }
    if (o.origin !== undefined) {
        if (!Array.isArray(o.origin) || o.origin.length !== 2 || !o.origin.every((n) => num(n) && n >= -4 && n <= 5)) problems.push(`${at}.origin must be [x, y] as fractions of the layer's box, like [0.5, 0.5]`);
        else layer.origin = [o.origin[0], o.origin[1]];
    }
    if (o.when !== undefined && o.when !== "working" && o.when !== "idle") problems.push(`${at}.when must be "working" or "idle"`);
    else if (o.when) layer.when = o.when as LayerWhen;
    const motion = checkMotion(o.motion, at, problems);
    if (motion) layer.motion = motion;
    for (const key of Object.keys(o)) if (!["svg", "x", "y", "width", "height", "opacity", "origin", "motion", "when"].includes(key)) problems.push(`${at} has "${key}": a layer takes svg, x, y, width, height, opacity, origin, motion and when`);
    return layer;
}

function checkLook(v: unknown, scheme: Scheme, problems: string[]): Look | undefined {
    if (v === undefined) return undefined;
    if (!v || typeof v !== "object") return void problems.push(`${scheme} must be an object`), undefined;
    const o = v as Record<string, unknown>;
    const c = o.colors as Record<string, unknown> | undefined;
    if (!c || typeof c !== "object") return void problems.push(`${scheme}.colors must have background and text`), undefined;
    for (const key of ["background", "text"] as const) if (!isHex(c[key])) problems.push(`${scheme}.colors.${key} must be a hex colour like #1a1b26`);
    if (c.accent !== undefined && !isHex(c.accent)) problems.push(`${scheme}.colors.accent must be a hex colour like #7aa2ff`);
    for (const key of Object.keys(c)) if (!["background", "text", "accent"].includes(key)) problems.push(`${scheme}.colors has "${key}": colours are background, text and accent`);
    if (isHex(c.background) && isHex(c.text)) {
        const bg = parseHex(c.background);
        const ratio = contrast(parseHex(c.text), bg);
        if (ratio < TEXT_CONTRAST + 1) problems.push(`${scheme}: text on the background is ${ratio.toFixed(1)}:1; it needs at least ${TEXT_CONTRAST + 1}:1 so dimmer text still reads`);
        const light = contrast(bg, { r: 0, g: 0, b: 0 }) > contrast(bg, { r: 255, g: 255, b: 255 });
        if (light !== (scheme === "light")) problems.push(`${scheme}: the background ${c.background} is ${light ? "light" : "dark"}; put it under "${light ? "light" : "dark"}"`);
    }
    if (o.veil !== undefined && (!num(o.veil) || o.veil < 0 || o.veil > 1)) problems.push(`${scheme}.veil must be 0–1`);
    let layers: Layer[] | undefined;
    if (o.layers !== undefined) {
        if (!Array.isArray(o.layers) || o.layers.length > LIMITS.layers) problems.push(`${scheme}.layers must be a list of at most ${LIMITS.layers} layers`);
        else layers = o.layers.map((l, i) => checkLayer(l, `${scheme}.layers[${i}]`, problems)).filter((l): l is Layer => Boolean(l));
    }
    for (const key of Object.keys(o)) if (!["colors", "layers", "veil"].includes(key)) problems.push(`${scheme} has "${key}": a look takes colors, layers and veil`);
    const colors: ThemeColors = { background: String(c.background), text: String(c.text), ...(isHex(c.accent) ? { accent: c.accent } : {}) };
    return { colors, ...(layers?.length ? { layers } : {}), ...(num(o.veil) ? { veil: o.veil } : {}) };
}

/** What was written, as a theme, or what to fix. Every problem is listed, so one round of fixes can take them all. */
export function checkTheme(raw: unknown): Checked {
    const problems: string[] = [];
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { problems: ["a theme must be an object with name and light and/or dark"] };
    const o = raw as Record<string, unknown>;
    if (typeof o.name !== "string" || !o.name.trim()) problems.push("name must be a short name");
    else if (o.name.trim().length > LIMITS.name) problems.push(`name must be at most ${LIMITS.name} characters`);
    const light = checkLook(o.light, "light", problems);
    const dark = checkLook(o.dark, "dark", problems);
    if (o.light === undefined && o.dark === undefined) problems.push("a theme needs a light look, a dark look or both");
    for (const key of Object.keys(o)) if (!["name", "light", "dark", "$schema"].includes(key)) problems.push(`the theme has "${key}": a theme takes name, light and dark`);
    // As saved, with the namespace Cavvy adds to each (so a theme read back from its file counts the same).
    const size = [light, dark].flatMap((l) => l?.layers ?? []).reduce((n, l) => n + l.svg.length, 0);
    if (size > LIMITS.total) problems.push(`the layers' SVG comes to ${size} characters, with the xmlns Cavvy adds to each; at most ${LIMITS.total}`);
    if (problems.length) return { problems };
    return { theme: { name: (o.name as string).trim(), ...(light ? { light } : {}), ...(dark ? { dark } : {}) }, problems };
}

/** The look a window in `scheme` shows: the theme's own for it, or its only one. */
export function lookFor(t: Theme, scheme: Scheme): { look: Look; scheme: Scheme } {
    const own = t[scheme];
    if (own) return { look: own, scheme };
    const other: Scheme = scheme === "light" ? "dark" : "light";
    return { look: t[other]!, scheme: other };
}

/** The one scheme a theme is made for, when it has a look for only one. */
export function onlyScheme(t: Pick<Theme, "light" | "dark">): Scheme | undefined {
    return t.light && !t.dark ? "light" : t.dark && !t.light ? "dark" : undefined;
}
