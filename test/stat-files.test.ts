import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "fs";
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
        const { scanIndex, scanPaths } = await import("../src/agent/index-scan");
        const { scanIndexFiles } = await import("../src/agent/stat-files");
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
        // On the workers, side by side, as a capture asks.
        const viaWorkers = await scanIndexFiles(repo, index, 20, ["new.txt"], true, Date.now() + 10_000);
        expect(viaWorkers.differs).toEqual(whole.differs);
        expect(viaWorkers.contentKey).toBe(whole.contentKey);
        // Only some paths: the same entries, and the same key.
        const some = scanPaths(repo, index, 20, ["d1/e1/f1.txt", "d2", "d3/e0/f3.txt", "d4/e1/f4.txt", "new.txt"], true);
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

test("a missing file doesn't decide how this system's file times compare (a new repository has no index yet)", async () => {
    const { msTimesExact } = await import("../src/agent/git-index");
    msTimesExact(join(root, "no-index-yet"));
    writeFileSync(join(root, "an-index"), "x");
    // Asked of a file that is there, it's looked at: Bun's millisecond times are exact.
    expect(msTimesExact(join(root, "an-index"))).toBe(true);
});
