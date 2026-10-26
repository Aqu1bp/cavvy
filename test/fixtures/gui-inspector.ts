// The inspector's controls rendered with real Solid reactivity in an in-memory DOM (run by gui-inspector.test.ts):
// the diff reader's resize handle and side-by-side toggle, and the side panel's Changes pane.
import { expect, test } from "bun:test";
import { readFileSync } from "fs";
import * as solid from "../../gui/node_modules/solid-js/dist/solid.js";
import { all, component, node, renderer, text } from "../helpers/gui-render";
import { CHANGE, dirOf, nameOf, REVIEW_DEFAULT, REVIEW_MIN, REVIEW_STEP, reviewDragWidth, reviewWidthRange } from "../../gui/src/lib/inspector";
import { frameDrag } from "../../gui/src/lib/drag";
import { fakeFrames } from "../helpers/frames";

const review = readFileSync(new URL("../../gui/src/components/ReviewPane.tsx", import.meta.url), "utf8");
const panel = readFileSync(new URL("../../gui/src/components/RightPanel.tsx", import.meta.url), "utf8");
const between = (source: string, from: string, to: string) => source.slice(source.indexOf(from), source.indexOf(to));

test("the reader's handle starts from the width shown, not the saved one, and takes arrow keys and a double-click", () => {
    const world = dragWorld();
    const frames = fakeFrames();
    const shown: (number | undefined)[] = [];
    const Resizer = component(between(review, "function ReviewResizer(", "export function ReviewPane("), "ReviewResizer", {
        // Saved at 420; the layout shows it at 640 (55% of the sheet).
        // A 1400px sheet: the conversation keeps 480, so it can widen to 920.
        shellLayout: () => ({ sheet: { w: 1400 }, inspector: { mode: "dock", width: 640 } }),
        setPrefs: (key: string, value: number) => saved.push([key, value]),
        setReviewDrag: (w: number | undefined) => shown.push(w),
        frameDrag: (o: Parameters<typeof frameDrag>[0]) => frameDrag({ ...o, frames }),
        reviewDragWidth, reviewWidthRange, REVIEW_DEFAULT, REVIEW_STEP,
        window: world.window, document: world.document,
    });
    const saved: [string, number][] = [];
    const root = node("root");
    const dispose = renderer.render(() => Resizer({}), root);
    try {
        const handle = all(root).find((n) => String(n.props.class).includes("rv-resizer"))!;
        expect(handle.props.role).toBe("separator");
        expect(handle.props["aria-valuenow"]).toBe(640);
        // Its range is the real one in pixels, not the 0-100 a separator defaults to.
        expect(handle.props["aria-valuemin"]).toBe(REVIEW_MIN);
        expect(handle.props["aria-valuemax"]).toBe(920);
        const listeners = world.listeners;
        const target = {};
        handle.props.onPointerDown({ button: 0, clientX: 500, pointerId: 1, preventDefault() {}, currentTarget: target });
        // Ten pixels left widens it from 640 on the next frame: no dead zone up to the width shown.
        listeners.pointermove!({ clientX: 490 });
        frames.run();
        expect(shown).toEqual([650]);
        // Moves within a frame show once, at the latest; nothing is saved until the release.
        listeners.pointermove!({ clientX: 520 });
        listeners.pointermove!({ clientX: 530 });
        frames.run();
        expect(shown).toEqual([650, 610]);
        expect(saved).toEqual([]);
        expect(world.classes.has("resizing")).toBe(true);
        // The release saves the last width at once, shown or not, and stops showing the dragged one.
        listeners.pointermove!({ clientX: 540 });
        listeners.pointerup!({});
        expect(saved).toEqual([["reviewWidth", 600]]);
        expect(shown).toEqual([650, 610, undefined]);
        expect(frames.pending()).toBe(0);
        expect(listeners.pointermove).toBeUndefined();
        expect(world.classes.has("resizing")).toBe(false);
        // Only the main button drags.
        const before = saved.length;
        handle.props.onPointerDown({ button: 2, clientX: 500, preventDefault() {}, currentTarget: target });
        expect(saved.length).toBe(before);
        const key = (k: string) => {
            let prevented = false;
            handle.props.onKeyDown({ key: k, preventDefault: () => (prevented = true) });
            return prevented;
        };
        expect(key("ArrowLeft")).toBe(true);
        expect(saved.at(-1)).toEqual(["reviewWidth", 640 + REVIEW_STEP]);
        expect(key("ArrowRight")).toBe(true);
        expect(saved.at(-1)).toEqual(["reviewWidth", 640 - REVIEW_STEP]);
        const n = saved.length;
        expect(key("Enter")).toBe(false);
        expect(saved.length).toBe(n);
        handle.props.onDblClick();
        expect(saved.at(-1)).toEqual(["reviewWidth", REVIEW_DEFAULT]);
    } finally {
        dispose();
    }
});

