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
