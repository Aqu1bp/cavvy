import { describe, expect, test } from "bun:test";
import { bold, colorEnabled, padEnd, padStart, sanitizeLine, stripAnsi, truncate, width, wrapLine, wrapText } from "../src/ui/ansi";
import { alsoRunInOtherColorMode } from "./helpers/color-mode";

// Raw escape sequences, independent of colorEnabled.
const red = (s: string) => `\x1b[31m${s}\x1b[39m`;
const osc8 = (text: string, url: string) => `\x1b]8;;${url}\x1b\\${text}\x1b]8;;\x1b\\`;
const OSC8_CLOSE = "\x1b]8;;\x1b\\";

/** Deterministic PRNG so fuzz cases are reproducible. */
function rng(seed: number) {
    let s = seed >>> 0;
    return () => (s = (s * 1103515245 + 12345) >>> 0) / 2 ** 32;
}

function randomStyled(r: () => number): string {
    const parts = ["a", "b", "c", " ", " ", "日", "😀", "\x1b[31m", "\x1b[39m", "\x1b[1m", "\x1b[22m", "xyz", "longwordlongword", "é"];
    let s = "";
    const n = 1 + Math.floor(r() * 40);
    for (let i = 0; i < n; i++) s += parts[Math.floor(r() * parts.length)];
    return s;
}

describe("width", () => {
    test("plain ASCII", () => {
        expect(width("")).toBe(0);
        expect(width("abc")).toBe(3);
    });

    test("SGR escape codes have zero width", () => {
        expect(width(red("abc"))).toBe(3);
        expect(width("\x1b[1m\x1b[38;2;10;20;30mab\x1b[0m")).toBe(2);
        expect(width(bold("abc"))).toBe(3);
    });

    test("OSC 8 hyperlinks count only their text (ST and BEL terminators)", () => {
        expect(width(osc8("link", "https://example.com/some/long/path"))).toBe(4);
        expect(width("\x1b]8;;http://a\x07link\x1b]8;;\x07")).toBe(4);
    });

    test("CJK characters are width 2", () => {
        expect(width("日本")).toBe(4);
        expect(width("日本語テキスト")).toBe(14);
        expect(width("a日b")).toBe(4);
    });

    test("emoji are width 2, including modifiers and ZWJ sequences", () => {
        expect(width("😀")).toBe(2);
        expect(width("👍🏽")).toBe(2);
        expect(width("👨‍👩‍👧")).toBe(2);
    });

    test("combining marks add no width", () => {
        expect(width("e\u0301")).toBe(1);
    });
});

describe("stripAnsi", () => {
    test("removes SGR and OSC 8 sequences and keeps the text", () => {
        expect(stripAnsi(red("abc"))).toBe("abc");
        expect(stripAnsi(osc8("link", "https://x.y"))).toBe("link");
        expect(stripAnsi("\x1b]8;;http://a\x07link\x1b]8;;\x07")).toBe("link");
        expect(stripAnsi("plain")).toBe("plain");
    });

    test.each([
        ["CSI with private parameters", "\x1b[?25lx\x1b[?25h", "x"],
        ["CSI > (modifyOtherKeys)", "\x1b[>4;2mx", "x"],
        ["CSI < (SGR mouse report)", "\x1b[<0;10;20Mx", "x"],
        ["CSI = ", "\x1b[=5ux", "x"],
        ["cursor movement / clear", "\x1b[2J\x1b[1;1Hx\x1b[K", "x"],
        ["OSC with BEL", "\x1b]0;title\x07x", "x"],
        ["OSC with ST", "\x1b]2;title\x1b\\x", "x"],
        ["OSC without terminator", "x\x1b]0;unterminated title", "x"],
        ["OSC cut short by the next escape", "\x1b]0;title\x1b[31mx", "x"],
        ["DCS", "\x1bPq#0;2;0;0;0~~\x1b\\x", "x"],
        ["SOS", "\x1bX sos \x1b\\x", "x"],
        ["PM", "\x1b^pm\x1b\\x", "x"],
        ["APC", "\x1b_apc\x1b\\x", "x"],
        ["ESC c (full reset)", "a\x1bcb", "ab"],
        ["ESC 7 / ESC 8 (save/restore cursor)", "\x1b7x\x1b8", "x"],
        ["ESC ( B (charset)", "\x1b(Bx", "x"],
        ["ESC = / ESC >", "\x1b=x\x1b>", "x"],
        ["trailing lone ESC", "x\x1b", "x"],
        ["ESC ESC", "\x1b\x1b[31mx", "x"],
    ])("removes %s", (_name, input, expected) => {
        expect(stripAnsi(input)).toBe(expected);
    });

    test("an incomplete CSI drops only the introducer", () => {
        expect(stripAnsi("\x1b[31")).toBe("31");
    });

    test("leaves C0 control characters that are not escapes alone", () => {
        expect(stripAnsi("a\tb\nc")).toBe("a\tb\nc");
    });
});

