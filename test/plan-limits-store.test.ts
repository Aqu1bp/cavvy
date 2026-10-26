// Plan limits without a turn: the last ones the server saw are saved and come back
// after a restart (with the time they were reported), and Codex is asked for its
// own (account/rateLimits/read) when the server starts. Fake CLIs only.
import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { PlanLimits, ServerEvent } from "../src/server/protocol";

const iso = isolate();
const root = tempDir("plan-limits-store-");
const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
const { addAccount } = await import("../src/providers/accounts");
const { Engine } = await import("../src/server/engine");
const { paths } = await import("../src/config/paths");
const { loadPlanLimits } = await import("../src/server/limits-store");
const { codexPlan } = await import("../src/backends/codex");

const FAKE_KEYS = ["FAKE_ACCOUNT", "FAKE_RATE_LIMITS", "FAKE_LOG", "FAKE_PLAN", "FAKE_LOGGED_IN"];
const fake = (name: string, fixture: string) => {
    const bin = join(root, name);
    writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`);
    chmodSync(bin, 0o700);
    return bin;
};
const codexBin = fake("codex", "fake-codex.ts");
const claudeBin = fake("claude", "fake-claude.ts");
const READ = join(import.meta.dir, "fixtures", "limits", "codex-read.json");

beforeEach(() => {
    process.env.HARNESS_HOME = iso.home;
    for (const k of FAKE_KEYS) delete process.env[k];
    for (const p of ["codex", "claude-code"]) removeAgentConfig(p);
    rmSync(paths.planLimits(), { force: true });
});
afterAll(() => {
    for (const k of FAKE_KEYS) delete process.env[k];
    rmSync(root, { recursive: true, force: true });
    iso.cleanup();
});

const client = (events: ServerEvent[] = []) => ({ send: (e: ServerEvent) => events.push(e), subs: new Set<string>() });
const report = (provider: string, percent: number, at: number, accountId = "default"): PlanLimits => ({ provider, accountId, windows: [{ id: "five_hour", label: "5-hour", usedPercent: percent, resetsAt: at + 3_600_000 }], reached: false, at });
const engineOf = () => new Engine({ listModels: async () => [] });

async function until<T>(f: () => Promise<T | undefined>, ms = 15_000): Promise<T> {
    const end = Date.now() + ms;
    for (;;) {
        const v = await f();
        if (v !== undefined) return v;
        if (Date.now() > end) throw new Error("timed out");
        await new Promise((r) => setTimeout(r, 50));
    }
}

test("the last limits the server saw come back after a restart, as reported then", async () => {
    const at = Date.now() - 3 * 3_600_000;
    const first = engineOf();
    first.limitsReported(report("claude-code", 64, at), false);
    first.limitsReported(report("codex", 30, at + 1000), false);
    await first.stop();
    expect(existsSync(paths.planLimits())).toBe(true);

    const second = engineOf();
    await second.start();
    const all = await second.handle(client(), "limits.get", {});
    expect(all.find((l) => l.provider === "claude-code")).toEqual(report("claude-code", 64, at));
    expect(all.find((l) => l.provider === "codex")?.windows[0]?.usedPercent).toBe(30);
    // A newer report replaces the saved one; an older one doesn't.
    second.limitsReported(report("claude-code", 10, at - 1000), false);
    second.limitsReported(report("claude-code", 70, Date.now()), false);
    expect(loadPlanLimits().find((l) => l.provider === "claude-code")?.windows[0]?.usedPercent).toBe(70);
    await second.stop();
});

test("an account removed is forgotten, saved too; one removed while the server was down isn't loaded", async () => {
    saveAgentConfig("codex", { path: codexBin });
    const folder = join(root, "work");
    mkdirSync(folder, { recursive: true });
    const work = addAccount("codex", { id: "work", name: "Work", folder });
    const first = engineOf();
    first.limitsReported(report("codex", 40, Date.now(), "work"), false);
    first.limitsReported(report("claude-code", 20, Date.now()), false);
    await first.handle(client(), "accounts.remove", { provider: "codex", id: "work", confirmedFolder: work.folder });
    expect(loadPlanLimits().map((l) => [l.provider, l.accountId])).toEqual([["claude-code", "default"]]);
    await first.stop();
    removeAgentConfig("codex");

    // Saved for an account that no longer exists (or a provider that isn't a plan): left out.
    writeFileSync(paths.planLimits(), JSON.stringify({ version: 1, limits: [report("codex", 50, 1, "gone"), report("anthropic", 50, 1), report("claude-code", 20, 5)] }));
    const second = engineOf();
    await second.start();
    expect((await second.handle(client(), "limits.get", {})).map((l) => [l.provider, l.accountId])).toEqual([["claude-code", "default"]]);
    await second.stop();
});

test("whether turns go on using credits (#434) is saved as a flag, and nothing else of credits", () => {
    const window = { id: "codex:primary", label: "5-hour", usedPercent: 100, reached: true };
    writeFileSync(paths.planLimits(), JSON.stringify({ version: 1, limits: [
        { provider: "codex", at: 1, reached: true, credits: true, windows: [window, { ...window, id: "spark:primary", credits: false }] },
        { provider: "claude-code", at: 2, reached: true, credits: { balance: "917" }, windows: [{ ...window, credits: "yes" }] },
    ] }));
    const [codex, claude] = loadPlanLimits();
    expect(codex!.credits).toBe(true);
    expect(codex!.windows.map((w) => w.credits)).toEqual([undefined, false]);
    expect(claude!.credits).toBeUndefined();
    expect(claude!.windows[0]!.credits).toBeUndefined();
    expect(JSON.stringify(claude)).not.toContain("917");
});

test("a broken or foreign file is ignored", async () => {
    writeFileSync(paths.planLimits(), "{ not json");
    expect(loadPlanLimits()).toEqual([]);
    writeFileSync(paths.planLimits(), JSON.stringify({ version: 2, limits: [report("claude-code", 1, 1)] }));
    expect(loadPlanLimits()).toEqual([]);
    writeFileSync(paths.planLimits(), JSON.stringify({ version: 1, limits: [{ provider: "claude-code", windows: "x", at: 1 }, { provider: "codex", at: 2, windows: [{ id: "a", label: "5-hour", usedPercent: 140 }, { id: 3 }] }] }));
    expect(loadPlanLimits()).toEqual([{ provider: "codex", accountId: "default", windows: [{ id: "a", label: "5-hour", usedPercent: 100, resetsAt: undefined, reached: undefined }], reached: undefined, resetsAt: undefined, at: 2 }]);
});

test("Codex on a ChatGPT plan is asked for its limits without a turn; on an API key it isn't", async () => {
    saveAgentConfig("codex", { path: codexBin });
    process.env.FAKE_RATE_LIMITS = READ;
    process.env.FAKE_LOG = join(root, "codex-plan.log");
    const plan = await codexPlan("codex", undefined, "default");
    expect(plan.account.type).toBe("chatgpt");
    expect(plan.limits).toMatchObject({ provider: "codex", accountId: "default", reached: false });
    expect(plan.limits!.windows.map((w) => [w.label, w.usedPercent])).toEqual([["Weekly", 14]]);

    process.env.FAKE_ACCOUNT = "apikey";
    process.env.FAKE_LOG = join(root, "codex-apikey.log");
    const keyed = await codexPlan("codex", undefined, "default");
    expect(keyed.account.type).toBe("apiKey");
    expect(keyed.limits).toBeUndefined();
    expect(readFileSync(process.env.FAKE_LOG, "utf8")).not.toContain("account/rateLimits/read");
});

test("at start, a Codex plan's limits and each CLI's sign-in are read, and every window hears of them", async () => {
    saveAgentConfig("codex", { path: codexBin });
    saveAgentConfig("claude-code", { path: claudeBin });
    process.env.FAKE_RATE_LIMITS = READ;
    process.env.FAKE_PLAN = "pro";
    const engine = engineOf();
    const events: ServerEvent[] = [];
    const c = client(events);
    engine.clients.add(c);
    await engine.start();
    const all = await until(async () => {
        const l = await engine.handle(c, "limits.get", {});
        return l.length ? l : undefined;
    });
    expect(all.map((l) => l.provider)).toEqual(["codex"]);
    expect(all[0]!.windows[0]?.usedPercent).toBe(14);
    expect(events.some((e) => e.type === "limits" && e.limits.provider === "codex")).toBe(true);
    // Saved, for the next start.
    expect(loadPlanLimits().map((l) => l.provider)).toEqual(["codex"]);
    // The plans' sign-in, for the sidebar to pick from (without asking each CLI again).
    const codex = await until(async () => (await engine.handle(c, "accounts.list", { provider: "codex" })).find((a) => a.signedIn !== undefined));
    expect(codex).toMatchObject({ signedIn: true, plan: "pro", apiKey: false });
    const claude = await until(async () => (await engine.handle(c, "accounts.list", { provider: "claude-code" })).find((a) => a.signedIn !== undefined));
    expect(claude).toMatchObject({ signedIn: true, plan: "pro", apiKey: false });
    await until(async () => (events.some((e) => e.type === "models.changed") ? true : undefined));
    await engine.stop();
});

test("a CLI that isn't turned on isn't asked", async () => {
    process.env.FAKE_RATE_LIMITS = READ;
    process.env.FAKE_LOG = join(root, "off.log");
    const engine = engineOf();
    await engine.start();
    await new Promise((r) => setTimeout(r, 300));
    expect(await engine.handle(client(), "limits.get", {})).toEqual([]);
    expect(existsSync(process.env.FAKE_LOG)).toBe(false);
    await engine.stop();
});
