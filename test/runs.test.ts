// Runs (src/server/runs.ts): one prompt to several models, each in a worktree
// of its own. Names, then the RPC end to end (real server, the mock model, temp
// repositories), then what a run refuses and how one model failing leaves the
// others alone. Every repository here is a temp one.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { gitArgv, gitEnv } = await import("../src/util/git");
const { getProvider } = await import("../src/providers/registry");
const runs = await import("../src/server/runs");
const { promptSlug, modelSlug, modelSlugs, uniqueName, billingOf, startRun } = runs;
import type { RunResult, SessionSummary } from "../src/server/protocol";
import type { ProviderListing } from "../src/providers/models";

const TOKEN = "test-token-runs-0123456789";
const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const mock = startMockLlm({ delayMs: 0 });
const PROVIDERS = { custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }, { id: "mockkey", name: "Mock Keyed", baseUrl: mock.url, requiresKey: true }] };
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify(PROVIDERS));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
}

/** A temp repository with one commit (realpath: macOS's /var is a link, and worktree paths come back resolved). */
function repo(files: Record<string, string> = {}): string {
    const dir = realpathSync(tempDir("harness-run-repo-"));
    git(dir, "init", "-q", "-b", "main");
    writeFileSync(join(dir, "README.md"), "# demo\n");
    for (const [rel, content] of Object.entries(files)) {
        mkdirSync(join(dir, rel, ".."), { recursive: true });
        writeFileSync(join(dir, rel), content);
    }
    git(dir, "add", ".");
    git(dir, "commit", "-q", "-m", "Initial commit");
    return dir;
}

const worktreesOf = (main: string) => (existsSync(join(main, ".claude", "worktrees")) ? readdirSync(join(main, ".claude", "worktrees")).sort() : []);
const branchesOf = (main: string) => git(main, "for-each-ref", "--format=%(refname:short)", "refs/heads/").split("\n").filter(Boolean).sort();

class Client {
    ws: WebSocket;
    private next = 1;
    private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

    constructor(port: number) {
        this.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { protocols: ["harness.v1", `auth.${TOKEN}`] } as any);
        this.ws.onmessage = (m) => {
            const msg = JSON.parse(String(m.data));
            if ("event" in msg) return;
            const w = this.waiting.get(msg.id);
            this.waiting.delete(msg.id);
            if (msg.error) w?.reject(Object.assign(new Error(msg.error.message), { code: msg.error.code, folder: msg.error.folder }));
            else w?.resolve(msg.result);
        };
    }

    opened(): Promise<void> {
        return new Promise((resolve, reject) => {
            this.ws.onopen = () => resolve();
            this.ws.onerror = () => reject(new Error("connection failed"));
        });
    }

    call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
        const id = this.next++;
        this.ws.send(JSON.stringify({ id, method, params }));
        return new Promise((resolve, reject) => this.waiting.set(id, { resolve, reject }));
    }
}

async function until(pred: () => boolean | Promise<boolean>, ms = 10_000) {
    const end = Date.now() + ms;
    while (!(await pred())) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(25);
    }
}

let srv: Awaited<ReturnType<typeof startServer>>;
let c: Client;

beforeAll(async () => {
    srv = await startServer({ token: TOKEN, unloadAfterMs: 300 });
    c = new Client(srv.port);
    await c.opened();
});

afterAll(async () => {
    c.ws.close();
    await srv.stop();
    mock.stop();
    iso.cleanup();
});

// ---------------------------------------------------------------------------

