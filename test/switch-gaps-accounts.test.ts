// #409's switch matrix, account switches: while on an API model, a fork's, an idle compaction's, a message's during
// the switch, a message held since a restart, after the CLI's own compaction. In the GUI server's Runtime with the
// fake CLIs and the mock API (test/helpers/switch-app.ts). An account whose CLI shares the native session's history
// (a Harness-made one) resumes it natively; one on an existing folder starts a new one, handed the conversation.

import { describe, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import { API, CLIS, TOKEN, alive, count, mode, real, until, switchKit, type Cli } from "./helpers/switch-app";

const iso = isolate();
const { app, account, withApp } = await switchKit(iso);
const { saveQueue } = await import("../src/agent/queue-store");
const { backendModel } = await import("../src/backends/types");
import type { BackendTurn } from "../src/backends/types";

// Gap 1: the account changes while the session is on an API model; then back on the CLI.
for (const provider of CLIS)
    for (const live of [true, false])
        describe(`gap 1: ${provider}, ${mode(live)}: an account switch while on an API model, then back on the CLI`, () => {
            test("an account sharing the history: the earlier process goes, and the next turn resumes the same session under the new home, with the missed turn once", async () => {
                const shared = account(provider, "shared");
                await withApp(provider, live, async (h) => {
                    expect((await h.send("first")).status).toBe("done");
                    const id = h.rt.session.backends.get(provider)!.id;
                    const pid = h.lastProc().pid;
                    expect(await h.rt.switchModel(API)).toBe(true);
                    expect((await h.send(`hello ${TOKEN}`)).status).toBe("done");
                    await h.rt.setAccount(provider, shared.id);
                    expect(alive(pid)).toBe(false);
                    expect(h.rt.session.backends.get(provider)?.id).toBe(id);
                    expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                    expect((await h.send("go on")).status).toBe("done");
                    expect(h.opened()).toEqual(["new", id]);
                    expect(h.lastProc().home).toBe(real(shared.folder));
                    // Only what it missed, not the whole conversation.
                    expect(h.prompts().at(-1)!.startsWith("<conversation-so-far>\nWhile another model or account answered in this session")).toBe(true);
                    expect([count(h.prompts().at(-1)!, TOKEN), count(h.prompts().at(-1)!, "User: first")]).toEqual([1, 0]);
                    expect((await h.send("and again")).status).toBe("done");
                    expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
                });
            }, 30_000);

            // And back on Default (#413, #422): its own earlier session comes back, sent only what it missed.
            test("an existing-folder account: a new session under its home, handed the whole conversation once; back on Default, its own session again", async () => {
                const own = account(provider, "own");
                await withApp(
                    provider,
                    live,
                    async (h) => {
                        expect((await h.send("first words")).status).toBe("done");
                        const id = h.rt.session.backends.get(provider)!.id;
                        const pid = h.lastProc().pid;
                        expect(await h.rt.switchModel(API)).toBe(true);
                        expect((await h.send(`hello ${TOKEN}`)).status).toBe("done");
                        await h.rt.setAccount(provider, own.id);
                        expect(alive(pid)).toBe(false);
                        expect(h.rt.session.backends.has(provider)).toBe(false);
                        expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                        expect((await h.send("go on")).status).toBe("done");
                        expect(h.opened()).toEqual(["new", "new"]);
                        expect(h.lastProc().home).toBe(real(own.folder));
                        const p = h.prompts().at(-1)!;
                        expect(count(p, "<conversation-so-far>")).toBe(1);
                        expect(count(p, "first words")).toBe(1);
                        expect(count(p, TOKEN)).toBe(1);
                        expect((await h.send("and again")).status).toBe("done");
                        expect(h.prompts().at(-1)).not.toContain("conversation-so-far");
                        expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
                        const elsewhere = h.rt.session.backends.get(provider)!.id;
                        expect(elsewhere).not.toBe(id);
                        await h.rt.setAccount(provider, "default");
                        expect((await h.send("back home")).status).toBe("done");
                        expect(h.opened().at(-1)).toBe(id);
                        expect(h.lastProc().home).toBe(real(process.env[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]));
                        const back = h.prompts().at(-1)!;
                        expect(back.startsWith("<conversation-so-far>\nWhile another model or account answered in this session")).toBe(true);
                        expect([count(back, "User: first words"), count(back, TOKEN), count(back, "User: go on"), count(back, "User: and again"), count(back, "back home")]).toEqual([0, 1, 1, 1, 1]);
                    },
                    // Codex's threads each with an id of their own, as Codex's are.
                    { env: { FAKE_UNIQUE_THREADS: "1" } },
                );
            }, 30_000);
        });

// Gap 6: a fork (sharing the native session) switched to an account whose CLI shares the history, a process per turn:
// the fork's first turn forks the native session there, under the new home.
for (const provider of CLIS)
    test(`gap 6: ${provider}, per run: a fork switched to an account sharing the history forks the native session under the new home`, async () => {
        const shared = account(provider, "shared");
        await withApp(provider, false, async (h) => {
            expect((await h.send("first")).status).toBe("done");
            const id = h.rt.session.backends.get(provider)!.id;
            const turn = h.turns().at(-1)!;
            const made = await h.handle("session.fork", { id: h.rt.id, index: turn.prompt!.index, text: turn.prompt!.text, turn: turn.id });
            const fork = h.engine.runtimes.get(made.state.id)!;
            expect(fork.session.backends.get(provider)).toMatchObject({ id, fork: true });
            await fork.setAccount(provider, shared.id);
            // Kept: the new account's CLI finds it.
            expect(fork.session.backends.get(provider)).toMatchObject({ id, fork: true });
            expect((await h.send("in the fork", fork)).status).toBe("done");
            expect(h.opened().at(-1)).toBe(`${id} (fork)`);
            expect(h.lastProc().home).toBe(real(shared.folder));
            // It had everything already: nothing handed over (only the fork's note of the permission mode).
            expect(h.prompts().at(-1)!.startsWith("in the fork")).toBe(true);
            expect(h.prompts().at(-1)).not.toContain("conversation-so-far");
            const own = fork.session.backends.get(provider)!;
            expect(own.fork).toBeUndefined();
            expect(own.id).not.toBe(id);
            // The original, still on Default, forks its own copy there.
            expect((await h.send("in the original")).status).toBe("done");
            expect(h.opened().at(-1)).toBe(`${id} (fork)`);
            expect(h.lastProc().home).not.toBe(real(shared.folder));
        });
    }, 30_000);

/** A CLI stand-in (its provider's id, so an account switch lets it go): each turn and compaction, with its account. */
function scripted(provider: Cli) {
    const calls: { kind: "turn" | "compact"; accountId?: string; aborted?: boolean; done?: boolean }[] = [];
    const o = { compactHold: undefined as Promise<void> | undefined, releaseHold: undefined as Promise<void> | undefined, releases: 0 };
    const backend = {
        agentBackend: true as const,
        adoptsTurns: true,
        def: { id: provider },
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        release: async () => {
            o.releases++;
            await o.releaseHold;
        },
        compact: async (t: BackendTurn) => {
            const c: (typeof calls)[number] = { kind: "compact", accountId: t.accountId };
            calls.push(c);
            if (o.compactHold) await Promise.race([o.compactHold, new Promise((r) => t.signal.addEventListener("abort", r))]);
            c.aborted = t.signal.aborted;
            c.done = true;
            if (t.signal.aborted) return { reason: "aborted" as const, text: "", actions: [] };
            t.session.sessionId("cli-1");
            return { reason: "done" as const, text: "", actions: [] };
        },
        runTurn: async (t: BackendTurn) => {
            calls.push({ kind: "turn", accountId: t.accountId, done: true });
            t.session.sessionId("cli-1");
            t.sink.emit({ type: "text", text: "ok." });
            return { reason: "done" as const, text: "ok.", actions: [] };
        },
    };
    return { backend, calls, o };
}

// Gap 7: an idle compaction and an account switch (session.setAccount).
describe("gap 7: an idle compaction while the account is switched", () => {
    async function setup() {
        const h = await app("claude-code", true);
        const s = scripted("claude-code");
        const model = backendModel("claude-code", "x");
        h.rt.agent!.setModel(model, s.backend as never);
        (h.rt as any).model = model;
        expect((await h.send("first")).status).toBe("done");
        expect(s.calls).toEqual([{ kind: "turn", accountId: "default", done: true }]);
        return { h, ...s };
    }

    test("under way when the switch comes: it gives way first, and nothing goes on under the earlier account", async () => {
        const other = account("claude-code", "shared");
        const { h, calls, o } = await setup();
        try {
            o.compactHold = new Promise(() => {});
            void h.rt.compact(undefined, { idle: true });
            await until(() => h.rt.compactingWhileIdle && calls.length === 2);
            await h.handle("session.setAccount", { id: h.rt.id, provider: "claude-code", accountId: other.id });
            // Stopped before the switch was made, not left running beside it.
            expect(calls[1]).toEqual({ kind: "compact", accountId: "default", aborted: true, done: true });
            expect(h.rt.session.accountId("claude-code")).toBe(other.id);
            expect(h.rt.compactingWhileIdle).toBe(false);
            o.compactHold = undefined;
            expect((await h.send("go on")).status).toBe("done");
            expect(calls.slice(2)).toEqual([{ kind: "turn", accountId: other.id, done: true }]);
        } finally {
            await h.engine.stop();
        }
    }, 30_000);

    test("due while the switch lets the earlier process go: it doesn't run on the earlier account", async () => {
        const other = account("claude-code", "shared");
        const { h, calls, o } = await setup();
        try {
            let open!: () => void;
            o.releaseHold = new Promise<void>((r) => (open = r));
            // A long conversation on a warm cache: it's due now.
            (h.rt.agent as any).idleCompactPlan = (now: number) => ({ fireAt: now, expiresAt: now + 60_000, contextTokens: 250_000 });
            const switching = h.rt.setAccount("claude-code", other.id);
            await until(() => o.releases === 1);
            (h.rt.idleCompact as any).fire();
            await until(() => h.rt.idle);
            open();
            await switching;
            await until(() => h.rt.idle);
            expect(calls.slice(1).filter((c) => c.accountId !== other.id)).toEqual([]);
        } finally {
            await h.engine.stop();
        }
    }, 30_000);

    // Claude Code on a subscription, with its one-hour cache: an idle compaction is planned after the turn. The new
    // account hasn't read the history (as a new model hasn't: Agent.setModel forgets the cache), so the compaction
    // planned on the earlier account's warm cache would read it all afresh, on an account the user just switched to.
    test("planned on the earlier account's cache: it doesn't run after the switch (#421)", async () => {
        const other = account("claude-code", "shared");
        await withApp(
            "claude-code",
            true,
            async (h) => {
                expect((await h.send("first")).status).toBe("done");
                await until(() => h.rt.idleCompact.due !== undefined);
                const due = h.rt.idleCompact.due!;
                await h.rt.setAccount("claude-code", other.id);
                // At its time.
                h.rt.idleCompact.clock = { ...h.rt.idleCompact.clock, now: () => due };
                (h.rt.idleCompact as any).fire();
                await until(() => h.rt.idle);
                expect(h.prompts().filter((p) => p.startsWith("/compact"))).toEqual([]);
                expect(h.rt.agent!.idleCompactPlan(due)).toBeNull();
                // The new account's first turn warms its own cache, and plans its own compaction.
                h.rt.idleCompact.clock = { ...h.rt.idleCompact.clock, now: () => Date.now() };
                expect((await h.send("go on")).status).toBe("done");
                await until(() => h.rt.idleCompact.due !== undefined);
                expect(h.lastProc().home).toBe(real(other.folder));
            },
            { env: { FAKE_CACHE_1H: "250000" } },
        );
    }, 30_000);

    test("a switch of another CLI's account (Codex's, on Claude Code) leaves the planned compaction as it was", async () => {
        const codex = account("codex", "shared");
        await withApp(
            "claude-code",
            true,
            async (h) => {
                expect((await h.send("first")).status).toBe("done");
                await until(() => h.rt.idleCompact.due !== undefined);
                const due = h.rt.idleCompact.due!;
                await h.rt.setAccount("codex", codex.id);
                expect(h.rt.idleCompact.due).toBe(due);
                expect(h.rt.agent!.idleCompactPlan(due)).not.toBeNull();
            },
            { env: { FAKE_CACHE_1H: "250000" } },
        );
    }, 30_000);
});

// Gap 8: the account switch (async: it lets the earlier process go) and a message sent while it does.
for (const provider of CLIS)
    test(`gap 8: ${provider}, live: a message sent while the switch lets the earlier process go runs under the new home, and the release doesn't end it`, async () => {
        const shared = account(provider, "shared");
        await withApp(provider, true, async (h) => {
            expect((await h.send("first")).status).toBe("done");
            const id = h.rt.session.backends.get(provider)!.id;
            const pid = h.lastProc().pid;
            // The new account's process takes a moment over its turn (Claude Code waits for a steer; Codex is slow).
            Object.assign(process.env, provider === "claude-code" ? { FAKE_SCENARIO: "steering" } : { FAKE_TURN_MS: "500" });
            const agent = h.rt.agent!;
            const release = agent.releaseAccountProcess.bind(agent);
            let open!: () => void;
            const gate = new Promise<void>((r) => (open = r));
            let entered = false;
            // The release starts at once, as it does; the switch is held until the message's turn is running.
            agent.releaseAccountProcess = async (p: string) => {
                entered = true;
                const stopped = release(p);
                await gate;
                return stopped;
            };
            const switching = h.rt.setAccount(provider, shared.id);
            await until(() => entered);
            const n = h.turns().length;
            expect(await h.rt.send("go on now")).toEqual({ queued: false });
            await until(() => h.prompts().length === 2 && h.lastProc().pid !== undefined);
            expect(h.rt.busy).toBe(true);
            open();
            await switching;
            await until(() => h.ended(n));
            expect(h.turns().at(-1)!.status).toBe("done");
            expect(h.notices().filter((t) => /error|stopped|restarted/i.test(t))).toEqual([]);
            expect(h.lastProc().home).toBe(real(shared.folder));
            expect(h.opened()).toEqual(["new", id]);
            expect(alive(pid)).toBe(false);
            // Its process wasn't let go by the switch that was under way.
            expect(alive(h.lastProc().pid)).toBe(true);
        });
    }, 30_000);

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

// Gap 9 (lower priority), with an account switch.
for (const provider of CLIS)
    describe(`gap 9: ${provider}`, () => {
        test("live: a message held since a restart, with an image, sent after an account switch: it goes once, with its image, under the new home", async () => {
            const shared = account(provider, "shared");
            await withApp(provider, true, async (h) => {
                expect((await h.send("first")).status).toBe("done");
                const id = h.rt.session.backends.get(provider)!.id;
                // Waiting when the server stopped: held in the queue as the session opens again.
                await h.reopen(() => saveQueue(h.rt.session.path, h.rt.id, [{ text: "look at this image", mode: "queue", attachments: [{ type: "image", mediaType: "image/png", data: PNG }] }]));
                const held = (h.rt as any).queued as { id: number; held?: boolean }[];
                expect(held).toHaveLength(1);
                expect(held[0]!.held).toBe(true);
                await h.rt.setAccount(provider, shared.id);
                const n = h.turns().length;
                expect(await h.rt.sendQueuedNow(held[0]!.id)).toMatchObject({ sent: true });
                await until(() => h.ended(n));
                expect(h.turns().at(-1)!.status).toBe("done");
                expect(h.sent().at(-1)).toMatchObject({ images: 1 });
                expect(count(h.prompts().at(-1)!, "look at this image")).toBe(1);
                expect(h.prompts().filter((p) => p.includes("look at this image"))).toHaveLength(1);
                expect(h.lastProc().home).toBe(real(shared.folder));
                expect(h.opened()).toEqual(["new", id]);
                expect((h.rt as any).queued).toEqual([]);
            });
        }, 30_000);

        test("live: the CLI's own compaction moves its session to a new id; after an account switch the next turn resumes that one, with the missed turn once", async () => {
            const shared = account(provider, "shared");
            await withApp(provider, true, async (h) => {
                expect((await h.send("first")).status).toBe("done");
                const id = h.rt.session.backends.get(provider)!.id;
                expect(await h.rt.switchModel(API)).toBe(true);
                expect((await h.send(`hello ${TOKEN}`)).status).toBe("done");
                expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                // Shared with a fork (/fork): the compaction forks it in place, so the session goes on under a new id.
                expect(h.rt.session.markBackendForked(provider)).toBe(true);
                await h.rt.compact();
                const compacted = h.rt.session.backends.get(provider)!;
                expect(compacted.id).not.toBe(id);
                expect(compacted.fork).toBeUndefined();
                await h.rt.setAccount(provider, shared.id);
                expect(h.rt.session.backends.get(provider)?.id).toBe(compacted.id);
                expect((await h.send("go on now")).status).toBe("done");
                expect(h.opened().at(-1)).toBe(compacted.id);
                expect(h.lastProc().home).toBe(real(shared.folder));
                expect(count(h.prompts().at(-1)!, TOKEN)).toBe(1);
                expect((await h.send("and again")).status).toBe("done");
                expect(count(h.prompts().at(-1)!, TOKEN)).toBe(0);
            });
        }, 30_000);

    });
