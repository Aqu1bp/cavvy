// The simulator's screen as text (src/simulator/outline.ts): roles, labels and values, refs standing for the center
// of what's on screen, what's left out, and the text read from the picture that the tree hasn't got.
import { describe, expect, test } from "bun:test";
import { agrees, MAX_OUTLINE, outline, refNow, type AxNode, type SeenLine } from "../src/simulator/outline";

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

describe("noise in what's read from the picture", () => {
    const line = (text: string, frame: number[]): SeenLine => ({ text, confidence: 1, frame });
    const seen = (o: { text: string }) => o.text.split("\n").filter((l) => l.includes("- seen"));

    test("a word read wrong in an element's own text isn't listed again", () => {
        const form: AxNode = { role: "AXApplication", children: [{ role: "AXStaticText", label: "Standby Learn more", frame: [20, 300, 300, 30] }] };
        expect(seen(outline(form, SCREEN, [line("Stanuby aarn mora", [20, 285, 200, 20])]))).toEqual([]);
    });

    test("nor is anything else inside a line's element (an icon, a clock), but text outside it is", () => {
        const form: AxNode = { role: "AXApplication", children: [{ role: "AXStaticText", label: "4:02 PM", frame: [20, 300, 200, 80] }] };
        expect(seen(outline(form, SCREEN, [line("4:0₴", [30, 310, 120, 60]), line("Fresh news", [20, 500, 100, 20])]))).toEqual(['- seen "Fresh news" [e2]']);
    });

    test("a tall element's text isn't its own: it may hold other lines", () => {
        const page: AxNode = { role: "AXApplication", children: [{ role: "AXGroup", label: "Page", frame: [0, 100, 402, 600] }] };
        expect(seen(outline(page, SCREEN, [line("Fresh news", [20, 500, 100, 20])]))).toHaveLength(1);
    });

    const ALERT: AxNode = {
        role: "AXApplication",
        children: [
            { role: "AXStaticText", label: "Test alert", frame: [65, 374, 260, 22] },
            { role: "AXButton", label: "Cancel", frame: [51, 442, 140, 48] },
        ],
    };

    test("what's behind a dialog isn't listed, can't be tapped or waited for, and the outline says so", () => {
        const o = outline(ALERT, SCREEN, [line("Tap me", [150, 120, 80, 20]), line("Switch: on", [5, 380, 80, 20]), line("Choose one", [65, 403, 260, 20])]);
        expect(seen(o)).toEqual(['- seen "Choose one" [e3]']);
        expect(o.text).toContain("(Text outside this dialog isn't listed: a screenshot shows it.)");
        expect(o.texts).not.toContain("Tap me");
    });

    test("a web page under toolbars at the screen's edges isn't a dialog", () => {
        const safari: AxNode = { role: "AXApplication", children: [{ role: "AXButton", label: "Back", frame: [10, 800, 40, 40] }] };
        const o = outline(safari, SCREEN, [line("Tap me", [150, 120, 80, 20])]);
        expect(seen(o)).toHaveLength(1);
        expect(o.text).not.toContain("dialog");
    });
});

test("refs go on from where the last outline's stopped, so one is never another element's later", () => {
    const first = outline(tree, SCREEN);
    const next = outline(tree, SCREEN, [], first.lastRef);
    expect(next.refs.has("e1")).toBe(false);
    expect(next.refs.has(`e${first.lastRef + 1}`)).toBe(true);
    expect(next.lastRef).toBe(first.lastRef * 2);
});

test("a button over the whole screen is tapped at its corner, where what it's around isn't", () => {
    const menu: AxNode = { role: "AXApplication", children: [{ role: "AXButton", label: "Dismiss context menu", frame: [0, 0, 402, 874] }, { role: "AXButton", label: "Open", frame: [100, 400, 200, 44] }] };
    const o = outline(menu, SCREEN);
    expect(o.refs.get("e1")).toMatchObject({ x: 10, y: 70 });
    expect(o.refs.get("e2")).toMatchObject({ x: 200, y: 422 });
});

test("a web page's alert, an empty sheet in the tree, is said to be there", () => {
    const page: AxNode = { role: "AXApplication", children: [{ role: "AXSheet", frame: [0, 0, 402, 874] }, { role: "AXButton", label: "Back", frame: [10, 800, 40, 40] }] };
    const lines = [{ text: "Hello from the page", confidence: 1, frame: [60, 400, 200, 20] }];
    expect(outline(page, SCREEN, lines).text).toContain("(A dialog or menu is open");
    expect(outline({ role: "AXApplication", children: [page.children![1]!] }, SCREEN, lines).text).not.toContain("A dialog");
});

