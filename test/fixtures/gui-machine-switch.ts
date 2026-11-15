// Switching between sessions on different machines (gui/src/state/app.ts activate): a desktop window on this computer,
// one session of its own, and a server ("box") with one of its own, listed beside it. Picking box's session opens it
// in the same page, over a connection to box's Cavvy (asked of this computer's: servers.connect), as picking another
// of the window's own would: the page isn't loaded again, and no row leaves the sidebar on the way.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

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
        } else if (method === "settings.get") reply({});
        else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };

const { start, rpc, app, activate, handleFor, upsertSession } = await import("../../gui/src/state/app");
Object.assign(rpc, { credentials: async () => ({ url: "ws://local.test/ws", token: "local-token" }) });
try {
    start();
    await settle();
    await activate("l1");
    await settle();
    // Box's session in the list, as the servers code puts it there (components/OtherMachines.tsx, which a script can't
    // load: it's the page's own, Solid's JSX).
    upsertSession(summary("b1", { status: "running", live: true, machine: "box" }) as never);
    await settle();
    assert.ok(app.sessions.some((s) => s.id === "b1" && s.machine === "box"), "box's session is listed beside the window's own");
    // Every row there is, from here on: none may leave on the way.
    const rows = () => new Set(app.sessions.map((s) => s.id));
    const before = rows();
    let lost: string[] = [];
    const watch = setInterval(() => { for (const id of before) if (!rows().has(id)) lost.push(id); }, 0);

    await activate("b1");
    await settle();
    clearInterval(watch);
    assert.equal(reloads, 0, "switching to another machine's session doesn't load the page again");
    assert.deepEqual(lost, [], "no row left the sidebar");
    assert.equal(app.activeId, "b1");
    assert.deepEqual(opened.filter((o) => o.id === "b1").map((o) => o.url.includes("box")), [true], "opened over a connection to box");
    assert.ok(handleFor("b1"), "box's session has a handle in this page");

    // And back: the window's own, at once (its handle kept), and box's still there for next time.
    lost = [];
    await activate("l1");
    await settle();
    assert.equal(reloads, 0);
    assert.equal(app.activeId, "l1");
    assert.ok(handleFor("b1"), "box's session is kept open, for going back to it");
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