/** A stand-in for `window` and `document.body`: the listeners a drag adds, and the body's classes. */
function dragWorld() {
    const listeners: Record<string, ((e: any) => void) | undefined> = {};
    const classes = new Set<string>();
    return {
        listeners,
        classes,
        window: { addEventListener: (type: string, fn: any) => (listeners[type] = fn), removeEventListener: (type: string, fn: any) => listeners[type] === fn && delete listeners[type] },
        document: { body: { classList: { add: (c: string) => classes.add(c), remove: (c: string) => classes.delete(c) } } },
    };
}

test("closing the reader in the middle of a drag ends it: no resizing class or listeners left behind, and the width so far is kept", () => {
    const world = dragWorld();
    const frames = fakeFrames();
    const saved: [string, number][] = [];
    let shown: number | undefined;
    const Resizer = component(between(review, "function ReviewResizer(", "export function ReviewPane("), "ReviewResizer", {
        shellLayout: () => ({ sheet: { w: 1400 }, inspector: { mode: "dock", width: 640 } }),
        setPrefs: (key: string, value: number) => saved.push([key, value]),
        setReviewDrag: (w: number | undefined) => (shown = w),
        frameDrag: (o: Parameters<typeof frameDrag>[0]) => frameDrag({ ...o, frames }),
        reviewDragWidth, reviewWidthRange, REVIEW_DEFAULT, REVIEW_STEP,
        window: world.window, document: world.document,
    });
    const root = node("root");
    const dispose = renderer.render(() => Resizer({}), root);
    const handle = all(root).find((n) => String(n.props.class).includes("rv-resizer"))!;
    const el = { setPointerCapture() {}, addEventListener() {}, removeEventListener() {} };
    handle.props.onPointerDown({ button: 0, clientX: 500, pointerId: 1, preventDefault() {}, currentTarget: el });
    expect(world.classes.has("resizing")).toBe(true);
    world.listeners.pointermove!({ clientX: 480 });
    frames.run();
    expect(shown).toBe(660);
    // Esc closes the reader while the button is still down: the handle goes away.
    dispose();
    expect(world.classes.has("resizing")).toBe(false);
    expect(Object.keys(world.listeners).filter((k) => world.listeners[k])).toEqual([]);
    expect(saved).toEqual([["reviewWidth", 660]]);
    expect(shown).toBeUndefined();
    expect(frames.pending()).toBe(0);
});

test("the side-by-side toggle sets the shared split signal the layout widens the inspector for, and says so pressed", () => {
    const [reviewSplit, setReviewSplit] = solid.createSignal(false);
    const Toggle = component(between(review, "function SplitToggle(", "/**\n * The reader's left edge"), "SplitToggle", {
        reviewSplit, setReviewSplit,
        Columns2: () => node("icon"),
    });
    const root = node("root");
    const dispose = renderer.render(() => Toggle(), root);
    try {
        const button = () => all(root).find((n) => n.tag === "button")!;
        expect(button().props["aria-pressed"]).toBe(false);
        button().props.onClick();
        expect(reviewSplit()).toBe(true);
        expect(button().props["aria-pressed"]).toBe(true);
        expect(button().props.title).toBe("Unified");
        button().props.onClick();
        expect(reviewSplit()).toBe(false);
    } finally {
        dispose();
    }
});

