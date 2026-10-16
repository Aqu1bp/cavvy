// Searching what was said in every session (sessions.search): read from the
// files without loading them, placed the way replay places turns, redacted,
// literal, bounded.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readdirSync, symlinkSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { searchSessions, snippetAround, clearSearchCache, searchCacheSize, SEARCH_LIMITS } = await import("../src/server/search");
const { paths, projectStateDir } = await import("../src/config/paths");
const { readSegments, replay, STEERING, UiLog } = await import("../src/server/history");
const { registerSecret, unregisterSecret } = await import("../src/util/redact");
const { Engine } = await import("../src/server/engine");
const { writeImportedSession } = await import("../src/server/cli-import");
import type { SessionSearchResult, Turn } from "../src/server/protocol";

afterAll(() => iso.cleanup());

type Rec = Record<string, unknown>;
const prompt = (text: string, extra: Rec = {}): Rec => ({ t: "msg", m: { role: "user", content: [{ type: "text", text }], meta: { kind: "prompt" }, ...extra } });
const reply = (text: string): Rec => ({ t: "msg", m: { role: "assistant", provider: "anthropic", model: "claude-test", content: [{ type: "text", text }], stopReason: "end_turn" } });
const toolCall = (id: string): Rec => ({ t: "msg", m: { role: "assistant", provider: "anthropic", model: "claude-test", content: [{ type: "tool_call", id, name: "Bash", input: { command: "ls" } }], stopReason: "tool_use" } });
const results = (id: string, output: string, steer?: string): Rec => ({
    t: "msg",
    m: { role: "user", content: [{ type: "tool_result", toolCallId: id, toolName: "Bash", content: output }, ...(steer ? [{ type: "text", text: STEERING + steer }] : [])], meta: { kind: "tool_results" } },
});
const image = (data: string, text: string): Rec => ({ t: "msg", m: { role: "user", content: [{ type: "image", mediaType: "image/png", data }, { type: "text", text }], meta: { kind: "prompt" } } });

