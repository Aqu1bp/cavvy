// A message with an image, sent while a Claude Code session is busy, reaches Claude Code with its image:
// through the real Engine and Runtime, and the fake `claude` (test/fixtures/fake-claude.ts), whose log says
// what it was sent on stdin.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { createDemoProject } = await import("../scripts/demo-project");
const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
import type { SessionSnapshot } from "../src/server/protocol";

mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({}));

afterAll(() => iso.cleanup());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function fakeClaude(): string {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    const bin = tempDir("queued-images-cli-");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    return join(bin, "claude");
}

/** A session on the fake Claude Code in `scenario` (then `second` for its later prompts), with its first prompt sent. */
async function claudeSession(scenario: string, env: Record<string, string> = {}) {
    saveAgentConfig("claude-code", { path: fakeClaude() });
    process.env.FAKE_SCENARIO = scenario;
    process.env.FAKE_LOG = join(tempDir("queued-images-log-"), "log.jsonl");
    Object.assign(process.env, env);
    const { Engine } = await import("../src/server/engine");
    const engine = new Engine();
    const events: { type: string }[] = [];
    const c = { subs: new Set<string>(), send: (e: { type: string }) => void events.push(e) };
    engine.clients.add(c);
    const cwd = createDemoProject(tempDir("queued-images-proj-"), { git: false });
    const snap = (await engine.handle(c, "session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    await engine.handle(c, "models.list", { refresh: true });
    await engine.handle(c, "session.setModel", { id, ref: "claude-code:default", persist: false });
    await engine.handle(c, "session.send", { id, text: "start" });
    return { engine, c, id, rt, events };
}

async function cleanup(engine: { stop(): Promise<void> }) {
    await engine.stop();
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    removeAgentConfig("claude-code");
}

/** The user messages the fake Claude Code got on stdin. */
function received(): { content: any[] }[] {
    const file = process.env.FAKE_LOG!;
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.received?.type === "user").map((l) => l.received.message);
}
const withText = (text: string) => received().find((m) => m.content.some((b) => b.type === "text" && b.text.includes(text)));
const images = (m: { content: any[] } | undefined) => (m?.content ?? []).filter((b) => b.type === "image");

async function until(check: () => boolean, ms = 15_000) {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) await Bun.sleep(20);
    return check();
}

/** Its image, as Claude Code's stream-json takes it, in what Claude Code was sent, and in the session's record. */
function expectDelivered(rt: { session: { messages: { role: string; content: any[] }[] } }, text: string) {
    const sent = withText(text);
    expect(sent).toBeDefined();
    expect(images(sent)).toEqual([{ type: "image", source: { type: "base64", media_type: "image/png", data: PNG } }]);
    const stored = rt.session.messages.find((m) => m.role === "user" && m.content.some((p) => p.type === "text" && p.text.includes(text)));
    expect(stored?.content.filter((p) => p.type === "image")).toEqual([{ type: "image", mediaType: "image/png", data: PNG }]);
}

/** What the fake folded into its running turn (the steering scenario), as it logged it. */
function folded(): string[] {
    const file = process.env.FAKE_LOG!;
    if (!existsSync(file)) return [];
    return readFileSync(file, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).flatMap((l) => l.foldedBeforeResult ?? []);
}

describe("steering a running Claude Code turn with an image", () => {
    test("it joins the turn at its next tool round, its image before its text, and the turn shows it", async () => {
        const { engine, c, id, rt } = await claudeSession("steering", { FAKE_SECOND_SCENARIO: "silent" });
        try {
            expect(await until(() => rt.busy)).toBe(true);
            expect(await engine.handle(c, "session.send", { id, text: "look at this screenshot", images: [{ mediaType: "image/png", data: PNG }], mode: "steer" })).toEqual({ queued: true });
            expect(rt.snapshot().state.queuedModes).toEqual(["steer"]);
            expect(await until(() => !rt.busy)).toBe(true);
            // Folded into the turn that was running, not a turn of its own after it.
            expect(folded()).toEqual(["look at this screenshot"]);
            const sent = withText("look at this screenshot")!;
            expect(sent.content.map((b) => b.type)).toEqual(["image", "text"]);
            expectDelivered(rt, "look at this screenshot");
            const turn = rt.snapshot().turns.find((t) => t.prompt?.text === "look at this screenshot")!;
            expect(turn.prompt).toMatchObject({ images: 1 });
            expect(rt.promptImages(turn.pos!.seg, turn.pos!.index)).toEqual([{ mediaType: "image/png", data: PNG }]);
        } finally {
            await cleanup(engine);
        }
    }, 30_000);
});

const PDF = Buffer.from("%PDF-1.4\n% a test document\n%%EOF\n").toString("base64");
const log = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);

