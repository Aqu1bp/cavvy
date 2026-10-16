import { expect, test } from "bun:test";
import { SessionRequestGate } from "../gui/src/lib/session-request-gate";
import { mergeMcpStatus } from "../gui/src/lib/mcp";

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