describe("names", () => {
    test("a few words of the prompt, in ASCII", () => {
        expect(promptSlug("Fix the login redirect, please!")).toBe("fix-the-login-redirect-please");
        expect(promptSlug("Ünïcödé café — naïve résumé")).toBe("unicode-cafe-naive-resume");
        expect(promptSlug("修复登录 🚀 bug")).toBe("bug");
        expect(promptSlug("?!… --- ***")).toBe("run");
        expect(promptSlug("")).toBe("run");
    });

    test("bounded: at most five words and 40 characters", () => {
        expect(promptSlug("one two three four five six seven")).toBe("one-two-three-four-five");
        const long = promptSlug("internationalization localization accessibility interoperability");
        expect(long.length).toBeLessThanOrEqual(40);
        expect(long).toBe("internationalization-localization");
        expect(promptSlug("x".repeat(10_000))).toBe("run");
    });

    test("secrets and token-like words never reach a name", () => {
        const key = "sk-ant-api03-" + "A".repeat(40);
        expect(promptSlug(`use ${key} to deploy`)).toBe("use-to-deploy");
        expect(promptSlug("rotate ghp_" + "a1".repeat(18) + " now")).toBe("rotate-now");
        expect(promptSlug("check commit 3f9a2b7c1d0e4f5a")).toBe("check-commit");
        expect(promptSlug("upgrade to oauth2 and sha256")).toBe("upgrade-to-oauth2-and-sha256");
    });

    test("model slugs", () => {
        expect(modelSlug("anthropic:claude-opus-5-5")).toBe("opus-5-5");
        expect(modelSlug("claude-code:opus")).toBe("opus");
        expect(modelSlug("codex:gpt-6-astra")).toBe("gpt-6-astra");
        expect(modelSlug("openrouter:meta-llama/Llama-4.1-405B-Instruct")).toBe("llama-4-1-405b-instruct");
        expect(modelSlug("ollama:qwen3:32b")).toBe("qwen3-32b");
        expect(modelSlug("x:" + "very-long-".repeat(10)).length).toBeLessThanOrEqual(24);
        expect(modelSlug("x:✨")).toBe("model");
        // The same model through two providers stays tellable apart.
        expect(modelSlugs(["claude-code:claude-opus-5-5", "anthropic:claude-opus-5-5", "codex:gpt-6"])).toEqual(["claude-code-opus-5-5", "anthropic-opus-5-5", "gpt-6"]);
    });

    test("de-duplicated with -2, -3, ...", () => {
        const taken = new Set(["fix-opus", "fix-opus-2"]);
        expect(uniqueName("fix-opus", (n) => taken.has(n))).toBe("fix-opus-3");
        expect(uniqueName("fix-sonnet", (n) => taken.has(n))).toBe("fix-sonnet");
        expect(uniqueName("x", () => true, 5)).toBeUndefined();
    });

    test("what counts as paid", () => {
        expect(billingOf(getProvider("claude-code"))).toBe("plan");
        expect(billingOf(getProvider("codex"))).toBe("plan");
        expect(billingOf(getProvider("ollama"))).toBe("local");
        expect(billingOf(getProvider("lmstudio"))).toBe("local");
        expect(billingOf(getProvider("mock"))).toBe("local");
        expect(billingOf(getProvider("anthropic"))).toBe("api");
        expect(billingOf(getProvider("openrouter"))).toBe("api");
        expect(billingOf(getProvider("vertex"))).toBe("api");
        expect(billingOf(undefined)).toBe("api");
    });
});

// ---------------------------------------------------------------------------

