// The diff reader's stacked files (gui/src/lib/review-stack.ts): which files have one side, what the view
// menu offers and calls each view, how tall a file not drawn yet is guessed to be, which file's header is
// stuck, and how far the scroll moves when files above the view change height.
import { describe, expect, test } from "bun:test";
import { anchorShift, cardAt, foldsSmoothly, oneSided, stackRows, viewLabel, viewMenu, VIEWS } from "../gui/src/lib/review-stack";

const line = (t: "add" | "del" | "ctx") => ({ t, text: "x" });
const hunk = (lines: ReturnType<typeof line>[], oldStart = 1) => ({ oldStart, oldLines: 1, newStart: 1, newLines: 1, lines });

describe("one side", () => {
    test("a new, untracked or deleted file has one side: its own lines only", () => {
        expect(oneSided({ status: "added", change: "untracked", hunks: [hunk([line("add"), line("add")])] })).toBe(true);
        expect(oneSided({ status: "added", hunks: [hunk([line("add")])] })).toBe(true);
        expect(oneSided({ status: "deleted", change: "deleted", hunks: [hunk([line("del")])] })).toBe(true);
        // Nothing to draw (a binary file, a new empty one): one side all the same.
        expect(oneSided({ status: "added", change: "added", hunks: [] })).toBe(true);
    });

    test("an edit has two sides, and so does a new or deleted file whose lines say otherwise", () => {
        expect(oneSided({ status: "modified", change: "modified", hunks: [hunk([line("add")])] })).toBe(false);
        // A rename with edits, a type change: both sides are there.
        expect(oneSided({ status: "modified", change: "renamed", hunks: [hunk([line("del"), line("add")])] })).toBe(false);
        expect(oneSided({ status: "modified", change: "typechange", hunks: [hunk([line("add")])] })).toBe(false);
        // Git's change wins over the edit tools' status.
        expect(oneSided({ status: "added", change: "modified", hunks: [hunk([line("add")])] })).toBe(false);
        // A line of the other side (or context) would lose its number in one column: two sides.
        expect(oneSided({ status: "added", change: "added", hunks: [hunk([line("add"), line("ctx")])] })).toBe(false);
        expect(oneSided({ status: "deleted", hunks: [hunk([line("del"), line("add")])] })).toBe(false);
    });
});

describe("the view menu", () => {
    const turns = [
        { id: 4, prompt: "Bump the schema", startedAt: 1, endedAt: 2 },
        { id: 7, prompt: "Fix the docs", startedAt: 3, endedAt: 4 },
        { id: 9, prompt: "Plan the fix", startedAt: 5 },
    ];

    test("the button names the view, or the turn by its place in the session", () => {
        expect(viewLabel("uncommitted")).toBe("Uncommitted");
        expect(viewLabel("branch")).toBe("Branch");
        expect(viewLabel("last-turn")).toBe("Last turn");
        expect(viewLabel("cavvy")).toBe("Cavvy edits");
        expect(viewLabel("turn", 7, turns)).toBe("Turn 2");
        // Not listed (yet): no number to give it.
        expect(viewLabel("turn", 12, turns)).toBe("Turn");
        expect(viewLabel("turn", undefined, undefined)).toBe("Turn");
        // One line each, in place of the paragraph under the diff; the long note stays as the item's title.
        for (const v of Object.values(VIEWS)) expect(v.desc).not.toContain("\n");
    });

    test("at home: the four views, the recorded turns newest first, a running one not yet pickable", () => {
        const m = viewMenu({ place: { scope: "turn" }, turnId: 7, repo: true, turns, busy: true, branch: "main", base: "origin/main" });
        expect(m.views.map((v) => [v.scope, v.on, v.disabled])).toEqual([
            ["uncommitted", false, undefined],
            ["branch", false, undefined],
            ["last-turn", false, undefined],
            ["cavvy", false, undefined],
        ]);
        expect(m.views[1]!.desc).toBe("Everything on main since it left origin/main");
        expect(m.turns.map((t) => [t.id, t.label, t.on, Boolean(t.disabled)])).toEqual([
            [9, "Turn 3", false, true],
            [7, "Turn 2", true, false],
            [4, "Turn 1", false, false],
        ]);
        // Not running (the turn ended without its end recorded): pickable, as today.
        expect(viewMenu({ place: { scope: "uncommitted" }, repo: true, turns, busy: false }).turns[0]!.disabled).toBeUndefined();
        expect(viewMenu({ place: { scope: "uncommitted" }, repo: true, turns, busy: false }).views[0]!.on).toBe(true);
    });

    test("another worktree: Git's views only, no turns", () => {
        const m = viewMenu({ place: { worktree: "/repo/wt", scope: "branch" }, repo: true, turns, busy: false });
        expect(m.views.map((v) => [v.scope, v.on, Boolean(v.disabled)])).toEqual([
            ["uncommitted", false, false],
            ["branch", true, false],
            ["last-turn", false, true],
            ["cavvy", false, true],
        ]);
        expect(m.turns).toEqual([]);
    });

    test("outside a Git repository: Cavvy edits is all there is, and Git's views say why", () => {
        const m = viewMenu({ place: { scope: "uncommitted" }, repo: false, reason: "Not a Git repository.", turns: undefined, busy: false });
        expect(m.views.map((v) => [v.scope, v.on, v.disabled])).toEqual([
            ["uncommitted", false, "Not a Git repository."],
            ["branch", false, "Not a Git repository."],
            ["last-turn", false, "Not a Git repository."],
            ["cavvy", true, undefined],
        ]);
    });
});

