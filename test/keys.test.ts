import { describe, expect, test } from "bun:test";
import { KeyParser, keyLabel, type Key } from "../src/ui/keys";

/** Feed chunks to a fresh parser; returns the parser and every key emitted. */
function feed(...chunks: string[]): { parser: KeyParser; keys: Key[]; perChunk: Key[][] } {
    const parser = new KeyParser();
    const perChunk = chunks.map((c) => parser.feed(c));
    return { parser, keys: perChunk.flat(), perChunk };
}

function only(data: string): Key {
    const { keys } = feed(data);
    expect(keys).toHaveLength(1);
    return keys[0]!;
}

describe("printable text", () => {
    test("single character", () => {
        expect(feed("a").keys).toEqual([{ name: "text", text: "a" }]);
    });

    test("consecutive printable characters are grouped into one text key", () => {
        expect(feed("hello world").keys).toEqual([{ name: "text", text: "hello world" }]);
    });

    test("non-ASCII, CJK and emoji (surrogate pairs) stay intact", () => {
        expect(feed("é").keys).toEqual([{ name: "text", text: "é" }]);
        expect(feed("日本語").keys).toEqual([{ name: "text", text: "日本語" }]);
        expect(feed("😀x").keys).toEqual([{ name: "text", text: "😀x" }]);
    });

    test("text is split around control characters and escape sequences", () => {
        expect(feed("x\ty").keys).toEqual([{ name: "text", text: "x" }, { name: "tab" }, { name: "text", text: "y" }]);
        expect(feed("hi\x1b[A").keys).toEqual([{ name: "text", text: "hi" }, { name: "up" }]);
    });

    test("text keys from separate feeds are not merged", () => {
        const { perChunk } = feed("ab", "cd");
        expect(perChunk).toEqual([[{ name: "text", text: "ab" }], [{ name: "text", text: "cd" }]]);
    });
});

describe("basic keys", () => {
    test("Enter (\\r)", () => {
        expect(only("\r")).toEqual({ name: "enter" });
    });

    test("LF (\\n, ctrl+j) is ctrl+enter", () => {
        expect(only("\n")).toEqual({ name: "enter", ctrl: true });
    });

    test("Backspace (\\x7f and \\x08)", () => {
        expect(only("\x7f")).toEqual({ name: "backspace" });
        expect(only("\x08")).toEqual({ name: "backspace" });
    });

    test("Tab and shift+tab (CSI Z)", () => {
        expect(only("\t")).toEqual({ name: "tab" });
        expect(only("\x1b[Z")).toEqual({ name: "tab", shift: true });
    });

    test("ctrl+space (NUL)", () => {
        expect(only("\x00")).toEqual({ name: "space", ctrl: true });
    });

    test("two Enters in one chunk are two enter keys, not a paste", () => {
        expect(feed("\r\r").keys).toEqual([{ name: "enter" }, { name: "enter" }]);
    });
});

describe("cursor and editing keys", () => {
    test.each([
        ["\x1b[A", "up"],
        ["\x1b[B", "down"],
        ["\x1b[C", "right"],
        ["\x1b[D", "left"],
        ["\x1bOA", "up"],
        ["\x1bOB", "down"],
        ["\x1bOC", "right"],
        ["\x1bOD", "left"],
    ])("arrow %j -> %s", (seq, name) => {
        expect(only(seq)).toEqual({ name });
    });

    test.each([
        ["\x1b[H", "home"],
        ["\x1b[F", "end"],
        ["\x1bOH", "home"],
        ["\x1bOF", "end"],
        ["\x1b[1~", "home"],
        ["\x1b[4~", "end"],
        ["\x1b[7~", "home"],
        ["\x1b[8~", "end"],
        ["\x1b[2~", "insert"],
        ["\x1b[3~", "delete"],
        ["\x1b[5~", "pageup"],
        ["\x1b[6~", "pagedown"],
    ])("%j -> %s", (seq, name) => {
        expect(only(seq)).toEqual({ name });
    });

    test("xterm modifier parameters on arrows and tilde keys", () => {
        expect(only("\x1b[1;2A")).toEqual({ name: "up", shift: true });
        expect(only("\x1b[1;3D")).toEqual({ name: "left", meta: true });
        expect(only("\x1b[1;5C")).toEqual({ name: "right", ctrl: true });
        expect(only("\x1b[1;6B")).toEqual({ name: "down", shift: true, ctrl: true });
        expect(only("\x1b[3;5~")).toEqual({ name: "delete", ctrl: true });
        expect(only("\x1b[1;9C")).toEqual({ name: "right", meta: true }); // super/cmd treated like meta
    });

    test("function keys via SS3", () => {
        expect(only("\x1bOP")).toEqual({ name: "f1" });
        expect(only("\x1bOS")).toEqual({ name: "f4" });
    });

    test("unknown CSI sequences produce an 'unknown' key and do not leak text", () => {
        expect(feed("\x1b[99~").keys).toEqual([{ name: "unknown" }]);
        expect(feed("\x1b[1;5X").keys).toEqual([{ name: "unknown" }]);
    });
});

