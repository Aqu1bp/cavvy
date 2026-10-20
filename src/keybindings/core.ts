// Keybindings: parse ~/.harness/keybindings.json (Claude Code's format) into a
// keymap for one app (the terminal or the GUI) on one platform, and match key
// presses against it, chords included. No I/O here: the GUI imports it too.

import { ACTIONS, ACTION_BY_ID, CONTEXTS, type ActionDef, type Context, type KeyApp } from "./actions";

export { ACTIONS, CONTEXTS, type ActionDef, type Context, type KeyApp };

export type KeyPlatform = "macos" | "windows" | "linux" | "other";

/** One key press. `alt` is Option on macOS (and what terminals call meta). `cmd` is Command / Windows / Super. */
export interface Stroke {
    key: string;
    ctrl?: boolean;
    alt?: boolean;
    shift?: boolean;
    cmd?: boolean;
}

export interface KeyIssue {
    level: "error" | "warning";
    message: string;
}

/** A user binding as written in the file, once checked. */
export interface UserBinding {
    context: Context;
    keys: string;
    action: string | null;
}

export interface Keymap {
    app: KeyApp;
    platform: KeyPlatform;
    /** context -> canonical key sequence ("ctrl+x ctrl+e") -> action id, or null for unbound. */
    readonly table: ReadonlyMap<Context, ReadonlyMap<string, string | null>>;
    /** context -> every proper prefix of a bound chord. */
    readonly prefixes: ReadonlyMap<Context, ReadonlySet<string>>;
    /** action id -> its key sequences, in the order to show them (custom ones first). */
    readonly keysOf: ReadonlyMap<string, string[]>;
    /** Actions whose keys differ from the defaults. */
    readonly customized: ReadonlySet<string>;
    readonly issues: KeyIssue[];
}

export const CHORD_TIMEOUT_MS = 2000;
export const KEYBINDINGS_DOCS = "https://code.claude.com/docs/en/keybindings";

const MODIFIERS: Record<string, "ctrl" | "alt" | "shift" | "cmd" | "mod"> = {
    ctrl: "ctrl",
    control: "ctrl",
    alt: "alt",
    opt: "alt",
    option: "alt",
    meta: "alt",
    shift: "shift",
    cmd: "cmd",
    command: "cmd",
    super: "cmd",
    win: "cmd",
    mod: "mod",
};

const KEY_ALIASES: Record<string, string> = {
    esc: "escape",
    return: "enter",
    del: "delete",
    arrowup: "up",
    arrowdown: "down",
    arrowleft: "left",
    arrowright: "right",
    pgup: "pageup",
    pgdn: "pagedown",
    pagedn: "pagedown",
    ins: "insert",
    spacebar: "space",
    plus: "+",
    minus: "-",
    backquote: "`",
    backtick: "`",
};

const NAMED_KEYS = new Set(["enter", "escape", "tab", "space", "backspace", "delete", "insert", "up", "down", "left", "right", "home", "end", "pageup", "pagedown", ...Array.from({ length: 12 }, (_, i) => `f${i + 1}`)]);

function editDistance(a: string, b: string): number {
    const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) d[0]![j] = j;
    for (let i = 1; i <= a.length; i++)
        for (let j = 1; j <= b.length; j++) d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1));
    return d[a.length]![b.length]!;
}

function closest(word: string, options: Iterable<string>): string | undefined {
    let best: string | undefined;
    let bestD = 3;
    for (const o of options) {
        const dist = editDistance(word.toLowerCase(), o.toLowerCase());
        if (dist < bestD) [best, bestD] = [o, dist];
    }
    return best;
}

/**
 * One keystroke ("ctrl+shift+k", "mod+enter", "ctrl++") as a Stroke for this
 * app and platform, or why it can't be one.
 */
