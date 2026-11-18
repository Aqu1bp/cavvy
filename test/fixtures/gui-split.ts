// Two sessions side by side (gui/src/state/split.ts), run against the real app store and a fake server (by
// gui-split.test.ts): what a drop does, where focus goes, what each session keeps in the side panel, and what ends it.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";

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
const summary = (id: string, machine?: string) => ({ id, title: id, cwd: `/${id}`, projectName: id, status: "idle", updatedAt: 1, createdAt: 1, ...(machine ? { machine } : {}) });
const more = ["d", "e", "f", "g", "h", "i", "j", "k", "l", "m"];
const sessions = [summary("a"), summary("b"), summary("c"), summary("far", "server"), ...more.map((id) => summary(id)), summary("broken"), summary("gone")];
/** Opens answered only when let go (fails), with an error. */
const held = new Map<string, (error: { message: string; code: string }) => void>();
class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "hello") reply({ startCwd: "/startup" });
        else if (method === "session.open" && (params.id === "broken" || params.id === "gone")) held.set(params.id, (error) => this.message({ id, error }));
        else if (method === "session.open") reply({ seq: 0, state: { id: params.id, cwd: `/${params.id}`, busy: false, interactions: [] }, turns: [], agents: [] });
        else if (method === "sessions.list") reply(sessions);
        else if (method === "settings.get") reply({});
        else if (method === "projects.recent") reply([]);
        else if (["providers.list", "models.list", "limits.get"].includes(method)) reply([]);
        else if (method === "session.delete" || method === "session.close") reply({});
        else throw Error(`Unexpected RPC: ${method}`);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = async () => { for (let i = 0; i < 4; i++) await new Promise<void>((r) => setImmediate(r)); };

