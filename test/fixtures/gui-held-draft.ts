// A session not shown with a message handed back to its box that no box has taken yet (a steer held while a command
// was typed, or one returned to a session in the background) stays open when others are opened: closing it would lose it.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: { hash: "", search: "", pathname: "/" },
});
const closed: string[] = [];
class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        if (method === "session.close") closed.push(params.id);
        const result = method === "session.open" ? { seq: 0, state: { id: params.id, cwd: "/" + params.id, busy: false, interactions: [] }, turns: [], agents: [] } : method === "hello" || method === "settings.get" ? {} : method === "session.close" ? null : [];
        queueMicrotask(() => this.message({ id, result }));
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = () => new Promise<void>((r) => setImmediate(r));
const appModule = await import("../../gui/src/state/app");
const { activate, handleFor, rpc } = appModule;
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
appModule.start();
await settle();
Socket.instances.at(-1)!.open();
await settle();
await settle();
await activate("held");
await settle();
Socket.instances.at(-1)!.message({ event: { type: "draft", sessionId: "held", text: "and then deploy", after: true } });
await settle();
for (let i = 0; i < 10; i++) {
    await activate(`s${i}`);
    await settle();
}
assert.deepEqual(handleFor("held")?.draft(), { text: "and then deploy", images: undefined, files: undefined, after: true }, "its handed-back message is still waiting for its box");
assert.ok(!closed.includes("held"), "it wasn't closed");
assert.ok(closed.length > 0, "others were");
process.exit(0);
