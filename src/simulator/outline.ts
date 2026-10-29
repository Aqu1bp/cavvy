// The simulator's screen as text: its accessibility tree (read by the helper) as an indented outline, with a ref
// like [e12] on each element the agent can tap, which stands for the element's center. Text read from the picture
// that the tree doesn't have (a web page's: its elements live in another process the tree doesn't reach) follows,
// as `seen` lines with refs of their own.

/** An element as the helper describes it: frame in the screen's points (x, y, width, height). */
export interface AxNode {
    role?: string;
    subrole?: string;
    label?: string;
    title?: string;
    value?: string;
    identifier?: string;
    placeholder?: string;
    frame?: number[];
    disabled?: boolean;
    children?: AxNode[];
}

/** A line of text Vision read from the screen's picture, with its frame in points. */
export interface SeenLine {
    text: string;
    confidence: number;
    frame: number[];
}

export interface RefTarget {
    x: number;
    y: number;
    frame: [number, number, number, number];
    name: string;
}

export interface Outline {
    text: string;
    refs: Map<string, RefTarget>;
    /** The labels and values of the elements shown: the text on the screen. */
    texts: string[];
}

/** The outline stops at about this many characters (as the browser's does), and says so. */
export const MAX_OUTLINE = 24_000;

/** Lines read less surely than this are mostly misreadings. */
const SEEN_CONFIDENCE = 0.5;
/** A line is the tree's own when this share of its words are in the elements it overlaps. */
const SEEN_KNOWN = 0.6;

const ROLES: Record<string, string> = {
    AXApplication: "app",
    AXButton: "button",
    AXStaticText: "text",
    AXTextField: "textfield",
    AXSecureTextField: "securefield",
    AXTextArea: "textarea",
    AXSearchField: "searchfield",
    AXImage: "image",
    AXLink: "link",
    AXCell: "cell",
    AXCheckBox: "switch",
    AXSwitch: "switch",
    AXSlider: "slider",
    AXPopUpButton: "popup",
    AXMenuButton: "menu",
    AXTabGroup: "tabs",
    AXRadioButton: "tab",
    AXHeading: "heading",
    AXGroup: "group",
    AXScrollArea: "scroll",
    AXTable: "list",
    AXList: "list",
    AXOutline: "list",
    AXToolbar: "toolbar",
    AXProgressIndicator: "progress",
    AXIncrementor: "stepper",
    AXKeyboard: "keyboard",
    AXKey: "key",
};

/** Roles that do nothing when tapped and say nothing: their children are shown in their place. */
const STRUCTURAL = new Set(["group", "scroll", "list", "toolbar", "AXUnknown", "unknown"]);

function roleOf(n: AxNode): string {
    const r = n.role ?? "";
    if (r === "AXButton" && /tab/i.test(n.subrole ?? "")) return "tab";
    return ROLES[r] ?? (r.replace(/^AX/, "").toLowerCase() || "element");
}

const clean = (s: string | undefined) => (s ?? "").replace(/\s+/g, " ").trim();

function quoted(s: string, n = 120): string {
    return JSON.stringify(s.length > n ? `${s.slice(0, n)}…` : s);
}

/**
 * The tree as an outline. `screen` is the screen's size in points: an element wholly outside it is left out, as
 * nobody could tap it, and one partly outside says so. Refs number the elements from e1, in the order shown.
 */
