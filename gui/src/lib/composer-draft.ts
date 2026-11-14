import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { composerStorage } from "./drafts";
import type { Attachment } from "./attachments";

interface Draft {
    text: string;
    attachments: Attachment[];
}

export const composerDrafts = new Map<string, Draft>();
/** What's attached to each stashed prompt. Its text is in composerStorage, so it outlives a reload; these don't, like a draft's. */
export const stashedAttachments = new Map<string, Attachment[]>();
const empty = (): Draft => ({ text: "", attachments: [] });
const filled = (d: Draft) => Boolean(d.text.trim() || d.attachments.length);
/** Counts every change to a stash, so each composer showing it (Home's comes and goes) reads it again. */
const [stashChanges, setStashChanges] = createSignal(0);
function stashOf(key: string): Draft | undefined {
    const d: Draft = { text: composerStorage.stash(key), attachments: stashedAttachments.get(key) ?? [] };
    return filled(d) ? d : undefined;
}

export function createComposerDraft(key: () => string, wasDeleted: (key: string) => boolean = () => false) {
    const [draft, setDraft] = createSignal<Draft>(empty());
    let disposed = false;
    const shows = (k: string) => !disposed && key() === k;
    const putStash = (k: string, d: Draft | undefined) => {
        composerStorage.setStash(k, d?.text ?? "");
        if (d?.attachments.length) stashedAttachments.set(k, d.attachments);
        else stashedAttachments.delete(k);
        setStashChanges((n) => n + 1);
    };
    /** The prompt put away with the stash key, for the draft shown. */
    const stash = createMemo(() => {
        stashChanges();
        return wasDeleted(key()) ? undefined : stashOf(key());
    });
    /** In the box, whether or not this composer still shows it (Home is gone once its send opens the session). */
    const putDraft = (k: string, d: Draft) => {
        if (filled(d)) composerDrafts.set(k, d);
        else composerDrafts.delete(k);
        composerStorage.setDraft(k, d.text);
        if (shows(k)) setDraft(d);
    };
    const keep = (key: string) => {
        // Switching sessions keeps unsent work; deleting one must not bring its draft back.
        if (!wasDeleted(key) && (draft().text.trim() || draft().attachments.length)) composerDrafts.set(key, draft());
        else composerDrafts.delete(key);
        if (wasDeleted(key)) {
            composerStorage.delete(key);
            stashedAttachments.delete(key);
        }
    };
    createEffect(on(key, (key, prev) => {
        if (prev !== undefined) keep(prev);
        // A replacement composer gets its own copy, safe from an old send's callback.
        composerStorage.refresh();
        setDraft({ text: composerStorage.draft(key), attachments: composerDrafts.get(key)?.attachments ?? [] });
        keep(key);
    }));
    onCleanup(() => {
        keep(key());
        disposed = true;
    });

    const capture = () => ({ key: key(), draft: draft() });
    /** What was sent is still what's in the box: nothing typed or attached since, and no other draft shown. */
    const holds = (submitted: ReturnType<typeof capture>) => !disposed && key() === submitted.key && draft() === submitted.draft;
    const clearSent = (submitted: ReturnType<typeof capture>, keepAttachments = false) => {
        // Local commands never send the files, so leave them ready for the next message.
        const cleared = keepAttachments ? { text: "", attachments: submitted.draft.attachments } : empty();
        let emptied = false;
        // Opening a new session can unmount Home before its successful send returns.
        if (composerDrafts.get(submitted.key) === submitted.draft) {
            if (cleared.attachments.length) composerDrafts.set(submitted.key, cleared);
            else composerDrafts.delete(submitted.key);
            composerStorage.setDraft(submitted.key, "");
            emptied = true;
        }
        // Each edit replaces the draft, so a late retry cannot clear newer typing or attachments.
        if (holds(submitted)) {
            setDraft(cleared);
            composerStorage.setDraft(submitted.key, "");
            emptied = true;
        }
        // The box this send left free takes the stashed prompt back. Never over something newer in it.
        const back = emptied && !filled(cleared) && !wasDeleted(submitted.key) ? stashOf(submitted.key) : undefined;
        if (back) {
            putStash(submitted.key, undefined);
            putDraft(submitted.key, back);
        }
        // Successful sends must be removed even if the window closes before the debounce.
        composerStorage.flush();
    };
    const setText = (value: string | ((text: string) => string)) => {
        if (disposed) return;
        setDraft((d) => ({ ...d, text: typeof value === "function" ? value(d.text) : value }));
        keep(key());
        composerStorage.setDraft(key(), wasDeleted(key()) ? "" : draft().text);
    };
    const setAttachments = (value: Attachment[] | ((attachments: Attachment[]) => Attachment[])) => {
        if (disposed) return;
        setDraft((d) => ({ ...d, attachments: typeof value === "function" ? value(d.attachments) : value }));
        keep(key());
    };
    /**
     * The stash key: what's in the box is put away, and what was put away comes back; with both, they trade
     * places. False with neither.
     */
    const swapStash = () => {
        const k = key();
        if (disposed || wasDeleted(k)) return false;
        const away = filled(draft()) ? draft() : undefined;
        const back = stash();
        if (!away && !back) return false;
        putStash(k, away);
        putDraft(k, back ?? empty());
        return true;
    };
    /** Throws the stashed prompt away. Returns the way back (Undo): to the stash, or after what's in the box if another prompt is stashed by then. */
    const dropStash = () => {
        const k = key();
        const dropped = stash();
        if (disposed || !dropped) return undefined;
        putStash(k, undefined);
        return () => {
            if (wasDeleted(k)) return;
            if (!stashOf(k)) return putStash(k, dropped);
            const box: Draft = { text: composerStorage.draft(k), attachments: composerDrafts.get(k)?.attachments ?? [] };
            putDraft(k, { text: [box.text.trimEnd(), dropped.text].filter(Boolean).join("\n\n"), attachments: [...box.attachments, ...dropped.attachments] });
        };
    };
    return { text: () => draft().text, setText, attachments: () => draft().attachments, setAttachments, capture, clearSent, holds, stash, swapStash, dropStash };
}
