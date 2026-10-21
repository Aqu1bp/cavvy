"use strict";
/* Harness glass redesign: interactive mockup. A scripted fake agent drives
   everything; no models are called. All data is sample data. */

// ---------- Helpers ------------------------------------------------------
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const I = (n, s = 16, w = 1.75, cls = "") =>
    `<span class="ic ${cls}"><svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round">${ICONS[n] ?? ""}</svg></span>`;
// Provider marks: the same ones the GUI ships in ProviderIcon.tsx.
const PI = (id, s = 16, key = "x") => {
    const m = PROVIDERS[id];
    if (!m) return "";
    return `<svg class="pi" width="${s}" height="${s}" viewBox="${m.viewBox}"${m.mono ? ' fill="currentColor"' : ""}${m.evenodd ? ' fill-rule="evenodd"' : ""} aria-hidden="true">${m.body.replaceAll("$ID", `pi-${id}-${key}-`)}</svg>`;
};
// Effort: bars that fill to the level, instead of a brain icon.
const EG = (level) => `<span class="eg">${[1, 2, 3, 4, 5].map((i) => `<i class="${i <= level ? "on" : ""}" style="height:${2 + i * 2}px"></i>`).join("")}</span>`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const base = (p) => p.split("/").pop();
const dir = (p) => p.split("/").slice(0, -1).join("/") || ".";
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const clock = (ms) => { const t = Math.floor(ms / 1000); return t < 60 ? `${t}s` : `${Math.floor(t / 60)}m ${String(t % 60).padStart(2, "0")}s`; };
const ago = (at) => { const m = Math.floor((Date.now() - at) / 60000); return m < 1 ? "now" : m < 60 ? `${m}m` : m < 1440 ? `${Math.floor(m / 60)}h` : `${Math.floor(m / 1440)}d`; };
const md = (t) => t.split(/\n\n+/).map((p) => `<p>${esc(p).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")}</p>`).join("");
let uid = 0;
const id = () => `b${++uid}`;
const fresh = (o) => o.fresh && (o.freshAt ??= Date.now()) > Date.now() - 600;
const root = document.documentElement, body = document.body;

// ---------- Static data -------------------------------------------------
const MODELS = [
    { h: "Claude, through Claude Code", prov: "claude-code" },
    { id: "opus", label: "Opus 5.5", prov: "anthropic", desc: "Most capable, for hard and long tasks", fast: true },
    { id: "sonnet", label: "Sonnet 5.5", prov: "anthropic", desc: "Fast and capable for everyday work" },
    { id: "haiku", label: "Haiku 5.5", prov: "anthropic", desc: "Fastest, for small tasks" },
    { h: "Codex", prov: "codex" },
    { id: "astra", label: "GPT-6 Astra", prov: "openai", desc: "Uses your Codex sign-in", levels: ["low", "medium", "high", "xhigh"], fast: true },
    { h: "Ollama on this Mac", prov: "ollama" },
    { id: "qwen", label: "qwen3-coder 30B", prov: "ollama", desc: "Runs locally", levels: [] },
];
const modelOf = (m) => MODELS.find((x) => x.id === m) ?? MODELS[1];
const EFFORTS = [
    { id: "low", label: "Low", desc: "Fastest replies, for simple tasks.", lv: 1 },
    { id: "medium", label: "Medium", desc: "Balanced speed and depth.", lv: 2 },
    { id: "high", label: "High", desc: "Thorough reasoning for real changes.", lv: 3 },
    { id: "xhigh", label: "Extra high", desc: "More time on hard problems.", lv: 4 },
    { id: "max", label: "Max", desc: "The deepest reasoning this model offers.", lv: 5 },
];
const effortOf = (e) => EFFORTS.find((x) => x.id === e) ?? EFFORTS[2];
// The levels a model takes (the server sends them as effortLevels); none means it has no reasoning control.
const levelsOf = (m) => { const l = modelOf(m).levels; return l ? EFFORTS.filter((e) => l.includes(e.id)) : EFFORTS; };
// The supported level closest to the one asked for, so switching models never leaves an effort it can't take.
const fitEffort = (m, e) => { const ls = levelsOf(m); if (!ls.length || ls.some((x) => x.id === e)) return e; const lv = effortOf(e).lv; return ls.reduce((a, b) => (Math.abs(b.lv - lv) < Math.abs(a.lv - lv) ? b : a)).id; };
const MODES = [
    { id: "default", label: "Manual", icon: "hand", desc: "Ask before edits, commands and other side effects" },
    { id: "acceptEdits", label: "Accept edits", icon: "file-pen", desc: "Edit files in the workspace without asking" },
    { id: "plan", label: "Plan", icon: "map", desc: "Research and propose a plan; change nothing until approved" },
    { id: "auto", label: "Auto", icon: "zap", desc: "A reviewer model approves routine actions; risky ones ask" },
    { id: "bypassPermissions", label: "Bypass", icon: "shield-alert", desc: "Run everything without asking (sandboxes only)" },
];
const modeOf = (m) => MODES.find((x) => x.id === m) ?? MODES[0];
const SLASH = [
    { id: "model", desc: "Switch the model" },
    { id: "mode", desc: "Change the permission mode" },
    { id: "new", desc: "Start a new session" },
    { id: "rename", desc: "Rename this session" },
    { id: "fork", desc: "Copy this session into a new one" },
    { id: "compact", desc: "Summarize the conversation to free up context" },
    { id: "context", desc: "Show how much context is used" },
    { id: "usage", desc: "Show plan usage" },
    { id: "settings", desc: "Open Settings" },
];
const FILES = [
    "gui/src/components/Sidebar.tsx", "gui/src/components/Composer.tsx", "gui/src/components/TerminalPanel.tsx",
    "gui/src/lib/session-order.ts", "gui/src/lib/composer-draft.ts", "gui/src/state/app.ts", "gui/src/state/prefs.ts",
    "gui/src/styles/tokens.css", "scripts/test-shard.ts", "src/providers/openai-compat.ts", "src/providers/registry.ts",
];
const PROJECTS = { "my-own-harness": "main", "codex-bridge": "main" };

// Context around each change, so the review pane reads like a real diff.
const CTX = {
    "gui/src/lib/session-order.ts": { fn: "sessionOrder", head: ['import type { Session } from "../state/app";', "", "/** Newest first. */"], pre: ["", "/** The order the sidebar lists sessions in. */"], post: ["", "export const isRunning = (s: Session) => s.status === \"running\";"], total: 31 },
    "gui/src/components/Sidebar.tsx": { fn: "SessionList", head: ['import { createMemo, For } from "solid-js";', 'import { sessionOrder, isRunning } from "../lib/session-order";', 'import { SessionRow } from "./SessionRow";'], pre: ["export function SessionList(p: { sessions: Session[] }) {", "    const [renaming, setRenaming] = createSignal<string>();"], post: ["    return <For each={ordered()}>{(s) => <SessionRow s={s} renaming={renaming() === s.id} />}</For>;", "}"], total: 412 },
    "gui/src/lib/composer-draft.ts": { fn: "saveDraft", head: ['import { read, write } from "./storage";', "", "const DRAFTS_KEY = \"harness.drafts\";"], pre: ["let timer: ReturnType<typeof setTimeout> | undefined;", "const pending = new Map<string, string>();", ""], post: ["", "function flush() {", "    write(DRAFTS_KEY, { ...all(), ...Object.fromEntries(pending) });"], total: 64 },
    "gui/src/App.tsx": { fn: "onKeyDown", head: ['import { createEffect, onMount } from "solid-js";', 'import { isMod, isTerminalToggle } from "./lib/platform";'], pre: ["function onKeyDown(e: KeyboardEvent) {", "    if (e.defaultPrevented) return;"], post: ["    if (isMod(e) && e.key === \"k\") setPaletteOpen(true);", "}"], total: 640 },
    "scripts/test-shard.ts": { fn: "shard", head: ['import timings from "../test/timings.json";', "", "const time = (f: string) => timings[f] ?? median;"], pre: ["/** The files shard `index` of `n` runs. */"], post: ["", "if (import.meta.main) console.log(shard(files, n).join(\"\\n\"));"], total: 88 },
    "src/providers/openai-compat.ts": { fn: "request", head: ['import type { Route } from "./registry";', 'import { toChat } from "./chat";'], pre: ["export async function request(route: Route, messages: Message[]) {"], post: ["    return fetch(route.url, { method: \"POST\", body: JSON.stringify(body) });", "}"], total: 210 },
    "gui/src/state/app.ts": { fn: "apply", head: ['import { createStore } from "solid-js/store";'], pre: ["/** Folds one server event into the session's state. */"], post: ["", "export function handleFor(id: string) {"], total: 980 },
};

// What the fake agent "finds" depends on words in the prompt.
const AREAS = [
    {
        re: /sidebar|session|rail|list|flicker|row/,
        reads: ["gui/src/components/Sidebar.tsx", "gui/src/lib/session-order.ts", "gui/src/state/app.ts"], search: "SessionRow",
        file: "gui/src/components/Sidebar.tsx", test: "test/gui-sidebar-component.test.ts",
        finding: "Rows in `Sidebar.tsx` are keyed by their index. Any reorder remounts them, which drops their hover and rename state.",
        fix: "I'll key them by session id and add a test that reorders mid-rename.",
        explain: "Each session row comes from `SessionRow` in `Sidebar.tsx`. The list is ordered by `sessionOrder()`, which sorts on when each session's last turn started.\n\nWhen Harness restarts, the server reloads each session from disk and the GUI asks for its history, so the transcript, the plan and the changed files come back as they were.",
        summary: "Done. Rows are keyed by session id, so reordering keeps their state, and the new test covers a reorder during a rename.",
        plan: ["Key session rows by id", "Keep rename state across reorders", "Test a reorder mid-rename"],
        hunk: [["c", 41, "export function SessionList(p: { sessions: Session[] }) {"], ["d", 42, "    return <For each={p.sessions}>{(s, i) => <SessionRow key={i()} s={s} />}</For>;"], ["a", 42, "    // Key by id: an index key remounts every row the list reorders."], ["a", 43, "    return <For each={p.sessions}>{(s) => <SessionRow key={s.id} s={s} />}</For>;"], ["c", 44, "}"]],
    },
    {
        re: /composer|input|draft|send|prompt box|queue|type/,
        reads: ["gui/src/components/Composer.tsx", "gui/src/lib/composer-draft.ts"], search: "saveDraft",
        file: "gui/src/lib/composer-draft.ts", test: "test/composer-draft.test.ts",
        finding: "Drafts are saved on every keystroke, and `saveDraft` writes the whole draft map each time.",
        fix: "I'll debounce the save and only write the session that changed.",
        explain: "The composer keeps one draft per session in `composer-draft.ts`. Typing updates it in memory and saves it, so switching sessions or restarting keeps what you typed.\n\nWhile a turn runs, Enter queues the message instead of sending it; the queue sends in order when the turn ends.",
        summary: "Done. Drafts save 300ms after you stop typing and only for the session you're in. The test checks both.",
        plan: ["Debounce draft saves", "Write only the changed session", "Test the debounce and the single write"],
        hunk: [["c", 18, "export function saveDraft(id: string, text: string) {"], ["d", 19, "    write(DRAFTS_KEY, { ...all(), [id]: text });"], ["a", 19, "    pending.set(id, text);"], ["a", 20, "    clearTimeout(timer);"], ["a", 21, "    timer = setTimeout(flush, 300);"], ["c", 22, "}"]],
    },
    {
        re: /terminal|shell|pty|shortcut|keyboard/,
        reads: ["gui/src/components/TerminalPanel.tsx", "gui/src/lib/terminal.ts", "gui/src/App.tsx"], search: "isTerminalToggle",
        file: "gui/src/App.tsx", test: "test/gui-terminal-engine.test.ts",
        finding: "The terminal toggle is wired in `App.tsx` through `isTerminalToggle`, but only for Ctrl and the backtick key.",
        fix: "I'll add ⌘J alongside it and list both in Settings → Shortcuts.",
        explain: "The terminal is an xterm view in `TerminalPanel.tsx` attached to a shell the server runs per project. `terminal.ts` buffers output while it's hidden, so nothing is lost when you close it.",
        summary: "Done. ⌘J now toggles the terminal too, and Settings → Shortcuts lists it.",
        plan: ["Accept ⌘J as a terminal toggle", "List the shortcut in Settings", "Test both shortcuts"],
        hunk: [["c", 212, "if (isTerminalToggle(e)) {"], ["d", 213, "    setTerminalOpen(!terminalOpen());"], ["a", 213, "    toggleTerminal();"], ["a", 214, "} else if (isMod(e) && e.key === \"j\") {"], ["a", 215, "    toggleTerminal();"], ["c", 216, "}"]],
    },
    {
        re: /test|ci|flaky|shard|timing/,
        reads: ["scripts/test-shard.ts", "test/timings.json", ".github/workflows/ci.yml"], search: "median",
        file: "scripts/test-shard.ts", test: "test/test-shard.test.ts",
        finding: "`test-shard.ts` fills shards in file order, so the slowest files can all land on one machine.",
        fix: "I'll sort files by recorded time, slowest first, and put each on the shard with the least time so far.",
        explain: "CI splits the suite across four machines with `scripts/test-shard.ts`. Each file's time comes from `test/timings.json`; a new file counts as the median until timings are refreshed.",
        summary: "Done. Shards now balance by recorded time. On the current timings the slowest shard drops from about 3m 40s to 2m 50s in the test's estimate.",
        plan: ["Sort files by recorded time", "Assign each to the lightest shard", "Test that shards stay within 10% of each other"],
        hunk: [["c", 31, "export function shard(files: string[], n: number) {"], ["d", 32, "    return files.filter((_, i) => i % n === index);"], ["a", 32, "    const byTime = [...files].sort((a, b) => time(b) - time(a));"], ["a", 33, "    const load = Array(n).fill(0), out = Array.from({ length: n }, () => []);"], ["a", 34, "    for (const f of byTime) { const i = load.indexOf(Math.min(...load)); out[i].push(f); load[i] += time(f); }"], ["a", 35, "    return out[index];"], ["c", 36, "}"]],
    },
    {
        re: /model|provider|openrouter|anthropic|codex|cache/,
        reads: ["src/providers/openai-compat.ts", "src/providers/registry.ts"], search: "cache_control",
        file: "src/providers/openai-compat.ts", test: "test/openai-compat.test.ts",
        finding: "`openai-compat.ts` never sends `cache_control`, so OpenRouter can't cache the system prompt.",
        fix: "I'll mark the system prompt and the last tool result as cacheable when the route supports it.",
        explain: "Providers register in `registry.ts`. OpenAI-compatible ones, OpenRouter included, go through `openai-compat.ts`, which turns Harness messages into chat-completions requests.",
        summary: "Done. Requests to routes that support caching now mark the system prompt and the latest tool result.",
        plan: ["Detect routes that support caching", "Mark the system prompt and last tool result", "Test the request body"],
        hunk: [["c", 88, "const body = {"], ["c", 89, "    model: route.model,"], ["d", 90, "    messages: toChat(messages),"], ["a", 90, "    messages: route.caching ? withCacheMarks(toChat(messages)) : toChat(messages),"], ["c", 91, "};"]],
    },
];
const FALLBACK = {
    reads: ["gui/src/state/app.ts", "gui/src/lib/format.ts"], search: "handleFor",
    file: "gui/src/state/app.ts", test: "test/gui-app-state.test.ts",
    finding: "This goes through `app.ts`, where session state is updated from server events.",
    fix: "I'll make the change there and cover it with a test.",
    explain: "Most of what you see comes from `app.ts`: it holds each session's state and updates it from the server's event stream. Components read from it and never talk to the server directly.",
    summary: "Done. The change is in `app.ts` with a test next to the others.",
    plan: ["Find where this state changes", "Make the change", "Add a test"],
    hunk: [["c", 240, "function apply(s: SessionState, e: ServerEvent) {"], ["d", 241, "    s.updatedAt = e.at;"], ["a", 241, "    if (e.kind !== \"status\") s.updatedAt = e.at;"], ["c", 242, "    reduce(s, e);"], ["c", 243, "}"]],
};
const areaFor = (p) => [...AREAS.slice(1), AREAS[0]].find((a) => a.re.test(p.toLowerCase())) ?? FALLBACK;