const appState = await import("../../gui/src/state/app");
const ui = await import("../../gui/src/state/ui");
const s = await import("../../gui/src/state/split");
Object.assign(appState.rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
appState.start();
await settle();
Socket.instances.at(-1)!.open();
await settle();
assert.equal(appState.app.sessionsLoaded, true);

// What App.tsx does as the session in view changes.
solid.createRoot(() => {
    let seen = false;
    solid.createEffect(solid.on(() => appState.app.activeId, (to, from) => {
        if (!seen) return void (seen = true);
        if (s.focusMoved(from, to)) return;
        ui.setAgentFocus(undefined);
        ui.setReview(undefined);
    }));
    solid.createEffect(() => s.prune());
});

// Nothing in view: nothing to drop beside.
assert.equal(s.canDrop("a"), false);
await appState.activate("a");
await settle();
// One in view: any other can come beside it, on whichever machine (opened over its own connection); not itself.
assert.equal(s.canDrop("b"), true);
assert.equal(s.canDrop("a"), false);
assert.equal(s.canDrop("far"), true);

ui.setInspectorPane("commands");
ui.setReview({ path: "a.ts" });
s.dropSession("b", "left");
await settle();
assert.deepEqual(s.split(), { anchor: "a", added: "b", side: "left" });
assert.deepEqual(s.splitIds(), ["b", "a"], "the dropped one goes to the half it was dropped on");
assert.deepEqual(JSON.parse(values.get("cavvy.split")!).on, { a: "", b: "" }, "each one's machine, the window's own too");
// After a reload, a pane's session of another machine opens from that machine, its row maybe not listed yet.
assert.equal(appState.machineOf("unlisted"), undefined);
appState.restoredFrom("unlisted", "box");
assert.equal(appState.machineOf("unlisted"), "box");
assert.equal(appState.app.activeId, "b", "and is focused");
assert.equal(ui.review(), undefined, "its own panel: no diff reader of a's");
assert.equal(s.besideReads(), true, "a's reader, kept, holds the side panel open and as wide while b is focused");
assert.deepEqual({ ...JSON.parse(values.get("cavvy.split")!), on: undefined }, { ...s.split(), on: undefined }, "kept for a reload of this window");

// Each one's panel comes back as it was.
ui.setInspectorPane("agents");
s.focusPane("a");
await settle();
assert.equal(appState.app.activeId, "a");
assert.deepEqual([ui.inspectorPane(), ui.review()], ["commands", { path: "a.ts" }]);
assert.equal(s.besideReads(), false, "b has none");
s.focusPane("b");
await settle();
assert.deepEqual([ui.inspectorPane(), ui.review()], ["agents", undefined]);
// The side panel closed from b (state/actions.ts togglePanel): a's reader goes with it.
assert.equal(ui.splitActions.closeBesideReader?.(), true);
assert.equal(s.besideReads(), false);
assert.equal(ui.splitActions.closeBesideReader?.(), false, "nothing holds it now");
s.focusPane("a");
await settle();
assert.equal(ui.review(), undefined, "a's reader is closed");
ui.setReview({ path: "a.ts" });
s.focusPane("b");
await settle();

// Neither of the two can be dropped again; a third takes the place of the one it's dropped on, and is focused.
assert.equal(s.canDrop("a"), false);
assert.equal(s.canDrop("b"), false);
assert.equal(s.canDrop("c"), true);
s.focusPane("a");
await settle();
s.dropSession("c", "right");
await settle();
assert.deepEqual(s.splitIds(), ["b", "c"], "c takes a's place on the right");
assert.equal(appState.app.activeId, "c");
assert.deepEqual([ui.inspectorPane(), ui.review()], ["commands", undefined], "its own panel: none of a's diff reader");
s.focusPane("b");
await settle();
assert.deepEqual([ui.inspectorPane(), ui.review()], ["agents", undefined], "b's own, as it left it");
s.dropSession("a", "left");
await settle();
assert.deepEqual(s.splitIds(), ["a", "c"], "and a takes b's on the left");
s.dropSession("b", "right");
await settle();
assert.deepEqual(s.splitIds(), ["a", "b"]);
s.dropSession("c", "right");
await settle();
assert.deepEqual(s.splitIds(), ["a", "c"]);
assert.equal(appState.app.activeId, "c");

// Closing the focused one: the other alone, focused, with its own panel back.
s.focusPane("a");
await settle();
ui.setInspectorPane("browser");
s.focusPane("c");
await settle();
s.closePane("c");
await settle();
assert.equal(s.split(), undefined);
assert.equal(appState.app.activeId, "a");
assert.equal(ui.inspectorPane(), "browser");
assert.equal(values.get("cavvy.split"), undefined);

// Picking a session outside the two shows it alone.
s.dropSession("b", "right");
await settle();
await appState.activate("c");
await settle();
assert.equal(s.split(), undefined);

// Archived (state/actions.ts leaveSplit) or deleted, a session takes only its own pane with it.
await appState.activate("a");
s.dropSession("b", "right");
await settle();
assert.equal(s.leaveSplit("a"), true);
await settle();
assert.equal(appState.app.activeId, "b");
assert.equal(s.split(), undefined);
assert.equal(s.leaveSplit("b"), false, "alone, it's the caller's to leave the screen");
s.dropSession("a", "left");
await settle();
assert.equal(appState.app.activeId, "a");
appState.forgetSession("a");
await settle();
assert.equal(s.split(), undefined);
assert.equal(appState.app.activeId, "b", "the focused one deleted: the other stays, focused");

// Many opened since: the one of two not focused stays open, as the focused one does.
await appState.activate("c");
s.dropSession("d", "right");
await settle();
assert.equal(appState.app.activeId, "d");
for (const id of more.slice(1)) await appState.openSession(id);
await settle();
assert.ok(appState.handleFor("c"), "the anchor, least recently used, is kept");
assert.ok(appState.handleFor("d"));
assert.equal(appState.handleFor("b"), undefined, "others are let go of as before");

// The one dropped is still opening when the other is focused: it opens in its own pane (OpeningPane), and says
// why it couldn't.
s.dropSession("broken", "right");
await settle();
assert.equal(appState.app.opening?.id, "broken");
s.focusPane("c");
await settle();
assert.equal(appState.app.opening, undefined);
s.openPane("broken");
assert.deepEqual({ ...s.paneOpening.broken }, { visible: false });
held.get("broken")!({ message: "No such folder", code: "internal" });
await settle();
assert.equal(s.paneOpening.broken?.error, "No such folder", "its pane says why");
assert.deepEqual(s.splitIds(), ["c", "broken"], "and stays, for Retry");
// One gone: its pane closes.
s.endPaneOpen("broken");
s.dropSession("gone", "right");
await settle();
s.focusPane("c");
await settle();
s.openPane("gone");
held.get("gone")!({ message: "Session not found", code: "not_found" });
await settle();
assert.equal(s.split(), undefined);
assert.equal(appState.app.activeId, "c");
assert.equal(s.paneOpening.gone, undefined);

appState.rpc.close();
process.exit(0);
