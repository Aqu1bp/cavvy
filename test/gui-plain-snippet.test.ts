import { expect, test } from "bun:test";
import { plainSnippet } from "../gui/src/lib/plain-snippet";

const marked = (text: string, query: string) => {
    const at = text.toLowerCase().indexOf(query.toLowerCase());
    const r = plainSnippet(text, at >= 0 ? [at, at + query.length] : undefined);
    return r.match ? `${r.text.slice(0, r.match[0])}[${r.text.slice(r.match[0], r.match[1])}]${r.text.slice(r.match[1])}` : r.text;
};

test("inline code, bold, italics and strikethrough lose their markers", () => {
    expect(plainSnippet("Email login is registered in `src/auth/index.ts`. I'll add **SSO** next to it.").text)
        .toBe("Email login is registered in src/auth/index.ts. I'll add SSO next to it.");
    expect(plainSnippet("an *italic* word, an _other_ one, ~~gone~~ and ``tick ` code``").text)
        .toBe("an italic word, an other one, gone and tick ` code");
});

test("identifiers and arithmetic keep their underscores and asterisks", () => {
    expect(plainSnippet("set max_tokens and 2 * 3 or a*b").text).toBe("set max_tokens and 2 * 3 or a*b");
    expect(plainSnippet("`__init__` stays").text).toBe("__init__ stays");
});

test("links keep their text, images their alt text", () => {
    expect(plainSnippet("see [the docs](https://example.com/a_b) and ![a chart](x.png)").text).toBe("see the docs and a chart");
});

test("heading, quote and list markers go at the start, after an ellipsis too", () => {
    expect(plainSnippet("## Plan for the release").text).toBe("Plan for the release");
    expect(plainSnippet("> quoted words").text).toBe("quoted words");
    expect(plainSnippet("…- the second item").text).toBe("…the second item");
    expect(plainSnippet("2. Then run it").text).toBe("Then run it");
    expect(plainSnippet("#163 merged").text).toBe("#163 merged");
});

test("the match moves with the text and stays on the same words", () => {
    expect(marked("I'll add **SSO** next to `login`", "sso")).toBe("I'll add [SSO] next to login");
    expect(marked("in `src/auth/index.ts`", "auth")).toBe("in src/[auth]/index.ts");
    // A match spanning syntax keeps only its words.
    expect(marked("the **login flow**", "login flow**")).toBe("the [login flow]");
    // A match that was only syntax is no match.
    expect(plainSnippet("a **b**", [2, 4]).match).toBeUndefined();
    expect(plainSnippet("plain", undefined).match).toBeUndefined();
});

test("**, __ and ~~ go only as emphasis, paired around words; otherwise they're text", () => {
    expect(marked("Use snake__case identifier", "snake__case")).toBe("Use [snake__case] identifier");
    expect(marked("Use ** glob to match all files", "**")).toBe("Use [**] glob to match all files");
    expect(marked("a lone ~~ here, a lone __ there", "~~")).toBe("a lone [~~] here, a lone __ there");
    expect(plainSnippet("unclosed **bold and ~~strike").text).toBe("unclosed **bold and ~~strike");
    expect(plainSnippet("spaced ** out ** and __ out __").text).toBe("spaced ** out ** and __ out __");
    expect(plainSnippet("__init__ and a__b__c").text).toBe("init and a__b__c");
    // Real emphasis still goes, and the match stays on its words.
    expect(marked("**bold**, __x__ and ~~gone~~ here", "gone")).toBe("bold, x and [gone] here");
    expect(marked("Use snake__case **and** ** glob", "** glob")).toBe("Use snake__case and [** glob]");
});
