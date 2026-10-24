import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { toast, toasts, pauseToast, dismissToast, runToastAction, runToastChoice, rpc } from "../gui/src/state/app";
import { archive, archivedWithWorktree, deleteSession, send, setArchived, settle } from "../gui/src/state/actions";
import { archiveRequest, setArchiveRequest } from "../gui/src/state/ui";
import { UNDO_DELETE_MS } from "../gui/src/lib/toasts";
import { RpcError, type Credentials } from "../gui/src/lib/rpc";
import { Socket } from "./helpers/gui-socket";

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
const originalTimeout = globalThis.setTimeout;
const originalClearTimeout = globalThis.clearTimeout;
const originalSocket = globalThis.WebSocket;
let now = 0;
let timerId = 0;
const timers = new Map<number, { at: number; fn: () => void }>();
let restoreNow: () => void;

beforeEach(() => {
    now = 0;
    timers.clear();
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } });
    globalThis.setTimeout = ((fn: () => void, ms: number) => {
        timers.set(++timerId, { at: now + ms, fn });
        return timerId;
    }) as unknown as typeof setTimeout;
    globalThis.clearTimeout = ((id: number) => {
        timers.delete(id);
    }) as unknown as typeof clearTimeout;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    restoreNow = () => clock.mockRestore();
});

afterEach(() => {
    while (toasts.length) dismissToast(toasts[0]!.id);
    globalThis.setTimeout = originalTimeout;
    globalThis.clearTimeout = originalClearTimeout;
    globalThis.WebSocket = originalSocket;
    if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
    else Reflect.deleteProperty(globalThis, "document");
    restoreNow();
});

function advance(ms: number) {
    now += ms;
    for (const [id, timer] of [...timers]) {
        if (timer.at <= now) {
            timers.delete(id);
            timer.fn();
        }
    }
}

test("settle offers Undo only after success, and Undo restores the original session", async () => {
    const pending = Promise.withResolvers<any>();
    const call = spyOn(rpc, "call").mockImplementationOnce(() => pending.promise).mockResolvedValue(null);
    try {
        const settling = settle("settled-session", true);
        expect(toasts).toHaveLength(0);
        pending.resolve(null);
        await settling;
        expect(call).toHaveBeenCalledWith("session.settle", { id: "settled-session", settled: true });
        const undo = toasts.find((t) => t.message === "Session settled")!;
        expect(undo.action?.label).toBe("Undo");
        await runToastAction(undo.id);
        expect(call).toHaveBeenLastCalledWith("session.settle", { id: "settled-session", settled: false });
        expect(toasts).toHaveLength(0);
    } finally {
        call.mockRestore();
    }
});

test("failed Settle offers no Undo, and Back in play creates no new Undo", async () => {
    const call = spyOn(rpc, "call").mockRejectedValueOnce(new Error("Settle failed")).mockResolvedValue(null);
    try {
        await settle("failed-session", true);
        expect(toasts.map((t) => [t.level, t.message, t.action])).toEqual([["error", "Settle failed", undefined]]);
        dismissToast(toasts[0]!.id);
        await settle("returned-session", false);
        expect(call).toHaveBeenLastCalledWith("session.settle", { id: "returned-session", settled: false });
        expect(toasts).toHaveLength(0);
    } finally {
        call.mockRestore();
    }
});

test("a failed Settle Undo remains available for an explicit retry", async () => {
    const call = spyOn(rpc, "call").mockResolvedValueOnce(null).mockRejectedValueOnce(new Error("Disconnected")).mockResolvedValue(null);
    try {
        await settle("settled-session", true);
        const undo = toasts[0]!;
        await runToastAction(undo.id);
        expect(toasts.find((t) => t.id === undo.id)).toMatchObject({ level: "error", message: "Session settled: Disconnected", action: { label: "Undo" } });
        expect(call).toHaveBeenCalledTimes(2);
        await runToastAction(undo.id);
        expect(call).toHaveBeenLastCalledWith("session.settle", { id: "settled-session", settled: false });
        expect(call).toHaveBeenCalledTimes(3);
        expect(toasts).toHaveLength(0);
    } finally {
        call.mockRestore();
    }
});

