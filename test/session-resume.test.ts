// A window whose connection dropped asks for a session again with what it had (session.open's `since`): it's sent
// only the ops it missed, in order, when the server still has them all, and a snapshot otherwise (too much missed, or
// the session read in again since).
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { SessionOp } from "../src/server/protocol";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { startServer } = await import("../src/server/server");

let srv: Awaited<ReturnType<typeof startServer>>;
let mock: ReturnType<typeof startMockLlm>;
const TOKEN = "resume-token-0123456789";

/** A window: its calls, and every batch of ops it's sent, by seq. */
async function window() {
    const ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const replies = new Map<number, (m: any) => void>();
    const batches: { seq: number; ops: SessionOp[]; bytes: number }[] = [];
    ws.onmessage = (m) => {
        const text = String(m.data);
        const msg = JSON.parse(text);
        if (msg.id) { replies.get(msg.id)?.(msg); replies.delete(msg.id); }
        else if (msg.event?.type === "session.ops") batches.push({ seq: msg.event.seq, ops: msg.event.ops, bytes: text.length });
    };
    const call = async (method: string, params: unknown): Promise<any> => {
        const id = ++seq;
        const msg = await new Promise<any>((r) => { replies.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
        if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
        return msg.result;
    };
    return { ws, call, batches };
}

beforeAll(async () => {
    mock = startMockLlm({ delayMs: 0 });
    mkdirSync(iso.home, { recursive: true });
    writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
    writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
    srv = await startServer({ token: TOKEN });
}, 30_000);

afterAll(async () => {
    await srv?.stop();
    mock?.stop();
    iso.cleanup();
});

const until = async (ok: () => boolean) => {
    for (let i = 0; i < 400 && !ok(); i++) await Bun.sleep(25);
    expect(ok()).toBe(true);
};

test("a window back after its connection dropped is sent what it missed, or a snapshot when that's not to be had", async () => {
    const cwd = join(tempDir("cavvy-resume-"), "project");
    mkdirSync(cwd, { recursive: true });
    const a = await window();
    const created = await a.call("session.create", { cwd });
    const id = created.state.id as string;
    const epoch = created.epoch as string;
    expect(typeof epoch).toBe("string");
    // Another window, open on it throughout: what the first should have had.
    const b = await window();
    await b.call("session.open", { id });
    // The first drops after its first reply; the session carries on.
    await a.call("session.send", { id, text: "Say hello" });
    await until(() => b.batches.some((x) => x.ops.some((o) => o.op === "state" && (o as any).patch?.busy === false)));
    const had = b.batches.at(-1)!.seq;
    a.ws.close();
    await b.call("session.send", { id, text: "Say hello again" });
    await until(() => b.batches.at(-1)!.seq > had && b.batches.at(-1)!.ops.some((o) => o.op === "state" && (o as any).patch?.busy === false));
    const missed = b.batches.filter((x) => x.seq > had);
    // Back: the ops after what it had, in order, up to where they come to.
    const c = await window();
    const back = await c.call("session.open", { id, last: 10, budget: 65536, since: { epoch, seq: had } });
    expect(back.resumed).toBe(true);
    expect(back.seq).toBe(missed.at(-1)!.seq);
    expect(back.ops).toEqual(missed.flatMap((x) => x.ops));
    // Nothing missed: nothing sent.
    expect(await c.call("session.open", { id, since: { epoch, seq: back.seq } })).toEqual({ resumed: true, seq: back.seq, ops: [] });
    // Numbered by another reading of the session (the server started again, say): a snapshot.
    const other = await c.call("session.open", { id, last: 10, since: { epoch: "elsewhere", seq: had } });
    expect(other.resumed).toBeUndefined();
    expect(other.epoch).toBe(epoch);
    expect(other.turns.length).toBeGreaterThan(0);
    // More missed than it keeps (a long reply): a snapshot, no bigger than one.
    const before = b.batches.at(-1)!.seq;
    await b.call("session.send", { id, text: "perfreply 120000 4000 1" });
    await until(() => b.batches.at(-1)!.seq > before && b.batches.at(-1)!.ops.some((o) => o.op === "state" && (o as any).patch?.busy === false));
    const long = b.batches.filter((x) => x.seq > before).reduce((n, x) => n + x.bytes, 0);
    expect(long).toBeGreaterThan(100 * 1024);
    const snap = await c.call("session.open", { id, last: 10, budget: 65536, since: { epoch, seq: before } });
    expect(snap.resumed).toBeUndefined();
    expect(snap.turns.length).toBeGreaterThan(0);
    for (const w of [b, c]) w.ws.close();
}, 60_000);
