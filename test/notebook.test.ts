// NotebookEdit: replace, insert and delete cells by the ids Read shows,
// keeping the notebook's JSON layout, with Edit's read-first and permission rules.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const { ReadTool, NotebookEditTool } = await import("../src/tools/file-tools");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { PermissionChecker } = await import("../src/permissions/checker");
const { paths } = await import("../src/config/paths");

afterAll(cleanup);

const toolCtx = (cwd: string) => ({ state: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() }, settings: {}, signal: new AbortController().signal }) as any;
const lines = (s: string) => s.match(/[^\n]*\n|[^\n]+$/g) ?? [];

const code = (id: string | undefined, src: string) => ({
    cell_type: "code",
    execution_count: 3,
    ...(id ? { id } : {}),
    metadata: { tags: ["keep"] },
    outputs: [{ name: "stdout", output_type: "stream", text: ["old output\n"] }],
    source: lines(src),
});
const markdown = (id: string | undefined, src: string) => ({ cell_type: "markdown", ...(id ? { id } : {}), metadata: {}, source: lines(src) });
const notebook = (cells: object[], minor = 5) => ({
    cells,
    metadata: { kernelspec: { display_name: "Python 3", language: "python", name: "python3" }, language_info: { name: "python" } },
    nbformat: 4,
    nbformat_minor: minor,
});
/** How Jupyter writes a notebook: one-space indent, a trailing newline. */
const jupyter = (nb: object) => JSON.stringify(nb, null, 1) + "\n";

/** A project with a notebook in it that the model has already Read. */
async function setup(nb: object, text = jupyter(nb)) {
    const proj = realpathSync(tempDir());
    const file = join(proj, "analysis.ipynb");
    writeFileSync(file, text);
    const ctx = toolCtx(proj);
    const read = await ReadTool.run({ file_path: file }, ctx);
    return { proj, file, ctx, read: read.content };
}

/** Validate, then run, like the agent does. */
async function edit(ctx: any, input: Record<string, unknown>) {
    const err = await NotebookEditTool.validate!(input as any, ctx);
    if (err) return { error: err };
    return NotebookEditTool.run(input as any, ctx);
}

const BASE = () => notebook([markdown("intro", "# Title\n"), code("load", "import pandas as pd\ndf = pd.read_csv('x.csv')"), code("plot", "df.plot()")]);

describe("Read shows the ids NotebookEdit takes", () => {
    test("a cell's own id, also on its outputs", async () => {
        const { read } = await setup(BASE());
        expect(read).toContain('<cell id="intro" type="markdown">\n# Title\n\n</cell>');
        expect(read).toContain('<cell id="load" type="code">\nimport pandas as pd\ndf = pd.read_csv(\'x.csv\')\n</cell>');
        expect(read).toContain('<output cell="load">\nold output\n\n</output>');
    });
    test("positions in a notebook without ids (nbformat 4.4)", async () => {
        const { read } = await setup(notebook([markdown(undefined, "a"), code(undefined, "b")], 4));
        expect(read).toContain('<cell id="cell-0" type="markdown">');
        expect(read).toContain('<cell id="cell-1" type="code">');
        expect(read).toContain('<output cell="cell-1">');
    });
});

