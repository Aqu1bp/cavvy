// The session rail's decisions, as plain functions: a row's glyph, the counts
// on its group headings, and the plan line in its footer.
import { expect, test } from "bun:test";
import type { PlanLimits, ProviderInfo } from "../src/server/protocol";

const { groupCounts, railFoot, railGlyph } = await import("../gui/src/lib/rail");

test("a row's glyph: working, needs you, stopped, finished unseen, quiet, new", () => {
    expect(railGlyph({ status: "running", messages: 3 }, true)).toBe("running");
    expect(railGlyph({ status: "waiting", messages: 3 }, true)).toBe("waiting");
    expect(railGlyph({ status: "error", messages: 3 }, true)).toBe("error");
    expect(railGlyph({ status: "idle", messages: 3 }, true)).toBe("done");
    expect(railGlyph({ status: "idle", messages: 3 }, false)).toBe("idle");
    expect(railGlyph({ status: "idle", messages: 0 }, false)).toBe("new");
});

test("a project heading counts the sessions under it, runs by their members, and stops at the next heading", () => {
    const counts = groupCounts([
        { key: "project:/a", kind: "project", cwd: "/a", name: "a" },
        { key: "1", kind: "card", id: "1" },
        { key: "run:cards:r", kind: "run", ids: ["2", "3", "4"], row: false },
        { key: "project:/b", kind: "project", cwd: "/b", name: "b" },
        { key: "5", kind: "card", id: "5" },
        { key: "more:cards", kind: "more", page: "cards", remaining: 4 },
        { key: "heading:settled", kind: "settled" },
        { key: "6", kind: "row", id: "6" },
    ]);
    expect([...counts]).toEqual([["project:/a", 4], ["project:/b", 1]]);
    // Listed by date there are no headings to count for.
    expect(groupCounts([{ key: "1", kind: "card", id: "1" }]).size).toBe(0);
});

const NOW = 1_000_000_000;
const claude: ProviderInfo = {
    id: "claude-code", name: "Claude Code", kind: "agent", configured: true, requiresKey: false,
    agentCli: { installed: true, signIn: "claude", install: "", plan: "Claude subscription", defaultAccount: "default", accounts: [{ id: "default", name: "Default", folder: "", managed: false, plan: "max" }] },
};
const codex: ProviderInfo = { id: "codex", name: "Codex", kind: "agent", configured: true, requiresKey: false, agentCli: { installed: true, signIn: "codex", install: "", plan: "ChatGPT plan" } };
const anthropic: ProviderInfo = { id: "anthropic", name: "Anthropic", kind: "anthropic", configured: true, requiresKey: true, source: "keychain" };
const limits = (provider: string, at: number, windows: PlanLimits["windows"], extra: Partial<PlanLimits> = {}): PlanLimits => ({ provider, at, windows, ...extra });
const key = (provider: string, account = "default") => JSON.stringify([provider, account]);
const withAccount = (p: ProviderInfo, account: Partial<NonNullable<NonNullable<ProviderInfo["agentCli"]>["accounts"]>[number]>): ProviderInfo =>
    ({ ...p, agentCli: { ...p.agentCli!, accounts: [{ id: "default", name: "Default", folder: "", managed: false, ...account }] } });
const lines = (plans: { provider: string; line: string }[]) => plans.map((p) => [p.provider, p.line]);

test("the footer shows plans only: never the computer or the connection, never an API provider", () => {
    // Nothing signed in to a plan: no footer but Settings.
    expect(railFoot({ limits: {}, providers: [], now: NOW })).toEqual([]);
    expect(railFoot({ limits: {}, providers: [anthropic], provider: "anthropic", now: NOW })).toEqual([]);
    const foot = railFoot({ limits: {}, providers: [anthropic, claude], provider: "anthropic", now: NOW });
    expect(foot.map((p) => p.provider)).toEqual(["claude-code"]);
    expect(JSON.stringify(foot)).not.toMatch(/This computer|Connected|Reconnecting/);
});

test("a plan that hasn't reported yet shows its name and an empty ring", () => {
    const [plan] = railFoot({ limits: {}, providers: [claude], now: NOW });
    expect(plan).toMatchObject({ provider: "claude-code", name: "Claude Code Max", tone: "normal", line: "Usage shows after a turn", stale: false });
    expect(plan!.pct).toBeUndefined();
    // A report with nothing in it says nothing either.
    const [empty] = railFoot({ limits: { [key("codex")]: limits("codex", NOW, []) }, providers: [codex], now: NOW });
    expect(empty).toMatchObject({ name: "ChatGPT plan", line: "Usage shows after a turn" });
    expect(empty!.pct).toBeUndefined();
});

test("only CLIs turned on, installed and signed in to a plan count", () => {
    const off = { ...codex, configured: false };
    const missing = { ...codex, agentCli: { ...codex.agentCli!, installed: false } };
    const out = withAccount(codex, { signedIn: false });
    const keyed = withAccount(claude, { signedIn: true, apiKey: true });
    const reported = { [key("codex")]: limits("codex", NOW, [{ id: "codex:primary", label: "Weekly", usedPercent: 74 }]) };
    for (const p of [off, missing, out, keyed]) expect(railFoot({ limits: reported, providers: [p], now: NOW })).toEqual([]);
    // Not checked yet (signedIn unknown) but turned on: shown.
    expect(railFoot({ limits: reported, providers: [codex], now: NOW }).map((p) => p.pct)).toEqual([74]);
});

