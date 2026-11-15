import { RenderBoundary } from "../ui/ErrorBoundary";
import { createEffect, createRenderEffect, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { endWriting, highlight, highlighted, highlightMore, newWriting } from "../../lib/highlight";
import { growing, trailBlock } from "../../lib/stream-dom";
import { CopyButton } from "../ui/bits";

const LABELS: Record<string, string> = { ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", js: "JavaScript", javascript: "JavaScript", jsx: "JSX", py: "Python", python: "Python", rs: "Rust", rust: "Rust", go: "Go", sh: "Shell", bash: "Shell", shell: "Shell", zsh: "Shell", console: "Console", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", md: "Markdown", markdown: "Markdown", html: "HTML", css: "CSS", sql: "SQL", diff: "Diff", swift: "Swift", kotlin: "Kotlin", java: "Java", c: "C", cpp: "C++", ruby: "Ruby", rb: "Ruby", php: "PHP" };

/** While code streams, its finished lines are highlighted at most this often. */
const STREAM_HIGHLIGHT_MS = 250;

/** How many lines `code` is drawn as (one it ends with starts none). */
export function linesOf(code: string): number {
    let n = 1;
    for (let at = code.indexOf("\n"); at !== -1 && at < code.length - 1; at = code.indexOf("\n", at + 1)) n++;
    return n;
}

export function CodeBlock(p: { code: string; lang?: string; streaming?: boolean; bare?: boolean; maxHeight?: number }) {
    return <RenderBoundary raw={() => p.code}><CodeBlockContent {...p} /></RenderBoundary>;
}

function CodeBlockContent(p: { code: string; lang?: string; streaming?: boolean; bare?: boolean; maxHeight?: number }) {
    /** The highlighted start of the code (all of it once it's finished): the source it covers and its HTML; `lines`: a box for each line. */
    // Highlighted before (shown again: its session switched back to): colored from its first frame.
    type Lit = { code: string; lang?: string; html: string; lines?: boolean };
    const [lit, setLit] = createSignal<Lit | undefined>(untrack((): Lit | undefined => {
        if (p.streaming || !p.lang) return undefined;
        const line = p.code.endsWith("\n");
        const html = highlighted(line ? p.code.slice(0, -1) : p.code, p.lang);
        return html === undefined ? undefined : { code: p.code, lang: p.lang, html: line ? html + "\n" : html };
    }));
    const [failure, setFailure] = createSignal<unknown>();
    createEffect(() => { if (failure()) throw failure(); });
    // Written while the reply streams: it comes out in the reply's ink trail (lib/stream-dom.ts).
    const born = Boolean(p.streaming);
    let box: HTMLDivElement | undefined;
    // Once its classes are set (Solid sets them after the ref).
    onMount(() => born && box && trailBlock(box));
    let token = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let lastRun = 0;
    /** While it's being written: its place in the highlighter (lib/highlight-core.ts). */
    let writing: number | undefined;
    const stopWriting = () => {
        if (writing !== undefined) endWriting(writing);
        writing = undefined;
    };
    onCleanup(() => {
        token++;
        clearTimeout(timer);
        stopWriting();
    });
    const run = (code: string, lang: string) => {
        const mine = ++token;
        busy = true;
        lastRun = Date.now();
        stopWriting();
        // Finished lines end in a newline, which the highlighter's lines don't keep.
        const line = code.endsWith("\n");
        void highlight(line ? code.slice(0, -1) : code, lang).then((h) => {
            if (mine !== token) return;
            busy = false;
            setLit(h === undefined ? undefined : { code, lang, html: line ? h + "\n" : h });
            if (p.streaming) schedule();
        }).catch((error) => {
            if (mine === token) setFailure(() => error || new Error("Highlighting failed"));
        });
    };
    /** The lines finished since the last time, read once each: only they go to the highlighter, and onto the end of the page. */
    const runMore = (done: string, lang: string) => {
        const mine = ++token;
        busy = true;
        lastRun = Date.now();
        const had = lit();
        // Anything but more of the same (another language, the text replaced): from the top.
        const more = writing !== undefined && had?.lang === lang && done.startsWith(had.code);
        if (!more) {
            stopWriting();
            writing = newWriting();
        }
        void highlightMore(writing!, more ? done.slice(had!.code.length) : done, lang).then((h) => {
            if (mine !== token) return;
            busy = false;
            setLit(h === undefined ? undefined : { code: done, lang, html: (more ? had!.html : "") + h, lines: true });
            if (p.streaming) schedule();
        }).catch((error) => {
            if (mine === token) setFailure(() => error || new Error("Highlighting failed"));
        });
    };
    // While it's being written: its finished lines, a few times a second (the
    // line being typed stays plain), so colour comes in as it's written instead
    // of all at once when the block closes.
    const schedule = () => {
        if (timer || busy) return;
        timer = setTimeout(() => {
            timer = undefined;
            const lang = p.lang;
            const done = p.code.slice(0, p.code.lastIndexOf("\n") + 1);
            if (!p.streaming || !lang || !done || (lit()?.code === done && lit()?.lang === lang)) return;
            runMore(done, lang);
        }, Math.max(0, STREAM_HIGHLIGHT_MS - (Date.now() - lastRun)));
    };
    createEffect(
        on(
            () => [p.code, p.lang, p.streaming] as const,
            ([code, lang, streaming]) => {
                if (!lang) {
                    token++;
                    busy = false;
                    return setLit(undefined);
                }
                if (streaming) return schedule();
                clearTimeout(timer);
                timer = undefined;
                const now = lit();
                if (now && !now.lines && now.code === code && now.lang === lang) return;
                run(code, lang);
            },
        ),
    );
    /** What's highlighted, while it's still the start of the code. */
    const head = () => {
        const l = lit();
        return l && l.lang === p.lang && p.code.startsWith(l.code) ? l : undefined;
    };
    const label = () => (p.lang ? (LABELS[p.lang.toLowerCase()] ?? p.lang) : "");
    return (
        <div class={`code${p.bare ? " bare" : ""}${p.streaming ? " writing" : ""}`} ref={box}>
            <Show when={!p.bare}>
                <div class="code-head" data-find-skip>
                    <span class="code-lang">{label() || "Code"}</span>
                    <CopyButton text={() => p.code} label="Copy code" />
                </div>
            </Show>
            <pre class="code-body" style={{ ...(p.maxHeight ? { "max-height": `${p.maxHeight}px` } : {}), "--lines": String(linesOf(p.code)) }}>
                <code>
                    <Show when={head()}>{(h) => <span class="code-lit" classList={{ lines: h().lines }} ref={(el) => {
                        const show = growing(el);
                        createRenderEffect(() => show(h().html));
                    }} />}</Show>
                    {p.code.slice(head()?.code.length ?? 0)}
                </code>
            </pre>
        </div>
    );
}
