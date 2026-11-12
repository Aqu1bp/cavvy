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

test("carried on by itself only so often within the hour: after that it's taken off the list", () => {
    const file = join(dir, "b.json");
    const w = new WorkingIndex(file);
    w.started("one", "/srv/app");
    const t = 1_000_000_000_000;
    for (let i = 0; i < MAX_RESTART_RESUMES; i++) expect(new WorkingIndex(file).resume("one", t + i * 1000)).toBe(true);
    const again = new WorkingIndex(file);
    expect(again.resume("one", t + 60_000)).toBe(false);
    expect(kept(file)).toEqual([]);
    // Long enough after, it has its share again.
    w.started("two", "/srv/site");
    const later = new WorkingIndex(file);
    for (let i = 0; i < MAX_RESTART_RESUMES; i++) later.resume("two", t);
    expect(new WorkingIndex(file).resume("two", t + RESUME_WINDOW_MS + 1)).toBe(true);
    expect(new WorkingIndex(file).resume("gone")).toBe(false);
});

test("a list that isn't one is read as none; entries that aren't sessions are dropped", () => {
    const file = join(dir, "c.json");
    writeFileSync(file, "not json");
    expect(new WorkingIndex(file).entries()).toEqual([]);
    writeFileSync(file, JSON.stringify({ sessions: { ok: { cwd: "/srv/app", resumed: [1, "x", 2] }, "../bad": { cwd: "/x" }, nocwd: {}, list: [] } }));
    expect(new WorkingIndex(file).entries()).toEqual([["ok", { cwd: "/srv/app", resumed: [1, 2] }]]);
});
