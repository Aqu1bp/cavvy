import { mkdir, readFile, stat } from "fs/promises";
import { existsSync } from "fs";
import { randomBytes } from "crypto";
import { dirname, isAbsolute } from "path";
import type { Tool, ToolContext, ToolResult } from "./types";
import { displayPath, expandPath, imageMediaType, looksBinary, numberLines } from "../util/files";
import { redact } from "../util/redact";
import { diffLines, diffStats } from "../util/diff";
import { writeTracked } from "../agent/checkpoints";

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
        const redacted = slice.map((line) => redact(line));
        let out = numberLines(redacted, start);
        if (start - 1 + slice.length < all.length) {
            out += `\n\n(Showing lines ${start}-${start - 1 + slice.length} of ${all.length}. Use offset/limit to read more.)`;
        }
        if (redacted.some((line, i) => line !== slice[i])) out += "\n\n<system-reminder>Some secrets in this file were redacted.</system-reminder>";
        return { content: out, display: { summary: `Read ${slice.length} line${slice.length === 1 ? "" : "s"}${partial ? ` (of ${all.length})` : ""}` } };
    },
};

function renderNotebook(json: string, abs: string): ToolResult {
    try {
        const nb = JSON.parse(json) as { cells?: NotebookCell[] };
        const parts: string[] = [];
        (nb.cells ?? []).forEach((c, i) => {
            const id = cellId(c, i);
            parts.push(`<cell id="${id}" type="${c.cell_type}">\n${cellSource(c)}\n</cell>`);
            for (const o of (c.outputs ?? []) as any[]) {
                const t = o.text ?? o.data?.["text/plain"];
                if (t) parts.push(`<output cell="${id}">\n${redact(Array.isArray(t) ? t.join("") : t).slice(0, 4000)}\n</output>`);
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
        // Again: the user may have saved the file while the approval prompt was open.
        const stale = await checkFresh(ctx, abs);
        if (stale) return { content: stale, isError: true };
        const existed = existsSync(abs);
        const before = existed ? await readFile(abs, "utf-8").catch(() => "") : "";
        await mkdir(dirname(abs), { recursive: true });
        await writeTracked(ctx.state, abs, input.content);
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
    return numberLines(lines.slice(start - 1, end).map((line) => redact(line)), start);
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
            await writeTracked(ctx.state, abs, input.new_string);
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
        await writeTracked(ctx.state, abs, r.text);
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
        await writeTracked(ctx.state, abs, text);
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

// ---------------------------------------------------------------------------
// Jupyter notebooks

interface NotebookCell {
    cell_type: string;
    id?: string;
    source?: string | string[];
    metadata?: Record<string, unknown>;
    outputs?: unknown[];
    execution_count?: number | null;
    [key: string]: unknown;
}

interface Notebook {
    cells: NotebookCell[];
    nbformat?: number;
    nbformat_minor?: number;
    [key: string]: unknown;
}

/** The id Read shows for a cell: its own (nbformat 4.5+), or its position. */
function cellId(c: NotebookCell, i: number): string {
    return typeof c.id === "string" && c.id ? c.id : `cell-${i}`;
}

function cellSource(c: NotebookCell): string {
    return Array.isArray(c.source) ? c.source.join("") : (c.source ?? "");
}

/** Source as stored: a list of lines (what Jupyter writes) or one string. */
function toSource(text: string, asList: boolean): string | string[] {
    return asList ? (text.match(/[^\n]*\n|[^\n]+$/g) ?? []) : text;
}

/** Only the ids Read shows: a position in a notebook with ids could be a different cell by now. */
function findCell(cells: NotebookCell[], id: string): number {
    return cells.findIndex((c, n) => cellId(c, n) === id);
}

/** A new cell, keys in the order Jupyter writes them. */
function newCell(type: "code" | "markdown", source: string | string[], id?: string): NotebookCell {
    const ident = id ? { id } : {};
    return type === "code" ? { cell_type: "code", execution_count: null, ...ident, metadata: {}, outputs: [], source } : { cell_type: "markdown", ...ident, metadata: {}, source };
}

function newCellId(cells: NotebookCell[]): string {
    const taken = new Set(cells.map((c) => c.id));
    for (;;) {
        const id = randomBytes(4).toString("hex");
        if (!taken.has(id)) return id;
    }
}

type NotebookEditInput = { notebook_path: string; cell_id?: string; new_source?: string; cell_type?: "code" | "markdown"; edit_mode?: "replace" | "insert" | "delete" };

interface NotebookChange {
    /** The whole file after the edit. */
    text: string;
    /** The cell's source before and after, for the diff. */
    before: string;
    after: string;
    /** For the permission prompt, the result line, and the model. */
    summary: string;
    done: string;
    message: string;
}

/**
 * JSON.parse, except numbers written in a form JSON.stringify wouldn't give
 * back (1.0, 1e-05, integers past 2^53) are kept as written, so saving the
 * notebook doesn't rewrite outputs and metadata the edit never touched.
 */
function parseKeepingNumbers(raw: string): unknown {
    const J = JSON as unknown as { rawJSON?: (text: string) => unknown };
    if (!J.rawJSON) return JSON.parse(raw);
    const keep = J.rawJSON;
    return JSON.parse(raw, function (key: string, value: unknown, ctx?: { source?: string }) {
        // The version numbers are compared below; a raw value would throw there.
        if (key === "nbformat" || key === "nbformat_minor") return value;
        return typeof value === "number" && ctx?.source !== undefined && ctx.source !== String(value) ? keep(ctx.source) : value;
    } as (key: string, value: unknown) => unknown);
}

/** Apply a NotebookEdit to the notebook's JSON, keeping its indentation, line endings and number formatting. */
function editNotebook(raw: string, input: NotebookEditInput, label: string): NotebookChange | { error: string } {
    let nb: Notebook;
    try {
        nb = parseKeepingNumbers(raw) as Notebook;
    } catch (e) {
        return { error: `${label} isn't valid notebook JSON: ${(e as Error).message}` };
    }
    if (!nb || !Array.isArray(nb.cells)) return { error: `${label} has no cells; is it a Jupyter notebook?` };
    const cells = nb.cells;
    const mode = input.edit_mode ?? "replace";
    let idx = -1;
    if (input.cell_id) {
        idx = findCell(cells, input.cell_id);
        if (idx < 0) {
            const ids = cells.slice(0, 30).map((c, i) => cellId(c, i));
            return { error: `Cell "${input.cell_id}" not found in ${label}. Its cells are: ${ids.join(", ") || "(none)"}${cells.length > 30 ? ", …" : ""}. Use the ids Read shows.` };
        }
    } else if (mode !== "insert") return { error: `cell_id is required to ${mode} a cell.` };
    if (mode !== "delete" && typeof input.new_source !== "string") return { error: `new_source is required to ${mode} a cell.` };
    const source = input.new_source ?? "";
    // Cells need ids from nbformat 4.5 on; before that Read shows positions.
    const hasIds = (nb.nbformat ?? 0) > 4 || (nb.nbformat === 4 && (nb.nbformat_minor ?? 0) >= 5);
    const asList = cells.some((c) => Array.isArray(c.source)) || !cells.some((c) => typeof c.source === "string");
    const shifted = hasIds ? "" : " Cells after it moved, so their ids (positions) changed; Read the notebook again before editing them.";

    let change: Omit<NotebookChange, "text">;
    if (mode === "insert") {
        if (!input.cell_type) return { error: "cell_type (code or markdown) is required to insert a cell." };
        const at = idx + 1;
        const id = hasIds ? newCellId(cells) : undefined;
        cells.splice(at, 0, newCell(input.cell_type, toSource(source, asList), id));
        const where = idx < 0 ? "at the start" : `after cell ${input.cell_id}`;
        change = {
            before: "",
            after: source,
            summary: `Insert a ${input.cell_type} cell ${where}`,
            done: `Inserted a ${input.cell_type} cell ${where}`,
            message: `Inserted a ${input.cell_type} cell ${where}; its id is ${id ?? `cell-${at}`}.${at < cells.length - 1 ? shifted : ""}`,
        };
    } else if (mode === "delete") {
        const [old] = cells.splice(idx, 1);
        change = { before: cellSource(old!), after: "", summary: `Delete cell ${input.cell_id}`, done: `Deleted cell ${input.cell_id}`, message: `Deleted cell ${input.cell_id}.${idx < cells.length ? shifted : ""}` };
    } else {
        const old = cells[idx]!;
        const type = input.cell_type ?? old.cell_type;
        const src = toSource(source, Array.isArray(old.source) || (old.source === undefined && asList));
        let cell: NotebookCell;
        if (type !== old.cell_type) cell = { ...newCell(type as "code" | "markdown", src, old.id), metadata: old.metadata ?? {} };
        // Outputs belong to the old code; they'd be wrong for the new.
        else if (type === "code") cell = { ...old, execution_count: null, outputs: [], source: src };
        else cell = { ...old, source: src };
        cells[idx] = cell;
        const cleared = old.cell_type === "code" && (old.outputs?.length || old.execution_count != null) ? " Its outputs were cleared." : "";
        change = {
            before: cellSource(old),
            after: source,
            summary: `Replace cell ${input.cell_id}${type !== old.cell_type ? ` (now ${type})` : ""}${cleared ? "; its outputs are cleared" : ""}`,
            done: `Updated cell ${input.cell_id}`,
            message: `Updated cell ${input.cell_id}${type !== old.cell_type ? `, now a ${type} cell` : ""}.${cleared}`,
        };
    }

    const indent = /^\s*\{\r?\n([ \t]+)"/.exec(raw)?.[1] ?? (raw.trim().includes("\n") ? 1 : 0);
    let text = JSON.stringify(nb, null, indent) + (raw.endsWith("\n") ? "\n" : "");
    if (raw.includes("\r\n")) text = text.replace(/\n/g, "\r\n");
    return { ...change, text };
}

export const NotebookEditTool: Tool<NotebookEditInput> = {
    name: "NotebookEdit",
    category: "edit",
    readOnly: false,
    description: `Edits one cell of a Jupyter notebook (.ipynb): replaces its source, inserts a new cell, or deletes it.

Usage:
- notebook_path must be an absolute path. Read the notebook first; the edit fails otherwise.
- cell_id is the id Read shows (<cell id="...">). In notebooks without their own cell ids, ids are positions (cell-0, cell-1, …) and change when cells are inserted or deleted.
- edit_mode is replace (the default), insert or delete. Insert puts the new cell after cell_id, or at the start when cell_id is omitted, and needs cell_type.
- With replace, cell_type changes the cell's type. Replacing a code cell clears its outputs and execution count.`,
    parameters: {
        type: "object",
        properties: {
            notebook_path: { type: "string", description: "Absolute path to the .ipynb file" },
            cell_id: { type: "string", description: "Cell to replace or delete, or to insert after (omit to insert at the start)" },
            new_source: { type: "string", description: "The cell's new source (replace and insert)" },
            cell_type: { type: "string", enum: ["code", "markdown"], description: "Cell type; required for insert" },
            edit_mode: { type: "string", enum: ["replace", "insert", "delete"], description: "replace (default), insert or delete" },
        },
        required: ["notebook_path"],
    },
    title: (i) => `NotebookEdit(${i.notebook_path ?? ""})`,
    async validate(input, ctx) {
        if (!isAbsolute(input.notebook_path.trim())) return `notebook_path must be an absolute path, not ${input.notebook_path}.`;
        const abs = expandPath(input.notebook_path, ctx.state.cwd);
        if (!abs.toLowerCase().endsWith(".ipynb")) return `${rel(abs, ctx)} isn't a Jupyter notebook (.ipynb). Use Edit for other files.`;
        if (!existsSync(abs)) return `File does not exist: ${abs}`;
        const stale = await checkFresh(ctx, abs);
        if (stale) return stale;
        const r = editNotebook(await readFile(abs, "utf-8"), input, rel(abs, ctx));
        return "error" in r ? r.error : undefined;
    },
    async preview(input, ctx) {
        const abs = expandPath(input.notebook_path, ctx.state.cwd);
        const r = editNotebook(await readFile(abs, "utf-8"), input, rel(abs, ctx));
        if ("error" in r) return undefined;
        return { summary: r.summary, diff: { path: rel(abs, ctx), before: r.before, after: r.after } };
    },
    async run(input, ctx) {
        const abs = expandPath(input.notebook_path, ctx.state.cwd);
        const stale = await checkFresh(ctx, abs);
        if (stale) return { content: stale, isError: true };
        const r = editNotebook(await readFile(abs, "utf-8"), input, rel(abs, ctx));
        if ("error" in r) return { content: r.error, isError: true };
        await writeTracked(ctx.state, abs, r.text);
        await recordRead(ctx, abs, false);
        return { content: r.message, display: { summary: r.done, diff: { path: rel(abs, ctx), before: r.before, after: r.after } } };
    },
};
