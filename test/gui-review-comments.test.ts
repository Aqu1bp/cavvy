// Review comments on the GUI's diff lines: what they quote, how they ride along
// in a message and come back out of it, where they sit when the file has moved
// on, and how they're kept between reloads.

import { describe, expect, test } from "bun:test";
import type { DiffLine } from "../src/server/protocol";
import { buildComment, formatComment, promptPreview, takesComments, lineRef, linesLabel, linesPhrase, locate, snippetLines, splitComments, withComments, type ReviewComment } from "../gui/src/lib/review-comments";
import { createReviewCommentStore, MAX_AGE, MAX_PER_SESSION, REVIEW_COMMENTS_KEY } from "../gui/src/state/review-comments";
import { promptTitle, reviewGist, titleWorthy } from "../src/server/runtime";

const ctx = (a: number, b: number, text: string): DiffLine => ({ t: "ctx", a, b, text });
const add = (b: number, text: string): DiffLine => ({ t: "add", b, text });
const del = (a: number, text: string): DiffLine => ({ t: "del", a, text });

const comment = (lines: DiffLine[], text = "Look at this", path = "src/a.ts", id = "c1") => buildComment({ id, path, lines, text, now: 1000 })!;

describe("building a comment", () => {
    test("one added line is anchored in the new file", () => {
        const c = comment([add(12, "const x = 1;")]);
        expect(c.start).toEqual({ side: "new", line: 12 });
        expect(c.end).toEqual({ side: "new", line: 12 });
        expect(c.snippet).toBe("@@ -0,0 +12,1 @@\n+const x = 1;");
        expect(linesLabel(c)).toBe("12");
        expect(linesPhrase(c)).toBe("line 12");
    });

    test("a deleted line is anchored in the old file", () => {
        const c = comment([del(7, "old()")]);
        expect(c.start).toEqual({ side: "old", line: 7 });
        expect(linesLabel(c)).toBe("−7");
        expect(linesPhrase(c)).toBe("deleted line 7");
        expect(c.snippet).toBe("@@ -7,1 +0,0 @@\n-old()");
    });

    test("a range across context, deleted and added lines keeps both files' numbers", () => {
        const c = comment([ctx(3, 3, "a"), del(4, "b"), del(5, "c"), add(4, "B"), ctx(6, 5, "d")]);
        expect(c.snippet).toBe("@@ -3,4 +3,3 @@\n a\n-b\n-c\n+B\n d");
        expect(linesLabel(c)).toBe("3–5");
        expect(linesPhrase(c)).toBe("lines 3–5");
        expect(snippetLines(c.snippet)).toEqual([ctx(3, 3, "a"), del(4, "b"), del(5, "c"), add(4, "B"), ctx(6, 5, "d")]);
    });

    test("a range that starts on a deleted line and ends on an added one names both", () => {
        const c = comment([del(4, "b"), add(4, "B"), add(5, "C")]);
        expect(linesLabel(c)).toBe("−4 to 5");
    });

    test("the comment's text is trimmed, and an empty one or a line without a number isn't a comment", () => {
        expect(comment([add(1, "x")], "  keep it  \n").text).toBe("keep it");
        expect(buildComment({ id: "c", path: "a", lines: [add(1, "x")], text: "   " })).toBeUndefined();
        expect(buildComment({ id: "c", path: "a", lines: [], text: "hi" })).toBeUndefined();
        expect(buildComment({ id: "c", path: "a", lines: [{ t: "add", text: "x" }], text: "hi" })).toBeUndefined();
    });

    test("lineRef follows the side the line lives on", () => {
        expect(lineRef(ctx(2, 3, ""))).toEqual({ side: "new", line: 3 });
        expect(lineRef(del(2, ""))).toEqual({ side: "old", line: 2 });
    });
});

