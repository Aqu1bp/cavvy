import { describe, expect, test } from "bun:test";
import { Highlighter, highlightCode, langFromPath, normalizeLang } from "../src/ui/highlight";
import { colorEnabled, stripAnsi, theme } from "../src/ui/ansi";
import { alsoRunInOtherColorMode } from "./helpers/color-mode";

const samples: Record<string, string> = {
    ts: [
        'import { x } from "./y";',
        "const a: number = 0x1F + 2.5e3 + 1_000n;",
        "/* block",
        "   comment */ let s = `tmpl ${a}",
        "line2`;",
        "function f<T>(v: T): T { return v; } // trailing",
        "class Foo extends Bar implements Baz {}",
        "const re = 'it\\'s' + \"q\\\"uote\";",
    ].join("\n"),
    py: [
        "def f(x):",
        '    """doc',
        '    string"""',
        "    return x + 1  # comment",
        "s = 'it\\'s'",
        "t = '''multi",
        "line'''",
        'print(f"{s}", None, True)',
        "@decorator",
        "class A(B): pass",
    ].join("\n"),
    sh: [
        "#!/bin/bash",
        "echo \"$HOME/${USER}\" 'single $x' $1 $@",
        "if [ -f a ]; then",
        "  ls -la # list",
        "fi",
        "export FOO=bar",
        "for i in $(seq 3); do echo \"$i\"; done",
        "echo 'back\\slash'",
    ].join("\n"),
    json: ["{", '  "key": "value",', '  "n": -1.5e3,', '  "b": true,', '  "nil": null,', '  "arr": [1, "two", {"k": "v\\"q"}]', "}"].join("\n"),
    go: ["package main", "", 'import "fmt"', "", "func main() {", "\ts := `raw", "string`", "\tfmt.Println(s, 42, 'c', nil)", "\t/* c */ var x int64 = 0x10", "}"].join("\n"),
    rust: [
        "use std::fmt;",
        "fn main() {",
        "    let v: Vec<i32> = vec![1, 2];",
        "    /* nested",
        "    */ println!(\"{}\", v.len());",
        "    let c = 'a'; // char",
        "    impl<'a> Foo<'a> for &'a str {}",
        "}",
    ].join("\n"),
};