describe("the stack", () => {
    test("a file not drawn yet is as many rows as DiffView draws: its lines, and a header for each hunk after the file's top", () => {
        expect(stackRows({ hunks: [hunk([line("add"), line("add")])] })).toBe(2);
        expect(stackRows({ hunks: [hunk([line("ctx")], 10)] })).toBe(2);
        expect(stackRows({ hunks: [hunk([line("ctx"), line("add")]), hunk([line("del")], 40)] })).toBe(4);
        // Its hunks still to come (deferred): guessed from its counts, with some context.
        expect(stackRows({ hunks: [], added: 10, removed: 5 })).toBe(21);
        expect(stackRows({ hunks: [] })).toBe(0);
        // Deferred and not counted: a screenful, so files waiting for their hunks aren't all fetched at once.
        expect(stackRows({ hunks: [], added: 0, removed: 0, deferred: true })).toBe(24);
    });

    test("folding is smooth for ordinary files, instant for very long ones", () => {
        expect(foldsSmoothly(40)).toBe(true);
        expect(foldsSmoothly(400)).toBe(true);
        expect(foldsSmoothly(401)).toBe(false);
    });

    test("the file under a point: the last one starting at or above it", () => {
        const tops = [0, 100, 250, 900];
        const at = (y: number) => cardAt(tops.length, (i) => tops[i]!, y);
        expect(at(-1)).toBe(-1);
        expect(at(0)).toBe(0);
        expect(at(99)).toBe(0);
        expect(at(100)).toBe(1);
        expect(at(899)).toBe(2);
        expect(at(5000)).toBe(3);
        expect(cardAt(0, () => 0, 10)).toBe(-1);
    });

    test("files above the view that change height move the scroll by as much; the one in view and those below don't", () => {
        // In view from 1000: a file above grew by 300 (drawn at last), one further up shrank by 50.
        expect(anchorShift([{ top: 0, before: 400, after: 350 }, { top: 350, before: 200, after: 500 }], 1000)).toBe(250);
        // The file the view is in (it keeps its own rows in place) and files below: nothing.
        expect(anchorShift([{ top: 900, before: 600, after: 900 }], 1000)).toBe(0);
        expect(anchorShift([{ top: 1400, before: 100, after: 900 }], 1000)).toBe(0);
        // Ending right at the view's top is above it.
        expect(anchorShift([{ top: 600, before: 400, after: 420 }], 1000)).toBe(20);
        // Tops are taken after the change: a file below one that grew is still found above the view.
        expect(anchorShift([{ top: 0, before: 100, after: 400 }, { top: 400, before: 500, after: 520 }], 700)).toBe(320);
        expect(anchorShift([], 10)).toBe(0);
    });
});
