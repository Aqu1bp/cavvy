// A rendered markdown block on screen, kept in step with its HTML while the
// reply streams. Setting innerHTML on every update would rebuild the block
// still being written many times a second: a selection in it is lost, images
// and links are recreated, and there's no telling what's new. Instead the
// block's DOM is brought in line with the new HTML, keeping every node that
// didn't change; text added at the end of a run and elements added at the
// end of a list of children are marked `md-fresh`.
//
// What has just come out is drawn lighter for a moment, an ink trail: each
// mark gets a tier by its age (md-t1 to md-t7, a static opacity in
// markdown.css), worked out again on each step of the stream clock while any
// mark is in the trail (lib/stream-clock.ts: the step text comes out on, so
// nothing is drawn between them). Without new text, the words still go on
// darkening a step at a time rather than standing light and then turning
// plain at once. Past the last tier a mark is taken out, its text joined to
// the text beside it; what's still in the trail when the reply is finished
// darkens the rest of the way.

import { onStep } from "./stream-clock";

const FRESH = "md-fresh";
/** A block first painted while the reply streams, for good: its lines wrap as they came (markdown.css). */
const WRITTEN = "md-written";
/** The trail's tiers by a mark's age (ms), between the clock's steps: younger than the first, tier 1, and so on; older than the last, plain. */
export const TRAIL_MS = [25, 75, 125, 175, 225, 275, 325] as const;
const TIERS = ["md-t1", "md-t2", "md-t3", "md-t4", "md-t5", "md-t6", "md-t7"] as const;
/** Attributes set after rendering (lib/markdown.ts leaves images without a src). */
const KEPT = new Set(["src", "tabindex", "data-loading"]);

const painted = new WeakMap<Element, string>();

/** The trail's tier (0 to 6) for a mark this many ms old, or -1 once it's past the trail. */
export function trailTier(age: number): number {
    return TRAIL_MS.findIndex((t) => age < t);
}

/** The marks still in the trail, and when each came out. */
let trail: { el: HTMLElement; at: number }[] = [];
/** When the text being painted came out. */
let paintedAt = 0;
/** The trail is worked out again at the clock's next step. */
let aging = false;
const age = () => {
    aging = false;
    retier(performance.now());
};

/** What's just come out: in the trail from now. */
function mark(el: HTMLElement) {
    el.classList.add(FRESH);
    trail.push({ el, at: paintedAt });
}

/** Each mark's tier for its age now; a mark past the trail is taken out (one gone from the page with it). */
function retier(now: number) {
    trail = trail.filter(({ el, at }) => {
        const tier = trailTier(now - at);
        if (tier >= 0) {
            TIERS.forEach((c, i) => el.classList.toggle(c, i === tier));
            return true;
        }
        // Only a text wrapper's text needs joining. A block's parent can hold Solid's own text nodes (a code block's
        // tail, empty for now), which normalize() would take out from under it.
        const parent = el.dataset.fresh !== undefined ? el.parentNode : null;
        unmark(el);
        parent?.normalize();
        return false;
    });
    if (trail.length && !aging) {
        aging = true;
        onStep(age);
    }
}

/** Shows HTML in `el` that mostly grows: what only grew is added to the end, so what's there stays as it is, laid out. */
export function growing(el: HTMLElement) {
    let shown = "";
    return (html: string) => {
        if (shown && html.startsWith(shown)) el.insertAdjacentHTML("beforeend", html.slice(shown.length));
        else el.innerHTML = html;
        shown = html;
    };
}

/**
 * A block that came out while the reply streams (a code block of its own, say) goes into the trail as a whole. Its
 * marks are taken out like any other.
 */
export function trailBlock(el: HTMLElement) {
    paintedAt = performance.now();
    mark(el);
    retier(paintedAt);
}

/**
 * Shows `html` in `el`. While `live`, an update changes only what's different
 * and marks what's new (a block first painted while live is marked whole);
 * otherwise it's plain innerHTML.
 */
export function paint(el: HTMLElement, html: string, live: boolean) {
    paintedAt = performance.now();
    const before = painted.get(el);
    if (before !== html) {
        if (live && before !== undefined) morph(el, html);
        else {
            el.innerHTML = html;
            if (live) {
                el.classList.add(WRITTEN);
                mark(el);
            }
        }
        painted.set(el, html);
    }
    // Finished as it was last drawn: its last words darken the rest of the way, as they would have.
    if (live || before === html) retier(paintedAt);
    else settleFresh(el);
}

