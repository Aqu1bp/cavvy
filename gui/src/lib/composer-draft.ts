import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { Attachment } from "../state/actions";

interface Draft {
    text: string;
    attachments: Attachment[];
}

/** Unsent text and images survive replacing the composer when switching sessions. */
type Clear = () => void;
type Receive = (draft: Draft) => Clear;
export const composerDrafts = new Map<string, Draft & { owner: symbol; submitted?: Draft; restored?: (clear: Clear) => void }>();
const mounted = new Map<string, Receive>();

function prepend(draft: Draft, existing?: Draft): Draft {
    return {
        text: existing?.text.trim() ? `${draft.text}\n${existing.text}` : draft.text,
        attachments: existing?.attachments.length ? [...draft.attachments, ...existing.attachments] : draft.attachments,
    };
}

function restore(key: string, draft: Draft): Clear {
    const receive = mounted.get(key);
    if (receive) return receive(draft);
    // The user may have left the new session while its first send was pending.
    // Hand cleanup to its first composer when it eventually mounts.
    const saved = { ...prepend(draft, drafts.get(key)), submitted: draft, owner: Symbol("transferred draft"), restored: (next: Clear) => { clear = next; } };
    let clear = () => {
        if (drafts.get(key) === saved && saved.text === draft.text && saved.attachments === draft.attachments) drafts.delete(key);
    };
    drafts.set(key, saved);
    return () => clear();
}

const drafts = composerDrafts;

export function createComposerDraft(key: () => string, wasDeleted: (key: string) => boolean = () => false) {
    const owner = Symbol("composer");
    const [text, setText] = createSignal("");
    const [attachments, setAttachments] = createSignal<Attachment[]>([]);
    let disposed = false;
    let registered: string | undefined;
    const keep = (key: string) => {
        if (!wasDeleted(key) && (text().trim() || attachments().length)) drafts.set(key, { text: text(), attachments: attachments(), owner });
        else drafts.delete(key);
    };
    createEffect(on(key, (key, prev) => {
        if (prev !== undefined) keep(prev);
        const draft = drafts.get(key);
        setText(draft?.text ?? "");
        setAttachments(draft?.attachments ?? []);
        if (registered !== undefined && mounted.get(registered) === receive) mounted.delete(registered);
        registered = key;
        mounted.set(key, receive);
        if (draft?.restored) {
            const submitted = { ...draft.submitted!, key };
            draft.restored(() => sent(submitted));
            delete draft.restored;
            delete draft.submitted;
        }
    }));
    onCleanup(() => {
        keep(key());
        disposed = true;
        if (registered !== undefined && mounted.get(registered) === receive) mounted.delete(registered);
    });

    const capture = () => ({ key: key(), text: text(), attachments: attachments() });
    const sent = (submitted: ReturnType<typeof capture>) => {
        const matches = (draft: Draft | undefined) => draft?.text === submitted.text && draft.attachments === submitted.attachments;
        // Home is disposed as soon as session creation activates the new session,
        // before sending finishes. Only clear the saved draft if it is still ours.
        const saved = drafts.get(submitted.key);
        if (saved?.owner === owner && matches(saved)) drafts.delete(submitted.key);
        if (!disposed && key() === submitted.key && matches({ text: text(), attachments: attachments() })) {
            setText("");
            setAttachments([]);
        }
    };
    const receive: Receive = (draft) => {
        const submitted = { ...draft, key: key() };
        // Preserve anything typed while the refused send was in flight.
        const next = prepend(draft, { text: text(), attachments: attachments() });
        setText(next.text);
        setAttachments(next.attachments);
        return () => sent(submitted);
    };
    const move = (submitted: ReturnType<typeof capture>, to: string) => {
        // A deletion may arrive before the refusal of a session's first message.
        if (wasDeleted(to)) return () => {};
        const clear = restore(to, submitted);
        sent(submitted);
        return clear;
    };
    return { text, setText, attachments, setAttachments, capture, sent, move };
}