describe("highlightCode preserves the text", () => {
    for (const [lang, code] of Object.entries(samples)) {
        test(`${lang}: one output line per input line, and stripAnsi(output) is the input`, () => {
            const out = highlightCode(code, lang);
            const input = code.split("\n");
            expect(out).toHaveLength(input.length);
            expect(out.map(stripAnsi)).toEqual(input);
        });
    }

    test("other languages and aliases", () => {
        const others: [string, string][] = [
            ["c", '#include <stdio.h>\nint main(void) { printf("%d\\n", 1); /* c */ }'],
            ["java", "public class A { String s = \"x\"; } // j"],
            ["rb", "def f?\n  puts 'x' # c\nend"],
            ["php", "<?php $x = \"a\"; // c\n# hash comment"],
            ["sql", "SELECT * FROM t WHERE a = 'x' -- c\n/* block */"],
            ["yaml", "key: value # c\nlist:\n  - 'a'"],
            ["toml", 'k = """multi\nline"""\n# c'],
            ["css", "@media (x) { a { color: #fff !important; } } /* c */"],
            ["html", '<div class="a"><!-- c --></div>'],
            ["lua", "local x = 'a' -- c"],
            ["swift", 'let s: String = "x" // c'],
            ["diff", "--- a\n+++ b\n@@ -1 +1 @@\n-old\n+new\n ctx"],
            ["markdown", "# not highlighted"],
            ["nonsense", "plain text"],
        ];
        for (const [lang, code] of others) {
            const out = highlightCode(code, lang);
            expect(out.map(stripAnsi)).toEqual(code.split("\n"));
        }
        expect(highlightCode("x = 1", undefined)).toEqual(["x = 1"]);
    });

    test("fuzz: random code-like input survives every language unchanged", () => {
        let seed = 7;
        const rnd = () => (seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32;
        const parts = ['"', "'", "`", "\\", "/*", "*/", "//", "#", '"""', "'''", "$", "${x}", "$1", "0x1f", "12.5e3", "const", "def", "fn", "if", "Foo", "bar(", ")", " ", "\n", "-", "?", "<div", "@media", "--", "<!--", "-->", "日本", "😀", "\t"];
        for (const lang of ["ts", "py", "sh", "json", "go", "rust", "c", "rb", "php", "swift", "sql", "yaml", "toml", "css", "html", "lua", "diff", undefined]) {
            for (let n = 0; n < 200; n++) {
                let s = "";
                const len = Math.floor(rnd() * 30);
                for (let i = 0; i < len; i++) s += parts[Math.floor(rnd() * parts.length)];
                const out = highlightCode(s, lang);
                expect(out.map(stripAnsi)).toEqual(s.split("\n"));
            }
        }
    });

    test("output is styled when colors are on", () => {
        const [line] = highlightCode("const x = 1;", "ts");
        if (colorEnabled) {
            expect(line).toContain(theme.synKeyword("const"));
            expect(line).toContain(theme.synNumber("1"));
        } else expect(line).toBe("const x = 1;");
    });

    test("token classes", () => {
        const h = new Highlighter("ts");
        expect(h.line('return "s" // c')).toBe(theme.synKeyword("return") + " " + theme.synString('"s"') + " " + theme.synComment("// c"));
        expect(new Highlighter("ts").line("foo(Bar)")).toBe(theme.synFunc("foo") + "(" + theme.synType("Bar") + ")");
        expect(new Highlighter("json").line('"k": "v"')).toBe(theme.synFunc('"k"') + ": " + theme.synString('"v"'));
        expect(new Highlighter("sh").line("echo $HOME")).toBe("echo " + theme.synType("$HOME"));
        expect(new Highlighter("sql").line("SELECT 1")).toBe(theme.synKeyword("SELECT") + " " + theme.synNumber("1"));
        expect(new Highlighter("diff").line("+added")).toBe(theme.diffAddedFg("+added"));
    });

    test("identifiers containing digits are not split into numbers", () => {
        expect(new Highlighter("ts").line("x1 = v2")).toBe("x1 = v2");
    });
});

describe("multi-line state", () => {
    test("a block comment carries over lines and ends mid-line", () => {
        const h = new Highlighter("ts");
        expect(h.line("/* start")).toBe(theme.synComment("/* start"));
        expect(h.line("middle const")).toBe(theme.synComment("middle const"));
        expect(h.line("end */ const x = 1;")).toBe(theme.synComment("end */") + " " + theme.synKeyword("const") + " x = " + theme.synNumber("1") + ";");
        expect(h.line("const y")).toBe(theme.synKeyword("const") + " y");
    });

    test("a block comment that opens and closes on one line does not carry over", () => {
        const h = new Highlighter("go");
        h.line("/* one line */ x");
        expect(h.line("func f()")).toBe(theme.synKeyword("func") + " " + theme.synFunc("f") + "()");
    });

    test("python triple-quoted strings carry over lines", () => {
        const h = new Highlighter("py");
        expect(h.line('s = """open')).toBe("s = " + theme.synString('"""open'));
        expect(h.line("still string def")).toBe(theme.synString("still string def"));
        expect(h.line('close""" + def')).toBe(theme.synString('close"""') + " + " + theme.synKeyword("def"));
    });

    test("JS template literals and Go raw strings carry over lines", () => {
        const js = new Highlighter("ts");
        js.line("const s = `line1");
        expect(js.line("line2 const")).toBe(theme.synString("line2 const"));
        expect(js.line("end` + 1")).toBe(theme.synString("end`") + " + " + theme.synNumber("1"));
        const go = new Highlighter("go");
        go.line("s := `raw");
        expect(go.line("text`")).toBe(theme.synString("text`"));
        expect(go.line("var")).toBe(theme.synKeyword("var"));
    });

    test("single-line strings do not carry over", () => {
        const h = new Highlighter("ts");
        h.line('const s = "unterminated');
        expect(h.line("const")).toBe(theme.synKeyword("const"));
        const r = new Highlighter("rust");
        r.line('let s = "unterminated');
        expect(r.line("let")).toBe(theme.synKeyword("let"));
    });

    test("each highlightCode call starts fresh", () => {
        highlightCode("/* open", "ts");
        expect(highlightCode("const", "ts")).toEqual([theme.synKeyword("const")]);
    });

    test("state carries across lines within one highlightCode call", () => {
        const out = highlightCode("/* a\nb\nc */ let", "ts");
        expect(out[1]).toBe(theme.synComment("b"));
        expect(out[2]).toBe(theme.synComment("c */") + " " + theme.synKeyword("let"));
    });

    test("an escaped backtick inside a continued template literal does not end it", () => {
        const h = new Highlighter("ts");
        h.line("const s = `line1");
        expect(stripAnsi(h.line("escaped \\` still in string`"))).toBe("escaped \\` still in string`");
        // The template closed at the final backtick, so nothing is left open...
        expect((h as unknown as { state?: unknown }).state).toBeUndefined();
        // ...and the next line is ordinary code.
        expect(h.line("const after = 1;")).toBe(new Highlighter("ts").line("const after = 1;"));
    });
});

describe("langFromPath / normalizeLang", () => {
    test.each([
        ["a.ts", "js"],
        ["a.tsx", "js"],
        ["src/ui/app.TS", "js"],
        ["x.mjs", "js"],
        ["b.py", "py"],
        ["c.go", "go"],
        ["d.rs", "rust"],
        ["e.sh", "sh"],
        ["e.zsh", "sh"],
        ["Dockerfile", "sh"],
        ["docker/Dockerfile.dev", "sh"],
        ["Makefile", "sh"],
        [".env.local", "sh"],
        [".bashrc", "sh"],
        ["x.json", "json"],
        ["x.jsonc", "json"],
        ["y.yml", "yaml"],
        ["y.yaml", "yaml"],
        ["A.JAVA", "c"],
        ["k.kt", "c"],
        ["h.hpp", "c"],
        ["r.rb", "rb"],
        ["s.scss", "css"],
        ["i.svg", "html"],
        ["q.sql", "sql"],
        ["c.toml", "toml"],
        ["x.diff", "diff"],
        ["x.patch", "diff"],
    ])("%s -> %s", (path, lang) => {
        expect(langFromPath(path)).toBe(lang);
    });

    test.each([["z.md"], ["README.markdown"], ["noext"], ["dir.v1/file"], ["weird.xyz"], [""]])("%j has no language", (path) => {
        expect(langFromPath(path)).toBeUndefined();
    });

    test("normalizeLang is case- and whitespace-insensitive", () => {
        expect(normalizeLang("TypeScript")).toBe("js");
        expect(normalizeLang("  py ")).toBe("py");
        expect(normalizeLang("Golang")).toBe("go");
        expect(normalizeLang("c++")).toBe("c");
        expect(normalizeLang("PATCH")).toBe("diff");
        expect(normalizeLang(undefined)).toBeUndefined();
        expect(normalizeLang("")).toBeUndefined();
        expect(normalizeLang("md")).toBeUndefined();
        expect(normalizeLang("unknown")).toBeUndefined();
    });
});

alsoRunInOtherColorMode(import.meta.path);
