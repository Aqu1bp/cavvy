import { afterAll, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";
import type { AssistantMessage, ChatRequest, Message } from "../src/providers/types";

const iso = isolate();
const { compactTranscriptText, handoffTranscript } = await import("../src/agent/compact");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
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
    // The older one is cut to what's left.
    expect(result.text.length).toBeLessThanOrEqual(1000);
    expect(result.text).toContain("OLDER x");
    expect(result.text).not.toContain(older);
    expect(result.shortenedChars).toBe(800 - (result.text.match(/x/g) ?? []).length);
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
    // Exactly what b's entry was: the note of it isn't counted as kept.
    const note = "\n[an attached file left out here, too long to include: b.txt]";
    expect(tight.shortenedChars).toBe(whole.text.length - (tight.text.length - note.length));
});

test("a long paste (sent as a file part) is the user's own words: a handoff keeps it whole, and counts only what it cut", () => {
    const findings = Array.from({ length: 11 }, (_, i) => `Finding ${i + 1}: ` + "x".repeat(700)).join("\n");
    const paste: Message = { role: "user", content: [{ type: "text", text: "Fix these." }, { type: "file", kind: "text", name: "Pasted text", size: findings.length, lines: 11, text: findings, pasted: true }] };
    const whole = handoffTranscript([user("first"), assistant("ok"), paste], 60_000);
    for (let n = 1; n <= 11; n++) expect(whole.text).toContain(`Finding ${n}:`);
    expect(whole.shortenedChars).toBe(0);
    // An attached file (not a paste) is cut to 4000 inside its frame: what's counted is what it lost, not the marker.
    const attached: Message = { role: "user", content: [{ type: "file", kind: "text", name: "notes.txt", size: findings.length, lines: 11, text: findings }] };
    expect(handoffTranscript([attached], 60_000).shortenedChars).toBe(findings.length - 4000);
});

test("a paste bigger than the whole budget keeps its head and tail inside its frame, and the count is only what was cut", () => {
    const text = "HEAD " + "x".repeat(90_000) + " TAIL";
    const paste: Message = { role: "user", content: [{ type: "file", kind: "text", name: "Pasted text", size: text.length, lines: 1, text, pasted: true }] };
    const r = handoffTranscript([paste], 60_000);
    expect(r.text.length).toBeLessThanOrEqual(60_000);
    expect(r.text).toContain("HEAD ");
    expect(r.text).toContain(" TAIL");
    expect(r.text).toMatch(/<pasted-text boundary="[0-9a-f]+">\nHEAD [\s\S]*characters \/ ~[\s\S]* TAIL\n<\/pasted-text boundary="[0-9a-f]+">$/);
    const body = r.text.slice(r.text.indexOf("\nHEAD "), r.text.lastIndexOf(" TAIL\n"));
    const kept = (body.match(/x/g) ?? []).length + "HEAD  TAIL".length;
    expect(r.shortenedChars).toBe(text.length - kept);
});

test("a later message too big for what's left is cut to it, keeping its head and tail, not left out", () => {
    for (const later of [user("HEAD " + "x".repeat(90_000) + " TAIL"), { role: "user" as const, content: [{ type: "file" as const, kind: "text" as const, name: "Pasted text", size: 90_010, lines: 1, text: "HEAD " + "x".repeat(90_000) + " TAIL", pasted: true }] }]) {
        const r = handoffTranscript([user("Original task"), assistant("ok"), later], 60_000);
        expect(r.text.length).toBeLessThanOrEqual(60_000);
        expect(r.text).toContain("Original task");
        expect(r.text).toContain("HEAD ");
        expect(r.text).toContain(" TAIL");
    }
});


function contextAgent(script: (req: ChatRequest, n: number) => AssistantMessage | Promise<AssistantMessage>) {
    const cwd = realpathSync(tempDir());
    const session = Session.create(cwd, { system: "SYSTEM" });
    const settings = { autoCompact: false, delegation: false };
    const requests: ChatRequest[] = [];
    const events: any[] = [];
    const agent = new Agent({
        session,
        model: { provider: "test", id: "test" },
        client: { stream: async (req) => { requests.push(structuredClone({ ...req, signal: undefined })); return script(req, requests.length); }, listModels: async () => [] },
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: [],
        mode: { get: () => "bypassPermissions", set() {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { emit: (e) => events.push(e), ui: {} },
    });
    const run = (signal = new AbortController().signal) => agent.run([{ type: "text", text: "finish the task" }], { signal });
    return { agent, session, requests, events, run };
}
const contextReply = (text: string, stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessage => ({ role: "assistant", provider: "test", model: "test", content: [{ type: "text", text }], stopReason });

test("context exhaustion compacts once even with autoCompact off, retaining partial text and usage", async () => {
    const a = contextAgent((_req, n) => n === 1
        ? { ...contextReply("partial answer", "context_window_exceeded"), usage: { inputTokens: 100, outputTokens: 12 } }
        : contextReply(n === 2 ? "summary of the task and partial answer" : "finished"));
    try {
        expect(await a.run()).toBe("done");
        expect(a.requests).toHaveLength(3);
        expect(a.requests[1]!.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "partial answer" }] }));
        expect(a.requests[2]!.messages).toContainEqual(expect.objectContaining({ role: "user", meta: expect.objectContaining({ kind: "summary" }) }));
        expect(a.events.filter((e) => e.type === "compact_start")).toHaveLength(1);
        expect(a.events.some((e) => e.type === "usage" && e.usage.outputTokens === 12)).toBe(true);
        expect(JSON.stringify(a.requests)).not.toContain("output token limit");
    } finally { a.session.release(); }
});

