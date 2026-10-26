// Randomized switch sequences (#414): a seeded generator drives the real Engine and Runtime through model,
// provider and CLI-account switches, forks, compactions, rewinds, failures, interrupts, steering, background
// wakes, account removal and reloads, with the fake Claude Code and Codex CLIs and the mock model, and checks
// invariants after every step. What each CLI thread received is read from the fakes' own transcripts
// (FAKE_TRANSCRIPTS), never from Harness's view of it. The generator favours #413's round trip (away from a CLI
// thread to another model or account, a message there, back, a message): the thread must go on, sent only what it
// missed.
//
//   FUZZ_SEED=n        replay one seed            FUZZ_RUNS=n   how many seeds (default 3: 1..3)
//   FUZZ_STEPS=n       operations per run (12)     FUZZ_BASE=n   the first seed (1)
//   FUZZ_OPS=file      replay exactly this operation list (JSON, as a failure saves it)
//   FUZZ_UNGATE=n,…|all     run what a gate below skips (by issue number)
//   FUZZ_SHRINK=1      on a failure, drop operations one at a time while it still fails the same way
//   FUZZ_VERBOSE=1     print each run's operations
//   FUZZ_CONTINUE=1    go on after a failing seed; all failures are reported at the end
//   FUZZ_KEEP=1        keep the temp folder (the fakes' logs, the failure files)
//
// A failure prints the seed and the operation list, and saves both to fuzz-failure-<seed>.json under the test's
// temp folder (its path is printed).
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { ServerEvent, SessionSnapshot } from "../src/server/protocol";

const iso = isolate();
const root = realpathSync(tempDir("switch-fuzz-"));
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { listAccounts, removeAccount } = await import("../src/providers/accounts");
const { saveAgentConfig } = await import("../src/providers/registry");
const { forgetClient } = await import("../src/providers/models");

// ---------------------------------------------------------------------------
// Gates: operations (or assertions) a known bug or a decided-but-unbuilt behaviour breaks. Each is on by default
// so the default run is green; FUZZ_UNGATE turns them off. Remove a gate when its issue is fixed.

const ungated = new Set((process.env.FUZZ_UNGATE ?? "").split(",").map((s) => s.trim()).filter(Boolean));
const gate = (issue: number) => !ungated.has("all") && !ungated.has(String(issue));
// The gates this test started with (#406, #407 and #410–#413) went with their fixes (#416–#419, #422), and #424's
// (Esc between Claude Code's `started` and its system/init) with its own. A new one: `KNOWN_n: gate(n)`.
const GATES: Record<string, boolean> = {};

const RUNS = Number(process.env.FUZZ_RUNS ?? 3);
const STEPS = Number(process.env.FUZZ_STEPS ?? 12);
const BASE = Number(process.env.FUZZ_BASE ?? 1);
/** How long a step may take to come back to idle (invariant 5). */
const IDLE_BOUND_MS = 20_000;
const verbose = process.env.FUZZ_VERBOSE === "1";

