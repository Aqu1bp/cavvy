import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// Isolate from the real ~/.cavvy before loading anything that reads paths.
const prevCavvyHome = process.env.CAVVY_HOME;
const CAVVY_HOME = mkdtempSync(join(tmpdir(), "cavvy-test-"));
process.env.CAVVY_HOME = CAVVY_HOME;

const modes = await import("../src/permissions/modes");
const { parseMode, nextMode, PERMISSION_MODES, MODE_INFO } = modes;

afterAll(() => {
    if (prevCavvyHome === undefined) delete process.env.CAVVY_HOME;
    else process.env.CAVVY_HOME = prevCavvyHome;
    rmSync(CAVVY_HOME, { recursive: true, force: true });
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

describe("the mode sessions start in", () => {
    const { defaultMode, startMode } = modes;
    test("here: Manual, or what settings say; a project can't turn Bypass on", () => {
        expect(defaultMode({}, CAVVY_HOME, false, false)).toEqual({ mode: "default", ignoredBypass: false });
        expect(defaultMode({ permissions: { defaultMode: "auto" } }, CAVVY_HOME, false, false)).toEqual({ mode: "auto", ignoredBypass: false });
        expect(defaultMode({ permissions: { defaultMode: "bypassPermissions" } }, CAVVY_HOME, false, false)).toEqual({ mode: "default", ignoredBypass: true });
        expect(defaultMode({ permissions: { defaultMode: "bypassPermissions" } }, CAVVY_HOME, true, false)).toEqual({ mode: "bypassPermissions", ignoredBypass: false });
    });

    test("on one of the user's servers: Bypass, unless its settings name another", () => {
        expect(defaultMode({}, CAVVY_HOME, false, true)).toEqual({ mode: "bypassPermissions", ignoredBypass: false });
        expect(defaultMode({ permissions: {} }, CAVVY_HOME, false, true).mode).toBe("bypassPermissions");
        expect(defaultMode({ permissions: { defaultMode: "default" } }, CAVVY_HOME, false, true).mode).toBe("default");
        expect(defaultMode({ permissions: { defaultMode: "auto" } }, CAVVY_HOME, false, true).mode).toBe("auto");
        expect(defaultMode({ permissions: { defaultMode: "bypassPermissions" } }, CAVVY_HOME, false, true)).toEqual({ mode: "bypassPermissions", ignoredBypass: false });
    });

    test("a mode asked for wins everywhere", () => {
        expect(startMode("plan", {}, CAVVY_HOME, false, true).mode).toBe("plan");
        expect(startMode("default", {}, CAVVY_HOME, false, true).mode).toBe("default");
        expect(startMode(undefined, {}, CAVVY_HOME, false, true).mode).toBe("bypassPermissions");
        expect(startMode(undefined, {}, CAVVY_HOME, false, false).mode).toBe("default");
    });

    test("a machine is a server once Cavvy was put on it from another: the mark in its own folder", async () => {
        const { onServer, forgetServerRole, SERVER_MARK } = await import("../src/servers/role");
        const { mkdirSync, writeFileSync } = await import("fs");
        forgetServerRole();
        expect(onServer()).toBe(false);
        expect(defaultMode({}, CAVVY_HOME).mode).toBe("default");
        mkdirSync(join(CAVVY_HOME, "server"), { recursive: true });
        writeFileSync(join(CAVVY_HOME, "server", SERVER_MARK), "");
        // Looked at once: a running Cavvy doesn't change what it is.
        expect(onServer()).toBe(false);
        forgetServerRole();
        expect(onServer()).toBe(true);
        expect(defaultMode({}, CAVVY_HOME).mode).toBe("bypassPermissions");
        rmSync(join(CAVVY_HOME, "server"), { recursive: true, force: true });
        forgetServerRole();
    });
});