describe("what's under a bar at the bottom of the screen", () => {
    const line = (text: string, y: number): SeenLine => ({ text, confidence: 1, frame: [16, y, 120, 20] });
    const bar = { role: "AXApplication", children: [{ role: "AXButton", label: "Back", frame: [34, 780, 48, 48] }] };

    test("isn't read: the glass blurs it into nonsense", () => {
        const o = outline(bar, SCREEN, [line("A real line above", 740), line("NUVV LO", 775), line("Under it", 830)]).text;
        expect(o).toContain("A real line above");
        expect(o).not.toContain("NUVV LO");
        expect(o).not.toContain("Under it");
    });

    test("a field is a bar's too (Safari's address, shrunk), but a row of text isn't", () => {
        const lines = [line("Below", 790)];
        expect(outline({ role: "AXApplication", children: [{ role: "AXTextField", label: "Address", value: "site", frame: [160, 806, 60, 16] }] }, SCREEN, lines).text).not.toContain('seen "Below"');
        expect(outline({ role: "AXApplication", children: [{ role: "AXStaticText", label: "Row 9", frame: [16, 745, 200, 20] }] }, SCREEN, lines).text).toContain('seen "Below"');
    });

    test("a button higher up says nothing about what's below it", () => {
        const higher = { role: "AXApplication", children: [{ role: "AXButton", label: "Back", frame: [34, 100, 48, 48] }] };
        expect(outline(higher, SCREEN, [line("A web page's text", 775)]).text).toContain('seen "A web page\'s text"');
    });
});

describe("whether a ref still stands for what it did", () => {
    const button = (label: string, y: number, w = 200) => ({ role: "AXButton", label, frame: [20, y, w, 40] });
    const app = (...children: AxNode[]): AxNode => ({ role: "AXApplication", children });
    const refs = (o: { refs: Map<string, unknown> }) => [...o.refs.values()] as Parameters<typeof refNow>[0][];

    test("a label that counts is the same button, with the screen around it unchanged", () => {
        const was = outline(app(button("Resend in 997", 100), button("Steady", 200)), SCREEN);
        const [resend] = refs(was);
        expect(refNow(resend!, app(button("Resend in 990", 100), button("Steady", 200)), [], refs(was))).toBe("Resend in 990");
        // And one counting beside it, and one narrower for its digits, with the same place in it.
        const beside = outline(app(button("Resend in 997", 100), button("Elapsed 3", 200)), SCREEN);
        expect(refNow(refs(beside)[0]!, app(button("Resend in 996", 100, 180), button("Elapsed 4", 200)), [], refs(beside))).toBe("Resend in 996");
    });

    test("a numbered list that moved is not: its rows all changed", () => {
        const rows = (first: number) => app(...[0, 1, 2, 3].map((i) => button(`Item ${first + i}`, 100 + i * 50)));
        const was = outline(rows(5), SCREEN);
        expect(refNow(refs(was)[0]!, rows(6), [], refs(was))).toBeUndefined();
        expect(refNow(refs(was)[2]!, rows(35), [], refs(was))).toBeUndefined();
        expect(refNow(refs(was)[0]!, rows(5), [], refs(was))).toBe("Item 5");
    });

    test("only a number apart: letters have to say it's the same, and its place has to be in it", () => {
        const was = outline(app(button("12", 100), button("Item 1", 200)), SCREEN);
        expect(refNow(refs(was)[0]!, app(button("13", 100), button("Item 1", 200)), [], refs(was))).toBeUndefined();
        expect(refNow(refs(was)[1]!, app(button("12", 100), button("Item 2", 300)), [], refs(was))).toBeUndefined();
        expect(refNow(refs(was)[1]!, app(button("12", 100), { ...button("Item 1", 200), role: "AXStaticText" }), [], refs(was))).toBeUndefined();
    });

    test("similar lines in the picture: a moved page isn't the same line, a misread or counting one on a still page is", () => {
        const page = (first: number): SeenLine[] => [0, 1, 2, 3].map((i) => ({ text: `Line ${first + i} of the page`, confidence: 1, frame: [16, 100 + i * 40, 200, 20] }));
        const was = outline(app(), SCREEN, page(5));
        const [five, six, seven, eight] = refs(was);
        expect(refNow(five!, app(), page(19), refs(was))).toBeUndefined();
        expect(refNow(seven!, app(), page(5), refs(was))).toBe("Line 7 of the page");
        const counted = page(5).map((l, i) => (i === 3 ? { ...l, text: "Line 9 of the page" } : l));
        expect(refNow(eight!, app(), counted, refs(was))).toBe("Line 9 of the page");
        const misread = page(5).map((l, i) => (i === 1 ? { ...l, text: "Lime 6 of the page" } : l));
        expect(refNow(six!, app(), misread, refs(was))).toBe("Lime 6 of the page");
        // Other words altogether, whatever the rest does.
        expect(refNow(six!, app(), page(5).map((l, i) => (i === 1 ? { ...l, text: "Something else" } : l)), refs(was))).toBeUndefined();
    });
});
