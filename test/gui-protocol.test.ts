// The pure parts of the GUI server: the shared timeline reducer (the GUI runs
// the same code), the history replay, diffs, cross-project session listing,
// and merging the login shell's PATH.

import { afterAll, describe, expect, test } from "bun:test";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { applyOp, coalesce, tail, wireReplacer, PROGRESS_LIMIT } = await import("../src/server/timeline");
const { fileDiff, trimInput, truncateText } = await import("../src/server/diffs");
const { replay, UiLog } = await import("../src/server/history");
const { mergePath } = await import("../src/server/login-env");
const { Session, listAllSessions, findSessionAnywhere } = await import("../src/agent/session");
const { Engine } = await import("../src/server/engine");
import type { SessionState, Turn } from "../src/server/protocol";
import type { Message } from "../src/providers/types";

afterAll(() => iso.cleanup());

function view() {
    return { state: { id: "s", busy: false, queued: [] } as unknown as SessionState, turns: [] as Turn[] };
}

describe("timeline ops", () => {
    test("append, patch and remove build a turn", () => {
        const v = view();
        applyOp(v, { op: "turn", turn: { id: "t1", blocks: [], status: "running" } });
        applyOp(v, { op: "block", turnId: "t1", block: { t: "text", id: "b1", text: "" } });
        applyOp(v, { op: "append", turnId: "t1", blockId: "b1", field: "text", text: "Hel" });
        applyOp(v, { op: "append", turnId: "t1", blockId: "b1", field: "text", text: "lo" });
        applyOp(v, { op: "block", turnId: "t1", block: { t: "tool", id: "c1", name: "Bash", title: "Bash(ls)", status: "running" } });
        applyOp(v, { op: "block.patch", turnId: "t1", blockId: "c1", patch: { status: "ok", summary: "done" } });
        applyOp(v, { op: "turn.patch", turnId: "t1", patch: { status: "done" } });
        expect(v.turns[0]!.blocks).toEqual([
            { t: "text", id: "b1", text: "Hello" },
            { t: "tool", id: "c1", name: "Bash", title: "Bash(ls)", status: "ok", summary: "done" },
        ]);
        applyOp(v, { op: "block.remove", turnId: "t1", blockId: "b1" });
        expect(v.turns[0]!.blocks.map((b) => b.id)).toEqual(["c1"]);
        expect(v.turns[0]!.status).toBe("done");
    });

    test("null on the wire clears a field (JSON has no undefined)", () => {
        const v = view();
        applyOp(v, { op: "state", patch: { activity: { label: "Thinking", since: 1 } } });
        const wire = JSON.parse(JSON.stringify({ op: "state", patch: { activity: undefined } }, wireReplacer));
        expect(wire.patch).toEqual({ activity: null });
        applyOp(v, wire);
        expect(v.state.activity).toBeUndefined();
        expect("activity" in v.state).toBe(true);
    });

    test("live output keeps only its tail", () => {
        const v = view();
        applyOp(v, { op: "turn", turn: { id: "t", blocks: [{ t: "tool", id: "c", name: "Bash", title: "Bash", status: "running" }], status: "running" } });
        const line = "x".repeat(99) + "\n";
        for (let i = 0; i < 300; i++) applyOp(v, { op: "append", turnId: "t", blockId: "c", field: "progress", text: line });
        const p = (v.turns[0]!.blocks[0] as { progress: string }).progress;
        expect(p.length).toBeLessThanOrEqual(PROGRESS_LIMIT);
        expect(p.startsWith("x")).toBe(true);
        expect(tail("abc\ndef", 4)).toBe("def");
    });

    test("bursts of tokens coalesce into one op", () => {
        const ops = coalesce([
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "a" },
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "b" },
            { op: "state", patch: { busy: true } },
            { op: "state", patch: { cost: 1 } },
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "c" },
        ]);
        expect(ops).toEqual([
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "ab" },
            { op: "state", patch: { busy: true, cost: 1 } },
            { op: "append", turnId: "t", blockId: "b", field: "text", text: "c" },
        ]);
    });
});

describe("diffs", () => {
    test("hunks with line numbers and stats", () => {
        const d = fileDiff("a.ts", "one\ntwo\nthree\n", "one\nTWO\nthree\nfour\n");
        expect(d.status).toBe("modified");
        expect([d.added, d.removed]).toEqual([2, 1]);
        expect(d.hunks[0]!.lines.map((l) => `${l.t}:${l.a ?? ""}:${l.b ?? ""}:${l.text}`)).toEqual(["ctx:1:1:one", "del:2::two", "add::2:TWO", "ctx:3:3:three", "add::4:four"]);
        expect(fileDiff("n.ts", null, "x\n").status).toBe("added");
        expect(fileDiff("n.ts", "x\n", null).status).toBe("deleted");
    });

    test("big diffs are cut, with a note", () => {
        const before = Array.from({ length: 5000 }, (_, i) => `line ${i}`).join("\n");
        const after = before.replace(/line (\d*)0\b/g, "LINE $10");
        const d = fileDiff("big.txt", before, after, { maxLines: 100 });
        expect(d.truncated).toBe(true);
        expect(d.hunks.reduce((n, h) => n + h.lines.length, 0)).toBeLessThanOrEqual(100);
        expect(fileDiff("huge", "a".repeat(3_000_000), "b").note).toBe("Too large to show");
    });

    test("long tool inputs are trimmed for display", () => {
        const t = trimInput({ content: "x".repeat(10_000), path: "a" })!;
        expect(String(t.content).length).toBeLessThan(4200);
        expect(t.path).toBe("a");
        expect(truncateText("abcdef", 10)).toEqual({ text: "abcdef", truncated: false });
        expect(truncateText("x".repeat(100), 20).truncated).toBe(true);
    });
});

