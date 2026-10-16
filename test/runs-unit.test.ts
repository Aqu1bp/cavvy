// Pure validation and orchestration: temporary repositories and fake sessions, no sockets.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { RunResult } from "../src/server/protocol";
import type { ProviderListing } from "../src/providers/models";
import type { AttachedPart } from "../src/providers/types";

const iso = isolate();
const { gitArgv, gitEnv } = await import("../src/util/git");
const { getProvider } = await import("../src/providers/registry");
const { Engine } = await import("../src/server/engine");
const { promptSlug, modelSlug, modelSlugs, uniqueName, billingOf, startRun, parseRunRequest } = await import("../src/server/runs");
const { trustFolder } = await import("../src/config/trust");
const { MEDIA_BUDGET } = await import("../src/util/media");
const PROVIDERS = { custom: [{ id: "mock", name: "Mock", baseUrl: "http://127.0.0.1:1/v1", requiresKey: false }, { id: "mockkey", name: "Mock Keyed", baseUrl: "http://127.0.0.1:1/v1", requiresKey: true }] };
writeFileSync(join(iso.home, "providers.json"), JSON.stringify(PROVIDERS));
const repos: string[] = [];
afterAll(() => { iso.cleanup(); for (const path of repos) rmSync(path, { recursive: true, force: true }); });

function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Harness Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString().trim();
}

/** A temp repository with one commit (realpath: macOS's /var is a link, and worktree paths come back resolved). */
function repo(files: Record<string, string> = {}): string {
    const dir = realpathSync(tempDir("harness-run-repo-"));
    repos.push(dir);
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

    test("what counts as paid", async () => {
        expect(await billingOf(getProvider("claude-code"))).toBe("plan");
        expect(await billingOf(getProvider("codex"))).toBe("plan");
        expect(await billingOf(getProvider("ollama"))).toBe("local");
        expect(await billingOf(getProvider("lmstudio"))).toBe("local");
        expect(await billingOf(getProvider("mock"))).toBe("local");
        expect(await billingOf(getProvider("anthropic"))).toBe("api");
        expect(await billingOf(getProvider("openrouter"))).toBe("api");
        expect(await billingOf(getProvider("vertex"))).toBe("api");
        expect(await billingOf(undefined)).toBe("api");
    });
});

// ---------------------------------------------------------------------------

// The orchestration alone, with a host whose sessions the test controls.

/** A host whose sessions the test controls: on the default model until set, never calling out. */
function host(o: { setModel: (ref: string) => boolean; actual?: (ref: string) => string; listings?: ProviderListing[] }) {
    const sent: string[] = [];
    const discarded: string[] = [];
    const delivered: { text: string; attachments?: AttachedPart[]; literal?: boolean }[] = [];
    const opened: { path: string; mode?: string }[] = [];
    const declined: string[] = [];
    let n = 0;
    const h: import("../src/server/runs").RunHost = {
        listings: async () => o.listings ?? [{ provider: getProvider("mock")!, status: "ok", models: [{ provider: "mock", id: "mock-opus" }, { provider: "mock", id: "mock-sonnet" }] }],
        declined: () => false,
        decline: (path) => void declined.push(path),
        bypassAllowed: () => false,
        stopping: () => false,
        openSession: async (path, mode) => {
            opened.push({ path, mode });
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
                send: async (text, attachments, literal) => {
                    sent.push(id);
                    delivered.push({ text, attachments, literal });
                },
            };
        },
        discard: (id) => void discarded.push(id),
        release: () => {},
        record: () => {},
    };
    return { h, sent, discarded, delivered, opened, declined };
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
        { id: "proxy", name: "Local Proxy", baseUrl: "http://localhost:4000/v1" },
        { id: "optionalproxy", name: "Optional Key Proxy", baseUrl: "http://127.0.0.1:4000/v1", requiresKey: false },
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

    test.each(["proxy", "optionalproxy"])("a keyed loopback provider (%s) counts toward paid confirmation before creating anything", async (id) => {
        const main = repo();
        const h = host({ setModel: () => true, listings: [...listings(), listing(id)] });
        const req = { path: main, models: ["paida:big", "paidb:big", `${id}:big`], text: "compare", images: [], confirmPaid: false };
        await expect(startRun(h.h, req)).rejects.toMatchObject({ code: "confirm_paid" });
        expect(h.opened).toEqual([]);
        expect(h.sent).toEqual([]);
        expect(worktreesOf(main)).toEqual([]);
        expect(branchesOf(main)).toEqual(["main"]);
        const result = await startRun(h.h, { ...req, confirmPaid: true });
        expect(result.results.map((r) => r.ok)).toEqual([true, true, true]);
    });

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

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const request = (path: string) => ({ path, models: ["mock:mock-opus", "mock:mock-sonnet"], text: "Fix the login redirect", images: [], confirmPaid: false });
const parse = (params: Record<string, unknown>) => parseRunRequest(params, {
    resolvePath: (path) => path,
    validImage: (i) => Boolean(i && ["image/png", "image/jpeg", "image/gif", "image/webp"].includes(String(i.mediaType)) && typeof i.data === "string"),
});

