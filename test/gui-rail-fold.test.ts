// Grouped by project, a heading folds its sessions under it: what the rail
// lists then, the counts, opening a session unfolding its project, and the
// folded projects kept in the preferences.
import { expect, test } from "bun:test";
import type { SessionSummary } from "../src/server/protocol";
import { projectOf, revealProject, sidebarEntries, sidebarIds, toggleProject, type SidebarOptions } from "../gui/src/lib/session-order";
import { groupCounts } from "../gui/src/lib/rail";
import { migratePrefs, PREF_DEFAULTS } from "../gui/src/state/prefs-core";

const session = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
    id, cwd: "/a", projectName: "a", title: id, createdAt: 1, updatedAt: 1,
    status: "idle", messages: 2, pinned: false, archived: false, settled: false, live: false, ...patch,
});
const options = (patch: Partial<SidebarOptions> = {}): SidebarOptions => ({
    groupBy: "project", archived: false, settledOpen: true, cards: 25, settled: 25, archive: 25, ...patch,
});
// Projects /a, /b and /c, newest first: a0 b0 c0 a1 b1 c1 …
const list = Array.from({ length: 12 }, (_, i) => {
    const p = "abc"[i % 3]!;
    return session(`${p}${Math.floor(i / 3)}`, { cwd: `/${p}`, projectName: p, updatedAt: 100 - i });
});

test("a folded project shows its heading (with every session in it counted) and none of its rows", () => {
    const entries = sidebarEntries(list, [], options({ collapsed: ["/b"] }));
    expect(entries.filter((e) => e.kind === "project").map((e) => [e.key, "collapsed" in e && e.collapsed])).toEqual([["project:/a", false], ["project:/b", true], ["project:/c", false]]);
    expect(entries.find((e) => e.key === "project:/b")).toMatchObject({ collapsed: true, ids: ["b0", "b1", "b2", "b3"] });
    expect(sidebarIds(entries)).toEqual(["a0", "a1", "a2", "a3", "c0", "c1", "c2", "c3"]);
    expect([...groupCounts(entries)]).toEqual([["project:/a", 4], ["project:/b", 4], ["project:/c", 4]]);
    // Unfolded, as before.
    expect(sidebarIds(sidebarEntries(list, [], options()))).toHaveLength(12);
});

test("folded sessions take no page slots: the page fills from the projects still open", () => {
    const folded = sidebarEntries(list, [], options({ cards: 4, collapsed: ["/a"] }));
    expect(sidebarIds(folded)).toEqual(["b0", "b1", "c0", "c1"]);
    expect(folded.find((e) => e.kind === "more")).toMatchObject({ remaining: 4 });
    // Its heading keeps its place among the others, where its latest session would be.
    expect(folded.filter((e) => e.kind === "project").map((e) => e.key)).toEqual(["project:/a", "project:/b", "project:/c"]);
});

test("only grouping by project folds; settled sessions stay in Settled; a run folds under its own folder", () => {
    expect(sidebarIds(sidebarEntries(list, [], options({ groupBy: "date", collapsed: ["/a", "/b"] })))).toHaveLength(12);
    const settled = list.map((s) => (s.id === "a3" ? { ...s, settled: true } : s));
    expect(sidebarIds(sidebarEntries(settled, [], options({ collapsed: ["/a"] })))).toContain("a3");
    const run = { id: "r", cwd: "/a", label: "Compare", model: "m:a", modelName: "A" };
    const runs = [session("r1", { cwd: "/wt/1", run }), session("r2", { cwd: "/wt/2", run }), session("x", { cwd: "/x", projectName: "x" })];
    expect(projectOf(runs[0]!)).toBe("/a");
    const entries = sidebarEntries(runs, [], options({ collapsed: ["/a"] }));
    expect(sidebarIds(entries)).toEqual(["x"]);
    expect(groupCounts(entries).get("project:/a")).toBe(2);
});

test("toggling a project, and opening a session unfolds its project (only when it would be listed there)", () => {
    expect(toggleProject([], "/a")).toEqual(["/a"]);
    expect(toggleProject(["/a", "/b"], "/a")).toEqual(["/b"]);
    const folded = ["/a", "/b"];
    expect(revealProject(folded, session("a1", { cwd: "/a" }), "project")).toEqual(["/b"]);
    // Nothing to unfold: the same array, so nothing is saved.
    for (const s of [undefined, session("c", { cwd: "/c" }), session("a", { cwd: "/a", settled: true }), session("a", { cwd: "/a", archived: true })]) expect(revealProject(folded, s, "project")).toBe(folded);
    expect(revealProject(folded, session("a1", { cwd: "/a" }), "date")).toBe(folded);
});

test("folded projects are a preference: none by default; a saved list passes through, anything else is dropped", () => {
    expect(PREF_DEFAULTS.collapsedProjects).toEqual([]);
    expect(migratePrefs({ collapsedProjects: ["/a", "/b"] })).toEqual({ collapsedProjects: ["/a", "/b"] });
    for (const bad of ["/a", [1], null, { "/a": true }]) expect(migratePrefs({ collapsedProjects: bad })).toEqual({});
});