test("the real toast store evicts a notice before the older Undo", () => {
    const undo = { label: "Undo", run() {} };
    toast("Session deleted", "info", undo, UNDO_DELETE_MS);
    const id = toasts[0]!.id;
    toast("First notice");
    toast("Second notice");
    expect(toasts.map((t) => t.message)).toEqual(["Session deleted", "Second notice"]);
    advance(9999);
    expect(toasts.map((t) => t.id)).toEqual([id]);
    advance(1);
    expect(toasts).toHaveLength(0);
});

test("an all-action list queues the next Undo until a slot frees", () => {
    for (const message of ["First", "Second", "Third"]) toast(message, "info", { label: "Undo", run() {} });
    expect(toasts.map((t) => t.message)).toEqual(["First", "Second"]);
    dismissToast(toasts[0]!.id);
    expect(toasts.map((t) => t.message)).toEqual(["Second", "Third"]);
});

test("two Undo toasts queue ordinary notices in FIFO order with a fresh lifetime", () => {
    for (const message of ["Undo A", "Undo B"]) toast(message, "info", { label: "Undo", run() {} }, UNDO_DELETE_MS);
    toast("First notice");
    toast("Second notice");
    advance(9999);
    expect(toasts.map((t) => t.message)).toEqual(["Undo A", "Undo B"]);
    advance(1);
    expect(toasts.map((t) => t.message)).toEqual(["First notice", "Second notice"]);
    advance(4499);
    expect(toasts).toHaveLength(2);
    advance(1);
    expect(toasts).toHaveLength(0);
});

test("queued repeats merge and begin paused if promoted while hidden", () => {
    for (const message of ["Undo A", "Undo B"]) toast(message, "info", { label: "Undo", run() {} });
    toast("Repeated");
    toast("Repeated");
    const ids = toasts.map((t) => t.id);
    Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: true } });
    for (const id of ids) dismissToast(id);
    expect(toasts.map((t) => [t.message, t.count])).toEqual([["Repeated", 2]]);
    advance(20_000);
    expect(toasts).toHaveLength(1);
    pauseToast(toasts[0]!.id, "hidden", false);
    advance(4500);
    expect(toasts).toHaveLength(0);
});

test("the ten-item queue drops its oldest action-less entry, preserving queued Undo", () => {
    for (const message of ["Visible A", "Visible B", "Queued Undo"]) toast(message, "info", { label: "Undo", run() {} });
    for (let i = 0; i < 11; i++) toast(`Notice ${i}`);
    const shown: string[] = [];
    while (toasts.length) {
        shown.push(toasts[0]!.message);
        dismissToast(toasts[0]!.id);
    }
    expect(shown).toEqual(["Visible A", "Visible B", "Queued Undo", ...Array.from({ length: 9 }, (_, i) => `Notice ${i + 2}`)]);
});

test("an all-action queue preserves every recovery action even beyond its usual limit", () => {
    const messages = Array.from({ length: 13 }, (_, i) => `Undo ${i}`);
    for (const message of messages) toast(message, "info", { label: "Undo", run() {} });
    const shown: string[] = [];
    while (toasts.length) {
        shown.push(toasts[0]!.message);
        dismissToast(toasts[0]!.id);
    }
    expect(shown).toEqual(messages);
});

for (const reason of ["hover", "focus"] as const) {
    test(`an Undo plus a ${reason} notice queues overflow instead of removing either`, () => {
        toast("Undo", "info", { label: "Undo", run() {} });
        toast("Being read");
        const ids = toasts.map((t) => t.id);
        pauseToast(ids[1]!, reason, true);
        toast("Waiting");
        expect(toasts.map((t) => t.message)).toEqual(["Undo", "Being read"]);
        dismissToast(ids[0]!);
        expect(toasts.map((t) => t.message)).toEqual(["Being read", "Waiting"]);
    });

    test(`eviction preserves a toast with ${reason} while another can go`, () => {
        toast("Being read");
        const id = toasts[0]!.id;
        pauseToast(id, reason, true);
        toast("Idle");
        toast("New");
        expect(toasts.map((t) => t.message)).toEqual(["Being read", "New"]);
        advance(20_000);
        expect(toasts.map((t) => t.id)).toEqual([id]);
        pauseToast(id, reason, false);
        advance(4500);
        expect(toasts).toHaveLength(0);
    });
}

