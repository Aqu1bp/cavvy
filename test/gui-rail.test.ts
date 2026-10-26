// The session rail's decisions, as plain functions: a row's glyph, the counts
// on its group headings, the sessions that need you, and the plan chips in its
// footer (their tint, how they fit, and the usage card's windows).
import { expect, test } from "bun:test";
import type { PlanLimits, ProviderInfo, SessionSummary } from "../src/server/protocol";

const { asking, foldOrder, groupCounts, inFront, needsLine, needsPlace, needsRowLine, needsYou, planFit, planTone, railFoot, railGlyph } = await import("../gui/src/lib/rail");

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
        { provider: "codex", name: "ChatGPT plan", pct: 74, tone: "normal", reached: false, window: "Weekly", line: "74% of the weekly limit", brief: "74% of the weekly limit", stale: false, detail: "ChatGPT plan\nWeekly 74%",
            windows: [{ label: "Weekly", pct: 74, tone: "normal", reached: false }] },
        { provider: "claude-code", name: "Claude Code Max", pct: 62, tone: "normal", reached: false, window: "5-hour", line: "62% of the 5-hour limit", brief: "62% of the 5-hour limit", stale: false, detail: "Claude Code Max\n5-hour 62%\nWeekly 30%",
            windows: [{ label: "5-hour", pct: 62, tone: "normal", reached: false }, { label: "Weekly", pct: 30, tone: "normal", reached: false }] },
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
    // The card has the window, with nothing current to show for it.
    expect(old!.windows).toEqual([{ label: "5-hour", tone: "normal", reached: false, resets: "Reset" }]);
});

test("a chip's tint: amber from 75%, red from 90% and at a limit", () => {
    expect([0, 74, 75, 89, 90, 100].map((p) => planTone(p))).toEqual(["normal", "normal", "warn", "warn", "danger", "danger"]);
    expect(planTone(undefined)).toBe("normal");
    expect(planTone(40, true)).toBe("danger");
    const at = (usedPercent: number) => railFoot({ limits: { [key("codex")]: limits("codex", NOW, [{ id: "codex:primary", label: "5-hour", usedPercent }]) }, providers: [codex], now: NOW })[0]!;
    expect([at(74).tone, at(75).tone, at(90).tone]).toEqual(["normal", "warn", "danger"]);
});

test("the usage card has each window: its share, tint and reset; a reached one is full and says when it lifts", () => {
    const all = { [key("claude-code")]: limits("claude-code", NOW, [
        { id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: NOW + 2 * 3_600_000 },
        { id: "seven_day", label: "Weekly", usedPercent: 80, resetsAt: NOW + 3 * 86_400_000 },
    ]) };
    const [plan] = railFoot({ limits: all, providers: [claude], now: NOW });
    expect(plan).toMatchObject({ pct: 100, tone: "danger", reached: true });
    // At the limit the chip says when it lifts, not which window: "100% · resets 4:40 PM".
    expect(plan!.window).toBeUndefined();
    expect(plan!.lifts).toMatch(/^\d{1,2}:\d{2}/);
    const [five, week] = plan!.windows;
    expect(five).toMatchObject({ label: "5-hour", pct: 100, tone: "danger", reached: true });
    // Short enough for its column: no ", in 2h".
    expect(five!.resets).toMatch(/^\d{1,2}:\d{2}/);
    expect(five!.resets).not.toContain(", in ");
    expect(week).toMatchObject({ label: "Weekly", pct: 80, tone: "warn", reached: false });
    expect(week!.resets).toMatch(/^[A-Za-z]+\.?$/);
    // Not reported yet: no windows, and a chip with nothing in it.
    expect(railFoot({ limits: {}, providers: [claude], now: NOW })[0]).toMatchObject({ windows: [], reached: false, tone: "normal" });
    // Told only that a limit is reached: one row says so.
    const bare = railFoot({ limits: { [key("codex")]: limits("codex", NOW, [], { reached: true }) }, providers: [codex], now: NOW })[0]!;
    expect(bare.windows).toEqual([{ label: "Limit", tone: "danger", reached: true, resets: undefined }]);
    // A limit reached that no window is (Codex's workspace limit, its windows at 20% and 30%): the card says so too, first.
    const workspace = railFoot({ limits: { [key("codex")]: limits("codex", NOW, [
        { id: "codex:primary", label: "5-hour", usedPercent: 20 }, { id: "codex:secondary", label: "Weekly", usedPercent: 30 },
    ], { reached: true, resetsAt: NOW + 3_600_000 }) }, providers: [codex], now: NOW })[0]!;
    expect(workspace).toMatchObject({ reached: true, tone: "danger" });
    expect(workspace.windows.map((w) => [w.label, w.reached])).toEqual([["Limit", true], ["5-hour", false], ["Weekly", false]]);
    expect(workspace.windows[0]!.resets).toBe(workspace.lifts);
    // A window that's reached says it itself: no extra row.
    expect(plan!.windows.map((w) => w.label)).toEqual(["5-hour", "Weekly"]);
    // Old figures say how old in the card.
    const old = railFoot({ limits: { [key("codex")]: limits("codex", NOW - 3_600_000, [{ id: "codex:primary", label: "5-hour", usedPercent: 20 }]) }, providers: [codex], now: NOW })[0]!;
    expect(old.asOf).toMatch(/^as of /);
});