describe("ctrl and meta", () => {
    // 0x08 = backspace, 0x09 = tab, 0x0a = LF (ctrl+enter), 0x0d = enter.
    const special = new Set([8, 9, 10, 13]);
    const letters = Array.from({ length: 26 }, (_, i) => i + 1).filter((c) => !special.has(c));

    test.each(letters.map((c) => [c, String.fromCharCode(c + 96)] as const))("control code %i -> ctrl+%s", (code, letter) => {
        expect(only(String.fromCharCode(code))).toEqual({ name: letter, ctrl: true });
    });

    test("ctrl+c, ctrl+d, ctrl+z", () => {
        expect(only("\x03")).toEqual({ name: "c", ctrl: true });
        expect(only("\x04")).toEqual({ name: "d", ctrl: true });
        expect(only("\x1a")).toEqual({ name: "z", ctrl: true });
    });

    test("alt/meta + letter (ESC prefix)", () => {
        expect(only("\x1bb")).toEqual({ name: "b", meta: true });
        expect(only("\x1bf")).toEqual({ name: "f", meta: true });
        expect(only("\x1bB")).toEqual({ name: "b", meta: true, shift: true });
    });

    test("alt/meta + enter, backspace and control letters", () => {
        expect(only("\x1b\r")).toEqual({ name: "enter", meta: true });
        expect(only("\x1b\x7f")).toEqual({ name: "backspace", meta: true });
        expect(only("\x1b\x01")).toEqual({ name: "a", ctrl: true, meta: true });
    });
});

describe("CSI u (kitty) and modifyOtherKeys", () => {
    test.each([
        ["\x1b[13u", { name: "enter" }],
        ["\x1b[13;2u", { name: "enter", shift: true }],
        ["\x1b[13;3u", { name: "enter", meta: true }],
        ["\x1b[13;5u", { name: "enter", ctrl: true }],
        ["\x1b[13;2:1u", { name: "enter", shift: true }], // with kitty event-type sub-parameter
        ["\x1b[9;2u", { name: "tab", shift: true }],
        ["\x1b[27u", { name: "escape" }],
        ["\x1b[127u", { name: "backspace" }],
        ["\x1b[127;3u", { name: "backspace", meta: true }],
        ["\x1b[32;5u", { name: "space", ctrl: true }],
        ["\x1b[32u", { name: "text", text: " " }],
        ["\x1b[97;5u", { name: "a", ctrl: true }],
        ["\x1b[97;3u", { name: "a", meta: true }],
        ["\x1b[97;2u", { name: "text", text: "A" }],
        ["\x1b[97u", { name: "text", text: "a" }],
    ] as [string, Key][])("%j", (seq, key) => {
        expect(only(seq)).toEqual(key);
    });

    test.each([
        ["\x1b[27;2;13~", { name: "enter", shift: true }],
        ["\x1b[27;5;13~", { name: "enter", ctrl: true }],
        ["\x1b[27;3;13~", { name: "enter", meta: true }],
        ["\x1b[27;5;97~", { name: "a", ctrl: true }],
        ["\x1b[27;2;9~", { name: "tab", shift: true }],
    ] as [string, Key][])("modifyOtherKeys %j", (seq, key) => {
        expect(only(seq)).toEqual(key);
    });
});

