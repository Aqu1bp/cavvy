// Steering a Claude Code turn from the app: through the real Engine and Runtime and the fake `claude`
// (test/fixtures/fake-claude.ts, steer-live). A message sent to steer leaves the queue as it's sent and joins the
// running turn; one sent while the reply is written cuts it there, and the words so far stay with the turn before.
// A model that takes nothing mid-turn is never offered Steer.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { createDemoProject } = await import("../scripts/demo-project");
const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
const { agentCli } = await import("../src/backends/defs");
import type { SessionSnapshot } from "../src/server/protocol";

mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({}));

afterAll(() => iso.cleanup());

function fakeClaude(): string {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    const bin = tempDir("steer-runtime-cli-");
    writeFileSync(join(bin, "claude"), `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
    chmodSync(join(bin, "claude"), 0o755);
    return join(bin, "claude");
}

/** A session on the fake Claude Code (steer-live), with its first prompt sent. `liveOff`: a process per run. */
async function claudeSession(env: Record<string, string>, o: { liveOff?: boolean } = {}) {
    saveAgentConfig("claude-code", { path: fakeClaude() });
    process.env.FAKE_SCENARIO = "steer-live";
    process.env.FAKE_LOG = join(tempDir("steer-runtime-log-"), "log.jsonl");
    Object.assign(process.env, env);
    const { Engine } = await import("../src/server/engine");
    const engine = new Engine();
    const c = { subs: new Set<string>(), send: () => {} };
    engine.clients.add(c);
    const cwd = createDemoProject(tempDir("steer-runtime-proj-"), { git: false });
    const snap = (await engine.handle(c, "session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    if (o.liveOff) (rt as any).ws.settings = { ...(rt as any).ws.settings, agentCli: { liveSessions: false } };
    await engine.handle(c, "models.list", { refresh: true });
    await engine.handle(c, "session.setModel", { id, ref: "claude-code:default", persist: false });
    await engine.handle(c, "session.send", { id, text: "start" });
    return { engine, c, id, rt };
}

async function cleanup(engine: { stop(): Promise<void> }) {
    await engine.stop();
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    removeAgentConfig("claude-code");
}

const log = () => (existsSync(process.env.FAKE_LOG!) ? readFileSync(process.env.FAKE_LOG!, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const sent = (text: string) => log().find((l) => l.received?.type === "user" && JSON.stringify(l.received.message.content).includes(text))?.received;

async function until(check: () => boolean, ms = 15_000) {
    for (const end = Date.now() + ms; !check() && Date.now() < end; ) await Bun.sleep(20);
    return check();
}

/** Each turn's prompt and the text of its blocks. */
const shown = (rt: { snapshot(): SessionSnapshot }) => rt.snapshot().turns.map((t) => ({ prompt: t.prompt?.text, steered: Boolean(t.prompt?.steered), text: t.blocks.flatMap((b) => (b.t === "text" ? [b.text] : [])).join(" ") }));

describe("steering a running Claude Code turn from the app", () => {
    test("sent while a call runs: out of the queue at once, into the turn with the call's result, shown joined to it", async () => {
        const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "2000" });
        try {
            expect(await until(() => rt.snapshot().turns.some((t) => t.blocks.some((b) => b.t === "tool" && b.id === "toolu_live")))).toBe(true);
            expect(await engine.handle(c, "session.send", { id, text: "use the other file", mode: "steer" })).toEqual({ queued: true });
            // Gone from the queue and to Claude Code well before the call's result.
            expect(await until(() => !rt.snapshot().state.queued.length && Boolean(sent("use the other file")), 1000)).toBe(true);
            expect(sent("use the other file").priority).toBeUndefined();
            expect(rt.busy).toBe(true);
            expect(await until(() => !rt.busy)).toBe(true);
            const turns = shown(rt);
            expect(turns.map((t) => [t.prompt, t.steered])).toEqual([["start", false], ["use the other file", true]]);
            expect(turns[1]!.text).toContain("Adjusted: use the other file");
            // Reopened, it still shows as steered in.
            await engine.stop();
            const { Engine } = await import("../src/server/engine");
            const reopened = new Engine();
            const next = { subs: new Set<string>(), send() {} };
            reopened.clients.add(next);
            try {
                const view = (await reopened.handle(next, "session.open", { id })) as SessionSnapshot;
                expect(view.turns.map((t) => [t.prompt?.text, Boolean(t.prompt?.steered)])).toEqual([["start", false], ["use the other file", true]]);
            } finally {
                await reopened.stop();
            }
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("sent while the reply is written: the reply cut, its words staying with the turn before (not shown twice), and the message answered at once", async () => {
        const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "50", FAKE_WRITE_MS: "5000" });
        try {
            expect(await until(() => rt.snapshot().turns.some((t) => t.blocks.some((b) => b.t === "text" && b.text.startsWith("Counting:"))))).toBe(true);
            await engine.handle(c, "session.send", { id, text: "stop counting", mode: "steer" });
            expect(await until(() => Boolean(sent("stop counting")), 1000)).toBe(true);
            expect(sent("stop counting").priority).toBe("now");
            expect(await until(() => !rt.busy, 4000)).toBe(true);
            const turns = shown(rt);
            expect(turns.map((t) => [t.prompt, t.steered])).toEqual([["start", false], ["stop counting", true]]);
            const cut = log().find((l) => "liveReply" in l)!;
            expect(cut.cut).toBe(true);
            // All it wrote before the cut, in the turn it was written in; none of it under the message.
            expect(turns[0]!.text).toContain(cut.liveReply);
            expect(turns[1]!.text).not.toContain("Counting:");
            expect(turns[1]!.text).toContain("Took: stop counting");
        } finally {
            await cleanup(engine);
        }
    }, 30_000);
});

/** The agent's id for the steer whose turn's prompt is `text` (Runtime.steeredTurns). */
const idOf = (rt: { snapshot(): SessionSnapshot }, text: string): number => {
    const turn = rt.snapshot().turns.find((t) => t.prompt?.text === text)!;
    return [...((rt as any).steeredTurns as Map<number, string>)].find(([, t]) => t === turn.id)![0];
};

describe("Esc with a steer Claude Code never took", () => {
    // Claude Code decides before the run is over: the agent's guard for a hand-back after it is never needed here.
    const debug = join(tempDir("steer-debug-"), "live.log");
    beforeAll(() => void Object.assign(process.env, { CAVVY_DEBUG: "1", CAVVY_DEBUG_FILE: debug }));
    afterAll(() => {
        delete process.env.CAVVY_DEBUG;
        delete process.env.CAVVY_DEBUG_FILE;
    });
    /** What the live layer logged: the hand-backs it made, and never one after its run. */
    const logged = () => (existsSync(debug) ? readFileSync(debug, "utf-8") : "");
    /** Drafts the server hands back to the composer. */
    const drafts = (c: { send: unknown }) => {
        const out: any[] = [];
        c.send = (ev: any) => void (ev.type === "draft" && out.push(ev));
        return out;
    };

    test("it leaves the conversation (live, on disk, reopened) and goes back to the composer, after what's typed; the turn before ends stopped; the next prompt has no note of it", async () => {
        const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "5000" });
        const back = drafts(c);
        try {
            expect(await until(() => rt.snapshot().turns.some((t) => t.blocks.some((b) => b.t === "tool" && b.id === "toolu_live")))).toBe(true);
            await engine.handle(c, "session.send", { id, text: "and then deploy", mode: "steer" });
            expect(await until(() => Boolean(sent("and then deploy")) && shown(rt).some((t) => t.steered), 2000)).toBe(true);
            await engine.handle(c, "session.interrupt", { id });
            expect(await until(() => !rt.busy && back.length > 0)).toBe(true);
            expect(back).toHaveLength(1);
            expect(back[0]).toMatchObject({ sessionId: id, text: "and then deploy", after: true });
            // Its turn is gone; the one it followed is the one stopped, nothing holding it open.
            expect(rt.snapshot().turns.map((t) => [t.prompt?.text, t.prompt?.steered ?? false, t.status])).toEqual([["start", false, "aborted"]]);
            expect(JSON.stringify(rt.session.messages)).not.toContain("and then deploy");
            await engine.handle(c, "session.send", { id, text: "next one" });
            expect(await until(() => Boolean(sent("next one")) && !rt.busy)).toBe(true);
            expect(JSON.stringify(sent("next one").message.content)).not.toContain("and then deploy");
            expect(JSON.stringify(rt.session.messages)).not.toContain("ended before it reached you");
            await engine.stop();
            // Reopened from disk: as it was left.
            const { Engine } = await import("../src/server/engine");
            const reopened = new Engine();
            const next = { subs: new Set<string>(), send() {} };
            reopened.clients.add(next);
            try {
                const view = (await reopened.handle(next, "session.open", { id })) as SessionSnapshot;
                expect(view.turns.map((t) => [t.prompt?.text, t.status])).toEqual([["start", "aborted"], ["next one", "done"]]);
                expect(JSON.stringify(view.turns)).not.toContain("and then deploy");
            } finally {
                await reopened.stop();
            }
        } finally {
            await cleanup(engine);
        }
    }, 40_000);

    test("only the one handed back leaves: one the CLI took (not handed back) stays, steered in, and isn't returned", async () => {
        const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "5000" });
        const back = drafts(c);
        try {
            expect(await until(() => rt.snapshot().turns.some((t) => t.blocks.some((b) => b.t === "tool" && b.id === "toolu_live")))).toBe(true);
            await engine.handle(c, "session.send", { id, text: "taken one", mode: "steer" });
            expect(await until(() => Boolean(sent("taken one")), 2000)).toBe(true);
            await engine.handle(c, "session.send", { id, text: "left one", mode: "steer" });
            expect(await until(() => Boolean(sent("left one")), 2000)).toBe(true);
            expect(shown(rt).map((t) => [t.prompt, t.steered])).toEqual([["start", false], ["taken one", true], ["left one", true]]);
            // One it doesn't know (its turn gone, its run over) isn't handed back: the agent keeps it, in a note.
            expect((rt as any).unsteered([{ id: 99_999, texts: ["unknown"], attachments: [] }])).toEqual([]);
            // As the agent hands back the one Claude Code dropped (AgentHost.unsteered), by the id it gave it.
            const steer = idOf(rt, "left one");
            expect((rt as any).unsteered([{ id: steer, texts: ["left one"], attachments: [] }])).toEqual([steer]);
            expect(shown(rt).map((t) => [t.prompt, t.steered])).toEqual([["start", false], ["taken one", true]]);
            expect(rt.snapshot().turns.at(-1)!.status).toBe("running");
            expect(await until(() => back.length > 0, 1000)).toBe(true);
            expect(back.map((d) => d.text)).toEqual(["left one"]);
            // Esc then: what's left of it (the other one, which Claude Code hadn't taken either) before the turn ends.
            await engine.handle(c, "session.interrupt", { id });
            expect(await until(() => !rt.busy)).toBe(true);
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("Esc with the withdrawal answered after the turn's result: the turn waits for it, the steer is back before the turn ends, and a prompt sent at once goes after it (live, reloaded, forked)", async () => {
        const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "5000", FAKE_CANCEL_FOLDED: "drop" });
        const back: { text: string; busy: boolean }[] = [];
        c.send = (ev: any) => void (ev.type === "draft" && back.push({ text: ev.text, busy: rt.busy }));
        try {
            expect(await until(() => rt.snapshot().turns.some((t) => t.blocks.some((b) => b.t === "tool" && b.id === "toolu_live")))).toBe(true);
            await engine.handle(c, "session.send", { id, text: "and then deploy", mode: "steer" });
            expect(await until(() => Boolean(sent("and then deploy")) && shown(rt).some((t) => t.steered), 2000)).toBe(true);
            await engine.handle(c, "session.interrupt", { id });
            expect(await until(() => !rt.busy)).toBe(true);
            // Handed back while the turn was still on: before anything else could be sent.
            expect(back).toEqual([{ text: "and then deploy", busy: true }]);
            await engine.handle(c, "session.send", { id, text: "next one" });
            expect(await until(() => Boolean(sent("next one")) && !rt.busy)).toBe(true);
            const said = rt.session.messages.map((m) => (m.role === "user" ? (m.meta?.display ?? (m.content[0] as { text?: string }).text) : m.role));
            expect(said).not.toContain("and then deploy");
            const at = said.indexOf("next one");
            const turns = rt.snapshot().turns;
            const next = turns.find((t) => t.prompt?.text === "next one")!;
            expect(turns.map((t) => t.prompt?.text)).toEqual(["start", "next one"]);
            expect([next.pos?.index, next.prompt?.index]).toEqual([at, at]);
            const steps = next.blocks.filter((b) => b.t === "text").map((b) => (b as { text: string }).text).join(" ");
            expect(steps).toContain("Took: next one");
            // Forked at it: the turn and its steps.
            const made = (await engine.handle(c, "session.fork", { id, index: next.prompt!.index, text: next.prompt!.text, turn: next.id })) as SessionSnapshot;
            expect(made.turns.find((t) => t.prompt?.text === "next one")!.blocks.some((b) => b.t === "text" && b.text.includes("Took: next one"))).toBe(true);
            await engine.stop();
            const { Engine } = await import("../src/server/engine");
            const reopened = new Engine();
            const other = { subs: new Set<string>(), send() {} };
            reopened.clients.add(other);
            try {
                const view = (await reopened.handle(other, "session.open", { id })) as SessionSnapshot;
                expect(view.turns.map((t) => t.prompt?.text)).toEqual(["start", "next one"]);
                expect(view.turns[1]!.blocks.some((b) => b.t === "text" && b.text.includes("Took: next one"))).toBe(true);
            } finally {
                await reopened.stop();
            }
            // The agent's guard for a hand-back after its run was never needed.
        } finally {
            await cleanup(engine);
        }
    }, 40_000);

    test("Esc whose interrupt is answered late though the turn stopped at once: the turn ends when the withdrawal does, not by the stop watchdog (no false 'didn't answer the stop'), the steer back first", async () => {
        const { stopTiming } = await import("../src/backends/cli");
        const was = stopTiming.interruptMs;
        stopTiming.interruptMs = 1000;
        const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "5000", FAKE_INTERRUPT_ANSWER_MS: "2500" });
        const back: { text: string; busy: boolean }[] = [];
        c.send = (ev: any) => void (ev.type === "draft" && back.push({ text: ev.text, busy: rt.busy }));
        try {
            expect(await until(() => rt.snapshot().turns.some((t) => t.blocks.some((b) => b.t === "tool" && b.id === "toolu_live")))).toBe(true);
            await engine.handle(c, "session.send", { id, text: "and then deploy", mode: "steer" });
            expect(await until(() => Boolean(sent("and then deploy")) && shown(rt).some((t) => t.steered), 2000)).toBe(true);
            await engine.handle(c, "session.interrupt", { id });
            expect(await until(() => !rt.busy)).toBe(true);
            expect(back).toEqual([{ text: "and then deploy", busy: true }]);
            const said = rt.snapshot().turns.flatMap((t) => t.blocks.flatMap((b) => (b.t === "notice" ? [b.text] : []))).join("\n");
            expect(said).not.toContain("didn't answer the stop");
            expect(rt.snapshot().turns.map((t) => [t.prompt?.text, t.status])).toEqual([["start", "aborted"]]);
        } finally {
            stopTiming.interruptMs = was;
            await cleanup(engine);
        }
    }, 30_000);

    test("its image comes back with it", async () => {
        const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "5000" });
        const back = drafts(c);
        const data = bigPng(4);
        try {
            expect(await until(() => rt.snapshot().turns.some((t) => t.blocks.some((b) => b.t === "tool" && b.id === "toolu_live")))).toBe(true);
            await engine.handle(c, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data }], mode: "steer" });
            expect(await until(() => Boolean(sent("look at this")) && !rt.snapshot().state.queued.length, 3000)).toBe(true);
            await engine.handle(c, "session.interrupt", { id });
            expect(await until(() => !rt.busy && back.length > 0)).toBe(true);
            expect(back[0]).toMatchObject({ text: "look at this", images: [{ mediaType: "image/png", data }], after: true });
            expect(rt.snapshot().turns.map((t) => t.prompt?.text)).toEqual(["start"]);
            expect(JSON.stringify(rt.session.messages)).not.toContain("look at this");
        } finally {
            await cleanup(engine);
        }
    }, 30_000);

    test("in all of these, the live layer handed each back itself, and the agent never got one after its run", () => {
        expect(logged()).toContain("steering withdrawn");
        expect(logged()).not.toContain("steer handed back after its run");
    });
});

/**
 * A PNG of random pixels, too big for the pipe to take at once: its write waits on Claude Code reading it (and a
 * moment more, JsonLinesProcess.send), time enough for its answer to come in before the write is known done.
 */
function bigPng(side = 1000): string {
    const crc = (b: Buffer) => Bun.hash.crc32(b) >>> 0;
    const chunk = (type: string, data: Buffer) => {
        const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const sum = Buffer.alloc(4);
        sum.writeUInt32BE(crc(body));
        return Buffer.concat([len, body, sum]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(side, 0);
    ihdr.writeUInt32BE(side, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const rows = Buffer.alloc(side * (side * 3 + 1));
    for (let i = 0; i < rows.length; i++) rows[i] = i % (side * 3 + 1) === 0 ? 0 : (Math.random() * 256) | 0;
    const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", Buffer.from(Bun.deflateSync(rows, { level: 0 }))), chunk("IEND", Buffer.alloc(0))]);
    return png.toString("base64");
}

describe("steering with an image", () => {
    for (const liveOff of [false, true]) {
        test(`${liveOff ? "a process per run" : "live"}: sent while the reply is written, it's in the history before what Claude Code says to it`, async () => {
            const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "50", FAKE_WRITE_MS: "5000" }, { liveOff });
            try {
                expect(await until(() => rt.snapshot().turns.some((t) => t.blocks.some((b) => b.t === "text" && b.text.startsWith("Counting:"))))).toBe(true);
                await engine.handle(c, "session.send", { id, text: "look at this", images: [{ mediaType: "image/png", data: bigPng() }], mode: "steer" });
                expect(await until(() => Boolean(sent("look at this")), 3000)).toBe(true);
                expect(sent("look at this").priority).toBe("now");
                expect(await until(() => !rt.busy, 6000)).toBe(true);
                const said = rt.session.messages.map((m) => `${m.role}: ${m.content.map((p: any) => p.text ?? `[${p.type}]`).join(" ")}`);
                const asked = said.findIndex((l) => l.startsWith("user: look at this"));
                const answered = said.findIndex((l) => l.startsWith("assistant:") && l.includes("Took: look at this"));
                expect(asked).toBeGreaterThan(0);
                expect(said[asked]).toContain("[image]");
                expect(answered).toBeGreaterThan(asked);
            } finally {
                await cleanup(engine);
            }
        }, 30_000);
    }
});

