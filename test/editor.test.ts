import { describe, expect, test } from "bun:test";
import { Editor } from "../src/ui/editor";
import { colorEnabled, inverse, stripAnsi, width } from "../src/ui/ansi";
import { alsoRunInOtherColorMode } from "./helpers/color-mode";

function editor(text = "", cursor = text.length): Editor {
    const e = new Editor();
    e.set(text, cursor);
    return e;
}

const plain = (lines: string[]) => lines.map(stripAnsi);

describe("insert / backspace / del", () => {
    test("insert at the cursor", () => {
        const e = new Editor();
        e.insert("hello");
        e.cursor = 0;
        e.insert(">> ");
        expect(e.text).toBe(">> hello");
        expect(e.cursor).toBe(3);
        expect(e.isEmpty).toBe(false);
    });

    test("insert of an empty string is a no-op", () => {
        const e = editor("abc", 1);
        e.insert("");
        expect(e.text).toBe("abc");
        expect(e.cursor).toBe(1);
    });

    test("backspace deletes the character before the cursor", () => {
        const e = editor("abc", 2);
        e.backspace();
        expect(e.text).toBe("ac");
        expect(e.cursor).toBe(1);
    });

    test("backspace at the start does nothing", () => {
        const e = editor("abc", 0);
        e.backspace();
        expect(e.text).toBe("abc");
        expect(e.cursor).toBe(0);
    });

    test("backspace removes a whole grapheme (emoji, combining mark)", () => {
        const a = editor("a😀b", 3);
        a.backspace();
        expect(a.text).toBe("ab");
        expect(a.cursor).toBe(1);
        const b = editor("e\u0301x", 2);
        b.backspace();
        expect(b.text).toBe("x");
        expect(b.cursor).toBe(0);
    });

    test("del removes the character after the cursor and keeps the cursor", () => {
        const e = editor("abc", 1);
        e.del();
        expect(e.text).toBe("ac");
        expect(e.cursor).toBe(1);
        e.cursor = 2;
        e.del(); // at end: no-op
        expect(e.text).toBe("ac");
    });

    test("del removes a whole emoji", () => {
        const e = editor("a😀b", 1);
        e.del();
        expect(e.text).toBe("ab");
    });

    test("clear empties the text", () => {
        const e = editor("abc");
        e.clear();
        expect(e.text).toBe("");
        expect(e.cursor).toBe(0);
        expect(e.isEmpty).toBe(true);
    });

    test("set clamps the cursor", () => {
        expect(editor("abc", 99).cursor).toBe(3);
        expect(editor("abc", -5).cursor).toBe(0);
    });
});

describe("cursor movement", () => {
    test("left/right move by one grapheme and stop at the edges", () => {
        const e = editor("a😀b", 0);
        e.left();
        expect(e.cursor).toBe(0);
        e.right();
        expect(e.cursor).toBe(1);
        e.right();
        expect(e.cursor).toBe(3); // over the surrogate pair
        e.right();
        expect(e.cursor).toBe(4);
        e.right();
        expect(e.cursor).toBe(4);
        e.left();
        e.left();
        expect(e.cursor).toBe(1);
    });

    test("wordLeft / wordRight jump over words and separators", () => {
        const e = editor("foo.bar  baz_qux", 16);
        e.wordLeft();
        expect(e.cursor).toBe(9); // start of baz_qux (underscore is a word char)
        e.wordLeft();
        expect(e.cursor).toBe(4); // start of bar
        e.wordLeft();
        expect(e.cursor).toBe(0);
        e.wordLeft();
        expect(e.cursor).toBe(0);
        e.wordRight();
        expect(e.cursor).toBe(3); // end of foo
        e.wordRight();
        expect(e.cursor).toBe(7); // end of bar
        e.wordRight();
        expect(e.cursor).toBe(16);
        e.wordRight();
        expect(e.cursor).toBe(16);
    });

    test("word movement treats non-ASCII letters as word characters", () => {
        const e = editor("héllo wörld");
        e.wordLeft();
        expect(e.cursor).toBe(6);
    });

    test("home/end move within the current line of multi-line text", () => {
        const e = editor("abc\ndefgh\nij", 6); // inside "defgh"
        e.home();
        expect(e.cursor).toBe(4);
        e.end();
        expect(e.cursor).toBe(9);
        e.cursor = 11;
        e.home();
        expect(e.cursor).toBe(10);
        e.end();
        expect(e.cursor).toBe(12);
        e.cursor = 1;
        e.end();
        expect(e.cursor).toBe(3);
    });

    test("onFirstLine / onLastLine", () => {
        const e = editor("a\nb\nc", 0);
        expect(e.onFirstLine).toBe(true);
        expect(e.onLastLine).toBe(false);
        e.cursor = 2;
        expect(e.onFirstLine).toBe(false);
        expect(e.onLastLine).toBe(false);
        e.cursor = 5;
        expect(e.onLastLine).toBe(true);
    });

    test("up/down keep the column, clamp to shorter lines, and return false at the edges", () => {
        const e = editor("abc\ndefgh\nij", 7); // 'g', column 3
        expect(e.up()).toBe(true);
        expect(e.cursor).toBe(3); // end of "abc"
        expect(e.up()).toBe(false);
        expect(e.cursor).toBe(3);

        e.cursor = 8; // 'h', column 4
        expect(e.down()).toBe(true);
        expect(e.cursor).toBe(12); // clamped to end of "ij"
        expect(e.down()).toBe(false);
        expect(e.cursor).toBe(12);
    });

    test("up/down on single-line text return false", () => {
        const e = editor("hello", 2);
        expect(e.up()).toBe(false);
        expect(e.down()).toBe(false);
        expect(e.cursor).toBe(2);
    });

    test("up/down use visual columns for wide characters", () => {
        const e = editor("日本語\nabcdef", 7); // 'd' at visual column 3 on line 2
        expect(e.up()).toBe(true);
        expect(e.cursor).toBe(1); // column 3 falls inside 本 (cols 2-3)
        expect(e.down()).toBe(true);
        expect(e.cursor).toBe(4 + 2); // column 2 on line 2
    });
});

