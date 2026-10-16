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
import type { ServerEvent, SessionSnapshot, SessionSummary } from "../src/server/protocol";

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
    test("moves the session's files out of projects/ and Undo brings back the same bytes, pin and archived state", async () => {
        const cwd = createDemoProject(tempDir("harness-del-git-"));
        const { engine, c, events, id, f } = await setup(cwd);
        try {
            addHistory(f.history);
            await engine.handle(c, "session.pin", { id, pinned: true });
            await engine.handle(c, "session.archive", { id, archived: true });
            const bytes = { file: readFileSync(f.file), ui: readFileSync(f.ui), index: readFileSync(join(f.history, "index.jsonl")), blob: readFileSync(join(f.history, "blobs", "abc")) };
            const before = { status: git(cwd, "status", "--porcelain"), readme: readFileSync(join(cwd, "README.md")) };
            expect(existsSync(f.lock)).toBe(true);

            await engine.handle(c, "session.delete", { id });
            for (const p of [f.file, f.lock, f.ui, f.history]) expect(gone(p)).toBe(true);
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

    test("a delete that fails halfway puts everything back, and windows get the session back to open afresh", async () => {
        const { engine, c, events, id, f } = await setup();
        try {
            await engine.handle(c, "session.pin", { id, pinned: true });
            const bytes = readFileSync(f.file);
            chmodSync(dirname(f.ui), 0o500);
            const err = await fails(engine.handle(c, "session.delete", { id }));
            chmodSync(dirname(f.ui), 0o700);
            expect(err.code).toBeUndefined();
            expect(readFileSync(f.file)).toEqual(bytes);
            expect(existsSync(f.ui)).toBe(true);
            expect(gone(join(trashDir(), id))).toBe(true);
            expect(store().pinned).toContain(id);
            const removed = events.findIndex((e) => e.type === "sessions.remove" && e.id === id);
            expect(removed).toBeGreaterThan(-1);
            expect(events.slice(removed).some((e) => e.type === "sessions.upsert" && e.session.id === id && e.session.pinned)).toBe(true);
            const snap = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
            expect(snap.turns.length).toBeGreaterThan(0);
        } finally {
            chmodSync(dirname(f.ui), 0o700);
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
    expect(purgeTrash()).toEqual(["old-1"]);
    expect(existsSync(join(trashDir(), "new-1", "entry.json"))).toBe(true);
    expect(lstatSync(join(trashDir(), "stray-link")).isSymbolicLink()).toBe(true);
    expect(readFileSync(join(outside, "keep.txt"), "utf-8")).toBe("mine");
});
