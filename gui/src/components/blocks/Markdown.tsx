import { RenderBoundary } from "../ui/ErrorBoundary";
import { createEffect, createMemo, Index, Match, onCleanup, Switch } from "solid-js";
import { MarkdownRenderer } from "../../lib/markdown";
import { openExternal } from "../../lib/platform";
import { openInEditor } from "../../state/actions";
import { linksVersion, paths } from "../../state/filelinks";
import { replyImages } from "../../state/images";
import { setViewedImage } from "../../state/ui";
import { CodeBlock } from "./CodeBlock";

function openFile(a: HTMLElement) {
    const n = (v?: string) => (v ? Number(v) : undefined);
    void openInEditor(a.dataset.file ?? "", n(a.dataset.line), { col: n(a.dataset.col) });
}

/** Links in rendered markdown open outside the app, never in its window; file links open in the editor; images open full size. */
export function onLinkClick(e: MouseEvent) {
    const img = (e.target as HTMLElement).closest<HTMLImageElement>("img.md-img");
    if (img?.src) return setViewedImage({ src: img.src, alt: img.alt });
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.external) void openExternal(a.getAttribute("href") ?? "");
    else if (a.dataset.file) openFile(a);
}

/** Fills in the images lib/markdown.ts left without a src: files in the session's folders, read by the server. */
function loadImages(root: HTMLElement, load: (path: string) => Promise<string>) {
    for (const img of root.querySelectorAll<HTMLImageElement>("img.md-img[data-image-file]:not([src]):not([data-loading])")) {
        const path = img.dataset.imageFile!;
        img.dataset.loading = "1";
        load(path).then(
            (src) => {
                img.src = src;
                img.tabIndex = 0;
            },
            () => {
                const label = document.createElement("span");
                label.className = "md-image";
                label.textContent = img.alt || "image";
                label.title = `${path} couldn't be shown`;
                img.replaceWith(label);
            },
        );
    }
}

function onLinkKey(e: KeyboardEvent) {
    const img = (e.target as HTMLElement).closest<HTMLImageElement>("img.md-img");
    if (img?.src && e.key === "Enter") {
        e.preventDefault();
        setViewedImage({ src: img.src, alt: img.alt });
        return;
    }
    const a = (e.target as HTMLElement).closest("a");
    if (e.key !== "Enter" || !a?.dataset.file) return;
    e.preventDefault();
    openFile(a);
}

/** With `sessionId`, paths to files in that session's folders become links (see lib/markdown.ts). */
export function Markdown(p: { text: string; streaming?: boolean; class?: string; sessionId?: string; find?: string }) {
    return <RenderBoundary raw={() => p.text}><MarkdownContent {...p} /></RenderBoundary>;
}

function MarkdownContent(p: { text: string; streaming?: boolean; class?: string; sessionId?: string; find?: string }) {
    const r = new MarkdownRenderer();
    let root: HTMLDivElement | undefined;
    const images = createMemo(() => (p.sessionId ? replyImages(p.sessionId) : undefined));
    // Unchanged blocks keep their objects; positional owners also keep a growing
    // code block mounted when its source changes. Only a reply
    // with paths in it looks again when what's known changes.
    const segments = createMemo(() => {
        const segs = r.segments(p.text, Boolean(p.streaming), p.sessionId ? paths.lookup(p.sessionId) : undefined);
        if (r.watching) linksVersion();
        return segs;
    });
    // Unknown paths are asked about together, at most every 400ms while the reply streams.
    let timer: ReturnType<typeof setTimeout> | undefined;
    createEffect(() => {
        segments();
        const id = p.sessionId;
        if (!id) return;
        const load = images();
        if (root && load) loadImages(root, load);
        // What's on screen stays known (see lib/pathcache.ts), until the next render or unmount.
        onCleanup(paths.hold(id, r.paths));
        if (!r.pending.size || timer) return;
        timer = setTimeout(
            () => {
                timer = undefined;
                void paths.resolve(id, r.pending);
            },
            p.streaming ? 400 : 0,
        );
    });
    onCleanup(() => clearTimeout(timer));
    return (
        <div ref={root} class={`md ${p.class ?? ""}`} data-find={p.find} onClick={onLinkClick} onKeyDown={onLinkKey}>
            <Index each={segments()}>
                {(s) => {
                    const code = createMemo(() => { const part = s(); return part.kind === "code" ? part : undefined; });
                    const html = createMemo(() => { const part = s(); return part.kind === "html" ? part : undefined; });
                    return <Switch>
                        <Match when={code()}>{(c) => <CodeBlock code={c().code} lang={c().lang} streaming={c().open} />}</Match>
                        <Match when={html()}>{(h) => <div class="md-block" innerHTML={h().html} />}</Match>
                    </Switch>;
                }}
            </Index>
        </div>
    );
}
