import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { KIND, statFiles, statHere } from "../src/agent/stat-files";

const root = mkdtempSync(join(tmpdir(), "stat-files-"));
afterAll(() => {
    chmodSync(join(root, "locked"), 0o700);
    rmSync(root, { recursive: true, force: true });
});

test("the worker finds what this thread does: files, links, folders, what's missing, and nothing through a linked folder", async () => {
    mkdirSync(join(root, "dir/sub"), { recursive: true });
    writeFileSync(join(root, "a.txt"), "a\n");
    writeFileSync(join(root, "dir/sub/b.txt"), "bb\n");
    symlinkSync("a.txt", join(root, "link"));
    symlinkSync(join(root, "dir"), join(root, "linked-dir"));
    mkdirSync(join(root, "locked"));
    writeFileSync(join(root, "locked/c.txt"), "c\n");
    chmodSync(join(root, "locked"), 0);
    const tracked = ["a.txt", "dir/sub/b.txt", "link", "dir", "gone.txt", "linked-dir/sub/b.txt"];
    const untracked = ["locked/c.txt"];
    const deadline = Date.now() + 10_000;
    const viaWorker = await statFiles(root, `${root}:1`, tracked, untracked, deadline, () => {});
    const here = await statHere(root, tracked, untracked, () => {});
    expect([...viaWorker.kinds]).toEqual([...here.kinds]);
    expect([...viaWorker.stamps]).toEqual([...here.stamps]);
    expect([...here.kinds].slice(0, 6)).toEqual([KIND.file, KIND.file, KIND.link, KIND.dir, KIND.missing, KIND.missing]);
    // A folder that can't be read (as anyone but root): what's in it can't be told apart from gone.
    if (process.getuid?.() !== 0) expect(here.kinds[6]).toBe(KIND.unreadable);
    expect(here.stamps[3]).toBe(2); // a.txt's size
    // The same list again: the worker kept it, and answers the same.
    const again = await statFiles(root, `${root}:1`, tracked, untracked, deadline, () => {});
    expect([...again.kinds]).toEqual([...here.kinds]);
});
