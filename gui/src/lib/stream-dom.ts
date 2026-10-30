// A rendered markdown block on screen, kept in step with its HTML while the
// reply streams. Setting innerHTML on every update would rebuild the block
// still being written many times a second: a selection in it is lost, images
// and links are recreated, and there's no telling what's new. Instead the
// block's DOM is brought in line with the new HTML, keeping every node that
// didn't change; text added at the end of a run and elements added at the
// end of a list of children are marked `md-fresh`.
//
// What has just come out is drawn lighter for a moment, an ink trail: each
// mark gets a tier by its age (md-t1 to md-t3, a static opacity in
// markdown.css), worked out again only when more text comes out (which draws
// the block again anyway) and once more after the last of it. Nothing
// animates, so nothing is drawn between the reply's own updates. Past the last
// tier a mark is taken out, its text joined to the text beside it; what's left
// when the reply is finished is taken out too.

const FRESH = "md-fresh";
/** The trail's tiers by a mark's age (ms): younger than the first, tier 1, and so on; older than the last, plain. */
export const TRAIL_MS = [35, 70, 120] as const;
const TIERS = ["md-t1", "md-t2", "md-t3"] as const;
/** Once more this long after the last text came out, so a stream that stalls doesn't leave words light. */
const SETTLE_MS = 130;
/** Inline elements a caret goes after rather than inside. */
const INLINE = new Set(["A", "B", "CODE", "DEL", "EM", "I", "S", "SPAN", "STRONG"]);
/** Attributes set after rendering (lib/markdown.ts leaves images without a src). */
const KEPT = new Set(["src", "tabindex", "data-loading"]);

const painted = new WeakMap<Element, string>();
const carets = new WeakMap<Element, HTMLElement>();

/** The trail's tier (0 to 2) for a mark this many ms old, or -1 once it's past the trail. */
export function trailTier(age: number): number {
    return TRAIL_MS.findIndex((t) => age < t);
}

/** The marks still in the trail, and when each came out. */
let trail: { el: HTMLElement; at: number }[] = [];
/** When the text being painted came out. */
let paintedAt = 0;
let settling: ReturnType<typeof setTimeout> | undefined;

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
    clearTimeout(settling);
    settling = trail.length ? setTimeout(() => retier(performance.now()), SETTLE_MS) : undefined;
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
 * otherwise it's plain innerHTML. `caret`: the writing mark goes after the
 * block's last text.
 */
export function paint(el: HTMLElement, html: string, live: boolean, caret: boolean) {
    paintedAt = performance.now();
    carets.get(el)?.remove();
    carets.delete(el);
    const before = painted.get(el);
    if (before !== html) {
        if (live && before !== undefined) morph(el, html);
        else {
            el.innerHTML = html;
            if (live) mark(el);
        }
        painted.set(el, html);
    }
    if (live) retier(paintedAt);
    else settleFresh(el);
    if (caret) placeCaret(el);
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

/** The last text with something in it, depth first from the end. */
function lastText(node: Node): Text | undefined {
    for (let c = node.lastChild; c; c = c.previousSibling) {
        if (c.nodeType === Node.TEXT_NODE) {
            if ((c as Text).data.trim()) return c as Text;
        } else if (c.nodeType === Node.ELEMENT_NODE) {
            const found = lastText(c);
            if (found) return found;
        }
    }
    return undefined;
}

function placeCaret(el: HTMLElement) {
    const text = lastText(el);
    if (!text) return;
    let at: Node = text;
    while (at.parentElement && at.parentElement !== el && INLINE.has(at.parentElement.nodeName)) at = at.parentElement;
    const caret = document.createElement("span");
    caret.className = "md-caret";
    caret.setAttribute("aria-hidden", "true");
    at.parentNode!.insertBefore(caret, at.nextSibling);
    carets.set(el, caret);
}
