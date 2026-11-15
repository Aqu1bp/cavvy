// @-mentions: file path completion and expansion of "@path" in prompts.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { spawnSync } from "bun";
import type { TextPart, UserContent } from "../providers/types";
import type { ToolState } from "../tools/types";
import { imageMediaType, looksBinary, isInside, canonical } from "../util/files";
import { fuzzyScore } from "./components";
import { redact } from "../util/redact";
import { withoutReviewQuotes } from "../util/review-quotes";
import { gitArgv, gitEnv } from "../util/git";
import { isImageFile, lexWords, loadImageFile, normalizePath, resolveUserPath, type PrepareOptions } from "./images";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", ".cache", "coverage", ".turbo", ".idea", ".DS_Store"]);

/** Most paths a project's index keeps (git ls-files, or a walk): a repository of a million files is all in it. */
const MAX_INDEXED = 2_000_000;
/** How long building an index works before it lets the server get on with the rest. */
const SLICE_MS = 8;
/** How long an index serves before it's listed again (in the background, on the server). */
const INDEX_FRESH_MS = 30_000;

/** A bit for each kind of character a path has, so a query with one it hasn't is passed over without scoring. */
function charMask(s: string): number {
    let m = 0;
    for (let i = 0; i < s.length; i++) m |= charBit(s.charCodeAt(i));
    return m;
}
function charBit(c: number): number {
    if (c >= 97 && c <= 122) return 1 << (c - 97);
    if (c >= 48 && c <= 57) return 1 << 26;
    if (c === 47) return 1 << 27;
    if (c === 46) return 1 << 28;
    if (c === 95) return 1 << 29;
    if (c === 45) return 1 << 30;
    return 1 << 31;
}
/** Where a word starts in a path (/[\s/:._-]/), by character code below 128. */
const BOUNDARY = (() => {
    const t = new Uint8Array(128);
    for (let c = 0; c < 128; c++) t[c] = /[\s/:._-]/.test(String.fromCharCode(c)) ? 1 : 0;
    return t;
})();
/** Whitespace above 127 /\s/ counts too: a word starts after it. */
const isBoundary = (c: number) => (c < 128 ? BOUNDARY[c] === 1 : /\s/.test(String.fromCharCode(c)));

/**
 * fuzzyScore(q, t.slice(from, end)), for `q` and `t` lower-cased already, without making the slice: as fuzzyScore scores
 * it (a substring first, by where it is; else each character in order).
 */
function scoreIn(q: string, t: string, from: number, end: number): number {
    if (!q) return 1;
    const len = end - from;
    const at = t.indexOf(q, from);
    if (at >= 0 && at + q.length <= end) {
        const idx = at - from;
        return 1000 - idx - len * 0.01 + (idx === 0 || isBoundary(t.charCodeAt(at - 1)) ? 200 : 0);
    }
    let ti = from;
    let score = 0;
    let last = -2;
    for (const c of q) {
        const found = t.indexOf(c, ti);
        if (found < 0 || found >= end) return -1;
        score += found - from === last + 1 ? 5 : 1;
        last = found - from;
        ti = found + 1;
    }
    return score;
}

export class FileIndex {
    /** Folders (with their "/"), then files: as they're offered, in this order on a tie. */
    private paths: string[] = [];
    private lower: string[] = [];
    /** Where each path's last part starts, and its end (a folder's "/" isn't part of it). */
    private baseFrom = new Uint32Array(0);
    private baseEnd = new Uint32Array(0);
    private masks = new Uint32Array(0);
    /** The most each path can score (by its length alone): one that can't beat the best found yet isn't scored. */
    private most = new Float64Array(0);
    private builtAt = 0;
    private building?: Promise<void>;
    /** git's listing the index was made from, hashed: the same again, it's kept as it is (a million files took 2 s). */
    private listedHash?: number | bigint;

    constructor(private root: string) {}

