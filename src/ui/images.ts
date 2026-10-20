// Images in the prompt: dropped or pasted paths, clipboard images, and the
// checks and size limits they have to pass before they're sent.

import { closeSync, mkdtempSync, openSync, readdirSync, readSync, rmSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";
import { fileURLToPath } from "url";
import type { ImagePart } from "../providers/types";
import { imageMediaType, sniffImage } from "../util/files";

/** What providers accept per image (the Read tool and @-mentions use the same cap). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
/** Anthropic rejects images over 8000px on a side; larger ones are shrunk to this first. */
export const MAX_IMAGE_SIDE = 8000;
export const DOWNSCALE_SIDE = 2000;
/** Nothing bigger is read into memory at all, not even to shrink it. */
export const MAX_PROCESS_BYTES = 50 * 1024 * 1024;

export interface NamedImage {
    name: string;
    bytes: number;
    part: ImagePart;
}

/** Why a path the user named still can't be read (deny rules, the credential store, secrets); undefined when it can. */
export type ReadGuard = (abs: string) => string | undefined;

/** Runs a command; `undefined` when it can't start, times out or prints more than `maxBytes`. Replaceable so tests never touch a real clipboard. */
export type Runner = (argv: string[], timeoutMs?: number, maxBytes?: number) => Promise<{ code: number; stdout: Buffer } | undefined>;

/** How long a command asked to stop (SIGTERM) gets before it's killed. */
export const KILL_GRACE_MS = 300;

/** Process groups still running. Detached, they'd outlive the harness, so its exit kills them. */
const liveGroups = new Set<number>();
let killOnExit = false;
function track(pid: number) {
    liveGroups.add(pid);
    if (killOnExit) return;
    killOnExit = true;
    process.once("exit", () => {
        for (const g of liveGroups) {
            try {
                process.kill(-g, "SIGKILL");
            } catch {
                // already gone
            }
        }
    });
}

/**
 * Settles only once the command, and everything it started, has exited: on
 * timeout or too much output its process group gets SIGTERM, then SIGKILL, so
 * a hung tool can't outlive its bound (or keep the caller's temp files alive).
 */
export const runCommand: Runner = async (argv, timeoutMs = 5000, maxBytes = 1024 * 1024) => {
    let proc;
    try {
        // Its own process group, so signals reach whatever it starts too.
        proc = Bun.spawn(argv, { stdout: "pipe", stderr: "ignore", stdin: "ignore", detached: true });
    } catch {
        return undefined;
    }
    const p = proc;
    track(p.pid);
    /** Signal the group; false once nothing in it is left. */
    const group = (sig: NodeJS.Signals | 0) => {
        try {
            process.kill(-p.pid, sig);
            return true;
        } catch {
            return false;
        }
    };
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const gone = async (ms: number) => {
        for (const until = Date.now() + ms; Date.now() < until && group(0); ) await sleep(10);
    };
    let stopped: Promise<"stopped"> | undefined;
    let dropOutput = () => {};
    const stop = () =>
        (stopped ??= (async () => {
            // Its output isn't wanted any more, and a flood of it starves the timers below; Bun also
            // doesn't report the exit while unread output is still in the pipe.
            dropOutput();
            group("SIGTERM");
            // The command may exit on TERM while something it started ignores it, so the grace is the group's.
            await gone(KILL_GRACE_MS);
            group("SIGKILL");
            await Promise.race([p.exited.catch(() => {}), sleep(2000)]);
            await gone(1000);
            return "stopped" as const;
        })());
    let wake = () => {};
    const stopping = new Promise<"stopped">((r) => (wake = () => void stop().then(r)));
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        wake();
    }, timeoutMs);
    const reader = p.stdout.getReader();
    dropOutput = () => void reader.cancel().catch(() => {});
    try {
        const chunks: Uint8Array[] = [];
        let total = 0;
        for (;;) {
            // A grandchild can hold stdout open after the command is gone; once it's stopped, stop reading.
            const r = await Promise.race([reader.read(), stopping]);
            if (r === "stopped") return undefined;
            if (r.done) break;
            total += r.value.length;
            if (total > maxBytes) {
                await stop();
                return undefined;
            }
            chunks.push(r.value);
        }
        const code = await Promise.race([p.exited, stopping]);
        // Timed out, even if the command itself then exited cleanly on TERM: what it started may not have.
        if (timedOut || code === "stopped") {
            await stop();
            return undefined;
        }
        return p.signalCode ? undefined : { code, stdout: Buffer.concat(chunks) };
    } catch {
        await stop();
        return undefined;
    } finally {
        clearTimeout(timer);
        reader.cancel().catch(() => {});
        // Nothing it left behind outlives the call, and it stays on the exit list until then.
        if (stopped) await stopped;
        else group("SIGKILL");
        liveGroups.delete(p.pid);
    }
};

