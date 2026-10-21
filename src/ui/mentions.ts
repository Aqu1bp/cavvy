// @-mentions: file path completion and expansion of "@path" in prompts.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative, resolve } from "path";
import { spawnSync } from "bun";
import type { TextPart, UserContent } from "../providers/types";
import type { ToolState } from "../tools/types";
import { imageMediaType, looksBinary, isInside, canonical } from "../util/files";
import { fuzzyScore } from "./components";
import { redact } from "../util/redact";
import { gitArgv, gitEnv } from "../util/git";
import { isImageFile, lexWords, loadImageFile, normalizePath, resolveUserPath, type PrepareOptions } from "./images";

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", "target", "__pycache__", ".venv", "venv", ".cache", "coverage", ".turbo", ".idea", ".DS_Store"]);

export class FileIndex {
    private files: string[] = [];
    private dirs: string[] = [];
    private builtAt = 0;

    constructor(private root: string) {}

    private build() {
        if (Date.now() - this.builtAt < 30_000 && this.files.length) return;
        this.builtAt = Date.now();
        const r = spawnSync(gitArgv(["ls-files", "-co", "--exclude-standard"]), { cwd: this.root, stdout: "pipe", stderr: "ignore", timeout: 3000, env: gitEnv() });
        let files: string[] = [];
        if (r.exitCode === 0) files = r.stdout.toString().split("\n").filter(Boolean).slice(0, 50_000);
        else files = this.walk(this.root, 0, []);
        const dirs = new Set<string>();
        for (const f of files) {
            const parts = f.split("/");
            for (let i = 1; i < parts.length; i++) dirs.add(parts.slice(0, i).join("/") + "/");
        }
        this.files = files;
        this.dirs = [...dirs];
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

    search(query: string, limit = 12): string[] {
        this.build();
        const q = query.replace(/^\.\//, "");
        const scored: { p: string; s: number }[] = [];
        for (const p of [...this.dirs, ...this.files]) {
            const base = p.replace(/\/$/, "").split("/").pop() ?? p;
            const s = Math.max(fuzzyScore(q, p), fuzzyScore(q, base) + 50);
            if (s > 0) scored.push({ p, s: s - p.length * 0.05 });
        }
        scored.sort((a, b) => b.s - a.s);
        return scored.slice(0, limit).map((x) => x.p);
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

const REVIEW_BLOCK = /<review_comment file="[^"]*" lines="[^"]*">\n([\s\S]*?)\n<\/review_comment>/g;
/**
 * The text without each review comment's quoted diff lines (gui/src/lib/review-comments): the
 * repository's code, not something the user named. What the user wrote above it still counts,
 * a diff of their own in it too. The quote is found from the block's end, as the GUI reads it:
 * its fence is longer than any run of backticks inside it, and a closing tag inside is escaped.
 */
function typedText(text: string): string {
    if (!text.includes("<review_comment ")) return text;
    return text.replace(REVIEW_BLOCK, (block, body: string) => {
        const closing = body.lastIndexOf("\n");
        const fence = body.slice(closing + 1);
        if (!/^`{3,}$/.test(fence)) return block;
        const open = body.lastIndexOf(`\n\n${fence}diff\n`, closing);
        return open < 0 ? block : block.slice(0, block.indexOf(">\n") + 2) + body.slice(0, open) + "\n</review_comment>";
    });
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
    for (const { raw, abs } of findMentions(typedText(text), state.cwd)) {
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
