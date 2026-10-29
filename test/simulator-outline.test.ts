// The simulator's screen as text (src/simulator/outline.ts): roles, labels and values, refs standing for the center
// of what's on screen, and what's left out.
import { expect, test } from "bun:test";
import { MAX_OUTLINE, outline, type AxNode } from "../src/simulator/outline";

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