describe("request validation without sockets", () => {
    test("malformed requests refuse the whole run", () => {
        const base = request("/test");
        for (const patch of [
            { models: null }, { models: [] }, { models: ["mock:mock-opus"] },
            { models: ["a", "b", "c", "d", "e"] }, { models: ["a", "a"] }, { models: ["a", 3] },
            { path: 3 }, { path: "" }, { path: "bad\0path" },
            { text: 3 }, { text: " " }, { text: "x".repeat(200_001) }, { text: "!echo unsafe" },
            { images: "bad" }, { images: [null] }, { images: [{ mediaType: "image/svg+xml", data: PNG }] },
            { images: [{ mediaType: "image/png", data: PNG + "!" }] },
            { mode: "unknown" }, { confirmPaid: "yes" },
        ]) expect(() => parse({ ...base, ...patch })).toThrow();
    });

    test("files retain text and pasted metadata and malformed files are rejected", () => {
        const data = Buffer.from("same attachment for both models").toString("base64");
        const parsed = parse({ ...request("/test"), files: [{ name: "notes.txt", data }, { name: "paste", data, pasted: true }] });
        expect(parsed.files).toMatchObject([{ type: "file", kind: "text", name: "notes.txt", text: "same attachment for both models" }, { type: "file", kind: "text", name: "Pasted text", pasted: true }]);
        for (const files of ["bad", [null], [{ name: "bad", data: "%%%" }], [{ name: "binary", data: "AAECAw==" }]]) expect(() => parse({ ...request("/test"), files })).toThrow();
    });

    test("the shared aggregate media budget applies before creating worktrees", () => {
        const data = Buffer.alloc(Math.floor(MEDIA_BUDGET / 2) + 1).toString("base64");
        expect(() => parse({ ...request("/test"), images: [{ mediaType: "image/png", data }, { mediaType: "image/png", data }] })).toThrow(/PDFs and images/);
    });
});