describe("kill ring", () => {
    test("killToEnd kills to end of line, then joins lines when at the end", () => {
        const e = editor("one\ntwo three\nfour", 9);
        e.killToEnd();
        expect(e.text).toBe("one\ntwo t\nfour");
        expect(e.cursor).toBe(9);
        e.killToEnd();
        expect(e.text).toBe("one\ntwo tfour");
        e.yank();
        expect(e.text).toBe("one\ntwo t\nfour");
        expect(e.cursor).toBe(10);
    });

    test("killToStart kills to the start of the line and yank restores it", () => {
        const e = editor("foo bar baz", 7);
        e.killToStart();
        expect(e.text).toBe(" baz");
        expect(e.cursor).toBe(0);
        e.yank();
        expect(e.text).toBe("foo bar baz");
        expect(e.cursor).toBe(7);
    });

    test("killToStart only affects the current line", () => {
        const e = editor("first\nsecond", 9);
        e.killToStart();
        expect(e.text).toBe("first\nond");
        expect(e.cursor).toBe(6);
    });

    test("killWordLeft / killWordRight", () => {
        const e = editor("foo bar baz");
        e.killWordLeft();
        expect(e.text).toBe("foo bar ");
        expect(e.cursor).toBe(8);
        e.yank();
        expect(e.text).toBe("foo bar baz");

        const r = editor("foo bar baz", 4);
        r.killWordRight();
        expect(r.text).toBe("foo  baz");
        expect(r.cursor).toBe(4);
        r.cursor = 0;
        r.yank();
        expect(r.text).toBe("barfoo  baz");
    });

    test("yank with an empty kill ring does nothing", () => {
        const e = editor("abc");
        e.yank();
        expect(e.text).toBe("abc");
    });

    test("a kill that removes nothing does not clobber the kill ring", () => {
        const e = editor("abc def", 3);
        e.killToEnd(); // kills " def"
        e.killToEnd(); // at the very end: nothing to kill
        e.yank();
        expect(e.text).toBe("abc def");
    });
});

