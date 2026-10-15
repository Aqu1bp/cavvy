// File checkpoints and /rewind: snapshots before edits, restoring files,
// truncating the conversation (and resuming it), outside changes, modes,
// cleanup, and the /rewind command flow.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { FileHistory, writeTracked, pruneFileHistory, rewindTargets, resetToolState, MAX_SNAPSHOT_BYTES } = await import("../src/agent/checkpoints");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { rewindCommand } = await import("../src/commands/rewind");
const { paths } = await import("../src/config/paths");
const { stripAnsi } = await import("../src/ui/ansi");
import type { AssistantMessage, Message, UserMessage } from "../src/providers/types";
import type { ToolState } from "../src/tools/types";
import type { PermissionMode } from "../src/permissions/modes";

const dirs: string[] = [];
afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    iso.cleanup();
});

/** A real path (history keys files by real path; the temp folder may be under a link). */
function project(): string {
    const d = realpathSync(tempDir("harness-rewind-"));
    dirs.push(d);
    return d;
}

type Call = { name: string; input: Record<string, unknown> };
const read = (file_path: string): Call => ({ name: "Read", input: { file_path } });
const write = (file_path: string, content: string): Call => ({ name: "Write", input: { file_path, content } });
const edit = (file_path: string, old_string: string, new_string: string): Call => ({ name: "Edit", input: { file_path, old_string, new_string } });

const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessage => ({ role: "assistant", provider: "test", model: "test", stopReason, content });

/** A model that answers each prompt (by its text) with one batch of tool calls, then "done <prompt>". */
function scripted(script: Record<string, Call[]>) {
    let n = 0;
    return {
        async stream(req: { messages: Message[] }) {
            const last = req.messages[req.messages.length - 1]!;
            const prompt = [...req.messages].reverse().find((m) => m.role === "user" && (m.meta?.kind === "prompt" || !m.meta)) as UserMessage | undefined;
            const first = prompt?.content[0];
            const text = first?.type === "text" ? first.text : "";
            if (last.role === "user" && last.meta?.kind !== "tool_results" && script[text]?.length) {
                return reply(script[text]!.map((c) => ({ type: "tool_call" as const, id: `c${++n}`, name: c.name, input: c.input })), "tool_use");
            }
            return { ...reply([{ type: "text", text: `done ${text}` }]), usage: { inputTokens: 5000, outputTokens: 10 } };
        },
        async listModels() {
            return [];
        },
    };
}

function setup(proj: string, script: Record<string, Call[]>, opts: { mode?: PermissionMode; classifier?: unknown; queue?: string[] } = {}) {
    const session = Session.create(proj, { system: "test system" });
    const settings = { autoCompact: false } as any;
    const state: ToolState = { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map() };
    let mode: PermissionMode = opts.mode ?? "bypassPermissions";
    const agent = new Agent({
        session,
        model: { provider: "test", id: "test", pricing: { input: 3, output: 15 } },
        client: scripted(script) as any,
        settings: () => settings,
        checker: new PermissionChecker(() => settings, proj),
        classifier: opts.classifier as any,
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: state,
        host: { emit() {}, ui: {}, drainQueued: () => opts.queue?.splice(0) ?? [] },
    });
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal, display: text });
    const history = state.fileHistory!;
    return { session, state, agent, run, history };
}

/** The checkpoint of the prompt with this text. */
function cpOf(session: { messages: Message[] }, text: string): number {
    const t = rewindTargets(session.messages).find((x) => x.text === text);
    if (!t?.checkpoint) throw new Error(`no checkpoint for ${text}`);
    return t.checkpoint;
}

function records(history: { dir: string }): any[] {
    const f = join(history.dir, "index.jsonl");
    return existsSync(f) ? readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}

const hashOf = (s: string | Buffer) => new Bun.CryptoHasher("sha256").update(s).digest("hex");

