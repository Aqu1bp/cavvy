import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text } from "../helpers/gui-render";
import { boundary } from "../helpers/render-boundary";
import { rawRenderText, renderDetails } from "../../gui/src/lib/render-error";
import * as format from "../../gui/src/lib/format";
import { createReveal } from "../../gui/src/lib/reveal";
import * as diffWindow from "../../gui/src/lib/diff-window";
import { registerSecret, unregisterSecret } from "../../src/util/redact";

const source = (file: string) => readFileSync(new URL(`../../gui/src/components/${file}.tsx`, import.meta.url), "utf8").replace(/^import [\s\S]*?;\n/gm, "");

test("unbounded render throws; boundary contains it, redacts text/copy/log, and retries only on changed input or request", async () => {
    const secret = "sk-proj-" + "x".repeat(30);
    const registered = "test-private-session-secret";
    registerSecret(registered);
    const logs: string[] = [];
    const copies: string[] = [];
    const RenderBoundary = boundary(async (s) => { copies.push(s); return true; }, (s) => logs.push(s));
    let attempts = 0;
    let broken = true;
    const Boom = () => { attempts++; if (broken) throw Error(`/Users/person/project ${secret} ${registered}`); return "recovered"; };
    // The old rendering path propagates the error to the caller and never renders its sibling.
    const Before = component('export function Before() { return <><Boom /><span>following block</span></>; }', "Before", { Boom });
    const before = node("root");
    expect(() => renderer.render(Before, before)).toThrow();
    expect(text(before)).not.toContain("following block");
    attempts = 0;
    const [raw, setRaw] = solid.createSignal(`<script>unsafe</script> ${secret} ${registered}`);
    const [tick, setTick] = solid.createSignal(0);
    const View = component('export function View() { return <><RenderBoundary raw={raw}><Boom /></RenderBoundary><span>following block {tick()}</span></>; }', "View", { RenderBoundary, Boom, raw, tick });
    const root = node("root");
    const dispose = renderer.render(View, root);
    try {
        expect(text(root)).toContain("Couldn't render this part");
        expect(text(root)).toContain("following block");
        expect(all(root).filter((n) => n.tag === "script")).toHaveLength(0);
        expect(text(root)).toContain("<script>unsafe</script>");
        expect(text(root)).not.toContain(secret);
        expect(text(root)).not.toContain(registered);
        expect(logs).toHaveLength(1);
        expect(logs[0]).not.toContain(secret);
        expect(logs[0]).not.toContain(registered);
        expect(logs[0]).not.toContain("/Users/person");
        for (const label of ["Copy text", "Copy details"]) {
            all(root).find((n) => n.tag === "button" && text(n) === label)!.props.onClick();
            await Promise.resolve();
        }
        expect(copies).toHaveLength(2);
        expect(copies.join()).not.toContain(secret);
        expect(copies.join()).not.toContain(registered);
        setTick(1);
        expect(attempts).toBe(1);
        setRaw(raw() + " new token");
        expect(attempts).toBe(2);
        setTick(2);
        expect(attempts).toBe(2);
        broken = false;
        all(root).find((n) => n.tag === "button" && text(n) === "Retry")!.props.onClick();
        expect(text(root)).toContain("recovered");
        expect(text(root)).not.toContain("Couldn't render");
    } finally { dispose(); unregisterSecret(registered); }
});

for (const kind of ["Markdown", "CodeBlock", "DiffView", "ToolRow", "ToolDetails", "ActivityGroup", "TurnView"]) {
    test(`${kind} catches setup errors at its public boundary and leaves siblings usable`, () => {
        const file = kind === "TurnView" ? kind : ["ToolRow", "ToolDetails", "ActivityGroup"].includes(kind) ? "blocks/Activity" : `blocks/${kind}`;
        const props: Record<string, unknown> = {
            Markdown: { text: "plain markdown" }, CodeBlock: { code: "safe code", lang: 42 },
            DiffView: { diff: { path: "broken", hunks: null } },
            ToolRow: { tool: { name: null } },
            ToolDetails: { tool: null }, ActivityGroup: { steps: [], tools: null },
            TurnView: { turn: { blocks: null } },
        };
        // Use actual renderers; force Markdown's parser failure and the others' malformed data/setup dependencies.
        const errors: string[] = [];
        const Widget = component(source(file), kind, {
            RenderBoundary: boundary(undefined, (error) => errors.push(error)),
            MarkdownRenderer: class { segments() { throw Error("bad markdown"); } },
            ...format, now: () => 0, prefs: {}, findReveal: () => undefined,
            ...Object.fromEntries(["Wrench", "Bot", "FileText", "ChevronRight", "CopyButton"].map((name) => [name, () => node(name)])),
            onMount() {}, highlight: async () => undefined, createReveal, paint() {},
            groupBlocks: () => { throw Error("bad turn"); },
        });
        const View = component('export function View() { return <><Widget {...props} /><button>still usable</button></>; }', "View", { Widget, props: props[kind] });
        const root = node("root");
        const dispose = renderer.render(View, root);
        try {
            expect(text(root)).toContain("Couldn't render this part");
            expect(text(root)).toContain("still usable");
            expect(errors.join()).not.toContain("ReferenceError");
        } finally { dispose(); }
    });
}

