// What Settings → About and the rail say about the desktop app's updates from
// main (gui/src/lib/app-update.ts), in each state the server can report.
import { describe, expect, test } from "bun:test";
import type { AppUpdateInfo } from "../src/server/protocol";

const { updateView } = await import("../gui/src/lib/app-update");

const base: AppUpdateInfo = { available: false, changes: [], behind: 0, checking: false, installed: "abc1234", latest: "def5678" };
const NOW = Date.parse("2026-10-24T12:00:00Z");

test("nothing from the server (an older one): nothing to show", () => {
    expect(updateView(undefined, 0)).toBeUndefined();
});

test("can't update itself: why, and no button anywhere", () => {
    const v = updateView({ ...base, unavailable: "Only the installed desktop app updates itself." }, 0)!;
    expect(v).toMatchObject({ title: "Updates from main", detail: "Only the installed desktop app updates itself.", busy: false });
    expect(v.action).toBeUndefined();
    expect(v.rail).toBeUndefined();
});

test("up to date: when it was checked, and Check now; nothing in the rail", () => {
    const v = updateView({ ...base, checkedAt: NOW - 5 * 60_000 }, 0, NOW)!;
    expect(v).toMatchObject({ title: "Cavvy is up to date", detail: "Built from main abc1234 · checked 5m ago", action: "check" });
    expect(v.rail).toBeUndefined();
    expect(updateView({ ...base, checkedAt: NOW - 10_000 }, 0, NOW)!.detail).toContain("checked just now");
});

test("checked, but never compared with main (no fetch, and no main from before): it says so, not that it's up to date", () => {
    const { installed: _i, latest: _l, ...never } = base;
    const v = updateView({ ...never, checkedAt: NOW, error: "Couldn't fetch main: Permission denied (publickey)." }, 0, NOW)!;
    expect(v).toMatchObject({ title: "Couldn't check for updates", action: "check", busy: false });
    expect(v.detail).toBeUndefined();
    expect(v.rail).toBeUndefined();
});

test("not checked yet, and checking", () => {
    expect(updateView(base, 0)).toMatchObject({ detail: "Not checked yet.", action: "check", busy: false });
    expect(updateView({ ...base, checking: true }, 0)).toMatchObject({ title: "Checking for updates…", busy: true });
});

test("an update: how many changes, Update & restart, and the rail's button", () => {
    const v = updateView({ ...base, available: true, behind: 4, checkedAt: NOW }, 0, NOW)!;
    expect(v).toMatchObject({ title: "4 new changes on main", detail: "This build abc1234 · main def5678 · checked just now", action: "update", busy: false });
    expect(v.rail).toEqual({ state: "ready", label: "4 new changes on main. Click to update and restart Cavvy." });
    expect(updateView({ ...base, available: true, behind: 1 }, 0)!.title).toBe("1 new change on main");
    // A check in flight doesn't take the update away.
    expect(updateView({ ...base, available: true, behind: 1, checking: true }, 0)).toMatchObject({ action: "update", busy: true });
});

test("an update with no list: what's odd about this build instead", () => {
    const v = updateView({ ...base, available: true, note: "This build is from a branch that isn't on main." }, 0)!;
    expect(v.title).toBe("An update from main");
    expect(v.detail).toBe("This build abc1234 · main def5678 · This build is from a branch that isn't on main.");
});

test("sessions working: the restart would stop them", () => {
    expect(updateView({ ...base, available: true, behind: 2 }, 1)!.warn).toBe("1 session working: restarting stops it.");
    expect(updateView({ ...base, available: true, behind: 2 }, 3)!.warn).toBe("3 sessions working: restarting stops them.");
    expect(updateView({ ...base, available: true, behind: 2 }, 0)!.warn).toBeUndefined();
});

test("updating: the build's last line, a spinner, and the rail says so", () => {
    const v = updateView({ ...base, available: true, behind: 2, updating: { startedAt: NOW, line: "Compiling tauri v2.1.0", restarting: false } }, 2)!;
    // Not the hash the last check saw: the update fetches main again, and builds what's there then.
    expect(v).toMatchObject({ title: "Updating to the latest main…", detail: "Compiling tauri v2.1.0", busy: true });
    expect(v.action).toBeUndefined();
    expect(v.warn).toContain("2 sessions working then will stop");
    expect(v.rail).toEqual({ state: "busy", label: "Updating Cavvy: Compiling tauri v2.1.0" });
});

