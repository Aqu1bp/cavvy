// All reports come from fake CLI protocols; no provider requests or signed-in homes.
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { AgentEvent } from "../src/agent/agent";
import type { BackendTurn } from "../src/backends/types";
import type { AccountInfo, PlanLimits, ServerEvent } from "../src/server/protocol";

const iso = isolate();
const root = tempDir("account-limits-");
const { BUILTIN_PROVIDERS, saveAgentConfig } = await import("../src/providers/registry");
const { createBackend } = await import("../src/backends/index");
const { mergeLimits, parseClaudeRateLimit, parseCodexRateLimits } = await import("../src/backends/limits");
const { Engine, limitTiming } = await import("../src/server/engine");
const { stopTiming } = await import("../src/backends/cli");
const { USAGE_NO_MODEL } = await import("../src/backends/claude-code");
const { planLimitKey } = await import("../src/server/protocol");
const { meterOf, limitAlternatives } = await import("../gui/src/lib/limits");
const keys = ["FAKE_SCENARIO", "FAKE_CLAUDE_LIMIT_INFO", "FAKE_CODEX_LIMIT_UPDATE", "FAKE_CODEX_LIMIT_READ", "FAKE_LIMIT_ERROR", "FAKE_RATE_LIMITS", "FAKE_RATE_LIMITS_RELEASE", "FAKE_LOG", "FAKE_USAGE_TEXT", "FAKE_USAGE_MODEL", "FAKE_USAGE_ERROR", "FAKE_USAGE_SHAPE", "FAKE_USAGE_DELAY_MS", "FAKE_CLAUDE_CLI_VERSION", "FAKE_VERSION_DELAY_MS", "FAKE_USAGE_IGNORE_TERM"];
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
    process.env.CAVVY_HOME = iso.home;
    for (const key of keys) delete process.env[key];
    process.env.FAKE_SCENARIO = "silent";
});
afterAll(() => {
    for (const key of keys) if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key];
    rmSync(root, { recursive: true, force: true });
    iso.cleanup();
});

function turn(provider: string, accountId: string, events: AgentEvent[], sessionKey = "test"): BackendTurn {
    return {
        prompt: "hello", images: [], cwd: root, model: { provider, id: "default" }, mode: "plan", accountId,
        additionalDirectories: [], trusted: true, rules: { deny: [], ask: [], root }, signal: new AbortController().signal,
        sessionKey,
        session: { mode: () => "plan", permission: async () => ({ allow: false }), askQuestions: async () => undefined, approvePlan: async () => ({ approved: false }), setMode: () => {}, usage: () => {}, sessionId: () => {}, limits: (limits, partial) => events.push({ type: "limits", limits, partial }) },
        sink: { emit: (e) => events.push(e), drainQueued: () => [] },
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
    expect(mergeLimits(personal, { ...personal, windows: [], at: 2 }, true).windows).toEqual(personal.windows.map((w) => ({ ...w, at: 1 })));
});

