// A rendered markdown block on screen, kept in step with its HTML while the
// reply streams. Setting innerHTML on every update would rebuild the block
// still being written many times a second: a selection in it is lost, images
// and links are recreated, and there's no telling what's new. Instead the
// block's DOM is brought in line with the new HTML, keeping every node that
// didn't change; text added at the end of a run and elements added at the
// end of a list of children are marked `md-fresh`, which fades them in.
// Each mark is taken out once its fade has run (a long reply would otherwise
// pile up thousands of wrappers, every one restyled on every frame), and any
// left when the reply is finished.

const FRESH = "md-fresh";
/** Inline elements a caret goes after rather than inside. */
const INLINE = new Set(["A", "B", "CODE", "DEL", "EM", "I", "S", "SPAN", "STRONG"]);
/** Attributes set after rendering (lib/markdown.ts leaves images without a src). */
const KEPT = new Set(["src", "tabindex", "data-loading"]);

const painted = new WeakMap<Element, string>();
const carets = new WeakMap<Element, HTMLElement>();

/**
 * Shows `html` in `el`. While `live`, an update changes only what's different
 * and fades in what's new (a block first painted while live fades in whole);
 * otherwise it's plain innerHTML. `caret`: the writing mark goes after the
 * block's last text.
 */
export function paint(el: HTMLElement, html: string, live: boolean, caret: boolean) {
    if (live && !fading.has(el)) {
        fading.add(el);
        el.addEventListener("animationend", faded);
    }
    carets.get(el)?.remove();
    carets.delete(el);
    const before = painted.get(el);
    if (before !== html) {
        if (live && before !== undefined) morph(el, html);
        else {
            el.innerHTML = html;
            if (live) el.classList.add(FRESH);
        }
        painted.set(el, html);
    }
    if (!live) settleFresh(el);
    if (caret) placeCaret(el);
}

/** Blocks listening for their marks' fades to end. */
const fading = new WeakSet<Element>();

/** One mark taken out: wrapped text goes back to plain text. */
function unmark(m: HTMLElement) {
    if (m.dataset.fresh !== undefined) m.replaceWith(...m.childNodes);
    else {
        m.classList.remove(FRESH);
        if (!m.classList.length) m.removeAttribute("class");
    }
}

/** A mark whose fade has run is taken out, its text joined to the text beside it. */
function faded(e: AnimationEvent) {
    const m = e.target as HTMLElement;
    if (e.animationName !== "md-fresh" || !m.classList.contains(FRESH)) return;
    const parent = m.parentNode;
    unmark(m);
    parent?.normalize();
}

/** Takes out the fade-in marks: wrapped text goes back to plain text. */
export function settleFresh(el: HTMLElement) {
    el.classList.remove(FRESH);
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
    span.className = FRESH;
    span.dataset.fresh = "";
    span.textContent = text;
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
                if (n.nodeType === Node.ELEMENT_NODE) (n as Element).classList.add(FRESH);
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

function attributes(el: Element, want: Element) {
    for (const a of [...el.attributes]) {
        if (want.hasAttribute(a.name) || KEPT.has(a.name)) continue;
        if (a.name === "class" && el.classList.contains(FRESH)) el.setAttribute("class", FRESH);
        else el.removeAttribute(a.name);
    }
    for (const a of want.attributes) {
        const value = a.name === "class" && el.classList.contains(FRESH) ? `${a.value} ${FRESH}` : a.value;
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