test("false turns the toast into an error that keeps its action and waits to be dismissed", async () => {
    toast("Try again", "info", { label: "Retry", run: () => false }, UNDO_DELETE_MS);
    const id = toasts[0]!.id;
    advance(9999);
    pauseToast(id, "focus", true);
    await runToastAction(id);
    advance(20_000);
    expect(toasts.map((t) => t.id)).toEqual([id]);
    expect(toasts[0]).toMatchObject({ level: "error", message: "Try again: Action failed. Try again.", action: { label: "Retry" } });
    pauseToast(id, "focus", false);
    advance(60_000);
    expect(toasts.map((t) => t.id)).toEqual([id]);
    dismissToast(id);
    expect(toasts).toHaveLength(0);
});

test("pending actions neither expire nor run twice, and dismiss after success", async () => {
    let resolve!: () => void;
    let runs = 0;
    toast("Working", "info", {
        label: "Undo",
        run: () => {
            runs++;
            return new Promise<void>((r) => {
                resolve = r;
            });
        },
    });
    const id = toasts[0]!.id;
    const pending = runToastAction(id);
    await runToastAction(id);
    advance(20_000);
    toast("First notice");
    toast("Second notice");
    expect(toasts.some((t) => t.id === id && t.running)).toBe(true);
    expect(runs).toBe(1);
    resolve();
    await pending;
    expect(toasts.some((t) => t.id === id)).toBe(false);
});

test("Send as message stays pending, retains a failed retry, and dismisses after success", async () => {
    let pending = Promise.withResolvers<any>();
    let sent = 0;
    const call = spyOn(rpc, "call")
        .mockImplementation(() => pending.promise)
        .mockRejectedValueOnce(new RpcError("Unknown command /oops", "unknown_command"));
    try {
        expect(await send("/oops", [], { to: { id: "original" }, sent: () => sent++ })).toBe(false);
        const notice = toasts.find((t) => t.action?.label === "Send as message")!;
        expect(notice).toBeDefined();
        const action = notice.action;
        const sending = runToastAction(notice.id);
        await runToastAction(notice.id);
        advance(20_000);
        expect(toasts.find((t) => t.id === notice.id)?.running).toBe(true);
        expect(call).toHaveBeenCalledTimes(2);
        expect(call).toHaveBeenLastCalledWith("session.send", expect.objectContaining({ id: "original", text: "/oops", literal: true }));
        expect(sent).toBe(0);

        pending.reject(new Error("Disconnected"));
        await sending;
        const failed = toasts.find((t) => t.id === notice.id)!;
        expect(failed).toBeDefined();
        expect(failed.level).toBe("error");
        expect(failed.running).toBe(false);
        expect(failed.action).toBe(action);
        // Reported once, in the retry toast, with the original error.
        expect(failed.message).toContain("Disconnected");
        expect(toasts.filter((t) => t.message.includes("Disconnected"))).toHaveLength(1);
        expect(sent).toBe(0);

        pending = Promise.withResolvers<any>();
        const retrying = runToastAction(notice.id);
        await runToastAction(notice.id);
        advance(20_000);
        expect(toasts.find((t) => t.id === notice.id)?.running).toBe(true);
        expect(call).toHaveBeenCalledTimes(3);
        expect(call).toHaveBeenLastCalledWith("session.send", expect.objectContaining({ id: "original", text: "/oops", literal: true }));
        expect(sent).toBe(0);
        pending.resolve({ queued: false });
        await retrying;
        expect(toasts.some((t) => t.id === notice.id)).toBe(false);
        await runToastAction(notice.id);
        expect(sent).toBe(1);
    } finally {
        call.mockRestore();
    }
});

test("both running actions queue a new toast instead of losing it", async () => {
    const finish: (() => void)[] = [];
    for (const message of ["Undo A", "Undo B"]) {
        toast(message, "info", {
            label: "Undo",
            run: () => new Promise<void>((resolve) => finish.push(resolve)),
        });
    }
    const pending = toasts.map((t) => runToastAction(t.id));
    toast("Waiting");
    advance(20_000);
    expect(toasts.map((t) => t.message)).toEqual(["Undo A", "Undo B"]);
    finish[0]!();
    await pending[0];
    expect(toasts.map((t) => t.message)).toEqual(["Undo B", "Waiting"]);
    finish[1]!();
    await pending[1];
    advance(4499);
    expect(toasts.map((t) => t.message)).toEqual(["Waiting"]);
    advance(1);
    expect(toasts).toHaveLength(0);
});

