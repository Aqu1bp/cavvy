// A tab's DevTools commands that Electron would send outside the tab (the approach is T3 Code's, desktop GuestInput).
//
// Chromium sends a page's DevTools key and text input to whichever frame holds focus in the window. A <webview> shares
// that focus with the UI around it, so while the person works in the UI (typing in the composer, say), Input.insertText
// on the tab's own debugger types into the UI's focused field, and Enter sends it: a page's words, as the person's
// message. Such input goes through DevTools only while the tab holds focus; otherwise straight to the tab's page, which
// nothing redirects. And Electron's debugger routes Page.reload on a webview to the window around it: the tab reloads
// itself instead.

import type { Debugger, KeyboardInputEvent, WebContents } from "electron";

/** DevTools input Chromium delivers to the window's focused frame rather than the tab's. */
const FOCUS_ROUTED = new Set(["Input.insertText", "Input.dispatchKeyEvent", "Input.imeSetComposition"]);

/**
 * Page script: the document holding the page's focus, or null when a cross-site frame holds it. Electron's direct input
 * reaches only the main frame's process, and insertText crashes the page when focus is in another one.
 */
const FOCUSED_DOCUMENT = `(() => {
    let doc = document;
    for (;;) {
        const active = doc.activeElement;
        if (active?.tagName !== "IFRAME" && active?.tagName !== "FRAME") return doc;
        if (!active.contentDocument) return null;
        doc = active.contentDocument;
    }
})()`;

/** Editing commands a key asks for (Cmd+A is selectAll), which Chromium runs only for DevTools keys. Never the clipboard's. */
const EDITING = new Set(["selectAll", "undo", "redo"]);
const ARROWS: Record<string, string> = { ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right" };
const NAMED = new Set(["Backspace", "Tab", "Enter", "Escape", "Delete", "Insert", "Home", "End", "PageUp", "PageDown", "Shift", "Control", "Alt", "Meta", "CapsLock"]);
const MODIFIERS = [[1, "alt"], [2, "control"], [4, "meta"], [8, "shift"]] as const;

/** Electron's name for a DOM key, or null when it has none. */
function keyCode(key: string): string | null {
    if ([...key].length === 1) return key;
    if (ARROWS[key]) return ARROWS[key];
    return NAMED.has(key) || /^F(?:[1-9]|1\d|2[0-4])$/.test(key) ? key : null;
}

/** The Electron key events for one Input.dispatchKeyEvent: typed text goes as char events of its own. */
export function keyboardEvents(params: Record<string, unknown>): KeyboardInputEvent[] {
    const bits = typeof params.modifiers === "number" ? params.modifiers : 0;
    const modifiers = MODIFIERS.flatMap(([bit, name]) => (bits & bit ? [name] : [])) as KeyboardInputEvent["modifiers"];
    const text = typeof params.text === "string" ? params.text : "";
    const chars = [...text].map((c) => ({ type: "char" as const, keyCode: c, modifiers }));
    const code = keyCode(typeof params.key === "string" ? params.key : "");
    switch (params.type) {
        case "keyDown":
            return [...(code ? [{ type: "rawKeyDown" as const, keyCode: code, modifiers }] : []), ...chars];
        case "rawKeyDown":
        case "keyUp":
            return code ? [{ type: params.type, keyCode: code, modifiers }] : [];
        case "char":
            return chars;
        default:
            return [];
    }
}

async function evaluate(dbg: Debugger, expression: string): Promise<unknown> {
    const r = (await dbg.sendCommand("Runtime.evaluate", { expression, returnByValue: true })) as { result?: { value?: unknown } };
    return r.result?.value;
}

/** Sends one of the tab's commands so that it stays in the tab. */
export async function sendToTab(wc: WebContents, method: string, params: Record<string, unknown>): Promise<unknown> {
    const dbg = wc.debugger;
    if (method === "Page.reload") {
        if (params.ignoreCache === true) wc.reloadIgnoringCache();
        else wc.reload();
        return {};
    }
    // The tab holds the window's focus (the person clicked into it): DevTools input lands in it.
    if (!FOCUS_ROUTED.has(method) || wc.focusedFrame) return dbg.sendCommand(method, params);
    if ((await evaluate(dbg, `${FOCUSED_DOCUMENT} !== null`)) !== true) {
        throw new Error("The page's focus is in a frame from another site, which takes typed text only while the tab has focus. Click the field first.");
    }
    switch (method) {
        case "Input.insertText":
            await wc.insertText(typeof params.text === "string" ? params.text : "");
            return {};
        case "Input.dispatchKeyEvent": {
            for (const event of keyboardEvents(params)) wc.sendInputEvent(event);
            const commands = Array.isArray(params.commands) ? params.commands.filter((c) => EDITING.has(c)) : [];
            // After the page has handled the keys, so the answer waits for them too.
            await evaluate(dbg, `(() => { const doc = ${FOCUSED_DOCUMENT}; for (const name of ${JSON.stringify(commands)}) doc?.execCommand(name); return 0; })()`);
            return {};
        }
        default:
            throw new Error(`${method} needs the tab to have focus.`);
    }
}
