// The server keeps at most 2 `git cat-file` readers open for snapshots, every session's together (turn-snapshots.ts).
import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { TurnSnapshots, openReaderCount } = await import("../src/agent/turn-snapshots");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

const IDENTITY = ["-c", "maintenance.auto=false", "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Cavvy Test", "-c", "user.email=test@example.invalid"];

function git(cwd: string, args: string[]): string {
    const env = gitEnv();
    for (const k of Object.keys(env)) if (k.startsWith("GIT_")) delete env[k];
    const r = Bun.spawnSync(gitArgv([...IDENTITY, ...args]), { cwd, env: { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
}

let next = 0;
/** A repository with one commit, and `n` sessions on it, each in a turn (so they read the repository's objects). */
async function setup(n: number) {
    const base = join(realpathSync(iso.home), `readers-${next++}`);
    const cwd = join(base, "repo");
    mkdirSync(join(cwd, "src"), { recursive: true });
    writeFileSync(join(cwd, "src", "a.ts"), "export const a = 1;\n");
    writeFileSync(join(cwd, "README.md"), "# readers\n");
    git(cwd, ["init", "-q", "-b", "main"]);
    git(cwd, ["add", "-A"]);
    git(cwd, ["commit", "-q", "-m", "Initial commit"]);
    const tree = git(cwd, ["rev-parse", "HEAD^{tree}"]).trim();
    const body = Buffer.from(Bun.spawnSync(gitArgv(["cat-file", "tree", tree]), { cwd }).stdout);
    const sessions = Array.from({ length: n }, (_, i) => new TurnSnapshots(join(base, `history-${i}`), cwd));
    for (const s of sessions) {
        await s.begin(1, "a turn");
        await s.settled();
    }
    return { cwd, tree, body, sessions };
}

/** `cat-file --batch` readers started while `f` runs. */
async function startsDuring(f: () => Promise<unknown>): Promise<number> {
    let starts = 0;
    const spawn = Bun.spawn;
    const spy = spyOn(Bun, "spawn").mockImplementation(((argv: any, opts: any) => {
        if (Array.isArray(argv) && argv.includes("cat-file") && argv.includes("--batch")) starts++;
        return spawn(argv, opts);
    }) as typeof Bun.spawn);
    try {
        await f();
    } finally {
        spy.mockRestore();
    }
    return starts;
}

/** Waits until `ok` holds, for at most `ms`. */
async function until(ok: () => boolean, ms = 5000) {
    for (const end = Date.now() + ms; !ok() && Date.now() < end; ) await Bun.sleep(20);
}

/** A read of the root tree with session `s`'s reader, after `wait` if given (the reader is busy until then). */
function read(s: InstanceType<typeof TurnSnapshots>, cwd: string, tree: string, wait?: Promise<void>): Promise<Buffer> {
    return (s as any).withReader(cwd, Date.now() + 10_000, async (r: { read(oid: string, type: string): Promise<Buffer> }) => {
        await wait;
        return r.read(tree, "tree");
    });
}

test("however many sessions read, at most 2 readers stay open, and each read is right", async () => {
    const { cwd, tree, body, sessions } = await setup(5);
    try {
        for (let round = 0; round < 2; round++)
            for (const s of sessions) {
                expect(await read(s, cwd, tree)).toEqual(body);
                expect(openReaderCount()).toBeLessThanOrEqual(2);
            }
    } finally {
        await Promise.all(sessions.map((s) => s.stop()));
    }
    expect(openReaderCount()).toBe(0);
});

test("a reader that's reading is never let go: another session gets one more, and the count comes back down", async () => {
    const { cwd, tree, body, sessions } = await setup(3);
    try {
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        const busy = [read(sessions[0]!, cwd, tree, gate), read(sessions[1]!, cwd, tree, gate)];
        // Both readers are mid-read: the third session can't take either, so it opens one past the limit.
        expect(await read(sessions[2]!, cwd, tree)).toEqual(body);
        release();
        for (const b of busy) expect(await b).toEqual(body);
        // Once they've been idle a moment (READERS_GRACE_MS), back to 2.
        await until(() => openReaderCount() <= 2);
        expect(openReaderCount()).toBeLessThanOrEqual(2);
    } finally {
        await Promise.all(sessions.map((s) => s.stop()));
    }
    expect(openReaderCount()).toBe(0);
});

test("a reader closed some other way (its own deadline, say) is no longer counted, and its session starts another", async () => {
    const { cwd, tree, body, sessions } = await setup(1);
    const s = sessions[0]!;
    try {
        await read(s, cwd, tree);
        expect(openReaderCount()).toBe(1);
        (s as any).reader.reader.close();
        expect(openReaderCount()).toBe(0);
        expect(await read(s, cwd, tree)).toEqual(body);
        expect(openReaderCount()).toBe(1);
    } finally {
        await s.stop();
    }
    expect(openReaderCount()).toBe(0);
});

test("sessions reading at the same time keep their readers: a walk's reads don't each start a git", async () => {
    const { cwd, tree, body, sessions } = await setup(3);
    try {
        // Each walks 40 trees one after another, all at once, as turns ending together do. Between two of a session's
        // reads its reader is idle for a moment: it isn't let go for that.
        const starts = await startsDuring(() =>
            Promise.all(sessions.map(async (s) => {
                for (let i = 0; i < 40; i++) expect(await read(s, cwd, tree)).toEqual(body);
            })),
        );
        expect(starts).toBeLessThanOrEqual(sessions.length);
        await until(() => openReaderCount() <= 2);
        expect(openReaderCount()).toBeLessThanOrEqual(2);
    } finally {
        await Promise.all(sessions.map((s) => s.stop()));
    }
    expect(openReaderCount()).toBe(0);
});