test("chips fold plain ones first, from the end, so a plan near its limit stays in view", () => {
    expect(foldOrder([{ tone: "danger" }, { tone: "normal" }, { tone: "warn" }, { tone: "normal" }])).toEqual([3, 1, 2, 0]);
    expect(foldOrder([])).toEqual([]);
});

test("the footer's fit: as they are when there's room, then without % signs, and only then into +N", () => {
    // Four chips of 50px (46 tight), 2px apart (1 tight); "+N" is 22px.
    const fit = (room: number, n = 4) => planFit({ room, normal: Array(n).fill(50), tight: Array(n).fill(46), gap: 2, tightGap: 1, more: 22, order: [3, 2, 1, 0].slice(4 - n) });
    expect(fit(206)).toEqual({ tight: false, folded: 0 });
    expect(fit(205.6)).toEqual({ tight: false, folded: 0 });
    // Short of room: tight first, nothing folded while tight fits (187px).
    expect(fit(200)).toEqual({ tight: true, folded: 0 });
    expect(fit(187)).toEqual({ tight: true, folded: 0 });
    // Then fold, counting the "+N" chip: three tight (140) + 1 + 22 = 163.
    expect(fit(186)).toEqual({ tight: true, folded: 1 });
    expect(fit(163)).toEqual({ tight: true, folded: 1 });
    expect(fit(162)).toEqual({ tight: true, folded: 2 });
    // However narrow, one chip stays.
    expect(fit(10)).toEqual({ tight: true, folded: 3 });
    // One plan never folds or tightens (its chip takes the row and truncates its name).
    expect(fit(10, 1)).toEqual({ tight: false, folded: 0 });
    // Uneven chips fold in the order given: dropping the wide one (index 0) first makes room sooner.
    expect(planFit({ room: 100, normal: [80, 40, 40], tight: [76, 36, 36], gap: 2, tightGap: 1, more: 20, order: [0, 2, 1] })).toEqual({ tight: true, folded: 1 });
});

test("Needs you: waiting sessions but the one in front of you, latest first, saying what each asks", () => {
    const s = (id: string, status: "waiting" | "idle" | "running", updatedAt: number, waitingKind?: "permission" | "plan" | "question" | "secret") => ({ id, status, updatedAt, waitingKind, title: `T${id}` });
    const list = [s("a", "waiting", 1, "permission"), s("b", "idle", 5), s("c", "waiting", 3, "plan"), s("d", "running", 9), s("e", "waiting", 2)];
    expect(needsYou(list).map((x) => x.id)).toEqual(["c", "e", "a"]);
    expect(needsYou(list, "c").map((x) => x.id)).toEqual(["e", "a"]);
    expect(needsYou([s("a", "waiting", 1)], "a")).toEqual([]);
    expect(list.map(asking)).toEqual(["Wants your approval", "Waiting for your answer", "Plan ready for review", "Waiting for your answer", "Waiting for your answer"]);
    expect(asking({ waitingKind: "question" })).toBe("Has a question for you");
    expect(asking({ waitingKind: "secret" })).toBe("Asks for a secret");
    expect(needsLine([list[0]!])).toBe("Ta needs you: Wants your approval");
    expect(needsLine(needsYou(list))).toBe("3 sessions need you");
    // Its pinned row, answered while the rail holds still, doesn't go on saying it asks.
    expect(needsRowLine({ status: "waiting", waitingKind: "plan" })).toBe("Plan ready for review");
    expect(needsRowLine({ status: "running" })).toBe("Answered");
});

