// An approved Mac app as text: its windows and menu bar from the accessibility tree (read by src/desktop/helper.swift)
// as an indented outline, with a ref like [e12] on each element the agent can click, which stands for the middle of
// the part of it that's in its window. Frames are in global points, from the top left of the main display, as clicks
// take them.

/** An element as the helper describes it. */
export interface DesktopNode {
    role?: string;
    subrole?: string;
    title?: string;
    label?: string;
    value?: string;
    identifier?: string;
    placeholder?: string;
    frame?: number[];
    disabled?: boolean;
    selected?: boolean;
    focused?: boolean;
    minimized?: boolean;
    children?: DesktopNode[];
}

export interface DesktopRef {
    x: number;
    y: number;
    frame: [number, number, number, number];
    /** What it's called in the outline, to find it again (with its role and frame). */
    name: string;
    role: string;
    /** The app it's in. */
    pid: number;
    /** A password field: what's typed in it isn't said back. */
    secure?: boolean;
}

export interface DesktopOutline {
    text: string;
    refs: Map<string, DesktopRef>;
    lastRef: number;
    /** Every name and value shown, for `wait`. */
    texts: string[];
}

/** The outline stops at about this many characters, and says so. */
export const MAX_OUTLINE = 24_000;

const ROLES: Record<string, string> = {
    AXWindow: "window",
    AXSheet: "sheet",
    AXDrawer: "drawer",
    AXButton: "button",
    AXStaticText: "text",
    AXTextField: "textfield",
    AXSecureTextField: "securefield",
    AXTextArea: "textarea",
    AXSearchField: "searchfield",
    AXComboBox: "combobox",
    AXImage: "image",
    AXLink: "link",
    AXCell: "cell",
    AXRow: "row",
    AXCheckBox: "checkbox",
    AXSwitch: "switch",
    AXRadioButton: "radio",
    AXSlider: "slider",
    AXPopUpButton: "popup",
    AXMenuButton: "menubutton",
    AXMenuBarItem: "menu",
    AXMenu: "menu",
    AXMenuItem: "item",
    AXTabGroup: "tabs",
    AXHeading: "heading",
    AXGroup: "group",
    AXRadioGroup: "group",
    AXSplitGroup: "group",
    AXLayoutArea: "group",
    AXScrollArea: "scroll",
    AXTable: "list",
    AXList: "list",
    AXOutline: "list",
    AXBrowser: "list",
    AXToolbar: "toolbar",
    AXProgressIndicator: "progress",
    AXBusyIndicator: "progress",
    AXIncrementor: "stepper",
    AXDisclosureTriangle: "disclosure",
    AXWebArea: "webpage",
    AXColorWell: "colorwell",
    AXDateField: "datefield",
};

/** Roles that do nothing when clicked and say nothing: their children are shown in their place. */
const STRUCTURAL = new Set(["group", "scroll", "list", "toolbar", "row", "tabs", "webpage", "unknown", "menu"]);
/** Left out with what's in them: they repeat what's elsewhere (a column, its cells) or can't be used. */
const SKIPPED = new Set(["AXColumn", "AXSplitter", "AXScrollBar", "AXValueIndicator", "AXGrowArea", "AXMatte"]);
const EDITABLE = new Set(["textfield", "securefield", "textarea", "searchfield", "combobox", "datefield"]);
const TOGGLES = new Set(["checkbox", "switch", "radio"]);

function roleOf(n: DesktopNode): string {
    const r = n.role ?? "";
    if (n.subrole === "AXSecureTextField") return "securefield";
    if (n.subrole === "AXSwitch") return "switch";
    return ROLES[r] ?? (r.replace(/^AX/, "").toLowerCase() || "element");
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function quoted(s: string, n = 120): string {
    return JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);
}

/** What an element is called: its label, title, or (text, whose words are its value) its value. */
export function nameOf(n: DesktopNode): string {
    const role = roleOf(n);
    return clean(n.label) || clean(n.title) || (role === "text" || role === "heading" ? clean(n.value) : "");
}

type Rect = [number, number, number, number];

function clip(a: Rect, b: Rect): Rect | undefined {
    const x0 = Math.max(a[0], b[0]);
    const y0 = Math.max(a[1], b[1]);
    const x1 = Math.min(a[0] + a[2], b[0] + b[2]);
    const y1 = Math.min(a[1] + a[3], b[1] + b[3]);
    return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1 - x0, y1 - y0] : undefined;
}

const round = (v: number) => Math.round(v * 10) / 10;

/**
 * The app's tree as an outline. Elements wholly outside their window (scrolled away) are left out, and so is the
 * Apple menu (the menu bar's first item: shutting down, System Settings). Refs number on from `firstRef`.
 */
