// Acting on a page the way a person does: real mouse and key events at real coordinates, so what the page's own
// handlers see is what a click or a key press would send. Elements are named by ref (a snapshot's [e12]), and
// scrolled into view and located by their box before the mouse goes to them.

import type { BrowserInput } from "../server/protocol";
import { CdpError } from "./cdp";
import { MODIFIER_BITS, fromKeyboardEvent, parseKey, type KeyPress } from "./keys";
import { BrowserError, raceAbort, type Page } from "./page";
import type { RefEntry } from "./refs";

export interface Point {
    x: number;
    y: number;
}

/** A target for a click or a scroll: an element by ref, or a spot on the page in CSS pixels. */
export interface Target {
    ref?: string;
    x?: number;
    y?: number;
}

const WAIT_MAX_MS = 60_000;
const WAIT_DEFAULT_MS = 10_000;
/** What a page gets to react to an input (start a request, a navigation) before the call waits for it to settle. */
const REACT_MS = 150;
const MAX_TEXT = 100_000;
/** How many times an element's place is looked at, waiting for it to hold still. */
const STILL_TRIES = 6;

const describe = (e: RefEntry, ref: string) => `${e.role}${e.name ? ` ${JSON.stringify(e.name)}` : ""} [${ref.trim().replace(/^\[|\]$/g, "")}]`;

/** What a failed command on an element means for the agent. */
function elementError(e: unknown, ref: string, entry: RefEntry): unknown {
    if (!(e instanceof CdpError)) return e;
    if (/Could not find node|No node with given id|Node with given id|does not belong|not found|detached/i.test(e.message)) return new BrowserError(`${describe(entry, ref)} is no longer on the page. Take a new snapshot (BrowserSnapshot).`);
    if (/box model|no layout|not visible|Could not compute/i.test(e.message)) return new BrowserError(`${describe(entry, ref)} isn't visible: it has no size on the page (hidden, collapsed or off-screen). Scroll or open what contains it, then take a new snapshot.`);
    if (/focus/i.test(e.message)) return new BrowserError(`${describe(entry, ref)} can't take focus.`);
    return e;
}

/** An element's backend node and its entry, or why the ref isn't usable. */
function entryOf(page: Page, ref: string): RefEntry {
    const found = page.refs.resolve(ref);
    if ("error" in found) throw new BrowserError(found.error);
    return found.entry;
}

/** Scrolls an element into view and says its box on the screen (CSS pixels of the viewport). */
export async function boxOf(page: Page, ref: string): Promise<{ x: number; y: number; width: number; height: number }> {
    const entry = entryOf(page, ref);
    try {
        await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId });
        const { model } = await page.send<{ model: { border: number[] } }>("DOM.getBoxModel", { backendNodeId: entry.backendNodeId });
        const xs = [0, 2, 4, 6].map((i) => model.border[i]!);
        const ys = [1, 3, 5, 7].map((i) => model.border[i]!);
        const x = Math.max(Math.min(...xs), 0);
        const y = Math.max(Math.min(...ys), 0);
        return { x, y, width: Math.max(Math.max(...xs) - x, 1), height: Math.max(Math.max(...ys) - y, 1) };
    } catch (e) {
        throw elementError(e, ref, entry);
    }
}

/** Resolves after the page has drawn two frames (or a tenth of a second: a page that draws none, one that's hidden). */
const FRAMES = "new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 100); })";

/**
 * Scrolls an element into view and says where its middle is. A page that is scrolling (a smooth scroll the wheel started)
 * or animating moves the element as it goes: the middle is taken once it is where it was a frame ago.
 */
async function locate(page: Page, ref: string): Promise<{ point: Point; entry: RefEntry }> {
    const entry = entryOf(page, ref);
    try {
        let point: Point | undefined;
        for (let tries = 0; tries < STILL_TRIES; tries++) {
            await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId });
            const { model } = await page.send<{ model: { content: number[] } }>("DOM.getBoxModel", { backendNodeId: entry.backendNodeId });
            const q = model.content;
            const now = { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
            if (point && Math.abs(point.x - now.x) < 0.5 && Math.abs(point.y - now.y) < 0.5) return { point: now, entry };
            point = now;
            await page.send("Runtime.evaluate", { expression: FRAMES, awaitPromise: true });
        }
        return { point: point!, entry };
    } catch (e) {
        throw elementError(e, ref, entry);
    }
}