    /**
     * The index of `files` (and the folders they're in). `slice`: a slice of SLICE_MS at a time, the rest after (the
     * server's: a million paths took seconds); none, all at once (the terminal's).
     */
    private async take(files: string[], slice?: () => Promise<void>) {
        let since = performance.now();
        // A promise only when it's time to let the server get on (awaited then, and only then: without slices it all
        // runs before take returns).
        const pause = (k: number): Promise<void> | undefined => {
            if (!slice || k % 512 || performance.now() - since < SLICE_MS) return undefined;
            return slice().then(() => void (since = performance.now()));
        };
        // Each file's folders, up from its own until one is there already (its parents are, then), put in shallowest
        // first: in the order they were offered in (a tie keeps it).
        const dirs = new Set<string>();
        const fresh: string[] = [];
        for (let k = 0; k < files.length; k++) {
            const f = files[k]!;
            for (let end = f.lastIndexOf("/"); end > 0; end = f.lastIndexOf("/", end - 1)) {
                const d = f.slice(0, end + 1);
                if (dirs.has(d)) break;
                fresh.push(d);
            }
            for (let j = fresh.length - 1; j >= 0; j--) dirs.add(fresh[j]!);
            fresh.length = 0;
            const waiting = pause(k);
            if (waiting) await waiting;
        }
        const paths = [...dirs, ...files];
        const n = paths.length;
        const lower = new Array<string>(n);
        const baseFrom = new Uint32Array(n);
        const baseEnd = new Uint32Array(n);
        const masks = new Uint32Array(n);
        const most = new Float64Array(n);
        for (let i = 0; i < n; i++) {
            const p = paths[i]!;
            const l = p.toLowerCase();
            lower[i] = l === p ? p : l;
            const end = p.endsWith("/") ? p.length - 1 : p.length;
            baseEnd[i] = end;
            baseFrom[i] = p.lastIndexOf("/", end - 1) + 1;
            masks[i] = charMask(l);
            // Found at the start of its name, at a word's start (scoreIn), less what its length costs (find).
            most[i] = Math.max(1250 - (end - baseFrom[i]!) * 0.01, 1200 - l.length * 0.01) - p.length * 0.05;
            const waiting = pause(i);
            if (waiting) await waiting;
        }
        Object.assign(this, { paths, lower, baseFrom, baseEnd, masks, most });
        this.builtAt = Date.now();
    }

    private listed(out: string): string[] {
        const files = out.split("\n").filter(Boolean);
        return files.length > MAX_INDEXED ? files.slice(0, MAX_INDEXED) : files;
    }

    /** Listed now, waiting for it, the first time (the terminal's); after, in the background as the server's is. */
    private build() {
        if (this.builtAt) {
            if (Date.now() - this.builtAt >= INDEX_FRESH_MS) void this.buildSoon();
            return;
        }
        const r = spawnSync(gitArgv(["ls-files", "-co", "--exclude-standard"]), { cwd: this.root, stdout: "pipe", stderr: "ignore", timeout: 3000, env: gitEnv() });
        const out = r.exitCode === 0 ? r.stdout.toString() : undefined;
        this.listedHash = out === undefined ? undefined : Bun.hash(out);
        // (No slices: it's all done before take returns.)
        void this.take(out !== undefined ? this.listed(out) : this.walk(this.root, 0, []));
    }

    /** Listed without holding the server: git in a process of its own. */
    private buildSoon(): Promise<void> {
        this.building ??= (async () => {
            try {
                const proc = Bun.spawn(gitArgv(["ls-files", "-co", "--exclude-standard"]), { cwd: this.root, stdout: "pipe", stderr: "ignore", env: gitEnv() });
                const timer = setTimeout(() => proc.kill(), 10_000);
                const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
                clearTimeout(timer);
                const hash = code === 0 ? Bun.hash(out) : undefined;
                // The same files as before: as it is.
                if (hash !== undefined && hash === this.listedHash && this.builtAt) {
                    this.builtAt = Date.now();
                    return;
                }
                this.listedHash = hash;
                await this.take(code === 0 ? this.listed(out) : this.walk(this.root, 0, []), () => new Promise((r) => setImmediate(r)));
            } catch {
                await this.take(this.walk(this.root, 0, []), () => new Promise((r) => setImmediate(r)));
            } finally {
                this.building = undefined;
            }
        })();
        return this.building;
    }

