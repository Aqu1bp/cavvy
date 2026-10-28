// The GUI server's Runtime with the fake CLIs (test/fixtures) and the mock API (scripts/mock-llm), for the switch
// tests (#409): a session switched between models, providers and accounts, and what each CLI was sent.
//
// Call switchKit(isolate()) at the top of the test file, after isolate() and before any other src import: src
// modules are loaded here with import(), so they see the isolated CAVVY_HOME. It registers its own cleanup.

import { afterAll, afterEach } from "bun:test";
import { chmodSync, existsSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { stopLiveCodex } from "./fake-env";
import { tempDir } from "./isolate";

export type Cli = "claude-code" | "codex";
export const CLIS: Cli[] = ["claude-code", "codex"];
export const API = "mock:mock-opus";
/** A word another model's turn carries: the CLI is sent it once, when it's back. */
export const TOKEN = "otter-kettle-409";

export const count = (s: string, sub: string) => s.split(sub).length - 1;
export const real = (p: string | undefined) => (p === undefined ? undefined : realpathSync(p));
export const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
};
export const mode = (live: boolean) => (live ? "live" : "per run");

export async function until(pred: () => boolean, ms = 15_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

/** What the CLIs answer with: a plain answer, and Codex signed in. */
const OK = { FAKE_SCENARIO: "chat", FAKE_CODEX_SCENARIO: "cmd", FAKE_ACCOUNT: "chatgpt" };

export async function switchKit(iso: { home: string; cleanup: () => void }) {
    const { Engine } = await import("../../src/server/engine");
    const { startMockLlm } = await import("../../scripts/mock-llm");
    const { createDemoProject } = await import("../../scripts/demo-project");
    const { saveAgentConfig } = await import("../../src/providers/registry");
    const { forgetClient } = await import("../../src/providers/models");
    const { addAccount, removeAccount } = await import("../../src/providers/accounts");

    const mock = startMockLlm({ delayMs: 0 });
    writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
    const bin = tempDir("switch-gaps-bin-");
    for (const [cli, fixture] of [["claude-code", "fake-claude.ts"], ["codex", "fake-codex.ts"]] as const) {
        const path = join(bin, cli);
        writeFileSync(path, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "..", "fixtures", fixture)}" "$@"\n`);
        chmodSync(path, 0o755);
        saveAgentConfig(cli, { path });
    }

    const prior = Object.fromEntries(Object.keys(process.env).filter((k) => k.startsWith("FAKE_")).map((k) => [k, process.env[k]]));
    const made: { provider: Cli; id: string; folder: string }[] = [];
    afterEach(() => stopLiveCodex());
    afterAll(() => {
        for (const a of made.splice(0)) removeAccount(a.provider, a.id, a.folder);
        for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
        Object.assign(process.env, prior);
        mock.stop();
        rmSync(bin, { recursive: true, force: true });
        iso.cleanup();
    });
    let seq = 0;

    /**
     * A session in the Runtime on `provider`, live (a process kept for the session) or a process per turn. The fakes
     * keep transcripts in each home's history folder (FAKE_TRANSCRIPTS) and resume only what they find there, as the
     * CLIs do: Default's home is the isolated CLAUDE_CONFIG_DIR / CODEX_HOME, which Cavvy-made accounts link.
     */
    async function app(provider: Cli, live: boolean, o: { env?: Record<string, string>; settings?: Record<string, unknown> } = {}) {
        for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
        const log = join(bin, `log-${++seq}.jsonl`);
        Object.assign(process.env, OK, { FAKE_TRANSCRIPTS: "1", FAKE_LOG: log }, o.env);
        writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: `${provider}:default`, smallModel: "mock:mock-haiku", permissions: { allowBypass: true }, agentCli: { liveSessions: live }, ...o.settings }));
        for (const cli of CLIS) forgetClient(cli);
        const client = { subs: new Set<string>(), send() {} } as never;
        const newEngine = () => {
            const e = new Engine({ listModels: async () => [] });
            e.clients.add(client);
            return e;
        };
        let engine = newEngine();
        const cwd = realpathSync(createDemoProject(tempDir("switch-gaps-proj-"), { git: false }));
        let rt = await engine.createSession(cwd, { mode: "bypassPermissions" });
        await rt.ready;
        const lines = (): any[] => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
        // Told apart by what they were started as: Codex's processes are app-servers (its sign-in is `login`), Claude
        // Code's are the rest but its sign-in checks (`auth`). Not one-offs either (Claude Code's without a session; Codex's
        // are ephemeral threads, left out below). Both fakes log their cwd, so that doesn't tell them apart.
        const isStart = (l: any, cli: Cli) =>
            Array.isArray(l.argv) && Boolean(l.pid) && (cli === "codex" ? l.argv[0] === "app-server" : !["app-server", "login", "auth"].includes(l.argv[0]) && !l.argv.includes("--no-session-persistence"));
        /** Each CLI process started for the session's turns, in order: its pid, argv and homes. */
        const starts = (cli: Cli = provider) => lines().filter((l) => isStart(l, cli));
        const received = () => lines().flatMap((l) => (l.received ? [l.received] : []));
        const text = (parts: any[]) => parts.filter((c) => c.type === "text").map((c) => c.text as string).join("\n\n");
        /** Each prompt a CLI was sent (Claude Code's text blocks, Codex's text input, joined), with the process it went to. */
        const sent = (cli: Cli = provider) =>
            lines().flatMap((l) => {
                const m = l.received;
                const start = () => lines().find((x) => x.pid === l.proc && isStart(x, cli));
                if (cli === "claude-code" && m?.type === "user" && Array.isArray(m.message?.content)) return [{ text: text(m.message.content), images: m.message.content.filter((c: any) => c.type === "image").length, start: start() }];
                if (cli === "codex" && m?.method === "turn/start" && m.params.threadId !== "thr-oneoff") return [{ text: text(m.params.input), images: (m.params.input as any[]).filter((c) => c.type === "image" || c.type === "localImage").length, start: start() }];
                return [];
            });
        const prompts = (cli: Cli = provider) => sent(cli).map((p) => p.text);
        /** What each Claude Code start (or Codex thread request) opened: "new", the id it resumed, or "<id> (fork)". */
        const opened = (cli: Cli = provider) =>
            cli === "claude-code"
                ? starts(cli).map((l) => {
                      const i = l.argv.indexOf("--resume");
                      return i < 0 ? "new" : `${l.argv[i + 1]}${l.argv.includes("--fork-session") ? " (fork)" : ""}`;
                  })
                : received()
                      .filter((m) => ["thread/start", "thread/resume", "thread/fork"].includes(m.method) && !m.params?.ephemeral)
                      .map((m) => (m.method === "thread/start" ? "new" : `${m.params.threadId}${m.method === "thread/fork" ? " (fork)" : ""}`));
        const homeOf = (start: any, cli: Cli = provider) => real(start?.[cli === "codex" ? "codexHome" : "claudeConfigDir"]);
        /** The process the last prompt went to: its pid and home. */
        const lastProc = (cli: Cli = provider) => {
            const s = sent(cli).at(-1)?.start;
            return { pid: s?.pid as number, home: homeOf(s, cli) };
        };
        type Rt = typeof rt;
        const turns = (on: Rt = rt) => on.snapshot().turns;
        /** The last turn on `on` has ended, and it has more than `n`. */
        const ended = (n: number, on: Rt = rt) => turns(on).length > n && on.idle && turns(on).at(-1)!.status !== "running";
        /** Send, and wait for its turn to end. */
        const send = async (text: string, on: Rt = rt) => {
            const n = turns(on).length;
            await on.send(text);
            await until(() => ended(n, on));
            return turns(on).at(-1)!;
        };
        const notices = (on: Rt = rt) => turns(on).flatMap((t: any) => t.blocks.filter((b: any) => b.t === "notice").map((b: any) => b.text as string));
        /** The last assistant message's text (another model's answer, say). */
        const lastAnswer = () => {
            const m = rt.session.messages.filter((x) => x.role === "assistant").at(-1)!;
            return m.content.flatMap((c) => (c.type === "text" ? [c.text] : [])).join("");
        };
        const handle = (method: string, params: Record<string, unknown>) => engine.handle(client, method as never, params as never) as Promise<any>;
        /**
         * The server stops (each CLI process with it) and starts again; the session is opened again, as the GUI does.
         * `meanwhile` runs while it's stopped.
         */
        const reopen = async (meanwhile?: () => void) => {
            const id = rt.id;
            await engine.stop();
            await stopLiveCodex();
            meanwhile?.();
            engine = newEngine();
            rt = engine.openSession(id);
            await rt.ready;
            // As it was (it opens in the folder's default mode): Codex's command runs without asking.
            rt.setMode("bypassPermissions");
            return rt;
        };
        return {
            get engine() {
                return engine;
            },
            get rt() {
                return rt;
            },
            bin, cwd, lines, starts, received, sent, prompts, opened, homeOf, lastProc, turns, ended, send, notices, lastAnswer, handle, reopen,
        };
    }

    /** A Cavvy-made account (its CLI shares Default's history), or one on an existing folder (a history of its own). */
    function account(provider: Cli, kind: "shared" | "own") {
        const id = `gap-${kind}-${++seq}`;
        const a = addAccount(provider, { id, name: id, ...(kind === "own" ? { folder: join(iso.home, `${provider}-${id}`) } : {}) });
        made.push({ provider, id: a.id, folder: a.folder });
        return a;
    }

    async function withApp(provider: Cli, live: boolean, body: (h: Awaited<ReturnType<typeof app>>) => Promise<void>, o: Parameters<typeof app>[2] = {}) {
        const h = await app(provider, live, o);
        try {
            await body(h);
        } finally {
            await h.engine.stop();
        }
    }

    return { app, account, withApp, bin };
}

type Kit = Awaited<ReturnType<typeof switchKit>>;
export type SwitchApp = Awaited<ReturnType<Kit["app"]>>;
