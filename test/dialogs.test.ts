import { describe, expect, test } from "bun:test";
import { InputDialog, MessageDialog, SelectDialog, frame, frameInner, type SelectDialogOptions } from "../src/ui/dialogs";
import { KeyParser, type Key } from "../src/ui/keys";
import { stripAnsi, theme, width } from "../src/ui/ansi";
import type { SelectItem } from "../src/ui/components";
import { alsoRunInOtherColorMode } from "./helpers/color-mode";

const PENDING = Symbol("pending");
/** The resolved value, or PENDING if the promise has not settled yet. */
async function settled<T>(p: Promise<T>): Promise<T | typeof PENDING> {
    return Promise.race([p, Promise.resolve(PENDING)]);
}

const key = (name: string, mods: Partial<Key> = {}): Key => ({ name, ...mods });
const text = (t: string): Key => ({ name: "text", text: t });
const plain = (lines: string[]) => lines.map(stripAnsi);

/** Feed raw terminal bytes through the real key parser into a dialog. */
function type(d: { onKey(k: Key): void }, raw: string) {
    const p = new KeyParser();
    for (const k of p.feed(raw)) d.onKey(k);
    for (const k of p.flushEscape()) d.onKey(k);
}

const items: SelectItem[] = [
    { label: "alpha", value: "a" },
    { label: "beta", value: "b", disabled: true },
    { label: "gamma", value: "g" },
    { label: "delta", value: "d", description: "the fourth letter" },
];

