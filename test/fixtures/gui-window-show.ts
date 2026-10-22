// The desktop window is created hidden; the page shows it (window_ready) once its first screen has what it shows.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

const mode = process.argv[2];
const invoked: string[] = [];
Object.assign(globalThis, {
    window: Object.assign(new EventTarget(), mode === "browser" ? {} : { __TAURI_INTERNALS__: { invoke: async (cmd: string) => void invoked.push(cmd) } }),
    document: Object.assign(new EventTarget(), { hidden: true, visibilityState: "hidden", documentElement: { dataset: {}, style: { setProperty() {} } } }),
    sessionStorage: { getItem: () => null, setItem() {} },
    location: { hash: "", search: "", pathname: "/" },
    history: { replaceState() {} },
});
let release: (() => void) | undefined;
class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "hello") reply({});
        else if (method === "settings.get") reply({});
        else if (method === "projects.recent") release = () => reply([{ path: "/project" }]);
        else if (method === "keybindings.get") reply({ bindings: [] });
        else reply([]);
    }
}
globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
// Long enough for a call's dynamic import of the Tauri API to land.
const settle = () => new Promise<void>((r) => setTimeout(r, 40));
const shown = () => invoked.filter((c) => c === "window_ready").length;

const app = await import("../../gui/src/state/app");
Object.assign(app.rpc, { credentials: async () => (mode === "unauthorized" ? undefined : { url: "ws://test", token: "test" }) });
app.start();
await settle();
if (mode === "data" || mode === "browser") {
    Socket.instances.at(-1)!.open();
    await settle();
    assert.equal(app.app.conn, "open");
    assert.equal(shown(), 0, "connected, but the first screen's projects aren't in: still hidden");
    assert.ok(release, "projects were asked for");
    release!();
    await settle();
    assert.equal(app.app.homeCwd, "/project");
    assert.equal(shown(), mode === "browser" ? 0 : 1, "shown once the first screen has its data (a browser tab has no window to show)");
    // A reconnect draws the screen again; the window is already up.
    Socket.instances.at(-1)!.close();
    app.rpc.reconnectNow();
    await settle();
    Socket.instances.at(-1)!.open();
    await settle();
    release?.();
    await settle();
    assert.equal(shown(), mode === "browser" ? 0 : 1);
} else if (mode === "unauthorized") {
    assert.equal(app.app.conn, "unauthorized");
    assert.equal(shown(), 1, "a screen that won't change by itself shows at once");
} else if (mode === "fallback") {
    // The server never answers: the splash shows after a second.
    assert.equal(shown(), 0);
    await new Promise((r) => setTimeout(r, 1100));
    assert.equal(shown(), 1);
} else throw Error(`unknown mode ${mode}`);
process.exit(0);
