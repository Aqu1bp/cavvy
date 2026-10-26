// One native CLI thread per history location (#413): a switch to an account whose CLI can't find the session's native
// thread sets it aside (parked), kept for its place with its own catch-up cursor; a switch back takes it up again. What
// the session file keeps of them, and every change that clears or copies them: rewind, Cavvy's /compact, forks,
// an account removed or re-added. The turns themselves, against the fake CLIs: account-session.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Session } = await import("../src/agent/session");
const { forkSession } = await import("../src/agent/fork");
const { accountPlace, addAccount, removeAccount } = await import("../src/providers/accounts");
import type { Message } from "../src/providers/types";

const root = realpathSync(tempDir("native-threads-"));
afterAll(() => {
    rmSync(root, { recursive: true, force: true });
    iso.cleanup();
});

let n = 0;
const project = () => {
    const p = join(root, `p${++n}`);
    mkdirSync(p, { recursive: true });
    return p;
};
const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }], meta: { kind: "prompt", display: text } });
const reply = (text: string): Message => ({ role: "assistant", content: [{ type: "text", text }], provider: "test", model: "m1", stopReason: "end_turn" });
const lines = (file: string) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));

for (const provider of ["claude-code", "codex"] as const) describe(`${provider}: native threads kept per history location`, () => {
    const tag = provider === "codex" ? "cx" : "cc";
    // Existing folders: each CLI keeps a history of its own there, so none finds Default's threads.
    const own = (name: string) => addAccount(provider, { id: `${tag}-${name}-${++n}`, name, folder: join(realpathSync(tempDir("home-")), "home") }, [root]);

    /** On Default "a" (thread D, 2 messages), then on `custom` "b" (thread C, 4). */
    function roundTrip(persist = true) {
        const custom = own("custom");
        const s = Session.create(project(), { persist });
        s.push(user("a"));
        s.push(reply("A"));
        s.setBackendSession(provider, "D", 2, accountPlace(provider));
        expect(s.setAccount(provider, custom.id)).toBe(true);
        s.push(user("b"));
        s.push(reply("B"));
        s.setBackendSession(provider, "C", 4, accountPlace(provider, custom.id));
        return { s, custom };
    }

    test("a switch to an account with its own history parks the thread for its place; switching back takes it up again, with its own cursor", () => {
        const { s, custom } = roundTrip();
        expect(s.backends.get(provider)).toEqual({ id: "C", synced: 4 });
        expect(s.parkedBackends(provider)).toEqual([{ provider, place: accountPlace(provider), session: { id: "D", synced: 2 } }]);
        expect(s.setAccount(provider, "default")).toBe(true);
        // Default's own: what it has seen stays where it was, so its next prompt carries "b" and "B".
        expect(s.backends.get(provider)).toEqual({ id: "D", synced: 2 });
        expect(s.backendPlace(provider)).toEqual(accountPlace(provider));
        expect(s.backendSession(provider, accountPlace(provider))).toEqual({ id: "D", synced: 2 });
        expect(s.parkedBackends(provider)).toEqual([{ provider, place: accountPlace(provider, custom.id), session: { id: "C", synced: 4 } }]);
        s.release();
        // As saved.
        const back = Session.load(s.path);
        expect(back.backends.get(provider)).toEqual({ id: "D", synced: 2 });
        expect(back.backendPlace(provider)).toEqual(accountPlace(provider));
        expect(back.parkedBackends(provider)).toEqual([{ provider, place: accountPlace(provider, custom.id), session: { id: "C", synced: 4 } }]);
        // And again the other way, after reopening.
        expect(back.setAccount(provider, custom.id)).toBe(true);
        expect(back.backends.get(provider)).toEqual({ id: "C", synced: 4 });
        expect(back.parkedBackends(provider).map((p) => p.session.id)).toEqual(["D"]);
        back.release();
        const again = Session.load(s.path);
        expect(again.backends.get(provider)?.id).toBe("C");
        expect(again.parkedBackends(provider).map((p) => p.session.id)).toEqual(["D"]);
        again.release();
    });

    test("a thread is parked with what it wasn't sent and its fork mark, and taken up with them", () => {
        const custom = own("unsent");
        const s = Session.create(project(), { persist: false });
        s.push(user("a"));
        s.setBackendSession(provider, "D", 1, accountPlace(provider), "<conversation-so-far>missed</conversation-so-far>");
        s.markBackendForked(provider);
        s.setAccount(provider, custom.id);
        expect(s.backends.has(provider)).toBe(false);
        s.setAccount(provider, "default");
        expect(s.backends.get(provider)).toEqual({ id: "D", synced: 1, fork: true, unsent: "<conversation-so-far>missed</conversation-so-far>" });
    });

    test("a thread whose home was replaced (the account re-added elsewhere) is parked, not resumed there; its own home finds it again", () => {
        const s = Session.create(project());
        s.push(user("a"));
        const first = { folder: join(root, `${tag}-first`) };
        const second = { folder: join(root, `${tag}-second`) };
        s.setBackendSession(provider, "T", 1, first);
        expect(s.backendSession(provider, second)).toBeUndefined();
        expect(s.parkedBackends(provider).map((p) => p.session.id)).toEqual(["T"]);
        s.release();
        const back = Session.load(s.path);
        expect(back.backends.has(provider)).toBe(false);
        expect(back.backendSession(provider, second)).toBeUndefined();
        expect(back.backendSession(provider, first)).toEqual({ id: "T", synced: 1 });
        expect(back.parkedBackends(provider)).toEqual([]);
        back.release();
    });

    test("removing an account: its parked thread isn't resumed by an account re-added with another folder, and is where the same folder is", () => {
        const { s, custom } = roundTrip(false);
        s.setAccount(provider, "default");
        removeAccount(provider, custom.id, custom.folder, [root]);
        // Re-added with the same id, in another folder: its CLI can't find C.
        const elsewhere = addAccount(provider, { id: custom.id, name: "Again", folder: join(realpathSync(tempDir("home-")), "home") }, [root]);
        s.setAccount(provider, elsewhere.id);
        expect(s.backends.has(provider)).toBe(false);
        expect(s.backendSession(provider, accountPlace(provider, elsewhere.id))).toBeUndefined();
        s.setAccount(provider, "default");
        expect(s.backends.get(provider)?.id).toBe("D");
        removeAccount(provider, elsewhere.id, elsewhere.folder, [root]);
        // Re-added at the folder C lives in: its CLI finds it there.
        const same = addAccount(provider, { id: custom.id, name: "Same", folder: custom.folder }, [root]);
        s.setAccount(provider, same.id);
        expect(s.backends.get(provider)).toEqual({ id: "C", synced: 4 });
        removeAccount(provider, same.id, same.folder, [root]);
    });

    describe("rewind", () => {
        test("drops the threads that saw past the rewind point, parked or not, and keeps the others with their cursors", () => {
            const { s, custom } = roundTrip();
            s.push(user("c"));
            s.push(reply("C"));
            s.setBackendSession(provider, "C", 6);
            // C saw past 4; D (at 2) didn't.
            s.rewind(4);
            expect(s.backends.has(provider)).toBe(false);
            expect(s.parkedBackends(provider).map((p) => [p.session.id, p.session.synced])).toEqual([["D", 2]]);
            s.setAccount(provider, "default");
            expect(s.backends.get(provider)).toEqual({ id: "D", synced: 2 });
            s.setAccount(provider, custom.id);
            // C is gone: a new thread on custom gets the whole conversation.
            expect(s.backends.has(provider)).toBe(false);
            s.release();
            const back = Session.load(s.path);
            expect(back.backends.has(provider)).toBe(false);
            expect(back.parkedBackends(provider).map((p) => [p.session.id, p.session.synced])).toEqual([["D", 2]]);
            // Back before D's cursor: D goes too.
            back.rewind(1);
            expect(back.parkedBackends(provider)).toEqual([]);
            back.release();
            expect(Session.load(s.path).parkedBackends(provider)).toEqual([]);
        });

        test("to exactly a parked thread's cursor: kept, with nothing missed", () => {
            const { s } = roundTrip(false);
            s.rewind(2);
            expect(s.backends.has(provider)).toBe(false);
            expect(s.parkedBackends(provider).map((p) => [p.session.id, p.session.synced])).toEqual([["D", 2]]);
        });
    });

    test("Cavvy's /compact clears every thread, parked ones too", () => {
        const { s, custom } = roundTrip();
        s.compact("summary", [user("kept")]);
        expect(s.backends.size).toBe(0);
        expect(s.parkedBackends()).toEqual([]);
        s.setAccount(provider, "default");
        expect(s.backends.has(provider)).toBe(false);
        s.setAccount(provider, custom.id);
        expect(s.backends.has(provider)).toBe(false);
        s.release();
        const back = Session.load(s.path);
        expect(back.backends.size).toBe(0);
        expect(back.parkedBackends()).toEqual([]);
        back.release();
    });

    describe("forks", () => {
        test("Session.fork sharing backends copies the parked threads too, to be forked natively", () => {
            const { s } = roundTrip(false);
            const copy = s.fork({ persist: false, shareBackends: true });
            expect(copy.backends.get(provider)).toEqual({ id: "C", synced: 4, fork: true });
            expect(copy.parkedBackends(provider)).toEqual([{ provider, place: accountPlace(provider), session: { id: "D", synced: 2, fork: true } }]);
            copy.setAccount(provider, "default");
            expect(copy.backendSession(provider, accountPlace(provider))).toEqual({ id: "D", synced: 2, fork: true });
            // Not without sharing.
            expect(s.fork({ persist: false }).parkedBackends()).toEqual([]);
        });

        test("forkSession copies the parked threads that saw no further than the cut, and marks the original's shared", () => {
            const { s, custom } = roundTrip();
            for (const cut of [4, 2]) {
                const f = forkSession(s, { cut });
                f.release();
                const reopened = Session.load(f.path);
                try {
                    expect(reopened.accountId(provider)).toBe(custom.id);
                    // C saw 4 messages: only a fork at 4 has it.
                    expect(reopened.backends.get(provider)).toEqual(cut === 4 ? { id: "C", synced: 4, fork: true } : undefined);
                    expect(reopened.parkedBackends(provider)).toEqual([{ provider, place: accountPlace(provider), session: { id: "D", synced: 2, fork: true } }]);
                    reopened.setAccount(provider, "default");
                    expect(reopened.backends.get(provider)).toEqual({ id: "D", synced: 2, fork: true });
                } finally { reopened.release(); }
            }
            // The original only forks them from now on, after reopening too.
            expect(s.parkedBackends(provider)[0]?.session.fork).toBe(true);
            s.release();
            const back = Session.load(s.path);
            expect(back.parkedBackends(provider)[0]?.session).toEqual({ id: "D", synced: 2, fork: true });
            back.release();
        });

        test("a parked thread that saw past the cut isn't copied", () => {
            const custom = own("past-cut");
            const s = Session.create(project());
            s.push(user("a"));
            s.push(reply("A"));
            s.push(user("b"));
            s.push(reply("B"));
            s.setBackendSession(provider, "D", 4, accountPlace(provider));
            s.setAccount(provider, custom.id);
            const f = forkSession(s, { cut: 2 });
            expect(f.parkedBackends()).toEqual([]);
            expect(s.parkedBackends(provider)[0]?.session.fork).toBeUndefined();
            f.release();
            s.release();
        });
    });

    describe("older session files", () => {
        test("a file with no parked lines loads as it did: a switch away had forgotten the thread", () => {
            const custom = own("old");
            const s = Session.create(project());
            s.push(user("a"));
            s.release();
            const place = accountPlace(provider);
            // As the version before #413 wrote a switch away from Default's thread, and a thread on the new account.
            appendFileSync(s.path, [
                { t: "backend", provider, id: "D", synced: 1, folder: place.folder, ...(place.history ? { history: place.history } : {}) },
                { t: "backend", provider, id: null },
                { t: "account", provider, id: custom.id },
                { t: "backend", provider, id: "C", synced: 1, folder: custom.folder },
            ].map((l) => JSON.stringify(l) + "\n").join(""));
            const back = Session.load(s.path);
            expect(back.backends.get(provider)).toEqual({ id: "C", synced: 1 });
            expect(back.parkedBackends()).toEqual([]);
            // Nothing was kept for Default: a new thread there.
            back.setAccount(provider, "default");
            expect(back.backends.has(provider)).toBe(false);
            expect(back.parkedBackends(provider).map((p) => p.session.id)).toEqual(["C"]);
            back.release();
        });

        test("a thread with no home saved (from before accounts) is Default's: parked for Default's home, and taken up there", () => {
            const custom = own("legacy");
            const s = Session.create(project(), { persist: false });
            s.push(user("a"));
            s.setBackendSession(provider, "legacy", 1);
            s.setAccount(provider, custom.id);
            expect(s.parkedBackends(provider)).toEqual([{ provider, place: accountPlace(provider), session: { id: "legacy", synced: 1 } }]);
            s.setAccount(provider, "default");
            expect(s.backends.get(provider)?.id).toBe("legacy");
        });

        test("what an older version reads of a newer file: only the backend lines, as it wrote them", () => {
            const { s } = roundTrip();
            s.setAccount(provider, "default");
            s.release();
            // The parked threads are lines of their own, which older versions skip.
            const kinds = lines(s.path).filter((l) => l.provider === provider && (l.t === "backend" || l.t === "parked")).map((l) => `${l.t}:${l.id}`);
            // Each written before what it replaces is dropped, so a torn write can't lose one (see the next test).
            expect(kinds).toEqual(["backend:D", "parked:D", "backend:null", "backend:C", "parked:C", "backend:null", "backend:D", "parked:null"]);
        });

        test("a torn switch (the thread taken up, its parked line not yet dropped) loads it once, as the session's", () => {
            const { s } = roundTrip();
            s.release();
            const place = accountPlace(provider);
            // Taken up: its backend line made it to the file, the parked one's removal didn't.
            appendFileSync(s.path, JSON.stringify({ t: "backend", provider, id: "D", synced: 2, folder: place.folder, ...(place.history ? { history: place.history } : {}) }) + "\n");
            const back = Session.load(s.path);
            expect(back.backends.get(provider)?.id).toBe("D");
            expect(back.parkedBackends(provider)).toEqual([]);
            back.release();
        });

        /** On Default, thread D at 2; then a switch away torn after its parked line (no forget line, no account line). */
        function tornFile() {
            const s = Session.create(project());
            s.push(user("a"));
            s.push(reply("A"));
            s.setBackendSession(provider, "D", 2, accountPlace(provider));
            s.release();
            const place = accountPlace(provider);
            appendFileSync(s.path, JSON.stringify({ t: "parked", provider, id: "D", synced: 2, folder: place.folder, ...(place.history ? { history: place.history } : {}) }) + "\n");
            return s;
        }
        function tornPark() {
            const s = tornFile();
            const back = Session.load(s.path);
            expect(back.backends.get(provider)).toEqual({ id: "D", synced: 2 });
            expect(back.parkedBackends(provider)).toEqual([]);
            return { s, back };
        }

        // PR #422 review: the stale parked line stays in the file, under what the session goes on to do with D.
        test("a torn switch away, then D goes on and is rewound past: no stale copy of D comes back", () => {
            const custom = own("torn-rewind");
            const { s, back } = tornPark();
            back.push(user("b"));
            back.push(reply("B"));
            back.setBackendSession(provider, "D", 4);
            // D saw "b": a rewind to 2 drops it.
            back.rewind(2);
            expect(back.backends.has(provider)).toBe(false);
            back.release();
            const again = Session.load(s.path);
            expect(again.backends.has(provider)).toBe(false);
            expect(again.parkedBackends(provider)).toEqual([]);
            again.setAccount(provider, custom.id);
            again.setAccount(provider, "default");
            expect(again.backends.has(provider)).toBe(false);
            again.release();
        });

        test("a torn switch away, then D forgotten (resumeFailed): no stale copy of D comes back", () => {
            const { s, back } = tornPark();
            back.forgetBackendSession(provider);
            back.release();
            const again = Session.load(s.path);
            expect(again.parkedBackends(provider)).toEqual([]);
            expect(again.backendSession(provider, accountPlace(provider))).toBeUndefined();
            again.release();
        });

        test("a read-only load of a torn switch writes nothing; the next writable one repairs it", () => {
            const s = tornFile();
            const before = readFileSync(s.path, "utf8");
            const readOnly = Session.load(s.path, { persist: false });
            expect(readOnly.parkedBackends(provider)).toEqual([]);
            readOnly.release();
            expect(readFileSync(s.path, "utf8")).toBe(before);
            const writable = Session.load(s.path);
            writable.forgetBackendSession(provider);
            writable.release();
            expect(Session.load(s.path, { persist: false }).parkedBackends(provider)).toEqual([]);
        });
    });
});

