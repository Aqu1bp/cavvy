import assert from "node:assert/strict";
import { createRoot } from "../../gui/node_modules/solid-js/dist/solid.js";
import { Socket } from "../helpers/gui-socket";

// Only browser surfaces touched by preferences, visibility and change watchers.
Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), {
        hidden: false,
        visibilityState: "visible",
        documentElement: { dataset: {}, style: { setProperty() {} } },
    }),
});

const { start, rpc, openSession, toasts, dismissToast } = await import("../../gui/src/state/app");
const { useChanges, useGitChanges } = await import("../../gui/src/state/changes");
const snapshot = { seq: 0, state: { id: "session", cwd: "/project", filesChanged: 1, busy: false }, turns: [], agents: [] };
const changes = { files: [{ path: "file.ts", added: 1, removed: 0 }], added: 1, removed: 0, tracked: true };
const gitChanges = { ...changes, repo: true, scope: "uncommitted", bases: [], more: 0 };
let loaded = false;
let reconnecting = false;
let releaseHello: (() => void) | undefined;
let premature = 0;
let reads = 0;
let opens = 0;

class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "hello") {
            if (reconnecting) releaseHello = () => reply({});
            else reply({});
        } else if (["sessions.list", "projects.recent", "providers.list", "models.list"].includes(method)) {
            reply([]);
        } else if (method === "settings.get") {
            reply({});
        } else if (method === "session.open") {
            loaded = true;
            opens++;
            reply(structuredClone(snapshot));
        } else if (method === "session.changes" || method === "session.gitChanges") {
            reads++;
            if (!loaded) {
                premature++;
                queueMicrotask(() => this.message({ id, error: { code: "not_open", message: "Session is not open" } }));
            } else reply(method === "session.changes" ? changes : gitChanges);
        } else {
            throw new Error(`Unexpected RPC: ${method}`);
        }
    }
}

globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
let dispose: (() => void) | undefined;

try {
    start();
    await settle();
    Socket.instances[0]!.open();
    await settle();
    const handle = await openSession("session");
    const [harness, git] = createRoot((cleanup) => {
        dispose = cleanup;
        return [useChanges(() => handle)[0], useGitChanges(() => handle)[0]] as const;
    });
    await settle();
    assert.deepEqual(harness(), changes);
    assert.deepEqual(git(), gitChanges);
    assert.equal(reads, 2);

    Socket.instances[0]!.close();
    // Simulate the server unloading an idle session during a long disconnect.
    loaded = false;
    reconnecting = true;
    rpc.reconnectNow();
    await settle();
    Socket.instances[1]!.open();
    await settle();
    assert.ok(releaseHello, "hold startup before session.open has run");
    assert.equal(premature, 0, "connection open must not refetch an unloaded session");
    assert.equal(reads, 2);
    assert.deepEqual(harness(), changes);
    assert.deepEqual(git(), gitChanges);

    releaseHello();
    await settle();
    assert.equal(opens, 2, "start() reopens the same handle after its startup refreshes");
    assert.equal(reads, 2, "an unchanged snapshot keeps the existing resource results");
    assert.deepEqual(harness(), changes);
    assert.deepEqual(git(), gitChanges);

    handle.set("state", "filesChanged", 2);
    await settle();
    assert.equal(reads, 4, "edits still refresh both resources");
    handle.set("state", "busy", true);
    await settle();
    assert.equal(reads, 6);
    handle.set("state", "busy", false);
    await settle();
    assert.equal(reads, 8, "turn completion still refreshes both resources");
} finally {
    dispose?.();
    rpc.close();
    while (toasts.length) dismissToast(toasts[0]!.id);
}