test("two failed pending actions both retain Undo and readable errors without stacking", async () => {
    const failures: ((e: Error) => void)[] = [];
    for (const message of ["Deleted A", "Deleted B"]) {
        toast(message, "info", {
            label: "Undo",
            run: () => new Promise<void>((_, reject) => failures.push(reject)),
        }, UNDO_DELETE_MS);
    }
    const ids = toasts.map((t) => t.id);
    const pending = ids.map(runToastAction);
    advance(20_000);
    for (const reject of failures) reject(new Error("Disconnected"));
    await Promise.all(pending);
    expect(toasts.map((t) => t.id)).toEqual(ids);
    expect(toasts.map((t) => t.message)).toEqual(["Deleted A: Disconnected", "Deleted B: Disconnected"]);
    expect(toasts.every((t) => t.level === "error" && t.action?.label === "Undo" && !t.running)).toBe(true);
    const retry = runToastAction(ids[0]!);
    failures[2]!(new Error("Still disconnected"));
    await retry;
    expect(toasts[0]!.message).toBe("Deleted A: Still disconnected");
    // Errors now: they wait to be dismissed, and leave the title bar's two places to the notices.
    advance(60_000);
    expect(toasts.map((t) => t.id)).toEqual(ids);
    toast("Notice A");
    toast("Notice B");
    expect(toasts.map((t) => t.message)).toEqual(["Deleted A: Still disconnected", "Deleted B: Disconnected", "Notice A", "Notice B"]);
});

test("delete then offline Undo stays available; only an explicit retry after reconnect restores", async () => {
    Socket.instances = [];
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    const creds = spyOn(rpc as unknown as { credentials: () => Promise<Credentials | undefined> }, "credentials");
    creds.mockResolvedValue({ url: "ws://test", token: "test" });
    try {
        await rpc.connect();
        const first = Socket.instances[0]!;
        first.open();
        const deleting = deleteSession("deleted-session");
        expect(first.sent[0]!.method).toBe("session.delete");
        first.message({ id: first.sent[0]!.id, result: null });
        await deleting;
        const undo = toasts.find((t) => t.action?.label === "Undo")!;
        expect(undo).toBeDefined();
        advance(9999);
        first.close();
        await runToastAction(undo.id);
        expect(toasts.some((t) => t.id === undo.id)).toBe(true);
        expect(toasts.some((t) => t.id === undo.id && t.level === "error" && t.message === "Session deleted: Not connected")).toBe(true);
        expect(first.sent.map((r) => r.method)).toEqual(["session.delete"]);
        rpc.reconnectNow();
        await Promise.resolve();
        const current = Socket.instances[1]!;
        current.open();
        advance(9999);
        expect(toasts.some((t) => t.id === undo.id)).toBe(true);
        expect(current.sent).toHaveLength(0);
        const restoring = runToastAction(undo.id);
        expect(current.sent.map((r) => r.method)).toEqual(["session.restore"]);
        expect(toasts.some((t) => t.id === undo.id)).toBe(true);
        current.message({ id: current.sent[0]!.id, result: null });
        await restoring;
        expect(toasts.some((t) => t.id === undo.id)).toBe(false);
    } finally {
        rpc.close();
        creds.mockRestore();
    }
});


test("dismissing a running Undo still reports a later restore failure", async () => {
    const restore = Promise.withResolvers<any>();
    const calls: string[] = [];
    const call = spyOn(rpc, "call").mockImplementation((method) => {
        calls.push(method);
        if (method === "session.delete") return Promise.resolve(null);
        if (method === "session.restore") return restore.promise;
        throw new Error(`Unexpected RPC: ${method}`);
    });
    try {
        await deleteSession("deleted-session");
        const undo = toasts.find((t) => t.action?.label === "Undo")!;
        const restoring = runToastAction(undo.id);
        expect(calls).toEqual(["session.delete", "session.restore"]);
        expect(toasts[0]!.running).toBe(true);
        dismissToast(undo.id);
        expect(toasts).toHaveLength(0);
        restore.reject(new Error("Restore failed"));
        await restoring;
        expect(toasts.map((t) => [t.level, t.message])).toEqual([["error", "Restore failed"]]);
        expect(toasts[0]!.id).not.toBe(undo.id);
        expect(toasts[0]!.action).toBeUndefined();
    } finally {
        call.mockRestore();
    }
});


