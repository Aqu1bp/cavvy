// Plan limits from the agent CLIs (parsed from captured payloads, and through
// the fake CLIs to the turn's error), the Usage view's aggregation over
// synthetic transcripts, and how slash commands are told from messages.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { parseClaudeRateLimit, parseCodexRateLimits, mergeLimits, resetPhrase, resetSentence, untilText, limitLines, limitNews } = await import("../src/backends/limits");
const { usageSummary, usageDays, usageBounds, clearUsageCache } = await import("../src/server/usage");
const { slashCommand } = await import("../src/commands/custom");
const { meterOf, costText, windowLine, resetLabel, emptyText } = await import("../gui/src/lib/limits");
const { clientAction, slashName } = await import("../gui/src/lib/commands");
const { contextView } = await import("../gui/src/lib/context");
const { cliCommandNames } = await import("../src/commands/custom");

type AgentEvent = import("../src/agent/agent").AgentEvent;
type PlanLimits = import("../src/server/protocol").PlanLimits;

const FIX = join(import.meta.dir, "fixtures", "limits");
const fixture = (name: string) => JSON.parse(readFileSync(join(FIX, name), "utf-8"));
const bin = tempDir("fake-limits-");
const LOG = join(bin, "log.jsonl");

function wrapper(name: string, fake: string): string {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" --no-env-file "${join(import.meta.dir, "fixtures", fake)}" "$@"\n`);
    chmodSync(p, 0o755);
    return p;
}
const claudeBin = wrapper("claude", "fake-claude.ts");
const codexBin = wrapper("codex", "fake-codex.ts");

/** A fixture with every resetsAt moved to `at` (ms), for the fakes to send. */
function shifted(name: string, at: number): string {
    const p = join(bin, `${Math.random().toString(36).slice(2)}-${name}`);
    writeFileSync(p, readFileSync(join(FIX, name), "utf-8").replace(/"resetsAt":\d+/g, `"resetsAt":${Math.round(at / 1000)}`));
    return p;
}

afterAll(() => {
    iso.cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

// ---------------------------------------------------------------------------

describe("Claude Code's rate_limit_event", () => {
    const at = 1_792_150_000_000;

    test("normal: its windows, with percentages and reset times", () => {
        const r = parseClaudeRateLimit(fixture("claude-normal.json"), at)!;
        expect(r.partial).toBe(false);
        expect(r.limits).toEqual({
            provider: "claude-code",
            accountId: "default",
            windows: [
                { id: "five_hour", label: "5-hour", usedPercent: 47, resetsAt: 1792156200_000, reached: undefined },
                { id: "seven_day", label: "Weekly", usedPercent: 54, resetsAt: 1792526400_000, reached: undefined },
            ],
            reached: false,
            resetsAt: undefined,
            at,
        });
    });

    test("warning: not reached", () => {
        const r = parseClaudeRateLimit(fixture("claude-warning.json"), at)!;
        expect(r.limits.reached).toBe(false);
        expect(r.limits.windows[0]).toMatchObject({ id: "five_hour", usedPercent: 91 });
    });

    test("rejected: the window it names is reached, and when it resets", () => {
        const r = parseClaudeRateLimit(fixture("claude-rejected.json"), at)!;
        expect(r.limits.reached).toBe(true);
        expect(r.limits.resetsAt).toBe(1792156200_000);
        expect(r.limits.windows.find((w) => w.id === "five_hour")).toMatchObject({ usedPercent: 100, reached: true });
        expect(r.limits.windows.find((w) => w.id === "seven_day")?.reached).toBeUndefined();
    });

    test("missing fields: a status alone says reached, with no time and no windows (partial)", () => {
        const r = parseClaudeRateLimit(fixture("claude-missing.json"), at)!;
        expect(r).toEqual({ limits: { provider: "claude-code", accountId: "default", windows: [], reached: true, resetsAt: undefined, at }, partial: true });
        expect(parseClaudeRateLimit({}, at)).toBeUndefined();
        expect(parseClaudeRateLimit(null, at)).toBeUndefined();
        expect(parseClaudeRateLimit({ status: "allowed", unifiedWindows: { five_hour: { utilization: "lots" } } }, at)!.limits.windows).toEqual([{ id: "five_hour", label: "5-hour", usedPercent: undefined, resetsAt: undefined, reached: undefined }]);
    });

    test("rejected without a top-level time: the named window's reset, not another window's", () => {
        const r = parseClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792156200 }, seven_day: { utilization: 0.4, resetsAt: 1792526400 } } }, at)!;
        expect(r.limits.resetsAt).toBe(1792156200_000);
    });

    test("a rejection naming five-hour still waits for a full weekly window", () => {
        const r = parseClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1792156200, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792156200 }, seven_day: { utilization: 1, resetsAt: 1792526400 } } }, at)!;
        expect(r.limits.resetsAt).toBe(1792526400_000);
        expect(meterOf(r.limits, 1792156200_000 + 1)!.reached).toBe(true);
        expect(meterOf(r.limits, 1792526400_000 + 1)!.reached).toBe(false);
    });

    test("a rejection's known five-hour reset cannot promise when an unknown weekly blocker lifts", () => {
        const r = parseClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: 1792156200, unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792156200 }, seven_day: { utilization: 1 } } }, at)!;
        expect(r.limits.reached).toBe(true);
        expect(r.limits.resetsAt).toBeUndefined();
        expect(r.limits.windows[0]!.resetsAt).toBe(1792156200_000);
        expect(r.limits.windows[1]!.resetsAt).toBeUndefined();
    });

    test("a partial allowed report does not clear another full window with an unknown reset", () => {
        const prev = parseClaudeRateLimit({ status: "rejected", rateLimitType: "seven_day", unifiedWindows: { five_hour: { utilization: 1, resetsAt: 1792156200 }, seven_day: { utilization: 1 } } }, at)!.limits;
        const next = parseClaudeRateLimit({ status: "allowed", rateLimitType: "five_hour", resetsAt: 1792160400 }, at + 1)!;
        const merged = mergeLimits(prev, next.limits, next.partial);
        expect(merged.reached).toBe(true);
        expect(merged.resetsAt).toBeUndefined();
        expect(merged.windows[0]!.resetsAt).toBe(1792160400_000);
    });

    test("a sparse rejection keeps the same window's unexpired reset", () => {
        const reset = at + 3_600_000;
        const detailed = parseClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: reset / 1000 }, at)!.limits;
        const sparse = parseClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour" }, at + 1)!;
        const merged = mergeLimits(detailed, sparse.limits, sparse.partial);
        expect(merged.windows[0]!.resetsAt).toBe(reset);
        expect(merged.resetsAt).toBe(reset);
        expect(meterOf(merged, at + 1)!.resets).toBe(resetLabel(reset, at + 1, true));

        const weekly = parseClaudeRateLimit({ status: "rejected", rateLimitType: "seven_day" }, at + 2)!;
        const blocked = mergeLimits(merged, weekly.limits, weekly.partial);
        expect(blocked.windows[0]!.resetsAt).toBe(reset);
        expect(blocked.windows[1]!.resetsAt).toBeUndefined();
        expect(blocked.resetsAt).toBeUndefined();
        expect(meterOf(blocked, at + 2)!.resets).toBeUndefined();
    });

    test("a sparse rejection does not carry a reset into the next window", () => {
        const reset = at + 3_600_000;
        const detailed = parseClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour", resetsAt: reset / 1000 }, at)!.limits;
        const sparse = parseClaudeRateLimit({ status: "rejected", rateLimitType: "five_hour" }, reset)!;
        const merged = mergeLimits(detailed, sparse.limits, sparse.partial);
        expect(merged.reached).toBe(true);
        expect(merged.windows[0]!.resetsAt).toBeUndefined();
        expect(merged.resetsAt).toBeUndefined();
    });

    test("99.6% used is 99%, not a reached limit", () => {
        const r = parseClaudeRateLimit({ status: "allowed_warning", rateLimitType: "five_hour", unifiedWindows: { five_hour: { utilization: 0.996, resetsAt: 1792156200 } } }, at)!;
        expect(r.limits.windows[0]).toMatchObject({ usedPercent: 99, reached: undefined });
        expect(meterOf(r.limits, at)!.reached).toBe(false);
        expect(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 99.7 } } }, { at })!.limits.windows[0]).toMatchObject({ usedPercent: 99, reached: undefined });
    });

    test("keeps nothing else, and its strings are bounded and redacted", () => {
        const key = "sk-ant-api03-" + "x".repeat(40);
        const r = parseClaudeRateLimit({ status: "allowed", email: "me@example.com", organizationUuid: "org-1", unifiedWindows: { [`some_${key}_${"y".repeat(80)}`]: { utilization: 0.1 } } }, at)!;
        const json = JSON.stringify(r);
        expect(json).not.toContain("me@example.com");
        expect(json).not.toContain("org-1");
        expect(json).not.toContain(key);
        expect(r.limits.windows[0]!.label.length).toBeLessThanOrEqual(40);
    });
});

