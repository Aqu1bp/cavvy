import { mkdir, readFile, stat, writeFile } from "fs/promises";
import { existsSync } from "fs";
import { dirname } from "path";
import type { Tool, ToolContext, ToolResult } from "./types";
import { displayPath, expandPath, imageMediaType, looksBinary, numberLines } from "../util/files";
import { redact } from "../util/redact";
import { diffLines, diffStats } from "../util/diff";

const MAX_LINES = 2000;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 10 * 1024 * 1024;

function rel(p: string, ctx: ToolContext) {
    return displayPath(p, ctx.state.projectRoot);
}

async function recordRead(ctx: ToolContext, abs: string, partial: boolean) {
    try {
        const st = await stat(abs);
        ctx.state.fileState.set(abs, { mtimeMs: st.mtimeMs, size: st.size, partial });
    } catch {
        // ignore
    }
}

/** Guard against editing a file the model hasn't seen, or one that changed underneath it. */
async function checkFresh(ctx: ToolContext, abs: string): Promise<string | undefined> {
    const st = await stat(abs).catch(() => undefined);
    if (!st) return undefined;
    const seen = ctx.state.fileState.get(abs);
    if (!seen) return `You must Read ${rel(abs, ctx)} before modifying it.`;
    if (Math.abs(st.mtimeMs - seen.mtimeMs) > 1 || st.size !== seen.size) {
        return `${rel(abs, ctx)} has been modified since you last read it (by the user or another process). Read it again before editing.`;
    }
    return undefined;
}

// ---------------------------------------------------------------------------

export const ReadTool: Tool<{ file_path: string; offset?: number; limit?: number }> = {
    name: "Read",
    category: "read",
    readOnly: true,
    description: `Reads a file from the local filesystem and returns its contents with line numbers (cat -n format: line number, tab, content).

Usage:
- file_path may be absolute or relative to the working directory.
- By default reads up to ${MAX_LINES} lines from the start. For long files pass offset (1-based line number) and limit.
- Lines longer than 2000 characters are truncated.
- Images (PNG, JPG, GIF, WEBP) are returned as images you can see.
- Jupyter notebooks (.ipynb) are rendered as cells with their outputs.
- Directories cannot be read; use LS or Glob instead.
- When you need several files, call Read for all of them in parallel in one response.
- You must Read a file before editing or overwriting it.`,
    parameters: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Path to the file (absolute or relative to the working directory)" },
            offset: { type: "number", description: "1-based line number to start reading from" },
            limit: { type: "number", description: "Maximum number of lines to read" },
        },
        required: ["file_path"],
    },
    title: (i) => `Read(${i.file_path ?? ""})`,
    async run(input, ctx): Promise<ToolResult> {
        const abs = expandPath(input.file_path, ctx.state.cwd);
        const st = await stat(abs).catch(() => undefined);
        if (!st) return { content: `File does not exist: ${abs}`, isError: true };
        if (st.isDirectory()) return { content: `${abs} is a directory. Use LS or Glob to list its contents.`, isError: true };

        const media = imageMediaType(abs);
        if (media) {
            if (st.size > MAX_IMAGE_BYTES) return { content: `Image is too large (${st.size} bytes, max ${MAX_IMAGE_BYTES}).`, isError: true };
            const data = Buffer.from(await readFile(abs)).toString("base64");
            await recordRead(ctx, abs, false);
            return {
                content: `Image file: ${abs} (${media}, ${st.size} bytes)`,
                images: [{ type: "image", mediaType: media, data }],
                display: { summary: `Read image (${Math.round(st.size / 1024)} KB)` },
            };
        }
        if (st.size > MAX_TEXT_BYTES && !input.offset && !input.limit) {
            return { content: `File is large (${st.size} bytes). Use offset and limit to read it in parts, or Grep to search it.`, isError: true };
        }
        const buf = await readFile(abs);
        if (abs.endsWith(".ipynb")) {
            await recordRead(ctx, abs, false);
            return renderNotebook(buf.toString("utf-8"), abs);
        }
        if (looksBinary(buf)) return { content: `${abs} appears to be a binary file and cannot be displayed as text.`, isError: true };

        const text = buf.toString("utf-8");
        if (text.length === 0) {
            await recordRead(ctx, abs, false);
            return { content: `<system-reminder>The file ${abs} exists but is empty.</system-reminder>`, display: { summary: "Empty file" } };
        }
        const all = text.split("\n");
        if (all[all.length - 1] === "") all.pop();
        const start = Math.max(1, Math.floor(input.offset ?? 1));
        const limit = Math.max(1, Math.floor(input.limit ?? MAX_LINES));
        if (start > all.length) {
            return { content: `offset ${start} is past the end of the file (${all.length} lines).`, isError: true };
        }
        const slice = all.slice(start - 1, start - 1 + limit);
        const partial = start > 1 || start - 1 + slice.length < all.length;
        await recordRead(ctx, abs, partial);
        let out = numberLines(slice, start);
        if (start - 1 + slice.length < all.length) {
            out += `\n\n(Showing lines ${start}-${start - 1 + slice.length} of ${all.length}. Use offset/limit to read more.)`;
        }
        const red = redact(out);
        if (red !== out) out = red + "\n\n<system-reminder>Some secrets in this file were redacted.</system-reminder>";
        return { content: out, display: { summary: `Read ${slice.length} line${slice.length === 1 ? "" : "s"}${partial ? ` (of ${all.length})` : ""}` } };
    },
};

