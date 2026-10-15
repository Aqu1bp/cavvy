import { createEffect, createSignal, on, Show } from "solid-js";
import { highlight } from "../../lib/highlight";
import { CopyButton } from "../ui/bits";

const LABELS: Record<string, string> = { ts: "TypeScript", typescript: "TypeScript", tsx: "TSX", js: "JavaScript", javascript: "JavaScript", jsx: "JSX", py: "Python", python: "Python", rs: "Rust", rust: "Rust", go: "Go", sh: "Shell", bash: "Shell", shell: "Shell", zsh: "Shell", console: "Console", json: "JSON", yaml: "YAML", yml: "YAML", toml: "TOML", md: "Markdown", markdown: "Markdown", html: "HTML", css: "CSS", sql: "SQL", diff: "Diff", swift: "Swift", kotlin: "Kotlin", java: "Java", c: "C", cpp: "C++", ruby: "Ruby", rb: "Ruby", php: "PHP" };

export function CodeBlock(p: { code: string; lang?: string; streaming?: boolean; bare?: boolean; maxHeight?: number }) {
    const [html, setHtml] = createSignal<string>();
    let token = 0;
    createEffect(
        on(
            () => [p.code, p.lang, p.streaming] as const,
            ([code, lang, streaming]) => {
                const mine = ++token;
                // While it's being written, plain text (highlighting every token would be wasted work).
                if (streaming || !lang) return setHtml(undefined);
                void highlight(code, lang).then((h) => {
                    if (mine === token) setHtml(h);
                });
            },
        ),
    );
    const label = () => (p.lang ? (LABELS[p.lang.toLowerCase()] ?? p.lang) : "");
    return (
        <div class={`code ${p.bare ? "bare" : ""}`}>
            <Show when={!p.bare}>
                <div class="code-head">
                    <span class="code-lang">{label() || "Code"}</span>
                    <CopyButton text={() => p.code} label="Copy code" />
                </div>
            </Show>
            <pre class="code-body" style={p.maxHeight ? { "max-height": `${p.maxHeight}px` } : undefined}>
                <Show when={html()} fallback={<code>{p.code}</code>}>
                    <code innerHTML={html()} />
                </Show>
            </pre>
        </div>
    );
}