describe("replay", () => {
    const user = (text: string, kind: "prompt" | "tool_results" | "interrupt" = "prompt", extra: Partial<Message> = {}): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind }, ...extra }) as Message;

    test("prompts, text, tool calls with results, and interrupts", () => {
        const segs = [
            {
                messages: [
                    user("fix it"),
                    { role: "assistant", provider: "p", model: "m", content: [{ type: "text", text: "Looking." }, { type: "tool_call", id: "c1", name: "Read", input: { file_path: "a.ts" } }] },
                    { role: "user", content: [{ type: "tool_result", toolCallId: "c1", toolName: "Read", content: "     1\tx" }], meta: { kind: "tool_results" } },
                    { role: "assistant", provider: "p", model: "m", content: [{ type: "tool_call", id: "c2", name: "Edit", input: { file_path: "a.ts", old_string: "x", new_string: "y" } }] },
                    { role: "user", content: [{ type: "tool_result", toolCallId: "c2", toolName: "Edit", content: "The user declined this tool call." , isError: true }], meta: { kind: "tool_results" } },
                    user("[Request interrupted by user]", "interrupt"),
                ] as Message[],
            },
        ];
        let n = 0;
        const turns = replay({ segments: segs, current: segs[0]!.messages, ui: new UiLog(join(tempDir(), "x.jsonl"), "x", false), meta: (c) => ({ title: `${c.name}(${String(c.input.file_path)})`, category: c.name === "Edit" ? "edit" : "read" }), newId: () => `i${++n}` });
        expect(turns).toHaveLength(1);
        const t = turns[0]!;
        expect(t.prompt).toEqual({ text: "fix it", index: 0 });
        expect(t.status).toBe("aborted");
        expect(t.blocks.map((b) => (b.t === "tool" ? `${b.name}:${b.status}` : b.t))).toEqual(["text", "Read:ok", "Edit:denied"]);
        // Diffs come from the input when the GUI's log doesn't have them.
        const edit = t.blocks[2] as { diff?: { added: number; removed: number } };
        expect([edit.diff?.added, edit.diff?.removed]).toEqual([1, 1]);
    });

    test("turns from before a compaction are kept, marked archived and not rewindable", () => {
        const segs = [{ messages: [user("old prompt")] }, { summary: "Summary.", messages: [user("Summary.", "prompt", { meta: { kind: "summary" } } as Partial<Message>), user("new prompt")] }];
        let n = 0;
        const turns = replay({ segments: segs, current: segs[1]!.messages, ui: new UiLog(join(tempDir(), "y.jsonl"), "y", false), meta: (c) => ({ title: c.name }), newId: () => `i${++n}` });
        expect(turns.map((t) => [t.prompt?.text ?? t.blocks[0]?.t, Boolean(t.archived), t.prompt?.index])).toEqual([
            ["old prompt", true, undefined],
            ["compact", false, undefined],
            ["new prompt", false, 1],
        ]);
    });
});

describe("sessions across projects", () => {
    test("listed newest first with their own folder; found by id anywhere", () => {
        const a = Session.create(join(tempDir(), "proj-a"));
        a.push({ role: "user", content: [{ type: "text", text: "in a" }], meta: { kind: "prompt" } });
        const b = Session.create(join(tempDir(), "proj-b"));
        b.setTitle("Named b");
        b.push({ role: "user", content: [{ type: "text", text: "in b" }], meta: { kind: "prompt" } });
        const empty = Session.create(join(tempDir(), "proj-c"));
        empty.setTitle("never used");
        const all = listAllSessions(50);
        const mine = all.filter((s) => s.id === a.meta.id || s.id === b.meta.id);
        expect(mine.map((s) => [s.title, s.cwd])).toContainEqual(["in a", a.meta.cwd]);
        expect(mine.map((s) => [s.title, s.cwd])).toContainEqual(["Named b", b.meta.cwd]);
        expect(all.some((s) => s.id === empty.meta.id)).toBe(false);
        expect(findSessionAnywhere(b.meta.id)).toBe(b.path);
        expect(findSessionAnywhere("../etc")).toBeUndefined();
    });
});

describe("login shell PATH", () => {
    test("the login shell's entries come first, without duplicates", () => {
        expect(mergePath("/usr/bin:/bin", "/opt/homebrew/bin:/usr/bin")).toBe("/opt/homebrew/bin:/usr/bin:/bin");
        expect(mergePath("/usr/bin", undefined)).toBe("/usr/bin");
        expect(mergePath(undefined, "/a::/b")).toBe("/a:/b");
    });
});

describe("engine", () => {
    test("with no models, listing doesn't loop (each list used to broadcast a change that asked for another)", async () => {
        let fetched = 0;
        const engine = new Engine({ listModels: async () => (fetched++, []) });
        const events: string[] = [];
        const client = { subs: new Set<string>(), send: (e: { type: string }) => events.push(e.type) };
        engine.clients.add(client as never);
        // The GUI lists again whenever it hears models.changed.
        let lists = 0;
        const list = async () => {
            lists++;
            return engine.handle(client as never, "models.list", {});
        };
        expect(await list()).toEqual([]);
        for (let i = 0; i < 5 && events.includes("models.changed"); i++) {
            events.length = 0;
            await list();
        }
        expect(lists).toBe(1);
        expect(fetched).toBe(1);
        // Asking for a refresh still refreshes.
        await engine.handle(client as never, "models.list", { refresh: true });
        expect(fetched).toBe(2);
        await engine.stop();
    });
});
