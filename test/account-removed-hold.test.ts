// A session whose CLI account was removed (#410): its next message is held, never run on an account the user didn't
// choose. Nothing is stored or sent; the session asks for an account; picking one sends the message once, on that
// account, and a later switch doesn't send it again as missed context. Through the desktop's Engine and Runtime and
// the terminal's App, with the fake `claude` and `codex` (test/fixtures), live and with a process per run.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { SessionSnapshot } from "../src/server/protocol";

const iso = isolate();
const root = realpathSync(tempDir("account-removed-hold-"));
const { addAccount, listAccounts, removeAccount } = await import("../src/providers/accounts");
const { saveAgentConfig } = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Engine } = await import("../src/server/engine");
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { stripAnsi } = await import("../src/ui/ansi");
const { backendModel } = await import("../src/backends/types");

// Bypass mode, so Codex's command runs without asking.
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ permissions: { allowBypass: true } }));
const log = join(root, "cli.jsonl");
const fakes: Record<string, string> = {};
for (const [provider, fixture] of [["claude-code", "fake-claude.ts"], ["codex", "fake-codex.ts"]] as const) {
    fakes[provider] = join(root, provider);
    writeFileSync(fakes[provider], `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`);
    chmodSync(fakes[provider], 0o700);
}
beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    process.env.FAKE_LOG = log;
    process.env.FAKE_SCENARIO = "silent";
    process.env.FAKE_CODEX_SCENARIO = "cmd";
    rmSync(log, { force: true });
    for (const provider of ["claude-code", "codex"]) {
        saveAgentConfig(provider, { path: fakes[provider], accounts: [], defaultAccount: "default" });
        forgetClient(provider);
    }
});
afterAll(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    iso.cleanup();
    rmSync(root, { recursive: true, force: true });
});

async function until(done: () => boolean, what: string, ms = 20_000) {
    const end = Date.now() + ms;
    while (!done()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await Bun.sleep(10);
    }
}

/** The prompts the fake CLIs were sent that say `tag`. */
function sent(tag: string): number {
    if (!existsSync(log)) return 0;
    return readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l))
        .filter((l) => l.received && (l.received.type === "user" || l.received.method === "turn/start") && JSON.stringify(l.received).includes(tag)).length;
}
/** The prompt the CLIs were last sent, as JSON. */
function lastSent(): string {
    if (!existsSync(log)) return "";
    const prompts = readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.received?.type === "user" || l.received?.method === "turn/start");
    return JSON.stringify(prompts.at(-1)?.received ?? "");
}
/** The user messages in the session that say `tag`. */
const stored = (session: { messages: { role: string; content: unknown }[] }, tag: string) => session.messages.filter((m) => m.role === "user" && JSON.stringify(m.content).includes(tag)).length;
const defaultFolder = (provider: string) => realpathSync(listAccounts(provider)[0]!.folder);
const name = (provider: string) => (provider === "codex" ? "Codex" : "Claude Code");
const held = (provider: string, id: string) => `The ${name(provider)} account this session used ("${id}") was removed. Pick an account for ${name(provider)} to send your message.`;

const notices = (rt: { snapshot(): SessionSnapshot }) => rt.snapshot().turns.flatMap((t) => t.blocks.flatMap((b) => (b.t === "notice" ? [(b as unknown as { text: string }).text] : [])));

