import { expect, test } from "bun:test";

const { toastMs, UNDO_DELETE_MS, ToastLifetime, repeatedToast } = await import("../gui/src/lib/toasts");

test("the Undo after a delete stays about 10 seconds; other toasts keep their timing", () => {
    expect(UNDO_DELETE_MS).toBe(10_000);
    expect(toastMs("info", UNDO_DELETE_MS)).toBe(10_000);
    expect(toastMs("info")).toBe(4500);
    expect(toastMs("success")).toBe(4500);
    expect(toastMs("warn")).toBe(4500);
    expect(toastMs("error")).toBe(8000);
});

test("hover, focus, and hidden pauses overlap without losing remaining time", () => {
    const life = new ToastLifetime(4500, 0);
    life.pause("hover", 1000);
    life.pause("focus", 2000);
    life.pause("hidden", 3000);
    life.resume("hover", 10_000);
    life.resume("focus", 11_000);
    expect(life.paused).toBe(true);
    expect(life.remaining(20_000)).toBe(3500);
    life.resume("hidden", 20_000);
    expect(life.remaining(23_499)).toBe(1);
    expect(life.remaining(23_500)).toBe(0);
});

test("repeats renew the duration but keep focus and visibility pauses", () => {
    const life = new ToastLifetime(8000, 0);
    life.pause("focus", 7000);
    life.restart(8000, 10_000);
    expect(life.paused).toBe(true);
    expect(life.remaining(30_000)).toBe(8000);
    life.resume("focus", 30_000);
    expect(life.remaining(37_999)).toBe(1);
});

test("only actionless repeats of the same message and level merge", () => {
    const item = { id: 1, message: "Not connected", level: "info" as const, count: 1 };
    expect(repeatedToast([item], item.message, "info")).toBe(item);
    expect(repeatedToast([item], item.message, "error")).toBeUndefined();
    expect(repeatedToast([item], "Different message", "info")).toBeUndefined();
    expect(repeatedToast([item], item.message, "info", { label: "Undo", run() {} })).toBeUndefined();
});

test("Undo toasts stay separate even when their messages and action labels match", () => {
    const undo = { label: "Undo", run() {} };
    const item = { id: 1, message: "Session deleted", level: "info" as const, count: 1, action: undo };
    expect(repeatedToast([item], item.message, "info", undo)).toBeUndefined();
    expect(repeatedToast([item], item.message, "info", { label: "Undo", run() {} })).toBeUndefined();
    expect(repeatedToast([item], item.message, "info")).toBeUndefined();
});
