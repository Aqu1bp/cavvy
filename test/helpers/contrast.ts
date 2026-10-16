// Resolves gui/src/styles/tokens.css the way a browser would for one theme on
// <html>, and measures WCAG 2 contrast between the resolved colors. Only the
// subset of CSS the token file uses is understood (hex, rgb[a](), var() and
// color-mix() in srgb); anything else throws, so a new syntax in tokens.css
// fails the contrast test loudly instead of being measured wrong.

export interface Rgba {
    r: number;
    g: number;
    b: number;
    a: number;
}

interface Rule {
    selectors: string[];
    decls: Map<string, string>;
}

/** What the <html> element carries: prefs.ts sets these attributes. */
export interface Root {
    theme: string;
    scheme: "light" | "dark";
    accent?: string;
}

export function parseRules(css: string): Rule[] {
    const rules: Rule[] = [];
    const body = css.replace(/\/\*[\s\S]*?\*\//g, "");
    for (const m of body.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
        const decls = new Map<string, string>();
        for (const d of m[2]!.split(";")) {
            const i = d.indexOf(":");
            if (i > 0) decls.set(d.slice(0, i).trim(), d.slice(i + 1).trim());
        }
        rules.push({ selectors: m[1]!.split(",").map((s) => s.trim()), decls });
    }
    return rules;
}

/** Specificity (as one comparable number) of `sel` when it matches `root`, else null. */
function match(sel: string, root: Root): number | null {
    if (sel === ":where(:root)") return 0;
    if (sel === ":root") return 1;
    const attrs = [...sel.matchAll(/\[data-([a-z]+)(?:="([^"]*)")?\]/g)];
    if (attrs.length === 0 || attrs.map((a) => a[0]).join("") !== sel) return null;
    const values: Record<string, string | undefined> = { theme: root.theme, scheme: root.scheme, accent: root.accent };
    for (const [, name, value] of attrs) {
        const have = values[name!];
        if (have === undefined || (value !== undefined && value !== have)) return null;
    }
    return attrs.length;
}

/** Custom properties on <html> after the cascade: higher specificity wins, then the later rule. */
export function cascade(rules: Rule[], root: Root): Map<string, string> {
    const hits: { spec: number; order: number; decls: Map<string, string> }[] = [];
    rules.forEach((rule, order) => {
        const specs = rule.selectors.map((s) => match(s, root)).filter((s): s is number => s !== null);
        if (specs.length) hits.push({ spec: Math.max(...specs), order, decls: rule.decls });
    });
    hits.sort((a, b) => a.spec - b.spec || a.order - b.order);
    const vars = new Map<string, string>();
    for (const h of hits) for (const [k, v] of h.decls) if (k.startsWith("--")) vars.set(k, v);
    return vars;
}

/** Splits on top-level commas (not the ones inside nested parentheses). */
function args(s: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "(") depth++;
        else if (s[i] === ")") depth--;
        else if (s[i] === "," && depth === 0) {
            out.push(s.slice(start, i).trim());
            start = i + 1;
        }
    }
    out.push(s.slice(start).trim());
    return out;
}

export function resolveColor(value: string, vars: Map<string, string>, seen: string[] = []): Rgba {
    const v = value.trim();
    const call = /^([a-z-]+)\(([\s\S]*)\)$/.exec(v);
    if (v === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
    if (v === "white") return { r: 255, g: 255, b: 255, a: 1 };
    if (v === "black") return { r: 0, g: 0, b: 0, a: 1 };
    if (v.startsWith("#")) {
        let hex = v.slice(1);
        if (hex.length === 3 || hex.length === 4) hex = [...hex].map((c) => c + c).join("");
        if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/i.test(hex)) throw new Error(`bad hex ${v}`);
        const n = (i: number) => parseInt(hex.slice(i, i + 2), 16);
        return { r: n(0), g: n(2), b: n(4), a: hex.length === 8 ? n(6) / 255 : 1 };
    }
    if (call?.[1] === "var") {
        const [name, fallback] = args(call[2]!);
        if (seen.includes(name!)) throw new Error(`var cycle ${[...seen, name].join(" -> ")}`);
        const def = vars.get(name!) ?? fallback;
        if (def === undefined) throw new Error(`undefined ${name}`);
        return resolveColor(def, vars, [...seen, name!]);
    }
    if (call?.[1] === "rgb" || call?.[1] === "rgba") {
        const parts = args(call[2]!).map(Number);
        if (parts.length < 3 || parts.length > 4 || !parts.every(Number.isFinite)) throw new Error(`unsupported ${v}`);
        const [r, g, b, a] = parts;
        return { r: r!, g: g!, b: b!, a: a ?? 1 };
    }
    if (call?.[1] === "color-mix") {
        // CSS Color 5: interpolate premultiplied colors; percentages summing under
        // 100% scale the result's alpha.
        const [space, ...parts] = args(call[2]!);
        if (space !== "in srgb" || parts.length !== 2) throw new Error(`unsupported ${v}`);
        const items = parts.map((p) => {
            const m = /^(.*?)\s+([\d.]+)%$/.exec(p);
            return { color: resolveColor(m ? m[1]! : p, vars, seen), pct: m ? Number(m[2]) / 100 : undefined };
        });
        const [x, y] = items as [(typeof items)[0], (typeof items)[0]];
        let p1 = x.pct ?? 1 - (y.pct ?? 0.5);
        let p2 = y.pct ?? 1 - p1;
        const sum = p1 + p2;
        p1 /= sum;
        p2 /= sum;
        const a = x.color.a * p1 + y.color.a * p2;
        const ch = (k: "r" | "g" | "b") => (a === 0 ? 0 : (x.color[k] * x.color.a * p1 + y.color[k] * y.color.a * p2) / a);
        return { r: ch("r"), g: ch("g"), b: ch("b"), a: a * Math.min(sum, 1) };
    }
    throw new Error(`unsupported color ${v}`);
}

/** `top` painted over `under`. */
export function over(top: Rgba, under: Rgba): Rgba {
    const a = top.a + under.a * (1 - top.a);
    if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
    const ch = (k: "r" | "g" | "b") => (top[k] * top.a + under[k] * under.a * (1 - top.a)) / a;
    return { r: ch("r"), g: ch("g"), b: ch("b"), a };
}

/** Paints layers bottom to top; the bottom one must be opaque. */
export function stack(layers: Rgba[]): Rgba {
    const [base, ...rest] = layers;
    if (!base || base.a < 1) throw new Error("a surface stack needs an opaque bottom layer");
    return rest.reduce((under, top) => over(top, under), base);
}

function luminance(c: Rgba): number {
    const lin = (v: number) => {
        const s = v / 255;
        return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
}

/** WCAG 2 contrast ratio of (possibly translucent) text over an opaque surface. */
export function contrast(text: Rgba, surface: Rgba): number {
    const fg = over(text, surface);
    const [hi, lo] = [luminance(fg), luminance(surface)].sort((a, b) => b - a) as [number, number];
    const ratio = (hi + 0.05) / (lo + 0.05);
    if (!Number.isFinite(ratio)) throw new Error("contrast is not a number");
    return ratio;
}
