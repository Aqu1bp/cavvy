import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { TurnSnapshots } = await import("../src/agent/turn-snapshots");
const { pruneFileHistory, HISTORY_MAX_AGE_MS, MAX_SNAPSHOT_BYTES } = await import("../src/agent/checkpoints");
const { paths } = await import("../src/config/paths");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

let next = 0;
const IDENTITY = ["-c", "maintenance.auto=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Cavvy Test", "-c", "user.email=test@example.invalid"];

function git(cwd: string, args: string[], extraEnv: Record<string, string> = {}): Buffer {
    const env = gitEnv();
    for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
    const r = Bun.spawnSync(gitArgv([...IDENTITY, ...args]), { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", ...extraEnv }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout;
}

function write(dir: string, path: string, body: string | Buffer) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), body);
}

/**
 * A repository with `files` committed, or, with `untracked`, written after the commit: Git's index has committed
 * files as they are, so a snapshot takes their blobs from it, and reads (and stores) only files Git doesn't have.
 */
function setup(files: Record<string, string | Buffer> = {}, format: "sha1" | "sha256" = "sha1", o: { untracked?: boolean } = {}) {
    const base = join(realpathSync(iso.home), `snapshot-${next++}`);
    const cwd = join(base, "repo");
    const dir = join(base, "history");
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q", "-b", "main", `--object-format=${format}`]);
    if (!o.untracked) for (const [path, body] of Object.entries(files)) write(cwd, path, body);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
    if (o.untracked) for (const [path, body] of Object.entries(files)) write(cwd, path, body);
    return { cwd, dir, snapshots: new TurnSnapshots(dir, cwd) };
}

/** Include directory entries and every file's bytes, so stray objects/shared indices count. */
function inventory(root: string): Record<string, string> {
    const result: Record<string, string> = {};
    const walk = (dir: string, prefix: string) => {
        for (const name of readdirSync(dir).sort()) {
            const path = join(dir, name);
            const relative = prefix + name;
            const st = lstatSync(path);
            result[relative] = st.isDirectory() ? "directory" : readFileSync(path).toString("base64");
            if (st.isDirectory()) walk(path, relative + "/");
        }
    };
    walk(root, "");
    return result;
}

function objectsDir(root: string): string {
    if (existsSync(join(root, "objects"))) return join(root, "objects");
    for (const name of readdirSync(root)) {
        const path = join(root, name);
        if (lstatSync(path).isDirectory()) {
            try {
                return objectsDir(path);
            } catch {
                // The next directory may contain the private object database.
            }
        }
    }
    throw new Error("No private objects directory");
}

/** Objects in a private store, loose and packed. */
function storedCount(objects: string): number {
    const loose = readdirSync(objects).filter((n) => /^[0-9a-f]{2}$/.test(n)).reduce((n, d) => n + readdirSync(join(objects, d)).length, 0);
    const pack = join(objects, "pack");
    const packed = existsSync(pack) ? readdirSync(pack).filter((n) => n.endsWith(".idx")).reduce((n, f) => n + readFileSync(join(pack, f)).readUInt32BE(8 + 255 * 4), 0) : 0;
    return loose + packed;
}

function expectPrivate(root: string) {
    const st = lstatSync(root);
    expect(st.mode & 0o777).toBe(st.isDirectory() ? 0o700 : 0o600);
    if (st.isDirectory()) for (const name of readdirSync(root)) expectPrivate(join(root, name));
}

