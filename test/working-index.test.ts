// The list a server's Cavvy keeps of sessions with a turn running (src/server/working.ts): what's read back after
// a restart, and how often a session is carried on by itself.

import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { MAX_RESTART_RESUMES, RESUME_WINDOW_MS, WorkingIndex } from "../src/server/working";

const dir = mkdtempSync(join(tmpdir(), "cavvy-working-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const kept = (file: string) => (existsSync(file) ? Object.keys(JSON.parse(readFileSync(file, "utf-8")).sessions) : []);

test("a session is on the list from its turn's start to its end, and the list is read back by the next Cavvy", () => {
    const file = join(dir, "a", "working.json");
    const w = new WorkingIndex(file);
    expect(w.entries()).toEqual([]);
    w.started("one", "/srv/app");
    w.started("two", "/srv/site");
    w.started("one", "/srv/app");
    expect(kept(file)).toEqual(["one", "two"]);
    w.ended("two");
    expect(new WorkingIndex(file).entries()).toEqual([["one", { cwd: "/srv/app" }]]);
    w.ended("one");
    // Nothing working: no file is left.
    expect(existsSync(file)).toBe(false);
    w.ended("never there");
});

test("carried on by itself only so often within the hour, however its turns ended between: after that it's taken off the list", () => {
    const file = join(dir, "b.json");
    const t = 1_000_000_000_000;
    const at = (ms: number) => new WorkingIndex(file, () => t + ms);
    at(0).started("one", "/srv/app");
    for (let i = 0; i < MAX_RESTART_RESUMES; i++) {
        const w = at(i * 1000);
        expect(w.resume("one")).toBe("go");
        // The turn it was given ends, and another starts before Cavvy goes down again: it still counts.
        w.ended("one");
        expect(kept(file)).toEqual([]);
        w.started("one", "/srv/app");
    }
    expect(at(60_000).resume("one")).toBe("capped");
    expect(kept(file)).toEqual([]);
    // Off the list (its turn ended since the list was read, or it never was on it): nothing to carry on or to say.
    expect(at(61_000).resume("one")).toBe("gone");
    expect(at(61_000).resume("never")).toBe("gone");
    // Long enough after, it has its share again, and what's past isn't kept.
    at(62_000).started("one", "/srv/app");
    expect(at(RESUME_WINDOW_MS + 5000).resume("one")).toBe("go");
    at(2 * RESUME_WINDOW_MS + 6000).ended("one");
    expect(existsSync(file)).toBe(false);
});

test("a list that isn't one is read as none; entries that aren't sessions are dropped", () => {
    const file = join(dir, "c.json");
    writeFileSync(file, "not json");
    expect(new WorkingIndex(file).entries()).toEqual([]);
    writeFileSync(file, JSON.stringify({ sessions: { ok: { cwd: "/srv/app" }, "../bad": { cwd: "/x" }, nocwd: {}, list: [] }, carried: { ok: [1, "x", Date.now()], "../bad": [Date.now()], odd: "x" } }));
    const w = new WorkingIndex(file);
    expect(w.entries()).toEqual([["ok", { cwd: "/srv/app" }]]);
    w.started("two", "/srv/site");
    expect(Object.keys(JSON.parse(readFileSync(file, "utf-8")).carried)).toEqual(["ok"]);
});