test("saved-plan choices preserve async errors, prevent double actions, and can retry", async () => {
    const copy = Promise.withResolvers<boolean>();
    let reveals = 0;
    let copies = 0;
    toast("Saved plan.md", "success", [
        { label: "Reveal in Finder", run: () => { reveals++; } },
        { label: "Copy path", run: () => { copies++; return copy.promise; } },
    ]);
    const id = toasts[0]!.id;
    expect(toasts[0]!.additionalActions?.[0]?.label).toBe("Copy path");
    const pending = runToastChoice(id, 1);
    await runToastAction(id);
    expect(reveals).toBe(0);
    expect(copies).toBe(1);
    copy.resolve(false);
    await pending;
    expect(toasts[0]!.level).toBe("error");
    expect(toasts[0]!.additionalActions?.[0]?.label).toBe("Copy path");
    await runToastAction(id);
    expect(reveals).toBe(1);
    expect(toasts).toHaveLength(0);
});

test("failed archive does not claim success or offer Undo", async () => {
    const call = spyOn(rpc, "call").mockRejectedValue(new Error("Archive failed"));
    try {
        expect(await setArchived("session", true)).toBe(false);
        expect(toasts.map((t) => [t.level, t.message, t.action])).toEqual([["error", "Archive failed", undefined]]);
    } finally {
        call.mockRestore();
    }
});

test("managed worktree archive waits for the dialog, while ordinary folders archive directly", async () => {
    const methods: string[] = [];
    let managed = true;
    const call = spyOn(rpc, "call").mockImplementation((method) => {
        methods.push(method);
        if (method === "session.archiveOffer") return Promise.resolve(managed
            ? { removable: true, worktree: { path: "/repo/.claude/worktrees/plan", branch: "plan", main: "/repo" } }
            : { removable: false }) as any;
        return Promise.resolve(null) as any;
    });
    try {
        await archive("session", true);
        expect(methods).toEqual(["session.archiveOffer"]);
        expect(archiveRequest()?.id).toBe("session");
        expect(toasts).toHaveLength(0);
        setArchiveRequest(undefined);
        managed = false;
        expect(await archive("session", true)).toBe(true);
        expect(methods).toEqual(["session.archiveOffer", "session.archiveOffer", "session.archive"]);
        expect(toasts[0]!.message).toBe("Session archived");
    } finally {
        setArchiveRequest(undefined);
        call.mockRestore();
    }
});

test("worktree removal Undo restores only the archive and remains available after failure", async () => {
    const calls: unknown[] = [];
    let offline = true;
    const call = spyOn(rpc, "call").mockImplementation((method, params) => {
        calls.push({ method, params });
        return offline ? Promise.reject(new Error("Offline")) : Promise.resolve(null) as any;
    });
    try {
        archivedWithWorktree("session", { archived: true, removed: true, worktree: "/repo/.claude/worktrees/plan", main: "/repo" });
        const id = toasts[0]!.id;
        await runToastAction(id);
        expect(toasts[0]!.message).toBe("Session archived; worktree removed: Offline");
        expect(toasts[0]!.action?.label).toBe("Undo");
        offline = false;
        await runToastAction(id);
        expect(toasts).toHaveLength(0);
        expect(calls).toEqual(Array(2).fill({ method: "session.archive", params: { id: "session", archived: false } }));
    } finally {
        call.mockRestore();
    }
});

test("an error waits to be dismissed: no timer, hidden or not", () => {
    toast("Couldn't reach Anthropic", "error");
    const id = toasts[0]!.id;
    advance(10 * 60_000);
    pauseToast(id, "hidden", true);
    pauseToast(id, "hidden", false);
    advance(10 * 60_000);
    expect(toasts.map((t) => [t.id, t.level])).toEqual([[id, "error"]]);
    expect(timers.size).toBe(0);
    dismissToast(id);
    expect(toasts).toHaveLength(0);
});

