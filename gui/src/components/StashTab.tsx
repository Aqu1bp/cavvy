// The prompt put away with the stash key, as a row inside the composer card:
// click it (or press the key again) to bring it back, or throw it away.

import { Show } from "solid-js";
import { Archive, Paperclip, X } from "lucide-solid";
import { shortcutHint, withShortcut } from "../state/keybindings";

export function StashTab(p: { text: string; attached: number; onRestore: () => void; onDiscard: () => void }) {
    /** Its first line with something on it: a row's worth. */
    const line = () => p.text.trim().split("\n", 1)[0]!.trim();
    // Neither button takes the focus from the box: what's typed next goes there.
    const keepFocus = (e: MouseEvent) => e.preventDefault();
    return (
        <div class="queue stash-tab">
            <div class="goal-row">
                <button class="stash-back" title={withShortcut("Restore", "chat:stash")} aria-label={`Restore the stashed prompt: ${line() || "attachments"}`} onMouseDown={keepFocus} onClick={p.onRestore}>
                    <Archive size={14} class="queue-icon" aria-hidden="true" />
                    <span class="goal-label">Stashed</span>
                    <span class="goal-text truncate">{line()}</span>
                    <Show when={p.attached}>
                        <span class="queue-attached">
                            <Paperclip size={12} /> {p.attached}
                        </span>
                    </Show>
                </button>
                <Show when={shortcutHint("chat:stash")}>{(key) => <kbd aria-hidden="true">{key()}</kbd>}</Show>
                <button class="hb sm" title="Discard" aria-label="Discard the stashed prompt" onMouseDown={keepFocus} onClick={p.onDiscard}>
                    <X size={14} />
                </button>
            </div>
        </div>
    );
}
