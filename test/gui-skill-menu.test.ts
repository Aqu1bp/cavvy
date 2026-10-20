// The composer's $ menu: which $word is a skill being typed, and what it offers.

import { describe, expect, test } from "bun:test";
import { matchSkills, skillToken } from "../gui/src/lib/commands";

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
