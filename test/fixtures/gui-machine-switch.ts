// Switching between sessions on different machines (gui/src/state/app.ts activate): a desktop window on this computer,
// one session of its own, and a server ("box") with one of its own, listed beside it. Picking box's session opens it
// in the same page, over a connection to box's Cavvy (asked of this computer's: servers.connect), as picking another
// of the window's own would: the page isn't loaded again, and no row leaves the sidebar on the way.
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
/** Sessions made (session.create), and messages sent (session.send): where each went. */
const made: { url: string; cwd: string; mode?: string }[] = [];
const sent: { url: string; id: string; text: string }[] = [];
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
        } else if (method === "settings.get") reply(onBox ? { model: "boxp:only-on-box" } : {});
        else if (method === "projects.recent") reply(onBox ? [{ path: "/srv/app", name: "app", exists: true, trusted: true, needsTrust: [] }, { path: "/srv/api", name: "api", exists: true, trusted: true, needsTrust: [] }] : [{ path: "/home/me/web", name: "web", exists: true, trusted: true, needsTrust: [] }]);
        else if (method === "projects.inspect") reply({ path: params.path, exists: true });
        else if (method === "session.create") {
            made.push({ url: this.url, cwd: params.cwd, mode: params.mode });
            reply({ seq: 0, epoch: "e", state: { id: `made-${made.length}`, cwd: params.cwd, busy: false, interactions: [] }, turns: [], agents: [] });
        } else if (method === "session.send") {
            sent.push({ url: this.url, id: params.id, text: params.text });
            reply(null);
        } else if (method === "session.close" || method === "session.shown") reply(null);
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 30; i++) await new Promise<void>((r) => setImmediate(r)); };

