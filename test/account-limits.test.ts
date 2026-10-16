// All reports come from fake CLI protocols; no provider requests or signed-in homes.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { componentCode, elements, node } from "./gui-component-harness";
import type { AgentEvent } from "../src/agent/agent";
import type { BackendTurn } from "../src/backends/types";
import type { AccountInfo, PlanLimits, ServerEvent } from "../src/server/protocol";

const iso = isolate();
const root = tempDir("account-limits-");
const { BUILTIN_PROVIDERS, saveAgentConfig } = await import("../src/providers/registry");
const { createBackend } = await import("../src/backends/index");
const { mergeLimits, parseClaudeRateLimit, parseCodexRateLimits } = await import("../src/backends/limits");
const { Engine } = await import("../src/server/engine");
const { planLimitKey } = await import("../src/server/protocol");
const { meterOf, limitAlternatives } = await import("../gui/src/lib/limits");
const keys = ["FAKE_SCENARIO", "FAKE_CLAUDE_LIMIT_INFO", "FAKE_CODEX_LIMIT_UPDATE", "FAKE_CODEX_LIMIT_READ", "FAKE_LIMIT_ERROR", "FAKE_RATE_LIMITS", "FAKE_RATE_LIMITS_RELEASE", "FAKE_LOG"];
const previous = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
for (const provider of ["claude-code", "codex"]) {
    const binary = join(root, provider);
    writeFileSync(binary, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures", provider === "codex" ? "fake-codex.ts" : "fake-claude.ts")}" "$@"\n`);
    chmodSync(binary, 0o700);
    const accounts = ["personal", "work"].map((id) => {
        const folder = join(iso.home, "accounts", provider, id);
        mkdirSync(folder, { recursive: true });
        return { id, name: id === "personal" ? "Personal" : "Work", folder, managed: true };
    });
    saveAgentConfig(provider, { path: binary, accounts });
}
beforeEach(() => {
    process.env.HARNESS_HOME = iso.home;
    for (const key of keys) delete process.env[key];
    process.env.FAKE_SCENARIO = "silent";
});
afterAll(() => {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    rmSync(root, { recursive: true, force: true });
    iso.cleanup();
});

function turn(provider: string, accountId: string, events: AgentEvent[]): BackendTurn {
    return {
        prompt: "hello", images: [], cwd: root, model: { provider, id: "default" }, mode: "plan", accountId,
        additionalDirectories: [], trusted: true, rules: { deny: [], ask: [], root }, signal: new AbortController().signal,
        host: { emit: (e) => events.push(e), mode: () => "plan", permission: async () => ({ allow: false }), askQuestions: async () => undefined, approvePlan: async () => ({ approved: false }), setMode: () => {}, usage: () => {}, sessionId: () => {}, drainQueued: () => [] },
    };
}
const report = (provider: string, accountId: string, percent: number, at = Date.now()): PlanLimits => ({ provider, accountId, windows: [{ id: "five", label: "5-hour", usedPercent: percent }], reached: percent === 100, at });

for (const provider of ["claude-code", "codex"]) describe(provider, () => {
    test("fixture reports and reached errors stay on the selected account", async () => {
        const backend = createBackend(BUILTIN_PROVIDERS.find((p) => p.id === provider)!);
        const engine = new Engine();
        const broadcasts: ServerEvent[] = [];
        const client = { send: (e: ServerEvent) => broadcasts.push(e), subs: new Set<string>() };
        engine.clients.add(client);
        for (const [id, percent] of [["personal", 100], ["work", 25]] as const) {
            if (provider === "claude-code") process.env.FAKE_CLAUDE_LIMIT_INFO = JSON.stringify({ status: percent === 100 ? "rejected" : "allowed", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: percent / 100, resetsAt: Date.now() / 1000 + 3600 } } });
            else process.env.FAKE_CODEX_LIMIT_UPDATE = JSON.stringify({ rateLimits: { limitId: "codex", primary: { usedPercent: percent, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600 }, rateLimitReachedType: percent === 100 ? "rate_limit" : null } });
            process.env.FAKE_LIMIT_ERROR = percent === 100 ? "1" : "0";
            const events: AgentEvent[] = [];
            const result = await backend.runTurn(turn(provider, id, events));
            const reports = events.filter((e) => e.type === "limits");
            expect(reports.length).toBeGreaterThan(0);
            expect(reports.every((e) => e.limits.accountId === id && e.limits.provider === provider)).toBe(true);
            for (const event of reports) engine.limitsReported(event.limits, event.partial);
            if (percent === 100) {
                expect(result.reason).toBe("error");
                expect(result.error).toContain("Personal");
                expect(result.error).toContain("send again");
            }
        }
        const all = await engine.handle(client, "limits.get", {});
        expect(all).toHaveLength(2);
        expect(all.find((l) => l.accountId === "personal")).toMatchObject({ reached: true });
        expect(all.find((l) => l.accountId === "personal")!.windows[0]!.usedPercent).toBe(100);
        expect(all.find((l) => l.accountId === "work")!.windows[0]!.usedPercent).toBe(25);
        expect(broadcasts.filter((e) => e.type === "limits").every((e) => "accountId" in e.limits)).toBe(true);
        expect(JSON.stringify(all)).not.toContain("me@example.com");
        await engine.stop();
    });
});

test("sparse merges never copy another account or provider's windows", () => {
    const personal = report("codex", "personal", 100, 1);
    const work = { ...report("codex", "work", 15, 2), windows: [] };
    expect(mergeLimits(personal, work, true)).toEqual(work);
    const claude = { ...work, provider: "claude-code", accountId: "personal" };
    expect(mergeLimits(personal, claude, true)).toEqual(claude);
    expect(mergeLimits(personal, { ...personal, windows: [], at: 2 }, true).windows).toEqual(personal.windows);
});

test("RPC state rejects older snapshots independently for each account", async () => {
    const engine = new Engine();
    const client = { send: () => {}, subs: new Set<string>() };
    engine.limitsReported(report("codex", "personal", 80, 20), false);
    engine.limitsReported(report("codex", "work", 10, 30), false);
    engine.limitsReported(report("codex", "personal", 5, 10), false);
    const all = await engine.handle(client, "limits.get", {});
    const keyed = Object.fromEntries(all.map((l) => [planLimitKey(l.provider, l.accountId), l]));
    expect(meterOf(keyed[planLimitKey("codex", "personal")], 30)?.top).toBe(80);
    expect(meterOf(keyed[planLimitKey("codex", "work")], 30)?.top).toBe(10);
    expect(planLimitKey("codex", "personal")).not.toBe(planLimitKey("claude-code", "personal"));
    await engine.stop();
});

test("meter alternatives require confirmed sign-in and omit the currently selected account", () => {
    const accounts = [
        { id: "personal", signedIn: true }, { id: "work", signedIn: true },
        { id: "unknown" }, { id: "out", signedIn: false },
    ] as AccountInfo[];
    expect(limitAlternatives(accounts, "personal").map((a) => a.id)).toEqual(["work"]);
    expect(limitAlternatives(accounts, "work").map((a) => a.id)).toEqual(["personal"]);
});

test("CLI payload identity and credits never enter limit state", () => {
    const claude = parseClaudeRateLimit({ status: "allowed", email: "private@example.com", plan: "private", unifiedWindows: { five_hour: { utilization: 0.2 } } }, 1, "personal");
    const codex = parseCodexRateLimits({ rateLimits: { planType: "private", credits: { balance: "private" }, primary: { usedPercent: 33, windowDurationMins: 300 } } }, { at: 1, accountId: "work" });
    expect(claude?.limits.accountId).toBe("personal");
    expect(codex?.limits.accountId).toBe("work");
    expect(JSON.stringify([claude, codex])).not.toContain("private");
});

test("Claude warning deduplication does not suppress another account's notice", async () => {
    process.env.FAKE_CLAUDE_LIMIT_INFO = JSON.stringify({ status: "allowed_warning", rateLimitType: "five_hour", resetsAt: 4_000_000_000 });
    const backend = createBackend(BUILTIN_PROVIDERS.find((p) => p.id === "claude-code")!);
    const notices: string[][] = [];
    for (const accountId of ["personal", "personal", "work"]) {
        const events: AgentEvent[] = [];
        await backend.runTurn(turn("claude-code", accountId, events));
        notices.push(events.filter((e) => e.type === "notice" && /close to the .*usage limit/.test(e.message)).map((e) => e.message));
    }
    expect(notices.map((n) => n.length)).toEqual([1, 0, 1]);
    expect(notices[0]![0]).toContain("Personal");
    expect(notices[2]![0]).toContain("Work");
});

test("removing metadata clears the server and GUI meter before the id can be reused", async () => {
    const folder = join(root, "discarded");
    mkdirSync(folder);
    const { addAccount } = await import("../src/providers/accounts");
    const added = addAccount("codex", { id: "discarded", name: "Discarded", folder });
    const engine = new Engine();
    const events: ServerEvent[] = [];
    const client = { send: (e: ServerEvent) => events.push(e), subs: new Set<string>() };
    engine.clients.add(client);
    engine.limitsReported(report("codex", "discarded", 100), false);
    engine.limitsReported(report("codex", "work", 25), false);
    await engine.handle(client, "accounts.remove", { provider: "codex", id: "discarded", confirmedFolder: added.folder });
    const all = await engine.handle(client, "limits.get", {});
    expect(all.map((l) => l.accountId)).toEqual(["work"]);
    const clearing = events.filter((e) => e.type === "limits" && e.limits.accountId === "discarded").at(-1)!;
    expect(clearing.type === "limits" && meterOf(clearing.limits, Date.now())).toBeUndefined();
    await engine.stop();
});


test("a newer Codex read on another account does not suppress a delayed account snapshot", async () => {
    const backend = createBackend(BUILTIN_PROVIDERS.find((p) => p.id === "codex")!);
    const personal: AgentEvent[] = [];
    const work: AgentEvent[] = [];
    const release = join(root, "release-personal-limits");
    const log = join(root, "personal-read.log");
    process.env.FAKE_RATE_LIMITS = join(import.meta.dir, "fixtures", "limits", "codex-update-normal.json");
    process.env.FAKE_RATE_LIMITS_RELEASE = release;
    process.env.FAKE_LOG = log;
    const older = backend.runTurn(turn("codex", "personal", personal));
    try {
        const deadline = Date.now() + 3000;
        while (!(existsSync(log) && readFileSync(log, "utf8").includes('"method":"account/rateLimits/read"')) && Date.now() < deadline) await Bun.sleep(5);
        expect(existsSync(log) && readFileSync(log, "utf8").includes('"method":"account/rateLimits/read"')).toBe(true);
        delete process.env.FAKE_RATE_LIMITS_RELEASE;
        delete process.env.FAKE_LOG;
        process.env.FAKE_RATE_LIMITS = join(import.meta.dir, "fixtures", "limits", "codex-update-reached.json");
        expect((await backend.runTurn(turn("codex", "work", work))).reason).toBe("done");
        expect(work.filter((e) => e.type === "limits")).toHaveLength(1);
    } finally {
        writeFileSync(release, "release");
        await older;
    }
    const reports = personal.filter((e) => e.type === "limits");
    expect(reports).toHaveLength(1);
    expect(reports[0]!.limits).toMatchObject({ provider: "codex", accountId: "personal" });
    expect(work.find((e) => e.type === "limits")!.limits).toMatchObject({ provider: "codex", accountId: "work", reached: true });
});


test("PlanMeter starts on Home's default account and uses an open session's own account", () => {
    const providers = [{ id: "codex", name: "Codex", agentCli: { plan: "ChatGPT plan", defaultAccount: "work", accounts: [{ id: "personal", name: "Personal" }, { id: "work", name: "Work" }] } }];
    const limits = Object.fromEntries([report("codex", "personal", 80), report("codex", "work", 20)].map((l) => [planLimitKey(l.provider, l.accountId), l]));
    let settingsTab: string | undefined;
    const PlanMeter = componentCode("PlanMeter", {
        app: { providers, limits }, handleFor: () => ({ view: { state: { model: { provider: "codex" }, accounts: { codex: "personal" } } } }),
        planLimitKey, meterOf, limitAlternatives, windowLine: (w: { pct: number }) => `${w.pct}%`,
        now: () => Date.now(), createMemo: (fn: () => unknown) => { const value = fn(); return () => value; },
        createSignal: (value: unknown) => [() => value, () => {}], createEffect: () => {}, onCleanup: () => {},
        node, Show: "Show", For: "For", Popover: "Popover", setSettingsTab: (tab: string) => { settingsTab = tab; },
    });
    const home = elements(PlanMeter({ provider: "codex" }), "button");
    expect(home[0]!.props["aria-label"]).toBe("ChatGPT plan · Work usage: 20%");
    home.find((b) => b.children.includes("Usage"))!.props.onClick();
    expect(settingsTab).toBe("usage");
    const session = elements(PlanMeter({ sessionId: "session" }), "button");
    expect(session[0]!.props["aria-label"]).toBe("ChatGPT plan · Personal usage: 80%");
});