    private walk(dir: string, depth: number, out: string[]): string[] {
        if (depth > 12 || out.length > 20_000) return out;
        let entries;
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        } catch {
            return out;
        }
        for (const e of entries) {
            if (IGNORE.has(e.name)) continue;
            const p = join(dir, e.name);
            if (e.isDirectory()) this.walk(p, depth + 1, out);
            else out.push(relative(this.root, p));
        }
        return out;
    }

    /** The paths that best match `query`, best first (the terminal's: listed the first time before it answers). */
    search(query: string, limit = 12): string[] {
        this.build();
        return this.find(query, limit);
    }

    /**
     * The same, for the server: listed in the background, never waiting on git but the first time. One listed more
     * than INDEX_FRESH_MS ago is used as it is, and listed again meanwhile.
     */
    async searchSoon(query: string, limit = 12): Promise<string[]> {
        if (!this.builtAt) await this.buildSoon();
        else if (Date.now() - this.builtAt >= INDEX_FRESH_MS && !this.building) void this.buildSoon();
        return this.find(query, limit);
    }

    private find(query: string, limit: number): string[] {
        const q = query.replace(/^\.\//, "").toLowerCase();
        const need = charMask(q);
        // The best `limit`, best first; a later one only above an equal one if better (as a stable sort leaves them).
        const best: { i: number; s: number }[] = [];
        for (let i = 0; i < this.paths.length; i++) {
            // Can't beat the last of the best, whatever it scores: not scored.
            if (best.length === limit && this.most[i]! <= best[limit - 1]!.s) continue;
            if ((this.masks[i]! & need) !== need) continue;
            const t = this.lower[i]!;
            // Its name first (by 50), if it's there: a path it isn't in at all isn't offered (it was, at 49, above
            // ones it was in with letters between).
            const base = scoreIn(q, t, this.baseFrom[i]!, this.baseEnd[i]!);
            const s = Math.max(scoreIn(q, t, 0, t.length), base >= 0 ? base + 50 : -1);
            if (s <= 0) continue;
            const score = s - this.paths[i]!.length * 0.05;
            if (best.length === limit && score <= best[limit - 1]!.s) continue;
            let at = best.length;
            while (at > 0 && best[at - 1]!.s < score) at--;
            best.splice(at, 0, { i, s: score });
            if (best.length > limit) best.pop();
        }
        return best.map((b) => this.paths[b.i]!);
    }
}

const MAX_FILE = 256 * 1024;
const IMAGE_END = /\.(?:png|jpe?g|gif|webp)(?=$|[\s,;:!?)])/gi;

/** What expandMentions may read: PermissionChecker, or a stand-in in tests. */
export interface MentionGuard {
    userReadRefusal(abs: string, opts?: { sensitive?: boolean; dir?: boolean }): string | undefined;
}

export interface MentionOptions {
    /** Shrinks oversized images (tests replace it). */
    prepare?: PrepareOptions;
}

interface Mention {
    raw: string;
    abs: string;
}

function existing(p: string): boolean {
    try {
        statSync(p);
        return true;
    } catch {
        return false;
    }
}

/** How far past a mention's first word a space-containing image path may reach, and how many such phrases are tried. */
const MAX_PHRASE = 256;
const MAX_PHRASES = 8;

/**
 * The "@path" mentions in a prompt. A mention is one shell-style word (quotes
 * and backslash escapes allowed); unescaped spaces only join in when the longer
 * phrase names an existing image and the word alone names nothing (a macOS
 * screenshot path typed as is), so the prose after a mention stays prose. A
 * phrase never crosses a line break or the next mention, and each path is
 * looked up once, so a prompt full of missing names stays cheap.
 */
export function findMentions(text: string, cwd: string): Mention[] {
    const out: Mention[] = [];
    const memo = new Map<string, string | undefined>();
    const lookup = (r: string) => {
        if (!memo.has(r)) memo.set(r, resolveUserPath(r, cwd));
        return memo.get(r);
    };
    const at = /(^|\s)@/g;
    for (let m = at.exec(text); m; m = at.exec(text)) {
        const from = m.index + m[0].length;
        const w = lexWords(text, true, from, 1)[0];
        if (!w || w.start !== from) continue;
        const raw = w.raw.replace(/[.,;:!?)]+$/, "");
        if (!raw) continue;
        let found: Mention = { raw, abs: lookup(raw) ?? resolve(cwd, normalizePath(raw)) };
        let end = w.end;
        if (!existing(found.abs)) {
            // one character more, so a phrase cut off at the cap isn't mistaken for one ending there
            const rest = text.slice(from, from + MAX_PHRASE + 1);
            const stop = rest.search(/\n|\s@/);
            const span = stop < 0 ? rest : rest.slice(0, stop);
            let tried = 0;
            for (const e of span.matchAll(IMAGE_END)) {
                const phrase = span.slice(0, e.index! + e[0].length);
                if (!/\s/.test(phrase) || phrase.length > MAX_PHRASE) continue;
                if (++tried > MAX_PHRASES) break;
                const f = lookup(phrase);
                if (f) {
                    found = { raw: phrase, abs: f };
                    end = from + phrase.length;
                    break;
                }
            }
        }
        out.push(found);
        at.lastIndex = end;
    }
    return out;
}

