// The prompt put away with the stash key: a small chip over the composer's top right corner.
// Click it (or press the key again) to bring the prompt back; its ✕ throws it away.

import { Archive, X } from "lucide-solid";
import { plural } from "../lib/format";
import { withShortcut } from "../state/keybindings";

export function StashChip(p: { text: string; attached: number; onRestore: () => void; onDiscard: () => void }) {
    /** What's in it, in a line: the tooltip, and what a screen reader says. */
    const what = () => {
        const line = p.text.trim().split("\n", 1)[0]!.trim();
        const files = p.attached ? plural(p.attached, "attachment") : "";
        return [line.length > 80 ? `${line.slice(0, 80)}…` : line, files].filter(Boolean).join(" · ");
    };
    // Neither button takes the focus from the box: what's typed next goes there.
    const keepFocus = (e: MouseEvent) => e.preventDefault();
    return (
        <div class="stash-chip card-surface">
            <button class="stash-back" title={withShortcut(`Restore: ${what()}`, "chat:stash")} aria-label={`Restore the stashed prompt: ${what()}`} onMouseDown={keepFocus} onClick={p.onRestore}>
                <Archive size={13} aria-hidden="true" />
                Stash
            </button>
            <button class="stash-drop" title="Discard" aria-label="Discard the stashed prompt" onMouseDown={keepFocus} onClick={p.onDiscard}>
                <X size={13} />
            </button>
        </div>
    );
}
