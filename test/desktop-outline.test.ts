// A Mac app's accessibility tree as the outline the agent reads (src/desktop/outline.ts): what's shown, what refs
// stand for, what's left out (the Apple menu, what's scrolled out of its window), and finding a ref's element again.
import { describe, expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

isolate();
const { outlineApp, refStill, MAX_OUTLINE } = await import("../src/desktop/outline");
type DesktopNode = import("../src/desktop/outline").DesktopNode;

const TEXTEDIT: DesktopNode = {
    role: "AXApplication",
    title: "TextEdit",
    children: [
        {
            role: "AXMenuBar",
            children: [
                { role: "AXMenuBarItem", title: "Apple", frame: [0, 0, 30, 24] },
                { role: "AXMenuBarItem", title: "TextEdit", frame: [30, 0, 70, 24] },
                {
                    role: "AXMenuBarItem",
                    title: "File",
                    frame: [100, 0, 40, 24],
                    selected: true,
                    children: [
                        {
                            role: "AXMenu",
                            children: [
                                { role: "AXMenuItem", title: "New", frame: [100, 24, 200, 22] },
                                { role: "AXMenuItem", title: "Close", frame: [100, 46, 200, 22], disabled: true },
                            ],
                        },
                    ],
                },
            ],
        },
        {
            role: "AXWindow",
            title: "Untitled",
            frame: [100, 100, 600, 400],
            focused: true,
            children: [
                { role: "AXButton", subrole: "AXCloseButton", label: "close button", frame: [108, 108, 14, 14] },
                {
                    role: "AXScrollArea",
                    frame: [100, 130, 600, 370],
                    children: [
                        { role: "AXTextArea", value: "Hello there", frame: [100, 130, 600, 1200], focused: true },
                        { role: "AXScrollBar", frame: [690, 130, 10, 370], children: [{ role: "AXValueIndicator", frame: [690, 130, 10, 50] }] },
                    ],
                },
                { role: "AXStaticText", value: "Far below", frame: [100, 900, 100, 20] },
                { role: "AXCheckBox", title: "Wrap", value: "1", frame: [400, 105, 60, 20] },
                { role: "AXSecureTextField", subrole: "AXSecureTextField", label: "Password", value: "••••", frame: [200, 105, 100, 20] },
                { role: "AXColumn", frame: [100, 130, 100, 370], children: [{ role: "AXCell", title: "dup", frame: [100, 130, 100, 20] }] },
            ],
        },
        { role: "AXWindow", title: "Notes.txt", minimized: true, frame: [0, 0, 400, 300], children: [{ role: "AXButton", title: "Hidden", frame: [10, 10, 40, 20] }] },
    ],
};

describe("the outline", () => {
    const o = outlineApp(TEXTEDIT, 42);
    const lines = o.text.split("\n");

    test("names the app, then its menus on one line (not the Apple menu), and an open menu's items", () => {
        expect(lines[0]).toBe("App: TextEdit");
        expect(lines[1]).toBe('- menu bar: "TextEdit" [e1], "File" [e2]');
        expect(o.text).not.toContain("Apple");
        expect(lines).toContain('  - item "New" [e3]');
        expect(lines).toContain('  - item "Close" (disabled) [e4]');
    });

    test("a window with where it is; its elements with a ref on what can be clicked", () => {
        expect(lines).toContain('- window "Untitled" at 100,100, 600×400 (focused)');
        expect(lines).toContain('  - textarea value="Hello there" (focused) [e6]');
        expect(lines).toContain('  - checkbox "Wrap" (on) [e7]');
        // What's typed in a password field isn't shown.
        expect(lines).toContain('  - securefield "Password" [e8]');
        expect(o.text).not.toContain("••••");
    });

    test("leaves out what's scrolled out of its window, scroll bars, columns and a minimized window's contents", () => {
        expect(o.text).not.toContain("Far below");
        expect(o.text).not.toContain("scrollbar");
        expect(o.text).not.toContain("dup");
        expect(lines).toContain('- window "Notes.txt" (minimized)');
        expect(o.text).not.toContain("Hidden");
    });

    test("a ref stands for the middle of what of it is in its window", () => {
        // The text area runs past the window's bottom: its ref is the middle of the part inside.
        expect(o.refs.get("e6")).toMatchObject({ x: 400, y: 315, role: "AXTextArea", pid: 42 });
        expect(o.refs.get("e8")).toMatchObject({ secure: true });
        expect(o.refs.get("e2")).toMatchObject({ x: 120, y: 12, name: "File", role: "AXMenuBarItem" });
        expect(o.lastRef).toBe(8);
        // Numbering goes on from the last outline's, so an old ref is never another element.
        expect(outlineApp(TEXTEDIT, 42, 8).refs.has("e9")).toBe(true);
    });

    test("an app with no windows says how to bring it up; a huge one is cut and says so", () => {
        expect(outlineApp({ role: "AXApplication", title: "Calculator", children: [] }, 1).text).toBe("App: Calculator\n(no windows: DesktopControl action=open brings the app to the front)");
        const many: DesktopNode = { role: "AXApplication", title: "Big", children: [{ role: "AXWindow", title: "W", frame: [0, 0, 1000, 1000], children: Array.from({ length: 2000 }, (_, i) => ({ role: "AXButton", title: `Button number ${i}`, frame: [0, i % 900, 50, 20] })) }] };
        const big = outlineApp(many, 1);
        expect(big.text.length).toBeLessThan(MAX_OUTLINE + 100);
        expect(big.text).toEndWith("(the outline stops at 24,000 characters)");
    });
});

describe("finding a ref again", () => {
    const o = outlineApp(TEXTEDIT, 42);

    test("the same element where it was is found; one that moved, changed or went isn't", () => {
        const wrap = o.refs.get("e7")!;
        expect(refStill(wrap, TEXTEDIT)).toBe("Wrap");
        const moved = structuredClone(TEXTEDIT);
        moved.children![1]!.children![3]!.frame = [400, 160, 60, 20];
        expect(refStill(wrap, moved)).toBeUndefined();
        const renamed = structuredClone(TEXTEDIT);
        renamed.children![1]!.children![3]!.title = "Ruler";
        expect(refStill(wrap, renamed)).toBeUndefined();
        const gone = structuredClone(TEXTEDIT);
        gone.children![1]!.children!.splice(3, 1);
        expect(refStill(wrap, gone)).toBeUndefined();
    });

    test("a field whose text changed is still the field", () => {
        const area = o.refs.get("e6")!;
        const typed = structuredClone(TEXTEDIT);
        typed.children![1]!.children![1]!.children![0]!.value = "Hello there, and more";
        expect(refStill(area, typed)).toBe("Hello there, and more");
    });
});