describe("SelectDialog", () => {
    test("Enter resolves with the highlighted value", async () => {
        const d = new SelectDialog({ title: "Pick", items });
        d.onKey(key("down")); // skips disabled beta
        d.onKey(key("enter"));
        expect(await d.done).toBe("g");
    });

    test("Escape and ctrl+c resolve with undefined", async () => {
        const a = new SelectDialog({ items });
        a.onKey(key("escape"));
        expect(await a.done).toBeUndefined();
        const b = new SelectDialog({ items });
        b.onKey(key("c", { ctrl: true }));
        expect(await b.done).toBeUndefined();
    });

    test("cancel() resolves with undefined", async () => {
        const d = new SelectDialog({ items });
        d.cancel();
        expect(await d.done).toBeUndefined();
    });

    test("navigation keys: up/down, ctrl+p/n, tab/shift+tab", async () => {
        const d = new SelectDialog({ items });
        d.onKey(key("n", { ctrl: true })); // g
        d.onKey(key("tab")); // d
        d.onKey(key("tab", { shift: true })); // g
        d.onKey(key("p", { ctrl: true })); // a
        d.onKey(key("up")); // wraps to d
        d.onKey(key("enter"));
        expect(await d.done).toBe("d");
    });

    test("the initial option selects an item", async () => {
        const d = new SelectDialog({ items, initial: 3 });
        d.onKey(key("enter"));
        expect(await d.done).toBe("d");
    });

    test("number keys pick items directly when not searchable", async () => {
        const d = new SelectDialog({ items });
        d.onKey(text("4"));
        expect(await d.done).toBe("d");
    });

    test("number keys for a disabled or missing item are ignored", async () => {
        const d = new SelectDialog({ items });
        d.onKey(text("2")); // beta is disabled
        d.onKey(text("9")); // no 9th item
        d.onKey(text("0"));
        expect(await settled(d.done)).toBe(PENDING);
        d.onKey(text("3"));
        expect(await d.done).toBe("g");
    });

    test("Enter on a disabled item does not resolve", async () => {
        const d = new SelectDialog({ items: [{ label: "x", value: 1, disabled: true }] });
        d.onKey(key("enter"));
        expect(await settled(d.done)).toBe(PENDING);
    });

    test("searchable: typing filters, digits are search text, backspace and ctrl+u edit the query", async () => {
        const d = new SelectDialog({
            items: [...items, { label: "item 2", value: "i2" }],
            searchable: true,
        });
        d.onKey(text("del"));
        expect(d.list.query).toBe("del");
        expect(d.list.filtered().map((x) => x.item.value)).toEqual(["d"]);
        expect(plain(d.render(60, 30)).some((l) => l.includes("Search: del"))).toBe(true);
        d.onKey(key("backspace"));
        expect(d.list.query).toBe("de");
        d.onKey(key("u", { ctrl: true }));
        expect(d.list.query).toBe("");
        d.onKey(text("2"));
        expect(await settled(d.done)).toBe(PENDING);
        expect(d.list.query).toBe("2");
        d.onKey(key("enter"));
        expect(await d.done).toBe("i2");
    });

    test("searchable: Enter picks the best match", async () => {
        const d = new SelectDialog({ items, searchable: true });
        type(d, "gam");
        type(d, "\r");
        expect(await d.done).toBe("g");
    });

    test("multi-select: space and number keys toggle, Enter returns the selected values in list order", async () => {
        const d = new SelectDialog({ items, multi: true });
        d.onKey(text("4")); // toggles delta
        d.onKey(key("up")); // gamma
        d.onKey(text(" "));
        d.onKey(text("1")); // toggles alpha
        const out = plain(d.render(60, 30));
        expect(out.some((l) => l.includes("◉ alpha"))).toBe(true);
        expect(out.some((l) => l.includes("○ beta"))).toBe(true);
        d.onKey(key("enter"));
        expect(await d.done).toEqual(["a", "g", "d"]);
    });

    test("multi-select with nothing toggled returns the highlighted item as an array", async () => {
        const d = new SelectDialog({ items, multi: true, initial: 2 });
        d.onKey(key("enter"));
        expect(await d.done).toEqual(["g"]);
    });

    test("choose() resolves with any value, e.g. from an extra-key handler", async () => {
        const d = new SelectDialog<string>({
            items,
            onExtraKey: (k, dlg) => {
                if (k.name === "right") {
                    dlg.choose("custom");
                    return true;
                }
                return false;
            },
        });
        d.onKey(key("right"));
        expect(await d.done).toBe("custom");
    });

    test("an extra-key handler that returns true swallows the key", async () => {
        const d = new SelectDialog({ items, onExtraKey: (k) => k.name === "enter" });
        d.onKey(key("enter"));
        expect(await settled(d.done)).toBe(PENDING);
        d.onKey(key("escape"));
        expect(await d.done).toBeUndefined();
    });

    test("keys from the real parser drive the dialog (down arrow, Enter)", async () => {
        const d = new SelectDialog({ items });
        type(d, "\x1b[B\x1b[B\r");
        expect(await d.done).toBe("d");
    });

    test("a lone ESC from the parser cancels after flushEscape", async () => {
        const d = new SelectDialog({ items });
        type(d, "\x1b");
        expect(await d.done).toBeUndefined();
    });

    test("render shows title, header, items, footer and a hint inside a frame", () => {
        const d = new SelectDialog({ title: "Pick one", header: ["Header text"], footer: ["Footer text"], items });
        const out = plain(d.render(60, 30));
        expect(out[0]!.startsWith("╭")).toBe(true);
        expect(out[out.length - 1]!.startsWith("╰")).toBe(true);
        const body = out.join("\n");
        for (const s of ["Pick one", "Header text", "Footer text", "1. alpha", "4. delta", "the fourth letter", "enter to confirm"]) expect(body).toContain(s);
    });

    test("render without a border", () => {
        const d = new SelectDialog({ title: "T", items, border: false });
        const out = plain(d.render(60, 30));
        expect(out.some((l) => l.includes("╭"))).toBe(false);
        for (const l of out) expect(l.startsWith(" ")).toBe(true);
    });

    test("a long list scrolls inside the available rows", () => {
        const many = Array.from({ length: 50 }, (_, i) => ({ label: `item ${i}`, value: i }));
        const d = new SelectDialog({ items: many, maxRows: 5 });
        for (let i = 0; i < 30; i++) d.onKey(key("down"));
        const out = plain(d.render(60, 40));
        expect(out.filter((l) => /item \d+/.test(l))).toHaveLength(5);
        expect(out.some((l) => l.includes("❯ 31. item 30"))).toBe(true);
    });
});

