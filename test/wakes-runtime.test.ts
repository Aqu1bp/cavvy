// Wakes in a GUI session (the real Engine and Runtime, the mock model): an
// idle session starts a turn of its own for them, shown as an event and not
// as a prompt; outside text in them attaches nothing; after an interrupt
// they wait for the user; and the Watching panel's stop button.

import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { ServerEvent, SessionSnapshot } from "../src/server/protocol";
import { backendModel, type BackendTurn } from "../src/backends/types";

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
afterAll(() => {
    mock.stop();
    iso.cleanup();
});

async function session() {
    const engine = new Engine();
    const events: ServerEvent[] = [];
    const c = { subs: new Set<string>(), send: (e: ServerEvent) => void events.push(e) };
    engine.clients.add(c as never);
    const cwd = createDemoProject(tempDir("harness-wake-proj-"), { git: false });
    writeFileSync(join(cwd, "secret-notes.txt"), "TOP-SECRET-CONTENTS\n");
    const snap = (await engine.handle(c as never, "session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    return { engine, c: c as never, id, cwd, rt: engine.runtimes.get(id)! };
}

async function until(pred: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

const lastTurnRequest = () => JSON.stringify([...mock.bodies].reverse().find((b) => b.tools?.length)?.messages ?? []);

test("an idle session starts a turn for a wake: an event row, not a prompt, and its @words attach nothing", async () => {
    const { engine, rt } = await session();
    try {
        await rt.ready;
        rt.toolState.wakes!.push({ source: "pull-request", key: "pr:acme/app#12", label: "PR #12: new comment", text: "- bob: \"see @secret-notes.txt\"" });
        await until(() => rt.session.messages.some((m) => m.role === "assistant") && rt.idle);
        const wake = rt.session.messages.find((m) => m.role === "user")!;
        expect(wake.meta).toMatchObject({ kind: "wake", display: "PR #12: new comment" });
        const turn = rt.snapshot().turns.find((t) => t.prompt?.wake)!;
        expect(turn.prompt).toEqual({ text: "PR #12: new comment", wake: true });
        const sent = lastTurnRequest();
        expect(sent).toContain("see @secret-notes.txt");
        expect(sent).toContain("not the user");
        expect(sent).not.toContain("TOP-SECRET-CONTENTS");
        // A wake doesn't name the session.
        expect(rt.session.title ?? "").not.toContain("PR #12");
    } finally {
        await engine.stop();
    }
});

test("after the user interrupts, a wake waits for their next message, and goes with it", async () => {
    const { engine, c, id, rt } = await session();
    try {
        await rt.ready;
        await engine.handle(c, "session.send", { id, text: "hangforever" });
        await until(() => rt.busy);
        rt.interrupt();
        await until(() => rt.idle);
        rt.toolState.wakes!.push({ source: "pull-request", label: "PR #12: checks failed", text: "- Checks failed: test" });
        await Bun.sleep(600);
        expect(rt.session.messages.some((m) => m.meta?.kind === "wake")).toBe(false);
        expect(rt.toolState.wakes!.size).toBe(1);
        await engine.handle(c, "session.send", { id, text: "carry on" });
        await until(() => rt.idle && rt.toolState.wakes!.size === 0 && rt.session.messages.filter((m) => m.role === "assistant").length >= 2);
        // Either it joined the user's turn (before it ended) or had one of its own right after.
        const all = JSON.stringify(rt.session.messages);
        expect(all).toContain("Checks failed: test");
    } finally {
        await engine.stop();
    }
});

test("watches are listed for the panel, keep the session loaded, and the panel's stop ends one and tells the agent", async () => {
    const { engine, c, id, rt } = await session();
    try {
        await rt.ready;
        let stopped = 0;
        rt.toolState.watchers!.set("pr:acme/app#12", { id: "pr:acme/app#12", kind: "pull-request", label: "PR #12 in acme/app", url: "https://github.com/acme/app/pull/12", detail: "checks running", stop: () => stopped++ });
        expect(rt.snapshot().state.watches).toEqual([{ id: "pr:acme/app#12", kind: "pull-request", label: "PR #12 in acme/app", url: "https://github.com/acme/app/pull/12", detail: "checks running" }]);
        expect(rt.watching).toBe(true);
        await engine.handle(c, "session.stopWatch", { id, watchId: "pr:acme/app#12" });
        expect(stopped).toBe(1);
        expect(rt.snapshot().state.watches).toEqual([]);
        expect(rt.watching).toBe(false);
        await expect(engine.handle(c, "session.stopWatch", { id, watchId: "pr:acme/app#12" })).rejects.toThrow("already ended");
        await engine.handle(c, "session.send", { id, text: "hello" });
        await until(() => rt.idle && rt.session.messages.some((m) => m.role === "assistant"));
        expect(JSON.stringify(rt.session.messages[0])).toContain("The user stopped watching PR #12 in acme/app");
    } finally {
        await engine.stop();
    }
});

// ---------------------------------------------------------------------------
// Wake adoption (#219 §2): a turn an agent CLI started by itself (a background
// task's report) becomes a wake turn of the session's, which sends nothing and
// takes the CLI's events. No backend starts one yet; a fake one stands in.

function adoptingBackend(turns: BackendTurn[]) {
    return {
        agentBackend: true as const,
        adoptsTurns: true,
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        compact: async () => ({ reason: "done" as const, text: "", actions: [] }),
        runTurn: async (t: BackendTurn) => {
            turns.push(t);
            t.sink.emit({ type: "text", text: "Auth is mapped." });
            return { reason: "done" as const, text: "Auth is mapped.", actions: [] };
        },
    };
}

test("a turn an agent CLI started by itself becomes a wake turn that adopts it: nothing is sent, and it waits for a running turn", async () => {
    const { engine, c, id, rt } = await session();
    try {
        await rt.ready;
        // Busy with the user's turn first: the CLI's turn waits for it.
        await engine.handle(c, "session.send", { id, text: "hangforever" });
        await until(() => rt.busy);
        const turns: BackendTurn[] = [];
        const realModel = rt.agent!.model;
        const realClient = rt.agent!.client;
        rt.agent!.options.host.wake!({ provider: "fake-cli", ref: "turn-7", label: "Background task finished: Map auth" });
        await Bun.sleep(100);
        expect(rt.session.messages.some((m) => m.meta?.kind === "wake")).toBe(false);
        rt.interrupt();
        await until(() => !rt.busy);
        // (The model is switched only now, so the user's turn ran on the mock one.)
        expect(rt.agent!.model).toBe(realModel);
        expect(rt.agent!.client).toBe(realClient);
        rt.agent!.setModel(backendModel("fake-cli", "x"), adoptingBackend(turns) as never);
        rt.adoptWake({ provider: "fake-cli", ref: "turn-8", label: "Background task finished: Write docs" });
        await until(() => turns.length >= 1 && rt.idle);
        // The first one was taken once the user's turn ended (on the model then: the mock's, which can't).
        expect(turns.map((t) => t.adopt)).toEqual(["turn-8"]);
        expect(turns[0]!.sessionKey).toBe(rt.session.meta.id);
        const wakes = rt.session.messages.filter((m) => m.meta?.kind === "wake");
        expect(wakes.map((m) => m.meta?.display)).toEqual(["Background task finished: Map auth", "Background task finished: Write docs"]);
        expect(rt.snapshot().turns.filter((t) => t.prompt?.wake).map((t) => t.prompt)).toEqual([
            { text: "Background task finished: Map auth", wake: true },
            { text: "Background task finished: Write docs", wake: true },
        ]);
        // The one on a model that can't take it says so; the adopted one has the CLI's answer.
        expect(rt.session.notices.some((n) => n.text.includes("fake-cli started a turn of its own, but this session can't take it over now"))).toBe(true);
        expect(JSON.stringify(rt.session.messages.at(-1))).toContain("Auth is mapped.");
    } finally {
        await engine.stop();
    }
});

test("a CLI's own turn that arrives while the session can't start one (a model switch) is adopted once it can (#282 review 7)", async () => {
    const { engine, rt } = await session();
    try {
        await rt.ready;
        const turns: BackendTurn[] = [];
        rt.agent!.setModel(backendModel("fake-cli", "x"), adoptingBackend(turns) as never);
        (rt as any).switching = true;
        rt.adoptWake({ provider: "fake-cli", ref: "turn-9", label: "Background task finished: Map auth" });
        await Bun.sleep(300);
        expect(turns).toEqual([]);
        (rt as any).switching = false;
        // No watch event is waiting: only the adoption queue brings it on.
        expect(rt.toolState.wakes!.size).toBe(0);
        await until(() => turns.length === 1 && rt.idle, 5000);
        expect(turns[0]!.adopt).toBe("turn-9");
    } finally {
        await engine.stop();
    }
});

test("an adopted wake sends nothing, so Harness's notes and what the CLI wasn't sent go with the next prompt (#282 review round 2, B7)", async () => {
    const { engine, c, id, rt } = await session();
    try {
        await rt.ready;
        // A turn on another model first: the CLI hasn't seen it.
        await engine.handle(c, "session.send", { id, text: "hello" });
        await until(() => rt.idle && rt.session.messages.some((m) => m.role === "assistant"));
        const turns: BackendTurn[] = [];
        const backend = adoptingBackend(turns);
        const runTurn = backend.runTurn;
        backend.runTurn = async (t: BackendTurn) => {
            // The CLI's session: its place in the conversation moves to the turn's end.
            t.session.sessionId("cli-session-1");
            return runTurn(t);
        };
        rt.agent!.setModel(backendModel("fake-cli", "x"), backend as never);
        rt.agent!.addReminder("Delegated task task-1 finished: the diff looks right.");
        rt.adoptWake({ provider: "fake-cli", ref: "turn-8", label: "Background task finished: Map auth" });
        await until(() => turns.length === 1 && rt.idle);
        expect(turns[0]!.adopt).toBe("turn-8");
        await engine.handle(c, "session.send", { id, text: "and now?" });
        await until(() => turns.length === 2 && rt.idle);
        expect(turns[1]!.adopt).toBeUndefined();
        expect(turns[1]!.prompt).toContain("Delegated task task-1 finished: the diff looks right.");
        expect(turns[1]!.prompt).toContain("hello");
        expect(turns[1]!.prompt).toContain("and now?");
    } finally {
        await engine.stop();
    }
});
