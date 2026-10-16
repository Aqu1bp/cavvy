import { expect, test } from "bun:test";
import type { SessionSummary } from "../src/server/protocol";
import { adjacentSession, holdSidebar, orderSessions, pageSessions, sidebarEntries, sidebarIds, type SidebarOptions } from "../gui/src/lib/session-order";
import { projectColor, projectMonograms } from "../gui/src/lib/format";
import { sessionStatus } from "../gui/src/lib/session-status";

const session = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({
    id, cwd: "/project", projectName: "project", title: id, createdAt: 1, updatedAt: 1,
    status: "idle", messages: 2, pinned: false, archived: false, settled: false, live: false, ...patch,
});
const options = (patch: Partial<SidebarOptions> = {}): SidebarOptions => ({
    groupBy: "date", archived: false, settledOpen: true, cards: 25, settled: 25, archive: 25, ...patch,
});
const many = () => Array.from({ length: 80 }, (_, i) => session(String(i), { updatedAt: 100 - i, cwd: `/project/${i % 8}`, projectName: `project-${i % 8}` }));

test("attention, pins, then activity; re-sorting does not mutate input", () => {
    const list = [session("old"), session("new", { updatedAt: 9 }), session("pin", { pinned: true }), session("ask", { status: "waiting" })];
    expect(orderSessions(list).map((s) => s.id)).toEqual(["ask", "pin", "new", "old"]);
    expect(list[0]!.id).toBe("old");
    list[0]!.updatedAt = 20;
    expect(orderSessions(list).map((s) => s.id)).toEqual(["ask", "pin", "old", "new"]);
    list[3]!.status = "idle";
    expect(orderSessions(list).map((s) => s.id)).toEqual(["pin", "old", "new", "ask"]);
});

for (const groupBy of ["date", "project"] as const) {
    test(`${groupBy}: page budget plus every waiting and open session, with keyboard in rendered order`, () => {
        const list = many();
        list[60]!.status = "waiting";
        list[70]!.status = "waiting";
        expect(pageSessions(list, 25, "79")).toHaveLength(28);
        const entries = sidebarEntries(list, [], options({ groupBy, activeId: "79" }));
        const ids = sidebarIds(entries);
        expect(ids).toHaveLength(26); // Waiting rows rank inside the normal budget; active is extra.
        for (const id of ["60", "70", "79"]) expect(ids).toContain(id);
        for (let i = 0; i < ids.length; i++) {
            expect(adjacentSession(ids, ids[i], 1)).toBe(ids[(i + 1) % ids.length]);
            expect(adjacentSession(ids, ids[i], -1)).toBe(ids[(i + ids.length - 1) % ids.length]);
        }
        expect(sidebarIds(sidebarEntries(list, [], options({ groupBy, cards: 50 })))).toHaveLength(50);
    });
}

test("same-named directories form separate project groups", () => {
    const entries = sidebarEntries([session("a", { cwd: "/one/app" }), session("b", { cwd: "/two/app" })], [], options({ groupBy: "project" }));
    expect(entries.filter((e) => e.kind === "project")).toHaveLength(2);
});

test("settled and archive paging preserve required rows even across collapsed/filter views", () => {
    const list = many().map((s) => ({ ...s, settled: true }));
    list[70]!.status = "waiting";
    expect(sidebarIds(sidebarEntries(list, [], options({ activeId: "79" })))).toHaveLength(26);
    expect(sidebarIds(sidebarEntries(list, [], options({ activeId: "79", settledOpen: false })))).toEqual(["70", "79"]);
    const archived = list.map((s) => ({ ...s, archived: true }));
    expect(sidebarIds(sidebarEntries([], archived, options({ archived: true, activeId: "79" })))).toHaveLength(26);
    expect(sidebarIds(sidebarEntries([], archived, options({ activeId: "79" })))).toEqual(["70", "79"]);
    expect(sidebarIds(sidebarEntries(list, [], options({ archived: true, activeId: "79" })))).toEqual(["70", "79"]);
});

for (const reason of ["hover", "menu", "rename"]) {
    test(`${reason} holds row positions and shelves, appends new attention; release applies pending order`, () => {
        const list = many();
        const before = sidebarEntries(list, [], options());
        list[1]!.settled = true;
        list[60]!.status = "waiting";
        const next = sidebarEntries(list, [], options({ activeId: "79" }));
        const held = holdSidebar(before, next, true, list, "79");
        expect(held.slice(0, before.length)).toEqual(before);
        expect(sidebarIds(held).slice(-2)).toEqual(["60", "79"]);
        expect(holdSidebar(held, next, false, list, "79")).toEqual(next);
        expect(sidebarIds(next)[0]).toBe("60");
    });
}

test("navigation handles empty lists, home, wraparound and absent current IDs", () => {
    expect(adjacentSession([], "x", 1)).toBeUndefined();
    expect(adjacentSession(["a", "b"], undefined, 1)).toBe("a");
    expect(adjacentSession(["a", "b"], "missing", -1)).toBe("b");
    expect(adjacentSession(["a", "b"], "a", -1)).toBe("b");
    expect(adjacentSession(["a", "b"], "b", 1)).toBe("a");
});

