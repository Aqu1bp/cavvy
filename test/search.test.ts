// Searching what was said in every session (sessions.search): read from the
// files without loading them, placed the way replay places turns, redacted,
// literal, bounded.

import { afterAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { searchSessions, snippetAround, clearSearchCache } = await import("../src/server/search");
const { projectStateDir } = await import("../src/config/paths");
const { readSegments, replay, STEERING, UiLog } = await import("../src/server/history");
const { registerSecret, unregisterSecret } = await import("../src/util/redact");
const { Engine } = await import("../src/server/engine");
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
});
