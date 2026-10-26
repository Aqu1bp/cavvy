// A message with an image steering a running Codex turn, through the real Engine and Runtime and the fake Codex
// (test/fixtures/fake-codex.ts): it's the queue's until Codex has accepted it, so a refusal, an interrupt or the
// session closing leaves it queued (on disk too) or in the composer, image and all, and it reaches Codex once.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { createDemoProject } = await import("../scripts/demo-project");
const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
const { closeTiming } = await import("../src/server/runtime");
const { loadQueue } = await import("../src/agent/queue-store");
import type { SessionSnapshot } from "../src/server/protocol";

mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({}));
afterAll(() => iso.cleanup());

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const imageItem = { type: "image", url: `data:image/png;base64,${PNG}` };

function fakeCodex(): string {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    const bin = tempDir("steer-tx-cli-");
    writeFileSync(join(bin, "codex"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-codex.ts")}" "$@"\n`);
    chmodSync(join(bin, "codex"), 0o755);
    return join(bin, "codex");
}

type Client = { subs: Set<string>; send(e: { type: string }): void };
const newClient = (events: any[]): Client => ({ subs: new Set<string>(), send: (e) => void events.push(e) });

/** An Engine with a Codex session, its first prompt sent in `scenario`. */
async function codexSession(scenario: string, env: Record<string, string> = {}) {
    saveAgentConfig("codex", { path: fakeCodex() });
    process.env.FAKE_LOG = join(tempDir("steer-tx-log-"), "log.jsonl");
    process.env.FAKE_SCENARIO = scenario;
    Object.assign(process.env, env);
    const { Engine } = await import("../src/server/engine");
    const engine = new Engine();
    const events: any[] = [];
    const c = newClient(events);
    engine.clients.add(c as never);
    const cwd = createDemoProject(tempDir("steer-tx-proj-"), { git: false });
    const snap = (await engine.handle(c as never, "session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    await engine.handle(c as never, "models.list", { refresh: true });
    await engine.handle(c as never, "session.setModel", { id, ref: "codex:default", persist: false });
    await engine.handle(c as never, "session.send", { id, text: "start" });
    return { engine, c, id, rt, events };
}

async function cleanup(engine: { stop(): Promise<void> }) {
    await engine.stop();
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    removeAgentConfig("codex");
}

const received = (): any[] => {
    const f = process.env.FAKE_LOG!;
    return existsSync(f) ? readFileSync(f, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).flatMap((l) => (l.received?.method ? [l.received] : [])) : [];
};
const turnStarts = () => received().filter((m) => m.method === "turn/start").map((m) => m.params);
const steers = () => received().filter((m) => m.method === "turn/steer").map((m) => m.params);
const imagesIn = (input: any[]) => input.filter((i: any) => i.type === "image");
/** The images Codex took: in turns it started (every steer here is refused). */
const deliveredByTurns = () => turnStarts().flatMap((t) => imagesIn(t.input));
const imagesInHistory = (rt: { session: { messages: { content: { type: string }[] }[] } }) => rt.session.messages.filter((m) => m.content.some((p) => p.type === "image")).length;

async function until(check: () => boolean, ms = 15_000) {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) await Bun.sleep(20);
    return check();
}

describe("a steer with an image to Codex is the queue's until Codex accepts it", () => {
    test("refused: it stays queued, then runs as its own prompt after the run, its image sent once", async () => {
        const { engine, c, id, rt } = await codexSession("steps", { FAKE_STEER_FAIL: "1", FAKE_SLOW_TURN_START: "300" });
        try {
            // Once Codex's turn is on its way (it steers what's queued once it has started).
            expect(await until(() => rt.busy && turnStarts().length === 1)).toBe(true);
            await engine.handle(c as never, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data: PNG }], mode: "steer" });
            expect(await until(() => steers().length === 1)).toBe(true);
            expect(imagesIn(steers()[0]!.input)).toEqual([imageItem]);
            expect(await until(() => !rt.busy && !rt.snapshot().state.queued.length && turnStarts().length === 2)).toBe(true);
            expect(deliveredByTurns()).toEqual([imageItem]);
            expect(turnStarts()[1].input.find((i: any) => i.type === "text").text).toContain("look at this");
            // Recorded once: as the prompt it went as.
            expect(imagesInHistory(rt)).toBe(1);
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    // #438: Codex holds a steer until the turn's next step, and drops it if the turn is interrupted first.
    test("accepted, then the turn interrupted before Codex took it: it goes back to the composer with its image, and isn't in the history", async () => {
        const { engine, c, id, rt, events } = await codexSession("hang", { FAKE_STEER_PENDING: "1", FAKE_HANG_MS: "20000" });
        try {
            expect(await until(() => rt.busy && turnStarts().length === 1)).toBe(true);
            await engine.handle(c as never, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data: PNG }], mode: "steer" });
            const log = () => readFileSync(process.env.FAKE_LOG!, "utf-8");
            expect(await until(() => log().includes('"steerPending"'))).toBe(true);
            // Accepted, not taken: still the queue's.
            expect(rt.snapshot().state.queued).toEqual(["look at this"]);
            await engine.handle(c as never, "session.interrupt", { id });
            expect(await until(() => !rt.busy && events.some((e) => e.type === "draft"))).toBe(true);
            expect(log()).toContain('"steerDropped"');
            expect(events.find((e) => e.type === "draft")).toMatchObject({ text: "look at this", images: [{ mediaType: "image/png", data: PNG }] });
            expect(rt.snapshot().state.queued).toEqual([]);
            expect(imagesInHistory(rt)).toBe(0);
            expect(JSON.stringify(rt.session.messages)).not.toContain("look at this");
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("refused, then the turn interrupted: it goes back to the composer with its image, and isn't in the history", async () => {
        const { engine, c, id, rt, events } = await codexSession("slow", { FAKE_STEER_FAIL: "1" });
        try {
            expect(await until(() => rt.busy && turnStarts().length === 1)).toBe(true);
            await engine.handle(c as never, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data: PNG }], mode: "steer" });
            expect(await until(() => steers().length === 1)).toBe(true);
            await engine.handle(c as never, "session.interrupt", { id });
            expect(await until(() => !rt.busy && events.some((e) => e.type === "draft"))).toBe(true);
            expect(events.find((e) => e.type === "draft")).toMatchObject({ text: "look at this", images: [{ mediaType: "image/png", data: PNG }] });
            expect(rt.snapshot().state.queued).toEqual([]);
            expect(imagesInHistory(rt)).toBe(0);
            expect(JSON.stringify(rt.session.messages)).not.toContain("look at this");
            expect(deliveredByTurns()).toEqual([]);
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("the session closed while its turn/steer is unanswered: it stays in the saved queue, and after reopening goes once", async () => {
        const saved = { ...closeTiming };
        closeTiming.turnMs = 300;
        // Codex is slow to stop, and answers the steer (refusing it) only after the session was let go of.
        const { engine, c, id, rt } = await codexSession("slow", { FAKE_STEER_FAIL: "1", FAKE_STEER_MS: "1500", FAKE_IGNORE_INTERRUPT: "1" });
        const path = rt.session.path;
        try {
            expect(await until(() => rt.busy && turnStarts().length === 1)).toBe(true);
            await engine.handle(c as never, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data: PNG }], mode: "steer" });
            expect(await until(() => steers().length === 1)).toBe(true);
            await engine.handle(c as never, "session.close", { id });
            await engine.stop();
            // Its answer comes, and the run ends, after the release.
            await Bun.sleep(2000);
            expect(loadQueue(path, id)).toEqual([expect.objectContaining({ text: "look at this", attachments: [{ type: "image", mediaType: "image/png", data: PNG }] })]);
        } finally {
            Object.assign(closeTiming, saved);
        }
        delete process.env.FAKE_STEER_FAIL;
        delete process.env.FAKE_STEER_MS;
        delete process.env.FAKE_IGNORE_INTERRUPT;
        delete process.env.FAKE_SCENARIO;
        const { Engine } = await import("../src/server/engine");
        const again = new Engine();
        try {
            const c2 = newClient([]);
            again.clients.add(c2 as never);
            const snap = (await again.handle(c2 as never, "session.open", { id })) as SessionSnapshot;
            // Back in the queue, held for the user, image and all; nothing of it in the history.
            expect(snap.state.queued).toEqual(["look at this"]);
            expect(snap.state.queuedModes).toEqual(["held"]);
            const rt2 = again.runtimes.get(id)!;
            expect(imagesInHistory(rt2)).toBe(0);
            // The model was chosen for that session only (persist: false): chosen again.
            await again.handle(c2 as never, "models.list", { refresh: true });
            await again.handle(c2 as never, "session.setModel", { id, ref: "codex:default", persist: false });
            await again.handle(c2 as never, "session.sendQueuedNow", { id, queueId: snap.state.queueIds[0] });
            expect(await until(() => turnStarts().length === 2)).toBe(true);
            expect(deliveredByTurns()).toEqual([imageItem]);
            expect(imagesInHistory(rt2)).toBe(1);
        } finally {
            await cleanup(again);
        }
    }, 40_000);
    // Round 4 of the review.
    test("while its turn/steer is unanswered it can't be edited or removed; once Codex accepts it, it's recorded once", async () => {
        const { engine, c, id, rt } = await codexSession("slow", { FAKE_STEER_MS: "1200" });
        try {
            expect(await until(() => rt.busy && turnStarts().length === 1)).toBe(true);
            await engine.handle(c as never, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data: PNG }], mode: "steer" });
            expect(await until(() => steers().length === 1)).toBe(true);
            const [queueId] = rt.snapshot().state.queueIds;
            await expect(engine.handle(c as never, "session.dequeue", { id, queueId, edit: true })).rejects.toThrow(/going into the running turn/);
            await expect(engine.handle(c as never, "session.dequeue", { id, queueId })).rejects.toThrow(/going into the running turn/);
            expect(rt.snapshot().state.queued).toEqual(["look at this"]);
            // Accepted: out of the queue, and in the history once.
            expect(await until(() => !rt.snapshot().state.queued.length)).toBe(true);
            expect(imagesInHistory(rt)).toBe(1);
            expect(steers().flatMap((s) => imagesIn(s.input))).toEqual([imageItem]);
            await engine.handle(c as never, "session.interrupt", { id });
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("words sent after an image don't overtake it: they go once Codex has the image", async () => {
        const { engine, c, id, rt } = await codexSession("slow", { FAKE_STEER_MS: "800" });
        try {
            expect(await until(() => rt.busy && turnStarts().length === 1)).toBe(true);
            await engine.handle(c as never, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data: PNG }], mode: "steer" });
            expect(await until(() => steers().length === 1)).toBe(true);
            await engine.handle(c as never, "session.send", { id, text: "use the image above", mode: "steer" });
            await Bun.sleep(300);
            // Still on its way: the words wait behind it.
            expect(steers()).toHaveLength(1);
            expect(await until(() => steers().length === 2)).toBe(true);
            expect(steers()[1]!.input).toEqual([expect.objectContaining({ type: "text", text: "use the image above" })]);
            const texts = rt.session.messages.map((m) => JSON.stringify(m.content));
            expect(texts.findIndex((t) => t.includes("look at this"))).toBeLessThan(texts.findIndex((t) => t.includes("use the image above")));
            await engine.handle(c as never, "session.interrupt", { id });
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("drained in the queue's order: words queued after an image wait for it, rather than going first", async () => {
        const { engine, rt } = await codexSession("slow");
        try {
            expect(await until(() => rt.busy && turnStarts().length === 1)).toBe(true);
            const inner = rt as unknown as { queued: unknown[]; drainQueued(): Promise<any[]> | any[] };
            inner.queued = [
                { id: 901, text: "look at this", attachments: [{ type: "image", mediaType: "image/png", data: PNG }], mode: "steer" },
                { id: 902, text: "use the image above", mode: "steer" },
            ];
            const drained = await inner.drainQueued();
            expect(drained).toEqual([expect.objectContaining({ text: "look at this", transaction: expect.anything() })]);
            drained[0].transaction.refused();
            expect((inner.queued as { text: string; sending?: boolean }[]).map((q) => [q.text, Boolean(q.sending)])).toEqual([["look at this", false], ["use the image above", false]]);
            inner.queued = [];
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("its UserPromptSubmit hooks run once, refused and then sent as a prompt of its own", async () => {
        const seen = join(tempDir("steer-tx-hook-"), "seen.jsonl");
        writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ hooks: { UserPromptSubmit: [{ command: `cat >> '${seen}'; echo >> '${seen}'` }] } }));
        try {
            // Its turn/steer refused while the turn goes on (about 5 s), then the turn ends and the run with it.
            // The next turn asks nothing (on the live app-server it's the fake's second, not a new process's first).
            const { engine, c, id, rt } = await codexSession("slow", { FAKE_STEER_FAIL: "1", FAKE_CODEX_SCENARIOS: "slow,steps" });
            try {
                expect(await until(() => rt.busy && turnStarts().length === 1)).toBe(true);
                await engine.handle(c as never, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data: PNG }], mode: "steer" });
                expect(await until(() => steers().length === 1)).toBe(true);
                expect(await until(() => !rt.busy && !rt.snapshot().state.queued.length && turnStarts().length === 2, 20_000)).toBe(true);
                expect(deliveredByTurns()).toEqual([imageItem]);
                const runs = readFileSync(seen, "utf-8").split("\n").filter((l) => l.includes("look at this"));
                expect(runs).toHaveLength(1);
            } finally {
                await cleanup(engine);
            }
        } finally {
            writeFileSync(join(iso.home, "settings.json"), JSON.stringify({}));
        }
    }, 30_000);
});