// ---------------------------------------------------------------------------
// The world: the mock model as two API providers, the fake CLIs behind wrappers (which can fail to start).

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [
    { id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false },
    { id: "mock2", name: "Mock Two", baseUrl: mock.url, requiresKey: false },
] }));
const settingsFile = join(iso.home, "settings.json");
const writeSettings = (live: boolean) => writeFileSync(settingsFile, JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku", autoResume: true, ...(live ? {} : { agentCli: { liveSessions: false } }) }));
writeSettings(true);

type Cli = "claude-code" | "codex";
const CLIS: Cli[] = ["claude-code", "codex"];
for (const [provider, fixture] of [["claude-code", "fake-claude.ts"], ["codex", "fake-codex.ts"]] as const) {
    const wrapper = join(root, provider);
    // FUZZ_SPAWN_FAIL: the CLI can't start (a spawn failure, as a missing or broken binary).
    writeFileSync(wrapper, `#!/bin/sh\nif [ -n "$FUZZ_SPAWN_FAIL" ]; then echo "fuzz: can't start" >&2; exit 127; fi\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`);
    chmodSync(wrapper, 0o700);
    saveAgentConfig(provider, { path: wrapper, accounts: [], defaultAccount: "default" });
    forgetClient(provider);
}
const DEFAULT_HOME: Record<Cli, string> = { "claude-code": process.env.CLAUDE_CONFIG_DIR!, codex: process.env.CODEX_HOME! };
/** Every fake setting the steps change: in the environment new processes start with, and in the file live ones read per prompt. */
const envFile = join(root, "fake-env.json");
const BASE_ENV: Record<string, string> = {
    FAKE_TRANSCRIPTS: "1",
    FAKE_UNIQUE_THREADS: "1",
    FAKE_SCENARIO: "plain",
    FAKE_CODEX_SCENARIO: "steps",
    // As Codex 0.163 does: steered input waits for the turn's next step, and an interrupt drops it (#438).
    FAKE_STEER_PENDING: "1",
    FAKE_ENV_FILE: envFile,
    FAKE_CLAUDE_ENV_FILE: envFile,
};
let fakeKeys = new Set<string>();
function setFakeEnv(over: Record<string, string> = {}) {
    for (const k of fakeKeys) delete process.env[k];
    const env = { ...BASE_ENV, ...over };
    fakeKeys = new Set(Object.keys(env));
    Object.assign(process.env, env);
    // Without FAKE_ENV_FILE / FAKE_LOG themselves: the fakes keep those.
    const file = Object.fromEntries(Object.entries(env).filter(([k]) => k.startsWith("FAKE_") && k !== "FAKE_ENV_FILE" && k !== "FAKE_CLAUDE_ENV_FILE"));
    writeFileSync(envFile, JSON.stringify({ ...file, ...(process.env.FAKE_LOG ? { FAKE_LOG: process.env.FAKE_LOG } : {}) }));
}
setFakeEnv();
afterAll(() => {
    for (const k of fakeKeys) delete process.env[k];
    delete process.env.FUZZ_SPAWN_FAIL;
    mock.stop();
    iso.cleanup();
    if (!process.env.FUZZ_KEEP) rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// A seeded PRNG (mulberry32).

function prng(seed: number) {
    let a = seed >>> 0;
    const next = () => {
        a = (a + 0x6d2b79f5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    return { next, int: (n: number) => Math.floor(next() * n), pick: <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]! };
}

// ---------------------------------------------------------------------------
// Operations: small records, generated from the seed and the state, replayable as they are.

const MODELS = ["claude-code:default", "claude-code:sonnet", "codex:default", "codex:gpt-other", "mock:mock-opus", "mock2:mock-sonnet"] as const;
type AcctKey = "default" | "shared" | "own";
type FailHow = "auth" | "limit" | "signedout" | "spawn" | "gone";
type Op =
    | { k: "send"; s: number }
    | { k: "model"; s: number; ref: string }
    | { k: "account"; s: number; provider: Cli; acct: AcctKey }
    | { k: "fork"; s: number; pick: number; go: boolean }
    | { k: "focus"; s: number }
    | { k: "compact"; s: number; idle: boolean }
    | { k: "rewind"; s: number; pick: number }
    | { k: "fail"; s: number; how: FailHow }
    | { k: "interrupt"; s: number; at?: number; init?: number }
    /** `esc`: on Codex, Esc this many ms after the steer is sent (Codex may have accepted it and not taken it yet, #438). */
    | { k: "steer"; s: number; esc?: number }
    | { k: "wake"; s: number }
    | { k: "remove"; provider: Cli; acct: Exclude<AcctKey, "default"> }
    | { k: "readd"; provider: Cli; acct: Exclude<AcctKey, "default"> }
    | { k: "reload" }
    | { k: "live"; on: boolean }
    | { k: "goal"; s: number };

const isCli = (ref: string | undefined): ref is `${Cli}:${string}` => Boolean(ref && (ref.startsWith("claude-code:") || ref.startsWith("codex:")));
const cliOf = (ref: string) => ref.split(":")[0] as Cli;

interface Tok {
    text: string;
    sentAt: number;
}
interface FuzzSession {
    id: string;
    /** The conversation as the user made it: their messages, in order (rewinds and compactions take some away). */
    tokens: Tok[];
}
interface Account { id: string; name: string; folder?: string; present: boolean }
interface World {
    /** The run's own: in its tokens. */
    tag: string;
    engine: InstanceType<typeof Engine>;
    client: { subs: Set<string>; send: (e: ServerEvent) => void };
    cwd: string;
    sessions: FuzzSession[];
    focus: number;
    live: boolean;
    accounts: Record<Cli, Record<Exclude<AcctKey, "default">, Account>>;
    tokenSeq: number;
    /** Every token sent in this run, for the no-duplicates check. */
    allTokens: Set<string>;
    /** Per session and CLI, the threads it ran in each history folder, for #413. */
    slots: Map<string, string>;
    /** CLI turns checked (invariant 1), turn starts (invariant 2), and round trips: an earlier thread caught up (#413). */
    stats: { turns: number; starts: number; caughtUp: number };
    /** What each session gave back to the user's message box (draft events). */
    drafts: Map<string, string[]>;
    /** Operations the generator already chose (the rest of a round trip), taken before it picks again. */
    queue: Op[];
}

class Violation extends Error {
    constructor(readonly invariant: string, detail: string) {
        super(`${invariant}: ${detail}`);
    }
}

// ---------------------------------------------------------------------------
// The fakes' transcripts.

interface Sent { text: string; home: string | null; at: number; pid: number }
interface Thread { file: string; provider: Cli; id: string; sent: Sent[]; headers: string[] }

const real = (p: string) => { try { return realpathSync(p); } catch { return p; } };
/** History folders to look in: Default's, and each existing-folder account's (Harness-made ones link Default's). */
function historyRoots(w: World): { provider: Cli; dir: string }[] {
    const out: { provider: Cli; dir: string }[] = [];
    for (const provider of CLIS) {
        const homes = [DEFAULT_HOME[provider], w.accounts[provider].own.folder!];
        for (const home of homes) out.push({ provider, dir: provider === "codex" ? join(home, "sessions") : join(home, "projects") });
    }
    return out;
}
function readThreads(w: World): Thread[] {
    const files = new Map<string, Cli>();
    for (const { provider, dir } of historyRoots(w)) {
        if (!existsSync(dir)) continue;
        const dirs = provider === "codex" ? [dir] : readdirSync(dir).map((d) => join(dir, d)).filter((d) => statSync(d).isDirectory());
        for (const d of dirs) for (const f of readdirSync(d)) if (f.endsWith(".jsonl")) files.set(real(join(d, f)), provider);
    }
    return [...files].map(([file, provider]) => {
        const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
        return {
            file, provider, id: basename(file, ".jsonl"),
            sent: lines.filter((l) => l.type === "fake-sent"),
            headers: lines.filter((l) => !l.type && (l.sessionId || l.id)).map((l) => String(l.sessionId ?? l.id)),
        };
    });
}
/** What the model of a thread was sent and took: its words a fixture repeats back (steering) left out. */
const taken = (t: Thread) => t.sent.map((s) => s.text.replace(/(Adjusted|Heard): [^\n]*/g, "")).join("\n");
const count = (hay: string, needle: string) => hay.split(needle).length - 1;
/** A prompt that's a command of the CLI's own (/compact), not a turn of the conversation. */
const command = (s: Sent) => /^\/\w/.test(s.text.trim());

// ---------------------------------------------------------------------------
// Harness's side, only to pick operations and to check reloads and the session's own record.

const rtOf = (w: World, s: FuzzSession) => w.engine.runtimes.get(s.id);
const textOf = (m: any): string => (Array.isArray(m.content) ? m.content.map((p: any) => (typeof p.text === "string" ? p.text : "")).join("\n") : typeof m.content === "string" ? m.content : "");
function userText(w: World, s: FuzzSession): string {
    const rt = rtOf(w, s);
    // Not Harness's reminders: one quotes a steered message its turn ended before taking, for the next prompt (#438).
    return rt ? rt.session.messages.filter((m: any) => m.role === "user" && m.meta?.kind !== "reminder").map(textOf).join("\n") : "";
}
/** The account a session has selected for a CLI, and its folder (undefined: the account is gone). */
function selected(w: World, s: FuzzSession, provider: Cli): { id: string; folder?: string } {
    const id = rtOf(w, s)!.session.accountId(provider);
    const a = listAccounts(provider).find((x) => x.id === id);
    return { id, folder: a ? real(a.folder) : undefined };
}
function modelOf(w: World, s: FuzzSession): string | undefined {
    const m = rtOf(w, s)?.model;
    return m ? `${m.provider}:${m.id}` : undefined;
}
/** The session's CLI thread is behind: messages since its cursor that it hasn't been sent. */
function stale(w: World, s: FuzzSession, provider: Cli): boolean {
    const rt = rtOf(w, s)!;
    const b = rt.session.backends.get(provider);
    return Boolean(b && (b.synced < rt.session.messages.length || b.unsent));
}
function reloadState(w: World, s: FuzzSession) {
    const sess = rtOf(w, s)!.session;
    return {
        model: sess.model,
        accounts: Object.fromEntries(CLIS.map((p) => [p, sess.accountId(p)])),
        backends: Object.fromEntries([...sess.backends].sort(([a], [b]) => a.localeCompare(b))),
        places: Object.fromEntries(CLIS.map((p) => [p, sess.backendPlace(p) ?? null])),
        messages: sess.messages.length,
    };
}
/** The session is on a CLI whose selected account was removed (#410). */
function accountMissing(w: World, s: FuzzSession): boolean {
    const model = modelOf(w, s);
    return isCli(model) && !selected(w, s, cliOf(model)).folder;
}
/** What the session holds for the user to send: its queue (#410's held messages). */
const heldText = (w: World, s: FuzzSession): string => ((rtOf(w, s) as any)?.queued ?? []).map((q: { text: string }) => q.text).join("\n");
const pendingResume = (w: World, s: FuzzSession) => Boolean(rtOf(w, s)?.schedules.scheduler.list().some((j) => j.kind === "resume"));
function allIdle(w: World): boolean {
    return w.sessions.every((s) => {
        const rt = rtOf(w, s);
        // #410: a message held for an account to be picked waits for the user, as an idle session does.
        return !rt || (rt.idle && !rt.busy) || (!rt.busy && accountMissing(w, s));
    });
}
async function settle(w: World, what: string) {
    const end = Date.now() + IDLE_BOUND_MS;
    // Twice in a row, a moment apart: a wake or a queued message can start a turn just after one ends.
    for (let quiet = 0; quiet < 2; ) {
        if (Date.now() > end) {
            const busy = w.sessions.map((s, i) => {
                const rt = rtOf(w, s) as any;
                if (!rt || (rt.idle && !rt.busy)) return "";
                const tasks = (rt.agent?.backgroundTasks() ?? []).filter((t: any) => t.status === "running").map((t: any) => `${t.provider}:${t.kind}:${t.label}`);
                return `s${i} busy=${rt.busy} status=${rt.status} queued=${Boolean(rt.nextQueued())} pending=${rt.pending?.size} switching=${Boolean(rt.switching)} goal=${rt.goal?.pending?.()} tasks=[${tasks.join(", ")}] delegated=${(rt.agent?.delegatedTasks ?? []).length}`;
            }).filter(Boolean);
            throw new Violation("5 wedged", `not idle ${IDLE_BOUND_MS} ms after ${what}: ${busy.join("; ")}`);
        }
        quiet = allIdle(w) ? quiet + 1 : 0;
        await Bun.sleep(quiet ? 120 : 25);
    }
}
async function until(done: () => boolean, ms = 8000): Promise<boolean> {
    const end = Date.now() + ms;
    while (!done()) {
        if (Date.now() > end) return false;
        await Bun.sleep(15);
    }
    return true;
}
const rpc = (w: World, method: Parameters<World["engine"]["handle"]>[1], params: Record<string, unknown>) => w.engine.handle(w.client as never, method, params);

// ---------------------------------------------------------------------------
// Generating operations.

function candidates(w: World, r: ReturnType<typeof prng>): [number, Op | Op[]][] {
    const s = w.focus;
    const sess = w.sessions[s]!;
    const rt = rtOf(w, sess)!;
    const model = modelOf(w, sess);
    const cli = isCli(model) ? cliOf(model) : undefined;
    const out: [number, Op | Op[]][] = [];
    out.push([10, { k: "send", s }]);
    // Often back to a CLI the session has a thread with: where catch-up happens.
    const back = MODELS.filter((m) => m !== model && isCli(m) && rt.session.backends.has(cliOf(m)));
    out.push([6, { k: "model", s, ref: back.length && r.next() < 0.5 ? r.pick(back) : r.pick(MODELS.filter((m) => m !== model)) }]);
    {
        const provider = r.pick(CLIS);
        const now = rt.session.accountId(provider);
        const choices = (["default", "shared", "own"] as AcctKey[]).filter((a) => (a === "default" || w.accounts[provider][a].present) && acctId(w, provider, a) !== now);
        if (choices.length) out.push([6, { k: "account", s, provider, acct: r.pick(choices) }]);
    }
    // #410: the session's CLI account was removed and its messages are held: picking one sends them (or it'd idle out the run).
    if (cli && accountMissing(w, sess)) {
        const present = (["default", "shared", "own"] as AcctKey[]).filter((a) => a === "default" || w.accounts[cli][a].present);
        out.push([12, { k: "account", s, provider: cli, acct: r.pick(present) }]);
    }
    const forkable = rt.snapshot().turns.filter((t) => t.prompt && t.prompt.index !== undefined && !t.prompt.wake && t.status !== "running" && !t.archived);
    if (forkable.length && w.sessions.length < 4) out.push([2, { k: "fork", s, pick: r.next(), go: r.next() < 0.5 }]);
    if (w.sessions.length > 1) out.push([2, { k: "focus", s: r.pick(w.sessions.map((_, i) => i).filter((i) => i !== s)) }]);
    const behind = Boolean(cli && stale(w, sess, cli));
    if (rt.session.messages.length >= 2) out.push([behind ? 5 : 2, { k: "compact", s, idle: r.next() < 0.4 }]);
    if (rt.rewindTargets().length) out.push([2, { k: "rewind", s, pick: r.next() }]);
    if (cli) {
        const hows: FailHow[] = [...(rt.session.backends.has(cli) ? (["gone"] as const) : []), ...(cli === "codex" ? (["spawn", "limit", "signedout"] as const) : (["spawn", "auth", "limit"] as const))];
        if (hows.length) out.push([3, { k: "fail", s, how: r.pick(hows) }]);
    }
    // Esc once the CLI has the prompt, or `at` ms after sending it (while it may be on its way).
    out.push([2, { k: "interrupt", s, ...(r.next() < 0.5 ? { at: r.int(60) } : {}), ...(cli === "claude-code" && r.next() < 0.3 ? { init: 300 } : {}) }]);
    out.push([2, { k: "steer", s }]);
    // On Codex, Esc soon after a steer: it may have been accepted and not taken yet (#438).
    if (cli === "codex") out.push([3, { k: "steer", s, esc: r.int(300) }]);
    if (cli && w.live) out.push([3, { k: "wake", s }]);
    if (cli === "codex" && w.live) out.push([1, { k: "goal", s }]);
    for (const provider of CLIS) for (const acct of ["shared", "own"] as const) {
        const a = w.accounts[provider][acct];
        if (a.present) out.push([1, { k: "remove", provider, acct }]);
        if (!a.present) out.push([2, { k: "readd", provider, acct }]);
    }
    // #413's round trip: away from the CLI thread (another model, or another account of the CLI), a message there,
    // back, and a message: the thread goes on, sent only what it missed. Each is a step of its own, checked as any.
    if (cli && rt.session.backends.has(cli)) {
        const now = rt.session.accountId(cli);
        const nowKey = (["default", "shared", "own"] as AcctKey[]).find((a) => acctId(w, cli, a) === now);
        const others = (["default", "shared", "own"] as AcctKey[]).filter((a) => a !== nowKey && (a === "default" || w.accounts[cli][a].present));
        const send: Op = { k: "send", s };
        if (nowKey && others.length && r.next() < 0.4) out.push([4, [{ k: "account", s, provider: cli, acct: r.pick(others) }, send, { k: "account", s, provider: cli, acct: nowKey }, send]]);
        else out.push([4, [{ k: "model", s, ref: r.pick(MODELS.filter((m) => !m.startsWith(`${cli}:`))) }, send, { k: "model", s, ref: model! }, send]]);
    }
    if (reloadable(w)) out.push([1, { k: "reload" }]);
    out.push([1, { k: "live", on: !w.live }]);
    return out;
}
/** A session nothing was said in isn't kept on disk, so it can't be reopened: a restart only once each has a message. */
const reloadable = (w: World) => w.sessions.every((s) => (rtOf(w, s)?.session.messages.length ?? 0) > 0);
function generate(w: World, r: ReturnType<typeof prng>): Op {
    if (w.queue.length) return w.queue.shift()!;
    const c = candidates(w, r);
    let x = r.next() * c.reduce((n, [weight]) => n + weight, 0);
    let picked = c.at(-1)![1];
    for (const [weight, op] of c) if ((x -= weight) < 0) { picked = op; break; }
    if (!Array.isArray(picked)) return picked;
    w.queue.push(...picked.slice(1));
    return picked[0]!;
}
const acctId = (w: World, provider: Cli, acct: AcctKey) => (acct === "default" ? "default" : w.accounts[provider][acct].id);
const describe = (op: Op) => JSON.stringify(op);

// ---------------------------------------------------------------------------
// Running operations. Each returns false when its preconditions don't hold (on replay, say): then it's skipped.

/** What a usage limit's auto-resume belongs to: the model and, for a CLI, the account the session has for it. */
function limitIdentity(w: World, s: FuzzSession): string {
    const model = modelOf(w, s);
    return `${model}|${isCli(model) ? rtOf(w, s)!.session.accountId(cliOf(model)) : ""}`;
}
/**
 * A model or account switch. #411: a usage-limit auto-resume that was waiting is cancelled when the switch changes
 * the model or its CLI's account, and stays when it doesn't (another CLI's account).
 */
async function switched(w: World, s: FuzzSession, act: () => Promise<unknown>): Promise<true | string> {
    const waiting = pendingResume(w, s);
    const was = limitIdentity(w, s);
    await act();
    if (!waiting) return true;
    const now = limitIdentity(w, s);
    if (now !== was && pendingResume(w, s)) throw new Violation("#411 limit resume", `the session's usage-limit auto-resume is still scheduled after a switch from ${was} to ${now}`);
    if (now === was && !pendingResume(w, s)) throw new Violation("#411 limit resume", `the session's usage-limit auto-resume was cancelled by a switch that left ${now} as it was`);
    return now === was ? "a limit resume was waiting, and stays" : "a limit resume was waiting";
}
/** After a rewind or a compaction: the user's messages that are still the conversation. */
function prune(w: World, s: FuzzSession) {
    const text = userText(w, s);
    s.tokens = s.tokens.filter((t) => count(text, t.text) > 0);
}
function nextToken(w: World) {
    return `FZ${w.tag}x${++w.tokenSeq}ZF`;
}
async function send(w: World, s: FuzzSession, text: string, token: string, mode?: "steer") {
    const tok = { text: token, sentAt: Date.now() };
    await rpc(w, "session.send", { id: s.id, text, ...(mode ? { mode } : {}) });
    s.tokens.push(tok);
    w.allTokens.add(token);
}
/** Waits until the session's current turn is running and its model has `token` (a CLI's transcript), or a moment for an API model. */
async function reached(w: World, s: FuzzSession, token: string) {
    const rt = rtOf(w, s)!;
    if (!isCli(modelOf(w, s))) return until(() => rt.busy).then(() => Bun.sleep(150));
    await until(() => readThreads(w).some((t) => t.sent.some((x) => x.text.includes(token))) || !rt.busy, 6000);
}

async function apply(w: World, op: Op): Promise<boolean | string> {
    if ("s" in op && op.k !== "focus" && !w.sessions[op.s]) return false;
    const s = "s" in op ? w.sessions[op.s]! : w.sessions[w.focus]!;
    const model = "s" in op ? modelOf(w, s) : undefined;
    switch (op.k) {
        case "send": {
            const t = nextToken(w);
            await send(w, s, t, t);
            return true;
        }
        case "model":
            if (model === op.ref) return false;
            return switched(w, s, () => rpc(w, "session.setModel", { id: s.id, ref: op.ref, persist: false }));
        case "account": {
            const a = op.acct === "default" ? { id: "default", present: true } : w.accounts[op.provider][op.acct];
            if (!a.present) return false;
            return switched(w, s, () => rpc(w, "session.setAccount", { id: s.id, provider: op.provider, accountId: a.id }));
        }
        case "fork": {
            const rt = rtOf(w, s)!;
            const turns = rt.snapshot().turns.filter((t) => t.prompt && t.prompt.index !== undefined && !t.prompt.wake && t.status !== "running" && !t.archived);
            if (!turns.length) return false;
            const t = turns[Math.min(turns.length - 1, Math.floor(op.pick * turns.length))]!;
            const snap = (await rpc(w, "session.fork", { id: s.id, index: t.prompt!.index, text: t.prompt!.text, turn: t.id })) as SessionSnapshot;
            const fork: FuzzSession = { id: snap.state.id, tokens: [] };
            const had = userText(w, { id: fork.id, tokens: [] });
            fork.tokens = s.tokens.filter((x) => count(had, x.text) > 0);
            // #413: the fork goes on in a thread of the session's only if all that thread had is in what the fork keeps.
            // One with messages from past the fork point can't be continued (a fork from before them starts its own).
            const kept = new Set(fork.tokens.map((x) => x.text));
            for (const [key, id] of [...w.slots]) {
                if (!key.startsWith(`${s.id}|`)) continue;
                const file = join(key.split("|").slice(2).join("|"), `${id}.jsonl`);
                const sent = existsSync(file) ? readFileSync(file, "utf8") : "";
                const had = [...w.allTokens].filter((tok) => sent.includes(tok));
                if (had.length && had.every((tok) => kept.has(tok))) w.slots.set(fork.id + key.slice(s.id.length), id);
            }
            w.sessions.push(fork);
            if (op.go) w.focus = w.sessions.length - 1;
            return `forked at ${t.prompt!.text.slice(0, 20)} -> s${w.sessions.length - 1}`;
        }
        case "focus":
            if (!w.sessions[op.s]) return false;
            w.focus = op.s;
            return true;
        case "compact": {
            const rt = rtOf(w, s)!;
            if (rt.session.messages.length < 2) return false;
            if (op.idle) await rt.compact(undefined, { idle: true });
            else await rpc(w, "session.compact", { id: s.id });
            // Harness's own compaction (an API model's) leaves a summary: the messages before it are no longer the conversation,
            // and the CLI threads start over from it.
            prune(w, s);
            if (!isCli(model)) forgetSlots(w, s);
            return true;
        }
        case "rewind": {
            const targets = (await rpc(w, "session.rewindTargets", { id: s.id })) as { index: number; text: string }[];
            if (!targets.length) return false;
            const t = targets[Math.min(targets.length - 1, Math.floor(op.pick * targets.length))]!;
            const plan = (await rpc(w, "session.rewindPlan", { id: s.id, index: t.index })) as { planId: string };
            await rpc(w, "session.rewind", { id: s.id, index: t.index, planId: plan.planId, code: false, conversation: true });
            prune(w, s);
            forgetSlots(w, s);
            return `to ${t.text.slice(0, 20)}`;
        }
        case "fail": {
            if (!isCli(model)) return false;
            const cli = cliOf(model);
            const over: Record<string, string> = {};
            if (op.how === "auth") over.FAKE_SCENARIO = "auth-failed";
            if (op.how === "limit") {
                const limit = join(root, `limit-${w.tag}.json`);
                const resetsAt = Math.floor(Date.now() / 1000) + 3600;
                writeFileSync(limit, JSON.stringify({ status: "rejected", resetsAt, rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt } } }));
                over.FAKE_SCENARIO = "rate-limit";
                over.FAKE_RATE_LIMIT = limit;
                over.FAKE_CODEX_SCENARIO = "usage-limit";
            }
            if (op.how === "signedout") over.FAKE_ACCOUNT = "none";
            if (op.how === "gone") {
                const b = rtOf(w, s)!.session.backends.get(cli);
                if (!b) return false;
                over.FAKE_GONE_ID = b.id;
                forgetSlots(w, s, cli);
            }
            setFakeEnv(over);
            if (op.how === "spawn") process.env.FUZZ_SPAWN_FAIL = "1";
            try {
                const t = nextToken(w);
                await send(w, s, t, t);
                await settle(w, describe(op));
            } finally {
                delete process.env.FUZZ_SPAWN_FAIL;
                setFakeEnv();
            }
            return true;
        }
        case "interrupt": {
            const t = nextToken(w);
            // `init`: Claude Code says its turn started (system/init) this late, after it took the prompt.
            setFakeEnv({ FAKE_SCENARIO: "hang", FAKE_CODEX_SCENARIO: "hang", ...(op.init ? { FAKE_INIT_DELAY_MS: String(op.init) } : {}) });
            try {
                await send(w, s, isCli(model) ? t : `${t} hangforever`, t);
                if (op.at === undefined) await reached(w, s, t);
                else await Bun.sleep(op.at);
                await rpc(w, "session.interrupt", { id: s.id });
                await settle(w, describe(op));
            } finally {
                setFakeEnv();
            }
            return true;
        }
        case "steer": {
            const a = nextToken(w);
            const b = nextToken(w);
            const esc = op.esc !== undefined && model?.startsWith("codex:");
            setFakeEnv({ FAKE_SCENARIO: "steering", FAKE_CODEX_SCENARIO: "hang", FAKE_HANG_MS: esc ? "20000" : "900" });
            try {
                await send(w, s, isCli(model) ? a : `${a} pause`, a);
                await reached(w, s, a);
                await send(w, s, b, b, "steer");
                if (esc) {
                    await Bun.sleep(op.esc!);
                    await rpc(w, "session.interrupt", { id: s.id });
                }
                await settle(w, describe(op));
            } finally {
                setFakeEnv();
            }
            return true;
        }
        case "wake": {
            if (!isCli(model) || !w.live) return false;
            setFakeEnv({ FAKE_SCENARIO: "agent-background", FAKE_BACKGROUND_MS: "300", FAKE_CODEX_SCENARIO: "bg", FAKE_BG_MS: "300" });
            try {
                const t = nextToken(w);
                await send(w, s, t, t);
                // Only this prompt's turn starts background work: the turn for its report doesn't start more.
                await reached(w, s, t);
                setFakeEnv();
                await settle(w, describe(op));
            } finally {
                setFakeEnv();
            }
            return true;
        }
        case "goal": {
            // #412: a Codex goal running, then the session switches to another model: the goal must pause.
            if (cliOf(model ?? "") !== "codex" || !w.live) return false;
            // A goal that keeps Codex starting turns of its own (a slash command of the CLI's: not a message of the conversation).
            setFakeEnv({ FAKE_GOAL_TURNS: "1000", FAKE_GOAL_CONTINUE_MS: "150" });
            const goals = `${process.env.FAKE_LOG}.goals.json`;
            const goal = () => {
                const thread = rtOf(w, s)!.session.backends.get("codex")?.id ?? "";
                return { thread, status: existsSync(goals) ? (JSON.parse(readFileSync(goals, "utf8"))[thread]?.status as string | undefined) : undefined };
            };
            try {
                await rpc(w, "session.send", { id: s.id, text: "/goal keep the checks passing" });
                if (!(await until(() => goal().status === "active", 5000))) return "the goal didn't start";
                await until(() => !rtOf(w, s)!.busy, 3000);
                await rpc(w, "session.setModel", { id: s.id, ref: "mock:mock-opus", persist: false });
                await Bun.sleep(600);
                const g = goal();
                if (g.status === "active") throw new Violation("#412 goal pause", `Codex's goal on ${g.thread} is still active 600 ms after the session switched to mock:mock-opus`);
            } finally {
                setFakeEnv();
            }
            return true;
        }
        case "remove": {
            const a = w.accounts[op.provider][op.acct];
            if (!a.present) return false;
            const folder = listAccounts(op.provider).find((x) => x.id === a.id)!.folder;
            await rpc(w, "accounts.remove", { provider: op.provider, id: a.id, confirmedFolder: folder });
            a.present = false;
            return true;
        }
        case "readd": {
            const a = w.accounts[op.provider][op.acct];
            if (a.present) return false;
            await rpc(w, "accounts.add", { provider: op.provider, id: a.id, name: a.name, ...(a.folder && op.acct === "own" ? { folder: a.folder } : {}) });
            a.present = true;
            return true;
        }
        case "reload": {
            if (!reloadable(w)) return false;
            const before = w.sessions.map((x) => reloadState(w, x));
            await w.engine.stop();
            w.engine = new Engine();
            w.engine.clients.add(w.client as never);
            for (const [i, x] of w.sessions.entries()) {
                try {
                    await rpc(w, "session.open", { id: x.id });
                } catch (e) {
                    throw new Violation("4 reload-stable", `s${i} couldn't be opened again: ${(e as Error).message}`);
                }
                await rtOf(w, x)!.ready.catch(() => undefined);
            }
            const after = w.sessions.map((x) => reloadState(w, x));
            for (let i = 0; i < before.length; i++) {
                if (!Bun.deepEquals(before[i], after[i])) throw new Violation("4 reload-stable", `s${i} before ${JSON.stringify(before[i])}\n  after ${JSON.stringify(after[i])}`);
            }
            return true;
        }
        case "live":
            if (w.live === op.on) return false;
            w.live = op.on;
            writeSettings(op.on);
            w.engine.reloadSettings();
            return true;
    }
}

// ---------------------------------------------------------------------------
// Invariants, after every step.

interface StepStart {
    at: number;
    /** Per session and CLI: the selected account's folder (undefined: removed). */
    homes: Map<string, Record<Cli, string | undefined>>;
    /** Sessions on a CLI whose selected account was removed (#410). */
    missing: Set<string>;
    stepSession: FuzzSession;
}

function check(w: World, start: StepStart, threads: Thread[]) {
    // 3. No lost input: each of the user's messages is in the session once, held for them (#410), or given back to
    // their message box (Esc with messages waiting): then it's theirs again, no longer the conversation's.
    for (const [i, s] of w.sessions.entries()) {
        const text = userText(w, s);
        const held = heldText(w, s);
        const back = (w.drafts.get(s.id) ?? []).join("\n");
        for (const t of [...s.tokens]) {
            const where = { session: count(text, t.text), held: count(held, t.text), returned: count(back, t.text) };
            if (where.session + where.held + where.returned !== 1) throw new Violation("3 no lost input", `s${i}: the user's message ${t.text} is in the session ${where.session} times, held ${where.held} times, back in the message box ${where.returned} times`);
            // #410: sent while the session's CLI account was gone, it's held (not stored, not run anywhere) until an account is picked.
            if (start.missing.has(s.id) && t.sentAt >= start.at && accountMissing(w, s) && where.session) throw new Violation("#410 held message", `s${i}: ${t.text}, sent while its ${modelOf(w, s)} account was removed, was stored as a prompt rather than held for an account to be picked`);
            if (where.returned) s.tokens = s.tokens.filter((x) => x !== t);
        }
    }
    for (const t of threads) {
        const fresh = t.sent.filter((x) => x.at >= start.at);
        if (!fresh.length) continue;
        const owner = w.sessions.find((s) => rtOf(w, s)?.session.backends.get(t.provider)?.id === t.id && s === start.stepSession)
            ?? w.sessions.find((s) => rtOf(w, s)?.session.backends.get(t.provider)?.id === t.id)
            ?? start.stepSession;
        const ownerIndex = w.sessions.indexOf(owner);
        // 2. Right account: each turn ran with the home of the account the session had selected when it started: at the
        // step's start, or after its switch (an account picked for held messages sends them in the same step).
        const want = [start.homes.get(owner.id)?.[t.provider], selected(w, owner, t.provider).folder].filter((x): x is string => Boolean(x));
        for (const x of fresh) {
            const got = real(x.home ?? DEFAULT_HOME[t.provider]);
            if (!want.length) throw new Violation("2 right account", `${t.provider} thread ${t.id} ran a turn (pid ${x.pid}) for s${ownerIndex}, whose selected account was removed`);
            if (!want.includes(got)) throw new Violation("2 right account", `${t.provider} thread ${t.id} ran a turn (pid ${x.pid}) for s${ownerIndex} in ${got}, but the session had ${want.join(" then ")} selected`);
        }
        // 1. No loss, no duplicates: a thread that ran a turn has had every earlier user message exactly once.
        const all = taken(t);
        for (const tok of w.allTokens) {
            const n = count(all, tok);
            if (n > 1) throw new Violation("1 no duplicates", `${t.provider} thread ${t.id} was sent ${tok} ${n} times`);
        }
        const turns = fresh.filter((x) => !command(x));
        const last = turns.at(-1);
        w.stats.starts += fresh.length;
        if (!last) continue;
        w.stats.turns++;
        for (const tok of owner.tokens) {
            if (tok.sentAt >= last.at) continue;
            const n = count(all, tok.text);
            if (n !== 1) throw new Violation("1 no loss", `${t.provider} thread ${t.id} ran a turn for s${ownerIndex} having been sent ${tok.text} ${n} times (want 1)`);
        }
        // #413: in a history folder where the session ran a thread before, that thread (or a fork of it) goes on.
        const key = `${owner.id}|${t.provider}|${dirname(t.file)}`;
        const before = w.slots.get(key);
        if (before && !t.headers.includes(before)) throw new Violation("#413 one thread per account", `s${ownerIndex} ran a turn in a new ${t.provider} thread ${t.id}, not its earlier thread ${before} in that history (${dirname(t.file)})`);
        // A round trip back: an earlier thread went on, and this step caught it up on messages it hadn't had.
        if (before && fresh.some((x) => owner.tokens.some((tok) => tok.sentAt < start.at && x.text.includes(tok.text)))) w.stats.caughtUp++;
        w.slots.set(key, t.id);
    }
}
/** #413: the session's threads no longer go on (a compaction or rewind of Harness's, a thread the CLI lost): forgotten. */
function forgetSlots(w: World, s: FuzzSession, provider?: Cli) {
    for (const key of [...w.slots.keys()]) if (key.startsWith(`${s.id}|${provider ?? ""}`)) w.slots.delete(key);
}

// ---------------------------------------------------------------------------
// A run.

interface Plan { first: string; live: boolean; ops: Op[] }
interface Failure { seed: number; step: number; invariant: string; message: string }
/** Each run's own: tokens and account ids never repeat, across seeds and replays. */
let attempt = 0;

async function runOnce(seed: number, steps: number, replay?: Plan): Promise<{ failure?: Failure; plan: Plan; notes: string[]; stats: World["stats"] }> {
    const r = prng(seed);
    const run = ++attempt;
    // Live CLI sessions in three seeds of five (1, 2, 5, 6, …), per-run ones in the rest: the default run has both.
    const live = replay ? replay.live : seed % 5 !== 3 && seed % 5 !== 4;
    const first = replay ? replay.first : r.pick(MODELS);
    writeSettings(live);
    process.env.FAKE_LOG = join(root, `fake-${seed}-${run}.log`);
    setFakeEnv();
    const engine = new Engine();
    const drafts = new Map<string, string[]>();
    const client = { subs: new Set<string>(), send: (e: ServerEvent) => void (e.type === "draft" && drafts.set(e.sessionId, [...(drafts.get(e.sessionId) ?? []), e.text])) };
    engine.clients.add(client as never);
    const cwd = createDemoProject(realpathSync(tempDir(`fuzz-${seed}-`)), { git: false });
    const accounts = {} as World["accounts"];
    for (const provider of CLIS) {
        const p = provider === "codex" ? "cx" : "cc";
        accounts[provider] = {
            shared: { id: `shared-${p}-${run}`, name: "Shared", present: false },
            own: { id: `own-${p}-${run}`, name: "Own", folder: join(root, `own-${p}-${run}`), present: false },
        };
        for (const a of Object.values(accounts[provider])) {
            await engine.handle(client as never, "accounts.add", { provider, id: a.id, name: a.name, ...(a.folder ? { folder: a.folder } : {}) });
            a.present = true;
        }
    }
    const plan: Plan = { first, live, ops: [] };
    const notes: string[] = [`start: ${first}, ${live ? "live" : "per-run"} CLI sessions`];
    const w: World = { tag: `${seed}r${run}`, engine, client, cwd, sessions: [], focus: 0, live, accounts, tokenSeq: 0, allTokens: new Set(), slots: new Map(), stats: { turns: 0, starts: 0, caughtUp: 0 }, drafts, queue: [] };
    let failure: Failure | undefined;
    try {
        const snap = (await engine.handle(client as never, "session.create", { cwd, model: first })) as SessionSnapshot;
        w.sessions.push({ id: snap.state.id, tokens: [] });
        const total = replay?.ops.length ?? steps;
        for (let step = 0; step < total; step++) {
            let op: Op | undefined;
            try {
                op = replay ? replay.ops[step]! : generate(w, r);
                const start: StepStart = {
                    at: Date.now(),
                    stepSession: "s" in op && w.sessions[op.s] ? w.sessions[op.s]! : w.sessions[w.focus]!,
                    homes: new Map(w.sessions.map((s) => [s.id, Object.fromEntries(CLIS.map((p) => [p, selected(w, s, p).folder])) as Record<Cli, string | undefined>])),
                    missing: new Set(w.sessions.filter((s) => accountMissing(w, s)).map((s) => s.id)),
                };
                plan.ops.push(op);
                let outcome: boolean | string;
                try {
                    outcome = await apply(w, op);
                } catch (e) {
                    if (e instanceof Violation) throw e;
                    outcome = `refused: ${(e as Error).message.split("\n")[0]}`;
                }
                notes.push(`${step}: ${describe(op)}${outcome === true ? "" : outcome === false ? " (skipped)" : ` (${outcome})`}  [${w.sessions.map((s, i) => `s${i}=${modelOf(w, s)}`).join(" ")}]`);
                await settle(w, describe(op));
                check(w, start, readThreads(w));
            } catch (e) {
                // Anything else thrown is reported the same way, with where it was thrown.
                const v = e instanceof Violation ? e : new Violation("harness error", `${(e as Error).stack?.split("\n").slice(0, 4).join("\n") ?? e}`);
                notes.push(`${step}: ${op ? describe(op) : "(generating)"} FAILED ${v.message}`);
                failure = { seed, step, invariant: v.invariant, message: v.message };
                break;
            }
        }
    } finally {
        delete process.env.FUZZ_SPAWN_FAIL;
        setFakeEnv();
        await w.engine.stop().catch(() => undefined);
        writeSettings(true);
        for (const provider of CLIS) for (const a of Object.values(w.accounts[provider])) {
            const found = listAccounts(provider).find((x) => x.id === a.id);
            if (found) try { removeAccount(provider, a.id, found.folder); } catch {}
        }
    }
    return { failure, plan, notes, stats: w.stats };
}

/** Drops operations one at a time, last first, while the run still breaks the same invariant. */
async function shrink(seed: number, plan: Plan, invariant: string): Promise<Plan> {
    let best = plan;
    for (let i = best.ops.length - 2; i >= 0; i--) {
        const tried = { ...best, ops: best.ops.filter((_, j) => j !== i) };
        const { failure } = await runOnce(seed, tried.ops.length, tried);
        if (failure?.invariant === invariant) best = { ...tried, ops: tried.ops.slice(0, failure.step + 1) };
    }
    return best;
}

test("random switch sequences: every CLI thread has each user message once, on the right account; reloads keep state; nothing wedges", async () => {
    const replay: Plan | undefined = process.env.FUZZ_OPS ? (() => {
        const saved = JSON.parse(readFileSync(process.env.FUZZ_OPS!, "utf8"));
        return { first: saved.first, live: saved.live, ops: saved.ops.map((o: string | Op) => (typeof o === "string" ? JSON.parse(o) : o)) };
    })() : undefined;
    const seeds = process.env.FUZZ_SEED ? [Number(process.env.FUZZ_SEED)] : Array.from({ length: RUNS }, (_, i) => BASE + i);
    const gates = Object.entries(GATES).filter(([, on]) => on).map(([name]) => name);
    if (verbose) console.log(`switch-fuzz: seeds ${seeds.join(",")}, ${STEPS} steps; gates on: ${gates.join(", ") || "none"}`);
    const failed: string[] = [];
    for (const seed of seeds) {
        const { failure, notes, plan, stats } = await runOnce(seed, STEPS, replay);
        if (verbose || failure) console.log(`seed ${seed} (${stats.turns} CLI turns checked, ${stats.caughtUp} round trips caught up, ${stats.starts} prompts):\n  ${notes.join("\n  ")}`);
        if (!failure) continue;
        let found = { ...plan, ops: plan.ops.slice(0, failure.step + 1) };
        if (process.env.FUZZ_SHRINK === "1") found = await shrink(seed, found, failure.invariant);
        const saved = join(root, `fuzz-failure-${seed}.json`);
        writeFileSync(saved, JSON.stringify({ ...failure, first: found.first, live: found.live, ops: found.ops.map(describe), gates }, null, 2));
        process.env.FUZZ_KEEP = "1";
        const report = `seed ${seed}: ${failure.message}\nStarted on ${found.first}, ${found.live ? "live" : "per-run"} CLI sessions; replay with FUZZ_SEED=${seed} FUZZ_STEPS=${STEPS}, or FUZZ_OPS=${saved}\nOperations${process.env.FUZZ_SHRINK === "1" ? " (shrunk)" : ""}:\n  ${found.ops.map(describe).join("\n  ")}`;
        console.log(`FUZZ FAILURE ${report}`);
        failed.push(report);
        // FUZZ_CONTINUE=1: on with the next seeds; every failure is reported at the end.
        if (process.env.FUZZ_CONTINUE !== "1") break;
    }
    if (failed.length) throw new Error(`switch fuzz: ${failed.length} of the runs failed\n\n${failed.join("\n\n")}`);
    expect(failed).toEqual([]);
}, Math.max(60_000, RUNS * STEPS * 6_000));