test("a repeated error bumps its count instead of stacking", () => {
    for (let i = 0; i < 3; i++) toast("Not connected", "error");
    expect(toasts.map((t) => [t.message, t.count])).toEqual([["Not connected", 3]]);
    toast("Not connected", "info");
    expect(toasts.map((t) => [t.level, t.count])).toEqual([["error", 3], ["info", 1]]);
});

test("errors take none of the title bar's two places, and every one is kept", () => {
    toast("First notice");
    toast("Second notice");
    for (const m of ["Error A", "Error B", "Error C"]) toast(m, "error");
    expect(toasts.map((t) => t.message)).toEqual(["First notice", "Second notice", "Error A", "Error B", "Error C"]);
    // A third notice evicts a notice, never an error.
    toast("Third notice");
    expect(toasts.filter((t) => t.level !== "error").map((t) => t.message)).toEqual(["Second notice", "Third notice"]);
    expect(toasts.filter((t) => t.level === "error")).toHaveLength(3);
    advance(4500);
    expect(toasts.map((t) => t.message)).toEqual(["Error A", "Error B", "Error C"]);
});

test("past twenty errors the oldest without an action goes", () => {
    toast("Undo failed", "error", { label: "Undo", run() {} });
    for (let i = 0; i < 20; i++) toast(`Error ${i}`, "error");
    expect(toasts).toHaveLength(20);
    expect(toasts[0]!.message).toBe("Undo failed");
    expect(toasts[1]!.message).toBe("Error 1");
});

test("the same error with the same fix is one card, counted, keeping the latest fix", () => {
    const ran: number[] = [];
    for (let i = 0; i < 3; i++) toast("Keybindings not reloaded: bad JSON", "error", { label: "Show", run() { ran.push(i); } });
    expect(toasts.map((t) => [t.message, t.count, t.action?.label])).toEqual([["Keybindings not reloaded: bad JSON", 3, "Show"]]);
    toasts[0]!.action!.run();
    expect(ran).toEqual([2]);
    // A different fix is a different card.
    toast("Keybindings not reloaded: bad JSON", "error", { label: "Open file", run() {} });
    expect(toasts).toHaveLength(2);
});

test("past twenty errors that all have a fix, the oldest still goes", () => {
    for (let i = 0; i < 21; i++) toast(`Error ${i}`, "error", { label: "Retry", run() {} });
    expect(toasts).toHaveLength(20);
    expect(toasts[0]!.message).toBe("Error 1");
});

test("an Undo that fails becomes an error card and frees its place for a waiting notice", async () => {
    for (const message of ["Undo A", "Undo B"]) toast(message, "info", { label: "Undo", run: () => Promise.reject(new Error("Offline")) });
    toast("Waiting");
    expect(toasts.map((t) => t.message)).toEqual(["Undo A", "Undo B"]);
    await runToastAction(toasts[0]!.id);
    expect(toasts.map((t) => [t.level, t.message])).toEqual([["error", "Undo A: Offline"], ["info", "Undo B"], ["info", "Waiting"]]);
    advance(60_000);
    expect(toasts.map((t) => t.message)).toEqual(["Undo A: Offline"]);
});

test("an Undo that fails with twenty errors kept stays, and the oldest error goes instead, however often", async () => {
    for (let i = 0; i < 20; i++) toast(`Error ${i}`, "error", { label: "Retry", run() {} });
    for (const n of [1, 2, 3]) {
        toast(`Deleted ${n}`, "info", { label: "Undo", run: () => Promise.reject(new Error("Offline")) });
        await runToastAction(toasts.find((t) => t.message === `Deleted ${n}`)!.id);
        expect(toasts.filter((t) => t.level === "error")).toHaveLength(20);
        expect(toasts.find((t) => t.message === `Deleted ${n}: Offline`)).toMatchObject({ level: "error", running: false });
    }
    expect(toasts.map((t) => t.message).slice(0, 2)).toEqual(["Error 3", "Error 4"]);
    expect(toasts).toHaveLength(20);
});

test("a new error past the cap is kept even when it alone has no action", () => {
    for (let i = 0; i < 20; i++) toast(`Error ${i}`, "error", { label: "Retry", run() {} });
    toast("Not connected", "error");
    expect(toasts).toHaveLength(20);
    expect(toasts[0]!.message).toBe("Error 1");
    expect(toasts.at(-1)!.message).toBe("Not connected");
});
