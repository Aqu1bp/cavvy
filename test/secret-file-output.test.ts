import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import type { ToolContext } from "../src/tools/types";

const iso = isolate();
const { ReadTool, EditTool } = await import("../src/tools/file-tools");
const { GrepTool, filterRgOutput } = await import("../src/tools/search-tools");
const { SecretStore, MAX_SECRET_BYTES } = await import("../src/agent/secrets");
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

function noFragment(text: string, value = VALUE) {
    for (let i = 0; i <= value.length - 6; i++) expect(text.includes(value.slice(i, i + 6))).toBe(false);
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

for (const fallback of [false, true]) {
    for (const separator of [":", "-"]) {
        test(`Grep ${fallback ? "fallback" : "ripgrep"} redacts numeric${separator} content without line numbers`, async () => {
            const value = `12345678${separator}` + "qV7mK9sP".repeat(100);
            secrets.set("NUMERIC_FILE_TOKEN", value);
            const file_path = join(root, `numeric-${separator === ":" ? "colon" : "hyphen"}-${fallback}.txt`);
            writeFileSync(file_path, value + "\n");
            try {
                if (fallback) process.env.PATH = "/nonexistent";
                const result = await GrepTool.run({ path: file_path, pattern: "qV7m", output_mode: "content", show_line_numbers: false }, ctx);
                noFragment(result.content, value);
                expect(result.content).toContain("[REDACTED NUMERIC_FILE_TOKEN]");
            } finally {
                process.env.PATH = realPath;
            }
        });
    }
}

test("Grep bounds ripgrep previews before receiving a huge matching line", async () => {
    const file_path = join(root, "huge-grep.txt");
    const value = "hN5qA8sD3vF7kP2R/".repeat(Math.floor(MAX_SECRET_BYTES / 17));
    secrets.set("LONG_FILE_TOKEN", value);
    const encoded = encodeURIComponent(value);
    writeFileSync(file_path, "x".repeat(492) + encoded + "x".repeat(8 * 1024 * 1024) + "\n");
    const spawn = spyOn(Bun, "spawn");
    try {
        const result = await GrepTool.run({ path: file_path, pattern: "x", output_mode: "content" }, ctx);
        const args = spawn.mock.calls.find(([args]) => Array.isArray(args) && args.includes("--with-filename"))?.[0] as string[] | undefined;
        expect(args).toBeDefined();
        expect(args).toContain("--max-columns-preview");
        const limitIndex = args!.indexOf("--max-columns");
        expect(limitIndex).toBeGreaterThan(-1);
        const columns = Number(args![limitIndex + 1]);
        expect(columns).toBeGreaterThanOrEqual(500 + encoded.length);
        expect(columns).toBeLessThanOrEqual(3 * (500 + MAX_SECRET_BYTES));
        expect(result.content.length).toBeLessThan(600);
        noFragment(result.content, encoded);
        expect(result.content).toContain("[REDACT");
    } finally {
        spawn.mockRestore();
    }
});

test("Grep does not pull an incomplete preview tail into view when earlier secrets shrink", () => {
    const value = "jT4mQ9bK2sF7vN8c";
    const block = "rU6pD3hW8nS2eJ5f".repeat(MAX_SECRET_BYTES / 16);
    const previewLimit = 3 * (500 + MAX_SECRET_BYTES);
    const padding = "vC2kY9wH4gM7aP6d".repeat(100).slice(0, previewLimit - 3 * block.length - 8);
    secrets.set("COMPRESSED_FILE_BLOCK", block);
    secrets.set("COMPRESSED_FILE_PADDING", padding);
    secrets.set("COMPRESSED_FILE_TOKEN", value);
    // Model rg's byte-limited preview: all preceding content collapses into
    // short markers, but the final secret is incomplete and cannot match.
    const preview = block.repeat(3) + padding + value.slice(0, 8) + " [... omitted end of line]";
    const result = filterRgOutput(`${root}/compressed.txt\0${preview}\n`, "content", () => false);
    noFragment(result, value);
    expect(result).toContain("[REDACTED COMPRESSED_FILE_BLOCK]");
    expect(result.length).toBeLessThan(600);
});

test("Grep redacts filenames before its overall middle truncation", async () => {
    const file_path = join(root, `${VALUE}.txt`);
    const line = "x".repeat(400);
    const prefix = `${VALUE}.txt:`;
    const width = prefix.length + line.length + 1;
    const position = 12_000 - 8;
    const row = Math.floor(position / width);
    const padding = position - row * width;
    const lines = Array.from({ length: 100 }, () => line);
    // Move this row's pathname to eight characters before truncateMiddle's head
    // boundary. Per-line redaction only sees contents, so it cannot protect it.
    for (let left = padding, i = 0; left > 0; i++) {
        const add = Math.min(left, 100);
        lines[i] += "x".repeat(add);
        left -= add;
    }
    expect(lines.slice(0, row).reduce((n, l) => n + prefix.length + l.length + 1, 0)).toBe(position);
    writeFileSync(file_path, lines.join("\n"));
    const result = await GrepTool.run({ path: file_path, pattern: ".", output_mode: "content", show_line_numbers: false }, ctx);
    noFragment(result.content);
    expect(result.content).toContain("omitted");
});
