// Run in a child process so these GUI mocks cannot leak into other tests.
import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { createRoot } from "../../gui/node_modules/solid-js/dist/solid.js";
import { createComposerDraft } from "../../gui/src/lib/composer-draft";
import { RpcError } from "../../gui/src/lib/rpc";

const notices: { text: string; action?: { run: () => void } }[] = [];
const errors: unknown[] = [];
const calls: { method: string; params: any }[] = [];
const app = { activeId: "original" as string | undefined, homeCwd: "/project", settings: { model: "mock:model" as string | undefined }, homeMode: "default" };
let failure: unknown = new RpcError("Unknown command /oops", "unknown_command");
let created = 0;
let commandFailure: unknown;
let pendingSend: Promise<void> | undefined;
const rpc = { call: async (method: string, params: any) => {
    calls.push({ method, params });
    if (method === "commands.list") {
        if (commandFailure) throw commandFailure;
        return [];
    }
    if (failure) throw failure;
    await pendingSend;
    return { queued: false };
} };
const noop = () => {};
function mount(key: string) {
    return createRoot((dispose) => ({ ...createComposerDraft(() => key), dispose }));
}
let composer: ReturnType<typeof mount> | undefined;
function submit() {
    const draft = composer!;
    const submitted = draft.capture();
    return send(submitted.draft.text, submitted.draft.attachments, {
        sent: () => draft.clearSent(submitted),
    }).then((ok) => { if (ok) draft.clearSent(submitted); return ok; });
}
mock.module("../../gui/src/state/app", () => ({
    app, rpc, reportError: (e: unknown) => errors.push(e),
    toast: (text: string, _level: string, action: any) => notices.push({ text, action }),
    createSession: async () => { created++; return { id: "created" }; }, setApp: (key: string, value: any) => {
        Object.assign(app, { [key]: value });
        if (key === "activeId" && composer) {
            composer.dispose();
            composer = mount(value ?? "home");
        }
    },
    activate: noop, handleFor: noop, importCliSession: noop, markSeen: noop, refreshModels: noop, refreshProjects: noop,
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

// Home checks before creating a session. Exercise actual drafts and cleanup,
// including typing while a literal retry's RPC is still pending.
for (const recovery of ["literal", "corrected", "newer-text", "newer-images"] as const) {
    app.activeId = undefined;
    composer = mount("home");
    composer.setText("/oops");
    composer.setAttachments(attachments);
    const before = created;
    failure = undefined;
    commandFailure = new RpcError("Unknown command /oops", "unknown_command");
    calls.length = 0;
    assert.equal(await submit(), false);
    assert.equal(app.activeId, undefined);
    assert.equal(created, before);
    assert.deepEqual(calls, [{ method: "commands.list", params: { cwd: "/project", command: "oops" } }]);
    assert.equal(composer.text(), "/oops");
    assert.equal(composer.attachments(), attachments);
    assert.equal(notices.at(-1)?.text, "Unknown command /oops");
    if (recovery === "corrected") {
        composer.setText("corrected message");
        assert.equal(await submit(), true);
    } else {
        const pending = Promise.withResolvers<void>();
        pendingSend = pending.promise;
        notices.at(-1)!.action!.run();
        await Bun.sleep(0);
        assert.equal(app.activeId, undefined);
        if (recovery === "newer-text") composer.setText("newer draft");
        if (recovery === "newer-images") composer.setAttachments([{ ...attachments[0]!, data: "new-image" }]);
        pending.resolve();
        await Bun.sleep(0);
        pendingSend = undefined;
    }
    assert.equal(created, before + 1);
    assert.equal(app.activeId, "created");
    assert.deepEqual(calls.at(-1), { method: "session.send", params: {
        id: "created", text: recovery === "corrected" ? "corrected message" : "/oops",
        images: [{ mediaType: "image/png", data: "image-data" }],
        literal: recovery === "corrected" ? undefined : true,
    } });
    // The active session is empty; only newer unsent work remains on Home.
    assert.equal(composer.text(), "");
    composer.dispose();
    composer = mount("home");
    assert.equal(composer.text(), recovery === "newer-text" ? "newer draft" : recovery === "newer-images" ? "/oops" : "");
    assert.deepEqual(composer.attachments(), recovery === "newer-images" ? [{ ...attachments[0]!, data: "new-image" }] : recovery === "newer-text" ? attachments : []);
    composer.setText("");
    composer.setAttachments([]);
    composer.dispose();
    composer = undefined;
}

// The server remains authoritative if its command list changes after preflight.
app.activeId = undefined;
composer = mount("home");
composer.setText("/oops");
composer.setAttachments(attachments);
commandFailure = undefined;
failure = new RpcError("Unknown command /oops", "unknown_command");
const before = created;
assert.equal(await submit(), false);
assert.equal(created, before + 1);
assert.equal(app.activeId, undefined);
assert.equal(composer.text(), "/oops");
assert.equal(composer.attachments(), attachments);
failure = undefined;
notices.at(-1)!.action!.run();
await Bun.sleep(0);
assert.equal(created, before + 1);
assert.equal(app.activeId, "created");
composer.dispose();
composer = mount("home");
assert.equal(composer.text(), "");
assert.deepEqual(composer.attachments(), []);
composer.dispose();
composer = undefined;

// Home leaves provider resolution to the server, including project overrides
// and the no-settings default; an uninitialized Claude workspace passes there.
for (const model of ["claude-code:default", undefined, "mock:model"]) {
    app.activeId = undefined;
    app.settings.model = model;
    calls.length = 0;
    assert.equal(await send("/project-skill"), true);
    assert.deepEqual(calls.map((c) => c.method), ["commands.list", "session.send"]);
    assert.deepEqual(calls[0]!.params, { cwd: "/project", command: "project-skill" });
}

// A failed preflight retains Home without starting a session or hiding the error.
app.activeId = undefined;
commandFailure = new RpcError("Disconnected", "disconnected");
const beforeFailure = created;
assert.equal(await send("/oops"), false);
assert.equal(created, beforeFailure);
assert.equal(errors.at(-1), commandFailure);