export function parseStroke(text: string, app: KeyApp, platform: KeyPlatform): Stroke | { error: string } {
    const raw = text.trim();
    if (!raw) return { error: "Empty keystroke" };
    // "ctrl++" and a bare "+" name the plus key.
    const parts = raw === "+" ? ["+"] : raw.endsWith("++") ? [...raw.slice(0, -2).split("+"), "+"] : raw.split("+");
    const keyPart = parts.pop()!.toLowerCase();
    const s: Stroke = { key: "" };
    for (const p of parts) {
        const m = MODIFIERS[p.toLowerCase()];
        if (!m) {
            const suggestion = closest(p, Object.keys(MODIFIERS));
            return { error: `"${p}" is not a modifier in "${raw}"${suggestion ? `. Did you mean "${[...parts.map((x) => (x === p ? suggestion : x)), keyPart].join("+")}"?` : ". Use a space between the keys of a chord."}` };
        }
        // `mod` is Command on a Mac, Ctrl elsewhere and in every terminal.
        const which = m === "mod" ? (app === "gui" && platform === "macos" ? "cmd" : "ctrl") : m;
        s[which] = true;
    }
    const key = KEY_ALIASES[keyPart] ?? keyPart;
    if (key.length !== 1 && !NAMED_KEYS.has(key)) {
        const suggestion = closest(key, NAMED_KEYS);
        return { error: `Unknown key "${keyPart}" in "${raw}"${suggestion ? `. Did you mean "${suggestion}"?` : ""}` };
    }
    s.key = key;
    if (app === "tui") {
        // Terminals send these the same as other keys; match what the key parser reports.
        if (s.cmd) {
            s.cmd = undefined;
            s.alt = true;
        }
        if (s.ctrl && !s.alt && !s.shift && key === "j") s.key = "enter";
    }
    return s;
}

/** The canonical text of a stroke, for lookups: modifiers in a fixed order. */
export function strokeId(s: Stroke): string {
    return `${s.ctrl ? "ctrl+" : ""}${s.alt ? "alt+" : ""}${s.shift ? "shift+" : ""}${s.cmd ? "cmd+" : ""}${s.key}`;
}

function isPrintable(s: Stroke): boolean {
    return !s.ctrl && !s.alt && !s.cmd && (s.key.length === 1 || s.key === "space");
}

/** Why a keystroke can't (error) or may not (warning) be used in this app; undefined when it's fine. */
function strokeProblem(s: Stroke, raw: string, app: KeyApp, platform: KeyPlatform): KeyIssue | undefined {
    if (isPrintable(s)) return { level: "error", message: `"${raw}" is a key you type; binding it would stop you typing "${s.shift && s.key.length === 1 ? s.key.toUpperCase() : s.key === "space" ? " " : s.key}". Add ctrl, alt or cmd.` };
    if (app === "tui") {
        const plainCtrl = s.ctrl && !s.alt && !s.shift;
        if (s.ctrl && s.key === "c") return { level: "error", message: `"${raw}" can't be rebound: it interrupts and exits.` };
        if (s.ctrl && s.key === "d") return { level: "error", message: `"${raw}" can't be rebound: it exits.` };
        const same: Record<string, string> = { m: "Enter", "[": "Escape", i: "Tab", h: "Backspace" };
        if (plainCtrl && same[s.key]) return { level: "error", message: `"${raw}" can't be rebound: terminals send it as ${same[s.key]}.` };
        if (plainCtrl && s.key === "z") return { level: "warning", message: `"${raw}" may not reach Harness: terminals use it to suspend the program.` };
        if (plainCtrl && s.key === "\\") return { level: "warning", message: `"${raw}" may not reach Harness: terminals use it to quit the program.` };
        if (/(^|\+)(cmd|command|super|win)\+/i.test(raw)) return { level: "warning", message: `"${raw}": most terminals never send Cmd, and those that do report it like Alt. Prefer ctrl.` };
        return undefined;
    }
    if (platform === "macos" && s.cmd && !s.ctrl && !s.alt && !s.shift && ["q", "w", "tab", "space", "h", "m"].includes(s.key)) return { level: "error", message: `"${raw}" belongs to macOS and never reaches Harness.` };
    const mod = platform === "macos" ? s.cmd && !s.ctrl : s.ctrl && !s.cmd;
    if (mod && !s.alt && !s.shift && ["c", "v", "x", "a", "z"].includes(s.key)) return { level: "warning", message: `"${raw}" replaces ${({ c: "copy", v: "paste", x: "cut", a: "select all", z: "undo" } as Record<string, string>)[s.key]} wherever the binding applies.` };
    return undefined;
}

/**
 * The bindings in the file's text, checked. Problems that make the whole file
 * unusable (not JSON, wrong shape) come back as `fatal`.
 */