export function outlineApp(root: DesktopNode, pid: number, firstRef = 0): DesktopOutline {
    const refs = new Map<string, DesktopRef>();
    const lines: string[] = [];
    const texts: string[] = [];
    let size = 0;
    let cut = false;
    let seq = firstRef;
    const add = (line: string): boolean => {
        if (size + line.length + 1 > MAX_OUTLINE) {
            cut = true;
            return false;
        }
        lines.push(line);
        size += line.length + 1;
        return true;
    };
    const ref = (n: DesktopNode, f: Rect, role: string, name: string): string => {
        const r = `e${++seq}`;
        refs.set(r, { x: round(f[0] + f[2] / 2), y: round(f[1] + f[3] / 2), frame: (n.frame ?? f).map(round) as Rect, name, role: n.role ?? "", pid, ...(role === "securefield" ? { secure: true } : {}) });
        return r;
    };

    const visit = (n: DesktopNode, depth: number, within: Rect | undefined) => {
        if (cut || SKIPPED.has(n.role ?? "")) return;
        const role = roleOf(n);
        const f = n.frame?.length === 4 ? (n.frame as Rect) : undefined;
        const shown = f && within ? clip(f, within) : f && f[2] >= 1 && f[3] >= 1 ? f : undefined;
        // Scrolled out of its window: nobody can click it, and nor can what's in it.
        if (f && within && !shown && !STRUCTURAL.has(role)) return;
        const name = nameOf(n);
        const value = clean(n.value);
        const id = clean(n.identifier);
        const placeholder = clean(n.placeholder);
        const silent = (STRUCTURAL.has(role) && !name) || (role === "menu" && n.role === "AXMenu");
        let next = depth;
        if (!silent) {
            let line = `${"  ".repeat(depth)}- ${role}`;
            if (name) line += ` ${quoted(name)}`;
            if (TOGGLES.has(role)) line += value === "1" ? " (on)" : value === "0" ? " (off)" : "";
            else if (value && value !== name && value !== placeholder && role !== "securefield") line += ` value=${quoted(value, EDITABLE.has(role) ? 2000 : 80)}`;
            if (placeholder && placeholder !== name) line += ` placeholder=${quoted(placeholder, 80)}`;
            if (id && id !== name && !/^[0-9A-F-]{36}$/i.test(id) && !/^_NS:\d+$/.test(id)) line += ` id=${quoted(id, 60)}`;
            if (n.disabled) line += " (disabled)";
            if (n.selected && !TOGGLES.has(role)) line += " (selected)";
            if (n.focused) line += " (focused)";
            if (shown && role !== "window" && role !== "sheet") line += ` [${ref(n, shown, role, name || value || role)}]`;
            if (!add(line)) return;
            texts.push(...[name, value || placeholder].filter(Boolean));
            next = depth + 1;
        }
        for (const k of n.children ?? []) visit(k, next, within);
    };

    const app = clean(root.title) || "App";
    for (const top of root.children ?? []) {
        if (cut) break;
        if (top.role === "AXMenuBar") {
            // On one line: the app's menus, without the Apple menu, and below it what an open one shows.
            const items = (top.children ?? []).slice(1).filter((m) => m.frame?.length === 4);
            const parts = items.map((m) => `${quoted(nameOf(m))} [${ref(m, m.frame as Rect, "menu", nameOf(m))}]`);
            if (parts.length && !add(`- menu bar: ${parts.join(", ")}`)) break;
            for (const m of items) for (const k of m.children ?? []) visit(k, 1, undefined);
            continue;
        }
        const f = top.frame?.length === 4 ? (top.frame as Rect) : undefined;
        const title = nameOf(top);
        if (top.minimized) {
            add(`- window${title ? ` ${quoted(title)}` : ""} (minimized)`);
            continue;
        }
        const where = f ? ` at ${Math.round(f[0])},${Math.round(f[1])}, ${Math.round(f[2])}×${Math.round(f[3])}` : "";
        if (!add(`- ${roleOf(top)}${title ? ` ${quoted(title)}` : ""}${where}${top.focused ? " (focused)" : ""}`)) break;
        for (const k of top.children ?? []) visit(k, 1, f);
    }
    const body = lines.length ? lines.join("\n") : "(no windows: DesktopControl action=open brings the app to the front)";
    return { text: `App: ${app}\n${body}${cut ? `\n… (the outline stops at ${MAX_OUTLINE.toLocaleString("en-US")} characters)` : ""}`, refs, lastRef: seq, texts };
}

/**
 * Whether what a ref stood for is still there: the same kind of element called the same, at the same place (within
 * 2 points). Returns what it's called now, or undefined if it's gone or has moved.
 */
export function refStill(r: DesktopRef, root: DesktopNode): string | undefined {
    const find = (n: DesktopNode): string | undefined => {
        const f = n.frame;
        if ((n.role ?? "") === r.role && f?.length === 4 && f.every((v, i) => Math.abs(v - r.frame[i]!) <= 2)) {
            const now = nameOf(n) || clean(n.value) || roleOf(n);
            // A field's value is what was typed: it may change, and the field is still the field.
            if (now === r.name || EDITABLE.has(roleOf(n))) return now;
        }
        for (const k of n.children ?? []) {
            const found = find(k);
            if (found !== undefined) return found;
        }
        return undefined;
    };
    return find(root);
}