test("both signed in: the session in view's plan first, else the one used last, else the latest report", () => {
    const all = {
        [key("claude-code")]: limits("claude-code", NOW - 5000, [{ id: "five_hour", label: "5-hour", usedPercent: 62 }, { id: "seven_day", label: "Weekly", usedPercent: 30 }]),
        [key("codex")]: limits("codex", NOW, [{ id: "codex:primary", label: "Weekly", usedPercent: 74 }]),
    };
    const providers = [claude, codex];
    // No session in view and no sessions: the latest report first.
    expect(railFoot({ limits: all, providers, now: NOW })).toEqual([
        { provider: "codex", name: "ChatGPT plan", pct: 74, tone: "warn", line: "74% of the weekly limit", brief: "74% of the weekly limit", stale: false, detail: "ChatGPT plan\nWeekly 74%" },
        { provider: "claude-code", name: "Claude Code Max", pct: 62, tone: "normal", line: "62% of the 5-hour limit", brief: "62% of the 5-hour limit", stale: false, detail: "Claude Code Max\n5-hour 62%\nWeekly 30%" },
    ]);
    // The plan used last leads.
    expect(railFoot({ limits: all, providers, recent: ["anthropic", "claude-code", "codex"], now: NOW }).map((p) => p.provider)).toEqual(["claude-code", "codex"]);
    // The session in view's plan leads, whatever was used last.
    expect(railFoot({ limits: all, providers, provider: "codex", recent: ["claude-code"], now: NOW }).map((p) => p.provider)).toEqual(["codex", "claude-code"]);
    // On an API provider: as with no session.
    expect(railFoot({ limits: all, providers, provider: "anthropic", recent: ["claude-code"], now: NOW }).map((p) => p.provider)).toEqual(["claude-code", "codex"]);
});

test("the session in view's account is the one shown, named when there are several", () => {
    const two: ProviderInfo = { ...codex, agentCli: { ...codex.agentCli!, accounts: [{ id: "default", name: "Default", folder: "", managed: false, plan: "plus" }, { id: "work", name: "Work", folder: "", managed: true, plan: "pro", email: "me@work.example" }] } };
    const all = {
        [key("codex")]: limits("codex", NOW, [{ id: "codex:primary", label: "Weekly", usedPercent: 10 }]),
        [key("codex", "work")]: limits("codex", NOW, [{ id: "codex:primary", label: "Weekly", usedPercent: 55 }]),
    };
    expect(railFoot({ limits: all, providers: [two], now: NOW })[0]).toMatchObject({ name: "Codex Plus", pct: 10 });
    const [work] = railFoot({ limits: all, providers: [two], provider: "codex", account: "work", now: NOW });
    expect(work).toMatchObject({ name: "Codex Pro", pct: 55 });
    expect(work!.detail.split("\n")[0]).toBe("Codex Pro (Work, me@work.example)");
});

test("a reached limit fills the ring and says when it resets", () => {
    const all = { [key("codex")]: limits("codex", NOW, [{ id: "codex:primary", label: "5-hour", usedPercent: 100, resetsAt: NOW + 2 * 3_600_000 }]) };
    const [foot] = railFoot({ limits: all, providers: [codex], now: NOW });
    expect(foot!.pct).toBe(100);
    expect(foot!.tone).toBe("danger");
    expect(foot!.line).toMatch(/^Reached, resets \d{1,2}:\d{2}/);
    expect(foot!.line).not.toContain(", in ");
    expect(foot!.detail).toMatch(/resets .+, in 2h$/);
    // A day away: just the day.
    const later = { [key("codex")]: limits("codex", NOW, [{ id: "codex:secondary", label: "Weekly", usedPercent: 100, resetsAt: NOW + 3 * 86_400_000 }]) };
    expect(railFoot({ limits: later, providers: [codex], now: NOW })[0]!.line).toMatch(/^Reached, resets [A-Za-z]+\.?$/);
});

test("limits saved before a restart show with their age; a window that has reset since shows nothing as current", () => {
    // Saved 6h ago: 100% of the 5-hour window (reset since), 40% of the weekly one (still running).
    const at = NOW - 6 * 3_600_000;
    const all = { [key("codex")]: limits("codex", at, [
        { id: "codex:primary", label: "5-hour", usedPercent: 100, resetsAt: NOW - 3_600_000 },
        { id: "codex:secondary", label: "Weekly", usedPercent: 40, resetsAt: NOW + 3 * 86_400_000 },
    ]) };
    const [foot] = railFoot({ limits: all, providers: [codex], now: NOW });
    expect(foot!.pct).toBe(40);
    expect(foot!.tone).toBe("normal");
    // Today's report by its time, an earlier day's by the day.
    expect(foot!.line).toMatch(/^Weekly 40% as of (\d{1,2}:\d{2}|[A-Za-z]+\.?$)/);
    expect(foot!.detail).toMatch(/\nAs of /);
    // Beside another plan's, the row has no room for the age: the ring shows it's old, the tooltip when.
    expect(foot!.brief).toBe("40% of the weekly limit");
    expect(foot!.stale).toBe(true);
    // Only old: an hour ago, nothing reset since.
    const [hour] = railFoot({ limits: { [key("claude-code")]: limits("claude-code", NOW - 3_600_000, [{ id: "five_hour", label: "5-hour", usedPercent: 64, resetsAt: NOW + 3_600_000 }]) }, providers: [claude], now: NOW });
    expect(hour!.line).toMatch(/^5-hour 64% as of \d{1,2}:\d{2}/);
    expect(hour!.pct).toBe(64);
    // With every window reset, there's no figure to show.
    const gone = { [key("codex")]: limits("codex", at, [{ id: "codex:primary", label: "5-hour", usedPercent: 100, resetsAt: NOW - 3_600_000 }]) };
    const [old] = railFoot({ limits: gone, providers: [codex], now: NOW });
    expect(old!.pct).toBeUndefined();
    expect(old!.line).toMatch(/^Reset since (\d{1,2}:\d{2}|[A-Za-z]+\.?$)/);
});
