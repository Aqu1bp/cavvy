// A page as the agent reads it: the accessibility tree (Accessibility.getFullAXTree) pruned to an indented outline
// of what a person would see and use, each interactive or named element with a ref (refs.ts) to act on it by.
// Pure: the tree and what the DOM says of it (links, password fields) go in, text comes out.

import { RefTable, type RefEntry } from "./refs";

export interface AxValue {
    value?: unknown;
}

export interface AxNode {
    nodeId: string;
    ignored?: boolean;
    role?: AxValue;
    name?: AxValue;
    value?: AxValue;
    properties?: { name: string; value: AxValue }[];
    childIds?: string[];
    parentId?: string;
    backendDOMNodeId?: number;
}

/** What the DOM adds, by backend node id: where links go, and fields whose value must not be shown. */
export interface DomFacts {
    hrefs: ReadonlyMap<number, string>;
    secret: ReadonlySet<number>;
}

export interface SnapshotOptions {
    refs: RefTable;
    dom?: DomFacts;
    /** The snapshot's length in characters; what's past it is left out and counted. */
    maxChars?: number;
}

export interface Outline {
    text: string;
    entries: Map<string, RefEntry>;
    /** Lines the page has; `shown` of them are in the text. */
    lines: number;
    shown: number;
}

export const SNAPSHOT_CHARS = 24_000;
const MAX_NAME = 160;
const MAX_VALUE = 120;
const MAX_HREF = 120;

/** Roles a person acts on. */
const INTERACTIVE = new Set(["button", "link", "textbox", "searchbox", "combobox", "checkbox", "radio", "switch", "slider", "spinbutton", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "option", "treeitem", "listbox", "disclosuretriangle", "PopUpButton"]);
/** Roles that only group: left out, their content kept. Text on either side of one doesn't run together. */
const BLOCKS = new Set(["none", "presentation", "generic", "GenericContainer", "paragraph", "RootWebArea", "WebArea", "Section", "LayoutTable", "LayoutTableRow", "LayoutTableCell", "Iframe", "IframePresentational", "MenuListPopup"]);
/** Roles that style text inside a line: left out, and the text around them is one run. */
const INLINE = new Set(["strong", "emphasis", "mark", "Abbr", "abbr", "Time", "time", "subscript", "superscript", "LabelText", "Ruby", "RubyAnnotation"]);
/** Roles that give structure only when they have a name; unnamed, they're left out like a block. */
const NAMED_ONLY = new Set(["form", "group", "region", "article"]);
/** Roles with nothing to say: dropped with what's inside them. */
const EMPTY = new Set(["InlineTextBox", "LineBreak", "ListMarker"]);
/** Roles whose name is the text inside them: that text isn't printed again. */
const NAMED_BY_CONTENT = new Set(["button", "link", "heading", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "option", "treeitem", "cell", "columnheader", "rowheader", "switch", "checkbox", "radio", "listitem", "caption", "legend", "figcaption", "term", "definition"]);
/** Roles that show what was typed or chosen. */
const HAS_VALUE = new Set(["textbox", "searchbox", "combobox", "slider", "spinbutton"]);
/** Roles whose content is their value, already said: nothing inside them is listed. */
const TYPED = new Set(["textbox", "searchbox", "spinbutton", "slider"]);
const CHECKABLE = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);

