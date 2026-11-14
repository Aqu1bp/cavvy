import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { FileText, FileX, File as FileIcon, TextCursorInput, X } from "lucide-solid";
import { extensionOf, formatSize, previewNow, previewOf, tintOf, type Attachment, type ImageAttachment } from "../lib/attachments";
import { plural } from "../lib/format";
import { setViewedImage } from "../state/ui";

/** The chip shows at once; its thumbnail, made in a worker, when it's ready. */
function Preview(p: { image: ImageAttachment }) {
    const [src, setSrc] = createSignal<string>();
    let live = true;
    onCleanup(() => (live = false));
    void previewOf(p.image).then((u) => live && setSrc(u));
    return (
        <Show when={src()}>
            <img src={src()} alt={p.image.name} />
        </Show>
    );
}

/**
 * What's attached to the message being written, as tiles of one height: an image's thumbnail, and a card for a
 * file (its kind on a tinted tile, its name, a few words on it). A refused one says why; a PDF the model can't
 * read says so. An image opens full size, text to read, and a paste can go back into the box as text.
 */
export function AttachmentChips(p: { items: Attachment[]; readsPdf: boolean; blocked?: string; onRemove: (i: number) => void; onToText: (i: number) => void }) {
    const [open, setOpen] = createSignal<Attachment>();
    /** The viewer on this image, the whole of it (not the thumbnail), stepping through the others attached. */
    const view = (img: ImageAttachment, from: Element) => {
        const images = p.items.filter((a): a is ImageAttachment => a.kind === "image");
        setViewedImage({ images: images.map((a) => ({ name: a.name, full: a, preview: previewNow(a) })), index: images.indexOf(img), from });
    };
    const shown = () => {
        const a = open();
        return a && a.kind === "text" && p.items.includes(a) ? a : undefined;
    };
    const Remove = (r: { name: string; i: number }) => (
        <button class="att-x" title="Remove" aria-label={`Remove ${r.name}`} onClick={() => p.onRemove(r.i)}>
            <X size={10} stroke-width={2.5} />
        </button>
    );
    return (
        <div class="attachments-wrap">
            <div class="attachments">
                <For each={p.items}>
                    {(a, i) => (
                        <Switch>
                            <Match when={a.kind === "image" && a}>
                                {(img) => (
                                    <div class="att att-image" title={`${img().name} · ${formatSize(img().size)}`}>
                                        <button class="att-open" aria-label={`View ${img().name}`} onClick={(e) => view(img(), e.currentTarget)}>
                                            <Preview image={img()} />
                                        </button>
                                        <Remove name={img().name} i={i()} />
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
                                    const pasted = () => f().kind === "text" && Boolean((f() as { pasted?: boolean }).pasted);
                                    const meta = () => {
                                        const x = f();
                                        return x.kind === "text" ? `${plural(x.lines, "line")} · ${formatSize(x.size)}` : formatSize(x.size);
                                    };
                                    const ext = () => (pasted() ? undefined : extensionOf(f().name));
                                    const isOpen = () => shown() === f();
                                    const Body = () => (
                                        <>
                                            <span class="att-tile" data-tint={problem() ? "bad" : tintOf(f().name)} aria-hidden="true">
                                                <Switch fallback={<FileIcon size={16} />}>
                                                    <Match when={problem()}>
                                                        <FileX size={16} />
                                                    </Match>
                                                    <Match when={pasted()}>
                                                        <FileText size={16} />
                                                    </Match>
                                                    <Match when={ext()}>{(e) => <span class={`att-ext ${e().length > 3 ? "long" : ""}`}>{e()}</span>}</Match>
                                                </Switch>
                                            </span>
                                            <span class="att-body">
                                                <span class="att-name truncate">{f().name}</span>
                                                {/* A model that can't read it: the note under the tiles says so, and what to do. */}
                                                <span class="att-meta truncate">{f().kind === "refused" ? problem() : meta()}</span>
                                            </span>
                                        </>
                                    );
                                    return (
                                        <div class={`att att-file ${problem() ? "refused" : ""} ${isOpen() ? "open" : ""}`} title={problem() ? `${f().name}: ${problem()}` : f().name}>
                                            {/* Text opens below to read; anything else is only what it is. */}
                                            <Show when={f().kind === "text"} fallback={<span class="att-card"><Body /></span>}>
                                                <button class="att-card" aria-expanded={isOpen()} aria-label={`${isOpen() ? "Hide" : "Show"} ${f().name}`} onClick={() => setOpen(isOpen() ? undefined : f())}>
                                                    <Body />
                                                </button>
                                            </Show>
                                            <Show when={pasted()}>
                                                <button class="att-act" title="Put it back in the box as text" aria-label="Put the pasted text back in the box" onClick={() => p.onToText(i())}>
                                                    <TextCursorInput size={14} />
                                                </button>
                                            </Show>
                                            <Remove name={f().name} i={i()} />
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