describe("a model that takes nothing mid-turn", () => {
    test("says so (ModelSummary.steers), and a message sent to steer waits for the turn's end, as queued", async () => {
        const caps = agentCli("claude-code")!.caps as { steering: string };
        const was = caps.steering;
        caps.steering = "none";
        const { engine, c, id, rt } = await claudeSession({ FAKE_TOOL_MS: "1500" });
        try {
            expect(rt.snapshot().state.model?.steers).toBe(false);
            expect(await until(() => rt.busy)).toBe(true);
            await engine.handle(c, "session.send", { id, text: "after you", mode: "steer" });
            expect(rt.snapshot().state.queuedModes).toEqual(["turn"]);
            expect(rt.snapshot().state.queuedWhy).toEqual(["Claude Code can't take messages in a running turn: this runs once it ends."]);
            const [queueId] = rt.snapshot().state.queueIds;
            await expect(engine.handle(c, "session.sendQueuedNow", { id, queueId })).rejects.toThrow(/can't take messages in a running turn/);
            // Not sent mid-turn: it's the next prompt, once the turn has ended.
            await Bun.sleep(500);
            expect(sent("after you")).toBeUndefined();
            expect(await until(() => !rt.busy && !rt.snapshot().state.queued.length && Boolean(sent("after you")))).toBe(true);
            expect(log().some((l) => l.midTurn)).toBe(false);
        } finally {
            caps.steering = was;
            await cleanup(engine);
        }
    }, 30_000);

    test("Claude Code and Codex can be steered: their models say nothing of it", async () => {
        const { modelSummary } = await import("../src/server/runtime");
        expect(modelSummary({ provider: "claude-code", id: "default" } as any).steers).toBeUndefined();
        expect(modelSummary({ provider: "codex", id: "gpt-test" } as any).steers).toBeUndefined();
        expect(modelSummary({ provider: "anthropic", id: "claude-test" } as any).steers).toBeUndefined();
    });
});