test("the Changes pane: counts, a row per file opening the reader on it, and the empty and error states", () => {
    const opened: unknown[][] = [];
    const Pane = component(between(panel, "function FileRow(", "/** Pull requests the agent watches"), "ChangesPane", {
        CHANGE, dirOf, nameOf,
        plural: (n: number, w: string) => `${n} ${n === 1 ? w : `${w}s`}`,
        openReview: (...args: unknown[]) => opened.push(args),
        Spinner: () => node("spinner"),
        FileDiff: () => node("icon"),
    });
    const [changes, setChanges] = solid.createSignal<any>({
        repo: true, count: 3, more: 1, atLeast: false, added: 7, removed: 2, error: undefined,
        files: [
            { path: "src/auth/index.ts", change: "modified", added: 6, removed: 2 },
            { path: "README.md", change: "untracked", added: 1, removed: 0 },
        ],
    });
    const root = node("root");
    const dispose = renderer.render(() => Pane({ get changes() { return changes(); } }), root);
    const rows = () => all(root).filter((n) => n.props.class === "file");
    try {
        expect(text(root)).toContain("+7−2in 3 files");
        expect(text(root)).toContain("1 more not shown");
        expect(rows().map((r) => text(r))).toEqual(["Mindex.tssrc/auth/+6−2", "UREADME.md+1"]);
        rows()[0]!.props.onClick();
        expect(opened.at(-1)).toEqual(["src/auth/index.ts", "uncommitted"]);
        all(root).find((n) => n.props.class === "btn ghost sm")!.props.onClick();
        expect(opened.at(-1)).toEqual([undefined, "uncommitted"]);
        // Outside a repository: Harness's own record, and the reader opens on it.
        setChanges({ repo: false, count: 1, more: 0, atLeast: false, added: 1, removed: 0, files: [{ path: "notes.md", change: "added", added: 1, removed: 0 }] });
        rows()[0]!.props.onClick();
        expect(opened.at(-1)).toEqual(["notes.md", "harness"]);
        // Nothing changed: a blank pane that still opens the reader (the branch, a turn).
        setChanges({ repo: true, count: 0, more: 0, atLeast: false, added: 0, removed: 0, files: [] });
        expect(text(root)).toContain("No changes yet");
        expect(text(root)).toContain("The working tree matches the last commit.");
        all(root).find((n) => n.props.class === "link-btn")!.props.onClick();
        expect(opened.at(-1)).toEqual([undefined, "uncommitted"]);
        // Git couldn't say: why, rather than "no changes".
        setChanges({ repo: true, count: 0, more: 0, atLeast: false, added: 0, removed: 0, files: [], error: "fatal: bad object HEAD" });
        expect(text(root)).toContain("Changes unavailable");
        expect(text(root)).toContain("fatal: bad object HEAD");
        expect(text(root)).not.toContain("No changes yet");
        // Still loading.
        setChanges(undefined);
        expect(all(root).some((n) => n.tag === "spinner")).toBe(true);
    } finally {
        dispose();
    }
});

/** useFolderChanges with git's answer and the server's replies under the test's control. */
function folderChanges(reply: () => Promise<unknown>) {
    const calls: string[] = [];
    const errors: unknown[] = [];
    const [git, setGit] = solid.createSignal<any>(undefined);
    const [busy, setBusy] = solid.createSignal(false);
    const use = component(between(panel, "function useFolderChanges(", "function FileRow("), "useFolderChanges", {
        useGitChanges: () => [git],
        sessionReadReady: () => true,
        reportError: (e: unknown) => errors.push(e),
        rpc: { call: (method: string) => (calls.push(method), reply()) },
    });
    const handle = { id: "s1", view: { state: { filesChanged: 0, get busy() { return busy(); } } } };
    let changes!: () => any;
    const dispose = solid.createRoot((d: () => void) => ((changes = use(() => handle)), d));
    return { calls, errors, setGit, setBusy, changes, dispose };
}
const settle = () => new Promise((r) => setTimeout(r, 0));

test("outside a repository, Harness's record is asked for once per change, not again for each git reply", async () => {
    const f = folderChanges(async () => ({ files: [{ path: "notes.md", status: "added", added: 2, removed: 0, hunks: [] }], added: 2, removed: 0, tracked: true }));
    try {
        f.setGit({ repo: false, files: [], added: 0, removed: 0, bases: [], more: 0 });
        await settle();
        expect(f.calls).toEqual(["session.changes"]);
        expect(f.changes()).toMatchObject({ repo: false, count: 1, added: 2 });
        // Git answers again (its own refetch on the same change): the same "not a repository".
        f.setGit({ repo: false, files: [], added: 0, removed: 0, bases: [], more: 0 });
        await settle();
        expect(f.calls).toEqual(["session.changes"]);
        // A real change (a turn starts): one more.
        f.setBusy(true);
        await settle();
        f.setGit({ repo: false, files: [], added: 0, removed: 0, bases: [], more: 0 });
        await settle();
        expect(f.calls).toEqual(["session.changes", "session.changes"]);
    } finally {
        f.dispose();
    }
});
test("outside a repository, a failed request says so and leaves the reader reachable, rather than loading for ever", async () => {
    const f = folderChanges(async () => {
        throw new Error("session is gone");
    });
    try {
        f.setGit({ repo: false, files: [], added: 0, removed: 0, bases: [], more: 0 });
        await settle();
        expect(f.changes()).toMatchObject({ repo: false, count: 0, files: [], error: "session is gone" });
        expect(f.errors).toHaveLength(1);
    } finally {
        f.dispose();
    }
});
