import { RenderBoundary } from "../ui/ErrorBoundary";
import { createEffect, createMemo, For, Match, onCleanup, Switch } from "solid-js";
import { MarkdownRenderer } from "../../lib/markdown";
import { openExternal } from "../../lib/platform";
import { openInEditor } from "../../state/actions";
import { linksVersion, paths } from "../../state/filelinks";
import { CodeBlock } from "./CodeBlock";

function openFile(a: HTMLElement) {
    const n = (v?: string) => (v ? Number(v) : undefined);
    void openInEditor(a.dataset.file ?? "", n(a.dataset.line), { col: n(a.dataset.col) });
}

/** Links in rendered markdown open outside the app, never in its window; file links open in the editor. */
export function onLinkClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.external) void openExternal(a.getAttribute("href") ?? "");
    else if (a.dataset.file) openFile(a);
}

function onLinkKey(e: KeyboardEvent) {
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
    // Same objects for unchanged blocks, so <For> keeps their DOM. Only a reply
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
        <div class={`md ${p.class ?? ""}`} data-find={p.find} onClick={onLinkClick} onKeyDown={onLinkKey}>
            <For each={segments()}>
                {(s) => (
                    <Switch>
                        <Match when={s.kind === "code" && s}>{(c) => <CodeBlock code={c().code} lang={c().lang} streaming={c().open} />}</Match>
                        <Match when={s.kind === "html" && s}>{(h) => <div class="md-block" innerHTML={h().html} />}</Match>
                    </Switch>
                )}
            </For>
        </div>
    );
}
