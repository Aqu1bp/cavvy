// The simulator's screen as text (src/simulator/outline.ts): roles, labels and values, refs standing for the center
// of what's on screen, what's left out, and the text read from the picture that the tree hasn't got.
import { describe, expect, test } from "bun:test";
import { agrees, MAX_OUTLINE, outline, type AxNode, type SeenLine } from "../src/simulator/outline";

const SCREEN = { width: 402, height: 874 };

const tree: AxNode = {
    role: "AXApplication",
    label: "Settings",
    children: [
        { role: "AXHeading", label: "Settings", frame: [20, 100, 200, 40] },
        {
            role: "AXGroup",
            frame: [0, 150, 402, 600],
            children: [
                { role: "AXButton", label: "General", identifier: "com.apple.settings.general", frame: [16, 200, 370, 44] },
                { role: "AXSwitch", label: "Airplane Mode", value: "0", frame: [16, 250, 370, 44] },
                { role: "AXTextField", value: "Search", placeholder: "Search", frame: [16, 820, 370, 40] },
                { role: "AXButton", label: "Below", frame: [16, 900, 370, 44] },
                { role: "AXButton", label: "Cut", frame: [16, 850, 370, 44], disabled: true },
            ],
        },
    ],
};

test("elements show by role and label, with values, ids and states, each with a ref", () => {
    const o = outline(tree, SCREEN);
    expect(o.text.split("\n")).toEqual([
        "Screen: Settings",
        '- heading "Settings" [e1]',
        '- button "General" id="com.apple.settings.general" [e2]',
        '- switch "Airplane Mode" value="0" [e3]',
        '- textfield placeholder="Search" [e4]',
        '- button "Cut" (disabled) [e5] (partly off screen)',
    ]);
});

test("the text on the screen is the labels and values shown: not ids, roles or what's off screen", () => {
    expect(outline(tree, SCREEN).texts).toEqual(["Settings", "General", "Airplane Mode", "0", "Search", "Cut"]);
    const below: AxNode = { role: "AXGroup", label: "Done", frame: [0, 900, 402, 100], children: [{ role: "AXButton", label: "Back", frame: [16, 800, 100, 44] }] };
    expect(outline({ role: "AXApplication", children: [below] }, SCREEN).texts).toEqual(["Back"]);
});

test("what's chosen says so, and a field's value shows whole, so what was typed can be checked", () => {
    const long = "x".repeat(150);
    const o = outline({ role: "AXApplication", children: [{ role: "AXButton", label: "Dark", selected: true, frame: [16, 200, 370, 44] }, { role: "AXTextField", value: long, frame: [16, 300, 370, 40] }, { role: "AXStaticText", label: "y".repeat(150), frame: [16, 400, 370, 40] }] }, SCREEN);
    expect(o.text).toContain('- button "Dark" (selected) [e1]');
    expect(o.text).toContain(`value="${long}"`);
    expect(o.text).toContain(`"${"y".repeat(120)}…"`);
});

test("a ref stands for the center of the part of the element that's on screen", () => {
    const o = outline(tree, SCREEN);
    expect(o.refs.get("e2")).toMatchObject({ x: 201, y: 222, name: "General" });
    // 850..894 cut at 874: the middle of what shows.
    expect(o.refs.get("e5")).toMatchObject({ x: 201, y: 862 });
});

test("an element wholly off screen is left out; a silent group shows its children in its place", () => {
    const o = outline(tree, SCREEN);
    expect(o.text).not.toContain("Below");
    expect(o.text).not.toContain("group");
});

test("a screen with nothing to read says to take a screenshot, and a long one stops and says so", () => {
    expect(outline({ role: "AXApplication" }, SCREEN).text).toContain("take a screenshot");
    const many: AxNode = { role: "AXApplication", children: Array.from({ length: 2000 }, (_, i) => ({ role: "AXStaticText", label: `Row number ${i} with some words`, frame: [0, 10, 100, 20] })) };
    const o = outline(many, SCREEN);
    expect(o.text.length).toBeLessThan(MAX_OUTLINE + 200);
    expect(o.text).toMatch(/the outline stops at 24,000 characters/);
});

