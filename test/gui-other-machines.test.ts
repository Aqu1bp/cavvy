// Every machine's sessions in the window's one list (gui/src/components/OtherMachines.tsx, lib/machine-rows.ts):
// which sessions of other machines are listed beside the window's own, where what a row offers is sent, how
// projects on different machines are kept apart, and that all of it is part of the servers code, loaded only when
// there are servers.

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { listable, mayTake, otherRows, routeOf } from "../gui/src/lib/machine-rows";
import { folderOf, onAnother, projectOf, sidebarEntries } from "../gui/src/lib/session-order";
import type { MachineOverview, SessionSummary } from "../src/server/protocol";

const s = (id: string, o: Partial<SessionSummary> = {}): SessionSummary => ({ id, cwd: "/srv/app", projectName: "app", title: id, createdAt: 1, updatedAt: 1, messages: 1, status: "idle", pinned: false, archived: false, settled: false, live: false, ...o });
const server = (name: string, sessions: SessionSummary[], state: MachineOverview["state"] = "connected"): MachineOverview => ({ name, state, sessions });

test("a window on this computer lists each server's sessions with the server's name; one on a server lists this computer's and the other servers', not its own again", () => {
    const servers = [server("box", [s("b1"), s("b2")]), server("den", [s("d1")]), server("old", [s("o1")], "removed")];
    expect(otherRows(undefined, [], servers).map((x) => [x.id, x.machine])).toEqual([["b1", "box"], ["b2", "box"], ["d1", "den"]]);
    // On box: its own sessions are the window's. This computer's have no machine: that's what says they're its.
    const onBox = otherRows("box", [s("m1", { machine: "made-up" })], servers);
    expect(onBox.map((x) => [x.id, x.machine])).toEqual([["m1", undefined], ["d1", "den"]]);
    expect("machine" in onBox[0]!).toBe(true);
});

test("a server doesn't get to choose a row: a session with the id of one of the window's own, or of one already listed, isn't listed", () => {
    const own = [s("mine"), s("also")];
    const others = [s("mine", { machine: "box", title: "an impostor" }), s("b1", { machine: "box" }), s("b1", { machine: "den", title: "a second one" }), s("d1", { machine: "den" })];
    expect(listable(own, others).map((x) => [x.id, x.machine])).toEqual([["b1", "box"], ["d1", "den"]]);
    // A change to one that's listed is that machine's to make; nobody else's.
    expect(mayTake(undefined, undefined, "box")).toBe(true);
    expect(mayTake({ machine: "box" }, undefined, "box")).toBe(true);
    expect(mayTake({ machine: "box" }, undefined, "den")).toBe(false);
    // The window's own, on this computer or (the window being on box) on box: never.
    expect(mayTake({ machine: undefined }, undefined, "box")).toBe(false);
    expect(mayTake({ machine: "box" }, "box", "box")).toBe(false);
    expect(mayTake({ machine: undefined }, "box", undefined)).toBe(true);
});

