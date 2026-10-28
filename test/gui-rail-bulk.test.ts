// Settling, archiving and deleting several sessions picked in the rail: each
// goes through the same RPC as one does, with one toast and one Undo for all
// of them; the ones that fail are named and stay selected.
import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { app, dismissToast, rpc, runToastAction, setApp, toasts } from "../gui/src/state/app";
import { archiveSessions, deleteSessions, settleSessions } from "../gui/src/state/actions";
import { railSelection, setRailSelection } from "../gui/src/state/sidebar";
import { UNDO_DELETE_MS } from "../gui/src/lib/toasts";
import { RpcError } from "../gui/src/lib/rpc";
import type { SessionSummary } from "../src/server/protocol";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const timeouts: number[] = [];
const original = { sessions: [...app.sessions], archived: [...app.archived], activeId: app.activeId, homeCwd: app.homeCwd };

const s = (id: string, patch: Partial<SessionSummary> = {}): SessionSummary => ({ id, cwd: "/p", projectName: "p", title: id.toUpperCase(), createdAt: 1, updatedAt: 1, messages: 2, status: "idle", pinned: false, settled: false, archived: false, live: true, ...patch });

beforeEach(() => {
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
    // Toasts don't expire on their own here; their timers' lengths are noted.
    timeouts.length = 0;
    globalThis.setTimeout = ((_fn: () => void, ms: number) => (timeouts.push(ms), 0)) as unknown as typeof setTimeout;
    globalThis.clearTimeout = (() => {}) as unknown as typeof clearTimeout;
    setApp({ sessions: [s("a"), s("b"), s("c")], archived: [s("x", { archived: true }), s("y", { archived: true })], activeId: undefined });
    setRailSelection({ ids: ["a", "b", "c"], anchor: "a" });
});

afterEach(() => {
    while (toasts.length) dismissToast(toasts[0]!.id);
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    setApp({ sessions: original.sessions, archived: original.archived, activeId: original.activeId, homeCwd: original.homeCwd });
    setRailSelection({ ids: [] });
});

const calls = (call: { mock: { calls: unknown[][] } }, method: string) => call.mock.calls.filter((c) => c[0] === method).map((c) => (c[1] as { id: string }).id).sort();

test("deleting several: each through session.delete, one toast, and one Undo restores them all", async () => {
    const call = spyOn(rpc, "call").mockResolvedValue(null);
    try {
        expect(await deleteSessions(["a", "b", "c"])).toEqual([]);
        expect(calls(call, "session.delete")).toEqual(["a", "b", "c"]);
        expect(toasts.map((t) => [t.level, t.message, t.action?.label])).toEqual([["info", "3 sessions deleted", "Undo"]]);
        // As long as one delete's Undo stays.
        expect(timeouts.map(Math.round)).toEqual([UNDO_DELETE_MS]);
        expect(railSelection().ids).toEqual([]);
        await runToastAction(toasts[0]!.id);
        expect(calls(call, "session.restore")).toEqual(["a", "b", "c"]);
        expect(toasts).toHaveLength(0);
    } finally {
        call.mockRestore();
    }
});

test("a partial failure names the ones that failed, keeps them selected, and the Undo covers only the rest", async () => {
    const busy = new RpcError("This session is still working. Stop it first, then delete it.", "busy");
    const call = spyOn(rpc, "call").mockImplementation((async (method: string, p: { id: string }) => {
        if (method === "session.delete" && p.id === "b") throw busy;
        return null;
    }) as never);
    try {
        expect(await deleteSessions(["a", "b", "c"])).toEqual(["b"]);
        expect(toasts.map((t) => [t.level, t.message])).toEqual([
            ["info", "2 sessions deleted"],
            ["error", "Couldn't delete “B”: This session is still working. Stop it first, then delete it."],
        ]);
        expect(railSelection().ids).toEqual(["b"]);
        await runToastAction(toasts[0]!.id);
        expect(calls(call, "session.restore")).toEqual(["a", "c"]);
    } finally {
        call.mockRestore();
    }
});