describe("InputDialog", () => {
    test("typing and Enter resolve with the value", async () => {
        const d = new InputDialog({ title: "Name" });
        type(d, "hello");
        d.onKey(key("enter"));
        expect(await d.done).toBe("hello");
    });

    test("initial value and editing keys", async () => {
        const d = new InputDialog({ title: "Name", initial: "world" });
        d.onKey(key("home"));
        d.onKey(text("hello "));
        d.onKey(key("end"));
        d.onKey(key("backspace"));
        d.onKey(key("left"));
        d.onKey(key("delete"));
        d.onKey(key("enter"));
        expect(await d.done).toBe("hello wor");
    });

    test("Escape resolves with undefined", async () => {
        const d = new InputDialog({ title: "Name" });
        type(d, "abc");
        d.onKey(key("escape"));
        expect(await d.done).toBeUndefined();
    });

    test("validate keeps the dialog open and shows the error until the input is valid", async () => {
        const d = new InputDialog({ title: "Key", validate: (v) => (v.startsWith("sk-") ? undefined : "must start with sk-") });
        type(d, "abc");
        d.onKey(key("enter"));
        expect(await settled(d.done)).toBe(PENDING);
        expect(d.error).toBe("must start with sk-");
        expect(plain(d.render(60)).some((l) => l.includes("must start with sk-"))).toBe(true);

        d.onKey(key("home")); // any edit clears the error
        expect(d.error).toBeUndefined();
        expect(plain(d.render(60)).some((l) => l.includes("must start with sk-"))).toBe(false);

        d.onKey(text("sk-"));
        d.onKey(key("enter"));
        expect(await d.done).toBe("sk-abc");
    });

    test("multiline: shift/meta+enter insert a newline, plain Enter submits", async () => {
        const d = new InputDialog({ title: "Msg", multiline: true });
        d.onKey(text("a"));
        d.onKey(key("enter", { shift: true }));
        d.onKey(text("b"));
        d.onKey(key("enter", { meta: true }));
        d.onKey(text("c"));
        d.onKey(key("enter"));
        expect(await d.done).toBe("a\nb\nc");
    });

    test("pastes are inserted, and large pastes expand in the result", async () => {
        const big = Array.from({ length: 20 }, (_, i) => `row ${i}`).join("\n");
        const d = new InputDialog({ title: "Paste" });
        type(d, `\x1b[200~${big}\x1b[201~`);
        expect(plain(d.render(60)).some((l) => l.includes("[Pasted text #1 +20 lines]"))).toBe(true);
        d.onKey(key("enter"));
        expect(await d.done).toBe(big);
    });

    test("secret mode never renders the plaintext (typed or pasted)", async () => {
        const d = new InputDialog({ title: "API key", secret: true });
        type(d, "sk-ant-");
        type(d, "\x1b[200~api03-SECRETVALUE\x1b[201~");
        for (const cols of [40, 80, 120]) {
            const out = d.render(cols).join("\n");
            expect(out).not.toContain("SECRET");
            expect(out).not.toContain("sk-ant");
            expect(stripAnsi(out)).toContain("•".repeat(24));
        }
        d.onKey(key("enter"));
        expect(await d.done).toBe("sk-ant-api03-SECRETVALUE");
    });

    test("placeholder is shown when empty", () => {
        const d = new InputDialog({ title: "T", placeholder: "Type here" });
        expect(plain(d.render(60)).some((l) => l.includes("> Type here"))).toBe(true);
    });
});

describe("MessageDialog", () => {
    test("Escape and ctrl+c call onCancel", () => {
        let n = 0;
        const d = new MessageDialog(["Checking key…"], theme.permission, () => n++);
        d.onKey(key("escape"));
        d.onKey(key("c", { ctrl: true }));
        d.onKey(key("enter"));
        expect(n).toBe(2);
        expect(plain(d.render(40)).some((l) => l.includes("Checking key…"))).toBe(true);
    });
});

describe("frame", () => {
    test("frameInner leaves room for the borders and the last column", () => {
        expect(frameInner(80)).toBe(75);
        expect(frameInner(40)).toBe(35);
        expect(frameInner(5)).toBe(10); // minimum
    });

    test("frame pads every row to the same width and wraps long lines", () => {
        const out = frame(["a".repeat(50), "short"], 40, (s) => s);
        expect(out.map(width)).toEqual(Array(out.length).fill(39));
        expect(plain(out)).toEqual([
            "╭─────────────────────────────────────╮",
            "│ " + "a".repeat(35) + " │",
            "│ " + "a".repeat(15) + " ".repeat(20) + " │",
            "│ short" + " ".repeat(30) + " │",
            "╰─────────────────────────────────────╯",
        ]);
    });
});