describe("file snapshots", () => {
    test("a file is saved before its first change in a turn, not again in that turn", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        writeFileSync(a, "v0\n");
        const { session, run, history } = setup(proj, {
            t1: [read(a), write(a, "v1\n"), edit(a, "v1", "v2")],
            t2: [write(a, "v3\n")],
        });
        expect(await run("t1")).toBe("done");
        expect(readFileSync(a, "utf-8")).toBe("v2\n");
        const cp1 = cpOf(session, "t1");
        let snaps = records(history).filter((r) => r.t === "snap");
        expect(snaps).toHaveLength(1);
        expect(snaps[0]).toMatchObject({ cp: cp1, path: a, hash: hashOf("v0\n") });
        expect(history.filesIn(cp1)).toEqual([a]);
        // Only what was there before is kept; the turn's own intermediate writes aren't.
        expect(readdirSync(join(history.dir, "blobs"))).toEqual([hashOf("v0\n")]);

        await run("t2");
        const cp2 = cpOf(session, "t2");
        expect(cp2).toBeGreaterThan(cp1);
        snaps = records(history).filter((r) => r.t === "snap");
        expect(snaps).toHaveLength(2);
        expect(snaps[1]).toMatchObject({ cp: cp2, path: a, hash: hashOf("v2\n") });
        expect(history.plan(cp2)).toMatchObject([{ path: a, action: "write", hash: hashOf("v2\n") }]);
        expect(history.plan(cp1)).toMatchObject([{ path: a, action: "write", hash: hashOf("v0\n") }]);
    });

    test("a new file is recorded as missing and is deleted on restore", async () => {
        const proj = project();
        const f = join(proj, "sub", "new.txt");
        const { session, run, history } = setup(proj, { make: [write(f, "fresh\n")] });
        await run("make");
        expect(readFileSync(f, "utf-8")).toBe("fresh\n");
        const cp = cpOf(session, "make");
        expect(records(history).find((r) => r.t === "snap")).toMatchObject({ cp, path: f, hash: null });
        const plan = history.plan(cp);
        expect(plan).toMatchObject([{ path: f, action: "delete", outside: false }]);
        expect(history.restore(plan)).toEqual({ done: [f], failed: [] });
        expect(existsSync(f)).toBe(false);
        // Restored state is what the harness last wrote now: nothing left to do.
        expect(history.plan(cp)).toEqual([]);
    });

    test("several turns, then restoring to the middle one", async () => {
        const proj = project();
        const [a, b, c, d] = ["a.txt", "b.txt", "c.txt", "d.txt"].map((n) => join(proj, n));
        writeFileSync(d!, "original d\n");
        const { session, run, history } = setup(proj, {
            one: [write(a!, "1\n")],
            two: [write(a!, "2\n"), write(b!, "b\n")],
            three: [write(a!, "3\n"), write(c!, "c\n"), read(d!), edit(d!, "original", "changed")],
        });
        await run("one");
        await run("two");
        await run("three");
        const plan = history.plan(cpOf(session, "two"));
        expect(plan.map((i) => [i.path, i.action])).toEqual([
            [a, "write"],
            [b, "delete"],
            [c, "delete"],
            [d, "write"],
        ]);
        expect(plan.every((i) => !i.outside)).toBe(true);
        history.restore(plan);
        expect(readFileSync(a!, "utf-8")).toBe("1\n");
        expect(existsSync(b!)).toBe(false);
        expect(existsSync(c!)).toBe(false);
        expect(readFileSync(d!, "utf-8")).toBe("original d\n");
        // Back to after "one" means one file to undo for the first turn.
        expect(history.plan(cpOf(session, "one")).map((i) => [i.path, i.action])).toEqual([[a, "delete"]]);
    });

    test("identical content is stored once", async () => {
        const proj = project();
        const [a, b] = [join(proj, "a.txt"), join(proj, "b.txt")];
        writeFileSync(a, "same\n");
        writeFileSync(b, "same\n");
        const { run, history } = setup(proj, {
            one: [read(a), read(b), write(a, "x\n"), write(b, "y\n")],
            two: [write(a, "same\n")],
            three: [write(a, "z\n")],
        });
        await run("one");
        await run("two");
        await run("three");
        expect(records(history).filter((r) => r.t === "snap").map((r) => r.hash)).toEqual([hashOf("same\n"), hashOf("same\n"), hashOf("x\n"), hashOf("same\n")]);
        expect(readdirSync(join(history.dir, "blobs")).sort()).toEqual([hashOf("same\n"), hashOf("x\n")].sort());
    });

    test("restores are byte for byte, through any edit tool that uses writeTracked", async () => {
        const proj = project();
        const f = join(proj, "bin.dat");
        const bytes = Buffer.from([0xff, 0xfe, 0x00, 0x0d, 0x0a, 0xc3, 0x28, 0x41, 0x0d, 0x0a]);
        writeFileSync(f, bytes);
        const session = Session.create(proj);
        const history = FileHistory.for(session)!;
        const state: ToolState = { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map(), fileHistory: history };
        const cp = history.begin();
        // Like a notebook tool writing through it.
        await writeTracked(state, f, "{}");
        await writeTracked(state, f, '{"cells":[]}');
        expect(readFileSync(f, "utf-8")).toBe('{"cells":[]}');
        expect(history.filesIn(cp)).toEqual([f]);
        history.restore(history.plan(cp));
        expect(readFileSync(f).equals(bytes)).toBe(true);
    });

    test("a file deleted since is put back with its mode", async () => {
        const proj = project();
        const f = join(proj, "run.sh");
        writeFileSync(f, "#!/bin/sh\n");
        chmodSync(f, 0o766); // group-writable: the usual umask would drop that
        const { session, run, history } = setup(proj, { one: [read(f), write(f, "#!/bin/sh\necho hi\n")] });
        await run("one");
        rmSync(f);
        const plan = history.plan(cpOf(session, "one"));
        expect(plan).toMatchObject([{ path: f, action: "write", current: null, outside: true }]);
        expect(history.restore(plan).done).toEqual([f]);
        expect(readFileSync(f, "utf-8")).toBe("#!/bin/sh\n");
        expect(statSync(f).mode & 0o777).toBe(0o766);
    });

    test("a file reached through a link is one file", async () => {
        const proj = project();
        const real = join(proj, "real.txt");
        const link = join(proj, "link.txt");
        writeFileSync(real, "original\n");
        symlinkSync(real, link);
        // The project folder through a link too, the way /tmp is on macOS.
        const alias = join(project(), "proj");
        symlinkSync(proj, alias);
        const { session, run, history } = setup(proj, {
            one: [read(real), write(real, "first\n"), read(link), write(link, "second\n"), read(join(alias, "real.txt")), write(join(alias, "real.txt"), "third\n")],
        });
        await run("one");
        expect(readFileSync(real, "utf-8")).toBe("third\n");
        const cp = cpOf(session, "one");
        expect(history.filesIn(cp)).toEqual([real]);
        const plan = history.plan(cp);
        expect(plan).toMatchObject([{ path: real, action: "write", hash: hashOf("original\n"), outside: false }]);
        expect(history.restore(plan)).toEqual({ done: [real], failed: [] });
        expect(readFileSync(real, "utf-8")).toBe("original\n");
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    test("a link to a file that didn't exist: the file it made is deleted, the link kept", async () => {
        const proj = project();
        const target = join(proj, "target.txt");
        const link = join(proj, "link.txt");
        symlinkSync(target, link);
        const { session, run, history } = setup(proj, { one: [write(link, "made\n")] });
        await run("one");
        expect(readFileSync(target, "utf-8")).toBe("made\n");
        const plan = history.plan(cpOf(session, "one"));
        expect(plan).toMatchObject([{ path: target, action: "delete", outside: false }]);
        history.restore(plan);
        expect(existsSync(target)).toBe(false);
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
    });

    test("parallel writes to one file are recorded in order", async () => {
        const proj = project();
        const f = join(proj, "f.txt");
        writeFileSync(f, "v0\n");
        const history = FileHistory.for(Session.create(proj))!;
        const state: ToolState = { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map(), fileHistory: history };
        const cp = history.begin();
        await Promise.all(["a\n", "b\n", "c\n", "d\n"].map((t) => writeTracked(state, f, t)));
        expect(readFileSync(f, "utf-8")).toBe("d\n");
        expect(records(history).filter((r) => r.t === "wrote").map((r) => r.hash)).toEqual(["a\n", "b\n", "c\n", "d\n"].map(hashOf));
        expect(history.plan(cp)).toMatchObject([{ path: f, outside: false }]);
    });

    test("a sub-agent's edits count toward the parent's prompt", async () => {
        const proj = project();
        const f = join(proj, "from-sub.txt");
        const { session, run, history } = setup(proj, {
            delegate: [{ name: "Task", input: { description: "make a file", prompt: "sub: make it" } }],
            "sub: make it": [write(f, "made by a sub-agent\n")],
        });
        await run("delegate");
        expect(readFileSync(f, "utf-8")).toBe("made by a sub-agent\n");
        const cp = cpOf(session, "delegate");
        expect(history.filesIn(cp)).toEqual([f]);
        expect(history.plan(cp)).toMatchObject([{ path: f, action: "delete" }]);
    });

    test("a message typed while the agent was answering starts its own checkpoint", async () => {
        const proj = project();
        const f = join(proj, "later.txt");
        const queue: string[] = [];
        const { session, run, history } = setup(proj, { "queued edit": [write(f, "later\n")] }, { queue });
        queue.push("queued edit");
        await run("plain");
        expect(rewindTargets(session.messages).map((t) => t.text)).toEqual(["plain", "queued edit"]);
        expect(history.filesIn(cpOf(session, "plain"))).toEqual([]);
        expect(history.filesIn(cpOf(session, "queued edit"))).toEqual([f]);
    });

    test(`files over ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB are skipped with a reason`, async () => {
        const proj = project();
        const f = join(proj, "big.bin");
        writeFileSync(f, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 1));
        const history = FileHistory.for(Session.create(proj))!;
        const cp = history.begin();
        await history.write(f, Buffer.from("small now"));
        expect(history.plan(cp)).toEqual([{ path: f, action: "skip", reason: "over 10 MB" }]);
        expect(existsSync(join(history.dir, "blobs")) ? readdirSync(join(history.dir, "blobs")) : []).toEqual([]);
        // Restoring does nothing to it.
        expect(history.restore(history.plan(cp))).toEqual({ done: [], failed: [] });
        expect(readFileSync(f, "utf-8")).toBe("small now");
    });

    test("snapshots are read back from disk (a resumed session)", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        const { session, run, history } = setup(proj, { one: [write(a, "1\n")], two: [write(a, "2\n")] });
        await run("one");
        await run("two");
        const again = new FileHistory(history.dir);
        expect(again.plan(cpOf(session, "two"))).toMatchObject([{ path: a, action: "write", hash: hashOf("1\n"), outside: false }]);
        expect(again.plan(cpOf(session, "one"))).toMatchObject([{ path: a, action: "delete", outside: false }]);
        expect(again.begin()).toBeGreaterThan(cpOf(session, "two"));
    });

    test("if the index can't be saved, this run still has it and nothing later is saved", async () => {
        const proj = project();
        const [a, b, c] = ["a.txt", "b.txt", "c.txt"].map((n) => join(proj, n));
        const { session, run, history } = setup(proj, { one: [write(a!, "1\n")], two: [write(b!, "2\n")], three: [write(c!, "3\n")] });
        await run("one");
        // A folder where the index was makes the append fail, even as root (whom a read-only file doesn't stop).
        const index = join(history.dir, "index.jsonl");
        renameSync(index, `${index}.kept`);
        mkdirSync(index);
        await run("two");
        rmdirSync(index);
        renameSync(`${index}.kept`, index);
        await run("three");
        expect(history.unsaved).toBeTruthy();
        expect(history.plan(cpOf(session, "two")).map((i) => i.path)).toEqual([b, c]);
        // On disk only what came before the failure, so a resume never restores to the wrong point.
        const again = new FileHistory(history.dir);
        expect(again.plan(cpOf(session, "one")).map((i) => i.path)).toEqual([a]);
        expect(again.plan(cpOf(session, "two"))).toEqual([]);
        expect(again.unsaved).toBeUndefined();
    });

    test("a missing saved copy is shown as one that can't be restored", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        writeFileSync(a, "v0\n");
        const { session, run, history } = setup(proj, { one: [read(a), write(a, "v1\n")] });
        await run("one");
        rmSync(join(history.dir, "blobs", hashOf("v0\n")));
        expect(history.plan(cpOf(session, "one"))).toEqual([{ path: a, action: "skip", reason: "the saved copy is missing" }]);
    });

    test("folders are 0700 and files 0600", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        writeFileSync(a, "x");
        const { run, history } = setup(proj, { one: [read(a), write(a, "y")] });
        await run("one");
        const mode = (p: string) => statSync(p).mode & 0o777;
        expect(history.dir.startsWith(join(paths.projectsDir()))).toBe(true);
        expect(mode(dirname(history.dir))).toBe(0o700);
        expect(mode(history.dir)).toBe(0o700);
        expect(mode(join(history.dir, "blobs"))).toBe(0o700);
        expect(mode(join(history.dir, "index.jsonl"))).toBe(0o600);
        for (const b of readdirSync(join(history.dir, "blobs"))) expect(mode(join(history.dir, "blobs", b))).toBe(0o600);
    });
});