test("Needs you shows on the rail, else the title bar; over both, in Settings' top line", () => {
    expect(needsPlace({ railShown: true, settings: false })).toBe("rail");
    expect(needsPlace({ railShown: false, settings: false })).toBe("title");
    // Settings takes the rail's place (its own list) and covers the title bar, rail shown or not.
    expect(needsPlace({ railShown: true, settings: true })).toBe("settings");
    expect(needsPlace({ railShown: false, settings: true })).toBe("settings");
});

test("the session in front of you (left out of Needs you): the open one, but not under Settings or one of its sub-agents' views", () => {
    expect(inFront({ activeId: "a", settings: false })).toBe("a");
    expect(inFront({ activeId: "a", settings: true })).toBeUndefined();
    // A sub-agent's view shows only its own requests: the session's own still needs showing.
    expect(inFront({ activeId: "a", settings: false, agentFocus: "agent-1" })).toBeUndefined();
    expect(inFront({ settings: false })).toBeUndefined();
    const waiting = [{ id: "a", status: "waiting" as const, updatedAt: 1 }];
    expect(needsYou(waiting, inFront({ activeId: "a", settings: false, agentFocus: "agent-1" })).map((s) => s.id)).toEqual(["a"]);
});

test("Needs you's group starts the active list, isn't counted under a project, and isn't in the list's order", async () => {
    const order = await import("../gui/src/lib/session-order");
    const sess = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ id, cwd: "/p", projectName: "p", title: id, createdAt: 1, updatedAt: 1, status: "idle", messages: 1, pinned: false, archived: false, settled: false, live: true, ...o });
    const list = [sess("1", { status: "waiting" }), sess("2"), sess("3", { settled: true })];
    const base = { groupBy: "project" as const, archived: false, settledOpen: true, cards: 25, settled: 25, archive: 25 };
    const entries = order.sidebarEntries(list, [], { ...base, needs: ["1"] });
    expect(entries[0]).toEqual({ key: "heading:needs", kind: "needs", ids: ["1"] });
    expect(order.sidebarIds(entries)).toEqual(["1", "2", "3"]);
    expect([...groupCounts(entries)]).toEqual([["project:/p", 2]]);
    // None waiting, or the archived list: no group.
    expect(order.sidebarEntries(list, [], { ...base, needs: [] }).some((e) => e.kind === "needs")).toBe(false);
    expect(order.sidebarEntries(list, [], { ...base, archived: true, needs: ["1"] }).some((e) => e.kind === "needs")).toBe(false);
    // Held (the pointer on the list), it keeps its rows, less any deleted.
    const rest = [list[1]!, list[2]!];
    const held = order.holdSidebar(entries, order.sidebarEntries(rest, [], { ...base, needs: [] }), true, rest);
    expect(held.some((e) => e.kind === "needs")).toBe(false);
    const kept = order.holdSidebar(entries, order.sidebarEntries(list, [], { ...base, needs: [] }), true, list);
    expect(kept[0]).toEqual({ key: "heading:needs", kind: "needs", ids: ["1"] });
    // Held by a selection alone (no pointer on it), the group follows who's waiting; the rows below stay put.
    const answered = [sess("1"), list[1]!, list[2]!];
    const picked = order.holdSidebar(entries, order.sidebarEntries(answered, [], { ...base, needs: [] }), true, answered, undefined, false);
    expect(picked.some((e) => e.kind === "needs")).toBe(false);
    expect(order.sidebarIds(picked)).toEqual(order.sidebarIds(entries));
    const plain = order.sidebarEntries(answered, [], { ...base, needs: [] });
    const now = [sess("1"), sess("2", { status: "waiting" }), list[2]!];
    const joined = order.holdSidebar(plain, order.sidebarEntries(now, [], { ...base, needs: ["2"] }), true, now, undefined, false);
    expect(joined[0]).toEqual({ key: "heading:needs", kind: "needs", ids: ["2"] });
    expect(order.sidebarIds(joined)).toEqual(order.sidebarIds(plain));
});
