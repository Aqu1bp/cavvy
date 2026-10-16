import { afterAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import type { ToolContext } from "../src/tools/types";

const iso = isolate();
const { ReadTool, EditTool } = await import("../src/tools/file-tools");
const { GrepTool } = await import("../src/tools/search-tools");
const { SecretStore } = await import("../src/agent/secrets");
const VALUE = "zq7Xv9Lr2Wm4Kp8T";
const secrets = new SecretStore();
secrets.set("FILE_TEST_TOKEN", VALUE);
const root = join(iso.home, "project");
mkdirSync(root);
const ctx = {
    state: { cwd: root, projectRoot: root, fileState: new Map(), todos: [], shells: new Map(), secrets },
    settings: {}, signal: new AbortController().signal, ui: {}, mode: () => "default", setMode() {},
} as ToolContext;
afterAll(() => iso.cleanup());

function noFragment(text: string) {
    for (let i = 0; i <= VALUE.length - 6; i++) expect(text.includes(VALUE.slice(i, i + 6))).toBe(false);
}

for (const tool of ["Read", "Edit"] as const) {
    test(`${tool} redacts a secret spanning the 2000-character line cap`, async () => {
        const file_path = join(root, `${tool}.txt`);
        writeFileSync(file_path, "x".repeat(1992) + VALUE + "\nold\n");
        const read = await ReadTool.run({ file_path }, ctx);
        const result = tool === "Read" ? read : await EditTool.run({ file_path, old_string: "old", new_string: "new" }, ctx);
        noFragment(result.content);
        expect(result.content).toContain("[REDACT");
    });
}

test("notebook output redacts a secret spanning its 4000-character cap", async () => {
    const file_path = join(root, "output.ipynb");
    writeFileSync(file_path, JSON.stringify({ cells: [{ cell_type: "code", source: ["print('test')"], outputs: [{ text: ["x".repeat(3992), VALUE] }] }] }));
    const result = await ReadTool.run({ file_path }, ctx);
    noFragment(result.content);
    expect(result.content).toContain("[REDACT");
});

const realPath = process.env.PATH;
for (const fallback of [false, true]) {
    test(`Grep ${fallback ? "fallback" : "ripgrep"} redacts before its line preview cap`, async () => {
        if (!fallback) expect(Bun.which("rg")).not.toBeNull();
        const file_path = join(root, `grep-${fallback}.txt`);
        writeFileSync(file_path, "x".repeat(492) + VALUE + "\n");
        try {
            if (fallback) process.env.PATH = "/nonexistent";
            // Match against the original content, even when the pattern is itself redacted from output.
            const result = await GrepTool.run({ path: file_path, pattern: VALUE, output_mode: "content" }, ctx);
            noFragment(result.content);
            expect(result.content).toContain("[REDACT");
        } finally {
            process.env.PATH = realPath;
        }
    });
}

test("Grep redacts before its overall middle truncation", async () => {
    const file_path = join(root, "aggregate.txt");
    const line = "x".repeat(400);
    const prefix = "aggregate.txt:";
    const width = prefix.length + line.length + 1;
    const position = 12_000 - 8;
    const row = Math.floor(position / width);
    const column = position % width - prefix.length;
    expect(column).toBeGreaterThan(0);
    const lines = Array.from({ length: 100 }, () => line);
    lines[row] = line.slice(0, column) + VALUE + line.slice(column + VALUE.length);
    writeFileSync(file_path, lines.join("\n"));
    const result = await GrepTool.run({ path: file_path, pattern: ".", output_mode: "content", show_line_numbers: false }, ctx);
    noFragment(result.content);
    expect(result.content).toContain("omitted");
});