describe("run orchestration without sockets", () => {
    test("each model gets its own branch, the Home mode, identical prompt, images and files", async () => {
        const main = repo();
        git(main, "branch", "fix-the-login-redirect-mock-opus");
        mkdirSync(join(main, ".claude", "worktrees", "fix-the-login-redirect-mock-sonnet"), { recursive: true });
        const req = parse({ ...request(main), mode: "plan", images: [{ mediaType: "image/png", data: PNG }], files: [{ name: "notes.txt", data: Buffer.from("Keep the login accessible").toString("base64") }] });
        const h = host({ setModel: () => true });
        const result = await startRun(h.h, req);
        expect(result.results.map((row) => row.ok)).toEqual([true, true]);
        expect(result.results.map((row) => row.branch)).toEqual(["fix-the-login-redirect-mock-opus-2", "fix-the-login-redirect-mock-sonnet-2"]);
        expect(h.opened.map((row) => row.mode)).toEqual(["plan", "plan"]);
        expect(h.delivered).toEqual(Array.from({ length: 2 }, () => ({ text: req.text, attachments: [...req.images, ...req.files!], literal: true })));
        for (const opened of h.opened) expect(git(opened.path, "rev-parse", "HEAD")).toBe(git(main, "rev-parse", "HEAD"));
    });

    test("unknown and unconfigured models fail separately before making their worktrees", async () => {
        const main = repo();
        const h = host({ setModel: () => true });
        const result = await startRun(h.h, { ...request(main), models: ["mock:missing", "mockkey:mock-opus", "mock:mock-sonnet"] });
        expect(result.results.map((row) => row.ok)).toEqual([false, false, true]);
        expect(result.results[0]).toMatchObject({ error: expect.stringContaining("doesn't list") });
        expect(result.results[1]).toMatchObject({ error: expect.stringContaining("No API key") });
        expect(worktreesOf(main)).toEqual(["fix-the-login-redirect-mock-sonnet"]);
    });

    test("an unsupported PDF fails only that model, before creating its worktree", async () => {
        const main = repo();
        const listings: ProviderListing[] = [{ provider: getProvider("mock")!, status: "ok", models: [{ provider: "mock", id: "mock-opus", supportsPdf: false }, { provider: "mock", id: "mock-sonnet", supportsPdf: true }] }];
        const h = host({ setModel: () => true, listings });
        const result = await startRun(h.h, parse({ ...request(main), files: [{ name: "paper.pdf", data: Buffer.from("%PDF-1.4\n%%EOF").toString("base64") }] }));
        expect(result.results.map((row) => row.ok)).toEqual([false, true]);
        expect(result.results[0]).toMatchObject({ error: expect.stringContaining("can't read PDFs") });
        expect(worktreesOf(main)).toEqual(["fix-the-login-redirect-mock-sonnet"]);
    });

    test("unsupported images fail only that model", async () => {
        const main = repo();
        const listings: ProviderListing[] = [{ provider: getProvider("mock")!, status: "ok", models: [{ provider: "mock", id: "mock-opus", supportsImages: false }, { provider: "mock", id: "mock-sonnet", supportsImages: true }] }];
        const h = host({ setModel: () => true, listings });
        const result = await startRun(h.h, parse({ ...request(main), images: [{ mediaType: "image/png", data: PNG }] }));
        expect(result.results.map((row) => row.ok)).toEqual([false, true]);
        expect(worktreesOf(main)).toEqual(["fix-the-login-redirect-mock-sonnet"]);
    });

    test("one branch lock fails only that model and exposes no Git stderr", async () => {
        const main = repo();
        writeFileSync(join(main, ".git", "refs", "heads", "fix-the-login-redirect-mock-opus.lock"), "");
        const h = host({ setModel: () => true });
        const result = await startRun(h.h, request(main));
        expect(result.results.map((row) => row.ok)).toEqual([false, true]);
        expect(result.results[0]).toMatchObject({ error: "Git couldn't create the worktree. No worktree was made for this model." });
        expect(worktreesOf(main)).toEqual(["fix-the-login-redirect-mock-sonnet"]);
    });

    test("repository Git config needs trust before any worktree or session", async () => {
        const main = repo();
        appendFileSync(join(main, ".git", "config"), '[filter "unsafe"]\n\tsmudge = cat\n');
        const h = host({ setModel: () => true });
        await expect(startRun(h.h, request(main))).rejects.toMatchObject({ code: "needs_trust", folder: main });
        expect(worktreesOf(main)).toEqual([]);
        expect(h.opened).toEqual([]);
    });

    test("committed configuration needs one decision, and a decline propagates to every worktree", async () => {
        const main = repo({ ".mcp.json": '{"mcpServers":{}}' });
        const h = host({ setModel: () => true });
        await expect(startRun(h.h, request(main))).rejects.toMatchObject({ code: "needs_project_trust", folder: main });
        expect(worktreesOf(main)).toEqual([]);
        h.h.declined = (path) => path === main;
        const result = await startRun(h.h, request(main));
        expect(result.results.map((row) => row.ok)).toEqual([true, true]);
        expect(h.declined).toEqual(h.opened.map((row) => row.path));
    });

    test("explicit trust of the main worktree covers the run's managed worktrees", async () => {
        const main = repo({ ".mcp.json": '{"mcpServers":{}}' });
        trustFolder(main);
        const h = host({ setModel: () => true });
        const result = await startRun(h.h, request(main));
        expect(result.results.map((row) => row.ok)).toEqual([true, true]);
        expect(h.declined).toEqual([]);
    });

    test("non-Git folders, bypass mode and overlapping starts refuse without extra worktrees", async () => {
        const plain = realpathSync(tempDir("harness-run-plain-"));
        repos.push(plain);
        const h = host({ setModel: () => true });
        await expect(startRun(h.h, request(plain))).rejects.toMatchObject({ code: "not_git" });
        const main = repo();
        await expect(startRun(h.h, { ...request(main), mode: "bypassPermissions" })).rejects.toMatchObject({ code: "invalid" });
        expect(worktreesOf(main)).toEqual([]);
        const results = await Promise.allSettled([startRun(h.h, request(main)), startRun(h.h, request(main))]);
        expect(results.map((row) => row.status)).toEqual(["fulfilled", "rejected"]);
        expect(results[1]).toMatchObject({ reason: { code: "busy" } });
        expect(worktreesOf(main)).toHaveLength(2);
    });
});

