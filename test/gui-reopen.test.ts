import { expect, test } from "bun:test";

const { afterFailedReopen } = await import("../gui/src/lib/reopen");

test("a session that couldn't be opened again: deleted on not_found, kept while disconnected, dropped otherwise", () => {
    expect(afterFailedReopen("not_found")).toBe("forget");
    expect(afterFailedReopen("disconnected")).toBe("keep");
    expect(afterFailedReopen("in_use")).toBe("drop");
    expect(afterFailedReopen(undefined)).toBe("drop");
});
