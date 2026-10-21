// Deleting a session from the GUI: its files go to the Harness home's trash
// and come back on Undo; nothing outside the Harness home is touched.

import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, symlinkSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { findSessionAnywhere } = await import("../src/agent/session");
const { purgeTrash, trashDir } = await import("../src/server/session-delete");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
import type { ServerEvent, SessionSearchResult, SessionSnapshot, SessionSummary } from "../src/server/protocol";

const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

afterAll(() => {
    mock.stop();
    iso.cleanup();
});

const DAY = 24 * 60 * 60 * 1000;
const holder = join(import.meta.dir, "fixtures", "hold-session.ts");
const gone = (p: string) => {
    try {
        lstatSync(p);
        return false;
    } catch {
        return true;
    }
};
const mode = (p: string) => lstatSync(p).mode & 0o777;
const store = () => JSON.parse(readFileSync(join(iso.home, "gui.json"), "utf-8")) as Record<string, string[]>;
const git = (cwd: string, ...args: string[]) => new TextDecoder().decode(Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" }).stdout);
const fails = (p: Promise<unknown>) => p.then(() => ({ code: "resolved" }) as { code?: string }, (e) => e as { code?: string });

/** An engine with one saved session (a turn, a UI log, file history), open but idle. */
async function setup(cwd = createDemoProject(tempDir("harness-del-proj-"), { git: false })) {
    const engine = new Engine({ unloadAfterMs: 100 });
    const events: ServerEvent[] = [];
    const c = { subs: new Set<string>(), send: (e: ServerEvent) => void events.push(e) };
    engine.clients.add(c);
    const snap = (await engine.handle(c, "session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    await engine.handle(c, "session.send", { id, text: "first prompt" });
    for (let i = 0; i < 200 && !(rt.idle && rt.session.messages.length >= 2); i++) await Bun.sleep(25);
    expect(rt.idle).toBe(true);
    const file = findSessionAnywhere(id)!;
    const dir = dirname(file);
    const f = {
        file,
        lock: `${file}.lock`,
        ui: join(dir, "ui", `${id}.jsonl`),
        history: join(dir, "file-history", id),
        queue: join(dir, "queue", `${id}.json`),
    };
    if (!existsSync(f.ui)) {
        mkdirSync(dirname(f.ui), { recursive: true, mode: 0o700 });
        writeFileSync(f.ui, '{"t":"x"}\n', { mode: 0o600 });
    }
    return { engine, c, events, id, rt, cwd, f };
}

function addHistory(dir: string) {
    mkdirSync(join(dir, "blobs"), { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, "index.jsonl"), '{"checkpoint":1}\n', { mode: 0o600 });
    writeFileSync(join(dir, "blobs", "abc"), "old contents", { mode: 0o600 });
}

/** Close it in this engine and wait until its lock is let go. */
async function unload(engine: InstanceType<typeof Engine>, c: { subs: Set<string> }, id: string, lock: string) {
    await engine.handle(c as never, "session.close", { id });
    for (let i = 0; i < 100 && existsSync(lock); i++) await Bun.sleep(25);
    expect(existsSync(lock)).toBe(false);
}

describe("session.delete", () => {
    test("cached message hits disappear after deletion, fail to open, and return on Undo", async () => {
        const { engine, c, id } = await setup();
        try {
            const search = async () => (await engine.handle(c, "sessions.search", { query: "first prompt" })) as SessionSearchResult;
            const before = await search();
            const hit = before.hits.find((h) => h.id === id)!;
            expect(hit).toMatchObject({ id, role: "user", seg: 0, index: 0 });
            expect((await search()).hits).toContainEqual(hit); // warm cache
            await engine.handle(c, "session.delete", { id });
            const after = await search();
            expect(after.partial).toBe(false);
            expect(after.hits.some((h) => h.id === id)).toBe(false);
            expect((await fails(engine.handle(c, "session.open", { id: hit.id }))).code).toBe("not_found");
            await engine.handle(c, "session.restore", { id });
            expect((await search()).hits).toContainEqual(hit);
            const opened = await engine.handle(c, "session.open", { id: hit.id }) as SessionSnapshot;
            expect(opened.turns[0]).toMatchObject({ pos: { seg: hit.seg, index: hit.index }, prompt: { text: "first prompt" } });
        } finally {
            await engine.stop();
        }
    }, 30_000);

    test("moves the session's files out of projects/ and Undo brings back the same bytes, pin and archived state", async () => {
        const cwd = createDemoProject(tempDir("harness-del-git-"));
        const { engine, c, events, id, f } = await setup(cwd);
        try {
            addHistory(f.history);
            // Messages that were waiting when it was last open.
            mkdirSync(dirname(f.queue), { recursive: true, mode: 0o700 });
            writeFileSync(f.queue, '{"v":1,"items":[{"text":"later","mode":"queue"}]}', { mode: 0o600 });
            await engine.handle(c, "session.pin", { id, pinned: true });
            await engine.handle(c, "session.archive", { id, archived: true });
            const bytes = { file: readFileSync(f.file), ui: readFileSync(f.ui), queue: readFileSync(f.queue), index: readFileSync(join(f.history, "index.jsonl")), blob: readFileSync(join(f.history, "blobs", "abc")) };
            const before = { status: git(cwd, "status", "--porcelain"), readme: readFileSync(join(cwd, "README.md")) };
            expect(existsSync(f.lock)).toBe(true);

            await engine.handle(c, "session.delete", { id });
            for (const p of [f.file, f.lock, f.ui, f.history, f.queue]) expect(gone(p)).toBe(true);
            expect(engine.runtimes.has(id)).toBe(false);
            expect(store().pinned ?? []).not.toContain(id);
            expect(store().archived ?? []).not.toContain(id);
            expect(events).toContainEqual({ type: "sessions.remove", id });
            for (const archived of [false, true]) expect(((await engine.handle(c, "sessions.list", { archived })) as SessionSummary[]).some((s) => s.id === id)).toBe(false);
            expect((await fails(engine.handle(c, "session.open", { id }))).code).toBe("not_found");
            expect(git(cwd, "status", "--porcelain")).toBe(before.status);
            expect(readFileSync(join(cwd, "README.md"))).toEqual(before.readme);
            expect(existsSync(join(trashDir(), id, "transcript.jsonl"))).toBe(true);

            await engine.handle(c, "session.restore", { id });
            expect(readFileSync(f.file)).toEqual(bytes.file);
            expect(readFileSync(f.ui)).toEqual(bytes.ui);
            expect(readFileSync(f.queue)).toEqual(bytes.queue);
            expect(readFileSync(join(f.history, "index.jsonl"))).toEqual(bytes.index);
            expect(readFileSync(join(f.history, "blobs", "abc"))).toEqual(bytes.blob);
            expect([mode(f.file), mode(f.ui), mode(f.history)]).toEqual([0o600, 0o600, 0o700]);
            expect(gone(join(trashDir(), id))).toBe(true);
            const back = ((await engine.handle(c, "sessions.list", { archived: true })) as SessionSummary[]).find((s) => s.id === id);
            expect(back).toMatchObject({ pinned: true, archived: true });
            expect(events.some((e) => e.type === "sessions.upsert" && e.session.id === id && e.session.pinned && e.session.archived)).toBe(true);
            const snap = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
            expect(snap.turns.length).toBeGreaterThan(0);
            expect(((await engine.handle(c, "session.rewindTargets", { id })) as unknown[]).length).toBeGreaterThan(0);
            expect(git(cwd, "status", "--porcelain")).toBe(before.status);
        } finally {
            await engine.stop();
        }
    }, 30_000);

    test("Undo when gui.json can't be written: the session is back (as an active one), every window is told, and the user is warned", async () => {
        const { engine, c, events, id, f } = await setup();
        const gui = join(iso.home, "gui.json");
        try {
            await engine.handle(c, "session.pin", { id, pinned: true });
            await engine.handle(c, "session.archive", { id, archived: true });
            await engine.handle(c, "session.delete", { id });
            events.length = 0;
            chmodSync(gui, 0o400);
            await engine.handle(c, "session.restore", { id });
            chmodSync(gui, 0o600);
            expect(existsSync(f.file)).toBe(true);
            expect(events.some((e) => e.type === "sessions.upsert" && e.session.id === id && !e.session.archived && !e.session.pinned)).toBe(true);
            expect(events.some((e) => e.type === "toast" && e.level === "warn" && /couldn't be saved/.test(e.message))).toBe(true);
            expect(((await engine.handle(c, "sessions.list", {})) as SessionSummary[]).some((s) => s.id === id)).toBe(true);
        } finally {
            chmodSync(gui, 0o600);
            await engine.stop();
        }
    });

    test("a restore is refused once the id is taken again", async () => {
        const { engine, c, id, f } = await setup();
        try {
            await engine.handle(c, "session.delete", { id });
            writeFileSync(f.file, "someone else\n");
            expect((await fails(engine.handle(c, "session.restore", { id }))).code).toBe("exists");
            expect(readFileSync(f.file, "utf-8")).toBe("someone else\n");
            expect(existsSync(join(trashDir(), id, "transcript.jsonl"))).toBe(true);
        } finally {
            await engine.stop();
        }
    });

    test("opening it while it's being deleted waits, then finds nothing (and makes nothing)", async () => {
        const { engine, c, id, f } = await setup();
        try {
            const deleting = engine.handle(c, "session.delete", { id });
            const opening = fails(engine.handle(c, "session.open", { id }));
            await deleting;
            expect((await opening).code).toBe("not_found");
            for (const p of [f.file, f.lock, f.ui]) expect(gone(p)).toBe(true);
        } finally {
            await engine.stop();
        }
    });

    test("opened just before it's deleted, or renamed meanwhile, it's still deleted and nothing is left open", async () => {
        const { engine, c, id, f } = await setup();
        try {
            const opening = engine.handle(c, "session.open", { id });
            const deleting = engine.handle(c, "session.delete", { id });
            const renaming = fails(engine.handle(c, "session.rename", { id, title: "too late" }));
            await opening;
            await deleting;
            expect((await renaming).code).toBe("not_found");
            expect(engine.runtimes.has(id)).toBe(false);
            for (const p of [f.file, f.lock, f.ui]) expect(gone(p)).toBe(true);
            await engine.handle(c, "session.restore", { id });
            expect(readFileSync(f.file, "utf-8")).not.toContain("too late");
        } finally {
            await engine.stop();
        }
    });

    test("a cold open racing a delete (the session not loaded) ends deleted either way", async () => {
        const { engine, c, id, f } = await setup();
        try {
            await unload(engine, c, id, f.lock);
            expect(engine.runtimes.has(id)).toBe(false);
            // Opened first: it loads, then the delete closes it.
            const opening = engine.handle(c, "session.open", { id });
            const deleting = engine.handle(c, "session.delete", { id });
            await opening;
            await deleting;
            expect(engine.runtimes.has(id)).toBe(false);
            for (const p of [f.file, f.lock, f.ui]) expect(gone(p)).toBe(true);

            await engine.handle(c, "session.restore", { id });
            expect(engine.runtimes.has(id)).toBe(false);
            // Deleted first: the open waits, then finds nothing.
            const deleting2 = engine.handle(c, "session.delete", { id });
            const opening2 = fails(engine.handle(c, "session.open", { id }));
            await deleting2;
            expect((await opening2).code).toBe("not_found");
            expect(engine.runtimes.has(id)).toBe(false);
            for (const p of [f.file, f.lock, f.ui]) expect(gone(p)).toBe(true);
        } finally {
            await engine.stop();
        }
    });

    test("restore takes nothing from a trash folder that links out of the Harness home", async () => {
        const { engine, c, id, f } = await setup();
        try {
            await engine.handle(c, "session.delete", { id });
            const outside = tempDir("harness-del-outside-");
            renameSync(trashDir(), join(outside, "trash"));
            symlinkSync(join(outside, "trash"), trashDir());
            expect((await fails(engine.handle(c, "session.restore", { id }))).code).toBe("not_found");
            expect(existsSync(join(outside, "trash", id, "transcript.jsonl"))).toBe(true);
            expect(gone(f.file)).toBe(true);
            unlinkSync(trashDir());
            renameSync(join(outside, "trash"), trashDir());
        } finally {
            await engine.stop();
        }
    });

    test("is refused while a turn runs, and while another process has it open", async () => {
        const { engine, c, id, rt, f } = await setup();
        try {
            rt.busy = true;
            expect((await fails(engine.handle(c, "session.delete", { id }))).code).toBe("busy");
            rt.busy = false;
            expect(existsSync(f.file)).toBe(true);

            await unload(engine, c, id, f.lock);
            const child = Bun.spawn([process.execPath, "--no-env-file", holder, f.file], { stdin: "pipe", stdout: "pipe", env: process.env as Record<string, string> });
            try {
                expect(new TextDecoder().decode((await child.stdout.getReader().read()).value)).toContain("held");
                expect((await fails(engine.handle(c, "session.delete", { id }))).code).toBe("in_use");
                expect(existsSync(f.file) && existsSync(f.ui)).toBe(true);
            } finally {
                child.stdin.end();
                await child.exited;
            }
        } finally {
            rt.busy = false;
            await engine.stop();
        }
    }, 30_000);

    test("a delete that fails after closing it puts everything back, and the windows that had it open it again (not deleted)", async () => {
        const { engine, c, events, id, rt, f } = await setup();
        const elsewhere: ServerEvent[] = [];
        engine.clients.add({ subs: new Set<string>(), send: (e: ServerEvent) => void elsewhere.push(e) });
        try {
            await engine.handle(c, "session.pin", { id, pinned: true });
            const bytes = readFileSync(f.file);
            const turns = rt.snapshot().turns.length;
            events.length = 0;
            // The transcript moves, then the UI log can't: everything goes back.
            chmodSync(dirname(f.ui), 0o500);
            const err = await fails(engine.handle(c, "session.delete", { id }));
            chmodSync(dirname(f.ui), 0o700);
            expect(err.code).toBeUndefined();
            expect(readFileSync(f.file)).toEqual(bytes);
            expect(existsSync(f.ui)).toBe(true);
            expect(gone(join(trashDir(), id))).toBe(true);
            expect(store().pinned).toContain(id);

            // Not a delete: no window drops it (its draft and view stay); the one that had it open reloads it.
            expect(events.concat(elsewhere).some((e) => e.type === "sessions.remove")).toBe(false);
            expect(events).toContainEqual({ type: "session.reload", sessionId: id });
            expect(elsewhere.some((e) => e.type === "session.reload")).toBe(false);
            expect(elsewhere.some((e) => e.type === "sessions.upsert" && e.session.id === id && e.session.pinned)).toBe(true);
            expect(engine.runtimes.has(id)).toBe(false);
            expect(c.subs.has(id)).toBe(false);

            // What the window does on session.reload: open it again, and carry on in it.
            const snap = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
            expect(snap.turns.length).toBe(turns);
            expect(c.subs.has(id)).toBe(true);
            const again = engine.runtimes.get(id)!;
            await engine.handle(c, "session.send", { id, text: "first prompt" });
            for (let i = 0; i < 200 && !(again.idle && again.snapshot().turns.length > turns); i++) await Bun.sleep(25);
            expect(again.snapshot().turns.length).toBe(turns + 1);
            expect(((await engine.handle(c, "sessions.list", {})) as SessionSummary[]).find((s) => s.id === id)).toMatchObject({ pinned: true });
        } finally {
            chmodSync(dirname(f.ui), 0o700);
            await engine.stop();
        }
    }, 30_000);

    test("a folder that can't be searched stops the delete before anything moves or closes", async () => {
        const { engine, c, events, id, rt, f } = await setup();
        try {
            chmodSync(dirname(f.ui), 0o000);
            const err = await fails(engine.handle(c, "session.delete", { id }));
            chmodSync(dirname(f.ui), 0o700);
            expect(err.message).toMatch(/EACCES/);
            expect(engine.runtimes.get(id)).toBe(rt);
            expect(existsSync(f.file) && existsSync(f.ui)).toBe(true);
            expect(gone(join(trashDir(), id))).toBe(true);
            expect(events.some((e) => (e.type === "sessions.remove" && e.id === id) || (e.type === "session.reload" && e.sessionId === id))).toBe(false);
        } finally {
            chmodSync(dirname(f.ui), 0o700);
            await engine.stop();
        }
    });

    test("restore holds the session's lock: refused while another process has it, and the trash entry stays", async () => {
        const { engine, c, id, f } = await setup();
        const other = Bun.spawn(["sleep", "30"]);
        try {
            await engine.handle(c, "session.delete", { id });
            const theirs = JSON.stringify({ pid: other.pid, at: Date.now() });
            writeFileSync(f.lock, theirs);
            expect((await fails(engine.handle(c, "session.restore", { id }))).code).toBe("in_use");
            expect(gone(f.file)).toBe(true);
            expect(existsSync(join(trashDir(), id, "transcript.jsonl"))).toBe(true);
            expect(readFileSync(f.lock, "utf-8")).toBe(theirs);
            other.kill();
            await other.exited;
            // Once it's gone, its lock is stale.
            await engine.handle(c, "session.restore", { id });
            expect(existsSync(f.file)).toBe(true);
            expect(gone(f.lock)).toBe(true);
        } finally {
            other.kill();
            await engine.stop();
        }
    });

    test("restore removes only the trash entry it emptied", async () => {
        const { engine, c, id, f } = await setup();
        try {
            await engine.handle(c, "session.delete", { id });
            // As if another server had deleted it again into the same folder meanwhile.
            writeFileSync(join(trashDir(), id, "theirs.txt"), "keep");
            await engine.handle(c, "session.restore", { id });
            expect(existsSync(f.file)).toBe(true);
            expect(readFileSync(join(trashDir(), id, "theirs.txt"), "utf-8")).toBe("keep");
            expect(gone(join(trashDir(), id, "entry.json"))).toBe(true);
            // A later delete replaces what's left of it.
            await engine.handle(c, "session.delete", { id });
            expect(gone(join(trashDir(), id, "theirs.txt"))).toBe(true);
            expect(existsSync(join(trashDir(), id, "transcript.jsonl"))).toBe(true);
        } finally {
            await engine.stop();
        }
    });

    test("bad ids are refused and nothing is touched", async () => {
        const { engine, c, f } = await setup();
        const listing = () => JSON.stringify([readdirSync(dirname(f.file)).sort(), existsSync(trashDir()) ? readdirSync(trashDir()) : []]);
        try {
            const before = listing();
            for (const id of ["..", "../x", "a/b", f.file, "/etc", "", "a\0b", "x".repeat(65), 7, undefined]) {
                for (const method of ["session.delete", "session.restore"] as const) expect((await fails(engine.handle(c, method, { id } as never))).code).toBe("invalid");
            }
            expect(listing()).toBe(before);
            expect(existsSync(f.file)).toBe(true);
        } finally {
            await engine.stop();
        }
    });

    test("file history that's a link: the link moves, what it points to stays", async () => {
        const { engine, c, id, f } = await setup();
        const outside = tempDir("harness-del-outside-");
        writeFileSync(join(outside, "keep.txt"), "mine");
        mkdirSync(dirname(f.history), { recursive: true });
        symlinkSync(outside, f.history);
        try {
            await engine.handle(c, "session.delete", { id });
            expect(gone(f.history)).toBe(true);
            expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("mine");
            await engine.handle(c, "session.restore", { id });
            expect(lstatSync(f.history).isSymbolicLink()).toBe(true);

            await engine.handle(c, "session.delete", { id });
            expect(purgeTrash({ now: Date.now() + 8 * DAY })).toContain(id);
            expect(gone(join(trashDir(), id))).toBe(true);
            expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("mine");
        } finally {
            await engine.stop();
        }
    });
});

test("purging removes only entries older than a week, and doesn't follow links", () => {
    const outside = tempDir("harness-del-outside-");
    writeFileSync(join(outside, "keep.txt"), "mine");
    const entry = (name: string, deletedAt: number) => {
        mkdirSync(join(trashDir(), name), { recursive: true });
        writeFileSync(join(trashDir(), name, "entry.json"), JSON.stringify({ id: name, slug: "p", deletedAt }));
        symlinkSync(outside, join(trashDir(), name, "file-history"));
    };
    entry("old-1", Date.now() - 8 * DAY);
    entry("new-1", Date.now() - 1 * DAY);
    symlinkSync(outside, join(trashDir(), "stray-link"));
    // An entry.json that's a link isn't read: the folder's own (recent) time counts.
    writeFileSync(join(outside, "entry.json"), JSON.stringify({ deletedAt: Date.now() - 30 * DAY }));
    mkdirSync(join(trashDir(), "linked-1"));
    symlinkSync(join(outside, "entry.json"), join(trashDir(), "linked-1", "entry.json"));
    expect(purgeTrash()).toEqual(["old-1"]);
    expect(lstatSync(join(trashDir(), "linked-1", "entry.json")).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, "entry.json"))).toBe(true);
    expect(existsSync(join(trashDir(), "new-1", "entry.json"))).toBe(true);
    expect(lstatSync(join(trashDir(), "stray-link")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("mine");
});