function clampPoint(page: Page, p: Point): Point {
    return { x: Math.min(Math.max(p.x, 0), page.viewport.width), y: Math.min(Math.max(p.y, 0), page.viewport.height) };
}

/** Where a target is: the element's middle, or the coordinates given. */
async function where(page: Page, t: Target): Promise<{ point: Point; what: string }> {
    if (t.ref) {
        const { point, entry } = await locate(page, t.ref);
        return { point, what: describe(entry, t.ref) };
    }
    if (typeof t.x !== "number" || typeof t.y !== "number") throw new BrowserError("Say where: a ref from a snapshot, or both x and y.");
    const point = clampPoint(page, { x: t.x, y: t.y });
    return { point, what: `(${Math.round(point.x)}, ${Math.round(point.y)})` };
}

type MouseButton = "left" | "middle" | "right";
const HELD = { left: 1, right: 2, middle: 4 } as const;

/** `agent`: the agent's input, which stops the moment the person takes the tab or the call is cancelled; without it, the person's. */
function mouse(page: Page, type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel", p: Point, extra: Record<string, unknown> = {}, agent?: { signal?: AbortSignal }) {
    const params = { type, x: p.x, y: p.y, ...extra };
    return agent ? page.agentInput("Input.dispatchMouseEvent", params, agent.signal) : page.input("Input.dispatchMouseEvent", params);
}

/** After an input: gives the page a moment to react, then waits for what it started (a request, a navigation) to settle. */
async function afterInput(page: Page, signal?: AbortSignal) {
    const requests = page.network.started;
    await page.waitUntil(() => page.loading || page.network.started !== requests || page.dialog !== undefined, REACT_MS, signal);
    if (!page.dialog) await page.settle(signal);
}

export async function click(page: Page, t: Target, o: { count?: 1 | 2; button?: MouseButton } = {}, signal?: AbortSignal): Promise<string> {
    page.actable(signal);
    const { point, what } = await where(page, t);
    const button = o.button ?? "left";
    const agent = { signal };
    await mouse(page, "mouseMoved", point, {}, agent);
    for (let n = 1; n <= (o.count ?? 1); n++) {
        await mouse(page, "mousePressed", point, { button, buttons: HELD[button], clickCount: n }, agent);
        await mouse(page, "mouseReleased", point, { button, buttons: 0, clickCount: n }, agent);
    }
    await afterInput(page, signal);
    return `${o.count === 2 ? "Double-clicked" : button === "right" ? "Right-clicked" : "Clicked"} ${what}`;
}

export async function hover(page: Page, t: Target, signal?: AbortSignal): Promise<string> {
    page.actable(signal);
    const { point, what } = await where(page, t);
    await mouse(page, "mouseMoved", point, {}, { signal });
    await afterInput(page, signal);
    return `Hovered ${what}`;
}

/** Resolves once the page's scroll position has held for three frames (or after a second). */
const SCROLLED = `new Promise((resolve) => {
    let at = [scrollX, scrollY], still = 0;
    const end = performance.now() + 1000;
    const frame = () => {
        const now = [scrollX, scrollY];
        still = now[0] === at[0] && now[1] === at[1] ? still + 1 : 0;
        at = now;
        if (still >= 3 || performance.now() > end) resolve(true);
        else requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
    setTimeout(() => resolve(true), 1200);
})`;

export async function scroll(page: Page, t: Target, delta: { x?: number; y?: number }, signal?: AbortSignal): Promise<string> {
    page.actable(signal);
    const at = t.ref || typeof t.x === "number" ? await where(page, t) : { point: { x: page.viewport.width / 2, y: page.viewport.height / 2 }, what: "the page" };
    const deltaX = delta.x ?? 0;
    const deltaY = delta.y ?? (delta.x === undefined ? 600 : 0);
    await mouse(page, "mouseWheel", at.point, { deltaX, deltaY }, { signal });
    // Smooth scrolling takes a few frames to arrive, and scrolling can load more (an endless list).
    await page.send("Runtime.evaluate", { expression: SCROLLED, awaitPromise: true });
    await afterInput(page, signal);
    const moved = [deltaY && `${Math.abs(deltaY)}px ${deltaY > 0 ? "down" : "up"}`, deltaX && `${Math.abs(deltaX)}px ${deltaX > 0 ? "right" : "left"}`].filter(Boolean);
    return `Scrolled ${at.what}${moved.length ? ` ${moved.join(", ")}` : ""}`;
}

