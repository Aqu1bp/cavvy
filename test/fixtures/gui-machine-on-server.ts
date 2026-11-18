// A window on a server ("box"): its own session listed with box's name, and one of this computer's beside it. New
// session from box's own goes Home in its folder; from this computer's, not opened here yet (its connection being made,
// or this computer unreachable), Home on box in its latest project, not in a folder of this computer's.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

// The servers screen (components/Servers.tsx), which a script can't load (Solid's JSX): a stand-in that notes where
// the window was sent (switchMachine: the machine, the session, the folder).
const switched: unknown[][] = [];
Object.assign(globalThis, { switched });
Bun.plugin({
    name: "servers-screen",
    setup(build) {
        build.onLoad({ filter: /components\/Servers\.tsx$/ }, () => ({ contents: "export const connected = () => {}; export const switchMachine = (...a) => void globalThis.switched.push(a); export const machineCredentials = async () => undefined;", loader: "ts" }));
    },
});
let reloads = 0;
const store = new Map<string, string>();
Object.assign(globalThis, {
    requestAnimationFrame: (f: (t: number) => void) => setTimeout(() => f(performance.now()), 0),
    cancelAnimationFrame: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    location: { reload: () => void reloads++, hash: "", href: "http://test/", search: "" },
    // The desktop app's bridge: a reload counted, anything else a no-op.
    window: Object.assign(new EventTarget(), { cavvyDesktop: new Proxy({ reloadHeld: () => void reloads++ } as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : () => undefined) }) }),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null }),
});

const summary = (id: string, o: object = {}) => ({ id, cwd: "/srv/app", projectName: "app", title: id, createdAt: 1, updatedAt: 1, messages: 1, status: "idle", pinned: false, archived: false, settled: false, live: false, ...o });
const opened: { url: string; id: string }[] = [];
/** Where each lookup by folder or path went (fs.*), and what it was. */
const looked: { url: string; method: string }[] = [];

class ServerSocket extends Socket {
    url: string;
    constructor(url: string) {
        super();
        this.url = String(url);
        queueMicrotask(() => this.open());
    }
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        const onBox = this.url.includes("box");
        if (method === "hello") reply({});
        else if (method === "sessions.list") reply(params?.archived ? [] : onBox ? [summary("b1", { status: "running", live: true })] : [summary("l1")]);
        else if (method === "servers.overview") reply({ machines: [{ name: "box", state: "connected", sessions: [summary("b1", { status: "running", live: true })] }] });
        else if (method === "servers.connect") reply({ status: "connected", url: "ws://box.test/ws", token: "box-token" });
        else if (method === "session.open") {
            opened.push({ url: this.url, id: params.id });
            reply({ seq: 0, epoch: "e", state: { id: params.id, cwd: "/srv/app", busy: false, interactions: [] }, turns: [{ id: `${params.id}-t`, status: "done", startedAt: 1, prompt: { text: "hi" }, blocks: [] }], agents: [] });
        } else if (method === "models.list") reply(onBox ? [{ provider: "boxp", providerName: "Box's", status: "ok", models: [{ ref: "boxp:only-on-box", id: "only-on-box", name: "Only on box", provider: "boxp" }] }] : []);
        else if (method.startsWith("fs.")) {
            looked.push({ url: this.url, method });
            reply(method === "fs.mentions" ? [] : {});
        } else if (method === "settings.get") reply({});
        else if (method === "projects.recent") reply(onBox ? [] : [{ path: "/home/me/web", name: "web", exists: true, trusted: true, needsTrust: [] }]);
        else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };
store.set("cavvy.machine", "box");
const { start, rpc, app, activate, upsertSession, setApp, awayUnopened } = await import("../../gui/src/state/app");
const { newSession } = await import("../../gui/src/state/actions");
const { machine } = await import("../../gui/src/lib/platform");
Object.assign(rpc, { credentials: async () => ({ url: "ws://local.test/ws", token: "local-token" }) });
start();
await settle();
assert.equal(machine, "box");
assert.deepEqual(app.sessions.map((s: any) => [s.id, s.machine]), [["l1", "box"]]);
await activate("l1");
await settle();
assert.equal(awayUnopened("l1"), false, "the window's own session isn't another machine's");
assert.equal(app.homeCwd, "/srv/app");
newSession(app.homeCwd);
await settle();
assert.equal(app.homeCwd, "/srv/app", "a new session from the window's own: in its folder");
assert.deepEqual(switched, []);
// This computer's session (row machine undefined in a window on a server), not opened here.
upsertSession(summary("m1", { cwd: "/Users/me/macproj", machine: undefined }) as never);
setApp({ activeId: "m1", homeCwd: "/Users/me/macproj" });
assert.equal(awayUnopened("m1"), true, "this computer's, not opened here");
newSession(app.homeCwd);
await settle();
assert.notEqual(app.homeCwd, "/Users/me/macproj", "not in a folder of this computer's");
assert.equal(app.homeCwd, "/home/me/web", "in the window's latest project");
assert.deepEqual(switched, [], "and the window stays where it is");
assert.equal(app.activeId, undefined);
process.exit(0);