describe("NotebookEdit", () => {
    test("is a built-in edit tool", () => {
        const t = BUILTIN_TOOLS.find((x) => x.name === "NotebookEdit");
        expect(t).toBe(NotebookEditTool);
        expect(t!.category).toBe("edit");
    });

    test("replace changes only that cell's source and clears its outputs; the rest of the file is byte for byte the same", async () => {
        const { file, ctx, read } = await setup(BASE());
        const id = /<cell id="([^"]+)" type="code">\nimport pandas/.exec(read)![1]!;
        const r: any = await edit(ctx, { notebook_path: file, cell_id: id, new_source: "import polars as pl\ndf = pl.read_csv('x.csv')" });
        expect(r.isError).toBeUndefined();
        expect(r.content).toBe("Updated cell load. Its outputs were cleared.");
        const want = BASE();
        want.cells[1] = { ...want.cells[1]!, execution_count: null, outputs: [], source: ["import polars as pl\n", "df = pl.read_csv('x.csv')"] };
        expect(readFileSync(file, "utf-8")).toBe(jupyter(want));
        expect(r.display.diff).toEqual({ path: "analysis.ipynb", before: "import pandas as pd\ndf = pd.read_csv('x.csv')", after: "import polars as pl\ndf = pl.read_csv('x.csv')" });
    });

    test("numbers elsewhere in the file keep how Python wrote them (1.0, 1e-05, -0.0, integers past 2^53)", async () => {
        // JSON.stringify would write these as 1, 0.00001, 0 and 12345678901234567000.
        const RAW: Record<string, string> = { __A__: "1.0", __B__: "1e-05", __C__: "-0.0", __D__: "12345678901234567890" };
        const python = (nb: object) => jupyter(nb).replace(/"(__[A-D]__)"/g, (_m, k: string) => RAW[k]!);
        const nb = () => {
            const n = BASE();
            n.cells[2] = { ...n.cells[2]!, outputs: [{ output_type: "execute_result", execution_count: 3, data: { "application/json": { x: ["__A__", "__B__", "__C__"] } }, metadata: {} }] } as any;
            (n.metadata as any).widget_id = "__D__";
            return n;
        };
        const { file, ctx } = await setup(nb(), python(nb()));
        const r: any = await edit(ctx, { notebook_path: file, cell_id: "intro", new_source: "# New title\n" });
        expect(r.isError).toBeUndefined();
        const want = nb();
        want.cells[0] = { ...want.cells[0]!, source: ["# New title\n"] };
        expect(readFileSync(file, "utf-8")).toBe(python(want));
    });

    test("version numbers written as floats (4.0, 5.0) still work", async () => {
        const text = jupyter(BASE()).replace('"nbformat": 4,', '"nbformat": 4.0,').replace('"nbformat_minor": 5', '"nbformat_minor": 5.0');
        expect(text).toContain('"nbformat": 4.0,');
        const { file, ctx } = await setup(BASE(), text);
        const r: any = await edit(ctx, { notebook_path: file, cell_id: "intro", edit_mode: "insert", cell_type: "markdown", new_source: "More" });
        expect(r.isError).toBeUndefined();
        expect(JSON.parse(readFileSync(file, "utf-8")).cells.length).toBe(4);
    });

    test("replace with cell_type changes the cell's type", async () => {
        const { file, ctx } = await setup(BASE());
        await edit(ctx, { notebook_path: file, cell_id: "plot", new_source: "Plot it.", cell_type: "markdown" });
        const nb = JSON.parse(readFileSync(file, "utf-8"));
        expect(nb.cells[2]).toEqual({ cell_type: "markdown", id: "plot", metadata: { tags: ["keep"] }, source: ["Plot it."] });
    });

    test("insert without a cell_id goes at the start, with a new id (nbformat 4.5)", async () => {
        const { file, ctx } = await setup(BASE());
        const r: any = await edit(ctx, { notebook_path: file, edit_mode: "insert", cell_type: "code", new_source: "import os\nprint(os.getcwd())\n" });
        const nb = JSON.parse(readFileSync(file, "utf-8"));
        expect(nb.cells.map((c: any) => c.id).slice(1)).toEqual(["intro", "load", "plot"]);
        const added = nb.cells[0];
        expect(added.id).toMatch(/^[0-9a-f]{8}$/);
        // The keys Jupyter writes, in its order.
        expect(Object.keys(added)).toEqual(["cell_type", "execution_count", "id", "metadata", "outputs", "source"]);
        expect(added).toEqual({ cell_type: "code", execution_count: null, id: added.id, metadata: {}, outputs: [], source: ["import os\n", "print(os.getcwd())\n"] });
        expect(r.content).toBe(`Inserted a code cell at the start; its id is ${added.id}.`);
        // Read shows the new cell under the id the result gave.
        expect((await ReadTool.run({ file_path: file }, ctx)).content).toContain(`<cell id="${added.id}" type="code">\nimport os\n`);
    });

    test("insert after a cell id", async () => {
        const { file, ctx } = await setup(BASE());
        await edit(ctx, { notebook_path: file, edit_mode: "insert", cell_id: "load", cell_type: "markdown", new_source: "## Plot" });
        const nb = JSON.parse(readFileSync(file, "utf-8"));
        expect(nb.cells.map((c: any) => c.source.join(""))).toEqual(["# Title\n", "import pandas as pd\ndf = pd.read_csv('x.csv')", "## Plot", "df.plot()"]);
        expect(Object.keys(nb.cells[2])).toEqual(["cell_type", "id", "metadata", "source"]);
    });

    test("delete removes the cell", async () => {
        const { file, ctx } = await setup(BASE());
        const r: any = await edit(ctx, { notebook_path: file, edit_mode: "delete", cell_id: "intro" });
        expect(r.content).toBe("Deleted cell intro.");
        const want = BASE();
        want.cells.shift();
        expect(readFileSync(file, "utf-8")).toBe(jupyter(want));
        expect(r.display.diff).toEqual({ path: "analysis.ipynb", before: "# Title\n", after: "" });
    });

    test("an unknown cell id is refused, naming the ids there are, and nothing is written", async () => {
        const { file, ctx } = await setup(BASE());
        const before = readFileSync(file, "utf-8");
        const r: any = await edit(ctx, { notebook_path: file, cell_id: "nope", new_source: "x" });
        expect(r.error).toBe('Cell "nope" not found in analysis.ipynb. Its cells are: intro, load, plot. Use the ids Read shows.');
        // run() checks again on its own.
        const ran = await NotebookEditTool.run({ notebook_path: file, cell_id: "nope", new_source: "x" }, ctx);
        expect(ran.isError).toBe(true);
        expect(readFileSync(file, "utf-8")).toBe(before);
    });

    test("keeps the file's own indentation, line endings and missing final newline, and string sources", async () => {
        const nb = notebook([{ ...markdown("m", ""), source: "Hello\nworld" }, { ...code("c", ""), source: "x = 1" }]);
        for (const [indent, eol, end] of [[2, "\n", ""], ["\t", "\n", "\n"], [1, "\r\n", "\r\n"]] as const) {
            const text = JSON.stringify(nb, null, indent).replace(/\n/g, eol) + end;
            const { file, ctx } = await setup(nb, text);
            await edit(ctx, { notebook_path: file, cell_id: "m", new_source: "Hi\nthere" });
            const want = structuredClone(nb);
            want.cells[0] = { ...want.cells[0]!, source: "Hi\nthere" };
            expect(readFileSync(file, "utf-8")).toBe(JSON.stringify(want, null, indent).replace(/\n/g, eol) + end);
        }
    });

    test("notebooks without ids get no ids, and the result says positions moved", async () => {
        const nb = notebook([markdown(undefined, "a"), code(undefined, "b")], 4);
        const { file, ctx } = await setup(nb);
        const r: any = await edit(ctx, { notebook_path: file, edit_mode: "insert", cell_id: "cell-0", cell_type: "code", new_source: "c" });
        expect(r.content).toBe("Inserted a code cell after cell cell-0; its id is cell-1. Cells after it moved, so their ids (positions) changed; Read the notebook again before editing them.");
        const saved = JSON.parse(readFileSync(file, "utf-8"));
        expect(saved.cells.map((c: any) => c.id)).toEqual([undefined, undefined, undefined]);
        expect(saved.cells.map((c: any) => c.source.join(""))).toEqual(["a", "c", "b"]);
        const del: any = await edit(ctx, { notebook_path: file, edit_mode: "delete", cell_id: "cell-2" });
        expect(del.content).toBe("Deleted cell cell-2.");
    });

    test("in a notebook with ids, a position isn't an id, so a repeated delete can't take the next cell", async () => {
        const { file, ctx } = await setup(BASE());
        expect(((await edit(ctx, { notebook_path: file, edit_mode: "delete", cell_id: "cell-2" })) as any).error).toContain('Cell "cell-2" not found');
        const nb = notebook([markdown("cell-0", "a"), markdown("keep", "b")]);
        const s = await setup(nb);
        expect(((await edit(s.ctx, { notebook_path: s.file, edit_mode: "delete", cell_id: "cell-0" })) as any).content).toBe("Deleted cell cell-0.");
        expect(((await edit(s.ctx, { notebook_path: s.file, edit_mode: "delete", cell_id: "cell-0" })) as any).error).toContain('Cell "cell-0" not found');
        expect(JSON.parse(readFileSync(s.file, "utf-8")).cells.map((c: any) => c.id)).toEqual(["keep"]);
    });

    test("like Edit: the notebook must have been Read, and not changed since", async () => {
        const { file, ctx } = await setup(BASE());
        const fresh = toolCtx(ctx.state.cwd);
        expect(await NotebookEditTool.validate!({ notebook_path: file, cell_id: "plot", new_source: "x" }, fresh)).toBe("You must Read analysis.ipynb before modifying it.");
        writeFileSync(file, jupyter(notebook([markdown("intro", "changed by the user")])));
        expect(await NotebookEditTool.validate!({ notebook_path: file, cell_id: "intro", new_source: "x" }, ctx)).toContain("has been modified since you last read it");
        const r = await NotebookEditTool.run({ notebook_path: file, cell_id: "intro", new_source: "x" }, ctx);
        expect(r.isError).toBe(true);
        expect(readFileSync(file, "utf-8")).toContain("changed by the user");
    });

    test("refuses relative paths, other files and incomplete input", async () => {
        const { proj, file, ctx } = await setup(BASE());
        const v = (input: object) => NotebookEditTool.validate!(input as any, ctx);
        expect(await v({ notebook_path: "analysis.ipynb", cell_id: "plot", new_source: "x" })).toBe("notebook_path must be an absolute path, not analysis.ipynb.");
        writeFileSync(join(proj, "notes.txt"), "x");
        expect(await v({ notebook_path: join(proj, "notes.txt"), cell_id: "plot", new_source: "x" })).toBe("notes.txt isn't a Jupyter notebook (.ipynb). Use Edit for other files.");
        expect(await v({ notebook_path: join(proj, "missing.ipynb"), new_source: "x", edit_mode: "insert", cell_type: "code" })).toContain("File does not exist");
        expect(await v({ notebook_path: file, new_source: "x" })).toBe("cell_id is required to replace a cell.");
        expect(await v({ notebook_path: file, edit_mode: "insert", new_source: "x" })).toBe("cell_type (code or markdown) is required to insert a cell.");
        expect(await v({ notebook_path: file, cell_id: "plot" })).toBe("new_source is required to replace a cell.");
    });

    test("the permission prompt gets a diff of the cell and a summary", async () => {
        const { file, ctx } = await setup(BASE());
        expect(await NotebookEditTool.preview!({ notebook_path: file, cell_id: "plot", new_source: "df.plot(kind='bar')" }, ctx)).toEqual({
            summary: "Replace cell plot; its outputs are cleared",
            diff: { path: "analysis.ipynb", before: "df.plot()", after: "df.plot(kind='bar')" },
        });
        expect((await NotebookEditTool.preview!({ notebook_path: file, edit_mode: "insert", cell_id: "intro", cell_type: "markdown", new_source: "x" }, ctx))?.summary).toBe("Insert a markdown cell after cell intro");
    });
});

