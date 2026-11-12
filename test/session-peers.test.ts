// One session's agent reaching the user's others (src/agent/peers.ts, src/tools/session-tools.ts,
// src/server/session-peers.ts): what it lists and reads, and what a message or a new session does in the app.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { projectOf, listText, readText, peerWake, freerMode, narrowerMode, PeerError } = await import("../src/agent/peers");
const { formatWakes, wakesFrom, WakeQueue } = await import("../src/agent/wakes");
const { listSessions, readSession, sendToSession, startSession, sessionServerTools, SESSION_TOOLS, SESSION_READ_TOOLS } = await import("../src/tools/session-tools");
const { Engine } = await import("../src/server/engine");
const { listAllSessions } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { PeerSummary, SessionPeers } from "../src/agent/peers";
import type { Message } from "../src/providers/types";

const dirs: string[] = [];
const mock = startMockLlm({ delayMs: 0 });
afterAll(() => {
    mock.stop();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    iso.cleanup();
});

async function until(pred: () => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

const summary = (id: string, cwd: string, o: Partial<PeerSummary> = {}): PeerSummary => ({ id, title: `Session ${id}`, cwd, status: "idle", updatedAt: Date.now() - 60_000, ...o });

function fakePeers(self: string, cwd: string, rows: PeerSummary[], messages: Record<string, Message[]> = {}, o: Partial<SessionPeers> = {}): SessionPeers {
    return { self, cwd, list: ({ limit, match }) => rows.filter((r) => !match || match(r)).slice(0, limit), read: (id) => (rows.find((r) => r.id === id) ? { summary: rows.find((r) => r.id === id)!, messages: messages[id] ?? [] } : undefined), ...o };
}

describe("projects", () => {
    test("a repository's worktrees are its project; a folder outside one is its own", () => {
        const root = realpathSync(tempDir("peers-proj-"));
        dirs.push(root);
        const main = join(root, "app");
        mkdirSync(join(main, ".git", "worktrees", "feature"), { recursive: true });
        mkdirSync(join(main, "src"), { recursive: true });
        const wt = join(root, "wt", "feature");
        mkdirSync(join(wt, "src"), { recursive: true });
        writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "feature")}\n`);
        const plain = join(root, "plain");
        mkdirSync(plain);
        expect(projectOf(join(main, "src"))).toBe(main);
        expect(projectOf(join(wt, "src"))).toBe(main);
        expect(projectOf(plain)).toBe(plain);
        // Opened through a link (macOS's /tmp is one): git writes the worktree's real path; still one project.
        const link = join(root, "link");
        symlinkSync(root, link);
        expect(projectOf(join(link, "app", "src"))).toBe(projectOf(join(wt, "src")));
    });
});

describe("what the agent reads", () => {
    test("the listing leaves this session and other projects out, unless all", () => {
        const here = realpathSync(tempDir("peers-here-"));
        const there = realpathSync(tempDir("peers-there-"));
        dirs.push(here, there);
        const peers = fakePeers("me", here, [summary("me", here), summary("a", here, { status: "working", model: "mock:mock-opus" }), summary("b", there), summary("c", here, { title: "Fix login" })]);
        const r = listText(peers, {});
        expect(r.count).toBe(2);
        expect(r.text).toContain("a  “Session a”  working");
        expect(r.text).toContain("mock:mock-opus");
        expect(r.text).not.toMatch(/^me /m);
        expect(r.text).not.toContain("Session b");
        expect(listText(peers, { all: true }).text).toContain(`folder: ${there}`);
        expect(listText(peers, { query: "LOGIN" }).text).toContain("Fix login");
        expect(listText(fakePeers("me", here, []), {}).text).toContain("No other sessions in this project");
    });

    test("a search looks past the newest few, in every project and in this one", () => {
        const here = realpathSync(tempDir("peers-many-"));
        const there = realpathSync(tempDir("peers-many-there-"));
        dirs.push(here, there);
        // Newest first; the session searched for is the 30th, and this project's only one is behind 250 others'.
        const rows = Array.from({ length: 300 }, (_, i) => summary(`s${i}`, i === 260 ? here : there, { title: i === 29 ? "Fix login" : `Other ${i}`, updatedAt: Date.now() - i * 1000 }));
        const peers = fakePeers("me", here, rows);
        expect(listText(peers, { all: true, query: "login" }).text).toContain("“Fix login”");
        expect(listText(peers, {}).text).toContain("s260 ");
    });

    test("a read has its turns, tools as one line, and who sent a message; the newest kept when too long", () => {
        const at = (role: "user" | "assistant", content: any[], meta?: any): Message => (role === "user" ? { role, content, meta } : { role, content, provider: "mock", model: "m" }) as Message;
        const messages: Message[] = [
            at("user", [{ type: "text", text: "fix the login bug" }], { kind: "prompt" }),
            at("assistant", [{ type: "tool_call", id: "1", name: "Read", input: {} }, { type: "tool_call", id: "2", name: "Read", input: {} }]),
            at("user", [{ type: "tool_result", toolCallId: "1", content: "x" }], { kind: "tool_results" }),
            at("assistant", [{ type: "text", text: "Fixed it in auth.ts." }]),
            at("user", [{ type: "text", text: "wrapped" }], { kind: "wake", display: "run the tests", from: { id: "s2", title: "Reviewer" } }),
            at("assistant", [{ type: "text", text: "Tests pass." }]),
        ];
        const r = readText({ summary: summary("s1", "/p"), messages }, {});
        expect(r.turns).toBe(2);
        expect(r.text).toContain("## User\nfix the login bug");
        expect(r.text).toContain("[used Read ×2]");
        expect(r.text).toContain("## Message from session s2 (“Reviewer”)\nrun the tests");
        expect(r.text).toContain("Tests pass.");
        const one = readText({ summary: summary("s1", "/p"), messages }, { turns: 1 });
        expect(one.text).toContain("1 earlier turn not shown");
        expect(one.text).not.toContain("fix the login bug");
        const huge = readText({ summary: summary("s1", "/p"), messages: [at("user", [{ type: "text", text: "go" }]), at("assistant", [{ type: "text", text: `start ${"x".repeat(100_000)} end` }])] }, {});
        expect(huge.text.length).toBeLessThan(45_000);
        expect(huge.text).toContain("characters left out");
        expect(huge.text).toContain(" end");
    });

    test("a message arrives marked as another session's agent, not the user", () => {
        const w = { ...peerWake({ id: "s1", title: "Fix login" }, "please run the tests"), at: 0 };
        const text = formatWakes([w]);
        expect(text).toContain("A message from the agent in another of the user's sessions arrived");
        expect(text).toContain("isn't the user");
        expect(text).toContain("send a message to session s1");
        expect(formatWakes([w, { source: "pull-request", label: "PR", text: "ci", at: 0 }])).toContain("and an event you asked to be told about arrived");
        expect(wakesFrom([w, w])).toEqual({ id: "s1", title: "Fix login" });
        expect(wakesFrom([w, { ...w, from: { id: "s9", title: "x" } }])).toBeUndefined();
        expect(wakesFrom([{ source: "monitor", label: "m", text: "t", at: 0 }])).toBeUndefined();
    });

    test("modes: no handing work to a session that asks less; a new one gets the narrower", () => {
        expect(freerMode("bypassPermissions", "default")).toBe(true);
        expect(freerMode("default", "auto")).toBe(false);
        expect(freerMode("plan", "plan")).toBe(false);
        expect(narrowerMode("auto", "acceptEdits")).toBe("acceptEdits");
        expect(narrowerMode("plan", "bypassPermissions")).toBe("plan");
    });

    test("between a goal's turns, only a message is taken", () => {
        const q = new WakeQueue({ coalesceMs: 0 });
        q.push({ source: "pull-request", label: "PR", text: "ci" });
        expect(q.hasMessage()).toBe(false);
        expect(q.takeForTurn({ messages: true })).toHaveLength(0);
        q.push(peerWake({ id: "a", title: "a" }, "hi"));
        expect(q.hasMessage()).toBe(true);
        expect(q.takeForTurn({ messages: true }).map((w) => w.from?.id)).toEqual(["a"]);
        expect(q.pending().map((w) => w.label)).toEqual(["PR"]);
        q.dispose();
    });

    test("a running turn takes events, not messages; a turn takes one sender's messages", () => {
        const q = new WakeQueue({ coalesceMs: 0 });
        const from = (id: string) => peerWake({ id, title: id }, `hi from ${id}`);
        q.push(from("a"));
        q.push({ source: "pull-request", label: "PR", text: "ci" });
        q.push(from("b"));
        q.push(from("a"));
        expect(q.drainRunning().map((w) => w.label)).toEqual(["PR"]);
        expect(q.takeForTurn().map((w) => w.from?.id)).toEqual(["a", "a"]);
        expect(q.takeForTurn().map((w) => w.from?.id)).toEqual(["b"]);
        q.dispose();
    });

    test("a queue sharing a session's memory keeps Esc and the hourly limit", () => {
        const memory = { started: [] as number[], paused: false };
        const first = new WakeQueue({ memory, maxPerHour: 1, coalesceMs: 0 });
        first.push({ source: "x", label: "a", text: "a" });
        expect(first.takeForTurn()).toHaveLength(1);
        first.pause();
        first.dispose();
        const again = new WakeQueue({ memory, maxPerHour: 1, coalesceMs: 0 });
        expect(again.isPaused).toBe(true);
        again.resume();
        expect(again.full()).toBe(true);
        again.dispose();
    });

    test("the hourly limit on wake turns shows before a wake is pushed", () => {
        const q = new WakeQueue({ maxPerHour: 1, coalesceMs: 0 });
        q.push({ source: "x", label: "a", text: "a" });
        expect(q.full()).toBe(false);
        expect(q.takeForTurn()).toHaveLength(1);
        expect(q.full()).toBe(true);
        q.dispose();
    });
});

describe("the tools", () => {
    const here = "/p";
    test("without peers, or from the terminal, they say why", async () => {
        expect(listSessions(undefined, {}).text).toContain("only a session's main agent");
        const disk = fakePeers("me", here, [summary("a", here)]);
        expect((await sendToSession(disk, { id: "a", message: "hi" })).text).toContain("Cavvy app only");
        expect((await startSession(disk, { prompt: "hi" })).text).toContain("Cavvy app only");
        expect(readSession(disk, { id: "me" }).text).toBe("That's this session.");
        expect(readSession(disk, { id: "nope" }).text).toContain("No session nope");
    });

    test("send checks the message and says what happened", async () => {
        const sent: string[] = [];
        const peers = fakePeers("me", here, [summary("a", here)], {}, {
            send: async (id, text) => {
                if (id === "busy") throw new PeerError("refused for a reason");
                sent.push(text);
                return { summary: summary(id, here), delivery: "queued" };
            },
            start: async () => summary("new", here),
        });
        expect((await sendToSession(peers, { id: "me", message: "hi" })).isError).toBe(true);
        expect((await sendToSession(peers, { id: "a", message: "  " })).text).toContain("non-empty");
        expect((await sendToSession(peers, { id: "a", message: "x".repeat(20_001) })).text).toContain("at most");
        expect((await sendToSession(peers, { id: "busy", message: "hi" })).text).toBe("refused for a reason");
        const ok = await sendToSession(peers, { id: "a", message: " run the tests " });
        expect(ok.text).toContain("It's busy: it reads this as soon as it's done.");
        expect(sent).toEqual(["run the tests"]);
    });

    test("the served names are used in what a CLI's agent reads; the terminal's set has no send or start", () => {
        const run = async () => ({ text: "Use ListSessions, then SendToSession." });
        const all = sessionServerTools(run, true);
        expect(all.map((t) => t.name)).toEqual(["list_sessions", "read_session", "send_to_session", "start_session"]);
        expect(all.every((t) => !/ListSessions|ReadSession|SendToSession|StartSession/.test(t.description))).toBe(true);
        expect(sessionServerTools(run, false).map((t) => t.name)).toEqual(["list_sessions", "read_session"]);
        expect(SESSION_READ_TOOLS.map((t) => t.name)).toEqual(["ListSessions", "ReadSession"]);
        expect(SESSION_TOOLS.find((t) => t.name === "SendToSession")!.category).toBe("execute");
    });

    test("in Plan mode, sending and starting are refused for what they are; listing and reading aren't asked", () => {
        const checker = new PermissionChecker(() => ({}), "/p");
        const send = SESSION_TOOLS.find((t) => t.name === "SendToSession")!;
        expect(checker.check(send, { id: "a", message: "hi" }, "plan", "/p")).toMatchObject({ behavior: "deny", reason: expect.stringContaining("not sent to or started") });
        expect(checker.check(send, { id: "a", message: "hi" }, "default", "/p").behavior).toBe("ask");
        for (const mode of ["plan", "default"] as const) expect(checker.check(SESSION_TOOLS.find((t) => t.name === "ReadSession")!, { id: "a" }, mode, "/p").behavior).toBe("allow");
    });

    test("served calls answer with the served names", async () => {
        const [list] = sessionServerTools(async () => ({ text: "Use ReadSession next." }), true);
        const r = await list!.call({}, { signal: new AbortController().signal, meta: {} });
        expect(r.text).toBe("Use read_session next.");
    });
});

describe("in the app", () => {
    writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
    writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", permissions: { allowBypass: true } }));
    const engine = new Engine({ listModels: async () => [], unloadAfterMs: 50 });
    const client = { subs: new Set<string>(), send() {} } as never;
    engine.clients.add(client);
    const project = realpathSync(createDemoProject(tempDir("peers-app-"), { git: false }));
    dirs.push(project);
    afterAll(() => engine.stop());

    type Rt = Awaited<ReturnType<typeof engine.createSession>>;
    const turns = (rt: Rt) => rt.snapshot().turns;
    const send = async (rt: Rt, text: string) => {
        const n = turns(rt).length;
        await rt.send(text);
        await until(() => turns(rt).length > n && rt.idle && turns(rt).at(-1)!.status !== "running");
        return turns(rt).at(-1)!;
    };
    const textOf = (turn: any) => turn.blocks.filter((b: any) => b.t === "text").map((b: any) => b.text).join("\n");

    test("a handoff reaches the other session as a message from this one, and it answers it", async () => {
        const a = await engine.createSession(project, { mode: "bypassPermissions" });
        const b = await engine.createSession(project, { mode: "bypassPermissions" });
        await Promise.all([a.ready, b.ready]);
        (client as any).subs.add(a.id).add(b.id);
        await send(b, "hello there");
        const before = turns(b).length;
        const handoff = await send(a, "handoff the auth tests");
        expect(textOf(handoff)).toContain(`Sent to session ${b.id}`);
        await until(() => turns(b).length > before && b.idle && turns(b).at(-1)!.status !== "running");
        const got = turns(b).at(-1)!;
        expect(got.prompt?.wake).toBe(true);
        expect(got.prompt?.from?.id).toBe(a.id);
        expect(got.prompt?.text).toBe("Please run the auth tests and tell me if any fail.");
        expect(textOf(got)).toContain("Another session asked: “Please run the auth tests and tell me if any fail.”");
        // Kept with the message: a reopened session shows who sent it.
        const stored = b.session.messages.find((m) => m.role === "user" && m.meta?.kind === "wake");
        expect(stored?.role === "user" && stored.meta?.from?.id).toBe(a.id);
        // And the sender can read what happened there.
        const read = readSession(a.toolState.peers, { id: b.id });
        expect(read.text).toContain(`## Message from session ${a.id}`);
        expect(read.text).toContain("Another session asked");
    });

    test("a new session started by one gets its prompt from it, in the same folder, no freer than it", async () => {
        const a = await engine.createSession(project, { mode: "acceptEdits" });
        await a.ready;
        const s = await startSession(a.toolState.peers, { prompt: "Write a README section about SSO sign-in.", title: "SSO README" });
        expect(s.isError).toBeFalsy();
        const id = /Started session (\S+)/.exec(s.text)![1]!;
        const n = engine.runtimes.get(id)!;
        expect(n.ws.cwd).toBe(project);
        expect(n.title).toBe("SSO README");
        // The folder's default (Manual) asks more than Accept edits.
        expect(n.mode).toBe("default");
        await until(() => turns(n).length > 0 && n.idle && turns(n).at(-1)!.status !== "running");
        expect(turns(n)[0]!.prompt?.from?.id).toBe(a.id);
        // Nothing has it open: it's let go once it's done, as a session no window shows is.
        await until(() => !engine.runtimes.has(id));
    });

    test("a message to a busy session waits for its turn to end, then shows whole, from its sender", async () => {
        const a = await engine.createSession(project, { mode: "bypassPermissions" });
        const b = await engine.createSession(project, { mode: "bypassPermissions" });
        await Promise.all([a.ready, b.ready]);
        (client as any).subs.add(a.id).add(b.id);
        // "pause": the mock answers after a moment, time to send meanwhile.
        await b.send("pause please");
        await until(() => b.busy);
        const r = await sendToSession(a.toolState.peers, { id: b.id, message: "Check the migration too." });
        expect(r.text).toContain("It's busy: it reads this as soon as it's done.");
        await until(() => turns(b).length === 2 && b.idle && turns(b).at(-1)!.status !== "running");
        // Not folded into the running turn: a turn of its own, shown whole and from A.
        expect(textOf(turns(b)[0])).not.toContain("Message from");
        expect(turns(b)[1]!.prompt?.from?.id).toBe(a.id);
        expect(turns(b)[1]!.prompt?.text).toBe("Check the migration too.");
    });

    test("a message to a session working on a goal goes in between the goal's turns, not after the goal", async () => {
        const a = await engine.createSession(project, { mode: "bypassPermissions" });
        const b = await engine.createSession(project, { mode: "bypassPermissions" });
        await Promise.all([a.ready, b.ready]);
        (client as any).subs.add(a.id).add(b.id);
        // goaldemo: its check says "not met" once, so the goal takes a second turn.
        await b.send("/goal goaldemo the auth tests pass");
        await until(() => b.busy);
        const r = await sendToSession(a.toolState.peers, { id: b.id, message: "Leave the migration alone." });
        expect(r.text).toMatch(/It's busy|working on it now/);
        await until(() => b.idle && !b.busy && turns(b).some((t) => t.prompt?.from) && turns(b).length >= 3, 15_000);
        const message = turns(b).findIndex((t) => t.prompt?.from?.id === a.id);
        // Right after the turn it arrived in, before the goal's next.
        expect(message).toBe(1);
        expect(turns(b).length).toBeGreaterThan(2);
    }, 20_000);

    test("Esc and the hourly limit hold after the session is closed and opened again", async () => {
        const a = await engine.createSession(project, { mode: "bypassPermissions" });
        const b = await engine.createSession(project, { mode: "bypassPermissions" });
        await Promise.all([a.ready, b.ready]);
        await send(b, "hello");
        b.toolState.wakes!.pause();
        // No window has it: it's closed, as when the last window lets go of it.
        (engine as any).unloadIfUnused(b.id);
        await until(() => !engine.runtimes.has(b.id));
        const r = await sendToSession(a.toolState.peers, { id: b.id, message: "go on" });
        expect(r.text).toContain("The user stopped that session");
        const reopened = engine.runtimes.get(b.id)!;
        expect(reopened).not.toBe(b);
        await Bun.sleep(300);
        expect(turns(reopened).filter((t) => t.prompt?.from)).toHaveLength(0);
        reopened.toolState.wakes!.resume();
        await until(() => turns(reopened).some((t) => t.prompt?.from?.id === a.id) && reopened.idle);
    }, 20_000);

    test("a session started by another runs on its Claude Code and Codex accounts", async () => {
        const a = await engine.createSession(project, { mode: "bypassPermissions" });
        await a.ready;
        a.session.setAccount("codex", "work");
        const s = await startSession(a.toolState.peers, { prompt: "Write the changelog.", title: "Changelog" });
        const id = /Started session (\S+)/.exec(s.text)![1]!;
        expect(engine.runtimes.get(id)!.session.accountId("codex")).toBe("work");
        await until(() => turns(engine.runtimes.get(id)!).length > 0 && engine.runtimes.get(id)!.idle);
    });

    test("a filtered listing reads session files newest first, only until it has enough, and never too many", async () => {
        const all = listAllSessions(500);
        expect(all.length).toBeGreaterThan(3);
        // Filtered as read: the oldest one, found though it's last.
        const oldest = all.at(-1)!;
        expect(listAllSessions(1, { match: (s) => s.id === oldest.id }).map((s) => s.id)).toEqual([oldest.id]);
        // Capped: two files read, at most two listed, whatever the limit.
        expect(listAllSessions(500, { maxRead: 2 }).length).toBeLessThanOrEqual(2);
        expect(listAllSessions(500, { maxRead: 2, match: (s) => s.id === oldest.id })).toHaveLength(0);
    });

    test("refusals: itself, unknown, a session that asks less, and a stopped one waits", async () => {
        const a = await engine.createSession(project, { mode: "default" });
        const b = await engine.createSession(project, { mode: "bypassPermissions" });
        await Promise.all([a.ready, b.ready]);
        expect((await sendToSession(a.toolState.peers, { id: a.id, message: "x" })).isError).toBe(true);
        expect((await sendToSession(a.toolState.peers, { id: "20990101-000000-abcdef", message: "x" })).text).toContain("No session");
        expect((await sendToSession(a.toolState.peers, { id: b.id, message: "x" })).text).toContain("asks the user less");
        // The other way is fine; a session the user stopped reads it when they next send it something.
        a.toolState.wakes!.pause();
        const r = await sendToSession(b.toolState.peers, { id: a.id, message: "when you can" });
        expect(r.text).toContain("The user stopped that session");
        expect(a.toolState.wakes!.size).toBe(1);
    });
});