describe("undo", () => {
    test("undo reverts edits step by step", () => {
        const e = new Editor();
        e.insert("hello");
        e.backspace();
        e.backspace();
        expect(e.text).toBe("hel");
        e.undo();
        expect(e.text).toBe("hell");
        e.undo();
        expect(e.text).toBe("hello");
        e.undo();
        expect(e.text).toBe("");
        e.undo(); // empty stack: no-op
        expect(e.text).toBe("");
    });

    test("consecutive typing coalesces into one undo step, whitespace starts a new one", () => {
        const e = new Editor();
        e.insert("abc");
        e.insert("def");
        e.insert(" ");
        e.insert("ghi");
        e.undo();
        expect(e.text).toBe("abcdef ");
        e.undo();
        expect(e.text).toBe("");
    });

    test("undo restores the cursor", () => {
        const e = editor("hello world", 5);
        e.killToEnd();
        e.undo();
        expect(e.text).toBe("hello world");
        expect(e.cursor).toBe(5);
    });

    test("moving left/right breaks the typing group", () => {
        const e = new Editor();
        e.insert("hello");
        e.left();
        e.insert("X");
        e.undo();
        expect(e.text).toBe("hello");
    });

    test("moving with home/wordLeft also breaks the typing group (like left/right do)", () => {
        const a = new Editor();
        a.insert("hello");
        a.home();
        a.insert("X");
        a.undo();
        expect(a.text).toBe("hello");

        const b = new Editor();
        b.insert("foo");
        b.wordLeft();
        b.insert("Y");
        b.undo();
        expect(b.text).toBe("foo");
    });

    test("typing after a kill is undone separately from the kill", () => {
        const e = new Editor();
        e.insert("abc");
        e.killToStart();
        e.insert("x");
        e.undo();
        expect(e.text).toBe(""); // the state right after the kill
    });

    test("undoing a paste keeps the text typed before it", () => {
        const e = new Editor();
        e.insert("abc");
        e.paste("x".repeat(1600));
        e.undo();
        expect(e.text).toBe("abc");
    });
});

describe("history", () => {
    test("historyPrev walks back from the newest entry and saves the draft", () => {
        const e = new Editor();
        e.setHistory(["first", "second"]);
        e.insert("draft");
        expect(e.historyPrev()).toBe(true);
        expect(e.text).toBe("second");
        expect(e.cursor).toBe(6);
        expect(e.historyPrev()).toBe(true);
        expect(e.text).toBe("first");
        expect(e.historyPrev()).toBe(false);
        expect(e.text).toBe("first");
    });

    test("historyNext walks forward and restores the draft at the end", () => {
        const e = new Editor();
        e.setHistory(["first", "second"]);
        e.insert("my draft");
        e.historyPrev();
        e.historyPrev();
        expect(e.historyNext()).toBe(true);
        expect(e.text).toBe("second");
        expect(e.historyNext()).toBe(true);
        expect(e.text).toBe("my draft");
        expect(e.cursor).toBe(8);
        expect(e.historyNext()).toBe(false);
        expect(e.text).toBe("my draft");
    });

    test("with no history, prev/next return false and leave the text alone", () => {
        const e = editor("x");
        expect(e.historyPrev()).toBe(false);
        expect(e.historyNext()).toBe(false);
        expect(e.text).toBe("x");
    });

    test("pushHistory skips blanks and consecutive duplicates and resets navigation", () => {
        const e = new Editor();
        e.setHistory(["a"]);
        e.pushHistory("b");
        e.pushHistory("b");
        e.pushHistory("   ");
        e.pushHistory("");
        expect(e.historyPrev()).toBe(true);
        expect(e.text).toBe("b");
        expect(e.historyPrev()).toBe(true);
        expect(e.text).toBe("a");
        expect(e.historyPrev()).toBe(false);
        e.pushHistory("c");
        e.set("");
        expect(e.historyPrev()).toBe(true);
        expect(e.text).toBe("c");
    });

    test("setHistory copies the array", () => {
        const h = ["one"];
        const e = new Editor();
        e.setHistory(h);
        h.push("two");
        e.historyPrev();
        expect(e.text).toBe("one");
    });

    test("typing after recalling an entry restarts navigation from the newest entry", () => {
        const e = new Editor();
        e.setHistory(["a", "b"]);
        e.historyPrev();
        e.historyPrev();
        e.insert("!");
        expect(e.text).toBe("a!");
        expect(e.historyNext()).toBe(false);
        expect(e.historyPrev()).toBe(true);
        expect(e.text).toBe("b");
        e.historyNext();
        expect(e.text).toBe("a!"); // the edited text became the draft
    });
});

