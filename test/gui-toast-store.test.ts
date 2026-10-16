import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { toast, toasts, pauseToast, dismissToast, runToastAction, rpc } from "../gui/src/state/app";
import { deleteSession } from "../gui/src/state/actions";
import { UNDO_DELETE_MS } from "../gui/src/lib/toasts";
import type { Credentials } from "../gui/src/lib/rpc";
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
    for (const item of [...toasts]) dismissToast(item.id);
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

test("an all-action list evicts the oldest action", () => {
    for (const message of ["First", "Second", "Third"]) toast(message, "info", { label: "Undo", run() {} });
    expect(toasts.map((t) => t.message)).toEqual(["Second", "Third"]);
});

for (const reason of ["hover", "focus"] as const) {
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