let n = 0;
/** A session file as the app writes it, one record a line; `age` seconds old. */
function write(records: Rec[], o: { cwd?: string; age?: number; id?: string } = {}): { id: string; file: string; cwd: string } {
    const cwd = o.cwd ?? join(tempDir("harness-search-proj-"), "proj");
    const id = o.id ?? `20260101-000000-${(++n).toString(16).padStart(6, "0")}`;
    const dir = projectStateDir(cwd);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${id}.jsonl`);
    writeFileSync(file, [{ t: "meta", id, cwd, createdAt: 0, version: "1" }, ...records].map((r) => JSON.stringify(r)).join("\n") + "\n");
    if (o.age !== undefined) {
        const t = Date.now() / 1000 - o.age;
        utimesSync(file, t, t);
    }
    return { id, file, cwd };
}

/** The turn replay draws for a session file, found the way the GUI finds a hit's (gui/src/lib/find.ts turnAt). */
function turnFor(file: string, seg: number, index: number): Turn | undefined {
    const segments = readSegments(file);
    const turns = replay({ segments, current: segments[segments.length - 1]!.messages, ui: new UiLog(file, "x", false), meta: () => ({ title: "" }), newId: (() => { let i = 0; return () => `t${++i}`; })() });
    let best: Turn | undefined;
    for (const t of turns) if (t.pos && (t.pos.seg < seg || (t.pos.seg === seg && t.pos.index <= index))) best = t;
    return best;
}

describe("searching session files", () => {
    test.each(["claude-code", "codex"] as const)("%s imports keep searchable message positions without enabling rewind", async (source) => {
        const cwd = tempDir("harness-search-import-");
        const title = `Imported ${source} conversation`;
        const key = `import-${source}-search`;
        const id = writeImportedSession({
            cwd, title, model: `${source}:default`,
            entry: { source, id: "native-session", file: join(cwd, "native.jsonl"), cwd, title, named: true, startedAt: 1000, updatedAt: 4000, size: 0, messages: 7, partial: false },
            transcript: { omitted: 12, turns: [
                { prompt: `${key} opening`, replies: [`${key} first reply`], actions: [`Bash(${key}-tool-only)`], at: 1000 },
                { prompt: `${key} actions only`, replies: [], actions: [`Read(${key}-tool-only)`], at: 2000 },
                { prompt: `${key} command`, command: true, replies: [], actions: [], at: 3000 },
                { prompt: `${key} last prompt`, replies: [`${key} last reply`], actions: [], at: 4000 },
            ] },
        });
        const file = join(projectStateDir(cwd), `${id}.jsonl`);
        // The banner adds no message slot; action notes share the assistant's
        // slot. A prompt without a reply takes one; an action-only turn takes two.
        for (const [index, start, at, text, query] of [
            [0, 0, 1000, "opening", "opening"], [1, 0, 1000, "opening", "first reply"],
            [2, 2, 2000, "actions only", "actions only"], [4, 4, 3000, "command", "command"],
            [5, 5, 4000, "last prompt", "last prompt"], [6, 5, 4000, "last prompt", "last reply"],
        ] as const) {
            const r = await searchSessions(`${key} ${query}`);
            expect(r.partial).toBe(false);
            expect(r.hits).toHaveLength(1);
            const hit = r.hits[0]!;
            expect(hit).toMatchObject({ id, cwd, title, seg: 0, index, at });
            const turn = turnFor(file, hit.seg, hit.index)!;
            expect(turn).toMatchObject({ imported: true, pos: { seg: 0, index: start }, prompt: { text: `${key} ${text}` } });
            expect(turn.prompt!.index).toBeUndefined();
            if (index === 4) expect(turn.prompt!.command).toBe(true);
        }
        expect((await searchSessions(`${key}-tool-only`)).hits).toEqual([]);
        // The trailing backend/import metadata must not shift the next live turn.
        appendFileSync(file, [prompt(`${key} continued`), reply(`${key} new reply`)].map((r) => JSON.stringify(r) + "\n").join(""));
        const next = (await searchSessions(`${key} new reply`)).hits[0]!;
        expect(next).toMatchObject({ id, seg: 0, index: 8 });
        expect(turnFor(file, next.seg, next.index)).toMatchObject({ pos: { seg: 0, index: 7 }, prompt: { text: `${key} continued`, index: 7 } });
    });

    test("finds prompts and replies, with the turn they're in", async () => {
        const s = write([prompt("how do I configure the frobnicator?"), reply("The Frobnicator is configured in settings.toml under [frob]."), prompt("thanks"), reply("Anything else?")]);
        const user = await searchSessions("configure the frob");
        expect(user.hits).toHaveLength(1);
        expect(user.hits[0]).toMatchObject({ id: s.id, cwd: s.cwd, role: "user", seg: 0, index: 0, title: "how do I configure the frobnicator?" });
        const h = (await searchSessions("SETTINGS.TOML")).hits;
        expect(h).toHaveLength(1);
        expect(h[0]).toMatchObject({ id: s.id, role: "assistant", seg: 0, index: 1 });
        // The match, marked in the snippet, as it was written.
        expect(h[0]!.snippet.slice(...h[0]!.match!)).toBe("settings.toml");
        expect(turnFor(s.file, 0, 1)?.prompt?.text).toBe("how do I configure the frobnicator?");
    });

    test("a title record names the hit; tool output isn't searched; steering is, as its own turn", async () => {
        const s = write([{ t: "title", title: "Greeting exchange" }, prompt("list the files"), toolCall("c1"), results("c1", "quuxfile.txt in the folder", "also check the quuxdir"), reply("done")]);
        expect((await searchSessions("quuxfile")).hits).toHaveLength(0);
        const h = (await searchSessions("check the quuxdir")).hits;
        expect(h).toHaveLength(1);
        expect(h[0]).toMatchObject({ title: "Greeting exchange", role: "user", index: 2 });
        expect(turnFor(s.file, 0, h[0]!.index)?.prompt?.text).toBe("also check the quuxdir");
    });

    test("image data isn't searched, and a line too long to read still takes its place", async () => {
        const marker = "ZEBRAZEBRAZEBRA";
        const small = "QUJD".repeat(20_000) + marker + "QUJD".repeat(100);
        const huge = "QUJD".repeat(1_300_000) + marker; // over 4 MB
        const s = write([image(small, "describe this picture please"), reply("A lighthouse."), image(huge, "and this enormous one"), reply("xylophone after the huge image")]);
        expect((await searchSessions(marker.toLowerCase())).hits).toHaveLength(0);
        expect((await searchSessions("describe this picture")).hits[0]).toMatchObject({ id: s.id, index: 0 });
        // The huge line isn't parsed (its text isn't found), but the reply after it is where replay has it.
        expect((await searchSessions("enormous one")).hits).toHaveLength(0);
        const h = (await searchSessions("xylophone")).hits;
        expect(h[0]).toMatchObject({ id: s.id, index: 3, role: "assistant" });
        expect(turnFor(s.file, 0, 3)?.blocks.some((b) => b.t === "text" && b.text.includes("xylophone"))).toBe(true);
    });

    test("rewinds drop what they cut; compactions start a segment, as replay counts", async () => {
        const s = write([
            prompt("alpha opening words"),
            reply("ok"),
            prompt("rewound bravo words"),
            reply("ok"),
            { t: "rewind", count: 2 },
            prompt("charlie after the rewind"),
            reply("ok"),
            { t: "compact", summary: "We talked." },
            { t: "msg", m: { role: "user", content: [{ type: "text", text: "summary of delta words" }], meta: { kind: "summary" } } },
            prompt("echo after compaction"),
            reply("foxtrot reply after compaction"),
        ]);
        expect((await searchSessions("rewound bravo")).hits).toHaveLength(0);
        expect((await searchSessions("delta words")).hits).toHaveLength(0);
        expect((await searchSessions("charlie after")).hits[0]).toMatchObject({ seg: 0, index: 2 });
        expect((await searchSessions("echo after compaction")).hits[0]).toMatchObject({ seg: 1, index: 1 });
        const f = (await searchSessions("foxtrot reply")).hits[0]!;
        expect(f).toMatchObject({ seg: 1, index: 2, role: "assistant" });
        expect(turnFor(s.file, 0, 2)?.prompt?.text).toBe("charlie after the rewind");
        expect(turnFor(s.file, f.seg, f.index)?.prompt?.text).toBe("echo after compaction");
    });

    test("a reply that carries on after an automatic compaction is in its own place", async () => {
        const s = write([
            prompt("golf before the automatic compaction"),
            toolCall("g1"),
            results("g1", "output"),
            { t: "compact", summary: "Summary so far." },
            { t: "msg", m: { role: "user", content: [{ type: "text", text: "summary" }], meta: { kind: "summary" } } },
            reply("hotel continuation words"),
            prompt("india next prompt"),
        ]);
        const h = (await searchSessions("hotel continuation")).hits[0]!;
        expect(h).toMatchObject({ seg: 1, index: 1, role: "assistant" });
        const t = turnFor(s.file, h.seg, h.index)!;
        expect(t.blocks.some((b) => b.t === "text" && b.text === "hotel continuation words")).toBe(true);
        expect(turnFor(s.file, 1, 2)?.prompt?.text).toBe("india next prompt");
    });

    test("persisted notices don't count as messages or move search hits across turns", async () => {
        const notice = (index: number, text: string): Rec => ({ t: "notice", index, level: "error", text, at: 1234 });
        const s = write([
            prompt("notice-map initial prompt"),
            notice(1, "notice-map initial error"),
            prompt("notice-map tool prompt"),
            toolCall("notice-map-tool"),
            results("notice-map-tool", "output", "notice-map steering"),
            reply("notice-map steered reply"),
            notice(5, "notice-map steering error"),
            prompt("notice-map removed prompt"),
            reply("notice-map removed reply"),
            notice(7, "notice-map removed error"),
            { t: "rewind", count: 5 },
            prompt("notice-map replacement prompt", { meta: { kind: "command", display: "/notice-map" } }),
            reply("notice-map replacement reply"),
            notice(7, "notice-map replacement error"),
            { t: "compact", summary: "notice-map compact summary" },
            { t: "msg", m: { role: "user", content: [{ type: "text", text: "summary" }], meta: { kind: "summary" } } },
            prompt("notice-map current prompt"),
            notice(2, "notice-map current error"),
            reply("notice-map current reply"),
        ]);
        for (const [query, seg, index, promptText, error] of [
            ["notice-map steered reply", 0, 4, "notice-map steering", "notice-map steering error"],
            ["notice-map replacement reply", 0, 6, "/notice-map", "notice-map replacement error"],
            ["notice-map current reply", 1, 2, "notice-map current prompt", "notice-map current error"],
        ] as const) {
            const h = (await searchSessions(query)).hits[0]!;
            expect(h).toMatchObject({ id: s.id, seg, index, role: "assistant" });
            const turn = turnFor(s.file, h.seg, h.index)!;
            expect(turn.prompt?.text).toBe(promptText);
            expect(turn.blocks.some((b) => b.t === "text" && b.text === query)).toBe(true);
            expect(turn.blocks.some((b) => b.t === "notice" && b.text === error)).toBe(true);
        }
        expect((await searchSessions("notice-map removed")).hits).toHaveLength(0);
        expect((await searchSessions("notice-map initial error")).hits).toHaveLength(0);
        const segments = readSegments(s.file);
        expect(segments.map((s) => s.messages.length)).toEqual([7, 3]);
        expect(segments[0]!.notices?.map((n) => n.text)).toEqual(["notice-map initial error", "notice-map steering error", "notice-map replacement error"]);
        expect(turnFor(s.file, 0, 0)?.blocks.some((b) => b.t === "notice" && b.text === "notice-map initial error")).toBe(true);
    });

    test("a notice-created turn has a position, including an empty segment and a later continuation", async () => {
        const s = write([
            prompt("notice-position before compaction"),
            { t: "compact", summary: "Summary before a failed continuation." },
            { t: "msg", m: { role: "user", content: [{ type: "text", text: "summary" }], meta: { kind: "summary" } } },
            { t: "notice", index: 1, level: "error", text: "notice-position failed continuation", at: 1234 },
        ]);
        const failed = turnFor(s.file, 1, 1)!;
        expect(failed.pos).toEqual({ seg: 1, index: 1 });
        expect(failed.blocks).toContainEqual(expect.objectContaining({ t: "notice", text: "notice-position failed continuation" }));
        appendFileSync(s.file, JSON.stringify(reply("notice-position resumed reply")) + "\n");
        const hit = (await searchSessions("notice-position resumed reply")).hits[0]!;
        expect(hit).toMatchObject({ id: s.id, seg: 1, index: 1 });
        const resumed = turnFor(s.file, hit.seg, hit.index)!;
        expect(resumed.pos).toEqual({ seg: 1, index: 1 });
        expect(resumed.blocks.some((b) => b.t === "text" && b.text === "notice-position resumed reply")).toBe(true);
        appendFileSync(s.file, JSON.stringify({ t: "compact", summary: "Empty segment." }) + "\n" + JSON.stringify({ t: "notice", index: 0, level: "error", text: "notice-position empty segment", at: 2345 }) + "\n");
        const empty = turnFor(s.file, 2, 0)!;
        expect(empty.pos).toEqual({ seg: 2, index: 0 });
        expect(empty.blocks).toContainEqual(expect.objectContaining({ t: "notice", text: "notice-position empty segment" }));
    });

    test("a long line a crash cut short isn't counted, as replay skips it", async () => {
        const torn = JSON.stringify(image("QUJD".repeat(1_300_000), "torn"));
        expect(torn.endsWith("}}}")).toBe(true);
        const cwd = join(tempDir("harness-search-proj-"), "proj");
        const s = write([prompt("juliet before the torn line")], { cwd });
        appendFileSync(s.file, torn.slice(0, -1) + "\n" + JSON.stringify(reply("kilo after the torn line")) + "\n");
        const h = (await searchSessions("kilo after the torn")).hits[0]!;
        expect(h.index).toBe(1);
        expect(readSegments(s.file)[0]!.messages).toHaveLength(2);
        expect(turnFor(s.file, 0, h.index)?.blocks.some((b) => b.t === "text" && b.text === "kilo after the torn line")).toBe(true);
    });

    test("when a reused position was last started counts (a rewind reuses it)", async () => {
        const s = write([prompt("lima zero"), reply("ok"), { t: "rewind", count: 0 }, prompt("lima replaced words"), reply("ok")]);
        const ui = join(projectStateDir(s.cwd), "ui");
        mkdirSync(ui, { recursive: true });
        writeFileSync(join(ui, `${s.id}.jsonl`), [{ t: "turn", seg: 0, index: 0, at: 1_000 }, { t: "turn", seg: 0, index: 0, at: 5_000 }].map((r) => JSON.stringify(r)).join("\n") + "\n");
        expect((await searchSessions("lima replaced")).hits[0]).toMatchObject({ index: 0, at: 5_000 });
    });

    test("a reply's time is its own turn's, not one a rewind took away", async () => {
        const s = write([prompt("old zero"), reply("ok"), prompt("old two"), reply("ok"), { t: "rewind", count: 0 }, prompt("oscar new prompt"), toolCall("o1"), results("o1", "x"), reply("oscar new reply")]);
        const ui = join(projectStateDir(s.cwd), "ui");
        mkdirSync(ui, { recursive: true });
        writeFileSync(join(ui, `${s.id}.jsonl`), [{ t: "turn", seg: 0, index: 0, at: 1_000 }, { t: "turn", seg: 0, index: 2, at: 2_000 }, { t: "turn", seg: 0, index: 0, at: 9_000 }].map((r) => JSON.stringify(r)).join("\n") + "\n");
        expect((await searchSessions("oscar new reply")).hits[0]).toMatchObject({ index: 3, at: 9_000 });
    });

    test("case doesn't depend on the letters around (Greek final sigma)", async () => {
        write([prompt("ΟΣΑ ΕΙΠΑ")]);
        expect((await searchSessions("ΟΣ")).hits).toHaveLength(1);
        expect((await searchSessions("οσα")).hits).toHaveLength(1);
    });

    test("regex characters are taken literally", async () => {
        write([prompt("grep for a.*(b) in the logs"), reply("abc and a+b and \\d+ too")]);
        const h = (await searchSessions(".*(")).hits;
        expect(h).toHaveLength(1);
        expect(h[0]!.snippet.slice(...h[0]!.match!)).toBe(".*(");
        expect((await searchSessions("a.c")).hits).toHaveLength(0);
        expect((await searchSessions("\\d+")).hits).toHaveLength(1);
        expect((await searchSessions("a+b")).hits).toHaveLength(1);
        expect((await searchSessions("[a-z]")).hits).toHaveLength(0);
    });

    test("a key in a transcript is redacted in the snippet", async () => {
        const key = "sk-proj-" + "Zq7".repeat(12);
        write([prompt("where did I put it"), reply(`the gizmo key is ${key} so keep it safe`)]);
        const h = (await searchSessions("the gizmo key")).hits;
        expect(h).toHaveLength(1);
        expect(h[0]!.snippet).not.toContain("Zq7Zq7");
        expect(h[0]!.snippet).toContain("[REDACTED openai-key]");
        // Searching for the key itself finds the message, but doesn't show it.
        const k = (await searchSessions(key)).hits;
        expect(k).toHaveLength(1);
        expect(k[0]!.snippet).not.toContain("Zq7Zq7");
        // A secret the harness learned since the file was written.
        registerSecret("hunter2-wobble-secret", "test-secret");
        try {
            write([prompt("the passphrase"), reply("it was hunter2-wobble-secret all along")]);
            const r = (await searchSessions("all along")).hits[0]!;
            expect(r.snippet).not.toContain("hunter2");
            expect(r.snippet).toContain("[REDACTED test-secret]");
        } finally {
            unregisterSecret("hunter2-wobble-secret");
        }
        // One longer than the stretch shown: only recognized whole, so it's redacted before the snippet is cut.
        const long = "Q9x".repeat(170);
        registerSecret(long, "long-secret");
        try {
            write([prompt("the certificate"), reply(`${long} mango-omega follows it`)]);
            const r = (await searchSessions("mango-omega")).hits[0]!;
            expect(r.snippet).not.toContain("Q9xQ9x");
            expect(r.snippet).toContain("[REDACTED long-secret]");
            // Across the point where a very long message stops being searched.
            const head = "word ".repeat(Math.floor((256 * 1024 - 40) / 5));
            write([prompt("a long paste"), reply(`${head}papa-marker ${long} and more`)]);
            const c = (await searchSessions("papa-marker")).hits[0]!;
            expect(c.snippet).not.toContain("Q9x");
            // In a title too, where it's cut at 120 characters.
            write([{ t: "title", title: `${"t".repeat(110)}${long}` }, prompt("november title words")]);
            const t = (await searchSessions("november title")).hits[0]!;
            expect(t.title).not.toContain("Q9x");
        } finally {
            unregisterSecret(long);
        }
    });

    test("the limit holds, and one session gives at most three hits, newest session first", async () => {
        for (let i = 0; i < 6; i++) write([prompt(`kilo marker ${i}`), reply("kilo marker again"), prompt("kilo marker thrice"), reply("kilo marker four")], { age: 100 + i });
        const all = (await searchSessions("kilo marker", { limit: 200 })).hits;
        expect(all).toHaveLength(18);
        const counts = new Map<string, number>();
        for (const h of all) counts.set(h.id, (counts.get(h.id) ?? 0) + 1);
        expect([...counts.values()].every((c) => c === 3)).toBe(true);
        expect(all[0]!.snippet).toContain("kilo marker 0");
        expect((await searchSessions("kilo marker", { limit: 5 })).hits).toHaveLength(5);
    });

    test("a session changed since it was read is read again", async () => {
        const s = write([prompt("lima first words"), reply("ok")]);
        expect((await searchSessions("lima later words")).hits).toHaveLength(0);
        appendFileSync(s.file, JSON.stringify(prompt("lima later words")) + "\n");
        expect((await searchSessions("lima later words")).hits[0]).toMatchObject({ id: s.id, index: 2 });
    });

    test("the cache counts all it keeps: folded text, turn starts, turn times by record", async () => {
        const limits = { ...SEARCH_LIMITS };
        try {
            // Prompts of only an image start turns but have no text; a reply has its text twice (as written, folded).
            const recs: Rec[] = [];
            for (let i = 0; i < 3000; i++) recs.push({ t: "msg", m: { role: "user", content: [{ type: "image", mediaType: "image/png", data: "QUJD" }], meta: { kind: "prompt" } } });
            recs.push(reply("sierra " + "x".repeat(1000)));
            const s = write(recs);
            const ui = join(projectStateDir(s.cwd), "ui");
            mkdirSync(ui, { recursive: true });
            writeFileSync(join(ui, `${s.id}.jsonl`), Array.from({ length: 50 }, (_, i) => JSON.stringify({ t: "turn", seg: 0, index: i, at: i })).join("\n") + "\n");
            const only = (id: string) => id === s.id;
            clearSearchCache();
            expect((await searchSessions("sierra", { include: only })).hits).toHaveLength(1);
            const kept = searchCacheSize();
            expect(kept).toMatchObject({ docs: 1, turnTimes: 1, records: 51 });
            expect(kept.chars).toBeGreaterThan(3000 * 32 + 2 * 1007);
            // Over the limits: given back, not kept.
            SEARCH_LIMITS.cacheChars = 50_000;
            SEARCH_LIMITS.cacheTurnTimes = 10;
            clearSearchCache();
            expect((await searchSessions("sierra", { include: only })).hits).toHaveLength(1);
            expect(searchCacheSize()).toEqual({ docs: 0, chars: 0, turnTimes: 0, records: 0 });
        } finally {
            Object.assign(SEARCH_LIMITS, limits);
            clearSearchCache();
        }
    });

    test("GUI logs with no turn in them still count against the cache's limit", async () => {
        const limits = { ...SEARCH_LIMITS };
        try {
            const ids = new Set<string>();
            for (let i = 0; i < 3; i++) {
                const s = write([prompt(`xenon empty log ${i}`)]);
                ids.add(s.id);
                const ui = join(projectStateDir(s.cwd), "ui");
                mkdirSync(ui, { recursive: true });
                // Empty, or only tool records: no turn times.
                writeFileSync(join(ui, `${s.id}.jsonl`), i === 0 ? "" : JSON.stringify({ t: "tool", id: "c1", summary: "x" }) + "\n");
            }
            SEARCH_LIMITS.cacheTurnTimes = 2;
            clearSearchCache();
            expect((await searchSessions("xenon empty log", { include: (id) => ids.has(id) })).hits).toHaveLength(3);
            const kept = searchCacheSize();
            expect(kept.turnTimes).toBeLessThanOrEqual(2);
            expect(kept.records).toBeLessThanOrEqual(2);
            expect(kept.records).toBe(kept.turnTimes);
        } finally {
            Object.assign(SEARCH_LIMITS, limits);
            clearSearchCache();
        }
    });

    test("a symlinked ui folder isn't followed either", async () => {
        const s = write([prompt("yankee real prompt")]);
        const elsewhere = tempDir("harness-search-uidir-");
        writeFileSync(join(elsewhere, `${s.id}.jsonl`), JSON.stringify({ t: "turn", seg: 0, index: 0, at: 4_242 }) + "\n");
        symlinkSync(elsewhere, join(projectStateDir(s.cwd), "ui"));
        clearSearchCache();
        const h = (await searchSessions("yankee real prompt")).hits[0]!;
        expect(h.id).toBe(s.id);
        expect(h.at).not.toBe(4_242);
    });

    test("symlinked project folders, session files and GUI logs aren't followed", async () => {
        // A folder elsewhere, linked in as a project.
        const elsewhere = tempDir("harness-search-elsewhere-");
        writeFileSync(join(elsewhere, "20260101-000000-feed01.jsonl"), [{ t: "meta", id: "20260101-000000-feed01", cwd: elsewhere, createdAt: 0, version: "1" }, prompt("tango linked folder")].map((r) => JSON.stringify(r)).join("\n") + "\n");
        symlinkSync(elsewhere, join(paths.projectsDir(), "linked-project"));
        // A session file elsewhere, linked into a real project.
        const real = write([prompt("victor real session")]);
        const outside = join(tempDir("harness-search-file-"), "s.jsonl");
        writeFileSync(outside, [{ t: "meta", id: "x", cwd: real.cwd, createdAt: 0, version: "1" }, prompt("uniform linked file")].map((r) => JSON.stringify(r)).join("\n") + "\n");
        symlinkSync(outside, join(projectStateDir(real.cwd), "20260101-000000-feed02.jsonl"));
        // A GUI log elsewhere, linked in for the real session.
        const log = join(tempDir("harness-search-log-"), "ui.jsonl");
        writeFileSync(log, JSON.stringify({ t: "turn", seg: 0, index: 0, at: 7_777 }) + "\n");
        mkdirSync(join(projectStateDir(real.cwd), "ui"), { recursive: true });
        symlinkSync(log, join(projectStateDir(real.cwd), "ui", `${real.id}.jsonl`));
        clearSearchCache();
        expect((await searchSessions("tango linked folder")).hits).toHaveLength(0);
        expect((await searchSessions("uniform linked file")).hits).toHaveLength(0);
        const v = (await searchSessions("victor real session")).hits[0]!;
        expect(v.id).toBe(real.id);
        expect(v.at).not.toBe(7_777);
    });

    test("the snippet is a short stretch around the match", () => {
        const text = "word ".repeat(200) + "the NEEDLE is here " + "more ".repeat(200);
        const at = text.indexOf("NEEDLE");
        const s = snippetAround(text, at, "needle");
        expect(s.snippet.startsWith("…")).toBe(true);
        expect(s.snippet.endsWith("…")).toBe(true);
        expect(s.snippet.length).toBeLessThan(200);
        expect(s.snippet.slice(...s.match!)).toBe("NEEDLE");
    });
});

describe("sessions.search in the engine", () => {
    test("archived sessions are marked, and can be picked or left out", async () => {
        const a = write([prompt("mike phrase in an archived one")]);
        const b = write([prompt("mike phrase in a current one")]);
        writeFileSync(join(iso.home, "gui.json"), JSON.stringify({ archived: [a.id] }));
        const engine = new Engine({ listModels: async () => [] });
        const c = { subs: new Set<string>(), send() {} };
        engine.clients.add(c);
        try {
            const all = (await engine.handle(c, "sessions.search", { query: "mike phrase" })) as SessionSearchResult;
            expect(all.hits.map((h) => [h.id, h.archived]).sort()).toEqual([[a.id, true], [b.id, false]].sort() as [string, boolean][]);
            expect(all.hits[0]!.projectName).toBe("proj");
            const only = (await engine.handle(c, "sessions.search", { query: "mike phrase", archived: true })) as SessionSearchResult;
            expect(only.hits.map((h) => h.id)).toEqual([a.id]);
            const not = (await engine.handle(c, "sessions.search", { query: "mike phrase", archived: false })) as SessionSearchResult;
            expect(not.hits.map((h) => h.id)).toEqual([b.id]);
            // Too short to search; too long, or not text, is refused.
            expect(((await engine.handle(c, "sessions.search", { query: "m" })) as SessionSearchResult).hits).toEqual([]);
            await expect(engine.handle(c, "sessions.search", { query: "x".repeat(201) })).rejects.toThrow(/200 characters/);
            await expect(engine.handle(c, "sessions.search", { query: 5 })).rejects.toThrow(/query must be a string/);
        } finally {
            writeFileSync(join(iso.home, "gui.json"), "{}");
            await engine.stop();
        }
    });

    test("a newer search from the same window stops the one before it", async () => {
        clearSearchCache();
        const engine = new Engine({ listModels: async () => [] });
        const c = { subs: new Set<string>(), send() {} };
        const other = { subs: new Set<string>(), send() {} };
        engine.clients.add(c);
        engine.clients.add(other);
        try {
            const first = engine.handle(c, "sessions.search", { query: "kilo marker" }) as Promise<SessionSearchResult>;
            const elsewhere = engine.handle(other, "sessions.search", { query: "kilo marker" }) as Promise<SessionSearchResult>;
            const second = engine.handle(c, "sessions.search", { query: "lima first" }) as Promise<SessionSearchResult>;
            const [a, b, o] = await Promise.all([first, second, elsewhere]);
            expect(a).toMatchObject({ hits: [], stale: true });
            expect(b.hits).toHaveLength(1);
            // Another window's search isn't affected.
            expect(o.hits.length).toBeGreaterThan(0);
        } finally {
            await engine.stop();
        }
    });
});

describe("speed", () => {
    test("a few hundred sessions: the first search reads them, the next ones are quick", async () => {
        const cwd = join(tempDir("harness-search-many-"), "many");
        const filler = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore. ".repeat(6);
        let bytes = 0;
        for (let i = 0; i < 200; i++) {
            const recs: Rec[] = [];
            for (let j = 0; j < 30; j++) {
                recs.push(prompt(`question ${j} about part ${i}: ${filler}`));
                recs.push(toolCall(`c${j}`));
                recs.push(results(`c${j}`, filler.repeat(8)));
                recs.push(reply(`${j === 17 && i % 40 === 0 ? "the oscillating november widget " : ""}answer ${j}. ${filler}`));
            }
            bytes += recs.reduce((s, r) => s + JSON.stringify(r).length + 1, 0);
            write(recs, { cwd, age: 1000 + i });
        }
        clearSearchCache();
        let t = performance.now();
        const cold = await searchSessions("november widget", { limit: 50 });
        const coldMs = performance.now() - t;
        t = performance.now();
        const warm = await searchSessions("November Widget", { limit: 50 });
        const warmMs = performance.now() - t;
        t = performance.now();
        const none = await searchSessions("nothing says this anywhere", { limit: 50 });
        const noneMs = performance.now() - t;
        console.log(`search: ${(bytes / 1024 / 1024).toFixed(0)} MB in 200 sessions: first ${coldMs.toFixed(0)} ms, again ${warmMs.toFixed(0)} ms, no match ${noneMs.toFixed(0)} ms`);
        expect(cold.hits).toHaveLength(5);
        expect(cold.partial).toBe(false);
        expect(warm.hits).toHaveLength(5);
        expect(none.hits).toHaveLength(0);
        expect(coldMs).toBeLessThan(5000);
        expect(warmMs).toBeLessThan(400);
        expect(noneMs).toBeLessThan(400);
    }, 60_000);

    test("the budget stops a search with what it found", async () => {
        clearSearchCache();
        const r = await searchSessions("question 3 about", { limit: 500, budgetBytes: 1 });
        expect(r.partial).toBe(true);
        expect(r.stale).toBe(false);
    });

    test("asked again, a search stopped by its budget reads on from where it stopped", async () => {
        // The oldest session of all says it; everything newer is read first.
        const old = write([prompt("what did we name it"), reply("we named it the quokka lighthouse")], { age: 400 * 86400 });
        clearSearchCache();
        const budgetBytes = 8 * 1024 * 1024;
        const first = await searchSessions("quokka lighthouse", { budgetBytes });
        expect(first).toMatchObject({ hits: [], partial: true });
        // Each answer reads at most the budget; read from scratch, every one would stop where the first did.
        let r = first;
        let rounds = 1;
        while (r.partial && rounds < 20) {
            r = await searchSessions("quokka lighthouse", { budgetBytes });
            rounds++;
        }
        expect(r.partial).toBe(false);
        expect(r.hits.map((h) => h.id)).toEqual([old.id]);
        expect(rounds).toBeGreaterThan(2);
        expect(rounds).toBeLessThan(12);
    });
});

describe("listing a big project folder", () => {
    test("yields and checks for a newer search every so many files, and a budget spent listing is partial", async () => {
        const cwd = join(tempDir("harness-search-big-"), "big");
        const dir = projectStateDir(cwd);
        mkdirSync(dir, { recursive: true });
        for (let i = 0; i < 3000; i++) {
            const id = `20250101-000000-${i.toString(16).padStart(6, "0")}`;
            writeFileSync(join(dir, `${id}.jsonl`), JSON.stringify({ t: "meta", id, cwd, createdAt: 0, version: "1" }) + "\n");
        }
        const folders = readdirSync(paths.projectsDir()).length;
        let checks = 0;
        const none = await searchSessions("whiskey", { include: () => false, stale: () => (checks++, false) });
        expect(none.partial).toBe(false);
        // Once a folder (or once after listing) would be the folder count plus one; inside this one, every 64 files too.
        expect(checks).toBeGreaterThanOrEqual(folders + Math.floor(3000 / 64));
        // A newer search while it lists: it stops there.
        let n = 0;
        expect(await searchSessions("whiskey", { stale: () => ++n > folders + 5 })).toMatchObject({ hits: [], stale: true });
        // No time left once it's listed: partial, even though no session was looked at.
        const late = await searchSessions("whiskey", { include: () => false, budgetMs: 0 });
        expect(late.partial).toBe(true);
    });
});