function renderNotebook(json: string, abs: string): ToolResult {
    try {
        const nb = JSON.parse(json) as { cells?: { cell_type: string; source: string | string[]; outputs?: any[] }[] };
        const parts: string[] = [];
        (nb.cells ?? []).forEach((c, i) => {
            const src = Array.isArray(c.source) ? c.source.join("") : c.source;
            parts.push(`<cell id="${i}" type="${c.cell_type}">\n${src}\n</cell>`);
            for (const o of c.outputs ?? []) {
                const t = o.text ?? o.data?.["text/plain"];
                if (t) parts.push(`<output cell="${i}">\n${(Array.isArray(t) ? t.join("") : t).slice(0, 4000)}\n</output>`);
            }
        });
        return { content: redact(parts.join("\n")), display: { summary: `Read notebook (${nb.cells?.length ?? 0} cells)` } };
    } catch (e) {
        return { content: `Could not parse notebook ${abs}: ${(e as Error).message}`, isError: true };
    }
}

// ---------------------------------------------------------------------------

export const WriteTool: Tool<{ file_path: string; content: string }> = {
    name: "Write",
    category: "edit",
    readOnly: false,
    description: `Writes a file to the local filesystem, creating parent directories as needed. Overwrites the file if it exists.

Usage:
- If the file already exists you must Read it first; the write fails otherwise.
- Prefer Edit for changing existing files: it only sends the diff. Use Write for new files or complete rewrites.
- Don't create documentation or README files unless asked.`,
    parameters: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Path to the file (absolute or relative to the working directory)" },
            content: { type: "string", description: "The full content to write" },
        },
        required: ["file_path", "content"],
    },
    title: (i) => `Write(${i.file_path ?? ""})`,
    async validate(input, ctx) {
        if (typeof input.content !== "string") return "content must be a string";
        const abs = expandPath(input.file_path, ctx.state.cwd);
        return checkFresh(ctx, abs);
    },
    async preview(input, ctx) {
        const abs = expandPath(input.file_path, ctx.state.cwd);
        const before = existsSync(abs) ? await readFile(abs, "utf-8").catch(() => "") : "";
        return { diff: { path: rel(abs, ctx), before, after: input.content } };
    },
    async run(input, ctx) {
        const abs = expandPath(input.file_path, ctx.state.cwd);
        const existed = existsSync(abs);
        const before = existed ? await readFile(abs, "utf-8").catch(() => "") : "";
        await mkdir(dirname(abs), { recursive: true });
        await writeFile(abs, input.content, "utf-8");
        await recordRead(ctx, abs, false);
        const lines = input.content ? input.content.replace(/\n$/, "").split("\n").length : 0;
        const stats = diffStats(diffLines(before, input.content));
        return {
            content: existed ? `The file ${abs} has been updated.` : `File created successfully at: ${abs}`,
            display: {
                summary: existed ? `Updated with ${stats.added} addition${stats.added === 1 ? "" : "s"} and ${stats.removed} removal${stats.removed === 1 ? "" : "s"}` : `Wrote ${lines} line${lines === 1 ? "" : "s"}`,
                diff: { path: rel(abs, ctx), before, after: input.content },
            },
        };
    },
};

// ---------------------------------------------------------------------------

interface EditSpec {
    old_string: string;
    new_string: string;
    replace_all?: boolean;
}

