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
        await call("session.close", { id: t.id });
    }, 60_000);
}