describe("current main compatibility", () => {
    test("slash-prefixed prompts are sent literally and attachment-only runs keep their payload", async () => {
        const main = repo();
        const h = host({ setModel: () => true });
        await startRun(h.h, { ...request(main), text: "/compact" });
        expect(h.delivered.map((row) => [row.text, row.literal])).toEqual([["/compact", true], ["/compact", true]]);
        const attached = parse({ ...request(main), text: "", files: [{ name: "notes.txt", data: Buffer.from("Explain this").toString("base64") }] });
        await startRun(h.h, attached);
        expect(h.delivered.slice(2).map((row) => row.attachments)).toEqual([attached.files, attached.files]);
        expect(worktreesOf(main)).toContain("run-mock-opus");
    });

    test("a managed sibling asks once for main trust, then starts from the Home HEAD", async () => {
        const main = repo({ ".mcp.json": '{"mcpServers":{}}' });
        const home = join(main, ".claude", "worktrees", "home");
        git(main, "worktree", "add", "-b", "home", home);
        writeFileSync(join(home, "new.txt"), "Only on the Home branch");
        git(home, "add", "new.txt");
        git(home, "commit", "-m", "Home changes");
        appendFileSync(join(main, ".git", "config"), '[filter "unsafe"]\n\tsmudge = cat\n');
        const h = host({ setModel: () => true });
        await expect(startRun(h.h, request(home))).rejects.toMatchObject({ code: "needs_trust", folder: main });
        expect(worktreesOf(main)).toEqual(["home"]);
        trustFolder(main);
        const result = await startRun(h.h, request(home));
        expect(result.results.map((row) => row.ok)).toEqual([true, true]);
        for (const opened of h.opened) expect(git(opened.path, "rev-parse", "HEAD")).toBe(git(home, "rev-parse", "HEAD"));
    });

    test("an external linked Home with unsafe Git config refuses before creating anything", async () => {
        const main = repo({ ".mcp.json": '{"mcpServers":{}}' });
        const parent = realpathSync(tempDir("harness-run-linked-"));
        repos.push(parent);
        const home = join(parent, "home");
        git(main, "worktree", "add", "-b", "external", home);
        appendFileSync(join(main, ".git", "config"), '[filter "unsafe"]\n\tsmudge = cat\n');
        const h = host({ setModel: () => true });
        await expect(startRun(h.h, request(home))).rejects.toMatchObject({ code: "run_trust_required" });
        expect(worktreesOf(main)).toEqual([]);
        expect(h.opened).toEqual([]);
    });
});

