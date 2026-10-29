// The simulator's screen as text: its accessibility tree (read by the helper) as an indented outline, with a ref
// like [e12] on each element the agent can tap, which stands for the element's center.

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
export function outline(root: AxNode, screen: { width: number; height: number }): Outline {
    const refs = new Map<string, RefTarget>();
    const lines: string[] = [];
    const texts: string[] = [];
    let size = 0;
    let cut = false;
    let seq = 0;

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
            if (size + line.length + 1 > MAX_OUTLINE) {
                cut = true;
                return;
            }
            lines.push(line);
            size += line.length + 1;
            // A container off screen shows for its children; its own text isn't on the screen.
            if (!outside) texts.push(...[label, value].filter(Boolean));
            next = depth + 1;
        }
        for (const k of kids) visit(k, next);
    };
    visit(root, 0);
    const app = clean(root.label) || clean(root.title);
    const head = app ? `Screen: ${app}` : "Screen";
    const body = lines.length ? lines.join("\n") : "(nothing on the screen can be read; take a screenshot)";
    return { text: `${head}\n${body}${cut ? `\n… (the outline stops at ${MAX_OUTLINE.toLocaleString("en-US")} characters)` : ""}`, refs, texts };
}
