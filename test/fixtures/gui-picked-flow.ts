// A window that loads on another machine with a pick left in its tab's storage (gui/src/lib/picked.ts): what it
// shows on its first screen, and what it asks that machine to save.
import assert from "node:assert/strict";
import { Socket } from "../helpers/gui-socket";

const mode = process.argv[2];
const values = new Map<string, string>([["cavvy.picked", JSON.stringify({ model: "codex:gpt-6-luna", effort: "high", fastMode: true })]]);
Object.assign(globalThis, {
    // The desktop app's window: hidden until the page says its first screen is drawn.
    window: Object.assign(new EventTarget(), { cavvyDesktop: new Proxy({}, { get: () => async () => undefined }) }),
    document: Object.assign(new EventTarget(), { hidden: false, visibilityState: "visible", documentElement: { dataset: {}, style: { setProperty() {} } } }),
    sessionStorage: { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), removeItem: (k: string) => void values.delete(k) },
    location: { hash: "", search: "", pathname: "/" },
    history: { replaceState() {} },
});
// This machine's own: another model, with fast mode never set.
const own = { model: "claude-code:haiku", effort: "medium", defaultMode: "bypassPermissions" };
const luna = { ref: "codex:gpt-6-luna", id: "gpt-6-luna", name: "GPT-6 Luna", effortLevels: ["low", "medium", "high"], ...(mode === "fast-not-here" ? {} : { supportsFastMode: true }) };
const MODELS_MS = mode === "slow-models" ? 700 : 30;
const updates: Record<string, unknown>[] = [];
const sent: string[] = [];
class Server extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        sent.push(method);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "hello") reply({ startCwd: "/s" });
        else if (method === "settings.get") reply(own);
        else if (method === "models.list") setTimeout(() => reply([{ provider: "codex", providerName: "Codex", models: mode === "lacks" ? [] : [luna] }, { provider: "claude-code", providerName: "Claude Code", models: [{ ref: "claude-code:haiku", id: "haiku", name: "Haiku" }] }]), MODELS_MS);
        else if (method === "settings.update") {
            updates.push(params.patch);
            // As the engine does: fast mode on a model that can't run fast is refused, with all that came with it.
            if (params.patch.fastMode && mode === "fast-not-here") queueMicrotask(() => this.message({ id, error: { message: "Fast mode is not available for this model/backend" } }));
            else reply({ ...own, ...params.patch });
        } else reply([]);
    }
}
globalThis.WebSocket = Server as unknown as typeof WebSocket;
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const m = await import("../../gui/src/state/app");
const { isWindowShown } = await import("../../gui/src/lib/platform");
Object.assign(m.rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
const shows = () => ({ model: m.app.settings.model, effort: m.app.settings.effort, fastMode: m.app.settings.fastMode });
try {
    // Taken from the tab's storage as the page loads, once.
    assert.equal(values.has("cavvy.picked"), false);
    if (mode === "from-a-cover") {
        // The machine was never reached (the window sits on its cover): what came with the window is still to go on.
        assert.deepEqual(m.pendingPicked(), { model: "codex:gpt-6-luna", effort: "high", fastMode: true });
        process.exit(0);
    }
    m.start();
    await wait(5);
    Socket.instances.at(-1)!.open();
    await wait(15);
    // The lists are in and the models aren't: the first screen waits for them, so the composer isn't seen changing.
    assert.equal(m.app.sessionsLoaded, true);
    assert.ok(sent.indexOf("models.list") < sent.indexOf("sessions.list"), "the models are asked for with the lists");
    assert.deepEqual([isWindowShown(), shows()], [false, { model: "claude-code:haiku", effort: "medium", fastMode: undefined }]);
    await wait(mode === "slow-models" ? 480 : 80);
    assert.equal(isWindowShown(), true);
    assert.equal(m.toasts.length, 0, JSON.stringify(m.toasts.map((t: { text: string }) => t.text)));
    if (mode === "has") {
        assert.deepEqual(updates, [{ model: "codex:gpt-6-luna", effort: "high", fastMode: true }]);
        assert.deepEqual(shows(), { model: "codex:gpt-6-luna", effort: "high", fastMode: true });
    } else if (mode === "fast-not-here") {
        // The model can't run fast here: the model and effort come without it, and nothing is refused.
        assert.deepEqual(updates, [{ model: "codex:gpt-6-luna", effort: "high" }]);
        assert.deepEqual(shows(), { model: "codex:gpt-6-luna", effort: "high", fastMode: undefined });
    } else if (mode === "lacks") {
        assert.deepEqual([updates, shows()], [[], { model: "claude-code:haiku", effort: "medium", fastMode: undefined }]);
    } else if (mode === "slow-models") {
        // The window came up without the models (after a moment): the pick is let go, and the composer doesn't
        // change when they do come.
        assert.deepEqual([updates, shows(), m.app.modelsLoaded], [[], { model: "claude-code:haiku", effort: "medium", fastMode: undefined }, false]);
        await wait(400);
        assert.deepEqual([updates, shows(), m.app.modelsLoaded], [[], { model: "claude-code:haiku", effort: "medium", fastMode: undefined }, true]);
    }
    assert.equal(m.pendingPicked(), undefined);
} finally {
    m.rpc.close();
}
process.exit(0);