describe("outside changes", () => {
    test("a file changed since the harness last wrote it is flagged; others aren't", async () => {
        const proj = project();
        const [a, b, c] = ["a.txt", "b.txt", "c.txt"].map((n) => join(proj, n));
        const { session, run, history } = setup(proj, { one: [write(a!, "a1\n"), write(b!, "b1\n"), write(c!, "c1\n")] });
        await run("one");
        writeFileSync(a!, "edited by hand\n");
        rmSync(c!);
        const plan = history.plan(cpOf(session, "one"));
        expect(plan.map((i) => [i.path, i.outside])).toEqual([
            [a, true],
            [b, false],
        ]);
        // c is gone already, which is how it was then: nothing to do.
        expect(plan.find((i) => i.path === c)).toBeUndefined();
    });

    test("a file that changes again after the plan was made is left alone", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        const { session, run, history } = setup(proj, { one: [write(a, "a1\n")] });
        await run("one");
        const plan = history.plan(cpOf(session, "one"));
        writeFileSync(a, "typed meanwhile\n");
        const res = history.restore(plan);
        expect(res.done).toEqual([]);
        expect(res.failed[0]?.path).toBe(a);
        expect(readFileSync(a, "utf-8")).toBe("typed meanwhile\n");
    });

    test("a file replaced by a link isn't written through it", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        const victim = join(proj, "victim.txt");
        writeFileSync(a, "v0\n");
        const { session, run, history } = setup(proj, { one: [read(a), write(a, "v1\n")] });
        await run("one");
        const plan = history.plan(cpOf(session, "one"));
        // Same bytes behind the link, so only the link gives it away.
        writeFileSync(victim, "v1\n");
        rmSync(a);
        symlinkSync(victim, a);
        const res = history.restore(plan);
        expect(res.done).toEqual([]);
        expect(res.failed[0]?.error).toContain("replaced by a link");
        expect(readFileSync(victim, "utf-8")).toBe("v1\n");
        expect(history.plan(cpOf(session, "one"))).toEqual([{ path: a, action: "skip", reason: "replaced by a link" }]);
    });
});