test("context exhaustion never executes its tool calls and closes them before compacting", async () => {
    const a = contextAgent((_req, n) => n === 1
        ? { ...contextReply("partial", "context_window_exceeded"), content: [{ type: "tool_call", id: "cut", name: "Write", input: { path: "partial" } }] }
        : contextReply(n === 2 ? "summary" : "finished"));
    try {
        expect(await a.run()).toBe("done");
        expect(a.events.some((e) => e.type === "tool_start")).toBe(false);
        const results = a.requests[1]!.messages.flatMap((m) => m.content).filter((p) => p.type === "tool_result");
        expect(results).toEqual([expect.objectContaining({ toolCallId: "cut", isError: true, content: expect.stringContaining("context window") })]);
        expect(JSON.stringify(a.requests)).not.toContain("smaller pieces");
    } finally { a.session.release(); }
});

test("repeated context exhaustion ends with context guidance instead of output retries", async () => {
    const a = contextAgent((_req, n) => contextReply(n === 2 ? "summary" : "partial", n === 2 ? "end_turn" : "context_window_exceeded"));
    try {
        expect(await a.run()).toBe("error");
        expect(a.requests).toHaveLength(3);
        expect(a.events.filter((e) => e.type === "compact_start")).toHaveLength(1);
        expect(a.session.notices.at(-1)?.text).toContain("context window");
        expect(JSON.stringify(a.events)).not.toContain("output token limit");
    } finally { a.session.release(); }
});

test("failed context compaction ends with context guidance and keeps the partial answer", async () => {
    const a = contextAgent((_req, n) => { if (n === 2) throw new Error("summary unavailable"); return contextReply("partial", "context_window_exceeded"); });
    try {
        expect(await a.run()).toBe("error");
        expect(a.requests).toHaveLength(2);
        expect(a.session.messages).toContainEqual(expect.objectContaining({ role: "assistant", content: [{ type: "text", text: "partial" }] }));
        expect(a.session.notices.at(-1)?.text).toContain("context window");
    } finally { a.session.release(); }
});

test("abort during context compaction does not retry or replace the transcript", async () => {
    const controller = new AbortController();
    const a = contextAgent((_req, n) => {
        if (n === 2) controller.abort();
        return contextReply(n === 2 ? "discard this summary" : "partial", n === 2 ? "end_turn" : "context_window_exceeded");
    });
    try {
        expect(await a.run(controller.signal)).toBe("aborted");
        expect(a.requests).toHaveLength(2);
        expect(a.events.some((e) => e.type === "compact_end")).toBe(false);
        expect(a.session.messages.some((m) => m.role === "user" && m.meta?.kind === "summary")).toBe(false);
    } finally { a.session.release(); }
});

test("a context-limited compaction summary uses the condensed fallback", async () => {
    const a = contextAgent((_req, n) => contextReply(n < 3 ? "incomplete" : n === 3 ? "complete summary" : "finished", n < 3 ? "context_window_exceeded" : "end_turn"));
    try {
        expect(await a.run()).toBe("done");
        expect(a.requests).toHaveLength(4);
        expect(a.requests[2]!.tools).toEqual([]);
        expect(JSON.stringify(a.requests[3]!.messages)).toContain("complete summary");
        expect(JSON.stringify(a.requests[3]!.messages)).not.toContain("incomplete");
    } finally { a.session.release(); }
});

test("a context-limited fallback summary fails without replacing history", async () => {
    const a = contextAgent(() => contextReply("incomplete", "context_window_exceeded"));
    try {
        expect(await a.run()).toBe("error");
        expect(a.requests).toHaveLength(3);
        expect(a.events.some((e) => e.type === "compact_end")).toBe(false);
        expect(a.session.messages.some((m) => m.role === "user" && m.meta?.kind === "summary")).toBe(false);
    } finally { a.session.release(); }
});
