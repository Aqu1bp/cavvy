// Edit, MultiEdit and Write never change bytes they weren't asked to: a file
// that isn't UTF-8 is refused before anything is written (#258), and the line
// breaks an edit adds follow the file's CRLF convention and byte-order mark (#262).

import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "fs";
import { join } from "path";
import * as fsPromises from "fs/promises";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { ReadTool, WriteTool, EditTool, MultiEditTool, applyEdit } = await import("../src/tools/file-tools");
afterAll(() => iso.cleanup());

const toolCtx = (cwd: string) => ({ state: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() }, settings: {}, signal: new AbortController().signal }) as any;

/** A file with these bytes, already Read, and a context to change it with. */
async function readFixture(name: string, bytes: Uint8Array | string) {
    const root = tempDir();
    const file_path = join(root, name);
    writeFileSync(file_path, bytes);
    const ctx = toolCtx(root);
    const read = await ReadTool.run({ file_path }, ctx);
    return { file_path, ctx, read };
}

const hex = (path: string) => readFileSync(path).toString("hex");

describe("a file that isn't UTF-8 is refused, not corrupted", () => {
    // "café\nold\n" in Latin-1: é is the single byte e9, which isn't valid UTF-8.
    const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a, 0x6f, 0x6c, 0x64, 0x0a]);

    test("Read says why its bytes show as U+FFFD and that Edit and Write will refuse it", async () => {
        const { read } = await readFixture("latin1.txt", LATIN1);
        expect(read.isError).toBeFalsy();
        expect(read.content).toContain("     2\told");
        expect(read.content).toContain("is not valid UTF-8");
        expect(read.content).toContain("Edit and Write will refuse it");
    });

    test("Edit refuses it in validate and in run, and the file keeps every byte", async () => {
        const { file_path, ctx } = await readFixture("latin1.txt", LATIN1);
        const input = { file_path, old_string: "old", new_string: "new" };
        expect(await EditTool.validate!(input, ctx)).toContain("is not valid UTF-8");
        expect(await EditTool.preview!(input, ctx)).toBeUndefined();
        const r = await EditTool.run(input, ctx);
        expect(r.isError).toBe(true);
        expect(r.content).toContain("is not valid UTF-8");
        expect(r.content).toContain("nothing was written");
        expect(hex(file_path)).toBe(LATIN1.toString("hex"));
    });

    test("MultiEdit refuses it", async () => {
        const { file_path, ctx } = await readFixture("latin1.txt", LATIN1);
        const input = { file_path, edits: [{ old_string: "old", new_string: "new" }] };
        expect(await MultiEditTool.validate!(input, ctx)).toContain("is not valid UTF-8");
        const r = await MultiEditTool.run(input, ctx);
        expect(r.isError).toBe(true);
        expect(hex(file_path)).toBe(LATIN1.toString("hex"));
    });

    test("Write refuses to overwrite it", async () => {
        const { file_path, ctx } = await readFixture("latin1.txt", LATIN1);
        // What the model would write back after Read showed é as U+FFFD.
        const input = { file_path, content: "caf�\nnew\n" };
        expect(await WriteTool.validate!(input, ctx)).toContain("is not valid UTF-8");
        const r = await WriteTool.run(input, ctx);
        expect(r.isError).toBe(true);
        expect(r.content).toContain("delete it first, then Write it");
        expect(hex(file_path)).toBe(LATIN1.toString("hex"));
    });

    test("a UTF-16 file and one with NUL bytes are refused too", async () => {
        const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("old\n", "utf16le")]);
        const nul = Buffer.from("old\0\n");
        for (const [name, bytes, why] of [["utf16.txt", utf16, "UTF-16"], ["nul.txt", nul, "NUL bytes"]] as const) {
            const { file_path, ctx, read } = await readFixture(name, bytes);
            // Read calls both binary, so the model has seen them some other way: mark them read.
            expect(read.content).toContain("binary");
            const st = statSync(file_path);
            ctx.state.fileState.set(file_path, { mtimeMs: st.mtimeMs, size: st.size, partial: false });
            const r = await EditTool.run({ file_path, old_string: "o", new_string: "n" }, ctx);
            expect(r.isError).toBe(true);
            expect(r.content).toContain(why);
            expect(hex(file_path)).toBe(bytes.toString("hex"));
        }
    });

    test("Write refuses an existing file it can't read, since it can't check the encoding", async () => {
        const { file_path, ctx } = await readFixture("latin1.txt", LATIN1);
        // Made write-only after Read: its mtime and size stay the same.
        const spy = spyOn(fsPromises, "readFile").mockImplementation((async () => {
            throw Object.assign(new Error("EACCES: permission denied"), { code: "EACCES" });
        }) as any);
        try {
            const input = { file_path, content: "caf\uFFFD\nnew\n" };
            expect(await WriteTool.validate!(input, ctx)).toContain("EACCES");
            const r = await WriteTool.run(input, ctx);
            expect(r.isError).toBe(true);
            expect(r.content).toContain("nothing was written");
        } finally {
            spy.mockRestore();
        }
        expect(hex(file_path)).toBe(LATIN1.toString("hex"));
    });

    test("an edit to a UTF-8 file leaves its other non-ASCII bytes alone", async () => {
        const before = "café — naïve 日本\nold\n";
        const { file_path, ctx } = await readFixture("utf8.txt", before);
        const r = await EditTool.run({ file_path, old_string: "old", new_string: "new" }, ctx);
        expect(r.isError).toBeFalsy();
        expect(readFileSync(file_path, "utf-8")).toBe("café — naïve 日本\nnew\n");
    });
});