// What a terminal sends once the harness pushes the kitty protocol's
// "disambiguate escape codes" flag (CSI > 1 u): Esc, ctrl+key and alt+key
// become CSI u; plain Enter, Tab and Backspace keep their legacy bytes; the
// modifier number is 1 + shift 1, alt 2, ctrl 4, super 8, caps lock 64, num lock 128.
describe("kitty keyboard protocol, disambiguate flag", () => {
    test.each([
        ["\x1b[27u", { name: "escape" }],
        ["\x1b[27;65u", { name: "escape" }], // caps lock on
        ["\x1b[99;5u", { name: "c", ctrl: true }],
        ["\x1b[99;69u", { name: "c", ctrl: true }], // caps lock on
        ["\x1b[99;133u", { name: "c", ctrl: true }], // num lock on
        ["\x1b[100;5u", { name: "d", ctrl: true }],
        ["\x1b[103;5u", { name: "g", ctrl: true }],
        ["\x1b[111;5u", { name: "o", ctrl: true }],
        ["\x1b[116;5u", { name: "t", ctrl: true }],
        ["\x1b[45;6u", { name: "-", ctrl: true, shift: true }], // ctrl+_ (undo)
        ["\x1b[98;3u", { name: "b", meta: true }],
        ["\x1b[102;3u", { name: "f", meta: true }],
        ["\x1b[100;3u", { name: "d", meta: true }],
        ["\x1b[98;4u", { name: "b", meta: true, shift: true }],
        ["\x1b[13;2u", { name: "enter", shift: true }],
        ["\x1b[13;5u", { name: "enter", ctrl: true }],
        ["\x1b[13;3u", { name: "enter", meta: true }],
        ["\x1b[9;2u", { name: "tab", shift: true }],
        ["\x1b[127;5u", { name: "backspace", ctrl: true }],
        ["\x1b[127;3u", { name: "backspace", meta: true }],
    ] as [string, Key][])("%j", (seq, key) => {
        expect(only(seq)).toEqual(key);
    });

    test("unmodified Enter, Tab, Backspace and arrows are unchanged", () => {
        expect(feed("\r", "\t", "\x7f", "\x1b[A", "\x1b[1;3D", "\x1b[1;5C", "\x1b[Z").keys).toEqual([
            { name: "enter" },
            { name: "tab" },
            { name: "backspace" },
            { name: "up" },
            { name: "left", meta: true },
            { name: "right", ctrl: true },
            { name: "tab", shift: true },
        ]);
    });

    test("esc esc arrives as two escapes, in one chunk or two, with no lone-ESC wait", () => {
        const one = feed("\x1b[27u\x1b[27u");
        expect(one.keys).toEqual([{ name: "escape" }, { name: "escape" }]);
        expect(one.parser.pendingEscape).toBe(false);
        expect(feed("\x1b[27u", "\x1b[27u").keys).toEqual([{ name: "escape" }, { name: "escape" }]);
    });

    test("ctrl+keys that legacy terminals send as LF, CR, tab, backspace and ESC keep that meaning", () => {
        expect(only("\x1b[106;5u")).toEqual({ name: "enter", ctrl: true }); // ctrl+j: newline
        expect(only("\x1b[106;69u")).toEqual({ name: "enter", ctrl: true }); // with caps lock
        expect(only("\x1b[109;5u")).toEqual({ name: "enter" }); // ctrl+m
        expect(only("\x1b[105;5u")).toEqual({ name: "tab" }); // ctrl+i
        expect(only("\x1b[104;5u")).toEqual({ name: "backspace" }); // ctrl+h
        expect(only("\x1b[91;5u")).toEqual({ name: "escape" }); // ctrl+[
        // With other modifiers they're ordinary keys.
        expect(only("\x1b[106;7u")).toEqual({ name: "j", ctrl: true, meta: true });
        expect(only("\x1b[106;3u")).toEqual({ name: "j", meta: true });
        // modifyOtherKeys spells ctrl+j the same way.
        expect(only("\x1b[27;5;106~")).toEqual({ name: "enter", ctrl: true });
    });

    test("keypad keys are the keys they stand for, and other functional keys are never typed as text", () => {
        expect(only("\x1b[57414u")).toEqual({ name: "enter" }); // KP_Enter
        expect(only("\x1b[57414;2u")).toEqual({ name: "enter", shift: true });
        expect(only("\x1b[57419u")).toEqual({ name: "up" }); // KP_Up
        expect(only("\x1b[57417;5u")).toEqual({ name: "left", ctrl: true });
        expect(only("\x1b[57426u")).toEqual({ name: "delete" });
        expect(only("\x1b[57399u")).toEqual({ name: "text", text: "0" });
        expect(only("\x1b[57413u")).toEqual({ name: "text", text: "+" });
        expect(only("\x1b[57427u")).toEqual({ name: "unknown" }); // KP_Begin
        expect(only("\x1b[57441;2u")).toEqual({ name: "unknown" }); // left shift
        expect(only("\x1b[57376u")).toEqual({ name: "unknown" }); // F13
    });
});