describe("comments in a message", () => {
    const a = comment([add(12, "await send(user, { ttl: 15 });")], "Make the ttl configurable.", "src/auth/index.ts", "a");
    const b = comment([ctx(3, 3, "x"), del(4, "y"), add(4, "z")], "Why?\n\nIt was fine.", "src/b.ts", "b");

    test("go after the typed text as <review_comment> blocks quoting their lines", () => {
        const sent = withComments("Please address these.  \n", [a]);
        expect(sent).toBe([
            "Please address these.",
            "",
            '<review_comment file="src/auth/index.ts" lines="12">',
            "Make the ttl configurable.",
            "",
            "```diff",
            "@@ -0,0 +12,1 @@",
            "+await send(user, { ttl: 15 });",
            "```",
            "</review_comment>",
        ].join("\n"));
    });

    test("wait out shell lines and commands, read as the server reads them", () => {
        for (const t of ["!ls", "  !ls", "/compact", " /review now"]) expect(takesComments(t)).toBe(false);
        for (const t of ["", "hello", "/src/auth/index.ts leaks the token", "//not a command", "see !this"]) expect(takesComments(t)).toBe(true);
    });

    test("can be sent on their own", () => {
        expect(withComments("", [a]).startsWith("<review_comment ")).toBe(true);
        expect(withComments("   ", [a]).startsWith("<review_comment ")).toBe(true);
        expect(withComments("text", [])).toBe("text");
    });

    test("come back apart: the typed text, then each comment as it was", () => {
        const back = splitComments(withComments("Please address these.", [a, b]));
        expect(back.text).toBe("Please address these.");
        expect(back.comments).toEqual([a, b].map(({ id: _id, created: _c, ...rest }) => rest));
    });

    test("comments alone come back with no text", () => {
        const back = splitComments(withComments("", [a, b]));
        expect(back.text).toBe("");
        expect(back.comments.map((c) => c.path)).toEqual(["src/auth/index.ts", "src/b.ts"]);
    });

    test("text that closes the tag, backtick runs, quotes and fences survive the trip", () => {
        const tricky = comment([add(1, "const s = `a ```` b`;")], 'Ends with </review_comment> and "quotes" & ```js\ncode\n```', 'dir/"odd" & <name>.ts', "t");
        const block = formatComment(tricky);
        expect(block).toContain("`````diff");
        expect(block.match(/<\/review_comment>/g)).toHaveLength(1);
        const back = splitComments(withComments("Hi", [tricky, a]));
        expect(back.text).toBe("Hi");
        expect(back.comments[0]).toEqual({ path: tricky.path, start: tricky.start, end: tricky.end, text: tricky.text, snippet: tricky.snippet });
        expect(back.comments[1]!.text).toBe(a.text);
    });

    test("a message that only mentions the tag, or glues a block to its text, is left alone", () => {
        const mention = 'How do I parse <review_comment file="x" lines="1"> tags?';
        expect(splitComments(mention)).toEqual({ text: mention, comments: [] });
        const glued = `Hi${formatComment(a)}`;
        expect(splitComments(glued).comments).toHaveLength(0);
        const inline = `Hi\n\n${formatComment(a)} and more on the same line`;
        expect(splitComments(inline).comments).toHaveLength(0);
    });

    test("queued messages sent together keep each one's comments and text", () => {
        // How the server joins queued messages into one turn (drainQueued).
        const merged = [withComments("fix A", [a]), "also B", withComments("", [b])].join("\n\n");
        const back = splitComments(merged);
        expect(back.text).toBe("fix A\n\nalso B");
        expect(back.comments.map((c) => c.path)).toEqual(["src/auth/index.ts", "src/b.ts"]);
        expect(promptPreview(merged)).toBe("fix A\n\nalso B (+2 review comments)");
        expect(promptPreview(withComments("", [a]))).toBe("1 review comment");
        expect(promptPreview("plain")).toBe("plain");
    });

    test("a malformed block isn't taken for a comment", () => {
        const broken = 'Hi\n\n<review_comment file="a" lines="1">\nno fence here\n</review_comment>';
        expect(splitComments(broken)).toEqual({ text: broken, comments: [] });
    });

    test("trailing whitespace after the last block is fine", () => {
        expect(splitComments(`${withComments("Hi", [a])}\n  \n`).comments).toHaveLength(1);
    });
});

describe("finding a comment's lines again", () => {
    const file = (shift = 0): DiffLine[] => [
        ...Array.from({ length: shift }, (_, i) => add(i + 1, `// new ${i}`)),
        ctx(1, 1 + shift, "import x;"),
        del(2, "const a = 1;"),
        add(2 + shift, "const a = 2;"),
        add(3 + shift, "const b = 3;"),
        ctx(3, 4 + shift, "}"),
    ];
    const c = comment([add(2, "const a = 2;"), add(3, "const b = 3;")]);

    test("in the same place", () => {
        expect(locate(c, file())).toBe(3);
    });

    test("after lines were added above it", () => {
        expect(locate(c, file(2))).toBe(5);
    });

    test("not at all once its lines were edited: it's outdated there", () => {
        const edited = file().map((l) => (l.text === "const b = 3;" ? { ...l, text: "const b = 4;" } : l));
        expect(locate(c, edited)).toBeUndefined();
    });

    test("a deleted line isn't matched by an added line with the same text", () => {
        const d = comment([del(2, "same")]);
        expect(locate(d, [add(2, "same")])).toBeUndefined();
        expect(locate(d, [add(2, "same"), del(2, "same")])).toBe(1);
    });

    test("the copy nearest its old place wins when the lines repeat", () => {
        const one = comment([add(50, "}")]);
        const lines = [add(10, "}"), add(48, "}"), add(90, "}")];
        expect(locate(one, lines)).toBe(1);
    });

    test("stays fast on a long diff with many comments", () => {
        const lines = Array.from({ length: 10_000 }, (_, i) => (i % 2 ? add(i, `line ${i}`) : del(i, `old ${i}`)));
        const many = Array.from({ length: 200 }, (_, i) => comment([lines[i * 50 + 1]!], "x", "a", `c${i}`));
        const start = performance.now();
        for (const m of many) expect(locate(m, lines)).toBeDefined();
        // Generous: about 20 ms here. It runs when the diff or the comments change, not per frame.
        expect(performance.now() - start).toBeLessThan(1000);
    });
});