for (const provider of ["claude-code", "codex"] as const) for (const live of [true, false]) describe(`${provider}, ${live ? "live CLI sessions" : "a process per run"}`, () => {
    const tag = `${provider === "codex" ? "cx" : "cc"}-${live ? "live" : "run"}`;

    test("desktop: removed while idle, the next message is held (nothing stored or sent); picking Default sends it once there", async () => {
        const cwd = realpathSync(tempDir("account-removed-rt-"));
        const engine = new Engine({ startCwd: cwd, listModels: async () => [] });
        const client = { subs: new Set<string>(), send() {} };
        const work = addAccount(provider, { id: `${tag}-work`, name: "Work" });
        const next = addAccount(provider, { id: `${tag}-next`, name: "Next" });
        const rt = await engine.createSession(cwd, { model: `${provider}:default`, mode: "bypassPermissions" });
        if (!live) (rt as any).ws.settings = { ...(rt as any).ws.settings, agentCli: { liveSessions: false } };
        const setAccount = (id: string) => engine.handle(client, "session.setAccount", { id: rt.id, provider, accountId: id });
        const send = (text: string) => engine.handle(client, "session.send", { id: rt.id, text }) as Promise<{ queued: boolean }>;
        try {
            await setAccount(work.id);
            await send("FIRST-410 on work");
            await until(() => !rt.busy && stored(rt.session, "FIRST-410") === 1, "the first turn");
            expect(rt.session.backendPlace(provider)?.folder).toBe(realpathSync(work.folder));

            // Idle: removing it is allowed.
            await engine.handle(client, "accounts.remove", { provider, id: work.id, confirmedFolder: work.folder });
            const before = structuredClone(rt.session.messages);
            expect(await send("HELD-410 please")).toEqual({ queued: true });
            await Bun.sleep(300);
            expect(rt.busy).toBe(false);
            expect(rt.session.messages).toEqual(before);
            expect(sent("HELD-410")).toBe(0);
            const state = rt.snapshot().state;
            expect(state.queued).toEqual(["HELD-410 please"]);
            expect(state.queuedModes).toEqual(["held"]);
            expect(state.queuedWhy).toEqual([held(provider, work.id)]);
            expect(state.accountNeeded).toBe(provider);
            expect(notices(rt)).toContain(held(provider, work.id));
            expect(notices(rt).join("\n")).not.toContain("Unexpected error");
            // A second message waits with it, in order.
            expect(await send("HELD-410 also")).toEqual({ queued: true });
            expect(rt.snapshot().state.queued).toEqual(["HELD-410 please", "HELD-410 also"]);

            // Picking Default sends them, each once, there.
            await setAccount("default");
            await until(() => !rt.busy && stored(rt.session, "HELD-410 also") === 1 && !rt.snapshot().state.queued.length, "the held messages");
            expect(stored(rt.session, "HELD-410 please")).toBe(1);
            expect(sent("HELD-410 please")).toBe(1);
            expect(sent("HELD-410 also")).toBe(1);
            expect(rt.session.messages.slice(0, before.length)).toEqual(before);
            expect(rt.session.backendPlace(provider)?.folder).toBe(defaultFolder(provider));
            expect(rt.snapshot().state.accountNeeded).toBeUndefined();

            // A later switch (to an account that resumes the same native session) sends only what's new.
            await setAccount(next.id);
            await send("AFTER-410");
            await until(() => !rt.busy && stored(rt.session, "AFTER-410") === 1, "the turn after");
            expect(lastSent()).toContain("AFTER-410");
            expect(lastSent()).not.toContain("HELD-410");
            expect(sent("HELD-410 please")).toBe(1);
            expect(notices(rt).join("\n")).not.toContain("Unexpected error");
        } finally {
            await engine.stop();
            removeAccount(provider, next.id, next.folder);
            rmSync(cwd, { recursive: true, force: true });
        }
    }, 60_000);

    test("terminal: removed while idle, the next message is held (nothing stored or sent); /account Default sends it once there", async () => {
        const cwd = realpathSync(tempDir("account-removed-tui-"));
        const work = addAccount(provider, { id: `${tag}-twork`, name: "Work" });
        const next = addAccount(provider, { id: `${tag}-tnext`, name: "Next" });
        const { app, a, text } = await terminal(provider, cwd, live);
        try {
            await app.setAccount(provider, work.id);
            await app.submitText("FIRST-410 on work");
            expect(app.session.backendPlace(provider)?.folder).toBe(realpathSync(work.folder));

            removeAccount(provider, work.id, work.folder, [cwd]);
            const before = structuredClone(app.session.messages);
            await app.submitText("HELD-410 please");
            await Bun.sleep(300);
            expect(app.busy).toBe(false);
            expect(app.session.messages).toEqual(before);
            expect(sent("HELD-410")).toBe(0);
            expect(text()).toContain(held(provider, work.id));
            expect(text()).not.toContain("Unexpected error");
            expect(a.heldForAccount.drafts.map((d: { text: string }) => d.text)).toEqual(["HELD-410 please"]);

            await app.setAccount(provider, "default");
            await until(() => !app.busy && stored(app.session, "HELD-410") === 1, "the held message");
            expect(sent("HELD-410")).toBe(1);
            expect(app.session.backendPlace(provider)?.folder).toBe(defaultFolder(provider));
            expect(a.heldForAccount).toBeUndefined();

            await app.setAccount(provider, next.id);
            await app.submitText("AFTER-410");
            expect(stored(app.session, "AFTER-410")).toBe(1);
            expect(lastSent()).toContain("AFTER-410");
            expect(lastSent()).not.toContain("HELD-410");
            expect(sent("HELD-410")).toBe(1);
            expect(text()).not.toContain("Unexpected error");
        } finally {
            await app.agent?.dispose();
            removeAccount(provider, next.id, next.folder, [cwd]);
            rmSync(cwd, { recursive: true, force: true });
        }
    }, 60_000);
});

