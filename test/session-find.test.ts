// Find in turns a window hasn't been sent (session.find): counted by the window's own code, so what the server finds
// is what the window would, and only the matches are sent.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");
const { writeThread } = await import("../scripts/perf-thread");
const { findMatches } = await import("../gui/src/lib/find-text");

let srv: Awaited<ReturnType<typeof startServer>>;
let mock: ReturnType<typeof startMockLlm>;
let ws: WebSocket;
let seq = 0;
const replies = new Map<number, (v: any) => void>();
const call = async (method: string, params: unknown) => {
    const r = await new Promise<any>((res) => { const id = ++seq; replies.set(id, res); ws.send(JSON.stringify({ id, method, params })); });
    if (r.error) throw new Error(`${method}: ${r.error.message}`);
    return r.result;
};

beforeAll(async () => {
    mock = startMockLlm({ delayMs: 1 });
    mkdirSync(iso.home, { recursive: true });
    writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
    const TOKEN = "session-find-token-0123456789";
    srv = await startServer({ token: TOKEN });
    ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => { const msg = JSON.parse(String(m.data)); if (msg.id) { replies.get(msg.id)?.(msg); replies.delete(msg.id); } };
});
afterAll(async () => {
    ws?.close();
    await srv?.stop();
    mock?.stop();
    iso.cleanup();
});

for (const kind of ["cli", "native"] as const) {
    test(`what the server finds in a ${kind === "cli" ? "Claude Code session" : "session of Cavvy's own model"} is what the window finds in the same turns`, async () => {
        const cwd = join(tempDir("cavvy-session-find-"), "project");
        mkdirSync(cwd, { recursive: true });
        const t = writeThread({ cwd, items: 1500, kind, seed: 5 });
        // Every turn, so the window's count can be made from the same turns.
        const all = await call("session.open", { id: t.id });
        for (const query of ["the server", "Turn 7:", "READ", "npm test", "no such words anywhere", "e"]) {
            const server = (await call("session.find", { id: t.id, query })).matches as { turnId: string; part: string; n: number; pos?: unknown }[];
            expect({ query, matches: server.map(({ turnId, part, n }) => ({ turnId, part, n })) }).toEqual({ query, matches: findMatches(all.turns, query) });
            // Each with where its turn is, to bring it into the window.
            expect(server.every((m) => m.pos !== undefined)).toBe(true);
        }
        // Before a turn: only the turns before it.
        const turns = all.turns as { id: string }[];
        const mid = turns[Math.floor(turns.length / 2)]!.id;
        const before = (await call("session.find", { id: t.id, query: "the server", before: mid })).matches as { turnId: string }[];
        const ids = new Set(turns.slice(0, Math.floor(turns.length / 2)).map((x) => x.id));
        expect(before.length).toBeGreaterThan(0);
        expect(before.every((m) => ids.has(m.turnId))).toBe(true);
        expect(before).toEqual(findMatches(all.turns.slice(0, Math.floor(turns.length / 2)), "the server").map((m) => expect.objectContaining(m)));
        // And in a gap the window holds (a page far up, then its later turns): those between, marked, in order.
        const q = Math.floor(turns.length / 4);
        const page = (await call("session.find", { id: t.id, query: "the server", before: turns[q]!.id, gap: { after: turns[q + 5]!.id, before: mid } })).matches as { turnId: string; gap?: true }[];
        const between = findMatches(all.turns.slice(q + 6, Math.floor(turns.length / 2)), "the server");
        expect(between.length).toBeGreaterThan(0);
        expect(page).toEqual([...findMatches(all.turns.slice(0, q), "the server").map((m) => expect.objectContaining(m)), ...between.map((m) => expect.objectContaining({ ...m, gap: true }))]);
        await call("session.close", { id: t.id });
    }, 60_000);
}

test("in turns a window has folded, the server finds what the window would in them whole, in order with the rest", async () => {
    const cwd = join(tempDir("cavvy-session-find-folded-"), "project");
    mkdirSync(cwd, { recursive: true });
    const t = writeThread({ cwd, items: 1500, kind: "native", seed: 6 });
    const all = (await call("session.open", { id: t.id })).turns as { id: string; blocks: unknown[] }[];
    await call("session.close", { id: t.id });
    // Opened as a window opens it, folding work: its last turns, those finished folded.
    const open = await call("session.open", { id: t.id, last: 30, fold: true });
    const folded = (open.turns as { id: string; folded?: true }[]).filter((x) => x.folded).map((x) => x.id);
    expect(folded.length).toBeGreaterThan(10);
    // Words in commands' output (which a folded row doesn't have).
    let inFolded = 0;
    for (const query of ["npm test", "the server", "PASS"]) {
        const found = (await call("session.find", { id: t.id, query, before: open.turns[0].id, turns: folded })).matches as { turnId: string; part: string; n: number }[];
        const want = findMatches(all as never, query).filter((m) => all.findIndex((x) => x.id === m.turnId) < all.length - 30 || folded.includes(m.turnId));
        expect({ query, found: found.map(({ turnId, part, n }) => ({ turnId, part, n })) }).toEqual({ query, found: want });
        inFolded += want.filter((m) => folded.includes(m.turnId)).length;
    }
    expect(inFolded).toBeGreaterThan(0);
    await call("session.close", { id: t.id });
}, 60_000);