describe("keeping comments between reloads", () => {
    const memory = () => {
        const data = new Map<string, string>();
        return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k), data };
    };
    const c = (id: string, created = 1000, text = "fix this"): ReviewComment => ({ ...comment([add(1, "x")], text, "a.ts", id), created });

    test("adds, edits, removes and restores per session", () => {
        const s = memory();
        const store = createReviewCommentStore(() => s, () => 2000);
        store.add("s1", c("a"));
        store.add("s1", c("b"));
        store.add("s2", c("z"));
        store.edit("s1", "a", "  changed  ");
        store.edit("s1", "b", "   ");
        expect(store.list("s1").map((x) => [x.id, x.text])).toEqual([["a", "changed"], ["b", "fix this"]]);
        store.remove("s1", ["a"]);
        store.restore("s1", [c("r")]);
        expect(store.list("s1").map((x) => x.id)).toEqual(["b", "r"]);
        expect(store.list("s2").map((x) => x.id)).toEqual(["z"]);
        expect(store.list(undefined)).toEqual([]);
    });

    test("are written to storage and read back by the next window", () => {
        const s = memory();
        const one = createReviewCommentStore(() => s, () => 2000);
        one.add("s1", c("a"));
        one.flush();
        expect(JSON.parse(s.data.get(REVIEW_COMMENTS_KEY)!).s1[0].id).toBe("a");
        const two = createReviewCommentStore(() => s, () => 3000);
        expect(two.list("s1").map((x) => x.id)).toEqual(["a"]);
        two.remove("s1", ["a"]);
        two.flush();
        expect(s.data.has(REVIEW_COMMENTS_KEY)).toBe(false);
    });

    test("never write one that looks like a secret, and forget old ones", () => {
        const s = memory();
        const store = createReviewCommentStore(() => s, () => 2000 + MAX_AGE);
        store.add("s1", c("secret", 2000 + MAX_AGE, "use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 here"));
        store.add("s1", c("fresh", 2000 + MAX_AGE));
        store.flush();
        const saved = JSON.parse(s.data.get(REVIEW_COMMENTS_KEY)!);
        expect(saved.s1.map((x: ReviewComment) => x.id)).toEqual(["fresh"]);
        // In this tab it's still there.
        expect(store.list("s1").map((x) => x.id)).toEqual(["secret", "fresh"]);
        s.setItem(REVIEW_COMMENTS_KEY, JSON.stringify({ s1: [c("old", 1000)], s2: [c("new", 2000 + MAX_AGE - 1)] }));
        const later = createReviewCommentStore(() => s, () => 2000 + MAX_AGE);
        expect(later.list("s1")).toEqual([]);
        expect(later.list("s2").map((x) => x.id)).toEqual(["new"]);
    });

    test("ignore what isn't theirs: bad JSON, wrong shapes", () => {
        const s = memory();
        s.setItem(REVIEW_COMMENTS_KEY, "{nope");
        expect(createReviewCommentStore(() => s).list("s1")).toEqual([]);
        s.setItem(REVIEW_COMMENTS_KEY, JSON.stringify({ s1: [{ id: 1 }, "x", null, { ...c("ok", Date.now()) }], s2: "x" }));
        expect(createReviewCommentStore(() => s).list("s1").map((x) => x.id)).toEqual(["ok"]);
    });

    test("keep at most MAX_PER_SESSION per session, newest kept", () => {
        const store = createReviewCommentStore(() => undefined);
        for (let i = 0; i < MAX_PER_SESSION + 5; i++) store.add("s", c(`c${i}`));
        expect(store.list("s")).toHaveLength(MAX_PER_SESSION);
        expect(store.list("s")[0]!.id).toBe("c5");
    });

    test("two windows writing at once keep both windows' comments", () => {
        const s = memory();
        const a = createReviewCommentStore(() => s, () => 2000);
        const b = createReviewCommentStore(() => s, () => 2000);
        a.add("s1", c("from-a"));
        b.add("s2", c("from-b"));
        a.flush();
        b.refresh(); // the storage event, while b still has its own change to write
        b.flush();
        a.refresh();
        expect(a.list("s1").map((x) => x.id)).toEqual(["from-a"]);
        expect(a.list("s2").map((x) => x.id)).toEqual(["from-b"]);
        expect(b.list("s1").map((x) => x.id)).toEqual(["from-a"]);
        const saved = JSON.parse(s.data.get(REVIEW_COMMENTS_KEY)!);
        expect(Object.keys(saved).sort()).toEqual(["s1", "s2"]);
    });

    test("a comment kept in this tab only survives another window's write", () => {
        const s = memory();
        const a = createReviewCommentStore(() => s, () => 2000);
        const b = createReviewCommentStore(() => s, () => 2000);
        a.add("s1", c("secret", 2000, "token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789"));
        a.flush();
        b.add("s1", c("other"));
        b.flush();
        a.refresh();
        expect(a.list("s1").map((x) => x.id).sort()).toEqual(["other", "secret"]);
    });

    test("another window's write and edits still to be written here both stand", () => {
        const s = memory();
        const store = createReviewCommentStore(() => s, () => 2000);
        store.add("s1", c("mine"));
        s.setItem(REVIEW_COMMENTS_KEY, JSON.stringify({ s1: [c("theirs", 2000)] }));
        store.refresh();
        expect(store.list("s1").map((x) => x.id)).toEqual(["theirs", "mine"]);
        store.flush();
        store.refresh();
        expect(store.list("s1").map((x) => x.id)).toEqual(["theirs", "mine"]);
    });

    test("two windows adding to the same session before either writes keep both", () => {
        const s = memory();
        const a = createReviewCommentStore(() => s, () => 2000);
        const b = createReviewCommentStore(() => s, () => 2000);
        a.add("s1", c("from-a"));
        b.add("s1", c("from-b"));
        a.flush();
        b.refresh();
        b.flush();
        a.refresh();
        for (const ids of [a.list("s1"), b.list("s1"), JSON.parse(s.data.get(REVIEW_COMMENTS_KEY)!).s1 as ReviewComment[]].map((l) => l.map((x) => x.id))) expect(ids).toEqual(["from-a", "from-b"]);
        // Flushing without hearing of the other's write first loses nothing either.
        a.add("s1", c("a2"));
        b.add("s1", c("b2"));
        a.flush();
        b.flush();
        a.refresh();
        expect(a.list("s1").map((x) => x.id)).toEqual(["from-a", "from-b", "a2", "b2"]);
        expect(b.list("s1").map((x) => x.id)).toEqual(["from-a", "from-b", "a2", "b2"]);
    });

    test("an edit or delete in one window touches only that comment in the other", () => {
        const s = memory();
        const a = createReviewCommentStore(() => s, () => 2000);
        a.add("s1", c("one"));
        a.add("s1", c("two"));
        a.flush();
        const b = createReviewCommentStore(() => s, () => 2000);
        a.edit("s1", "one", "edited in a");
        b.remove("s1", ["two"]);
        b.add("s1", c("three"));
        b.flush();
        a.flush();
        a.refresh();
        b.refresh();
        for (const st of [a, b]) expect(st.list("s1").map((x) => [x.id, x.text])).toEqual([["one", "edited in a"], ["three", "fix this"]]);
        // A delete here isn't undone by the other window's older copy.
        a.remove("s1", ["one"]);
        b.edit("s1", "three", "again");
        a.flush();
        b.flush();
        a.refresh();
        expect(a.list("s1").map((x) => [x.id, x.text])).toEqual([["three", "again"]]);
    });
});

describe("session titles", () => {
    const a = comment([add(3, "x")], "Rename this variable", "src/a.ts");

    test("are made from the comments' words, not their markup", () => {
        const sent = withComments("", [a]);
        expect(reviewGist(sent)).toBe("Rename this variable");
        expect(titleWorthy(sent)).toBe(true);
        expect(promptTitle(reviewGist(sent))).toBe("Rename this variable");
        expect(reviewGist(withComments("Please fix", [a]))).toBe("Please fix\n\nRename this variable");
        expect(reviewGist("plain text")).toBe("plain text");
    });
});
