// @-mentions: file path completion and expansion of "@path" in prompts.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { spawnSync } from "bun";
import type { TextPart, UserContent } from "../providers/types";
import type { ToolState } from "../tools/types";
import { imageMediaType, looksBinary, isInside, canonical } from "../util/files";
import { redact } from "../util/redact";
import { withoutReviewQuotes } from "../util/review-quotes";
import { gitArgv, gitEnv } from "../util/git";
import { MAX_INDEXED, PathIndex } from "./path-index";
import { MentionShards, mentionSharding } from "./mention-shards";
import { isImageFile, lexWords, loadImageFile, normalizePath, resolveUserPath, type PrepareOptions } from "./images";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", ".cache", "coverage", ".turbo", ".idea", ".DS_Store"]);

/** How long an index serves before it's listed again (in the background, on the server). */
const INDEX_FRESH_MS = 30_000;

export class FileIndex {
    private index = new PathIndex();
    private builtAt = 0;
    private building?: Promise<void>;
    /** git's listing the index was made from, hashed: the same again, it's kept as it is (a million files took 2 s). */
    private listedHash?: number | bigint;
    /** A big project's paths, on worker threads (the server's: mention-shards.ts); none for a small one. */
    private shards?: MentionShards;
    /** Workers couldn't be had, or one stopped: its paths are indexed here from then on. */
    private noShards = process.env.CAVVY_MENTION_WORKERS === "0";

    constructor(private root: string) {}

    /**
     * The index of `files` (and the folders they're in), in place of the one there was once it's made. `slice`: a slice
     * at a time, the rest after (the server's: a million paths took seconds); none, all at once (the terminal's).
     */
    private async take(files: string[], slice?: () => Promise<void>) {
        const next = new PathIndex();
        const made = next.take(files, { slice });
        // Without slices it's made by now (the terminal's first search counts on it: build).
        if (slice) await made;
        this.index = next;
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
                const [bytes, code] = await Promise.all([new Response(proc.stdout).bytes(), proc.exited]);
                clearTimeout(timer);
                // A big project's: indexed and searched on workers (each keeps its part as it was where it's the same).
                if (code === 0 && bytes.length >= mentionSharding.from && !this.noShards) {
                    this.shards ??= new MentionShards();
                    if (await this.shards.take(bytes)) {
                        this.index = new PathIndex();
                        this.listedHash = undefined;
                        this.builtAt = Date.now();
                        return;
                    }
                    this.noShards = true;
                }
                this.shards?.stop();
                this.shards = undefined;
                const out = code === 0 ? new TextDecoder().decode(bytes) : "";
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
        if (this.shards) {
            try {
                return await this.shards.search(query, limit);
            } catch {
                // A worker stopped: indexed here instead, from now on.
                this.shards.stop();
                this.shards = undefined;
                this.noShards = true;
                this.builtAt = 0;
                await this.buildSoon();
            }
        }
        return this.find(query, limit);
    }

    /** Its workers let go of (it's not used again). */
    dispose() {
        this.shards?.stop();
        this.shards = undefined;
    }

    private find(query: string, limit: number): string[] {
        return this.index.find(query, limit);
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
