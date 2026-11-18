// Another machine's session opened in this window (gui/src/state/app.ts activate) when things go wrong: the machine
// can't be reached (pointed at, then clicked; clicked, then clicked again), a click overtaken by another, a drop with
// a reconnect that fails once, events of the kind that machine has no business sending this window, a fork made
// there, and (MODE=reload) the window loaded again while that session was the one on screen.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

const mode = process.env.MODE ?? "main";
let reloads = 0;
const store = new Map<string, string>();
// Loaded again while box's session was on screen: what the window kept of where it was.
if (mode === "reload") store.set("cavvy.navigation", JSON.stringify({ activeId: "b1", homeCwd: "/srv/app", on: "box" }));
// A window on box, on a Mac that lends box's sessions its simulators: one of this computer's sessions opened in it.
if (mode === "lent") {
    store.set("cavvy.machine", "box");
    // A window on a server loads the servers screen (components/Servers.tsx), which a script can't (Solid's JSX): a
    // stand-in that does nothing.
    Bun.plugin({
        name: "servers-screen",
        setup(build) {
            build.onLoad({ filter: /components\/Servers\.tsx$/ }, () => ({ contents: "export const connected = () => {}; export const switchMachine = () => {}; export const machineCredentials = async () => undefined;", loader: "ts" }));
        },
    });
}
Object.assign(globalThis, {
    requestAnimationFrame: (f: (t: number) => void) => setTimeout(() => f(performance.now()), 0),
    cancelAnimationFrame: (t: ReturnType<typeof setTimeout>) => clearTimeout(t),
    sessionStorage: { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) },
    location: { reload: () => void reloads++, hash: "", href: "http://test/", search: "" },
    window: Object.assign(new EventTarget(), { cavvyDesktop: new Proxy({ reloadHeld: () => void reloads++, sidecarInfo: async () => ({ port: 1, token: "local-token" }) } as Record<string, unknown>, { get: (t, k) => (typeof k === "string" && k in t ? t[k] : () => undefined) }) }),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } }, querySelector: () => null }),
});

const summary = (id: string, o: object = {}) => ({ id, cwd: "/srv/app", projectName: "app", title: id, createdAt: 1, updatedAt: 1, messages: 1, status: "idle", pinned: false, archived: false, settled: false, live: false, ...o });
const snapshot = (id: string) => ({ seq: 0, epoch: "e", state: { id, cwd: "/srv/app", busy: false, interactions: [] }, turns: [{ id: `${id}-t`, status: "done", startedAt: 1, prompt: { text: "hi" }, blocks: [] }], agents: [] });

/** What box's Cavvy can be asked for: reached, or why not; a held answer waits for `release`. */
let reach: "ok" | "failed" | "hold" = "ok";
let release: (() => void) | undefined;
/** Box's next connection is refused before it opens (a sign-in it no longer takes). */
let refuseNext = false;
/** Every call, by where it went. */
const calls: { on: "box" | "here"; method: string; params: any }[] = [];
const boxSockets = () => Socket.instances.filter((s) => (s as ServerSocket).url.includes("box")) as ServerSocket[];

class ServerSocket extends Socket {
    url: string;
    constructor(url: string) {
        super();
        this.url = String(url);
        if (this.url.includes("box") && refuseNext) {
            refuseNext = false;
            queueMicrotask(() => this.close());
        } else queueMicrotask(() => this.open());
    }
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        const fail = (message: string, code: string) => queueMicrotask(() => this.message({ id, error: { message, code } }));
        const onBox = this.url.includes("box");
        calls.push({ on: onBox ? "box" : "here", method, params });
        if (method === "hello") reply({});
        else if (method === "sessions.list") reply(params?.archived ? [] : onBox ? [summary("b1")] : [summary("l1")]);
        else if (method === "servers.connect") {
            const answer = () => reply(reach === "failed" ? { status: "failed", problem: { message: "Can't reach box.example." } } : { status: "connected", url: "ws://box.test/ws", token: "box-token" });
            if (reach === "hold") release = answer;
            else answer();
        } else if (method === "session.open") {
            if (!onBox && params.id !== "l1") return fail("No such session", "not_found");
            reply(snapshot(params.id));
        } else if (method === "session.fork") reply(snapshot("f1"));
        // Box has no simulators, and only its own sessions; this computer (a Mac) has one.
        else if (method === "simulator.state") {
            if (onBox) return params.id.startsWith("b") ? reply({ status: "unavailable", devices: [] }) : fail("That session isn't open", "not_open");
            reply({ status: "stopped", devices: [{ udid: "u", name: "iPhone" }] });
        } else if (method === "offers.session") reply({ offered: true, asks: [] });
        else if (method === "offers.asking") reply([]);
        else if (method === "models.list") reply([]);
        else if (method === "settings.get") reply({});
        else reply(null);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };
