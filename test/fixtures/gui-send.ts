// Run in a child process so these GUI mocks cannot leak into other tests.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { RpcError } from "../../gui/src/lib/rpc";

const notices: { text: string; action?: { run: () => void } }[] = [];
const errors: unknown[] = [];
const calls: { method: string; params: any }[] = [];
const app = { activeId: "original" as string | undefined, homeCwd: "/project", settings: { model: "mock:model" as string | undefined }, homeMode: "default" };
let failure: unknown = new RpcError("Unknown command /oops", "unknown_command");
const rpc = { call: async (method: string, params: any) => {
    calls.push({ method, params });
    if (failure) throw failure;
    return { queued: false };
} };
const noop = () => {};
mock.module("../../gui/src/state/app", () => ({
    app, rpc, reportError: (e: unknown) => errors.push(e),
    toast: (text: string, _level: string, action: any) => notices.push({ text, action }),
    createSession: async () => ({ id: "created" }), setApp: (key: string, value: any) => Object.assign(app, { [key]: value }),
    activate: noop, handleFor: noop, refreshModels: noop, refreshProjects: noop,
    refreshProviders: noop, refreshSessions: noop, refreshSettings: noop, requestTrust: noop,
}));
mock.module("../../gui/src/lib/platform", () => ({ copyText: noop, pickFolder: noop }));
mock.module("../../gui/src/state/prefs", () => ({ prefs: {}, setPrefs: noop }));
mock.module("../../gui/src/state/ui", () => Object.fromEntries([
    "requestComposerFocus", "setAgentFocus", "setContextCardOpen", "setFolderPickerOpen", "setModePickerOpen",
    "setModelPickerOpen", "setReview", "setRewindOpen", "setSettingsTab",
].map((name) => [name, noop])));
const { send } = await import("../../gui/src/state/actions");
const attachments = [{ name: "image", mediaType: "image/png", data: "image-data", preview: "preview" }];
let sent = 0;
assert.equal(await send("/oops", attachments, { sent: () => sent++ }), false);
assert.equal(errors.length, 0);
assert.equal(notices[0]?.text, "Unknown command /oops");
assert.equal(sent, 0);

// A retry targets the original session and preserves the original attachments.
app.activeId = "another";
failure = undefined;
notices[0]!.action!.run();
await Bun.sleep(0);
assert.equal(sent, 1);
assert.deepEqual(calls.at(-1), { method: "session.send", params: {
    id: "original", text: "/oops", images: [{ mediaType: "image/png", data: "image-data" }], literal: true,
} });

failure = new RpcError("Disconnected", "disconnected");
assert.equal(await send("/oops"), false);
assert.deepEqual(errors, [failure]);
assert.equal(notices.length, 1);

// A fresh Claude workspace reaches its server guard without a premature home rejection.
app.activeId = undefined;
app.settings.model = "claude-code:default";
failure = undefined;
calls.length = 0;
assert.equal(await send("/project-skill"), true);
assert.deepEqual(calls.map((c) => c.method), ["session.send"]);
assert.equal(calls[0]!.params.id, "created");

// With no configured model, the server may choose Claude as its default too.
app.activeId = undefined;
app.settings.model = undefined;
calls.length = 0;
assert.equal(await send("/project-skill"), true);
assert.deepEqual(calls.map((c) => c.method), ["session.send"]);

// A project's Claude override must work even when the global default is another provider.
app.activeId = undefined;
app.settings.model = "mock:model";
calls.length = 0;
assert.equal(await send("/project-skill"), true);
assert.deepEqual(calls.map((c) => c.method), ["session.send"]);
assert.equal(calls[0]!.params.id, "created");