test("diagnostics tolerate unusual thrown values and unreadable raw content", () => {
    expect(renderDetails({ toString() { throw Error("fail"); } })).toBe("Render error (details unavailable)");
    expect(rawRenderText(() => { throw Error("fail"); })).toBe("Original content unavailable.");
});

for (const kind of ["CodeBlock", "DiffView"]) {
    test(`${kind} catches rejected highlighting, redacts diagnostics and allows retry`, async () => {
        const errors: string[] = [];
        let fail = true;
        const secret = "sk-proj-" + "x".repeat(30);
        const highlight = async () => { if (fail) throw Error(secret); return undefined; };
        const Widget = component(source(`blocks/${kind}`), kind, {
            RenderBoundary: boundary(undefined, (error) => errors.push(error)),
            highlight, highlightLines: highlight, highlightLineStream: streamOf(highlight), langOf: () => "ts", escapeHtml: (s: string) => s,
            ...diffWindow, plural: format.plural,
            CopyButton: () => node("copy"),
            IntersectionObserver: class {
                constructor(private callback: Function) {}
                observe() { this.callback([{ isIntersecting: true }]); }
                disconnect() {}
            },
        });
        const root = node("root");
        const props = kind === "CodeBlock" ? { code: "const x = 1", lang: "ts" } : {
            diff: { path: "x.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ t: "add", text: "const x = 1", b: 1 }] }] },
        };
        const dispose = renderer.render(() => Widget(props), root);
        try {
            await new Promise((r) => setImmediate(r));
            expect(text(root)).toContain("Couldn't render this part");
            expect(errors).toHaveLength(1);
            expect(errors[0]).toContain("[REDACTED openai-key]");
            expect(errors[0]).not.toContain(secret);
            fail = false;
            all(root).find((n) => n.tag === "button" && text(n) === "Retry")!.props.onClick();
            await new Promise((r) => setImmediate(r));
            expect(text(root)).not.toContain("Couldn't render");
            expect(errors).toHaveLength(1);
        } finally { dispose(); }
    });
}

for (const target of ["SettingsPage", "AgentView", "ReviewPane"]) {
    test(`${target} failure preserves navigation and session recovery`, () => {
        const [settingsTab, setSettingsTab] = solid.createSignal(target === "SettingsPage" ? "general" : undefined);
        const [agentFocus, setAgentFocus] = solid.createSignal(target === "AgentView" ? "agent" : undefined);
        const [review, setReview] = solid.createSignal(target === "ReviewPane" ? {} : undefined);
        const handle = { view: { state: { cwd: "/project" }, agents: [{ id: "agent" }] } };
        const appSource = readFileSync(new URL("../../gui/src/App.tsx", import.meta.url), "utf8");
        const builtins = new Set(["Show", "For", "Index", "Switch", "Match", "Dynamic", "Portal", "ErrorBoundary", "Suspense", "RenderBoundary"]);
        const tags = [...new Set([...appSource.matchAll(/<([A-Z][A-Za-z0-9]*)[\s/>]/g)].map((m) => m[1]!))].filter((tag) => !builtins.has(tag));
        const App = component(appSource.slice(appSource.indexOf("export function App")), "App", {
            RenderBoundary: boundary(), app: { conn: "open", activeId: "session" }, handleFor: () => handle,
            prefs: { sidebar: true }, isTauri: false, document: {}, onMount() {}, setEnterSends() {}, actionOf: () => undefined,
            railDrag: () => undefined, shellLayout: () => ({ railMode: "dock", railShown: true, sheet: { w: 1100, h: 860 }, inspector: { open: false, mode: "dock", width: 360, short: false, bottom: 8 }, terminal: { shown: false, height: 0, maximized: false, most: 560 } }), settingsTab, agentFocus, review, setAgentFocus() {}, setReview() {}, attentionCount: () => 0,
            ...Object.fromEntries(tags.map((tag) => [tag, () => { if (tag === target) throw Error("injected " + target); return node(tag); }])),
        });
        const root = node("root");
        const dispose = renderer.render(App, root);
        try {
            expect(text(root)).toContain("Couldn't render this part");
            expect(all(root).some((n) => n.tag === (target === "SettingsPage" ? "SettingsNav" : "Sidebar"))).toBe(true);
            setSettingsTab(undefined);
            setAgentFocus(undefined);
            setReview(undefined);
            expect(all(root).some((n) => n.tag === "SessionView")).toBe(true);
            expect(text(root)).not.toContain("Couldn't render");
        } finally { dispose(); }
    });
}

test("root failure offers Reload and safe Copy details", async () => {
    const copies: string[] = [];
    const RenderBoundary = boundary(async (s) => { copies.push(s); return true; });
    const Root = component('export function Root() { return <RenderBoundary app><Broken /></RenderBoundary>; }', "Root", {
        RenderBoundary, Broken: () => { throw Error("root failed"); },
    });
    const root = node("root");
    const dispose = renderer.render(Root, root);
    try {
        expect(text(root)).toContain("Couldn't render Harness");
        expect(all(root).some((n) => n.tag === "button" && text(n) === "Reload")).toBe(true);
        all(root).find((n) => n.tag === "button" && text(n) === "Copy details")!.props.onClick();
        await Promise.resolve();
        expect(copies[0]).toContain("root failed");
    } finally { dispose(); }
});

/** Execute the actual highlighting module, replacing only dynamic module loading. */
/** DiffView's streamed highlighting (highlight.ts) over a whole-file highlightLines, as the worker's first part. */
function streamOf(highlightLines: (code: string, lang?: string) => Promise<string[] | undefined>) {
    return (code: string, lang: string | undefined, part: (from: number, lines: string[]) => void) => {
        let over = false;
        const done = highlightLines(code, lang).then((lines) => {
            if (!over && lines) part(0, lines);
        });
        return { done, cancel: () => void (over = true) };
    };
}

function retryingHighlighter(failure: "import" | "initialize" = "import") {
    const original = readFileSync(new URL("../../gui/src/lib/highlight-core.ts", import.meta.url), "utf8");
    const js = new Bun.Transpiler({ loader: "ts" }).transformSync(original)
        .replace(/\bimport\(/g, "loadModule(").replace(/^export /gm, "");
    let loads = 0;
    let initializations = 0;
    const highlighter = {
        getLoadedLanguages: () => ["typescript"],
        codeToHtml: () => "<pre><code>highlighted</code></pre>",
        codeToTokens: () => ({ tokens: [[{ content: "highlighted" }]] }),
    };
    const loadModule = async (name: string) => {
        if (name === "shiki/engine/javascript") return { createJavaScriptRegexEngine: () => ({}) };
        if (name !== "shiki/core") throw Error(`Unexpected module: ${name}`);
        loads++;
        if (failure === "import" && loads === 1) throw Error("Transient chunk-load failure");
        return {
            createCssVariablesTheme: () => ({}),
            createHighlighterCore: async () => {
                initializations++;
                if (failure === "initialize" && initializations === 1) throw Error("Transient initialization failure");
                return highlighter;
            },
        };
    };
    const core = new Function("loadModule", `${js}; return { highlight, highlightLines, warmUp };`)(loadModule);
    return {
        ...core,
        highlightLineStream: streamOf(core.highlightLines),
        loads: () => loads,
    };
}

for (const kind of ["CodeBlock", "DiffView"]) {
    test(`${kind} Retry recovers through the real highlighter after an import failure`, async () => {
        const errors: string[] = [];
        const highlighting = retryingHighlighter();
        const Widget = component(source(`blocks/${kind}`), kind, {
            RenderBoundary: boundary(undefined, (error) => errors.push(error)),
            ...highlighting, langOf: () => "typescript", escapeHtml: (s: string) => s,
            ...diffWindow, plural: format.plural,
            CopyButton: () => node("copy"),
            IntersectionObserver: class {
                constructor(private callback: Function) {}
                observe() { this.callback([{ isIntersecting: true }]); }
                disconnect() {}
            },
        });
        const root = node("root");
        const props = kind === "CodeBlock" ? { code: "const x = 1", lang: "typescript" } : {
            diff: { path: "x.ts", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: [{ t: "add", text: "const x = 1", b: 1 }] }] },
        };
        const dispose = renderer.render(() => Widget(props), root);
        try {
            await new Promise((r) => setImmediate(r));
            expect(text(root)).toContain("Couldn't render this part");
            expect(highlighting.loads()).toBe(1); // Both sides of a diff share the same attempt.
            expect(errors).toHaveLength(1);
            all(root).find((n) => n.tag === "button" && text(n) === "Retry")!.props.onClick();
            await new Promise((r) => setImmediate(r));
            expect(highlighting.loads()).toBe(2);
            expect(text(root)).not.toContain("Couldn't render");
            expect(all(root).some((n) => n.props.innerHTML === "highlighted")).toBe(true);
            expect(errors).toHaveLength(1);
        } finally { dispose(); }
    });
}

for (const failure of ["import", "initialize"] as const) {
    test(`a failed warm-up (${failure}) does not poison later highlighting`, async () => {
        const highlighting = retryingHighlighter(failure);
        highlighting.warmUp();
        await new Promise((r) => setImmediate(r));
        expect(highlighting.loads()).toBe(1);
        expect(await highlighting.highlight("code", "typescript")).toBe("highlighted");
        expect(await highlighting.highlightLines("diff", "typescript")).toEqual(["highlighted"]);
        expect(highlighting.loads()).toBe(2); // Successful initialization remains cached.
    });
}