describe("rewinding the conversation", () => {
    test("history is cut to before the prompt, and resume shows the same", async () => {
        const proj = project();
        const { session, agent, run } = setup(proj, { one: [], two: [], three: [] });
        await run("one");
        await run("two");
        await run("three");
        const cost = session.cost;
        const target = rewindTargets(session.messages).find((t) => t.text === "two")!;
        agent.rewind(target.index);
        expect(session.messages.map((m) => (m.role === "user" ? m.meta?.display : (m.content[0] as { text: string }).text))).toEqual(["one", "done one"]);
        expect(agent.contextTokens).toBe(0);
        expect(session.cost).toBe(cost);

        const loaded = Session.load(session.path);
        expect(loaded.messages).toEqual(session.messages);
        expect(loaded.cost).toBeCloseTo(cost);
        expect(readFileSync(session.path, "utf-8")).toContain('"t":"rewind"');

        // The conversation goes on from there, and resumes that way too.
        await run("four");
        const again = Session.load(session.path);
        expect(rewindTargets(again.messages).map((t) => t.text)).toEqual(["one", "four"]);
        expect(again.messages).toEqual(session.messages);
    });

    test("state that came from the dropped turns is reset", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        writeFileSync(a, "x");
        let cleared = 0;
        const classifier = { clearCache: () => cleared++, classify: async () => ({ decision: "allow", reason: "" }) };
        const { session, state, agent, run } = setup(
            proj,
            {
                one: [{ name: "TodoWrite", input: { todos: [{ content: "first", status: "in_progress" }] } }],
                two: [read(a), { name: "TodoWrite", input: { todos: [{ content: "second", status: "pending" }] } }],
            },
            { classifier },
        );
        await run("one");
        state.approvedPlan = "a plan approved in turn two";
        agent.addReminder("the user ran a command before prompt two");
        await run("two");
        expect(state.todos.map((t) => t.content)).toEqual(["second"]);
        expect(state.fileState.has(a)).toBe(true);
        expect(agent.contextTokens).toBeGreaterThan(0);

        agent.rewind(rewindTargets(session.messages).find((t) => t.text === "two")!.index);
        expect(state.todos.map((t) => t.content)).toEqual(["first"]);
        expect(state.approvedPlan).toBeUndefined();
        expect(state.fileState.size).toBe(0);
        expect(agent.contextTokens).toBe(0);
        expect(cleared).toBe(1);

        // The note that went out with "two" is pending again, with the current mode.
        await run("two again");
        const sent = session.messages.find((m) => m.role === "user" && m.meta?.display === "two again")!;
        const texts = sent.content.map((p) => (p.type === "text" ? p.text : ""));
        expect(texts.some((t) => t.includes("the user ran a command before prompt two"))).toBe(true);
        expect(texts.some((t) => t.includes('The permission mode is "Bypass permissions"'))).toBe(true);
    });

    test("resetToolState keeps todos and the plan only from calls that succeeded", () => {
        const state: ToolState = { cwd: "/", projectRoot: "/", fileState: new Map([["/x", { mtimeMs: 1, size: 1, partial: false }]]), todos: [], shells: new Map() };
        const msgs: Message[] = [
            reply(
                [
                    { type: "tool_call", id: "t1", name: "TodoWrite", input: { todos: [{ content: "kept", status: "pending" }] } },
                    { type: "tool_call", id: "p1", name: "ExitPlanMode", input: { plan: "approved plan" } },
                ],
                "tool_use",
            ),
            { role: "user", content: [{ type: "tool_result", toolCallId: "t1", toolName: "TodoWrite", content: "ok" }, { type: "tool_result", toolCallId: "p1", toolName: "ExitPlanMode", content: "ok" }], meta: { kind: "tool_results" } },
            reply(
                [
                    { type: "tool_call", id: "t2", name: "TodoWrite", input: { todos: [{ content: "rejected", status: "pending" }] } },
                    { type: "tool_call", id: "p2", name: "ExitPlanMode", input: { plan: "rejected plan" } },
                ],
                "tool_use",
            ),
            { role: "user", content: [{ type: "tool_result", toolCallId: "t2", toolName: "TodoWrite", content: "bad", isError: true }, { type: "tool_result", toolCallId: "p2", toolName: "ExitPlanMode", content: "no", isError: true }], meta: { kind: "tool_results" } },
        ];
        resetToolState(state, msgs);
        expect(state.todos).toEqual([{ content: "kept", status: "pending", activeForm: undefined }]);
        expect(state.approvedPlan).toBe("approved plan");
        expect(state.fileState.size).toBe(0);
    });

    test("rewind targets are prompts and commands, with what the user typed", () => {
        const msgs: Message[] = [
            { role: "user", content: [{ type: "text", text: "summary" }], meta: { kind: "summary" } },
            { role: "user", content: [{ type: "text", text: "fix @a.ts" }, { type: "text", text: "Contents of a.ts ..." }, { type: "text", text: "<system-reminder>\nmode note\n</system-reminder>" }], meta: { kind: "prompt", display: "fix @a.ts", checkpoint: 5 } },
            reply([{ type: "text", text: "ok" }]),
            { role: "user", content: [{ type: "text", text: "LONG INIT PROMPT" }], meta: { kind: "command", display: "/init", checkpoint: 6 } },
            { role: "user", content: [{ type: "tool_result", toolCallId: "x", toolName: "Read", content: "r" }], meta: { kind: "tool_results" } },
            { role: "user", content: [{ type: "text", text: "old style" }] },
        ];
        expect(rewindTargets(msgs)).toEqual([
            { index: 1, text: "fix @a.ts", checkpoint: 5 },
            { index: 3, text: "/init", checkpoint: 6 },
            { index: 5, text: "old style", checkpoint: undefined },
        ]);
    });
});

