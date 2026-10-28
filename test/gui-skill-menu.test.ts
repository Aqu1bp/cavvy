// The composer's $ menu: which $word is a skill being typed, and what it offers; and which commands and skills in the
// text it marks as what will run.

import { describe, expect, test } from "bun:test";
import { argsHint, matchSkills, skillToken, textPieces } from "../gui/src/lib/commands";

describe("skillToken", () => {
    test("a $ at the start or after a space, with what's typed after it", () => {
        expect(skillToken("$")).toEqual({ query: "", start: 0 });
        expect(skillToken("use $pd")).toEqual({ query: "pd", start: 4 });
        expect(skillToken("line one\n$my-plugin:re")).toEqual({ query: "my-plugin:re", start: 9 });
    });

    test("not inside a word, not a shell variable, not past a space", () => {
        for (const t of ["a$pdf", "echo $HOME", "$Pdf", "$pdf done", "${x", "`$x"]) expect(skillToken(t)).toBeUndefined();
    });
});

describe("matchSkills", () => {
    const cmds = [
        { name: "help", description: "" },
        { name: "pptx", description: "", skill: true },
        { name: "pdf", description: "", skill: true },
        { name: "make-pdf", description: "", skill: true },
    ];
    test("skills only, names that start with the query first", () => {
        expect(matchSkills(cmds, "").map((c) => c.name)).toEqual(["make-pdf", "pdf", "pptx"]);
        expect(matchSkills(cmds, "p").map((c) => c.name)).toEqual(["pdf", "pptx"]);
        expect(matchSkills(cmds, "pdf").map((c) => c.name)).toEqual(["pdf", "make-pdf"]);
        expect(matchSkills(cmds, "he")).toEqual([]);
    });
});

describe("textPieces", () => {
    const cmds = [
        { name: "review", description: "" },
        { name: "pdf", description: "", skill: true },
        { name: "my-plugin:report", description: "", skill: true },
    ];
    const marked = (text: string) => textPieces(text, cmds).filter((p) => p.kind).map((p) => `${p.kind}:${p.text}`);

    test("the /command a message starts with, and each $skill, cut out of the text as it is", () => {
        expect(textPieces("/review the auth module", cmds)).toEqual([{ text: "/review", kind: "command" }, { text: " the auth module" }]);
        expect(textPieces("use $pdf, then $my-plugin:report.", cmds)).toEqual([{ text: "use " }, { text: "$pdf", kind: "skill" }, { text: ", then " }, { text: "$my-plugin:report", kind: "skill" }, { text: "." }]);
        expect(marked("  /review $pdf")).toEqual(["command:/review", "skill:$pdf"]);
        expect(marked("($pdf) and\n$pdf: again")).toEqual(["skill:$pdf", "skill:$pdf"]);
    });

    test("only what will run: unknown names, paths, prices, shell variables and half-typed names stay plain", () => {
        for (const t of ["/revie", "/reviewer", "/Users/me/app.ts fails", "//review", "a /review", "costs $5", "echo $HOME", "$pdfx", "a$pdf", "$review", "/pdf.md"]) expect(marked(t)).toEqual([]);
        expect(marked("/pdf")).toEqual(["command:/pdf"]);
        expect(textPieces("nothing here", cmds)).toEqual([{ text: "nothing here" }]);
        expect(textPieces("/review", [])).toEqual([{ text: "/review" }]);
    });
});

describe("argsHint", () => {
    const cmds = [{ name: "review", args: "[pr|focus]" }, { name: "compact" }];
    test("what the command takes, after it, until something's typed there", () => {
        expect(argsHint("/review ", cmds)).toBe("[pr|focus]");
        expect(argsHint("/review", cmds)).toBe(" [pr|focus]");
        for (const t of ["/review 12", "/review \nmore", "/compact ", "/revie ", "say /review ", "/reviewer "]) expect(argsHint(t, cmds)).toBeUndefined();
    });
});
