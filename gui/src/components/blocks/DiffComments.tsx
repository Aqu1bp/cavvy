import { createSignal, onMount, Show } from "solid-js";
import { MessageSquare, Pencil, Trash2 } from "lucide-solid";
import { isMod, mod } from "../../lib/platform";
import { composingKey } from "../../lib/composer-menu";

/** Writing a comment (or changing one): Cmd/Ctrl+Enter keeps it, Esc lets it go without closing the pane. */
export function CommentBox(p: { label: string; initial?: string; submitLabel?: string; /** False when it's redrawn while you're typing elsewhere. */ autofocus?: boolean; onSubmit: (text: string) => void; onCancel: () => void; onText?: (text: string) => void }) {
    const [text, setText] = createSignal(p.initial ?? "");
    let ta: HTMLTextAreaElement | undefined;
    const fit = () => {
        if (!ta) return;
        ta.style.height = "auto";
        ta.style.height = `${Math.min(ta.scrollHeight, 240)}px`;
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
    return (
        <div class="dc-box" onPointerDown={(e) => e.stopPropagation()}>
            <textarea
                ref={ta}
                class="dc-input"
                rows={2}
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
                    if (e.key === "Escape") {
                        e.preventDefault();
                        p.onCancel();
                    } else if (e.key === "Enter" && isMod(e)) {
                        e.preventDefault();
                        submit();
                    }
                }}
            />
            <div class="dc-actions">
                <span class="dc-hint">{mod}+Enter to {p.submitLabel ? p.submitLabel.toLowerCase() : "add"} · Esc to cancel</span>
                <button class="btn sm ghost" onClick={() => p.onCancel()}>
                    Cancel
                </button>
                <button class="btn sm primary" disabled={!text().trim()} onClick={submit}>
                    {p.submitLabel ?? "Comment"}
                </button>
            </div>
        </div>
    );
}

/** A comment waiting to be sent, under the line it's about. */
export function CommentCard(p: { label: string; text: string; outdated?: boolean; snippet?: string; onEdit: (text: string) => void; onRemove: () => void; onHover?: (on: boolean) => void }) {
    const [editing, setEditing] = createSignal(false);
    return (
        <Show
            when={!editing()}
            fallback={
                <CommentBox
                    label={p.label}
                    initial={p.text}
                    submitLabel="Save"
                    onSubmit={(t) => {
                        p.onEdit(t);
                        setEditing(false);
                    }}
                    onCancel={() => setEditing(false)}
                />
            }
        >
            <div class={`dc-card ${p.outdated ? "outdated" : ""}`} role="note" aria-label={`Your comment on ${p.label}`} onPointerDown={(e) => e.stopPropagation()} onMouseEnter={() => p.onHover?.(true)} onMouseLeave={() => p.onHover?.(false)}>
                <span class="dc-icon" title="Goes with your next message"><MessageSquare size={14} aria-hidden="true" /></span>
                <div class="dc-body">
                    <div class="dc-meta">
                        <span class="dc-label">{p.label[0]!.toUpperCase() + p.label.slice(1)}</span>
                        <Show when={p.outdated}>
                            <span class="dc-tag" title="These lines changed after you commented. The agent still gets the lines as you saw them.">Outdated</span>
                        </Show>
                    </div>
                    <p class="dc-text">{p.text}</p>
                    <Show when={p.outdated && p.snippet}>
                        <pre class="dc-snippet mono">{p.snippet!.split("\n").slice(1).join("\n")}</pre>
                    </Show>
                </div>
                <span class="dc-tools">
                    <button class="hb sm" title="Edit comment" aria-label={`Edit comment on ${p.label}`} onClick={() => setEditing(true)}>
                        <Pencil size={13} />
                    </button>
                    <button class="hb sm" title="Delete comment" aria-label={`Delete comment on ${p.label}`} onClick={() => p.onRemove()}>
                        <Trash2 size={13} />
                    </button>
                </span>
            </div>
        </Show>
    );
}
