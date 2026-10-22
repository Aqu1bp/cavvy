// What the real CLIs do with a message steering a running turn that carries an image or a PDF, from captures
// (test/fixtures/protocol, base64 replaced by a description), and the fake Claude Code held to the same.
// Probed 2026-10-22 with Claude Code 2.1.304 (haiku) and Codex 0.163.0: an image reaches the model mid-turn in
// both; Claude Code drops a mid-turn document block (a PDF) without a word.

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers/isolate";

type Frame = { t: number; dir: "in" | "out" | "note"; frame: any };
const capture = (name: string): Frame[] =>
    readFileSync(join(import.meta.dir, "fixtures", "protocol", name), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l) as Frame);

/** The steer: the user message sent after the first, while the turn ran. */
function claudeSteer(frames: Frame[]) {
    const users = frames.filter((f) => f.dir === "out" && f.frame.type === "user");
    expect(users).toHaveLength(2);
    return users[1]!;
}

describe("Claude Code 2.1.304: a mid-turn user message with media", () => {
    test("an image block reaches the model in the running turn, answered once the tool in flight is done", () => {
        const frames = capture("claude-2.1.304-steer-image.jsonl");
        const steer = claudeSteer(frames);
        expect(steer.frame.message.content.map((b: any) => b.type)).toEqual(["image", "text"]);
        // Sent while Bash ran: after its tool_use, before its tool_result.
        const toolUse = frames.find((f) => f.dir === "in" && f.frame.type === "assistant" && f.frame.message.content.some((b: any) => b.type === "tool_use"))!;
        const toolResult = frames.find((f) => f.dir === "in" && f.frame.type === "user" && f.frame.message.content.some((b: any) => b.type === "tool_result"))!;
        expect(steer.t).toBeGreaterThan(toolUse.t);
        expect(steer.t).toBeLessThan(toolResult.t);
        // One turn, one result, which reads the image's word.
        const results = frames.filter((f) => f.dir === "in" && f.frame.type === "result");
        expect(results).toHaveLength(1);
        expect(results[0]!.t).toBeGreaterThan(toolResult.t);
        expect(results[0]!.frame.result).toContain("PELICAN");
    });

    test("a document block (a PDF) is dropped: the text arrives, the model never sees the document", () => {
        const frames = capture("claude-2.1.304-steer-pdf-dropped.jsonl");
        const steer = claudeSteer(frames);
        expect(steer.frame.message.content.map((b: any) => b.type)).toEqual(["document", "text"]);
        expect(steer.frame.message.content[0].source.media_type).toBe("application/pdf");
        const result = frames.find((f) => f.dir === "in" && f.frame.type === "result")!;
        expect(result.frame.result).not.toContain("PELICAN");
        expect(result.frame.result).toMatch(/don't see a document/);
    });
});

describe("Codex 0.163: turn/steer with an image", () => {
    test("it takes an image item as turn/start does, into the running turn at once, and the model reads it", () => {
        const frames = capture("codex-0.163-steer-image.jsonl");
        const steer = frames.find((f) => f.dir === "out" && f.frame.method === "turn/steer")!;
        expect(steer.frame.params.input.map((i: any) => i.type)).toEqual(["image", "text"]);
        expect(steer.frame.params.input[0].url).toStartWith("data:image/png;base64,");
        const started = frames.find((f) => f.dir === "out" && f.frame.method === "turn/start")!;
        expect(steer.frame.params.expectedTurnId).toBeDefined();
        // Accepted for the running turn.
        const reply = frames.find((f) => f.dir === "in" && f.frame.id === steer.frame.id)!;
        expect(reply.frame.result).toEqual({ turnId: steer.frame.params.expectedTurnId });
        expect(started.t).toBeLessThan(steer.t);
        // Taken at once, as a user message in that turn with its image, while the command still ran.
        const taken = frames.find((f) => f.dir === "in" && f.frame.method === "item/started" && f.frame.params.item.type === "userMessage" && f.t > steer.t)!;
        expect(taken.frame.params.turnId).toBe(steer.frame.params.expectedTurnId);
        expect(taken.frame.params.item.content.map((c: any) => c.type)).toEqual(["image", "text"]);
        const answer = frames.find((f) => f.dir === "in" && f.frame.method === "item/completed" && f.frame.params.item.type === "agentMessage")!;
        expect(answer.frame.params.item.text).toBe("PELICAN");
    });
});

describe("the fake Claude Code does what the real one did", () => {
    /** The fake in its steering scenario, sent the captured first prompt and then the captured steer. */
    async function replay(name: string) {
        const frames = capture(name);
        const [first, steer] = frames.filter((f) => f.dir === "out" && f.frame.type === "user");
        const logFile = join(tempDir("steer-capture-"), "log.jsonl");
        const env: Record<string, string> = { ...(process.env as Record<string, string>), FAKE_SCENARIO: "steering", FAKE_LOG: logFile };
        const p = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures", "fake-claude.ts"), "-p", "--input-format", "stream-json", "--output-format", "stream-json"], { env, stdin: "pipe", stdout: "pipe", stderr: "ignore" });
        try {
            p.stdin.write(JSON.stringify(first!.frame) + "\n");
            await p.stdin.flush();
            await Bun.sleep(150);
            p.stdin.write(JSON.stringify(steer!.frame) + "\n");
            await p.stdin.flush();
            const lines = () => (existsSync(logFile) ? readFileSync(logFile, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) : []);
            for (let k = 0; k < 200 && !lines().some((l) => l.foldedBeforeResult); k++) await Bun.sleep(20);
            return lines();
        } finally {
            p.kill();
        }
    }

    test("a mid-turn image is folded into the turn", async () => {
        const log = await replay("claude-2.1.304-steer-image.jsonl");
        expect(log.find((l) => l.foldedBeforeResult)).toMatchObject({ foldedBeforeResult: ["What word is in this image?"], foldedImages: 1 });
        expect(log.some((l) => l.droppedMidTurnDocuments)).toBe(false);
    });

    test("a mid-turn document is dropped, its text folded", async () => {
        const log = await replay("claude-2.1.304-steer-pdf-dropped.jsonl");
        expect(log.find((l) => l.foldedBeforeResult)).toMatchObject({ foldedBeforeResult: ["What word is in this document?"], foldedImages: 0 });
        expect(log.find((l) => l.droppedMidTurnDocuments)).toEqual({ droppedMidTurnDocuments: 1 });
    });
});