describe("every rendered line fits in cols - 1", () => {
    const longWord = "x".repeat(300);
    const longWords = "lorem ipsum dolor sit amet ".repeat(12);
    const cjk = "日本語のテキスト".repeat(20);
    const emoji = "😀👍🏽👨‍👩‍👧".repeat(30);
    const styled = theme.error("error: ") + theme.code("`" + longWord + "`") + " " + theme.link("https://example.com/" + "p".repeat(150));
    const tabbed = "col\tcol\tcol";
    const longItems: SelectItem<number>[] = [
        { label: longWord, value: 1, description: longWords, detail: "detail" },
        { label: cjk, value: 2, description: emoji, group: "G".repeat(200) },
        { label: "short", value: 3, detail: longWord },
        { label: emoji, value: 4, disabled: true },
    ];

    function dialogs(): { name: string; render: (cols: number) => string[] }[] {
        const sel = (o: Partial<SelectDialogOptions<number>>) => new SelectDialog<number>({ items: longItems, ...o });
        const input = new InputDialog({ title: longWords, header: [longWord, cjk], placeholder: longWords, hint: longWords });
        input.editor.insert(longWord + " " + cjk + " " + emoji);
        const invalid = new InputDialog({ title: "T", validate: () => longWords + longWord });
        invalid.editor.insert("bad");
        invalid.onKey(key("enter"));
        const secret = new InputDialog({ title: "Key", secret: true, header: [styled] });
        secret.editor.insert(longWord);
        const searching = sel({ searchable: true });
        searching.onKey(text(longWord.slice(0, 40)));
        return [
            { name: "select with long title/header/footer", render: (c) => sel({ title: longWords + longWord, header: [longWords, longWord, cjk, emoji, styled, tabbed], footer: [longWord, longWords] }).render(c, 40) },
            { name: "select multi + numbers", render: (c) => sel({ multi: true, numbers: true, current: (v) => v === 3, hint: longWord }).render(c, 40) },
            { name: "select searchable with a long query", render: (c) => searching.render(c, 40) },
            {
                name: "select without border",
                render: (c) => new SelectDialog<number>({ items: longItems.map(({ group: _g, ...i }) => i), border: false, header: [longWords, longWord, cjk], footer: [longWord] }).render(c, 40),
            },
            { name: "select in few rows", render: (c) => sel({ title: "T" }).render(c, 5) },
            { name: "input with long content", render: (c) => input.render(c) },
            { name: "input with a long validation error", render: (c) => invalid.render(c) },
            { name: "secret input", render: (c) => secret.render(c) },
            { name: "message", render: (c) => new MessageDialog([longWords, longWord, cjk, emoji, styled]).render(c) },
            { name: "frame of raw lines", render: (c) => frame([longWord, longWords, cjk, emoji, styled, ""], c, theme.permission) },
        ];
    }

    for (const cols of [40, 80, 120]) {
        test(`cols = ${cols}`, () => {
            for (const d of dialogs()) {
                const out = d.render(cols);
                expect(out.length).toBeGreaterThan(0);
                for (const l of out) {
                    if (width(l) > cols - 1) throw new Error(`${d.name}: line of width ${width(l)} > ${cols - 1}: ${JSON.stringify(stripAnsi(l))}`);
                }
            }
        });
    }

    test("without a border, the title, hint, search line and group headers are wrapped or truncated too", () => {
        // border: false is not used by the app today; with the frame, frame() wraps these.
        for (const cols of [40, 80, 120]) {
            const d = new SelectDialog<number>({ title: longWords, items: longItems, border: false, multi: true, searchable: false });
            const s = new SelectDialog<number>({ items: longItems, border: false, searchable: true });
            s.onKey(text(longWord.slice(0, 150)));
            for (const l of [...d.render(cols, 40), ...s.render(cols, 40)]) expect(width(l)).toBeLessThanOrEqual(cols - 1);
        }
    });

    test("framed dialogs have rows of exactly cols - 1", () => {
        for (const cols of [40, 80, 120]) {
            const out = new SelectDialog({ title: "T", items, header: ["h"] }).render(cols, 30);
            expect(new Set(out.map(width))).toEqual(new Set([cols - 1]));
        }
    });
});

alsoRunInOtherColorMode(import.meta.path);