describe("cleanup", () => {
    test("history of sessions untouched for 30 days is deleted, the rest kept", async () => {
        const root = join(paths.projectsDir(), "prune-test");
        const day = 24 * 60 * 60 * 1000;
        const now = Date.now();
        const make = (id: string, historyAge: number, sessionAge?: number) => {
            const dir = join(root, "file-history", id);
            mkdirSync(join(dir, "blobs"), { recursive: true });
            writeFileSync(join(dir, "index.jsonl"), "{}\n");
            const t = (now - historyAge) / 1000;
            utimesSync(join(dir, "index.jsonl"), t, t);
            utimesSync(dir, t, t);
            if (sessionAge !== undefined) {
                writeFileSync(join(root, `${id}.jsonl`), "{}\n");
                const s = (now - sessionAge) / 1000;
                utimesSync(join(root, `${id}.jsonl`), s, s);
            }
            return dir;
        };
        const old = make("old", 40 * day, 40 * day);
        const orphan = make("orphan", 31 * day);
        const recent = make("recent", 2 * day, 2 * day);
        const resumed = make("resumed", 40 * day, 1 * day);
        const kept = make("kept", 40 * day, 40 * day);
        const removed = await pruneFileHistory({ keep: "kept", now });
        expect(removed.sort()).toEqual([old, orphan].sort());
        expect(existsSync(old)).toBe(false);
        expect(existsSync(orphan)).toBe(false);
        expect(existsSync(recent)).toBe(true);
        expect(existsSync(resumed)).toBe(true);
        expect(existsSync(kept)).toBe(true);
    });
});

