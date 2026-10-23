// Exercise Composer's actual reactive markup and handlers with a small in-memory renderer.
import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { transformSync } from "../../gui/node_modules/@babel/core/lib/index.js";
import solidPreset from "../../gui/node_modules/babel-preset-solid/index.js";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { createComposerDraft } from "../../gui/src/lib/composer-draft";
import { composerStorage, createComposerStorage } from "../../gui/src/lib/drafts";
import { composingKey, revealMenuOption } from "../../gui/src/lib/composer-menu";
import { matchSkills, skillToken } from "../../gui/src/lib/commands";
import { createRunSheet, type RunRequest } from "../../gui/src/lib/run-sheet";
import { firstSendable, followUpFor, otherFollowUp } from "../../gui/src/lib/queue";
import { canStop } from "../../gui/src/lib/session-status";
import { splitComments, takesComments, withComments } from "../../gui/src/lib/review-comments";
import { plural } from "../../gui/src/lib/format";
import { aroundOf, createReviewCommentStore } from "../../gui/src/state/review-comments";
import type { RunResult } from "../../src/server/protocol";
import { applyKeybindingsFile, keymap, matchKey, shortcut, shortcutHint, withShortcut } from "../../gui/src/state/keybindings";
import { eventStrokes } from "../../gui/src/lib/keystrokes";
import { os } from "../../gui/src/lib/platform";
import { expandedDown, expandedHeight, grow, GROW_MS } from "../../gui/src/lib/composer-size";
/** The keybindings follow the OS the tests run on (Mod is Ctrl off a Mac); the steer-or-queue key is Mod+Shift+Enter. */
const MOD = os === "macos" ? { metaKey: true } : { ctrlKey: true };

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
            getBoundingClientRect: () => ({ top: 0, bottom: 100 }), closest: () => undefined,
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
let commandLists = 0;
let holdSend: Promise<void> | undefined;
const commentStore = createReviewCommentStore(() => undefined);
const noop = () => undefined;
const components = Object.fromEntries(["ArrowUp", "CornerDownRight", "QueueTab", "GoalTab", "FileText", "Folder", "ListEnd", "Paperclip", "Pencil", "Slash", "Sparkles", "SquareTerminal", "X", "ModelPicker", "EffortPicker", "AtSign", "ModePicker", "ComposerMeter", "AttachmentChips", "InteractionTab", "Popover", "Ring", "ReviewCommentChips", "BackgroundChip", "Maximize2", "Minimize2"].map((key) => [key, noop]));
/** What the Steps strip was given: the session it's in and that session's view (StepsTray.tsx decides when it shows). */
const stepsTrays: { sessionId: string; view: any }[] = [];
const StepsTray = (p: { sessionId: string; view: any }) => void stepsTrays.push(p);
const [working, setWorking] = solid.createSignal(false);
const [goal, setGoal] = solid.createSignal<any>();
const [asks, setAsks] = solid.createSignal<any[]>([]);
const [activity, setActivity] = solid.createSignal<any>({ label: "Running bun test", since: Date.now() });
/** The last turn started an hour ago: an idle compaction counts from its own start, not from it. */
const turns = [{ startedAt: Date.now() - 3_600_000 }];
const sessionState = { cwd: "/workspace", queued: ["joins", "waits"], queueIds: [1, 2], queuedModes: ["steer", "queue"], get interactions() { return asks(); }, model: {}, get activity() { return activity(); }, get busy() { return working(); }, get goal() { return goal(); } };
let interrupts = 0;
const sent: { text: string; followUp?: string }[] = [];
/** What went with each message sent. */
const sentAttachments: unknown[][] = [];
const calls: { method: string; params: any }[] = [];
const appState = { conn: "open", homeCwd: "/workspace", settings: {} as { followUpBehavior?: string }, models: [] };
/** The composer opening or closing its large size told the conversation to glide with it. */
let dockGlides = 0;
const deps = { ...solid, ...components, StepsTray, expandedDown, expandedHeight, grow, GROW_MS, motionMs: () => 0, glideDock: () => void dockGlides++, shellLayout: () => ({ column: { h: 800 } }), renderer, createComposerDraft, composerStorage, composingKey, revealMenuOption, matchSkills, skillToken, firstSendable, followUpFor, otherFollowUp, canStop, now: () => Date.now(), turnDuration: (ms: number) => `${Math.round(ms / 1000)}s`, keymap, matchKey, withShortcut, shortcut, shortcutHint, eventStrokes,
    comparePicks, setComparePicks, startRun: runSheet.startRun,
    splitComments, takesComments, withComments, plural, setReview: noop,
    aroundOf, reviewComments: commentStore, newCommentId: () => crypto.randomUUID(),
    createLifetimeGuard: () => (fn: any) => fn, wasDeleted: () => false,
    app: appState,
    handleFor: () => ({ view: { state: sessionState, turns }, draft: noop }),
    contextCardOpen: () => false, setContextCardOpen: noop, contextView: () => ({ ring: false }),
    focusComposer: () => 0, modelPickerOpen: () => false, modePickerOpen: () => false, settingsTab: () => undefined, columnHeight: () => "800px",
    setModelPickerOpen: noop, setModePickerOpen: noop, blockedBy: () => false,
    readAttachment: async (f: { name: string }) => ({ kind: "image", name: f.name, size: 3, mediaType: "image/png", data: "cG5n" }),
    prefs: { enterSends: true }, mod: "⌘", isMod: (e: any) => e.metaKey, interrupt: () => void interrupts++,
    send: async (text: string, attachments: unknown[], opts: { accepted: (id: string) => void; followUp?: string }) => { sends++; sent.push({ text, followUp: opts.followUp }); sentAttachments.push(attachments); if (holdSend) await holdSend; opts.accepted(session()); return true; }, toast: noop, reportError: noop,
    rpc: { call: async (method: string, params: any) => { calls.push({ method, params }); if (method === "commands.list") { commandLists++; return [{ name: "help", description: "Help" }, { name: "pdf", description: "Read PDFs", skill: true }, { name: "compact", description: "Summarize", noAttachments: true }]; } const reply = Promise.withResolvers<string[]>(); replies.push(reply); return reply.promise; } },
    window: { innerHeight: 800, matchMedia: () => ({ matches: narrow }) },
    document: { get activeElement() { return focused; }, querySelector: () => modal ? {} : undefined, documentElement: { getBoundingClientRect: () => ({ top: 0, bottom: 800 }) } },
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
// The Steps strip goes in the composer's stack, with this session's view.
assert.equal(stepsTrays.length, 1);
assert.equal(stepsTrays[0]!.sessionId, "a");
assert.equal(stepsTrays[0]!.view.state, sessionState);
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
// $ opens the skills at the cursor (asking the server again for new ones); the pick goes where the $ was.
const listsBefore = commandLists;
input("fill it in with $");
assert.equal(commandLists, listsBefore + 1);
await Bun.sleep(0);
input("fill it in with $p");
assert.equal(ta.props["aria-expanded"], true);
assert.ok(renderedText.includes("Read PDFs"));
key("Enter");
assert.equal(ta.props.value, "fill it in with $pdf ");
assert.equal(sends, 0);
// Prices and shell variables don't open it.
input("costs $5");
assert.equal(ta.props["aria-expanded"], false);
input("echo $HOME");
assert.equal(ta.props["aria-expanded"], false);
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
{
    // A long draft stops at its modest height and scrolls (composer.css): the expand button shows. It, or Mod+Shift+E,
    // opens it large (here, as far down the page as there's room) and closes it again; sending closes it.
    const root = nodes.find((n) => typeof n.props.class === "string" && n.props.class.startsWith("composer "));
    const cls = () => String(root.props.class).split(/\s+/);
    const expandButtons = () => nodes.filter((n) => n.props.class === "cb c-expand").length;
    Object.assign(ta, { scrollHeight: 400, clientHeight: 154, offsetHeight: 154 });
    input("a long draft");
    tick();
    assert.ok(cls().includes("expandable"), "past the modest height the expand button shows");
    assert.ok(!cls().includes("expanded"));
    assert.equal(expandButtons(), 1);
    assert.match(nodes.findLast((n) => n.props.class === "cb c-expand").props.title, /^Expand \(/, "its tooltip names its key");
    const glidesBefore = dockGlides;
    assert.equal(key("E", { ...MOD, shiftKey: true, code: "KeyE" }).prevented, true);
    assert.ok(cls().includes("expanded"));
    assert.equal(ta.style.height, "830px", "from 154px down to 24px above the page's foot (800px), less what's under the text");
    assert.equal(dockGlides, glidesBefore + 1, "the conversation glides with the dock");
    assert.equal(focused, ta);
    nodes.findLast((n) => n.props.class === "cb c-expand").props.onClick();
    assert.ok(!cls().includes("expanded"), "the button closes it");
    assert.ok(cls().includes("expandable"));
    key("E", { ...MOD, shiftKey: true, code: "KeyE" });
    assert.ok(cls().includes("expanded"));
    key("Enter");
    await Bun.sleep(0);
    assert.equal(sent.at(-1)!.text, "a long draft");
    assert.ok(!cls().includes("expanded"), "sending closes it");
    // ↑ in the empty box still brings the last message back.
    Object.assign(ta, { scrollHeight: 30, clientHeight: 44 });
    tick();
    assert.ok(!cls().includes("expandable"), "a short draft fits: no button");
    key("ArrowUp");
    assert.equal(ta.props.value, "a long draft");
    input("");
    tick();
    // A send that completes late doesn't close a newer draft opened large meanwhile.
    const gate = Promise.withResolvers<void>();
    holdSend = gate.promise;
    Object.assign(ta, { scrollHeight: 400, clientHeight: 154 });
    input("sent slowly");
    key("Enter");
    await Bun.sleep(0);
    input("the next long draft");
    tick();
    key("E", { ...MOD, shiftKey: true, code: "KeyE" });
    assert.ok(cls().includes("expanded"));
    // The keys let go (mod+shift held flips the send button's way).
    ta.props.onKeyUp({ key: "Shift", isComposing: false, keyCode: 0 });
    gate.resolve();
    holdSend = undefined;
    await Bun.sleep(0);
    tick();
    assert.equal(ta.props.value, "the next long draft", "the newer draft stays");
    assert.ok(cls().includes("expanded"), "and stays open large");
    nodes.findLast((n) => n.props.class === "cb c-expand").props.onClick();
    Object.assign(ta, { scrollHeight: 30, clientHeight: 44 });
    input("");
    tick();
    assert.ok(!cls().includes("expanded"));
}
// While a turn runs: Enter does what the setting says (steer by default), mod+shift+enter the other; idle, neither is sent.
assert.equal(sent.at(-1)!.followUp, undefined);
setWorking(true);
assert.match(ta.props.placeholder, /^Steer/);
// Writing while it runs: the key that sends it the other way shows by the send button.
const altHints = () => nodes.filter((n) => n.props.class === "c-alt").length;
const hintsBefore = altHints();
input("steer this");
assert.equal(altHints(), hintsBefore + 1, "the other way's key shows once something is written");
assert.ok(renderedText.includes("queue"), "it names the other way: queue");
key("Enter");
await Bun.sleep(0);
assert.deepEqual(sent.at(-1), { text: "steer this", followUp: "steer" });
input("queue this");
assert.equal(key("Enter", { ...MOD, shiftKey: true }).prevented, true);
await Bun.sleep(0);
assert.deepEqual(sent.at(-1), { text: "queue this", followUp: "queue" });
appState.settings.followUpBehavior = "queue";
input("waits by default");
key("Enter");
await Bun.sleep(0);
assert.deepEqual(sent.at(-1), { text: "waits by default", followUp: "queue" });
input("steers this once");
key("Enter", { ...MOD, shiftKey: true });
await Bun.sleep(0);
assert.deepEqual(sent.at(-1), { text: "steers this once", followUp: "steer" });
// Nothing typed: mod+shift+enter sends the first queued message that isn't already steering.
const sendsBefore = sends;
key("Enter", { ...MOD, shiftKey: true });
assert.equal(sends, sendsBefore);
assert.deepEqual(calls.at(-1), { method: "session.sendQueuedNow", params: { id: "f", queueId: 2 } });
// Custom bindings, explicit unbinding and a pending chord take precedence over the queue shortcut.
input("keep this draft");
for (const binding of [null, "app:interrupt"]) {
    applyKeybindingsFile({ path: "/test/keybindings.json", text: JSON.stringify({ bindings: [{ context: "Global", bindings: { "mod+shift+enter": binding } }] }) });
    key("Enter", { ...MOD, shiftKey: true });
    assert.equal(sends, sendsBefore);
    assert.equal(ta.props.value, "keep this draft");
}
applyKeybindingsFile({ path: "/test/keybindings.json", text: JSON.stringify({ bindings: [{ context: "Global", bindings: { "mod+shift+enter t": "app:interrupt" } }] }) });
assert.equal(key("Enter", { ...MOD, shiftKey: true }).prevented, true);
assert.equal(sends, sendsBefore);
key("t");
assert.equal(sends, sendsBefore);
// Moved to another key: that key sends the other way, and the send button says so.
applyKeybindingsFile({ path: "/test/keybindings.json", text: JSON.stringify({ bindings: [{ context: "Chat", bindings: { "alt+s": "chat:submitOtherWay" } }] }) });
assert.equal(key("s", { altKey: true }).prevented, true);
await Bun.sleep(0);
assert.deepEqual(sent.at(-1), { text: "keep this draft", followUp: "steer" });
input("titled");
assert.ok(nodes.some((n) => typeof n.props.title === "string" && n.props.title.endsWith(`-click or ${shortcut("chat:submitOtherWay")} to steer instead.`)), "the send button names the moved key");
applyKeybindingsFile({ path: "/test/keybindings.json", text: JSON.stringify({ bindings: [{ context: "Global", bindings: { "mod+shift+enter": null } }] }) });
assert.ok(nodes.some((n) => typeof n.props.title === "string" && n.props.title.endsWith("-click to steer instead.")), "an unbound key isn't named");
applyKeybindingsFile({ path: "/test/keybindings.json" });
// The opposite-send shortcut still works with file suggestions open.
input("@queue-file");
await Bun.sleep(80);
replies.at(-1)!.resolve(["queue-file.ts"]);
await Bun.sleep(0);
assert.equal(ta.props["aria-expanded"], true);
assert.equal(key("Enter", { ...MOD, shiftKey: true }).prevented, true);
await Bun.sleep(0);
assert.deepEqual(sent.at(-1), { text: "@queue-file", followUp: "steer" });
// Moved to Mod+Enter, it still sends with the suggestions open: only a plain Enter takes the suggestion.
applyKeybindingsFile({ path: "/test/keybindings.json", text: JSON.stringify({ bindings: [{ context: "Chat", bindings: { "mod+enter": "chat:submitOtherWay" } }] }) });
input("@queue-again");
await Bun.sleep(80);
replies.at(-1)!.resolve(["queue-file.ts"]);
await Bun.sleep(0);
assert.equal(ta.props["aria-expanded"], true);
assert.equal(key("Enter", MOD).prevented, true);
await Bun.sleep(0);
assert.deepEqual(sent.at(-1), { text: "@queue-again", followUp: "steer" });
applyKeybindingsFile({ path: "/test/keybindings.json" });
input("");
appState.settings.followUpBehavior = undefined;
setWorking(false);
// Esc stops a goal of the loop here between its turns (a check or a retry coming): it pauses it. Not a paused one, or a CLI's.
const stopsBefore = interrupts;
key("Escape");
assert.equal(interrupts, stopsBefore);
for (const state of ["checking", "waiting", "active"]) {
    setGoal({ condition: "the tests pass", state, judge: "model" });
    assert.equal(key("Escape").prevented, true);
}
assert.equal(interrupts, stopsBefore + 3);
const stop = nodes.findLast((n) => n.props.class === "send stop");
assert.equal(stop?.props.title, "Pause the goal (Esc)");
for (const g of [{ state: "paused", judge: "model" }, { state: "active", judge: "native" }]) {
    setGoal({ condition: "the tests pass", ...g });
    key("Escape");
}
assert.equal(interrupts, stopsBefore + 3);
setGoal(undefined);
// No status row while a turn runs: the turn's live line says what it's doing; the box keeps its height,
// with "esc" beside the stop button.
const escs = () => nodes.filter((n) => n.props.class === "c-alt c-esc").length;
const escsBefore = escs();
setWorking(true);
assert.equal(nodes.filter((n) => n.props.class === "c-status").length, 0, "no status row");
assert.ok(!renderedText.includes("Running bun test"), "the composer doesn't say what the turn is doing");
assert.equal(escs(), escsBefore + 1, "an esc hint beside the stop button");
setActivity({ label: "Compacting", since: Date.now() - 2000, idle: true });
assert.ok(!renderedText.includes("Compacting"), "nor an idle compaction (the transcript's live line does)");
setActivity({ label: "Running bun test", since: Date.now() });
setWorking(false);
// The mention button puts an @ at the caret (after a space) and asks for files.
input("look at");
const mentionsBefore = calls.filter((c) => c.method === "fs.mentions").length;
nodes.findLast((n) => n.props["aria-label"] === "Mention a file").props.onClick();
assert.equal(ta.props.value, "look at @");
tick();
assert.equal(ta.selectionStart, "look at @".length);
await Bun.sleep(80);
assert.equal(calls.filter((c) => c.method === "fs.mentions").length, mentionsBefore + 1);
replies.at(-1)!.resolve([]);
await Bun.sleep(0);
input("");
// Exercise the actual Home submit handler through the run-sheet controller.
const sessionSends = sends;
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
assert.equal(sends, sessionSends); // Multi-model sends never use session.send.
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
// A comment edited (here or in another window) while its message is on the way keeps the new text.
{
    setComparePicks(undefined);
    setSession("c");
    await Bun.sleep(0);
    const id = "c";
    const comment = (cid: string, text: string) => ({ id: cid, path: "a.ts", start: { side: "new" as const, line: 1 }, end: { side: "new" as const, line: 1 }, text, snippet: "@@ -1,1 +1,1 @@\n+x", created: 1 });
    commentStore.add(id, comment("sent", "Original text"));
    commentStore.add(id, comment("unchanged", "Also sent"));
    const gate = Promise.withResolvers<void>();
    holdSend = gate.promise;
    input("With comments");
    key("Enter");
    await Bun.sleep(0);
    assert.ok(sent.at(-1)!.text.includes("Original text") && sent.at(-1)!.text.includes("Also sent"));
    commentStore.edit(id, "sent", "NEW UNSENT TEXT");
    commentStore.add(id, comment("later", "Added meanwhile"));
    gate.resolve();
    holdSend = undefined;
    await Bun.sleep(0);
    assert.deepEqual(commentStore.list(id).map((c) => [c.id, c.text]), [["sent", "NEW UNSENT TEXT"], ["later", "Added meanwhile"]]);
}
// With screenshots pasted in, / still opens the commands; one that would drop them says so, and the others run with them.
{
    let pastePrevented = false;
    ta.props.onPaste({ clipboardData: { files: [{ name: "one.png" }, { name: "two.png" }, { name: "three.png" }], getData: () => "" }, preventDefault: () => { pastePrevented = true; } });
    await Bun.sleep(0);
    assert.ok(pastePrevented);
    const warnings = () => nodes.filter((n) => n.props.class === "cm-desc cm-warn truncate").length;
    const warned = warnings();
    input("/");
    assert.equal(ta.props["aria-expanded"], true, "the / menu opens with images attached");
    assert.ok(nodes.some((n) => n.props.role === "option" && n.props["aria-selected"]));
    assert.equal(warnings(), warned + 1, "/compact says it doesn't take attachments");
    input("/hel");
    key("Enter");
    await Bun.sleep(0);
    assert.equal(sent.at(-1)!.text, "/help");
    assert.deepEqual((sentAttachments.at(-1) as { name: string }[]).map((a) => a.name), ["one.png", "two.png", "three.png"], "the command goes with the images");
    assert.equal(ta.props.value, "");
}
dispose();
composerStorage.flush();
