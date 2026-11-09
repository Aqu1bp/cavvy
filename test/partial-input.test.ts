import { describe, expect, test } from "bun:test";
import { partialInput, PARTIAL_SCAN } from "../src/tools/partial-input";

describe("partialInput", () => {
    test("reads a field once its value has arrived whole", () => {
        expect(partialInput('{"file_path": "src/game/char')).toEqual({});
        expect(partialInput('{"file_path": "src/game/characters.gd", "content": "extends No')).toEqual({ file_path: "src/game/characters.gd" });
    });

    test("unescapes the value", () => {
        expect(partialInput('{"command": "echo \\"hi\\"\\nls", "descr')).toEqual({ command: 'echo "hi"\nls' });
    });

    test("an escape cut in two waits for the rest", () => {
        expect(partialInput('{"command": "a\\')).toEqual({});
    });

    test("doesn't take a key from inside a string value", () => {
        const json = JSON.stringify({ content: 'config = {"path": "/etc/x"}' }).slice(0, -1);
        expect(partialInput(json)).toEqual({});
    });

    test("leaves out long fields, and reads only the start", () => {
        expect(partialInput(JSON.stringify({ content: "x".repeat(10), file_path: "a.ts" }))).toEqual({ file_path: "a.ts" });
        expect(partialInput(`{"content": "${"x".repeat(PARTIAL_SCAN)}", "file_path": "late.ts"}`)).toEqual({});
    });

    test("several fields", () => {
        expect(partialInput('{"pattern": "TODO", "path": "src", "glob')).toEqual({ pattern: "TODO", path: "src" });
    });
});
