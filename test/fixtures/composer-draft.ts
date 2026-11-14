// Browser-condition Solid runs the same effects and cleanup as Composer, without needing a DOM.
import { strict as assert } from "node:assert";
import { createRoot } from "../../gui/node_modules/solid-js/dist/solid.js";
import { composerDrafts, composerStashes, createComposerDraft } from "../../gui/src/lib/composer-draft";
import { STASH_LIMIT } from "../../gui/src/lib/drafts";
import { isLongPaste, pastedText, readAttachment } from "../../gui/src/lib/attachments";

function mount(key: string, wasDeleted?: (key: string) => boolean) {
    return createRoot((dispose) => ({ ...createComposerDraft(() => key, wasDeleted), dispose }));
}
const image = await readAttachment(new File([new Uint8Array([137, 80, 78, 71])], "image.png", { type: "image/png" }), []);
assert.equal(image.kind, "image");
const textFile = await readAttachment(new File(["first line\nsecond line\n"], "notes.txt"), []);
const pdf = await readAttachment(new File(["%PDF-1.7\n"], "document.pdf"), []);
const refused = await readAttachment(new File([new Uint8Array([0])], "binary.bin"), []);
const longText = "a line of pasted text\n".repeat(100);
assert.equal(isLongPaste(longText), true);
const paste = pastedText(longText, []);
assert.equal(textFile.kind, "text");
assert.equal(pdf.kind, "pdf");
assert.equal(refused.kind, "refused");
assert.equal(paste.kind, "text");
assert.ok(paste.kind === "text" && paste.pasted);
const files = [image, textFile, pdf, paste];

// Home unmounts when a successful send opens the session, before its completion callback runs.
const home = mount("home");
home.setText("send this");
home.setAttachments(files);
const submitted = home.capture();
const pending = Promise.withResolvers<boolean>();
const finish = pending.promise.then((ok) => { if (ok) home.clearSent(submitted); });
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
    original.clearSent(sent);
    const again = mount(change);
    assert.equal(again.text(), newer.draft.text);
    assert.deepEqual(again.attachments(), newer.draft.attachments);
    again.dispose();
}

// A disposed toast callback cannot clear a replacement's saved draft, even with identical content.
const original = mount("toast");
original.setText("/unknown");
original.setAttachments([image]);
const snapshot = original.capture();
const toastSent = () => original.clearSent(snapshot);
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
active.setAttachments(files);
active.clearSent(active.capture());
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
const retrySent = () => toastHome.clearSent(toastSnapshot);
toastHome.dispose();
retrySent();
const afterRetry = mount("toast-home");
assert.equal(afterRetry.text(), "");
assert.deepEqual(afterRetry.attachments(), []);
afterRetry.dispose();

