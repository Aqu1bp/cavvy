import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import type { AssistantMessage, Message } from "../src/providers/types";

const iso = isolate();
const { toOpenAIMessages } = await import("../src/providers/openai-compat");
const { BUILTIN_PROVIDERS } = await import("../src/providers/registry");
afterAll(() => iso.cleanup());

const def = BUILTIN_PROVIDERS.find((p) => p.id === "gemini")!;

for (const args of ['{"path": "a.txt"', "", "  ", "null", "[]", "1", "true", '"text"']) {
    test(`normalizes invalid replay arguments ${JSON.stringify(args)} without changing the transcript`, () => {
        const validArgs = '{ "z": 1, "a": 2 }';
        const raw = {
            role: "assistant",
            content: null,
            tool_calls: [
                { id: "bad", type: "function", function: { name: "read_file", arguments: args }, extra_content: { google: { thought_signature: "signature" } } },
                { id: "good", type: "function", function: { name: "read_file", arguments: validArgs } },
            ],
        };
        const msg: AssistantMessage = {
            role: "assistant", provider: def.id, model: "m",
            content: [{ type: "tool_call", id: "bad", name: "read_file", input: { __invalid_json: args } }],
            raw: { openai: raw },
        };
        const history: Message[] = [msg, {
            role: "user",
            content: [{ type: "tool_result", toolCallId: "bad", toolName: "read_file", isError: true, content: "The tool arguments were not valid JSON" }],
        }];
        const before = JSON.stringify(history);
        const converted = toOpenAIMessages("", history, def);
        expect(converted[0]).toEqual({ ...raw, tool_calls: [
            { ...raw.tool_calls[0], function: { name: "read_file", arguments: "{}" } },
            raw.tool_calls[1],
        ] });
        expect(converted[1]).toEqual({ role: "tool", tool_call_id: "bad", content: "Error: The tool arguments were not valid JSON" });
        expect(JSON.stringify(toOpenAIMessages("", history, def))).toBe(JSON.stringify(converted));
        expect(JSON.stringify(history)).toBe(before);
    });
}
