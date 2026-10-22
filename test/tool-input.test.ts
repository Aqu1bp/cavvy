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

    test("optional parameters may be omitted but must permit an explicit null", () => {
        const t = tool({ type: "string" });
        t.parameters.required = [];
        expect(validateInput(t, {})).toBeUndefined();
        expect(validateInput(t, { cursor: null })).toBe('Parameter "cursor" does not allow null');
    });
});
