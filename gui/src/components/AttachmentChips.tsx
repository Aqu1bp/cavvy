import { createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { ArrowDown, FileX, File as FileIcon, Image as ImageIcon, MessageSquareText, Type, X } from "lucide-solid";
import { extensionOf, formatSize, previewNow, previewOf, type Attachment, type ImageAttachment } from "../lib/attachments";
import { plural } from "../lib/format";
import { setViewedImage } from "../state/ui";
import { Markdown } from "./blocks/Markdown";

/** Under this (its longer side, in pixels) an image is too small to make out in a chip: its name is shown instead. */
const TINY = 24;

/** The chip shows at once; its thumbnail, made in a worker, when it's ready. `onSize`: how big it is, once drawn (0 × 0: it couldn't be). */
function Preview(p: { image: ImageAttachment; onSize: (w: number, h: number) => void }) {
    const [src, setSrc] = createSignal<string>();
    let live = true;
    onCleanup(() => (live = false));
    void previewOf(p.image).then((u) => live && setSrc(u));
    return (
        <Show when={src()}>
            <img src={src()} alt={p.image.name} onLoad={(e) => p.onSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} onError={() => p.onSize(0, 0)} />
        </Show>
    );
}

/**
 * What's attached to the message being written, as tiles of one height: an image's thumbnail, and a card for a
 * file (its kind on a tinted tile, its name, a few words on it). A refused one says why; a PDF the model can't
 * read says so. An image opens full size, text to read, and a paste can go back into the box as text.
 */
export function AttachmentChips(p: { items: Attachment[]; readsPdf: boolean; blocked?: string; onRemove: (i: number) => void; onToText?: (i: number) => void }) {
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
            <X size={11} stroke-width={2.6} />
        </button>
    );
    return (
        <div class="atts">
            <div class="atts-list">
                <For each={p.items}>
                    {(a, i) => (
                        <Switch>
                            <Match when={a.kind === "image" && a}>
                                {(img) => {
                                    const [size, setSize] = createSignal<[number, number]>();
                                    /** Too small to make out at the chip's size, or not drawn: a card with its name, as a file's. */
                                    const named = () => {
                                        const s = size();
                                        return Boolean(s && Math.max(s[0], s[1]) < TINY);
                                    };
                                    /** Smaller than the chip: shown at its own size, not blown up. */
                                    const small = () => {
                                        const s = size();
                                        return Boolean(s && (s[0] < 52 || s[1] < 52));
                                    };
                                    return (
                                        <span class={`att ${named() ? "att-file" : "att-image"} ${small() ? "small" : ""}`} title={`${img().name} · ${formatSize(img().size)}`}>
                                            <button class={named() ? "att-main" : "att-thumb"} aria-label={`View ${img().name}`} onClick={(e) => view(img(), e.currentTarget)}>
                                                <Show when={named()} fallback={<Preview image={img()} onSize={(w, h) => setSize([w, h])} />}>
                                                    <span class="att-ext" aria-hidden="true">
                                                        <ImageIcon size={13} />
                                                    </span>
                                                    <span class="att-text">
                                                        <span class="att-name">{img().name}</span>
                                                        <span class="att-meta">{size()![0] ? `${size()![0]}×${size()![1]} · ${formatSize(img().size)}` : formatSize(img().size)}</span>
                                                    </span>
                                                </Show>
                                            </button>
                                            <Remove name={img().name} i={i()} />
                                        </span>
                                    );
                                }}
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
                                    /** Brought back from the side chat: marked as the side chat's tab is. */
                                    const sideChat = () => f().kind === "text" && (f() as { from?: string }).from === "side-chat";
                                    // A brought-back answer's size in bytes says nothing: its lines only.
                                    const meta = () => {
                                        const x = f();
                                        return x.kind === "text" ? (sideChat() ? plural(x.lines, "line") : `${plural(x.lines, "line")} · ${formatSize(x.size)}`) : formatSize(x.size);
                                    };
                                    const ext = () => (pasted() || sideChat() ? undefined : extensionOf(f().name));
                                    const isOpen = () => shown() === f();
                                    // Its kind on the tile: the extension (a paste and a side chat's answer read as text), or a mark.
                                    const kind = () => (pasted() || sideChat() ? "txt" : (ext() ?? "").toLowerCase());
                                    const canOpen = () => f().kind === "text";
                                    return (
                                        <span class="att att-file" data-refused={problem() ? "" : undefined} data-open={isOpen() ? "" : undefined} title={problem() ? `${f().name}: ${problem()}` : f().name}>
                                            {/* Text opens below to read; anything else is only what it is. */}
                                            <button class="att-main" disabled={!canOpen()} aria-expanded={canOpen() ? isOpen() : undefined} aria-label={canOpen() ? `${isOpen() ? "Hide" : "Show"} ${f().name}` : undefined} onClick={() => setOpen(isOpen() ? undefined : f())}>
                                                <span class="att-ext" data-ext={kind() || undefined} aria-hidden="true">
                                                    <Switch fallback={<FileIcon size={13} />}>
                                                        <Match when={problem()}>
                                                            <FileX size={13} />
                                                        </Match>
                                                        <Match when={pasted()}>
                                                            <Type size={13} />
                                                        </Match>
                                                        <Match when={sideChat()}>
                                                            <MessageSquareText size={13} />
                                                        </Match>
                                                        <Match when={ext()}>{(e) => e().slice(0, 4)}</Match>
                                                    </Switch>
                                                </span>
                                                <span class="att-text">
                                                    <span class="att-name">{pasted() ? "Pasted text" : f().name}</span>
                                                    {/* A model that can't read it: the note under the tiles says so, and what to do. */}
                                                    <span class="att-meta">{problem() ?? meta()}</span>
                                                </span>
                                            </button>
                                            <Show when={pasted() && p.onToText}>
                                                <button class="att-back" title="Put back as text" aria-label="Put back as text" onClick={() => p.onToText?.(i())}>
                                                    <ArrowDown size={12} />
                                                </button>
                                            </Show>
                                            <Remove name={f().name} i={i()} />
                                        </span>
                                    );
                                }}
                            </Match>
                        </Switch>
                    )}
                </For>
            </div>
            <Show when={shown()}>
                {/* A side chat's answer reads as it did there, not as the Markdown it was written in. */}
                {(t) => (t().from === "side-chat" ? <div class="att-preview prose"><Markdown text={t().text} class="small" /></div> : <pre class="att-preview" tabIndex={0}>{t().text.length > 100_000 ? `${t().text.slice(0, 100_000)}\n… (${plural(t().lines, "line")} in all)` : t().text}</pre>)}
            </Show>
            <Show when={p.blocked}>
                <p class="atts-note">{p.blocked}</p>
            </Show>
        </div>
    );
}
