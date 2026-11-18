// Images and files attached to an answer to the agent's question: what the
// server accepts, and how they reach the agent that asked: Cavvy's own loop as
// images and framed files in AskUserQuestion's result, an agent CLI (whose
// answer is text) as files saved in the project and named in the answer.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { answerAttachments, attachmentsDir, fileSaver } = await import("../src/server/attachments");
const { answerWithAttachments, attachedAsText } = await import("../src/providers/files");
const { AskUserQuestionTool } = await import("../src/tools/meta-tools");
import type { AttachedPart, Message, ToolResultPart } from "../src/providers/types";
import type { QuestionInteraction, ServerEvent, SessionSnapshot } from "../src/server/protocol";
import type { ToolContext } from "../src/tools/types";

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

afterAll(() => {
    mock.stop();
    iso.cleanup();
});

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString("base64");
const PDF = b64("%PDF-1.4\n1 0 obj << >> endobj\n%%EOF\n");
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function until(pred: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

async function questionAsked() {
    const engine = new Engine();
    const events: ServerEvent[] = [];
    const c = { subs: new Set<string>(), send: (e: ServerEvent) => void events.push(e) };
    engine.clients.add(c as never);
    const cwd = createDemoProject(tempDir("cavvy-qa-proj-"), { git: false });
    const snap = (await engine.handle(c as never, "session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    await engine.handle(c as never, "session.send", { id, text: "question" });
    await until(() => rt.snapshot().state.interactions.length > 0);
    const it = rt.snapshot().state.interactions[0] as QuestionInteraction;
    const respond = (response: unknown) => engine.handle(c as never, "session.respond", { id, interactionId: it.id, response });
    return { engine, c, id, rt, cwd, it, respond };
}

const toolResult = (messages: Message[]) => messages.flatMap((m) => (m.role === "user" ? m.content : [])).find((p): p is ToolResultPart => p.type === "tool_result" && p.toolName === "AskUserQuestion");

describe("answering Cavvy's own agent", () => {
    test("the question card offers attaching; images go as images, text framed in, a PDF saved and named", async () => {
        const { rt, cwd, it, respond } = await questionAsked();
        expect(it.attach).toBe(true);
        await respond({ kind: "question", answers: ["SAML 2.0"], images: [{ mediaType: "image/png", data: PNG }], files: [{ name: "idp.xml", data: b64("<EntityDescriptor/>\n") }, { name: "spec.pdf", data: PDF }] });
        await until(() => rt.idle && Boolean(toolResult(rt.session.messages)));
        const r = toolResult(rt.session.messages)!;
        expect(r.images).toEqual([{ type: "image", mediaType: "image/png", data: PNG }]);
        expect(r.content.startsWith("The user answered: SAML 2.0")).toBe(true);
        expect(r.content).toMatch(/<attached-file name="idp\.xml" boundary="[0-9a-f]{16}">\n<EntityDescriptor\/>\n/);
        expect(r.content).toContain("An image the user attached is included below.");
        const path = /The user attached "spec\.pdf" \(\d+ B\)\. It's saved at (\S+);/.exec(r.content)?.[1];
        expect(path?.startsWith(join(attachmentsDir(cwd), rt.id))).toBe(true);
        expect(readFileSync(path!, "latin1").startsWith("%PDF-")).toBe(true);
        // The agent got them all, and the reply says so (the mock names what it was given).
        expect(rt.snapshot().turns.at(-1)!.blocks.some((b) => b.t === "text" && b.text.includes("I have idp.xml, spec.pdf, an image."))).toBe(true);
    });

    test("attachments alone answer it; a refused one leaves the question waiting", async () => {
        const { rt, respond } = await questionAsked();
        await expect(respond({ kind: "question", answers: [], images: [{ mediaType: "image/svg+xml", data: b64("<svg/>") }] })).rejects.toThrow(/PNG, JPEG, GIF or WebP/);
        await expect(respond({ kind: "question", answers: [], files: Array.from({ length: 11 }, (_, i) => ({ name: `${i}.txt`, data: b64("x") })) })).rejects.toThrow(/10 files at most/);
        expect(rt.snapshot().state.interactions).toHaveLength(1);
        await respond({ kind: "question", answers: [], files: [{ name: "notes.md", data: b64("prefer OIDC\n") }] });
        await until(() => rt.idle && Boolean(toolResult(rt.session.messages)));
        const r = toolResult(rt.session.messages)!;
        expect(r.content.startsWith("The user answered with attachments only.")).toBe(true);
        expect(r.content).toContain("prefer OIDC");
        expect(r.images).toBeUndefined();
    });

    test("skipping still dismisses it, attachments or not", async () => {
        const { rt, respond } = await questionAsked();
        await respond({ kind: "question" });
        await until(() => rt.idle && Boolean(toolResult(rt.session.messages)));
        expect(toolResult(rt.session.messages)!.content).toContain("dismissed the question");
    });
});

describe("the AskUserQuestion tool", () => {
    const ctx = (ui: ToolContext["ui"]) => ({ ui }) as unknown as ToolContext;
    test("asks for content where it can, and shows what was attached in its summary", async () => {
        let as: string | undefined;
        const attached: AttachedPart[] = [{ type: "image", mediaType: "image/png", data: PNG }, { type: "file", kind: "saved", name: "big.zip", size: 2048, path: "/p/.cavvy/attachments/s/x/big.zip" }];
        const r = await AskUserQuestionTool.run({ question: "Which?", options: [{ label: "A" }] }, ctx({ askQuestion: async () => ["A"], askQuestionAttaching: async (_q, _o, _m, a) => ((as = a), { answers: ["A"], attached }) }));
        expect(as).toBe("content");
        expect(r.images).toEqual([attached[0]]);
        expect(r.content).toContain("It's saved at /p/.cavvy/attachments/s/x/big.zip");
        expect(r.display?.summary).toBe("A, attached image, big.zip");
    });

    test("without attaching (the terminal), it asks as before", async () => {
        const r = await AskUserQuestionTool.run({ question: "Which?", options: [{ label: "A" }] }, ctx({ askQuestion: async () => ["A"] }));
        expect(r.content).toBe("The user answered: A");
    });
});

describe("answers that are text only (agent CLIs)", () => {
    test("paths: images and PDFs are saved in the session's folder and named; text is framed in", () => {
        const cwd = tempDir("cavvy-qa-paths-");
        const parts = answerAttachments({ images: [{ mediaType: "image/png", data: PNG }], files: [{ name: "a.txt", data: b64("hello\n") }, { name: "doc.pdf", data: PDF }] }, fileSaver(cwd, "sess"), "paths");
        expect(parts.map((p) => (p.type === "file" ? p.kind : p.type))).toEqual(["saved", "text", "saved"]);
        const saved = parts.filter((p) => p.type === "file" && p.kind === "saved") as Extract<AttachedPart, { kind: "saved" }>[];
        expect(saved.map((p) => p.name)).toEqual(["image-1.png", "doc.pdf"]);
        for (const p of saved) {
            expect(p.path.startsWith(join(attachmentsDir(cwd), "sess"))).toBe(true);
            expect(existsSync(p.path)).toBe(true);
        }
        expect(readFileSync(saved[0]!.path)).toEqual(Buffer.from(PNG, "base64"));
        const lines = attachedAsText(parts);
        expect(lines).toHaveLength(3);
        expect(lines[0]).toContain(`It's saved at ${saved[0]!.path}`);
        expect(lines[1]).toMatch(/<attached-file name="a\.txt"[^>]*>\nhello\n/);
        expect(lines[2]).toContain(`It's saved at ${saved[1]!.path}`);
    });

    test("content: images stay images, a PDF is saved (a tool result can't carry one)", () => {
        const cwd = tempDir("cavvy-qa-content-");
        const parts = answerAttachments({ images: [{ mediaType: "image/png", data: PNG }], files: [{ name: "doc.pdf", data: PDF }] }, fileSaver(cwd, "sess"), "content");
        expect(parts[0]).toEqual({ type: "image", mediaType: "image/png", data: PNG });
        expect(parts[1]).toMatchObject({ type: "file", kind: "saved", name: "doc.pdf" });
        const { text, images } = answerWithAttachments(["B"], parts);
        expect(images).toHaveLength(1);
        expect(text).toContain("The user answered: B");
        expect(text).toContain("doc.pdf");
    });
});