const hl = (code) => esc(code)
    .replace(/(\/\/.*|\/\*\*.*\*\/)$/, '<span class="c">$1</span>')
    .replace(/\b(export|function|const|return|if|else|for|of|new|await|async|import|from|let|type)\b/g, '<span class="k">$1</span>')
    .replace(/(&quot;[^&]*&quot;)/g, '<span class="s">$1</span>')
    .replace(/\b([a-zA-Z_]+)(?=\()/g, '<span class="f">$1</span>');

// ---------- State --------------------------------------------------------
const prefs = {
    scheme: "light", accent: "blue", fs: 14.5, density: "comfortable", chatWidth: "standard", motion: "quick", glass: "glass", contrast: "standard",
    enterSends: true, expandActivity: false, notifications: true, showThinking: true, autoCompact: true, webSearch: "auto", editor: "Cursor", allowBypass: false,
    model: "opus", smallModel: "haiku", reviewer: "sonnet", defaultMode: "default", effort: "high",
};
const state = {
    sessions: [], active: null,
    insp: "changes",           // changes | plan
    review: null,              // { path } while the diff reader is open
    rvMode: "unified", unfold: {}, comments: {}, cEdit: null,
    search: "", speed: 1, usage: 62, prNext: 187,
    settings: null,            // section id while Settings is open
    inspW: 360, scale: 1,
    term: { open: false, h: 250, max: false, tabs: {}, active: {} },
    win: { mode: "fit", w: 1360, h: 880 },
    keys: [],                  // provider keys added in Settings
};
const cur = () => state.sessions.find((s) => s.id === state.active);
const MIN = 60000;

function mkSession(o) {
    return {
        id: `s${++uid}`, project: "my-own-harness", title: "New session", branch: "main", status: "idle", unread: false,
        at: Date.now(), blocks: [], changes: [], plan: [], model: prefs.model, effort: prefs.effort, mode: prefs.defaultMode,
        ctx: 12, queue: [], pending: null, run: null, started: 0, label: "", pr: null, commit: null, isNew: false,
        attach: [], draft: "", fresh: false, history: [], ...o,
    };
}
const B = (k, o) => ({ id: id(), k, v: 1, ...o });
const userB = (text, att = []) => B("user", { text, att });
const actsB = (items) => B("acts", { items: items.map(([icon, verb, p, x]) => ({ icon, verb, p, x })), live: false });
const proseB = (text) => B("prose", { text });
const editB = (file, hunk) => {
    const lines = hunk.map(([t, n, c]) => ({ t, n, c }));
    return B("edit", { file, lines, add: lines.filter((l) => l.t === "a").length, del: lines.filter((l) => l.t === "d").length, open: true });
};
const cmdB = (cmd, out, status = "ok", dur = 1800) => B("cmd", { cmd, out, status, dur });
const change = (path, add, del, kind = "m", lines = null) => ({ path, add, del, kind, live: false, lines });
const testLines = (name) => [["a", 1, `import { describe, expect, test } from "bun:test";`], ["a", 2, ""], ["a", 3, `test("${name}", () => {`], ["a", 4, `    const out = run(fixture());`], ["a", 5, `    expect(out).toEqual(expected);`], ["a", 6, `});`]];

function seed() {
    const flick = mkSession({
        title: "Session list flickers when a run ends", branch: "fix/session-flicker", at: Date.now(), ctx: 38, mode: "default",
        history: ["The session list flickers for a frame whenever a run finishes. Find out why and fix it.", "Also keep running sessions pinned to the top of their project."],
        blocks: [
            userB("The session list flickers for a frame whenever a run finishes. Find out why and fix it.", ["flicker.mov"]),
            actsB([["eye", "Read", "gui/src/components/Sidebar.tsx"], ["file-search", "Searched", "sessionOrder", "4 results"], ["eye", "Read", "gui/src/lib/session-order.ts"], ["eye", "Read", "gui/src/state/app.ts", "lines 210 to 288"]]),
            proseB("The list sorts on `updatedAt`. When a run ends the server sends the new `updatedAt` first and the status a moment later, so for one frame the finished session jumps up, then drops back.\n\nSorting on when the last turn started removes the gap, because that time doesn't change when a run ends."),
            editB("gui/src/lib/session-order.ts", [["c", 12, "export function sessionOrder(list: Session[]): Session[] {"], ["d", 13, "    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);"], ["a", 13, "    // A finished run sends updatedAt before its status. Sorting on"], ["a", 14, "    // the turn's start time keeps that gap from moving rows."], ["a", 15, "    return [...list].sort((a, b) => b.turnStartedAt - a.turnStartedAt);"], ["c", 16, "}"]]),
            cmdB("bun test ./test/gui-session-order.test.ts", ["✓ keeps order when status lands after updatedAt", "✓ new turn moves its session to the top", "14 pass, 0 fail"], "ok", 1800),
            proseB("Fixed, with a test for the case where the status arrives late. The list no longer moves when a run ends."),
            B("meta", { text: "Opus 5.5, high effort", dur: 72000 }),
            userB("Also keep running sessions pinned to the top of their project."),
            actsB([["eye", "Read", "gui/src/components/Sidebar.tsx"], ["list-checks", "Updated the plan", "", "3 steps"]]),
            editB("gui/src/components/Sidebar.tsx", [["c", 88, "const ordered = createMemo(() => {"], ["d", 89, "    return sessionOrder(p.sessions);"], ["a", 89, "    const list = sessionOrder(p.sessions);"], ["a", 90, "    // Running sessions first, newest first; the rest keep their order."], ["a", 91, "    return [...list.filter(isRunning), ...list.filter((s) => !isRunning(s))];"], ["c", 92, "});"]]),
        ],
        changes: [
            change("gui/src/lib/session-order.ts", 3, 1, "m", [["c", 12, "export function sessionOrder(list: Session[]): Session[] {"], ["d", 13, "    return [...list].sort((a, b) => b.updatedAt - a.updatedAt);"], ["a", 13, "    // A finished run sends updatedAt before its status. Sorting on"], ["a", 14, "    // the turn's start time keeps that gap from moving rows."], ["a", 15, "    return [...list].sort((a, b) => b.turnStartedAt - a.turnStartedAt);"], ["c", 16, "}"]]),
            change("gui/src/components/Sidebar.tsx", 3, 1, "m", [["c", 88, "const ordered = createMemo(() => {"], ["d", 89, "    return sessionOrder(p.sessions);"], ["a", 89, "    const list = sessionOrder(p.sessions);"], ["a", 90, "    // Running sessions first, newest first; the rest keep their order."], ["a", 91, "    return [...list.filter(isRunning), ...list.filter((s) => !isRunning(s))];"], ["c", 92, "});"]]),
            change("test/gui-session-order.test.ts", 6, 0, "a", testLines("keeps order when status lands after updatedAt")),
        ],
        plan: [{ t: "Sort on when the last turn started", st: "done" }, { t: "Pin running sessions to the top of their project", st: "done" }, { t: "Test pinning, and that finished runs drop back", st: "now" }],
    });
    const shard = mkSession({
        title: "Shard CI by file timings", branch: "ci/shard-timings", at: Date.now() - 3 * MIN, mode: "plan", ctx: 21,
        blocks: [
            userB("Split CI tests across the four machines by each file's recorded time instead of by count."),
            actsB([["eye", "Read", "scripts/test-shard.ts"], ["eye", "Read", "test/timings.json"], ["eye", "Read", ".github/workflows/ci.yml"]]),
            proseB("`test-shard.ts` fills shards in file order, so the slowest files can all land on one machine. Here's the plan."),
        ],
        plan: AREAS[3].plan.map((t) => ({ t, st: "todo" })),
    });
    const resume = mkSession({
        title: "Resumed turns drop only their closing note", branch: "fix/resume-note-match", at: Date.now() - 130 * MIN, ctx: 54, model: "sonnet", effort: "medium",
        blocks: [
            userB("When I resume a Codex session, the note at the end of the last turn disappears along with an earlier one. Only the closing note should go."),
            actsB([["eye", "Read", "src/agent/resume.ts"], ["file-search", "Searched", "closingNote", "2 results"]]),
            proseB("`stripNotes` matched every note with the same text, not just the one that closes the turn. It now matches by position."),
            editB("src/agent/resume.ts", [["c", 64, "function stripNotes(turn: Turn) {"], ["d", 65, "    turn.items = turn.items.filter((i) => i.text !== CLOSING);"], ["a", 65, "    if (turn.items.at(-1)?.text === CLOSING) turn.items.pop();"], ["c", 66, "}"]]),
            proseB("Merged as #163."),
            B("meta", { text: "Sonnet 5.5, medium effort", dur: 41000 }),
        ],
        pr: 163, prChecks: "passed",
    });
    const quick = (title, branch, at, q, answer, project = "my-own-harness", model = "opus") => mkSession({
        title, branch, at, project, ctx: 9, model,
        blocks: [userB(q), actsB([["eye", "Read", pick(FILES)], ["file-search", "Searched", pick(["cache_control", "menubar", "summary", "listModels"]), "3 results"]]), proseB(answer), B("meta", { text: `${modelOf(model).label}, high effort`, dur: 23000 })],
    });
    state.sessions = [
        flick, shard, resume,
        quick("OpenRouter cache_control", "main", Date.now() - 26 * 60 * MIN, "Does OpenRouter support cache_control on chat completions?", "It does for Anthropic and Gemini routes. `openai-compat.ts` doesn't send it yet, so every request pays for the full prompt. Worth a small change when you get to it."),
        quick("Usage in the menu bar", "feat/usage-menubar", Date.now() - 50 * 60 * MIN, "What would it take to show plan usage in the macOS menu bar?", "A tray icon from Tauri's tray API plus a small window for the details. The usage numbers already come from the server, so the menu bar only needs to subscribe to them."),
        quick("Stream reasoning summaries", "feat/reasoning-stream", Date.now() - 74 * 60 * MIN, "Can we stream reasoning summaries from app-server?", "Yes. app-server sends them as deltas, and the bridge can forward each one as it arrives instead of waiting for the item to finish.", "codex-bridge", "astra"),
        quick("Model list from app-server", "main", Date.now() - 120 * 60 * MIN, "Where does the model list come from?", "From app-server's model list call at startup. It's cached for the session, so a new model shows up after a restart.", "codex-bridge", "astra"),
    ];
    state.active = flick.id;
    // Terminals: one shell and a dev server per project to start with.
    state.term.tabs["my-own-harness"] = [
        tab("zsh", [`<span class="mut">Last login: Tue Oct 21 09:12:04 on ttys002</span>`, `${prompt("my-own-harness", "fix/session-flicker")} git status --short`, " M gui/src/components/Sidebar.tsx", " M gui/src/lib/session-order.ts", "?? test/gui-session-order.test.ts"]),
        tab("bun run dev", [`${prompt("my-own-harness", "fix/session-flicker")} bun run dev`, "$ vite", "", "  VITE v8.3.0  ready in 412 ms", "", "  ➜  Local:   http://localhost:5173/", "  ➜  press h + enter to show help"], true),
    ];
    state.term.tabs["codex-bridge"] = [tab("zsh", [])];
    return { flick, shard };
}

// ---------- Fake agent --------------------------------------------------
class Stop extends Error {}
class Denied extends Error {}
const wait = async (run, ms) => { await sleep(ms / state.speed); if (run.stopped) throw new Stop(); };
const add = (s, b) => { s.blocks.push(b); paint(); return b; };
const bump = (b) => { b.v++; paint(); };

function notify(s, msg, o) {
    if (s.id === state.active && !state.settings) return;
    s.unread = true;
    if (prefs.notifications) toast(msg, { ...o, action: { label: "Open", fn: () => select(s.id) } });
}
function setStatus(s, st) {
    const was = s.status;
    s.status = st;
    if (st === "waiting" && was !== "waiting") notify(s, `“${s.title}” needs you`, { kind: "warn", icon: "hand" });
    paint();
}

function startRun(s, script) {
    const run = { s, stopped: false, reject: null };
    s.run = run; s.started = Date.now(); s.label = "Thinking"; s.at = Date.now();
    setStatus(s, "running");
    (async () => {
        let result = "done";
        try { await script(run); }
        catch (e) {
            if (e instanceof Stop) {
                closeActs(s); clearThinking(s); stopStreams(s); add(s, B("note", { text: "Stopped. Nothing after this point ran.", kind: "stop" })); result = "idle";
                // Follow-ups queued behind the run come back to the message box instead of sending.
                const back = s.queue.splice(0).map((q) => q.text).join("\n");
                if (back) {
                    const ta = $("#input");
                    if (s === cur()) { ta.value = ta.value.trim() ? `${back}\n${ta.value}` : back; autosize(); ta.focus(); } else s.draft = s.draft.trim() ? `${back}\n${s.draft}` : back;
                }
            }
            else console.error(e);
        }
        s.pending = null; s.run = null; s.label = "";
        for (const c of s.changes) c.live = false;
        setStatus(s, result);
        if (result === "done") { state.usage = Math.min(97, state.usage + 2); notify(s, `“${s.title}” finished`, { kind: "ok", icon: "check" }); }
        const next = s.queue.shift();
        if (next) send(s, next.text, next.att, true);
    })();
    return run;
}
function stop(s) { if (!s?.run) return; s.run.stopped = true; s.run.reject?.(new Stop()); }
function clearThinking(s) { s.blocks = s.blocks.filter((b) => b.k !== "thinking"); paint(); }
function stopStreams(s) { for (const b of s.blocks) if (b.streaming) { b.streaming = false; bump(b); } for (const b of s.blocks) if (b.k === "cmd" && b.status === "run") { b.status = "stop"; bump(b); } }

async function think(run, text, ms = 900) {
    const s = run.s; clearThinking(s);
    s.label = text; add(s, B("thinking", { text }));
    await wait(run, ms);
    clearThinking(s);
}
function group(s) {
    const last = s.blocks.at(-1);
    if (last?.k === "acts" && last.live) return last;
    return add(s, B("acts", { items: [], open: true, live: true }));
}
function closeActs(s) {
    for (const b of s.blocks) if (b.k === "acts" && b.live) { b.live = false; b.open = undefined; for (const i of b.items) i.live = false; bump(b); }
}
async function act(run, icon, verb, p, x = "", ms = 650) {
    const s = run.s; clearThinking(s);
    const g = group(s);
    const it = { icon, verb, p, x, live: true };
    g.items.push(it); bump(g);
    s.label = verb === "Read" ? `Reading ${base(p)}` : verb === "Searched" ? `Searching for ${p}` : `${verb} ${p ? base(p) : ""}`.trim();
    s.ctx = Math.min(95, s.ctx + 2);
    await wait(run, ms + Math.random() * 300);
    it.live = false; bump(g);
}
async function say(run, text) {
    const s = run.s; clearThinking(s); closeActs(s);
    s.label = "Writing";
    const b = add(s, B("prose", { text: "", streaming: true }));
    const parts = text.match(/\S+\s*/g) ?? [];
    for (let i = 0; i < parts.length; ) {
        const n = 1 + Math.floor(Math.random() * 3);
        b.text += parts.slice(i, i + n).join(""); i += n; bump(b);
        await wait(run, 28 + Math.random() * 40);
    }
    b.text = text; b.streaming = false; bump(b);
}
function ask(run, p) {
    const s = run.s;
    s.pending = p; p.shown = performance.now(); s.label = "Waiting for you";
    setStatus(s, "waiting");
    return new Promise((res, rej) => {
        p.resolve = (v) => { s.pending = null; run.reject = null; setStatus(s, "running"); res(v); };
        run.reject = (e) => { s.pending = null; run.reject = null; rej(e); };
    });
}
async function setPlan(run, steps) {
    run.s.plan = steps.map((t) => ({ t, st: "todo" }));
    await act(run, "list-checks", "Updated the plan", "", `${steps.length} steps`, 500);
}
function step(s, i, st) { if (s.plan[i]) { s.plan[i].st = st; if (st === "now") s.plan.forEach((p, j) => { if (j < i) p.st = "done"; }); paint(); } }

async function edit(run, file, hunk) {
    const s = run.s; clearThinking(s); closeActs(s);
    if (s.mode === "default" && !run.editsOk) {
        const v = await ask(run, { kind: "edit", file, hunk });
        if (v === "deny") throw new Denied();
        if (v === "all") { s.mode = "acceptEdits"; toast("Edits apply without asking in this session", { icon: "file-pen" }); }
        run.editsOk = true;
    }
    s.label = `Editing ${base(file)}`;
    let c = s.changes.find((x) => x.path === file);
    if (!c) { c = change(file, 0, 0, "m", []); c.fresh = true; s.changes.push(c); }
    c.live = true; c.lines = hunk;
    const b = add(s, B("edit", { file, lines: [], add: 0, del: 0, open: true, live: true }));
    for (const [t, n, code] of hunk) {
        b.lines.push({ t, n, c: code });
        if (t === "a") { b.add++; c.add++; } if (t === "d") { b.del++; c.del++; }
        bump(b);
        await wait(run, 90 + Math.random() * 80);
    }
    b.live = false; c.live = false; bump(b);
    s.ctx = Math.min(95, s.ctx + 3);
    if (file.startsWith("gui/")) termEcho(s.project, "bun run dev", [`<span class="mut">${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" })}</span> <span class="ok">[vite]</span> hmr update /src/${esc(file.slice(8))}`]);
}

async function command(run, cmd, out, ok = true) {
    const s = run.s; clearThinking(s); closeActs(s);
    let auto = false;
    if (s.mode === "default" || s.mode === "acceptEdits") {
        const v = await ask(run, { kind: "cmd", cmd, why: "It isn't on this project's list of allowed commands." });
        if (v === "deny") { add(s, B("note", { text: `You declined ${cmd}.` })); return false; }
        if (v === "always") toast(`Allowed ${cmd.split(" ").slice(0, 2).join(" ")} in ${s.project}`, { icon: "shield-check", kind: "ok" });
    } else if (s.mode === "auto") auto = true;
    s.label = `Running ${cmd.split(" ").slice(0, 2).join(" ")}`;
    const b = add(s, B("cmd", { cmd, out: [], status: "run", t0: Date.now(), auto }));
    await wait(run, 500);
    for (const line of out) { b.out.push(line); bump(b); await wait(run, 220 + Math.random() * 200); }
    b.status = ok ? "ok" : "fail"; b.dur = Date.now() - b.t0; bump(b);
    return true;
}
const testOut = (test) => ["bun test v1.3.14", "", `${test}:`, `✓ ${pick(["handles the empty case", "keeps existing order", "applies the change once"])}`, `✓ ${pick(["survives a reorder", "debounces repeated calls", "matches the recorded times"])}`, `${7 + Math.floor(Math.random() * 12)} pass, 0 fail`];

async function agent(run, prompt) {
    const s = run.s, a = areaFor(prompt);
    const question = /^(why|how|what|where|when|which|explain|does|do|is|are|can you explain|tell me)\b/i.test(prompt.trim()) || prompt.trim().endsWith("?");
    await think(run, pick(["Looking at the code", "Finding where this lives", "Reading the relevant files"]), 1000);
    await act(run, "eye", "Read", a.reads[0]);
    await act(run, "file-search", "Searched", a.search, `${2 + Math.floor(Math.random() * 5)} results`);
    for (const r of a.reads.slice(1)) await act(run, "eye", "Read", r);
    if (question) { await say(run, a.explain); return finishTurn(run); }
    if (s.mode === "plan") return planThenBuild(run, a);
    await build(run, a, true);
}
async function planThenBuild(run, a) {
    const s = run.s;
    await setPlan(run, a.plan);
    await say(run, `${a.finding} Here's the plan.`);
    const v = await ask(run, { kind: "plan", steps: a.plan });
    await planChosen(run, a, v);
}
// What the plan card's answer does: 1 approve and accept edits, 2 approve and ask, 3 Auto mode, 4 keep planning.
async function planChosen(run, a, v) {
    const s = run.s;
    if (v === "keep") {
        const fb = run.feedback; run.feedback = null;
        await say(run, fb ? `Okay, I'll rework the plan: ${fb.replace(/[.!]?$/, ".")} Tell me if anything else should change.` : "Okay, I'll keep planning. Tell me what to change about it.");
        return finishTurn(run);
    }
    s.mode = v === "edits" ? "acceptEdits" : v === "auto" ? "auto" : "default";
    run.editsOk = v !== "ask";
    await build(run, a, false);
}
async function build(run, a, explain) {
    const s = run.s;
    if (explain) { await setPlan(run, a.plan); await say(run, `${a.finding} ${a.fix}`); }
    try {
        step(s, 0, "now");
        await edit(run, a.file, a.hunk);
        step(s, 1, "now");
        await act(run, "file-plus", "Created", a.test, "", 500);
        let c = s.changes.find((x) => x.path === a.test);
        if (!c) { c = change(a.test, 0, 0, "a", testLines(a.plan[2].toLowerCase())); c.fresh = true; s.changes.push(c); }
        c.add = c.lines.length;
        step(s, 2, "now");
        const ran = await command(run, `bun test ./${a.test}`, testOut(a.test));
        s.plan.forEach((p) => (p.st = "done"));
        await say(run, ran ? a.summary : `${a.summary.replace(/ The .*$/, "")} I didn't run the tests, so run \`bun test ./${a.test}\` before you merge.`);
    } catch (e) {
        if (!(e instanceof Denied)) throw e;
        await say(run, "Okay, I won't change files. Switch to Plan mode if you'd like me to lay out the change first.");
    }
    finishTurn(run);
}
function finishTurn(run) {
    const s = run.s;
    clearThinking(s); closeActs(s);
    add(s, B("meta", { text: `${modelOf(s.model).label}, ${effortOf(s.effort).label.toLowerCase()} effort`, dur: Date.now() - s.started }));
}
function resumeSeeds({ flick, shard }) {
    startRun(flick, async (run) => {
        flick.started = Date.now() - 102000;
        await wait(run, 400);
        const ran = await command(run, "bun test ./test/gui-sidebar-component.test.ts", testOut("test/gui-sidebar-component.test.ts"));
        flick.plan.forEach((p) => (p.st = "done"));
        await say(run, ran ? "Running sessions now stay at the top of their project, newest first. When a run ends its session drops back into place, and the test covers both." : "Running sessions now stay at the top of their project. I didn't run the tests, so run them before you merge.");
        finishTurn(run);
    });
    startRun(shard, async (run) => {
        shard.started = Date.now() - 180000;
        const v = await ask(run, { kind: "plan", steps: AREAS[3].plan });
        await planChosen(run, AREAS[3], v);
    });
}

// ---------- Shell (terminal tabs and "!" commands) ----------------------
let tuid = 0;
function tab(name, lines = [], busy = false) { return { id: `t${++tuid}`, name, lines, busy, hist: [], hi: -1, run: null }; }
const prompt = (project, branch) => `<span class="pr">~/${esc(project)}</span> <span class="mut">(${esc(branch)})</span> <span class="pr">❯</span>`;
const tabsFor = (p) => (state.term.tabs[p] ??= [tab("zsh")]);
const activeTab = (p) => { const ts = tabsFor(p); return ts.find((t) => t.id === state.term.active[p]) ?? ts[0]; };
function termEcho(project, name, lines) {
    const t = tabsFor(project).find((x) => x.name === name);
    if (t) { t.lines.push(...lines); paint(); }
}

// Runs a mock command. `out(line)` receives escaped HTML lines.
async function shell(cmd, s, out, live = { stopped: false }) {
    const [c0, ...rest] = cmd.trim().split(/\s+/);
    const arg = rest.join(" ");
    const L = (t, cls = "") => out(cls ? `<span class="${cls}">${esc(t)}</span>` : esc(t));
    const pause = async (ms) => { await sleep(ms / state.speed); if (live.stopped) throw new Stop(); };
    if (!c0) return true;
    if (c0 === "ls") { L("bin  desktop  gui  scripts  src  test  AGENTS.md  README.md  bun.lock  package.json  tsconfig.json"); return true; }
    if (c0 === "pwd") { L(`/Users/you/${s.project}`); return true; }
    if (c0 === "echo") { L(arg); return true; }
    if (c0 === "help") { L("Mock shell. Try: ls, pwd, git status, git log, git branch, git diff --stat, bun test, bun run dev, cat <file>, clear, exit"); return true; }
    if (c0 === "cat") { const f = CTX[arg] ?? CTX[FILES.find((x) => x.endsWith(arg)) ?? ""]; if (!f) { L(`cat: ${arg}: No such file or directory`, "bad"); return false; } f.head.forEach((x) => L(x)); return true; }
    if (c0 === "git") {
        if (rest[0] === "status") {
            L(`On branch ${s.branch}`);
            if (!s.changes.length) L("nothing to commit, working tree clean");
            else { L("Changes not staged for commit:"); s.changes.forEach((x) => L(`\t${x.kind === "a" ? "new file:" : "modified:"}   ${x.path}`, x.kind === "a" ? "ok" : "bad")); }
            return true;
        }
        if (rest[0] === "log") { ["78f01a73 Merge pull request #163 from fix/resume-note-match", "6c573570 Prompt and footer on the bottom rows again", "4755ef39 Merge pull request #162 from fix/repaint-at-turn-end", "7eb9bbc1 Resumed history: actions one a line"].forEach((x) => L(x)); return true; }
        if (rest[0] === "branch") { ["main", "fix/session-flicker", "ci/shard-timings", "feat/usage-menubar"].forEach((b) => L(`${b === s.branch ? "* " : "  "}${b}`, b === s.branch ? "ok" : "")); return true; }
        if (rest[0] === "diff") { s.changes.forEach((x) => L(` ${x.path} | ${x.add + x.del} ${"+".repeat(Math.min(20, x.add))}${"-".repeat(Math.min(20, x.del))}`)); L(` ${s.changes.length} files changed`); return true; }
        L(`git: '${rest[0] ?? ""}' is not a git command in this mockup.`, "bad"); return false;
    }
    if (c0 === "bun" && rest[0] === "test") {
        L("bun test v1.3.14", "mut"); await pause(300);
        const f = rest[1]?.replace(/^\.\//, "") ?? "test/gui-session-order.test.ts";
        L(""); L(`${f}:`); await pause(400);
        for (const t of ["keeps order when status lands after updatedAt", "new turn moves its session to the top", "running sessions stay pinned"]) { L(`✓ ${t}`, "ok"); await pause(260); }
        L(""); L(" 14 pass", "ok"); L(" 0 fail"); L("Ran 14 tests across 1 file. [1.21s]", "mut");
        return true;
    }
    if (c0 === "bun" && rest[0] === "run" && rest[1] === "dev") {
        L("$ vite", "mut"); await pause(500); L(""); L("  VITE v8.3.0  ready in 398 ms", "ok"); L(""); L("  ➜  Local:   http://localhost:5173/"); L("  ➜  press h + enter to show help", "mut");
        while (true) await pause(1000);
    }
    L(`zsh: command not found: ${c0}`, "bad");
    return false;
}

async function termRun(t, s, cmd) {
    t.lines.push(`${prompt(s.project, s.branch)} ${esc(cmd)}`);
    if (cmd.trim()) { t.hist.push(cmd); t.hi = -1; }
    if (cmd.trim() === "clear") { t.lines = []; return paint(); }
    if (cmd.trim() === "exit") return closeTab(s.project, t.id);
    if (/^bun run dev/.test(cmd.trim())) t.name = "bun run dev";
    const live = { stopped: false };
    t.run = live; t.busy = true; paint();
    try { await shell(cmd, s, (l) => { t.lines.push(l); paint(); }, live); }
    catch (e) { if (!(e instanceof Stop)) throw e; t.lines.push(`<span class="mut">^C</span>`); }
    t.run = null; t.busy = false; paint();
}
function closeTab(project, tid) {
    const ts = tabsFor(project), i = ts.findIndex((t) => t.id === tid);
    if (i < 0) return;
    ts[i].run && (ts[i].run.stopped = true);
    ts.splice(i, 1);
    if (!ts.length) { ts.push(tab("zsh")); setTerm(false); }
    if (state.term.active[project] === tid) state.term.active[project] = ts[Math.max(0, i - 1)].id;
    paint();
}
function newTab(project) {
    const ts = tabsFor(project);
    const t = tab(`zsh ${ts.filter((x) => x.name.startsWith("zsh")).length + 1}`.replace(/ 1$/, ""));
    ts.push(t); state.term.active[project] = t.id;
    setTerm(true);
}

// "!cmd" in the composer: you run it yourself; it lands in the conversation.
async function runYourself(s, cmd) {
    if (/^bun run dev/.test(cmd.trim())) {
        add(s, B("note", { text: "Long-running commands open in the terminal." }));
        newTab(s.project); const t = activeTab(s.project); termRun(t, s, cmd);
        return;
    }
    const b = add(s, B("cmd", { cmd, out: [], status: "run", t0: Date.now(), by: "you" }));
    let ok = true;
    try { ok = await shell(cmd, s, (l) => { b.out.push(l.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')); bump(b); }); }
    catch { ok = false; }
    b.status = ok ? "ok" : "fail"; b.dur = Date.now() - b.t0; bump(b);
}

// ---------- Actions ------------------------------------------------------
function autoTitle(p) {
    const words = p.replace(/[@/!]\S+/g, "").replace(/[^\w\s'-]/g, "").trim().split(/\s+/).slice(0, 7);
    while (words.length > 2 && /^(a|an|the|to|of|for|per|and|in|on|with|by|so|that)$/i.test(words.at(-1))) words.pop();
    const w = words.join(" ");
    return w ? w[0].toUpperCase() + w.slice(1) : "New session";
}
const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 28);

function send(s, text, att = [], fromQueue = false) {
    text = text.trim();
    if (!text) return;
    if (s.run && !fromQueue) { s.queue.push({ text, att }); paint(); return; }
    if (s.isNew) {
        s.isNew = false; s.title = autoTitle(text.replace(/^!/, ""));
        if (s.worktree) s.branch = `harness/${slug(s.title)}`;
        s.fresh = true;
    }
    s.history.push(text); s.hi = -1;
    const cm = state.comments[s.id];
    if (cm?.length) { att = [...att, `${cm.length} review comment${cm.length > 1 ? "s" : ""}`]; state.comments[s.id] = []; }
    if (text.startsWith("!")) { add(s, B("user", { text, att })); runYourself(s, text.slice(1)); }
    else { add(s, B("user", { text, att })); startRun(s, (run) => agent(run, text)); }
    requestAnimationFrame(() => scrollBottom(true));
}

function select(sid) {
    const s = state.sessions.find((x) => x.id === sid);
    if (!s) return;
    const prev = cur();
    if (prev) prev.draft = $("#input").value;
    state.active = sid; s.unread = false; state.review = null; state.cEdit = null;
    closeSettings();
    body.dataset.railopen = "off";
    $("#input").value = s.draft; autosize();
    layout(); paint(true);
    // The dock settles a frame later; until then its resizes keep the newest item in view.
    state.justOpened = true; clearTimeout(select.t); select.t = setTimeout(() => { state.justOpened = false; }, 500);
    requestAnimationFrame(() => scrollBottom());
}
function stepSession(d) {
    const list = Object.keys(PROJECTS).flatMap((p) => state.sessions.filter((s) => s.project === p).sort((a, b) => b.at - a.at));
    const i = list.findIndex((s) => s.id === state.active);
    const next = list[(i + d + list.length) % list.length];
    if (next) select(next.id);
}
function newSession(project = cur()?.project ?? "my-own-harness") {
    const existing = state.sessions.find((s) => s.isNew && !s.blocks.length);
    const s = existing ?? mkSession({ isNew: true, project, branch: PROJECTS[project], fresh: true });
    if (!existing) state.sessions.unshift(s);
    select(s.id);
    $("#input").focus();
}
function archive(sid) {
    const i = state.sessions.findIndex((s) => s.id === sid);
    const [s] = state.sessions.splice(i, 1);
    stop(s);
    if (state.active === sid) { const next = state.sessions.find((x) => x.project === s.project) ?? state.sessions[0]; if (next) select(next.id); else newSession(s.project); }
    toast(`Archived “${s.title}”`, { icon: "archive", ms: 8000, action: { label: "Undo", fn: () => { state.sessions.splice(i, 0, s); paint(); } } });
    paint();
}
function fork(s) {
    const f = mkSession({ ...structuredClone({ ...s, run: null, pending: null }), id: `s${++uid}`, title: `${s.title} (fork)`, run: null, pending: null, status: "idle", queue: [], fresh: true, at: Date.now() });
    f.blocks = f.blocks.map((b) => ({ ...b, id: id() }));
    state.sessions.unshift(f); select(f.id);
    toast("Forked into a new session", { icon: "git-fork" });
}
function renameStart() { const h = $("#ttl"); h.contentEditable = "true"; h.focus(); getSelection().selectAllChildren(h); }
function renameEnd(commit) {
    const h = $("#ttl"), s = cur();
    if (h.contentEditable !== "true") return;
    h.contentEditable = "false";
    if (commit && h.textContent.trim()) s.title = h.textContent.trim();
    h._h = null; paint();
}
function resolveAsk(v) {
    const s = cur(), p = s?.pending;
    if (!p) return;
    // Keep planning opens a feedback field first; pressed again (or Enter in the field), it sends.
    if (v === "keep" && p.fb === undefined) { p.fb = ""; paint(); setTimeout(() => $("#plan-fb")?.focus(), 30); return; }
    if (v === "keep") s.run.feedback = ($("#plan-fb")?.value ?? p.fb).trim();
    if (v === "save") {
        return dialog(`<h3>Save the plan</h3><p>As a Markdown file in the project.</p><div class="keyin" style="padding:0"><input id="dlg-plan" value="docs/plans/${slug(s.title)}.md" spellcheck="false" /></div><div class="row"><span class="grow"></span><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`,
            (sc) => { toast(`Saved the plan to ${$("#dlg-plan", sc).value}`, { kind: "ok", icon: "save" }); }, "#dlg-plan");
    }
    if (v === "worktree") {
        return dialog(`<h3>Build in a new worktree</h3><p>Approves the plan and builds it on its own branch, leaving this checkout as it is.</p><div class="keyin" style="padding:0"><input id="dlg-wt" value="harness/${slug(s.title)}" spellcheck="false" /></div><div class="row"><span class="grow"></span><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Create and build</button></div>`,
            (sc) => { s.branch = $("#dlg-wt", sc).value.trim() || s.branch; s.worktree = true; toast(`Created a worktree on ${s.branch}`, { kind: "ok", icon: "folder-git-2" }); resolveAsk("edits"); }, "#dlg-wt");
    }
    const el = $("#ask .ask");
    if (el) { el.classList.add("out"); setTimeout(() => p.resolve(v), 180); } else p.resolve(v);
}
const ASK_KEYS = { cmd: ["once", "always", "deny"], edit: ["once", "all", "deny"], plan: ["edits", "ask", "auto", "keep", "worktree", "save"] };
function cycleMode(s) {
    const order = ["default", "acceptEdits", "plan", "auto", ...(prefs.allowBypass ? ["bypassPermissions"] : [])];
    s.mode = order[(order.indexOf(s.mode) + 1) % order.length];
    toast(`${modeOf(s.mode).label}: ${modeOf(s.mode).desc}`, { icon: modeOf(s.mode).icon });
    paint();
}

// Panels
function toggleInsp(on = body.dataset.insp !== "on") { body.dataset.insp = on ? "on" : "off"; if (!on) state.review = null; layout(); paint(); }
function setTerm(on = !state.term.open) {
    state.term.open = on; layout(); paint();
    if (on) setTimeout(() => $("#tin")?.focus(), 60);
}
function openReview(path) { state.review = { path }; state.cEdit = null; body.dataset.insp = "on"; layout(); paint(); }
function closeReview() { state.review = null; state.cEdit = null; layout(); paint(); }
function toggleRail() {
    if (body.dataset.railmode === "overlay") body.dataset.railopen = body.dataset.railopen === "on" ? "off" : "on";
    else body.dataset.rail = body.dataset.rail === "off" ? "on" : "off";
    layout();
}
function openSettings(sec = "general") { state.settings = sec; body.dataset.settings = "on"; closeMenu(); paint(); }
function closeSettings() { if (!state.settings) return; state.settings = null; body.dataset.settings = "off"; paint(); }

// ---------- Toasts -------------------------------------------------------
function toast(msg, o = {}) {
    const el = document.createElement("div");
    el.className = `toast glass ${o.kind ?? ""}`;
    el.innerHTML = `${I(o.icon ?? "info", 15)}<span>${esc(msg)}</span>${o.action ? `<button class="btn ghost">${esc(o.action.label)}</button>` : ""}`;
    const close = () => { el.classList.add("out"); setTimeout(() => el.remove(), 240); };
    if (o.action) el.querySelector("button").onclick = () => { o.action.fn(); close(); };
    $("#toasts").append(el);
    while ($("#toasts").children.length > 2) $("#toasts").firstChild.remove();
    // Pointing at a toast holds it, so an Undo can't slip away under the cursor.
    let left = o.ms ?? 4200, t0 = Date.now(), timer = setTimeout(close, left);
    el.onpointerenter = () => { clearTimeout(timer); left -= Date.now() - t0; };
    el.onpointerleave = () => { t0 = Date.now(); timer = setTimeout(close, Math.max(1200, left)); };
}

// ---------- Menus --------------------------------------------------------
let menu = null;
function openMenu(anchor, items, onPick, o = {}) {
    closeMenu();
    const el = document.createElement("div");
    el.className = "menu glass";
    el.style.width = `${o.width ?? 280}px`;
    el.innerHTML = items.map((it, i) => it.h ? `<div class="mh">${it.prov ? PI(it.prov, 13, "mh") : ""}${esc(it.h)}</div>` : it.sep ? `<div class="msep"></div>` :
        `<div class="mi ${it.icon || it.prov || it.lv ? "" : "noicon"} ${it.danger ? "danger" : ""} ${it.dis ? "dis" : ""}" data-i="${i}">${it.prov ? PI(it.prov, 16, "mi") : it.lv ? EG(it.lv) : it.icon ? I(it.icon, 15) : ""}<span class="trunc"><span class="l">${esc(it.label)}</span>${it.desc ? `<span class="d">${esc(it.desc)}</span>` : ""}</span><span class="end">${it.kbd ? `<span class="kbd">${esc(it.kbd)}</span>` : ""}${it.check ? I("check", 15, 2, "ck") : ""}</span></div>`).join("");
    placePop(el, anchor, o);
    const rows = $$(".mi", el);
    const ok = (i) => !items[+rows[i].dataset.i].dis;
    let at = Math.max(0, rows.findIndex((x, i) => items[+x.dataset.i].check && ok(i)));
    const mark = () => rows.forEach((x, i) => x.classList.toggle("act", i === at));
    const step = (d) => { for (let n = 0; n < rows.length; n++) { at = (at + d + rows.length) % rows.length; if (ok(at)) break; } mark(); };
    mark();
    const choose = (it) => { if (it.dis) return; closeMenu(); onPick(it); };
    el.addEventListener("pointermove", (e) => { const x = e.target.closest(".mi"); if (x) { at = rows.indexOf(x); mark(); } });
    el.addEventListener("click", (e) => { const x = e.target.closest(".mi"); if (x) choose(items[+x.dataset.i]); });
    anchor.classList.add("open");
    menu = { el, anchor, key: (e) => {
        if (e.key === "ArrowDown") { step(1); return true; }
        if (e.key === "ArrowUp") { step(-1); return true; }
        if (e.key === "Enter") { choose(items[+rows[at].dataset.i]); return true; }
        if (e.key === "Tab") { closeMenu(); return false; }
        if (e.key === "Escape") { closeMenu(); return true; }
        if (o.numbers && (e.metaKey || e.ctrlKey) && /^[1-9]$/.test(e.key)) { const it = items.filter((x) => x.id)[+e.key - 1]; if (it) choose(it); return true; }
        return false;
    } };
}
// Puts a popover by its anchor, inside the window: above it when there's room, else below.
function placePop(el, anchor, o = {}) {
    const win = $("#win").getBoundingClientRect(), r = anchor.getBoundingClientRect(), k = state.scale;
    $("#win").append(el);
    const mw = el.offsetWidth, mh = el.offsetHeight, W = win.width / k, H = win.height / k;
    const ax = (r.left - win.left) / k, ay = (r.top - win.top) / k, ab = (r.bottom - win.top) / k, ar = (r.right - win.left) / k;
    let left = o.align === "right" ? ar - mw : ax;
    left = Math.max(8, Math.min(left, W - mw - 8));
    const above = o.place === "bottom" ? false : ay > mh + 12 || ay > H - ab;
    el.style.left = `${left}px`;
    el.style.top = `${Math.max(8, above ? ay - mh - 6 : Math.min(ab + 6, H - mh - 8))}px`;
    el.style.setProperty("--origin", `${above ? "bottom" : "top"} ${o.align === "right" ? "right" : "left"}`);
}
function closeMenu() {
    if (!menu) return;
    const { el, anchor } = menu, a = document.activeElement;
    el.remove(); anchor.classList?.remove("open"); menu = null;
    // Focus that was in the menu, or nowhere, goes back to what opened it.
    if (anchor !== body && (!a || a === body || el.contains(a))) (anchor === $("#composer") ? $("#input") : anchor).focus?.({ preventScroll: true });
}

const modelItems = (sel) => { let n = 0; return MODELS.map((m) => (m.h ? m : { ...m, check: sel === m.id, kbd: `⌘${++n}` })); };
function modelMenu(anchor, sel = cur().model, set = (v) => { const s = cur(); s.model = v; s.effort = fitEffort(v, s.effort); }) {
    openMenu(anchor, modelItems(sel), (m) => { set(m.id); paint(); }, { width: 340, numbers: true });
}
// Effort is the composer's level glyph grown into a control: a bar per level the model takes, rising left to right.
// Bars up to the chosen level fill in. It applies as it moves.
const sliderHTML = (levels, sel) => {
    const at = Math.max(0, levels.findIndex((e) => e.id === sel)), n = levels.length;
    return `<div class="es" role="slider" tabindex="0" aria-label="Reasoning effort" aria-valuemin="1" aria-valuemax="${n}" aria-valuenow="${at + 1}" aria-valuetext="${esc(levels[at].label)}">
        ${levels.map((e, i) => `<span class="eb ${i <= at ? "on" : ""}" style="--h:${(i + 1) / n}" title="${esc(e.label)}"><i></i></span>`).join("")}
    </div>`;
};
// Click or drag across the bars, or use the arrow keys; hovering previews a level before you pick it.
function bindSlider(root, levels, sel, set) {
    const sl = $(".es", root), bars = $$(".eb", sl), n = levels.length;
    let at = Math.max(0, levels.findIndex((e) => e.id === sel)), down = false;
    const paintBars = (i, cls) => bars.forEach((b, j) => b.classList.toggle(cls, j <= i));
    const go = (i) => {
        i = Math.max(0, Math.min(n - 1, i));
        paintBars(i, "on");
        if (i === at) return;
        at = i;
        sl.setAttribute("aria-valuenow", i + 1); sl.setAttribute("aria-valuetext", levels[i].label);
        root.dispatchEvent(new CustomEvent("level", { detail: levels[i] }));
        set(levels[i].id);
    };
    const idx = (e) => { const r = sl.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.floor(((e.clientX - r.left) / r.width) * n))); };
    sl.addEventListener("pointerdown", (e) => { e.preventDefault(); sl.focus(); try { sl.setPointerCapture(e.pointerId); } catch {} down = true; go(idx(e)); });
    sl.addEventListener("pointermove", (e) => { if (down) go(idx(e)); else { paintBars(idx(e), "pre"); sl.classList.add("hov"); } });
    sl.addEventListener("pointerleave", () => { sl.classList.remove("hov"); paintBars(-1, "pre"); });
    const up = () => { down = false; };
    sl.addEventListener("pointerup", up); sl.addEventListener("pointercancel", up);
    const key = (e) => {
        const d = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
        if (d) { go(at + d); return true; }
        if (e.key === "Home") { go(0); return true; }
        if (e.key === "End") { go(n - 1); return true; }
        if (/^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && +e.key <= n) { go(+e.key - 1); return true; }
        return false;
    };
    sl.addEventListener("keydown", (e) => { if (key(e)) { e.preventDefault(); e.stopPropagation(); } });
    return key;
}
// The effort popover: the level's name, fast mode where the model offers it, and the bars.
function effortMenu(anchor) {
    closeMenu();
    const s = cur(), m = modelOf(s.model), levels = levelsOf(s.model);
    if (!levels.length) return;
    const el = document.createElement("div");
    el.className = "menu glass effort-pop";
    const fast = () => (m.fast ? `<button class="ep-fast ${s.fast ? "on" : ""}" data-ep="fast" ${s.run ? "disabled" : ""} aria-pressed="${!!s.fast}" title="${s.run ? "Change speed after this response finishes" : "Faster service at higher usage. Same model and reasoning effort."}">${I("zap", 12, 2.25)}Fast</button>` : "");
    const e0 = levels.find((e) => e.id === s.effort) ?? levels[0];
    el.innerHTML = `<div class="ep-h"><b class="ep-lv">${esc(e0.label)}</b>${fast()}</div>${sliderHTML(levels, e0.id)}`;
    el.addEventListener("level", (ev) => put($(".ep-lv", el), esc(ev.detail.label)));
    placePop(el, anchor);
    const key = bindSlider(el, levels, e0.id, (id) => { s.effort = id; paint(); });
    el.addEventListener("click", (e) => {
        const b = e.target.closest("[data-ep=fast]");
        if (!b || b.disabled) return;
        s.fast = !s.fast; b.classList.toggle("on", s.fast); b.setAttribute("aria-pressed", s.fast); paint();
    });
    anchor.classList.add("open");
    $(".es", el).focus({ preventScroll: true });
    menu = { el, anchor, key: (e) => {
        if (e.key === "Escape" || e.key === "Enter" || e.key === "Tab") { closeMenu(); return true; }
        return key(e);
    } };
}
// The context meter opens a card: how full the context window is, and the plan's limits.
function ctxCard(anchor) {
    closeMenu();
    const s = cur(), el = document.createElement("div");
    el.className = "menu glass ctx-card";
    const line = (l, v, sub) => `<div class="cc-line"><span>${l}</span><b>${v}%</b></div><div class="cc-bar"><i style="width:${v}%"></i></div>${sub ? `<div class="cc-sub">${sub}</div>` : ""}`;
    el.innerHTML = `<div class="mh">Context window</div><div class="cc">${line(`${Math.round(s.ctx * 2)}k of 200k tokens`, s.ctx)}<button class="btn ghost sm" data-ctx-compact ${s.run ? "disabled" : ""}>Compact now</button></div>
        <div class="msep"></div><div class="mh">Plan limits · ${esc($("#plan-name").textContent || "Claude Max")}</div><div class="cc">${line("5-hour", state.usage, "Resets in 2h 14m")}${line("Weekly", 31, "Resets Monday")}</div>`;
    placePop(el, anchor, { align: "right" });
    anchor.classList.add("open");
    el.addEventListener("click", (e) => { if (e.target.closest("[data-ctx-compact]")) { closeMenu(); s.ctx = Math.round(s.ctx * 0.3); paint(); toast("Compacted the conversation", { icon: "minimize-2", kind: "ok" }); } });
    menu = { el, anchor, key: (e) => { if (e.key === "Escape") { closeMenu(); return true; } return false; } };
}
function modeMenu(anchor, sel = cur().mode, set = (v) => { cur().mode = v; }) {
    openMenu(anchor, [{ h: "Permission mode" }, ...MODES.map((m) => ({ ...m, check: sel === m.id, danger: m.id === "bypassPermissions", dis: m.id === "bypassPermissions" && !prefs.allowBypass, desc: m.id === "bypassPermissions" && !prefs.allowBypass ? "Turn it on in Settings → General" : m.desc }))], (m) => { set(m.id); paint(); }, { width: 340 });
}
function moreMenu(anchor) {
    const s = cur();
    openMenu(anchor, [
        { id: "rename", label: "Rename", icon: "pencil" },
        { id: "fork", label: "Fork session", icon: "git-fork" },
        { id: "find", label: "Find in conversation", icon: "search", kbd: "⌘F" },
        { id: "copy", label: "Copy branch name", icon: "copy" },
        { sep: true },
        { id: "archive", label: "Archive", icon: "archive" },
    ], (it) => {
        if (it.id === "rename") renameStart();
        if (it.id === "fork") fork(s);
        if (it.id === "find") openFind();
        if (it.id === "copy") toast(`Copied ${s.branch}`, { icon: "copy" });
        if (it.id === "archive") archive(s.id);
    }, { width: 240, align: "right", place: "bottom" });
}
function projectMenu(anchor) {
    const s = cur();
    openMenu(anchor, [{ h: "Projects" }, ...Object.keys(PROJECTS).map((p) => ({ id: p, label: p, icon: "folder", check: s.project === p })), { sep: true }, { id: "+", label: "Open folder…", icon: "folder-git-2" }], (it) => {
        if (it.id === "+") return toast("Opens the folder picker in the app", { icon: "folder" });
        s.project = it.id; s.branch = PROJECTS[it.id]; paint();
    }, { width: 240, place: "bottom" });
}
function branchMenu(anchor) {
    const s = cur();
    openMenu(anchor, [{ h: "Start from" }, ...["main", "fix/session-flicker", "ci/shard-timings", "feat/usage-menubar"].map((b) => ({ id: b, label: b, icon: "git-branch", check: s.branch === b }))], (it) => { s.branch = it.id; paint(); }, { width: 260, place: "bottom" });
}
function composerMenus() {
    const ta = $("#input"), v = ta.value.slice(0, ta.selectionStart);
    const sl = /^\/(\w*)$/.exec(v), at = /(?:^|\s)@([\w./-]*)$/.exec(v);
    if (sl) {
        const items = SLASH.filter((c) => c.id.startsWith(sl[1].toLowerCase())).map((c) => ({ ...c, label: `/${c.id}`, icon: "slash" }));
        if (!items.length) return closeMenu();
        openMenu($("#composer"), [{ h: "Commands" }, ...items], (c) => { ta.value = ""; autosize(); slash(c.id); }, { width: 360 });
    } else if (at) {
        const items = FILES.filter((f) => f.toLowerCase().includes(at[1].toLowerCase())).slice(0, 6).map((f) => ({ id: f, label: base(f), desc: dir(f), icon: "file-text" }));
        if (!items.length) return closeMenu();
        openMenu($("#composer"), [{ h: "Files" }, ...items], (f) => {
            const start = ta.selectionStart - at[1].length - 1;
            ta.value = `${ta.value.slice(0, start)}@${f.id} ${ta.value.slice(ta.selectionStart)}`;
            ta.focus(); autosize();
        }, { width: 360 });
    } else if (menu?.anchor === $("#composer")) closeMenu();
}
function slash(c) {
    const s = cur();
    if (c === "model") modelMenu($("#pick-model"));
    if (c === "mode") modeMenu($("#pick-mode"));
    if (c === "new") newSession();
    if (c === "rename") renameStart();
    if (c === "fork") fork(s);
    if (c === "settings") openSettings();
    if (c === "compact") { add(s, B("note", { text: `Conversation compacted. Context went from ${s.ctx}% to 9%.` })); s.ctx = 9; paint(); }
    if (c === "context") toast(`${s.ctx}% of the context window is used`, { icon: "info" });
    if (c === "usage") toast(`${state.usage}% of the 5-hour limit used; resets in 2h 14m`, { icon: "gauge" });
}

// ---------- Palette and dialogs ----------------------------------------
const plain = (t) => t.replace(/`([^`]+)`/g, "$1").replace(/\*\*([^*]+)\*\*/g, "$1").replace(/\s+/g, " ").trim();
// A window of the text around the match, so it's visible however long the message.
const snippet = (t, q) => { const i = t.toLowerCase().indexOf(q); return i < 30 ? t.slice(0, 90) : `…${t.slice(i - 24, i + 66)}`; };
function jumpTo(s, b) {
    select(s.id);
    setTimeout(() => { const el = $(`[data-k="${b.id}"]`); if (!el) return; el.scrollIntoView({ block: "center" }); el.classList.remove("flash"); void el.offsetWidth; el.classList.add("flash"); }, 120);
}
function palette() {
    closeMenu();
    const cmds = [
        { label: "New session", icon: "square-pen", kbd: "⌘N", run: () => newSession() },
        { label: "Find in the conversation", icon: "search", kbd: "⌘F", run: () => openFind() },
        { label: "Toggle the sidebar", icon: "panel-left", kbd: "⌘B", run: () => toggleRail() },
        { label: "Toggle the side panel", icon: "panel-right", kbd: "⌘.", run: () => toggleInsp() },
        { label: "Toggle the terminal", icon: "panel-bottom", kbd: "⌃`", run: () => setTerm() },
        { label: "Switch model", icon: "sliders-horizontal", kbd: "⌘/", run: () => modelMenu($("#pick-model")) },
        { label: "Change permission mode", icon: "shield-check", kbd: "⇧Tab", run: () => modeMenu($("#pick-mode")) },
        { label: "Settings", icon: "settings", kbd: "⌘,", run: () => openSettings() },
        { label: "Switch light and dark", icon: "moon", run: () => setPref("scheme", body.dataset.theme === "dark" ? "light" : "dark") },
    ];
    const scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = `<div class="pal glass"><div class="pal-in">${I("search", 17)}<input placeholder="Search sessions, messages and actions" /><span class="kbd">Esc</span></div><div class="pal-list"></div></div>`;
    $("#win").append(scrim);
    const inp = $("input", scrim), list = $(".pal-list", scrim);
    let rows = [], at = 0;
    const draw = () => {
        const q = inp.value.toLowerCase();
        const ss = state.sessions.filter((s) => !s.isNew && s.title.toLowerCase().includes(q)).slice(0, 5);
        const msgs = q.length > 2 ? state.sessions.flatMap((s) => s.blocks.filter((b) => (b.k === "user" || b.k === "prose") && b.text.toLowerCase().includes(q)).slice(0, 1).map((b) => ({ s, b }))).slice(0, 3) : [];
        const cs = cmds.filter((c) => c.label.toLowerCase().includes(q));
        rows = [
            ...ss.map((s) => ({ g: "Sessions", label: s.title, icon: "message-square-text", s, run: () => select(s.id) })),
            ...msgs.map(({ s, b }) => ({ g: "Messages", label: snippet(plain(b.text), q), mark: q, desc: s.title, icon: "search", run: () => jumpTo(s, b) })),
            ...cs.map((c) => ({ g: "Actions", ...c })),
        ];
        at = Math.min(at, Math.max(0, rows.length - 1));
        let html = "", g = "";
        rows.forEach((r, i) => {
            if (r.g !== g) { g = r.g; html += `<div class="mh">${g}</div>`; }
            const end = r.s ? (r.s.status === "waiting" ? `<span class="badge-wait">Needs you</span>` : r.s.status === "running" ? `<span class="ring"></span>` : `<span class="dim">${ago(r.s.at)}</span>`) : r.kbd ? `<span class="kbd">${r.kbd}</span>` : "";
            const lab = r.mark ? esc(r.label).replace(new RegExp(`(${r.mark.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"), "<mark>$1</mark>") : esc(r.label);
            html += `<div class="mi ${i === at ? "act" : ""}" data-i="${i}">${I(r.icon, 15)}<span class="trunc"><span class="l">${lab}</span>${r.desc ? `<span class="d">${esc(r.desc)}</span>` : ""}</span><span class="end">${end}</span></div>`;
        });
        list.innerHTML = html || `<div class="blank">No matches</div>`;
        list.querySelector(".act")?.scrollIntoView({ block: "nearest" });
    };
    const close = () => { scrim.remove(); menu = null; };
    const go = (i) => { const r = rows[i]; close(); r?.run(); };
    draw();
    inp.oninput = () => { at = 0; draw(); };
    list.onclick = (e) => { const x = e.target.closest(".mi"); if (x) go(+x.dataset.i); };
    list.onpointermove = (e) => { const x = e.target.closest(".mi"); if (x && +x.dataset.i !== at) { at = +x.dataset.i; draw(); } };
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
    menu = { el: scrim, anchor: body, modal: true, key: (e) => {
        if (e.key === "ArrowDown") { at = Math.min(rows.length - 1, at + 1); draw(); return true; }
        if (e.key === "ArrowUp") { at = Math.max(0, at - 1); draw(); return true; }
        if (e.key === "Enter") { go(at); return true; }
        if (e.key === "Escape") { close(); return true; }
        return false;
    } };
    inp.focus();
}
function dialog(html, onOk, focusSel) {
    closeMenu();
    const back = document.activeElement;
    const scrim = document.createElement("div");
    scrim.className = "scrim center";
    scrim.innerHTML = `<div class="dialog glass" role="dialog" aria-modal="true">${html}</div>`;
    $("#win").append(scrim);
    const close = () => { scrim.remove(); menu = null; (back && back !== body && back.isConnected ? back : $("#input")).focus({ preventScroll: true }); };
    // Tab stays inside the dialog.
    scrim.addEventListener("keydown", (e) => {
        if (e.key !== "Tab") return;
        const f = $$("button, input, textarea", scrim), i = f.indexOf(document.activeElement);
        e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length]?.focus();
    });
    const ok = () => { if (onOk(scrim) !== false) close(); };
    $("[data-x]", scrim).onclick = close;
    $("[data-ok]", scrim).onclick = ok;
    scrim.onclick = (e) => { if (e.target === scrim) close(); };
    menu = { el: scrim, anchor: body, modal: true, key: (e) => {
        if (e.key === "Escape") { close(); return true; }
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey || !focusSel || document.activeElement?.tagName === "INPUT")) { ok(); return true; }
        return false;
    } };
    setTimeout(() => (focusSel ? $(focusSel, scrim) : $("[data-ok]", scrim))?.focus(), 30);
    return scrim;
}
// Rewind goes back to before one of your prompts: the code, the conversation, or both.
function rewindDialog(s, from) {
    if (s.run) return dialog(`<h3>Rewind</h3><p>Wait for the current response to finish (or stop it) before rewinding.</p><div class="row"><span class="grow"></span><button class="btn primary" data-ok>OK</button></div>`, () => {});
    const prompts = s.blocks.map((b, i) => ({ b, i })).filter((x) => x.b.k === "user");
    if (!prompts.length) return toast("Nothing to rewind to yet", { icon: "info" });
    let pick = (prompts.find((x) => x.i > from) ?? prompts.at(-1)).i;
    const files = () => { const cut = new Set(s.blocks.slice(pick).filter((b) => b.k === "edit").map((b) => b.file)); return s.changes.filter((c) => cut.has(c.path)); };
    const body = () => {
        const f = files();
        return `<div class="rw-list">${prompts.map((x) => `<button class="rw-item ${x.i === pick ? "on" : ""}" data-rw="${x.i}">${I("rotate-ccw-clock", 14)}<span class="trunc">${esc(plain(x.b.text))}</span></button>`).join("")}</div>
            <div class="rw-plan">${f.length ? `<div>Harness changed ${f.length} file${f.length > 1 ? "s" : ""} since then:</div>${f.map((c) => `<div class="rw-f">${I("file-pen", 13)}${esc(c.path)}</div>`).join("")}` : `<div class="dim">No file changes to undo since then.</div>`}<div class="dim">Changes made by shell commands aren't tracked and won't be undone.</div></div>`;
    };
    const sc = dialog(`<h3>Rewind</h3><p>Go back to before one of your prompts</p><div class="rw">${body()}</div>
        <div class="row"><button class="btn ghost" data-x>Cancel</button><span class="grow"></span><button class="btn ghost" data-rwgo="code">Code only</button><button class="btn ghost" data-rwgo="conv">Conversation only</button><button class="btn primary" data-ok>Restore both</button></div>`, () => go(true, true));
    $(".dialog", sc).classList.add("wide");
    const go = (code, conv) => {
        const f = files(), text = s.blocks[pick].text;
        if (code) s.changes = s.changes.filter((c) => !f.includes(c));
        if (conv) { s.blocks = s.blocks.slice(0, pick); const ta = $("#input"); ta.value = text; autosize(); ta.focus(); }
        state.review = null; layout(); paint();
        toast(code && f.length ? `Restored ${f.length} file${f.length > 1 ? "s" : ""}${conv ? " and the conversation" : ""}` : "Rewound the conversation; the prompt is back in the input box", { icon: "undo-2", kind: "ok" });
    };
    sc.addEventListener("click", (e) => {
        const r = e.target.closest("[data-rw]"), g = e.target.closest("[data-rwgo]");
        if (r) { pick = +r.dataset.rw; put($(".rw", sc), body()); }
        if (g) { sc.remove(); menu = null; go(g.dataset.rwgo === "code", g.dataset.rwgo === "conv"); }
    });
}
function commitDialog(thenPR = false) {
    const s = cur(), files = s.changes.length;
    let push = true;
    const scrim = dialog(`<h3>Commit ${files} file${files === 1 ? "" : "s"}</h3><p>On ${esc(s.branch)}</p>
        <textarea>${esc(s.title)}\n\n${esc(s.changes.map((c) => `- ${base(c.path)}`).join("\n"))}</textarea>
        <button class="check on" data-push><i>${I("check", 11, 3)}</i>Push after committing</button>
        <div class="row"><span class="grow"></span><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>${thenPR ? "Commit and open PR" : "Commit"} <span class="kbd">⌘↵</span></button></div>`, (sc) => {
        const msg = $("textarea", sc).value.split("\n")[0];
        s.commit = { sha: Math.random().toString(16).slice(2, 9), msg, files, pushed: push };
        s.commit.changes = s.changes; s.changes = []; state.review = null; layout(); paint();
        toast(`Committed ${files} file${files === 1 ? "" : "s"} to ${s.branch}${push ? " and pushed" : ""}`, { kind: "ok", icon: "git-commit-horizontal" });
        if (thenPR) setTimeout(() => openPR(s), 300);
    }, "textarea");
    $("[data-push]", scrim).onclick = (e) => { push = !push; e.currentTarget.classList.toggle("on", push); };
}
function openPR(s) {
    if (s.pr && !s.changes.length) return toast(`Opens PR #${s.pr} on GitHub`, { icon: "external-link" });
    if (s.changes.length) return commitDialog(true);
    s.prBusy = true; paint();
    setTimeout(() => {
        s.prBusy = false; s.pr = state.prNext++; s.prChecks = "running"; paint();
        toast(`Opened PR #${s.pr}`, { kind: "ok", icon: "git-pull-request", action: { label: "View", fn: () => toast("Opens the PR on GitHub", { icon: "external-link" }) } });
        setTimeout(() => { s.prChecks = "passed"; paint(); }, 5000 / state.speed);
    }, 1100 / state.speed);
}

// ---------- Find (⌘F) ----------------------------------------------------
const find = { q: "", ranges: [], at: 0 };
function openFind() { $("#find").classList.add("show"); const i = $("#find-in"); i.focus(); i.select(); runFind(); }
function closeFind() { $("#find").classList.remove("show"); CSS.highlights?.delete("find"); CSS.highlights?.delete("find-cur"); find.ranges = []; $("#find-n").textContent = ""; }
function runFind(move = 0) {
    find.q = $("#find-in").value.toLowerCase();
    find.ranges = [];
    if (find.q.length > 1) {
        const w = document.createTreeWalker($("#col"), NodeFilter.SHOW_TEXT);
        for (let n; (n = w.nextNode()); ) {
            const t = n.data.toLowerCase();
            for (let i = t.indexOf(find.q); i >= 0; i = t.indexOf(find.q, i + 1)) { const r = new Range(); r.setStart(n, i); r.setEnd(n, i + find.q.length); find.ranges.push(r); }
        }
    }
    find.at = find.ranges.length ? (find.at + move + find.ranges.length) % find.ranges.length : 0;
    if (move === 0) find.at = 0;
    $("#find-n").textContent = find.q.length > 1 ? (find.ranges.length ? `${find.at + 1} of ${find.ranges.length}` : "No matches") : "";
    if (CSS.highlights) {
        CSS.highlights.set("find", new Highlight(...find.ranges));
        CSS.highlights.set("find-cur", new Highlight(...(find.ranges[find.at] ? [find.ranges[find.at]] : [])));
    }
    const r = find.ranges[find.at];
    if (r) { const sc = $("#scroll"), box = r.getBoundingClientRect(), sb = sc.getBoundingClientRect(); sc.scrollTop += (box.top - sb.top) / state.scale - sc.clientHeight / 3; }
}

// ---------- Settings -----------------------------------------------------
const SECTIONS = [["general", "General", "sliders-horizontal"], ["appearance", "Appearance", "palette"], ["providers", "Providers", "plug"], ["usage", "Usage", "chart-column"], ["shortcuts", "Shortcuts", "keyboard"], ["about", "About", "info"]];
const SHORTCUTS = [["⌘ N", "New session"], ["⌘ K", "Search sessions, messages and actions"], ["⌘ F", "Find in the conversation"], ["⌘ ,", "Settings"], ["⌘ B", "Toggle the sidebar"], ["⌘ .", "Toggle the side panel"], ["⌘ /", "Switch model"], ["⌘ 1…9", "Pick a model (model picker open)"], ["⌘ [|⌘ ]", "Previous / next session"], ["⌘ L", "Focus the input box"], ["⌃ `", "Toggle the terminal"], ["⇧ Tab", "Cycle permission mode"], ["Esc", "Interrupt while working, deny a permission, close"], ["1|2|3", "Answer the request on the composer"], ["↵|⇧ ↵", "Send / new line"], ["↑", "Previous prompt (empty input)"], ["@", "Mention a file"], ["/", "Commands"], ["!", "Run a shell command yourself"]];
const row = (title, desc, ctl) => `<div class="set-row"><div class="lab"><b>${title}</b>${desc ? `<span>${desc}</span>` : ""}</div>${ctl}</div>`;
const tg = (k, danger = false) => `<button class="tg ${prefs[k] ? "on" : ""} ${danger ? "danger" : ""}" data-tg="${k}" role="switch" aria-checked="${!!prefs[k]}"></button>`;
const segp = (k, opts) => `<div class="seg">${opts.map(([v, l]) => `<button class="${prefs[k] === v ? "on" : ""}" data-pref="${k}" data-val="${v}">${l}</button>`).join("")}</div>`;
const selModel = (k) => { const m = modelOf(prefs[k]); return `<button class="selbtn" data-selpref="${k}">${PI(m.prov, 15, "set")}${esc(m.label)}${I("chevron-down", 13, 1.75, "chev")}</button>`; };

function settingsHTML() {
    const sec = state.settings;
    const name = SECTIONS.find((x) => x[0] === sec)[1];
    let h = `<div class="set-in"><div class="set-top"><h2>${name}</h2><button class="ib" data-act="settings-close" title="Close (Esc)">${I("x", 16)}</button></div>`;
    h += `<div class="set-tabs">${SECTIONS.map(([k, l]) => `<button class="${k === sec ? "on" : ""}" data-snav="${k}">${l}</button>`).join("")}</div>`;
    if (sec === "general") {
        h += `<div class="set-h">Defaults for new sessions</div><div class="set-group">`;
        h += row("Model", "Also changes when you pick a model in a session.", selModel("model"));
        h += row("Small model", "For session titles and page summaries.", selModel("smallModel"));
        h += row("Auto-mode reviewer", "Checks actions in Auto before they run, on API models. Claude Code and Codex use their own.", selModel("reviewer"));
        h += row("Permission mode", "Shift-Tab cycles it in the composer.", `<button class="selbtn" data-selpref="defaultMode">${I(modeOf(prefs.defaultMode).icon, 14)}${modeOf(prefs.defaultMode).label}${I("chevron-down", 13, 1.75, "chev")}</button>`);
        h += row("Reasoning effort", "Where new sessions start. A model with fewer levels takes the closest one.", `<div class="set-effort" id="set-effort"><span class="v">${esc(effortOf(prefs.effort).label)}</span>${sliderHTML(EFFORTS, prefs.effort)}</div>`);
        h += `</div><div class="set-h">Conversation</div><div class="set-group">`;
        h += row("Show thinking", "The model's reasoning, when the provider shares it.", tg("showThinking"));
        h += row("Compact automatically", "Summarize the conversation when the context window is nearly full.", tg("autoCompact"));
        h += row("Web search", "", segp("webSearch", [["auto", "Automatic"], ["on", "On"], ["off", "Off"]]));
        h += row("Expand tool activity", "Show every tool call instead of a one-line summary.", tg("expandActivity"));
        h += row("Enter sends", "Off: ⌘+Enter sends and Enter adds a line.", tg("enterSends"));
        h += `</div><div class="set-h">This Mac</div><div class="set-group">`;
        h += row("Open files with", "For file links in replies, changed files and tool rows.", `<button class="selbtn" data-selpref="editor">${esc(prefs.editor)}${I("chevron-down", 13, 1.75, "chev")}</button>`);
        h += row("Notifications", "When a session needs you or finishes while you're elsewhere.", tg("notifications"));
        h += row("Allow bypass mode", "Lets sessions run everything without asking. Only for sandboxes and containers.", tg("allowBypass", true));
        h += `</div>`;
    }
    if (sec === "appearance") {
        h += `<div class="set-h">Colour scheme</div><div class="set-group"><div class="tiles">${[["system", "System", "s"], ["light", "Light", "l"], ["dark", "Dark", "d"]].map(([v, l, c]) => `<button class="tile ${prefs.scheme === v ? "on" : ""}" data-pref="scheme" data-val="${v}"><span class="pv ${c}"><i></i><u></u></span>${l}</button>`).join("")}</div></div>`;
        h += `<div class="set-h">Look</div><div class="set-group">`;
        h += row("Accent", "Send, primary buttons, links and focus.", `<div class="swatches">${[["blue", "#2b6cff"], ["tangerine", "#f2611d"], ["mint", "#0f9b78"], ["rose", "#e0345f"], ["graphite", "#5b5e66"]].map(([v, c]) => `<button class="${prefs.accent === v ? "on" : ""}" style="background:${c}" data-pref="accent" data-val="${v}" title="${v}"></button>`).join("")}</div>`);
        h += row("Window", "How much of your desktop shows through the window and sidebar.", segp("glass", [["glass", "Glass"], ["tinted", "Tinted"], ["solid", "Solid"]]));
        h += row("Contrast", "Stronger text and edges.", segp("contrast", [["standard", "Standard"], ["high", "Increased"]]));
        h += `</div><div class="set-h">Text and layout</div><div class="set-group">`;
        h += row("Text size", "Prose and the composer. The interface scales with it.", `<div class="stepper"><button class="ib sm" data-step="-1" ${prefs.fs <= 12 ? "disabled" : ""}>${I("minus", 14)}</button><span>${prefs.fs}</span><button class="ib sm" data-step="1" ${prefs.fs >= 18 ? "disabled" : ""}>${I("plus", 14)}</button></div>`);
        h += `<div class="preview">The list sorts on <code>updatedAt</code>, so a finished run moves for one frame before its status lands.</div>`;
        h += row("Density", "Row and header height across the app.", segp("density", [["comfortable", "Comfortable"], ["compact", "Compact"]]));
        h += row("Chat width", "How wide the conversation can grow on a big window.", segp("chatWidth", [["narrow", "Narrow"], ["standard", "Standard"], ["wide", "Wide"]]));
        h += row("Panel animations", "Panels and menus. Your system's reduced-motion setting always wins.", segp("motion", [["instant", "Instant"], ["quick", "Quick"], ["smooth", "Smooth"]]));
        h += `</div>`;
    }
    if (sec === "providers") {
        const prov = (p, name, sub, right) => `<div class="prov"><span class="logo-s">${PI(p, 18, "set")}</span><div class="lab"><b>${name}</b><span>${sub}</span></div>${right}</div>`;
        h += `<div class="set-group"><div class="keyin"><input id="quickkey" type="password" placeholder="Paste any API key; the provider is detected from its format" /><button class="btn primary sm" data-act="quickkey">Add</button></div></div>`;
        h += `<div class="set-h">Subscriptions</div><div class="set-group">`;
        h += prov("claude-code", `Claude Code <span class="tag ok">Connected</span>`, "Claude Max. Opus, Sonnet and Haiku run through it.", `<button class="btn ghost sm" data-act="provoff">Turn off</button>`);
        h += prov("codex", `Codex <span class="tag ok">Connected</span>`, "Signed in with ChatGPT.", `<button class="btn ghost sm" data-act="provoff">Turn off</button>`);
        h += `</div><div class="set-h">API keys</div><div class="set-group">`;
        h += prov("openai", "OpenAI", `<code>sk-…a91f</code>`, `<span class="tag">keychain</span><button class="ib sm" title="Remove key" data-act="provoff">${I("x", 14)}</button>`);
        h += prov("openrouter", "OpenRouter", `<code>sk-or-…77c2</code>`, `<span class="tag">keychain</span><button class="ib sm" title="Remove key" data-act="provoff">${I("x", 14)}</button>`);
        for (const [p, n] of [["anthropic", "Anthropic"], ["gemini", "Gemini"], ["deepseek", "DeepSeek"]]) {
            const k = state.keys.find((x) => x.p === p);
            h += prov(p, n, k ? `<code>${esc(k.masked)}</code>` : "Not set up", k ? `<span class="tag">keychain</span>` : `<button class="btn ghost sm" data-addkey="${p}">Add key</button>`);
        }
        h += `</div><div class="set-h">On this Mac</div><div class="set-group">`;
        h += prov("ollama", `Ollama <span class="tag">local</span>`, "3 models. Nothing leaves this Mac.", `<span class="tag ok">Running</span>`);
        h += prov("lmstudio", "LM Studio", "Not running", `<button class="btn ghost sm" data-act="provcheck">Check again</button>`);
        h += `</div><div class="set-note">Keys are checked with one cheap request, then stored in your OS keychain (or a private file when there's none). They're only ever sent to their own provider and are masked everywhere else.</div>`;
    }
    if (sec === "usage") {
        const bar = (label, v, sub) => `<div class="useb"><div class="top"><b>${label}</b><span class="dim">${sub}</span></div><div class="bar2"><i style="width:${v}%"></i></div></div>`;
        h += `<div class="set-h">${PI("claude-code", 13, "uh")} Claude Max</div><div class="set-group">${bar("5-hour limit", state.usage, `${state.usage}%, resets in 2h 14m`)}${bar("Weekly limit", 31, "31%, resets Monday")}</div>`;
        h += `<div class="set-h">${PI("codex", 13, "uh2")} Codex</div><div class="set-group">${bar("5-hour limit", 18, "18%, resets in 3h 40m")}${bar("Weekly limit", 9, "9%, resets Thursday")}</div>`;
        h += `<div class="set-h">API spend this month</div><div class="set-group">${row(`OpenRouter`, "41 requests", `<span class="set-val">$4.12</span>`)}${row("OpenAI", "12 requests", `<span class="set-val">$1.80</span>`)}</div><div class="set-note">Sample numbers for the mockup.</div>`;
    }
    if (sec === "shortcuts") {
        h += `<div class="set-group">${SHORTCUTS.map(([k, d]) => row(d, "", `<span class="sc-keys">${k.split("|").map((x) => `<span class="kbd">${esc(x)}</span>`).join("")}</span>`)).join("")}</div>`;
    }
    if (sec === "about") {
        h += `<div class="set-group">${row("Version", "", `<span class="set-val">1.0.0</span>`)}${row("Data", "", `<span class="set-val">~/.harness</span>`)}${row("Platform", "", `<span class="set-val">macOS, arm64</span>`)}${row("Connection", "", `<span class="set-val">Local server, connected</span>`)}</div><div class="set-note">Sample values for the mockup.</div>`;
    }
    return h + `</div>`;
}
function settingsNavHTML() {
    return `<button class="back" data-act="settings-close">${I("chevron-left", 15)}Settings</button>${SECTIONS.map(([k, l, ic]) => `<button class="navi ${state.settings === k ? "sel" : ""}" data-snav="${k}">${I(ic, 16)}${l}</button>`).join("")}`;
}
function setPref(k, v) {
    if (k === "allowBypass" && v) {
        return dialog(`<h3>Allow bypass mode?</h3><p>Sessions in Bypass run every command and edit without asking. Only turn this on in a sandbox or container you can throw away.</p><div class="row"><span class="grow"></span><button class="btn ghost" data-x>Cancel</button><button class="btn danger" data-ok>Allow bypass</button></div>`, () => { prefs.allowBypass = true; applyPrefs(); paint(); });
    }
    prefs[k] = v;
    if (k === "allowBypass" && !v) for (const s of state.sessions) if (s.mode === "bypassPermissions") s.mode = "default";
    applyPrefs(); paint();
}
function applyPrefs() {
    const dark = prefs.scheme === "dark" || (prefs.scheme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
    body.dataset.theme = dark ? "dark" : "light";
    body.dataset.accent = prefs.accent; body.dataset.density = prefs.density; body.dataset.motion = prefs.motion; body.dataset.glass = prefs.glass;
    root.style.setProperty("--fs", `${prefs.fs}px`);
    root.style.setProperty("--col-w", { narrow: "640px", standard: "760px", wide: "960px" }[prefs.chatWidth]);
    if (prefs.contrast === "high") { body.style.setProperty("--fg-3", dark ? "#b2b5bd" : "#4a4d55"); body.style.setProperty("--line", dark ? "rgba(255,255,255,.16)" : "rgba(15,18,30,.18)"); }
    else { body.style.removeProperty("--fg-3"); body.style.removeProperty("--line"); }
    for (const b of $$('[data-set="theme"] button')) b.classList.toggle("on", b.dataset.v === body.dataset.theme);
    for (const s of state.sessions) for (const b of s.blocks) if (b.k === "acts") b.v++;
}

// ---------- Rendering ---------------------------------------------------
let queued = false, forceAll = false;
function paint(all = false) { forceAll ||= all; if (!queued) { queued = true; requestAnimationFrame(render); } }
function put(el, html) { if (el && el._h !== html) { el.innerHTML = html; el._h = html; } }

function render() {
    queued = false;
    const s = cur(), all = forceAll; forceAll = false;
    renderRail();
    if (state.settings) {
        // Leave the effort slider alone while it's held or focused, so a repaint can't drop the drag or the focus.
        if (!$("#set-effort")?.contains(document.activeElement)) put($("#settings"), settingsHTML());
        put($("#rail-set"), settingsNavHTML());
        const se = $("#set-effort");
        if (se && !se._bound) { se._bound = true; bindSlider(se, EFFORTS, prefs.effort, (id) => { prefs.effort = id; $(".v", se).textContent = effortOf(id).label; }); }
    }
    if (!s) return;
    $("#main").classList.toggle("is-home", s.isNew && !s.blocks.length);
    renderBar(s);
    const sc = $("#scroll"), near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140;
    renderBlocks(s, all);
    if (near) scrollBottom();
    $("#jump").classList.toggle("show", !near && !s.isNew && sc.scrollHeight > sc.clientHeight + 200);
    renderHome(s); renderAsk(s); renderComposer(s); renderInsp(s); renderTerm(s);
    $("#usage").style.setProperty("--v", state.usage);
    for (const b of $$("button[title]:not([aria-label])")) b.setAttribute("aria-label", b.title);
    put($("#plan-name"), `${PI("claude-code", 13, "foot")}Claude Max`);
    put($("#usage-t"), `${state.usage}% of the 5-hour limit`);
}

function statusGlyph(s) {
    if (s.status === "running") return `<span class="st"><span class="ring"></span></span>`;
    if (s.status === "waiting") return `<span class="st wait">${I("hand", 15)}</span>`;
    if (s.status === "done" && s.unread) return `<span class="st done">${I("check", 15, 2)}</span>`;
    if (s.isNew) return `<span class="st">${I("square-pen", 15)}</span>`;
    return `<span class="st">${I("message-square-text", 15)}</span>`;
}
function renderRail() {
    const q = state.search.toLowerCase();
    let html = "";
    for (const p of Object.keys(PROJECTS)) {
        const ss = state.sessions.filter((s) => s.project === p && (!q || s.title.toLowerCase().includes(q))).sort((a, b) => b.at - a.at);
        if (!ss.length && q) continue;
        html += `<div class="group"><div class="group-h">${I("folder", 14)}${p}<span class="n">${ss.length}</span></div>`;
        for (const s of ss) {
            const wait = s.status === "waiting";
            const end = wait ? `<span class="wait-dot"></span>` : `${s.unread ? `<span class="unread-dot" title="Unread"></span>` : ""}<span>${s.status === "running" ? "now" : ago(s.at)}</span>`;
            const label = `${s.title}${wait ? ", needs you" : s.status === "running" ? ", running" : ""}`;
            html += `<div class="sess ${s.id === state.active && !state.settings ? "sel" : ""} ${s.unread ? "unread" : ""} ${wait ? "waiting" : ""} ${fresh(s) ? "enter" : ""}" data-sid="${s.id}" role="button" tabindex="0" aria-label="${esc(label)}" ${s.id === state.active ? 'aria-current="true"' : ""} title="${wait ? "Needs you" : ""}">${statusGlyph(s)}<span class="t">${esc(s.title)}</span><span class="end">${end}</span><span class="m"><span class="trunc">${esc(s.branch)}</span>${s.pr ? `<span class="prtag">#${s.pr}</span>` : ""}</span>${wait ? "" : `<button class="ib arch" data-arch="${s.id}" title="Archive">${I("archive", 14)}</button>`}</div>`;
        }
        html += `</div>`;
    }
    put($("#rail-list"), html || `<div class="empty-rail">No sessions match “${esc(state.search)}”.</div>`);
}
function renderBar(s) {
    const railShown = body.dataset.railmode === "dock" ? body.dataset.rail !== "off" : body.dataset.railopen === "on";
    put($("#proj"), railShown ? "" : `${esc(s.project)}<span class="sl">/</span>`);
    const h = $("#ttl");
    if (h.contentEditable !== "true") put(h, esc(s.isNew ? "New session" : s.title));
    put($("#branch"), s.isNew ? "" : `${I("git-branch", 13)}${esc(s.branch)}`);
    const a = s.changes.reduce((n, c) => n + c.add, 0), d = s.changes.reduce((n, c) => n + c.del, 0);
    put($("#diffchip"), s.pr && !s.changes.length ? `${I("git-pull-request", 15)}<span class="prchip">#${s.pr}</span>` : `${I("file-diff", 15)}<span class="a">+${a}</span><span class="d">−${d}</span>`);
    const show = s.pr || s.changes.length;
    $("#diffchip").style.display = show ? "" : "none";
    $("#diffsep").style.display = show ? "" : "none";
    $("#insp-btn").classList.toggle("on", body.dataset.insp === "on");
    $("#term-btn").classList.toggle("on", state.term.open);
}

function blockHTML(b) {
    switch (b.k) {
        case "user": return `<div class="you">${esc(b.text)}${b.att?.length ? `<div class="att">${b.att.map((a) => `<span class="chip">${I(/review comment/.test(a) ? "message-square-text" : /\.(png|jpe?g|gif|mov|mp4)$/i.test(a) ? "image" : "file-text", 13)}${esc(a)}</span>`).join("")}</div>` : ""}</div>`;
        case "prose": { let h = md(b.text || " "); if (b.streaming) h = h.replace(/<\/p>$/, '<span class="caret"></span></p>'); return `<div class="prose">${h}</div>`; }
        case "thinking": return `<div class="thinking">${esc(b.text)}</div>`;
        case "note": return `<div class="note ${b.kind ?? ""}">${I(b.kind === "stop" ? "circle-stop" : "info", 14)}${esc(b.text)}</div>`;
        case "meta": return `<div class="meta"><span>${esc(b.text)}</span><span>${clock(b.dur)}</span><span class="grow"></span><button class="ib" data-copy title="Copy">${I("copy", 14)}</button><button class="ib" data-rewind title="Rewind to here">${I("undo-2", 14)}</button></div>`;
    }
    return "";
}
function actsSummary(b) {
    // Open, the rows already say what's happening; the header only does when they're folded away.
    if (b.live) { const l = b.items.at(-1); return !l || (b.open ?? prefs.expandActivity) ? "Working" : esc(l.verb === "Read" ? `Reading ${base(l.p)}` : l.verb === "Searched" ? `Searching for ${l.p}` : l.verb); }
    const reads = b.items.filter((i) => i.verb === "Read").length, finds = b.items.filter((i) => i.verb === "Searched").length;
    const parts = [];
    if (reads) parts.push(`read ${reads} file${reads > 1 ? "s" : ""}`);
    if (finds) parts.push(`searched ${finds === 1 ? "once" : finds === 2 ? "twice" : `${finds} times`}`);
    const other = b.items.filter((i) => i.verb !== "Read" && i.verb !== "Searched");
    for (const v of new Set(other.map((i) => i.verb))) { const its = other.filter((i) => i.verb === v); parts.push(its.length === 1 && its[0].p && !/plan/i.test(v) ? `${v.toLowerCase()} ${base(its[0].p)}` : v.toLowerCase()); }
    const t = parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0] ?? "worked";
    return t[0].toUpperCase() + t.slice(1);
}
function patchActs(el, b) {
    if (!el.firstChild) el.innerHTML = `<div class="acts"><button class="acts-h"></button><ul class="tl"></ul></div>`;
    const a = el.firstChild, ul = a.lastChild;
    a.classList.toggle("open", b.open ?? prefs.expandActivity);
    put(a.firstChild, `${b.live ? '<span class="ring"></span>' : I("chevron-right", 14, 1.75, "chev")}${actsSummary(b)}`);
    b.items.forEach((it, i) => {
        let li = ul.children[i];
        if (!li) { li = document.createElement("li"); li.className = el.classList.contains("noanim") ? "" : "enter"; ul.append(li); }
        li.classList.toggle("live", !!it.live);
        put(li, `${I(it.icon, 14)}${esc(it.verb)} ${it.p ? `<span class="p trunc">${esc(it.p)}</span>` : ""}${it.x ? `<span class="x">${esc(it.x)}</span>` : ""}`);
    });
}
function codeRows(lines, anim) {
    return lines.map((l) => `<div class="${l.t === "a" ? "add" : l.t === "d" ? "del" : ""}${anim ? " enter" : ""}"><span class="n">${l.n}</span><span class="g">${l.t === "a" ? "+" : l.t === "d" ? "−" : " "}</span><span>${hl(l.c)}</span></div>`).join("");
}
function patchEdit(el, b) {
    if (!el.firstChild) el.innerHTML = `<div class="card"><div class="card-h"></div><div class="body"><div class="code"></div></div></div>`;
    const card = el.firstChild, code = $(".code", card);
    put(card.firstChild, `${b.live ? '<span class="ring"></span>' : I("pencil", 14)}<span class="p trunc">${esc(b.file)}</span><span class="a">+${b.add}</span><span class="d">−${b.del}</span><span class="grow"></span><button class="ib" data-review title="Review in the side panel">${I("file-diff", 14)}</button><button class="ib" data-fold title="Collapse">${I(b.open ? "chevron-down" : "chevron-right", 14)}</button>`);
    $(".body", card).style.display = b.open ? "" : "none";
    if (b.lines.length < code.children.length) code.innerHTML = "";
    code.insertAdjacentHTML("beforeend", codeRows(b.lines.slice(code.children.length), b.live));
}
function patchCmd(el, b) {
    if (!el.firstChild) el.innerHTML = `<div class="card cmd ${b.by === "you" ? "you-ran" : ""}"><div class="card-h"></div><div class="body"><div class="code"></div></div></div>`;
    const card = el.firstChild, code = $(".code", card);
    const last = b.out.filter(Boolean).at(-1) ?? "";
    const pill = b.status === "run" ? `<span class="runpill"><span class="ring"></span>Running</span>` : b.status === "ok" ? `<span class="okpill">${I("check", 12, 2.25)}${/pass/.test(last) ? esc(last.trim().split(",")[0]) : "Done"}</span>` : b.status === "stop" ? `<span class="failpill">Stopped</span>` : `<span class="failpill">${I("x", 12, 2.25)}Failed</span>`;
    put(card.firstChild, `${I("terminal", 14)}${b.by === "you" ? `<span class="who">You ran</span>` : ""}<span class="p trunc">${esc(b.cmd)}</span><span class="grow"></span>${b.auto ? `<span class="dim">Approved by reviewer</span>` : ""}<span class="dim">${clock(b.status === "run" ? Date.now() - b.t0 : b.dur)}</span>${pill}`);
    $(".body", card).style.display = b.out.length ? "" : "none";
    const anim = el.classList.contains("noanim") ? "" : "enter";
    code.insertAdjacentHTML("beforeend", b.out.slice(code.children.length).map((l) => `<div class="${anim}">${esc(l) || " "}</div>`).join(""));
    code.scrollTop = code.scrollHeight;
}
function renderBlocks(s, all) {
    const col = $("#col");
    const isFresh = col.dataset.sid !== s.id;
    if (isFresh) { col.innerHTML = ""; col.dataset.sid = s.id; }
    const keep = new Set();
    let prev = null;
    for (const b of s.blocks) {
        keep.add(b.id);
        let el = col.querySelector(`:scope > [data-k="${b.id}"]`);
        if (!el) {
            el = document.createElement("div");
            el.dataset.k = b.id;
            el.className = `blk ${b.k}${isFresh ? " noanim" : ""}`;
            if (prev) prev.after(el); else col.prepend(el);
        }
        const tick = (b.k === "cmd" && b.status === "run") || all;
        if (el.dataset.v !== String(b.v) || tick) {
            if (b.k === "acts") patchActs(el, b);
            else if (b.k === "edit") patchEdit(el, b);
            else if (b.k === "cmd") patchCmd(el, b);
            else put(el, blockHTML(b));
            el.dataset.v = b.v;
        }
        prev = el;
    }
    for (const el of [...col.children]) if (!keep.has(el.dataset.k)) el.remove();
}
function renderHome(s) {
    if (!s.isNew) return;
    put($("#home-where"), `<button class="pillbtn" data-act="project">${I("folder", 14)}${esc(s.project)}${I("chevron-down", 13, 1.75, "chev")}</button>
        <button class="pillbtn" data-act="branch">${I("git-branch", 14)}${esc(s.branch)}${I("chevron-down", 13, 1.75, "chev")}</button>
        <div class="seg"><button class="${s.worktree ? "" : "on"}" data-wt="0">${I("laptop", 13)}Local</button><button class="${s.worktree ? "on" : ""}" data-wt="1">${I("folder-git-2", 13)}New worktree</button></div>`);
}
function askButtons(kind, labels) {
    const [k1, k2, k3] = ASK_KEYS[kind];
    return `<div class="ask-row"><button class="btn ghost" data-ans="${k3}">${labels[2]} <span class="kbd">3</span></button><span class="grow"></span><button class="btn ghost" data-ans="${k2}">${labels[1]} <span class="kbd">2</span></button><button class="btn primary" data-ans="${k1}">${labels[0]} <span class="kbd">1</span></button></div>`;
}
function renderAsk(s) {
    const p = s.pending;
    if (!p) return put($("#ask"), "");
    let html = "";
    if (p.kind === "cmd") html = `<div class="ask glass"><div class="ask-h">${I("hand", 16)}Run this command?</div><div class="ask-cmd">${esc(p.cmd)}</div><div class="ask-why">${esc(p.why)}</div>${askButtons("cmd", ["Allow once", "Always allow here", "Deny"])}</div>`;
    if (p.kind === "edit") html = `<div class="ask glass"><div class="ask-h">${I("file-pen", 16)}Edit ${esc(base(p.file))}?</div><div class="code">${codeRows(p.hunk.map(([t, n, c]) => ({ t, n, c })), false)}</div><div class="ask-why">${esc(p.file)}</div>${askButtons("edit", ["Allow", "Accept all edits", "Deny"])}</div>`;
    if (p.kind === "plan") {
        const k = (n) => `<span class="kbd">${n}</span>`;
        html = `<div class="ask planask glass"><div class="ask-h">${I("clipboard-list", 16)}Plan ready for review<span class="grow"></span><span class="aside">Nothing has been changed yet</span></div><ol>${p.steps.map((t) => `<li>${esc(t)}</li>`).join("")}</ol>
            ${p.fb !== undefined ? `<textarea id="plan-fb" class="plan-fb" rows="2" placeholder="What should change? Enter sends, Esc cancels"></textarea>` : ""}
            <div class="ask-row plan-row">
                <button class="btn ghost" data-ans="keep">${p.fb !== undefined ? "Send feedback" : "Keep planning"} ${k(4)}</button>
                <button class="btn ghost" data-ans="save" title="Save the plan as a Markdown file">${I("save", 13)}Save… ${k(6)}</button>
                <button class="btn ghost" data-ans="worktree" title="Approve and build in a new worktree">${I("folder-git-2", 13)}New worktree… ${k(5)}</button>
            </div>
            <div class="ask-row plan-row">
                <span class="grow"></span>
                <button class="btn ghost" data-ans="auto">Auto mode ${k(3)}</button>
                <button class="btn ghost" data-ans="ask">Approve, ask for edits ${k(2)}</button>
                <button class="btn primary" data-ans="edits">Approve, auto-accept edits ${k(1)}</button>
            </div></div>`;
    }
    put($("#ask"), html);
}
function renderComposer(s) {
    const c = $("#composer"), running = !!s.run;
    c.classList.toggle("running", running);
    c.classList.toggle("asking", !!s.pending);
    c.classList.toggle("shell", $("#input").value.startsWith("!"));
    const st = s.status === "waiting" ? `<span class="wait">${I("hand", 15)}</span><span class="lbl">Waiting for your answer</span>` : `<span class="ring"></span><span class="lbl trunc">${esc(s.label)}</span>`;
    put($("#status"), `${st}<span class="tm">${running ? clock(Date.now() - s.started) : ""}</span><span class="grow"></span><span class="kbd">Esc to stop</span>`);
    put($("#queue"), s.queue.map((q, i) => `<div class="qrow">${I("list-plus", 14)}<span class="grow trunc">${esc(q.text)}</span><span class="dim">Sends next</span><button class="ib" data-unq="${i}" title="Remove">${I("x", 13)}</button></div>`).join(""));
    const cm = state.comments[s.id] ?? [];
    put($("#chips"), [...s.attach.map((a, i) => `<span class="chip">${I(/\.(png|jpe?g|gif|mov|mp4)$/i.test(a) ? "image" : "file-text", 13)}${esc(a)}<button class="ib x" data-unatt="${i}">${I("x", 12)}</button></span>`), ...(cm.length ? [`<span class="chip">${I("message-square-text", 13)}${cm.length} review comment${cm.length > 1 ? "s" : ""}<button class="ib x" data-uncm>${I("x", 12)}</button></span>`] : [])].join(""));
    const m = modelOf(s.model), md2 = modeOf(s.mode), ef = effortOf(s.effort);
    put($("#pick-model"), `${PI(m.prov, 15, "pick")}<span class="trunc">${esc(m.label)}</span>${I("chevron-down", 13, 1.75, "chev")}`);
    const fast = s.fast && m.fast;
    put($("#pick-effort"), `${fast ? I("zap", 13, 2, "fz") : ""}${EG(ef.lv)}<span class="lbl">${esc(ef.label)}</span>${I("chevron-down", 13, 1.75, "chev")}`);
    $("#pick-effort").title = `Reasoning effort${fast ? ", fast mode on" : ""}`;
    $("#pick-effort").hidden = !levelsOf(s.model).length;
    put($("#pick-mode"), `${I(md2.icon, 14)}<span class="lbl">${esc(md2.label)}</span>${I("chevron-down", 13, 1.75, "chev")}`);
    $("#pick-mode").className = `pick ${s.mode === "plan" ? "mode-plan" : s.mode === "bypassPermissions" ? "mode-bypass" : ""}`;
    $("#ctx").style.setProperty("--v", s.ctx);
    $("#ctx").title = `Context: ${s.ctx}% used`;
    put($("#ctx"), `<span>${s.ctx}</span>`);
    const v = $("#input").value, has = v.trim().length > 0;
    const btn = $("#send"), kind = running && !has ? "stop" : "send";
    btn.className = `send ${kind === "stop" ? "stop" : has ? "" : "off"}`;
    btn.title = kind === "stop" ? "Stop (Esc)" : running ? "Queue" : v.startsWith("!") ? "Run" : "Send";
    put(btn, kind === "stop" ? I("square", 12, 0).replace('fill="none"', 'fill="currentColor"') : I(running ? "list-plus" : v.startsWith("!") ? "terminal" : "arrow-up", 17, 2.25));
    $("#input").placeholder = s.isNew ? "Describe the task. / for commands, @ for files, ! to run a command" : running ? "Add a follow-up. It sends when this turn ends." : "Reply. / for commands, @ for files, ! to run a command";
}

// Inspector: Changes and Plan, or the diff reader.
function diffRows(c) {
    const cx = CTX[c.path];
    const hunk = c.lines ?? [];
    if (c.kind === "a") return { rows: hunk.map(([, , code], i) => ({ t: "a", o: "", n: i + 1, c: code })), header: `@@ -0,0 +1,${hunk.length} @@`, above: 0, below: 0, head: [] };
    const pre = cx?.pre ?? [], post = cx?.post ?? [];
    const first = hunk[0]?.[1] ?? 1, start = Math.max(1, first - pre.length);
    let o = start, n = start;
    const rows = [];
    for (const l of pre) rows.push({ t: "c", o: o++, n: n++, c: l });
    for (const [t, , code] of hunk) rows.push(t === "c" ? { t, o: o++, n: n++, c: code } : t === "d" ? { t, o: o++, n: "", c: code } : { t, o: "", n: n++, c: code });
    for (const l of post) rows.push({ t: "c", o: o++, n: n++, c: l });
    const oc = rows.filter((r) => r.o !== "").length, nc = rows.filter((r) => r.n !== "").length;
    return { rows, header: `@@ -${start},${oc} +${start},${nc} @@ ${cx?.fn ?? ""}`, above: start - 1, below: Math.max(0, (cx?.total ?? o + 20) - o), head: cx?.head ?? [] };
}
// A line's place in the diff: removed lines by their old number, every other line by its new one.
const sideOf = (r) => (r.t === "d" ? ["o", r.o] : ["n", r.n]);
function lineHTML(r, path, split) {
    const g = r.t === "a" ? "+" : r.t === "d" ? "−" : " ";
    const cls = r.t === "a" ? "add" : r.t === "d" ? "del" : "";
    const [side, ln] = sideOf(r);
    const cbtn = `<button class="cbtn" data-cmt="${esc(path)}|${side}|${ln}" title="Comment on this line">${I("plus", 12, 2.5)}</button>`;
    return split ? `<div class="dl ${cls}"><span class="nn">${r.n || r.o}</span><span class="g">${g}</span><span class="tx">${hl(r.c)}</span>${cbtn}</div>`
        : `<div class="dl ${cls}"><span class="o">${r.o}</span><span class="nn">${r.n}</span><span class="g">${g}</span><span class="tx">${hl(r.c)}</span>${cbtn}</div>`;
}
function commentsAt(sid, path, r) {
    const [side, ln] = sideOf(r), here = (c) => c.path === path && c.side === side && c.ln === ln;
    const what = `${side === "o" ? "removed " : ""}line ${ln}`;
    let h = (state.comments[sid] ?? []).filter(here).map((c) => `<div class="cmt"><b>${I("message-square-text", 12)}You, ${what}</b>${esc(c.text)}</div>`).join("");
    if (state.cEdit && here(state.cEdit)) h += `<div class="cmt"><textarea id="cmt-in" placeholder="Comment on ${what}. It's sent with your next message."></textarea><div class="row"><button class="btn ghost sm" data-act="cmt-cancel">Cancel</button><button class="btn primary sm" data-act="cmt-save">Comment</button></div></div>`;
    return h;
}
// What the reader shows: this session's uncommitted changes, or once they're committed, that commit's.
const reviewable = (s) => (s.changes.length ? s.changes : s.commit?.changes ?? []);
function reviewHTML(s) {
    const list = reviewable(s);
    const c = list.find((x) => x.path === state.review.path) ?? list[0];
    if (!c) { state.review = null; return ""; }
    const d = diffRows(c), unf = state.unfold[c.path];
    let rowsHtml = "";
    if (state.rvMode === "split") {
        const L = [], R = [];
        for (let i = 0; i < d.rows.length; ) {
            const r = d.rows[i];
            if (r.t === "c") { L.push(r); R.push(r); i++; continue; }
            const dels = [], adds = [];
            while (d.rows[i]?.t === "d") dels.push(d.rows[i++]);
            while (d.rows[i]?.t === "a") adds.push(d.rows[i++]);
            for (let j = 0; j < Math.max(dels.length, adds.length); j++) { L.push(dels[j] ?? null); R.push(adds[j] ?? null); }
        }
        // One row per pair, so a comment on either side opens under both halves without breaking the alignment.
        const cell = (r) => (r ? lineHTML(r, c.path, true) : `<div class="dl empty"><span></span><span></span><span class="tx"> </span></div>`);
        rowsHtml = L.map((l, j) => { const r = R[j]; return `<div class="sp">${cell(l)}${cell(r)}</div>${l ? commentsAt(s.id, c.path, l) : ""}${r && r !== l ? commentsAt(s.id, c.path, r) : ""}`; }).join("");
    } else {
        rowsHtml = d.rows.map((r) => lineHTML(r, c.path, false) + commentsAt(s.id, c.path, r)).join("");
    }
    const sp = state.rvMode === "split", headRow = (l, i) => { const r = { t: "c", o: i + 1, n: i + 1, c: l }; return (sp ? `<div class="sp">${lineHTML(r, c.path, true)}${lineHTML(r, c.path, true)}</div>` : lineHTML(r, c.path, false)) + commentsAt(s.id, c.path, r); };
    const above = d.above ? (unf ? d.head.map(headRow).join("") + (d.above > d.head.length ? `<div class="fold static">${d.above - d.head.length} lines not shown</div>` : "") : `<button class="fold" data-unfold="${esc(c.path)}">${I("chevron-down", 14)}${d.above} lines above</button>`) : "";
    const below = d.below ? `<div class="fold static">${d.below} lines below not shown</div>` : "";
    const i = list.indexOf(c);
    return `<div class="rv-h"><button class="ib" data-act="rv-close" title="Back to changes">${I("chevron-left", 16)}</button>
        <div class="nm"><b>${esc(base(c.path))}</b><span>${esc(dir(c.path))}</span></div>
        <span class="a">+${c.add}</span><span class="d">−${c.del}</span>
        <div class="seg"><button class="${state.rvMode === "unified" ? "on" : ""}" data-rvmode="unified">Unified</button><button class="${state.rvMode === "split" ? "on" : ""}" data-rvmode="split">Split</button></div>
        <button class="ib" data-act="rv-open" title="Open in ${esc(prefs.editor)}">${I("external-link", 15)}</button></div>
        <div class="rv-files">${list.map((x) => `<button class="${x === c ? "on" : ""}" data-rvfile="${esc(x.path)}"><span class="fs ${x.kind}" style="width:auto;padding:0 3px;border-radius:4px;font-size:9.5px;font-weight:700">${x.kind.toUpperCase()}</span>${esc(base(x.path))}</button>`).join("")}</div>
        <div class="insp-body" id="rv-body"><div class="diff ${sp ? "is-split" : ""}">${above}<div class="hunk">${esc(d.header)}</div>${rowsHtml}${below}</div>
        <div class="set-note" style="margin:0 2px 8px">${i + 1} of ${list.length} files${s.changes.length ? "" : `, committed in ${s.commit.sha}`}. Hover a line and press + to leave a comment; comments go with your next message.</div></div>`;
}
function renderInsp(s) {
    const root2 = $("#insp-in");
    if (state.review) {
        const html = reviewHTML(s);
        if (state.review) {
            const keepScroll = $("#rv-body")?.scrollTop;
            const typing = state.cEdit && $("#cmt-in") ? $("#cmt-in").value : null;
            if (root2._h !== html) { root2.innerHTML = html + footHTML(s); root2._h = html; if (keepScroll) $("#rv-body").scrollTop = keepScroll; if (typing !== null && $("#cmt-in")) $("#cmt-in").value = typing; }
            return;
        }
    }
    const nC = s.changes.length;
    let bodyHtml = "";
    if (state.insp === "plan") {
        bodyHtml = s.plan.length ? `<div class="pane plan"><ul>${s.plan.map((p) => `<li class="${p.st}"><span class="box">${p.st === "done" ? I("check", 11, 3) : ""}</span><span>${esc(p.t)}</span></li>`).join("")}</ul></div>`
            : `<div class="pane blank">${I("map", 22)}<b>No plan yet</b>Switch to Plan mode (⇧Tab) and Harness lays out the steps before changing anything.</div>`;
    } else {
        const a = s.changes.reduce((n, c) => n + c.add, 0), d = s.changes.reduce((n, c) => n + c.del, 0);
        if (s.pr) bodyHtml += `<div class="prline">${I("git-pull-request", 18)}<div><b>PR #${s.pr} is open</b><span>${s.prChecks === "running" ? "Checks are running" : "All checks passed"}</span></div></div>`;
        if (nC) {
            bodyHtml += `<div class="sum"><b class="a">+${a}</b><b class="d">−${d}</b><span>in ${nC} file${nC > 1 ? "s" : ""}</span></div>`;
            bodyHtml += s.changes.map((c) => `<button class="file ${c.live ? "live" : ""} ${fresh(c) ? "enter" : ""}" style="width:100%;text-align:left" data-file="${esc(c.path)}" title="Review ${esc(base(c.path))}"><span class="fs ${c.kind}">${c.kind.toUpperCase()}</span><span class="nm"><b>${esc(base(c.path))}</b><span>${esc(dir(c.path))}</span></span><span class="st"><span class="a">+${c.add}</span> ${c.del ? `<span class="d">−${c.del}</span>` : ""}</span></button>`).join("");
        } else if (s.commit) {
            bodyHtml += `<div class="sum committed">${I("git-commit-horizontal", 15)}<span>Committed <b>${s.commit.sha}</b>${s.commit.pushed ? " and pushed" : ""}</span></div><div class="cmsg">${esc(s.commit.msg)}</div>`;
            bodyHtml += s.commit.changes.map((c) => `<button class="file" style="width:100%;text-align:left" data-file="${esc(c.path)}" title="Review ${esc(base(c.path))}"><span class="fs ${c.kind}">${c.kind.toUpperCase()}</span><span class="nm"><b>${esc(base(c.path))}</b><span>${esc(dir(c.path))}</span></span><span class="st"><span class="a">+${c.add}</span> ${c.del ? `<span class="d">−${c.del}</span>` : ""}</span></button>`).join("");
        }
        else if (!s.pr) bodyHtml += `<div class="pane blank">${I("file-diff", 22)}<b>No changes yet</b>Files Harness edits in this session show up here.</div>`;
    }
    const html = `<div class="insp-h"><div class="seg">${[["changes", `Changes${nC ? ` <span class="ct">${nC}</span>` : ""}`], ["plan", `Plan${s.plan.length ? ` <span class="ct">${s.plan.filter((p) => p.st === "done").length}/${s.plan.length}</span>` : ""}`]].map(([k, l]) => `<button class="${state.insp === k ? "on" : ""}" data-pane="${k}">${l}</button>`).join("")}</div></div><div class="insp-body">${bodyHtml}</div>`;
    put(root2, html + footHTML(s));
}
function footHTML(s) {
    const wait = s.run ? 'title="Wait for the turn to finish"' : "";
    return `<div class="insp-foot"><button class="btn ghost" data-commit ${s.changes.length && !s.run ? "" : "disabled"} ${wait}>${I("git-commit-horizontal", 14)}Commit</button>
        <button class="btn primary" data-pr ${(s.changes.length || s.commit || s.pr) && !s.prBusy && !(s.run && s.changes.length) ? "" : "disabled"} ${s.run && s.changes.length ? wait : ""}>${s.prBusy ? '<span class="ring" style="border-color:rgba(255,255,255,.35);border-top-color:#fff"></span>Opening' : `${I(s.pr && !s.changes.length ? "external-link" : "git-pull-request", 14)}${s.pr && !s.changes.length ? `View PR #${s.pr}` : "Open PR"}`}</button></div>`;
}
function renderTerm(s) {
    if (!state.term.open) return;
    const ts = tabsFor(s.project), t = activeTab(s.project);
    put($("#ttabs"), ts.map((x) => `<button class="ttab ${x === t ? "on" : ""}" data-tab="${x.id}">${x.busy ? '<span class="busy"></span>' : I("terminal", 13)}${esc(x.name)}<span class="ib x" data-tclose="${x.id}" title="Close (⌘W)">${I("x", 12)}</span></button>`).join(""));
    const out = $("#term-out");
    if (!$("#tin") || out.dataset.tab !== t.id) {
        out.innerHTML = `<div id="tlines"></div><div class="term-in"><span id="tprompt"></span><input id="tin" spellcheck="false" autocomplete="off" /></div>`;
        out.dataset.tab = t.id;
    }
    const near = out.scrollHeight - out.scrollTop - out.clientHeight < 40;
    put($("#tlines"), t.lines.map((l) => `<div>${l || " "}</div>`).join(""));
    put($("#tprompt"), t.busy ? "" : prompt(s.project, s.branch));
    $("#tin").style.visibility = t.busy ? "hidden" : "";
    if (near) out.scrollTop = out.scrollHeight;
    put($("#tmax"), I(state.term.max ? "minimize-2" : "maximize-2", 14));
}
function scrollBottom(smooth = false) { const sc = $("#scroll"); sc.scrollTo({ top: sc.scrollHeight, behavior: smooth ? "smooth" : "auto" }); }

// ---------- Layout: window size, rail and panel modes --------------------
function layoutWindow() {
    const desk = $(".desktop"), el = $("#win");
    const vw = desk.clientWidth, vh = desk.clientHeight;
    let w, h;
    if (state.win.mode === "fit") { w = Math.max(720, vw - 40); h = Math.max(480, vh - 24); }
    else { w = state.win.w; h = state.win.h; }
    const scale = Math.min(1, (vw - 12) / w, (vh - 8) / h);
    el.style.width = `${w}px`; el.style.height = `${h}px`;
    el.style.transform = scale < 0.999 ? `scale(${scale})` : "";
    state.scale = scale; state.winW = w; state.winH = h;
    for (const b of $$("#sizes button")) b.classList.toggle("on", b.dataset.size === (state.win.mode === "fit" ? "fit" : `${w}x${h}`));
    layout();
}
// Rail docks when the window is wide enough, otherwise it floats on demand.
// The inspector docks when the conversation keeps at least 520px, otherwise it floats over it.
function layout() {
    const w = state.winW ?? 1360, h = state.winH ?? 880;
    const railDock = w >= 900;
    body.dataset.railmode = railDock ? "dock" : "overlay";
    if (railDock) body.dataset.railopen = "off";
    const railW = parseFloat(getComputedStyle(root).getPropertyValue("--rail-w"));
    const sheetW = w - 8 - (railDock && body.dataset.rail !== "off" ? railW : 8);
    const sheetH = h - 16;
    const want = state.review ? Math.min(state.rvMode === "split" ? 1120 : 860, Math.max(state.inspW, Math.round(sheetW * (state.rvMode === "split" ? 0.68 : 0.55)))) : state.inspW;
    root.style.setProperty("--insp-cur", `${want}px`);
    const dock = sheetW - want >= 480;
    // Shrinking past the point where it fits closes the panel, like a Mac
    // inspector; opening it again on a narrow window floats it instead.
    if (!dock && body.dataset.inspmode === "dock" && !state.review) body.dataset.insp = "off";
    body.dataset.inspmode = dock ? "dock" : "float";
    root.style.setProperty("--insp-col", dock && body.dataset.insp === "on" ? `${want}px` : "0px");
    // The conversation keeps at least 300px under an open terminal; maximized, the terminal takes the whole sheet.
    const th = state.term.max ? sheetH : Math.max(120, Math.min(state.term.h, sheetH - 300));
    root.style.setProperty("--term-h", state.term.open ? `${th}px` : "0px");
    body.dataset.term = state.term.open ? "on" : "off";
    body.dataset.tmax = state.term.open && state.term.max ? "on" : "off";
    fitFloat();
}
// A floating inspector ends above the composer and any request, so it never hides them. When that leaves it
// too short to use, it takes the full height instead, and a request arriving closes it.
function fitFloat() {
    const sheetH = (state.winH ?? 880) - 16, termH = parseFloat(root.style.getPropertyValue("--term-h")) || 0;
    const dockH = $("#dock-in")?.offsetHeight ?? 0;
    $("#sheet").style.setProperty("--dock-h", `${dockH + 12}px`);
    body.dataset.inspshort = sheetH - termH - 54 - dockH - 20 < 260 ? "on" : "off";
    const p = cur()?.pending;
    if (p && !p.cleared && body.dataset.inspmode === "float" && body.dataset.inspshort === "on" && body.dataset.insp === "on") { p.cleared = true; toggleInsp(false); }
}

// ---------- Input --------------------------------------------------------
function autosize() { const ta = $("#input"); ta.style.height = "auto"; ta.style.height = `${ta.scrollHeight}px`; }
const typingIn = (el) => el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);

function drag(el, onMove, onEnd) {
    el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        el.setPointerCapture(e.pointerId); el.classList.add("drag");
        $("#sheet").classList.remove("anim"); $("#win").classList.remove("anim");
        const start = { x: e.clientX, y: e.clientY };
        const move = (ev) => onMove(ev, ev.clientX - start.x, ev.clientY - start.y);
        const up = () => { el.classList.remove("drag"); $("#sheet").classList.add("anim"); $("#win").classList.add("anim"); el.removeEventListener("pointermove", move); el.removeEventListener("pointerup", up); onEnd?.(); };
        el.addEventListener("pointermove", move); el.addEventListener("pointerup", up);
        onMove(e, 0, 0, true);
    });
}
let badgeT;
function sizeBadge() {
    const b = $("#sizebadge");
    b.textContent = `${state.winW} × ${state.winH}${state.scale < 0.999 ? `  (shown at ${Math.round(state.scale * 100)}%)` : ""}`;
    b.classList.add("show"); clearTimeout(badgeT); badgeT = setTimeout(() => b.classList.remove("show"), 900);
}

function wire() {
    const ta = $("#input");
    ta.addEventListener("input", () => { autosize(); composerMenus(); paint(); });
    ta.addEventListener("focus", () => $("#composer").classList.add("focus"));
    ta.addEventListener("blur", () => $("#composer").classList.remove("focus"));
    document.addEventListener("keydown", (e) => {
        if (e.target.id !== "plan-fb") return;
        const p = cur()?.pending;
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); resolveAsk("keep"); }
        if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); if (p) p.fb = undefined; paint(); $("#input").focus(); }
    }, true);
    ta.addEventListener("keydown", (e) => {
        if (menu && menu.anchor === $("#composer") && ["ArrowDown", "ArrowUp", "Enter", "Tab", "Escape"].includes(e.key) && menu.key(e)) { e.preventDefault(); return; }
        const s = cur();
        const hist = s.history;
        if (e.key === "ArrowUp" && hist.length && (!ta.value || (s.hi >= 0 && ta.selectionStart === 0))) {
            e.preventDefault();
            if (!(s.hi >= 0)) { s.hiDraft = ta.value; s.hi = hist.length; }
            s.hi = Math.max(0, s.hi - 1); ta.value = hist[s.hi]; autosize(); paint(); return;
        }
        if (e.key === "ArrowDown" && s.hi >= 0 && ta.selectionStart === ta.value.length) {
            e.preventDefault();
            s.hi++; ta.value = s.hi >= hist.length ? s.hiDraft ?? "" : hist[s.hi]; if (s.hi >= hist.length) s.hi = -1; autosize(); paint(); return;
        }
        const sendKey = e.key === "Enter" && !e.isComposing && (prefs.enterSends ? !e.shiftKey && !e.metaKey : e.metaKey || e.ctrlKey);
        if (sendKey) {
            e.preventDefault();
            const t = ta.value;
            if (!t.trim()) return;
            if (/^\/\w+$/.test(t.trim()) && SLASH.some((c) => `/${c.id}` === t.trim())) { ta.value = ""; autosize(); return slash(t.trim().slice(1)); }
            const att = s.attach; s.attach = []; ta.value = ""; autosize();
            send(s, t, att);
        }
        if (e.key === "Tab" && e.shiftKey) { e.preventDefault(); cycleMode(cur()); }
    });
    $("#send").onclick = () => {
        const s = cur();
        if ($("#send").classList.contains("stop")) return stop(s);
        const t = ta.value, att = s.attach;
        s.attach = []; ta.value = ""; autosize(); send(s, t, att); ta.focus();
    };
    const comp = $("#composer");
    comp.addEventListener("dragover", (e) => { e.preventDefault(); comp.classList.add("drag"); });
    comp.addEventListener("dragleave", () => comp.classList.remove("drag"));
    comp.addEventListener("drop", (e) => { e.preventDefault(); comp.classList.remove("drag"); for (const f of e.dataTransfer.files) cur().attach.push(f.name); paint(); });

    $("#search").addEventListener("input", (e) => { state.search = e.target.value; paint(); });
    $("#ttl").addEventListener("dblclick", renameStart);
    $("#ttl").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); renameEnd(true); } if (e.key === "Escape") { e.stopPropagation(); renameEnd(false); } });
    $("#ttl").addEventListener("blur", () => renameEnd(true));
    $("#scroll").addEventListener("scroll", () => { const sc = $("#scroll"); $("#jump").classList.toggle("show", sc.scrollHeight - sc.scrollTop - sc.clientHeight >= 140); }, { passive: true });
    $("#find-in").addEventListener("input", () => runFind());
    $("#find-in").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); runFind(e.shiftKey ? -1 : 1); } if (e.key === "Escape") { e.stopPropagation(); closeFind(); } });

    document.addEventListener("click", (e) => {
        const t = e.target, s = cur(), q = (sel) => t.closest(sel);
        if (menu && !menu.modal && t.isConnected && !menu.el.contains(t) && !menu.anchor.contains?.(t)) closeMenu();
        if (body.dataset.railopen === "on" && !q(".rail") && !q(".rail-top")) body.dataset.railopen = "off";
        let el;
        if ((el = q("[data-arch]"))) { e.stopPropagation(); return archive(el.dataset.arch); }
        if ((el = q(".sess"))) return select(el.dataset.sid);
        if ((el = q("[data-ans]"))) return resolveAsk(el.dataset.ans);
        if ((el = q(".acts-h"))) { const b = s.blocks.find((x) => x.id === el.closest("[data-k]").dataset.k); b.open = !(b.open ?? prefs.expandActivity); return bump(b); }
        if ((el = q("[data-fold]"))) { const b = s.blocks.find((x) => x.id === el.closest("[data-k]").dataset.k); b.open = !b.open; return bump(b); }
        if ((el = q("[data-review]"))) { const b = s.blocks.find((x) => x.id === el.closest("[data-k]").dataset.k); if (reviewable(s).some((c) => c.path === b.file)) openReview(b.file); else toast("That change isn't in this session's changes any more", { icon: "info" }); return; }
        if (q("[data-copy]")) return toast("Copied the reply", { icon: "copy" });
        if ((el = q("[data-rewind]"))) return rewindDialog(s, s.blocks.findIndex((x) => x.id === el.closest("[data-k]").dataset.k));
        if ((el = q("[data-file]"))) return openReview(el.dataset.file);
        if ((el = q("[data-rvfile]"))) { state.review = { path: el.dataset.rvfile }; state.cEdit = null; return paint(); }
        if ((el = q("[data-rvmode]"))) { state.rvMode = el.dataset.rvmode; layout(); return paint(); }
        if ((el = q("[data-unfold]"))) { state.unfold[el.dataset.unfold] = true; return paint(); }
        if ((el = q("[data-cmt]"))) { const [path, side, ln] = el.dataset.cmt.split("|"); state.cEdit = { path, side, ln: +ln }; paint(); setTimeout(() => $("#cmt-in")?.focus(), 30); return; }
        if ((el = q("[data-pane]"))) { state.insp = el.dataset.pane; return paint(); }
        if (q("[data-commit]")) return commitDialog();
        if (q("[data-pr]")) return openPR(s);
        if ((el = q("[data-unq]"))) { s.queue.splice(+el.dataset.unq, 1); return paint(); }
        if ((el = q("[data-unatt]"))) { s.attach.splice(+el.dataset.unatt, 1); return paint(); }
        if (q("[data-uncm]")) { state.comments[s.id] = []; return paint(); }
        if ((el = q("[data-wt]"))) { s.worktree = el.dataset.wt === "1"; return paint(); }
        if ((el = q("[data-start]"))) { ta.value = el.dataset.start; autosize(); paint(); ta.focus(); return; }
        if ((el = q("[data-tclose]"))) { e.stopPropagation(); return closeTab(s.project, el.dataset.tclose); }
        if ((el = q("[data-tab]"))) { state.term.active[s.project] = el.dataset.tab; paint(); setTimeout(() => $("#tin")?.focus(), 30); return; }
        if (q("#term-out") && !getSelection().toString()) $("#tin")?.focus();
        // Settings
        if ((el = q("[data-snav]"))) { state.settings = el.dataset.snav; $("#settings").scrollTop = 0; return paint(); }
        if ((el = q("[data-tg]"))) return setPref(el.dataset.tg, !prefs[el.dataset.tg]);
        if ((el = q("[data-pref]"))) return setPref(el.dataset.pref, el.dataset.val);
        if ((el = q("[data-step]"))) return setPref("fs", Math.min(18, Math.max(12, prefs.fs + +el.dataset.step)));
        if ((el = q("[data-selpref]"))) {
            const k = el.dataset.selpref;
            if (menu?.anchor === el) return closeMenu();
            if (["model", "smallModel", "reviewer"].includes(k)) return modelMenu(el, prefs[k], (v) => setPref(k, v));
            if (k === "defaultMode") return modeMenu(el, prefs.defaultMode, (v) => setPref("defaultMode", v));
            if (k === "editor") return openMenu(el, ["Cursor", "VS Code", "Zed", "Xcode", "Finder"].map((x) => ({ id: x, label: x, check: prefs.editor === x })), (it) => setPref("editor", it.id), { width: 200 });
        }
        if ((el = q("[data-addkey]"))) {
            const p = el.dataset.addkey;
            return dialog(`<h3>Add a key</h3><p>It's checked with one cheap request, then stored in your keychain.</p><div class="keyin" style="padding:0"><input id="dlgkey" type="password" placeholder="Paste your key" /></div><div class="row"><span class="grow"></span><button class="btn ghost" data-x>Cancel</button><button class="btn primary" data-ok>Save</button></div>`, (sc) => {
                const v = $("#dlgkey", sc).value.trim(); if (!v) return false;
                state.keys.push({ p, masked: `${v.slice(0, 6)}…${v.slice(-4)}` }); paint(); toast("Key checked and saved", { kind: "ok", icon: "key-round" });
            }, "#dlgkey");
        }
        if ((el = q("[data-act]"))) {
            const a = el.dataset.act;
            if (menu?.anchor === el) return closeMenu();
            if (a === "rail") toggleRail();
            if (a === "new") newSession();
            if (a === "insp") toggleInsp();
            if (a === "term") setTerm();
            if (a === "changes") { state.insp = "changes"; state.review = null; toggleInsp(true); }
            if (a === "more") moreMenu(el);
            if (a === "ctx") ctxCard(el);
            if (a === "model") modelMenu(el);
            if (a === "effort") effortMenu(el);
            if (a === "mode") modeMenu(el);
            if (a === "project") projectMenu(el);
            if (a === "branch") branchMenu(el);
            if (a === "attach") { s.attach.push(pick(["screenshot.png", "error.log", "design.png"])); paint(); }
            if (a === "mention") { ta.focus(); ta.setRangeText(ta.value && !ta.value.endsWith(" ") ? " @" : "@", ta.selectionStart, ta.selectionEnd, "end"); composerMenus(); }
            if (a === "settings") state.settings ? closeSettings() : openSettings();
            if (a === "settings-close") closeSettings();
            if (a === "jump") scrollBottom(true);
            if (a === "palette") palette();
            if (a === "rv-close") closeReview();
            if (a === "rv-open") toast(`Opens ${base(state.review.path)} in ${prefs.editor}`, { icon: "external-link" });
            if (a === "cmt-cancel") { state.cEdit = null; paint(); }
            if (a === "cmt-save") { const v = $("#cmt-in").value.trim(); if (v) { (state.comments[s.id] ??= []).push({ ...state.cEdit, text: v }); toast("Comment added. It goes with your next message", { icon: "message-square-text" }); } state.cEdit = null; paint(); }
            if (a === "tnew") newTab(s.project);
            if (a === "tmax") { state.term.max = !state.term.max; layout(); paint(); }
            if (a === "find-next") runFind(1);
            if (a === "find-prev") runFind(-1);
            if (a === "find-close") closeFind();
            if (a === "quickkey") { const v = $("#quickkey").value.trim(); if (!v) return; const p = /^sk-ant/.test(v) ? "anthropic" : /^sk-or/.test(v) ? "openrouter" : /^AIza/.test(v) ? "gemini" : "deepseek"; state.keys.push({ p, masked: `${v.slice(0, 6)}…${v.slice(-4)}` }); toast(`Detected ${p}. Key checked and saved`, { kind: "ok", icon: "key-round" }); paint(); }
            if (a === "provoff") toast("In the app this asks to confirm first", { icon: "info" });
            if (a === "provcheck") toast("LM Studio still isn't running", { icon: "info" });
        }
    });

    // Terminal input
    document.addEventListener("keydown", (e) => {
        if (e.target.id !== "tin") return;
        const s = cur(), t = activeTab(s.project);
        if (e.key === "Enter") { const v = e.target.value; e.target.value = ""; termRun(t, s, v); }
        else if (e.key === "ArrowUp" && t.hist.length) { e.preventDefault(); t.hi = t.hi < 0 ? t.hist.length - 1 : Math.max(0, t.hi - 1); e.target.value = t.hist[t.hi]; }
        else if (e.key === "ArrowDown" && t.hi >= 0) { e.preventDefault(); t.hi = t.hi + 1 >= t.hist.length ? -1 : t.hi + 1; e.target.value = t.hi < 0 ? "" : t.hist[t.hi]; }
        else if (e.ctrlKey && e.key === "c") { if (t.run) t.run.stopped = true; else { t.lines.push(`${prompt(s.project, s.branch)} ${esc(e.target.value)}<span class="mut">^C</span>`); e.target.value = ""; paint(); } }
        else if (e.metaKey && e.key.toLowerCase() === "k") { e.preventDefault(); e.stopPropagation(); t.lines = []; paint(); }
        else if (e.metaKey && e.key.toLowerCase() === "t") { e.preventDefault(); e.stopPropagation(); newTab(s.project); }
        else if (e.metaKey && e.key.toLowerCase() === "w") { e.preventDefault(); e.stopPropagation(); closeTab(s.project, t.id); }
        else return;
        e.stopPropagation();
    }, true);
    // Busy terminal: Ctrl+C still reaches the running command.
    document.addEventListener("keydown", (e) => {
        const s = cur(); if (!s || !state.term.open) return;
        const t = activeTab(s.project);
        if (t.busy && e.ctrlKey && e.key === "c" && $("#termp").contains(document.activeElement ?? null)) { t.run && (t.run.stopped = true); e.preventDefault(); }
    });

    // Global shortcuts, matching Settings → Shortcuts.
    document.addEventListener("keydown", (e) => {
        if (e.defaultPrevented) return;
        const mod = e.metaKey || e.ctrlKey, s = cur(), k = e.key.toLowerCase();
        if (menu && menu.anchor !== $("#composer") && menu.key(e)) { e.preventDefault(); return; }
        if (menu?.modal) return;
        if (e.ctrlKey && (e.key === "`" || e.code === "Backquote")) { e.preventDefault(); return setTerm(); }
        if (mod && k === "k") { e.preventDefault(); return palette(); }
        if (mod && k === "n") { e.preventDefault(); return newSession(); }
        if (mod && k === "f") { e.preventDefault(); return state.settings ? undefined : openFind(); }
        if (mod && k === ",") { e.preventDefault(); return state.settings ? closeSettings() : openSettings(); }
        if (mod && k === "b") { e.preventDefault(); return toggleRail(); }
        if (mod && k === ".") { e.preventDefault(); return toggleInsp(); }
        if (mod && k === "/") { e.preventDefault(); return modelMenu($("#pick-model")); }
        if (mod && k === "[") { e.preventDefault(); return stepSession(-1); }
        if (mod && k === "]") { e.preventDefault(); return stepSession(1); }
        if (mod && k === "l") { e.preventDefault(); return $("#input").focus(); }
        if ((e.key === "Enter" || e.key === " ") && document.activeElement?.classList.contains("sess")) { e.preventDefault(); return select(document.activeElement.dataset.sid); }
        if (e.key === "Escape" && document.activeElement?.id !== "tin") {
            if (menu) return closeMenu();
            if (state.cEdit) { state.cEdit = null; return paint(); }
            if ($("#find").classList.contains("show")) return closeFind();
            if (body.dataset.railopen === "on") { body.dataset.railopen = "off"; return; }
            if (state.settings) return closeSettings();
            // Like the real cards: Esc answers a request (deny, or feedback on a plan) unless you're typing.
            if (s.pending && !typingIn(document.activeElement) && performance.now() - s.pending.shown > 400) return resolveAsk(s.pending.kind === "plan" ? "keep" : "deny");
            if (state.review) return closeReview();
            if (s.run && !s.pending) return stop(s);
        }
        // Number keys answer the request showing, not while typing anywhere, and not in its first 400ms.
        const keys = s.pending && ASK_KEYS[s.pending.kind];
        if (keys && !mod && !e.altKey && !typingIn(document.activeElement) && /^[1-9]$/.test(e.key) && +e.key <= keys.length && performance.now() - s.pending.shown > 400) { e.preventDefault(); return resolveAsk(keys[+e.key - 1]); }
        if (!mod && !e.altKey && e.key.length === 1 && !typingIn(document.activeElement) && !state.settings) ta.focus();
    });

    // Drag: inspector width, terminal height, window size.
    let w0, h0;
    drag($("#resizer"), (ev, dx, dy, start) => {
        if (start) { w0 = state.inspW; return; }
        state.inspW = Math.round(Math.max(280, Math.min(620, w0 - dx / state.scale))); layout();
    });
    drag($("#tresize"), (ev, dx, dy, start) => {
        if (start) { h0 = parseFloat(getComputedStyle(root).getPropertyValue("--term-h")); return; }
        state.term.max = false; state.term.h = Math.round(Math.max(120, h0 - dy / state.scale)); layout();
    });
    for (const h of $$("[data-rh]")) drag(h, (ev, dx, dy, start) => {
        if (start) { w0 = state.winW; h0 = state.winH; state.win.mode = "fixed"; return; }
        const desk = $(".desktop");
        if (h.dataset.rh !== "b") state.win.w = Math.round(Math.max(720, Math.min(desk.clientWidth - 12, w0 + (2 * dx) / state.scale)));
        if (h.dataset.rh !== "r") state.win.h = Math.round(Math.max(480, Math.min(desk.clientHeight - 8, h0 + (2 * dy) / state.scale)));
        layoutWindow(); sizeBadge();
    });

    // Keep the transcript clear of the dock however tall it gets.
    new ResizeObserver(() => {
        const h = $("#dock-in").offsetHeight, sc = $("#scroll"), near = sc.scrollHeight - sc.scrollTop - sc.clientHeight < 140 + Math.max(0, h + 48 - (parseFloat($("#col").style.paddingBottom) || 0));
        $("#col").style.paddingBottom = `${h + 48}px`; $("#main").style.setProperty("--dock-h", `${h + 12}px`);
        fitFloat();
        if (near || state.justOpened) scrollBottom();
    }).observe($("#dock-in"));
    new ResizeObserver(() => layoutWindow()).observe($(".desktop"));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => prefs.scheme === "system" && applyPrefs());

    // Mockup controls
    for (const g of $$("[data-set]")) g.addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (g.dataset.set === "theme") setPref("scheme", b.dataset.v); else { body.dataset[g.dataset.set] = b.dataset.v; for (const x of g.children) x.classList.toggle("on", x === b); } });
    $("#sizes").addEventListener("click", (e) => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.size === "fit") state.win.mode = "fit"; else { const [w, h] = b.dataset.size.split("x").map(Number); state.win = { mode: "fixed", w, h }; } layoutWindow(); sizeBadge(); });
    $("[data-speed]").onclick = (e) => { state.speed = state.speed === 1 ? 2 : state.speed === 2 ? 4 : 1; e.currentTarget.textContent = `${state.speed}× speed`; };
    $("[data-reset]").onclick = () => location.reload();
    setInterval(() => paint(), 1000);
}

// ---------- Boot ---------------------------------------------------------
for (const el of $$("[data-i]")) el.outerHTML = I(el.dataset.i, +(el.dataset.s || 16), +(el.dataset.w || 1.75), el.className);
const params = new URLSearchParams(location.search);
if (params.get("theme")) prefs.scheme = params.get("theme");
for (const [k, v] of params) if (k !== "theme") body.dataset[k] = v;
for (const g of $$("[data-set]")) for (const b of g.children) b.classList.toggle("on", b.dataset.v === body.dataset[g.dataset.set]);
const seeds = seed();
applyPrefs();
wire();
layoutWindow();
paint(true);
requestAnimationFrame(() => { scrollBottom(); $("#sheet").classList.add("anim"); $("#win").classList.add("anim"); });
setTimeout(() => resumeSeeds(seeds), 300);