describe("NotebookEdit permissions, as for Edit", () => {
    const tool = BUILTIN_TOOLS.find((t) => t.name === "NotebookEdit")!;
    const W = realpathSync(tempDir());
    const O = realpathSync(tempDir());
    const checker = new PermissionChecker(() => ({ permissions: { allow: [], ask: [], deny: [] } }), W);
    const check = (p: string, mode: any = "default") => checker.check(tool, { notebook_path: p, cell_id: "a", new_source: "x" }, mode, W);

    test("inside the workspace: asks by default, runs in acceptEdits, refused in plan mode", () => {
        expect(check(join(W, "n.ipynb"))).toMatchObject({ behavior: "ask", offerAcceptEdits: true });
        expect(check(join(W, "n.ipynb"), "acceptEdits").behavior).toBe("allow");
        expect(check(join(W, "n.ipynb"), "plan").behavior).toBe("deny");
    });
    test("outside the workspace asks, even in acceptEdits", () => {
        expect(check(join(O, "n.ipynb"), "acceptEdits")).toMatchObject({ behavior: "ask", reason: "Outside the workspace" });
    });
    test("the harness's own files: the credential store is refused, config always asks", () => {
        expect(check(paths.credentialsFile(), "bypassPermissions").behavior).toBe("deny");
        expect(check(join(W, ".harness", "n.ipynb"), "acceptEdits").behavior).toBe("ask");
    });
    test("the path checked is notebook_path, even with a file_path alongside it", () => {
        const decoy = { notebook_path: join(O, "n.ipynb"), file_path: join(W, "n.ipynb"), cell_id: "a", new_source: "x" };
        expect(checker.check(tool, decoy, "acceptEdits", W)).toMatchObject({ behavior: "ask", reason: "Outside the workspace" });
        const denying = new PermissionChecker(() => ({ permissions: { deny: [`Edit(/${O}/**)`] } }), W);
        expect(denying.check(tool, decoy, "acceptEdits", W).behavior).toBe("deny");
    });
});
