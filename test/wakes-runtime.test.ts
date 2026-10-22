// Wakes in a GUI session (the real Engine and Runtime, the mock model): an
// idle session starts a turn of its own for them, shown as an event and not
// as a prompt; outside text in them attaches nothing; after an interrupt
// they wait for the user; and the Watching panel's stop button.

import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
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

// #282 review round 3 (D2, D3): what an adopted turn's CLI wasn't sent goes with its next prompt once, whatever
// becomes of the adopted turn, and is never part of the history (another model would be sent it twice).
describe("an adopted turn's unsent context (#282 review round 3)", () => {
    const TOKEN = "zebra-pancake-71";
    const NOTE = "Delegated task task-1 finished: r3-note-42.";
    const count = (s: string, sub: string) => s.split(sub).length - 1;

    /** A CLI backend: each turn says its session id (its place moves to the turn's end), then an adopted one does `onAdopt`. */
    function backend(turns: BackendTurn[], onAdopt: (t: BackendTurn) => Promise<any>) {
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
                t.session.sessionId("cli-session-1");
                if (t.adopt) return onAdopt(t);
                // A model's answer, as a backend streams it (what shows the prompt reached a model turn).
                t.sink.emit({ type: "text", text: "ok." });
                return { reason: "done" as const, text: "ok.", actions: [] };
            },
        };
    }

    async function setup(onAdopt: (t: BackendTurn) => Promise<any> = async () => ({ reason: "done", text: "Auth is mapped.", actions: [] }), settings?: Record<string, unknown>) {
        const s = await session();
        await s.rt.ready;
        // A turn on another model first: the CLI hasn't seen it.
        await s.engine.handle(s.c, "session.send", { id: s.id, text: `hello ${TOKEN}` });
        await until(() => s.rt.idle && s.rt.session.messages.some((m) => m.role === "assistant"));
        const realModel = s.rt.agent!.model;
        const realClient = s.rt.agent!.client;
        const turns: BackendTurn[] = [];
        s.rt.agent!.setModel(backendModel("fake-cli", "x"), backend(turns, onAdopt) as never);
        if (settings) {
            const o = (s.rt.agent as any).o;
            const orig = o.settings;
            o.settings = () => ({ ...orig(), ...settings });
        }
        s.rt.agent!.addReminder(NOTE);
        return { ...s, turns, realModel, realClient };
    }

    /** The prompts the CLI was sent (an adopted turn is sent nothing). */
    const sent = (turns: BackendTurn[]) => turns.filter((t) => !t.adopt).map((t) => t.prompt).join("\n");

    for (const how of ["throws", "throws an abort"] as const) {
        test(`an adopted turn that ${how} after the CLI said its session id: what it wasn't sent still goes with the next prompt, once (D2)`, async () => {
            const { engine, c, id, rt, turns } = await setup(async (t) => {
                if (how === "throws") throw new Error("host went away");
                await new Promise<void>((r) => (t.signal.aborted ? r() : t.signal.addEventListener("abort", () => r(), { once: true })));
                throw new DOMException("The operation was aborted.", "AbortError");
            });
            try {
                rt.adoptWake({ provider: "fake-cli", ref: "turn-8", label: "Background task finished: Map auth" });
                await until(() => turns.length === 1 && (how === "throws" ? rt.idle : rt.busy));
                if (how !== "throws") {
                    rt.interrupt();
                    await until(() => rt.idle);
                }
                await engine.handle(c, "session.send", { id, text: "and now?" });
                await until(() => turns.length === 2 && rt.idle);
                expect(count(sent(turns), TOKEN)).toBe(1);
                expect(count(sent(turns), NOTE)).toBe(1);
            } finally {
                await engine.stop();
            }
        });
    }

    test("two adopted wakes, then a prompt: the earlier turn goes to the CLI once, and the session keeps no copy of it (D3)", async () => {
        const { engine, c, id, rt, turns } = await setup();
        try {
            rt.adoptWake({ provider: "fake-cli", ref: "turn-8", label: "Background task finished: Map auth" });
            await until(() => turns.length === 1 && rt.idle);
            rt.adoptWake({ provider: "fake-cli", ref: "turn-9", label: "Background task finished: Write docs" });
            await until(() => turns.length === 2 && rt.idle);
            await engine.handle(c, "session.send", { id, text: "and now?" });
            await until(() => turns.length === 3 && rt.idle);
            expect(count(sent(turns), TOKEN)).toBe(1);
            expect(count(sent(turns), NOTE)).toBe(1);
            // The user's own message is the only copy in the history (no reminder carries the transcript).
            expect(rt.session.messages.filter((m) => m.role === "user" && JSON.stringify(m).includes(TOKEN)).map((m) => m.meta?.kind)).toEqual(["prompt"]);
            // Sent: nothing waits any more.
            expect(rt.session.backends.get("fake-cli")?.unsent).toBeUndefined();
        } finally {
            await engine.stop();
        }
    });

    test("after an adopted wake, back on an API model: its request has the earlier turn once (D3)", async () => {
        const { engine, c, id, rt, turns, realModel, realClient } = await setup();
        try {
            rt.adoptWake({ provider: "fake-cli", ref: "turn-8", label: "Background task finished: Map auth" });
            await until(() => turns.length === 1 && rt.idle);
            rt.agent!.setModel(realModel, realClient);
            const before = mock.bodies.length;
            await engine.handle(c, "session.send", { id, text: "and now, api?" });
            await until(() => rt.idle && mock.bodies.length > before);
            expect(count(lastTurnRequest(), TOKEN)).toBe(1);
        } finally {
            await engine.stop();
        }
    });

    test("an adopted wake a Stop hook keeps going: the hook's round carries what the CLI wasn't sent, once", async () => {
        const flag = join(tempDir("r3-flag-"), "once");
        const { engine, c, id, rt, turns } = await setup(undefined, { hooks: { Stop: [{ command: `[ -f '${flag}' ] || { touch '${flag}'; echo 'keep going r3' >&2; exit 2; }` }] } });
        try {
            rt.adoptWake({ provider: "fake-cli", ref: "turn-8", label: "Background task finished: Map auth" });
            await until(() => turns.length >= 2 && rt.idle);
            await engine.handle(c, "session.send", { id, text: "and now?" });
            await until(() => turns.length === 3 && rt.idle);
            expect(turns[0]!.adopt).toBe("turn-8");
            expect(turns[1]!.prompt).toContain("keep going r3");
            expect(turns[1]!.prompt).toContain(TOKEN);
            expect(count(sent(turns), TOKEN)).toBe(1);
            expect(count(sent(turns), NOTE)).toBe(1);
        } finally {
            await engine.stop();
        }
    });
});