const until = async (what: string, ok: () => boolean, ms = 5000) => {
    const end = Date.now() + ms;
    while (!ok()) {
        if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
        await new Promise((r) => setTimeout(r, 20));
    }
};
/** An event from box's Cavvy, as it would send it. */
const fromBox = (event: unknown) => boxSockets().filter((s) => s.readyState === 1).forEach((s) => s.message({ event }));

const { start, rpc, app, activate, handleFor, upsertSession, warmFor, connFor, forkSession, toasts, problemFor } = await import("../../gui/src/state/app");
const { sessionReadReady } = await import("../../gui/src/state/changes");
const connects = () => calls.filter((c) => c.method === "servers.connect");
Object.assign(rpc, { credentials: async () => ({ url: "ws://local.test/ws", token: "local-token" }) });
const listBox = () => upsertSession(summary("b1", { machine: "box" }) as never);

try {
    if (mode === "lent") {
        Object.assign(rpc, { credentials: async () => ({ url: "ws://box.test/ws", token: "box-token" }) });
        const { Rpc } = await import("../../gui/src/lib/rpc");
        await import("../../gui/src/lib/lent");
        const { sim, loadSimulatorState } = await import("../../gui/src/state/simulator");
        const lentTo = (id: string) => !(sim.stream(() => id) instanceof Rpc);
        start();
        await settle();
        await activate("b1");
        await settle();
        assert.ok(lentTo("b1"), "box's session borrows this computer's simulator");
        // This computer's session, opened in the window on box, with the side panel open (its simulator looked at).
        upsertSession(summary("l1") as never);
        await activate("l1");
        await settle();
        await loadSimulatorState("l1").catch(() => undefined);
        await activate("b1");
        await settle();
        // What this computer said of its own session isn't taken for box having simulators.
        assert.ok(lentTo("b1"), "box's session still borrows this computer's simulator");
        process.exit(0);
    }
    if (mode === "reload") {
        start();
        // Box's rows come later than the window's own (the servers code lists them): it's opened from box all the same.
        await settle();
        await until("box's session to open", () => app.activeId === "b1" && Boolean(handleFor("b1")));
        assert.ok(!calls.some((c) => c.on === "here" && c.method === "session.open" && c.params.id === "b1"), "not asked of this computer");
        assert.equal(reloads, 0);
        process.exit(0);
    }
    start();
    await settle();
    await activate("l1");
    await settle();
    listBox();
    await settle();

    // Pointed at while box can't be reached: asked as a connection trying again by itself (a server stopped on purpose
    // stays stopped), as the window's own link to box (this computer's Cavvy doesn't take the window to be on box),
    // and not kept trying.
    reach = "failed";
    warmFor("b1");
    await settle();
    const asked = calls.filter((c) => c.method === "servers.connect");
    assert.deepEqual(asked.map((c) => c.params), [{ name: "box", link: true, retry: true }]);
    // Let go of: not asked again by itself (a link kept for it would try every few seconds).
    await new Promise((r) => setTimeout(r, 1200));
    assert.equal(connects().length, 1, "a machine only pointed at isn't kept trying");
    // Then clicked, once box can be: it opens (it was hung for good, the failed connection kept).
    reach = "ok";
    await activate("b1");
    await settle();
    assert.equal(app.activeId, "b1");
    assert.ok(handleFor("b1"), "opened after a failed attempt");
    assert.equal(reloads, 0);
    await activate("l1");
    await settle();

    // Dropped, and the first try to reconnect fails: shown not connected meanwhile, back by itself after.
    reach = "failed";
    for (const s of boxSockets()) if (s.readyState === 1) s.close();
    await settle();
    assert.notEqual(connFor("b1"), "open", "box's session shows its own connection down");
    assert.equal(connFor("l1"), "open");
    assert.equal(handleFor("b1")!.ready(), false);
    assert.equal(sessionReadReady(handleFor("b1")!), false, "its Changes wait for its connection");
    await until("a try to reconnect", () => calls.filter((c) => c.method === "servers.connect").length > asked.length + 1);
    assert.match(problemFor("b1")?.message ?? "", /Couldn't reach box/, "the banner says why");
    reach = "ok";
    await until("box's session back", () => handleFor("b1")!.ready() && connFor("b1") === "open", 15_000);
    assert.equal(problemFor("b1"), undefined);
    // A sign-in box no longer takes: the next one asked for is a new one (renew).
    refuseNext = true;
    for (const s of boxSockets()) if (s.readyState === 1) s.close();
    await until("box's session back after a refused sign-in", () => handleFor("b1")!.ready() && connFor("b1") === "open", 15_000);
    assert.ok(connects().some((c) => c.params.renew === true), "a new sign-in asked for after one opened nothing");

    // This computer's connection down, box's up: box's session's Changes go on.
    for (const s of Socket.instances as ServerSocket[]) if (!s.url.includes("box") && s.readyState === 1) s.close();
    await settle();
    assert.notEqual(app.conn, "open");
    assert.equal(sessionReadReady(handleFor("b1")!), true, "its Changes follow its own connection");
    rpc.reconnectNow();
    await until("this computer's connection back", () => app.conn === "open");
    await settle();

    // Its browser's state is box's: asked of box, and what box says of it is heard where the window's own is.
    const heardHere: string[] = [];
    rpc.onEvent((e) => { if (e.type === "browser.state") heardHere.push(e.sessionId); });
    fromBox({ type: "browser.state", sessionId: "b1", state: { tabs: [] } });
    await settle();
    assert.deepEqual(heardHere, ["b1"]);
    await rpc.call("browser.state", { id: "b1" } as never);
    assert.equal(calls.filter((c) => c.method === "browser.state").at(-1)!.on, "box");

    // Box says what isn't its to say: a row for this computer, one of this computer's gone, a toast, a notification
    // this computer's Cavvy says itself. None of it lands. What's of its session does.
    const rows = app.sessions.length;
    const toastsBefore = toasts.length;
    fromBox({ type: "sessions.upsert", sessionId: "b1", session: summary("fake") });
    fromBox({ type: "sessions.remove", sessionId: "b1", id: "l1" });
    fromBox({ type: "toast", sessionId: "b1", message: "from box", level: "info" });
    await settle();
    assert.equal(app.sessions.length, rows);
    assert.ok(app.sessions.some((s) => s.id === "l1") && !app.sessions.some((s) => s.id === "fake"));
    assert.equal(toasts.length, toastsBefore);
    fromBox({ type: "session.ops", sessionId: "b1", seq: 1, ops: [{ op: "state", patch: { title: "from box" } }] });
    await settle();
    await until("box's op applied", () => handleFor("b1")!.view.state.title === "from box");

    // An account's id that happens to be a session's isn't a session's: asked of this computer.
    await rpc.call("accounts.setDefault", { provider: "claude", id: "b1" } as never);
    assert.equal(calls.filter((c) => c.method === "accounts.setDefault").at(-1)!.on, "here");

    // Not on screen any more: box is told none of its sessions is.
    await activate("b1");
    await settle();
    await activate("l1");
    await settle();
    assert.deepEqual(calls.filter((c) => c.on === "box" && c.method === "session.shown").at(-1)!.params, {});

    // A fork made on box is box's: what's asked of it goes there.
    await forkSession("b1", { index: 0, text: "hi", turn: "b1-t" });
    await settle();
    assert.equal(app.activeId, "f1");
    await settle();
    // Where the window was is kept with its machine: loaded again, the fork is opened from box (MODE=reload).
    assert.equal(JSON.parse(store.get("cavvy.navigation")!).on, "box");
    await rpc.call("session.interrupt", { id: "f1" });
    assert.equal(calls.filter((c) => c.method === "session.interrupt").at(-1)!.on, "box");

    // Clicked while box can't be reached: said why. Clicked again once it can: it opens.
    await activate("l1");
    await settle();
    const other = "b2";
    upsertSession(summary(other, { machine: "box" }) as never);
    for (const s of boxSockets()) if (s.readyState === 1) s.close();
    reach = "failed";
    await settle();
    await activate(other);
    await settle();
    assert.equal(app.activeId, other);
    assert.match(app.opening?.error ?? "", /Couldn't reach box: Can't reach box\.example\./);
    reach = "ok";
    await activate(other);
    await settle();
    assert.ok(handleFor(other), "opened on the second click");
    assert.equal(app.opening, undefined);

    // Clicked while box's connection waits to try again (a few tries failed, the next seconds away): tried now.
    await activate("l1");
    await settle();
    upsertSession(summary("b4", { machine: "box" }) as never);
    reach = "failed";
    for (const s of boxSockets()) if (s.readyState === 1) s.close();
    const failedBefore = connects().length;
    await until("a few tries to reconnect", () => connects().length >= failedBefore + 3, 15_000);
    reach = "ok";
    const clicked = Date.now();
    await activate("b4");
    await settle();
    assert.ok(handleFor("b4"), "opened");
    assert.ok(Date.now() - clicked < 800, `opened at once, not after the wait (${Date.now() - clicked} ms)`);

    // Overtaken: a click on box's session while box is being reached, then another session picked. The first is
    // shown as picked at once, and the second stays.
    await activate("l1");
    await settle();
    upsertSession(summary("b3", { machine: "box" }) as never);
    for (const s of boxSockets()) if (s.readyState === 1) s.close();
    reach = "hold";
    await settle();
    const first = activate("b3");
    await settle();
    assert.equal(app.activeId, "b3", "picked at once");
    await activate("l1");
    reach = "ok";
    release?.();
    await first;
    await settle();
    assert.equal(app.activeId, "l1", "the later pick stays");
    assert.equal(reloads, 0);
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
