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
let imagesReady = false;
type Img = { mediaType: string; data: string };
let thumbsOf: () => Promise<{ mediaType: string; thumb: string }[]> = async () => [];
let wholeOf: (id: string, pos: unknown, key: string) => Promise<Img[]> = async () => [];
const viewed: { images: { name: string; full: unknown; preview?: string }[]; index: number }[] = [];
const toasts: string[] = [];
const UserPrompt = component(source, "UserPrompt", {
    splitComments, linesLabel, linesPhrase, plural, promptTime, shortPrompt,
    formatSize: (n: number) => `${n} B`,
    findReveal: () => undefined,
    imagesReady: () => imagesReady,
    promptImages: () => thumbsOf(),
    wholePromptImages: (id: string, pos: unknown, key: string) => wholeOf(id, pos, key),
    toast: (m: string) => toasts.push(m),
    setViewedImage: (v: (typeof viewed)[number]) => viewed.push(v),
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
    expect(classOf(row)).toEqual(["msg-user"]);
    expect(kids(row).map((c) => classOf(c)[0])).toEqual(["bubble", "msg-actions"]);
    const bubble = kids(row)[0]!;
    expect(bubble.props["data-find"]).toBe("prompt");
    expect(classOf(bubble)).toContain("short");
    // Nothing but the words is in what find searches.
    expect(find(bubble, "msg-actions")).toBeUndefined();
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

test("what came with it sits above the bubble: the schedule, then the images, then the files", () => {
    const { row, dispose } = mount({ prompt: { text: "Look at this, it's a longer message that wraps over more than one line of the bubble", scheduled: "Scheduled (every 10m)", images: 1, files: [{ name: "notes.txt", size: 12, lines: 2 }], index: 1 }, startedAt: at });
    expect(kids(row).map((c) => classOf(c)[0])).toEqual(["msg-tag", "msg-images", "msg-files", "bubble", "msg-actions"]);
    expect(kids(row)[0]!.props["data-find-skip"]).toBe(true);
    expect(kids(row)[1]!.props["data-find-skip"]).toBe(true);
    expect(kids(row)[2]!.props["data-find-skip"]).toBe(true);
    expect(text(kids(row)[1]!)).toContain("1 image");
    expect(text(kids(row)[2]!)).toContain("notes.txt");
    expect(classOf(kids(row)[3]!)).not.toContain("short");
    dispose();
});

test("a message that's only attachments (a side chat's answer brought back) has no empty bubble, nor Copy", () => {
    const { row, dispose } = mount({ prompt: { text: "", files: [{ name: "Side chat answer", size: 40, lines: 3, from: "side-chat" }], index: 2 }, startedAt: at }, () => {});
    expect(kids(row).map((c) => classOf(c)[0])).toEqual(["msg-files", "msg-actions"]);
    expect(text(kids(row)[0]!)).toContain("3 lines");
    expect(all(row).some((n) => n.tag === "copy")).toBe(false);
    expect(all(row).some((n) => n.props["aria-label"] === "Rewind to before this prompt")).toBe(true);
    dispose();
});

test("a prompt's images keep their places, at their shapes, from the first frame; the count when they can't be had", async () => {
    const sizes: [number, number][] = [[1280, 800], [600, 800], [0, 0]];
    const waiting = mount({ pos: { seg: 0, index: 1 }, prompt: { text: "these", images: 3, imagesKey: "k", imageSizes: sizes, index: 1 } });
    const places = all(waiting.row).filter((n) => classOf(n).includes("wait"));
    expect(places.map((n) => n.props.style.width)).toEqual(["calc(121.6 * var(--sp))", "calc(57 * var(--sp))", "calc(101 * var(--sp))"]);
    expect(places.map((n) => n.props["aria-label"])).toEqual(["Image 1 of 3", "Image 2 of 3", "Image 3 of 3"]);
    expect(text(waiting.row)).not.toContain("3 images");
    waiting.dispose();
    // Sizes from before they were sent: the count, as before.
    const unsized = mount({ prompt: { text: "these", images: 2, index: 1 } });
    expect(text(unsized.row)).toContain("2 images");
    unsized.dispose();
    // Fetched and gone (promptImages gives none): the count, not empty places.
    imagesReady = true;
    try {
        const gone = mount({ pos: { seg: 0, index: 1 }, prompt: { text: "these", images: 3, imagesKey: "k", imageSizes: sizes, index: 1 } });
        await new Promise((r) => setTimeout(r, 10));
        expect(text(gone.row)).toContain("3 images");
        expect(all(gone.row).some((n) => classOf(n).includes("wait"))).toBe(false);
        gone.dispose();
    } finally {
        imagesReady = false;
    }
});

test("a prompt's thumbnail opens the viewer on its images whole, asked for then; the thumbnails show first", async () => {
    imagesReady = true;
    const asked: unknown[][] = [];
    thumbsOf = async () => [{ mediaType: "image/png", thumb: "data:thumb1" }, { mediaType: "image/png", thumb: "data:thumb2" }];
    wholeOf = async (...a) => (asked.push(a), [{ mediaType: "image/png", data: "AAA" }, { mediaType: "image/png", data: "BBB" }]);
    try {
        const m = mount({ pos: { seg: 0, index: 3 }, prompt: { text: "these", images: 2, imagesKey: "k2", imageSizes: [[10, 10], [10, 10]], index: 3 } });
        await new Promise((r) => setTimeout(r, 10));
        const buttons = all(m.row).filter((n) => classOf(n).includes("prompt-image") && n.tag === "button");
        expect(buttons.map((b) => all(b).find((n) => n.tag === "img")?.props.src)).toEqual(["data:thumb1", "data:thumb2"]);
        // Nothing whole is asked for until one is opened.
        expect(asked).toEqual([]);
        buttons[1]!.props.onClick({ currentTarget: buttons[1] });
        await new Promise((r) => setTimeout(r, 10));
        expect(asked).toEqual([["s1", { seg: 0, index: 3 }, "k2"]]);
        expect(viewed.at(-1)).toEqual({ images: [{ name: "Image 1", full: { mediaType: "image/png", data: "AAA" }, preview: "data:thumb1" }, { name: "Image 2", full: { mediaType: "image/png", data: "BBB" }, preview: "data:thumb2" }], index: 1, from: buttons[1] } as never);
        // Gone since: no viewer, a toast.
        const before = viewed.length;
        wholeOf = async () => { throw new Error("not_found"); };
        buttons[0]!.props.onClick({ currentTarget: buttons[0] });
        await new Promise((r) => setTimeout(r, 10));
        expect(viewed.length).toBe(before);
        expect(toasts.at(-1)).toBe("Couldn't open the image");
        m.dispose();
    } finally {
        imagesReady = false;
        thumbsOf = async () => [];
        wholeOf = async () => [];
    }
});

test("each kind keeps its look: a shell line, a command, a long prompt clamped with Show more, review comments", () => {
    const shell = mount({ prompt: { text: "!ls -la" } });
    expect(classOf(kids(shell.row)[0]!)).toContain("shell");
    expect(text(kids(shell.row)[0]!)).toContain("ls -la");
    expect(all(shell.row).some((n) => n.tag === "icon:terminal")).toBe(true);
    shell.dispose();

    const command = mount({ prompt: { text: "/review", command: true, index: 1 } });
    expect(classOf(kids(command.row)[0]!)).toEqual(expect.arrayContaining(["bubble", "bubble-command", "short"]));
    command.dispose();

    const long = mount({ prompt: { text: Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"), index: 1 } });
    const bubble = kids(long.row)[0]!;
    expect(classOf(bubble)).toContain("clamped");
    expect(classOf(bubble)).not.toContain("short");
    const more = find(bubble, "bubble-more")!;
    expect(text(more)).toBe("Show more");
    expect(more.props["aria-expanded"]).toBe(false);
    more.props.onClick();
    expect(classOf(bubble)).not.toContain("clamped");
    expect(text(more)).toBe("Show less");
    long.dispose();

    const comment = ["Please address these.", "", '<review_comment file="src/a.ts" lines="12">', "Make it configurable.", "", "```diff", "@@ -0,0 +12,1 @@", "+x", "```", "</review_comment>"].join("\n");
    const reviewed = mount({ prompt: { text: comment, index: 1 } });
    const b = kids(reviewed.row)[0]!;
    // The comments under the bubble, each a card that shows its file in the review.
    const comments = kids(reviewed.row)[1]!;
    expect(classOf(comments)).toEqual(["msg-comments"]);
    expect(text(find(comments, "msg-comment-text")!)).toBe("Make it configurable.");
    expect(text(find(comments, "msg-comment-loc")!)).toBe("a.ts:12");
    // A comment makes it more than one short line.
    expect(classOf(b)).not.toContain("short");
    reviewed.dispose();
});

test("a wake row is unchanged: no bubble, no actions", () => {
    const { row, dispose } = mount({ prompt: { text: "CI passed", wake: true }, startedAt: at });
    expect(classOf(row)).toEqual(["wake-row"]);
    expect(row.props["data-find"]).toBe("prompt");
    expect(find(row, "msg-actions")).toBeUndefined();
    expect(text(row)).toBe("CI passed");
    dispose();
});
