import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { composerStorage, STASH_LIMIT } from "./drafts";
import type { Attachment } from "./attachments";

interface Draft {
    text: string;
    attachments: Attachment[];
}

export const composerDrafts = new Map<string, Draft>();
/**
 * Each composer's stashed prompts, newest first, with what's attached. Their texts are in composerStorage too, so they
 * outlive a reload; attachments don't, like a draft's (and a stash that was only attachments goes with them).
 */
export const composerStashes = new Map<string, Draft[]>();
const empty = (): Draft => ({ text: "", attachments: [] });
const filled = (d: Draft) => Boolean(d.text.trim() || d.attachments.length);
/** Counts every change to a stash, so each composer showing it (Home's comes and goes) reads it again. */
const [stashChanges, setStashChanges] = createSignal(0);
function stashesOf(key: string): Draft[] {
    const saved = composerStorage.stashes(key);
    const held = composerStashes.get(key) ?? [];
    const texts = held.filter((d) => d.text.trim()).map((d) => d.text);
    if (texts.length === saved.length && texts.every((text, i) => text === saved[i])) return held;
    // Saved ones this page hasn't seen (a reload, another window): as saved, each keeping what was attached to it here.
    const pool = [...held];
    const next = saved.map((text) => {
        const i = pool.findIndex((d) => d.text === text);
        return i < 0 ? { text, attachments: [] } : pool.splice(i, 1)[0]!;
    });
    if (next.length) composerStashes.set(key, next);
    else composerStashes.delete(key);
    return next;
}
function putStashes(key: string, list: Draft[]) {
    if (list.length) composerStashes.set(key, list);
    else composerStashes.delete(key);
    composerStorage.setStashes(key, list.filter((d) => d.text.trim()).map((d) => d.text));
    setStashChanges((n) => n + 1);
}

export function createComposerDraft(key: () => string, wasDeleted: (key: string) => boolean = () => false) {
    const [draft, setDraft] = createSignal<Draft>(empty());
    let disposed = false;
    const shows = (k: string) => !disposed && key() === k;
    /** The prompts put away with the stash key, newest first, for the draft shown. */
    const stashes = createMemo(() => {
        stashChanges();
        return wasDeleted(key()) ? [] : stashesOf(key());
    });
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
            composerStashes.delete(key);
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
        // Opening a new session can unmount Home before its successful send returns.
        if (composerDrafts.get(submitted.key) === submitted.draft) {
            if (cleared.attachments.length) composerDrafts.set(submitted.key, cleared);
            else composerDrafts.delete(submitted.key);
            composerStorage.setDraft(submitted.key, "");
        }
        // Each edit replaces the draft, so a late retry cannot clear newer typing or attachments.
        if (holds(submitted)) {
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
        composerStorage.setDraft(key(), wasDeleted(key()) ? "" : draft().text);
    };
    const setAttachments = (value: Attachment[] | ((attachments: Attachment[]) => Attachment[])) => {
        if (disposed) return;
        setDraft((d) => ({ ...d, attachments: typeof value === "function" ? value(d.attachments) : value }));
        keep(key());
    };
    /** Puts what's in the box away, on top of the others stashed. "full": there are as many as it keeps. */
    const pushStash = (): boolean | "full" => {
        const k = key();
        if (disposed || wasDeleted(k) || !filled(draft())) return false;
        const list = stashesOf(k);
        if (list.length >= STASH_LIMIT) return "full";
        putStashes(k, [draft(), ...list]);
        putDraft(k, empty());
        return true;
    };
    /** Brings a stashed prompt back into the box (the newest by default). What was in the box, if anything, is stashed in its place, as the newest. */
    const takeStash = (which?: Draft) => {
        const k = key();
        if (disposed || wasDeleted(k)) return false;
        const list = stashesOf(k);
        const back = which ?? list[0];
        if (!back || !list.includes(back)) return false;
        const rest = list.filter((d) => d !== back);
        putStashes(k, filled(draft()) ? [draft(), ...rest] : rest);
        putDraft(k, back);
        return true;
    };
    /** Throws a stashed prompt away. Returns the way back (Undo): to where it was in the list. */
    const dropStash = (which: Draft) => {
        const k = key();
        const at = stashesOf(k).indexOf(which);
        if (disposed || at < 0) return undefined;
        putStashes(k, stashesOf(k).filter((d) => d !== which));
        return () => {
            if (wasDeleted(k)) return;
            const list = stashesOf(k);
            if (!list.includes(which)) putStashes(k, [...list.slice(0, at), which, ...list.slice(at)]);
        };
    };
    return { text: () => draft().text, setText, attachments: () => draft().attachments, setAttachments, capture, clearSent, holds, stashes, pushStash, takeStash, dropStash };
}