describe("bracketed paste", () => {
    test("a complete paste in one chunk", () => {
        expect(feed("\x1b[200~hello\nworld\x1b[201~").keys).toEqual([{ name: "paste", paste: "hello\nworld" }]);
    });

    test("CRLF and CR inside a paste are normalized to LF", () => {
        expect(feed("\x1b[200~a\r\nb\rc\x1b[201~").keys).toEqual([{ name: "paste", paste: "a\nb\nc" }]);
    });

    test("paste content is literal: escape sequences, Enter and ctrl codes inside are not keys", () => {
        expect(feed("\x1b[200~x\x1b[Ay\r\x03z\x1b[201~").keys).toEqual([{ name: "paste", paste: "x\x1b[Ay\n\x03z" }]);
    });

    test("a paste split across several feed() calls, including inside the end marker", () => {
        const { perChunk } = feed("\x1b[200~hel", "lo\nwor", "ld\x1b[2", "01~");
        expect(perChunk).toEqual([[], [], [], [{ name: "paste", paste: "hello\nworld" }]]);
    });

    test("end marker split right after its ESC, followed by typed text", () => {
        const { perChunk } = feed("\x1b[200~abc\x1b", "[201~tail");
        expect(perChunk).toEqual([[], [{ name: "paste", paste: "abc" }, { name: "text", text: "tail" }]]);
    });

    test("start marker split across chunks", () => {
        const { perChunk } = feed("\x1b[20", "0~abc\x1b[201~");
        expect(perChunk).toEqual([[], [{ name: "paste", paste: "abc" }]]);
    });

    test("a long multi-chunk paste is reassembled exactly", () => {
        const body = Array.from({ length: 200 }, (_, i) => `line ${i} ${"x".repeat(i % 17)}`).join("\n");
        const raw = `\x1b[200~${body}\x1b[201~`;
        const chunks: string[] = [];
        for (let i = 0; i < raw.length; i += 37) chunks.push(raw.slice(i, i + 37));
        const { keys } = feed(...chunks);
        expect(keys).toEqual([{ name: "paste", paste: body }]);
    });

    test("an empty paste", () => {
        expect(feed("\x1b[200~\x1b[201~").keys).toEqual([{ name: "paste", paste: "" }]);
    });

    test("keys before and after a paste in the same chunk", () => {
        expect(feed("a\x1b[200~p\x1b[201~\r").keys).toEqual([{ name: "text", text: "a" }, { name: "paste", paste: "p" }, { name: "enter" }]);
    });

    test("pendingEscape is false while a paste is open, and flushEscape does not break it", () => {
        const p = new KeyParser();
        expect(p.feed("\x1b[200~abc")).toEqual([]);
        expect(p.pendingEscape).toBe(false);
        expect(p.flushEscape()).toEqual([]);
        expect(p.feed("def\x1b[201~")).toEqual([{ name: "paste", paste: "abcdef" }]);
    });
});

