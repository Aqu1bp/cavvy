import { expect, test } from "bun:test";
import { createRunSheet, type RunRequest } from "../gui/src/lib/run-sheet";
import { Rpc, RpcError } from "../gui/src/lib/rpc";
import { Socket } from "./helpers/gui-socket";
import type { RunResult } from "../src/server/protocol";

const req: RunRequest = { path: "/tmp/project", models: ["mock:a", "mock:b"], text: "Compare", attachments: [], mode: "default" };
const success: RunResult = { ok: true, model: "mock:a", modelName: "A", sessionId: "s-a", branch: "compare-a", path: "/tmp/project/.claude/worktrees/compare-a" };
const failure: RunResult = { ok: false, model: "mock:b", modelName: "B", error: "Configure this provider first." };

// Let a controller's pending async handler settle without a DOM or server socket.
const tick = () => new Promise<void>((resolve) => queueMicrotask(resolve));

test("a lost reply leaves the run outcome unknown and cannot resend from the sheet", async () => {
    const originalSocket = globalThis.WebSocket;
    globalThis.WebSocket = Socket as unknown as typeof WebSocket;
    Socket.instances = [];
    const rpc = new Rpc(async () => ({ url: "ws://test", token: "test" }));
    try {
        await rpc.connect();
        const ws = Socket.instances[0]!;
        ws.open();
        const c = createRunSheet({
            start: (req, confirmPaid) => rpc.call("runs.start", { path: req.path, models: req.models, text: req.text, confirmPaid }),
            trust: async () => {}, refresh: () => {},
        });
        const started = c.startRun(req);
        expect(ws.sent.map((r) => r.method)).toEqual(["runs.start"]);
        // The server can have accepted this request; its reply never arrives.
        ws.close();
        await tick();
        await tick();
        expect(c.sheet()?.phase).toEqual({ kind: "unknown", message: "Lost connection — some sessions may already be running; check the sidebar before resending" });
        c.confirm();
        await c.decide(req.path, true);
        expect(await c.startRun({ ...req })).toBe(false);
        expect(ws.sent).toHaveLength(1);
        c.close();
        expect(await started).toBe(false);
        expect(c.sheet()).toBeUndefined();
    } finally {
        rpc.close();
        globalThis.WebSocket = originalSocket;
    }
});

test("a pending result sheet prevents duplicate starts across composer remounts", async () => {
    let calls = 0;
    let refreshed = 0;
    const response = Promise.withResolvers<{ results: RunResult[] }>();
    const c = createRunSheet({ start: () => { calls++; return response.promise; }, trust: async () => {}, refresh: () => refreshed++ });
    const started = c.startRun(req);
    c.close(); // A run cannot be dismissed while creating worktrees.
    expect(c.sheet()?.phase.kind).toBe("starting");
    expect(await c.startRun({ ...req })).toBe(false);
    expect(calls).toBe(1);
    response.resolve({ results: [success] });
    await tick();
    expect(refreshed).toBe(1);
    c.close();
    expect(await started).toBe(true);
    expect(c.sheet()).toBeUndefined();
});

test("cancelling a paid confirmation never retries or reports a successful send", async () => {
    const confirmations: boolean[] = [];
    const c = createRunSheet({ start: async (_, confirmed) => { confirmations.push(confirmed); throw new RpcError("Confirm three paid models", "confirm_paid"); }, trust: async () => {}, refresh: () => {} });
    const started = c.startRun(req);
    await tick();
    expect(c.sheet()?.phase.kind).toBe("confirm");
    c.close();
    c.confirm(); // A stale button event cannot restart the cancelled request.
    expect(await started).toBe(false);
    expect(confirmations).toEqual([false]);
});

test("accepting paid confirmation retries once and partial success clears the submitted draft", async () => {
    const confirmations: boolean[] = [];
    const c = createRunSheet({ start: async (_, confirmed) => {
        confirmations.push(confirmed);
        if (!confirmed) throw new RpcError("Confirm paid models", "confirm_paid");
        return { results: [success, failure] };
    }, trust: async () => {}, refresh: () => {} });
    const started = c.startRun(req);
    await tick();
    c.confirm();
    c.confirm();
    await tick();
    expect(confirmations).toEqual([false, true]);
    expect(c.sheet()?.phase).toEqual({ kind: "done", results: [success, failure] });
    c.close();
    expect(await started).toBe(true);
});

test("an all-failed run preserves its draft and project trust is never implicit", async () => {
    const decisions: [string, boolean][] = [];
    let attempts = 0;
    const c = createRunSheet({ start: async () => {
        attempts++;
        if (attempts === 1) throw new RpcError("Trust project", "needs_project_trust", "/tmp/project");
        return { results: [failure] };
    }, trust: async (folder, trust) => { decisions.push([folder, trust]); }, refresh: () => {} });
    const started = c.startRun(req);
    await tick();
    expect(c.sheet()?.phase).toEqual({ kind: "trust", folder: "/tmp/project", message: "Trust project", project: true });
    expect(decisions).toEqual([]);
    await c.decide("/tmp/project", false);
    expect(decisions).toEqual([["/tmp/project", false]]);
    expect(attempts).toBe(2);
    c.close();
    expect(await started).toBe(false);
});

test("paid confirmation retains every authoritative server model and price", async () => {
    // The server may have refreshed providers since the GUI cached its model list.
    const message = "This starts 3 models billed per token through an API key: A ($3/$15 per million tokens), Renamed B ($2/$8 per million tokens), Newly listed C (price unknown). Confirm to go ahead.";
    const c = createRunSheet({ start: async () => { throw new RpcError(message, "confirm_paid"); }, trust: async () => {}, refresh: () => {} });
    const started = c.startRun({ ...req, models: ["mock:a", "mock:b", "mock:c"] });
    await tick();
    expect(c.sheet()?.phase).toEqual({ kind: "confirm", message });
    c.close();
    expect(await started).toBe(false);
});