/** The file's bytes, or undefined when it's over `max` (checked before reading, and again while reading in case it grew). */
export function readCapped(path: string, max = MAX_PROCESS_BYTES): Buffer | undefined {
    if (statSync(path).size > max) return undefined;
    const fd = openSync(path, "r");
    try {
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
            const buf = Buffer.allocUnsafe(Math.min(1024 * 1024, max + 1 - total));
            const n = readSync(fd, buf, 0, buf.length, null);
            if (!n) break;
            total += n;
            if (total > max) return undefined;
            chunks.push(buf.subarray(0, n));
        }
        return Buffer.concat(chunks);
    } finally {
        closeSync(fd);
    }
}

function readHead(path: string, n = 64): Buffer {
    try {
        const fd = openSync(path, "r");
        try {
            const buf = Buffer.alloc(n);
            return buf.subarray(0, readSync(fd, buf, 0, n, 0));
        } finally {
            closeSync(fd);
        }
    } catch {
        return Buffer.alloc(0);
    }
}

/** Does the file start like a PNG, JPEG, GIF or WebP? */
export function isImageFile(path: string): boolean {
    return sniffImage(readHead(path)) !== undefined;
}

// ---------------------------------------------------------------------------
// Paths

const SPACE_LIKE = /[\u202f\u00a0]/g;

export interface Word {
    /** As typed, quotes and escapes included. */
    raw: string;
    /** With quotes and escapes undone. */
    value: string;
    /** Starts with an unquoted `~`, so it names the home folder. */
    tilde: boolean;
    start: number;
    end: number;
}

/**
 * Shell-style words: single quotes are literal (backslashes too), double
 * quotes take backslash escapes of `"`, `\`, `$` and backquote, and outside
 * quotes a backslash escapes any character. A quote with no partner is an
 * ordinary character (an apostrophe in prose). With `split` false whitespace
 * is part of the word, for a path pasted with its spaces unescaped.
 */
