// Real-browser checks of commenting on diff lines: the actual DiffView, its
// gutter, keyboard and comment boxes, with a local list of comments in place
// of the session's store. Also a bound on a 10,000-line diff's cost.
import { render } from "solid-js/web";
import { createSignal } from "solid-js";
import type { DiffLine, FileDiff } from "@shared/protocol";
import { DiffView, type DiffComments } from "../src/components/blocks/DiffView";
import { buildComment, type ReviewComment } from "../src/lib/review-comments";
import { textRanges } from "../src/lib/find";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/transcript.css";

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 30));
async function until(ok: () => unknown, ms = 1000) {
    for (const end = performance.now() + ms; !ok() && performance.now() < end; ) await settle();
    return ok();
}
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}

function diffOf(lines: DiffLine[], path = "src/a.ts"): FileDiff {
    return { path, status: "modified", added: lines.filter((l) => l.t === "add").length, removed: lines.filter((l) => l.t === "del").length, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 0, lines }] };
}
const small: FileDiff = {
    path: "src/a.ts",
    status: "modified",
    added: 3,
    removed: 2,
    hunks: [
        { oldStart: 1, oldLines: 4, newStart: 1, newLines: 5, lines: [
            { t: "ctx", a: 1, b: 1, text: "import x;" },
            { t: "del", a: 2, text: "const a = 1;" },
            { t: "del", a: 3, text: "const b = 1;" },
            { t: "add", b: 2, text: "const a = 2;" },
            { t: "add", b: 3, text: "const b = 2;" },
            { t: "add", b: 4, text: "const c = 2;" },
            { t: "ctx", a: 4, b: 5, text: "}" },
        ] },
        { oldStart: 20, oldLines: 1, newStart: 21, newLines: 1, lines: [{ t: "ctx", a: 20, b: 21, text: "export {};" }] },
    ],
};

function setup(diff: () => FileDiff, split: () => boolean) {
    const [list, setList] = createSignal<ReviewComment[]>([]);
    let n = 0;
    const comments: DiffComments = {
        get list() {
            return list();
        },
        add: (lines, text, around) => setList((l) => [...l, buildComment({ id: `c${n++}`, path: diff().path, lines, text, ...around })!]),
        edit: (id, text) => setList((l) => l.map((c) => (c.id === id ? { ...c, text } : c))),
        remove: (id) => setList((l) => l.filter((c) => c.id !== id)),
    };
    return { list, setList, comments };
}

function gutter(root: HTMLElement, idx: number, side: "l" | "r" | "" = "") {
    const el = root.querySelector<HTMLElement>(`.ln${side ? `.${side}` : ""}[data-g="${idx}"]`);
    check(el, `no gutter for row ${idx}${side ? ` (${side})` : ""}`);
    return el;
}
function pointer(type: string, el: HTMLElement, init: PointerEventInit = {}) {
    const r = el.getBoundingClientRect();
    const target = type === "pointerdown" ? el : window;
    target.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: r.left + 4, clientY: r.top + r.height / 2, ...init }));
}
async function type(root: HTMLElement, text: string) {
    const ta = root.querySelector<HTMLTextAreaElement>(".dc-input")!;
    check(document.activeElement === ta, "the comment box takes focus as soon as it opens");
    ta.value = text;
    ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
    await settle();
    return ta;
}
const key = (el: HTMLElement, key: string, init: KeyboardEventInit = {}) => {
    const e = new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true, ...init });
    el.dispatchEvent(e);
    return e;
};

