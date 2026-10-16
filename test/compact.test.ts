import { afterAll, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import type { Message } from "../src/providers/types";

const iso = isolate();
const { compactTranscriptText, handoffTranscript } = await import("../src/agent/compact");
const { Agent } = await import("../src/agent/agent");
afterAll(() => iso.cleanup());

const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
const assistant = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "end_turn" });

function handoff(messages: Message[]): string {
    return (Agent.prototype as any).backendPrompt.call({ session: { messages } }, "continue", messages.length);
}

test("handoff keeps all eleven findings, without per-message clipping", () => {
    const findings = Array.from({ length: 11 }, (_, i) => `Finding ${i + 1}: ${"x".repeat(700)}`).join("\n");
    const messages = [user("Review this"), assistant("Ready"), user(findings)];
    expect(handoffTranscript(messages, 60_000).text).toContain(findings);
    expect(handoff(messages)).toContain(findings);
});

test("handoff budgets user instructions before assistant text and tool output", () => {
    const instruction = "Keep these requirements: " + "x".repeat(9000);
    const messages = [user(instruction), assistant("old " + "a".repeat(40_000)), { role: "user", content: [{ type: "tool_result", toolCallId: "r", toolName: "Read", content: "log " + "z".repeat(40_000) }] } as Message, assistant("newest answer")];
    const text = handoffTranscript(messages, 12_000).text;
    expect(text).toContain(instruction);
    expect(text).toContain("newest answer");
    expect(text.length).toBeLessThanOrEqual(12_000);
});

test("an oversized paste keeps its head and tail and discloses shortening", () => {
    const messages = [user("HEAD " + "x".repeat(90_000) + " TAIL")];
    const text = handoffTranscript(messages, 60_000).text;
    expect(text).toContain("HEAD");
    expect(text).toContain("TAIL");
    expect(text).toMatch(/characters \/ ~\d+ lines omitted/);
    expect(text.length).toBeLessThanOrEqual(60_000);
    expect(handoff(messages)).toMatch(/shortened[\s\S]*\d+ characters/);
});

test("small budgets never overflow, including truncation markers and separators", () => {
    for (const budget of [0, 1, 40, 100, 200, 1000]) {
        expect(handoffTranscript([user("x".repeat(2000)), assistant("y".repeat(2000))], budget).text.length).toBeLessThanOrEqual(budget);
    }
});

test("queued user instructions survive a large tool result in the same message", () => {
    const instruction = "REQUIREMENTS " + "x".repeat(40_000);
    const messages: Message[] = [{ role: "user", content: [{ type: "tool_result", toolCallId: "r", toolName: "Read", content: "z".repeat(80_000) }, { type: "text", text: instruction }] }];
    const text = handoffTranscript(messages, 60_000).text;
    expect(text.includes(instruction)).toBe(true);
    expect(text.length).toBeLessThanOrEqual(60_000);
});

test("the initial task is kept before newer user messages", () => {
    const old = "OLD " + "x".repeat(800);
    const latest = "LATEST " + "y".repeat(800);
    const text = handoffTranscript([user(old), assistant("answer"), user(latest)], 1000).text;
    expect(text).toContain(old);
    expect(text).not.toContain(latest);
    expect(text.length).toBeLessThanOrEqual(1000);
});

test("shortening counts the characters actually removed, excluding the marker", () => {
    const result = handoffTranscript([user("HEAD " + "x".repeat(2000) + " TAIL")], 1000);
    const marker = result.text.match(/… \[(\d+) characters \/ ~\d+ lines omitted\] …/)!;
    expect(result.shortenedChars).toBe(Number(marker[1]));
});

test("compaction retains its original first-message and condensed-text policy", () => {
    const messages = [user("FIRST REQUEST"), ...Array.from({ length: 50 }, (_, i) => assistant(`step ${i} ` + "y".repeat(200)))];
    const text = compactTranscriptText(messages, 3000);
    expect(text.startsWith("User: FIRST REQUEST")).toBe(true);
    expect(text).toContain("step 49");
    expect(text).not.toContain("step 0 ");
    expect(text).toContain("earlier messages omitted");
    expect(compactTranscriptText([user("x".repeat(6000))], 60_000)).toContain("2000 characters");
});

test("after the initial task, newer user messages get the remaining budget first", () => {
    const initial = "INITIAL TASK";
    const older = "OLDER " + "x".repeat(800);
    const latest = "LATEST " + "y".repeat(800);
    const result = handoffTranscript([user(initial), user(older), user(latest)], 1000);
    expect(result.text).toContain(initial);
    expect(result.text).toContain(latest);
    expect(result.text).not.toContain(older);
    expect(result.shortenedChars).toBe("User: ".length + older.length);
});

test("assistant and tool parts keep their caps and count only original characters", () => {
    const input = { log: "x".repeat(2000) };
    const messages: Message[] = [user("TASK"), assistant("a".repeat(8000)), { role: "assistant", content: [{ type: "tool_call", id: "r", name: "Read", input }], stopReason: "tool_use" }, { role: "user", content: [{ type: "tool_result", toolCallId: "r", toolName: "Read", content: "z".repeat(5000) }] }];
    const result = handoffTranscript(messages, 60_000);
    expect(result.shortenedChars).toBe(8000 - 4000 + JSON.stringify(input).length - 600 + 5000 - 1500);
    expect(result.text.length).toBeLessThan(7000);
    const dropped = handoffTranscript(messages, 10);
    expect(dropped.text).toBe("User: TASK");
    expect(dropped.shortenedChars).toBe("Assistant: ".length + 8000 + "Assistant: [called Read: ]".length + JSON.stringify(input).length + "[result of Read: ]".length + 5000);
});

test("a handoff still discloses history when every block was left out", () => {
    const messages: Message[] = [{ role: "assistant", content: Array.from({ length: 20 }, () => ({ type: "text", text: "x".repeat(8000) })), stopReason: "end_turn" }];
    expect(handoffTranscript(messages, 60_000).text).toBe("");
    expect(handoff(messages)).toContain("Parts of it were shortened or left out");
});

test("a handoff frames attached files, and drops a whole file rather than cut a message through its frame", () => {
    const file = (name: string, text: string) => ({ type: "file" as const, kind: "text" as const, name, size: text.length, lines: 1, text });
    const msg: Message = { role: "user", content: [{ type: "text", text: "Read these." }, file("a.txt", "a".repeat(3000)), file("b.txt", "b".repeat(3000))] };
    const whole = handoffTranscript([msg], 60_000);
    expect(whole.text).toMatch(/<attached-file name="a\.txt" boundary="[0-9a-f]{16}">\na{3000}\n<\/attached-file boundary="[0-9a-f]{16}">/);
    expect(whole.shortenedChars).toBe(0);
    const tight = handoffTranscript([msg], 5000);
    expect(tight.text.length).toBeLessThanOrEqual(5000);
    expect(tight.text).toContain("Read these.");
    expect(tight.text).toContain("an attached file left out here, too long to include: b.txt");
    expect(tight.text).not.toContain("characters / ~");
    expect(tight.shortenedChars).toBeGreaterThanOrEqual(3000);
});
