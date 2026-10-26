import { boundary } from "../helpers/render-boundary";
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";
import { readFileSync } from "node:fs";
import { all, component, node, renderer, text } from "../helpers/gui-render";
import { columnSteps, COLUMN_NARROW, COLUMN_SHORT } from "../../gui/src/lib/layout";

const mode = process.argv[2];
const key = "cavvy.navigation";
const values = new Map<string, string>();
const otherTab = new Map([[key, JSON.stringify({ activeId: "other-tab", homeCwd: "/other" })]]);
let tabValues = values;
const storage = {
    getItem(k: string) { if (mode === "unavailable") throw Error("denied"); return tabValues.get(k) ?? null; },
    setItem(k: string, v: string) { if (mode === "unavailable") throw Error("denied"); tabValues.set(k, v); },
};
Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), mode === "desktop" ? { __TAURI_INTERNALS__: {} } : {}),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
    sessionStorage: storage,
    // Navigation must leave authentication/deep-link URLs untouched.
    location: { hash: "#code=link-code", search: "?existing=value", pathname: "/" },
    history: { replaceState() { throw Error("navigation must not rewrite URLs"); } },
});
const snapshot = (id: string) => ({ seq: 0, state: { id, cwd: "/project", busy: true, interactions: [] }, turns: [], agents: [] });
let failure: string | undefined;
let hold = false;
let release: (() => void) | undefined;
let opens = 0;
class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "hello") {
            assert.equal(params.client, mode === "desktop" ? "desktop" : "browser");
            reply({ startCwd: "/startup" });
        } else if (method === "session.open") {
            opens++;
            const answer = () => failure
                ? queueMicrotask(() => this.message({ id, error: { code: failure, message: failure } }))
                : reply(snapshot(params.id));
            if (hold) release = answer; else answer();
        } else if (method === "settings.get") reply({});
        else if (method === "projects.recent") reply([{ path: "/recent" }]);
        else if (["sessions.list", "providers.list", "models.list", "limits.get"].includes(method)) reply([]);
        else throw Error(`Unexpected RPC: ${method}`);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = () => new Promise<void>((r) => setImmediate(r));