// A late toast retry cannot clear text or images edited in the same composer.
for (const change of ["text", "attachments", "same-text-again"] as const) {
    const draft = mount(`late-${change}`);
    draft.setText("/oops");
    draft.setAttachments([image]);
    const submitted = draft.capture();
    if (change === "attachments") draft.setAttachments([{ ...image, data: "new-image" }]);
    else {
        draft.setText("new text");
        if (change === "same-text-again") draft.setText("/oops");
    }
    const newer = draft.capture();
    draft.clearSent(submitted);
    assert.equal(draft.text(), newer.draft.text);
    assert.deepEqual(draft.attachments(), newer.draft.attachments);
    draft.dispose();
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

// Undo allows future drafts again, without reviving the deleted one.
deleted.delete("deleted-session");
const undone = mount("deleted-session", wasDeleted);
assert.equal(undone.text(), "");
assert.deepEqual(undone.attachments(), []);
undone.setText("after undo");
undone.dispose();
assert.equal(composerDrafts.get("deleted-session")?.text, "after undo");

// Unsent files retain their contents and chip metadata when switching sessions.
const withFiles = mount("files");
withFiles.setText("review these");
withFiles.setAttachments([...files, refused]);
withFiles.dispose();
const keptFiles = mount("files");
assert.equal(keptFiles.text(), "review these");
assert.deepEqual(keptFiles.attachments(), [...files, refused]);
keptFiles.setAttachments(files);
const fileSubmission = keptFiles.capture();
// A refused send never clears the draft, including after it is saved and reopened.
keptFiles.dispose();
const refusedSend = mount("files");
assert.equal(refusedSend.text(), fileSubmission.draft.text);
assert.deepEqual(refusedSend.attachments(), files);
refusedSend.clearSent(refusedSend.capture());
assert.equal(refusedSend.text(), "");
assert.deepEqual(refusedSend.attachments(), []);
refusedSend.dispose();
const clearedFiles = mount("files");
assert.equal(clearedFiles.text(), "");
assert.deepEqual(clearedFiles.attachments(), []);
clearedFiles.dispose();

// New files or a long paste added during a send belong to the next draft.
for (const added of [textFile, pdf, paste]) {
    const draft = mount(`added-${added.name}`);
    draft.setText("message");
    draft.setAttachments([image]);
    const sent = draft.capture();
    draft.setAttachments((attachments) => [...attachments, added]);
    draft.clearSent(sent);
    assert.equal(draft.text(), "message");
    assert.deepEqual(draft.attachments(), [image, added]);
    draft.dispose();
    const reopened = mount(`added-${added.name}`);
    assert.deepEqual(reopened.attachments(), [image, added]);
    reopened.dispose();
}

// Local commands consume only the command text; they never submit the attached files.
for (const lifecycle of ["mounted", "disposed", "replaced"] as const) {
    const key = `local-${lifecycle}`;
    const draft = mount(key);
    draft.setText("/context");
    draft.setAttachments([...files, refused]);
    const submitted = draft.capture();
    if (lifecycle !== "mounted") draft.dispose();
    const replacement = lifecycle === "replaced" ? mount(key) : undefined;
    replacement?.setText("newer message");
    replacement?.dispose();
    draft.clearSent(submitted, true);
    if (lifecycle === "mounted") {
        assert.equal(draft.text(), "");
        assert.deepEqual(draft.attachments(), [...files, refused]);
        draft.dispose();
    }
    const reopened = mount(key);
    assert.equal(reopened.text(), lifecycle === "replaced" ? "newer message" : "");
    assert.deepEqual(reopened.attachments(), [...files, refused]);
    reopened.dispose();
}

// ---- The stash key
/** What's stashed, without when. */
const plain = (list: { text: string; attachments: unknown[] }[]) => list.map(({ text, attachments }) => ({ text, attachments }));
// Each is stamped with when it was put away, and what's brought back is a draft again, without it.
const stamped = createRoot((dispose) => ({ ...createComposerDraft(() => "stash-time", undefined, () => 1234), dispose }));
stamped.setText("timed");
stamped.pushStash();
assert.deepEqual(stamped.stashes(), [{ text: "timed", attachments: [], at: 1234 }]);
stamped.takeStash();
assert.deepEqual(stamped.capture().draft, { text: "timed", attachments: [] });
stamped.dispose();
// Put away, the prompt leaves the box with its files; brought back, both return.
const stashing = mount("stash");
assert.equal(stashing.pushStash(), false);
assert.equal(stashing.takeStash(), false);
stashing.setText("long prompt");
stashing.setAttachments(files);
assert.equal(stashing.pushStash(), true);
assert.equal(stashing.text(), "");
assert.deepEqual(stashing.attachments(), []);
assert.deepEqual(plain(stashing.stashes()), [{ text: "long prompt", attachments: files }]);
assert.equal(stashing.takeStash(), true);
assert.equal(stashing.text(), "long prompt");
assert.deepEqual(stashing.attachments(), files);
assert.deepEqual(stashing.stashes(), []);
// Several are kept, newest first; a session switch away and back keeps each where it was.
stashing.pushStash();
stashing.setText("second");
stashing.pushStash();
stashing.setAttachments([image]);
stashing.pushStash();
stashing.setText("in the box");
assert.deepEqual(stashing.stashes().map((d) => d.text), ["", "second", "long prompt"]);
stashing.dispose();
const stashKept = mount("stash");
assert.equal(stashKept.text(), "in the box");
assert.deepEqual(plain(stashKept.stashes()), [{ text: "", attachments: [image] }, { text: "second", attachments: [] }, { text: "long prompt", attachments: files }]);
assert.deepEqual(mount("stash-other").stashes(), []);
// One picked from the list comes back, and what was in the box is stashed in its place, as the newest.
assert.equal(stashKept.takeStash(stashKept.stashes()[2]), true);
assert.equal(stashKept.text(), "long prompt");
assert.deepEqual(stashKept.attachments(), files);
assert.deepEqual(stashKept.stashes().map((d) => d.text), ["in the box", "", "second"]);
// One that's no longer there is not brought back twice.
assert.equal(stashKept.takeStash({ text: "long prompt", attachments: files, at: 0 }), false);
stashKept.dispose();

// A send never brings one back: the box is left empty, and they wait until they're asked for.
const sentWith = mount("stash-send");
sentWith.setText("older");
sentWith.pushStash();
sentWith.setText("stays stashed");
sentWith.setAttachments([image]);
sentWith.pushStash();
sentWith.setText("goes first");
const first = sentWith.capture();
sentWith.clearSent(first);
assert.equal(sentWith.text(), "");
assert.deepEqual(sentWith.attachments(), []);
assert.deepEqual(plain(sentWith.stashes()), [{ text: "stays stashed", attachments: [image] }, { text: "older", attachments: [] }]);
// Nor a local command, which leaves its files in the box.
sentWith.setText("/context");
sentWith.setAttachments([image]);
sentWith.clearSent(sentWith.capture(), true);
assert.equal(sentWith.text(), "");
assert.equal(sentWith.stashes().length, 2);
sentWith.dispose();

// Home is gone by the time its send has opened the session: its stash is still stashed when it's next shown.
const stashHome = mount("stash-home");
stashHome.setText("for the next session");
stashHome.pushStash();
stashHome.setText("this session first");
const homeSend = stashHome.capture();
stashHome.dispose();
stashHome.clearSent(homeSend);
const homeAgain = mount("stash-home");
assert.equal(homeAgain.text(), "");
assert.deepEqual(homeAgain.stashes().map((d) => d.text), ["for the next session"]);
homeAgain.dispose();

// Discarded, one is gone; Undo puts it back where it was in the list, whatever was stashed meanwhile.
const dropping = mount("stash-drop");
for (const text of ["oldest", "thrown away", "newest"]) {
    dropping.setText(text);
    if (text === "thrown away") dropping.setAttachments([image]);
    dropping.pushStash();
}
const undo = dropping.dropStash(dropping.stashes()[1]!)!;
assert.deepEqual(dropping.stashes().map((d) => d.text), ["newest", "oldest"]);
assert.equal(dropping.text(), "");
undo();
assert.deepEqual(plain(dropping.stashes()), [{ text: "newest", attachments: [] }, { text: "thrown away", attachments: [image] }, { text: "oldest", attachments: [] }]);
undo();
assert.equal(dropping.stashes().length, 3);
const undoLate = dropping.dropStash(dropping.stashes()[1]!)!;
dropping.setText("stashed since");
dropping.pushStash();
undoLate();
assert.deepEqual(dropping.stashes().map((d) => d.text), ["stashed since", "thrown away", "newest", "oldest"]);
assert.equal(dropping.dropStash({ text: "never stashed", attachments: [], at: 0 }), undefined);
dropping.dispose();

// It keeps so many and no more: the prompt stays in the box, until one is brought back or thrown away.
const full = mount("stash-full");
for (let i = 0; i < STASH_LIMIT; i++) {
    full.setText(`prompt ${i}`);
    assert.equal(full.pushStash(), true);
}
full.setText("one too many");
assert.equal(full.pushStash(), "full");
assert.equal(full.text(), "one too many");
assert.equal(full.stashes().length, STASH_LIMIT);
// Picked from the list at the limit, the two still trade places.
assert.equal(full.takeStash(full.stashes()[3]), true);
assert.equal(full.stashes()[0]!.text, "one too many");
assert.equal(full.stashes().length, STASH_LIMIT);
full.dispose();

// A deleted session's stashes go with it, and nothing is stashed there afterwards.
const stashDeleted = mount("stash-deleted", wasDeleted);
stashDeleted.setText("never again");
stashDeleted.setAttachments([image]);
stashDeleted.pushStash();
deleted.add("stash-deleted");
stashDeleted.setText("typed after");
assert.equal(stashDeleted.pushStash(), false);
assert.equal(stashDeleted.takeStash(), false);
stashDeleted.dispose();
deleted.delete("stash-deleted");
const stashGone = mount("stash-deleted", wasDeleted);
assert.deepEqual(stashGone.stashes(), []);
stashGone.dispose();

// Persistence follows live edits, without serializing any attachment content.
const { composerStorage } = await import("../../gui/src/lib/drafts");
const persistent = mount("persistent");
persistent.setText("typed text only");
persistent.setAttachments(files);
assert.equal(composerStorage.draft("persistent"), "typed text only");
persistent.clearSent(persistent.capture());
assert.equal(composerStorage.draft("persistent"), "");
persistent.dispose();

// A late send must not erase persistence for a replacement that is still mounted.
const oldMounted = mount("mounted-replacement");
oldMounted.setText("old");
const oldCapture = oldMounted.capture();
oldMounted.dispose();
const liveReplacement = mount("mounted-replacement");
liveReplacement.setText("new typed work");
oldMounted.clearSent(oldCapture);
assert.equal(composerStorage.draft("mounted-replacement"), "new typed work");
assert.equal(liveReplacement.text(), "new typed work");
liveReplacement.dispose();

// Stashes are saved as their text alone, like a draft: one that was only files doesn't outlive a reload.
const stashReload = mount("stash-reload");
stashReload.setText("stashed across a reload");
stashReload.setAttachments(files);
stashReload.pushStash();
stashReload.setAttachments([image]);
stashReload.pushStash();
assert.deepEqual(composerStorage.stashes("stash-reload").map((st) => st.text), ["stashed across a reload"]);
assert.equal(composerStorage.draft("stash-reload"), "");
stashReload.dispose();
composerStashes.clear();
const stashReloaded = mount("stash-reload");
assert.deepEqual(plain(stashReloaded.stashes()), [{ text: "stashed across a reload", attachments: [] }]);
stashReloaded.dispose();

// Reload drops attachments, but restores the persisted text synchronously.
const reload = mount("reload");
reload.setText("survives reload");
reload.setAttachments(files);
reload.dispose();
composerDrafts.clear();
const reloaded = mount("reload");
assert.equal(reloaded.text(), "survives reload");
assert.deepEqual(reloaded.attachments(), []);
reloaded.dispose();
composerStorage.flush();

// An async attachment read finishing after unmount cannot overwrite the replacement.
oldMounted.setAttachments(files);
oldMounted.setText("too late");
assert.equal(composerStorage.draft("mounted-replacement"), "new typed work");
composerStorage.flush();
