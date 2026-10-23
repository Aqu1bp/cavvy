// Account identity and lifecycle guards (#159), through public entry points.
// Fake CLIs and fake sign-in files only: no real CLI, credential or login is used.
import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { BackendTurn } from "../src/backends/types";

const iso = isolate();
const root = realpathSync(tempDir("account-lifecycle-"));
const { addAccount, accountEnv, accountProtectedPaths, listAccounts, removeAccount, setDefaultAccount } = await import("../src/providers/accounts");
const { saveAgentConfig, BUILTIN_PROVIDERS } = await import("../src/providers/registry");
const { loginCommand } = await import("../src/backends/account-login");
const { checkAgentCli, createBackend } = await import("../src/backends/index");
const { forgetClient } = await import("../src/providers/models");
const { Engine } = await import("../src/server/engine");
const log = join(root, "starts.jsonl");
const touched = ["FAKE_LOG", "FAKE_SCENARIO", "FAKE_SECOND_SCENARIO", "FAKE_ACCOUNT", "FAKE_LATE_TASK"];
const old = Object.fromEntries(touched.map((key) => [key, process.env[key]]));
const fakes: Record<string, string> = {};
for (const [provider, fixture] of [["claude-code", "fake-claude.ts"], ["codex", "fake-codex.ts"]] as const) {
    fakes[provider] = join(root, provider);
    writeFileSync(fakes[provider], `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`);
    chmodSync(fakes[provider], 0o700);
}
const def = (provider: string) => BUILTIN_PROVIDERS.find((p) => p.id === provider)!;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
/** The fake CLIs' process starts (FAKE_LOG). */
const launches = (): { argv: string[] }[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((line) => line.argv) : []);
async function until(done: () => boolean, what: string) {
    const end = Date.now() + 10_000;
    while (!done()) {
        if (Date.now() > end) throw new Error(`Timed out waiting for ${what}`);
        await Bun.sleep(10);
    }
}
beforeEach(() => {
    for (const key of touched) delete process.env[key];
    process.env.FAKE_LOG = log;
    rmSync(log, { force: true });
    for (const provider of ["claude-code", "codex"]) {
        saveAgentConfig(provider, { path: fakes[provider], accounts: [], defaultAccount: "default" });
        forgetClient(provider);
    }
});
afterAll(() => {
    for (const [key, value] of Object.entries(old)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    iso.cleanup();
    rmSync(root, { recursive: true, force: true });
});

function fakeTurn(provider: string, accountId: string): BackendTurn {
    return {
        prompt: "hello", images: [], cwd: root, model: { provider, id: "default" }, mode: "auto", accountId,
        additionalDirectories: [], trusted: true, rules: { deny: [], ask: [], root }, signal: new AbortController().signal,
        sessionKey: `lifecycle-${provider}-${accountId}-${Math.random()}`,
        session: {
            mode: () => "auto", permission: async () => ({ allow: true }), askQuestions: async () => undefined,
            approvePlan: async () => ({ approved: false }), setMode: () => {}, usage: () => {}, sessionId: () => {},
        },
        sink: { emit: () => {}, drainQueued: () => [] },
    } as BackendTurn;
}

test("a named folder replaced by a link to another named account's is refused at every launch, for both accounts", async () => {
    // Same CLI, and across CLIs (the Claude keychain check can't see a Codex folder).
    for (const [first, second] of [["codex", "codex"], ["claude-code", "codex"], ["codex", "claude-code"]] as const) {
        const a = addAccount(first, { id: "alpha", name: "Alpha" });
        const b = addAccount(second, { id: "beta", name: "Beta" });
        for (const target of [b.folder, dirname(b.folder)]) {
            rmSync(a.folder, { recursive: true });
            symlinkSync(target, a.folder);
            try {
                for (const [provider, id] of [[first, a.id], [second, b.id]] as const) {
                    const what = { first, second, target, provider, id };
                    expect({ ...what, env: (() => { try { return accountEnv(provider, id); } catch (e) { return (e as Error).message; } })() }).toEqual({ ...what, env: "Accounts must have separate, non-overlapping folders" });
                    expect(() => loginCommand(provider, id)).toThrow(/separate, non-overlapping/);
                    await expect(checkAgentCli(provider, undefined, id)).rejects.toThrow(/separate, non-overlapping/);
                    saveAgentConfig(provider, { defaultAccount: id });
                    forgetClient(provider);
                    await expect(createBackend(def(provider)).listModels()).rejects.toThrow(/separate, non-overlapping/);
                    saveAgentConfig(provider, { defaultAccount: "default" });
                    for (const liveSessions of [true, false]) {
                        const backend = createBackend(def(provider));
                        const turn = { ...fakeTurn(provider, id), liveSessions };
                        const result = await backend.runTurn(turn).catch((e: Error) => ({ reason: "error", error: e.message }));
                        expect(result).toMatchObject({ reason: "error", error: expect.stringContaining("separate, non-overlapping") });
                        await backend.shutdown?.();
                    }
                }
                // Nothing was started under either identity.
                expect(existsSync(log)).toBe(false);
            } finally {
                rmSync(a.folder);
                mkdirSync(a.folder, { mode: 0o700 });
            }
        }
        removeAccount(first, a.id, a.folder);
        removeAccount(second, b.id, b.folder);
    }
});

test("an account can't be removed while its sign-in terminal runs: attached, in a window that went away, or closing", async () => {
    const pidFile = join(root, "login.pid");
    const fake = join(root, "fake-claude-login");
    // Ignores hangups, so closing its terminal leaves it running until it's killed.
    writeFileSync(fake, [
        "#!/bin/sh", "trap '' HUP",
        'if [ "$1" = "auth" ] && [ "$2" = "login" ]; then',
        `  echo $$ > '${pidFile}'`, "  printf 'login-ready\\n'", "  read answer",
        '  mkdir -p "$CLAUDE_CONFIG_DIR"', `  printf '{"fake":true}\\n' > "$CLAUDE_CONFIG_DIR/.credentials.json"`, "  sleep 3",
        "else", `  printf '{"loggedIn":false}\\n'`, "fi", "",
    ].join("\n"), { mode: 0o700 });
    saveAgentConfig("claude-code", { path: fake });
    const signing = addAccount("claude-code", { id: "signing", name: "Signing" });
    const other = addAccount("claude-code", { id: "other", name: "Other" });
    const engine = new Engine({ startCwd: root, listModels: async () => [] });
    const events: any[] = [];
    const tab = { window: "account-login-window", subs: new Set<string>(), send(e: any) { events.push(e); } };
    const elsewhere = { subs: new Set<string>(), send() {} };
    engine.clients.add(tab);
    engine.clients.add(elsewhere);
    const remove = (a: { id: string; folder: string }) => engine.handle(elsewhere, "accounts.remove", { provider: "claude-code", id: a.id, confirmedFolder: a.folder });
    const output = () => events.filter((e) => e.type === "terminal.data" && e.id === "login-tab").map((e) => e.data).join("");
    const registered = () => listAccounts("claude-code").map((a) => a.id);
    try {
        await engine.handle(tab, "terminal.open", { id: "login-tab", cwd: root, cols: 80, rows: 24, login: { provider: "claude-code", accountId: signing.id } });
        await until(() => output().includes("login-ready"), "the login");
        const pid = Number(readFileSync(pidFile, "utf8"));
        await expect(remove(signing)).rejects.toMatchObject({ code: "busy", message: expect.stringContaining("sign-in terminal") });
        expect(registered()).toContain(signing.id);
        expect(existsSync(signing.folder)).toBe(true);
        // Another account's login doesn't hold this one; then this is the last named account, and stays protected.
        await remove(other);
        expect(registered()).toEqual(["default", signing.id]);
        await expect(remove(signing)).rejects.toMatchObject({ code: "busy" });
        expect(accountProtectedPaths()).toContain(signing.folder);
        // The window goes away: its login keeps running for it to come back to.
        engine.dropClient(tab);
        await expect(remove(signing)).rejects.toMatchObject({ code: "busy" });
        // It comes back and closes the tab: the account stays until the login's process has exited.
        const back = { window: "account-login-window", subs: new Set<string>(), send() {} };
        engine.clients.add(back);
        await engine.handle(back, "terminal.close", { id: "login-tab" });
        expect(alive(pid)).toBe(true);
        await expect(remove(signing)).rejects.toMatchObject({ code: "busy" });
        for (const end = Date.now() + 10_000; ;) {
            try { await remove(signing); break; } catch (e: any) {
                if (e.code !== "busy" || Date.now() > end) throw e;
                await Bun.sleep(20);
            }
        }
        expect(alive(pid)).toBe(false);
        expect(registered()).toEqual(["default"]);
        await Bun.sleep(200);
        expect(existsSync(signing.folder)).toBe(false);
    } finally {
        await engine.stop();
    }
});

async function tuiApp() {
    const { App } = await import("../src/ui/app");
    const { Session } = await import("../src/agent/session");
    const { runCommand } = await import("../src/commands/index");
    const ended = join(root, `login-ended-${Math.random()}`);
    const started = join(root, `login-started-${Math.random()}`);
    const wrapper = join(root, "codex-login");
    // A login that takes a second and says when it has started and ended; everything else is the fake Codex.
    writeFileSync(wrapper, `#!/bin/sh\nif [ "$1" = "login" ]; then : > '${started}'; sleep 1; : > '${ended}'; exit 0; fi\nexec "${fakes.codex}" "$@"\n`, { mode: 0o700 });
    saveAgentConfig("codex", { path: wrapper });
    const app = new App({ cwd: root, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    const a = app as any;
    a.screen = { print() {}, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {}, suspend: async (f: () => unknown) => f() };
    a.renderLive = () => {};
    const notices: string[] = [];
    a.notice = (text: string) => void notices.push(text);
    app.session = Session.create(root, { persist: false });
    // Something can start while the questions are being answered: a delegated CLI child, or a turn.
    const state = { child: false, starts: undefined as (() => void) | undefined };
    a.agent = { hasCliChild: () => state.child };
    let answers: string[] = [];
    a.showDialog = async () => {
        const answer = answers.shift();
        if (!answers.length) state.starts?.();
        return answer;
    };
    const add = async (id: string) => {
        notices.length = 0;
        answers = [id, "Added", ""];
        const thrown = await runCommand(app, "/login codex add").then(() => "", (e: Error) => e.message);
        return [thrown, ...notices].join("\n");
    };
    const signIn = async (id: string) => {
        notices.length = 0;
        const thrown = await runCommand(app, `/login codex ${id}`).then(() => "", (e: Error) => e.message);
        return [thrown, ...notices].join("\n");
    };
    return { app, state, add, ended, started, signIn };
}

test("the terminal app's /login <cli> add doesn't wait for delegated CLI children or running responses (#375)", async () => {
    const { app, state, add } = await tuiApp();
    try {
        state.starts = () => { state.child = true; };
        expect(await add("while-child")).not.toContain("Add accounts once");
        state.child = false;
        state.starts = () => { app.busy = true; };
        expect(await add("while-busy")).not.toContain("Add accounts once");
        state.starts = undefined;
        expect(listAccounts("codex").map((x) => x.id)).toEqual(["default", "while-child", "while-busy"]);
    } finally {
        app.busy = false;
    }
});

test("the terminal app's account login keeps the event loop running, so running turns go on during it", async () => {
    const { add, ended } = await tuiApp();
    let loginEndedWhenSeen: boolean | undefined;
    const tick = setInterval(() => { loginEndedWhenSeen ??= existsSync(ended); }, 50);
    try { await add("added"); } finally { clearInterval(tick); }
    expect(listAccounts("codex").map((x) => x.id)).toEqual(["default", "added"]);
    expect(existsSync(ended)).toBe(true);
    // Seen while the login still ran, not once it returned.
    expect(loginEndedWhenSeen).toBe(false);
});

test("adding an account, or removing one a running CLI turn doesn't use, goes ahead mid-turn and the turn goes on (#375)", async () => {
    const { Session } = await import("../src/agent/session");
    const unrelated = addAccount("codex", { id: "unrelated-fg", name: "Unrelated" });
    // A turn that runs until it's stopped.
    process.env.FAKE_SCENARIO = "hang";
    const cwd = realpathSync(tempDir("account-foreground-"));
    const session = Session.create(cwd, { persist: false });
    const { agent, client } = await liveClaudeAgent(cwd, session);
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    const stop = new AbortController();
    let ended: string | undefined;
    const turn = agent.run([{ type: "text", text: "work" }], { signal: stop.signal }).then((r) => (ended = r));
    try {
        await until(() => launches().length > 0, "the turn's process");
        engine.runtimes.set(session.meta.id, { busy: true, session, agent, ws: { cwd }, toolState: { cwd } } as any);
        await expect(engine.handle(rpc, "accounts.add", { provider: "claude-code", id: "mid-turn", name: "Mid turn" })).resolves.toMatchObject({ id: "mid-turn" });
        await engine.handle(rpc, "accounts.remove", { provider: "codex", id: unrelated.id, confirmedFolder: unrelated.folder });
        expect(existsSync(unrelated.folder)).toBe(false);
        await Bun.sleep(400);
        expect(ended).toBeUndefined();
        expect(launches()).toHaveLength(1);
        stop.abort();
        expect(await turn).toBe("aborted");
    } finally {
        stop.abort();
        await turn;
        engine.runtimes.clear();
        await agent.dispose();
        await (client as any).shutdown?.();
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("a terminal-app login holds its account against removal by a desktop server, which can't see its terminal", async () => {
    const { started, ended, signIn } = await tuiApp();
    const signing = addAccount("codex", { id: "tui-signing", name: "TUI signing" });
    // Another Harness process's server: it has no terminals of its own.
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    const remove = () => engine.handle(rpc, "accounts.remove", { provider: "codex", id: signing.id, confirmedFolder: signing.folder });
    try {
        const login = signIn(signing.id);
        await until(() => existsSync(started), "the login");
        await expect(remove()).rejects.toMatchObject({ code: "busy", message: expect.stringContaining("sign-in for this account is still running") });
        expect(existsSync(signing.folder)).toBe(true);
        await login;
        expect(existsSync(ended)).toBe(true);
        await remove();
        expect(existsSync(signing.folder)).toBe(false);
    } finally {
        await engine.stop();
    }
});

/** Another Harness process on the same home (HARNESS_HOME is inherited): it takes a sign-in's or a removal's lease and holds it until its stdin closes. */
const others = new Set<import("bun").Subprocess>();
const endInput = (p: import("bun").Subprocess) => { try { (p.stdin as import("bun").FileSink).end(); } catch {} };
// Whatever a test's assertions did: each other process ends (its stdin's end releases what it holds; one that
// doesn't go then is killed) and is waited for, so none is left holding a lease for later tests.
afterEach(async () => {
    await Promise.all([...others].map(async (p) => {
        if (p.exitCode === null && p.signalCode === null) {
            endInput(p);
            if (!(await Promise.race([p.exited.then(() => true), Bun.sleep(5000).then(() => false)]))) p.kill("SIGKILL");
        }
        await p.exited;
    }));
    others.clear();
});
async function otherProcess(code: string) {
    const accounts = JSON.stringify(join(import.meta.dir, "..", "src", "providers", "accounts.ts"));
    const p = Bun.spawn([process.execPath, "--no-env-file", "-e", `const a = await import(${accounts}); ${code}`], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: process.env });
    // Before anything that can fail.
    others.add(p);
    const reader = (p.stdout as ReadableStream<Uint8Array>).getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    reader.releaseLock();
    return { p, first, done: async () => { endInput(p); return p.exited; } };
}
const holding = (hold: "holdLogin" | "holdRemoval", provider: string, id: string) =>
    otherProcess(`const release = a.${hold}(${JSON.stringify(provider)}, ${JSON.stringify(id)}); console.log("held"); await Bun.stdin.text(); release();`);

test("a sign-in under way in another Harness process holds removal, with others holding too, until each ends; a dead one doesn't", async () => {
    const { holdLogin } = await import("../src/providers/accounts");
    const released = addAccount("codex", { id: "other-process", name: "Other process" });
    const crashed = addAccount("codex", { id: "crashed-process", name: "Crashed process" });
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    const remove = (a: { id: string; folder: string }) => engine.handle(rpc, "accounts.remove", { provider: "codex", id: a.id, confirmedFolder: a.folder });
    try {
        const other = await holding("holdLogin", "codex", released.id);
        expect(other.first).toContain("held");
        const mine = holdLogin("codex", released.id);
        await expect(remove(released)).rejects.toMatchObject({ code: "busy", message: expect.stringContaining("sign-in for this account is still running") });
        mine();
        // The other process's still runs.
        await expect(remove(released)).rejects.toMatchObject({ code: "busy" });
        expect(existsSync(released.folder)).toBe(true);
        expect(await other.done()).toBe(0);
        await remove(released);
        expect(existsSync(released.folder)).toBe(false);
        // A process killed outright leaves its file behind: it holds nothing once the process is gone.
        const killed = await holding("holdLogin", "codex", crashed.id);
        await expect(remove(crashed)).rejects.toMatchObject({ code: "busy" });
        killed.p.kill("SIGKILL");
        await killed.p.exited;
        await remove(crashed);
        expect(existsSync(crashed.folder)).toBe(false);
    } finally {
        await engine.stop();
    }
});

test("a removal under way in another Harness process stops a sign-in from starting, in the terminal app and the desktop's terminal; a finished one leaves nothing to sign in to", async () => {
    const { started, signIn } = await tuiApp();
    const target = addAccount("codex", { id: "being-removed", name: "Being removed" });
    const engine = new Engine({ listModels: async () => [] });
    const tab = { window: "removal-window", subs: new Set<string>(), send() {} };
    engine.clients.add(tab);
    try {
        const remover = await holding("holdRemoval", "codex", target.id);
        expect(remover.first).toContain("held");
        expect(await signIn(target.id)).toContain("This account is being removed");
        await expect(engine.handle(tab, "terminal.open", { id: "removal-login", cwd: root, cols: 80, rows: 24, login: { provider: "codex", accountId: target.id } })).rejects.toMatchObject({ code: "busy" });
        expect(existsSync(started)).toBe(false);
        // That removal gave up: the sign-in goes ahead.
        expect(await remover.done()).toBe(0);
        expect(await signIn(target.id)).not.toContain("being removed");
        expect(existsSync(started)).toBe(true);
        rmSync(started);
        // One that went through: its change was saved before its lease went, so the sign-in finds no account.
        const removed = await otherProcess(`a.removeAccount("codex", ${JSON.stringify(target.id)}, ${JSON.stringify(target.folder)}); console.log("removed");`);
        expect(removed.first).toContain("removed");
        expect(await removed.done()).toBe(0);
        expect(await signIn(target.id)).toContain("Account no longer exists");
        expect(existsSync(started)).toBe(false);
        expect(existsSync(target.folder)).toBe(false);
    } finally {
        await engine.stop();
    }
});

test("sign-ins and removals refuse when the record of them can't be read", async () => {
    const { holdLogin } = await import("../src/providers/accounts");
    const { paths } = await import("../src/config/paths");
    const target = addAccount("codex", { id: "unreadable", name: "Unreadable" });
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    const remove = () => engine.handle(rpc, "accounts.remove", { provider: "codex", id: target.id, confirmedFolder: target.folder });
    const leases = join(paths.home(), "accounts", ".leases");
    try {
        holdLogin("codex", target.id)();
        // A lease of this account whose process can't be told: it counts.
        const odd = join(leases, `login.codex.${target.id}.not-a-pid.x`);
        writeFileSync(odd, "");
        await expect(remove()).rejects.toMatchObject({ code: "busy" });
        rmSync(odd);
        chmodSync(leases, 0o000);
        try {
            await expect(remove()).rejects.toThrow(/Cannot (check|record)/);
            expect(() => holdLogin("codex", target.id)).toThrow(/Cannot (check|record)/);
        } finally { chmodSync(leases, 0o700); }
        expect(existsSync(target.folder)).toBe(true);
        await remove();
        expect(existsSync(target.folder)).toBe(false);
    } finally {
        await engine.stop();
    }
});

test("one CLI's task ending doesn't hide another CLI's task of the same id still running on its account", async () => {
    const { Agent } = await import("../src/agent/agent");
    const { Session } = await import("../src/agent/session");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { SessionBackground } = await import("../src/agent/background");
    const claude = addAccount("claude-code", { id: "collide-a", name: "Collide A" });
    const codex = addAccount("codex", { id: "collide-b", name: "Collide B" });
    const cwd = realpathSync(tempDir("account-collide-"));
    const session = Session.create(cwd, { persist: false });
    session.setAccount("claude-code", claude.id);
    session.setAccount("codex", codex.id);
    const hosts: import("../src/backends/types").SessionHost[] = [];
    const backend: any = {
        agentBackend: true, adoptsTurns: true, setMode() {}, listModels: async () => [],
        stream: async () => { throw new Error("unused"); }, compact: async () => ({ reason: "done", text: "", actions: [] }),
        runTurn: async (t: BackendTurn) => { hosts.push(t.session); t.sink.emit({ type: "text", text: "ok" }); return { reason: "done", text: "ok", actions: [] }; },
    };
    const agent = new Agent({
        session, model: { provider: "claude-code", id: "default" }, client: backend, settings: () => ({}), checker: new PermissionChecker(() => ({}), cwd), tools: [],
        mode: { get: () => "default", set() {} }, toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), background: new SessionBackground() },
        host: { emit() {}, ui: {}, askPermission: async () => ({ allow: true }), wake() {} },
    } as any);
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    const task = (provider: string, status: "running" | "stopped") => ({ id: "X", provider, kind: "shell" as const, label: `${provider} X`, startedAt: 1, status, stoppable: true });
    try {
        expect(await agent.run([{ type: "text", text: "start" }], { signal: new AbortController().signal })).toBe("done");
        engine.runtimes.set(session.meta.id, { busy: false, session, agent, ws: { cwd }, toolState: { cwd } } as any);
        // Claude Code on A and Codex on B each run a task with the same id; Codex's ends.
        hosts[0]!.emitSession!({ type: "background_task", task: task("claude-code", "running"), accountId: claude.id });
        hosts[0]!.emitSession!({ type: "background_task", task: task("codex", "running"), accountId: codex.id });
        hosts[0]!.emitSession!({ type: "background_task", task: task("codex", "stopped"), accountId: codex.id });
        // The list keeps one X, Codex's ended one; Claude Code's goes on.
        expect(agent.backgroundTasks().filter((t) => t.id === "X").map((t) => [t.provider, t.status])).toEqual([["codex", "stopped"]]);
        await expect(engine.handle(rpc, "accounts.remove", { provider: "claude-code", id: claude.id, confirmedFolder: claude.folder })).rejects.toMatchObject({ code: "busy" });
        expect(existsSync(claude.folder)).toBe(true);
        // Only once Claude Code's ends.
        hosts[0]!.emitSession!({ type: "background_task", task: task("claude-code", "stopped"), accountId: claude.id });
        await engine.handle(rpc, "accounts.remove", { provider: "claude-code", id: claude.id, confirmedFolder: claude.folder });
        expect(existsSync(claude.folder)).toBe(false);
        await engine.handle(rpc, "accounts.remove", { provider: "codex", id: codex.id, confirmedFolder: codex.folder });
    } finally {
        engine.runtimes.clear();
        await agent.dispose();
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("a Stop the CLI answers after the session moved to another CLI clears only the asking CLI's task", async () => {
    const { Agent } = await import("../src/agent/agent");
    const { Session } = await import("../src/agent/session");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { SessionBackground } = await import("../src/agent/background");
    const claude = addAccount("claude-code", { id: "stop-a", name: "Stop A" });
    const codex = addAccount("codex", { id: "stop-b", name: "Stop B" });
    const cwd = realpathSync(tempDir("account-stop-"));
    const session = Session.create(cwd, { persist: false });
    session.setAccount("claude-code", claude.id);
    session.setAccount("codex", codex.id);
    const hosts: import("../src/backends/types").SessionHost[] = [];
    // Claude Code's answer to the Stop is held until the session has moved to Codex.
    const answer = Promise.withResolvers<Record<string, "unknown">>();
    let asked: string[] | undefined;
    const backend: any = {
        agentBackend: true, adoptsTurns: true, setMode() {}, listModels: async () => [],
        stream: async () => { throw new Error("unused"); }, compact: async () => ({ reason: "done", text: "", actions: [] }),
        runTurn: async (t: BackendTurn) => { hosts.push(t.session); t.sink.emit({ type: "text", text: "ok" }); return { reason: "done", text: "ok", actions: [] }; },
        stopBackground: async (_key: string, ids: string[]) => { asked = ids; return answer.promise; },
    };
    const agent = new Agent({
        session, model: { provider: "claude-code", id: "default" }, client: backend, settings: () => ({}), checker: new PermissionChecker(() => ({}), cwd), tools: [],
        mode: { get: () => "default", set() {} }, toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), background: new SessionBackground() },
        host: { emit() {}, ui: {}, askPermission: async () => ({ allow: true }), wake() {} },
    } as any);
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    const task = (provider: string, status: "running" | "stopped") => ({ id: "X", provider, kind: "shell" as const, label: `${provider} X`, startedAt: 1, status, stoppable: true });
    const listed = () => agent.backgroundTasks().filter((t) => t.id === "X").map((t) => [t.provider, t.status]);
    try {
        expect(await agent.run([{ type: "text", text: "start" }], { signal: new AbortController().signal })).toBe("done");
        engine.runtimes.set(session.meta.id, { busy: false, session, agent, ws: { cwd }, toolState: { cwd } } as any);
        hosts[0]!.emitSession!({ type: "background_task", task: task("claude-code", "running"), accountId: claude.id });
        const stopping = agent.stopBackground(["X"]);
        await until(() => asked !== undefined, "the Stop to reach Claude Code");
        // Meanwhile the session moves to Codex, whose own task X starts on B.
        agent.setModel({ provider: "codex", id: "default" } as any, backend);
        hosts[0]!.emitSession!({ type: "background_task", task: task("codex", "running"), accountId: codex.id });
        // Claude Code doesn't know its X any more.
        answer.resolve({ X: "unknown" });
        expect(await stopping).toEqual({ X: "unknown" });
        // Only Claude Code's X is over: Codex's still runs on B, in the guards and in the list.
        expect(agent.childUsesAccount("claude-code", claude.id)).toBe(false);
        expect(agent.childUsesAccount("codex", codex.id)).toBe(true);
        expect(listed()).toEqual([["codex", "running"]]);
        await expect(engine.handle(rpc, "accounts.remove", { provider: "codex", id: codex.id, confirmedFolder: codex.folder })).rejects.toMatchObject({ code: "busy" });
        expect(existsSync(codex.folder)).toBe(true);
        hosts[0]!.emitSession!({ type: "background_task", task: task("codex", "stopped"), accountId: codex.id });
        await engine.handle(rpc, "accounts.remove", { provider: "codex", id: codex.id, confirmedFolder: codex.folder });
        await engine.handle(rpc, "accounts.remove", { provider: "claude-code", id: claude.id, confirmedFolder: claude.folder });
    } finally {
        answer.resolve({ X: "unknown" });
        engine.runtimes.clear();
        await agent.dispose();
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("model lists come from the starting account, and a session switched to another account is told so", async () => {
    const alpha = addAccount("codex", { id: "cat-alpha", name: "Alpha" });
    const beta = addAccount("codex", { id: "cat-beta", name: "Beta" });
    // The fake lists one more model, different for each account's folder.
    writeFileSync(join(alpha.folder, "fake-model"), "alpha-only");
    writeFileSync(join(beta.folder, "fake-model"), "beta-only");
    setDefaultAccount("codex", alpha.id);
    const engine = new Engine({ startCwd: root });
    const client = { subs: new Set<string>(), send() {} };
    const listed = async (refresh: boolean) => ((await engine.handle(client, "models.list", { refresh })) as any[]).find((p) => p.provider === "codex")?.models.map((m: any) => m.id) ?? [];
    const lastNotice = (rt: { session: { notices: { text: string }[] } }) => rt.session.notices.at(-1)?.text ?? "";
    try {
        const fromAlpha = await listed(true);
        expect(fromAlpha).toContain("alpha-only");
        expect(fromAlpha).not.toContain("beta-only");
        const rt = await engine.createSession(root);
        await engine.handle(client, "session.setAccount", { id: rt.session.meta.id, provider: "codex", accountId: beta.id });
        expect(lastNotice(rt)).toContain("Codex's model list, with each model's effort and speed options, comes from its starting account (Alpha); Beta may not offer all of them.");
        // Refreshing doesn't make it Beta's: the policy is the starting account's list.
        expect(await listed(true)).toEqual(fromAlpha);
        // Switching back to the starting account says nothing more about it.
        const before = rt.session.notices.length;
        await engine.handle(client, "session.setAccount", { id: rt.session.meta.id, provider: "codex", accountId: alpha.id });
        expect(rt.session.notices.length).toBe(before);
        // A new starting account lists its own.
        await engine.handle(client, "accounts.setDefault", { provider: "codex", id: beta.id });
        const fromBeta = await listed(false);
        expect(fromBeta).toContain("beta-only");
        expect(fromBeta).not.toContain("alpha-only");
        await engine.handle(client, "session.setAccount", { id: rt.session.meta.id, provider: "codex", accountId: "default" });
        expect(lastNotice(rt)).toContain("comes from its starting account (Beta); Default may not offer all of them.");
    } finally {
        await engine.stop();
    }
});

for (const provider of ["claude-code", "codex"] as const) test(`${provider}: a signed-out named account is pointed to its own sign-in, live and per run; Default keeps the CLI's`, async () => {
    const named = addAccount(provider, { id: "work", name: "Work" });
    if (provider === "codex") process.env.FAKE_ACCOUNT = "none";
    else process.env.FAKE_SCENARIO = "auth-failed";
    const bare = provider === "codex" ? "`codex login`" : "`claude auth login`";
    try {
        for (const liveSessions of [true, false]) {
            for (const id of [named.id, "default"]) {
                const backend = createBackend(def(provider));
                const result = await backend.runTurn({ ...fakeTurn(provider, id), liveSessions }).catch((e: Error) => ({ reason: "error", error: e.message }));
                await backend.shutdown?.();
                const what = { liveSessions, id };
                expect({ ...what, reason: result.reason }).toEqual({ ...what, reason: "error" });
                const error = String((result as { error?: string }).error);
                if (id === "default") expect({ ...what, error }).toEqual({ ...what, error: expect.stringContaining(`In a terminal, run ${bare}, then try again.`) });
                else {
                    expect({ ...what, error }).toEqual({ ...what, error: expect.stringContaining(`Sign in to the Work account with \`/login ${provider} work\` in the terminal app, or its Sign in button under Settings → Providers, then try again.`) });
                    expect(error).not.toContain(bare);
                }
            }
        }
    } finally {
        removeAccount(provider, named.id, named.folder);
    }
});

/** A session's agent on the fake live Claude Code, through the real Agent loop. */
async function liveClaudeAgent(cwd: string, session: InstanceType<typeof import("../src/agent/session").Session>) {
    const { Agent } = await import("../src/agent/agent");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { BUILTIN_TOOLS } = await import("../src/tools/index");
    const { SessionBackground } = await import("../src/agent/background");
    const { clientFor } = await import("../src/providers/models");
    const trust = await import("../src/config/trust");
    trust.trustForSession(cwd);
    const client = await clientFor("claude-code");
    const agent = new Agent({
        session, model: { provider: "claude-code", id: "default" }, client,
        settings: () => ({}), checker: new PermissionChecker(() => ({}), cwd), tools: BUILTIN_TOOLS,
        mode: { get: () => "default", set() {} },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), background: new SessionBackground() },
        host: { emit() {}, ui: {}, askPermission: async () => ({ allow: true }), wake() {} },
    });
    const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    const running = () => agent.backgroundTasks().filter((t) => t.status === "running" && t.provider === "claude-code");
    return { agent, client, run, running };
}

test("a session's idle live CLI background work holds its account's removal until it's stopped; other account changes go ahead and restart nothing (#375)", async () => {
    const { Session } = await import("../src/agent/session");
    const selected = addAccount("claude-code", { id: "background", name: "Background" });
    const unrelated = addAccount("codex", { id: "unrelated", name: "Unrelated" });
    // Claude Code's background sub-agent goes on after the turn's answer, until it's stopped.
    process.env.FAKE_SCENARIO = "agent-background-stuck";
    process.env.FAKE_SECOND_SCENARIO = "silent";
    const cwd = realpathSync(tempDir("account-background-"));
    const session = Session.create(cwd, { persist: false });
    session.setAccount("claude-code", selected.id);
    const { agent, client, run, running } = await liveClaudeAgent(cwd, session);
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    try {
        expect(await run("map auth in the background")).toBe("done");
        expect(running()).toHaveLength(1);
        // The turn has ended: only the CLI's own background work goes on.
        engine.runtimes.set(session.meta.id, { busy: false, session, agent, ws: { cwd }, toolState: { cwd } } as any);
        await expect(engine.handle(rpc, "accounts.remove", { provider: "claude-code", id: selected.id, confirmedFolder: selected.folder })).rejects.toMatchObject({ code: "busy" });
        expect(existsSync(selected.folder)).toBe(true);
        // Adding an account to either CLI, or removing one it doesn't use, goes ahead (#375): an account only selects
        // a CLI's folder, so nothing is restarted and the work goes on.
        for (const provider of ["claude-code", "codex"]) {
            await expect(engine.handle(rpc, "accounts.add", { provider, id: "while-background", name: "While background" })).resolves.toMatchObject({ id: "while-background" });
        }
        await engine.handle(rpc, "accounts.remove", { provider: "codex", id: unrelated.id, confirmedFolder: unrelated.folder });
        expect(existsSync(unrelated.folder)).toBe(false);
        await Bun.sleep(400);
        expect(running()).toHaveLength(1);
        // The next turn goes to the same process: the new accounts didn't change what it was started with.
        expect(await run("anything else?")).toBe("done");
        expect(launches()).toHaveLength(1);
        expect(running()).toHaveLength(1);
        // Its account stays in use after the session switches: the process signed in with it.
        session.setAccount("claude-code", "default");
        await expect(engine.handle(rpc, "accounts.remove", { provider: "claude-code", id: selected.id, confirmedFolder: selected.folder })).rejects.toMatchObject({ code: "busy" });
        // Once it's stopped, its account can go.
        await agent.stopBackground();
        await until(() => running().length === 0, "the background task to stop");
        await engine.handle(rpc, "accounts.remove", { provider: "claude-code", id: selected.id, confirmedFolder: selected.folder });
        expect(existsSync(selected.folder)).toBe(false);
    } finally {
        engine.runtimes.clear();
        await agent.dispose();
        await (client as any).shutdown?.();
        await engine.stop();
        if (listAccounts("codex").some((a) => a.id === unrelated.id)) removeAccount("codex", unrelated.id, unrelated.folder);
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("an idle live Claude Code process isn't restarted for accounts added or removed between turns (#375)", async () => {
    const { Session } = await import("../src/agent/session");
    process.env.FAKE_SCENARIO = "silent";
    const cwd = realpathSync(tempDir("account-idle-"));
    const session = Session.create(cwd, { persist: false });
    const { agent, client, run } = await liveClaudeAgent(cwd, session);
    try {
        expect(await run("first")).toBe("done");
        const added = addAccount("claude-code", { id: "between-turns", name: "Between turns" });
        expect(await run("second")).toBe("done");
        removeAccount("claude-code", added.id, added.folder);
        expect(await run("third")).toBe("done");
        expect(launches()).toHaveLength(1);
    } finally {
        await agent.dispose();
        await (client as any).shutdown?.();
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("a task an old live process lists after the session switched accounts keeps the process's account", async () => {
    const { Session } = await import("../src/agent/session");
    const selected = addAccount("claude-code", { id: "old-process", name: "Old process" });
    // The background sub-agent ends; then, before its report turn, the same process lists another task for a while.
    process.env.FAKE_SCENARIO = "agent-background";
    process.env.FAKE_LATE_TASK = "1500";
    const cwd = realpathSync(tempDir("account-old-process-"));
    const session = Session.create(cwd, { persist: false });
    session.setAccount("claude-code", selected.id);
    const { agent, client, run, running } = await liveClaudeAgent(cwd, session);
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    const remove = () => engine.handle(rpc, "accounts.remove", { provider: "claude-code", id: selected.id, confirmedFolder: selected.folder });
    try {
        expect(await run("map auth in the background")).toBe("done");
        engine.runtimes.set(session.meta.id, { busy: false, session, agent, ws: { cwd }, toolState: { cwd } } as any);
        session.setAccount("claude-code", "default");
        await until(() => running().some((t) => t.id === "workflow-1") && !running().some((t) => t.id === "agent-1"), "the late task");
        // It started after the switch, on the process signed in with the removed account's folder.
        await expect(remove()).rejects.toMatchObject({ code: "busy" });
        expect(existsSync(selected.folder)).toBe(true);
        await until(() => running().length === 0, "the late task to end");
        await remove();
        expect(existsSync(selected.folder)).toBe(false);
    } finally {
        delete process.env.FAKE_LATE_TASK;
        engine.runtimes.clear();
        await agent.dispose();
        await (client as any).shutdown?.();
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
});

test("Claude Code's live and per-run task reports name the account their process signed in with", async () => {
    const selected = addAccount("claude-code", { id: "stamped", name: "Stamped" });
    process.env.FAKE_SCENARIO = "agent-background";
    try {
        for (const liveSessions of [true, false]) {
            const backend = createBackend(def("claude-code"));
            const reports: { status: string; accountId?: string }[] = [];
            const turn = fakeTurn("claude-code", selected.id);
            turn.liveSessions = liveSessions;
            turn.session = { ...turn.session, emitSession: (e) => { if (e.type === "background_task") reports.push({ status: e.task.status, accountId: e.accountId }); } };
            expect((await backend.runTurn(turn)).reason).toBe("done");
            await until(() => reports.some((r) => r.status !== "running"), "the task's end");
            await backend.shutdown?.();
            expect({ liveSessions, reports: reports.length > 1, accounts: [...new Set(reports.map((r) => r.accountId))] }).toEqual({ liveSessions, reports: true, accounts: [selected.id] });
        }
    } finally {
        removeAccount("claude-code", selected.id, selected.folder);
    }
});

test("a task reported late keeps the account of the turn that bound its host, or the one its backend names", async () => {
    const { Agent } = await import("../src/agent/agent");
    const { Session } = await import("../src/agent/session");
    const { PermissionChecker } = await import("../src/permissions/checker");
    const { SessionBackground } = await import("../src/agent/background");
    const selected = addAccount("claude-code", { id: "late", name: "Late" });
    const cwd = realpathSync(tempDir("account-late-task-"));
    const session = Session.create(cwd, { persist: false });
    session.setAccount("claude-code", selected.id);
    // A live backend keeps the host of a session's last turn, and reports through it between turns.
    const hosts: import("../src/backends/types").SessionHost[] = [];
    const backend: any = {
        agentBackend: true, adoptsTurns: true, setMode() {}, listModels: async () => [],
        stream: async () => { throw new Error("unused"); }, compact: async () => ({ reason: "done", text: "", actions: [] }),
        runTurn: async (t: BackendTurn) => { hosts.push(t.session); t.sink.emit({ type: "text", text: "ok" }); return { reason: "done", text: "ok", actions: [] }; },
    };
    const agent = new Agent({
        session, model: { provider: "claude-code", id: "default" }, client: backend, settings: () => ({}), checker: new PermissionChecker(() => ({}), cwd), tools: [],
        mode: { get: () => "default", set() {} }, toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map(), background: new SessionBackground() },
        host: { emit() {}, ui: {}, askPermission: async () => ({ allow: true }), wake() {} },
    } as any);
    const engine = new Engine({ listModels: async () => [] });
    const rpc = { subs: new Set<string>(), send() {} };
    const remove = () => engine.handle(rpc, "accounts.remove", { provider: "claude-code", id: selected.id, confirmedFolder: selected.folder });
    const task = (id: string, status: "running" | "stopped") => ({ id, provider: "claude-code", kind: "shell" as const, label: id, startedAt: 1, status, stoppable: true });
    try {
        expect(await agent.run([{ type: "text", text: "start" }], { signal: new AbortController().signal })).toBe("done");
        session.setAccount("claude-code", "default");
        expect(await agent.run([{ type: "text", text: "again" }], { signal: new AbortController().signal })).toBe("done");
        engine.runtimes.set(session.meta.id, { busy: false, session, agent, ws: { cwd }, toolState: { cwd } } as any);
        // Through the first turn's host, after the switch: that turn's account.
        hosts[0]!.emitSession!({ type: "background_task", task: task("late-1", "running") });
        await expect(remove()).rejects.toMatchObject({ code: "busy" });
        hosts[0]!.emitSession!({ type: "background_task", task: task("late-1", "stopped") });
        // Through the newer host (as after an adopted wake), from a process the backend says signed in with the old account.
        hosts[1]!.emitSession!({ type: "background_task", task: task("late-2", "running"), accountId: selected.id });
        await expect(remove()).rejects.toMatchObject({ code: "busy" });
        hosts[1]!.emitSession!({ type: "background_task", task: task("late-2", "stopped"), accountId: selected.id });
        await remove();
        expect(existsSync(selected.folder)).toBe(false);
    } finally {
        engine.runtimes.clear();
        await agent.dispose();
        await engine.stop();
        rmSync(cwd, { recursive: true, force: true });
    }
});
