// A CLI backend's turn ended before it took a message with images or PDFs (a prompt's own, held by the backend:
// TurnSink.undelivered). They go with the words: with the next prompt, or a Stop hook's "keep going" one (#304).

import { afterAll, expect, test } from "bun:test";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const trust = await import("../src/config/trust");
const { backendModel } = await import("../src/backends/types");
afterAll(() => iso.cleanup());

type Turn = import("../src/backends/types").BackendTurn;
const image = { type: "image" as const, mediaType: "image/png", data: "iVBORw0KGgo=" };
const pdf = { type: "file" as const, kind: "pdf" as const, name: "spec.pdf", size: 8, mediaType: "application/pdf", data: "JVBERi0x" };

/** An agent on a scripted CLI whose first turn ends before it took a message with an image and a PDF. */
function setup(settings: Record<string, unknown> = {}) {
    const cwd = tempDir("undelivered-media-");
    trust.trustForSession(cwd);
    const turns: Turn[] = [];
    const cli = {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        runTurn: async (t: Turn) => {
            turns.push(t);
            t.session.sessionId("cli-1");
            if (turns.length === 1) t.sink.undelivered?.([{ text: "look at these", images: [image], documents: [pdf] }]);
            t.sink.emit({ type: "text", text: "ok." });
            return { reason: "done" as const, text: "ok.", actions: [] };
        },
    };
    const agent = new Agent({
        session: Session.create(cwd, { persist: false }),
        // One that reads PDFs, as Claude Code does.
        model: { ...backendModel("fake-cli", "x"), supportsPdf: true },
        client: cli as never,
        settings: () => settings as never,
        checker: new PermissionChecker(() => settings as never, cwd),
        tools: [],
        mode: { get: () => "bypassPermissions", set: () => {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() } as never,
        host: { emit: () => {}, ui: {} },
    } as never);
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    return { cwd, turns, run };
}

test("the next prompt carries the words, the image and the PDF, once", async () => {
    const s = setup();
    expect(await s.run("first")).toBe("done");
    expect(await s.run("next")).toBe("done");
    expect(s.turns[1]!.prompt).toContain("look at these");
    expect(s.turns[1]!.images).toEqual([image]);
    expect(s.turns[1]!.documents).toEqual([pdf]);
    expect(await s.run("after")).toBe("done");
    expect(s.turns[2]!.images ?? []).toEqual([]);
    expect(s.turns[2]!.documents ?? []).toEqual([]);
});

test("a Stop hook's keep-going prompt carries them, once", async () => {
    const flag = join(tempDir("undelivered-hook-"), "ran");
    const s = setup({ hooks: { Stop: [{ command: `[ -e '${flag}' ] && exit 0; touch '${flag}'; echo 'keep going' >&2; exit 2` }] } });
    expect(await s.run("first")).toBe("done");
    expect(s.turns.length).toBe(2);
    expect(s.turns[1]!.prompt).toContain("keep going");
    expect(s.turns[1]!.prompt).toContain("look at these");
    expect(s.turns[1]!.images).toEqual([image]);
    expect(s.turns[1]!.documents).toEqual([pdf]);
    expect(await s.run("next")).toBe("done");
    expect(s.turns[2]!.images ?? []).toEqual([]);
    expect(s.turns[2]!.documents ?? []).toEqual([]);
});

/** An agent on a scripted CLI whose first turn drains each of `drained` in turn, then hands back those `back` picks. */
function steering(drained: string[][], back: (taken: import("../src/backends/types").SteerMessage[][]) => import("../src/backends/types").SteerMessage[], restores = true) {
    const cwd = tempDir("unsteered-");
    trust.trustForSession(cwd);
    const turns: Turn[] = [];
    const handed: string[][][] = [];
    const cli = {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        runTurn: async (t: Turn) => {
            turns.push(t);
            t.session.sessionId("cli-1");
            if (turns.length === 1) {
                const taken = [];
                for (let i = 0; i < drained.length + 1; i++) taken.push(await t.sink.drainQueued());
                t.sink.undelivered?.(back(taken.filter((x) => x.length)));
            }
            return { reason: "done" as const, text: "ok.", actions: [] };
        },
    };
    const session = Session.create(cwd, { persist: false });
    const settings = {};
    const agent = new Agent({
        session,
        model: backendModel("fake-cli", "x"),
        client: cli as never,
        settings: () => settings as never,
        checker: new PermissionChecker(() => settings as never, cwd),
        tools: [],
        mode: { get: () => "bypassPermissions", set: () => {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() } as never,
        host: { emit: () => {}, ui: {}, drainQueued: () => drained.shift() ?? [], unsteered: (b: { id: number; texts: string[] }[]) => (handed.push(b.map((x) => x.texts)), restores ? b.map((x) => x.id) : []) },
    } as never);
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    return { session, turns, handed, run };
}

test("two handed back with the same words are two: both leave the history, and nothing else does", async () => {
    const s = steering([["same words"], ["same words"]], (taken) => taken.flat());
    expect(await s.run("first")).toBe("done");
    expect(s.handed).toEqual([[["same words"], ["same words"]]]);
    const said = s.session.messages.map((m) => m.content.map((p: any) => p.text ?? "").join(""));
    expect(said.filter((t) => t.includes("same words"))).toEqual([]);
    expect(said[0]).toBe("first");
    expect(said.at(-1)).toContain("ok.");
});

test("one handed back with the same words as one taken: only that one leaves", async () => {
    const s = steering([["same words"], ["same words"]], (taken) => taken[1]!);
    expect(await s.run("first")).toBe("done");
    expect(s.handed).toEqual([[["same words"]]]);
    const said = s.session.messages.map((m) => m.content.map((p: any) => p.text ?? "").join(""));
    expect(said.filter((t) => t.includes("same words"))).toHaveLength(1);
});

test("one dropped with a later one kept after it (stored apart): not taken out (what's after would move), the note carries it; all dropped, all go", async () => {
    const s = steering([["A one"], ["B one"]], (taken) => taken[0]!);
    expect(await s.run("first")).toBe("done");
    expect(s.handed).toEqual([]);
    const said = JSON.stringify(s.session.messages);
    expect(said).toContain("A one");
    expect(said).toContain("B one");
    expect(await s.run("next")).toBe("done");
    expect(s.turns[1]!.prompt).toContain("your turn ended before it reached you:\nA one");
    const all = steering([["A one"], ["B one"]], (taken) => taken.flat());
    expect(await all.run("first")).toBe("done");
    expect(all.handed).toEqual([[["A one"], ["B one"]]]);
    expect(JSON.stringify(all.session.messages)).not.toContain(" one");
});

test("one the host couldn't hand back (none of its ids came back) stays in the history, and the next prompt carries it: never lost", async () => {
    const s = steering([["left one"]], (taken) => taken.flat(), false);
    expect(await s.run("first")).toBe("done");
    expect(s.handed).toEqual([[["left one"]]]);
    expect(JSON.stringify(s.session.messages)).toContain("left one");
    expect(await s.run("next")).toBe("done");
    expect(s.turns[1]!.prompt).toContain("your turn ended before it reached you:\nleft one");
});

test("with a host that takes them back (AgentHost.unsteered): the one never taken is handed back and leaves the history; the one taken stays; nothing is sent again", async () => {
    const cwd = tempDir("unsteered-");
    trust.trustForSession(cwd);
    const turns: Turn[] = [];
    const drained = [["taken one"], ["left one"]];
    const handed: string[][][] = [];
    const cli = {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        runTurn: async (t: Turn) => {
            turns.push(t);
            t.session.sessionId("cli-1");
            if (turns.length === 1) {
                await t.sink.drainQueued();
                const left = await t.sink.drainQueued();
                t.sink.undelivered?.(left);
            }
            return { reason: "done" as const, text: "ok.", actions: [] };
        },
    };
    const session = Session.create(cwd, { persist: false });
    const settings = {};
    const agent = new Agent({
        session,
        model: backendModel("fake-cli", "x"),
        client: cli as never,
        settings: () => settings as never,
        checker: new PermissionChecker(() => settings as never, cwd),
        tools: [],
        mode: { get: () => "bypassPermissions", set: () => {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() } as never,
        host: { emit: () => {}, ui: {}, drainQueued: () => drained.shift() ?? [], unsteered: (b: { id: number; texts: string[] }[]) => (handed.push(b.map((x) => x.texts)), b.map((x) => x.id)) },
    } as never);
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    expect(await run("first")).toBe("done");
    expect(handed).toEqual([[["left one"]]]);
    const said = JSON.stringify(session.messages);
    expect(said).toContain("taken one");
    expect(said).not.toContain("left one");
    expect(await run("next")).toBe("done");
    expect(turns[1]!.prompt).not.toContain("left one");
    expect(JSON.stringify(session.messages)).not.toContain("ended before it reached you");
});

test("handed back by a turn whose run is over, as the next run starts: never withdrawn (its bubble stays); the note carries it", async () => {
    const cwd = tempDir("unsteered-late-");
    trust.trustForSession(cwd);
    const turns: Turn[] = [];
    const handed: string[][] = [];
    let first: { sink: Turn["sink"]; left: import("../src/backends/types").SteerMessage[] } | undefined;
    const cli = {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        runTurn: async (t: Turn) => {
            turns.push(t);
            t.session.sessionId("cli-1");
            if (turns.length === 1) first = { sink: t.sink, left: await t.sink.drainQueued() };
            return { reason: "done" as const, text: "ok.", actions: [] };
        },
    };
    const session = Session.create(cwd, { persist: false });
    const settings = {};
    const drained = [["left one"]];
    const agent = new Agent({
        session,
        model: backendModel("fake-cli", "x"),
        client: cli as never,
        settings: () => settings as never,
        checker: new PermissionChecker(() => settings as never, cwd),
        tools: [],
        mode: { get: () => "bypassPermissions", set: () => {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() } as never,
        host: { emit: () => {}, ui: {}, drainQueued: () => drained.shift() ?? [], unsteered: (b: { id: number; texts: string[] }[]) => (handed.push(...b.map((x) => x.texts)), b.map((x) => x.id)) },
    } as never);
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    expect(await run("first")).toBe("done");
    expect(first!.left.map((m) => m.text)).toEqual(["left one"]);
    // The next run has started (running again), its backend turn not yet: the old turn's callback comes now.
    const next = run("next");
    first!.sink.undelivered?.(first!.left);
    expect(await next).toBe("done");
    expect(handed).toEqual([]);
    expect(JSON.stringify(session.messages)).toContain("left one");
});