const first = await import("../../gui/src/state/app");
Object.assign(first.rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
await first.rpc.connect();
Socket.instances.at(-1)!.open();
await first.activate("saved");
await settle();
if (mode !== "unavailable") assert.deepEqual(JSON.parse(values.get(key) ?? "null"), { activeId: "saved", homeCwd: "/project" }, "activation persists this tab's session and project");
first.rpc.close();
if (mode === "isolated") tabValues = otherTab;
if (mode === "home") {
    first.setApp("activeId", undefined);
    first.setApp("homeCwd", "/chosen-home");
    await settle();
}
if (mode === "corrupt") values.set(key, JSON.stringify({ activeId: {}, homeCwd: 12 }));
if (mode === "missing") failure = "not_found";
if (mode === "transient" || mode === "retry") failure = "in_use";
if (mode === "trust") failure = "needs_trust";
if (mode === "navigate") hold = true;
// A fresh app module models reload, retaining only this tab's storage.
const second = await import(`../../gui/src/state/app.ts?reload=${mode}`);
Object.assign(second.rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
const appSource = readFileSync(new URL("../../gui/src/App.tsx", import.meta.url), "utf8");
// Every component App renders, except Solid's control flow, is a stub; new ones need no listing here.
const builtins = new Set(["Show", "For", "Index", "Switch", "Match", "Dynamic", "Portal", "ErrorBoundary", "Suspense"]);
const widgets = [...new Set([...appSource.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]!))].filter((tag) => !builtins.has(tag));
const App = component(appSource.slice(appSource.indexOf("export function App")), "App", {
    // Stubs first: a component given explicitly below wins.
    ...Object.fromEntries(widgets.map((tag) => [tag, () => node(tag)])),
    RenderBoundary: boundary(), Spinner: () => node("Spinner"), activate: second.activate, app: second.app, handleFor: second.handleFor, restoreActiveSession: second.restoreActiveSession,
    prefs: { sidebar: false }, isTauri: mode === "desktop", os: "other", setEnterSends() {}, actionOf: () => undefined, skipCovered() {},
    railDrag: () => undefined, columnSteps, COLUMN_NARROW, COLUMN_SHORT, shellLayout: () => ({ railMode: "dock", railShown: true, sheet: { w: 1100, h: 860 }, column: { w: 1100, h: 860 }, inspector: { open: false, mode: "dock", width: 360, short: false, bottom: 8 }, terminal: { shown: false, height: 0, maximized: false, most: 560 } }), settingsTab: () => undefined, agentFocus: () => undefined, review: () => undefined,
    attentionCount: () => 0, setAgentFocus() {}, setReview() {}, onMount() {},
});
const root = node("root");
const dispose = renderer.render(App, root);
const onHome = () => all(root).some((n) => n.tag === "Home");
try {
    second.start();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    await settle();
    if (["home", "corrupt", "unavailable"].includes(mode!)) {
        assert.equal(second.app.activeId, undefined);
        assert.equal(opens, 1, "Home never restores an older session");
        assert.equal(second.app.homeCwd, mode === "home" ? "/chosen-home" : "/startup");
        assert.ok(onHome());
    } else if (mode === "navigate") {
        assert.ok(release);
        assert.equal(onHome(), false, "pending restoration does not flash Home");
        second.setApp("activeId", undefined);
        second.setApp("homeCwd", "/new-project");
        release();
        await settle();
        assert.equal(second.app.activeId, undefined, "a pending restore cannot override Home navigation");
        assert.equal(second.app.homeCwd, "/new-project");
        assert.ok(onHome());
    } else if (mode === "missing") {
        assert.equal(second.app.activeId, undefined);
        assert.equal(JSON.parse(values.get(key)!).activeId, undefined, "deleted selection is cleared");
        assert.equal(second.app.homeCwd, "/project");
        assert.ok(onHome());
    } else {
        const selected = mode === "isolated" ? "other-tab" : "saved";
        assert.equal(second.app.activeId, selected, "reload restores this tab's session even outside the capped lists");
        assert.equal(second.app.homeCwd, "/project");
        assert.equal(onHome(), false, "a selected session never falls back to Home on a temporary open failure");
        if (mode === "trust") {
            const request = second.trustRequest();
            assert.equal(request?.path, "/project");
            failure = undefined;
            request!.then();
            await settle();
            assert.ok(second.handleFor("saved")?.ready());
        } else if (mode === "transient" || mode === "retry") {
            assert.ok(text(root).includes("Couldn't open this session"));
            if (mode === "retry") {
                failure = undefined;
                all(root).find((n) => n.tag === "button" && text(n) === "Retry opening session")!.props.onClick();
                await settle();
                assert.ok(second.handleFor(selected)?.ready(), "retry opens the session without a reconnect");
            }
        } else assert.ok(second.handleFor(selected)?.ready());
        // Reconnect must retain the current selection and reopen its snapshot;
        // temporary open failures must keep enough state to retry next time.
        Socket.instances.at(-1)!.close();
        failure = undefined;
        second.rpc.reconnectNow();
        await settle();
        Socket.instances.at(-1)!.open();
        await settle();
        await settle();
        assert.equal(second.app.activeId, selected);
        assert.ok(second.handleFor(selected)?.ready());
        assert.equal(opens, mode === "trust" || mode === "retry" ? 4 : 3);
    }
    if (mode === "isolated") assert.deepEqual(JSON.parse(values.get(key)!), { activeId: "saved", homeCwd: "/project" }, "another tab cannot overwrite the first tab's navigation");
    else assert.deepEqual(JSON.parse(otherTab.get(key)!), { activeId: "other-tab", homeCwd: "/other" });
    assert.equal(location.hash, "#code=link-code");
} finally {
    dispose();
    second.rpc.close();
    while (second.toasts.length) second.dismissToast(second.toasts[0]!.id);
}