/** Apply one edit to text. Returns new text or an error message. */
export function applyEdit(text: string, e: EditSpec, label: string): { text: string } | { error: string } {
    if (e.old_string === e.new_string) return { error: "old_string and new_string are identical; no change to make." };
    let oldS = e.old_string;
    let newS = e.new_string;
    let count = countOccurrences(text, oldS);
    if (count === 0 && text.includes("\r\n") && !oldS.includes("\r\n")) {
        // The model writes \n; the file uses \r\n.
        const o2 = oldS.replace(/\n/g, "\r\n");
        const c2 = countOccurrences(text, o2);
        if (c2 > 0) {
            oldS = o2;
            newS = newS.replace(/\n/g, "\r\n");
            count = c2;
        }
    }
    if (count === 0) {
        const hint = /^\s*\d+\t/m.test(oldS) ? " It looks like old_string contains line-number prefixes from Read output; remove them." : "";
        return { error: `old_string was not found in ${label}. It must match the file exactly, including whitespace and indentation.${hint} Read the file again if unsure.` };
    }
    if (count > 1 && !e.replace_all) {
        return { error: `old_string appears ${count} times in ${label}. Add more surrounding context to make it unique, or set replace_all to true to change every occurrence.` };
    }
    if (e.replace_all) return { text: text.split(oldS).join(newS) };
    const idx = text.indexOf(oldS);
    return { text: text.slice(0, idx) + newS + text.slice(idx + oldS.length) };
}

function countOccurrences(text: string, sub: string): number {
    if (!sub) return 0;
    let n = 0;
    let i = 0;
    while ((i = text.indexOf(sub, i)) !== -1) {
        n++;
        i += sub.length;
    }
    return n;
}

function snippetAround(after: string, needle: string): string {
    const idx = needle ? after.indexOf(needle) : 0;
    const lineNo = idx >= 0 ? after.slice(0, idx).split("\n").length : 1;
    const lines = after.split("\n");
    const span = needle.split("\n").length;
    const start = Math.max(1, lineNo - 4);
    const end = Math.min(lines.length, lineNo + span + 3);
    return numberLines(lines.slice(start - 1, end), start);
}

export const EditTool: Tool<{ file_path: string; old_string: string; new_string: string; replace_all?: boolean }> = {
    name: "Edit",
    category: "edit",
    readOnly: false,
    description: `Performs an exact string replacement in a file.

Usage:
- You must Read the file first in this conversation; the edit fails otherwise.
- old_string must match the file exactly, including indentation (copy it from the Read output WITHOUT the line-number prefix).
- The edit fails if old_string is not unique; include more surrounding lines, or set replace_all to replace every occurrence (useful for renames).
- To create a new file, use an empty old_string with a path that doesn't exist yet.
- Keep edits minimal; prefer several small Edits (or MultiEdit) over rewriting a whole file.`,
    parameters: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Path to the file to modify" },
            old_string: { type: "string", description: "Exact text to replace" },
            new_string: { type: "string", description: "Text to replace it with (must differ from old_string)" },
            replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
        },
        required: ["file_path", "old_string", "new_string"],
    },
    title: (i) => `Edit(${i.file_path ?? ""})`,
    async validate(input, ctx) {
        const abs = expandPath(input.file_path, ctx.state.cwd);
        if (input.old_string === "" && !existsSync(abs)) return undefined;
        if (!existsSync(abs)) return `File does not exist: ${abs}. To create it, use Write or an Edit with an empty old_string.`;
        const stale = await checkFresh(ctx, abs);
        if (stale) return stale;
        const text = await readFile(abs, "utf-8");
        const r = applyEdit(text, input, rel(abs, ctx));
        return "error" in r ? r.error : undefined;
    },
    async preview(input, ctx) {
        const abs = expandPath(input.file_path, ctx.state.cwd);
        const before = existsSync(abs) ? await readFile(abs, "utf-8") : "";
        const r = input.old_string === "" && !before ? { text: input.new_string } : applyEdit(before, input, rel(abs, ctx));
        if ("error" in r) return undefined;
        return { diff: { path: rel(abs, ctx), before, after: r.text } };
    },
    async run(input, ctx) {
        const abs = expandPath(input.file_path, ctx.state.cwd);
        if (input.old_string === "" && !existsSync(abs)) {
            await mkdir(dirname(abs), { recursive: true });
            await writeFile(abs, input.new_string, "utf-8");
            await recordRead(ctx, abs, false);
            const lines = input.new_string ? input.new_string.replace(/\n$/, "").split("\n").length : 0;
            return {
                content: `File created successfully at: ${abs}`,
                display: { summary: `Created with ${lines} line${lines === 1 ? "" : "s"}`, diff: { path: rel(abs, ctx), before: "", after: input.new_string } },
            };
        }
        const stale = await checkFresh(ctx, abs);
        if (stale) return { content: stale, isError: true };
        const before = await readFile(abs, "utf-8");
        const r = applyEdit(before, input, rel(abs, ctx));
        if ("error" in r) return { content: r.error, isError: true };
        await writeFile(abs, r.text, "utf-8");
        await recordRead(ctx, abs, false);
        const stats = diffStats(diffLines(before, r.text));
        return {
            content: `The file ${abs} has been updated${input.replace_all ? " (all occurrences)" : ""}. Snippet of the result:\n${redact(snippetAround(r.text, input.new_string))}`,
            display: {
                summary: `Updated with ${stats.added} addition${stats.added === 1 ? "" : "s"} and ${stats.removed} removal${stats.removed === 1 ? "" : "s"}`,
                diff: { path: rel(abs, ctx), before, after: r.text },
            },
        };
    },
};