export function outline(root: AxNode, screen: { width: number; height: number }, seen: SeenLine[] = []): Outline {
    const refs = new Map<string, RefTarget>();
    const lines: string[] = [];
    const texts: string[] = [];
    /** The text of each element on the screen, where it is: what the picture's lines are checked against. */
    const shown: { frame: [number, number, number, number]; words: Set<string> }[] = [];
    let size = 0;
    let cut = false;
    let seq = 0;
    const add = (line: string): boolean => {
        if (size + line.length + 1 > MAX_OUTLINE) {
            cut = true;
            return false;
        }
        lines.push(line);
        size += line.length + 1;
        return true;
    };

    const visit = (n: AxNode, depth: number) => {
        if (cut) return;
        const f = n.frame && n.frame.length === 4 ? (n.frame.map((v) => Math.round(v * 10) / 10) as [number, number, number, number]) : undefined;
        const outside = f && (f[2] <= 0 || f[3] <= 0 || f[0] >= screen.width || f[1] >= screen.height || f[0] + f[2] <= 0 || f[1] + f[3] <= 0);
        const role = roleOf(n);
        const label = clean(n.label) || clean(n.title);
        const value = clean(n.value);
        const id = clean(n.identifier);
        const kids = n.children ?? [];
        // An element nobody sees takes its children with it, unless it's a container whose own frame says nothing.
        if (outside && !STRUCTURAL.has(role) && role !== "app") return;
        if (f && !outside && (label || value) && role !== "app") shown.push({ frame: f, words: new Set(wordsOf(`${label} ${value}`)) });
        const silent = STRUCTURAL.has(role) && !label && !value;
        let next = depth;
        if (!silent && role !== "app") {
            let line = `${"  ".repeat(depth)}- ${role}`;
            if (label) line += ` ${quoted(label)}`;
            const placeholder = clean(n.placeholder);
            // An empty field's value is its placeholder.
            if (value && value !== label && value !== placeholder) line += ` value=${quoted(value, 80)}`;
            if (placeholder && placeholder !== label) line += ` placeholder=${quoted(placeholder, 80)}`;
            if (id && id !== label && !/^[0-9A-F-]{36}$/i.test(id)) line += ` id=${quoted(id, 60)}`;
            if (n.disabled) line += " (disabled)";
            if (f) {
                const partly = f[0] < 0 || f[1] < 0 || f[0] + f[2] > screen.width || f[1] + f[3] > screen.height;
                // The center of what's on screen, so a tap lands on the element.
                const x0 = Math.max(f[0], 0);
                const y0 = Math.max(f[1], 0);
                const x1 = Math.min(f[0] + f[2], screen.width);
                const y1 = Math.min(f[1] + f[3], screen.height);
                const ref = `e${++seq}`;
                refs.set(ref, { x: Math.round(((x0 + x1) / 2) * 10) / 10, y: Math.round(((y0 + y1) / 2) * 10) / 10, frame: f, name: label || value || role });
                line += ` [${ref}]`;
                if (partly) line += " (partly off screen)";
            }
            if (!add(line)) return;
            // A container off screen shows for its children; its own text isn't on the screen.
            if (!outside) texts.push(...[label, value].filter(Boolean));
            next = depth + 1;
        }
        for (const k of kids) visit(k, next);
    };
    visit(root, 0);
    for (const l of seenLines(seen, shown, screen)) {
        if (cut) break;
        const ref = `e${++seq}`;
        if (!add(`- seen ${quoted(l.text)} [${ref}]`)) break;
        const [x, y, w, h] = l.frame;
        refs.set(ref, { x: Math.round((x + w / 2) * 10) / 10, y: Math.round((y + h / 2) * 10) / 10, frame: l.frame, name: l.text });
        texts.push(l.text);
    }
    const app = clean(root.label) || clean(root.title);
    const head = app ? `Screen: ${app}` : "Screen";
    const body = lines.length ? lines.join("\n") : "(nothing on the screen can be read; take a screenshot)";
    return { text: `${head}\n${body}${cut ? `\n… (the outline stops at ${MAX_OUTLINE.toLocaleString("en-US")} characters)` : ""}`, refs, texts };
}

const wordsOf = (s: string) => s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const overlaps = (a: number[], b: number[]) => a[0]! < b[0]! + b[2]! && b[0]! < a[0]! + a[2]! && a[1]! < b[1]! + b[3]! && b[1]! < a[1]! + a[3]!;

/**
 * The picture's lines the tree doesn't have, top to bottom: read surely, on the screen, and not mostly words of the
 * elements they overlap (a button's title, read again). The status bar's clock, which no app's tree has, is left out.
 */
function seenLines(seen: SeenLine[], shown: { frame: number[]; words: Set<string> }[], screen: { width: number; height: number }): { text: string; frame: [number, number, number, number] }[] {
    const out: { text: string; frame: [number, number, number, number] }[] = [];
    for (const l of seen) {
        const text = clean(l.text);
        const f = l.frame.map((v) => Math.round(v * 10) / 10) as [number, number, number, number];
        if (!text || f.length !== 4 || l.confidence < SEEN_CONFIDENCE) continue;
        if (f[0] >= screen.width || f[1] >= screen.height || f[0] + f[2] <= 0 || f[1] + f[3] <= 0) continue;
        if (f[1] + f[3] < 60 && /^\d{1,2}[:.]\d{2}(\s?[AP]M)?$/i.test(text)) continue;
        const words = wordsOf(text);
        if (!words.length) continue;
        const near = shown.filter((e) => overlaps(e.frame, f));
        const known = words.filter((w) => near.some((e) => e.words.has(w))).length;
        if (known / words.length >= SEEN_KNOWN) continue;
        out.push({ text, frame: f });
    }
    // Reading order: in rows (a line whose top is within half a line of the row's first joins it), left to right.
    out.sort((a, b) => a.frame[1] - b.frame[1]);
    const rows: (typeof out)[] = [];
    for (const l of out) {
        const row = rows[rows.length - 1];
        if (row && l.frame[1] - row[0]!.frame[1] < row[0]!.frame[3] / 2) row.push(l);
        else rows.push([l]);
    }
    return rows.flatMap((row) => row.sort((a, b) => a.frame[0] - b.frame[0]));
}