export function parseKeybindingsText(text: string): { bindings: UserBinding[]; issues: KeyIssue[]; fatal?: string } {
    let data: unknown;
    try {
        data = JSON.parse(stripJsonComments(text));
    } catch (e) {
        return { bindings: [], issues: [], fatal: `keybindings.json isn't valid JSON: ${(e as Error).message}` };
    }
    if (!data || typeof data !== "object" || Array.isArray(data) || !("bindings" in data)) return { bindings: [], issues: [], fatal: 'keybindings.json must be an object with a "bindings" array: { "bindings": [{ "context": "Chat", "bindings": { "ctrl+e": "chat:externalEditor" } }] }' };
    const blocks = (data as { bindings: unknown }).bindings;
    if (!Array.isArray(blocks)) return { bindings: [], issues: [], fatal: '"bindings" must be an array of { "context", "bindings" } blocks.' };
    const issues: KeyIssue[] = [];
    const out: UserBinding[] = [];
    blocks.forEach((block, i) => {
        const where = `bindings[${i}]`;
        if (!block || typeof block !== "object" || Array.isArray(block)) return void issues.push({ level: "error", message: `${where} must be an object with "context" and "bindings".` });
        const { context, bindings } = block as { context?: unknown; bindings?: unknown };
        if (typeof context !== "string" || !(CONTEXTS as readonly string[]).includes(context)) {
            const near = typeof context === "string" ? closest(context, CONTEXTS) : undefined;
            return void issues.push({ level: "error", message: `${where}: unknown context ${JSON.stringify(context ?? null)}${near ? ` (did you mean "${near}"?)` : ""}. Valid contexts: ${CONTEXTS.join(", ")}.` });
        }
        if (!bindings || typeof bindings !== "object" || Array.isArray(bindings)) return void issues.push({ level: "error", message: `${where} (${context}): "bindings" must be an object of "key": "action" pairs.` });
        for (const [keys, action] of Object.entries(bindings as Record<string, unknown>)) {
            if (action !== null && typeof action !== "string") {
                issues.push({ level: "error", message: `${context} "${keys}": the action must be a string such as "chat:submit", or null to unbind.` });
                continue;
            }
            if (typeof action === "string") {
                const def = ACTION_BY_ID.get(action);
                if (!def) {
                    const near = closest(action, ACTION_BY_ID.keys());
                    issues.push({ level: "error", message: `${context} "${keys}": unknown action "${action}"${near ? ` (did you mean "${near}"?)` : ""}.` });
                    continue;
                }
                if ((def.context === "Autocomplete") !== (context === "Autocomplete")) {
                    issues.push({ level: "error", message: `${context} "${keys}": "${action}" only works in the ${def.context === "Autocomplete" ? "Autocomplete" : "Global or Chat"} context.` });
                    continue;
                }
            }
            out.push({ context: context as Context, keys, action });
        }
    });
    return { bindings: out, issues };
}

/** JSON with // and /* comments (the template has some), outside of strings. */
export function stripJsonComments(text: string): string {
    let out = "";
    for (let i = 0; i < text.length; i++) {
        const c = text[i]!;
        if (c === '"') {
            const start = i;
            for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
            out += text.slice(start, i + 1);
        } else if (c === "/" && text[i + 1] === "/") {
            while (i < text.length && text[i] !== "\n") i++;
            out += "\n";
        } else if (c === "/" && text[i + 1] === "*") {
            const end = text.indexOf("*/", i + 2);
            i = end < 0 ? text.length : end + 1;
            out += " ";
        } else out += c;
    }
    return out;
}

function parseSequence(keys: string, app: KeyApp, platform: KeyPlatform): { id?: string; issue?: KeyIssue } {
    const parts = keys.trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return { issue: { level: "error", message: "An empty key." } };
    const ids: string[] = [];
    let warning: KeyIssue | undefined;
    for (const p of parts) {
        const s = parseStroke(p, app, platform);
        if ("error" in s) return { issue: { level: "error", message: s.error } };
        // A chord's later keys may be plain ones ("ctrl+x b"), as in Claude Code.
        const problem = ids.length && isPrintable(s) ? undefined : strokeProblem(s, p, app, platform);
        if (problem?.level === "error") return { issue: problem };
        warning ??= problem;
        ids.push(strokeId(s));
    }
    return { id: ids.join(" "), issue: warning };
}

export interface BuildOptions {
    /** Replace an action's default keys (the GUI's Enter-sends preference). */
    defaults?: Record<string, string[]>;
}