const text = (v: AxValue | undefined): string => (typeof v?.value === "string" ? v.value : typeof v?.value === "number" ? String(v.value) : "");
const tidy = (s: string, max: number) => {
    const t = s.replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max)}…` : t;
};
const quote = (s: string) => JSON.stringify(s);

function property(node: AxNode, name: string): unknown {
    return node.properties?.find((p) => p.name === name)?.value.value;
}

interface Line {
    depth: number;
    role: string;
    name: string;
    states: string[];
    value?: string;
    href?: string;
    node?: number;
}

/** The states worth saying: what's on, and for toggles what's off. */
function states(node: AxNode, role: string): string[] {
    const out: string[] = [];
    const checked = property(node, "checked");
    if (CHECKABLE.has(role) || checked !== undefined) out.push(checked === "mixed" ? "mixed" : checked === true || checked === "true" ? "checked" : "unchecked");
    const expanded = property(node, "expanded");
    if (expanded !== undefined) out.push(expanded === true ? "expanded" : "collapsed");
    for (const flag of ["pressed", "selected", "disabled", "required", "readonly", "modal"]) {
        const v = property(node, flag);
        if (v === true || v === "true" || (flag === "pressed" && v === "mixed")) out.push(flag);
    }
    const invalid = property(node, "invalid");
    if (invalid && invalid !== "false") out.push("invalid");
    const level = property(node, "level");
    if (role === "heading" && typeof level === "number") out.push(`level=${level}`);
    return out;
}

/** A link's target as the page shows it: a path on the same site, the whole address elsewhere. */
function shownHref(raw: string, base: string | undefined): string {
    try {
        const u = new URL(raw, base);
        const here = base ? new URL(base) : undefined;
        const shown = here && u.origin === here.origin ? `${u.pathname}${u.search}${u.hash}` : u.href;
        return shown.length > MAX_HREF ? `${shown.slice(0, MAX_HREF)}…` : shown;
    } catch {
        return raw.slice(0, MAX_HREF);
    }
}

/** What Accessibility.getFullAXTree can't say, from DOMSnapshot.captureSnapshot's answer: link targets and password fields. */
export function domFacts(snapshot: { documents: { baseURL: number; nodes: { nodeName?: number[]; backendNodeId?: number[]; attributes?: number[][] } }[]; strings: string[] }): DomFacts {
    const hrefs = new Map<number, string>();
    const secret = new Set<number>();
    for (const doc of snapshot.documents) {
        const { nodeName = [], backendNodeId = [], attributes = [] } = doc.nodes;
        const base = snapshot.strings[doc.baseURL];
        for (let i = 0; i < nodeName.length; i++) {
            const name = snapshot.strings[nodeName[i]!]?.toUpperCase();
            if (name !== "A" && name !== "INPUT" && name !== "AREA") continue;
            const attrs = new Map<string, string>();
            const list = attributes[i] ?? [];
            for (let k = 0; k + 1 < list.length; k += 2) attrs.set(snapshot.strings[list[k]!]!.toLowerCase(), snapshot.strings[list[k + 1]!]!);
            const node = backendNodeId[i]!;
            const href = attrs.get("href");
            if (name !== "INPUT" && href) hrefs.set(node, shownHref(href, base));
            if (name === "INPUT" && attrs.get("type")?.toLowerCase() === "password") secret.add(node);
        }
    }
    return { hrefs, secret };
}

/**
 * The outline of a page. `nodes` is Accessibility.getFullAXTree's answer. Refs go to interactive elements and named
 * ones that have a DOM node; they are numbered by `refs`, so an element keeps its ref from one snapshot to the next.
 */
export function outlineOf(nodes: AxNode[], o: SnapshotOptions): Outline {
    const byId = new Map(nodes.map((n) => [n.nodeId, n]));
    const root = nodes.find((n) => !n.parentId || !byId.has(n.parentId));
    const lines: Line[] = [];
    const dom = o.dom ?? { hrefs: new Map(), secret: new Set() };
    /** The text line that more text at its depth continues. */
    let run: Line | undefined;
    const seen = new Set<string>();

    const say = (line: Line) => {
        run = undefined;
        lines.push(line);
    };
    const sayText = (depth: number, raw: string, covered: string) => {
        const t = tidy(raw, MAX_NAME * 2);
        if (!t || (covered && covered.includes(t))) return;
        // Pieces of one sentence (around a <strong>) join as they were written, spaces and all.
        const piece = raw.replace(/\s+/g, " ");
        if (run && run.depth === depth) run.name += piece;
        else lines.push((run = { depth, role: "text", name: piece, states: [] }));
    };

    /** The text inside a node. */
    const contentOf = (node: AxNode): string =>
        (node.childIds ?? [])
            .map((id) => byId.get(id))
            .map((k) => (!k ? "" : text(k.role) === "StaticText" ? text(k.name) : contentOf(k)))
            .join("");

    const visit = (node: AxNode, depth: number, covered: string) => {
        if (seen.has(node.nodeId)) return;
        seen.add(node.nodeId);
        const role = text(node.role);
        if (EMPTY.has(role)) return;
        const name = tidy(text(node.name), MAX_NAME);
        const kids = () => (node.childIds ?? []).map((id) => byId.get(id)).filter((n): n is AxNode => n !== undefined);
        if (role === "StaticText") {
            if (!node.ignored) sayText(depth, text(node.name), covered);
            return;
        }
        if (node.ignored || !role || INLINE.has(role) || BLOCKS.has(role) || (NAMED_ONLY.has(role) && !name)) {
            const block = !INLINE.has(role);
            if (block) run = undefined;
            // A label's words are the name of the control it labels.
            for (const k of kids()) visit(k, depth, role === "LabelText" ? contentOf(node) : covered);
            if (block) run = undefined;
            return;
        }
        const backend = node.backendDOMNodeId;
        let value = HAS_VALUE.has(role) ? tidy(text(node.value), MAX_VALUE) : "";
        if (value && backend !== undefined && dom.secret.has(backend)) value = "[hidden]";
        const line: Line = { depth, role, name, states: states(node, role), node: backend };
        if (value) line.value = value;
        if (role === "link" && backend !== undefined) line.href = dom.hrefs.get(backend);
        const before = lines.length;
        say(line);
        if (!TYPED.has(role)) for (const k of kids()) visit(k, depth + 1, NAMED_BY_CONTENT.has(role) && name ? name : "");
        // A group, list or landmark with nothing of its own and nothing shown inside it gets no line.
        if (!name && !line.states.length && !line.value && !INTERACTIVE.has(role) && lines.length === before + 1) lines.pop();
        run = undefined;
    };
    if (root) visit(root, 0, "");

    // Refs go only to what's shown, in order; the text stops at the cap.
    const entries = new Map<string, RefEntry>();
    const max = o.maxChars ?? SNAPSHOT_CHARS;
    const out: string[] = [];
    let used = 0;
    for (const l of lines) {
        const wantsRef = l.node !== undefined && l.role !== "text" && (INTERACTIVE.has(l.role) || Boolean(l.name));
        const ref = wantsRef ? o.refs.refFor(l.node!) : undefined;
        const body = [`${"  ".repeat(l.depth)}- ${l.role}`, l.name && quote(l.role === "text" ? tidy(l.name, MAX_NAME * 2) : l.name), ref && `[${ref}]`, ...l.states, l.value !== undefined && `value=${quote(l.value)}`, l.href && `-> ${l.href}`].filter(Boolean).join(" ");
        if (used + body.length + 1 > max) break;
        used += body.length + 1;
        out.push(body);
        if (ref) entries.set(ref, { backendNodeId: l.node!, role: l.role, name: l.name });
    }
    return { text: out.join("\n"), entries, lines: lines.length, shown: out.length };
}