test("status distinguishes permission/question/secret/plan/done; working uses turn start", () => {
    for (const [waitingKind, label] of [["permission", "Needs approval"], ["question", "Has a question"], ["secret", "Has a question"], ["plan", "Plan to review"]] as const) {
        expect(sessionStatus(session("s", { status: "waiting", waitingKind }), 0)?.text).toBe(label);
    }
    expect(sessionStatus(session("s", { status: "waiting" }), 0)?.text).toBe("Needs you");
    expect(sessionStatus(session("s", { status: "running", turnStartedAt: 1000 }), 181000)?.text).toBe("Working 3m");
    expect(sessionStatus(session("s", { status: "running" }), 181000)?.text).toBe("Working");
    expect(sessionStatus(session("s"), 0)?.text).toBe("Done");
    expect(sessionStatus(session("s", { messages: 0 }), 0)).toBeUndefined();
    expect(sessionStatus(session("s", { status: "error" }), 0)?.text).toBe("Stopped");
});

test("monograms distinguish colliding names and paths; colors are stable and readable", () => {
    const names = ["feat-git-changes", "feat-worktree-create", "app", "app", "!!!", "..."];
    const projects = names.map((projectName, i) => ({ cwd: `/project/${i}`, projectName }));
    const labels = projectMonograms(projects);
    expect(new Set(labels.values()).size).toBe(projects.length);
    expect(labels.get("/project/0")).toBe("FGC");
    expect(labels.get("/project/1")).toBe("FWC");
    expect(projectMonograms([...projects].reverse())).toEqual(labels);
    expect(projectColor("/project/0")).not.toBe(projectColor("/project/1"));
    for (const p of projects) {
        expect(projectColor(p.cwd)).toBe(projectColor(p.cwd));
        const rgb = projectColor(p.cwd).slice(1).match(/../g)!.map((hex) => parseInt(hex, 16) / 255).map((v) => v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4);
        const lum = .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
        expect(1.05 / (lum + .05)).toBeGreaterThanOrEqual(4.5);
    }
});

const runSession = (id: string, patch: Partial<SessionSummary> = {}) => session(id, {
    cwd: `/worktrees/${id}`, run: { id: "run", cwd: "/original/project", label: "Compare models", model: `mock:${id}`, modelName: id }, ...patch,
});

for (const groupBy of ["date", "project"] as const) {
    test(`${groupBy}: runs rank by attention/pins/activity, page as units and navigate in model start order`, () => {
        const list = [session("new", { updatedAt: 100 }), runSession("a", { createdAt: 10 }), runSession("b", { createdAt: 20, pinned: true })];
        const layout = (patch: Partial<SidebarOptions> = {}) => sidebarEntries(list, [], options({ groupBy, cards: 1, ...patch }));
        expect(sidebarIds(layout())).toEqual(["a", "b"]);
        expect(layout().find((e) => e.kind === "more")).toMatchObject({ remaining: 1 });
        list[0]!.status = "waiting";
        expect(sidebarIds(layout())).toEqual(["new"]);
        expect(sidebarIds(layout({ activeId: "b" }))).toEqual(["new", "a", "b"]);
        list[2]!.status = "waiting";
        expect(sidebarIds(layout())).toEqual(["a", "b", "new"]);
        const ids = sidebarIds(layout());
        expect(adjacentSession(ids, "a", 1)).toBe("b");
        expect(adjacentSession(ids, "b", -1)).toBe("a");
        expect(adjacentSession(ids, "new", 1)).toBe("a");
        if (groupBy === "project") expect(layout().filter((e) => e.kind === "project")).toEqual([
            { key: "project:/original/project", kind: "project", cwd: "/original/project", name: "project" },
            { key: "project:/project", kind: "project", cwd: "/project", name: "project" },
        ]);
    });
}

test("held runs keep model order and append new required groups without duplicates, then regroup on release", () => {
    let list = [runSession("a"), runSession("b", { createdAt: 2 }), session("tail")];
    const before = sidebarEntries(list, [], options());
    list = [...list, runSession("c", { createdAt: 3, status: "waiting" })];
    const next = sidebarEntries(list, [], options());
    const held = holdSidebar(before, next, true, list);
    expect(sidebarIds(held)).toEqual(["a", "b", "tail", "c"]);
    expect(sidebarIds(holdSidebar(held, next, true, list))).toEqual(["a", "b", "tail", "c"]);
    expect(sidebarIds(holdSidebar(held, next, false, list))).toEqual(["a", "b", "c", "tail"]);
    list = list.filter((s) => s.id !== "b");
    expect(sidebarIds(holdSidebar(held, sidebarEntries(list, [], options()), true, list))).toEqual(["a", "tail", "c"]);
});

test("settled and archived runs page together and retain active/waiting groups across filters", () => {
    const list = [runSession("a", { settled: true }), runSession("b", { settled: true }), session("tail", { settled: true })];
    expect(sidebarIds(sidebarEntries(list, [], options({ settled: 1 })))).toEqual(["a", "b"]);
    expect(sidebarIds(sidebarEntries(list, [], options({ settledOpen: false, activeId: "b" })))).toEqual(["a", "b"]);
    const archived = list.map((s) => ({ ...s, archived: true }));
    expect(sidebarIds(sidebarEntries([], archived, options({ archived: true, archive: 1 })))).toEqual(["a", "b"]);
    expect(sidebarIds(sidebarEntries([], archived, options({ activeId: "b" })))).toEqual(["a", "b"]);
});
