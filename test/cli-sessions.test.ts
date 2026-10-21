// Picking up a Claude Code or Codex session in Harness: listing a folder's
// CLI sessions, importing one, and carrying on with it natively. Every store
// here is a synthetic fixture in a temp folder (isolate() points
// CLAUDE_CONFIG_DIR and CODEX_HOME at empty ones too).
import { afterAll, beforeEach, describe, expect, spyOn, test } from "bun:test";
import * as fs from "fs";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { randomUUID } from "crypto";
import { isolate, tempDir, FAKE } from "./helpers/isolate";
import { claudeFolder, claudeSession, codexSession, snapshotTree, type FixtureTurn } from "./helpers/cli-stores";

const iso = isolate();
const { listCliSessions, readCliTranscript, findCliSession } = await import("../src/server/cli-sessions");
const { Engine, RpcError } = await import("../src/server/engine");
const { Session, cliLinks, findSessionAnywhere, listSessions } = await import("../src/agent/session");
const { harnessLinks, importModel, writeImportedSession } = await import("../src/server/cli-import");
const { rewindTargets } = await import("../src/agent/checkpoints");
const { saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
const { forgetClient } = await import("../src/providers/models");
import type { CliSessionsList, SessionSnapshot, Turn } from "../src/server/protocol";

const CLAUDE = process.env.CLAUDE_CONFIG_DIR!;
const CODEX = process.env.CODEX_HOME!;
const bin = tempDir("cli-import-bin-");
const LOG = join(bin, "log.jsonl");

function wrapper(name: string, fixture: string): string {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`);
    chmodSync(p, 0o755);
    return p;
}
const claudeBin = wrapper("claude", "fake-claude.ts");
const codexBin = wrapper("codex", "fake-codex.ts");

const TURNS: FixtureTurn[] = [
    { prompt: `fix the login bug, my key is ${FAKE.anthropic}`, reply: "Found it in auth.ts.", tools: [["Bash", { command: "npm test" }], ["Edit", { file_path: "src/auth.ts", old_string: "a", new_string: "b" }]] },
    { prompt: "now add a test", reply: "Added one." },
];
const CODEX_TURNS: FixtureTurn[] = [
    { prompt: "rename the helper", reply: "Renamed it.", tools: [["shell", { command: ["bash", "-lc", "rg helper"] }], ["apply_patch", { input: "*** Begin Patch\n*** Update File: src/util.ts\n*** End Patch" }]] },
];

let cwd: string;
let real: string;

beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    process.env.FAKE_LOG = LOG;
    rmSync(LOG, { force: true });
    // Stores and projects start empty for every test.
    for (const root of [CLAUDE, CODEX]) {
        rmSync(root, { recursive: true, force: true });
        mkdirSync(root, { recursive: true });
    }
    cwd = tempDir("cli-import-proj-");
    // On macOS the temp folder is reached through a symlink (/var -> /private/var): the CLIs record the real path.
    real = realpathSync(cwd);
    removeAgentConfig("claude-code");
    removeAgentConfig("codex");
    forgetClient("claude-code");
    forgetClient("codex");
});

afterAll(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    rmSync(bin, { recursive: true, force: true });
    iso.cleanup();
});

function turnOn() {
    saveAgentConfig("claude-code", { path: claudeBin });
    saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
}

async function engine() {
    const e = new Engine({ unloadAfterMs: 50 });
    const c = { subs: new Set<string>(), send() {} };
    e.clients.add(c);
    return { e, c };
}

function logLines(): any[] {
    return existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
}
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));
/** The argv of each `claude` run for a turn (not the ones listing models). */
const turnStarts = (): string[][] => logLines().flatMap((l) => (l.argv?.includes("--permission-prompt-tool=stdio") ? [l.argv] : []));
const userTexts = () => received().flatMap((m) => (m.type === "user" ? m.message.content.filter((c: any) => c.type === "text").map((c: any) => c.text as string) : []));

/** Send a prompt and wait for the turn to end, allowing whatever it asks. */
async function send(e: InstanceType<typeof Engine>, c: { subs: Set<string>; send(): void }, id: string, text: string) {
    const rt = e.runtimes.get(id)!;
    const before = rt.session.messages.length;
    await e.handle(c, "session.send", { id, text });
    for (let i = 0; i < 400; i++) {
        for (const it of rt.snapshot().state.interactions) await e.handle(c, "session.respond", { id, interactionId: it.id, response: { kind: "permission", choice: "yes" } }).catch(() => undefined);
        if (rt.idle && rt.session.messages.length > before + 1) return rt;
        await Bun.sleep(50);
    }
    throw new Error("the turn didn't end");
}

const prompts = (turns: Turn[]) => turns.filter((t) => t.prompt).map((t) => t.prompt!);

describe("reading the stores", () => {
    test("lists this folder's sessions of both CLIs, newest first, and nothing else", () => {
        const now = Date.now();
        const a = claudeSession(CLAUDE, { cwd: real, turns: TURNS, title: "Login bug", model: "claude-opus-5-5", mtime: now - 60 * 60_000 });
        const b = claudeSession(CLAUDE, { cwd: real, turns: [{ prompt: "explain the build   setup\nplease", reply: "Sure." }], mtime: now - 30 * 60_000 });
        const x = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS, title: "Helper rename", model: "gpt-test", mtime: now - 10 * 60_000 });
        // Elsewhere: another project, a folder whose store name collides with this one's, a sub-agent's thread.
        const other = tempDir("cli-import-other-");
        claudeSession(CLAUDE, { cwd: other, turns: TURNS });
        claudeSession(CLAUDE, { cwd: real.replace(/-([^-]*)$/, ".$1"), folderOf: real, turns: TURNS });
        codexSession(CODEX, { cwd: other, turns: CODEX_TURNS });
        codexSession(CODEX, { cwd: real, turns: CODEX_TURNS, subAgent: true });
        // Nothing to import, or not to be read.
        claudeSession(CLAUDE, { cwd: real, turns: [] });
        const target = claudeSession(CLAUDE, { cwd: real, turns: TURNS }).file;
        const linkTo = join(tempDir("cli-import-link-"), "x.jsonl");
        writeFileSync(linkTo, readFileSync(target));
        rmSync(target);
        symlinkSync(linkTo, target);

        // Asked for by the path as given (through the symlinked temp folder).
        const claude = listCliSessions("claude-code", cwd);
        expect(claude.sessions.map((s) => s.id)).toEqual([b.id, a.id]);
        expect(claude.more).toBe(0);
        const [sb, sa] = claude.sessions;
        expect(sa).toMatchObject({ title: "Login bug", named: true, model: "claude-opus-5-5", messages: 5, partial: false, cwd: real });
        expect(sb!.title).toBe("explain the build setup please");
        expect(sb!.named).toBe(false);
        const codex = listCliSessions("codex", cwd);
        expect(codex.sessions.map((s) => s.id)).toEqual([x.id]);
        expect(codex.sessions[0]).toMatchObject({ title: "Helper rename", named: true, model: "gpt-test", messages: 2 });
    });

    test("a fake key in a prompt never shows in the list", () => {
        claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const out = JSON.stringify(listCliSessions("claude-code", cwd));
        expect(out).not.toContain(FAKE.anthropic);
        expect(out).toContain("[REDACTED");
    });

    test("ones already in Harness have a limit of their own, and ones to leave out take no room", () => {
        const ids = Array.from({ length: 8 }, (_, i) => claudeSession(CLAUDE, { cwd: real, turns: TURNS, mtime: Date.now() - i * 1000 }).id);
        // Newest first: held, new, hidden, held, new, held, new, held.
        const kind = ["held", "new", "hidden", "held", "new", "held", "new", "held"] as const;
        const l = listCliSessions("claude-code", cwd, { limits: { list: 2 }, sort: (id) => kind[ids.indexOf(id)]! });
        expect(l.sessions.map((s) => ids.indexOf(s.id))).toEqual([1, 4]);
        expect(l.more).toBe(1);
        expect(l.held.map((s) => ids.indexOf(s.id))).toEqual([0, 3]);
        expect(l.moreHeld).toBe(2);
    });

    test("the list stops at its limit and says how many more there are", () => {
        for (let i = 0; i < 5; i++) claudeSession(CLAUDE, { cwd: real, turns: TURNS, mtime: Date.now() - i * 1000 });
        const l = listCliSessions("claude-code", cwd, { limits: { list: 3 } });
        expect(l.sessions).toHaveLength(3);
        expect(l.more).toBe(2);
    });

    test("torn and oversized lines are skipped; a file over the cap isn't listed", () => {
        const torn = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        writeFileSync(torn.file, readFileSync(torn.file, "utf-8") + '{"type":"user","message":{"content":"half a li');
        const big = claudeSession(CLAUDE, { cwd: real, turns: [{ prompt: "with a pasted image", reply: "Nice picture." }, ...TURNS] });
        const rows = readFileSync(big.file, "utf-8").split("\n");
        // A pasted image: one huge line, inside the conversation's chain.
        const huge = JSON.parse(rows[0]!);
        huge.message.content = [{ type: "text", text: "with a pasted image" }, { type: "image", source: { type: "base64", data: "A".repeat(110_000) } }];
        rows[0] = JSON.stringify(huge);
        writeFileSync(big.file, rows.join("\n"));
        const over = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        writeFileSync(over.file, readFileSync(over.file, "utf-8") + JSON.stringify({ type: "padding", data: "x".repeat(200_000) }) + "\n");

        const limits = { line: 100_000, file: 150_000 };
        const l = listCliSessions("claude-code", cwd, { limits });
        expect(l.sessions.map((s) => s.id).sort()).toEqual([torn.id, big.id].sort());
        const tornT = readCliTranscript(l.sessions.find((s) => s.id === torn.id)!, { limits });
        expect(tornT.turns.map((t) => t.prompt.slice(0, 7))).toEqual(["fix the", "now add"]);
        // The chain is cut where the long line was: what's in the file still comes through, in its order.
        const bigT = readCliTranscript(l.sessions.find((s) => s.id === big.id)!, { limits });
        expect(bigT.turns.map((t) => t.prompt.slice(0, 7))).toEqual(["fix the", "now add"]);
        expect(bigT.turns[0]!.replies).toEqual(["Found it in auth.ts.", "Finished."]);
    });

    test("a transcript has prompts, replies and what was used, not thinking or tool output", () => {
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const t = readCliTranscript(findCliSession("claude-code", cwd, id)!);
        expect(t.turns).toHaveLength(2);
        expect(t.turns[0]!.prompt).not.toContain(FAKE.anthropic);
        expect(t.turns[0]!.replies).toEqual(["Found it in auth.ts.", "Finished."]);
        expect(t.turns[0]!.actions).toEqual(["Bash(npm test)", "Edit(src/auth.ts)"]);
        expect(JSON.stringify(t)).not.toMatch(/THINKING_TEXT|TOOL_OUTPUT/);
        const c = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS });
        const ct = readCliTranscript(findCliSession("codex", cwd, c.id)!);
        expect(ct.turns).toEqual([expect.objectContaining({ prompt: "rename the helper", replies: ["Renamed it."], actions: ["Bash(rg helper)", "Edit(src/util.ts)"] })]);
        expect(JSON.stringify(ct)).not.toMatch(/THINKING_TEXT|TOOL_OUTPUT|environment_context/);
    });

    test("a turn's replies share one message's budget", () => {
        const long = Array.from({ length: 12 }, (_, i) => String(i % 10).repeat(39_000));
        const { id } = codexSession(CODEX, { cwd: real, turns: [{ prompt: "write a lot", reply: long[0]!, more: long.slice(1) }] });
        const t = readCliTranscript(findCliSession("codex", cwd, id)!);
        const chars = t.turns[0]!.replies.join("\n\n").length;
        expect(chars).toBeLessThan(41_000);
        expect(t.turns[0]!.replies.at(-1)).toEndWith("[…cut short on import]");
    });

    test("a Codex session whose first line is longer than the head read is still listed", () => {
        const { id } = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS });
        const l = listCliSessions("codex", cwd, { limits: { head: 32 * 1024 } });
        expect(l.sessions.map((s) => [s.id, s.title, s.messages, s.partial])).toEqual([[id, "rename the helper", 2, true]]);
        expect(findCliSession("codex", cwd, id, { limits: { head: 32 * 1024 } })?.id).toBe(id);
    });

    test("a Claude Code branch left by a rewind stays out, even past a line too long to read", () => {
        const id = randomUUID();
        const dir = claudeFolder(CLAUDE, real);
        mkdirSync(dir, { recursive: true });
        let t = Date.parse("2026-10-14T09:00:00Z");
        const e = (uuid: string, parentUuid: string | null, rest: Record<string, unknown>) => JSON.stringify({ parentUuid, isSidechain: false, uuid, timestamp: new Date((t += 1000)).toISOString(), cwd: real, sessionId: id, ...rest });
        const user = (text: unknown) => ({ type: "user", message: { role: "user", content: text } });
        const said = (msg: string, content: unknown[]) => ({ type: "assistant", message: { id: msg, role: "assistant", model: "claude-test-1", content } });
        writeFileSync(join(dir, `${id}.jsonl`), [
            e("u1", null, user("first")),
            e("a1", "u1", said("m1", [{ type: "text", text: "one" }])),
            e("b1", "a1", user("abandoned")),
            e("b2", "b1", said("m2", [{ type: "text", text: "abandoned reply" }])),
            e("c1", "a1", user("kept")),
            e("c2", "c1", said("m3", [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "ls" } }])),
            e("c3", "c2", user([{ type: "tool_result", tool_use_id: "t1", content: "x".repeat(200_000) }])),
            e("c4", "c3", said("m4", [{ type: "text", text: "after the tool" }])),
        ].join("\n") + "\n");
        const tr = readCliTranscript(findCliSession("claude-code", cwd, id, { limits: { line: 100_000 } })!, { limits: { line: 100_000 } });
        expect(tr.turns.map((x) => [x.prompt, x.replies, x.actions])).toEqual([["first", ["one"], []], ["kept", ["after the tool"], ["Bash(ls)"]]]);
    });

    test("only the latest messages are imported past the limits, and the rest are counted", () => {
        const many = Array.from({ length: 10 }, (_, i) => ({ prompt: `prompt ${i}`, reply: `reply ${i}` }));
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: many });
        const t = readCliTranscript(findCliSession("claude-code", cwd, id)!, { limits: { messages: 6 } });
        expect(t.turns.map((x) => x.prompt)).toEqual(["prompt 7", "prompt 8", "prompt 9"]);
        expect(t.omitted).toBe(14);
    });

    test("large action titles and even the newest turn stay within the import budget", () => {
        const huge = "x".repeat(1_000_000);
        const { id, file } = codexSession(CODEX, { cwd: real, turns: [
            { prompt: "older prompt", reply: "older reply" },
            { prompt: "newest " + "p".repeat(500), reply: "r".repeat(500), tools: [[huge, {}]] },
        ] });
        fs.appendFileSync(file, JSON.stringify({ type: "response_item", payload: { type: "web_search_call", action: { query: huge } } }) + "\n");
        const entry = findCliSession("codex", cwd, id)!;
        const full = readCliTranscript(entry);
        const actions = full.turns.at(-1)!.actions;
        expect(actions).toHaveLength(2);
        expect(actions.every((a) => a.length <= 200 && a.endsWith("…"))).toBe(true);
        expect(actions[1]).toStartWith("WebSearch(");

        for (const chars of [0, 8, 64, 700, 1100]) {
            const t = readCliTranscript(entry, { limits: { chars } });
            expect(t.turns).toHaveLength(1);
            expect(t.omitted).toBe(2);
            const newest = t.turns[0]!;
            const size = newest.prompt.length + [...newest.replies, ...newest.actions].reduce((n, s) => n + s.length, 0);
            expect(size).toBeLessThanOrEqual(chars);
            expect(newest.at).toBe(full.turns.at(-1)!.at);
            if (chars >= 64) expect(newest.prompt).toStartWith("newest ");
        }
    });
});

describe("importing", () => {
    test.each(["msg", "backend"])("a failed %s write leaves no session behind and a retry imports the whole conversation once", async (failAt) => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const entry = findCliSession("claude-code", cwd, id)!;
        const transcript = readCliTranscript(entry);
        const append = fs.appendFileSync;
        let file = "";
        let messages = 0;
        const fault = spyOn(fs, "appendFileSync").mockImplementation((path, data, options) => {
            const text = String(data);
            if (text.includes('"t":"msg"')) messages++;
            if (!file && (failAt === "msg" ? messages === 2 : text.includes('"t":"backend"'))) {
                file = String(path);
                // A disk write can leave a torn line before reporting failure.
                append(path, text.slice(0, Math.floor(text.length / 2)), options);
                throw new Error("simulated disk write failure");
            }
            return append(path, data, options);
        });
        try {
            expect(() => writeImportedSession({ cwd, entry, transcript, model: "claude-code:default", title: "Login bug" })).toThrow("simulated disk write failure");
        } finally {
            fault.mockRestore();
        }
        expect(file).not.toBe("");
        expect(harnessLinks([cwd]).held.size).toBe(0);
        // Half of it would list as an ordinary session with part of the conversation.
        expect(existsSync(file)).toBe(false);
        expect(listSessions(cwd).map((m) => m.title)).not.toContain("Login bug");

        const { e, c } = await engine();
        try {
            const snap = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            expect(findSessionAnywhere(snap.state.id)).not.toBe(file);
            expect(snap.turns[0]!.blocks[0]).toMatchObject({ t: "imported", source: "Claude Code" });
            expect(prompts(snap.turns)).toHaveLength(2);
            expect(e.runtimes.get(snap.state.id)!.session.backends.get("claude-code")).toEqual({ id, synced: 4 });
            expect(listSessions(cwd).map((m) => m.id)).toEqual([snap.state.id]);
        } finally {
            await e.stop();
        }
    });

    test("opens a session on the matching backend, with the conversation shown read-only", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS, title: "Login bug" });
        const { e, c } = await engine();
        try {
            const snap = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            // The folder as Home names it (the CLI recorded its real path).
            expect(snap.state.cwd).toBe(cwd);
            expect(snap.state.title).toBe("Login bug");
            expect(snap.state.model?.ref).toStartWith("claude-code:");
            const [head, ...rest] = snap.turns;
            expect(head!.blocks[0]).toMatchObject({ t: "imported", source: "Claude Code", omitted: 0 });
            expect(prompts(rest).map((p) => p.text.slice(0, 7))).toEqual(["fix the", "now add"]);
            // Not rewindable: no index, and flagged.
            expect(rest.every((t) => t.imported && t.prompt?.index === undefined)).toBe(true);
            expect(rest[0]!.blocks.map((b) => (b.t === "text" || b.t === "notice" ? b.text : b.t))).toEqual(["Found it in auth.ts.\n\nFinished.", "Used: Bash(npm test), Edit(src/auth.ts)"]);
            expect(await e.handle(c, "session.rewindTargets", { id: snap.state.id })).toEqual([]);

            const file = findSessionAnywhere(snap.state.id)!;
            const text = readFileSync(file, "utf-8");
            expect(text).not.toContain(FAKE.anthropic);
            const lines = text.trim().split("\n").map((l) => JSON.parse(l));
            expect(lines.at(-1)).toMatchObject({ t: "import", source: "claude-code", id, messages: 4, omitted: 0 });
            expect(lines.filter((l) => l.t === "backend").at(-1)).toMatchObject({ provider: "claude-code", id, synced: 4 });
        } finally {
            await e.stop();
        }
    });

    test("leaves the CLI store exactly as it was", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const x = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS, title: "Helper rename" });
        const before = [snapshotTree(CLAUDE), snapshotTree(CODEX)];
        const { e, c } = await engine();
        try {
            await e.handle(c, "cliSessions.list", { cwd });
            await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id });
            await e.handle(c, "cliSessions.import", { cwd, source: "codex", id: x.id });
            await e.handle(c, "cliSessions.list", { cwd });
        } finally {
            await e.stop();
        }
        expect([snapshotTree(CLAUDE), snapshotTree(CODEX)]).toEqual(before);
    });

    test("bad ids, sources and folders are refused", async () => {
        turnOn();
        claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const { e, c } = await engine();
        try {
            for (const id of ["../x", "-x", "../../etc/passwd", "a/b", ""]) {
                await expect(e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })).rejects.toBeInstanceOf(RpcError);
            }
            await expect(e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id: randomUUID() })).rejects.toMatchObject({ code: "not_found" });
            await expect(e.handle(c, "cliSessions.import", { cwd, source: "gemini", id: randomUUID() })).rejects.toBeInstanceOf(RpcError);
            await expect(e.handle(c, "cliSessions.list", { cwd: join(cwd, "nope") })).rejects.toBeInstanceOf(RpcError);
            // A session of another folder isn't found from this one.
            const other = claudeSession(CLAUDE, { cwd: tempDir("cli-import-other-"), turns: TURNS });
            await expect(e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id: other.id })).rejects.toMatchObject({ code: "not_found" });
        } finally {
            await e.stop();
        }
    });

    test("importing again opens the same session, and the list says it's in Harness", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const { e, c } = await engine();
        try {
            const first = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            const again = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id: id.toUpperCase() })) as SessionSnapshot;
            expect(again.state.id).toBe(first.state.id);
            const list = (await e.handle(c, "cliSessions.list", { cwd })) as CliSessionsList;
            expect(list.sessions.find((s) => s.id === id)?.harnessId).toBe(first.state.id);
            // The record lasts even when the backend's id changes (a resume that failed).
            e.runtimes.get(first.state.id)!.session.setBackendSession("claude-code", randomUUID(), 4);
            const third = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            expect(third.state.id).toBe(first.state.id);
        } finally {
            await e.stop();
        }
    });

    test("reopening an import while deleting it leaves nothing open, and Undo keeps the imported conversation", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const before = snapshotTree(CLAUDE);
        const { e, c } = await engine();
        try {
            const first = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            const sid = first.state.id;
            const file = findSessionAnywhere(sid)!;
            const bytes = readFileSync(file);
            const reopening = e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id });
            const deleting = e.handle(c, "session.delete", { id: sid });
            await reopening;
            await deleting;
            expect(e.runtimes.has(sid)).toBe(false);
            expect(findSessionAnywhere(sid)).toBeUndefined();
            expect(existsSync(`${file}.lock`)).toBe(false);
            expect(e.cliSessionsList(cwd).sessions.find((s) => s.id === id)?.harnessId).toBeUndefined();

            await e.handle(c, "session.restore", { id: sid });
            expect(readFileSync(file)).toEqual(bytes);
            expect(e.cliSessionsList(cwd).sessions.find((s) => s.id === id)?.harnessId).toBe(sid);
            const restored = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            expect(restored.state.id).toBe(sid);
            expect(restored.turns).toEqual(first.turns);
            expect(rewindTargets(e.runtimes.get(sid)!.session.messages)).toEqual([]);

            // The delete starts first this time: reopening waits, then finds it gone.
            const deletingAgain = e.handle(c, "session.delete", { id: sid });
            const refused = expect(e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })).rejects.toMatchObject({ code: "not_found" });
            await deletingAgain;
            await refused;
            expect(e.runtimes.has(sid)).toBe(false);
            expect(findSessionAnywhere(sid)).toBeUndefined();
            expect(existsSync(`${file}.lock`)).toBe(false);
            expect(snapshotTree(CLAUDE)).toEqual(before);
        } finally {
            await e.stop();
        }
    });

    test("a CLI session Harness ran itself counts as in Harness", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const s = Session.create(real);
        s.push({ role: "user", content: [{ type: "text", text: "hello" }], meta: { kind: "prompt" } });
        s.setBackendSession("claude-code", id, 1);
        s.release();
        const { e, c } = await engine();
        try {
            const list = (await e.handle(c, "cliSessions.list", { cwd })) as CliSessionsList;
            expect(list.sessions.find((x) => x.id === id)?.harnessId).toBe(s.meta.id);
            const snap = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            expect(snap.state.id).toBe(s.meta.id);
        } finally {
            await e.stop();
        }
    });

    test("a Harness session kept under another path to the same folder counts too", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        // Harness ran it through the symlinked path; Home now has the real one.
        const s = Session.create(cwd);
        s.push({ role: "user", content: [{ type: "text", text: "hello" }], meta: { kind: "prompt" } });
        s.setBackendSession("claude-code", id, 1);
        s.release();
        writeFileSync(join(iso.home, "gui.json"), JSON.stringify({ recent: [{ path: cwd, at: Date.now() }] }));
        const { e, c } = await engine();
        try {
            const list = (await e.handle(c, "cliSessions.list", { cwd: real })) as CliSessionsList;
            expect(list.sessions.find((x) => x.id === id)?.harnessId).toBe(s.meta.id);
            const snap = (await e.handle(c, "cliSessions.import", { cwd: real, source: "claude-code", id })) as SessionSnapshot;
            expect(snap.state.id).toBe(s.meta.id);
        } finally {
            await e.stop();
            rmSync(join(iso.home, "gui.json"), { force: true });
        }
    });

    test("Harness's own sub-agent runs aren't offered, nor Codex threads its client started that no session holds", async () => {
        turnOn();
        const subClaude = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const subCodex = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS, originator: "harness_cli" });
        // From before sub-agent runs were recorded: Harness's client started it, and no session holds it.
        const orphan = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS, originator: "harness_cli" });
        // A Harness session's own Codex thread: Harness's client too, but held, so listed as in Harness.
        const own = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS, originator: "harness_cli" });
        const mine = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS });
        const parent = Session.create(real);
        parent.push({ role: "user", content: [{ type: "text", text: "review it" }], meta: { kind: "prompt" } });
        parent.setBackendSession("codex", own.id, 1);
        const child = Session.create(real, { persist: false });
        child.runsFor = parent;
        child.setBackendSession("claude-code", subClaude.id, 1);
        child.setBackendSession("codex", subCodex.id, 1);
        parent.release();
        const { e, c } = await engine();
        try {
            const list = (await e.handle(c, "cliSessions.list", { cwd })) as CliSessionsList;
            expect(list.sessions.map((s) => [s.id, s.harnessId]).sort()).toEqual([[mine.id, undefined], [own.id, parent.meta.id]].sort());
            for (const [source, id] of [["claude-code", subClaude.id], ["codex", subCodex.id], ["codex", orphan.id]]) {
                await expect(e.handle(c, "cliSessions.import", { cwd, source, id })).rejects.toMatchObject({ code: "not_found" });
            }
        } finally {
            await e.stop();
        }
    });

    test("the model it ran on is kept: Claude Code's specific alias, not the default that resolves to it today", () => {
        const listing = (models: { id: string; name: string }[]) => [{ provider: { id: "claude-code" }, models: models.map((m) => ({ provider: "claude-code", ...m })), status: "ok" }] as any;
        const models = [
            { id: "default", name: "Default (recommended) (claude-opus-5-5)" },
            { id: "sonnet", name: "Sonnet (claude-sonnet-5-5)" },
            { id: "opus", name: "Opus (claude-opus-5-5)" },
        ];
        expect(importModel("claude-code", "claude-opus-5-5", listing(models))).toBe("claude-code:opus");
        expect(importModel("claude-code", "claude-sonnet-5-5", listing(models))).toBe("claude-code:sonnet");
        // Only the default resolves to it: the default, then. Unknown, or nothing listed: the default.
        expect(importModel("claude-code", "claude-opus-5-5", listing(models.slice(0, 2)))).toBe("claude-code:default");
        expect(importModel("claude-code", "claude-haiku-9", listing(models))).toBe("claude-code:default");
        expect(importModel("codex", "gpt-test", [])).toBe("codex:default");
    });

    test("a provider that isn't turned on: listed as off, and import says so", async () => {
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const { e, c } = await engine();
        try {
            const list = (await e.handle(c, "cliSessions.list", { cwd })) as CliSessionsList;
            expect(list.sources.find((s) => s.source === "claude-code")).toMatchObject({ enabled: false, name: "Claude Code" });
            await expect(e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })).rejects.toMatchObject({ code: "provider_off", message: expect.stringMatching(/Turn on Claude Code in Settings → Providers/) });
        } finally {
            await e.stop();
        }
    });

    test("a session changed in the last couple of minutes is flagged", async () => {
        claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        claudeSession(CLAUDE, { cwd: real, turns: TURNS, mtime: Date.now() - 10 * 60_000 });
        const { e, c } = await engine();
        try {
            const list = (await e.handle(c, "cliSessions.list", { cwd })) as CliSessionsList;
            expect(list.sessions.map((s) => s.recent)).toEqual([true, false]);
        } finally {
            await e.stop();
        }
    });

    test("looks the same after it's closed and reopened, and the terminal app can load it", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const { e, c } = await engine();
        let sid = "";
        let before: Turn[] = [];
        try {
            const snap = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            sid = snap.state.id;
            before = snap.turns;
            await e.handle(c, "session.close", { id: sid });
            for (let i = 0; i < 100 && e.runtimes.has(sid); i++) await Bun.sleep(20);
            expect(e.runtimes.has(sid)).toBe(false);
            const again = (await e.handle(c, "session.open", { id: sid })) as SessionSnapshot;
            const shape = (ts: Turn[]) => ts.map((t) => ({ prompt: t.prompt, imported: t.imported, startedAt: t.startedAt, blocks: t.blocks.map(({ id: _, ...b }) => b) }));
            expect(shape(again.turns)).toEqual(shape(before));
            expect(before[1]!.startedAt).toBeGreaterThan(0);
        } finally {
            await e.stop();
        }
        // What the terminal app does with it: list, load, and offer nothing imported to rewind to.
        expect(listSessions(cwd).find((s) => s.id === sid)?.title).toContain("fix the login bug");
        const s = Session.load(findSessionAnywhere(sid)!);
        try {
            expect(s.imported).toMatchObject({ source: "claude-code", id });
            expect(s.backends.get("claude-code")).toEqual({ id, synced: 4 });
            expect(rewindTargets(s.messages)).toEqual([]);
        } finally {
            s.release();
        }
    });
});

describe("carrying on", () => {
    test("Claude Code: the next turn resumes the CLI's session and sends only the new prompt", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const { e, c } = await engine();
        try {
            const snap = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            const rt = await send(e, c, snap.state.id, "and the docs too");
            const argv: string[] = turnStarts()[0]!;
            expect(argv[argv.indexOf("--resume") + 1]).toBe(id);
            expect(userTexts()).toEqual(["and the docs too"]);
            // The new prompt is the only one that can be rewound to.
            const targets = rewindTargets(rt.session.messages);
            expect(targets.map((t) => t.text)).toEqual(["and the docs too"]);
            expect(targets[0]!.index).toBe(4);
        } finally {
            await e.stop();
        }
    }, 30_000);

    test("Codex: the next turn resumes the CLI's thread", async () => {
        turnOn();
        const x = codexSession(CODEX, { cwd: real, turns: CODEX_TURNS });
        const { e, c } = await engine();
        try {
            const snap = (await e.handle(c, "cliSessions.import", { cwd, source: "codex", id: x.id })) as SessionSnapshot;
            expect(snap.state.model?.ref).toStartWith("codex:");
            await send(e, c, snap.state.id, "and the call sites");
            const methods = received().map((m) => m.method).filter((m) => m?.startsWith("thread/"));
            expect(methods).toEqual(["thread/resume"]);
            expect(received().find((m) => m.method === "thread/resume").params.threadId).toBe(x.id);
            const input: string = received().find((m) => m.method === "turn/start").params.input[0].text;
            expect(input).not.toContain("<conversation-so-far>");
            expect(input).toEndWith("and the call sites");
        } finally {
            await e.stop();
        }
    }, 30_000);

    test("a CLI session that's gone: a new one gets the conversation as context", async () => {
        turnOn();
        const { id } = claudeSession(CLAUDE, { cwd: real, turns: TURNS });
        const { e, c } = await engine();
        try {
            const snap = (await e.handle(c, "cliSessions.import", { cwd, source: "claude-code", id })) as SessionSnapshot;
            process.env.FAKE_GONE_ID = id;
            const rt = await send(e, c, snap.state.id, "and the docs too");
            expect(turnStarts().map((a) => a.includes("--resume"))).toEqual([true, false]);
            const prompt = userTexts().at(-1)!;
            expect(prompt).toContain("<conversation-so-far>");
            expect(prompt).toContain("User: now add a test");
            expect(prompt).not.toContain(FAKE.anthropic);
            expect(prompt.endsWith("and the docs too")).toBe(true);
            const notices = rt.snapshot().turns.flatMap((t) => t.blocks).filter((b) => b.t === "notice").map((b) => (b as { text: string }).text);
            expect(notices.join("\n")).toMatch(/Starting a new one with this conversation as context/);
        } finally {
            await e.stop();
        }
    }, 30_000);
});
