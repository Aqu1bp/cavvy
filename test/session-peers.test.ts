// One session's agent reaching the user's others (src/agent/peers.ts, src/tools/session-tools.ts,
// src/server/session-peers.ts): what it lists and reads, and what a message or a new session does in the app.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { projectOf, listText, readText, peerWake, freerMode, narrowerMode, PeerError } = await import("../src/agent/peers");
const { formatWakes, wakesFrom, WakeQueue } = await import("../src/agent/wakes");
const { listSessions, readSession, sendToSession, startSession, sessionServerTools, SESSION_TOOLS, SESSION_READ_TOOLS } = await import("../src/tools/session-tools");
const { Engine } = await import("../src/server/engine");
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
    return { self, cwd, list: ({ limit }) => rows.slice(0, limit), read: (id) => (rows.find((r) => r.id === id) ? { summary: rows.find((r) => r.id === id)!, messages: messages[id] ?? [] } : undefined), ...o };
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
                return { summary: summary(id, here), delivery: "joined" };
            },
            start: async () => summary("new", here),
        });
        expect((await sendToSession(peers, { id: "me", message: "hi" })).isError).toBe(true);
        expect((await sendToSession(peers, { id: "a", message: "  " })).text).toContain("non-empty");
        expect((await sendToSession(peers, { id: "a", message: "x".repeat(20_001) })).text).toContain("at most");
        expect((await sendToSession(peers, { id: "busy", message: "hi" })).text).toBe("refused for a reason");
        const ok = await sendToSession(peers, { id: "a", message: " run the tests " });
        expect(ok.text).toContain("It's working: it reads this at its next step.");
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