describe("Codex's account/rateLimits", () => {
    const at = 1_792_150_000_000;

    test("read (normal, as captured from 0.163.0): the weekly window", () => {
        const r = parseCodexRateLimits(fixture("codex-read.json"), { at })!;
        expect(r).toEqual({ limits: { provider: "codex", accountId: "default", windows: [{ id: "codex:primary", label: "Weekly", usedPercent: 14, resetsAt: 1792652703_000, reached: undefined }], reached: false, resetsAt: undefined, at }, partial: false });
    });

    test("read at the limit: reached, resetting when its window does", () => {
        const r = parseCodexRateLimits(fixture("codex-read-reached.json"), { at })!;
        expect(r.limits.reached).toBe(true);
        expect(r.limits.resetsAt).toBe(1792652703_000);
    });

    test("updated (normal): both windows; reached unknown, as it's sparse", () => {
        const r = parseCodexRateLimits(fixture("codex-update-normal.json"), { update: true, at })!;
        expect(r.partial).toBe(true);
        expect(r.limits.reached).toBeUndefined();
        expect(r.limits.windows.map(windowShape)).toEqual([
            ["5-hour", 62, 1792160400_000],
            ["Weekly", 30, 1792652703_000],
        ]);
    });

    test("updated (reached): the full window's reset", () => {
        const r = parseCodexRateLimits(fixture("codex-update-reached.json"), { update: true, at })!;
        expect(r.limits.reached).toBe(true);
        expect(r.limits.resetsAt).toBe(1792160400_000);
        expect(r.limits.windows[0]!.reached).toBe(true);
    });

    test("both read and update leave the overall reset unknown if any full window has no time", () => {
        for (const update of [false, true]) {
            const r = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1792160400 }, secondary: { usedPercent: 100 } } }, { at, update })!;
            expect(r.limits.reached).toBe(true);
            expect(r.limits.resetsAt).toBeUndefined();
            expect(r.limits.windows[0]!.resetsAt).toBe(1792160400_000);
            expect(r.limits.windows[1]!.resetsAt).toBeUndefined();
        }
    });

    test("sparse merges keep an unknown blocking reset until that window is resolved", () => {
        const known = parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1792160400 } } }, { at })!.limits;
        const unknown = parseCodexRateLimits({ rateLimits: { secondary: { usedPercent: 100 } } }, { update: true, at: at + 1 })!.limits;
        const mixed = mergeLimits(known, unknown, true);
        expect(mixed.reached).toBe(true);
        expect(mixed.resetsAt).toBeUndefined();
        expect(mixed.windows[0]!.resetsAt).toBe(1792160400_000);

        const repeatKnown = { ...known, at: at + 2 };
        expect(mergeLimits(mixed, repeatKnown, true).resetsAt).toBeUndefined();
        const afterReset = mergeLimits(mixed, { provider: "codex", windows: [], at: 1792160400_001 }, true);
        expect(afterReset.reached).toBe(true);
        expect(afterReset.resetsAt).toBeUndefined();

        const resolved = parseCodexRateLimits({ rateLimits: { secondary: { usedPercent: 100, resetsAt: 1792652703 } } }, { update: true, at: at + 3 })!.limits;
        expect(mergeLimits(mixed, resolved, true).resetsAt).toBe(1792652703_000);
        const cleared = parseCodexRateLimits({ rateLimits: { secondary: { usedPercent: 30 } } }, { update: true, at: at + 4 })!.limits;
        expect(mergeLimits(mixed, cleared, true).resetsAt).toBe(1792160400_000);
        const allClear = mergeLimits(afterReset, { ...cleared, at: 1792160400_002 }, true);
        expect(allClear.reached).toBe(false);
        expect(allClear.resetsAt).toBeUndefined();
    });

    test("updated with nothing in it: no windows, and earlier ones still stand", () => {
        const empty = parseCodexRateLimits(fixture("codex-update-missing.json"), { update: true, at: at + 1 })!;
        expect(empty.limits.windows).toEqual([]);
        const read = parseCodexRateLimits(fixture("codex-read.json"), { at })!.limits;
        const merged = mergeLimits(read, empty.limits, empty.partial);
        expect(merged.windows).toEqual(read.windows);
        expect(merged.reached).toBe(false);
        expect(merged.at).toBe(at + 1);
        expect(parseCodexRateLimits({}, { at })).toBeUndefined();
        expect(parseCodexRateLimits({ rateLimits: { primary: { usedPercent: 5 } } }, { at })!.limits.windows).toEqual([{ id: "codex:primary", label: "Primary", usedPercent: 5, resetsAt: undefined, reached: undefined }]);
    });

    test("a full report replaces what was known; a reached limit lifts when a read says so", () => {
        const reached = parseCodexRateLimits(fixture("codex-update-reached.json"), { update: true, at })!;
        const read = parseCodexRateLimits(fixture("codex-read.json"), { at: at + 1 })!;
        expect(mergeLimits(reached.limits, read.limits, read.partial)).toEqual(read.limits);
    });

    test("a sparse update after the reset: no longer reached, though Codex's reached type is null", () => {
        const before = parseCodexRateLimits(fixture("codex-update-reached.json"), { update: true, at })!.limits;
        const after = parseCodexRateLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 1, windowDurationMins: 300, resetsAt: 1792178400 }, rateLimitReachedType: null } }, { update: true, at: 1792160400_000 + 1 })!;
        const m = mergeLimits(before, after.limits, true);
        expect(m.reached).toBe(false);
        expect(m.resetsAt).toBeUndefined();
    });

    test("a sparse update naming one full window keeps the later reset of another", () => {
        const weekly = { id: "codex:secondary", label: "Weekly", usedPercent: 100, resetsAt: at + 4 * 86_400_000, reached: true };
        const prev: PlanLimits = { provider: "codex", windows: [{ id: "codex:primary", label: "5-hour", usedPercent: 40, resetsAt: at + 3_600_000 }, weekly], reached: true, resetsAt: weekly.resetsAt, at };
        const next = parseCodexRateLimits({ rateLimits: { limitId: "codex", primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: Math.round((at + 2 * 3_600_000) / 1000) }, rateLimitReachedType: "rate_limit_reached" } }, { update: true, at: at + 1 })!;
        const m = mergeLimits(prev, next.limits, true);
        expect(m.reached).toBe(true);
        expect(m.resetsAt).toBe(weekly.resetsAt);
    });

    test("a fresh rejection's later reset isn't lost to an earlier full window's", () => {
        const prev: PlanLimits = { provider: "claude-code", windows: [{ id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: at + 3_600_000, reached: true }], reached: true, resetsAt: at + 3_600_000, at };
        const next = parseClaudeRateLimit({ status: "rejected", resetsAt: Math.round((at + 2 * 3_600_000) / 1000) }, at + 1)!;
        expect(next.partial).toBe(true);
        expect(mergeLimits(prev, next.limits, true).resetsAt).toBe(at + 2 * 3_600_000);
    });

    test("reached with no window to show for it stands until its reset", () => {
        const prev: PlanLimits = { provider: "codex", windows: [], reached: true, resetsAt: at + 3_600_000, at };
        const update = { provider: "codex", windows: [], at: at + 1 } as PlanLimits;
        expect(mergeLimits(prev, update, true).reached).toBe(true);
        expect(mergeLimits(prev, { ...update, at: at + 3_600_001 }, true).reached).toBe(false);
    });

    test("keeps no account details", () => {
        const r = parseCodexRateLimits({ ...fixture("codex-read.json"), accountId: "acct-123", rateLimits: { ...fixture("codex-read.json").rateLimits, planType: "pro", credits: { hasCredits: true, unlimited: false, balance: "42" } } }, { at })!;
        expect(JSON.stringify(r)).not.toMatch(/acct-123|"pro"|balance/);
    });

    function windowShape(w: PlanLimits["windows"][number]) {
        return [w.label, w.usedPercent, w.resetsAt];
    }
});

