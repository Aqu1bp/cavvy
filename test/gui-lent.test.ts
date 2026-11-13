// A session on a server that uses this computer's Simulator, in a window on that server (gui/src/lib/lent.ts,
// lent-stream.ts): the pane speaks of the session it shows, this computer's Cavvy of its own session for it, and
// none of it is in the window unless it's on a server.

import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { lentStream } from "../gui/src/lib/lent-stream";

function setup(o: { guest?: string; open?: () => Promise<string | undefined> } = {}) {
    const sent: [string, string, unknown][] = [];
    let frame: ((f: any) => void) | undefined;
    let guest = o.guest;
    const none: [string, string | undefined][] = [];
    let opened = 0;
    const stream = lentStream(
        {
            state: "open",
            connect: async () => {},
            close: () => {},
            onState: () => () => {},
            onEvent: () => () => {},
            onSimulatorFrame: (fn: (f: any) => void) => ((frame = fn), () => {}),
            notify: (method: string, params: unknown) => void sent.push(["notify", method, params]),
            call: async (method: string, params: unknown) => (sent.push(["call", method, params]), { status: "off", devices: [] }),
        } as never,
        {
            session: () => "there",
            guest: () => guest,
            open: async () => {
                opened++;
                guest = await (o.open ?? (async () => "here"))();
                return guest;
            },
            none: (session, state) => void none.push([session, state.error]),
        },
    );
    return { stream, sent, none, frame: (f: object) => frame!(f), opened: () => opened };
}

test("what the pane asks of the session it shows is asked of this computer's session for it, and its pictures come back as that session's", async () => {
    const { stream, sent, frame, opened } = setup({ guest: "here" });
    await stream.call("simulator.watch", { id: "there", side: 800 });
    stream.notify("simulator.input", { id: "there", input: { kind: "button", name: "home" } });
    expect(sent).toEqual([
        ["call", "simulator.watch", { id: "here", side: 800 }],
        ["notify", "simulator.input", { id: "here", input: { kind: "button", name: "home" } }],
    ]);
    expect(opened()).toBe(0);
    const got: any[] = [];
    stream.onSimulatorFrame((f) => void got.push(f));
    frame({ sessionId: "here", frameId: "f1", width: 2, height: 2, data: new Uint8Array(1) });
    // Another session's pictures aren't this pane's.
    frame({ sessionId: "other", frameId: "f2", width: 2, height: 2, data: new Uint8Array(1) });
    expect(got.map((f) => [f.sessionId, f.frameId])).toEqual([["there", "f1"]]);
});

test("a pane opened before the session's agent used the simulator has this computer make one, once it asks for something; leaving asks for nothing", async () => {
    const { stream, sent, opened } = setup();
    // Input with nothing to send it to goes nowhere, and a pane that goes away makes nothing.
    stream.notify("simulator.ack", { id: "there", frameId: "f" });
    expect(await stream.call("simulator.unwatch", { id: "there" })).toBeNull();
    expect([sent.length, opened()]).toEqual([0, 0]);
    await stream.call("simulator.watch", { id: "there" });
    await stream.call("simulator.command", { id: "there", command: "boot", udid: "AAAA" });
    expect(opened()).toBe(1);
    expect(sent.map((x) => [x[1], (x[2] as { id: string }).id])).toEqual([["simulator.watch", "here"], ["simulator.command", "here"]]);
});

test("when this computer has none to lend, the pane is told so, not left waiting", async () => {
    const off = setup({ open: async () => undefined });
    expect(await off.stream.call("simulator.watch", { id: "there" })).toEqual({ status: "unavailable", error: "This Mac's Simulator is turned off.", devices: [] });
    expect(off.none).toEqual([["there", "This Mac's Simulator is turned off."]]);
    expect(off.sent).toEqual([]);
    const full = setup({ open: async () => Promise.reject(new Error("This Mac's Simulator is already in use by 30 sessions on box.")) });
    await expect(full.stream.call("simulator.watch", { id: "there" })).rejects.toThrow("already in use");
    expect(full.none).toEqual([["there", "This Mac's Simulator is already in use by 30 sessions on box."]]);
});

test("it's part of the servers code: the window's own code only leaves room for it, and answers go to this computer only for its own sessions", () => {
    const read = (f: string) => readFileSync(new URL(`../gui/src/${f}`, import.meta.url), "utf8");
    expect(read("components/Servers.tsx")).toContain('import "../lib/lent";');
    for (const f of ["state/simulator.ts", "state/actions.ts", "components/Composer.tsx", "components/SimulatorPane.tsx"]) expect(read(f)).not.toContain("lib/lent\"");
    // An answer goes to this computer's Cavvy only for a session this computer said is its own; any other goes
    // where the window's sessions are.
    expect(read("state/actions.ts")).toContain('(far.rpc?.(id) ?? rpc).call("session.respond"');
    expect(read("lib/lent.ts")).toContain("far.rpc = (id) => (sessionOf.has(id) ? h : undefined);");
});