export async function checkDiffComments(root: HTMLElement) {
    const style = root.style.cssText;
    root.style.cssText = "width: 700px";
    const [split, setSplit] = createSignal(false);
    const [diff, setDiff] = createSignal(small);
    const s = setup(diff, split);
    const dispose = render(() => <DiffView diff={diff()} split={split()} comments={s.comments} />, root);
    try {
        await settle();
        const rows = root.querySelector<HTMLElement>(".diff-rows")!;
        check(rows.classList.contains("commentable") && rows.tabIndex === 0, "a commentable diff is one tab stop");
        check(!root.querySelector("button.ln, .ln button"), "no per-line buttons: the gutter's + is drawn by CSS");

        // Click one gutter: a box under that line; Ctrl/Cmd+Enter adds the comment.
        pointer("pointerdown", gutter(root, 4));
        pointer("pointerup", gutter(root, 4));
        await settle();
        let ta = await type(root, "  Rename b  ");
        check(ta.closest(".dc-slot")?.previousElementSibling?.getAttribute("data-i") === "4", "the box sits under the clicked line");
        key(ta, "Enter", { ctrlKey: true, metaKey: true });
        await settle();
        check(s.list().length === 1 && s.list()[0]!.text === "Rename b" && s.list()[0]!.start.line === 3, "the comment is added, trimmed, on new line 3");
        check(JSON.stringify([s.list()[0]!.before, s.list()[0]!.after]) === JSON.stringify([["-const b = 1;", "+const a = 2;"], ["+const c = 2;", " }"]]), `it keeps two lines either side, from its hunk (${JSON.stringify([s.list()[0]!.before, s.list()[0]!.after])})`);
        check(root.querySelectorAll(".dc-card").length === 1 && !root.querySelector(".dc-box"), "it shows as a card and the box closes");
        check(document.activeElement === rows, "focus goes back to the diff");

        // Drag over several lines, past the hunk's end: the pick stays in its hunk.
        pointer("pointerdown", gutter(root, 2));
        pointer("pointermove", gutter(root, 6));
        await settle();
        check(root.querySelectorAll(".csel").length === 5, `dragging marks the lines picked (${root.querySelectorAll(".csel").length}; ${(() => { const r = gutter(root, 6).getBoundingClientRect(); const e = document.elementFromPoint(r.left + 4, r.top + r.height / 2); return `${e?.className} at ${r.left},${r.top} vp ${innerWidth}x${innerHeight} scroll ${scrollY}`; })()})`);
        pointer("pointermove", root.querySelector<HTMLElement>(`[data-i="8"]`)!);
        await settle();
        check(root.querySelectorAll(".csel").length === 5 && !root.querySelector(`[data-i="8"].csel`), "a pick can't cross into the next hunk");
        pointer("pointerup", gutter(root, 6));
        await settle();
        ta = await type(root, "Both changed");
        // Esc on the box's buttons closes the box too, not the pane.
        const cancel = root.querySelector<HTMLButtonElement>(".dc-box .btn.ghost")!;
        cancel.focus();
        const escButton = key(cancel, "Escape");
        await settle();
        check(escButton.defaultPrevented && !root.querySelector(".dc-box"), "Esc with focus on Cancel closes only the box");
        pointer("pointerdown", gutter(root, 2));
        pointer("pointerup", gutter(root, 6));
        await settle();
        ta = await type(root, "Both changed");
        // Esc cancels the box without letting the review pane close.
        const esc = key(ta, "Escape");
        check(esc.defaultPrevented, "Esc in a comment box is handled there (the pane checks defaultPrevented)");
        await settle();
        check(!root.querySelector(".dc-box") && s.list().length === 1, "Esc drops the unsaved comment");

        // Keyboard: arrows move, Shift extends, Enter opens the box.
        rows.focus();
        key(rows, "End");
        await settle();
        check(root.querySelector(".ccur")?.getAttribute("data-i") === "8", "End goes to the last line");
        key(rows, "Home");
        key(rows, "ArrowDown", { shiftKey: true });
        key(rows, "ArrowDown", { shiftKey: true });
        await settle();
        check(root.querySelectorAll(".csel").length === 3, "Shift+arrows pick lines");
        key(rows, "Enter");
        await settle();
        ta = await type(root, "From the keyboard");
        root.querySelector<HTMLButtonElement>(".dc-box .btn.primary")!.click();
        await settle();
        const kb = s.list()[1]!;
        check(kb.start.side === "new" && kb.start.line === 1 && kb.end.side === "old" && kb.end.line === 3, `keyboard comment covers new 1 to old 3 (${JSON.stringify([kb.start, kb.end])})`);

        // Edit and delete from the card.
        const card = root.querySelector<HTMLElement>(".dc-card")!;
        card.querySelector<HTMLButtonElement>('[aria-label^="Edit comment"]')!.click();
        await settle();
        ta = root.querySelector<HTMLTextAreaElement>(".dc-input")!;
        check(ta.value === "Rename b" || ta.value === "From the keyboard", "editing starts from the comment's text");
        const before = ta.value;
        ta.value = `${before}!`;
        ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
        key(ta, "Enter", { ctrlKey: true, metaKey: true });
        await settle();
        check(s.list().some((c) => c.text === `${before}!`), "the edit is kept");
        root.querySelector<HTMLButtonElement>('[aria-label^="Delete comment"]')!.click();
        await settle();
        check(s.list().length === 1, "delete removes it");

        // Split view: a deleted line on the left gutter.
        setSplit(true);
        await settle();
        pointer("pointerdown", gutter(root, 2, "l"));
        pointer("pointerup", gutter(root, 2, "l"));
        await settle();
        ta = await type(root, "Old side");
        key(ta, "Enter", { ctrlKey: true, metaKey: true });
        await settle();
        const left = s.list().at(-1)!;
        check(left.start.side === "old" && left.start.line === 3, "split view's left gutter comments on the old file");
        check(root.querySelectorAll(".dc-card").length === 2, "split view shows the comments");
        setSplit(false);
        await settle();

        // A refresh while writing (an edit landed): the box keeps its lines, its text and its focus.
        pointer("pointerdown", gutter(root, 5));
        pointer("pointerup", gutter(root, 5));
        await settle();
        await type(root, "Half-written");
        const shifted = structuredClone(small);
        shifted.hunks[0]!.lines.unshift({ t: "add", b: 1, text: "// pushed down" });
        for (const l of shifted.hunks[0]!.lines.slice(1)) if (l.b !== undefined) l.b++;
        setDiff(shifted);
        await settle();
        let box = root.querySelector<HTMLTextAreaElement>(".dc-input");
        check(box && box.value === "Half-written" && document.activeElement === box, "the box survives a refresh with its text and focus");
        const under = () => box!.isConnected ? box!.closest(".dc-slot")?.previousElementSibling : root.querySelector(".dc-input")?.closest(".dc-slot")?.previousElementSibling;
        check(await until(() => under()?.textContent?.includes("const c = 2;")), `and stays under the same line after it moved (${under()?.outerHTML.slice(0, 200)})`);
        // Focus elsewhere: a refresh doesn't pull it back into the box.
        const outside = document.createElement("input");
        document.body.append(outside);
        outside.focus();
        setDiff(structuredClone(shifted));
        await settle();
        box = root.querySelector<HTMLTextAreaElement>(".dc-input");
        check(box && document.activeElement === outside, "a refresh doesn't steal focus from elsewhere");
        outside.remove();
        key(box, "Escape");
        await settle();
        setDiff(small);
        await settle();

        // Changing a saved comment survives a refresh, and another window's write: its text and its focus,
        // even with a new comment open under the same line.
        const savedCard = root.querySelector<HTMLElement>(".dc-slot .dc-card")!;
        const savedRow = Number(savedCard.closest(".dc-slot")!.previousElementSibling!.getAttribute("data-i"));
        pointer("pointerdown", gutter(root, savedRow));
        pointer("pointerup", gutter(root, savedRow));
        await settle();
        check(root.querySelector(".dc-box:not([data-edit])"), "a new comment opens under the commented line");
        savedCard.querySelector<HTMLButtonElement>('[aria-label^="Edit comment"]')!.click();
        await settle();
        const editBox = () => root.querySelector<HTMLTextAreaElement>(".dc-box[data-edit] .dc-input");
        check(editBox() && document.activeElement === editBox(), "Edit opens a focused box");
        editBox()!.value = "Changed, not saved";
        editBox()!.dispatchEvent(new InputEvent("input", { bubbles: true }));
        const savedTexts = JSON.stringify(s.list().map((c) => c.text));
        setDiff(structuredClone(small));
        await settle();
        check(editBox()?.value === "Changed, not saved" && document.activeElement === editBox(), `an edit under way survives a refresh, focus and all (${editBox()?.value}, ${document.activeElement?.className})`);
        s.setList((l) => l.map((c) => ({ ...c })));
        await settle();
        check(editBox()?.value === "Changed, not saved" && document.activeElement === editBox(), "and another window's write to the comments");
        const save = root.querySelector<HTMLButtonElement>(".dc-box[data-edit] .btn.primary")!;
        save.focus();
        const escSave = key(save, "Escape");
        await settle();
        check(escSave.defaultPrevented && !editBox() && JSON.stringify(s.list().map((c) => c.text)) === savedTexts, "Esc on Save drops the edit and keeps the pane");
        key(root.querySelector<HTMLTextAreaElement>(".dc-input")!, "Escape");
        await settle();

        // The same line twice: a box open on one doesn't move to the other when its line is edited.
        const twin = diffOf(([[10, "a();"], [11, "return x;"], [12, "c();"], [29, "b();"], [30, "return x;"], [31, "d();"]] as const).map(([b, text]): DiffLine => ({ t: "add", b, text })));
        setDiff(twin);
        await settle();
        pointer("pointerdown", gutter(root, 4));
        pointer("pointerup", gutter(root, 4));
        await settle();
        await type(root, "On the second");
        const twinEdited = structuredClone(twin);
        twinEdited.hunks[0]!.lines[4]!.text = "return y;";
        setDiff(twinEdited);
        await settle();
        check(!root.querySelector(".dc-input"), `the box closes rather than jump to the other copy (${root.querySelector(".dc-input")?.closest(".dc-slot")?.previousElementSibling?.getAttribute("data-i")})`);
        // A box that closes on a refresh while focus is elsewhere doesn't stop the next one from taking it.
        setDiff(twin);
        await settle();
        pointer("pointerdown", gutter(root, 4));
        pointer("pointerup", gutter(root, 4));
        await settle();
        const elsewhere = document.createElement("input");
        document.body.append(elsewhere);
        elsewhere.focus();
        setDiff(structuredClone(twinEdited));
        await settle();
        elsewhere.remove();
        check(!root.querySelector(".dc-input"), "an unfocused box whose lines changed closes");
        pointer("pointerdown", gutter(root, 1));
        pointer("pointerup", gutter(root, 1));
        await settle();
        await type(root, "Next one");
        key(root.querySelector<HTMLTextAreaElement>(".dc-input")!, "Escape");
        await settle();
        setDiff(small);
        await settle();

        // The file changes under the comments: moved lines follow, edited ones are outdated.
        const moved = structuredClone(small);
        moved.hunks[0]!.lines.unshift({ t: "add", b: 1, text: "// new first line" });
        for (const l of moved.hunks[0]!.lines.slice(1)) if (l.b !== undefined) l.b++;
        setDiff(moved);
        await settle();
        check(!root.querySelector(".dc-outdated") && root.querySelectorAll(".dc-slot .dc-card").length === 2, "moved lines keep their comments");
        const edited = structuredClone(moved);
        for (const l of edited.hunks[0]!.lines) if (l.t !== "ctx") l.text += " // edited";
        setDiff(edited);
        await settle();
        check(root.querySelectorAll(".dc-outdated .dc-card.outdated").length === s.list().length && !root.querySelector(".dc-slot"), "comments whose lines changed are listed as outdated, not on other lines");
    } finally {
        dispose();
    }

    // A 10,000-line diff in a box that scrolls, as in the review pane: only the rows near the view are drawn.
    const big = diffOf(Array.from({ length: 10_000 }, (_, i): DiffLine => (i % 2 ? { t: "add", b: i, text: `const v${i} = compute(${i});` } : { t: "del", a: i, text: `const v${i} = old(${i});` })));
    // Far down, one line much wider than the rest: the diff scrolls sideways as far, wherever the view is.
    big.hunks[0]!.lines[9000] = { t: "add", b: 9000, text: `const wide = "${"w".repeat(400)}";` };
    const scroller = document.createElement("div");
    scroller.style.cssText = "height: 600px; overflow: auto";
    scroller.className = "dv-fixture";
    // As in the review pane (review.css): the page scrolls the diff, not a box of its own.
    const paneStyle = Object.assign(document.createElement("style"), { textContent: ".dv-fixture .diff-scroll { max-height: none; }" });
    document.head.append(paneStyle);
    root.append(scroller);
    const drawn = () => scroller.querySelectorAll(".dl").length;
    const scrollTo = async (idx: number) => {
        const h = scroller.querySelector<HTMLElement>(".dl:not(.dv-sizer)")!.getBoundingClientRect().height;
        scroller.scrollTop = idx * h - 200;
        await until(() => scroller.querySelector(`[data-i="${idx}"]`));
        await settle();
    };
    const t0 = performance.now();
    const [bigDiff] = createSignal(big);
    const b = setup(bigDiff, () => false);
    const disposeBig = render(() => <DiffView diff={bigDiff()} comments={b.comments} />, scroller);
    try {
        await settle();
        const mount = performance.now() - t0;
        check(drawn() > 20 && drawn() < 300, `a long diff draws only the rows near the view (${drawn()} of 10,000)`);
        const rowsBox = scroller.querySelector<HTMLElement>(".diff-rows")!;
        const height = rowsBox.getBoundingClientRect().height;
        check(height > 10_000 * 15, `spacers keep the whole diff's height (${height}px)`);
        const wide = scroller.querySelector<HTMLElement>(".diff-scroll")!.scrollWidth;
        check(wide > 400 * 6, `the widest line, not drawn yet, sets how far it scrolls sideways (${wide}px)`);

        // Down to line 5,000: drawn as the view gets there, and the rows above let go.
        await scrollTo(5000);
        check(!scroller.querySelector(`[data-i="10"]`) && drawn() < 300, `scrolled down, the top rows aren't drawn (${drawn()}: ${[...scroller.querySelectorAll(".dl[data-i], .dv-gap")].map((e) => (e as HTMLElement).dataset.i ?? `gap ${(e as HTMLElement).dataset.from}-${(e as HTMLElement).dataset.to}`).join(" ").slice(0, 300)}; sel ${JSON.stringify(document.getSelection()?.toString().slice(0, 40))} ${document.activeElement?.className})`);
        check(Math.abs(rowsBox.getBoundingClientRect().height - height) < 200, "the height stays put as rows are measured");
        check(scroller.querySelector<HTMLElement>(".diff-scroll")!.scrollWidth === wide, "and so does the width");

        // Commenting there: a drag, a box, a card; nothing redrawn.
        const t1 = performance.now();
        pointer("pointerdown", gutter(scroller, 5000));
        for (let i = 5001; i <= 5010; i++) pointer("pointermove", gutter(scroller, i));
        pointer("pointerup", gutter(scroller, 5010));
        const drag = performance.now() - t1;
        await settle();
        check(scroller.querySelectorAll(".csel").length === 11, `the drag marks the lines picked (${scroller.querySelectorAll(".csel").length})`);
        const ta = scroller.querySelector<HTMLTextAreaElement>(".dc-input")!;
        check(document.activeElement === ta, "the box takes focus");
        ta.value = "On a big diff";
        ta.dispatchEvent(new InputEvent("input", { bubbles: true }));
        // Scrolled far away while writing: the box stays drawn, text and focus kept.
        const box = ta.closest(".dc-slot")!;
        scroller.scrollTop = 0;
        await until(() => scroller.querySelector(`[data-i="5"]`));
        await settle();
        check(box.isConnected && document.activeElement === ta && ta.value === "On a big diff", `a comment being written stays drawn when the view leaves it (${box.isConnected}, ${document.activeElement === ta}, ${ta.value}, ${[...scroller.querySelectorAll<HTMLElement>(".dl[data-i], .dv-gap")].map((e) => e.dataset.i ?? `gap ${e.dataset.from}-${e.dataset.to}`).join(" ").slice(0, 300)})`);
        await scrollTo(5000);
        const kept = scroller.querySelector(`[data-i="5000"]`);
        const t2 = performance.now();
        key(ta, "Enter", { ctrlKey: true, metaKey: true });
        const addJs = performance.now() - t2;
        await new Promise((r) => requestAnimationFrame(() => r(undefined)));
        const add = performance.now() - t2;
        check(scroller.querySelector(`[data-i="5000"]`) === kept, "adding a comment keeps the rows (no redraw)");
        check(b.list().length === 1 && b.list()[0]!.start.line === 5000 && scroller.querySelectorAll(".dc-card").length === 1, "the comment shows on the big diff");
        const anchoredUnder = () => scroller.querySelector(".dc-card")?.closest(".dc-slot")?.previousElementSibling?.getAttribute("data-i");
        check(anchoredUnder() === "5010", `under its last line (${anchoredUnder()})`);
        // Away and back: drawn again under the same line.
        scroller.scrollTop = 0;
        await until(() => !scroller.querySelector(".dc-card"));
        await scrollTo(5010);
        check(anchoredUnder() === "5010", `back in view, the comment is under its line again (${anchoredUnder()})`);

        // A selection holds its rows: scrolled far off, its text is still there to copy.
        const texts = (idx: number) => {
            const w = document.createTreeWalker(scroller.querySelector(`[data-i="${idx}"] .txt`)!, NodeFilter.SHOW_TEXT);
            const out: Text[] = [];
            for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n as Text);
            return out;
        };
        const from = texts(5003)[0]!;
        const to = texts(5006).at(-1)!;
        const sel = document.getSelection()!;
        sel.setBaseAndExtent(from, 0, to, to.length);
        await settle();
        scroller.scrollTop = scroller.scrollHeight;
        await until(() => scroller.querySelector(`[data-i="9999"]`));
        await settle();
        check(sel.toString().includes("const v5004 = old(5004);") && sel.toString().includes("const v5006 = old(5006);"), `a selection keeps its rows drawn (${JSON.stringify(sel.toString().slice(0, 80))})`);
        sel.removeAllRanges();
        await settle();

        // The keyboard: Home goes to the first line, drawn and in view.
        const rows = scroller.querySelector<HTMLElement>(".diff-rows")!;
        rows.focus();
        key(rows, "Home");
        await settle();
        const cur = scroller.querySelector(".ccur");
        check(cur?.getAttribute("data-i") === "0", `Home draws and marks the first line (${cur?.getAttribute("data-i")})`);
        const cb = cur!.getBoundingClientRect();
        const vb = scroller.getBoundingClientRect();
        check(cb.top >= vb.top - 1 && cb.bottom <= vb.bottom + 1, "and scrolls it into view");
        (window as unknown as { diffCommentTimings: unknown }).diffCommentTimings = { mount, drag, add };
        check(mount < 1500 && drag < 1500 && add < 1000, `mount, drag and add stay quick on 10,000 lines (mount ${mount.toFixed(0)} ms, drag ${drag.toFixed(0)} ms, add ${add.toFixed(0)} ms, of which script ${addJs.toFixed(0)} ms)`);
    } finally {
        disposeBig();
        scroller.remove();
        paneStyle.remove();
    }

    // The transcript's diffs (no comments) draw every row: find counts and marks text in all of them.
    const [whole] = createSignal(diffOf(Array.from({ length: 2000 }, (_, i): DiffLine => ({ t: "add", b: i + 1, text: `kiwi row ${i}` }))));
    const disposeWhole = render(() => <DiffView diff={whole()} />, root);
    try {
        await settle();
        check(root.querySelectorAll(".dl").length === 2000 && !root.querySelector(".dv-gap"), "a diff without comments is drawn whole");
        check(textRanges(root, "kiwi row 1999").length === 1, "find sees its last line");
    } finally {
        disposeWhole();
        root.style.cssText = style;
    }
}