const { start, rpc, app, activate, forgetSession, handleFor, upsertSession, setApp, modelsFor, rpcFor, warmFor, homeOn, homeSettings, machineFor, homeModeOf, homeProjects, homeDraftKey } = await import("../../gui/src/state/app");
const { folderPickerOpen } = await import("../../gui/src/state/ui");
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

    // The pointer on its row: box is connected to then, nothing opened yet; the click has only the session to open.
    warmFor("b1");
    await settle();
    assert.ok(Socket.instances.some((x) => (x as ServerSocket).url.includes("box") && x.readyState === 1), "connected to box as the pointer came to its row");
    assert.equal(opened.filter((o) => o.id === "b1").length, 0, "nothing opened on the way");
    await activate("b1");
    await settle();
    clearInterval(watch);
    assert.equal(reloads, 0, "switching to another machine's session doesn't load the page again");
    assert.deepEqual(lost, [], "no row left the sidebar");
    assert.equal(app.activeId, "b1");
    assert.deepEqual(opened.filter((o) => o.id === "b1").map((o) => o.url.includes("box")), [true], "opened over a connection to box");
    assert.ok(handleFor("b1"), "box's session has a handle in this page");
    // What its composer offers and looks up is box's: its models, the files in its folder, the paths in what it says.
    assert.deepEqual(modelsFor("b1").flatMap((g) => g.models.map((m) => m.ref)), ["boxp:only-on-box"]);
    assert.deepEqual(modelsFor("l1"), app.models);
    await rpcFor("b1").call("fs.mentions", { cwd: "/srv/app", query: "rea" });
    await rpc.call("fs.exists", { sessionId: "b1", paths: ["README.md"] } as never);
    await rpcFor("l1").call("fs.mentions", { cwd: "/srv/app", query: "rea" });
    assert.deepEqual(looked.map((l) => [l.method, l.url.includes("box") ? "box" : "here"]), [["fs.mentions", "box"], ["fs.exists", "box"], ["fs.mentions", "here"]]);

    // And back: the window's own, at once (its handle kept), and box's still there for next time.
    lost = [];
    await activate("l1");
    await settle();
    assert.equal(reloads, 0);
    assert.equal(app.activeId, "l1");
    assert.ok(handleFor("b1"), "box's session is kept open, for going back to it");

    // New session with box's session on screen: Home on box, in its folder, in this window at once (not the window
    // sent there and loaded again, which took 0.2-0.5 s, what was typed meanwhile going astray), nor on this computer
    // in a folder of box's. With the window's own on screen, here.
    const { newSession, setArchived, send } = await import("../../gui/src/state/actions");
    newSession(app.homeCwd);
    assert.deepEqual(switched, [], "a new session from the window's own stays here");
    assert.equal(app.activeId, undefined);
    await activate("b1");
    await settle();
    const looking = looked.length;
    newSession(app.homeCwd);
    // Home, in the same moment: what's typed next goes in its composer.
    assert.equal(app.activeId, undefined, "Home at once");
    assert.equal(app.homeCwd, "/srv/app", "in box's folder");
    assert.equal(homeOn(), "box", "on box");
    await settle();
    assert.deepEqual(switched, [], "the window stays where it is");
    assert.equal(reloads, 0, "and isn't loaded again");
    // What Home offers and looks up is box's: its models, its settings, the files in its folder.
    assert.deepEqual(modelsFor(undefined).flatMap((g) => g.models.map((m) => m.ref)), ["boxp:only-on-box"]);
    assert.equal(homeSettings().model, "boxp:only-on-box");
    await rpcFor(undefined).call("fs.mentions", { cwd: "/srv/app", query: "rea" });
    assert.deepEqual(looked.slice(looking).map((l) => l.url.includes("box")), [true], "Home's lookups go to box");
    // Sent: made on box, in its folder, with box's own permission mode (none picked here), and opened here as box's.
    assert.ok(await send("hello from home"));
    assert.deepEqual(made.map((m) => [m.url.includes("box"), m.cwd, m.mode]), [[true, "/srv/app", undefined]], "made on box");
    assert.equal(app.activeId, "made-1", "and shown");
    assert.deepEqual(sent.map((m) => [m.url.includes("box"), m.id, m.text]), [[true, "made-1", "hello from home"]], "sent to box");
    assert.deepEqual(machineFor("made-1"), { machine: "box" });
    // New session from it: Home on box again. From the window's own: Home here.
    newSession(app.homeCwd);
    assert.equal(homeOn(), "box");
    // Each machine's Home keeps what's picked on it, for the window's life: the permission mode (box's isn't put back
    // to its default by going Home on it again, nor this computer's by box's), and its own draft.
    const { setMode, chooseProject, openProject } = await import("../../gui/src/state/actions");
    await setMode("default");
    assert.equal(homeModeOf(), "default", "Manual picked on box's Home");
    assert.equal(homeDraftKey(), "home@box", "box's Home has its own draft");
    await settle();
    // Box's projects, not this computer's; and its folders to choose from, not this computer's picker.
    assert.deepEqual(homeProjects().map((p) => p.path), ["/srv/app", "/srv/api"], "box's projects");
    void chooseProject(true);
    const looking2 = looked.length;
    await folderPickerOpen()!.link!.call("fs.dirs", { path: "~" });
    assert.deepEqual(looked.slice(looking2).map((l) => l.url.includes("box")), [true], "box's folders");
    folderPickerOpen()!.then(undefined);
    // A project picked there: Home stays on box, in that folder.
    await openProject("/srv/api", true);
    assert.equal(homeOn(), "box", "Home stays on box");
    assert.equal(app.homeCwd, "/srv/api");
    assert.deepEqual(switched, [], "and the window stays here");
    newSession(app.homeCwd);
    assert.equal(homeModeOf(), "default", "box's pick kept after a new session there");
    await activate("l1");
    newSession(app.homeCwd);
    assert.equal(homeOn(), undefined, "Home on this computer");
    assert.equal(homeModeOf(), undefined, "this computer's Home isn't given box's pick");
    assert.equal(homeDraftKey(), "home", "nor its draft");
    assert.deepEqual(homeProjects().map((p) => p.path), ["/home/me/web"], "and lists this computer's projects");
    assert.deepEqual(modelsFor(undefined), app.models);
    await activate("made-1");
    newSession(app.homeCwd);
    assert.equal(homeOn(), "box");
    assert.equal(homeModeOf(), "default", "box's pick kept after a visit to this computer's session");
    await activate("l1");
    newSession(app.homeCwd);
    await activate("b1");
    await settle();
    // One of box's on screen but not opened here (its connection still being made, or box unreachable): Home here, in
    // this computer's latest project, not in a folder of box's (nor the window sent to a box it may not reach).
    upsertSession(summary("b8", { machine: "box", cwd: "/srv/other" }) as never);
    setApp({ activeId: "b8", homeCwd: "/srv/other" });
    newSession(app.homeCwd);
    await settle();
    assert.equal(switched.length, 0, "the window stays here");
    assert.equal(app.activeId, undefined);
    assert.equal(app.homeCwd, "/home/me/web", "in this computer's latest project");
    await activate("b1");
    await settle();
    // Archived while on screen: Home here, in this computer's latest project (box's folder names nothing here).
    assert.ok(await setArchived("b1", true));
    assert.equal(app.activeId, undefined);
    assert.equal(app.homeCwd, "/home/me/web");
    assert.equal(switched.length, 0, "and the window stays where it is");
    // Deleted while on screen (here or in another window): the same.
    await activate("b1");
    assert.equal(app.homeCwd, "/srv/app");
    forgetSession("b1");
    assert.equal(app.activeId, undefined);
    assert.equal(app.homeCwd, "/home/me/web");
} catch (e) {
    console.error(e);
    process.exit(1);
}
process.exit(0);
