// The setup script's tickets (src/server/setup.ts) on their own, and what the
// New worktree dialog says about the script (gui/src/lib/setup.ts). The runs
// themselves are tested over RPC in gui-server.test.ts.

import { afterAll, describe, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { SETUP_TTL_MS, SetupTickets } = await import("../src/server/setup");
const { asksForSetup, setupNote, setupTabLabel } = await import("../gui/src/lib/setup");
afterAll(() => iso.cleanup());

const grant = (owner: object, path = "/repo/.claude/worktrees/x") => ({ owner, path, main: "/repo", project: "/repo", script: "s1", command: "bun install" });

describe("setup tickets", () => {
    test("single use, for the window that was given it, until they expire", () => {
        let now = 1_000;
        const tickets = new SetupTickets(() => now);
        const a = {};
        const b = {};
        const t1 = tickets.issue(grant(a));
        expect(t1).toMatch(/^[0-9a-f]{32}$/);
        expect(tickets.take(a, t1)).toMatchObject({ path: "/repo/.claude/worktrees/x", script: "s1", command: "bun install", expires: 1_000 + SETUP_TTL_MS });
        expect(() => tickets.take(a, t1)).toThrow(/already started/);
        const t2 = tickets.issue(grant(a));
        expect(() => tickets.take(b, t2)).toThrow(/another window/);
        expect(() => tickets.take(a, t2)).toThrow(/already started/);
        const t3 = tickets.issue(grant(a));
        now += SETUP_TTL_MS;
        expect(() => tickets.take(a, t3)).toThrow(/in time/);
        expect(tickets.size).toBe(0);
    });

    test("a window's tickets go when it does; there are never many, and stale ones are swept", () => {
        let now = 0;
        const tickets = new SetupTickets(() => now);
        const a = {};
        const b = {};
        const kept = tickets.issue(grant(b));
        for (let i = 0; i < 5; i++) tickets.issue(grant(a));
        tickets.drop(a);
        expect(tickets.size).toBe(1);
        expect(tickets.take(b, kept).owner).toBe(b);
        const issued = Array.from({ length: 100 }, () => tickets.issue(grant(a)));
        expect(tickets.size).toBe(32);
        expect(new Set(issued).size).toBe(100);
        // The oldest went first.
        expect(() => tickets.take(a, issued[0]!)).toThrow(/already started/);
        expect(tickets.take(a, issued[99]!).owner).toBe(a);
        now += SETUP_TTL_MS;
        tickets.issue(grant(a));
        expect(tickets.size).toBe(1);
    });

    test("anything but a ticket's shape is invalid", () => {
        const tickets = new SetupTickets();
        for (const bad of [undefined, null, 7, "", "abc", "A".repeat(32), "0".repeat(31), "0".repeat(33), {}]) {
            expect(() => tickets.take({}, bad)).toThrow(expect.objectContaining({ code: "invalid" }));
        }
    });
});

describe("what the New worktree dialog says", () => {
    const script = { id: "s1", name: "install", command: "bun install && cp ../../../.env ." };

    test("runs, unless skipped, only for a marked script in a trusted repository", () => {
        expect(setupNote(undefined)).toEqual({ kind: "loading" });
        expect(setupNote({ main: "/repo", trusted: true })).toEqual({ kind: "none" });
        expect(setupNote({ main: "/repo", trusted: false })).toEqual({ kind: "none" });
        expect(setupNote({ main: "/repo", script, trusted: true })).toEqual({ kind: "runs", script });
        expect(setupNote({ main: "/repo", script, trusted: false })).toEqual({ kind: "untrusted", script, main: "/repo" });
        expect(setupNote({ main: "/repo", script, trusted: true }, "scripts.json is broken")).toEqual({ kind: "error", message: "scripts.json is broken" });
        expect(asksForSetup(setupNote({ main: "/repo", script, trusted: true }), false)).toBe(true);
        expect(asksForSetup(setupNote({ main: "/repo", script, trusted: true }), true)).toBe(false);
        for (const note of [setupNote(undefined), setupNote({ main: "/repo", trusted: true }), setupNote({ main: "/repo", script, trusted: false }), setupNote(undefined, "error")]) {
            expect(asksForSetup(note, false)).toBe(false);
        }
    });

    test("the tab is named after the worktree's folder", () => {
        expect(setupTabLabel("/repo/.claude/worktrees/feat-x")).toBe("Setup · feat-x");
        expect(setupTabLabel("/elsewhere/feat-y/")).toBe("Setup · feat-y");
    });
});
