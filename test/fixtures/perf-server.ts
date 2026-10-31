// A turn in a real server on the mock model, in a process of its own: every git it starts goes through a stand-in on
// PATH, and that shouldn't reach any other test.
import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolate, tempDir } from "../helpers/isolate";
import { withinBudget } from "../helpers/perf-budget";

const iso = isolate();

// Every git the server starts goes through this, which writes down that it ran.
const shim = tempDir("cavvy-perf-shim-");
const gitLog = join(shim, "log");
const realGit = Bun.which("git")!;
writeFileSync(join(shim, "git"), `#!/bin/sh\necho "$*" >> "${gitLog}"\nexec "${realGit}" "$@"\n`);
chmodSync(join(shim, "git"), 0o755);
process.env.PATH = `${shim}:${process.env.PATH}`;
const gitSpawns = () => (existsSync(gitLog) ? readFileSync(gitLog, "utf8").split("\n").filter(Boolean).length : 0);

const { startServer } = await import("../../src/server/server");
const { startMockLlm, STREAM_DEMO } = await import("../../scripts/mock-llm");
const { createDemoProject } = await import("../../scripts/demo-project");

const TOKEN = "perf-token-0123456789";
const mock = startMockLlm({ delayMs: 1 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

let srv: Awaited<ReturnType<typeof startServer>>;
let ws: WebSocket;
let bytes = 0, streamed = 0;
const statusOf = new Map<string, string>();
const replies = new Map<number, (v: any) => void>();
let seq = 0;
const call = (method: string, params: unknown) => new Promise<any>((r) => { const id = ++seq; replies.set(id, r); ws.send(JSON.stringify({ id, method, params })); });

beforeAll(async () => {
    srv = await startServer({ token: TOKEN });
    ws = new WebSocket(`ws://127.0.0.1:${srv.port}/ws`, { protocols: ["cavvy.v1", `auth.${TOKEN}`] } as any);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    ws.onmessage = (m) => {
        const text = String(m.data);
        bytes += text.length;
        const msg = JSON.parse(text);
        if (msg.id) { replies.get(msg.id)?.(msg); replies.delete(msg.id); return; }
        const ev = msg.event;
        if (ev?.type === "session.ops") for (const op of ev.ops) {
            if (op.op === "append") streamed += String(op.text ?? "").length;
            if (op.op === "state" && op.patch?.status) statusOf.set(ev.sessionId, op.patch.status);
        }
    };
});

afterAll(async () => {
    ws.close();
    await srv.stop();
    mock.stop();
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function turn(cwd: string, prompt: string) {
    const id = (await call("session.create", { cwd })).result.state.id as string;
    await call("session.open", { id });
    await call("session.send", { id, text: prompt });
    for (let i = 0; i < 1200; i++) {
        const s = ((await call("sessions.list", { limit: 50 })).result as { id: string; status: string }[]).find((x) => x.id === id);
        if (s && s.status !== "running" && s.status !== "waiting" && i > 2) return id;
        if (s?.status === "waiting") {
            const asks = (await call("session.open", { id })).result?.state?.interactions ?? [];
            for (const ask of asks) if (ask.kind === "permission") await call("session.respond", { id, interactionId: ask.id, response: { kind: "permission", choice: ["always", "session", "yes"].find((c) => ask.options.some((o: { id: string }) => o.id === c)) } });
        }
        await sleep(50);
    }
    throw new Error("the turn didn't finish");
}

test("a reply costs its size on the socket, and not much more", async () => {
    const cwd = createDemoProject(tempDir("cavvy-perf-wire-"), { git: false });
    bytes = streamed = 0;
    await turn(cwd, "perfstream text 2 2000");
    expect(streamed).toBeGreaterThan(STREAM_DEMO.length);
    withinBudget("wireBytesPerCharacter", Math.round((bytes / streamed) * 100) / 100);
}, 60_000);

test("a turn starts few gits, and an idle session none", async () => {
    const cwd = createDemoProject(tempDir("cavvy-perf-git-"), { git: true });
    const before = gitSpawns();
    await turn(cwd, "sso");
    await sleep(1000);
    withinBudget("gitSpawnsPerTurn", gitSpawns() - before);
    const settled = gitSpawns();
    await sleep(5000);
    withinBudget("gitSpawnsIdle", gitSpawns() - settled);
}, 120_000);