describe("paste placeholders", () => {
    const big = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");

    test("a large paste collapses into a placeholder while value() returns the full text", () => {
        const e = new Editor();
        e.insert("before ");
        e.paste(big);
        e.insert(" after");
        expect(e.text).toBe("before [Pasted text #1 +20 lines] after");
        expect(e.value()).toBe(`before ${big} after`);
    });

    test("a long single-line paste (> 1500 chars) also collapses", () => {
        const e = new Editor();
        const long = "x".repeat(2000);
        e.paste(long);
        expect(e.text).toBe("[Pasted text #1 +1 lines]");
        expect(e.value()).toBe(long);
    });

    test("small pastes are inserted inline", () => {
        const e = new Editor();
        e.paste("small\npaste");
        expect(e.text).toBe("small\npaste");
        expect(e.cursor).toBe(11);
        expect(e.value()).toBe("small\npaste");
    });

    test("the 8-line boundary: 8 lines inline, 9 lines collapse", () => {
        const eight = Array.from({ length: 8 }, (_, i) => `l${i}`).join("\n");
        const nine = Array.from({ length: 9 }, (_, i) => `l${i}`).join("\n");
        const a = new Editor();
        a.paste(eight);
        expect(a.text).toBe(eight);
        const b = new Editor();
        b.paste(nine);
        expect(b.text).toBe("[Pasted text #1 +9 lines]");
    });

    test("multiple pastes get distinct ids and expand independently", () => {
        const other = Array.from({ length: 10 }, (_, i) => `other ${i}`).join("\n");
        const e = new Editor();
        e.paste(big);
        e.insert(" and ");
        e.paste(other);
        expect(e.text).toBe("[Pasted text #1 +20 lines] and [Pasted text #2 +10 lines]");
        expect(e.value()).toBe(`${big} and ${other}`);
    });

    test("backspace right after a placeholder deletes it whole", () => {
        const e = new Editor();
        e.insert("hi ");
        e.paste(big);
        e.backspace();
        expect(e.text).toBe("hi ");
        expect(e.cursor).toBe(3);
        expect(e.value()).toBe("hi ");
    });

    test("backspace inside a placeholder deletes a single character", () => {
        const e = new Editor();
        e.paste(big);
        e.cursor = 5;
        e.backspace();
        expect(e.text).toBe("[Pased text #1 +20 lines]");
    });

    test("secret mode never collapses pastes and strips whitespace", () => {
        const e = new Editor();
        e.secret = true;
        e.paste("sk-abc def\nghi");
        expect(e.text).toBe("sk-abcdefghi");
        const long = "k".repeat(2000);
        e.paste(long);
        expect(e.value()).toBe("sk-abcdefghi" + long);
        expect(e.text).not.toContain("[Pasted");
    });
});

describe("tokenAtCursor / replaceRange", () => {
    test("tokenAtCursor returns the word before the cursor up to the last whitespace", () => {
        expect(editor("see @src/ma").tokenAtCursor()).toEqual({ start: 4, text: "@src/ma" });
        expect(editor("see @src/ma rest", 11).tokenAtCursor()).toEqual({ start: 4, text: "@src/ma" });
        expect(editor("x ").tokenAtCursor()).toEqual({ start: 2, text: "" });
        expect(editor("").tokenAtCursor()).toEqual({ start: 0, text: "" });
        expect(editor("line1\n/cmd").tokenAtCursor()).toEqual({ start: 6, text: "/cmd" });
    });

    test("replaceRange replaces and puts the cursor after the inserted text", () => {
        const e = editor("see @src/ma rest", 11);
        const t = e.tokenAtCursor();
        e.replaceRange(t.start, t.start + t.text.length, "@src/main.ts");
        expect(e.text).toBe("see @src/main.ts rest");
        expect(e.cursor).toBe(16);
        e.undo();
        expect(e.text).toBe("see @src/ma rest");
    });
});