describe("sanitizeLine", () => {
    // Every ESC left in sanitized output must start an SGR or a terminated
    // OSC 8 sequence; no other C0/C1 control may survive except \n.
    const SAFE_SEQ = /\x1b\[[0-9;:]*m|\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g;
    function assertSafe(out: string) {
        const rest = out.replace(SAFE_SEQ, "");
        expect(rest).not.toMatch(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/);
    }

    test("plain text is returned unchanged (same string)", () => {
        const s = "hello, world · 日本 😀";
        expect(sanitizeLine(s)).toBe(s);
        expect(sanitizeLine("")).toBe("");
    });

    test("keeps SGR colors, including 256/truecolor and colon sub-parameters", () => {
        for (const s of [red("red"), "\x1b[38;2;1;2;3mx\x1b[0m", "\x1b[38;5;196m\x1b[48;5;21mboth\x1b[0m", "\x1b[4:3mcurly\x1b[24m", "\x1b[mreset"]) {
            expect(sanitizeLine(s)).toBe(s);
        }
    });

    test("keeps ST-terminated OSC 8 hyperlinks, with or without params", () => {
        const a = osc8("link", "https://example.com");
        expect(sanitizeLine(a)).toBe(a);
        const b = "\x1b]8;id=7;https://e.com\x1b\\L\x1b]8;;\x1b\\";
        expect(sanitizeLine(b)).toBe(b);
    });

    test("keeps BEL-terminated OSC 8 hyperlinks intact (does not strip their terminators)", () => {
        // e.g. GNU `ls --hyperlink` output. Removing the BELs leaves an
        // unterminated OSC, so the terminal swallows the link text and
        // everything printed after it.
        const s = "\x1b]8;;file:///tmp/a.txt\x07a.txt\x1b]8;;\x07 next";
        const out = sanitizeLine(s);
        expect(stripAnsi(out)).toBe("a.txt next");
        expect(width(out)).toBe(10);
        assertSafe(out);
        expect(sanitizeLine(out)).toBe(out);
    });

    test.each([
        ["clipboard write OSC 52 (BEL)", "\x1b]52;c;SGVsbG8=\x07after", "after"],
        ["clipboard write OSC 52 (ST)", "\x1b]52;c;SGVsbG8=\x1b\\after", "after"],
        ["clipboard OSC 52 hidden inside an unterminated OSC 8", "\x1b]8;;x\x1b]52;c;QUJD\x07y", "y"],
        ["window title OSC 0", "\x1b]0;evil title\x07after", "after"],
        ["window title OSC 2 (ST)", "\x1b]2;evil\x1b\\after", "after"],
        ["unterminated title OSC", "\x1b]0;unterminated title", ""],
        ["color query OSC 10", "\x1b]10;?\x07x", "x"],
        ["full reset ESC c", "before\x1bcafter", "beforeafter"],
        ["save/restore cursor ESC 7 / ESC 8", "\x1b7saved\x1b8", "saved"],
        ["charset ESC ( B", "\x1b(Bascii", "ascii"],
        ["8-bit CSI \\x9b (introducer dropped, params left as text)", "\x9b2Jtext", "2Jtext"],
        ["8-bit OSC \\x9d", "\x9d0;t\x07x", "0;tx"],
        ["other C1 controls (NEL, RI)", "\x85nel\x8dri", "nelri"],
        ["trailing lone ESC", "trailing\x1b", "trailing"],
        ["ESC ESC before a color", "\x1b\x1b[31mx", "\x1b[31mx"],
        ["clear screen + home", "\x1b[2J\x1b[Hcleared", "cleared"],
        ["cursor hide/show", "\x1b[?25lhidden\x1b[?25h", "hidden"],
        ["cursor position report request", "\x1b[6nx", "x"],
        ["cursor movement", "\x1b[1;1H\x1b[5Amove", "move"],
        ["modifyOtherKeys (CSI > ... m is not SGR)", "\x1b[>4;2mok", "ok"],
        ["bracketed paste markers", "\x1b[200~paste\x1b[201~", "paste"],
        ["DCS (sixel)", "\x1bPq#0;2;0;0;0~~\x1b\\sixel", "sixel"],
        ["DCS request", "\x1bP$q m\x1b\\", ""],
        ["SOS / PM / APC", "\x1bXsos\x1b\\a\x1b^pm\x1b\\b\x1b_apc\x1b\\c", "abc"],
        ["unterminated APC", "\x1b_apc unterminated", ""],
        ["carriage return", "carriage\rreturn", "carriagereturn"],
        ["BEL, backspace, DEL, NUL", "bell\x07 back\x08space del\x7f nul\x00", "bell backspace del nul"],
        ["incomplete CSI", "\x1b[31", "31"],
    ])("drops %s", (_name, input, expected) => {
        const out = sanitizeLine(input);
        expect(out).toBe(expected);
        assertSafe(out);
    });

    test("expands tabs to 4 spaces", () => {
        expect(sanitizeLine("a\tb")).toBe("a    b");
        expect(sanitizeLine("\t\tx")).toBe("        x");
        expect(sanitizeLine("日本\t😀")).toBe("日本    😀");
    });

    test("keeps newlines (callers split on them)", () => {
        expect(sanitizeLine("keep\nnewline")).toBe("keep\nnewline");
        expect(sanitizeLine("a\x1b[2J\nb")).toBe("a\nb");
    });

    test("keeps colors around dropped sequences", () => {
        expect(sanitizeLine(`\x1b[31mred\x1b]0;t\x07 still red\x1b[39m`)).toBe("\x1b[31mred still red\x1b[39m");
        expect(sanitizeLine("\x1b]0;title\x1b[31mred")).toBe("\x1b[31mred");
    });

    test("control characters inside a kept OSC 8 URL are removed without breaking the link", () => {
        const out = sanitizeLine("\x1b]8;;https://a\x08b\x1b\\L\x1b]8;;\x1b\\");
        expect(out).toBe(osc8("L", "https://ab"));
    });

    test("an OSC 8 without a terminator is dropped", () => {
        expect(sanitizeLine("\x1b]8;;https://a")).toBe("");
    });

    test("fuzz: output is always safe, idempotent, and keeps visible text of escape-free input", () => {
        const r = rng(2024);
        const parts = [
            "a", "b", " ", "日", "😀", "\t", "\n", "\r", "\x07", "\x08", "\x00", "\x7f", "\x9b", "\x9d", "\x85",
            "\x1b", "\x1b[", "\x1b[31m", "\x1b[0m", "\x1b[2J", "\x1b[?25l", "\x1b]", "\x1b]0;t", "\x1b]52;c;QQ==",
            "\x1b\\", "\x1bc", "\x1b7", "\x1b(B", "\x1bP", "\x1b_", "]8;;", "\x1b]8;;https://x", "\x1b]8;;\x1b\\", ";", "m", "~",
        ];
        for (let i = 0; i < 3000; i++) {
            let s = "";
            const n = Math.floor(r() * 25);
            for (let j = 0; j < n; j++) s += parts[Math.floor(r() * parts.length)];
            const out = sanitizeLine(s);
            // BEL-terminated OSC 8 links are a known bug (see above); skip them here.
            if (/\x1b\]8;[^\x07\x1b]*\x07/.test(s)) continue;
            const rest = out.replace(SAFE_SEQ, "");
            if (/[\x00-\x09\x0b-\x1f\x7f-\x9f]/.test(rest)) throw new Error(`unsafe output for ${JSON.stringify(s)}: ${JSON.stringify(out)}`);
            expect(sanitizeLine(out)).toBe(out);
            if (!/[\x1b\x9b\x9d]/.test(s)) expect(out).toBe(s.replace(/\t/g, "    ").replace(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g, ""));
        }
    });

    test("after sanitizing, width() matches the visible text", () => {
        for (const s of ["\x1b(B\x1b[mtext", "\x1b7x\x1b8", "a\tb", "\x1bPdcs\x1b\\x", red("r") + "\x1b]0;t\x07"]) {
            const out = sanitizeLine(s);
            expect(width(out)).toBe(Bun.stringWidth(stripAnsi(out)));
        }
    });

    test("width() agrees with stripAnsi for escapes Bun.stringWidth does not know (ESC ( B, ESC 7, DCS, APC)", () => {
        // `tput sgr0` emits "\x1b(B\x1b[m", common in colored tool output that
        // gets measured (truncate/wrapLine/padEnd) before Screen sanitizes it.
        for (const s of ["\x1b(B\x1b[mtext", "\x1b7x\x1b8", "a\x1bcb", "\x1bPdcs\x1b\\x", "\x1b_apc\x1b\\x"]) {
            expect(width(s)).toBe(Bun.stringWidth(stripAnsi(s)));
        }
    });

    test("text measured as fitting still fits after sanitizeLine expands its tabs", () => {
        // width() counts "\t" as 0 columns, sanitizeLine prints it as 4.
        expect(width(sanitizeLine(truncate("a\tb\tc", 6)))).toBeLessThanOrEqual(6);
        for (const l of wrapLine("col1\tcol2\tcol3\tcol4", 12)) expect(width(sanitizeLine(l))).toBeLessThanOrEqual(12);
        expect(width(sanitizeLine(padEnd("a\tb", 8)))).toBe(8);
    });
});

