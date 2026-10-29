// The simulator's screen as text: its accessibility tree (read by the helper) as an indented outline, with a ref
// like [e12] on each element the agent can tap, which stands for the element's center. Text read from the picture
// that the tree doesn't have (a web page's: its elements live in another process the tree doesn't reach) follows,
// as `seen` lines with refs of their own. The picture also says whether the tree is the screen's: one read as the
// screen changes, or before it has (the front app changes a second or more after the picture does), has text the
// picture hasn't got.

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
    selected?: boolean;
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
    /** The labels and values of the elements shown: the text on the screen (the picture's, also joined up, for a phrase that wraps). */
    texts: string[];
    /** Of the tree's elements whose label is text to see (a row's, a heading's), how many the picture shows where they are. */
    agreement: { checked: number; matched: number };
}

/** The outline stops at about this many characters (as the browser's does), and says so. */
export const MAX_OUTLINE = 24_000;

/** Lines read less surely than this are mostly misreadings. */
const SEEN_CONFIDENCE = 0.5;
/** A line is the tree's own when this share of its words are in the elements it overlaps. */
const SEEN_KNOWN = 0.6;
/** The tree isn't the screen's when it has at least this many elements to check and the picture shows under this share of them. */
const AGREE_MIN = 4;
const AGREE_SHARE = 0.4;

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
/** Fields, whose value is what was typed: shown whole, so it can be checked. */
const EDITABLE = new Set(["textfield", "securefield", "textarea", "searchfield"]);
/** Roles whose label is usually the text they show (a button's may be an icon's name: only a wide one counts). */
const CHECKED = new Set(["text", "heading", "link", "cell", "switch", "button", "tab"]);

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
    /** Elements showing their label as text, which the picture should have too. */
    const checks: { frame: number[]; words: string[] }[] = [];
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
        const placeholder = clean(n.placeholder);
        if (f && !outside && (label || value || placeholder) && role !== "app") shown.push({ frame: f, words: new Set(wordsOf(`${label} ${value} ${placeholder}`)) });
        if (f && !outside && label && CHECKED.has(role) && f[0] >= 0 && f[1] >= 0 && f[0] + f[2] <= screen.width && f[1] + f[3] <= screen.height && f[2] >= 40 && f[2] >= f[3] * 2.5) {
            const words = wordsOf(label).filter((w) => w.length > 1);
            if (words.some((w) => w.length > 2)) checks.push({ frame: f, words });
        }
        const silent = STRUCTURAL.has(role) && !label && !value;
        let next = depth;
        if (!silent && role !== "app") {
            let line = `${"  ".repeat(depth)}- ${role}`;
            if (label) line += ` ${quoted(label)}`;
            // An empty field's value is its placeholder.
            if (value && value !== label && value !== placeholder) line += ` value=${quoted(value, EDITABLE.has(role) ? 2000 : 80)}`;
            if (placeholder && placeholder !== label) line += ` placeholder=${quoted(placeholder, 80)}`;
            if (id && id !== label && !/^[0-9A-F-]{36}$/i.test(id)) line += ` id=${quoted(id, 60)}`;
            if (n.disabled) line += " (disabled)";
            if (n.selected) line += " (selected)";
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
            // A container off screen shows for its children; its own text isn't on the screen. An empty field shows its placeholder.
            if (!outside) texts.push(...[label, value || placeholder].filter(Boolean));
            next = depth + 1;
        }
        for (const k of kids) visit(k, next);
    };
    visit(root, 0);
    const picture = seenLines(seen, shown, screen);
    for (const l of picture) {
        if (cut) break;
        const ref = `e${++seq}`;
        if (!add(`- seen ${quoted(l.text)} [${ref}]`)) break;
        const [x, y, w, h] = l.frame;
        refs.set(ref, { x: Math.round((x + w / 2) * 10) / 10, y: Math.round((y + h / 2) * 10) / 10, frame: l.frame, name: l.text });
        texts.push(l.text);
    }
    // A phrase that wraps is on two lines.
    if (picture.length > 1) texts.push(picture.map((l) => l.text).join(" "));
    const read = seen.map((l) => ({ frame: l.frame, words: new Set(wordsOf(l.text)) }));
    const matched = checks.filter((c) => {
        const near = read.filter((l) => l.frame.length === 4 && overlaps(l.frame, [c.frame[0]! - 6, c.frame[1]! - 6, c.frame[2]! + 12, c.frame[3]! + 12]));
        return c.words.filter((w) => near.some((l) => l.words.has(w))).length >= c.words.length / 2;
    }).length;
    const app = clean(root.label) || clean(root.title);
    const head = app ? `Screen: ${app}` : "Screen";
    const body = lines.length ? lines.join("\n") : "(nothing on the screen can be read; take a screenshot)";
    return { text: `${head}\n${body}${cut ? `\n… (the outline stops at ${MAX_OUTLINE.toLocaleString("en-US")} characters)` : ""}`, refs, texts, agreement: { checked: checks.length, matched } };
}

/** Whether the picture shows what the tree says (undefined: too little to tell, an app whose text is icons or a web page). */
export function agrees(o: Outline): boolean | undefined {
    const { checked, matched } = o.agreement;
    if (checked < AGREE_MIN) return undefined;
    return matched / checked >= AGREE_SHARE;
}

/** Words, without case or accents (Vision reads "café" as "cafe" at times). */
const wordsOf = (s: string) =>
    s
        .normalize("NFD")
        .replace(/\p{M}/gu, "")
        .toLowerCase()
        .match(/[\p{L}\p{N}]+/gu) ?? [];

const overlaps = (a: number[], b: number[]) => a[0]! < b[0]! + b[2]! && b[0]! < a[0]! + a[2]! && a[1]! < b[1]! + b[3]! && b[1]! < a[1]! + a[3]!;

/**
 * The picture's lines the tree doesn't have, top to bottom: read surely, on the screen, and not mostly words of the
 * elements they overlap (a button's title, read again, with an icon beside it read as a letter). The status bar (the
 * clock, the battery, a link back to the app before), which no app's tree has, is left out, and so are icons read as
 * a letter or two.
 */
function seenLines(seen: SeenLine[], shown: { frame: number[]; words: Set<string> }[], screen: { width: number; height: number }): { text: string; frame: [number, number, number, number] }[] {
    const out: { text: string; frame: [number, number, number, number] }[] = [];
    for (const l of seen) {
        const text = clean(l.text);
        const f = l.frame.map((v) => Math.round(v * 10) / 10) as [number, number, number, number];
        if (!text || f.length !== 4 || l.confidence < SEEN_CONFIDENCE) continue;
        if (f[0] >= screen.width || f[1] >= screen.height || f[0] + f[2] <= 0 || f[1] + f[3] <= 0) continue;
        if (f[1] + f[3] / 2 < statusBar(screen)) continue;
        if ((text.match(/[\p{L}\p{N}]/gu) ?? []).length < 2) continue;
        // An icon beside the text reads as a letter: only longer words count, unless there are none.
        const all = wordsOf(text);
        const words = all.some((w) => w.length > 1) ? all.filter((w) => w.length > 1) : all;
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

/** How far down the status bar reaches, in points: a tall iPhone's is beside its camera; an iPad's or a short iPhone's is a thin strip. */
const statusBar = (screen: { width: number; height: number }) => (screen.height / screen.width > 2 ? 60 : 24);
