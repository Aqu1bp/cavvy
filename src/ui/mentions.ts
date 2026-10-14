// @-mentions: file path completion and expansion of "@path" in prompts.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { spawnSync } from "bun";
import type { ImagePart, TextPart, UserContent } from "../providers/types";
import type { ToolState } from "../tools/types";
import { expandPath, imageMediaType, looksBinary, isInside, canonical } from "../util/files";
import { fuzzyScore } from "./components";
import { redact } from "../util/redact";
import { gitArgv, gitEnv } from "../util/git";

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

const MENTION = /(^|\s)@(?:"([^"]+)"|([^\s"']+))/g;
const MAX_FILE = 256 * 1024;

/**
 * Turn "@path" mentions into attached file contents (like a Read), images
 * into image parts. Records read state so the model can edit right away.
 */
export function expandMentions(text: string, state: ToolState, allowedRoots: string[]): { parts: UserContent[]; attached: string[] } {
    const parts: UserContent[] = [{ type: "text", text }];
    const attached: string[] = [];
    const seen = new Set<string>();
    for (const m of text.matchAll(MENTION)) {
        const raw = (m[2] ?? m[3] ?? "").replace(/[.,;:!?)]+$/, "");
        if (!raw) continue;
        const abs = expandPath(raw, state.cwd);
        if (seen.has(abs) || !existsSync(abs)) continue;
        seen.add(abs);
        const c = canonical(abs);
        // only inside the workspace (or added dirs): mentions shouldn't become a way around permissions
        if (!allowedRoots.some((r) => isInside(c, canonical(r)))) continue;
        let st;
        try {
            st = statSync(abs);
        } catch {
            continue;
        }
        const rel = relative(state.cwd, abs) || abs;
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
        const media = imageMediaType(abs);
        if (media && st.size <= 5 * 1024 * 1024) {
            parts.push({ type: "image", mediaType: media, data: readFileSync(abs).toString("base64") } as ImagePart);
            attached.push(rel);
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
    return { parts, attached };
}