describe("text read from the picture", () => {
    // Safari's tree: its toolbar, and no node for the page.
    const safari: AxNode = {
        role: "AXApplication",
        label: "Safari",
        children: [
            { role: "AXButton", label: "Back", frame: [34, 792, 48, 48] },
            { role: "AXTextField", label: "Address", value: "\u200eexample.com", frame: [149, 805, 104, 22] },
        ],
    };
    const line = (text: string, frame: number[], confidence = 1): SeenLine => ({ text, frame, confidence });

    test("lines the tree hasn't got follow it as seen lines, top to bottom and left to right, each with a ref", () => {
        const o = outline(safari, SCREEN, [line("monitoring purposes.", [20, 300, 150, 18]), line("Learn more", [20, 340, 80, 18]), line("Example Domain", [20, 200, 200, 30]), line("Privacy", [200, 342, 60, 18])]);
        expect(o.text.split("\n")).toEqual([
            "Screen: Safari",
            '- button "Back" [e1]',
            '- textfield "Address" value="\u200eexample.com" [e2]',
            '- seen "Example Domain" [e3]',
            '- seen "monitoring purposes." [e4]',
            '- seen "Learn more" [e5]',
            '- seen "Privacy" [e6]',
        ]);
        expect(o.refs.get("e5")).toEqual({ x: 60, y: 349, frame: [20, 340, 80, 18], name: "Learn more" });
        expect(o.texts).toContain("Example Domain");
    });

    test("what the tree has already, the status bar's clock, unsure readings and what's off screen are left out", () => {
        const o = outline(safari, SCREEN, [
            line("= example.com", [150, 806, 100, 20]),
            line("Back", [40, 800, 30, 20]),
            line("1:33", [54, 25, 40, 16]),
            line("4>L>Jl ugJ 4U4144", [20, 400, 200, 18], 0.3),
            line("Far below", [20, 900, 100, 18]),
            line("· ·", [20, 500, 30, 10]),
        ]);
        expect(o.text).not.toContain("seen");
        // The clock is text an app's tree never has, but only at the top: a time on the page is the page's.
        expect(outline(safari, SCREEN, [line("1:33", [20, 400, 40, 16])]).text).toContain('- seen "1:33"');
        // Words the tree has elsewhere on the screen don't make a line known: only those of what it overlaps.
        expect(outline(safari, SCREEN, [line("Back to top", [20, 400, 90, 18])]).text).toContain('- seen "Back to top"');
    });

    test("the status bar, icons read as a letter or two, and a field read with its icon are left out", () => {
        const search: AxNode = {
            role: "AXApplication",
            children: [
                { role: "AXSearchField", value: "café — naïve", placeholder: "Search", frame: [16, 120, 370, 36] },
                // Empty: its placeholder shows.
                { role: "AXSearchField", placeholder: "Search", frame: [16, 166, 370, 36] },
            ],
        };
        const o = outline(search, SCREEN, [
            line("• Safari", [20, 38, 60, 16]),
            line("→ 100", [340, 20, 40, 14]),
            line("C", [20, 400, 12, 14]),
            line("| X", [60, 400, 20, 14]),
            line("Q cafe E# v - naive", [16, 125, 300, 24]),
            line("Q Search", [16, 170, 100, 24]),
        ]);
        expect(o.text).not.toContain("seen");
        // The empty field's placeholder is on the screen still, as the tree's.
        expect(o.texts).toContain("Search");
        // Below the status bar, two letters are a word ("OK"), and the same on an iPad starts lower than a phone's bar.
        expect(outline(search, SCREEN, [line("OK", [20, 400, 30, 16])]).text).toContain('- seen "OK"');
        expect(outline(search, { width: 820, height: 1180 }, [line("Sign in", [20, 40, 60, 16])]).text).toContain('- seen "Sign in"');
    });

    test("a phrase that wraps onto the next line is found", () => {
        const o = outline(safari, SCREEN, [line("This domain is for use in documentation", [20, 300, 300, 18]), line("examples without needing permission.", [20, 320, 300, 18])]);
        expect(o.texts.some((t) => t.includes("documentation examples"))).toBe(true);
    });

    test("a screen whose tree is empty can still be read from its picture", () => {
        const o = outline({ role: "AXApplication" }, SCREEN, [line("Loading your feed", [100, 400, 200, 20])]);
        expect(o.text).toBe('Screen\n- seen "Loading your feed" [e1]');
    });
});

describe("whether the tree is the screen's", () => {
    // Settings' rows, and the same screen as the picture shows it.
    const rows = ["General", "Accessibility", "Camera", "Home Screen", "Privacy & Security"];
    const settings: AxNode = { role: "AXApplication", label: "Settings", children: rows.map((label, i) => ({ role: "AXButton", label, frame: [16, 200 + i * 52, 370, 44] })) };
    const read = (labels: string[]): SeenLine[] => labels.map((text, i) => ({ text, confidence: 1, frame: [60, 210 + i * 52, 150, 22] }));

    test("the picture showing most of the rows' text where they are: it is", () => {
        expect(agrees(outline(settings, SCREEN, read(rows)))).toBe(true);
        // A row Vision misread or missed doesn't change that.
        expect(agrees(outline(settings, SCREEN, read(["General", "Accessibiity", "", "Home Screen", "Privacy Security"])))).toBe(true);
    });

    test("a black screen, or another app's text: it isn't", () => {
        expect(agrees(outline(settings, SCREEN, []))).toBe(false);
        expect(agrees(outline(settings, SCREEN, read(["Calendar", "Photos", "Maps", "Clock", "Weather"])))).toBe(false);
        // The same words elsewhere on the screen aren't the rows.
        const moved = read(rows).map((l) => ({ ...l, frame: [60, 700, 150, 22] }));
        expect(agrees(outline(settings, SCREEN, moved))).toBe(false);
    });

    test("too little to tell: icons, whose labels aren't text to see, and a web page's few native views", () => {
        const icons: AxNode = { role: "AXApplication", children: ["Back", "Share", "Tabs", "Bookmarks", "Reload"].map((label, i) => ({ role: "AXButton", label, frame: [20 + i * 60, 792, 48, 48] })) };
        expect(agrees(outline(icons, SCREEN, []))).toBeUndefined();
        expect(agrees(outline({ role: "AXApplication", children: settings.children!.slice(0, 3) }, SCREEN, []))).toBeUndefined();
    });
});