describe("lone ESC and split sequences", () => {
    test("a lone ESC waits; flushEscape() turns it into an escape key", () => {
        const p = new KeyParser();
        expect(p.feed("\x1b")).toEqual([]);
        expect(p.pendingEscape).toBe(true);
        expect(p.flushEscape()).toEqual([{ name: "escape" }]);
        expect(p.pendingEscape).toBe(false);
        expect(p.flushEscape()).toEqual([]);
    });

    test("flushEscape is a no-op when nothing is pending", () => {
        const p = new KeyParser();
        expect(p.flushEscape()).toEqual([]);
        p.feed("abc");
        expect(p.flushEscape()).toEqual([]);
    });

    test("ESC followed later by the rest of a CSI sequence (before any flush)", () => {
        const { perChunk } = feed("\x1b", "[A");
        expect(perChunk).toEqual([[], [{ name: "up" }]]);
    });

    test('a CSI split as "\\x1b[" then "A"', () => {
        const p = new KeyParser();
        expect(p.feed("\x1b[")).toEqual([]);
        expect(p.pendingEscape).toBe(false); // only a lone ESC is ambiguous
        expect(p.feed("A")).toEqual([{ name: "up" }]);
    });

    test("a CSI split in the middle of its parameters", () => {
        expect(feed("\x1b[1;", "5C").perChunk).toEqual([[], [{ name: "right", ctrl: true }]]);
        expect(feed("\x1b[13;", "2u").perChunk).toEqual([[], [{ name: "enter", shift: true }]]);
    });

    test("an SS3 sequence split after O", () => {
        expect(feed("\x1bO", "A").perChunk).toEqual([[], [{ name: "up" }]]);
    });

    test("ESC ESC [A is escape then up", () => {
        expect(feed("\x1b\x1b[A").keys).toEqual([{ name: "escape" }, { name: "up" }]);
    });

    test("an over-long unterminated CSI is discarded and the parser recovers", () => {
        const p = new KeyParser();
        p.feed("\x1b[" + "1;".repeat(20));
        const keys = p.feed("\r");
        expect(keys[keys.length - 1]).toEqual({ name: "enter" });
        expect(p.feed("\x1b[A")).toEqual([{ name: "up" }]);
    });
});

describe("pastes from terminals without bracketed paste", () => {
    test("a multi-line chunk is a single paste", () => {
        expect(feed("line1\nline2\nline3").keys).toEqual([{ name: "paste", paste: "line1\nline2\nline3" }]);
    });

    test("CR and CRLF line endings in such a chunk are normalized", () => {
        expect(feed("line1\rline2").keys).toEqual([{ name: "paste", paste: "line1\nline2" }]);
        expect(feed("a\r\nb").keys).toEqual([{ name: "paste", paste: "a\nb" }]);
    });

    test("typed text followed by a single trailing \\r is text then enter, not a paste", () => {
        expect(feed("hello\r").keys).toEqual([{ name: "text", text: "hello" }, { name: "enter" }]);
        expect(feed("ab\r").keys).toEqual([{ name: "text", text: "ab" }, { name: "enter" }]);
        expect(feed("a\r").keys).toEqual([{ name: "text", text: "a" }, { name: "enter" }]);
    });

    test("a multi-line chunk ending in \\r is still a paste", () => {
        expect(feed("one\rtwo\r").keys).toEqual([{ name: "paste", paste: "one\ntwo\n" }]);
    });

    test("a chunk with newlines and an escape sequence is parsed as keys, not a paste", () => {
        const { keys } = feed("ab\x1b[Acd\r");
        expect(keys).toEqual([{ name: "text", text: "ab" }, { name: "up" }, { name: "text", text: "cd" }, { name: "enter" }]);
    });
});

describe("keyLabel", () => {
    test("text keys show their text", () => {
        expect(keyLabel({ name: "text", text: "x" })).toBe("x");
        expect(keyLabel({ name: "text" })).toBe("");
    });

    test("modifiers are listed in ctrl, meta, shift order", () => {
        expect(keyLabel({ name: "a", ctrl: true })).toBe("ctrl+a");
        expect(keyLabel({ name: "enter", shift: true })).toBe("shift+enter");
        expect(keyLabel({ name: "enter", shift: true, meta: true, ctrl: true })).toBe("ctrl+meta+shift+enter");
        expect(keyLabel({ name: "up" })).toBe("up");
    });

    test("labels of parsed keys", () => {
        expect(keyLabel(only("\x1b[13;2u"))).toBe("shift+enter");
        expect(keyLabel(only("\x1b[Z"))).toBe("shift+tab");
        expect(keyLabel(only("\x03"))).toBe("ctrl+c");
        expect(keyLabel(only("\x1bb"))).toBe("meta+b");
    });
});