describe("truncate", () => {
    test("returns the input unchanged when it fits", () => {
        expect(truncate("hello", 5)).toBe("hello");
        expect(truncate(red("hello"), 5)).toBe(red("hello"));
    });

    // When colors are on, truncate() emits a reset before the ellipsis, so
    // compare the visible text.
    const cut = (s: string, max: number, ellipsis?: string) => stripAnsi(truncate(s, max, ellipsis));

    test("cuts and appends an ellipsis within the width", () => {
        expect(cut("hello world", 5)).toBe("hell…");
        expect(cut("hello", 4)).toBe("hel…");
        expect(cut("abc", 2)).toBe("a…");
        expect(cut("abc", 1)).toBe("…");
        expect(truncate("abc", 0)).toBe("");
        expect(truncate("abc", -3)).toBe("");
    });

    test("custom ellipsis", () => {
        expect(cut("hello world", 6, "...")).toBe("hel...");
        expect(cut("hello world", 4, "")).toBe("hell");
    });

    test("is ANSI-aware: escape codes do not count toward the width", () => {
        const t = truncate(red("hello world"), 6);
        expect(stripAnsi(t)).toBe("hello…");
        expect(t.startsWith("\x1b[31m")).toBe(true);
        expect(width(t)).toBe(6);
    });

    test("closes styles before the ellipsis when colors are on", () => {
        const t = truncate(red("hello world"), 6);
        if (colorEnabled) expect(t).toBe("\x1b[31mhello\x1b[0m…");
        else expect(t).toBe("\x1b[31mhello…");
    });

    test("never splits a wide character", () => {
        expect(cut("日本語テキスト", 5)).toBe("日本…");
        expect(cut("日本語テキスト", 4)).toBe("日…");
        expect(cut("😀😀😀", 3)).toBe("😀…");
    });

    test("never exceeds the max width (fuzz)", () => {
        const r = rng(42);
        for (let i = 0; i < 2000; i++) {
            const s = randomStyled(r);
            const max = Math.floor(r() * 25);
            const t = truncate(s, max);
            expect(width(t)).toBeLessThanOrEqual(Math.max(0, max));
            if (width(s) > max && max > 0) expect(stripAnsi(t).endsWith("…")).toBe(true);
            if (max > 0 && width(s) <= max) expect(t).toBe(s);
        }
    });

    test("cutting inside an OSC 8 hyperlink closes the link", () => {
        const t = truncate(osc8("a long link text", "https://example.com"), 8);
        expect(stripAnsi(t)).toBe("a long …");
        // An unclosed OSC 8 turns the rest of the terminal row into the link.
        const close = t.indexOf(OSC8_CLOSE);
        expect(close).toBeGreaterThan(t.indexOf("\x1b]8;;https://"));
        expect(close).toBeLessThan(t.indexOf("…"));
    });

    test("cutting after a hyperlink has closed adds no extra closer", () => {
        const t = truncate(osc8("ab", "https://e.com") + " and more text", 6);
        expect(stripAnsi(t)).toBe("ab an…");
        expect(t.split(OSC8_CLOSE).length - 1).toBe(1);
    });
});

