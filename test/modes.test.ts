import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate from the real ~/.harness before loading anything that reads paths.
const prevHarnessHome = process.env.HARNESS_HOME;
const HARNESS_HOME = mkdtempSync(join(tmpdir(), "harness-test-"));
process.env.HARNESS_HOME = HARNESS_HOME;

const { parseMode, nextMode, PERMISSION_MODES, MODE_INFO } = await import("../src/permissions/modes");

afterAll(() => {
    if (prevHarnessHome === undefined) delete process.env.HARNESS_HOME;
    else process.env.HARNESS_HOME = prevHarnessHome;
    rmSync(HARNESS_HOME, { recursive: true, force: true });
});

describe("parseMode", () => {
    test.each([
        ["default", "default"],
        ["manual", "default"],
        ["Normal", "default"],
        ["ASK", "default"],
        ["acceptEdits", "acceptEdits"],
        ["accept-edits", "acceptEdits"],
        ["accept_edits", "acceptEdits"],
        ["accept", "acceptEdits"],
        ["edits", "acceptEdits"],
        ["plan", "plan"],
        ["plan-mode", "plan"],
        ["auto", "auto"],
        ["Auto Mode", "auto"],
        ["bypass", "bypassPermissions"],
        ["bypassPermissions", "bypassPermissions"],
        ["yolo", "bypassPermissions"],
        ["--dangerously-skip-permissions", "bypassPermissions"],
    ] as const)("%p -> %p", (s, mode) => {
        expect(parseMode(s)).toBe(mode);
    });

    test.each([undefined, "", "nope", "bypass-all", "123"])("%p -> undefined", (s) => {
        expect(parseMode(s)).toBeUndefined();
    });

    test("every canonical mode name round-trips", () => {
        for (const m of PERMISSION_MODES) expect(parseMode(m)).toBe(m);
    });
});

describe("nextMode", () => {
    test("cycles default -> acceptEdits -> plan -> auto -> default without bypass", () => {
        expect(nextMode("default", false)).toBe("acceptEdits");
        expect(nextMode("acceptEdits", false)).toBe("plan");
        expect(nextMode("plan", false)).toBe("auto");
        expect(nextMode("auto", false)).toBe("default");
    });

    test("includes bypassPermissions only when allowed", () => {
        expect(nextMode("auto", true)).toBe("bypassPermissions");
        expect(nextMode("bypassPermissions", true)).toBe("default");
    });

    test("leaving bypass when it is not allowed goes back to default", () => {
        expect(nextMode("bypassPermissions", false)).toBe("default");
    });

    test("never reaches bypass when not allowed", () => {
        let m = nextMode("default", false);
        for (let i = 0; i < 10; i++, m = nextMode(m, false)) expect(m).not.toBe("bypassPermissions");
    });
});

test("every mode has display info", () => {
    expect(PERMISSION_MODES).toEqual(["default", "acceptEdits", "plan", "auto", "bypassPermissions"]);
    for (const m of PERMISSION_MODES) expect(MODE_INFO[m].label.length).toBeGreaterThan(0);
});
