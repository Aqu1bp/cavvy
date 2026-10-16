import { createEffect, createSignal, on, onCleanup } from "solid-js";
import type { Attachment } from "../state/actions";

interface Draft {
    text: string;
    attachments: Attachment[];
}

/** Unsent text and images survive replacing the composer when switching sessions. */
export const composerDrafts = new Map<string, Draft & { owner: symbol }>();

const drafts = composerDrafts;

export function createComposerDraft(key: () => string, wasDeleted: (key: string) => boolean = () => false) {
    const owner = Symbol("composer");
    const [text, setText] = createSignal("");
    const [attachments, setAttachments] = createSignal<Attachment[]>([]);
    let disposed = false;
    const keep = (key: string) => {
        if (!wasDeleted(key) && (text().trim() || attachments().length)) drafts.set(key, { text: text(), attachments: attachments(), owner });
        else drafts.delete(key);
    };
    createEffect(on(key, (key, prev) => {
        if (prev !== undefined) keep(prev);
        const draft = drafts.get(key);
        setText(draft?.text ?? "");
        setAttachments(draft?.attachments ?? []);
    }));
    onCleanup(() => {
        keep(key());
        disposed = true;
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
    return { text, setText, attachments, setAttachments, capture, sent };
}