test("restarting: installed, and the app is about to go", () => {
    const v = updateView({ ...base, updating: { startedAt: NOW, line: "x", restarting: true } }, 0)!;
    expect(v).toMatchObject({ title: "Restarting Cavvy…", busy: true, rail: { state: "busy", label: "The update is installed: Cavvy is restarting" } });
});

test("a failed update: the rail's icon turns red, to try again; the card still offers the update", () => {
    const v = updateView({ ...base, available: true, behind: 2, failed: "The update failed: error: no space left" }, 0)!;
    expect(v.rail).toEqual({ state: "failed", label: "The update failed: error: no space left. Click to try again." });
    expect(v.action).toBe("update");
    // Nothing left to update (a check since found main installed): no icon, whatever went wrong before.
    expect(updateView({ ...base, checkedAt: NOW, failed: "x" }, 0, NOW)!.rail).toBeUndefined();
});

// A downloaded app (a release build): versions, not commits, and the latest release, not main.
describe("a downloaded app", () => {
    const rel: AppUpdateInfo = { available: false, changes: [], behind: 0, checking: false, release: true, installed: "1.2.0" };

    test("can't update where it is: says what to do, no button, nothing in the rail", () => {
        const v = updateView({ ...rel, unavailable: "Move Cavvy to Applications to update it." }, 0)!;
        expect(v).toEqual({ title: "Updates", detail: "Move Cavvy to Applications to update it.", busy: false });
    });
    test("not checked yet; up to date", () => {
        expect(updateView(rel, 0)).toMatchObject({ title: "Updates", detail: "Not checked yet.", action: "check" });
        const v = updateView({ ...rel, latest: "1.2.0", checkedAt: NOW - 5 * 60_000 }, 0, NOW)!;
        expect(v).toMatchObject({ title: "Cavvy is up to date", detail: "1.2.0 · checked 5m ago", action: "check" });
        expect(v.rail).toBeUndefined();
    });
    test("a newer release: its version, its notes, Update; the rail's icon", () => {
        const v = updateView({ ...rel, available: true, latest: "1.3.0", notes: "https://github.com/Aqu1bp/cavvy/releases/tag/v1.3.0", checkedAt: NOW }, 0, NOW)!;
        expect(v).toMatchObject({ title: "Cavvy 1.3.0 is available", detail: "This is 1.2.0 · checked just now", action: "update", notes: "https://github.com/Aqu1bp/cavvy/releases/tag/v1.3.0" });
        expect(v.rail).toEqual({ state: "ready", label: "Cavvy 1.3.0 is available. Click to update and restart Cavvy." });
        expect(updateView({ ...rel, available: true, latest: "1.3.0" }, 2)!.warn).toBe("2 sessions working: restarting stops them.");
    });
    test("needs a newer macOS: said, no Update, nothing in the rail", () => {
        const v = updateView({ ...rel, available: true, latest: "1.3.0", needsSystem: "14.0" }, 0)!;
        expect(v).toMatchObject({ problem: "This update needs macOS 14.0.", action: "check" });
        expect(v.rail).toBeUndefined();
    });
    test("downloading: the share in the rail's ring and its tooltip; then restarting", () => {
        const v = updateView({ ...rel, available: true, latest: "1.3.0", updating: { startedAt: NOW, line: "Downloading… 42%", restarting: false, progress: 0.42 } }, 0)!;
        expect(v).toMatchObject({ title: "Updating to Cavvy 1.3.0…", detail: "Downloading… 42%", busy: true });
        expect(v.rail).toEqual({ state: "busy", label: "Updating Cavvy: Downloading… 42%", progress: 0.42 });
        expect(updateView({ ...rel, ready: true, latest: "1.3.0", updating: { startedAt: NOW, line: "Restarting Cavvy…", restarting: true } }, 0)).toMatchObject({ title: "Restarting Cavvy…", busy: true });
    });
    test("downloaded and checked, the restart cancelled: ready, Restart", () => {
        const v = updateView({ ...rel, available: true, latest: "1.3.0", ready: true }, 0)!;
        expect(v).toMatchObject({ title: "Cavvy 1.3.0 is ready", detail: "Restart Cavvy to finish updating.", action: "restart" });
        expect(v.rail).toEqual({ state: "ready", label: "Cavvy 1.3.0 is ready. Click to restart." });
    });
    test("failed: the rail says it couldn't, About has the one reason (Settings shows `failed`)", () => {
        const v = updateView({ ...rel, available: true, latest: "1.3.0", failed: "The download isn't signed by Cavvy." }, 0)!;
        expect(v.rail).toEqual({ state: "failed", label: "Couldn't update. Click to try again." });
        expect(v.action).toBe("update");
    });
});