// Randomized switches (#409, #413): CLI turns, other models' turns, account switches among Default, a Cavvy-made
// account (Default's history) and two existing-folder accounts (their own), rewinds, Cavvy's /compact, reopening, and
// threads lost from their history. A scripted CLI checks each prompt against a model of what each history's thread
// has seen: every message reaches the thread that answers exactly once, a thread is resumed only in its own history,
// and a new one is started only where no thread can go on.
describe("randomized account switches against a model of each history's thread", () => {
    const { Agent } = require("../src/agent/agent") as typeof import("../src/agent/agent");
    const { PermissionChecker } = require("../src/permissions/checker") as typeof import("../src/permissions/checker");
    const { BUILTIN_TOOLS } = require("../src/tools/index") as typeof import("../src/tools/index");
    const provider = "claude-code";
    mkdirSync(join(process.env.CLAUDE_CONFIG_DIR!, "projects"), { recursive: true });
    const accounts = [
        "default",
        addAccount(provider, { id: "rand-shared", name: "Shared" }, [root]).id,
        addAccount(provider, { id: "rand-own1", name: "Own one", folder: join(realpathSync(tempDir("home-")), "home") }, [root]).id,
        addAccount(provider, { id: "rand-own2", name: "Own two", folder: join(realpathSync(tempDir("home-")), "home") }, [root]).id,
    ];
    const historyOf = (id: string) => accountPlace(provider, id).history!;

    test("a Cavvy-made account shares Default's history; the existing-folder ones don't", () => {
        expect(historyOf(accounts[1]!)).toBe(historyOf("default"));
        expect(new Set(accounts.map(historyOf)).size).toBe(3);
    });

    /** A small seeded generator (mulberry32). */
    const random = (seed: number) => () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };

    // 122, 204 and 249 tear a switch away right after its parked line, then end the thread (a rewind, a lost one):
    // they found the stale parked line of PR #422's review.
    for (const seed of [...Array.from({ length: 40 }, (_, i) => i + 1), 122, 204, 249])
        test(`seed ${seed}`, async () => {
            const rnd = random(seed);
            const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)]!;
            const cwd = project();
            let session = Session.create(cwd);
            /** The scripted CLI's threads: the history each lives in, the compaction epoch it's from, what it has seen. */
            const threads = new Map<string, { history: string; epoch: number; seen: Map<string, number>; lost?: true }>();
            /** The model: the thread each history should go on with, and how much of the session it has seen. */
            const model = new Map<string, { id: string; synced: number }>();
            const problems: string[] = [];
            let epoch = 0;
            let marker = 0;
            let made = 0;
            const cli = {
                agentBackend: true as const,
                setMode() {},
                listModels: async () => [],
                stream: async () => { throw new Error("not used"); },
                compact: async () => ({ reason: "done" as const, text: "", actions: [] }),
                runTurn: async (t: import("../src/backends/types").BackendTurn) => {
                    const history = historyOf(session.accountId(provider));
                    const expected = model.get(history);
                    let id = t.resumeId;
                    if (id) {
                        const known = threads.get(id);
                        if (known?.lost) return { reason: "error" as const, text: "", actions: [], error: "No conversation found with session ID", resumeFailed: true };
                        if (!known || known.history !== history) problems.push(`resumed ${id} in a history that can't find it`);
                        else if (known.epoch !== epoch) problems.push(`resumed ${id} across a compaction`);
                        if (expected?.id !== id) problems.push(`resumed ${id} where ${expected?.id ?? "a new thread"} goes on`);
                    } else {
                        if (expected && !threads.get(expected.id)?.lost) problems.push(`a new thread where ${expected.id} goes on`);
                        id = `t${++made}`;
                        threads.set(id, { history, epoch, seen: new Map() });
                    }
                    const thread = threads.get(id)!;
                    t.session.sessionId(id);
                    for (const m of t.prompt.match(/\b[mao]\d+\b/g) ?? []) thread.seen.set(m, (thread.seen.get(m) ?? 0) + 1);
                    const answer = `a${++marker}`;
                    thread.seen.set(answer, 1);
                    t.sink.emit({ type: "text", text: answer });
                    return { reason: "done" as const, text: answer, actions: [] };
                },
            };
            const make = (s: InstanceType<typeof Session>) => new Agent({
                session: s,
                model: { provider, id: "default", effortLevels: ["low", "high"] },
                client: cli as never,
                settings: () => ({ effort: "high", delegation: false }),
                checker: new PermissionChecker(() => ({}), cwd),
                tools: BUILTIN_TOOLS,
                mode: { get: () => "plan", set: () => {} },
                toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
                host: { emit: () => {}, ui: {}, askPermission: async () => ({ allow: false }) },
            });
            let agent = make(session);
            const steps: string[] = [];
            try {
                for (let step = 0; step < 60 && !problems.length; step++) {
                    const r = rnd();
                    if (r < 0.35) {
                        steps.push("turn");
                        expect(await agent.run([{ type: "text", text: `m${++marker}` }], { signal: new AbortController().signal })).toBe("done");
                        const id = session.backends.get(provider)!.id;
                        model.set(historyOf(session.accountId(provider)), { id, synced: session.messages.length });
                        // Every message of the session reached the thread that answered, once.
                        const seen = threads.get(id)!.seen;
                        for (const m of session.messages.flatMap((x) => JSON.stringify(x.content).match(/\b[mao]\d+\b/g) ?? []))
                            if (seen.get(m) !== 1) problems.push(`${id} has seen ${m} ${seen.get(m) ?? 0} times`);
                    } else if (r < 0.55) {
                        steps.push("other model");
                        session.push(user(`m${++marker}`));
                        session.push({ ...reply(`o${marker}`), provider: "mock", model: "mock-opus" });
                    } else if (r < 0.8) {
                        const to = pick(accounts);
                        const saved = () => (existsSync(session.path) ? readFileSync(session.path, "utf8").split("\n").filter(Boolean) : []);
                        const before = saved().length;
                        session.setAccount(provider, to);
                        const all = saved();
                        const added = all.length - before;
                        if (added > 1 && rnd() < 0.3) {
                            // Torn (Cavvy died part way through the switch's lines): what made it to the file is
                            // reopened. The account line is the last, so the switch didn't happen; the model is as it was.
                            const kept = 1 + Math.floor(rnd() * (added - 1));
                            steps.push(`switch to ${to}, torn after ${kept} of its ${added} lines`);
                            await agent.dispose();
                            session.release();
                            writeFileSync(session.path, all.slice(0, before + kept).join("\n") + "\n");
                            session = Session.load(session.path);
                            agent = make(session);
                        } else steps.push(`switch to ${to}`);
                    } else if (r < 0.87) {
                        const count = Math.floor(rnd() * (session.messages.length + 1));
                        steps.push(`rewind to ${count}`);
                        session.rewind(count);
                        for (const [h, slot] of model) if (slot.synced > count) model.delete(h);
                    } else if (r < 0.9) {
                        steps.push("compact");
                        session.compact("summary", []);
                        epoch++;
                        model.clear();
                    } else if (r < 0.96 && existsSync(session.path)) {
                        steps.push("reopen");
                        await agent.dispose();
                        session.release();
                        session = Session.load(session.path);
                        agent = make(session);
                    } else {
                        // Gone from its history (deleted, expired): resuming it fails, and a new one gets everything.
                        const slot = model.get(pick([...model.keys()]));
                        steps.push(`lose ${slot?.id ?? "nothing"}`);
                        if (slot) threads.get(slot.id)!.lost = true;
                    }
                }
                expect({ problems, steps }).toEqual({ problems: [], steps });
            } finally {
                await agent.dispose();
                session.release();
            }
        });
});