/** The keymap for one app: the defaults, then the user's bindings on top. */
export function buildKeymap(user: UserBinding[], app: KeyApp, platform: KeyPlatform, issues: KeyIssue[] = [], opts: BuildOptions = {}): Keymap {
    const table = new Map<Context, Map<string, string | null>>(CONTEXTS.map((c) => [c, new Map()]));
    const all = [...issues];
    const defaultKeys = new Map<string, string[]>();
    for (const a of ACTIONS) {
        const keys = opts.defaults?.[a.id] ?? a.defaults[app];
        if (!keys) continue;
        const ids: string[] = [];
        for (const k of keys) {
            const r = parseSequence(k, app, platform);
            if (!r.id) continue;
            if (!ids.includes(r.id)) ids.push(r.id);
            const ctx = table.get(a.context)!;
            if (!ctx.has(r.id)) ctx.set(r.id, a.id);
        }
        defaultKeys.set(a.id, ids);
    }
    const userKeys = new Map<string, string[]>();
    const seen = new Map<string, string>();
    for (const b of user) {
        const def = b.action ? ACTION_BY_ID.get(b.action) : undefined;
        // The other app's action: this app leaves the key alone.
        if (def && !(opts.defaults?.[def.id] ?? def.defaults[app])) continue;
        const r = parseSequence(b.keys, app, platform);
        if (r.issue) all.push({ ...r.issue, message: `${b.context}: ${r.issue.message}` });
        if (!r.id) continue;
        const dupKey = `${b.context}\u0000${r.id}`;
        const prev = seen.get(dupKey);
        if (prev !== undefined) all.push({ level: "warning", message: `${b.context}: "${prev}" and "${b.keys}" are the same key; the last one wins.` });
        seen.set(dupKey, b.keys);
        table.get(b.context)!.set(r.id, b.action);
        if (b.action) userKeys.set(b.action, [...(userKeys.get(b.action) ?? []).filter((k) => k !== r.id), r.id]);
    }
    // Chords: a key that is also the start of a chord waits for the chord.
    const prefixes = new Map<Context, Set<string>>();
    for (const [ctx, m] of table) {
        const set = new Set<string>();
        for (const [seq, action] of m) {
            if (!action) continue;
            const parts = seq.split(" ");
            for (let i = 1; i < parts.length; i++) set.add(parts.slice(0, i).join(" "));
        }
        for (const p of set) {
            const shadowed = m.get(p);
            if (shadowed) all.push({ level: "warning", message: `${ctx}: "${p}" starts a chord, so it no longer runs ${shadowed} on its own.` });
        }
        prefixes.set(ctx, set);
    }
    // What each action is bound to now, after unbinding and rebinding.
    const keysOf = new Map<string, string[]>();
    const customized = new Set<string>();
    for (const a of ACTIONS) {
        if (!(opts.defaults?.[a.id] ?? a.defaults[app])) continue;
        const live = (k: string) => [...table.values()].some((m) => m.get(k) === a.id);
        const keys = [...(userKeys.get(a.id) ?? []), ...(defaultKeys.get(a.id) ?? [])].filter((k, i, arr) => arr.indexOf(k) === i && live(k) && !prefixes.get(a.context)!.has(k));
        keysOf.set(a.id, keys);
        const defaults = defaultKeys.get(a.id) ?? [];
        if (keys.length !== defaults.length || keys.some((k) => !defaults.includes(k))) customized.add(a.id);
    }
    return { app, platform, table, prefixes, keysOf, customized, issues: all };
}

/** Parse the file's text (undefined: no file) and build the keymap. A broken file gives the defaults plus the error. */
export function loadKeymap(text: string | undefined, app: KeyApp, platform: KeyPlatform, opts: BuildOptions = {}): Keymap & { fatal?: string } {
    if (text === undefined || !text.trim()) return buildKeymap([], app, platform, [], opts);
    const parsed = parseKeybindingsText(text);
    if (parsed.fatal) return { ...buildKeymap([], app, platform, [{ level: "error", message: parsed.fatal }], opts), fatal: parsed.fatal };
    return buildKeymap(parsed.bindings, app, platform, parsed.issues, opts);
}

/** `abandoned`: how many earlier keys were a chord that didn't complete, for the caller to handle as usual first. */
export type MatchResult = { abandoned: number } & (
    | { kind: "action"; action: string; context: Context }
    /** The keys so far start a chord: wait for the next. */
    | { kind: "pending"; keys: string }
    /** Nothing bound; `unbound` when a null in the file took the key away. */
    | { kind: "none"; unbound?: boolean }
);

/**
 * Matches key presses against a keymap, chords included. `contexts` are the
 * active ones, most specific first. One per window or terminal.
 */
export class KeyMatcher {
    private pending: string[] = [];
    private pendingAt = 0;

    constructor(public keymap: Keymap, private now: () => number = Date.now) {}

    get waiting(): string | undefined {
        return this.pending.length && this.now() - this.pendingAt <= CHORD_TIMEOUT_MS ? this.pending.join(" ") : undefined;
    }

    reset() {
        this.pending = [];
    }