test("a store failure keeps that worktree unsent and the next model still starts", async () => {
    const main = repo();
    const h = host({ setModel: () => true });
    let records = 0;
    h.h.record = () => { if (++records === 1) throw new Error("not writable"); };
    const result = await startRun(h.h, request(main));
    expect(result.results.map((row) => row.ok)).toEqual([false, true]);
    expect(result.results[0]).toMatchObject({ path: join(main, ".claude", "worktrees", "fix-the-login-redirect-mock-opus"), branch: "fix-the-login-redirect-mock-opus" });
    expect(h.sent).toEqual(["s2"]);
    expect(h.discarded).toEqual(["s1"]);
    expect(worktreesOf(main)).toHaveLength(2);
});

test("committed project configuration behind a symlink is checked even when missing from dirty Home", async () => {
    const main = repo({ "config/settings.json": '{"hooks":{}}' });
    symlinkSync("config", join(main, ".harness"));
    git(main, "add", ".harness");
    git(main, "commit", "-m", "Linked project configuration");
    rmSync(join(main, ".harness"));
    const h = host({ setModel: () => true });
    await expect(startRun(h.h, request(main))).rejects.toMatchObject({ code: "needs_project_trust", folder: main });
    expect(worktreesOf(main)).toEqual([]);
    expect(h.opened).toEqual([]);
});

test("persisted run groups and outcomes survive fresh engines, including archived members", async () => {
    const { Session } = await import("../src/agent/session");
    const main = repo();
    const outcomes = ["done", "stopped", "working"] as const;
    const sessions = outcomes.map((outcome, i) => {
        const session = Session.create(join(main, `session-${i}`));
        session.push({ role: "user", content: [{ type: "text", text: "same prompt" }], meta: { kind: "prompt" } });
        session.setModel(`mock:model-${i}`);
        return { id: session.meta.id, model: `mock:model-${i}`, modelName: `Model ${i}`, outcome };
    });
    writeFileSync(join(iso.home, "gui.json"), JSON.stringify({ runs: [{ id: "persisted-run", label: "same prompt", cwd: main, at: Date.now(), sessions }] }));
    const client = { subs: new Set<string>(), send: () => {} };
    const first = new Engine({ listModels: async () => [] });
    try {
        const members = first.listSessions().filter((s) => s.run?.id === "persisted-run");
        expect(members).toHaveLength(3);
        expect(members.map((s) => s.run?.outcome).sort()).toEqual(["done", "stopped", "stopped"]);
        await first.handle(client, "session.archive", { id: sessions[1]!.id, archived: true });
        expect(first.listSessions().filter((s) => s.run?.id === "persisted-run")).toHaveLength(2);
    } finally {
        await first.stop();
    }
    const second = new Engine({ listModels: async () => [] });
    try {
        expect(second.listSessions().filter((s) => s.run?.id === "persisted-run")).toHaveLength(2);
        expect(second.listSessions(200, true).find((s) => s.id === sessions[1]!.id)?.run).toMatchObject({ id: "persisted-run", outcome: "stopped", modelName: "Model 1" });
        await second.handle(client, "session.archive", { id: sessions[1]!.id, archived: false });
        expect(second.listSessions().filter((s) => s.run?.id === "persisted-run")).toHaveLength(3);
    } finally {
        await second.stop();
    }
});
