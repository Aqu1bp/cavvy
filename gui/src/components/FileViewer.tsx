// The file viewer: a file of the session's, read-only, in the inspector column where the diff reader goes (with the
// side panel's rail beside it). Code is highlighted by the highlighter's worker and drawn only where it's in view
// (rows of one height, no wrapping: a long file costs what a screenful does). Markdown shows rendered or as its text;
// images as images (a click opens the image viewer); what isn't text, or is too big, says so and offers the editor.

import { batch, createEffect, createMemo, createResource, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, untrack } from "solid-js";
import { AtSign, ChevronLeft, Copy, Hash, RefreshCw, SquareArrowOutUpRight, X } from "lucide-solid";
import type { FileContent } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { rpc, toast } from "../state/app";
import { RpcError } from "../lib/rpc";
import { prefs } from "../state/prefs";
import { closeReview, review, setViewedImage, shellLayout } from "../state/ui";
import { openInEditor } from "../state/actions";
import { highlightLineStream } from "../lib/highlight";
import { escapeHtml } from "../lib/markdown";
import { langOf } from "../lib/format";
import { columns } from "../lib/diff-window";
import { fromBase64 } from "../lib/attachments";
import { copyText } from "../lib/platform";
import { dirOf, nameOf } from "../lib/inspector";
import { addToChat, viewFile } from "../lib/file-view";
import { Markdown } from "./blocks/Markdown";
import { ReviewResizer } from "./ReviewPane";
import { Segmented, Spinner } from "./ui/bits";
import "../styles/files.css";

/** Rows drawn past the edges of the view, each way. */
const OVER = 30;
/** A tab's width in columns, as the view draws it (files.css tab-size). */
const TAB = 4;

const sizeText = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

/** The lines of a text file, drawn where they're in view; `line` (1-based) scrolled to and marked, each time `jump` changes. */
function Lines(p: { text: string; path: string; line?: number; jump: number }) {
    const lines = createMemo(() => {
        const all = p.text.split("\n");
        if (all.length > 1 && all[all.length - 1] === "") all.pop();
        return all.map((l) => l.replace(/\r$/, ""));
    });
    const width = createMemo(() => {
        let most = 0;
        for (const l of lines()) if (l.length > most || l.includes("\t")) most = Math.max(most, columns(l, TAB));
        return most;
    });
    let scroller!: HTMLDivElement;
    const [top, setTop] = createSignal(0);
    const [height, setHeight] = createSignal(800);
    const [rowH, setRowH] = createSignal(20);
    // Highlighted a part at a time, the first screenful first; plain until each part comes.
    let hl: (string | undefined)[] = [];
    const [hlv, setHlv] = createSignal(0);
    createEffect(on([() => p.text, () => p.path], ([text, path]) => {
        hl = [];
        setHlv((n) => n + 1);
        const lang = langOf(path);
        if (!lang) return;
        const stream = highlightLineStream(text, lang, (from, part) => {
            for (let i = 0; i < part.length; i++) hl[from + i] = part[i];
            setHlv((n) => n + 1);
        });
        stream.done.catch(() => undefined);
        onCleanup(stream.cancel);
    }));
    const range = createMemo(() => {
        const n = lines().length;
        const h = rowH();
        const first = Math.max(0, Math.floor(top() / h) - OVER);
        const last = Math.min(n - 1, Math.ceil((top() + height()) / h) + OVER);
        const out: number[] = [];
        for (let i = first; i <= last; i++) out.push(i);
        return out;
    });
    const html = (i: number) => {
        hlv();
        return hl[i] ?? escapeHtml(lines()[i] ?? "");
    };
    onMount(() => {
        const ro = new ResizeObserver(() => {
            setHeight(scroller.clientHeight);
            const row = scroller.querySelector<HTMLElement>(".fv-row");
            if (row?.offsetHeight) setRowH(row.offsetHeight);
        });
        ro.observe(scroller);
        onCleanup(() => ro.disconnect());
    });
    // Another file starts at its top (or at its line, below).
    createEffect(on(() => p.path, () => {
        scroller.scrollTop = 0;
        setTop(0);
    }, { defer: true }));
    // The line asked for, a third of the way down.
    createEffect(on(() => [p.line, p.jump] as const, ([line]) => {
        if (!line) return;
        requestAnimationFrame(() => {
            const row = scroller.querySelector<HTMLElement>(".fv-row");
            const h = row?.offsetHeight || rowH();
            scroller.scrollTop = Math.max(0, (line - 1) * h - scroller.clientHeight / 3);
            setTop(scroller.scrollTop);
        });
    }));
    const digits = () => String(lines().length).length;
    return (
        <div ref={scroller} class="fv-scroll" onScroll={(e) => setTop(e.currentTarget.scrollTop)} tabIndex={0} aria-label={`${nameOf(p.path)}, ${lines().length} lines`}>
            <div class="fv-lines" style={{ height: `${lines().length * rowH()}px`, "--fv-digits": digits(), "--fv-cols": width() }}>
                <div class="fv-win" style={{ transform: `translateY(${(range()[0] ?? 0) * rowH()}px)` }}>
                    <For each={range()}>
                        {(i) => (
                            <div class="fv-row" classList={{ at: p.line === i + 1 }}>
                                <span class="fv-n">{i + 1}</span>
                                <span class="fv-c" innerHTML={html(i)} />
                            </div>
                        )}
                    </For>
                </div>
            </div>
        </div>
    );
}

