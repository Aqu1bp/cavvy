// The prompts put away with the stash key: a tab standing on the composer's top edge, at its far end.
// Click it and it opens along the card into their list, newest first: a row brings its prompt back,
// its ✕ throws it away.

import { createEffect, createSignal, createUniqueId, For, onCleanup, Show } from "solid-js";
import { Archive, ChevronDown, FileText, Paperclip, X } from "lucide-solid";
import type { Stashed } from "../lib/composer-draft";
import { now } from "../lib/clock";
import { ago, plural } from "../lib/format";

/** Its first line with something on it: a row's worth. */
const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.trim();

export function StashTray(p: { items: Stashed[]; /** The message box: where the focus goes when the list closes. */ box: () => HTMLElement | undefined; onRestore: (item: Stashed) => void; onDiscard: (item: Stashed) => void }) {
    const [open, setOpen] = createSignal(false);
    const listId = `stash-${createUniqueId()}`;
    let root: HTMLDivElement | undefined;
    const files = (item: Stashed) => (item.attachments.length ? plural(item.attachments.length, "attachment") : "");
    const said = (item: Stashed) => [firstLine(item.text), files(item)].filter(Boolean).join(", ");
    // Home: it takes no room in the column, so the question above the composer moves up by its height (home.css).
    createEffect(() => {
        const height = open() && p.items.length ? "open" : "";
        const home = root?.closest<HTMLElement>(".home");
        if (!home) return;
        const frame = requestAnimationFrame(() => home.style.setProperty("--stash-lift", height ? `${root!.offsetHeight}px` : "0px"));
        onCleanup(() => cancelAnimationFrame(frame));
    });
    onCleanup(() => root?.closest<HTMLElement>(".home")?.style.removeProperty("--stash-lift"));
    const picks = () => [...(root?.querySelectorAll<HTMLElement>(".stash-pick") ?? [])];
    const onKeyDown = (e: KeyboardEvent) => {
        if (e.key === "Escape" && open()) {
            // Its own Esc: closes the list, never stops the turn.
            e.preventDefault();
            e.stopPropagation();
            setOpen(false);
            p.box()?.focus();
            return;
        }
        const rows = picks();
        const at = rows.indexOf(document.activeElement as HTMLElement);
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            if (!rows.length) return;
            e.preventDefault();
            rows[(at + (e.key === "ArrowDown" ? 1 : -1) + rows.length) % rows.length]?.focus();
        } else if ((e.key === "Delete" || e.key === "Backspace") && at >= 0) {
            e.preventDefault();
            const item = p.items[at];
            if (!item) return;
            p.onDiscard(item);
            // The keys stay in the list, on the row that took its place; with none left, they go back to the box.
            requestAnimationFrame(() => (picks()[Math.min(at, picks().length - 1)] ?? p.box())?.focus());
        }
    };
    // Its buttons don't take the focus from the box when clicked: what's typed next goes there.
    const keepFocus = (e: MouseEvent) => e.preventDefault();
    return (
        <div ref={root} class="stash-tray" classList={{ open: open() }} onKeyDown={onKeyDown}>
            <button class="stash-head" aria-expanded={open()} aria-controls={open() ? listId : undefined} aria-label={`Stashed prompts: ${p.items.length}`} title={open() ? undefined : "Stashed prompts"} onMouseDown={keepFocus} onClick={() => setOpen(!open())}>
                <Archive size={13} aria-hidden="true" />
                <span class="stash-word">Stash</span>
                <Show when={open() || p.items.length > 1}>
                    <span class="stash-n num">{p.items.length}</span>
                </Show>
                <Show when={open()}>
                    <ChevronDown size={14} class="chev" aria-hidden="true" />
                </Show>
            </button>
            <Show when={open()}>
                <div class="stash-list" id={listId} role="list">
                    <For each={p.items}>
                        {(item) => (
                            <div class="stash-row" role="listitem">
                                <button class="stash-pick" title="Restore" aria-label={`Restore: ${said(item)}`} aria-keyshortcuts="Delete" onMouseDown={keepFocus} onClick={() => p.onRestore(item)}>
                                    <FileText size={14} aria-hidden="true" />
                                    <span class="stash-text truncate">{firstLine(item.text) || files(item)}</span>
                                    <Show when={item.attachments.length && firstLine(item.text)}>
                                        <span class="queue-attached">
                                            <Paperclip size={12} /> {item.attachments.length}
                                        </span>
                                    </Show>
                                    <span class="stash-when">{(now(), ago(item.at))}</span>
                                </button>
                                <button class="stash-drop" tabIndex={-1} title="Discard" aria-label={`Discard: ${said(item)}`} onMouseDown={keepFocus} onClick={() => p.onDiscard(item)}>
                                    <X size={14} />
                                </button>
                            </div>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}
