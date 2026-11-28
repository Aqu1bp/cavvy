// When the title bar asks the server for a branch's ahead/behind counts again (gui/src/lib/branch-sync.ts): each ask
// is a git process, so a turn starting, or its edits landing, doesn't ask.
import { expect, test } from "bun:test";
import { syncReadSkipped, type SyncReadKey } from "../gui/src/lib/branch-sync";

const key = (o: Partial<SyncReadKey> = {}): SyncReadKey => ({ cwd: "/p", id: "s1", branch: "main", busy: false, outside: 0, moved: 0, ...o });

test("the first read happens", () => {
    expect(syncReadSkipped(key())).toBe(false);
    expect(syncReadSkipped(key({ busy: true }))).toBe(false);
});

test("a turn starting doesn't read; its end does", () => {
    expect(syncReadSkipped(key({ busy: true }), key())).toBe(true);
    expect(syncReadSkipped(key(), key({ busy: true }))).toBe(false);
});

test("coming back to the window, a Git action, another branch, session or folder read, even mid-turn", () => {
    const was = key();
    expect(syncReadSkipped(key({ busy: true, outside: 1 }), was)).toBe(false);
    expect(syncReadSkipped(key({ busy: true, moved: 1 }), was)).toBe(false);
    expect(syncReadSkipped(key({ busy: true, branch: "topic" }), was)).toBe(false);
    expect(syncReadSkipped(key({ busy: true, id: "s2" }), was)).toBe(false);
    expect(syncReadSkipped(key({ busy: true, cwd: "/q" }), was)).toBe(false);
    expect(syncReadSkipped(key({ outside: 1 }), key({ busy: true }))).toBe(false);
});