describe("render", () => {
    const opts = { showCursor: true };

    test("short text renders on one line with the prefix", () => {
        const e = editor("hello", 0);
        const r = e.render(40, "> ", "  ", opts);
        expect(plain(r.lines)).toEqual(["> hello"]);
        expect(r.cursorRow).toBe(0);
    });

    test("long text wraps at cols minus the prefix width; continuation rows use restPrefix", () => {
        const e = editor("abcdefghijklmnopqrstuvwxyz", 5);
        const r = e.render(12, "> ", "  ", opts);
        expect(plain(r.lines)).toEqual(["> abcdefghij", "  klmnopqrst", "  uvwxyz"]);
        expect(r.cursorRow).toBe(0);
        for (const l of r.lines) expect(width(l)).toBeLessThanOrEqual(12);
    });

    test("cursorRow follows the cursor across wrapped and logical lines", () => {
        const e = editor("abcdefghijklmnopqrstuvwxyz", 15);
        expect(e.render(12, "> ", "  ", opts).cursorRow).toBe(1);
        e.cursor = 26;
        expect(e.render(12, "> ", "  ", opts).cursorRow).toBe(2);
        const m = editor("line one\nline two\nthree", 12); // on "line two"
        const r = m.render(40, "> ", "  ", opts);
        expect(plain(r.lines)).toEqual(["> line one", "  line two", "  three"]);
        expect(r.cursorRow).toBe(1);
    });

    test("a cursor at the end of a full row moves to a new row", () => {
        const e = editor("abcdefghij");
        const r = e.render(12, "> ", "  ", opts);
        expect(r.lines).toHaveLength(2);
        expect(r.cursorRow).toBe(1);
        expect(stripAnsi(r.lines[0]!)).toBe("> abcdefghij");
    });

    test("the end-of-text cursor is a visible cell (inverse space)", () => {
        const e = editor("abc");
        const r = e.render(40, "> ", "  ", opts);
        expect(r.lines[0]).toBe("> abc" + inverse(" "));
    });

    test("the cursor cell is rendered inverse when colors are on", () => {
        const e = editor("abc", 1);
        const r = e.render(40, "> ", "  ", opts);
        expect(r.lines[0]).toBe("> a" + inverse("b") + "c");
        if (colorEnabled) expect(r.lines[0]).toContain("\x1b[7m");
    });

    test("showCursor: false renders plain text", () => {
        const e = editor("abc", 1);
        expect(e.render(40, "> ", "  ", { showCursor: false }).lines).toEqual(["> abc"]);
    });

    test("wide characters wrap without splitting and every row fits", () => {
        const e = editor("日本語テキスト", 2);
        const r = e.render(10, "> ", "  ", opts);
        expect(plain(r.lines)).toEqual(["> 日本語テ", "  キスト"]);
        for (const l of r.lines) expect(width(l)).toBeLessThanOrEqual(10);
    });

    test("rows never exceed cols for assorted text", () => {
        const samples = ["a b c ".repeat(30), "x".repeat(100), "😀".repeat(40), "mixed 日本 text 😀 ".repeat(8), "a\n\nb\n" + "y".repeat(50)];
        for (const s of samples) {
            for (const cols of [8, 13, 40, 81]) {
                for (const cursor of [0, Math.floor(s.length / 2), s.length]) {
                    const e = editor(s, cursor);
                    // keep the cursor on a grapheme boundary
                    if (cursor !== 0 && cursor !== s.length) {
                        e.cursor = 0;
                        while (e.cursor < cursor) e.right();
                    }
                    const r = e.render(cols, "> ", "  ", opts);
                    for (const l of r.lines) expect(width(l)).toBeLessThanOrEqual(cols);
                    expect(r.cursorRow).toBeGreaterThanOrEqual(0);
                    expect(r.cursorRow).toBeLessThan(r.lines.length);
                }
            }
        }
    });

    test("placeholder is shown when empty", () => {
        const e = new Editor();
        expect(plain(e.render(40, "> ", "  ", { showCursor: true, placeholder: "Type here" }).lines)).toEqual(["> Type here"]);
        expect(plain(e.render(40, "> ", "  ", { showCursor: false, placeholder: "Type here" }).lines)).toEqual(["> Type here"]);
        expect(e.render(40, "> ", "  ", { showCursor: true }).lines).toEqual(["> " + inverse(" ")]);
    });

    test("secret mode renders bullets and never the plaintext", () => {
        const e = new Editor();
        e.secret = true;
        e.insert("sk-ant-SECRET-123");
        for (const cols of [10, 40]) {
            const r = e.render(cols, "> ", "  ", opts);
            const all = r.lines.join("\n");
            const visible = plain(r.lines).join("");
            expect(all).not.toContain("SECRET");
            expect(all).not.toContain("sk-");
            expect(visible.replace(/[> ]/g, "")).toBe("•".repeat(17));
        }
        expect(e.value()).toBe("sk-ant-SECRET-123");
    });

    test("secret mode masks one bullet per code point and keeps the cursor position", () => {
        const e = new Editor();
        e.secret = true;
        e.insert("p😀ss");
        e.left();
        const r = e.render(40, "> ", "  ", opts);
        expect(stripAnsi(r.lines[0]!)).toBe("> ••••");
        expect(r.lines[0]).toBe("> •••" + inverse("•"));
    });
});

alsoRunInOtherColorMode(import.meta.path);