// ---------------------------------------------------------------------------
// Keys and text

function keyParams(press: KeyPress, type: "down" | "up") {
    const text = type === "down" ? press.text : undefined;
    return {
        type: type === "up" ? "keyUp" : text ? "keyDown" : "rawKeyDown",
        modifiers: press.modifiers,
        key: press.key,
        code: press.code,
        windowsVirtualKeyCode: press.windowsVirtualKeyCode,
        nativeVirtualKeyCode: press.windowsVirtualKeyCode,
        ...(text ? { text, unmodifiedText: text } : {}),
        ...(type === "down" && press.commands ? { commands: press.commands } : {}),
    };
}

async function pressKey(page: Page, press: KeyPress, signal?: AbortSignal) {
    await page.agentInput("Input.dispatchKeyEvent", keyParams(press, "down"), signal);
    await page.agentInput("Input.dispatchKeyEvent", keyParams(press, "up"), signal);
}

export async function press(page: Page, key: string, modifiers: readonly string[] = [], signal?: AbortSignal): Promise<string> {
    page.actable(signal);
    const parsed = parseKey(key, modifiers);
    if (!parsed) throw new BrowserError(`"${key}" isn't a key I know. Use a name like Enter, Tab, Escape, ArrowDown, PageDown, F5, a single character, or a combination such as Control+A; modifiers can also go in modifiers (Control, Shift, Alt, Meta).`);
    await pressKey(page, parsed, signal);
    await afterInput(page, signal);
    const held = ["Control", "Alt", "Shift", "Meta"].filter((m) => parsed.modifiers & MODIFIER_BITS[m as keyof typeof MODIFIER_BITS]);
    return `Pressed ${[...held, parsed.key === " " ? "Space" : parsed.key].join("+")}`;
}

/** The handles to page objects an action holds are made in this group, and let go of together when it's done. */
const OBJECTS = "harness-act";
const releaseObjects = (page: Page) => page.send("Runtime.releaseObjectGroup", { objectGroup: OBJECTS }).catch(() => undefined);

/** Makes the element at hand the active one: by ref (focused, or clicked when it can't be), else whatever has focus now. */
async function focused(page: Page, ref: string | undefined): Promise<{ objectId: string; what: string }> {
    if (ref) {
        const entry = entryOf(page, ref);
        try {
            await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId });
            await page.send("DOM.focus", { backendNodeId: entry.backendNodeId });
            const { object } = await page.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: entry.backendNodeId, objectGroup: OBJECTS });
            return { objectId: object.objectId, what: describe(entry, ref) };
        } catch (e) {
            throw elementError(e, ref, entry);
        }
    }
    const r = await page.send<{ result: { objectId?: string; subtype?: string } }>("Runtime.evaluate", { expression: "document.activeElement", objectGroup: OBJECTS });
    if (!r.result.objectId || r.result.subtype === "null") throw new BrowserError("Nothing is focused to type into: give the ref of a text field.");
    return { objectId: r.result.objectId, what: "the focused element" };
}

/** Empties a field the way the page sees it: its own value setter and an input event, so frameworks notice. */
const CLEAR = `function () {
    if (this.isContentEditable) {
        const range = document.createRange();
        range.selectNodeContents(this);
        const selection = getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("delete");
        return true;
    }
    if (!("value" in this)) return false;
    const set = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(this), "value")?.set;
    if (set) set.call(this, ""); else this.value = "";
    this.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
}`;

export async function type(page: Page, o: { ref?: string; text: string; clear?: boolean; submit?: boolean }, signal?: AbortSignal): Promise<string> {
    page.actable(signal);
    if (o.text.length > MAX_TEXT) throw new BrowserError(`That text is ${o.text.length} characters; type at most ${MAX_TEXT} at a time.`);
    try {
        const target = await focused(page, o.ref);
        if (o.clear) {
            page.actable(signal);
            const r = await page.send<{ result: { value?: boolean } }>("Runtime.callFunctionOn", { objectId: target.objectId, functionDeclaration: CLEAR, returnByValue: true });
            if (!r.result.value) throw new BrowserError(`${target.what} isn't something text can be cleared from.`);
        }
        if (o.text) await page.agentInput("Input.insertText", { text: o.text }, signal);
        if (o.submit) await pressKey(page, parseKey("Enter")!, signal);
        await afterInput(page, signal);
        return `${o.clear ? "Replaced the text of" : "Typed into"} ${target.what}${o.submit ? " and pressed Enter" : ""}`;
    } finally {
        await releaseObjects(page);
    }
}

