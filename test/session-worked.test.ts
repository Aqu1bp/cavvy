// When a session last worked, as its file says (Session.worked): the sidebar's order, which writes that aren't work
// (a repair on loading, a rename, idle compaction) don't change.
import { afterAll, expect, test } from "bun:test";
import { appendFileSync, readFileSync, realpathSync, statSync, utimesSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Session, listAllSessions, listSessions } = await import("../src/agent/session");
afterAll(() => iso.cleanup());

const HOUR = 3_600_000;
const worked = (file: string) => readFileSync(file, "utf8").split("\n").filter((l) => l.startsWith('{"t":"worked"')).map((l) => JSON.parse(l).at as number);

/** A session written `ago` ms ago, from before worked lines. */
function legacy(cwd: string, text: string, ago: number) {
    const s = Session.create(cwd);
    s.push({ role: "user", content: [{ type: "text", text }] });
    s.push({ role: "assistant", content: [{ type: "text", text: "Done." }] } as never);
    s.release();
    const at = (Date.now() - ago) / 1000;
    utimesSync(s.path, at, at);
    return s;
}

test("work is a line a minute at most while it goes on; a turn's start and end, and letting go, write at once", () => {
    const s = Session.create(realpathSync(tempDir()));
    s.worked(1000, true);
    s.push({ role: "user", content: [{ type: "text", text: "Go" }] });
    s.worked(2000);
    s.worked(30_000);
    expect(worked(s.path)).toEqual([1000]);
    s.worked(61_000);
    expect(worked(s.path)).toEqual([1000, 61_000]);
    s.worked(70_000);
    s.worked(65_000);
    expect(s.workedAt).toBe(70_000);
    s.release();
    expect(worked(s.path)).toEqual([1000, 61_000, 70_000]);
    expect(Session.load(s.path).workedAt).toBe(70_000);
});

test("one from before worked lines keeps its file's time through a repair on loading and a rename", () => {
    const cwd = realpathSync(tempDir());
    const s = Session.create(cwd);
    s.push({ role: "user", content: [{ type: "text", text: "Run it" }] });
    s.push({ role: "assistant", content: [{ type: "tool_call", id: "c1", name: "Bash", input: { command: "ls" } }] } as never);
    s.release();
    // Torn as a crash leaves it, too.
    appendFileSync(s.path, '{"t":"msg","m":{"role":"us');
    const at = Date.now() - HOUR;
    utimesSync(s.path, at / 1000, at / 1000);
    const loaded = Session.load(s.path);
    expect(loaded.messages).toHaveLength(3);
    loaded.setTitle("Renamed");
    loaded.release();
    expect(statSync(s.path).mtimeMs).toBeGreaterThan(Date.now() - 5000);
    expect(worked(s.path).map(Math.round)).toEqual([Math.round(at)]);
    expect(Math.round(listSessions(cwd)[0]!.updatedAt)).toBe(Math.round(at));
    // Loading it again doesn't write another.
    Session.load(s.path).release();
    expect(worked(s.path)).toHaveLength(1);
});

test("the listing goes by work, reading past newer files that only a rename wrote", () => {
    const cwd = realpathSync(tempDir());
    const recent = legacy(cwd, "Worked a minute ago", 60_000);
    // Worked two to four hours ago, renamed now: their files are newer than the one that worked last.
    const others = [2, 3, 4].map((h) => legacy(cwd, `Worked ${h} hours ago`, h * HOUR));
    for (const o of others) {
        const l = Session.load(o.path);
        l.setTitle("Renamed now");
        l.release();
        expect(statSync(o.path).mtimeMs).toBeGreaterThan(statSync(recent.path).mtimeMs);
    }
    expect(listSessions(cwd, 1).map((s) => s.id)).toEqual([recent.meta.id]);
    expect(listSessions(cwd, 4).map((s) => s.id)).toEqual([recent, ...others].map((s) => s.meta.id));
    // Across projects too (an earlier test's sessions among them).
    expect(listAllSessions(1).map((s) => s.id)).toEqual([recent.meta.id]);
});

test("a work time after its file was last written (a clock set back since) counts as the file's time", () => {
    const cwd = realpathSync(tempDir());
    const ahead = Session.create(cwd);
    ahead.push({ role: "user", content: [{ type: "text", text: "Worked under a clock an hour fast" }] });
    ahead.worked(Date.now() + HOUR, true);
    ahead.release();
    const writtenAt = Date.now() - 3 * HOUR;
    utimesSync(ahead.path, writtenAt / 1000, writtenAt / 1000);
    const other = legacy(cwd, "Worked two hours ago", 2 * HOUR);
    expect(Math.round(Session.load(ahead.path).workedAt!)).toBe(Math.round(writtenAt));
    // So the listing, which reads newest files first and stops once the rest can't be listed, still finds the newest.
    expect(listSessions(cwd, 1).map((s) => s.id)).toEqual([other.meta.id]);
    expect(listSessions(cwd, 2).map((s) => s.id)).toEqual([other.meta.id, ahead.meta.id]);
});
