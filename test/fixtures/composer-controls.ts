// Exercise Composer's actual reactive markup and handlers with a small in-memory renderer.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { transformSync } from "../../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { createComposerDraft } from "../../gui/src/lib/composer-draft";
import { composerStorage, createComposerStorage } from "../../gui/src/lib/drafts";
import { composingKey, revealMenuOption } from "../../gui/src/lib/composer-menu";
import { createRunSheet, type RunRequest } from "../../gui/src/lib/run-sheet";
import type { RunResult } from "../../src/server/protocol";

const saved = new Map<string, string>();
const localStorage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => { saved.set(key, value); }, removeItem: (key: string) => { saved.delete(key); } };
Object.assign(globalThis, { window: { localStorage } });
const persisted = () => createComposerStorage(() => localStorage);

const nodes: any[] = [];
const renderedText: string[] = [];
let focused: any;
let narrow = false;
let modal = false;
let frames: (() => void)[] = [];
const resolve = (v: any): any => typeof v === "function" ? resolve(v()) : v;
const renderer = {
    ...solid, effect: solid.createRenderEffect, memo: solid.createMemo,
    createElement(tag: string) {
        const node: any = { tag, props: {}, style: {}, children: [], selectionStart: 0, selectionEnd: 0, scrollHeight: 30, scrollTop: 0,
            focus() { focused = node; }, matches() { return tag === "textarea"; }, setSelectionRange(start: number, end: number) { this.selectionStart = start; this.selectionEnd = end; },
            getBoundingClientRect: () => ({ top: 0, bottom: 100 }),
        };
        nodes.push(node);
        return node;
    },
    createTextNode: () => ({}), insertNode() {},
    setProp: (n: any, k: string, v: any) => { n.props[k] = v; return v; },
    insert: (_n: any, v: any) => solid.createRenderEffect(() => { const value = resolve(v); if (typeof value === "string") renderedText.push(value); return value; }),
};
const source = readFileSync(new URL("../../gui/src/components/Composer.tsx", import.meta.url), "utf8").replace(/^import .*;\n/gm, "");
const compiled = transformSync(source, { filename: "Composer.tsx", parserOpts: { plugins: ["typescript", "jsx"] }, presets: [[solidPreset, { generate: "universal", moduleName: "test-renderer" }]], configFile: false, babelrc: false })!.code!;
const js = new Bun.Transpiler({ loader: "ts" }).transformSync(compiled).replace(/import \{ ([\w$]+) as ([\w$]+) \} from "test-renderer";/g, "const $2 = renderer.$1;").replace("export function Composer", "function Composer");
const [session, setSession] = solid.createSignal<string | undefined>("a");
const [comparePicks, setComparePicks] = solid.createSignal<string[]>();
const runs: { request: RunRequest; response: ReturnType<typeof Promise.withResolvers<{ results: RunResult[] }>> }[] = [];
const runSheet = createRunSheet({
    start: (request) => { const response = Promise.withResolvers<{ results: RunResult[] }>(); runs.push({ request, response }); return response.promise; },
    trust: async () => {}, refresh: () => {},
});
const replies: ReturnType<typeof Promise.withResolvers<string[]>>[] = [];
let sends = 0;
const noop = () => undefined;
const components = Object.fromEntries(["ArrowUp", "FileText", "Folder", "ListEnd", "Paperclip", "Pencil", "Slash", "SquareTerminal", "X", "ModelPicker", "FastModeToggle", "EffortMenu", "ModePicker", "PlanMeter", "AttachmentChips", "InteractionTab", "Popover", "Ring"].map((key) => [key, noop]));
const deps = { ...solid, ...components, renderer, createComposerDraft, composerStorage, composingKey, revealMenuOption,
    comparePicks, setComparePicks, startRun: runSheet.startRun,
    createLifetimeGuard: () => (fn: any) => fn, wasDeleted: () => false,
    app: { conn: "open", homeCwd: "/workspace", settings: {}, models: [] },
    handleFor: () => ({ view: { state: { cwd: "/workspace", queued: [], interactions: [], model: {}, busy: false } }, draft: noop }),
    contextCardOpen: () => false, setContextCardOpen: noop, contextView: () => ({ ring: false }),
    focusComposer: () => 0, modelPickerOpen: () => false, modePickerOpen: () => false,
    setModelPickerOpen: noop, setModePickerOpen: noop, blockedBy: () => false,
    prefs: { enterSends: true }, mod: "⌘", isMod: (e: any) => e.metaKey, interrupt: noop,
    send: async (_text: string, _attachments: unknown[], opts: { accepted: (id: string) => void }) => { sends++; opts.accepted(session()); return true; }, toast: noop,
    rpc: { call: async (method: string) => { if (method === "commands.list") return [{ name: "help", description: "Help" }]; const reply = Promise.withResolvers<string[]>(); replies.push(reply); return reply.promise; } },
    window: { innerHeight: 800, matchMedia: () => ({ matches: narrow }) },
    document: { get activeElement() { return focused; }, querySelector: () => modal ? {} : undefined },
    requestAnimationFrame: (fn: () => void) => { frames.push(fn); return frames.length; }, cancelAnimationFrame: noop,
};
const Composer = new Function(...Object.keys(deps), `${js}; return Composer;`)(...Object.values(deps));
let dispose!: () => void;
solid.createRoot((d) => { dispose = d; Composer({ get sessionId() { return session(); }, compare: { available: true } }); });
const ta = nodes.find((n) => n.tag === "textarea");
const tick = () => { const queue = frames; frames = []; queue.forEach((f) => f()); };
const input = (text: string) => { ta.selectionStart = text.length; ta.selectionEnd = text.length; ta.props.onInput({ currentTarget: { value: text } }); };
const key = (key: string, extra = {}) => { const event = { key, isComposing: false, keyCode: 0, prevented: false, preventDefault() { this.prevented = true; }, stopPropagation() {}, ...extra }; ta.props.onKeyDown(event); return event; };
tick();
assert.equal(focused, ta);
await Bun.sleep(0);
input("/h");
assert.equal(ta.props.role, "combobox");
assert.equal(ta.props["aria-expanded"], true);
assert.ok(ta.props["aria-activedescendant"]);
assert.ok(nodes.some((n) => n.props.role === "option" && n.props["aria-selected"]));
for (const ime of [{ isComposing: true }, { keyCode: 229 }]) {
    assert.equal(key("Enter", ime).prevented, false);
    assert.equal(ta.props.value, "/h");
    assert.equal(sends, 0);
}
key("Escape");
assert.equal(ta.props["aria-expanded"], false);
assert.equal(ta.props["aria-activedescendant"], undefined);
input("@missing");
assert.ok(renderedText.includes("Searching…"));
assert.equal(ta.props["aria-expanded"], true);
assert.ok(nodes.some((n) => n.props.role === "listbox" && n.props["aria-busy"] === true));
await Bun.sleep(80);
replies.at(-1)!.resolve([]);
await Bun.sleep(0);
assert.equal(ta.props["aria-expanded"], true); // Empty state remains visible.
assert.ok(renderedText.includes("No matching files"));
assert.equal(ta.props["aria-activedescendant"], undefined);
input("@files");
await Bun.sleep(80);
replies.at(-1)!.resolve(["one", "two", "three"]);
await Bun.sleep(0);
const first = ta.props["aria-activedescendant"];
key("ArrowDown");
assert.notEqual(ta.props["aria-activedescendant"], first);
key("Enter");
assert.equal(ta.props.value, "@two ");
assert.equal(sends, 0);
tick();
input("@stale");
await Bun.sleep(80);
const stale = replies.at(-1)!;
setSession("b");
tick();
assert.equal(ta.props.value, "");
stale.resolve(["old-session-file"]);
await Bun.sleep(0);
assert.equal(ta.props["aria-expanded"], false);
assert.equal(ta.props["aria-activedescendant"], undefined);
composerStorage.remember("a", "only A");
composerStorage.remember("b", "older B");
composerStorage.remember("b", "newer B");
key("ArrowUp");
assert.equal(ta.props.value, "newer B");
ta.selectionStart = 0;
key("ArrowUp");
assert.equal(ta.props.value, "older B");
ta.selectionStart = ta.props.value.length;
key("ArrowDown");
assert.equal(ta.props.value, "newer B");
ta.selectionStart = ta.props.value.length;
key("ArrowDown");
assert.equal(ta.props.value, "");
const field = { matches: () => true };
focused = field;
setSession("c"); tick();
assert.equal(focused, field);
narrow = true; focused = undefined;
setSession("d"); tick();
assert.equal(focused, undefined);
narrow = false; modal = true;
setSession("e"); tick();
assert.equal(focused, undefined);
modal = false;
setSession("f"); tick();
assert.equal(focused, ta);
input("sent from F");
key("Enter");
await Bun.sleep(0);
assert.deepEqual(composerStorage.history("f"), ["sent from F"]);
assert.equal(composerStorage.draft("f"), "");
assert.equal(ta.props.value, "");
// Exercise the actual Home submit handler through the run-sheet controller.
setSession(undefined);
const models = ["mock:a", "mock:b"];
const success: RunResult = { ok: true, model: models[0]!, modelName: "A", sessionId: "run-a", branch: "run-a", path: "/workspace/run-a" };
const failure: RunResult = { ok: false, model: models[1]!, modelName: "B", error: "Unavailable" };
for (const results of [[failure, failure], [success, success], [success, failure]]) {
    // Separate user edits from the preceding clear's millisecond timestamp.
    await Bun.sleep(2);
    setComparePicks(models);
    const prompt = `Compare ${results.filter((r) => r.ok).length} successes`;
    input(prompt);
    composerStorage.flush();
    assert.equal(persisted().draft("home"), prompt);
    assert.ok(nodes.some((n) => n.props["aria-label"] === "Send to 2 models"));
    key("Enter");
    assert.deepEqual(runs.at(-1)!.request, { path: "/workspace", models, text: prompt, attachments: [], mode: "default" });
    runs.at(-1)!.response.resolve({ results });
    await Bun.sleep(0);
    runSheet.close();
    await Bun.sleep(0);
    const ok = results.some((r) => r.ok);
    assert.equal(ta.props.value, ok ? "" : prompt);
    assert.equal(persisted().draft("home"), ok ? "" : prompt);
    assert.equal(composerStorage.history("home").includes(prompt), ok);
    assert.equal(persisted().history("home").includes(prompt), ok);
    assert.deepEqual(comparePicks(), ok ? undefined : models);
    if (ok) {
        key("ArrowUp");
        assert.equal(ta.props.value, prompt);
    }
}
assert.equal(sends, 1); // Multi-model sends never use session.send.
await Bun.sleep(2);
setComparePicks(models);
input("Pending comparison");
key("Enter");
input("Newer Home draft");
runs.at(-1)!.response.resolve({ results: [success] });
await Bun.sleep(0);
runSheet.close();
await Bun.sleep(0);
assert.equal(ta.props.value, "Newer Home draft", "late run completion preserves the textarea");
assert.equal(persisted().draft("home"), "Newer Home draft", "late run completion preserves storage");
assert.equal(persisted().history("home").at(-1), "Pending comparison");
const list = { scrollTop: 20, getBoundingClientRect: () => ({ top: 100, bottom: 200 }) };
revealMenuOption(list as any, { getBoundingClientRect: () => ({ top: 190, bottom: 220 }) } as any);
assert.equal(list.scrollTop, 40);
revealMenuOption(list as any, { getBoundingClientRect: () => ({ top: 80, bottom: 110 }) } as any);
assert.equal(list.scrollTop, 20);
dispose();
composerStorage.flush();