export function lexWords(s: string, split = true, from = 0, limit = Infinity): Word[] {
    const out: Word[] = [];
    const space = (c: string) => split && /\s/.test(c);
    let i = from;
    while (i < s.length && out.length < limit) {
        if (space(s[i]!)) {
            i++;
            continue;
        }
        const start = i;
        let value = "";
        const tilde = s[i] === "~";
        while (i < s.length && !space(s[i]!)) {
            const c = s[i]!;
            const single = c === "'" ? s.indexOf("'", i + 1) : -1;
            const double = c === '"' ? closingDouble(s, i + 1) : -1;
            if (c === "\\" && i + 1 < s.length) {
                value += s[i + 1];
                i += 2;
            } else if (single > 0) {
                value += s.slice(i + 1, single);
                i = single + 1;
            } else if (double > 0) {
                value += s.slice(i + 1, double).replace(/\\(["\\$`])/g, "$1");
                i = double + 1;
            } else {
                value += c;
                i++;
            }
        }
        out.push({ raw: s.slice(start, i), value, tilde, start, end: i });
    }
    return out;
}

function closingDouble(s: string, from: number): number {
    for (let i = from; i < s.length; i++) {
        if (s[i] === "\\") i++;
        else if (s[i] === '"') return i;
    }
    return -1;
}

/** A lexed word as a filesystem path: file:// URLs decoded and a leading ~ expanded. */
export function wordPath(w: Word | undefined): string {
    if (!w) return "";
    const s = w.value;
    if (/^file:\/\//i.test(s)) {
        try {
            return fileURLToPath(s);
        } catch {
            return decodeURIComponentSafe(s.replace(/^file:\/\/(localhost)?/i, ""));
        }
    }
    if (w.tilde && s === "~") return homedir();
    if (w.tilde && s.startsWith("~/")) return join(homedir(), s.slice(2));
    return s;
}

/** One dropped, pasted or mentioned path, as the filesystem path it means. */
export function normalizePath(raw: string): string {
    return wordPath(lexWords(raw.trim(), false)[0]);
}

function decodeURIComponentSafe(s: string): string {
    try {
        return decodeURIComponent(s);
    } catch {
        return s;
    }
}

/** A paste's words as typed (see lexWords). */
export function splitPathTokens(s: string): string[] {
    return lexWords(s).map((w) => w.raw);
}

/** The comparison form of a file name: macOS puts U+202F or NBSP where a typed path has a space, and case is often lost. */
function nameKey(n: string): string {
    return n.replace(SPACE_LIKE, " ").toLowerCase();
}

function isFile(p: string): boolean {
    try {
        return statSync(p).isFile();
    } catch {
        return false;
    }
}

/** The existing file a path means: as given, with macOS's odd spaces (e.g. before AM/PM), or matched case-insensitively in its directory. */
export function resolveExisting(path: string): string | undefined {
    if (isFile(path)) return path;
    const variants = [
        path.replace(/ (?=[AP]M\b)/i, "\u202f"),
        path.replace(/ (?=[AP]M\b)/i, "\u00a0"),
        path.replace(/ /g, "\u202f"),
        path.replace(/ /g, "\u00a0"),
    ];
    for (const v of variants) if (v !== path && isFile(v)) return v;
    const dir = dirname(path);
    const want = nameKey(basename(path));
    try {
        const hits = readdirSync(dir).filter((n) => nameKey(n) === want);
        // an exact-case hit beats a merely case-insensitive one
        const hit = hits.find((n) => n.replace(SPACE_LIKE, " ") === basename(path)) ?? hits[0];
        if (hit && isFile(join(dir, hit))) return join(dir, hit);
    } catch {
        // unreadable directory: the caller reports it
    }
    return undefined;
}

function absolute(p: string, cwd: string): string {
    return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/** A user-typed path (mention or drop) made absolute and matched to a real file when there is one. */
export function resolveUserPath(raw: string, cwd: string): string | undefined {
    return resolveExisting(absolute(normalizePath(raw), cwd));
}

export interface PastePlan {
    /** Image files to attach, in paste order, with the words they came from. */
    files: { path: string; raw: string }[];
    notices: string[];
}

/**
 * What a paste of image paths means. Words that all name image files become
 * attachments; so does one line naming one with its spaces unescaped (copied
 * from a file manager). A lone absolute image path that can't be found gets a
 * notice: a dragged screenshot thumbnail is deleted within seconds. Anything
 * else (prose, code) is undefined and pasted exactly as it came.
 */
export function planPaste(paste: string, cwd: string): PastePlan | undefined {
    const body = paste.trim();
    if (!body || body.length > 4000) return undefined;
    const words = lexWords(body);
    const fileOf = (w: Word | undefined) => {
        const p = wordPath(w);
        return p && imageMediaType(p) ? resolveExisting(absolute(p, cwd)) : undefined;
    };
    const single = words.length === 1 ? words[0]! : undefined;
    // A lone absolute path is unambiguous: what's in it is checked (and reported) when it's read.
    if (single && imageMediaType(wordPath(single)) && /^(\/|~\/|file:\/\/)/i.test(single.value)) {
        const f = fileOf(single);
        if (f) return { files: [{ path: f, raw: single.raw }], notices: [] };
        return { files: [], notices: [`Couldn't read ${basename(wordPath(single))} (macOS deletes dragged screenshot thumbnails quickly; save the screenshot to a folder or copy it and paste with Ctrl+V)`] };
    }
    const files = words.map(fileOf);
    if (files.every((f) => f && isImageFile(f))) return { files: files.map((f, i) => ({ path: f!, raw: words[i]!.raw })), notices: [] };
    if (!body.includes("\n") && words.length > 1 && /^["']?(\/|~\/|file:\/\/)/i.test(body)) {
        const f = fileOf(lexWords(body, false)[0]);
        if (f && isImageFile(f)) return { files: [{ path: f, raw: body }], notices: [] };
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Preparing an image: content, dimensions, size

export type Prepared = { image: NamedImage } | { error: string };

export interface PrepareOptions {
    run?: Runner;
    platform?: NodeJS.Platform;
}

/** Read an image file the user named and prepare it; the guard's refusal and the size ceiling come before any read. */
export async function loadImageFile(path: string, guard: ReadGuard, opts: PrepareOptions = {}): Promise<Prepared> {
    const name = basename(path);
    const refused = guard(path);
    if (refused) return { error: `Can't attach ${name}: ${refused}.` };
    let data: Buffer | undefined;
    try {
        if (!statSync(path).isFile()) return { error: `Can't attach ${name}: it isn't a file.` };
        data = readCapped(path);
    } catch {
        return { error: `Couldn't read ${name}.` };
    }
    if (!data) return { error: `${name} is too large to attach (over ${MAX_PROCESS_BYTES / 1024 / 1024} MB).` };
    return prepareImage(name, data, opts);
}

/** Bytes as a sendable image: really a PNG, JPEG, GIF or WebP (typed by its content), within the limits or shrunk to fit. */
export async function prepareImage(name: string, data: Buffer, opts: PrepareOptions = {}): Promise<Prepared> {
    const mediaType = sniffImage(data);
    if (!mediaType) return { error: `${name} isn't a PNG, JPEG, GIF or WebP image, so it wasn't attached.` };
    const size = imageSize(data);
    if (planImage(data.length, size) === "ok") return { image: named(name, data, mediaType) };
    const small = await downscale(data, mediaType, opts.run, opts.platform);
    if (small) return { image: named(name, small.data, small.mediaType) };
    const platform = opts.platform ?? process.platform;
    const why = !size ? "its dimensions couldn't be read" : `${(data.length / 1024 / 1024).toFixed(1)} MB, ${size.width}×${size.height}px; the limit is ${MAX_IMAGE_BYTES / 1024 / 1024} MB and ${MAX_IMAGE_SIDE}px`;
    return { error: `${name} can't be attached (${why}). ${platform === "darwin" ? "Shrinking it with sips failed." : "Resize it first."}` };
}

function named(name: string, data: Buffer, mediaType: string): NamedImage {
    return { name, bytes: data.length, part: { type: "image", mediaType, data: data.toString("base64") } };
}

// ---------------------------------------------------------------------------
// Limits

/** Pixel size from the header of a PNG, GIF, JPEG or WebP; undefined when unknown. */
export function imageSize(b: Uint8Array): { width: number; height: number } | undefined {
    const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
    const type = sniffImage(b);
    const ascii = (i: number, n: number) => String.fromCharCode(...b.subarray(i, i + n));
    if (type === "image/png") return b.length >= 24 && ascii(12, 4) === "IHDR" ? { width: dv.getUint32(16), height: dv.getUint32(20) } : undefined;
    if (type === "image/gif") return b.length >= 10 ? { width: dv.getUint16(6, true), height: dv.getUint16(8, true) } : undefined;
    if (type === "image/webp") {
        const chunk = ascii(12, 4);
        if (chunk === "VP8X" && b.length >= 30) return { width: 1 + (b[24]! | (b[25]! << 8) | (b[26]! << 16)), height: 1 + (b[27]! | (b[28]! << 8) | (b[29]! << 16)) };
        if (chunk === "VP8L" && b.length >= 25 && b[20] === 0x2f) {
            const bits = dv.getUint32(21, true);
            return { width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
        }
        // a key frame's start code, then 14-bit sizes
        if (chunk === "VP8 " && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
        return undefined;
    }
    if (type === "image/jpeg") {
        let i = 2;
        while (i + 1 < b.length) {
            if (b[i] !== 0xff) return undefined;
            const m = b[i + 1]!;
            // fill bytes, and markers without a length
            if (m === 0xff) {
                i++;
                continue;
            }
            if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
                i += 2;
                continue;
            }
            if (m === 0xd9 || m === 0xda || i + 4 > b.length) return undefined;
            if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return i + 9 <= b.length ? { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) } : undefined;
            i += 2 + dv.getUint16(i + 2);
        }
    }
    return undefined;
}

/** Send as is, or shrink first; unknown dimensions can't be vouched for, so they're shrunk too. */
export function planImage(bytes: number, size?: { width: number; height: number }): "ok" | "downscale" {
    if (bytes > MAX_IMAGE_BYTES) return "downscale";
    if (!size || !size.width || !size.height || Math.max(size.width, size.height) > MAX_IMAGE_SIDE) return "downscale";
    return "ok";
}

/**
 * Shrink an image with macOS's sips (2000px long side; JPEG if it's still
 * too big). Undefined when it can't be done (other platforms, sips failing,
 * or output that isn't a sendable image either).
 */
export async function downscale(data: Buffer, mediaType: string, run: Runner = runCommand, platform = process.platform): Promise<{ data: Buffer; mediaType: string } | undefined> {
    if (platform !== "darwin") return undefined;
    const dir = mkdtempSync(join(tmpdir(), "harness-img-"));
    try {
        const ext = mediaType === "image/png" ? "png" : mediaType === "image/gif" ? "gif" : mediaType === "image/webp" ? "webp" : "jpg";
        const src = join(dir, `in.${ext}`);
        await Bun.write(src, data);
        const attempts = [
            { args: [] as string[], out: join(dir, `out.${ext}`) },
            { args: ["-s", "format", "jpeg", "-s", "formatOptions", "80"], out: join(dir, "out.jpg") },
        ];
        for (const a of attempts) {
            const r = await run(["sips", "-Z", String(DOWNSCALE_SIDE), ...a.args, src, "--out", a.out], 15_000);
            if (!r || r.code !== 0 || !isFile(a.out)) continue;
            const buf = readCapped(a.out);
            const type = buf && sniffImage(buf);
            if (buf && type && planImage(buf.length, imageSize(buf)) === "ok") return { data: buf, mediaType: type };
        }
        return undefined;
    } catch {
        return undefined;
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

// ---------------------------------------------------------------------------
// Clipboard

/** osascript writes the clipboard's PNG to the file named by its argument (a hex dump on stdout would be twice the size). */
const CLIPBOARD_SCRIPT = [
    "on run argv",
    "set png to the clipboard as «class PNGf»",
    "set f to open for access (POSIX file (item 1 of argv)) with write permission",
    "try",
    "write png to f",
    "on error e",
    "close access f",
    "error e",
    "end try",
    "close access f",
    "end run",
];

/** The clipboard's image as PNG bytes, or undefined when it holds none (or no tool can read it). */
export async function readClipboardImage(run: Runner = runCommand, platform = process.platform): Promise<Buffer | undefined> {
    const isPng = (b: Buffer | undefined) => (b && b.length && sniffImage(b) === "image/png" ? b : undefined);
    if (platform === "darwin") {
        const dir = mkdtempSync(join(tmpdir(), "harness-clip-"));
        try {
            const out = join(dir, "clipboard.png");
            const r = await run(["osascript", ...CLIPBOARD_SCRIPT.flatMap((l) => ["-e", l]), out], 5000);
            return r && r.code === 0 && isFile(out) ? isPng(readCapped(out)) : undefined;
        } catch {
            return undefined;
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    }
    for (const argv of [["wl-paste", "--type", "image/png"], ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"]]) {
        const r = await run(argv, 5000, MAX_PROCESS_BYTES);
        const png = r && r.code === 0 ? isPng(r.stdout) : undefined;
        if (png) return png;
    }
    return undefined;
}
