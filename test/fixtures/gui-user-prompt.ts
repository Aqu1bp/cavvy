import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text, type Node } from "../helpers/gui-render";
import { plural, promptTime, shortPrompt } from "../../gui/src/lib/format";
import { linesLabel, linesPhrase, splitComments } from "../../gui/src/lib/review-comments";

// The real UserPrompt (compiled from TurnView.tsx); icons, Copy and the image fetch are stand-ins.
const source = readFileSync(new URL("../../gui/src/components/TurnView.tsx", import.meta.url), "utf8").replace(/^import [\s\S]*?;\n/gm, "");
const icon = (name: string) => () => node(`icon:${name}`);
const rewinds: number[] = [];
const UserPrompt = component(source, "UserPrompt", {
    splitComments, linesLabel, linesPhrase, plural, promptTime, shortPrompt,
    formatSize: (n: number) => `${n} B`,
    findReveal: () => undefined,
    imagesReady: () => false,
    promptImages: async () => [],
    setViewedImage() {},
    openReview() {},
    CopyButton: (p: { label: string }) => { const n = node("copy"); n.props.label = p.label; return n; },
    BellRing: icon("bell"), Clock: icon("clock"), SquareTerminal: icon("terminal"), MessageSquareText: icon("comment"), FileText: icon("file"), RotateCcw: icon("rewind"),
});

const classOf = (n: Node) => String(n.props.class ?? "").split(/\s+/).filter(Boolean);
const find = (root: Node, cls: string) => all(root).find((n) => classOf(n).includes(cls));
/** The element children (Show leaves empty text nodes where it renders nothing). */
const kids = (n: Node) => n.children.filter((c) => c.tag !== "#text");
const mount = (turn: Record<string, unknown>, onRewind?: (i: number) => void) => {
    const root = node("root");
    const dispose = renderer.render(() => UserPrompt({ turn: { id: "t1", blocks: [], status: "done", ...turn }, sessionId: "s1", onRewind }), root);
    return { root, dispose, row: kids(root)[0]! };
};
const at = new Date(2026, 9, 22, 9, 41).getTime();

test("your words: the bubble, then under it (outside it) the time, Copy and Rewind", () => {
    const { row, dispose } = mount({ prompt: { text: "status?", index: 4 }, startedAt: at }, (i) => rewinds.push(i));
    expect(classOf(row)).toEqual(["user-row"]);
    expect(kids(row).map((c) => classOf(c)[0])).toEqual(["user-bubble", "user-actions"]);
    const bubble = kids(row)[0]!;
    expect(bubble.props["data-find"]).toBe("prompt");
    expect(classOf(bubble)).toContain("short");
    // Nothing but the words is in what find searches.
    expect(find(bubble, "user-actions")).toBeUndefined();
    expect(text(bubble)).toBe("status?");
    const actions = kids(row)[1]!;
    expect(actions.props["data-find-skip"]).toBe(true);
    const time = all(actions).find((n) => n.tag === "time")!;
    expect(text(time)).toBe(promptTime(at));
    expect(time.props.dateTime).toBe(new Date(at).toISOString());
    expect(all(actions).find((n) => n.tag === "copy")?.props.label).toBe("Copy prompt");
    const rewind = all(actions).find((n) => n.props["aria-label"] === "Rewind to before this prompt")!;
    rewind.props.onClick();
    expect(rewinds).toEqual([4]);
    dispose();
});

test("no time when the turn has none, and no Rewind for a steered prompt (no index) or an archived one", () => {
    const steered = mount({ prompt: { text: "also check the header" } }, () => {});
    expect(all(steered.row).some((n) => n.tag === "time")).toBe(false);
    expect(all(steered.row).some((n) => n.props["aria-label"] === "Rewind to before this prompt")).toBe(false);
    expect(all(steered.row).some((n) => n.tag === "copy")).toBe(true);
    steered.dispose();
    const archived = mount({ prompt: { text: "old", index: 2 }, archived: true, startedAt: at }, () => {});
    expect(all(archived.row).some((n) => n.props["aria-label"] === "Rewind to before this prompt")).toBe(false);
    archived.dispose();
    const noHandler = mount({ prompt: { text: "x", index: 2 } });
    expect(all(noHandler.row).some((n) => n.props["aria-label"] === "Rewind to before this prompt")).toBe(false);
    noHandler.dispose();
});

test("what came with it sits above the bubble: the schedule, then the attachments", () => {
    const { row, dispose } = mount({ prompt: { text: "Look at this, it's a longer message that wraps over more than one line of the bubble", scheduled: "Scheduled (every 10m)", images: 1, files: [{ name: "notes.txt", size: 12, lines: 2 }], index: 1 }, startedAt: at });
    expect(kids(row).map((c) => classOf(c)[0])).toEqual(["prompt-scheduled", "prompt-attachments", "user-bubble", "user-actions"]);
    expect(kids(row)[0]!.props["data-find-skip"]).toBe(true);
    expect(kids(row)[1]!.props["data-find-skip"]).toBe(true);
    expect(text(kids(row)[1]!)).toContain("1 image");
    expect(text(kids(row)[1]!)).toContain("notes.txt");
    expect(classOf(kids(row)[2]!)).not.toContain("short");
    dispose();
});

test("each kind keeps its look: a shell line, a command, a long prompt clamped with Show more, review comments", () => {
    const shell = mount({ prompt: { text: "!ls -la" } });
    expect(classOf(kids(shell.row)[0]!)).toContain("shell");
    expect(text(kids(shell.row)[0]!)).toContain("ls -la");
    expect(all(shell.row).some((n) => n.tag === "icon:terminal")).toBe(true);
    shell.dispose();

    const command = mount({ prompt: { text: "/review", command: true, index: 1 } });
    expect(classOf(kids(command.row)[0]!)).toEqual(expect.arrayContaining(["user-bubble", "command", "short"]));
    command.dispose();

    const long = mount({ prompt: { text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"), index: 1 } });
    const bubble = kids(long.row)[0]!;
    expect(classOf(bubble)).toContain("clamped");
    expect(classOf(bubble)).not.toContain("short");
    const more = find(bubble, "more")!;
    expect(text(more)).toBe("Show more");
    expect(more.props["aria-expanded"]).toBe(false);
    more.props.onClick();
    expect(classOf(bubble)).not.toContain("clamped");
    expect(text(more)).toBe("Show less");
    long.dispose();

    const comment = ["Please address these.", "", '<review_comment file="src/a.ts" lines="12">', "Make it configurable.", "", "```diff", "@@ -0,0 +12,1 @@", "+x", "```", "</review_comment>"].join("\n");
    const reviewed = mount({ prompt: { text: comment, index: 1 } });
    const b = kids(reviewed.row)[0]!;
    expect(find(b, "prompt-comments")).toBeDefined();
    expect(text(find(b, "prompt-comment-text")!)).toBe("Make it configurable.");
    // A comment makes it more than one short line.
    expect(classOf(b)).not.toContain("short");
    reviewed.dispose();
});

test("a wake row is unchanged: no bubble, no actions", () => {
    const { row, dispose } = mount({ prompt: { text: "CI passed", wake: true }, startedAt: at });
    expect(classOf(row)).toEqual(["wake-row"]);
    expect(row.props["data-find"]).toBe("prompt");
    expect(find(row, "user-actions")).toBeUndefined();
    expect(text(row)).toBe("CI passed");
    dispose();
});
