import { createSignal, onMount, Show } from "solid-js";
import { Pencil, Trash2 } from "lucide-solid";
import { isMod, mod } from "../../lib/platform";
import { composingKey } from "../../lib/composer-menu";

/** Writing a comment (or changing one): Cmd/Ctrl+Enter keeps it, Esc lets it go without closing the pane. */
export function CommentBox(p: { label: string; initial?: string; submitLabel?: string; /** False when it's redrawn while you're typing elsewhere. */ autofocus?: boolean; /** The saved comment it changes, if any. */ editing?: string; onSubmit: (text: string) => void; onCancel: () => void; onText?: (text: string) => void }) {
    const [text, setText] = createSignal(p.initial ?? "");
    let ta: HTMLTextAreaElement | undefined;
    const fit = () => {
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    };
    onMount(() => {
        if (p.autofocus === false) return void requestAnimationFrame(fit);
        // At once, so keys typed right after the click land here.
        ta?.focus({ preventScroll: true });
        ta?.setSelectionRange(ta.value.length, ta.value.length);
        requestAnimationFrame(() => {
            ta?.scrollIntoView({ block: "nearest" });
            fit();
        });
    });
    const submit = () => {
        if (text().trim()) p.onSubmit(text().trim());
    };
    const label = () => p.label[0]!.toUpperCase() + p.label.slice(1);
    return (
        <form
            class="rv-comment rv-comment-box dc-box"
            data-edit={p.editing}
            onSubmit={(e) => {
                e.preventDefault();
                submit();
            }}
            onPointerDown={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
                // From the text or either button: the box closes, the review pane stays.
                if (e.key !== "Escape" || composingKey(e)) return;
                e.preventDefault();
                p.onCancel();
            }}
        >
            <textarea
                ref={ta}
                rows={1}
                value={text()}
                placeholder="Leave a comment for the agent…"
                aria-label={`Comment on ${p.label}`}
                onInput={(e) => {
                    setText(e.currentTarget.value);
                    p.onText?.(e.currentTarget.value);
                    fit();
                }}
                onKeyDown={(e) => {
                    if (composingKey(e)) return;
                    if (e.key === "Enter" && isMod(e)) {
                        e.preventDefault();
                        submit();
                    }
                }}
            />
            <div class="rv-comment-foot">
                <span class="rv-comment-lines">{label()}</span>
                <span class="grow" />
                <button type="button" class="btn btn-sm btn-ghost" title="Esc" onClick={() => p.onCancel()}>
                    Cancel
                </button>
                <button type="submit" class="btn btn-sm btn-primary" title={`${mod}+Enter`} disabled={!text().trim()}>
                    {p.submitLabel ?? "Comment"}
                </button>
            </div>
        </form>
    );
}

/** Changing saved comments: kept by the diff, not the card, since a refresh draws the cards again. */
export interface CommentEdits {
    /** What's written so far, for a comment being changed. */
    text(id: string): string | undefined;
    set(id: string, text: string | undefined): void;
    /** Whether its box takes the focus when drawn: on Edit, or again after a refresh if it had it. */
    takeFocus(id: string): boolean;
}

/** A comment waiting to be sent, under the line it's about. */
export function CommentCard(p: { id: string; label: string; text: string; edits: CommentEdits; outdated?: boolean; snippet?: string; onEdit: (text: string) => void; onRemove: () => void; onHover?: (on: boolean) => void }) {
    return (
        <Show
            when={p.edits.text(p.id) === undefined}
            fallback={
                <CommentBox
                    label={p.label}
                    initial={p.edits.text(p.id)}
                    submitLabel="Save"
                    autofocus={p.edits.takeFocus(p.id)}
                    editing={p.id}
                    onText={(t) => p.edits.set(p.id, t)}
                    onSubmit={(t) => {
                        p.onEdit(t);
                        p.edits.set(p.id, undefined);
                    }}
                    onCancel={() => p.edits.set(p.id, undefined)}
                />
            }
        >
            <div class="rv-comment" data-outdated={p.outdated || undefined} role="note" aria-label={`Your comment on ${p.label}`} onPointerDown={(e) => e.stopPropagation()} onMouseEnter={() => p.onHover?.(true)} onMouseLeave={() => p.onHover?.(false)}>
                <div class="rv-comment-main">
                    <p class="rv-comment-text">{p.text}</p>
                    <Show when={p.outdated && p.snippet}>
                        <pre class="rv-comment-snippet mono">{p.snippet!.split("\n").slice(1).join("\n")}</pre>
                    </Show>
                    <p class="rv-comment-meta">
                        <span class="rv-comment-lines">{p.label[0]!.toUpperCase() + p.label.slice(1)}</span>
                        <Show when={p.outdated}>
                            <span class="tag" data-tone="amber" title="Changed since you commented. The agent gets the lines you saw.">Outdated</span>
                        </Show>
                    </p>
                </div>
                <div class="rv-comment-actions">
                    <button class="icon-btn icon-btn-sm" title="Edit comment" aria-label={`Edit comment on ${p.label}`} onClick={() => p.edits.set(p.id, p.text)}>
                        <Pencil size={13} />
                    </button>
                    <button class="icon-btn icon-btn-sm" title="Delete comment" aria-label={`Delete comment on ${p.label}`} onClick={() => p.onRemove()}>
                        <Trash2 size={13} />
                    </button>
                </div>
            </div>
        </Show>
    );
}
