// The prompts put away with the stash key: a small chip over the composer's top right corner.
// Click it for the list, newest first: pick one to bring it back, or throw one away.

import { createSignal, For, Show } from "solid-js";
import { Archive, Paperclip, X } from "lucide-solid";
import type { Attachment } from "../lib/attachments";
import { plural } from "../lib/format";
import { shortcutHint } from "../state/keybindings";
import { Menu } from "./ui/Menu";

interface Stashed {
    text: string;
    attachments: Attachment[];
}

/** Its first line with something on it: a row's worth. */
const firstLine = (text: string) => text.trim().split("\n", 1)[0]!.trim();

export function StashChip(p: { items: Stashed[]; placement: "top" | "bottom"; /** The message box: where the focus goes when the list closes. */ box: () => HTMLElement | undefined; onRestore: (item: Stashed) => void; onDiscard: (item: Stashed) => void }) {
    const [open, setOpen] = createSignal(false);
    let anchor: HTMLButtonElement | undefined;
    let list: HTMLDivElement | undefined;
    const said = (item: Stashed) => [firstLine(item.text), item.attachments.length ? plural(item.attachments.length, "attachment") : ""].filter(Boolean).join(", ");
    // The list closes: its Undo is a toast, which the list would cover.
    const discard = (item: Stashed) => {
        setOpen(false);
        p.onDiscard(item);
    };
    return (
        <>
            <button
                ref={anchor}
                class="stash-chip card-surface"
                classList={{ open: open() }}
                aria-haspopup="menu"
                aria-expanded={open()}
                aria-label={`Stashed prompts: ${p.items.length}`}
                title="Stashed prompts"
                onClick={() => setOpen(!open())}
            >
                <Archive size={13} aria-hidden="true" />
                Stash
                <Show when={p.items.length > 1}>
                    <span class="stash-n num">{p.items.length}</span>
                </Show>
            </button>
            <Menu
                label="Stashed prompts"
                open={open()}
                anchor={() => anchor}
                onClose={() => setOpen(false)}
                returnFocus={p.box}
                placement={p.placement}
                align="end"
                width={380}
                maxHeight={320}
                onKeyDown={(e) => {
                    if (e.key !== "Delete" && e.key !== "Backspace") return;
                    const rows = [...(list?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
                    const item = p.items[rows.indexOf(document.activeElement as HTMLElement)];
                    if (!item) return;
                    e.preventDefault();
                    discard(item);
                }}
            >
                <div class="stash-menu" ref={list}>
                    <div class="menu-head">
                        <span>Stashed</span>
                        <Show when={shortcutHint("chat:stash")}>{(key) => <kbd>{key()}</kbd>}</Show>
                    </div>
                    <For each={p.items}>
                        {(item) => (
                            <div class="stash-row">
                                <button
                                    class="menu-item"
                                    role="menuitem"
                                    aria-label={`Restore: ${said(item)}`}
                                    aria-keyshortcuts="Delete"
                                    onClick={() => {
                                        setOpen(false);
                                        p.onRestore(item);
                                    }}
                                >
                                    <span class="menu-label truncate">{firstLine(item.text)}</span>
                                    <Show when={item.attachments.length}>
                                        <span class="queue-attached">
                                            <Paperclip size={12} /> {item.attachments.length}
                                        </span>
                                    </Show>
                                </button>
                                <button class="stash-drop" tabIndex={-1} title="Discard" aria-label={`Discard: ${said(item)}`} onClick={() => discard(item)}>
                                    <X size={13} />
                                </button>
                            </div>
                        )}
                    </For>
                </div>
            </Menu>
        </>
    );
}