// Claude Code drops a mid-turn message's document blocks (claude-2.1.304-steer-pdf-dropped.jsonl): a PDF waits.
describe("steering a running Claude Code turn with a PDF", () => {
    test("it waits for a turn of its own, says why, and Claude Code gets the PDF then", async () => {
        const { engine, c, id, rt } = await claudeSession("steering", { FAKE_SECOND_SCENARIO: "silent" });
        try {
            expect(await until(() => rt.busy)).toBe(true);
            await engine.handle(c, "session.send", { id, text: "read this pdf", files: [{ name: "spec.pdf", data: PDF }], mode: "steer" });
            expect(rt.snapshot().state.queuedModes).toEqual(["turn"]);
            expect(rt.snapshot().state.queuedWhy).toEqual(["Claude Code can't take PDFs in a running turn: this runs once it ends."]);
            const [queueId] = rt.snapshot().state.queueIds;
            await expect(engine.handle(c, "session.sendQueuedNow", { id, queueId })).rejects.toThrow(/can't take PDFs in a running turn/);
            expect(await until(() => !rt.busy && !rt.snapshot().state.queued.length && Boolean(withText("read this pdf")))).toBe(true);
            // Not folded into the running turn (where it'd be dropped), but its own prompt, with the document.
            expect(folded()).toEqual([]);
            expect(log().some((l) => l.droppedMidTurnDocuments)).toBe(false);
            expect(withText("read this pdf")!.content.map((b) => b.type)).toEqual(["document", "text"]);
            const stored = rt.session.messages.find((m) => m.role === "user" && JSON.stringify(m.content).includes("read this pdf"))!;
            expect(stored.content.some((p) => p.type === "file" && p.kind === "pdf")).toBe(true);
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("an image with a PDF: the whole message waits, not split", async () => {
        const { engine, c, id, rt } = await claudeSession("steering", { FAKE_SECOND_SCENARIO: "silent" });
        try {
            expect(await until(() => rt.busy)).toBe(true);
            await engine.handle(c, "session.send", { id, text: "both of these", images: [{ mediaType: "image/png", data: PNG }], files: [{ name: "spec.pdf", data: PDF }], mode: "steer" });
            expect(rt.snapshot().state.queuedModes).toEqual(["turn"]);
            expect(await until(() => !rt.busy && !rt.snapshot().state.queued.length && Boolean(withText("both of these")))).toBe(true);
            expect(folded()).toEqual([]);
            expect(withText("both of these")!.content.map((b) => b.type)).toEqual(["image", "document", "text"]);
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("a text file still joins the running turn: it goes as text", async () => {
        const { engine, c, id, rt } = await claudeSession("steering", { FAKE_SECOND_SCENARIO: "silent" });
        try {
            expect(await until(() => rt.busy)).toBe(true);
            await engine.handle(c, "session.send", { id, text: "and these notes", files: [{ name: "notes.md", data: Buffer.from("# remember the cache\n").toString("base64") }], mode: "steer" });
            expect(rt.snapshot().state.queuedModes).toEqual(["steer"]);
            expect(await until(() => !rt.busy)).toBe(true);
            expect(folded()).toHaveLength(1);
            expect(folded()[0]).toStartWith("and these notes");
            expect(folded()[0]).toContain("# remember the cache");
        } finally {
            await cleanup(engine);
        }
    }, 30_000);
});

describe("a message with an image sent while Claude Code is busy", () => {
    for (const mode of ["steer", "queue", undefined] as const) {
        test(`mid-turn (${mode ?? "the setting's default"}): it runs after the turn, with its image`, async () => {
            const { engine, c, id, rt } = await claudeSession("steering", { FAKE_SECOND_SCENARIO: "silent" });
            try {
                expect(await until(() => rt.busy)).toBe(true);
                expect(await engine.handle(c, "session.send", { id, text: "look at this screenshot", images: [{ mediaType: "image/png", data: PNG }], ...(mode ? { mode } : {}) })).toEqual({ queued: true });
                expect(await until(() => !rt.busy && !rt.snapshot().state.queued.length && Boolean(withText("look at this screenshot")))).toBe(true);
                expectDelivered(rt, "look at this screenshot");
            } finally {
                await cleanup(engine);
            }
        }, 30_000);
    }

    for (const scenario of ["shell-background", "agent-background"]) {
        for (const mode of ["steer", "queue"] as const) {
            test(`while Claude Code only waits on its background work (${scenario}, ${mode}): it goes at once, with its image`, async () => {
                const { engine, c, id, rt } = await claudeSession(scenario, { FAKE_SECOND_SCENARIO: "silent", FAKE_SHELL_MS: "4000", FAKE_BACKGROUND_MS: "4000" });
                try {
                    expect(await until(() => Boolean(rt.snapshot().state.activity?.label?.includes("Waiting for")))).toBe(true);
                    expect(await engine.handle(c, "session.send", { id, text: "look at this screenshot", images: [{ mediaType: "image/png", data: PNG }], mode })).toEqual({ queued: true });
                    // Delivered before the background work is over.
                    expect(await until(() => Boolean(withText("look at this screenshot")), 3000)).toBe(true);
                    expectDelivered(rt, "look at this screenshot");
                } finally {
                    await cleanup(engine);
                }
            }, 30_000);
        }
    }
});
