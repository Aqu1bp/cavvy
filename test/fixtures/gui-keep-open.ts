// The window keeps few sessions open (state/app.ts trim): one made while the others all work or wait on the user isn't
// the one it closes. Run against the real app store and a fake server by gui-keep-open.test.ts.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

const values = new Map<string, string>();
const storage = { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) };
Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
    sessionStorage: storage,
    localStorage: storage,
    location: { hash: "", search: "", pathname: "/" },
    requestAnimationFrame: (fn: (at: number) => void) => setTimeout(() => fn(performance.now()), 0),
    cancelAnimationFrame: (n: ReturnType<typeof setTimeout>) => clearTimeout(n),
});
const ids = ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8", "s9", "s10"];
const summary = (id: string) => ({ id, title: id, cwd: "/p", projectName: "p", status: "idle", updatedAt: 1, createdAt: 1 });
/** A session that works, or waits on the user (a plan to approve): busy. */
const state = (id: string, busy: boolean) => ({ id, cwd: "/p", busy, interactions: [] });
let made = 0;
const closed: string[] = [];
class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "hello") reply({ startCwd: "/p" });
        else if (method === "session.create") reply({ seq: 0, state: state(ids[made++]!, false), turns: [], agents: [] });
        else if (method === "session.close") closed.push(params.id), reply(null);
        else if (method === "sessions.list") reply(ids.map(summary));
        else if (method === "settings.get") reply({});
        else if (method === "projects.recent") reply([]);
        else if (["providers.list", "models.list", "limits.get"].includes(method)) reply([]);
        else if (method === "session.shown" || method === "session.send") reply(null);
        else throw Error(`Unexpected RPC: ${method}`);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r)); };

const appState = await import("../../gui/src/state/app");
Object.assign(appState.rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
appState.start();
await settle();
Socket.instances.at(-1)!.open();
await settle();

// "New session", a prompt, Enter: each one then waits on the user (its plan), and the next is made from the new-session
// screen (nothing in view).
for (let i = 0; i < 9; i++) {
    const h = await appState.createSession("/p");
    await settle();
    assert.ok(appState.handleFor(h.id), `${h.id}, just made, is open`);
    assert.ok(!closed.includes(h.id), `${h.id}, just made, isn't closed`);
    h.set("state", "busy", true);
}
// The window still keeps few: with all nine waiting, none is closed (each would lose what it's showing).
assert.deepEqual(closed, []);
// One done: the next made closes it, the oldest not working, and not the new one.
appState.handleFor("s1")!.set("state", "busy", false);
const tenth = await appState.createSession("/p");
await settle();
assert.equal(tenth.id, "s10");
assert.deepEqual(closed, ["s1"]);
process.exit(0);