describe("per-turn snapshots", () => {
    test("prepare captures without cutting the open turn; beginWith starts the next turn from that capture, after an end that was asked first", async () => {
        const { snapshots } = setup({ "a.txt": "a" });
        await snapshots.begin(1, "first");
        const captured = await snapshots.prepare();
        expect(captured).toBeDefined();
        // Nothing started or ended: the first turn is still the open one.
        expect(snapshots.list().map((t) => [t.id, Boolean(t.end)])).toEqual([[1, false]]);
        // Dropped (the prompt didn't go): still nothing changes.
        await snapshots.prepare();
        expect(snapshots.list().map((t) => [t.id, Boolean(t.end)])).toEqual([[1, false]]);
        const started = snapshots.beginWith(2, "second", captured);
        const ended = snapshots.end();
        await Promise.all([started, ended]);
        // In the order asked: the first ends at the capture, the second starts from it, then ends.
        expect(snapshots.list().map((t) => [t.id, Boolean(t.end)])).toEqual([[1, true], [2, true]]);
        expect(snapshots.list()[1]!.start).toEqual(captured!);
    });

    test("the object quota degrades capture gracefully and survives reopening", async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "before\n" });
        await snapshots.begin(1, "saved");
        await snapshots.end();
        const objects = objectsDir(dir);
        const bytes = () => Object.values(inventory(objects)).reduce((total, value) => total + (value === "directory" ? 0 : Buffer.from(value, "base64").length), 0);
        const used = bytes();
        const limited = new TurnSnapshots(dir, cwd, { maxStoreBytes: used });
        await limited.begin(2, "fits existing objects");
        expect(limited.list()[1]!.start.incomplete).toBe(false);
        write(cwd, "a.txt", "a new version that needs another blob\n");
        await limited.end();
        const failed = limited.list()[1]!;
        expect(failed.end!.incomplete).toBe(true);
        expect(failed.end!.tree).toBeUndefined();
        expect(failed.end!.notes.join(" ")).toContain("Snapshot storage limit reached");
        expect(bytes()).toBe(used);
        const reopened = new TurnSnapshots(dir, cwd, { maxStoreBytes: used });
        expect(reopened.list()[1]!.end!.incomplete).toBe(true);
        await reopened.begin(3, "still full");
        expect(reopened.list()[2]!.start.notes.join(" ")).toContain("Snapshot storage limit reached");
        expect(bytes()).toBe(used);
        expect((await reopened.changes({ scope: "turn", turnId: 1 })).files).toEqual([]);
        expect((await reopened.changes({ scope: "turn", turnId: 2 })).incomplete).toBe(true);
    });

    test("tree objects and blobs left by failed captures count toward the quota", async () => {
        const { cwd, dir } = setup({ "a.txt": "before\n" }, "sha1", { untracked: true });
        // A loose blob fits, but its containing tree does not.
        const limited = new TurnSnapshots(dir, cwd, { maxStoreBytes: 32 });
        await limited.begin(1, "tree exceeds quota");
        expect(limited.list()[0]!.start.incomplete).toBe(true);
        expect(limited.list()[0]!.start.notes.join(" ")).toContain("Snapshot storage limit reached");
        const before = inventory(objectsDir(dir));
        const sizes = Object.values(before).filter((v) => v !== "directory").map((v) => Buffer.from(v, "base64").length);
        expect(sizes.length).toBe(1);
        expect(sizes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(32);
        const reopened = new TurnSnapshots(dir, cwd, { maxStoreBytes: 32 });
        await reopened.begin(2, "failed objects still count");
        expect(reopened.list()[1]!.start.notes.join(" ")).toContain("Snapshot storage limit reached");
        expect(inventory(objectsDir(dir))).toEqual(before);
        write(cwd, "a.txt", "changed\n");
        await reopened.end();
        expect(reopened.list()[1]!.end!.incomplete).toBe(true);
        expect(inventory(objectsDir(dir))).toEqual(before);
        expectPrivate(dir);
    });

    test("malformed journal records cannot supply paths or repository roots", async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "before\n" });
        await snapshots.begin(1, "valid");
        write(cwd, "a.txt", "after\n");
        await snapshots.end();
        const valid = snapshots.list()[0]!;
        const bad = [
            { id: "2" }, { id: -1 }, { prompt: null }, { startedAt: "now" }, { endedAt: null },
            { end: undefined }, { changed: {} }, { changed: [null] },
            ...["../escape", "dir/../escape", "/outside", ".git/config", "x/.GiT/config", "", "bad\0path"].flatMap((path) => [
                { changed: [path] },
                { start: { ...valid.start, skipped: { [path]: "omitted" } } },
                { end: { ...valid.end, skippedStamps: { [path]: "stamp" } } },
            ]),
            { start: { ...valid.start, root: join(cwd, "elsewhere") } },
            { end: { ...valid.end, root: dirname(cwd) } },
            { start: { ...valid.start, root: undefined } },
            { start: { ...valid.start, tree: undefined, incomplete: true } },
            { end: { ...valid.end, tree: undefined, incomplete: true } },
            { changed: undefined, start: { ...valid.start, tree: undefined, incomplete: false } },
            { start: { ...valid.start, incomplete: "yes" } },
            { start: { ...valid.start, durationMs: -1 } },
            { start: { ...valid.start, notes: [42] } },
            { start: { ...valid.start, skipped: [] } },
            { start: { ...valid.start, skipped: { "a.txt": 42 } } },
            { start: { ...valid.start, skippedStamps: { "a.txt": null } } },
        ];
        writeFileSync(join(dir, "turn-snapshots.jsonl"), [valid, ...bad.map((fields, i) => ({ ...valid, id: i + 2, ...fields }))].map((r) => JSON.stringify(r)).join("\n") + "\n");
        const reopened = new TurnSnapshots(dir, cwd);
        expect(reopened.list().map((r) => r.id)).toEqual([1]);
        expect(reopened.changedPaths()).toEqual([join(cwd, "a.txt")]);
        expect((await reopened.changes({ scope: "last-turn" })).files.map((f) => f.path)).toEqual(["a.txt"]);
    });

    test("version 1 absolute changed paths are contained before conversion, including from a subfolder", async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "before\n" });
        await snapshots.begin(1, "old format");
        write(cwd, "a.txt", "after\n");
        await snapshots.end();
        const valid = { ...snapshots.list()[0]!, version: 1, changed: [join(cwd, "a.txt")] };
        const bad = [join(dirname(cwd), "other.txt"), join(cwd, ".git/config"), `${cwd}/sub/../a.txt`, "a.txt"];
        writeFileSync(join(dir, "turn-snapshots.jsonl"), [valid, ...bad.map((path, i) => ({ ...valid, id: i + 2, changed: [path] }))].map((r) => JSON.stringify(r)).join("\n") + "\n");
        mkdirSync(join(cwd, "sub"));
        const reopened = new TurnSnapshots(dir, join(cwd, "sub"));
        expect(reopened.list().map((r) => r.id)).toEqual([1]);
        expect(reopened.list()[0]!.changed).toEqual(["a.txt"]);
        expect(reopened.changedPaths()).toEqual([join(cwd, "a.txt")]);
        expect((await reopened.changes({ scope: "last-turn" })).files.map((f) => f.path)).toEqual(["../a.txt"]);
    });

    test("prototype-named files keep ordinary diffs and omission metadata after reopening", async () => {
        const names = ["constructor", "toString", "__proto__"];
        const { cwd, dir, snapshots } = setup(Object.fromEntries(names.map((name) => [name, "before\n"])));
        await snapshots.begin(1, "unchanged");
        await snapshots.end();
        expect((await snapshots.changes({ scope: "last-turn" })).files).toEqual([]);
        await snapshots.begin(2, "edit prototype names");
        for (const name of names) write(cwd, name, "after\n");
        await snapshots.end();
        const reopened = new TurnSnapshots(dir, cwd);
        const changes = await reopened.changes({ scope: "last-turn" });
        expect(changes.files.map((f) => f.path).sort()).toEqual(names.sort());
        for (const file of changes.files) {
            expect(file.note).toBeUndefined();
            expect([file.added, file.removed]).toEqual([1, 1]);
        }
        for (const name of names) write(cwd, name, Buffer.alloc(MAX_SNAPSHOT_BYTES + 1));
        await reopened.begin(3, "unchanged omissions");
        await reopened.end();
        const omitted = new TurnSnapshots(dir, cwd);
        const result = await omitted.changes({ scope: "last-turn" });
        expect(result).toMatchObject({ incomplete: true, files: [] });
        for (const name of names) {
            expect(Object.hasOwn(omitted.list().at(-1)!.start.skipped, name)).toBe(true);
            expect(result.notes?.some((note) => note.includes(`Not captured: ${name}:`))).toBe(true);
        }
    });

    test("reopening a cut-off steering turn keeps its start without inventing an end", async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "before\n" });
        await snapshots.begin(101, "first prompt");
        write(cwd, "a.txt", "first turn\n");
        await snapshots.begin(102, "steered prompt");
        write(cwd, "a.txt", "cut off here\n");
        const journal = readFileSync(join(dir, "turn-snapshots.jsonl"), "utf8");
        const reopened = new TurnSnapshots(dir, cwd);
        expect(reopened.list()[0]!.end?.tree).toBe(reopened.list()[1]!.start.tree);
        expect(reopened.list()[1]!.start.tree).toBeDefined();
        expect(reopened.list()[1]!.end).toBeUndefined();
        for (const scope of ["last-turn", "turn"] as const) {
            const changes = await reopened.changes({ scope, turnId: 102 });
            expect(changes).toMatchObject({ turnId: 102, snapshotAvailable: false, incomplete: true, files: [] });
            expect(changes.notes?.join(" ")).toContain("without a closing snapshot");
        }
        expect(readFileSync(join(dir, "turn-snapshots.jsonl"), "utf8")).toBe(journal);
        await reopened.begin(103, "resume work");
        write(cwd, "a.txt", "resumed turn\n");
        await reopened.end();
        expect(reopened.list()[1]!.end).toBeUndefined();
        const changes = await reopened.changes({ scope: "last-turn" });
        expect(changes).toMatchObject({ turnId: 103, incomplete: false, snapshotAvailable: true });
        expect(changes.files[0]?.hunks.flatMap((h) => h.lines).map((l) => l.text).join("\n")).toContain("cut off here");
    });

    for (const phase of ["begin", "end", "compare", "steering-compare"] as const) test(`retiring during ${phase} drains private writes and never appends a late end`, async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "before\n" });
        await snapshots.begin(1, "interrupted prompt");
        write(cwd, "a.txt", "late change\n");
        const journal = readFileSync(join(dir, "turn-snapshots.jsonl"), "utf8");
        let entered!: () => void, release!: () => void;
        const waiting = new Promise<void>((r) => { entered = r; });
        const gate = new Promise<void>((r) => { release = r; });
        const method = phase.includes("compare") ? "compare" : "capture";
        const original = (snapshots as any)[method].bind(snapshots);
        (snapshots as any)[method] = async (...args: unknown[]) => {
            const value = await original(...args);
            entered();
            await gate;
            return value;
        };
        const pending = phase === "begin" || phase === "steering-compare" ? snapshots.begin(2, "pending steering") : snapshots.end();
        await waiting;
        let retired = false;
        const stopping = snapshots.stop().then(() => { retired = true; });
        await Bun.sleep(10);
        expect(retired).toBe(false);
        release();
        await Promise.all([pending, stopping]);
        await snapshots.begin(3, "too late");
        await snapshots.end();
        expect(readFileSync(join(dir, "turn-snapshots.jsonl"), "utf8")).toBe(journal);
        expect(snapshots.list()[0]!.end).toBeUndefined();
        const reopened = new TurnSnapshots(dir, cwd);
        await reopened.begin(4, "new owner");
        await reopened.end();
        expect(reopened.list().map((t) => [t.id, !!t.end])).toEqual([[1, false], [4, true]]);
    });

    test("records shell and external writes, and reopening preserves each turn's diff", async () => {
        const { cwd, dir, snapshots } = setup({ "shell.txt": "before shell\n", "backend.txt": "before backend\n" });
        await snapshots.begin(1, "Change both files");
        const shell = Bun.spawnSync(["sh", "-c", "printf 'after shell\\n' > shell.txt"], { cwd });
        expect(shell.exitCode).toBe(0);
        write(cwd, "backend.txt", "after backend\n");
        await snapshots.end();
        await snapshots.begin(2, "Create a file");
        write(cwd, "new.txt", "new\n");
        await snapshots.end();

        const reopened = new TurnSnapshots(dir, cwd);
        expect(reopened.list().map((t) => [t.id, t.prompt])).toEqual([[1, "Change both files"], [2, "Create a file"]]);
        expect(reopened.list().every((t) => t.start.tree && t.end?.tree && t.endedAt)).toBe(true);
        const first = await reopened.changes({ scope: "turn", turnId: 1 });
        expect(first.files.map((f) => f.path).sort()).toEqual(["backend.txt", "shell.txt"]);
        expect(first.files.every((f) => f.added === 1 && f.removed === 1)).toBe(true);
        const last = await reopened.changes({ scope: "last-turn" });
        expect(last.files.map((f) => f.path)).toEqual(["new.txt"]);
        expect(reopened.changedPaths().sort()).toEqual(["backend.txt", "new.txt", "shell.txt"].map((p) => join(cwd, p)));
    });

    test("private plumbing never changes .git or runs filters, fsmonitor, or index hooks", async () => {
        const { cwd, dir, snapshots } = setup({ "tracked.txt": "original\n" });
        const marker = join(dirname(cwd), "program-ran");
        write(cwd, ".gitattributes", "* filter=unsafe text eol=lf\n");
        git(cwd, ["config", "filter.unsafe.clean", `touch '${marker}'; cat`]);
        git(cwd, ["config", "filter.unsafe.process", `touch '${marker}'; exit 1`]);
        git(cwd, ["config", "core.fsmonitor", `touch '${marker}'`]);
        git(cwd, ["config", "core.splitIndex", "true"]);
        git(cwd, ["config", "core.sharedRepository", "all"]);
        write(cwd, ".git/hooks/post-index-change", `#!/bin/sh\ntouch '${marker}'\n`);
        chmodSync(join(cwd, ".git/hooks/post-index-change"), 0o700);
        const crlf = Buffer.from("first\r\nsecond\r\n");
        write(cwd, "raw.txt", crlf);
        const before = inventory(join(cwd, ".git"));
        const indexMtime = statSync(join(cwd, ".git/index")).mtimeMs;

        await snapshots.begin(1, "Change raw files");
        write(cwd, "tracked.txt", "edited\n");
        await snapshots.end();
        await snapshots.changes({ scope: "last-turn" });

        expect(existsSync(marker)).toBe(false);
        expect(inventory(join(cwd, ".git"))).toEqual(before);
        expect(statSync(join(cwd, ".git/index")).mtimeMs).toBe(indexMtime);
        const tree = snapshots.list()[0]!.start.tree!;
        expect(tree).toBeTruthy();
        const env = { GIT_OBJECT_DIRECTORY: objectsDir(dir), GIT_ALTERNATE_OBJECT_DIRECTORIES: "" };
        expect(git(cwd, ["cat-file", "blob", `${tree}:raw.txt`], env)).toEqual(crlf);
        expectPrivate(dir);
    });

    test("ignored files are omitted, large files are marked, and ordinary files still diff", async () => {
        const { cwd, dir, snapshots } = setup({ ".gitignore": "private.txt\n", "small.txt": "before\n" });
        write(cwd, "private.txt", "not captured\n");
        write(cwd, "large.bin", Buffer.alloc(MAX_SNAPSHOT_BYTES + 1, 1));
        await snapshots.begin(1, "Edit files");
        write(cwd, "private.txt", "still not captured\n");
        write(cwd, "small.txt", "after\n");
        await snapshots.end();

        const turn = snapshots.list()[0]!;
        expect(turn.start.incomplete).toBe(true);
        expect(turn.start.skipped["large.bin"]).toMatch(/10|large|size/i);
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(result.files.some((f) => f.path === "small.txt")).toBe(true);
        expect(result.files.some((f) => f.path === "private.txt")).toBe(false);
        expect(result.files.some((f) => f.path === "large.bin")).toBe(false);
        expect(snapshots.changedPaths()).toEqual([join(cwd, "small.txt")]);
        expect(JSON.stringify(result)).toMatch(/large|10 MB|10 MiB/i);
        const tree = turn.start.tree!;
        const contents = git(cwd, ["ls-tree", "-r", "--name-only", tree], { GIT_OBJECT_DIRECTORY: objectsDir(dir) }).toString();
        expect(contents).not.toContain("private.txt");
        expect(contents).not.toContain("large.bin");
    });

    test("linked worktrees keep both their own and the common repository metadata untouched", async () => {
        const { cwd, dir } = setup({ "a.txt": "before\n" });
        const linked = join(dirname(cwd), "linked");
        git(cwd, ["worktree", "add", "-q", "-b", "snapshot-linked", linked]);
        const before = inventory(join(cwd, ".git"));
        const pointer = readFileSync(join(linked, ".git"));
        const snapshots = new TurnSnapshots(dir, linked);
        await snapshots.begin(1, "Edit a linked worktree");
        write(linked, "a.txt", "after\n");
        await snapshots.end();
        expect((await snapshots.changes({ scope: "last-turn" })).files.map((f) => f.path)).toEqual(["a.txt"]);
        expect(inventory(join(cwd, ".git"))).toEqual(before);
        expect(readFileSync(join(linked, ".git"))).toEqual(pointer);
    });

    test("inherited repository variables cannot redirect snapshot reads or writes", async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "before\n" });
        const other = setup({ "other.txt": "not this repository\n" });
        const before = inventory(join(other.cwd, ".git"));
        const vars: Record<string, string> = {
            GIT_DIR: join(other.cwd, ".git"),
            GIT_WORK_TREE: other.cwd,
            GIT_INDEX_FILE: join(other.cwd, ".git/index"),
            GIT_OBJECT_DIRECTORY: join(other.cwd, ".git/objects"),
            GIT_ALTERNATE_OBJECT_DIRECTORIES: join(other.cwd, ".git/objects"),
            GIT_COMMON_DIR: join(other.cwd, ".git"),
        };
        const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
        try {
            Object.assign(process.env, vars);
            await snapshots.begin(1, "Use the actual folder");
            write(cwd, "a.txt", "after\n");
            await snapshots.end();
            expect((await snapshots.changes({ scope: "last-turn" })).files.map((f) => f.path)).toEqual(["a.txt"]);
        } finally {
            for (const [k, value] of Object.entries(saved)) {
                if (value === undefined) delete process.env[k];
                else process.env[k] = value;
            }
        }
        expect(inventory(join(other.cwd, ".git"))).toEqual(before);
        expect(new TurnSnapshots(dir, cwd).list()[0]!.start.tree).toBeTruthy();
    });

    test("a zero start budget degrades to an incomplete record without blocking the turn", async () => {
        const { cwd, dir } = setup({ "a.txt": "before\n" });
        const snapshots = new TurnSnapshots(dir, cwd, { budgetMs: 0 });
        const started = Date.now();
        await snapshots.begin(1, "Timed out snapshot");
        expect(Date.now() - started).toBeLessThan(1000);
        write(cwd, "a.txt", "after\n");
        await snapshots.end();
        const turn = snapshots.list()[0]!;
        expect(turn.start.incomplete).toBe(true);
        expect(turn.start.notes.join(" ")).toMatch(/time|budget/i);
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(JSON.stringify(result)).toMatch(/incomplete|time|budget/i);
        expect(new TurnSnapshots(dir, cwd).list()[0]!.start.incomplete).toBe(true);
    });

    test("private objects survive removal of matching objects from the repository", async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "committed bytes\n" });
        await snapshots.begin(1, "Change committed content");
        write(cwd, "a.txt", "new bytes\n");
        await snapshots.end();
        // Stronger than GC: remove every source object, including objects reachable from HEAD.
        rmSync(join(cwd, ".git/objects"), { recursive: true });
        mkdirSync(join(cwd, ".git/objects"));
        const reopened = new TurnSnapshots(dir, cwd);
        const result = await reopened.changes({ scope: "last-turn" });
        expect(result.files.map((f) => [f.path, f.added, f.removed])).toEqual([["a.txt", 1, 1]]);
    });

    test("a missing private blob reports an incomplete diff without repeated deferred loading", async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "before\n" });
        await snapshots.begin(1, "Change a file");
        write(cwd, "a.txt", "after\n");
        await snapshots.end();
        const objects = objectsDir(dir);
        const tree = snapshots.list()[0]!.start.tree!;
        const oid = git(cwd, ["rev-parse", `${tree}:a.txt`], { GIT_OBJECT_DIRECTORY: objects }).toString().trim();
        // Loose, or (kept at the turn's end from the repository's objects) in a pack of its own.
        const loose = join(objects, oid.slice(0, 2), oid.slice(2));
        if (existsSync(loose)) rmSync(loose);
        else rmSync(join(objects, "pack"), { recursive: true });
        const reopened = new TurnSnapshots(dir, cwd);
        for (const path of [undefined, "a.txt"]) {
            const result = await reopened.changes({ scope: "last-turn", path });
            expect(result.incomplete).toBe(true);
            expect(JSON.stringify(result)).toMatch(/missing|unreadable/i);
            expect(result.files.every((f) => !f.deferred)).toBe(true);
        }
    });

    test("repository replacement refs cannot substitute snapshot bytes", async () => {
        const { cwd, snapshots } = setup({ "a.txt": "before\n", "b.txt": "after\n" });
        const old = git(cwd, ["rev-parse", "HEAD:a.txt"]).toString().trim();
        const replacement = git(cwd, ["rev-parse", "HEAD:b.txt"]).toString().trim();
        git(cwd, ["replace", old, replacement]);
        await snapshots.begin(1, "Change the actual file");
        write(cwd, "a.txt", "after\n");
        await snapshots.end();
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(result.files.map((f) => [f.path, f.added, f.removed])).toEqual([["a.txt", 1, 1]]);
        expect(result.files[0]!.hunks.flatMap((h) => h.lines.map((line) => `${line.t}:${line.text}`))).toEqual(["del:before", "add:after"]);
    });

    test("symlink snapshots preserve target text without reading the target", async () => {
        const { cwd, dir, snapshots } = setup({ "a.txt": "ordinary\n" });
        const outside = join(dirname(cwd), "outside.txt");
        writeFileSync(outside, "outside secret bytes\n");
        symlinkSync("a.txt", join(cwd, "link"));
        await snapshots.begin(1, "Retarget a link");
        rmSync(join(cwd, "link"));
        symlinkSync(outside, join(cwd, "link"));
        await snapshots.end();
        const turn = snapshots.list()[0]!;
        const env = { GIT_OBJECT_DIRECTORY: objectsDir(dir) };
        expect(git(cwd, ["cat-file", "blob", `${turn.start.tree}:link`], env).toString()).toBe("a.txt");
        expect(git(cwd, ["cat-file", "blob", `${turn.end!.tree}:link`], env).toString()).toBe(outside);
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(result.files.map((f) => [f.path, f.kind])).toEqual([["link", "link"]]);
        expect(JSON.stringify(result)).not.toContain("outside secret bytes");
    });

    test("an executable-bit-only change is reported", async () => {
        const { cwd, snapshots } = setup({ "run.sh": "echo hello\n" });
        chmodSync(join(cwd, "run.sh"), 0o644);
        await snapshots.begin(1, "Make a script executable");
        chmodSync(join(cwd, "run.sh"), 0o755);
        await snapshots.end();
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(result.files.map((f) => [f.path, f.added, f.removed])).toEqual([["run.sh", 0, 0]]);
        expect(result.files[0]!.note).toMatch(/100644.*100755/);
        expect(result.files[0]!.change).toBe("modified");
        expect(result.incomplete).toBe(false);
    });

    test("deletions and file-directory swaps remove old index entries", async () => {
        const { cwd, snapshots } = setup({ "gone.txt": "deleted\n", "file": "was a file\n", "directory/child.txt": "was in a directory\n" });
        await snapshots.begin(1, "Swap file and directory types");
        rmSync(join(cwd, "gone.txt"));
        rmSync(join(cwd, "file"));
        write(cwd, "file/child.txt", "now in a directory\n");
        rmSync(join(cwd, "directory"), { recursive: true });
        write(cwd, "directory", "now a file\n");
        await snapshots.end();
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(result.incomplete).toBe(false);
        expect(result.files.map((f) => `${f.change} ${f.path}`).sort()).toEqual([
            "added directory", "added file/child.txt", "deleted directory/child.txt", "deleted file", "deleted gone.txt",
        ]);
    });

    test("untracked filenames cannot be confused with index entry metadata", async () => {
        const { cwd, snapshots } = setup();
        await snapshots.begin(1, "Create files with unusual names");
        const names = [`100644 ${"a".repeat(40)} 0\tpretend.txt`, "line\nbreak.txt", "ünï.txt"];
        for (const name of names) write(cwd, name, "new bytes\n");
        await snapshots.end();
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(result.incomplete).toBe(false);
        expect(result.files.map((f) => f.path).sort()).toEqual([...names].sort());
    });

    test("non-repositories retain the file-history fallback without creating snapshot storage", async () => {
        const base = join(realpathSync(iso.home), `nonrepo-${next++}`);
        const cwd = join(base, "folder");
        const dir = join(base, "history");
        mkdirSync(cwd, { recursive: true });
        write(cwd, "a.txt", "before\n");
        const snapshots = new TurnSnapshots(dir, cwd);
        await snapshots.begin(1, "No repository");
        write(cwd, "a.txt", "after\n");
        await snapshots.end();
        expect(snapshots.list()).toEqual([]);
        expect(snapshots.changedPaths()).toEqual([]);
        expect(existsSync(dir)).toBe(false);
        expect((await snapshots.changes({ scope: "last-turn" })).repo).toBe(false);
    });

    test("a fresh snapshot sidecar prevents pruning an otherwise stale session", async () => {
        const { cwd } = setup({ "a.txt": "a\n" });
        const project = join(paths.projectsDir(), `snapshot-prune-fresh-${next++}`);
        const dir = join(project, "file-history", "active-session");
        const snapshots = new TurnSnapshots(dir, cwd);
        await snapshots.begin(1, "An active turn");
        await snapshots.end();
        const session = join(project, "active-session.jsonl");
        writeFileSync(session, "old session\n");
        const now = Date.now();
        const old = new Date(now - HISTORY_MAX_AGE_MS - 60_000);
        writeFileSync(join(dir, "index.jsonl"), "");
        for (const path of [session, join(dir, "index.jsonl"), dir]) utimesSync(path, old, old);
        expect(await pruneFileHistory({ now })).not.toContain(dir);
        expect(existsSync(dir)).toBe(true);
    });

    test("an unreadable tracked path is incomplete rather than falsely deleted", async () => {
        const { cwd, snapshots } = setup({ "locked/a.txt": "before\n", "normal.txt": "before\n" });
        // Exclude traversal for untracked files, while the index still lists a.txt.
        write(cwd, ".gitignore", "locked/\n");
        await snapshots.begin(1, "Edit while another path becomes unreadable");
        chmodSync(join(cwd, "locked"), 0);
        try {
            write(cwd, "normal.txt", "after\n");
            await snapshots.end();
            const result = await snapshots.changes({ scope: "last-turn" });
            expect(result.incomplete).toBe(true);
            const locked = result.files.find((f) => f.path === "locked/a.txt")!;
            expect(locked.change).toBe("modified");
            expect(locked.note).toMatch(/unreadable/i);
            expect(locked.removed).toBe(0);
            expect(result.files.find((f) => f.path === "normal.txt")!.added).toBe(1);
        } finally { chmodSync(join(cwd, "locked"), 0o700); }
    });

    test("unreadable untracked directories invalidate the listing instead of fabricating deletions", async () => {
        const { cwd, snapshots } = setup();
        write(cwd, "locked/untracked.txt", "before\n");
        await snapshots.begin(1, "A directory becomes unreadable");
        chmodSync(join(cwd, "locked"), 0);
        try {
            await snapshots.end();
            const result = await snapshots.changes({ scope: "last-turn" });
            expect(result.incomplete).toBe(true);
            expect(result.notes!.join(" ")).toMatch(/file list is incomplete/i);
            expect(result.files.some((f) => f.change === "deleted")).toBe(false);
        } finally { chmodSync(join(cwd, "locked"), 0o700); }
    });

    test("a failed preceding comparison does not contaminate the next steering snapshot", async () => {
        const { cwd, dir } = setup({ "a.txt": "before\n" });
        const options = { budgetMs: 0 };
        const snapshots = new TurnSnapshots(dir, cwd, options);
        await snapshots.begin(1, "Incomplete first start");
        options.budgetMs = 2000;
        await snapshots.begin(2, "A complete steering boundary");
        write(cwd, "a.txt", "after\n");
        await snapshots.end();
        expect((await snapshots.changes({ scope: "turn", turnId: 1 })).snapshotAvailable).toBe(false);
        const result = await snapshots.changes({ scope: "turn", turnId: 2 });
        expect(result.snapshotAvailable).toBe(true);
        expect(result.incomplete).toBe(false);
        expect(result.files.map((f) => f.path)).toEqual(["a.txt"]);
    });

    test("inherited Git tracing cannot turn a complete listing into a warning or write trace files", async () => {
        const { cwd, snapshots } = setup({ "a.txt": "before\n" });
        const saved = process.env.GIT_TRACE;
        const trace = join(cwd, "trace-output.txt");
        process.env.GIT_TRACE = trace;
        try {
            await snapshots.begin(1, "A traced parent process");
            await snapshots.end();
        } finally {
            if (saved === undefined) delete process.env.GIT_TRACE;
            else process.env.GIT_TRACE = saved;
        }
        expect(snapshots.list()[0]!.start.incomplete).toBe(false);
        expect(existsSync(trace)).toBe(false);
    });

    test("reopening only hardens current trees, never historical objects", async () => {
        const { cwd, dir } = setup({ "current.txt": "before\n" });
        const folder = join(dir, "turn-snapshots", "objects", "ab");
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        const historical = join(folder, "f".repeat(38));
        writeFileSync(historical, "historical object outside the current tree", { mode: 0o600 });
        const before = statSync(historical, { bigint: true }).ctimeNs;
        const snapshots = new TurnSnapshots(dir, cwd);
        await snapshots.begin(1, "Only current objects need permission updates");
        await snapshots.end();
        expect(snapshots.list()[0]!.start.incomplete).toBe(false);
        expect(statSync(historical, { bigint: true }).ctimeNs).toBe(before);
    });

    test("tree planning matches Git directory ordering and SHA-256 object ids", async () => {
        const { cwd, dir, snapshots } = setup({ "a/item.txt": "one\n", "a.c": "two\n", "a0.txt": "three\n" }, "sha256");
        await snapshots.begin(1, "Change nested content");
        write(cwd, "a/item.txt", "after\n");
        await snapshots.end();
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(result.incomplete).toBe(false);
        expect(snapshots.list()[0]!.start.tree).toHaveLength(64);
        expect(result.files.map((f) => f.path)).toEqual(["a/item.txt"]);
        expectPrivate(dir);
    });

    test("snapshot replies defer files beyond the byte budget without claiming objects are missing", async () => {
        const { cwd, dir } = setup();
        const snapshots = new TurnSnapshots(dir, cwd, { budgetMs: 10_000 });
        const fill = "a".repeat(1024 * 1024 - 100);
        for (let i = 0; i < 35; i++) write(cwd, `file-${i}.txt`, `${i} before ${fill}\n`);
        await snapshots.begin(1, "Change many files");
        for (let i = 0; i < 35; i++) write(cwd, `file-${i}.txt`, `${i} after ${fill}\n`);
        await snapshots.end();
        const result = await snapshots.changes({ scope: "last-turn" });
        expect(result.incomplete).toBe(false);
        const deferred = result.files.find((f) => f.deferred);
        expect(deferred).toBeDefined();
        const single = await snapshots.changes({ scope: "turn", turnId: 1, path: deferred!.path });
        expect(single.incomplete).toBe(false);
        expect(single.files[0]!.deferred).toBeUndefined();
        expect(single.files[0]!.added).toBe(1);
    }, 120_000);

    test("a capture of many new files is one pack, and reads as loose objects do", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 400; i++) files[`src/d${i % 7}/f${i}.txt`] = `file ${i}\n`;
        const { cwd, dir, snapshots } = setup(files, "sha1", { untracked: true });
        await snapshots.begin(1, "Change one of many");
        write(cwd, "src/d0/f0.txt", "changed\n");
        await snapshots.end();
        const turn = snapshots.list()[0]!;
        expect([turn.start.incomplete, turn.end!.incomplete]).toEqual([false, false]);
        expect(turn.changed).toEqual(["src/d0/f0.txt"]);
        const objects = objectsDir(dir);
        const names = readdirSync(join(objects, "pack")).sort();
        expect(names.map((n) => n.replace(/-[0-9a-f]+/, ""))).toEqual(["pack.idx", "pack.pack"]);
        // Only what the turn changed is outside it: the file and the trees above it.
        expect(readdirSync(objects).filter((n) => n !== "pack").flatMap((n) => readdirSync(join(objects, n))).length).toBeLessThanOrEqual(4);
        expectPrivate(objects);
        const shown = await snapshots.changes({ scope: "last-turn", path: "src/d0/f0.txt" });
        expect(shown.files.map((f) => [f.path, f.added, f.removed])).toEqual([["src/d0/f0.txt", 1, 1]]);
        expect(JSON.stringify(shown)).toContain("file 0");

        // Reopened, what's in the pack isn't stored again.
        const before = inventory(objects);
        const reopened = new TurnSnapshots(dir, cwd);
        await reopened.begin(2, "Nothing new");
        await reopened.end();
        expect(reopened.list()[1]!.end!.incomplete).toBe(false);
        expect(inventory(objects)).toEqual(before);
        expect((await reopened.changes({ scope: "turn", turnId: 1 })).files.map((f) => f.path)).toEqual(["src/d0/f0.txt"]);
    });

    test("reopened, a pack whose index was cut off or never came is written again", async () => {
        const cutOff = (index: string, whole: Buffer) => writeFileSync(index, whole.subarray(0, 8 + 256 * 4 + whole.readUInt32BE(8 + 255 * 4) * 20));
        for (const leave of [cutOff, (index: string) => rmSync(index)]) {
            const files: Record<string, string> = {};
            for (let i = 0; i < 400; i++) files[`src/f${i}.txt`] = `file ${i}\n`;
            const { cwd, dir, snapshots } = setup(files, "sha1", { untracked: true });
            await snapshots.begin(1, "Many files");
            await snapshots.end();
            const folder = join(objectsDir(dir), "pack");
            const index = join(folder, readdirSync(folder).find((n) => n.endsWith(".idx"))!);
            leave(index, readFileSync(index));
            const reopened = new TurnSnapshots(dir, cwd);
            await reopened.begin(2, "Change one");
            write(cwd, "src/f0.txt", "changed\n");
            await reopened.end();
            expect(reopened.list()[1]!.end!.incomplete).toBe(false);
            expect(JSON.stringify(await reopened.changes({ scope: "turn", turnId: 2 }))).toContain("file 0");
            expectPrivate(objectsDir(dir));
        }
    });

    test("sessions in one repository share what they know of its files, and each keeps its own objects", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 400; i++) files[`src/f${i}.txt`] = `file ${i}\n`;
        const { cwd, dir, snapshots } = setup(files, "sha1", { untracked: true });
        await snapshots.begin(1, "First");
        await snapshots.end();

        const otherDir = join(dirname(dir), `${next++}-other`);
        mkdirSync(otherDir, { recursive: true });
        const other = new TurnSnapshots(otherDir, cwd);
        await other.begin(1, "Second session");
        write(cwd, "src/f0.txt", "changed\n");
        await other.end();
        expect(other.list()[0]!.end!.incomplete).toBe(false);
        // Known to the first session doesn't mean it's in this one's store: it can still show what it replaced.
        expect(readdirSync(join(objectsDir(otherDir), "pack")).filter((n) => n.endsWith(".pack")).length).toBe(1);
        expect(JSON.stringify(await other.changes({ scope: "turn", turnId: 1 }))).toContain("file 0");
        expect((other as any).known).toBe((snapshots as any).known);

        // The first session learns the changed file from the second, and still stores it itself.
        await snapshots.begin(3, "Next");
        await snapshots.end();
        expect(snapshots.list()[1]!.end!.incomplete).toBe(false);
        write(cwd, "src/f0.txt", "file 0\n");
        await snapshots.begin(5, "Back");
        write(cwd, "src/f1.txt", "also changed\n");
        await snapshots.end();
        const shown = await snapshots.changes({ scope: "last-turn" });
        expect(shown.files.map((f) => f.path)).toEqual(["src/f1.txt"]);
        expect(JSON.stringify(shown)).toContain("also changed");
    });

    test("a pack works in a SHA-256 repository", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 300; i++) files[`f${i}.txt`] = `file ${i}\n`;
        const { cwd, dir, snapshots } = setup(files, "sha256", { untracked: true });
        await snapshots.begin(1, "Change one");
        write(cwd, "f1.txt", "changed\n");
        await snapshots.end();
        expect(snapshots.list()[0]!.changed).toEqual(["f1.txt"]);
        const before = inventory(objectsDir(dir));
        const reopened = new TurnSnapshots(dir, cwd);
        await reopened.begin(2, "Nothing new");
        await reopened.end();
        expect(inventory(objectsDir(dir))).toEqual(before);
    });

    test("big files go into a pack too, and each pack's bytes count toward the quota", async () => {
        const big = (seed: number) => Buffer.from(Array.from({ length: 5 * 1024 * 1024 }, (_, i) => (i * 2654435761 + seed * 97) % 251));
        const { cwd, dir, snapshots } = setup({ "a.bin": big(1), "b.bin": big(2) }, "sha1", { untracked: true });
        await snapshots.begin(1, "Two big files");
        await snapshots.end();
        const turn = snapshots.list()[0]!;
        expect(turn.start.incomplete).toBe(false);
        expect(readdirSync(join(objectsDir(dir), "pack")).length).toBe(2);
        expect(git(cwd, ["cat-file", "-s", `${turn.start.tree}:a.bin`], { GIT_OBJECT_DIRECTORY: objectsDir(dir) }).toString().trim()).toBe(String(5 * 1024 * 1024));

        const small = setup(Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}.txt`, `file ${i}\n`])), "sha1", { untracked: true });
        const limited = new TurnSnapshots(small.dir, small.cwd, { maxStoreBytes: 500 });
        await limited.begin(1, "Over the limit");
        const start = limited.list()[0]!.start;
        expect(start.incomplete).toBe(true);
        expect(start.notes.join(" ")).toContain("Snapshot storage limit reached");
        // Nothing's left half written, and a later capture with room finishes.
        const roomy = new TurnSnapshots(small.dir, small.cwd);
        await roomy.begin(2, "Room again");
        expect(roomy.list().at(-1)!.start.incomplete).toBe(false);
    });

    test("over the limit partway through a pack: what fitted is kept and counted, and what didn't is read again", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 400; i++) files[`f${i}.txt`] = `file ${i} ${"x".repeat(200)}\n`;
        const { cwd, dir } = setup(files, "sha1", { untracked: true });
        const limited = new TurnSnapshots(dir, cwd, { maxStoreBytes: 4000 });
        await limited.begin(1, "Over the limit");
        expect(limited.list()[0]!.start.notes.join(" ")).toContain("Snapshot storage limit reached");
        const packed = readdirSync(join(objectsDir(dir), "pack")).map((n) => statSync(join(objectsDir(dir), "pack", n)).size);
        expect(packed.length).toBe(2);
        expect(packed[0]! + packed[1]!).toBeLessThanOrEqual(4000);
        expect(packed[0]! + packed[1]!).toBeGreaterThan(3000);
        // With room, it finishes, the file it hadn't got to included.
        const roomy = new TurnSnapshots(dir, cwd);
        await roomy.begin(2, "Room again");
        write(cwd, "f399.txt", "changed\n");
        await roomy.end();
        expect(roomy.list().at(-1)!.start.incomplete).toBe(false);
        expect(roomy.list().at(-1)!.changed).toEqual(["f399.txt"]);
        const shown = await roomy.changes({ scope: "last-turn", path: "f399.txt" });
        expect(JSON.stringify(shown)).toContain("file 399");
    });

    test("however often a capture's taken, what's in a pack isn't written again", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 300; i++) files[`f${i}.txt`] = `file ${i}\n`;
        const { dir, snapshots } = setup(files, "sha1", { untracked: true });
        await snapshots.begin(1, "Stored");
        await snapshots.end();
        expect(readdirSync(join(objectsDir(dir), "pack")).length).toBe(2);
        const before = inventory(objectsDir(dir));
        await snapshots.begin(2, "Again");
        await snapshots.end();
        expect(inventory(objectsDir(dir))).toEqual(before);
    });

    test("files as Git's index has them are taken from it, and what a turn changes is kept privately", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 400; i++) files[`src/f${i}.txt`] = `file ${i}\n`;
        const { cwd, dir, snapshots } = setup(files);
        await snapshots.begin(1, "Change one of many");
        // Nothing was read into the store, nor a tree made: the files and their trees are the ones Git has.
        expect(storedCount(objectsDir(dir))).toBe(0);
        write(cwd, "src/f7.txt", "changed\n");
        await snapshots.end();
        const turn = snapshots.list()[0]!;
        expect([turn.start.incomplete, turn.end!.incomplete]).toEqual([false, false]);
        expect(turn.changed).toEqual(["src/f7.txt"]);
        // Both versions of what changed are the session's own: the diff outlives the repository's objects.
        rmSync(join(cwd, ".git/objects"), { recursive: true });
        mkdirSync(join(cwd, ".git/objects"));
        const shown = await new TurnSnapshots(dir, cwd).changes({ scope: "last-turn" });
        expect(shown.incomplete).toBe(false);
        expect(shown.files.map((f) => [f.path, f.added, f.removed])).toEqual([["src/f7.txt", 1, 1]]);
        expect(JSON.stringify(shown)).toContain("file 7");
        expectPrivate(dir);
    });

    test("a file Git stores converted (attributes, core.autocrlf) is captured as its bytes, not taken from the index", async () => {
        const crlf = "one\r\ntwo\r\n";
        for (const convert of [(cwd: string) => write(cwd, ".gitattributes", "*.txt text eol=crlf\n"), (cwd: string) => git(cwd, ["config", "core.autocrlf", "true"])]) {
            const { cwd, dir } = setup();
            convert(cwd);
            write(cwd, "a.txt", crlf);
            git(cwd, ["add", "-A"]);
            git(cwd, ["commit", "-q", "-m", "Converted"]);
            const snapshots = new TurnSnapshots(dir, cwd);
            await snapshots.begin(1, "Converted file");
            const tree = snapshots.list()[0]!.start.tree!;
            expect(git(cwd, ["cat-file", "blob", `${tree}:a.txt`], { GIT_OBJECT_DIRECTORY: objectsDir(dir), GIT_ALTERNATE_OBJECT_DIRECTORIES: "" }).toString()).toBe(crlf);
        }
    });

    test("a file stamped no earlier than its index was written is read: it could have changed without its stat showing it", async () => {
        const { cwd, dir } = setup({ "a.txt": "a\n" });
        const at = statSync(join(cwd, "a.txt")).mtime;
        utimesSync(join(cwd, ".git/index"), at, at);
        const snapshots = new TurnSnapshots(dir, cwd);
        await snapshots.begin(1, "Racily clean");
        // The file's own blob (its tree, the same as Git's, is Git's).
        expect(storedCount(objectsDir(dir))).toBe(1);
        expect(snapshots.list()[0]!.start.incomplete).toBe(false);
    });

    test("trees worked out again only where something changed agree with Git's, capture after capture", async () => {
        const { cwd, snapshots } = setup({ "a/b/c.txt": "c\n", "a/d.txt": "d\n", "e.txt": "e\n", "f/g.txt": "g\n" });
        const steps: (() => void)[] = [
            () => write(cwd, "a/b/new/deep.txt", "deep\n"),
            () => rmSync(join(cwd, "f"), { recursive: true }),
            () => { rmSync(join(cwd, "e.txt")); write(cwd, "e.txt/inside.txt", "now a folder\n"); },
            () => write(cwd, "a/d.txt", "d again\n"),
            () => rmSync(join(cwd, "a"), { recursive: true }),
        ];
        await snapshots.begin(1, "start");
        for (const [i, step] of steps.entries()) {
            step();
            await snapshots.begin(i + 2, `step ${i}`);
        }
        await snapshots.end();
        // Each capture's planned root matched git write-tree's, or it would be incomplete.
        for (const turn of snapshots.list()) expect([turn.start.incomplete, turn.end?.incomplete]).toEqual([false, false]);
        expect(snapshots.list().map((t) => t.changed)).toEqual([["a/b/new/deep.txt"], ["f/g.txt"], ["e.txt", "e.txt/inside.txt"], ["a/d.txt"], ["a/b/c.txt", "a/b/new/deep.txt", "a/d.txt"], []]);
    });

    test("a turn that changes thousands of committed files ends whole, with every version kept in one pack", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 3000; i++) files[`d${i % 30}/f${i}.txt`] = `line ${i}\n`;
        const { cwd, dir, snapshots } = setup(files);
        await snapshots.begin(1, "Change them all");
        for (let i = 0; i < 3000; i++) write(cwd, `d${i % 30}/f${i}.txt`, `line ${i} changed\n`);
        await snapshots.end();
        const turn = snapshots.list()[0]!;
        expect([turn.start.incomplete, turn.end!.incomplete]).toEqual([false, false]);
        expect(turn.changed!.length).toBe(3000);
        // The versions it started from, taken from the index, are the session's own now: the diff outlives the repository's objects.
        rmSync(join(cwd, ".git/objects"), { recursive: true });
        mkdirSync(join(cwd, ".git/objects"));
        const shown = await new TurnSnapshots(dir, cwd).changes({ scope: "last-turn", path: "d7/f7.txt" });
        expect(shown.files.map((f) => [f.path, f.added, f.removed])).toEqual([["d7/f7.txt", 1, 1]]);
        expectPrivate(dir);
    }, 60_000);

    test("a turn that changed nothing takes the last capture again; a change something else made is still seen", async () => {
        const { cwd, snapshots } = setup({ "a.txt": "a\n", "src/b.txt": "b\n" });
        await snapshots.begin(1, "Look only");
        await Bun.sleep(400);
        await snapshots.end();
        const quiet = snapshots.list()[0]!;
        // Nothing started or read: the start's capture, again.
        expect(quiet.end!.durationMs).toBe(0);
        expect(quiet.end!.tree).toBe(quiet.start.tree);
        expect(quiet.changed).toEqual([]);
        await Bun.sleep(400);
        await snapshots.begin(2, "Meanwhile, an editor saves");
        await Bun.sleep(400);
        write(cwd, "src/b.txt", "b, saved elsewhere\n");
        await Bun.sleep(400);
        await snapshots.end();
        expect(snapshots.list()[1]!.changed).toEqual(["src/b.txt"]);
        // A turn that wrote (a tool call that isn't read-only reached the folder) is always captured.
        await Bun.sleep(400);
        await snapshots.begin(3, "Write");
        snapshots.reach([cwd]);
        await snapshots.end();
        expect(snapshots.list()[2]!.end!.durationMs).toBeGreaterThan(0);
    }, 30_000);

    for (const version of [2, 4]) test(`a capture that looks only at what the watch saw change agrees with one that looks at everything (index version ${version})`, async () => {
        const { cwd, dir } = setup({ ".gitignore": "*.log\nbuild/\n", "a/b/c.txt": "c\n", "a/d.txt": "d\n", "e.txt": "e\n", "f/g.txt": "g\n", "h/i/j.txt": "j\n", "k.txt": "k\n", "run.sh": "echo\n" });
        git(cwd, ["config", "index.version", String(version)]);
        git(cwd, ["update-index", "--index-version", String(version)]);
        const outside = join(dirname(cwd), "outside");
        mkdirSync(outside);
        const snapshots = new TurnSnapshots(dir, cwd, { narrowFromMs: 0 });
        const steps: [string, () => void][] = [
            ["edit", () => write(cwd, "a/d.txt", "d again\n")],
            ["new folders", () => write(cwd, "n/o/p.txt", "p\n")],
            ["ignored", () => { write(cwd, "x.log", "log\n"); write(cwd, "build/out.js", "js\n"); }],
            ["move a folder within", () => renameSync(join(cwd, "h"), join(cwd, "h2"))],
            ["move a folder out", () => renameSync(join(cwd, "n"), join(outside, "n"))],
            ["move a folder in", () => renameSync(join(outside, "n"), join(cwd, "m"))],
            ["remove a folder", () => rmSync(join(cwd, "f"), { recursive: true })],
            ["file to folder", () => { rmSync(join(cwd, "e.txt")); write(cwd, "e.txt/inside.txt", "now a folder\n"); }],
            ["folder to file", () => { rmSync(join(cwd, "a/b"), { recursive: true }); write(cwd, "a/b", "now a file\n"); }],
            ["mode and link", () => { chmodSync(join(cwd, "run.sh"), 0o755); symlinkSync("k.txt", join(cwd, "link")); }],
            ["revert an edit", () => write(cwd, "a/d.txt", "d\n")],
            ["untracked gone", () => rmSync(join(cwd, "m"), { recursive: true })],
            ["nested repository", () => { mkdirSync(join(cwd, "nest")); git(join(cwd, "nest"), ["init", "-q"]); write(cwd, "nest/inner.txt", "inner\n"); }],
            ["inside the nested one", () => write(cwd, "nest/inner.txt", "inner again\n")],
            ["staged", () => { write(cwd, "k.txt", "k staged\n"); git(cwd, ["add", "k.txt"]); }],
            ["after staging", () => write(cwd, "k.txt", "k again\n")],
            ["git status rewrites the index", () => { utimesSync(join(cwd, "h2/i/j.txt"), new Date(), new Date()); git(cwd, ["status", "--porcelain"]); }],
            ["committed", () => git(cwd, ["commit", "-q", "-m", "Two"])],
            ["after the commit", () => write(cwd, "a/d.txt", "d at last\n")],
            ["edited, staged and committed", () => { write(cwd, "a/d.txt", "d committed\n"); git(cwd, ["add", "a/d.txt"]); git(cwd, ["commit", "-q", "-m", "Three"]); }],
            ["an ignored file forced in", () => { git(cwd, ["add", "-f", "x.log"]); git(cwd, ["commit", "-q", "-m", "Four"]); }],
            ["and taken out again", () => { git(cwd, ["rm", "-q", "--cached", "x.log"]); git(cwd, ["commit", "-q", "-m", "Five"]); }],
        ];
        await snapshots.begin(1, "start");
        /** The steps whose capture looked at everything. */
        const whole: string[] = [];
        /** The steps whose first capture couldn't take what `git status` said. */
        const notFromStatus: string[] = [];
        for (const [i, [name, step]] of steps.entries()) {
            await Bun.sleep(60);
            step();
            await Bun.sleep(60);
            const before = snapshots.narrowedCount;
            await snapshots.begin(i + 2, name);
            if (snapshots.narrowedCount === before) whole.push(name);
            const full = new TurnSnapshots(join(dirname(dir), `full-${i}`), cwd);
            await full.begin(1, name);
            const [mine, theirs] = [snapshots.list().at(-1)!.start, full.list()[0]!.start];
            expect([name, mine.incomplete, mine.tree, Object.keys(mine.skipped).sort()]).toEqual([name, theirs.incomplete, theirs.tree, Object.keys(theirs.skipped).sort()]);
            // A first capture from what `git status` says differs, as a big repository's is: the same.
            const status = new TurnSnapshots(join(dirname(dir), `status-${i}`), cwd, { statusFromEntries: 0 });
            await status.begin(1, name);
            const fromStatus = status.list()[0]!.start;
            expect([name, fromStatus.incomplete, fromStatus.tree, Object.keys(fromStatus.skipped).sort()]).toEqual([name, theirs.incomplete, theirs.tree, Object.keys(theirs.skipped).sort()]);
            if (!status.statusCount) notFromStatus.push(name);
            await status.stop();
            await full.stop();
        }
        await snapshots.end();
        // The rest looked only at what changed. Staged with no tree Git worked out for it, Git's index is looked at
        // whole; rewritten as it was (git status), or committed (both trees there to compare), it isn't.
        expect(whole).toEqual(["staged"]);
        // Staged, Git has no tree worked out for its index until the commit: there's none to start from till then.
        expect(notFromStatus).toEqual(["staged", "after staging", "git status rewrites the index"]);
        await snapshots.stop();
    }, 60_000);

    test("what a turn changed is what git diff-tree finds between its trees: files that became folders, and the reverse, too", async () => {
        const { cwd, dir } = setup({ "a/b/c.txt": "c\n", "a-b": "ab\n", "z/y": "y\n", "é": "e\n", "keep/deep/k.txt": "k\n" });
        const snapshots = new TurnSnapshots(dir, cwd, { narrowFromMs: 0 });
        const names = ["a", "a-b", "a.txt", "a/b", "a/b/c", "a/b/c/d.txt", "a/b-c", "a/x", "z", "z/é.txt", "z/y", "é", "link"];
        let seed = 11;
        const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
        const onDisk = () => {
            const out = new Set<string>();
            for (const line of git(cwd, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]).toString().split("\0")) if (line && existsSync(join(cwd, line))) out.add(line);
            return out;
        };
        for (let round = 0; round < 25; round++) {
            await snapshots.begin(round + 1, `round ${round}`);
            await Bun.sleep(40);
            for (let k = random(3) + 1; k > 0; k--) {
                const name = names[random(names.length)]!;
                const files = onDisk();
                if (files.has(name) && random(2)) rmSync(join(cwd, name), { force: true });
                else {
                    // A file where a folder was (or the other way): what was in its way goes.
                    for (const p of files) if (p.startsWith(`${name}/`) || name.startsWith(`${p}/`)) rmSync(join(cwd, p), { recursive: true, force: true });
                    if (existsSync(join(cwd, name)) && lstatSync(join(cwd, name)).isDirectory()) rmSync(join(cwd, name), { recursive: true, force: true });
                    if (name === "link") { rmSync(join(cwd, name), { force: true }); symlinkSync(`target-${round}`, join(cwd, name)); }
                    else write(cwd, name, `round ${round}\n`);
                }
            }
            snapshots.reach([cwd]);
            await snapshots.end();
            const turn = snapshots.list().at(-1)!;
            const env = { GIT_OBJECT_DIRECTORY: objectsDir(dir), GIT_ALTERNATE_OBJECT_DIRECTORIES: join(cwd, ".git/objects") };
            const theirs = git(cwd, ["diff-tree", "-r", "-z", "--no-renames", "--name-only", turn.start.tree!, turn.end!.tree!], env).toString().split("\0").filter(Boolean).sort();
            expect([round, [...(turn.changed ?? [])].sort()]).toEqual([round, theirs]);
        }
        await snapshots.stop();
    }, 60_000);

    test("a turn that starts with nothing changed since the last one's end starts from that end, without looking again", async () => {
        const { cwd, dir } = setup({ "a.txt": "a\n", "b/c.txt": "c\n" });
        const snapshots = new TurnSnapshots(dir, cwd, { narrowFromMs: 0 });
        await snapshots.begin(1, "first");
        await Bun.sleep(60);
        write(cwd, "b/c.txt", "c changed\n");
        snapshots.reach([cwd]);
        await snapshots.end();
        const ended = snapshots.list()[0]!.end!;
        expect(snapshots.narrowedCount).toBe(1);
        // As a next prompt does once its turn's end is in.
        await Bun.sleep(300);
        await snapshots.begin(2, "second");
        const started = snapshots.list().at(-1)!.start;
        expect([started.tree, started.durationMs, snapshots.narrowedCount]).toEqual([ended.tree, 0, 1]);
        // Something changed meanwhile: looked at again.
        write(cwd, "a.txt", "a changed\n");
        await Bun.sleep(60);
        snapshots.reach([cwd]);
        await snapshots.end();
        await Bun.sleep(300);
        write(cwd, "d.txt", "new\n");
        await Bun.sleep(60);
        await snapshots.begin(3, "third");
        expect(snapshots.narrowedCount).toBe(3);
        expect(snapshots.list().at(-1)!.start.tree).not.toBe(snapshots.list().at(-2)!.end!.tree);
        await snapshots.stop();
    }, 30_000);

    test("a whole capture a turn can't wait for goes on, and the next turns start from it", async () => {
        const files: Record<string, string> = {};
        for (let i = 0; i < 3000; i++) files[`d${i % 30}/f${i}.txt`] = `line ${i}\n`;
        const { cwd, dir } = setup(files);
        const snapshots = new TurnSnapshots(dir, cwd, { turnBudgetMs: 1, narrowFromMs: 0 });
        await snapshots.begin(1, "Too soon");
        const first = snapshots.list()[0]!.start;
        expect([first.incomplete, first.tree]).toEqual([true, undefined]);
        // It goes on in the background; once it's in, captures look only at what changed since.
        write(cwd, "d1/f1.txt", "changed\n");
        await Bun.sleep(100);
        const later = new TurnSnapshots(dir, cwd);
        expect(later.list().length).toBe(1);
        // Turns that wait as long as they usually do; while it goes on, a turn doesn't wait for it (incomplete at once).
        (snapshots as unknown as { options: { turnBudgetMs?: number } }).options.turnBudgetMs = undefined;
        const whole = () => (snapshots as unknown as { whole?: Promise<void> }).whole;
        if (whole()) {
            const t = Date.now();
            await snapshots.begin(2, "While it goes on");
            expect(Date.now() - t).toBeLessThan(1500);
            // Unless it came in while this waited for it (up to 100 ms).
            if (whole()) expect(snapshots.list()[1]!.start.incomplete).toBe(true);
            await whole();
        }
        const before = snapshots.narrowedCount;
        await snapshots.begin(3, "In time");
        // From the one that went on: only what changed was looked at, and found as a whole capture finds it.
        expect(snapshots.narrowedCount).toBe(before + 1);
        const everything = new TurnSnapshots(join(dirname(dir), "whole"), cwd);
        await everything.begin(1, "Everything");
        expect(snapshots.list().at(-1)!.start.tree).toBe(everything.list()[0]!.start.tree!);
        await everything.stop();
        write(cwd, "d2/f2.txt", "changed in the turn\n");
        await snapshots.end();
        const second = snapshots.list().at(-1)!;
        expect([second.start.incomplete, second.end!.incomplete]).toEqual([false, false]);
        expect(snapshots.list().at(-1)!.changed).toEqual(["d2/f2.txt"]);
        await snapshots.stop();
    }, 60_000);

    test("snapshots are pruned with file history after thirty days", async () => {
        const { cwd } = setup({ "a.txt": "a\n" });
        const dir = join(paths.projectsDir(), `snapshot-prune-${next++}`, "file-history", "old-session");
        const snapshots = new TurnSnapshots(dir, cwd);
        await snapshots.begin(1, "An old turn");
        await snapshots.end();
        expect(existsSync(dir)).toBe(true);
        const now = Date.now();
        const old = new Date(now - HISTORY_MAX_AGE_MS - 60_000);
        const age = (p: string) => {
            if (lstatSync(p).isDirectory()) for (const name of readdirSync(p)) age(join(p, name));
            utimesSync(p, old, old);
        };
        age(dir);
        expect(await pruneFileHistory({ now })).toContain(dir);
        expect(existsSync(dir)).toBe(false);
    });
});
