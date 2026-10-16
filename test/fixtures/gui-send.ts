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
const rpc = { call: async (method: string, params: any) => {
    calls.push({ method, params });
    if (failure) throw failure;
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
    return send(submitted.text, submitted.attachments, {
        sent: () => draft.sent(submitted),
        refused: (id) => draft.move(submitted, id),
    }).then((ok) => { if (ok) draft.sent(submitted); return ok; });
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

// Exercise the same draft capture, unmount and transfer as Composer's submit.
// Both recovery paths read the actual session draft, including its attachments.
for (const recovery of ["literal", "corrected", "edited-after-refusal"] as const) {
    app.activeId = undefined;
    composer = mount("home");
    composer.setText("/oops");
    composer.setAttachments(attachments);
    const before = created;
    failure = new RpcError("Unknown command /oops", "unknown_command");
    calls.length = 0;
    assert.equal(await submit(), false);
    assert.equal(app.activeId, "created");
    assert.equal(created, before + 1);
    assert.equal(composer.text(), "/oops");
    assert.equal(composer.attachments(), attachments);
    const home = mount("home");
    assert.equal(home.text(), "");
    assert.deepEqual(home.attachments(), []);
    home.dispose();
    assert.equal(notices.at(-1)?.text, "Unknown command /oops");
    failure = undefined;
    if (recovery === "corrected") {
        composer.setText(composer.text().replace("/oops", "corrected message"));
        assert.equal(await submit(), true);
    } else {
        if (recovery === "edited-after-refusal") composer.setText("newer draft");
        notices.at(-1)!.action!.run();
        await Bun.sleep(0);
    }
    assert.equal(created, before + 1);
    assert.deepEqual(calls.at(-1), { method: "session.send", params: {
        id: "created", text: recovery === "corrected" ? "corrected message" : "/oops",
        images: [{ mediaType: "image/png", data: "image-data" }],
        literal: recovery === "corrected" ? undefined : true,
    } });
    assert.equal(composer.text(), recovery === "edited-after-refusal" ? "newer draft" : "");
    assert.deepEqual(composer.attachments(), recovery === "edited-after-refusal" ? attachments : []);
    composer.setText("");
    composer.setAttachments([]);
    composer.dispose();
    composer = undefined;
}

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
