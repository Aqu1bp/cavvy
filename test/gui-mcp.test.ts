import { expect, test } from "bun:test";
import { SessionRequestGate } from "../gui/src/lib/session-request-gate";
import { mergeMcpStatus } from "../gui/src/lib/mcp";
import { componentCode } from "./gui-component-harness";

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

test("late dialog responses cannot replace another session or a later opening", async () => {
    let active = "A";
    let shown = "";
    const gate = new SessionRequestGate(() => active);
    const request = async (response: Promise<string>) => {
        const captured = gate.capture()!;
        const result = await response;
        if (captured.current()) shown = result;
    };
    gate.open("A");
    const old = deferred<string>();
    const a = request(old.promise);
    active = "B";
    gate.open("B");
    await request(Promise.resolve("B's servers"));
    old.resolve("A's servers");
    await a;
    expect(shown).toBe("B's servers");

    const earlier = deferred<string>();
    const b = request(earlier.promise);
    gate.open();
    gate.open("B");
    await request(Promise.resolve("B reopened"));
    earlier.resolve("B's obsolete response");
    await b;
    expect(shown).toBe("B reopened");
});

test("a session switch invalidates requests before the dialog's close effect runs", () => {
    let active = "A";
    const gate = new SessionRequestGate(() => active);
    gate.open("A");
    const request = gate.capture()!;
    active = "B";
    expect(request.current()).toBe(false);
    expect(gate.capture()).toBeUndefined();
    gate.open();
    active = "A";
    expect(request.current()).toBe(false);
});

test("a connected server's live tool warning reaches the dialog and clears when resolved", () => {
    const server = { name: "srv", label: "srv", source: "project" as const, transport: "http" as const, status: "connecting" as const, tools: 0 };
    const live = { name: "srv", status: "connected" as const, tools: 2, error: "1 tool was hidden because its name contains a configured secret." };
    const merged = mergeMcpStatus(server, live);
    expect(merged.error).toBe(live.error);
    expect(mergeMcpStatus(merged, { ...live, error: undefined }).error).toBeUndefined();
});

test("live failed status preserves the detail response's multiline error", () => {
    const error = "server is not running\n[REDACTED env TOKEN]\nfixture told to fail";
    const server = { name: "srv", label: "srv", source: "project" as const, transport: "stdio" as const, status: "failed" as const, tools: 0, error };
    expect(mergeMcpStatus(server, { name: "srv", status: "failed", tools: 0, error: "server is not running" }).error).toBe(error);
});

function dialogHandlers() {
    const app = { activeId: "A" };
    let opened: { focus?: string } | undefined;
    const effects: (() => any)[] = [];
    const calls: { method: string; params: any; response: ReturnType<typeof deferred<any>> }[] = [];
    const trustRequests: any[][] = [];
    const notices: unknown[] = [];
    const McpDialog = componentCode("McpDialog", {
        app, SessionRequestGate, mergeMcpStatus,
        createSignal: (initial: unknown) => {
            let value = initial;
            return [() => value, (next: any) => { value = typeof next === "function" ? next(value) : next; }];
        },
        createMemo: (read: () => unknown) => read,
        createEffect: (effect: () => unknown) => effects.push(effect),
        on: (read: () => unknown, run: (value: unknown) => unknown) => () => run(read()),
        mcpOpen: () => opened,
        setMcpOpen: (value: typeof opened) => { opened = value; },
        handleFor: () => ({ view: { state: { cwd: "/project", mcp: [] } } }),
        rpc: { call: (method: string, params: unknown) => {
            const response = deferred<any>();
            calls.push({ method, params, response });
            return response.promise;
        } },
        requestTrust: (...args: any[]) => trustRequests.push(args),
        reportError: (error: unknown) => notices.push(error),
        toast: (message: unknown) => notices.push(message),
    }, ["list", "full", "busy", "approve", "revoke", "trust", "setChosen"]);
    const handlers = McpDialog();
    return {
        ...handlers, calls, trustRequests, notices,
        open: (id: string) => { app.activeId = id; opened = {}; effects[0]!(); },
        detail: () => effects[3]!(),
    };
}

const flushResponses = async () => { await Promise.resolve(); await Promise.resolve(); };
const emptyList = (meaning: string) => ({ servers: [], meaning });

test("McpDialog wires its list and action responses to the captured opening", async () => {
    const d = dialogHandlers();
    d.open("A");
    d.open("B");
    expect(d.calls.map((call: any) => call.params.id)).toEqual(["A", "B"]);
    d.calls[1]!.response.resolve(emptyList("B"));
    await flushResponses();
    d.calls[0]!.response.resolve(emptyList("A"));
    await flushResponses();
    expect(d.list().meaning).toBe("B");

    const oldAction = d.revoke({ name: "srv" });
    d.open("B"); // Even the same session's next opening must reject old responses.
    d.calls[3]!.response.resolve(emptyList("B reopened"));
    await flushResponses();
    const newAction = d.approve({ name: "srv", fingerprint: "new", label: "srv" });
    d.calls[2]!.response.resolve(emptyList("old revoke"));
    await oldAction;
    expect(d.list().meaning).toBe("B reopened");
    expect(d.busy()).toBe(true);
    d.calls[4]!.response.resolve({ list: emptyList("new approval"), approved: true });
    await newAction;
    expect(d.list().meaning).toBe("new approval");
    expect(d.busy()).toBe(false);

    const lateApproval = d.approve({ name: "srv", fingerprint: "old", label: "srv" });
    d.open("C");
    d.calls[6]!.response.resolve(emptyList("C"));
    await flushResponses();
    d.calls[5]!.response.resolve({ list: emptyList("old approval"), approved: false });
    await lateApproval;
    expect(d.list().meaning).toBe("C");
    expect(d.notices).toEqual([]);
});

test("McpDialog discards late details and requests the cancel-only MCP trust flow", async () => {
    const d = dialogHandlers();
    d.open("A");
    d.calls[0]!.response.resolve({ servers: [{ name: "srv", partial: true }] });
    await flushResponses();
    d.setChosen("srv");
    const detail = d.detail();
    expect(d.calls[1]!.params).toEqual({ id: "A", name: "srv" });
    d.trust();
    expect(d.trustRequests[0]![0]).toBe("/project");
    expect(d.trustRequests[0]![2]).toBe("mcp-approval");
    d.open("B");
    d.calls[2]!.response.resolve(emptyList("B"));
    await flushResponses();
    d.calls[1]!.response.resolve({ servers: [{ name: "srv", command: "old" }] });
    await detail;
    expect(d.full()).toBeUndefined();
    d.trustRequests[0]![1]();
    expect(d.calls).toHaveLength(3); // A late trust completion must not reload B.
});