describe("runs.start", () => {
    test("two models: two worktrees on their own branches, two sessions on their own models, each given the prompt and image, grouped", async () => {
        const main = repo();
        // A branch and a folder with the names the run would pick: it goes on to -2.
        git(main, "branch", "fix-the-login-redirect-mock-opus");
        mkdirSync(join(main, ".claude", "worktrees", "fix-the-login-redirect-mock-sonnet"), { recursive: true });
        const before = mock.requests.length;
        const text = "Fix the login redirect";
        const r = await c.call<{ runId: string; results: RunResult[] }>("runs.start", { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text, images: [{ mediaType: "image/png", data: PNG }], mode: "default" });

        expect(r.results.map((x) => x.ok)).toEqual([true, true]);
        const [a, b] = r.results as Extract<RunResult, { ok: true }>[];
        expect(a!.branch).toBe("fix-the-login-redirect-mock-opus-2");
        expect(b!.branch).toBe("fix-the-login-redirect-mock-sonnet-2");
        expect(a!.path).toBe(join(main, ".claude", "worktrees", "fix-the-login-redirect-mock-opus-2"));
        expect(b!.path).toBe(join(main, ".claude", "worktrees", "fix-the-login-redirect-mock-sonnet-2"));
        expect(branchesOf(main)).toEqual(["fix-the-login-redirect-mock-opus", "fix-the-login-redirect-mock-opus-2", "fix-the-login-redirect-mock-sonnet-2", "main"]);
        expect(git(a!.path, "rev-parse", "--abbrev-ref", "HEAD")).toBe(a!.branch);
        expect(git(a!.path, "rev-parse", "HEAD")).toBe(git(main, "rev-parse", "HEAD"));

        // Each session's turn went to its own model, with the prompt and the image.
        const turns = () => mock.requests.slice(before).filter((q) => q.kind === "turn" && q.prompt === text);
        await until(() => turns().length >= 2);
        expect(turns().map((q) => [q.model, q.images]).sort()).toEqual([["mock-opus", 1], ["mock-sonnet", 1]]);

        const list = await c.call<SessionSummary[]>("sessions.list", {});
        const mine = list.filter((s) => s.run?.id === r.runId);
        expect(mine.map((s) => s.id).sort()).toEqual([a!.sessionId, b!.sessionId].sort());
        const sa = mine.find((s) => s.id === a!.sessionId)!;
        expect(sa.cwd).toBe(a!.path);
        expect(sa.model).toBe("mock:mock-opus");
        expect(sa.run).toEqual({ id: r.runId, label: text, cwd: main, model: "mock:mock-opus", modelName: "Mock Opus" });
        expect(mine.find((s) => s.id === b!.sessionId)!.model).toBe("mock:mock-sonnet");
        // Picking models for a run doesn't change the default.
        expect((await c.call("settings.get", {})).model).toBe("mock:mock-opus");

        // An archived session leaves the group's list but keeps its place, so restoring it puts it back.
        await c.call("session.archive", { id: b!.sessionId, archived: true });
        const active = await c.call<SessionSummary[]>("sessions.list", {});
        expect(active.filter((s) => s.run?.id === r.runId).map((s) => s.id)).toEqual([a!.sessionId]);
        const archived = await c.call<SessionSummary[]>("sessions.list", { archived: true });
        expect(archived.find((s) => s.id === b!.sessionId)?.run?.id).toBe(r.runId);
        await c.call("session.archive", { id: b!.sessionId, archived: false });

        // The group survives a server restart (it's kept in gui.json).
        await until(async () => (await c.call<SessionSummary[]>("sessions.list", {})).filter((s) => s.run?.id === r.runId).every((s) => s.status === "idle"));
        const restarted = await startServer({ token: TOKEN });
        try {
            const c2 = new Client(restarted.port);
            await c2.opened();
            const again = (await c2.call<SessionSummary[]>("sessions.list", {})).filter((s) => s.run?.id === r.runId);
            expect(again.map((s) => [s.run?.modelName, s.cwd]).sort()).toEqual([["Mock Opus", a!.path], ["Mock Sonnet", b!.path]]);
            c2.ws.close();
        } finally {
            await restarted.stop();
        }
    });

    test("an unknown model and a provider with no key fail on their own rows, with no worktree; the other starts", async () => {
        const main = repo();
        const r = await c.call<{ results: RunResult[] }>("runs.start", { path: main, models: ["mock:nope", "mockkey:mock-opus", "mock:mock-sonnet"], text: "add a health check" });
        const [unknown, keyless, ok] = r.results;
        expect(unknown).toMatchObject({ ok: false, model: "mock:nope" });
        expect((unknown as { error: string }).error).toContain("doesn't list nope");
        expect(keyless).toMatchObject({ ok: false, model: "mockkey:mock-opus" });
        expect((keyless as { error: string }).error).toBe("No API key for Mock Keyed. Add one in Settings → Providers, or pick another model.");
        expect(unknown!.path).toBeUndefined();
        expect(ok).toMatchObject({ ok: true, branch: "add-a-health-check-mock-sonnet" });
        expect(worktreesOf(main)).toEqual(["add-a-health-check-mock-sonnet"]);
        expect(branchesOf(main)).toEqual(["add-a-health-check-mock-sonnet", "main"]);
    });

    test("one model's worktree can't be created: that row says so, the others start", async () => {
        const main = repo();
        // A stale lock on the first model's branch: Git refuses that one branch.
        writeFileSync(join(main, ".git", "refs", "heads", "tidy-up-mock-opus.lock"), "");
        const r = await c.call<{ results: RunResult[] }>("runs.start", { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "tidy up" });
        expect(r.results[0]).toMatchObject({ ok: false, model: "mock:mock-opus", error: "Git couldn't create the worktree. No worktree was made for this model." });
        expect(r.results[1]).toMatchObject({ ok: true, branch: "tidy-up-mock-sonnet" });
        expect(worktreesOf(main)).toEqual(["tidy-up-mock-sonnet"]);
    });

    test("the repository's Git config needs trust: nothing is created, and the folder to trust is named", async () => {
        const main = repo({ "a.txt": "hi\n" });
        appendFileSync(join(main, ".git", "config"), `[filter "evil"]\n\tsmudge = cat\n`);
        const err = await c.call("runs.start", { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "go" }).catch((e) => e);
        expect(err).toMatchObject({ code: "needs_trust", folder: main });
        expect(existsSync(join(main, ".claude"))).toBe(false);
        expect(branchesOf(main)).toEqual(["main"]);
        // Trusted, the same run goes ahead.
        await c.call("projects.trust", { path: main, trust: true });
        const r = await c.call<{ results: RunResult[] }>("runs.start", { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "go" });
        expect(r.results.every((x) => x.ok)).toBe(true);
    });

    test("committed project configuration: one question before anything is created; 'without its configuration' opens them that way", async () => {
        const main = repo({ ".mcp.json": JSON.stringify({ mcpServers: {} }) });
        const err = await c.call("runs.start", { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "look around" }).catch((e) => e);
        expect(err).toMatchObject({ code: "needs_project_trust", folder: main });
        expect(err.message).toContain(".mcp.json");
        expect(existsSync(join(main, ".claude"))).toBe(false);

        await c.call("projects.trust", { path: main, trust: false });
        const r = await c.call<{ results: Extract<RunResult, { ok: true }>[] }>("runs.start", { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "look around" });
        expect(r.results.every((x) => x.ok)).toBe(true);
        for (const x of r.results) {
            const snap = await c.call("session.open", { id: x.sessionId });
            expect(snap.state.trusted).toBe(false);
            await c.call("session.close", { id: x.sessionId });
        }
    });

    test("trusting the main worktree covers the run's worktrees inside it", async () => {
        const main = repo({ ".mcp.json": JSON.stringify({ mcpServers: {} }) });
        await c.call("projects.trust", { path: main, trust: true });
        const r = await c.call<{ results: Extract<RunResult, { ok: true }>[] }>("runs.start", { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "look again" });
        expect(r.results.every((x) => x.ok)).toBe(true);
        const snap = await c.call("session.open", { id: r.results[0]!.sessionId });
        expect(snap.state.trusted).toBe(true);
        await c.call("session.close", { id: r.results[0]!.sessionId });
    });

    test("malformed requests are refused whole", async () => {
        const main = repo();
        const refused = async (params: Record<string, unknown>) => (await c.call("runs.start", { path: main, text: "x", models: ["mock:mock-opus", "mock:mock-sonnet"], ...params }).catch((e) => e)) as { code?: string; message: string };
        expect(await refused({ models: ["mock:mock-opus"] })).toMatchObject({ code: "invalid", message: "Pick 2 to 4 models." });
        expect(await refused({ models: ["mock:mock-opus", "mock:mock-sonnet", "mock:mock-haiku", "mockkey:mock-opus", "mock:other"] })).toMatchObject({ code: "invalid" });
        expect(await refused({ models: ["mock:mock-opus", "mock:mock-opus"] })).toMatchObject({ code: "invalid", message: "Each model can be picked only once." });
        expect(await refused({ models: "mock:mock-opus" })).toMatchObject({ code: "invalid" });
        expect(await refused({ models: ["mock:mock-opus", 7] })).toMatchObject({ code: "invalid" });
        expect(await refused({ text: 42 })).toMatchObject({ code: "invalid" });
        expect(await refused({ text: "   " })).toMatchObject({ code: "invalid" });
        expect(await refused({ text: "x".repeat(200_001) })).toMatchObject({ code: "invalid" });
        expect(await refused({ text: "!rm -rf /" })).toMatchObject({ code: "invalid" });
        expect(await refused({ images: [{ mediaType: "image/svg+xml", data: PNG }] })).toMatchObject({ code: "invalid" });
        expect(await refused({ images: "nope" })).toMatchObject({ code: "invalid" });
        expect(await refused({ images: [{ mediaType: ["image/png"], data: PNG }] })).toMatchObject({ code: "invalid" });
        expect(await refused({ images: [{ mediaType: "image/png", data: PNG + "!" }] })).toMatchObject({ code: "invalid" });
        expect(await refused({ mode: "yolo" })).toMatchObject({ code: "invalid" });
        expect(await refused({ mode: "bypassPermissions" })).toMatchObject({ code: "invalid" });
        expect(await refused({ confirmPaid: "yes" })).toMatchObject({ code: "invalid" });
        expect(await refused({ path: 3 })).toMatchObject({ code: "invalid" });
        expect(await refused({ path: realpathSync(tempDir("harness-run-plain-")) })).toMatchObject({ code: "not_git" });
        expect(await refused({ path: join(main, "missing") })).toMatchObject({ code: "not_git" });
        expect(existsSync(join(main, ".claude"))).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Through the engine, with listings the test makes up.

describe("a run's checks, with made-up listings", () => {
    const client = { subs: new Set<string>(), send: () => {} };
    const mockDef = () => getProvider("mock")!;

    test("a model that doesn't take images fails when images are attached; the other starts", async () => {
        const engine = new Engine({ listModels: async () => [{ provider: mockDef(), status: "ok", models: [{ provider: "mock", id: "mock-opus", name: "Mock Opus" }, { provider: "mock", id: "mock-sonnet", name: "Text Only", supportsImages: false }] }] });
        const main = repo();
        try {
            const r = (await engine.handle(client, "runs.start", { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "describe this", images: [{ mediaType: "image/png", data: PNG }] })) as { results: RunResult[] };
            expect(r.results[0]).toMatchObject({ ok: true });
            expect(r.results[1]).toMatchObject({ ok: false, error: "Text Only doesn't take images. Remove the images, or pick another model." });
            expect(worktreesOf(main)).toEqual(["describe-this-mock-opus"]);
        } finally {
            await engine.stop();
        }
    });

    test("a second start while one is starting in the same repository is refused", async () => {
        const engine = new Engine({ listModels: async () => [{ provider: mockDef(), status: "ok", models: [{ provider: "mock", id: "mock-opus" }, { provider: "mock", id: "mock-sonnet" }] }] });
        const main = repo();
        try {
            const params = { path: main, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "twice" };
            const [first, second] = await Promise.allSettled([engine.handle(client, "runs.start", params), engine.handle(client, "runs.start", params)]);
            expect(first.status).toBe("fulfilled");
            expect(second).toMatchObject({ status: "rejected", reason: { code: "busy" } });
            expect(worktreesOf(main)).toEqual(["twice-mock-opus", "twice-mock-sonnet"]);
        } finally {
            await engine.stop();
        }
    });
});

// ---------------------------------------------------------------------------
// The orchestration alone, with a host whose sessions the test controls.

/** A host whose sessions the test controls: on the default model until set, never calling out. */
function host(o: { setModel: (ref: string) => boolean; actual?: (ref: string) => string; listings?: ProviderListing[] }) {
    const sent: string[] = [];
    const discarded: string[] = [];
    let n = 0;
    const h: import("../src/server/runs").RunHost = {
        listings: async () => o.listings ?? [{ provider: getProvider("mock")!, status: "ok", models: [{ provider: "mock", id: "mock-opus" }, { provider: "mock", id: "mock-sonnet" }] }],
        declined: () => false,
        decline: () => {},
        bypassAllowed: () => false,
        stopping: () => false,
        openSession: async () => {
            const id = `s${++n}`;
            // On the default model until set.
            let model = { provider: "mock", id: "mock-opus" };
            return {
                id,
                get model() {
                    return model;
                },
                setModel: async (ref: string) => {
                    if (!o.setModel(ref)) return false;
                    const [provider, mid] = (o.actual?.(ref) ?? ref).split(":") as [string, string];
                    model = { provider, id: mid };
                    return true;
                },
                send: async () => void sent.push(id),
            };
        },
        discard: (id) => void discarded.push(id),
        release: () => {},
        record: () => {},
    };
    return { h, sent, discarded };
}

describe("a session that can't be set to its model", () => {
    const req = (path: string) => ({ path, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "pick me", images: [], confirmPaid: false });

    test("is never sent the prompt and doesn't fall back to the default; its worktree is kept and named", async () => {
        const main = repo();
        const { h, sent, discarded } = host({ setModel: (ref) => ref !== "mock:mock-sonnet" });
        const r = await startRun(h, req(main));
        expect(r.results[0]).toMatchObject({ ok: true, sessionId: "s1" });
        expect(r.results[1]).toMatchObject({ ok: false, branch: "pick-me-mock-sonnet", path: join(main, ".claude", "worktrees", "pick-me-mock-sonnet") });
        expect((r.results[1] as { error: string }).error).toContain("wasn't sent the prompt");
        expect(sent).toEqual(["s1"]);
        expect(discarded).toEqual(["s2"]);
        expect(worktreesOf(main)).toEqual(["pick-me-mock-opus", "pick-me-mock-sonnet"]);
    });

    test("one that says it switched but is on another model isn't sent it either", async () => {
        const main = repo();
        const { h, sent } = host({ setModel: () => true, actual: () => "mock:mock-opus" });
        const r = await startRun(h, req(main));
        expect(r.results.map((x) => x.ok)).toEqual([true, false]);
        expect(sent).toEqual(["s1"]);
    });
});

describe("the cost guard", () => {
    const paid = [
        { id: "paida", name: "Paid A", baseUrl: "https://paid-a.invalid/v1" },
        { id: "paidb", name: "Paid B", baseUrl: "https://paid-b.invalid/v1" },
        { id: "paidc", name: "Paid C", baseUrl: "https://paid-c.invalid/v1" },
    ];
    beforeAll(() => {
        writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [...PROVIDERS.custom, ...paid] }));
        for (const p of paid) process.env[`${p.id.toUpperCase()}_API_KEY`] = "test-key-not-real";
    });
    afterAll(() => {
        writeFileSync(join(iso.home, "providers.json"), JSON.stringify(PROVIDERS));
        for (const p of paid) delete process.env[`${p.id.toUpperCase()}_API_KEY`];
    });
    const listing = (id: string, pricing?: { input: number; output: number }): ProviderListing => ({ provider: getProvider(id)!, status: "ok", models: [{ provider: id, id: "big", name: `${id} Big`, pricing }] });
    const listings = () => [listing("paida", { input: 3, output: 15 }), listing("paidb"), listing("paidc", { input: 1, output: 2 }), { provider: getProvider("mock")!, status: "ok" as const, models: [{ provider: "mock", id: "mock-opus" }] }];

    test("more than two paid API models are refused until confirmed; cancelled, nothing is created", async () => {
        const engine = new Engine({ listModels: async () => listings() });
        const main = repo();
        try {
            const err = await engine.handle({ subs: new Set<string>(), send: () => {} }, "runs.start", { path: main, models: ["paida:big", "paidb:big", "paidc:big"], text: "compare" }).catch((e) => e);
            expect(err).toMatchObject({ code: "confirm_paid" });
            expect(err.message).toContain("paida Big ($3/$15 per million tokens)");
            expect(err.message).toContain("paidb Big (price unknown)");
            expect(existsSync(join(main, ".claude"))).toBe(false);
            expect(branchesOf(main)).toEqual(["main"]);
        } finally {
            await engine.stop();
        }
    });

    test("two paid ones with a local one don't ask; confirmed, three paid ones start", async () => {
        const two = host({ setModel: () => true, listings: listings() });
        const r = await startRun(two.h, { path: repo(), models: ["paida:big", "paidb:big", "mock:mock-opus"], text: "compare", images: [], confirmPaid: false });
        expect(r.results.map((x) => x.ok)).toEqual([true, true, true]);
        const three = host({ setModel: () => true, listings: listings() });
        const ok = await startRun(three.h, { path: repo(), models: ["paida:big", "paidb:big", "paidc:big"], text: "compare", images: [], confirmPaid: true });
        expect(ok.results.map((x) => x.ok)).toEqual([true, true, true]);
        expect(three.sent).toEqual(["s1", "s2", "s3"]);
    });
});
