import { For, Show } from "solid-js";
import { X } from "lucide-solid";
import { linesLabel, linesPhrase, type ReviewComment } from "../lib/review-comments";
import { basename, plural } from "../lib/format";

/**
 * The review comments that go with the next message, one chip each: which lines, what it
 * says. Clicking one shows it in the review pane; × takes it out. With a command or a
 * shell line in the box they wait for the next message instead.
 */
export function ReviewCommentChips(p: { items: readonly ReviewComment[]; held?: string; onOpen: (c: ReviewComment) => void; onRemove: (c: ReviewComment) => void; onClear: () => void }) {
    return (
        <div class="cchips" role="group" aria-label={plural(p.items.length, "review comment")}>
            <div class="cchips-list">
                <For each={p.items}>
                    {(c) => (
                        <span class="cchip">
                            <button class="cchip-main" title={`${c.path}, ${linesPhrase(c)}: ${c.text}`} aria-label={`Show comment on ${c.path}, ${linesPhrase(c)}, in the review`} onClick={() => p.onOpen(c)}>
                                <span class="cchip-loc mono">
                                    {basename(c.path)}:{linesLabel(c)}
                                </span>
                                <span class="cchip-text">{c.text}</span>
                            </button>
                            <button class="cchip-x" title="Remove comment" aria-label={`Remove comment on ${c.path}, ${linesPhrase(c)}`} onClick={() => p.onRemove(c)}>
                                <X size={12} />
                            </button>
                        </span>
                    )}
                </For>
            </div>
            <div class="cchips-foot">
                <span>{p.held ?? `${plural(p.items.length, "review comment")} will be sent with this message`}</span>
                <Show when={p.items.length > 1}>
                    <button class="link-btn" onClick={() => p.onClear()}>
                        Remove all
                    </button>
                </Show>
            </div>
        </div>
    );
}