/** One mark taken out: wrapped text goes back to plain text. */
function unmark(m: HTMLElement) {
    if (m.dataset.fresh !== undefined) m.replaceWith(...m.childNodes);
    else {
        m.classList.remove(FRESH, ...TIERS);
        if (!m.classList.length) m.removeAttribute("class");
    }
}

/** Takes out the marks: wrapped text goes back to plain text. */
export function settleFresh(el: HTMLElement) {
    if (trail.length) trail = trail.filter((t) => !el.contains(t.el));
    if (el.classList.contains(FRESH)) unmark(el);
    const marked = el.querySelectorAll<HTMLElement>(`.${FRESH}`);
    if (!marked.length) return;
    for (const m of marked) unmark(m);
    el.normalize();
}

function morph(el: HTMLElement, html: string) {
    const next = document.createElement("template");
    next.innerHTML = html;
    sync(el, next.content);
}

/** A node as compared: a run of text (plain text nodes and fresh text wrappers) or anything else. */
type Unit = { nodes: Node[]; text?: string };

function units(parent: Node): Unit[] {
    const out: Unit[] = [];
    for (let n = parent.firstChild; n; n = n.nextSibling) {
        const text = n.nodeType === Node.TEXT_NODE ? (n as Text).data : isFreshText(n) ? n.textContent ?? "" : undefined;
        const prev = out.at(-1);
        if (text !== undefined && prev?.text !== undefined) {
            prev.nodes.push(n);
            prev.text += text;
        } else out.push({ nodes: [n], text });
    }
    return out;
}

function isFreshText(n: Node): n is HTMLElement {
    return n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).dataset.fresh !== undefined;
}

function freshText(text: string): Node {
    if (!text.trim()) return document.createTextNode(text);
    const span = document.createElement("span");
    span.dataset.fresh = "";
    span.textContent = text;
    mark(span);
    return span;
}

function replace(parent: Node, unit: Unit, node: Node) {
    parent.insertBefore(node, unit.nodes[0]!);
    for (const n of unit.nodes) parent.removeChild(n);
}

function sync(old: Node, next: Node) {
    const have = units(old);
    const want = [...next.childNodes];
    want.forEach((n, i) => {
        const u = have[i];
        if (!u) {
            // Added at the end: new.
            if (n.nodeType === Node.TEXT_NODE) old.appendChild(freshText((n as Text).data));
            else {
                if (n.nodeType === Node.ELEMENT_NODE) mark(n as HTMLElement);
                old.appendChild(n);
            }
            return;
        }
        if (n.nodeType === Node.TEXT_NODE) {
            const data = (n as Text).data;
            if (u.text === data) return;
            // The run grew: only the new end fades in.
            if (u.text !== undefined && data.startsWith(u.text)) old.insertBefore(freshText(data.slice(u.text.length)), u.nodes.at(-1)!.nextSibling);
            else replace(old, u, document.createTextNode(data));
            return;
        }
        const was = u.nodes[0]!;
        if (u.text === undefined && n.nodeType === Node.ELEMENT_NODE && was.nodeName === n.nodeName && !(n.nodeName === "IMG" && (was as Element).getAttribute("data-image-file") !== (n as Element).getAttribute("data-image-file"))) {
            attributes(was as Element, n as Element);
            sync(was, n);
            return;
        }
        if (u.text === undefined && n.nodeType === was.nodeType && n.nodeType !== Node.ELEMENT_NODE) {
            if (was.nodeValue !== n.nodeValue) was.nodeValue = n.nodeValue;
            return;
        }
        replace(old, u, n);
    });
    for (const u of have.slice(want.length)) for (const n of u.nodes) old.removeChild(n);
}

/** An element's attributes as the new HTML has them, its marks (fresh, and its tier) kept. */
function attributes(el: Element, want: Element) {
    const marks = [FRESH, ...TIERS].filter((c) => el.classList.contains(c)).join(" ");
    for (const a of [...el.attributes]) {
        if (want.hasAttribute(a.name) || KEPT.has(a.name)) continue;
        if (a.name === "class" && marks) el.setAttribute("class", marks);
        else el.removeAttribute(a.name);
    }
    for (const a of want.attributes) {
        const value = a.name === "class" && marks ? `${a.value} ${marks}` : a.value;
        if (el.getAttribute(a.name) !== value) el.setAttribute(a.name, value);
    }
}