describe("reset times in words", () => {
    const now = new Date(2026, 9, 16, 14, 0).getTime();

    test("today: the time, and how long", () => {
        expect(untilText(now + 125 * 60_000, now)).toBe("2h 5m");
        expect(resetPhrase(now + 125 * 60_000, now)).toMatch(/^at \S.* \(in 2h 5m\)$/);
        expect(resetSentence(now + 125 * 60_000, "Codex", now)).toMatch(/^It resets (?:at|on) .* \(in 2h 5m\)\.$/);
    });

    test("another day: the day too", () => {
        expect(resetPhrase(now + 3 * 86_400_000, now)).toMatch(/^on .*\(in 3d\)$/);
    });

    test("the terminal's /cost lines", () => {
        const l = parseCodexRateLimits(fixture("codex-update-reached.json"), { update: true, at: now })!.limits;
        const lines = limitLines({ ...l, windows: l.windows.map((w, i) => ({ ...w, resetsAt: now + (i ? 3 * 86_400_000 : 125 * 60_000) })) }, now);
        expect(lines[0]).toMatch(/^5-hour 100% reached · resets (?:at|on) .* \(in 2h 5m\)$/);
        expect(lines[1]).toMatch(/^Weekly 41% · resets on .* \(in 3d\)$/);
        expect(limitLines({ provider: "claude-code", windows: [], reached: true, at: now }, now)).toEqual(["Limit reached"]);
    });

    test("no time: says so", () => {
        expect(resetSentence(undefined, "Claude Code", now)).toBe("Claude Code didn't say when it resets.");
    });
});

// ---------------------------------------------------------------------------

