// Moving the desktop window. Its title bar is the page's own (the window has no native one over
// the web view), so the page starts the move: a press on the window's top strip, the band the
// traffic lights sit in, moves the window unless it lands on something that takes the
// press itself. What lies there changes with the state (the title bar, the side panel's or the
// diff reader's head, Settings, a maximized terminal's toolbar, a toast), so the rule is the
// strip's, not each element's: nothing has to be marked to drag, and nothing laid over the strip
// later can stop it. Below the strip, only the window's frame (the gaps around the rail and the
// sheet, marked data-window-drag) moves it.
//
// It replaces Tauri's data-tauri-drag-region, which drags only from the element that carries it
// (not its children), so every child and every overlay on the top line was a dead spot. Keep the
// GUI free of that attribute: Tauri's own script would start a second move from it. The move is
// the window plugin's start_dragging, which the app's capability has to allow
// (desktop/src-tauri/capabilities/default.json); zooming, internal_toggle_maximize, is in core:default.

/** What a press can land on: an element of the page (or a stand-in for one in tests). */
export interface PressTarget {
    tagName: string;
    getAttribute(name: string): string | null;
    hasAttribute(name: string): boolean;
}

const CONTROL_TAGS = new Set(["A", "BUTTON", "INPUT", "SELECT", "TEXTAREA", "LABEL", "SUMMARY", "OPTION", "VIDEO", "AUDIO", "IFRAME"]);
const CONTROL_ROLES = new Set(["button", "link", "menuitem", "menuitemcheckbox", "menuitemradio", "tab", "checkbox", "radio", "switch", "option", "slider", "textbox", "combobox", "spinbutton", "scrollbar"]);
/** Where Solid keeps a delegated handler (`onClick={…}` sets el.$$click): an element listening for a press. */
const PRESS_HANDLERS = ["$$click", "$$dblclick", "$$mousedown", "$$mouseup", "$$pointerdown", "$$pointerup"];

const isElement = (t: unknown): t is PressTarget => typeof (t as PressTarget | null)?.getAttribute === "function" && typeof (t as PressTarget).tagName === "string";

/** Whether the element takes a press itself: a control, something focusable or draggable, or one with a press handler. */
export function takesPress(el: PressTarget): boolean {
    if (CONTROL_TAGS.has(el.tagName.toUpperCase())) return true;
    const role = el.getAttribute("role");
    if (role && CONTROL_ROLES.has(role)) return true;
    const editable = el.getAttribute("contenteditable");
    if (editable !== null && editable !== "false") return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && tabindex !== "-1") return true;
    if (el.getAttribute("draggable") === "true") return true;
    const own = el as unknown as Record<string, unknown>;
    return PRESS_HANDLERS.some((k) => typeof own[k] === "function");
}

export interface DragRule {
    /** Where the top strip ends, in px from the window's top. */
    strip: number;
    /** Whether the press target is text you can select (it keeps its selection). */
    selectable: (el: PressTarget) => boolean;
}

/**
 * Whether a primary press at `y` (px from the window's top) on `path` (the event's composed path,
 * the target first) moves the window.
 */
export function movesWindow(path: readonly unknown[], y: number, rule: DragRule): boolean {
    const target = path.find(isElement);
    if (!target) return false;
    for (const el of path) {
        if (!isElement(el)) continue;
        const own = el.getAttribute("data-window-drag");
        if (own === "off" || takesPress(el)) return false;
        if (own !== null) return true;
    }
    return y < rule.strip && !rule.selectable(target);
}

/** Where the top strip ends: as far below the traffic lights' line as the window's inset is above it, with the rail's top row (tokens.css, shell.css, sidebar.css). */
export function stripEnd(topLine: number, winPad: number): number {
    return 2 * topLine - winPad;
}

const px = (v: string) => {
    const n = Number.parseFloat(v);
    return Number.isFinite(n) ? n : undefined;
};

/** Reads the strip from the page's styles: --top-line on the root, --win-pad on the window (.app). */
export function pageStrip(doc: Document = document): number {
    const line = px(getComputedStyle(doc.documentElement).getPropertyValue("--top-line")) ?? 34;
    const app = doc.querySelector(".app");
    const pad = (app && px(getComputedStyle(app).getPropertyValue("--win-pad"))) ?? 8;
    return stripEnd(line, pad);
}

const pageSelectable = (el: PressTarget) => {
    const style = getComputedStyle(el as unknown as Element);
    const select = style.getPropertyValue("-webkit-user-select") || style.getPropertyValue("user-select");
    return select === "text" || select === "all";
};

/**
 * Listens for presses on the window: a press on the strip moves the window; on macOS a double
 * press that doesn't move zooms it, on release, as the system's title bar does (and as Tauri's own
 * drag regions did); elsewhere a double press toggles maximize at once. `invoke` runs a window
 * command from inside the press, which the move needs to still be current. Returns the remover.
 */
export function installWindowDrag(o: { invoke: (cmd: string) => Promise<unknown>; mac: boolean; target?: Pick<Window, "addEventListener" | "removeEventListener">; rule?: () => DragRule }): () => void {
    const win = o.target ?? window;
    const rule = o.rule ?? ((): DragRule => ({ strip: pageStrip(), selectable: pageSelectable }));
    let zoomAt: { x: number; y: number } | undefined;
    const run = (cmd: string) => void o.invoke(`plugin:window|${cmd}`).catch(() => undefined);
    const down = (e: MouseEvent) => {
        zoomAt = undefined;
        if (e.button !== 0 || e.defaultPrevented || (o.mac && e.ctrlKey) || (e.detail !== 1 && e.detail !== 2)) return;
        if (!movesWindow(e.composedPath(), e.clientY, rule())) return;
        // No text selection or focus change from a press that moves the window.
        e.preventDefault();
        if (e.detail === 1) return run("start_dragging");
        if (o.mac) zoomAt = { x: e.clientX, y: e.clientY };
        else run("internal_toggle_maximize");
    };
    const up = (e: MouseEvent) => {
        const at = zoomAt;
        if (e.button !== 0 || e.detail !== 2 || !at) return;
        zoomAt = undefined;
        if (e.clientX === at.x && e.clientY === at.y && movesWindow(e.composedPath(), e.clientY, rule())) run("internal_toggle_maximize");
    };
    win.addEventListener("mousedown", down);
    win.addEventListener("mouseup", up);
    return () => {
        win.removeEventListener("mousedown", down);
        win.removeEventListener("mouseup", up);
    };
}