describe("wrapLine", () => {
    test("returns short lines unchanged", () => {
        expect(wrapLine("hello", 10)).toEqual(["hello"]);
        expect(wrapLine("", 10)).toEqual([""]);
        expect(wrapLine(red("hello"), 5)).toEqual([red("hello")]);
    });

    test("cols <= 1 returns the line as-is", () => {
        expect(wrapLine("hello world", 1)).toEqual(["hello world"]);
        expect(wrapLine("hello world", 0)).toEqual(["hello world"]);
    });

    test("wraps at spaces, swallowing the break space", () => {
        expect(wrapLine("the quick brown fox jumps over the lazy dog", 10)).toEqual(["the quick", "brown fox", "jumps over", "the lazy", "dog"]);
        expect(wrapLine("hello world foo", 11)).toEqual(["hello world", "foo"]);
        expect(wrapLine("aaaaaaaaaa bbbbbbbbbb", 10)).toEqual(["aaaaaaaaaa", "bbbbbbbbbb"]);
    });

    test("hard-breaks words longer than the width", () => {
        expect(wrapLine("12345678901234567890", 10)).toEqual(["1234567890", "1234567890"]);
        expect(wrapLine("aaaaaaaaaaaaaaaaaaaaaaaaa", 10)).toEqual(["aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]);
    });

    test("a long word after a short one starts on its own line, with no empty lines", () => {
        expect(wrapLine("hi aaaaaaaaaaaaaaaaaaaaaaaaa", 10)).toEqual(["hi", "aaaaaaaaaa", "aaaaaaaaaa", "aaaaa"]);
        expect(wrapLine("ab cdefghijklmnopqrstuvwxyz", 10)).toEqual(["ab", "cdefghijkl", "mnopqrstuv", "wxyz"]);
        expect(wrapLine("xxxxxxxxx yyyyyyyyyyyyyyyyyyyyyy", 10)).toEqual(["xxxxxxxxx", "yyyyyyyyyy", "yyyyyyyyyy", "yy"]);
    });

    test("a word that exactly fills the line does not leave an empty line behind", () => {
        expect(wrapLine("abcdefghij k", 10)).toEqual(["abcdefghij", "k"]);
        expect(wrapLine("abcdefghij abcdefghij", 10)).toEqual(["abcdefghij", "abcdefghij"]);
    });

    test("wide characters are never split and each line fits", () => {
        const lines = wrapLine("日本語テキスト日本語テキスト", 7);
        expect(lines).toEqual(["日本語", "テキス", "ト日本", "語テキ", "スト"]);
        expect(wrapLine("😀😀😀😀😀😀😀", 5)).toEqual(["😀😀", "😀😀", "😀😀", "😀"]);
    });

    test("keeps ANSI styling: styles are re-opened on continuation lines", () => {
        const lines = wrapLine(red("the quick brown fox jumps over"), 10);
        expect(lines.map(stripAnsi)).toEqual(["the quick", "brown fox", "jumps over"]);
        for (const l of lines) expect(l.startsWith("\x1b[31m")).toBe(true);
    });

    test("closes styles at the end of every wrapped line when colors are on", () => {
        const lines = wrapLine(red("the quick brown fox jumps over"), 10);
        for (const l of lines.slice(0, -1)) {
            if (colorEnabled) expect(l.endsWith("\x1b[0m")).toBe(true);
        }
        expect(lines[lines.length - 1]!.endsWith("\x1b[39m")).toBe(true);
    });

    test("a style closed mid-line is not re-opened as active text", () => {
        const lines = wrapLine(`${red("aaaa")} bbbbbbbb`, 6);
        expect(lines.map(stripAnsi)).toEqual(["aaaa", "bbbbbb", "bb"]);
    });

    test("OSC 8 hyperlinks wrap by their visible text", () => {
        const lines = wrapLine(osc8("click here for the docs page", "https://example.com/docs"), 10);
        expect(lines.map(stripAnsi)).toEqual(["click here", "for the", "docs page"]);
    });

    test("continuation lines get the indent", () => {
        expect(wrapLine("the quick brown fox jumps", 10, "  ")).toEqual(["the quick", "  brown", "  fox", "  jumps"]);
        expect(wrapLine("one two three four five six seven", 12, "> ")).toEqual(["one two", "> three four", "> five six", "> seven"]);
    });

    function checkWrap(s: string, cols: number) {
        const lines = wrapLine(s, cols);
        for (const l of lines) expect(width(l)).toBeLessThanOrEqual(cols);
        // nothing visible is lost or duplicated, apart from swallowed break spaces
        expect(lines.map(stripAnsi).join("").replace(/ /g, "")).toBe(stripAnsi(s).replace(/ /g, ""));
    }

    test("no line is wider than cols (fuzz: styled text with wide characters)", () => {
        const r = rng(7);
        for (let i = 0; i < 2000; i++) checkWrap(randomStyled(r), 3 + Math.floor(r() * 25));
    });

    test("no line is wider than cols (fuzz: plain text)", () => {
        const r = rng(11);
        for (let i = 0; i < 2000; i++) checkWrap(stripAnsi(randomStyled(r)), 3 + Math.floor(r() * 25));
    });

    test("a styled line that starts with a space still fits when it wraps a wide character", () => {
        // Regression: the space right after the leading escape used to be a
        // break point, and "bé" + "日" (width 4) was not re-checked.
        checkWrap("\x1b[1m bé日", 3);
    });

    test("styled text that starts with a space does not produce a visually empty line", () => {
        const lines = wrapLine("\x1b[31m 日日日日日", 4);
        expect(lines.map(stripAnsi).every((l) => l.trim() !== "")).toBe(true);
    });

    test("with an indent, no continuation line is wider than cols", () => {
        for (const l of wrapLine("a bbbbbbbbc", 10, "    ")) expect(width(l)).toBeLessThanOrEqual(10);
        for (const l of wrapLine("a bbbbbbbbc ddd", 10, "  ")) expect(width(l)).toBeLessThanOrEqual(10);
        const r = rng(99);
        for (let i = 0; i < 1000; i++) {
            const s = randomStyled(r);
            const cols = 3 + Math.floor(r() * 25);
            for (const indent of ["  ", "    ", "> "]) {
                const lines = wrapLine(s, cols, indent);
                for (const l of lines) expect(width(l)).toBeLessThanOrEqual(cols);
                expect(lines.map(stripAnsi).join("").replace(/[ >]/g, "")).toBe(stripAnsi(s).replace(/[ >]/g, ""));
            }
        }
    });

    test("an indent that leaves no room for text is dropped instead of overflowing", () => {
        const lines = wrapLine("abcdefgh", 4, "    ");
        expect(lines).toEqual(["abcd", "efgh"]);
    });

    test("trailing escapes stay on the last row instead of making an empty one", () => {
        const lines = wrapLine(red("aaaa bbbb"), 4);
        expect(lines.map(stripAnsi)).toEqual(["aaaa", "bbbb"]);
        expect(lines[lines.length - 1]!.endsWith("\x1b[39m")).toBe(true);
    });
});

describe("wrapText", () => {
    test("wraps each logical line separately", () => {
        expect(wrapText("aa bb\ncc dd ee", 5)).toEqual(["aa bb", "cc dd", "ee"]);
        expect(wrapText("a\n\nb", 5)).toEqual(["a", "", "b"]);
    });
});

describe("padEnd / padStart", () => {
    test("pad to a visual width", () => {
        expect(padEnd("ab", 5)).toBe("ab   ");
        expect(padStart("ab", 4)).toBe("  ab");
    });

    test("ignore ANSI codes when measuring", () => {
        expect(padEnd(red("ab"), 5)).toBe(red("ab") + "   ");
        expect(width(padEnd(red("ab"), 5))).toBe(5);
    });

    test("count wide characters as 2", () => {
        expect(padEnd("日本", 5)).toBe("日本 ");
        expect(padEnd("😀", 3)).toBe("😀 ");
    });

    test("never truncate a longer string", () => {
        expect(padEnd("abcdef", 3)).toBe("abcdef");
        expect(padStart("abcdef", 3)).toBe("abcdef");
    });
});

alsoRunInOtherColorMode(import.meta.path);