/** Chooses an option of a <select> by its value or its label (exact first, then a case-insensitive match). */
const CHOOSE = `function (wanted) {
    if (this.tagName !== "SELECT") return { error: "not a select" };
    const options = [...this.options];
    const lower = String(wanted).trim().toLowerCase();
    const found = options.find((o) => o.value === wanted) ?? options.find((o) => o.label === wanted || o.textContent.trim() === wanted) ?? options.find((o) => o.label.toLowerCase() === lower || o.textContent.trim().toLowerCase() === lower);
    if (!found) return { error: "no option", options: options.map((o) => o.label || o.value).slice(0, 50) };
    if (found.disabled) return { error: "disabled", label: found.label };
    this.value = found.value;
    this.dispatchEvent(new Event("input", { bubbles: true }));
    this.dispatchEvent(new Event("change", { bubbles: true }));
    return { label: found.label || found.value };
}`;

export async function select(page: Page, ref: string, value: string, signal?: AbortSignal): Promise<string> {
    page.actable(signal);
    const entry = entryOf(page, ref);
    try {
        let objectId: string;
        try {
            await page.send("DOM.scrollIntoViewIfNeeded", { backendNodeId: entry.backendNodeId });
            objectId = (await page.send<{ object: { objectId: string } }>("DOM.resolveNode", { backendNodeId: entry.backendNodeId, objectGroup: OBJECTS })).object.objectId;
        } catch (e) {
            throw elementError(e, ref, entry);
        }
        page.actable(signal);
        const r = await page.send<{ result: { value?: { error?: string; options?: string[]; label?: string } } }>("Runtime.callFunctionOn", { objectId, functionDeclaration: CHOOSE, arguments: [{ value }], returnByValue: true });
        const out = r.result.value ?? {};
        if (out.error === "not a select") throw new BrowserError(`${describe(entry, ref)} isn't a <select>. Click it instead.`);
        if (out.error === "no option") throw new BrowserError(`${describe(entry, ref)} has no option "${value}". Its options: ${(out.options ?? []).map((o) => JSON.stringify(o)).join(", ")}.`);
        if (out.error === "disabled") throw new BrowserError(`The option "${out.label}" is disabled.`);
        await afterInput(page, signal);
        return `Selected ${JSON.stringify(out.label)} in ${describe(entry, ref)}`;
    } finally {
        await releaseObjects(page);
    }
}

/** Resolves true once what's wanted is on the page; the page itself watches for it and gives up after `ms`. */
const WAIT_FOR = `(text, selector, ms) => new Promise((resolve) => {
    const found = () => selector ? document.querySelector(selector) !== null : (document.body?.innerText ?? "").includes(text);
    if (found()) return resolve(true);
    const timer = setTimeout(() => { observer.disconnect(); resolve(false); }, ms);
    const observer = new MutationObserver(() => {
        if (!found()) return;
        clearTimeout(timer);
        observer.disconnect();
        resolve(true);
    });
    observer.observe(document, { subtree: true, childList: true, characterData: true, attributes: true });
})`;

/** Waits for text or a selector to appear; with neither, for the page to settle (a navigation or request the last call started). */
export async function waitFor(page: Page, o: { text?: string; selector?: string; timeoutMs?: number }, signal?: AbortSignal): Promise<string> {
    page.ready();
    const ms = Math.min(Math.max(o.timeoutMs ?? WAIT_DEFAULT_MS, 100), WAIT_MAX_MS);
    if (o.text === undefined && o.selector === undefined) {
        await page.settle(signal, ms);
        return page.loading || page.inflight > 0 ? `The page was still busy after ${ms} ms.` : "The page has settled.";
    }
    const what = o.selector !== undefined ? `an element matching ${JSON.stringify(o.selector)}` : `the text ${JSON.stringify(o.text)}`;
    const deadline = Date.now() + ms;
    for (;;) {
        try {
            const r = await raceAbort(
                page.send<{ result: { value?: boolean }; exceptionDetails?: { exception?: { description?: string } } }>(
                    "Runtime.evaluate",
                    { expression: `(${WAIT_FOR})(${JSON.stringify(o.text ?? "")}, ${JSON.stringify(o.selector ?? "")}, ${Math.max(deadline - Date.now(), 0)})`, awaitPromise: true, returnByValue: true },
                    ms + 10_000,
                ),
                signal,
            );
            if (r.exceptionDetails) throw new BrowserError(`That selector isn't valid: ${(r.exceptionDetails.exception?.description ?? "").split("\n")[0]}`);
            return r.result.value ? `Found ${what}.` : `Timed out after ${ms} ms waiting for ${what}.`;
        } catch (e) {
            // A navigation ends the page the wait ran in: wait out the load and look again in the new one.
            if (!(e instanceof CdpError) || !/context|destroyed|navigat/i.test(e.message) || Date.now() >= deadline) throw e;
            await page.settle(signal, Math.max(deadline - Date.now(), 0));
        }
    }
}

