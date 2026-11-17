// lucide-solid's icons, drawn from a template (vite.config.ts points their `../Icon` here). Lucide's own Icon builds each
// icon anew: splitProps, two memos, a spread onto the <svg>, a <For> and a <Dynamic> for each of its shapes. A long
// reply's code blocks and a session's rows draw hundreds of them: 13.6-13.9 ms of a switch to one, 1.0-1.4 ms drawn
// from a template (measured, headless Chrome). An icon's <svg> is built once for each look and cloned after; what it
// draws is lucide's: the same attributes and classes, hidden from assistive tech unless it's given a label.

import { createRenderEffect } from "solid-js";
import { spread } from "solid-js/web";

type Shape = [string, Record<string, string>];
type Data = { name: string; node: Shape[]; size?: number; aliases?: string[] };
type Props = Record<string, unknown> & { icon?: Data };
/** What the template is made of; any other prop is put on the clone (spread). */
const LOOK = ["size", "width", "height", "strokeWidth", "absoluteStrokeWidth", "nonScalingStroke", "color", "class"];
const SVG = "http://www.w3.org/2000/svg";
const made = new Map<string, SVGSVGElement>();

/** Lucide's attributes for this look (its buildLucideIconNode, without a global LucideContext: Cavvy sets none). */
function attrs(data: Data, p: Props, labelled: boolean): Record<string, string> {
    const box = data.size ?? 24;
    const width = p.width ?? p.size ?? 24, height = p.height ?? p.size ?? 24;
    const stroke = Number(p.strokeWidth ?? 2);
    const classes = ["lucide", `lucide-${data.name}`, ...(data.aliases ?? []).map((a) => `lucide-${a}`), "lucide-icon", ...String(p.class ?? "").split(" ")];
    return {
        xmlns: SVG,
        width: String(width),
        height: String(height),
        viewBox: `0 0 ${box} ${box}`,
        fill: "none",
        stroke: p.color ? String(p.color) : "currentColor",
        "stroke-width": String(p.absoluteStrokeWidth ? (stroke * box) / Number(width) : stroke),
        "stroke-linecap": "round",
        "stroke-linejoin": "round",
        class: [...new Set(classes.filter(Boolean))].join(" "),
        ...(labelled ? {} : { "aria-hidden": "true" }),
    };
}

function build(data: Data, p: Props, labelled: boolean): SVGSVGElement {
    const svg = document.createElementNS(SVG, "svg");
    for (const [k, v] of Object.entries(attrs(data, p, labelled))) svg.setAttribute(k, v);
    for (const [name, a] of data.node) {
        const el = document.createElementNS(SVG, name);
        if (p.nonScalingStroke) el.setAttribute("vector-effect", "non-scaling-stroke");
        for (const [k, v] of Object.entries(a)) if (k !== "key") el.setAttribute(k, v);
        svg.appendChild(el);
    }
    return svg;
}

export default function Icon(props: Props) {
    const data = props.icon ?? { name: "", node: (props.iconNode as Shape[] | undefined) ?? [] };
    const rest: Record<string, unknown> = {};
    let reactive = false, labelled = false, others = false, key = data.name;
    for (const k of Object.getOwnPropertyNames(props)) {
        if (k === "icon" || k === "iconNode") continue;
        const d = Object.getOwnPropertyDescriptor(props, k)!;
        if (k === "children" || k === "title" || k === "role" || k.startsWith("aria-")) labelled = true;
        if (LOOK.includes(k)) {
            if (d.get) reactive = true;
            else key += `|${k}=${String(d.value)}`;
        } else if (k !== "children") {
            Object.defineProperty(rest, k, d);
            others = true;
        }
    }
    key += `|${labelled}`;
    let svg: SVGSVGElement;
    if (reactive) {
        svg = build(data, props, labelled);
        createRenderEffect(() => {
            for (const [k, v] of Object.entries(attrs(data, props, labelled))) svg.setAttribute(k, v);
        });
    } else {
        let t = made.get(key);
        if (!t) made.set(key, (t = build(data, props, labelled)));
        svg = t.cloneNode(true) as SVGSVGElement;
    }
    if (others) spread(svg, rest, true, true);
    return svg;
}