describe("line endings and the byte-order mark", () => {
    test("a single-line old_string with a multi-line new_string adds CRLF lines to a CRLF file", async () => {
        expect(applyEdit("one\r\ntwo\r\n", { old_string: "one", new_string: "one\ninserted" }, "x")).toEqual({ text: "one\r\ninserted\r\ntwo\r\n" });
        const { file_path, ctx } = await readFixture("crlf.txt", "one\r\ntwo\r\n");
        const r = await EditTool.run({ file_path, old_string: "one", new_string: "one\ninserted" }, ctx);
        expect(r.isError).toBeFalsy();
        expect(readFileSync(file_path, "utf-8")).toBe("one\r\ninserted\r\ntwo\r\n");
        // The snippet still points at the edit.
        expect(r.content).toContain("inserted");
    });

    test("a multi-line old_string written with LF still matches, and replace_all follows the file too", () => {
        expect(applyEdit("a\r\nb\r\nc\r\n", { old_string: "a\nb", new_string: "a\nx\nb" }, "x")).toEqual({ text: "a\r\nx\r\nb\r\nc\r\n" });
        expect(applyEdit("k\r\nk\r\n", { old_string: "k", new_string: "k\nk2", replace_all: true }, "x")).toEqual({ text: "k\r\nk2\r\nk\r\nk2\r\n" });
        // new_string that already has CRLF isn't doubled.
        expect(applyEdit("one\r\ntwo\r\n", { old_string: "one", new_string: "one\r\nzero" }, "x")).toEqual({ text: "one\r\nzero\r\ntwo\r\n" });
    });

    test("a match that starts or ends inside a CRLF takes the whole line break", () => {
        expect(applyEdit("a\r\nb\r\n", { old_string: "\nb", new_string: "\nx\nb" }, "x")).toEqual({ text: "a\r\nx\r\nb\r\n" });
        // Joining lines leaves no lone CR.
        expect(applyEdit("a\r\nb\r\n", { old_string: "\nb", new_string: "b" }, "x")).toEqual({ text: "ab\r\n" });
        expect(applyEdit("a\r\nb\r\n", { old_string: "a\r", new_string: "x\r" }, "x")).toEqual({ text: "x\r\nb\r\n" });
        expect(applyEdit("a\r\nb\r\n", { old_string: "a\r", new_string: "x" }, "x")).toEqual({ text: "xb\r\n" });
        // Adjacent matches sharing a CRLF are both replaced, and the line break between them is written once.
        expect(applyEdit("a\r\nfoo\r\nfoo\r\nz\r\n", { old_string: "\nfoo\r", new_string: "\nbar\r", replace_all: true }, "x")).toEqual({ text: "a\r\nbar\r\nbar\r\nz\r\n" });
        expect(applyEdit("a\r\nfoo\r\nfoo\r\nz\r\n", { old_string: "\nfoo\r", new_string: "\nbar\r" }, "x")).toEqual({ error: expect.stringContaining("appears 2 times") });
        // Every replace_all occurrence, also in a mostly-LF file.
        expect(applyEdit("a\r\nb\r\nc", { old_string: "\n", new_string: "\n\n", replace_all: true }, "x")).toEqual({ text: "a\r\n\r\nb\r\n\r\nc" });
        expect(applyEdit("a\r\nb\nc\nd\n", { old_string: "\n", new_string: " ", replace_all: true }, "x")).toEqual({ text: "a b c d " });
    });

    test("the dominant ending wins, and lines outside the edit keep theirs", () => {
        // Mostly LF: new lines are LF, and the one CRLF line is left as it was.
        expect(applyEdit("a\nb\r\nc\nd\n", { old_string: "c", new_string: "c\nc2" }, "x")).toEqual({ text: "a\nb\r\nc\nc2\nd\n" });
        // Mostly CRLF: new lines are CRLF, and the one LF line is left as it was.
        expect(applyEdit("a\r\nb\nc\r\nd\r\n", { old_string: "c", new_string: "c\nc2" }, "x")).toEqual({ text: "a\r\nb\nc\r\nc2\r\nd\r\n" });
    });

    test("MultiEdit keeps a CRLF file CRLF", async () => {
        const { file_path, ctx } = await readFixture("multi.txt", "one\r\ntwo\r\n");
        const r = await MultiEditTool.run({ file_path, edits: [{ old_string: "one", new_string: "one\n1.5" }, { old_string: "two", new_string: "two\nthree" }] }, ctx);
        expect(r.isError).toBeFalsy();
        expect(readFileSync(file_path, "utf-8")).toBe("one\r\n1.5\r\ntwo\r\nthree\r\n");
    });

    test("Edit keeps a BOM and whether the file ends with a newline", async () => {
        const a = await readFixture("bom.txt", "﻿first\r\nlast");
        await EditTool.run({ file_path: a.file_path, old_string: "last", new_string: "last\nreally last" }, a.ctx);
        expect(hex(a.file_path).startsWith("efbbbf")).toBe(true);
        expect(readFileSync(a.file_path, "utf-8")).toBe("﻿first\r\nlast\r\nreally last");
        const b = await readFixture("first-line.txt", "﻿first\nsecond\n");
        await EditTool.run({ file_path: b.file_path, old_string: "first", new_string: "1st" }, b.ctx);
        expect(readFileSync(b.file_path, "utf-8")).toBe("﻿1st\nsecond\n");
    });

    test("Write over a CRLF file with a BOM keeps both", async () => {
        const { file_path, ctx } = await readFixture("rewrite.txt", "﻿old\r\nlines\r\n");
        const r = await WriteTool.run({ file_path, content: "new\nlines\n" }, ctx);
        expect(r.isError).toBeFalsy();
        expect(readFileSync(file_path, "utf-8")).toBe("﻿new\r\nlines\r\n");
    });

    test("Write's preview shows what it writes", async () => {
        const { file_path, ctx } = await readFixture("preview.txt", "\uFEFFold\r\nlines\r\n");
        const input = { file_path, content: "new\nlines\n" };
        const preview = await WriteTool.preview!(input, ctx);
        await WriteTool.run(input, ctx);
        expect(preview?.diff?.after).toBe(readFileSync(file_path, "utf-8"));
        expect(preview?.diff?.before).toBe("\uFEFFold\r\nlines\r\n");
    });

    test("Write leaves an LF file's and a new file's content as given", async () => {
        const { file_path, ctx } = await readFixture("lf.txt", "old\n");
        await WriteTool.run({ file_path, content: "new\nlines" }, ctx);
        expect(readFileSync(file_path, "utf-8")).toBe("new\nlines");
        const created = join(tempDir(), "created.txt");
        await WriteTool.run({ file_path: created, content: "a\r\nb\n" }, toolCtx(tempDir()));
        expect(readFileSync(created, "utf-8")).toBe("a\r\nb\n");
    });
});