// #282 review round 4 (Astra 3 and 4, Bug E): what an adopted turn's CLI wasn't sent moves with every move of its
// place, in the same write, and is taken only by a prompt the CLI got.
describe("an adopted turn's unsent context: atomic with its place, taken only on delivery (#282 review round 4)", () => {
    const TOKEN = "walrus-teacup-93";
    const count = (s: string, sub: string) => s.split(sub).length - 1;
    /** `local`: a command the CLI answers itself, with no model turn (Codex's /goal status): a notice, and "done". */
    type Plan = { announce?: string | false; result?: any; throwAfter?: boolean; hold?: Promise<void>; local?: boolean };

    /** A CLI backend whose next turns do what `plans` say (by default: say its session id "cli-1", answer). */
    function backend(turns: BackendTurn[], plans: Plan[]) {
        return {
            agentBackend: true as const,
            adoptsTurns: true,
            setMode() {},
            listModels: async () => [],
            stream: async () => {
                throw new Error("not used");
            },
            compact: async (t: any) => {
                t.session.sessionId("cli-compacted");
                return { reason: "done" as const, text: "", actions: [] };
            },
            runTurn: async (t: BackendTurn) => {
                turns.push(t);
                const p = plans.shift() ?? {};
                if (p.announce !== false) t.session.sessionId(p.announce ?? "cli-1");
                if (p.hold) await p.hold;
                if (p.throwAfter) throw new Error("host went away");
                if (p.local) {
                    t.sink.emit({ type: "notice", level: "info", message: "No goal set. /goal <condition> sets one." });
                    return { reason: "done" as const, text: "", actions: [] };
                }
                if (p.result) return p.result;
                const answer = t.adopt ? "Auth is mapped." : "ok.";
                // A model's answer, as a backend streams it (what shows the prompt reached a model turn).
                t.sink.emit({ type: "text", text: answer });
                return { reason: "done" as const, text: answer, actions: [] };
            },
        };
    }

    /** The CLI's session has seen "first"; then another model's turn it hasn't (with TOKEN); then back on the CLI. */
    async function setup(plans: Plan[]) {
        const s = await session();
        await s.rt.ready;
        const realModel = s.rt.agent!.model;
        const realClient = s.rt.agent!.client;
        const turns: BackendTurn[] = [];
        const cli = backend(turns, plans);
        s.rt.agent!.setModel(backendModel("fake-cli", "x"), cli as never);
        await s.engine.handle(s.c, "session.send", { id: s.id, text: "first" });
        await until(() => turns.length === 1 && s.rt.idle);
        s.rt.agent!.setModel(realModel, realClient);
        await s.engine.handle(s.c, "session.send", { id: s.id, text: `hello ${TOKEN}` });
        await until(() => s.rt.idle && s.rt.session.messages.filter((m) => m.role === "assistant").length >= 2);
        s.rt.agent!.setModel(backendModel("fake-cli", "x"), cli as never);
        return { ...s, turns, realModel, realClient };
    }

    const send = async (s: Awaited<ReturnType<typeof setup>>, text: string, n: number) => {
        await s.engine.handle(s.c, "session.send", { id: s.id, text });
        await until(() => s.turns.length === n && s.rt.idle);
        return s.turns[n - 1]!.prompt;
    };
    const adopt = async (s: Awaited<ReturnType<typeof setup>>, n: number) => {
        s.rt.adoptWake({ provider: "fake-cli", ref: `turn-${n}`, label: "Background task finished: Map auth" });
        await until(() => s.turns.length === n && s.rt.idle);
    };

    test("an adopted turn that ends well without saying its session id again: the next prompt still carries what it wasn't sent (Astra 3)", async () => {
        const s = await setup([{}, { announce: false }]);
        try {
            await adopt(s, 2);
            expect(s.turns[1]!.adopt).toBe("turn-2");
            expect(count(await send(s, "and now?", 3), TOKEN)).toBe(1);
        } finally {
            await s.engine.stop();
        }
    });

    test("an adopted turn that said its session id and is still running: the log line that moved its place carries what it wasn't sent (Astra 3, after a restart)", async () => {
        let release!: () => void;
        const s = await setup([{}, { hold: new Promise<void>((r) => (release = r)) }]);
        try {
            s.rt.adoptWake({ provider: "fake-cli", ref: "turn-2", label: "Background task finished: Map auth" });
            await until(() => s.turns.length === 2 && s.rt.busy);
            const lines = readFileSync(s.rt.session.path, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
            const last = lines.filter((l) => l.t === "backend" && l.provider === "fake-cli").at(-1);
            expect(last.synced).toBe(s.rt.session.messages.length);
            expect(count(last.unsent ?? "", TOKEN)).toBe(1);
            release();
            await until(() => s.rt.idle);
        } finally {
            release?.();
            await s.engine.stop();
        }
    });

    test("a prompt that carried it, but the CLI failed before taking it (an error with nothing done): the retry carries it again (Astra 4)", async () => {
        const s = await setup([{}, {}, { announce: false, result: { reason: "error", text: "", actions: [], error: "Not logged in" } }]);
        try {
            await adopt(s, 2);
            expect(count(await send(s, "and now?", 3), TOKEN)).toBe(1);
            expect(count(await send(s, "again?", 4), TOKEN)).toBe(1);
            // Taken by the one the CLI answered: not sent a third time.
            expect(count(await send(s, "and after?", 5), TOKEN)).toBe(0);
        } finally {
            await s.engine.stop();
        }
    });

    test("/goal status, answered by the CLI itself with no model turn: what was waiting goes with the next prompt (#282 review round 5, #2)", async () => {
        const s = await setup([{}, {}, { local: true }]);
        try {
            await adopt(s, 2);
            // As the runtime sends /goal to a CLI that keeps goals itself (Codex): the command, as typed.
            await (s.rt as any).startTurn("/goal status", { display: "/goal status", kind: "command" });
            await until(() => s.turns.length === 3 && s.rt.idle);
            expect(s.turns[2]!.prompt).toBe("/goal status");
            expect(s.rt.session.backends.get("fake-cli")?.unsent).toContain(TOKEN);
            expect(count(await send(s, "continue", 4), TOKEN)).toBe(1);
            expect(s.rt.session.backends.get("fake-cli")?.unsent).toBeUndefined();
        } finally {
            await s.engine.stop();
        }
    });

    test("shared with a fork, the next turn says its forked session id and then fails: the retry carries it (Astra 4)", async () => {
        const s = await setup([{}, {}, { announce: "cli-fork-2", throwAfter: true }]);
        try {
            await adopt(s, 2);
            expect(s.rt.session.markBackendForked("fake-cli")).toBe(true);
            await send(s, "and now?", 3);
            expect(s.rt.session.backends.get("fake-cli")?.id).toBe("cli-fork-2");
            expect(count(await send(s, "again?", 4), TOKEN)).toBe(1);
        } finally {
            await s.engine.stop();
        }
    });

    test("shared with a fork, then compacted (a new session id): the next prompt carries it, once (Bug E)", async () => {
        const s = await setup([{}, {}]);
        try {
            await adopt(s, 2);
            expect(s.rt.session.markBackendForked("fake-cli")).toBe(true);
            await s.rt.agent!.compact({ auto: false, signal: new AbortController().signal });
            expect(s.rt.session.backends.get("fake-cli")?.id).toBe("cli-compacted");
            expect(count(await send(s, "and now?", 3), TOKEN)).toBe(1);
        } finally {
            await s.engine.stop();
        }
    });
});