    /**
     * `stroke`: the key pressed, or the ids it may go by (a GUI key is tried as
     * the character it typed and as the key on the keyboard), best first.
     */
    match(stroke: Stroke | string | readonly string[], contexts: readonly Context[]): MatchResult {
        const ids = typeof stroke === "string" ? [stroke] : Array.isArray(stroke) ? (stroke as readonly string[]) : [strokeId(stroke as Stroke)];
        let abandoned = 0;
        if (this.pending.length) {
            const held = this.pending;
            this.pending = [];
            if (this.now() - this.pendingAt > CHORD_TIMEOUT_MS) abandoned = held.length;
            else {
                for (const id of ids) {
                    const r = this.lookup(`${held.join(" ")} ${id}`, contexts);
                    if (r) return r;
                }
                abandoned = held.length;
            }
        }
        for (const id of ids) {
            const r = this.lookup(id, contexts);
            if (r) return { ...r, abandoned };
        }
        return { kind: "none", abandoned };
    }

    private lookup(seq: string, contexts: readonly Context[]): MatchResult | undefined {
        for (const c of contexts) {
            if (this.keymap.prefixes.get(c)?.has(seq)) {
                this.pending = seq.split(" ");
                this.pendingAt = this.now();
                return { kind: "pending", keys: seq, abandoned: 0 };
            }
            const m = this.keymap.table.get(c);
            if (!m?.has(seq)) continue;
            const action = m.get(seq);
            // A null in a more specific context unbinds the key there.
            if (action === null || action === undefined) return { kind: "none", abandoned: 0, unbound: true };
            return { kind: "action", action, context: c, abandoned: 0 };
        }
        return undefined;
    }
}

const MAC_SYMBOLS: Record<string, string> = { ctrl: "⌃", alt: "⌥", shift: "⇧", cmd: "⌘" };
const PC_NAMES: Record<string, string> = { ctrl: "Ctrl", alt: "Alt", shift: "Shift", cmd: "Win" };
const KEY_LABELS: Record<string, string> = { enter: "Enter", escape: "Esc", tab: "Tab", space: "Space", backspace: "Backspace", delete: "Delete", insert: "Insert", up: "↑", down: "↓", left: "←", right: "→", home: "Home", end: "End", pageup: "Page Up", pagedown: "Page Down", "+": "Plus" };

function splitStroke(stroke: string): { mods: string[]; key: string } {
    if (stroke.endsWith("++")) return { mods: stroke.slice(0, -2).split("+").filter(Boolean), key: "+" };
    const parts = stroke.split("+");
    return { key: parts.pop()!, mods: parts };
}

/**
 * A canonical key sequence for people. GUI: "⌘+K" on a Mac, "Ctrl+K"
 * elsewhere (each "+"-separated part is drawn as one key cap). Terminal:
 * "ctrl+k", as the file spells it.
 */
export function formatKeys(seq: string, app: KeyApp, platform: KeyPlatform): string {
    return seq
        .split(" ")
        .map((stroke) => {
            const { mods, key } = splitStroke(stroke);
            if (app === "tui") return mods.length === 1 && mods[0] === "ctrl" && key === "enter" ? "ctrl+j" : stroke;
            const label = KEY_LABELS[key] ?? key.toUpperCase();
            const names = platform === "macos" ? MAC_SYMBOLS : { ...PC_NAMES, cmd: platform === "windows" ? "Win" : "Super" };
            return [...mods.map((m) => names[m] ?? m), label].join("+");
        })
        .join(" ");
}

/** The keys for an action, formatted, or undefined when it has none. */
export function keyLabel(keymap: Keymap, action: string, all = false): string | undefined {
    const keys = keymap.keysOf.get(action);
    if (!keys?.length) return undefined;
    return (all ? keys : keys.slice(0, 1)).map((k) => formatKeys(k, keymap.app, keymap.platform)).join(" · ");
}

export const KEYBINDINGS_TEMPLATE = `{
  // Custom keyboard shortcuts for Harness (the terminal app and the GUI).
  // Same format as Claude Code's keybindings.json: ${KEYBINDINGS_DOCS}
  // Changes apply as soon as you save. Set a key to null to unbind it.
  // Modifiers: ctrl, alt (opt), shift, cmd, and mod (Cmd on macOS, Ctrl elsewhere).
  // Chords: "ctrl+x ctrl+e". Contexts: Global, Chat, Autocomplete.
  "bindings": [
    {
      "context": "Chat",
      "bindings": {
        // "ctrl+e": "chat:externalEditor"
      }
    }
  ]
}
`;
