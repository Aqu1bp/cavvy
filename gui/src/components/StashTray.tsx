// The prompts put away with the stash key: a tab standing on the composer's top edge, at its far end.
// Click it and their list opens above it, newest first: a row brings its prompt back, its ✕ throws it away.

import { createSignal, createUniqueId, For, Show } from "solid-js";
import { Paperclip, X } from "lucide-solid";
import { Popover } from "./ui/Popover";
import type { Attachment } from "../lib/attachments";
import { plural } from "../lib/format";

interface Stashed {
    text: string;
    attachments: Attachment[];
}

/** Its first line with something on it: a row's worth. */
const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.trim();

export function StashTray(p: { items: Stashed[]; /** The message box: where the focus goes when the list closes. */ box: () => HTMLElement | undefined; onRestore: (item: Stashed) => void; onDiscard: (item: Stashed) => void }) {
    const [open, setOpen] = createSignal(false);
    const listId = `stash-${createUniqueId()}`;
    let tab: HTMLButtonElement | undefined;
    let root: HTMLDivElement | undefined;
    const files = (item: Stashed) => (item.attachments.length ? plural(item.attachments.length, "attachment") : "");
    const said = (item: Stashed) => [firstLine(item.text), files(item)].filter(Boolean).join(", ");
    const picks = () => [...(root?.querySelectorAll<HTMLElement>(".stash-text") ?? [])];
    // Closed by Escape or a click elsewhere: the keys go back to the box.
    const close = () => {
        setOpen(false);
        p.box()?.focus();
    };
    const onKeyDown = (e: KeyboardEvent) => {
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
        <>
            <button ref={tab} class="stash-tab" aria-expanded={open()} aria-controls={open() ? listId : undefined} aria-label={`Stashed prompts: ${p.items.length}`} title={open() ? undefined : "Stashed prompts"} onMouseDown={keepFocus} onClick={() => setOpen(!open())}
                onKeyDown={(e) => {
                    // ↓ or ↑ on the tab goes into the list (opening it).
                    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
                    e.preventDefault();
                    setOpen(true);
                    requestAnimationFrame(() => (e.key === "ArrowDown" ? picks()[0] : picks().at(-1))?.focus());
                }}>
                Stash
                <span class="num">{p.items.length}</span>
            </button>
            <Popover open={open()} anchor={() => tab} onClose={close} placement="top" align="end" offset={6} width={340} maxHeight={300} class="menu stash-list">
                <div ref={root} id={listId} role="list" onKeyDown={onKeyDown}>
                    <For each={p.items}>
                        {(item) => (
                            <div class="stash-row" role="listitem">
                                <button class="stash-text" title="Restore" aria-label={`Restore: ${said(item)}`} aria-keyshortcuts="Delete" onMouseDown={keepFocus} onClick={() => (setOpen(false), p.onRestore(item))}>
                                    {firstLine(item.text) || files(item)}
                                    <Show when={item.attachments.length && firstLine(item.text)}>
                                        <span class="queue-attached">
                                            {" "}
                                            <Paperclip size={12} /> {item.attachments.length}
                                        </span>
                                    </Show>
                                </button>
                                <button class="icon-btn icon-btn-sm" tabIndex={-1} title="Discard" aria-label={`Discard: ${said(item)}`} onMouseDown={keepFocus} onClick={() => p.onDiscard(item)}>
                                    <X size={13} />
                                </button>
                            </div>
                        )}
                    </For>
                </div>
            </Popover>
        </>
    );
}
