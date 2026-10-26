import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "fs";
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

function setup(files: Record<string, string | Buffer> = {}, format: "sha1" | "sha256" = "sha1") {
    const base = join(realpathSync(iso.home), `snapshot-${next++}`);
    const cwd = join(base, "repo");
    const dir = join(base, "history");
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q", "-b", "main", `--object-format=${format}`]);
    for (const [path, body] of Object.entries(files)) write(cwd, path, body);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "--allow-empty", "-m", "Initial commit"]);
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
        const { cwd, dir } = setup({ "a.txt": "before\n" });
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
        rmSync(join(objects, oid.slice(0, 2), oid.slice(2)));
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
