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
const limits = (provider: string, at: number, windows: PlanLimits["windows"], extra: Partial<PlanLimits> = {}): PlanLimits => ({ provider, at, windows, ...extra });
const key = (provider: string, account = "default") => JSON.stringify([provider, account]);

test("the footer shows the connection until a plan reports its limits", () => {
    expect(railFoot({ conn: "open", limits: {}, providers: [], now: NOW })).toEqual({ tone: "normal", name: "This computer", line: "Connected" });
    expect(railFoot({ conn: "reconnecting", limits: {}, providers: [], now: NOW }).line).toBe("Reconnecting…");
    // A report with nothing in it says nothing either.
    expect(railFoot({ conn: "open", limits: { [key("codex")]: limits("codex", NOW, []) }, providers: [codex], now: NOW }).pct).toBeUndefined();
});

test("the footer names the plan and its fullest window, preferring the session in view's own", () => {
    const all = {
        [key("claude-code")]: limits("claude-code", NOW - 5000, [{ id: "five_hour", label: "5-hour", usedPercent: 62 }, { id: "seven_day", label: "Weekly", usedPercent: 30 }]),
        [key("codex")]: limits("codex", NOW, [{ id: "codex:primary", label: "Weekly", usedPercent: 74 }]),
    };
    // No session in view: the latest report.
    expect(railFoot({ conn: "open", limits: all, providers: [claude, codex], now: NOW })).toEqual({ provider: "codex", pct: 74, tone: "warn", name: "ChatGPT plan", line: "74% of the weekly limit" });
    // The session in view is on Claude Code: its plan, by the account's plan name.
    expect(railFoot({ conn: "open", limits: all, providers: [claude, codex], provider: "claude-code", now: NOW })).toEqual({ provider: "claude-code", pct: 62, tone: "normal", name: "Claude Code Max", line: "62% of the 5-hour limit" });
    // On a provider with no report: the latest one still shows.
    expect(railFoot({ conn: "open", limits: all, providers: [claude, codex], provider: "anthropic", now: NOW }).provider).toBe("codex");
});

test("a reached limit fills the ring and says when it resets", () => {
    const all = { [key("codex")]: limits("codex", NOW, [{ id: "codex:primary", label: "5-hour", usedPercent: 100, resetsAt: NOW + 2 * 3_600_000 }]) };
    const foot = railFoot({ conn: "open", limits: all, providers: [codex], now: NOW });
    expect(foot.pct).toBe(100);
    expect(foot.tone).toBe("danger");
    expect(foot.line).toMatch(/^Limit reached, resets .+, in 2h$/);
    expect(railFoot({ conn: "reconnecting", limits: all, providers: [codex], now: NOW }).line).toBe("Reconnecting…");
});
