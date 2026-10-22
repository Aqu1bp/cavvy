import { afterAll, describe, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import type { Tool } from "../src/tools/types";

const iso = isolate();
const { validateInput, coerceInput } = await import("../src/tools/index");
afterAll(() => iso.cleanup());

function tool(prop: unknown): Tool<any> {
    return { parameters: { type: "object", properties: { cursor: prop }, required: ["cursor"] } } as Tool<any>;
}

describe("required nullable tool arguments", () => {
    const nullable = [
        { type: ["string", "null"] },
        { type: "string", nullable: true },
        { anyOf: [{ type: "string" }, { type: "null" }] },
        { type: "null" },
        { enum: ["next", null] },
        { const: null },
        { oneOf: [{ type: "string" }, { type: "null" }] },
        { allOf: [{ type: ["string", "null"] }, { enum: [null] }] },
        { not: { type: "string" } },
        true,
        {},
    ];
    for (const prop of nullable) {
        test(`accepts null but requires a value: ${JSON.stringify(prop)}`, () => {
            const t = tool(prop);
            const input = coerceInput(t, { cursor: null });
            expect(input).toEqual({ cursor: null });
            expect(validateInput(t, input)).toBeUndefined();
            expect(validateInput(t, {})).toBe('Missing required parameter "cursor"');
            expect(validateInput(t, { cursor: undefined })).toBe('Missing required parameter "cursor"');
        });
    }

    test("inherited values do not satisfy required properties", () => {
        expect(validateInput(tool({}), Object.create({ cursor: "next" }))).toBe('Missing required parameter "cursor"');
    });

    for (const prop of [
        { type: "string" },
        { type: "object" },
        { anyOf: [{ type: "string" }, { type: "number" }] },
        { type: ["string", "null"], enum: ["next"] },
        { type: "string", nullable: true, enum: ["next"] },
        { const: "next" },
        { oneOf: [{ type: "null" }, {}] },
        { allOf: [{ type: ["string", "null"] }, { type: "string" }] },
        { not: { type: "null" } },
        false,
    ]) {
        test(`rejects prohibited null: ${JSON.stringify(prop)}`, () => {
            expect(validateInput(tool(prop), { cursor: null })).toBe('Parameter "cursor" does not allow null');
        });
    }

    test("nullable types still reject other primitive types", () => {
        expect(validateInput(tool({ type: ["string", "null"] }), { cursor: 12 })).toContain("should be string or null");
        expect(validateInput(tool({ type: "null" }), { cursor: "next" })).toContain("should be null");
        expect(validateInput(tool({ type: ["string", "null"] }), { cursor: "next" })).toBeUndefined();
    });

    test("an optional parameter's forbidden null counts as omitted and is dropped", () => {
        const t = tool({ type: "string" });
        t.parameters.required = [];
        expect(validateInput(t, {})).toBeUndefined();
        expect(validateInput(t, { cursor: null })).toBeUndefined();
        expect(coerceInput(t, { cursor: null })).toEqual({});
    });

    test("an optional parameter's allowed null is kept", () => {
        const t = tool({ type: ["string", "null"] });
        t.parameters.required = [];
        expect(coerceInput(t, { cursor: null })).toEqual({ cursor: null });
        expect(validateInput(t, { cursor: null })).toBeUndefined();
    });

    test("null for an unknown key is left alone", () => {
        const t = tool({ type: "string" });
        expect(coerceInput(t, { cursor: "next", other: null })).toEqual({ cursor: "next", other: null });
        expect(validateInput(t, { cursor: "next", other: null })).toBeUndefined();
    });
});

describe("built-in tools with null for unused optional parameters", () => {
    test("Read accepts null offset and limit, and the tool never sees them", async () => {
        const { ReadTool } = await import("../src/tools/file-tools");
        const input = coerceInput(ReadTool, { file_path: "/tmp/x", offset: null, limit: null });
        expect(input).toEqual({ file_path: "/tmp/x" });
        expect(validateInput(ReadTool, input)).toBeUndefined();
        expect(validateInput(ReadTool, { file_path: "/tmp/x", offset: null, limit: null })).toBeUndefined();
    });

    test("Grep accepts null glob, type and head_limit", async () => {
        const { GrepTool } = await import("../src/tools/search-tools");
        const input = coerceInput(GrepTool, { pattern: "x", glob: null, type: null, head_limit: null });
        expect(input).toEqual({ pattern: "x" });
        expect(validateInput(GrepTool, input)).toBeUndefined();
    });

    test("a required built-in parameter still rejects null", async () => {
        const { ReadTool } = await import("../src/tools/file-tools");
        expect(coerceInput(ReadTool, { file_path: null })).toEqual({ file_path: null });
        expect(validateInput(ReadTool, { file_path: null })).toBe('Parameter "file_path" does not allow null');
    });
});

describe("malformed property schemas from MCP servers", () => {
    const schemas: unknown[] = [null, "string", 3, [], { anyOf: [null] }, { anyOf: "x" }, { oneOf: [null, { type: "string" }] }, { allOf: [null] }, { not: null }, { enum: 3 }];
    for (const prop of schemas) {
        for (const required of [true, false]) {
            test(`does not throw for ${JSON.stringify(prop)} (${required ? "required" : "optional"})`, () => {
                const t = tool(prop);
                if (!required) t.parameters.required = [];
                for (const value of ["a", null, 1, {}]) {
                    expect(() => validateInput(t, coerceInput(t, { cursor: value }))).not.toThrow();
                }
            });
        }
    }

    test("a property schema that is not an object or boolean constrains nothing", () => {
        const t = { parameters: { type: "object", properties: { x: null }, required: [] } } as unknown as Tool<any>;
        expect(validateInput(t, { x: "a" })).toBeUndefined();
        expect(validateInput(t, { x: null })).toBeUndefined();
        expect(coerceInput(t, { x: null })).toEqual({ x: null });
    });

    test("a malformed not constrains nothing", () => {
        const t = tool({ type: ["string", "null"], not: null });
        expect(validateInput(t, { cursor: null })).toBeUndefined();
    });
});

describe("$ref in property schemas", () => {
    const S = { type: "string" };
    function refTool(prop: unknown, required: string[] = [], defs: Record<string, unknown> = { S }): Tool<any> {
        return { parameters: { type: "object", definitions: defs, $defs: { "a/b~c": S, N: { type: ["string", "null"] } }, properties: { x: prop }, required } } as Tool<any>;
    }

    test("a valid optional null behind a oneOf or not with a $ref is kept", () => {
        for (const prop of [{ oneOf: [{ $ref: "#/definitions/S" }, { type: "null" }] }, { not: { $ref: "#/definitions/S" } }, { anyOf: [{ $ref: "#/$defs/N" }] }]) {
            const t = refTool(prop);
            expect(coerceInput(t, { x: null })).toEqual({ x: null });
            expect(validateInput(t, { x: null })).toBeUndefined();
        }
    });

    test("a required non-nullable $ref rejects null; an optional one drops it", () => {
        for (const $ref of ["#/definitions/S", "#/$defs/a~1b~0c", "#/%24defs/a~1b~0c"]) {
            expect(validateInput(refTool({ $ref }, ["x"]), { x: null })).toBe('Parameter "x" does not allow null');
            expect(coerceInput(refTool({ $ref }), { x: null })).toEqual({});
        }
        expect(validateInput(refTool({ $ref: "#/$defs/N" }, ["x"]), { x: null })).toBeUndefined();
    });

    test("a cyclic $ref is unknown: null is neither rejected nor dropped", () => {
        const defs = { A: { $ref: "#/definitions/B" }, B: { anyOf: [{ $ref: "#/definitions/A" }, { type: "string" }] } };
        for (const required of [["x"], []]) {
            for (const prop of [{ $ref: "#/definitions/A" }, { oneOf: [{ $ref: "#/definitions/A" }, { type: "null" }] }]) {
                const t = refTool(prop, required, defs);
                expect(validateInput(t, { x: null })).toBeUndefined();
                expect(coerceInput(t, { x: null })).toEqual({ x: null });
            }
        }
    });

    test("an unresolvable or remote $ref is unknown: null is neither rejected nor dropped", () => {
        for (const $ref of ["#/definitions/Missing", "https://example.com/s.json", "#anchor", "#/%E0"]) {
            for (const required of [["x"], []]) {
                const t = refTool({ oneOf: [{ $ref }, { type: "null" }] }, required);
                expect(validateInput(t, { x: null })).toBeUndefined();
                expect(coerceInput(t, { x: null })).toEqual({ x: null });
                const bare = refTool({ $ref }, required);
                expect(validateInput(bare, { x: null })).toBeUndefined();
                expect(coerceInput(bare, { x: null })).toEqual({ x: null });
            }
        }
    });

    test("a known no still wins over an unknown $ref", () => {
        const t = refTool({ type: "string", $ref: "#/definitions/Missing" });
        expect(coerceInput(t, { x: null })).toEqual({});
        expect(validateInput(refTool({ allOf: [{ $ref: "#/definitions/Missing" }, { type: "string" }] }, ["x"]), { x: null })).toBe('Parameter "x" does not allow null');
    });
});