export const MultiEditTool: Tool<{ file_path: string; edits: EditSpec[] }> = {
    name: "MultiEdit",
    category: "edit",
    readOnly: false,
    description: `Makes several exact string replacements to ONE file in a single atomic operation. Edits are applied in order, each to the result of the previous one; if any edit fails, none are applied.

Same rules as Edit: Read the file first, match text exactly, make each old_string unique (or set replace_all). Prefer this over many sequential Edit calls on the same file.`,
    parameters: {
        type: "object",
        properties: {
            file_path: { type: "string", description: "Path to the file to modify" },
            edits: {
                type: "array",
                description: "Edits to apply in order",
                items: {
                    type: "object",
                    properties: {
                        old_string: { type: "string", description: "Exact text to replace" },
                        new_string: { type: "string", description: "Replacement text" },
                        replace_all: { type: "boolean", description: "Replace all occurrences (default false)" },
                    },
                    required: ["old_string", "new_string"],
                },
            },
        },
        required: ["file_path", "edits"],
    },
    title: (i) => `MultiEdit(${i.file_path ?? ""})`,
    async validate(input, ctx) {
        if (!Array.isArray(input.edits) || input.edits.length === 0) return "edits must be a non-empty array";
        const abs = expandPath(input.file_path, ctx.state.cwd);
        if (!existsSync(abs)) return `File does not exist: ${abs}`;
        const stale = await checkFresh(ctx, abs);
        if (stale) return stale;
        let text = await readFile(abs, "utf-8");
        for (const [i, e] of input.edits.entries()) {
            const r = applyEdit(text, e, rel(abs, ctx));
            if ("error" in r) return `Edit ${i + 1}: ${r.error}`;
            text = r.text;
        }
        return undefined;
    },
    async preview(input, ctx) {
        const abs = expandPath(input.file_path, ctx.state.cwd);
        const before = await readFile(abs, "utf-8").catch(() => "");
        let text = before;
        for (const e of input.edits) {
            const r = applyEdit(text, e, abs);
            if ("error" in r) return undefined;
            text = r.text;
        }
        return { diff: { path: rel(abs, ctx), before, after: text } };
    },
    async run(input, ctx) {
        const abs = expandPath(input.file_path, ctx.state.cwd);
        const stale = await checkFresh(ctx, abs);
        if (stale) return { content: stale, isError: true };
        const before = await readFile(abs, "utf-8");
        let text = before;
        for (const [i, e] of input.edits.entries()) {
            const r = applyEdit(text, e, rel(abs, ctx));
            if ("error" in r) return { content: `Edit ${i + 1} failed, no changes applied: ${r.error}`, isError: true };
            text = r.text;
        }
        await writeFile(abs, text, "utf-8");
        await recordRead(ctx, abs, false);
        const stats = diffStats(diffLines(before, text));
        return {
            content: `Applied ${input.edits.length} edit${input.edits.length === 1 ? "" : "s"} to ${abs}.`,
            display: {
                summary: `Updated with ${stats.added} addition${stats.added === 1 ? "" : "s"} and ${stats.removed} removal${stats.removed === 1 ? "" : "s"}`,
                diff: { path: rel(abs, ctx), before, after: text },
            },
        };
    },
};
