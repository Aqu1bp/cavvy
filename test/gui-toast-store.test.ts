import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { toast, toasts, pauseToast, dismissToast, runToastAction, rpc } from "../gui/src/state/app";
import { deleteSession, send } from "../gui/src/state/actions";
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

test("false renews an action's lifetime and keeps overlapping focus pauses", async () => {
    toast("Try again", "info", { label: "Retry", run: () => false }, UNDO_DELETE_MS);
    const id = toasts[0]!.id;
    advance(9999);
    pauseToast(id, "focus", true);
    await runToastAction(id);
    advance(20_000);
    expect(toasts.map((t) => t.id)).toEqual([id]);
    pauseToast(id, "focus", false);
    advance(9999);
    expect(toasts).toHaveLength(1);
    advance(1);
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
    advance(9999);
    expect(toasts).toHaveLength(2);
    advance(1);
    expect(toasts).toHaveLength(0);
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