test("an Undo that brings back only some says which, and its retry tries only those", async () => {
    let failOnce = true;
    const call = spyOn(rpc, "call").mockImplementation((async (method: string, p: { id: string }) => {
        if (method === "session.restore" && p.id === "c" && failOnce) {
            failOnce = false;
            throw new Error("Disconnected");
        }
        return null;
    }) as never);
    try {
        await deleteSessions(["a", "b", "c"]);
        const undo = toasts[0]!;
        await runToastAction(undo.id);
        expect(toasts.find((t) => t.id === undo.id)).toMatchObject({ level: "error", message: "3 sessions deleted: “C” couldn't be brought back: Disconnected", action: { label: "Undo" } });
        await runToastAction(undo.id);
        expect(call.mock.calls.filter((c) => c[0] === "session.restore").map((c) => (c[1] as { id: string }).id)).toEqual(["a", "b", "c", "c"]);
        expect(toasts).toHaveLength(0);
    } finally {
        call.mockRestore();
    }
});

test("settling several: one toast whose Undo brings them all back into play; Back in play has no toast", async () => {
    const call = spyOn(rpc, "call").mockResolvedValue(null);
    try {
        expect(await settleSessions(["a", "b"], true)).toEqual([]);
        expect(call.mock.calls.map((c) => c[1])).toEqual([{ id: "a", settled: true }, { id: "b", settled: true }]);
        expect(toasts.map((t) => t.message)).toEqual(["2 sessions settled"]);
        // Only the ones it did leave the selection.
        expect(railSelection().ids).toEqual(["c"]);
        await runToastAction(toasts[0]!.id);
        expect(call.mock.calls.slice(2).map((c) => c[1])).toEqual([{ id: "a", settled: false }, { id: "b", settled: false }]);
        expect(toasts).toHaveLength(0);
        await settleSessions(["a", "b"], false);
        expect(toasts).toHaveLength(0);
    } finally {
        call.mockRestore();
    }
});

test("archiving several keeps worktrees (no question each), sends the open one's window Home, and one Undo restores them", async () => {
    setApp({ activeId: "b", homeCwd: "/p" });
    const call = spyOn(rpc, "call").mockResolvedValue(null);
    try {
        expect(await archiveSessions(["a", "b"], true)).toEqual([]);
        expect(call.mock.calls.map((c) => c[0])).toEqual(["session.archive", "session.archive"]);
        expect(app.activeId).toBeUndefined();
        expect(toasts.map((t) => [t.message, t.action?.label])).toEqual([["2 sessions archived", "Undo"]]);
        await runToastAction(toasts[0]!.id);
        expect(call.mock.calls.slice(2).map((c) => c[1])).toEqual([{ id: "a", archived: false }, { id: "b", archived: false }]);
        // Restoring several: a toast, nothing to undo.
        await archiveSessions(["x", "y"], false);
        expect(toasts.map((t) => [t.message, t.action])).toEqual([["2 sessions restored", undefined]]);
    } finally {
        call.mockRestore();
    }
});

test("one session goes the single way: its own toast, and archiving asks about a worktree first", async () => {
    const call = spyOn(rpc, "call").mockResolvedValue(null);
    try {
        await deleteSessions(["a"]);
        expect(toasts.map((t) => t.message)).toEqual(["Session deleted"]);
        expect(railSelection().ids).toEqual(["b", "c"]);
        await archiveSessions(["b"], true);
        expect(call.mock.calls.map((c) => c[0])).toEqual(["session.delete", "session.archiveOffer", "session.archive"]);
    } finally {
        call.mockRestore();
    }
});

test("deleting asks nothing first, and with nothing picked it does nothing", async () => {
    const call = spyOn(rpc, "call").mockResolvedValue(null);
    try {
        expect(await deleteSessions([])).toEqual([]);
        expect(call).not.toHaveBeenCalled();
        expect(toasts).toHaveLength(0);
        await deleteSessions(["a", "x"]);
        expect(calls(call, "session.delete")).toEqual(["a", "x"]);
        expect(toasts.map((t) => t.action?.label)).toEqual(["Undo"]);
    } finally {
        call.mockRestore();
    }
});
