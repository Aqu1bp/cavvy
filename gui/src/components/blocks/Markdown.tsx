import { createMemo, For, Match, Switch } from "solid-js";
import { MarkdownRenderer } from "../../lib/markdown";
import { openExternal } from "../../lib/platform";
import { CodeBlock } from "./CodeBlock";

/** Links in rendered markdown open outside the app, never in its window. */
export function onLinkClick(e: MouseEvent) {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    if (a.dataset.external) void openExternal(a.getAttribute("href") ?? "");
}

export function Markdown(p: { text: string; streaming?: boolean; class?: string }) {
    const r = new MarkdownRenderer();
    // Same objects for unchanged blocks, so <For> keeps their DOM.
    const segments = createMemo(() => r.segments(p.text, Boolean(p.streaming)));
    return (
        <div class={`md ${p.class ?? ""}`} onClick={onLinkClick}>
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