/** A terminal app on the fake CLI, with the screen kept as text. */
async function terminal(provider: string, cwd: string, live = true, persist = false) {
    const app = new App({ cwd, trusted: true, mode: "bypassPermissions", allowBypass: true, startupNotes: [] });
    const printed: string[] = [];
    const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(200) : Array.isArray(l) ? l : [l])), {});
    (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {}, suspend() {}, resume() {} };
    (app as any).renderLive = () => {};
    if (!live) (app as any).settings = { ...(app as any).settings, agentCli: { liveSessions: false } };
    app.session = Session.create(cwd, { persist });
    app.model = backendModel(provider, "default");
    app.client = await clientFor(provider);
    app.makeAgent();
    return { app, a: app as any, text: () => printed.map(stripAnsi).join("\n") };
}

for (const provider of ["claude-code", "codex"] as const) {
    const tag = provider === "codex" ? "cx" : "cc";

    test(`${provider} desktop: a session loaded from disk whose account was removed holds its message, and sends it once an account is picked`, async () => {
        const cwd = realpathSync(tempDir("account-removed-load-"));
        const work = addAccount(provider, { id: `${tag}-lwork`, name: "Work" });
        const client = { subs: new Set<string>(), send() {} };
        const first = new Engine({ startCwd: cwd, listModels: async () => [] });
        const made = await first.createSession(cwd, { model: `${provider}:default`, mode: "bypassPermissions" });
        const id = made.id;
        await first.handle(client, "session.setAccount", { id, provider, accountId: work.id });
        await first.handle(client, "session.send", { id, text: "FIRST-410 before the restart" });
        await until(() => !made.busy && stored(made.session, "FIRST-410") === 1, "the first turn");
        await first.stop();
        // Removed while Cavvy was closed.
        removeAccount(provider, work.id, work.folder, [cwd]);

        const engine = new Engine({ startCwd: cwd, listModels: async () => [] });
        try {
            await engine.handle(client, "session.open", { id });
            const rt = engine.runtimes.get(id)!;
            await rt.ready;
            await engine.handle(client, "session.setMode", { id, mode: "bypassPermissions" });
            expect(rt.session.accountId(provider)).toBe(work.id);
            const before = structuredClone(rt.session.messages);
            expect(await engine.handle(client, "session.send", { id, text: "LOADED-410" })).toEqual({ queued: true });
            await Bun.sleep(300);
            expect(rt.busy).toBe(false);
            expect(rt.session.messages).toEqual(before);
            expect(sent("LOADED-410")).toBe(0);
            expect(rt.snapshot().state.accountNeeded).toBe(provider);
            expect(notices(rt)).toContain(held(provider, work.id));

            await engine.handle(client, "session.setAccount", { id, provider, accountId: "default" });
            await until(() => !rt.busy && stored(rt.session, "LOADED-410") === 1, "the held message");
            expect(sent("LOADED-410")).toBe(1);
            expect(rt.session.backendPlace(provider)?.folder).toBe(defaultFolder(provider));
        } finally {
            await engine.stop();
            rmSync(cwd, { recursive: true, force: true });
        }
    }, 60_000);

    test(`${provider} desktop: removed while a message waits behind a running turn, it's held when that turn ends, and sent once after`, async () => {
        const cwd = realpathSync(tempDir("account-removed-queue-"));
        const work = addAccount(provider, { id: `${tag}-qwork`, name: "Work" });
        // A turn that works for a while: long enough to queue a message and remove the account meanwhile.
        if (provider === "codex") process.env.FAKE_TURN_MS = "1500";
        else process.env.FAKE_SCENARIO = "steering";
        const engine = new Engine({ startCwd: cwd, listModels: async () => [] });
        const client = { subs: new Set<string>(), send() {} };
        const rt = await engine.createSession(cwd, { model: `${provider}:default`, mode: "bypassPermissions" });
        try {
            await engine.handle(client, "session.setAccount", { id: rt.id, provider, accountId: work.id });
            await engine.handle(client, "session.send", { id: rt.id, text: "RUNNING-410" });
            await until(() => rt.busy && sent("RUNNING-410") === 1, "the running turn");
            expect(await engine.handle(client, "session.send", { id: rt.id, text: "QUEUED-410", mode: "queue" })).toEqual({ queued: true });
            // The engine refuses it while the turn runs; another Cavvy (the terminal) sharing the accounts doesn't ask.
            await expect(engine.handle(client, "accounts.remove", { provider, id: work.id, confirmedFolder: work.folder })).rejects.toMatchObject({ code: "busy" });
            removeAccount(provider, work.id, work.folder, [cwd]);
            await until(() => !rt.busy && rt.snapshot().state.queuedModes?.[0] === "held", "the turn's end");
            await Bun.sleep(300);
            expect(rt.busy).toBe(false);
            expect(stored(rt.session, "QUEUED-410")).toBe(0);
            expect(sent("QUEUED-410")).toBe(0);
            expect(rt.snapshot().state.accountNeeded).toBe(provider);

            delete process.env.FAKE_TURN_MS;
            process.env.FAKE_SCENARIO = "silent";
            await engine.handle(client, "session.setAccount", { id: rt.id, provider, accountId: "default" });
            await until(() => !rt.busy && stored(rt.session, "QUEUED-410") === 1, "the held message");
            expect(sent("QUEUED-410")).toBe(1);
            expect(rt.session.backendPlace(provider)?.folder).toBe(defaultFolder(provider));
        } finally {
            await engine.stop();
            rmSync(cwd, { recursive: true, force: true });
        }
    }, 60_000);
}

