import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { composerStorage } from "./drafts";
import type { Attachment } from "./attachments";

interface Draft {
    text: string;
    attachments: Attachment[];
}

export const composerDrafts = new Map<string, Draft>();
const empty = (): Draft => ({ text: "", attachments: [] });

export function createComposerDraft(key: () => string, wasDeleted: (key: string) => boolean = () => false) {
    const [draft, setDraft] = createSignal<Draft>(empty());
    let disposed = false;
    const keep = (key: string) => {
        // Switching sessions keeps unsent work; deleting one must not bring its draft back.
        if (!wasDeleted(key) && (draft().text.trim() || draft().attachments.length)) composerDrafts.set(key, draft());
        else composerDrafts.delete(key);
        composerStorage.setDraft(key, wasDeleted(key) ? "" : draft().text);
    };
    createEffect(on(key, (key, prev) => {
        if (prev !== undefined) keep(prev);
        // A replacement composer gets its own copy, safe from an old send's callback.
        setDraft({ ...(composerDrafts.get(key) ?? { text: composerStorage.draft(key), attachments: [] }) });
        keep(key);
    }));
    onCleanup(() => {
        keep(key());
        disposed = true;
    });

    const capture = () => ({ key: key(), draft: draft() });
    const clearSent = (submitted: ReturnType<typeof capture>, keepAttachments = false) => {
        // Local commands never send the files, so leave them ready for the next message.
        const cleared = keepAttachments ? { text: "", attachments: submitted.draft.attachments } : empty();
        // Opening a new session can unmount Home before its successful send returns.
        if (composerDrafts.get(submitted.key) === submitted.draft) {
            if (cleared.attachments.length) composerDrafts.set(submitted.key, cleared);
            else composerDrafts.delete(submitted.key);
            composerStorage.setDraft(submitted.key, "");
        }
        // Each edit replaces the draft, so a late retry cannot clear newer typing or attachments.
        if (!disposed && key() === submitted.key && draft() === submitted.draft) {
            setDraft(cleared);
            composerStorage.setDraft(submitted.key, "");
        }
        // Successful sends must be removed even if the window closes before the debounce.
        composerStorage.flush();
    };
    const setText = (value: string | ((text: string) => string)) => {
        if (disposed) return;
        setDraft((d) => ({ ...d, text: typeof value === "function" ? value(d.text) : value }));
        keep(key());
    };
    const setAttachments = (value: Attachment[] | ((attachments: Attachment[]) => Attachment[])) => {
        if (disposed) return;
        setDraft((d) => ({ ...d, attachments: typeof value === "function" ? value(d.attachments) : value }));
        keep(key());
    };
    return { text: () => draft().text, setText, attachments: () => draft().attachments, setAttachments, capture, clearSent };
}
