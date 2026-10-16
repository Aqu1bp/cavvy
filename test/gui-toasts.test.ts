import { expect, test } from "bun:test";

const { toastMs, UNDO_DELETE_MS } = await import("../gui/src/lib/toasts");

test("the Undo after a delete stays about 10 seconds; other toasts keep their timing", () => {
    expect(UNDO_DELETE_MS).toBe(10_000);
    expect(toastMs("info", UNDO_DELETE_MS)).toBe(10_000);
    expect(toastMs("info")).toBe(4500);
    expect(toastMs("success")).toBe(4500);
    expect(toastMs("warn")).toBe(4500);
    expect(toastMs("error")).toBe(8000);
});