test("what a row offers is sent to the machine its session is on; anything else of another machine's session is refused, and the window's own go as ever", () => {
    const far = new Map<string, string | undefined>([["b1", "box"], ["m1", undefined], ["gone", "box"], ["now-mine", "box"]]);
    const rows: Record<string, { machine?: string }> = { b1: { machine: "box" }, m1: { machine: undefined }, mine: { machine: "den" }, "now-mine": { machine: "den" } };
    const to = (method: string, params: unknown) => routeOf(method, params, far, (id) => rows[id], "den");
    expect(to("session.archive", { id: "b1", archived: true })).toEqual({ relay: "box" });
    expect(to("session.rename", { id: "m1", title: "x" })).toBe("mac");
    for (const method of ["session.pin", "session.settle", "session.delete", "session.restore"]) expect(to(method, { id: "b1" })).toEqual({ relay: "box" });
    // Sending a message, opening, stopping: done in a window that's on that machine. So is asking what archiving
    // would remove there (a worktree): from here it's archived with everything kept.
    for (const method of ["session.send", "session.open", "session.interrupt", "session.respond", "session.setMode", "session.archiveOffer"]) expect(to(method, { id: "b1" })).toBe("refused");
    // The window's own sessions, and whatever isn't about a session (a terminal with that id, say), go where they always did.
    expect(to("session.send", { id: "mine", text: "hi" })).toBe("here");
    expect(to("terminal.write", { id: "b1", data: "x" })).toBe("here");
    expect(to("sessions.list", { limit: 3 })).toBe("here");
    expect(to("session.archive", undefined)).toBe("here");
    // No longer listed, or one of the window's own machine's has that id now: it's the window's.
    expect(to("session.archive", { id: "gone" })).toBe("here");
    // But Undo of a delete that the server hasn't confirmed yet is still that server's.
    expect(to("session.restore", { id: "gone" })).toEqual({ relay: "box" });
    expect(to("session.archive", { id: "now-mine" })).toBe("here");
    // Deleted on another machine: Undo brings it back there, and only that is sent after it's gone from the list.
    const gone = new Map<string, string | undefined>([["deleted", "box"], ["mac-deleted", undefined], ["b1", "den"]]);
    const after = (method: string, id: string) => routeOf(method, { id }, far, (x) => rows[x], "den", gone);
    expect([after("session.restore", "deleted"), after("session.restore", "mac-deleted"), after("session.delete", "deleted"), after("session.restore", "never-heard-of")]).toEqual([{ relay: "box" }, "mac", "here", "here"]);
    // Listed again since (another one took the id, or it came back): where it's listed now is what counts.
    expect(after("session.restore", "b1")).toEqual({ relay: "box" });
});

test("a new session asked for from a row or a heading starts on that one's machine: in a window on a server, this computer's is another machine too", () => {
    // In a window on this computer: its own rows and headings are here, a server's aren't.
    expect([onAnother({ machine: undefined }, undefined), onAnother({}, undefined), onAnother({ machine: "box" }, undefined)]).toEqual([false, false, true]);
    // In a window on box: box's are here, this computer's (no machine) and another server's aren't.
    expect([onAnother({ machine: "box" }, "box"), onAnother({ machine: undefined }, "box"), onAnother({}, "box"), onAnother({ machine: "den" }, "box")]).toEqual([false, true, true, true]);
    // Not asked from a row at all (the New session button, a shortcut): the window's own machine.
    expect([onAnother(undefined, undefined), onAnother(undefined, "box")]).toEqual([false, false]);
});

test("grouped by project, a folder at the same path on two machines is two projects, each named with its server", () => {
    const here = s("a", { cwd: "/srv/app" });
    const there = s("b", { cwd: "/srv/app", machine: "box" });
    expect(projectOf(here)).toBe("/srv/app");
    expect(projectOf(there)).not.toBe(projectOf(here));
    expect([folderOf(projectOf(here)), folderOf(projectOf(there))]).toEqual(["/srv/app", "/srv/app"]);
    const heads = sidebarEntries([here, there], [], { groupBy: "project", cards: 50, settled: 50, archive: 50, settledOpen: false, archived: false, collapsed: [], needs: [] } as never).filter((e) => e.kind === "project") as { cwd: string; name: string; machine?: string }[];
    expect(heads.map((h) => [folderOf(h.cwd), h.name, h.machine])).toEqual([["/srv/app", "app", undefined], ["/srv/app", "app", "box"]]);
});

test("nothing of other machines is loaded or asked for unless this Cavvy has servers, or the window is on one", () => {
    const read = (f: string) => readFileSync(new URL(`../gui/src/${f}`, import.meta.url), "utf8");
    const app = read("state/app.ts");
    expect(app).toContain("if (machine || app.hello?.servers) void serversUi().then((m) => m.connected());");
    // Only through the servers code, which is fetched when asked for.
    for (const f of ["state/app.ts", "state/actions.ts", "components/Sidebar.tsx", "lib/rpc.ts", "lib/session-order.ts"]) {
        // Named in a comment at most: never brought in.
        expect(/from "[^"]*(OtherMachines|machine-rows)"/.test(read(f))).toBe(false);
    }
    const others = read("components/OtherMachines.tsx");
    // It watches the rail's own children only: not everything that changes inside the sidebar while a reply streams.
    expect(others).toContain("seenRail.observe(rail, { childList: true });");
    expect(others).not.toContain("subtree");
    expect(others).not.toContain("setInterval");
});
