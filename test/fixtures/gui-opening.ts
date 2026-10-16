import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { Socket } from "../helpers/gui-socket";
import { all, component, node, renderer, text } from "../helpers/gui-render";
import { boundary } from "../helpers/render-boundary";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
    sessionStorage: { getItem() { return null; }, setItem() {} },
    location: { hash: "", search: "", pathname: "/" },
});
const requests: { id: string; answer: (error?: string) => void }[] = [];
class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        assert.equal(method, "session.open");
        requests.push({ id: params.id, answer: (error) => queueMicrotask(() => this.message(error
            ? { id, error: { code: "in_use", message: error } }
            : { id, result: { seq: 0, state: { id: params.id, cwd: "/" + params.id, busy: false, interactions: [] }, turns: [], agents: [] } })) });
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
const settle = () => new Promise<void>((r) => setImmediate(r));
const appModule = await import("../../gui/src/state/app");
const { app, setApp, activate, rpc } = appModule;
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
await rpc.connect();
Socket.instances.at(-1)!.open();
setApp("conn", "open");
const widgets = ["Header", "Home", "Sidebar", "SessionView", "Reconnecting", "Disconnected", "TerminalPanel", "CommandPalette", "RewindDialog", "McpDialog", "FolderPicker", "TrustDialog", "DeleteSessionDialog", "CommitDialog", "Toasts", "Spinner"];
const source = readFileSync(new URL("../../gui/src/App.tsx", import.meta.url), "utf8");
const App = component(source.slice(source.indexOf("export function App")), "App", {
    ...appModule, RenderBoundary: boundary(), prefs: { sidebar: true }, isTauri: false,
    settingsTab: () => undefined, agentFocus: () => undefined, review: () => undefined,
    attentionCount: () => 0, setAgentFocus() {}, setReview() {}, onMount() {},
    ...Object.fromEntries(widgets.map((tag) => [tag, () => node(tag)])),
});
const root = node("root");
const dispose = renderer.render(App, root);
try {
    const a = activate("a");
    assert.equal(app.activeId, "a", "sidebar selection changes synchronously");
    assert.equal(app.opening?.visible, false);
    assert.ok(!text(root).includes("Opening session"), "no initial loading flash");
    await settle();
    const b = activate("b");
    await settle();
    requests.find((r) => r.id === "b")!.answer();
    await b;
    requests.find((r) => r.id === "a")!.answer();
    await a;
    assert.equal(app.activeId, "b", "older success cannot steal selection");
    assert.equal(app.homeCwd, "/b");
    assert.equal(app.opening, undefined);

    const old = activate("old");
    await settle();
    await activate("b");
    requests.find((r) => r.id === "old")!.answer("stale failure");
    await old;
    assert.equal(app.activeId, "b");
    assert.equal(app.opening, undefined, "older failure cannot replace newer content");
    assert.equal(appModule.toasts.length, 0);

    const slow = activate("slow");
    await settle();
    await Bun.sleep(420);
    assert.equal(app.opening?.visible, true);
    assert.ok(text(root).includes("Opening session"));
    assert.ok(all(root).some((n) => n.tag === "Sidebar"));
    requests.find((r) => r.id === "slow")!.answer();
    await settle();
    assert.ok(text(root).includes("Opening session"), "cached handle must not bypass minimum visible time");
    await slow;
    assert.equal(app.opening, undefined);
    assert.ok(all(root).some((n) => n.tag === "SessionView"));

    const failure = activate("failure");
    await settle();
    const secret = "sk-proj-" + "x".repeat(30);
    requests.find((r) => r.id === "failure")!.answer(`bad ${secret}`);
    await failure;
    assert.ok(text(root).includes("Couldn't open this session"));
    assert.ok(!text(root).includes(secret));
    const retry = all(root).find((n) => n.tag === "button" && text(n) === "Retry opening session")!;
    retry.props.onClick();
    assert.equal(app.opening?.error, undefined, "retry clears the previous error despite Solid store merging");
    assert.ok(!text(root).includes("Couldn't open this session"));
    await settle();
    requests.at(-1)!.answer();
    await settle();
    assert.equal(app.opening, undefined);
    assert.equal(app.activeId, "failure");

    const home = activate("home-race");
    await settle();
    setApp("activeId", undefined); // newSession uses direct navigation too.
    setApp("homeCwd", "/chosen-project");
    requests.at(-1)!.answer();
    await home;
    assert.equal(app.activeId, undefined);
    assert.equal(app.homeCwd, "/chosen-project");
    assert.equal(app.opening, undefined);
    assert.ok(all(root).some((n) => n.tag === "Home"));
} finally { dispose(); rpc.close(); }