describe("/rewind command", () => {
    /** Just enough of the App for the command, answering each dialog with `answers` in turn. */
    function fakeApp(s: ReturnType<typeof setup>, proj: string, answers: ((d: any) => unknown)[]) {
        const printed: string[] = [];
        const shown: any[] = [];
        let input = "";
        const app = {
            cwd: proj,
            session: s.session,
            agent: s.agent,
            toolState: s.state,
            busy: false,
            lastResponse: "stale",
            classifier: { clearCache() {} },
            editor: { set: (t: string) => (input = t) },
            print: (l: string[]) => printed.push(...l.map((x) => stripAnsi(x))),
            notice: (m: string) => printed.push(m),
            showDialog: async (d: any) => {
                shown.push(d);
                const answer = answers.shift();
                if (!answer) throw new Error("unexpected dialog");
                return answer(d);
            },
        };
        return { app: app as any, printed, shown, input: () => input };
    }
    const pickLabel = (label: string) => (d: any) => d.list.items.find((i: any) => stripAnsi(i.label) === label)?.value;
    const pickValue = (v: unknown) => (d: any) => d.list.items.find((i: any) => i.value === v && !i.disabled)?.value;

    test("restore code and conversation: files back, history cut, prompt in the input", async () => {
        const proj = project();
        const [a, b] = [join(proj, "a.txt"), join(proj, "b.txt")];
        const s = setup(proj, { one: [write(a, "1\n")], two: [write(a, "2\n"), write(b, "b\n")], three: [write(a, "3\n")] });
        await s.run("one");
        await s.run("two");
        await s.run("three");
        const f = fakeApp(s, proj, [pickLabel("two"), pickValue("both")]);
        await rewindCommand(f.app);
        // Newest first, with how many files each prompt changed.
        expect(f.shown[0].list.items.map((i: any) => [i.label, i.description])).toEqual([
            ["three", "1 file changed"],
            ["two", "2 files changed"],
            ["one", "1 file changed"],
        ]);
        const header = f.shown[1].header.map((l: string) => stripAnsi(l)).join("\n");
        expect(header).toContain("restore a.txt");
        expect(header).toContain("delete  b.txt");
        expect(header).toContain("shell commands aren't tracked");
        expect(readFileSync(a, "utf-8")).toBe("1\n");
        expect(existsSync(b)).toBe(false);
        expect(rewindTargets(s.session.messages).map((t) => t.text)).toEqual(["one"]);
        expect(f.input()).toBe("two");
        expect(f.app.lastResponse).toBe("done one");
        expect(rewindTargets(Session.load(s.session.path).messages).map((t) => t.text)).toEqual(["one"]);
    });

    test("conversation only keeps the files; code only keeps the conversation", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        const s = setup(proj, { one: [write(a, "1\n")], two: [write(a, "2\n")] });
        await s.run("one");
        await s.run("two");
        let f = fakeApp(s, proj, [pickLabel("two"), pickValue("code")]);
        await rewindCommand(f.app);
        expect(readFileSync(a, "utf-8")).toBe("1\n");
        expect(rewindTargets(s.session.messages).map((t) => t.text)).toEqual(["one", "two"]);
        expect(f.input()).toBe("");

        writeFileSync(a, "2\n"); // as if redone
        f = fakeApp(s, proj, [pickLabel("one"), pickValue("conversation")]);
        await rewindCommand(f.app);
        expect(readFileSync(a, "utf-8")).toBe("2\n");
        expect(s.session.messages).toEqual([]);
        expect(f.input()).toBe("one");
    });

    test("outside changes are listed and need a second yes", async () => {
        const proj = project();
        const a = join(proj, "a.txt");
        const s = setup(proj, { one: [write(a, "1\n")] });
        await s.run("one");
        writeFileSync(a, "mine\n");
        const f = fakeApp(s, proj, [pickLabel("one"), pickValue("both"), () => false]);
        await rewindCommand(f.app);
        expect(stripAnsi(f.shown[1].header.join("\n"))).toContain("a.txt (changed outside Harness)");
        expect(stripAnsi(f.shown[2].title)).toContain("Overwrite changes made outside");
        // Declined: nothing happened.
        expect(readFileSync(a, "utf-8")).toBe("mine\n");
        expect(rewindTargets(s.session.messages)).toHaveLength(1);
    });

    test("with no file changes, only the conversation can be restored", async () => {
        const proj = project();
        const s = setup(proj, { one: [] });
        await s.run("one");
        const f = fakeApp(s, proj, [pickLabel("one"), (d) => d.list.current()?.value]);
        await rewindCommand(f.app);
        const items = f.shown[1].list.items;
        expect(items.filter((i: any) => i.disabled).map((i: any) => i.value)).toEqual(["both", "code"]);
        expect(s.session.messages).toEqual([]);
        expect(f.input()).toBe("one");
    });

    test("if a file can't be restored, the conversation is kept so the prompt can be tried again", async () => {
        const proj = project();
        const [a, b] = [join(proj, "a.txt"), join(proj, "b.txt")];
        const s = setup(proj, { one: [write(a, "1\n"), write(b, "b\n")] });
        await s.run("one");
        const f = fakeApp(s, proj, [
            pickLabel("one"),
            (d) => {
                writeFileSync(a, "saved while choosing\n");
                return pickValue("both")(d);
            },
        ]);
        await rewindCommand(f.app);
        expect(existsSync(b)).toBe(false);
        expect(readFileSync(a, "utf-8")).toBe("saved while choosing\n");
        expect(rewindTargets(s.session.messages).map((t) => t.text)).toEqual(["one"]);
        expect(f.input()).toBe("");
        expect(f.printed.join("\n")).toContain("The conversation wasn't rewound");
        // The files it did restore changed under the model.
        expect((s.agent as any).pendingReminders.join("\n")).toContain("- b.txt");
    });

    test("files that can't be restored are listed, and the model is told about them", async () => {
        const proj = project();
        const [a, b] = [join(proj, "a.txt"), join(proj, "b.txt")];
        writeFileSync(a, "v0\n");
        const s = setup(proj, { one: [read(a), write(a, "v1\n"), write(b, "b\n")] });
        await s.run("one");
        rmSync(join(s.history.dir, "blobs", hashOf("v0\n")));
        const f = fakeApp(s, proj, [pickLabel("one"), pickValue("both")]);
        await rewindCommand(f.app);
        expect(stripAnsi(f.shown[1].header.join("\n"))).toContain("a.txt (the saved copy is missing)");
        expect(existsSync(b)).toBe(false);
        expect(readFileSync(a, "utf-8")).toBe("v1\n");
        expect(s.session.messages).toEqual([]);
        const notes = (s.agent as any).pendingReminders.join("\n");
        expect(notes).toContain("weren't restored");
        expect(notes).toContain("- a.txt");
        expect(notes).not.toContain("b.txt");
    });

    test("a project opened through a link: paths shown from it, and read state cleared", async () => {
        const proj = project();
        const alias = join(project(), "proj");
        symlinkSync(proj, alias);
        const a = join(alias, "a.txt");
        writeFileSync(a, "v0\n");
        const s = setup(alias, { one: [read(a), write(a, "v1\n")] });
        await s.run("one");
        expect(s.state.fileState.has(a)).toBe(true);
        const f = fakeApp(s, alias, [pickLabel("one"), pickValue("code")]);
        await rewindCommand(f.app);
        expect(stripAnsi(f.shown[1].header.join("\n"))).toContain("restore a.txt");
        expect(readFileSync(a, "utf-8")).toBe("v0\n");
        expect(s.state.fileState.has(a)).toBe(false);
    });

    test("prompts before a compaction aren't offered", async () => {
        const proj = project();
        const s = setup(proj, {});
        s.session.compact("sum", [{ role: "user", content: [{ type: "text", text: "summary" }], meta: { kind: "summary" } }]);
        const f = fakeApp(s, proj, []);
        await rewindCommand(f.app);
        expect(f.printed.join("\n")).toContain("summarized by /compact");
    });
});
