import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { KIND, statFiles, statHere } from "../src/agent/stat-files";

const root = mkdtempSync(join(tmpdir(), "stat-files-"));
afterAll(() => {
    try { chmodSync(join(root, "locked"), 0o700); } catch {}
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

for (const version of [2, 4]) {
    test(`an index (version ${version}) scanned in parts finds what one scan does; its content key moves only with what it records`, async () => {
        const { scanIndex, scanPaths, LATE } = await import("../src/agent/index-scan");
        const { scanIndexFiles, statWorkersForTests } = await import("../src/agent/stat-files");
        const repo = join(root, `index-v${version}`);
        mkdirSync(repo, { recursive: true });
        const git = (args: string[], input?: string) => {
            const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
            if (r.exitCode !== 0) throw new Error(r.stderr.toString());
            return r.stdout.toString();
        };
        git(["init", "-q"]);
        for (let i = 0; i < 60; i++) {
            mkdirSync(join(repo, `d${i % 7}/e${i % 3}`), { recursive: true });
            writeFileSync(join(repo, `d${i % 7}/e${i % 3}/f${i}.txt`), `${i}\n`);
        }
        git(["add", "-A"]);
        git(["commit", "-qm", "init"]);
        git(["update-index", "--index-version", String(version)]);
        // A conflict's stages, side by side in the index; a changed file and a gone one.
        const blob = git(["hash-object", "-w", "--stdin"], "x\n").trim();
        git(["update-index", "-z", "--index-info"], `0 ${"0".repeat(40)}\td3/e0/f3.txt\0` + [1, 2, 3].map((stage) => `100644 ${blob} ${stage}\td3/e0/f3.txt\0`).join(""));
        await Bun.sleep(20);
        writeFileSync(join(repo, "d1/e1/f1.txt"), "changed\n");
        rmSync(join(repo, "d2/e2/f2.txt"));
        const index = join(repo, ".git/index");
        const whole = scanIndex(repo, index, 20, ["new.txt"], true);
        expect(whole.unusable).toBeUndefined();
        for (const n of [2, 3, 7]) {
            const parts = Array.from({ length: n }, (_, k) => scanIndex(repo, index, 20, k === n - 1 ? ["new.txt"] : [], true, { k, n }));
            expect({ differs: parts.flatMap((p) => p.differs), gone: parts.flatMap((p) => p.gone), key: parts[0]!.contentKey }).toEqual({ differs: whole.differs, gone: whole.gone, key: whole.contentKey });
        }
        // Most entries are as the index records them: blanked stat fields would make them differ.
        expect(whole.differs.length).toBeLessThan(10);
        // Read once and shared: the first part blanks the others' stat fields only once they're through, here only
        // once it's done with its own; not in time, it's late.
        const { mtimeMs } = statSync(index);
        for (const n of [2, 3]) {
            const buf = readFileSync(index);
            const rest: ReturnType<typeof scanIndex>[] = [];
            const others = () => {
                for (let k = 1; k < n; k++) rest.push(scanIndex(repo, index, 20, k === n - 1 ? ["new.txt"] : [], true, { k, n }, undefined, { buf, mtimeMs }));
                return true;
            };
            const first = scanIndex(repo, index, 20, [], true, { k: 0, n }, undefined, { buf, mtimeMs, othersDone: others });
            if (!rest.length) others();
            const parts = [first, ...rest];
            expect({ differs: parts.flatMap((p) => p.differs), gone: parts.flatMap((p) => p.gone), key: first.contentKey }).toEqual({ differs: whole.differs, gone: whole.gone, key: whole.contentKey });
            expect(() => scanIndex(repo, index, 20, [], true, { k: 0, n }, undefined, { buf: readFileSync(index), mtimeMs, othersDone: () => false })).toThrow(LATE);
        }
        // On the workers, side by side, as a capture asks; and split into parts sharing what was read.
        const viaWorkers = await scanIndexFiles(repo, index, 20, ["new.txt"], true, Date.now() + 10_000);
        expect(viaWorkers.differs).toEqual(whole.differs);
        expect(viaWorkers.contentKey).toBe(whole.contentKey);
        statWorkersForTests({ entriesPerWorker: 10 });
        try {
            const inParts = await scanIndexFiles(repo, index, 20, ["new.txt"], true, Date.now() + 10_000);
            expect({ differs: inParts.differs, gone: inParts.gone, key: inParts.contentKey, tree: inParts.cacheTree }).toEqual({ differs: whole.differs, gone: whole.gone, key: whole.contentKey, tree: whole.cacheTree });
        } finally {
            statWorkersForTests({ entriesPerWorker: 25_000 });
        }
        // Only some paths: the same entries, and the same key; asked again (by offset, the file being the same), the same.
        const asked = ["d1/e1/f1.txt", "d2", "d3/e0/f3.txt", "d4/e1/f4.txt", "new.txt"];
        const first = scanPaths(repo, index, 20, asked, true);
        const some = scanPaths(repo, index, 20, asked, true);
        expect(some).toEqual(first);
        for (const set of [["d0"], ["d0/e1", "d6/e2/f20.txt"], ["d3", "d3/e0"], ["nothing/here", "d5/e2"], ["d1/e1/f1.txt"]]) {
            const again = scanPaths(repo, index, 20, set, true);
            // Read whole, as when the file is new to it.
            writeFileSync(index, readFileSync(index));
            expect(scanPaths(repo, index, 20, set, true)).toEqual(again);
        }
        expect(some.contentKey).toBe(whole.contentKey);
        expect(some.states.map((s) => [s.path, s.tracked, s.kind, !!s.clean, s.special ?? ""])).toEqual([
            ["d1/e1/f1.txt", true, KIND.file, false, ""],
            ["d2", false, KIND.dir, false, ""],
            ["d3/e0/f3.txt", true, KIND.file, false, "entry"],
            ["d4/e1/f4.txt", true, KIND.file, true, ""],
            ["new.txt", false, KIND.missing, false, ""],
            // Under d2, which was looked at: what the index has there.
            ...[2, 9, 16, 23, 30, 37, 44, 51, 58].map((i) => [`d2/e${i % 3}/f${i}.txt`, true, i === 2 ? KIND.missing : KIND.file, i !== 2, ""]).sort((a, b) => (String(a[0]) < String(b[0]) ? -1 : 1)),
        ]);
        // Rewritten with what it records unchanged (stat times refreshed), the key is the same; staged, it isn't.
        git(["update-index", "-z", "--index-info"], `0 ${"0".repeat(40)} 1\td3/e0/f3.txt\0` + `0 ${"0".repeat(40)} 2\td3/e0/f3.txt\0` + `0 ${"0".repeat(40)} 3\td3/e0/f3.txt\0` + `100644 ${blob}\td3/e0/f3.txt\0`);
        const settled = scanIndex(repo, index, 20, [], true).contentKey;
        writeFileSync(join(repo, "d5/e2/f5.txt"), "5\n");
        const before = Bun.file(index).lastModified;
        git(["update-index", "-q", "--refresh"]);
        expect(Bun.file(index).lastModified).not.toBe(before);
        expect(scanIndex(repo, index, 20, [], true).contentKey).toBe(settled);
        git(["add", "d1/e1/f1.txt"]);
        expect(scanIndex(repo, index, 20, [], true).contentKey).not.toBe(settled);
    });
}

test("an index written again by git status (only stat fields differ) is known for the same without reading each entry; staged, it isn't", async () => {
    const { scanPaths } = await import("../src/agent/index-scan");
    const repo = join(root, "rewritten");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]) => {
        const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    git(["init", "-q"]);
    for (let i = 0; i < 200; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    git(["add", "-A"]);
    git(["commit", "-qm", "init"]);
    const index = join(repo, ".git/index");
    const first = scanPaths(repo, index, 20, [], true);
    const written = statSync(index).mtimeMs;
    // Touched, and the index refreshed: written again, the same entries.
    await Bun.sleep(1100);
    for (let i = 0; i < 200; i += 7) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    git(["status", "--porcelain"]);
    expect(statSync(index).mtimeMs).not.toBe(written);
    const again = scanPaths(repo, index, 20, [], true);
    expect([again.unusable, again.contentKey, again.cacheRoot]).toEqual([undefined, first.contentKey, first.cacheRoot]);
    // Staged: another key, and the one a whole read finds.
    writeFileSync(join(repo, "f3.txt"), "changed\n");
    git(["add", "f3.txt"]);
    const staged = scanPaths(repo, index, 20, [], true);
    expect(staged.contentKey).not.toBe(first.contentKey);
    rmSync(join(repo, ".git/index.lock"), { force: true });
    const whole = scanPaths(repo, index, 20, ["f3.txt"], true);
    expect(whole.contentKey).toBe(staged.contentKey);
});

test("a scan nothing waits for any more stops: past its deadline it's not done, and the worker is free for the next", async () => {
    const { scanIndex, LATE } = await import("../src/agent/index-scan");
    const { scanIndexFiles } = await import("../src/agent/stat-files");
    const repo = join(root, "late");
    mkdirSync(repo, { recursive: true });
    const git = (args: string[]) => {
        const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "core.hooksPath=/dev/null", ...args], { cwd: repo, env: { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
        if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    };
    git(["init", "-q"]);
    for (let i = 0; i < 3000; i++) writeFileSync(join(repo, `f${i}.txt`), `${i}\n`);
    git(["add", "-A"]);
    const index = join(repo, ".git/index");
    expect(() => scanIndex(repo, index, 20, [], true, { k: 0, n: 1 }, Date.now() - 1)).toThrow(LATE);
    await expect(scanIndexFiles(repo, index, 20, [], true, Date.now() - 1)).rejects.toThrow(/time budget/);
    const t = Date.now();
    const scan = await scanIndexFiles(repo, index, 20, [], true, Date.now() + 10_000);
    expect([scan.unusable, scan.gone.length, Date.now() - t < 5000]).toEqual([undefined, 0, true]);
});

test("a missing file doesn't decide how this system's file times compare (a new repository has no index yet)", async () => {
    const { msTimesExact } = await import("../src/agent/git-index");
    msTimesExact(join(root, "no-index-yet"));
    writeFileSync(join(root, "an-index"), "x");
    // Asked of a file that is there, it's looked at: Bun's millisecond times are exact.
    expect(msTimesExact(join(root, "an-index"))).toBe(true);
});

test("the worker keeps one tracked list for each folder: a new one takes the last one's place", async () => {
    const w = new Worker(new URL("../src/agent/stat-worker.ts", import.meta.url).href);
    let id = 0;
    const ask = (req: Record<string, unknown>) => new Promise<{ missing?: boolean; kinds?: Uint8Array }>((resolve) => {
        w.onmessage = (e) => resolve(e.data);
        w.postMessage({ id: ++id, untracked: [], ...req });
    });
    try {
        const other = join(root, "elsewhere");
        expect((await ask({ root, trackedId: "a", tracked: ["a.txt"] })).kinds?.length).toBe(1);
        expect((await ask({ root: other, trackedId: "a", tracked: ["x", "y"] })).kinds?.length).toBe(2);
        expect((await ask({ root, trackedId: "a" })).kinds?.length).toBe(1);
        expect((await ask({ root, trackedId: "b", tracked: ["a.txt", "dir"] })).kinds?.length).toBe(2);
        // The folder's last list is gone; another folder's is kept.
        expect((await ask({ root, trackedId: "a" })).missing).toBe(true);
        expect((await ask({ root, trackedId: "b" })).kinds?.length).toBe(2);
        expect((await ask({ root: other, trackedId: "a" })).kinds?.length).toBe(2);
        // An empty one is used as sent, and leaves the folder's kept.
        expect((await ask({ root, trackedId: "untracked", tracked: [], untracked: ["a.txt"] })).kinds?.length).toBe(1);
        expect((await ask({ root, trackedId: "b" })).kinds?.length).toBe(2);
    } finally {
        w.terminate();
    }
});

test("an idle stat worker is let go of, and started again when it's next asked", async () => {
    const { scanIndexPaths, statWorkersForTests } = await import("../src/agent/stat-files");
    const repo = join(root, "idle");
    mkdirSync(repo, { recursive: true });
    const env = { PATH: process.env.PATH!, HOME: root, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
    expect(Bun.spawnSync(["git", "init", "-q"], { cwd: repo, env }).exitCode).toBe(0);
    writeFileSync(join(repo, "a.txt"), "a\n");
    expect(Bun.spawnSync(["git", "add", "a.txt"], { cwd: repo, env }).exitCode).toBe(0);
    const index = join(repo, ".git/index");
    const ask = async () => {
        const stats = await statFiles(repo, `${repo}:idle`, ["a.txt"], [], Date.now() + 10_000, () => {});
        const looked = await scanIndexPaths(repo, index, 20, ["a.txt"], true, Date.now() + 10_000);
        return [stats.kinds[0], looked.states.map((s) => [s.path, s.tracked])];
    };
    statWorkersForTests({ idleMs: 50 });
    try {
        const first = await ask();
        expect(first).toEqual([KIND.file, [["a.txt", true]]]);
        expect(statWorkersForTests()).toEqual({ stat: true, lookups: true });
        await Bun.sleep(300);
        expect(statWorkersForTests()).toEqual({ stat: false, lookups: false });
        // Asked again: new workers, sent the list again, answering the same.
        expect(await ask()).toEqual(first);
        expect(statWorkersForTests()).toEqual({ stat: true, lookups: true });
    } finally {
        statWorkersForTests({ idleMs: 60_000 });
    }
});