// ---------------------------------------------------------------------------
// A person at the pane

const num = (v: unknown, lo: number, hi: number): number | undefined => (typeof v === "number" && Number.isFinite(v) ? Math.min(Math.max(v, lo), hi) : undefined);
const COORD = 100_000;
const BUTTONS = new Set(["left", "middle", "right"]);

/** What the pane sent, checked: undefined if it isn't an input. */
export function parseInput(raw: unknown): BrowserInput | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const e = raw as Record<string, unknown>;
    const modifiers = num(e.modifiers, 0, 15) ?? 0;
    switch (e.kind) {
        case "mouse": {
            const x = num(e.x, -COORD, COORD);
            const y = num(e.y, -COORD, COORD);
            if (x === undefined || y === undefined || (e.type !== "move" && e.type !== "down" && e.type !== "up")) return undefined;
            const button = typeof e.button === "string" && BUTTONS.has(e.button) ? (e.button as MouseButton) : undefined;
            return { kind: "mouse", type: e.type, x, y, ...(button ? { button } : {}), buttons: num(e.buttons, 0, 31) ?? 0, clickCount: num(e.clickCount, 0, 3) ?? 1, modifiers };
        }
        case "wheel": {
            const x = num(e.x, -COORD, COORD);
            const y = num(e.y, -COORD, COORD);
            const deltaX = num(e.deltaX, -COORD, COORD);
            const deltaY = num(e.deltaY, -COORD, COORD);
            return x === undefined || y === undefined || deltaX === undefined || deltaY === undefined ? undefined : { kind: "wheel", x, y, deltaX, deltaY, modifiers };
        }
        case "key":
            return (e.type === "down" || e.type === "up") && typeof e.key === "string" && e.key.length > 0 && e.key.length <= 32 && typeof e.code === "string" && e.code.length <= 32 ? { kind: "key", type: e.type, key: e.key, code: e.code, modifiers } : undefined;
        case "text":
            return typeof e.text === "string" && e.text.length > 0 && e.text.length <= MAX_TEXT ? { kind: "text", text: e.text } : undefined;
        default:
            return undefined;
    }
}

/** Whether an input takes the tab from the agent: moving the pointer over the pane doesn't. */
export const takesControl = (e: BrowserInput) => !(e.kind === "mouse" && e.type === "move" && !e.buttons);

/** Forwards what a person did in the pane to the page. */
export async function forward(page: Page, e: BrowserInput): Promise<void> {
    page.ready();
    switch (e.kind) {
        case "mouse": {
            const type = e.type === "move" ? "mouseMoved" : e.type === "down" ? "mousePressed" : "mouseReleased";
            const button = e.button ?? "left";
            await mouse(page, type, { x: e.x, y: e.y }, { button: e.type === "move" ? (e.buttons ? button : "none") : button, buttons: e.buttons ?? 0, clickCount: e.type === "move" ? 0 : (e.clickCount ?? 1), modifiers: e.modifiers ?? 0 });
            return;
        }
        case "wheel":
            await mouse(page, "mouseWheel", { x: e.x, y: e.y }, { deltaX: e.deltaX, deltaY: e.deltaY, modifiers: e.modifiers ?? 0 });
            return;
        case "key": {
            const press = fromKeyboardEvent({ key: e.key, code: e.code, modifiers: e.modifiers ?? 0 });
            if (press) await page.input("Input.dispatchKeyEvent", keyParams(press, e.type));
            return;
        }
        case "text":
            await page.input("Input.insertText", { text: e.text });
    }
}