let cwd: string;
beforeEach(() => {
    const real = tempDir("limits-proj-");
    cwd = `${real}-link`;
    symlinkSync(real, cwd);
    rmSync(LOG, { force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    process.env.FAKE_LOG = LOG;
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
});

async function runTurn(provider: "claude-code" | "codex") {
    const events: AgentEvent[] = [];
    trust.trustForSession(cwd);
    const settings = {};
    let mode: import("../src/permissions/modes").PermissionMode = "bypassPermissions";
    const agent = new Agent({
        session: Session.create(cwd, { persist: false }),
        model: { provider, id: "default" },
        client: await clientFor(provider),
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { drainQueued: () => [], emit: (e) => events.push(e), ui: {} },
    });
    const reason = await agent.run([{ type: "text", text: "hello" }], { signal: new AbortController().signal });
    const notices = events.flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
    const limits = events.flatMap((e) => (e.type === "limits" ? [e.limits] : []));
    return { reason, notices, limits, limitStop: agent.limitStop };
}

const received = () =>
    readFileSync(LOG, "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
        .flatMap((l) => (l.received ? [l.received] : []));

/** Two hours and five minutes from now (and a little, so the minutes round the same during the turn). */
const soon = () => Date.now() + 125 * 60_000 + 20_000;

describe("a turn that hits the plan's limit says when it resets", () => {
    test("Claude Code: a sparse named rejection retains the same window's reset in the turn error", async () => {
        const reset = Math.round(soon() / 1000);
        const known = join(bin, "claude-named-reset.json");
        const sparse = join(bin, "claude-named-sparse.json");
        writeFileSync(known, JSON.stringify({ status: "rejected", rateLimitType: "five_hour", resetsAt: reset }));
        writeFileSync(sparse, JSON.stringify({ status: "rejected", rateLimitType: "five_hour" }));
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = known;
        process.env.FAKE_RATE_LIMIT_FOLLOWUP = sparse;
        for (const late of ["0", "1"]) {
            process.env.FAKE_RATE_LIMIT_LATE = late;
            const r = await runTurn("claude-code");
            expect(r.reason).toBe("error");
            // An error arriving first also reports the reached account before its window details.
            expect(r.limits).toHaveLength(2 + Number(late === "1"));
            expect(r.notices.find((n) => n.startsWith("error:"))).toContain(resetSentence(reset * 1000, "Claude Code"));
        }
    });

    test("Claude Code: a new blocker without a reset clears a previously known overall time", async () => {
        const short = Math.round(soon() / 1000);
        const known = join(bin, "claude-known-reset.json");
        const unknown = join(bin, "claude-unknown-weekly-reset.json");
        writeFileSync(known, JSON.stringify({ status: "rejected", rateLimitType: "five_hour", resetsAt: short }));
        writeFileSync(unknown, JSON.stringify({ status: "rejected", rateLimitType: "seven_day" }));
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = known;
        process.env.FAKE_RATE_LIMIT_FOLLOWUP = unknown;
        for (const late of ["0", "1"]) {
            process.env.FAKE_RATE_LIMIT_LATE = late;
            const r = await runTurn("claude-code");
            expect(r.reason).toBe("error");
            expect(r.notices.find((n) => n.startsWith("error:"))).toContain("Claude Code didn't say when it resets.");
        }
    });

    test("Codex: mixed known and unknown blocking resets leave the turn's reset unknown", async () => {
        const p = join(bin, "codex-unknown-weekly-reset.json");
        writeFileSync(p, JSON.stringify({ rateLimits: { primary: { usedPercent: 100, resetsAt: Math.round(soon() / 1000) }, secondary: { usedPercent: 100 }, rateLimitReachedType: "rate_limit_reached" } }));
        process.env.FAKE_SCENARIO = "usage-limit";
        process.env.FAKE_LIMIT_UPDATE = p;
        const r = await runTurn("codex");
        expect(r.reason).toBe("error");
        expect(r.notices.find((n) => n.startsWith("error:"))).toContain("Codex didn't say when it resets.");
    });

    test("Claude Code: a partial five-hour rejection keeps the full weekly window's later reset", async () => {
        const short = Math.round(soon() / 1000);
        const weekly = short + 3 * 86_400;
        const detailed = join(bin, "claude-both-reached.json");
        const partial = join(bin, "claude-five-hour-only.json");
        writeFileSync(detailed, JSON.stringify({ status: "rejected", rateLimitType: "five_hour", resetsAt: short, unifiedWindows: { five_hour: { utilization: 1, resetsAt: short }, seven_day: { utilization: 1, resetsAt: weekly } } }));
        writeFileSync(partial, JSON.stringify({ status: "rejected", rateLimitType: "five_hour", resetsAt: short }));
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = detailed;
        process.env.FAKE_RATE_LIMIT_FOLLOWUP = partial;
        for (const late of ["0", "1"]) {
            process.env.FAKE_RATE_LIMIT_LATE = late;
            const r = await runTurn("claude-code");
            expect(r.reason).toBe("error");
            // An error arriving first also reports the reached account before its window details.
            expect(r.limits).toHaveLength(2 + Number(late === "1"));
            expect(r.notices.find((n) => n.startsWith("error:"))).toContain(resetSentence(weekly * 1000, "Claude Code"));
        }
    });

    test("Claude Code: a sparse rejection preserves the detailed rejection's reset", async () => {
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = shifted("claude-rejected.json", soon());
        process.env.FAKE_RATE_LIMIT_SPARSE = "1";
        for (const late of ["0", "1"]) {
            process.env.FAKE_RATE_LIMIT_LATE = late;
            const r = await runTurn("claude-code");
            expect(r.reason).toBe("error");
            // An error arriving first also reports the reached account before its window details.
            expect(r.limits).toHaveLength(2 + Number(late === "1"));
            expect(r.notices.find((n) => n.startsWith("error:"))).toMatch(/It resets (?:at|on) .*\(in 2h 5m\)/);
        }
    });

    test("Codex: a read answered after a newer update cannot overwrite it", async () => {
        process.env.FAKE_SCENARIO = "usage-limit";
        process.env.FAKE_RATE_LIMITS = join(FIX, "codex-update-normal.json");
        process.env.FAKE_RATE_LIMITS_DELAY = "1";
        process.env.FAKE_LIMIT_UPDATE = shifted("codex-update-reached.json", soon());
        const r = await runTurn("codex");
        expect(r.reason).toBe("error");
        expect(received().filter((m) => m.method === "account/rateLimits/read")).toHaveLength(1);
        // No stale event reaches the engine; the local turn also keeps its reset.
        expect(r.limits).toHaveLength(1);
        expect(r.limits[0]!.windows[0]).toMatchObject({ usedPercent: 100, reached: true });
        expect(r.notices.find((n) => n.startsWith("error:"))).toMatch(/It resets (?:at|on) .*\(in 2h 5m\)/);
    });

    test("Claude Code: the time from its rate_limit_event (sent before the error)", async () => {
        const at = soon();
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = shifted("claude-rejected.json", at);
        const r = await runTurn("claude-code");
        expect(r.reason).toBe("error");
        const error = r.notices.find((n) => n.startsWith("error:"))!;
        expect(error).toContain(`Claude Code · Default: usage limit reached. It resets ${resetPhrase(Math.round(at / 1000) * 1000)}.`);
        expect(error).toContain("(in 2h 5m)");
        // The notice as the limit was reached says so too, and the meter hears of it.
        expect(r.notices.some((n) => /^warn: Claude Code · Default: 5-hour usage limit reached\. It resets (?:at|on) .*\(in 2h 5m\)\.$/.test(n))).toBe(true);
        expect(r.limits.at(-1)).toMatchObject({ provider: "claude-code", reached: true });
    });

    test("Claude Code: the time from an event that comes after the error", async () => {
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = shifted("claude-rejected.json", soon());
        process.env.FAKE_RATE_LIMIT_LATE = "1";
        const r = await runTurn("claude-code");
        expect(r.notices.find((n) => n.startsWith("error:"))).toMatch(/It resets (?:at|on) .*\(in 2h 5m\)\. Choose another account/);
    });

    test("Claude Code: no time when it didn't report one", async () => {
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = join(FIX, "claude-missing.json");
        const r = await runTurn("claude-code");
        const error = r.notices.find((n) => n.startsWith("error:"))!;
        expect(error).toContain("Claude Code didn't say when it resets.");
        expect(error).not.toMatch(/resets (?:at|on) /);

        delete process.env.FAKE_RATE_LIMIT;
        const none = await runTurn("claude-code");
        expect(none.notices.find((n) => n.startsWith("error:"))).toContain("Claude Code didn't say when it resets.");
        expect(none.limits).toEqual([{ provider: "claude-code", accountId: "default", windows: [], reached: true, at: expect.any(Number) }]);
    });

    test("Claude Code: a normal turn reports its windows to the meter, with no notice", async () => {
        process.env.FAKE_RATE_LIMIT = join(FIX, "claude-normal.json");
        const r = await runTurn("claude-code");
        expect(r.reason).toBe("done");
        expect(r.limits[0]!.windows.map((w) => [w.label, w.usedPercent])).toEqual([
            ["5-hour", 47],
            ["Weekly", 54],
        ]);
        expect(r.notices.filter((n) => /limit/.test(n))).toEqual([]);
    });

    test("Claude Code: close to a limit is a notice with its reset", async () => {
        process.env.FAKE_RATE_LIMIT = shifted("claude-warning.json", soon());
        const r = await runTurn("claude-code");
        expect(r.notices).toContainEqual(expect.stringMatching(/^info: Claude Code · Default: close to the 5-hour usage limit\. It resets (?:at|on) .*\(in 2h 5m\)\.$/));
    });

    test("Codex: the time from account/rateLimits/updated", async () => {
        process.env.FAKE_SCENARIO = "usage-limit";
        process.env.FAKE_LIMIT_UPDATE = shifted("codex-update-reached.json", soon());
        const r = await runTurn("codex");
        expect(r.reason).toBe("error");
        const error = r.notices.find((n) => n.startsWith("error:"))!;
        expect(error).toMatch(/^error: Codex · Default: usage limit reached\. It resets (?:at|on) .*\(in 2h 5m\)\. Choose another account with \/account or the plan meter, then send again\.$/);
        expect(r.notices).toContainEqual(expect.stringMatching(/^warn: Codex · Default: usage limit reached \(rate limit reached\)\. It resets (?:at|on) .*\(in 2h 5m\)\.$/));
    });

    test("Codex: read from account/rateLimits/read when no update said", async () => {
        process.env.FAKE_SCENARIO = "usage-limit";
        process.env.FAKE_RATE_LIMITS = shifted("codex-read-reached.json", soon());
        const r = await runTurn("codex");
        expect(r.notices.find((n) => n.startsWith("error:"))).toMatch(/It resets (?:at|on) .*\(in 2h 5m\)\. Choose another account/);
        expect(received().filter((m) => m.method === "account/rateLimits/read").length).toBeGreaterThanOrEqual(1);
    });

    test("Codex: no time when it reported none (an older Codex without the read)", async () => {
        process.env.FAKE_SCENARIO = "usage-limit";
        const r = await runTurn("codex");
        const error = r.notices.find((n) => n.startsWith("error:"))!;
        expect(error).toContain("Codex didn't say when it resets.");
        expect(error).not.toMatch(/resets (?:at|on) /);
        // Asked twice (as the turn started, and after it failed): an unknown method fails neither.
        expect(received().filter((m) => m.method === "account/rateLimits/read").length).toBe(2);
    });

    test("Codex: a normal turn on a plan reads the limits as it starts; on an API key it doesn't", async () => {
        process.env.FAKE_RATE_LIMITS = join(FIX, "codex-read.json");
        process.env.FAKE_SCENARIO = "rename";
        const r = await runTurn("codex");
        expect(r.reason).toBe("done");
        expect(r.limits[0]!.windows).toEqual([{ id: "codex:primary", label: "Weekly", usedPercent: 14, resetsAt: 1792652703_000, reached: undefined }]);

        rmSync(LOG, { force: true });
        process.env.FAKE_ACCOUNT = "apikey";
        const key = await runTurn("codex");
        expect(key.limits).toEqual([]);
        expect(received().some((m) => m.method === "account/rateLimits/read")).toBe(false);
    });
});

describe("limit notices aren't repeated", () => {
    const close = (n: string[]) => n.filter((x) => x.includes("Claude Code · Default: close to the")).length;
    const reached = (n: string[]) => n.filter((x) => /^warn: .*usage limit reached/.test(x)).length;

    test("Claude Code's warning: once per window and reset, again when its status or reset changes", async () => {
        const at = soon();
        process.env.FAKE_RATE_LIMIT_REPEAT = "6";
        process.env.FAKE_RATE_LIMIT = shifted("claude-warning.json", at);
        // One per request in a turn: said once.
        const first = await runTurn("claude-code");
        expect(close(first.notices)).toBe(1);
        expect(first.limits.length).toBe(6); // the meter still hears each
        // The next turn, nothing changed: not again.
        expect(close((await runTurn("claude-code")).notices)).toBe(0);
        // Fine again, then close again (same reset): said again.
        process.env.FAKE_RATE_LIMIT = shifted("claude-normal.json", at);
        expect(close((await runTurn("claude-code")).notices)).toBe(0);
        process.env.FAKE_RATE_LIMIT = shifted("claude-warning.json", at);
        expect(close((await runTurn("claude-code")).notices)).toBe(1);
        // The window reset (a new reset time): said again.
        process.env.FAKE_RATE_LIMIT = shifted("claude-warning.json", at + 5 * 3_600_000);
        expect(close((await runTurn("claude-code")).notices)).toBe(1);
    }, 15_000);

    test("Claude Code's limit reached: once per turn, and the error still says when", async () => {
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT_REPEAT = "4";
        process.env.FAKE_RATE_LIMIT = shifted("claude-rejected.json", soon());
        for (let turn = 0; turn < 2; turn++) {
            const r = await runTurn("claude-code");
            expect(reached(r.notices)).toBe(1);
            expect(r.notices.find((n) => n.startsWith("error:"))).toMatch(/It resets (?:at|on) .*\(in 2h 5m\)/);
        }
    });

    test("Codex's limit reached: once per turn however many updates say so", async () => {
        process.env.FAKE_SCENARIO = "usage-limit";
        process.env.FAKE_LIMIT_REPEAT = "4";
        process.env.FAKE_LIMIT_UPDATE = shifted("codex-update-reached.json", soon());
        const r = await runTurn("codex");
        expect(reached(r.notices)).toBe(1);
        expect(r.limits.length).toBeGreaterThanOrEqual(4);
    });

    test("limitNews: by window, status and reset", () => {
        const seen = new Map<string, string>();
        expect(limitNews(seen, "five_hour", "allowed_warning", 1)).toBe(true);
        expect(limitNews(seen, "five_hour", "allowed_warning", 1)).toBe(false);
        expect(limitNews(seen, "seven_day", "allowed_warning", 1)).toBe(true);
        expect(limitNews(seen, "five_hour", "allowed_warning", 2)).toBe(true);
        expect(limitNews(seen, "five_hour", "allowed", 2)).toBe(true);
        expect(limitNews(seen, "five_hour", "allowed_warning", 2)).toBe(true);
        for (let i = 0; i < 100; i++) limitNews(seen, `w${i}`, "allowed", 1);
        expect(seen.size).toBeLessThanOrEqual(50);
    });
});

// ---------------------------------------------------------------------------

describe("usage over 24h, 7d and 30d", () => {
    const H = 3_600_000;
    const D = 24 * H;
    const now = Date.now();
    const dir = join(iso.home, "projects", "Users-me-app");

    function session(name: string, lines: object[], mtime: number) {
        mkdirSync(dir, { recursive: true });
        const file = join(dir, `${name}.jsonl`);
        const meta = { t: "meta", id: name, cwd: "/Users/me/app", createdAt: now - 40 * D, version: "1" };
        writeFileSync(file, [meta, { t: "msg", m: { role: "user", content: "hi" } }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
        utimesSync(file, mtime / 1000, mtime / 1000);
        return file;
    }
    const u = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, extra: object = {}) => ({ inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: 0, ...extra });

    beforeEach(() => {
        rmSync(join(iso.home, "projects"), { recursive: true, force: true });
        clearUsageCache();
        Object.assign(usageBounds, { maxFiles: 5000, maxBytes: 512 * 1024 * 1024, maxMs: 4000 });
        // s1: today. Sonnet 4.5 ($3 / $15 / $0.30 cache read per 1M); Vertex with no price (marked
        // unknown); Claude Code on a plan (Opus 5.5: $4 / $20 / $0.20); a custom model saved as $0
        // before unpriced usage was marked.
        session("s1", [
            { t: "usage", usage: u(100_000, 10_000, 200_000), cost: 0.51, model: "anthropic:claude-sonnet-4-5", at: now - 1 * H },
            { t: "usage", usage: u(50_000, 5_000), cost: 0, model: "vertex:google/gemini-3.5-flash", unknown: true, at: now - 2 * H },
            { t: "usage", usage: u(10_000, 2_000, 1_000_000, { cost: 0 }), cost: 0, model: "claude-code:claude-opus-5-5", at: now - 3 * H },
            { t: "usage", usage: u(1_000, 100), cost: 0, model: "custom:foo", at: now - 1 * H },
        ], now - 1 * H);
        // s2: an undated record (dated by the next one), then Codex on a plan two days ago
        // (GPT-6 Astra: $10 / $50 / $1 cache read).
        session("s2", [
            { t: "usage", usage: u(50_000, 0), cost: 0.15, model: "anthropic:claude-sonnet-4-5" },
            { t: "usage", usage: u(20_000, 1_000, 100_000, { cost: 0 }), cost: 0, model: "codex:gpt-6-astra", at: now - 2 * D },
        ], now - 2 * D);
        // s4: an old file, undated: placed at its last write, three days ago.
        session("s4", [{ t: "usage", usage: u(10_000, 0), cost: 0.03, model: "anthropic:claude-sonnet-4-5" }], now - 3 * D);
        // s3: ten days ago, and a record from before the month.
        session("s3", [
            { t: "usage", usage: u(1_000, 0), cost: 1, model: "anthropic:claude-sonnet-4-5", at: now - 40 * D },
            { t: "usage", usage: u(2_000, 0), cost: 1, model: "anthropic:claude-sonnet-4-5", at: now - 10 * D },
        ], now - 10 * D);
        // Not a session file, and a torn line.
        writeFileSync(join(dir, "s9.jsonl.lock"), "x");
        writeFileSync(join(dir, "s5.jsonl"), '{"t":"usage","usage":{"inputTokens":5');
    });

    const row = (s: Awaited<ReturnType<typeof usageSummary>>, model: string) => s.rows.find((r) => `${r.provider}:${r.model}` === model)!;
    const cents = (n: number) => Math.round(n * 100) / 100;

    test("24 hours", async () => {
        const s = await usageSummary(1, now);
        expect(s.rows.length).toBe(3);
        expect(row(s, "anthropic:claude-sonnet-4-5")).toMatchObject({ providerName: "Anthropic API", sessions: 1, inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 200_000, cost: 0.51, unknown: false, plan: false });
        // Unpriced: unknown, never $0, whether marked or not.
        expect(row(s, "vertex:google/gemini-3.5-flash")).toMatchObject({ cost: 0, unknown: true });
        expect(row(s, "custom:foo")).toMatchObject({ cost: 0, unknown: true });
        // CLI records here are deliberately ignored: only native transcripts count.
        expect(row(s, "claude-code:claude-opus-5-5")).toBeUndefined();
        expect(cents(s.totals.cost)).toBe(0.51);
        expect(s.totals).toMatchObject({ inputTokens: 151_000, outputTokens: 15_100, cacheReadTokens: 200_000, unknown: true });
        expect(s.sessions).toBe(1);
        expect(s.approxDated).toBe(0);
        expect(costText(row(s, "custom:foo"))).toBe("unknown");
        expect(costText(s.totals)).toBe("$0.51 + unknown");
    });

    test("7 days: undated records at the next dated one's time, or the file's last write", async () => {
        const s = await usageSummary(7, now);
        const sonnet = row(s, "anthropic:claude-sonnet-4-5");
        expect(sonnet).toMatchObject({ sessions: 3, inputTokens: 160_000, outputTokens: 10_000 });
        expect(cents(sonnet.cost)).toBe(0.69); // 0.51 + 0.15 + 0.03
        expect(row(s, "codex:gpt-6-astra")).toBeUndefined();
        expect(cents(s.totals.cost)).toBe(0.69);
        expect(cents(s.totals.planEquivalent)).toBe(0);
        expect(s.sessions).toBe(3);
        expect(s.approxDated).toBe(2);
    });

    test("30 days", async () => {
        const s = await usageSummary(30, now);
        expect(row(s, "anthropic:claude-sonnet-4-5")).toMatchObject({ sessions: 4, inputTokens: 162_000 });
        expect(cents(s.totals.cost)).toBe(1.69);
        expect(s.sessions).toBe(4);
        expect(s.truncated).toBeUndefined();
    });

    test("cached by mtime: a write is read again", async () => {
        expect(cents((await usageSummary(1, now)).totals.cost)).toBe(0.51);
        const file = join(dir, "s1.jsonl");
        writeFileSync(file, readFileSync(file, "utf-8") + JSON.stringify({ t: "usage", usage: u(1, 1), cost: 1, model: "anthropic:claude-sonnet-4-5", at: now - H }) + "\n");
        utimesSync(file, (now - H + 1000) / 1000, (now - H + 1000) / 1000);
        expect(cents((await usageSummary(1, now)).totals.cost)).toBe(1.51);
    });

    test("bounded: past the bounds it says what it left out", async () => {
        usageBounds.maxFiles = 2;
        const s = await usageSummary(30, now);
        expect(s.truncated).toContain("2 transcript files");
        // Directory iteration order is not a recency guarantee. Both discovery
        // and reading are bounded; any partial subset must be labelled.
        expect(s.sessions).toBeLessThanOrEqual(2);
        expect(cents(s.totals.cost)).toBeLessThanOrEqual(1.69);
        clearUsageCache();
        usageBounds.maxFiles = 5000;
        usageBounds.maxBytes = 10;
        expect((await usageSummary(30, now)).truncated).toMatch(/too much to read/);
    });

    test("legacy folded CLI records cannot double count native usage", async () => {
        session("s6", [
            { t: "usage", usage: u(1_000, 100), cost: 8, model: "claude-code:claude-opus-5-5", at: now - H },
            { t: "usage", usage: u(10_000, 2_000, 1_000_000), cost: 0, model: "codex:gpt-6-astra", at: now - H },
        ], now - H);
        const s = await usageSummary(1, now);
        expect(row(s, "claude-code:claude-opus-5-5")).toBeUndefined();
        expect(row(s, "codex:gpt-6-astra")).toBeUndefined();
        expect(cents(s.totals.cost)).toBe(0.51);
        expect(s.totals.planEquivalent).toBe(0);
    });

    test("out of time: says so, and the view doesn't call it no usage", async () => {
        usageBounds.maxMs = -1;
        const s = await usageSummary(30, now);
        expect(s.truncated).toMatch(/took too long/);
        expect(s.rows).toEqual([]);
        expect(emptyText(s)).toBe("Nothing read yet: Reading the sessions took too long; earlier ones are left out.");
        expect(emptyText({ days: 7 })).toBe("No usage in the last 7 days.");
    });

    test("only the offered ranges", () => {
        expect(usageDays(7)).toBe(7);
        for (const bad of [3, "7", 0, -1, 365, undefined, null]) expect(() => usageDays(bad)).toThrow("days must be one of 1, 7, 30, 90");
    });
});

// ---------------------------------------------------------------------------

describe("the plan meter", () => {
    const now = new Date(2026, 9, 16, 14, 0).getTime();
    const limits = (o: Partial<PlanLimits> = {}): PlanLimits => ({
        provider: "codex",
        windows: [
            { id: "codex:primary", label: "5-hour", usedPercent: 62, resetsAt: now + 160 * 60_000 },
            { id: "codex:secondary", label: "Weekly", usedPercent: 30, resetsAt: now + 4 * 86_400_000 },
        ],
        at: now - 60_000,
        ...o,
    });

    test("hidden when nothing is known", () => {
        expect(meterOf(undefined, now)).toBeUndefined();
        expect(meterOf(limits({ windows: [] }), now)).toBeUndefined();
    });

    test("each window: percentage and when it resets", () => {
        const m = meterOf(limits(), now)!;
        expect(m.reached).toBe(false);
        expect(m.asOf).toBeUndefined();
        expect(m.top).toBe(62);
        expect(windowLine(m.windows[0]!)).toBe(`5-hour 62% · resets ${resetLabel(now + 160 * 60_000, now)}`);
        expect(m.windows[1]!.resets).toBe(new Date(now + 4 * 86_400_000).toLocaleDateString(undefined, { weekday: "short" }));
    });

    test("stale: as of when it was reported", () => {
        expect(meterOf(limits({ at: now - 20 * 60_000 }), now)!.asOf).toMatch(/^as of /);
    });

    test("a full window keeps the meter reached beyond an earlier overall reset", () => {
        const short = now + 60_000;
        const weekly = now + 4 * 86_400_000;
        const l = limits({ reached: true, resetsAt: short, windows: [
            { id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: short, reached: true },
            { id: "seven_day", label: "Weekly", usedPercent: 100, resetsAt: weekly, reached: true },
        ] });
        const m = meterOf(l, short + 1)!;
        expect(m.reached).toBe(true);
        expect(m.windows.map((w) => w.reached)).toEqual([false, true]);
        expect(m.resets).toBe(resetLabel(weekly, short + 1, true));
        expect(meterOf(l, weekly + 1)!.reached).toBe(false);
    });

    test("an unknown blocking reset suppresses the overall time but keeps each window's time", () => {
        const short = now + 160 * 60_000;
        const l = limits({ reached: true, resetsAt: short, windows: [
            { id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: short, reached: true },
            { id: "seven_day", label: "Weekly", usedPercent: 100, reached: true },
        ] });
        for (const when of [now, short + 1]) {
            const m = meterOf(l, when)!;
            expect(m.reached).toBe(true);
            expect(m.resets).toBeUndefined();
            expect(m.windows[0]!.resets).toBeDefined();
            expect(m.windows[1]!.resets).toBeUndefined();
            expect(m.windows[1]!.reached).toBe(true);
        }
    });

    test("reached: red, with the reset time and how long", () => {
        const at = now + 160 * 60_000;
        const m = meterOf(limits({ reached: true, resetsAt: at, windows: [{ id: "codex:primary", label: "5-hour", usedPercent: 100, resetsAt: at, reached: true }] }), now)!;
        expect(m.reached).toBe(true);
        expect(m.resets).toMatch(/, in 2h 40m$/);
        // Once that time has passed, it isn't shown as reached any more (and the numbers are stale).
        const later = meterOf(limits({ reached: true, resetsAt: at, windows: [{ id: "codex:primary", label: "5-hour", usedPercent: 100, resetsAt: at, reached: true }] }), at + 1)!;
        expect(later.reached).toBe(false);
        expect(later.asOf).toBeDefined();
    });
});

describe("slash commands", () => {
    test("the GUI's own: /cost and /context open what they show, the others as before", () => {
        expect(clientAction("/cost")).toEqual({ action: "usage", args: "" });
        expect(clientAction("/context")?.action).toBe("context");
        expect(clientAction("/model")?.action).toBe("model");
        expect(clientAction("/fork")).toEqual({ action: "fork", args: "" });
        expect(clientAction("  /FoRk  ")).toEqual({ action: "fork", args: "" });
        expect(clientAction("//fork")).toBeUndefined();
        expect(clientAction("/rename My title")).toEqual({ action: "rename", args: "My title" });
        expect(clientAction("/tasks stop task-1")).toEqual({ action: "tasks", args: "stop task-1" });
        expect(clientAction("/clear")?.action).toBe("new");
        expect(clientAction("/nonsense")).toBeUndefined();
        expect(clientAction("/review 12")).toBeUndefined();
    });

    test("a path or // is a message, not a command", () => {
        for (const t of ["/Users/me/app.ts fails to build", "/tmp/x is full", "/README.md", "//cost", "hello /cost"]) {
            expect(slashName(t)).toBeUndefined();
            expect(slashCommand(t)).toBeUndefined();
        }
        expect(slashName("  /Review 12")).toBe("review");
        expect(slashCommand("/review 12")).toEqual({ name: "review", args: "12" });
        expect(slashCommand("/git:pr")).toEqual({ name: "git:pr", args: "" });
    });
});

describe("/context", () => {
    test("shows the card even before the window's size is known (Claude Code, before its first result)", () => {
        const fresh = { contextTokens: 0, model: { providerName: "Claude Code" } };
        // Nothing drawn until asked for, then the ring and a card that says why there's no number.
        expect(contextView(fresh, false).ring).toBe(false);
        expect(contextView(fresh, true)).toEqual({ ring: true, line: "Not known yet: Claude Code reports the window's size after its first reply." });
        expect(contextView({ contextTokens: 50_000, model: { contextWindow: 200_000 } }, false)).toEqual({ ring: true, pct: 0.25, line: "50k of 200k tokens" });
        expect(contextView(undefined, true).ring).toBe(false);
    });
});

describe("Claude Code's listed commands", () => {
    test("names only, bounded and checked", () => {
        expect(cliCommandNames(["code-review", "/Simplify", "design:ux-copy", "__remote-workflow", "bad name", "x".repeat(101), 3, "../etc"])).toEqual(["code-review", "simplify", "design:ux-copy", "__remote-workflow"]);
        expect(cliCommandNames(undefined)).toBeUndefined();
    });
});

describe("a turn stopped by the limit tells the host, so it can resume after the reset", () => {
    test("Claude Code: with the reset time", async () => {
        const at = soon();
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = shifted("claude-rejected.json", at);
        const r = await runTurn("claude-code");
        expect(r.limitStop?.resetsAt).toBe(Math.round(at / 1000) * 1000);
    });

    test("Claude Code: without one", async () => {
        process.env.FAKE_SCENARIO = "rate-limit";
        process.env.FAKE_RATE_LIMIT = join(FIX, "claude-missing.json");
        const r = await runTurn("claude-code");
        expect(r.limitStop).toEqual({ resetsAt: undefined });
    });

    test("Codex: with the reset time", async () => {
        process.env.FAKE_SCENARIO = "usage-limit";
        process.env.FAKE_LIMIT_UPDATE = shifted("codex-update-reached.json", soon());
        const r = await runTurn("codex");
        expect(r.limitStop?.resetsAt).toBeGreaterThan(Date.now() + 2 * 3_600_000);
    });

    test("a normal turn: nothing", async () => {
        process.env.FAKE_RATE_LIMIT = join(FIX, "claude-normal.json");
        const r = await runTurn("claude-code");
        expect(r.reason).toBe("done");
        expect(r.limitStop).toBeUndefined();
    });
});
