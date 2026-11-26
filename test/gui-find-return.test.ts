// Find in page opened from the Browser pane's address bar, with an address typed in it: Esc used to throw the address
// away and give the keyboard to the page's last focused field. It goes back to the address bar now, with the address
// and the caret as they were. From the page, it still goes back to the page (test/gui-page-focus.test.ts).
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import { addressMark, backToAddress, keepsDraft } from "../gui/src/lib/find-return";

/** An address bar: focusing it selects all of it, as BrowserPane.tsx's does. */
function field(value: string, caret: [number, number, "forward" | "backward" | "none"] = [value.length, value.length, "none"]) {
    const f = {
        value,
        selectionStart: caret[0] as number | null,
        selectionEnd: caret[1] as number | null,
        selectionDirection: caret[2] as "forward" | "backward" | "none" | null,
        disabled: false,
        isConnected: true,
        focused: 0,
        focus() {
            this.focused++;
            this.setSelectionRange(0, this.value.length);
        },
        setSelectionRange(start: number | null, end: number | null, dir?: "forward" | "backward" | "none") {
            this.selectionStart = start;
            this.selectionEnd = end;
            this.selectionDirection = dir ?? "none";
        },
    };
    return f;
}

test("the address bar's caret is kept as the find bar opens from it, and put back as it closes", () => {
    const address = field("localhost:30", [7, 7, "none"]);
    const mark = addressMark(address, address);
    expect(mark).toEqual({ start: 7, end: 7, dir: "none" });
    // The find bar has the keyboard; then Esc.
    address.setSelectionRange(0, 0);
    expect(backToAddress(address, mark)).toBe(true);
    expect(address.focused).toBe(1);
    // Not all of it selected (the next key would replace it): the caret where it was.
    expect([address.selectionStart, address.selectionEnd]).toEqual([7, 7]);
    // A selection, made backwards, comes back the same way.
    const sel = field("example.com", [2, 9, "backward"]);
    expect(backToAddress(sel, addressMark(sel, sel))).toBe(true);
    expect([sel.selectionStart, sel.selectionEnd, sel.selectionDirection]).toEqual([2, 9, "backward"]);
});

test("opened from anywhere else, nothing is kept and the find bar gives the keyboard to the page", () => {
    const address = field("localhost:3000");
    expect(addressMark(address, { other: true })).toBeUndefined();
    expect(addressMark(undefined, address)).toBeUndefined();
    expect(backToAddress(address, undefined)).toBe(false);
    expect(address.focused).toBe(0);
    // The address bar can't have it as the bar closes (the pane's page went away and it was turned off): the page.
    const mark = addressMark(address, address);
    address.disabled = true;
    expect(backToAddress(address, mark)).toBe(false);
    address.disabled = false;
    address.isConnected = false;
    expect(backToAddress(address, mark)).toBe(false);
    expect(address.focused).toBe(0);
});

test("leaving the address bar for the find bar keeps what was typed; leaving it for anything else doesn't", () => {
    const input = {};
    const bar = { contains: (n: unknown) => n === bar || n === input };
    expect(keepsDraft(bar, input as EventTarget)).toBe(true);
    expect(keepsDraft(bar, {} as EventTarget)).toBe(false);
    expect(keepsDraft(bar, null)).toBe(false);
    expect(keepsDraft(undefined, input as EventTarget)).toBe(false);
});

test("the pane uses them: kept as the bar opens, the address bar before the page as it closes, the address kept on the way", () => {
    const tools = readFileSync(join(import.meta.dir, "../gui/src/components/BrowserTools.tsx"), "utf8");
    const open = tools.slice(tools.indexOf("const openFind = () => {"), tools.indexOf("const closeFind = () => {"));
    // Noted before the find bar takes the keyboard, and the page's own focus isn't kept then (it isn't gone back to).
    expect(open.indexOf("addressMark(o.address(), document.activeElement)")).toBeGreaterThan(0);
    expect(open.indexOf("addressMark(o.address(), document.activeElement)")).toBeLessThan(open.indexOf("findInput?.focus()"));
    expect(open).toContain("!fromAddress ? keyOf(");
    const close = tools.slice(tools.indexOf("const closeFind = () => {"));
    expect(close.indexOf("if (!backToAddress(o.address(), mark)) {")).toBeGreaterThan(0);
    expect(close.indexOf("if (!backToAddress(o.address(), mark)) {")).toBeLessThan(close.indexOf("webview()?.focus();"));
    const pane = readFileSync(join(import.meta.dir, "../gui/src/components/BrowserPane.tsx"), "utf8");
    expect(pane).toContain("onBlur={(e) => tools.keepsDraft(e.relatedTarget) || setDraft(undefined)}");
});
