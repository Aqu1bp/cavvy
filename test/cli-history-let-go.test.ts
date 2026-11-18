// A Claude Code session doesn't keep its messages while it's open: once its turns are in its store, they're let go of
// whenever nothing runs (its CLI has the conversation), and read again from its file when something asks for them.
// Kept, a live session held everything it was sent, an @-mentioned file's copy each time: 15.8 MB of a real run's
// heap (4 sessions, 75 minutes). Runs on the fake `claude` (test/fixtures/fake-claude.ts), never the real CLI.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { SessionSnapshot } from "../src/server/protocol";

const iso = isolate();
const { startServer } = await import("../src/server/server");
const { findSessionAnywhere, Session } = await import("../src/agent/session");

const bin = tempDir("fake-claude-let-go-");
const claudeBin = join(bin, "claude");
writeFileSync(claudeBin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-claude.ts")}" "$@"\n`);
chmodSync(claudeBin, 0o755);

let srv: Awaited<ReturnType<typeof startServer>>;
let ws: WebSocket;
let seq = 0;
let lastId = "";
const replies = new Map<number, (msg: any) => void>();

const call = async (method: string, params: unknown): Promise<any> => {
    const id = ++seq;
    const msg = await new Promise<any>((r) => {
        replies.set(id, r);
        ws.send(JSON.stringify({ id, method, params }));
    });
    if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
    return msg.result;
};

async function until(what: string, pred: () => boolean | Promise<boolean>, ms = 15_000) {
    const end = Date.now() + ms;
    while (!(await pred())) {
        if (Date.now() > end) throw new Error(`timed out: ${what} ${JSON.stringify(await summary(lastId).catch(() => null)).slice(0, 600)}`);
        await Bun.sleep(20);
    }
}

const summary = async (id: string) => ((await call("sessions.list", { limit: 50 })) as any[]).find((s) => s.id === id);
const held = (id: string) => (srv.engine.runtimes.get(id)!.session as any).loadedMessages as unknown[];
/** As reading its file whole makes them (a fresh read, nothing it holds). */
const fromFile = (file: string) => JSON.parse(JSON.stringify((Session as any).read(file, false, true, false).messages));

beforeAll(async () => {
    process.env.CLAUDE_CODE_TMPDIR = tempDir("claude-code-tmp-");
    mkdirSync(iso.home, { recursive: true });
    writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ agents: { "claude-code": { path: claudeBin } } }));
    writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "claude-code:default" }));
    const TOKEN = "cli-let-go-token-0123456789";
    srv = await startServer({ token: TOKEN, allowBypass: true });
    ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
    await new Promise((r, j) => {
        ws.onopen = r;
        ws.onerror = j;
    });
    ws.onmessage = (m) => {
        const msg = JSON.parse(String(m.data));
        if (!msg.id) return;
        const r = replies.get(msg.id);
        replies.delete(msg.id);
        setImmediate(() => r?.(msg));
    };
}, 30_000);

afterAll(async () => {
    ws?.close();
    await srv?.stop();
    iso.cleanup();
});

test("a live Claude Code session lets go of its messages once its turns are stored, and again after it's reopened from its store", async () => {
    const cwd = join(tempDir("cavvy-cli-let-go-"), "project");
    mkdirSync(cwd, { recursive: true });
    const snap = (await call("session.create", { cwd, mode: "bypassPermissions" })) as SessionSnapshot;
    const id = (lastId = snap.state.id);
    // Past the latest 20 and the 50 more a session keeps built before it has a store (runtime.ts KEEP_BUILT, EXTRA_BUILT).
    for (let i = 0; i < 75; i++) {
        const before = (await summary(id))?.messages ?? 0;
        await call("session.send", { id, text: `Prompt ${i}` });
        await until(`turn ${i}`, async () => {
            const s = await summary(id);
            return s?.status === "idle" && s.messages > before;
        });
    }
    const rt = srv.engine.runtimes.get(id)!;
    expect((rt as any).client?.agentBackend).toBe(true);
    // Not kept while nothing runs: a digest in their place.
    await until("let go of while open", () => held(id).length === 0);
    expect(rt.session.historyDigest).toBeDefined();
    const file = findSessionAnywhere(id)!;
    const whole = fromFile(file);
    expect(rt.session.messageCount).toBe(whole.length);
    // Another turn after: put on the digest, not kept either.
    const before = rt.session.messageCount;
    await call("session.send", { id, text: "One more" });
    await until("one more", async () => (await summary(id))?.status === "idle" && rt.session.messageCount > before);
    await until("let go of after a turn", () => held(id).length === 0);
    // Read when asked for (rewind's targets read them all): as reading its file whole makes them.
    const targets = await call("session.rewindTargets", { id });
    expect(targets.length).toBeGreaterThan(70);
    expect(JSON.parse(JSON.stringify(rt.session.messages))).toEqual(fromFile(file));
    await call("session.close", { id });
    await until("closed", () => !srv.engine.runtimes.has(id));

    // Opened again: from its store, its messages read whole (no checkpoint has a digest of them yet), then let go of.
    await call("session.open", { id, last: 10 });
    const again = srv.engine.runtimes.get(id)!;
    await again.ready;
    await until("let go of after an open from its store", () => held(id).length === 0);
    expect(await call("session.rewindTargets", { id })).toEqual(targets);
    await call("session.close", { id });
}, 120_000);
