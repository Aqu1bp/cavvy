// Browser-condition Solid runs the same effects and cleanup as Composer, without needing a DOM.
import { strict as assert } from "node:assert";
import { createRoot } from "../../gui/node_modules/solid-js/dist/solid.js";
import { composerDrafts, createComposerDraft } from "../../gui/src/lib/composer-draft";

function mount(key: string, wasDeleted?: (key: string) => boolean) {
    return createRoot((dispose) => ({ ...createComposerDraft(() => key, wasDeleted), dispose }));
}
const image = { name: "image", mediaType: "image/png", data: "image-data", preview: "preview" };

// Home unmounts when session creation activates the session, while sending is still pending.
const home = mount("home");
home.setText("send this");
home.setAttachments([image]);
const submitted = home.capture();
const pending = Promise.withResolvers<boolean>();
const finish = pending.promise.then((ok) => { if (ok) home.sent(submitted); });
home.dispose();
pending.resolve(true);
await finish;
const reopened = mount("home");
assert.equal(reopened.text(), "");
assert.deepEqual(reopened.attachments(), []);
reopened.dispose();

// An unsuccessful send preserves the text and attachments saved at unmount.
const failed = mount("failed");
failed.setText("retry this");
failed.setAttachments([image]);
failed.dispose();
const retry = mount("failed");
assert.equal(retry.text(), "retry this");
assert.deepEqual(retry.attachments(), [image]);
retry.dispose();

// A replacement can save different text or images before the original send finishes.
for (const change of ["text", "attachments"] as const) {
    const original = mount(change);
    original.setText("original");
    original.setAttachments([image]);
    const sent = original.capture();
    original.dispose();
    const replacement = mount(change);
    if (change === "text") replacement.setText("newer draft");
    else replacement.setAttachments([{ ...image, data: "new-image" }]);
    const newer = replacement.capture();
    replacement.dispose();
    original.sent(sent);
    const again = mount(change);
    assert.equal(again.text(), newer.text);
    assert.deepEqual(again.attachments(), newer.attachments);
    again.dispose();
}

// A disposed toast callback cannot clear a replacement's saved draft, even with identical content.
const original = mount("toast");
original.setText("/unknown");
original.setAttachments([image]);
const snapshot = original.capture();
const toastSent = () => original.sent(snapshot);
original.dispose();
const replacement = mount("toast");
replacement.dispose();
toastSent();
const afterToast = mount("toast");
assert.equal(afterToast.text(), "/unknown");
assert.deepEqual(afterToast.attachments(), [image]);
afterToast.dispose();

// Successful mounted sends clear both UI and the next saved draft.
const active = mount("active");
active.setText("message");
active.setAttachments([image]);
active.sent(active.capture());
assert.equal(active.text(), "");
assert.deepEqual(active.attachments(), []);
active.dispose();
const next = mount("active");
assert.equal(next.text(), "");
assert.deepEqual(next.attachments(), []);
next.dispose();

// A disposed Home toast retry still clears the original draft when nobody replaced it.
const toastHome = mount("toast-home");
toastHome.setText("/unknown");
toastHome.setAttachments([image]);
const toastSnapshot = toastHome.capture();
const retrySent = () => toastHome.sent(toastSnapshot);
toastHome.dispose();
retrySent();
const afterRetry = mount("toast-home");
assert.equal(afterRetry.text(), "");
assert.deepEqual(afterRetry.attachments(), []);
afterRetry.dispose();

// A refusal can arrive after the user has left the newly created session.
// Restore it on the next mount and hand the toast's cleanup to that composer.
for (const remount of [false, true]) {
    const key = `late-refusal-${remount}`;
    const home = mount(`${key}-home`);
    home.setText("/oops");
    home.setAttachments([image]);
    const submitted = home.capture();
    home.dispose();
    const clear = home.move(submitted, key);
    const destination = remount ? mount(key) : undefined;
    if (destination) {
        assert.equal(destination.text(), "/oops");
        assert.deepEqual(destination.attachments(), [image]);
    }
    clear();
    if (destination) {
        assert.equal(destination.text(), "");
        assert.deepEqual(destination.attachments(), []);
        destination.dispose();
    }
    const again = mount(key);
    assert.equal(again.text(), "");
    assert.deepEqual(again.attachments(), []);
    again.dispose();
}

// Text typed in the new session before the refusal arrives survives the transfer and retry.
for (const mounted of [false, true]) {
    const key = `edited-before-refusal-${mounted}`;
    const destination = mount(key);
    destination.setText("newer text");
    if (!mounted) destination.dispose();
    const home = mount(`${key}-home`);
    home.setText("/oops");
    home.setAttachments([image]);
    const submitted = home.capture();
    home.dispose();
    const clear = home.move(submitted, key);
    const current = mounted ? destination : mount(key);
    clear();
    assert.equal(current.text(), "/oops\nnewer text");
    assert.deepEqual(current.attachments(), [image]);
    current.dispose();
}

// Session deletion clears the same store used by the lifecycle controller;
// cleanup after the deletion event must not save its text or images again.
const deleted = new Set<string>();
const wasDeleted = (key: string) => deleted.has(key);
const toDelete = mount("deleted-session", wasDeleted);
toDelete.setText("unsent draft");
toDelete.setAttachments([image]);
toDelete.dispose();
assert.equal(composerDrafts.get("deleted-session")?.text, "unsent draft");
const deleting = mount("deleted-session", wasDeleted);
deleted.add("deleted-session");
composerDrafts.delete("deleted-session");
deleting.dispose();
assert.equal(composerDrafts.has("deleted-session"), false);

// A first-message refusal can arrive after its new session was deleted.
// Keep the Home draft recoverable, without recreating the deleted draft.
const lateHome = mount("deleted-home", wasDeleted);
lateHome.setText("/oops");
lateHome.setAttachments([image]);
const lateSubmission = lateHome.capture();
lateHome.dispose();
lateHome.move(lateSubmission, "deleted-session")();
assert.equal(composerDrafts.has("deleted-session"), false);
const keptHome = mount("deleted-home", wasDeleted);
assert.equal(keptHome.text(), "/oops");
assert.deepEqual(keptHome.attachments(), [image]);
keptHome.dispose();

// Undo allows future drafts again, without reviving the deleted one.
deleted.delete("deleted-session");
const undone = mount("deleted-session", wasDeleted);
assert.equal(undone.text(), "");
assert.deepEqual(undone.attachments(), []);
undone.setText("after undo");
undone.dispose();
assert.equal(composerDrafts.get("deleted-session")?.text, "after undo");