/** An image file: shown fitted, a click opens it full size. */
function ImageFile(p: { file: FileContent & { kind: "image" } }) {
    const url = createMemo(() => {
        const u = URL.createObjectURL(new Blob([fromBase64(p.file.data) as BlobPart], { type: p.file.mediaType }));
        onCleanup(() => URL.revokeObjectURL(u));
        return u;
    });
    return (
        <div class="fv-img">
            <img
                src={url()}
                alt={nameOf(p.file.rel)}
                onClick={(e) => {
                    const img = e.currentTarget;
                    setViewedImage({ images: [{ name: nameOf(p.file.rel), full: { mediaType: p.file.mediaType, data: p.file.data }, preview: url(), size: img.naturalWidth ? { width: img.naturalWidth, height: img.naturalHeight } : undefined }], index: 0, from: img });
                }}
            />
        </div>
    );
}

export function FileViewer(p: { handle: SessionHandle }) {
    const target = () => review()?.file;
    const [reloads, setReloads] = createSignal(0);
    // Read again for another file (or Refresh); not for another line of the same one.
    const key = createMemo(() => {
        const t = target();
        return t ? `${p.handle.id}\0${t.path}\0${reloads()}` : undefined;
    });
    const [file] = createResource(key, () => rpc.call("fs.read", { sessionId: p.handle.id, path: untrack(target)!.path }));
    const shown = () => (file.state === "errored" ? undefined : file.latest);
    /** Refused (outside the session's folders) or gone: an editor would be refused it too, and the chat can't use it. */
    const unopenable = () => file.state === "errored" && file.error instanceof RpcError && (file.error.code === "outside" || file.error.code === "not_found");
    const rel = () => shown()?.rel ?? target()?.path ?? "";
    // Each time it's asked to go to a line (the same one again included).
    const [jump, setJump] = createSignal(0);
    createEffect(on(target, () => setJump((n) => n + 1)));
    const markdown = () => /\.(md|markdown|mdx)$/i.test(rel());
    const [raw, setRaw] = createSignal(false);
    // Opened at a line (a search's), Markdown shows its text, where the line is.
    createEffect(on(() => target()?.path, () => setRaw(Boolean(untrack(target)?.line))));
    const [lineOpen, setLineOpen] = createSignal(false);
    let lineInput: HTMLInputElement | undefined;
    const goTo = (v: string) => {
        const n = Number.parseInt(v, 10);
        setLineOpen(false);
        if (n > 0) batch(() => {
            setRaw(true);
            viewFile(target()!.path, n);
        });
    };
    const onKey = (e: KeyboardEvent) => {
        // Ctrl+G, as editors have it: go to a line.
        if (e.ctrlKey && !e.metaKey && !e.altKey && e.key.toLowerCase() === "g" && shown()?.kind === "text") {
            e.preventDefault();
            setLineOpen(true);
            queueMicrotask(() => lineInput?.focus());
        }
    };
    const editor = () => void openInEditor(rel(), target()?.line, { sessionId: p.handle.id });
    const copyPath = async () => {
        const f = shown();
        if (f && (await copyText(f.path))) toast("Path copied", "success");
    };
    const toChat = () => {
        if (!addToChat(rel())) toast("No message box to add it to", "warn");
    };
    return (
        <section class="review fv" aria-label="File viewer" onKeyDown={onKey}>
            <Show when={shellLayout().inspector.mode === "dock"}>
                <ReviewResizer />
            </Show>
            <div class="rv-h">
                <button class="hb rv-back" title={review()?.back ? "Back to the changes (Esc)" : prefs.panel ? "Back to the side panel (Esc)" : "Close (Esc)"} aria-label="Close file" onClick={closeReview}>
                    <Show when={prefs.panel || review()?.back} fallback={<X size={16} />}>
                        <ChevronLeft size={16} />
                    </Show>
                </button>
                <div class="fv-title selectable" title={rel()}>
                    <span class="fv-name">{nameOf(rel())}</span>
                    <span class="fv-dir">{dirOf(rel()).replace(/\/$/, "")}</span>
                </div>
                <span class="grow" />
                <Show when={shown()?.kind === "text" && markdown()}>
                    <Segmented size="sm" label="Show Markdown" value={raw() ? "raw" : "rendered"} onChange={(v) => setRaw(v === "raw")} options={[{ value: "rendered", label: <>Rendered</> }, { value: "raw", label: <>Raw</> }]} />
                </Show>
                <Show when={shown()?.kind === "text"}>
                    <Show
                        when={lineOpen()}
                        fallback={
                            <button class="hb" title="Go to line (Ctrl+G)" aria-label="Go to line" onClick={() => (setLineOpen(true), queueMicrotask(() => lineInput?.focus()))}>
                                <Hash size={15} />
                            </button>
                        }
                    >
                        <input
                            ref={lineInput}
                            class="fv-line-in"
                            inputmode="numeric"
                            placeholder="Line"
                            aria-label="Line number"
                            onKeyDown={(e) => {
                                if (e.key === "Enter") goTo(e.currentTarget.value);
                                else if (e.key === "Escape") {
                                    e.preventDefault();
                                    e.stopPropagation();
                                    setLineOpen(false);
                                }
                            }}
                            onBlur={() => setLineOpen(false)}
                        />
                    </Show>
                </Show>
                <button class="hb" title="Open in editor" aria-label="Open in editor" disabled={unopenable()} onClick={editor}>
                    <SquareArrowOutUpRight size={15} />
                </button>
                <button class="hb" title="Copy path" aria-label="Copy path" disabled={!shown()} onClick={() => void copyPath()}>
                    <Copy size={15} />
                </button>
                <button class="hb" title="Add to chat" aria-label="Add to chat" disabled={unopenable()} onClick={toChat}>
                    <AtSign size={15} />
                </button>
                <button class="hb" title="Refresh" aria-label="Refresh" disabled={file.loading} onClick={() => setReloads((n) => n + 1)}>
                    <Show when={file.loading} fallback={<RefreshCw size={15} />}>
                        <Spinner size={14} />
                    </Show>
                </button>
            </div>
            <div class="fv-body" aria-busy={file.loading}>
                <Switch>
                    <Match when={file.state === "errored"}>
                        <div class="fv-msg selectable" role="alert">{file.error instanceof Error ? file.error.message : String(file.error)}</div>
                    </Match>
                    <Match when={!shown() || (file.loading && shown()!.rel !== target()?.path && shown()!.path !== target()?.path)}>
                        <div class="fv-msg">
                            <Spinner size={16} />
                        </div>
                    </Match>
                    <Match when={shown()?.kind === "text" && markdown() && !raw() && shown()}>
                        {(f) => (
                            <div class="fv-md">
                                <Markdown text={(f() as { text: string }).text} sessionId={p.handle.id} />
                            </div>
                        )}
                    </Match>
                    <Match when={shown()?.kind === "text" && shown()}>
                        {(f) => <Lines text={(f() as { text: string }).text} path={f().rel} line={target()?.line} jump={jump()} />}
                    </Match>
                    <Match when={shown()?.kind === "image" && shown()}>
                        {(f) => <ImageFile file={f() as FileContent & { kind: "image" }} />}
                    </Match>
                    <Match when={shown()}>
                        {(f) => (
                            <div class="fv-msg">
                                <p>{f().kind === "large" ? `Too big to show (${sizeText(f().size)}).` : "Not a text file."}</p>
                                <button class="btn secondary sm" onClick={editor}>
                                    Open in editor
                                </button>
                            </div>
                        )}
                    </Match>
                </Switch>
            </div>
        </section>
    );
}