test("terminal: a session loaded from disk whose account was removed holds its message, and sends it once an account is picked", async () => {
    const provider = "codex";
    const cwd = realpathSync(tempDir("account-removed-tload-"));
    const work = addAccount(provider, { id: "tl-work", name: "Work" });
    const saved = Session.create(cwd);
    saved.setModel(`${provider}:default`);
    saved.setAccount(provider, work.id);
    saved.push({ role: "user", content: [{ type: "text", text: "Earlier" }], meta: { kind: "prompt" } });
    saved.push({ role: "assistant", content: [{ type: "text", text: "Noted." }], provider, model: "default", stopReason: "end_turn" });
    saved.release();
    removeAccount(provider, work.id, work.folder, [cwd]);
    const { app, a, text } = await terminal(provider, cwd);
    try {
        app.resume(saved.path);
        expect(app.session.accountId(provider)).toBe(work.id);
        const before = structuredClone(app.session.messages);
        await app.submitText("LOADED-410");
        await Bun.sleep(300);
        expect(app.busy).toBe(false);
        expect(app.session.messages).toEqual(before);
        expect(sent("LOADED-410")).toBe(0);
        expect(text()).toContain(held(provider, work.id));
        expect(a.heldForAccount.drafts).toHaveLength(1);
        await app.setAccount(provider, "default");
        await until(() => !app.busy && stored(app.session, "LOADED-410") === 1, "the held message");
        expect(sent("LOADED-410")).toBe(1);
        expect(app.session.backendPlace(provider)?.folder).toBe(defaultFolder(provider));
    } finally {
        await app.agent?.dispose();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);

// ---- Review of #419: a restart, the order of what's released, another model, and the same account added again.

const { loadQueue } = await import("../src/agent/queue-store");
const { sendsAccountPick } = await import("../gui/src/lib/account-pick");
/** The session's user messages that carry one of `tags`, by tag, in order. */
const order = (session: { messages: { role: string; content: unknown }[] }, tags: string[]) =>
    session.messages.filter((m) => m.role === "user").map((m) => tags.find((t) => JSON.stringify(m.content).includes(t))).filter(Boolean);

test("desktop: the hold survives a restart; reopened, picking an account sends each held message once, in order", async () => {
    const provider = "codex";
    const cwd = realpathSync(tempDir("account-removed-restart-"));
    const work = addAccount(provider, { id: "rs-work", name: "Work" });
    const client = { subs: new Set<string>(), send() {} };
    const first = new Engine({ startCwd: cwd, listModels: async () => [] });
    const made = await first.createSession(cwd, { model: `${provider}:default`, mode: "bypassPermissions" });
    const id = made.id;
    await first.handle(client, "session.setAccount", { id, provider, accountId: work.id });
    await first.handle(client, "session.send", { id, text: "FIRST-410" });
    await until(() => !made.busy && stored(made.session, "FIRST-410") === 1, "the first turn");
    await first.handle(client, "accounts.remove", { provider, id: work.id, confirmedFolder: work.folder });
    await first.handle(client, "session.send", { id, text: "RS-A-410" });
    await first.handle(client, "session.send", { id, text: "RS-B-410" });
    expect(made.snapshot().state.queuedModes).toEqual(["held", "held"]);
    await first.stop();

    const engine = new Engine({ startCwd: cwd, listModels: async () => [] });
    try {
        await engine.handle(client, "session.open", { id });
        const rt = engine.runtimes.get(id)!;
        await rt.ready;
        await engine.handle(client, "session.setMode", { id, mode: "bypassPermissions" });
        const state = rt.snapshot().state;
        expect(state.queued).toEqual(["RS-A-410", "RS-B-410"]);
        expect(state.queuedWhy).toEqual([held(provider, work.id), held(provider, work.id)]);
        expect(state.accountNeeded).toBe(provider);
        await engine.handle(client, "session.setAccount", { id, provider, accountId: "default" });
        await until(() => !rt.busy && stored(rt.session, "RS-B-410") === 1 && !rt.snapshot().state.queued.length, "the held messages");
        expect(order(rt.session, ["RS-A-410", "RS-B-410"])).toEqual(["RS-A-410", "RS-B-410"]);
        expect([sent("RS-A-410"), sent("RS-B-410")]).toEqual([1, 1]);
        expect(rt.session.backendPlace(provider)?.folder).toBe(defaultFolder(provider));
    } finally {
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);

test("terminal: the hold survives a restart, each message on its own (not merged into the prompt), until an account is picked", async () => {
    const provider = "codex";
    const cwd = realpathSync(tempDir("account-removed-trestart-"));
    const work = addAccount(provider, { id: "trs-work", name: "Work" });
    const one = await terminal(provider, cwd, true, true);
    let path = "";
    let id = "";
    try {
        await one.app.setAccount(provider, work.id);
        await one.app.submitText("FIRST-410");
        path = one.app.session.path;
        id = one.app.session.meta.id;
        removeAccount(provider, work.id, work.folder, [cwd]);
        await one.app.submitText("TRS-A-410");
        await one.app.submitText("TRS-B-410");
        expect(one.a.heldForAccount.drafts).toHaveLength(2);
    } finally {
        await one.app.agent?.dispose();
    }
    // Opened again: held as they were, and still saved held (another restart keeps them).
    const two = await terminal(provider, cwd);
    try {
        two.app.resume(path);
        expect(two.a.heldForAccount.drafts.map((d: { text: string }) => d.text)).toEqual(["TRS-A-410", "TRS-B-410"]);
        expect(two.a.editor.text).toBe("");
        expect(loadQueue(path, id)).toEqual([{ text: "TRS-A-410", mode: "queue", account: provider }, { text: "TRS-B-410", mode: "queue", account: provider }]);
        expect(two.text()).toContain("Pick one with /account");
        await two.app.setAccount(provider, "default");
        await until(() => !two.app.busy && stored(two.app.session, "TRS-B-410") === 1, "the held messages");
        expect(order(two.app.session, ["TRS-A-410", "TRS-B-410"])).toEqual(["TRS-A-410", "TRS-B-410"]);
        expect([sent("TRS-A-410"), sent("TRS-B-410")]).toEqual([1, 1]);
        expect(loadQueue(path, id)).toEqual([]);
    } finally {
        await two.app.agent?.dispose();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);

test("terminal: released messages go first, in order; one sent before the first starts waits behind them", async () => {
    const provider = "codex";
    const cwd = realpathSync(tempDir("account-removed-order-"));
    const work = addAccount(provider, { id: "ord-work", name: "Work" });
    const { app } = await terminal(provider, cwd);
    try {
        await app.setAccount(provider, work.id);
        removeAccount(provider, work.id, work.folder, [cwd]);
        await app.submitText("ORD-A-410");
        await app.submitText("ORD-B-410");
        await app.setAccount(provider, "default");
        // Before the first released one has started.
        void app.submitText("ORD-C-410");
        await until(() => !app.busy && stored(app.session, "ORD-A-410") + stored(app.session, "ORD-B-410") + stored(app.session, "ORD-C-410") === 3, "all three");
        expect(order(app.session, ["ORD-A-410", "ORD-B-410", "ORD-C-410"])).toEqual(["ORD-A-410", "ORD-B-410", "ORD-C-410"]);
        expect([sent("ORD-A-410"), sent("ORD-B-410"), sent("ORD-C-410")]).toEqual([1, 1, 1]);
    } finally {
        await app.agent?.dispose();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);

test("terminal: leaving the session before a released message starts hands it back to the prompt; it doesn't run in the next one", async () => {
    const provider = "codex";
    const cwd = realpathSync(tempDir("account-removed-leave-"));
    const work = addAccount(provider, { id: "lv-work", name: "Work" });
    const { app, a } = await terminal(provider, cwd);
    try {
        await app.setAccount(provider, work.id);
        removeAccount(provider, work.id, work.folder, [cwd]);
        await app.submitText("LEAVE-410");
        await app.setAccount(provider, "default");
        app.newSession();
        await Bun.sleep(300);
        expect(app.busy).toBe(false);
        expect(stored(app.session, "LEAVE-410")).toBe(0);
        expect(sent("LEAVE-410")).toBe(0);
        expect(a.editor.text).toBe("LEAVE-410");
    } finally {
        await app.agent?.dispose();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);

test("desktop: switching the model to another provider sends what was held there, once each, in order", async () => {
    const cwd = realpathSync(tempDir("account-removed-model-"));
    const work = addAccount("claude-code", { id: "md-work", name: "Work" });
    const engine = new Engine({ startCwd: cwd, listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} };
    const rt = await engine.createSession(cwd, { model: "claude-code:default", mode: "bypassPermissions" });
    try {
        await engine.handle(client, "session.setAccount", { id: rt.id, provider: "claude-code", accountId: work.id });
        await engine.handle(client, "accounts.remove", { provider: "claude-code", id: work.id, confirmedFolder: work.folder });
        await engine.handle(client, "session.send", { id: rt.id, text: "MD-A-410" });
        await engine.handle(client, "session.send", { id: rt.id, text: "MD-B-410" });
        expect(rt.snapshot().state.queuedModes).toEqual(["held", "held"]);
        await engine.handle(client, "session.setModel", { id: rt.id, ref: "codex:default", persist: false });
        await until(() => !rt.busy && stored(rt.session, "MD-B-410") === 1 && !rt.snapshot().state.queued.length, "the held messages");
        expect(order(rt.session, ["MD-A-410", "MD-B-410"])).toEqual(["MD-A-410", "MD-B-410"]);
        expect([sent("MD-A-410"), sent("MD-B-410")]).toEqual([1, 1]);
        expect(rt.session.backends.has("codex")).toBe(true);
        expect(rt.session.backends.has("claude-code")).toBe(false);
        expect(rt.snapshot().state.accountNeeded).toBeUndefined();
        expect(notices(rt).some((n) => n.startsWith("Sending the 2 messages held for an account to "))).toBe(true);
    } finally {
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);

test("terminal: switching the model to another provider sends what was held there, once each, in order", async () => {
    const cwd = realpathSync(tempDir("account-removed-tmodel-"));
    const work = addAccount("claude-code", { id: "tmd-work", name: "Work" });
    const { app, a } = await terminal("claude-code", cwd);
    try {
        await app.setAccount("claude-code", work.id);
        removeAccount("claude-code", work.id, work.folder, [cwd]);
        await app.submitText("TMD-A-410");
        await app.submitText("TMD-B-410");
        expect(await app.setModel("codex:default")).toBe(true);
        await until(() => !app.busy && stored(app.session, "TMD-B-410") === 1, "the held messages");
        expect(order(app.session, ["TMD-A-410", "TMD-B-410"])).toEqual(["TMD-A-410", "TMD-B-410"]);
        expect([sent("TMD-A-410"), sent("TMD-B-410")]).toEqual([1, 1]);
        expect(app.session.backends.has("codex")).toBe(true);
        expect(a.heldForAccount).toBeUndefined();
    } finally {
        await app.agent?.dispose();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);

test("desktop: the account added again under its id still waits for the pick (what's sent meanwhile is held too); picking it sends them in order", async () => {
    const provider = "codex";
    const cwd = realpathSync(tempDir("account-removed-readd-"));
    const work = addAccount(provider, { id: "ra-work", name: "Work" });
    const engine = new Engine({ startCwd: cwd, listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} };
    const rt = await engine.createSession(cwd, { model: `${provider}:default`, mode: "bypassPermissions" });
    try {
        await engine.handle(client, "session.setAccount", { id: rt.id, provider, accountId: work.id });
        await engine.handle(client, "accounts.remove", { provider, id: work.id, confirmedFolder: work.folder });
        await engine.handle(client, "session.send", { id: rt.id, text: "RA-A-410" });
        const again = addAccount(provider, { id: work.id, name: "Work again" });
        expect(await engine.handle(client, "session.send", { id: rt.id, text: "RA-B-410" })).toEqual({ queued: true });
        await Bun.sleep(300);
        expect(sent("RA-A-410") + sent("RA-B-410")).toBe(0);
        const state = rt.snapshot().state;
        expect(state.queued).toEqual(["RA-A-410", "RA-B-410"]);
        expect(state.accountNeeded).toBe(provider);
        // The GUI forwards a pick of the same account while messages wait for one.
        expect(sendsAccountPick(work.id, work.id, { missing: false, needed: state.accountNeeded === provider })).toBe(true);
        expect(sendsAccountPick(work.id, work.id, { missing: false, needed: false })).toBe(false);
        await engine.handle(client, "session.setAccount", { id: rt.id, provider, accountId: work.id });
        await until(() => !rt.busy && stored(rt.session, "RA-B-410") === 1 && !rt.snapshot().state.queued.length, "the held messages");
        expect(order(rt.session, ["RA-A-410", "RA-B-410"])).toEqual(["RA-A-410", "RA-B-410"]);
        expect([sent("RA-A-410"), sent("RA-B-410")]).toEqual([1, 1]);
        expect(rt.session.backendPlace(provider)?.folder).toBe(realpathSync(again.folder));
        removeAccount(provider, again.id, again.folder, [cwd]);
    } finally {
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
}, 60_000);
