import { createSignal, For, Match, Show, Switch } from "solid-js";
import { ChevronDown, File, FileText, FileX, TextCursorInput, X } from "lucide-solid";
import { formatSize, type Attachment } from "../lib/attachments";
import { plural } from "../lib/format";

/**
 * What's attached to the message being written: image thumbnails, and chips
 * for files (name, size, kind). A refused file says why; a PDF the model
 * can't read says so. Text can be opened to read, and a paste turned back
 * into text in the box.
 */
export function AttachmentChips(p: { items: Attachment[]; readsPdf: boolean; blocked?: string; onRemove: (i: number) => void; onToText: (i: number) => void }) {
    const [open, setOpen] = createSignal<Attachment>();
    const shown = () => {
        const a = open();
        return a && a.kind === "text" && p.items.includes(a) ? a : undefined;
    };
    return (
        <div class="attachments-wrap">
            <div class="attachments">
                <For each={p.items}>
                    {(a, i) => (
                        <Switch>
                            <Match when={a.kind === "image" && a}>
                                {(img) => (
                                    <div class="attachment" title={`${img().name} · ${formatSize(img().size)}`}>
                                        <img src={img().preview} alt={img().name} />
                                        <button class="attachment-x" title="Remove" aria-label={`Remove ${img().name}`} onClick={() => p.onRemove(i())}>
                                            <X size={11} />
                                        </button>
                                    </div>
                                )}
                            </Match>
                            <Match when={a.kind !== "image" && a}>
                                {(f) => {
                                    const problem = () => {
                                        const x = f();
                                        if (x.kind === "refused") return x.reason;
                                        if (x.kind === "pdf" && !p.readsPdf) return "This model can't read PDFs";
                                        return undefined;
                                    };
                                    const meta = () => {
                                        const x = f();
                                        if (x.kind === "text") return `${x.pasted ? "Pasted" : "Text"} · ${plural(x.lines, "line")} · ${formatSize(x.size)}`;
                                        if (x.kind === "pdf") return `PDF · ${formatSize(x.size)}`;
                                        return `Refused · ${formatSize(x.size)}`;
                                    };
                                    return (
                                        <div class={`file-chip ${problem() ? "refused" : ""} ${shown() === f() ? "open" : ""}`} title={problem() ? `${f().name}: ${problem()}` : f().name}>
                                            <span class="file-chip-icon">
                                                <Switch fallback={<File size={15} />}>
                                                    <Match when={problem()}>
                                                        <FileX size={15} />
                                                    </Match>
                                                    <Match when={f().kind === "text"}>
                                                        <FileText size={15} />
                                                    </Match>
                                                </Switch>
                                            </span>
                                            <span class="file-chip-body">
                                                <span class="file-chip-name truncate">{f().name}</span>
                                                <span class="file-chip-meta truncate">{problem() ?? meta()}</span>
                                            </span>
                                            <Show when={f().kind === "text"}>
                                                <button class="hb sm" title={shown() === f() ? "Hide" : "Show what's in it"} aria-label={shown() === f() ? `Hide ${f().name}` : `Show ${f().name}`} aria-expanded={shown() === f()} onClick={() => setOpen(shown() === f() ? undefined : f())}>
                                                    <ChevronDown size={13} class={shown() === f() ? "flip" : ""} />
                                                </button>
                                            </Show>
                                            <Show when={f().kind === "text" && (f() as { pasted?: boolean }).pasted}>
                                                <button class="hb sm" title="Put it back in the box as text" aria-label="Put the pasted text back in the box" onClick={() => p.onToText(i())}>
                                                    <TextCursorInput size={13} />
                                                </button>
                                            </Show>
                                            <button class="hb sm" title="Remove" aria-label={`Remove ${f().name}`} onClick={() => p.onRemove(i())}>
                                                <X size={13} />
                                            </button>
                                        </div>
                                    );
                                }}
                            </Match>
                        </Switch>
                    )}
                </For>
            </div>
            <Show when={shown()}>{(t) => <pre class="attachment-preview mono">{t().text.length > 100_000 ? `${t().text.slice(0, 100_000)}\n… (${plural(t().lines, "line")} in all)` : t().text}</pre>}</Show>
            <Show when={p.blocked}>
                <div class="attachments-note">{p.blocked}</div>
            </Show>
        </div>
    );
}
