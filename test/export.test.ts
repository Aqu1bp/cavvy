import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, realpathSync, rmSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { AssistantMessage, Message, UserMessage } from "../src/providers/types";
import type { App } from "../src/ui/app";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { runCommand } = await import("../src/commands");
afterAll(iso.cleanup);

const prompt = (text: string, kind: NonNullable<UserMessage["meta"]>["kind"] = "prompt"): UserMessage => ({ role: "user", content: [{ type: "text", text }], meta: { kind } });
const continuation = (): UserMessage => prompt("<system-reminder>Continue from the cutoff.</system-reminder>", "continuation");
const reply = (text: string, stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessage => ({
    role: "assistant", provider: "test", model: "test", stopReason,
    content: [{ type: "text", text }],
    raw: { anthropic: [{ type: "text", text }] },
});

async function exported(mode: "GUI" | "/export", messages: Message[]): Promise<string> {
    const cwd = realpathSync(tempDir("export-test-"));
    const engine = new Engine({ listModels: async () => [] });
    try {
        const rt = await engine.createSession(cwd);
        await rt.ready;
        for (const message of messages) rt.session.push(message);
        const original = structuredClone(rt.session.messages);
        const stored = readFileSync(rt.session.path, "utf8");
        let markdown: string;
        if (mode === "GUI") markdown = rt.exportMarkdown();
        else {
            const notices: string[] = [];
            const app = {
                cwd, session: rt.session, customCommands: [],
                notice: (text: string) => notices.push(text), print: () => {}, renderLive: () => {},
            } as unknown as App;
            const file = join(cwd, "export.md");
            expect(await runCommand(app, `/export ${file}`)).toBe(true);
            expect(notices).toHaveLength(1);
            expect(notices[0]).toContain("Exported the conversation");
            markdown = readFileSync(file, "utf8");
        }
        expect(rt.session.messages).toEqual(original);
        expect(readFileSync(rt.session.path, "utf8")).toBe(stored);
        return markdown;
    } finally {
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
}

for (const mode of ["GUI", "/export"] as const) describe(`${mode} continued-answer export`, () => {
    test("joins split code fences and whitespace before rendering one Assistant section", async () => {
        const fragments = ["Here:\n```ts\nconst value = ", " ", "42;\n```\nDone."];
        const middle = reply(fragments[1]!, "max_tokens");
        middle.content.unshift({ type: "thinking", text: "private reasoning", signature: "opaque-signature" });
        const text = await exported(mode, [prompt("code please"), reply(fragments[0]!, "max_tokens"), continuation(), middle, continuation(), reply(fragments[2]!)]);
        expect(text.match(/^## Assistant$/gm)).toHaveLength(1);
        expect(text).toContain(`## Assistant\n\n${fragments.join("")}\n`);
        expect(text).not.toContain("Continue from the cutoff");
        expect(text).not.toContain("private reasoning");
    });

    test("joins reasoning-only cuts and retains the tool calls and results", async () => {
        const head = reply("", "max_tokens");
        head.content = [{ type: "thinking", text: "reasoning only", signature: "opaque-signature" }];
        const tail = reply("I will inspect it.", "tool_use");
        tail.content.push({ type: "tool_call", id: "read-1", name: "Read", input: { path: "file.ts" } });
        const text = await exported(mode, [
            prompt("inspect"), head, continuation(), tail,
            { role: "user", meta: { kind: "tool_results" }, content: [{ type: "tool_result", toolCallId: "read-1", toolName: "Read", content: "file contents" }] },
            reply("All done."),
        ]);
        expect(text.match(/^## Assistant$/gm)).toHaveLength(2);
        expect(text).toContain("## Assistant\n\nI will inspect it.\n\n**Read** `{\"path\":\"file.ts\"}`");
        expect(text).toContain("<details><summary>Result: Read</summary>\n\n```\nfile contents\n```\n</details>\n\n## Assistant\n\nAll done.");
        expect(text).not.toContain("reasoning only");
    });

    test("does not join across user prompts or ordinary reminders", async () => {
        const text = await exported(mode, [
            prompt("first"), reply("First ", "max_tokens"), continuation(), reply("answer."),
            prompt("second"), reply("Second ", "max_tokens"), continuation(), reply("answer."),
            prompt("<system-reminder>ordinary reminder</system-reminder>", "reminder"), reply("Separate answer."),
        ]);
        expect(text.match(/^## Assistant$/gm)).toHaveLength(3);
        expect(text).toContain("## Assistant\n\nFirst answer.\n\n## User\n\nsecond\n\n## Assistant\n\nSecond answer.\n\n## Assistant\n\nSeparate answer.");
    });

    test("keeps an unfinished answer when its continuation was interrupted", async () => {
        const text = await exported(mode, [prompt("code please"), reply("Partial answer", "max_tokens"), continuation()]);
        expect(text.match(/^## Assistant$/gm)).toHaveLength(1);
        expect(text).toContain("## Assistant\n\nPartial answer\n");
        expect(text).not.toContain("Continue from the cutoff");
    });
});