/**
 * Turn "@path" mentions into attached file contents (like a Read), images
 * into image parts. Records read state so the model can edit right away.
 * Mentions reach outside the workspace only for images the user names, and
 * never past deny rules or protected files; images go through the same checks
 * and shrinking as pasted ones.
 */
export async function expandMentions(text: string, state: ToolState, allowedRoots: string[], guard: MentionGuard, opts: MentionOptions = {}): Promise<{ parts: UserContent[]; attached: string[]; notices: string[] }> {
    const parts: UserContent[] = [{ type: "text", text }];
    const attached: string[] = [];
    const notices: string[] = [];
    const seen = new Set<string>();
    for (const { raw, abs } of findMentions(withoutReviewQuotes(text), state.cwd)) {
        if (seen.has(abs) || !existsSync(abs)) continue;
        seen.add(abs);
        let st;
        try {
            st = statSync(abs);
        } catch {
            continue;
        }
        const rel = relative(state.cwd, abs) || abs;
        const c = canonical(abs);
        const inside = allowedRoots.some((r) => isInside(c, canonical(r)));
        // Permission first, by the name: telling an image from a look-alike reads the file.
        const imageName = st.isFile() && imageMediaType(abs) !== undefined;
        if (!inside && !imageName) continue;
        const refused = guard.userReadRefusal(abs, { sensitive: imageName, dir: st.isDirectory() });
        if (refused) {
            notices.push(`Can't attach ${rel}: ${refused}.`);
            continue;
        }
        const image = imageName && isImageFile(abs);
        if (!inside && !image) {
            notices.push(`${rel} isn't a PNG, JPEG, GIF or WebP image, so it wasn't attached.`);
            continue;
        }
        if (st.isDirectory()) {
            try {
                const entries = readdirSync(abs, { withFileTypes: true })
                    .filter((e) => !IGNORE.has(e.name))
                    .slice(0, 300)
                    .map((e) => (e.isDirectory() ? e.name + "/" : e.name))
                    .sort();
                parts.push({ type: "text", text: `Directory listing of ${rel}/:\n${entries.join("\n")}` } as TextPart);
                attached.push(rel + "/");
            } catch {
                // ignore
            }
            continue;
        }
        if (image) {
            const r = await loadImageFile(abs, (p) => guard.userReadRefusal(p, { sensitive: true }), opts.prepare);
            if ("error" in r) notices.push(r.error);
            else {
                parts.push(r.image.part);
                attached.push(rel);
            }
            continue;
        }
        if (st.size > MAX_FILE) {
            parts.push({ type: "text", text: `(${rel} is ${Math.round(st.size / 1024)} KB; too large to attach. Use the Read tool with offset/limit.)` });
            continue;
        }
        const buf = readFileSync(abs);
        if (looksBinary(buf)) continue;
        const content = redact(buf.toString("utf-8"));
        const lines = content.split("\n");
        const numbered = lines
            .slice(0, 2000)
            .map((l, i) => `${String(i + 1).padStart(6)}\t${l}`)
            .join("\n");
        parts.push({ type: "text", text: `Contents of ${rel} (attached by the user with @${raw}):\n${numbered}${lines.length > 2000 ? `\n… (${lines.length - 2000} more lines; use Read with an offset)` : ""}` });
        state.fileState.set(abs, { mtimeMs: st.mtimeMs, size: st.size, partial: lines.length > 2000 });
        attached.push(rel);
    }
    return { parts, attached, notices };
}