test("RPC state rejects older snapshots independently for each account", async () => {
    const engine = new Engine();
    const client = { send: () => {}, subs: new Set<string>() };
    engine.limitsReported(report("codex", "personal", 80, 20), false);
    engine.limitsReported(report("codex", "work", 10, 30), false);
    engine.limitsReported(report("codex", "personal", 5, 10), false);
    const all = await engine.handle(client, "limits.get", {});
    const keyed = Object.fromEntries(all.map((l) => [planLimitKey(l.provider, l.accountId), l]));
    expect(meterOf(keyed[planLimitKey("codex", "personal")], 30)?.top?.pct).toBe(80);
    expect(meterOf(keyed[planLimitKey("codex", "work")], 30)?.top?.pct).toBe(10);
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
        // Another session: one session runs one turn at a time (its app-server is live, #219).
        expect((await backend.runTurn(turn("codex", "work", work, "other"))).reason).toBe("done");
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

describe("limits.refresh: where a plan stands, asked of the CLI without a turn", () => {
    const usageLog = join(root, "usage.log");
    const lines = () => (existsSync(usageLog) ? readFileSync(usageLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
    /** The fake Claude Code's /usage runs so far: what each was started with. */
    const usageRuns = () => lines().filter((l) => l.argv?.[0] === "-p" && l.argv[1] === "/usage");
    const setup = () => {
        rmSync(usageLog, { force: true });
        // What earlier tests reported is fresh: each test starts from nothing.
        rmSync(join(iso.home, "limits.json"), { force: true });
        process.env.FAKE_LOG = usageLog;
        const engine = new Engine();
        const events: ServerEvent[] = [];
        const client = { send: (e: ServerEvent) => events.push(e), subs: new Set<string>() };
        engine.clients.add(client);
        return { engine, events, client };
    };
    const reset = new Date(Date.now() + 2 * 86_400_000);
    const when = `${reset.toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}, 8pm (UTC)`;
    const weekly = (pct: number) => `You are currently using your subscription to power your Claude Code usage\n\nCurrent week (all models): ${pct}% used · resets ${when}\nCurrent week (Fable): 4% used · resets ${when}\n\nWhat's contributing to your usage?\n  95%  a tip`;
    const work = [{ provider: "claude-code", accountId: "work" }];

    test("Claude Code's /usage: one check at a time per account, not again while it's fresh; no model, MCP servers or hooks; UTC", async () => {
        const { engine, events, client } = setup();
        process.env.FAKE_USAGE_TEXT = weekly(15);
        process.env.FAKE_USAGE_DELAY_MS = "200";
        await Promise.all([engine.handle(client, "limits.refresh", { plans: work }), engine.handle(client, "limits.refresh", { plans: work })]);
        // The second ask, during the first check, asked once more after it: the throttle then held it.
        expect(usageRuns()).toHaveLength(1);
        const argv: string[] = usageRuns()[0].argv;
        expect(argv).toEqual(expect.arrayContaining(["--output-format", "json", "--no-session-persistence", "--strict-mcp-config"]));
        // A model that doesn't exist: a CLI that sent /usage to one would fail before any request.
        expect(argv[argv.indexOf("--model") + 1]).toBe(USAGE_NO_MODEL);
        expect(JSON.parse(argv[argv.indexOf("--settings") + 1]!)).toEqual({ disableAllHooks: true });
        expect(lines().filter((l) => l.usage).map((l) => l.usage.tz)).toEqual(["UTC"]);
        expect(usageRuns()[0].claudeConfigDir).toContain("work");
        const all = await engine.handle(client, "limits.get", {});
        const got = all.find((l) => l.provider === "claude-code" && l.accountId === "work")!;
        expect(got.windows.map((w) => [w.label, w.usedPercent])).toEqual([["Weekly", 15], ["Weekly Fable", 4]]);
        expect(new Date(got.windows[0]!.resetsAt!).getUTCHours()).toBe(20);
        expect(events.some((e) => e.type === "limits" && e.limits.accountId === "work")).toBe(true);
        // Fresh: not asked again.
        await engine.handle(client, "limits.refresh", { plans: work });
        expect(usageRuns()).toHaveLength(1);
        await engine.stop();
    });

    test("a window that has reset since the last report is asked about at once", async () => {
        const { engine, client } = setup();
        process.env.FAKE_USAGE_TEXT = `Current week (all models): 1% used · resets ${when}`;
        const at = Date.now();
        engine.limitsReported({ provider: "claude-code", accountId: "work", windows: [{ id: "five_hour", label: "5-hour", usedPercent: 90, resetsAt: at + 50 }, { id: "seven_day", label: "Weekly", usedPercent: 50, resetsAt: reset.getTime() }], at }, false);
        // Just reported: not asked.
        await engine.handle(client, "limits.refresh", { plans: work });
        expect(usageRuns()).toHaveLength(0);
        await Bun.sleep(100);
        await engine.handle(client, "limits.refresh", { plans: work });
        expect(usageRuns()).toHaveLength(1);
        const got = (await engine.handle(client, "limits.get", {})).find((l) => l.provider === "claude-code" && l.accountId === "work")!;
        // The weekly figure is new; the 5-hour window /usage didn't list has reset, so it's gone.
        expect(got.windows.map((w) => [w.id, w.usedPercent])).toEqual([["seven_day", 1]]);
        await engine.stop();
    });

    test("asked again during a check (a reset passed meanwhile): checked once more after it", async () => {
        const { engine, client } = setup();
        // An answer it can't read: the last report stands, with its 5-hour window resetting during the check.
        process.env.FAKE_USAGE_TEXT = "Nothing to read";
        process.env.FAKE_USAGE_DELAY_MS = "400";
        const at = Date.now() - 10 * 60_000;
        engine.limitsReported({ provider: "claude-code", accountId: "work", windows: [{ id: "five_hour", label: "5-hour", usedPercent: 90, resetsAt: Date.now() + 150 }, { id: "seven_day", label: "Weekly", usedPercent: 50, resetsAt: reset.getTime() }], at }, false);
        const first = engine.handle(client, "limits.refresh", { plans: work });
        await Bun.sleep(250);
        await engine.handle(client, "limits.refresh", { plans: work });
        await first;
        const deadline = Date.now() + 5000;
        while (usageRuns().length < 2 && Date.now() < deadline) await Bun.sleep(50);
        expect(usageRuns()).toHaveLength(2);
        await Bun.sleep(600);
        // One follow-up at most.
        expect(usageRuns()).toHaveLength(2);
        await engine.stop();
    });

    test("an account removed during its check doesn't come back with the check's answer", async () => {
        const { engine, client } = setup();
        const folder = join(root, "leaving");
        mkdirSync(folder, { recursive: true });
        const { addAccount } = await import("../src/providers/accounts");
        const added = addAccount("claude-code", { id: "leaving", name: "Leaving", folder });
        process.env.FAKE_USAGE_TEXT = weekly(20);
        process.env.FAKE_USAGE_DELAY_MS = "400";
        const check = engine.handle(client, "limits.refresh", { plans: [{ provider: "claude-code", accountId: "leaving" }] });
        const deadline = Date.now() + 5000;
        while (!usageRuns().length && Date.now() < deadline) await Bun.sleep(20);
        await engine.handle(client, "accounts.remove", { provider: "claude-code", id: "leaving", confirmedFolder: added.folder });
        await check;
        await Bun.sleep(100);
        expect((await engine.handle(client, "limits.get", {})).some((l) => l.accountId === "leaving")).toBe(false);
        await engine.stop();
    });

    test("every account of the CLIs turned on, two checks at a time", async () => {
        const { engine, client } = setup();
        process.env.FAKE_USAGE_TEXT = weekly(30);
        process.env.FAKE_USAGE_DELAY_MS = "300";
        await engine.handle(client, "limits.refresh", {});
        const runs = lines().filter((l) => l.usage || l.usageEnd);
        expect(usageRuns().map((r) => r.claudeConfigDir ?? "default").length).toBe(3);
        // At most two at once: each start is after all but one of the earlier ones ended.
        let open = 0, most = 0;
        for (const l of runs) {
            open += l.usage ? 1 : -1;
            most = Math.max(most, open);
        }
        expect(most).toBeLessThanOrEqual(2);
        expect((await engine.handle(client, "limits.get", {})).filter((l) => l.provider === "claude-code").map((l) => l.accountId).sort()).toEqual(["default", "personal", "work"]);
        await engine.stop();
    });

    const waitFor = async (ok: () => boolean, ms = 5000) => {
        const deadline = Date.now() + ms;
        while (!ok() && Date.now() < deadline) await Bun.sleep(20);
    };
    const alive = (pid: number) => {
        try {
            process.kill(pid, 0);
            return true;
        } catch {
            return false;
        }
    };

    test("an account removed while its check is starting: /usage is never started for it", async () => {
        const { engine, client } = setup();
        const folder = join(root, "going");
        mkdirSync(folder, { recursive: true });
        const { addAccount } = await import("../src/providers/accounts");
        const added = addAccount("claude-code", { id: "going", name: "Going", folder });
        process.env.FAKE_USAGE_TEXT = weekly(20);
        process.env.FAKE_VERSION_DELAY_MS = "400";
        const check = engine.handle(client, "limits.refresh", { plans: [{ provider: "claude-code", accountId: "going" }] });
        await waitFor(() => lines().some((l) => l.version));
        await engine.handle(client, "accounts.remove", { provider: "claude-code", id: "going", confirmedFolder: added.folder });
        await check;
        await Bun.sleep(300);
        expect(usageRuns()).toHaveLength(0);
        await engine.stop();
    });

    test("stopping the server stops its checks: one that ignores SIGTERM is killed, one waiting doesn't start", async () => {
        const saved = { ...stopTiming };
        Object.assign(stopTiming, { killMs: 300 });
        try {
            const { engine, client } = setup();
            process.env.FAKE_USAGE_TEXT = weekly(20);
            process.env.FAKE_USAGE_DELAY_MS = "20000";
            process.env.FAKE_USAGE_IGNORE_TERM = "1";
            void engine.handle(client, "limits.refresh", {});
            await waitFor(() => usageRuns().length === 2);
            expect(usageRuns()).toHaveLength(2);
            const pids = lines().filter((l) => l.usage).map((l) => l.usage.pid as number);
            const t = Date.now();
            await engine.stop();
            expect(Date.now() - t).toBeLessThan(4000);
            expect(pids.filter(alive)).toEqual([]);
            await Bun.sleep(300);
            // The third account's check was waiting for a place: it never started.
            expect(usageRuns()).toHaveLength(2);
        } finally {
            Object.assign(stopTiming, saved);
        }
    });

    test("a check that waited long for its place counts from when it asked, and asking while it waits adds nothing", async () => {
        const saved = limitTiming.freshMs;
        limitTiming.freshMs = 600;
        try {
            const { engine, client } = setup();
            process.env.FAKE_USAGE_TEXT = "Nothing to read";
            process.env.FAKE_USAGE_DELAY_MS = "400";
            // Default and Personal take the places; Work waits for one (400 ms) and then asks (400 ms more).
            const all = engine.handle(client, "limits.refresh", {});
            await waitFor(() => usageRuns().length === 2);
            // Asked while it waits: the check it's waiting to make answers that too.
            await Promise.all([all, engine.handle(client, "limits.refresh", { plans: work })]);
            expect(usageRuns()).toHaveLength(3);
            expect(usageRuns()[2].claudeConfigDir).toContain("work");
            // Asked again as soon as it's done: it asked 400 ms ago, within the throttle, though it was queued 800 ms ago.
            await engine.handle(client, "limits.refresh", { plans: work });
            await Bun.sleep(200);
            expect(usageRuns()).toHaveLength(3);
            await engine.stop();
        } finally {
            limitTiming.freshMs = saved;
        }
    });

    test("a follow-up for a window that reset during a check isn't held back by a report about another window", async () => {
        const { engine, client } = setup();
        process.env.FAKE_USAGE_TEXT = "Nothing to read";
        process.env.FAKE_USAGE_DELAY_MS = "400";
        const at = Date.now() - 10 * 60_000;
        engine.limitsReported({ provider: "claude-code", accountId: "work", windows: [{ id: "five_hour", label: "5-hour", usedPercent: 90, resetsAt: Date.now() + 150 }, { id: "seven_day", label: "Weekly", usedPercent: 50, resetsAt: reset.getTime() }], at }, false);
        const first = engine.handle(client, "limits.refresh", { plans: work });
        await Bun.sleep(250);
        // The 5-hour window has reset: asked again during the check. Then a report about the week alone comes in.
        void engine.handle(client, "limits.refresh", { plans: work });
        await Bun.sleep(20);
        engine.limitsReported({ provider: "claude-code", accountId: "work", windows: [{ id: "seven_day", label: "Weekly", usedPercent: 52, resetsAt: reset.getTime() }], at: Date.now() }, true);
        await first;
        await waitFor(() => usageRuns().length >= 2);
        expect(usageRuns()).toHaveLength(2);
        await engine.stop();
    });

    // Last: an account whose answer wasn't a local one is remembered while Cavvy runs.
    test("an answer it can't read keeps the last report; one that isn't a local /usage answer isn't asked for again; an older CLI isn't asked", async () => {
        const { engine, client } = setup();
        engine.limitsReported(report("claude-code", "personal", 40, Date.now() - 10 * 60_000), false);
        const plans = [{ provider: "claude-code", accountId: "personal" }];
        process.env.FAKE_USAGE_TEXT = "Something else entirely";
        await engine.handle(client, "limits.refresh", { plans });
        expect(usageRuns()).toHaveLength(1);
        const kept = (await engine.handle(client, "limits.get", {})).find((l) => l.accountId === "personal" && l.provider === "claude-code")!;
        expect(kept.windows[0]!.usedPercent).toBe(40);
        await engine.stop();

        const second = setup();
        process.env.FAKE_CLAUDE_CLI_VERSION = "2.1.310";
        await second.engine.handle(second.client, "limits.refresh", { plans });
        expect(usageRuns()).toHaveLength(0);
        delete process.env.FAKE_CLAUDE_CLI_VERSION;
        await second.engine.stop();
        // Answered by the model, with an error, or in a shape not known: asked once, then not again (a new server
        // check each time, so the throttle isn't what stops it).
        for (const [account, key, value] of [["work", "FAKE_USAGE_MODEL", "1"], ["personal", "FAKE_USAGE_ERROR", "1"], ["default", "FAKE_USAGE_SHAPE", "other"]] as const) {
            process.env[key] = value;
            for (const runs of [1, 0]) {
                const s = setup();
                await s.engine.handle(s.client, "limits.refresh", { plans: [{ provider: "claude-code", accountId: account }] });
                expect(usageRuns()).toHaveLength(runs);
                await s.engine.stop();
            }
            delete process.env[key];
        }
    });
});
