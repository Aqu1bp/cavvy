// Browser regression fixture: actual Solid rows, find ranges and transcript CSS.
import { render } from "solid-js/web";
import { createStore } from "solid-js/store";
import type { NoticeBlock, ToolBlock, Turn } from "@shared/protocol";
import { ActivityGroup } from "../src/components/blocks/Activity";
import { Notice } from "../src/components/TurnView";
import { findMatches, textRanges } from "../src/lib/find";
import { setFindReveal } from "../src/state/ui";
import { checkEditorFind } from "./editor-find";
import { checkTranscriptScroll } from "./transcript-scroll";
import { checkCommandColumns } from "./command-columns";
import { checkPaletteDelete } from "./palette-delete";
import { checkDiffComments } from "./diff-comments";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/transcript.css";

const root = document.getElementById("root")!;
const result = document.getElementById("result")!;
const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
/** After the next paint, when scroll events have been delivered. */
const paint = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
/** Drawn where the reader can see it: not clipped to a pixel, as screen-reader-only text is. */
const visible = (r: Range) => {
    const el = r.startContainer.parentElement!;
    const box = el.getBoundingClientRect();
    return el.checkVisibility() && box.width > 1 && box.height > 1;
};
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
// A call that stays a row in its group (commands and edits get cards of their own, checked below).
const tool = (id: string, description: string): ToolBlock => ({
    t: "tool", id, name: "Monitor", title: description, input: { description }, status: "running",
    summary: "Monitor summary", progress: "Monitor output", startedAt: Date.now(),
});
const [tools, setTools] = createStore([
    tool("first", `echo ${"long-argument-".repeat(45)}quokka-end`),
    tool("second", "sleep 60; echo Monitor"),
]);
const turn = (): Turn => ({ id: "turn", blocks: tools, status: "running" });
const row = (id: string) => root.querySelector<HTMLElement>(`[data-find="${id}"]`)!;

async function run() {
    const dispose = render(() => <ActivityGroup tools={tools} steps={tools} turnRunning />, root);
    try {
        await frame();
        for (const status of ["running", "queued", "awaiting"] as const) {
            setTools(0, "status", status);
            setFindReveal(undefined);
            await frame();
            const arg = row("first").querySelector<HTMLElement>(".warg")!;
            check(arg.scrollWidth > arg.clientWidth, `${status}: fixture argument must start clipped`);
            check(findMatches([turn()], "quokka-end").length === 1, `${status}: count long argument once`);
            setFindReveal({ turnId: "turn", part: "first" });
            await frame();
            const range = textRanges(row("first"), "quokka-end")[0]!;
            const box = range.getBoundingClientRect();
            const bounds = arg.getBoundingClientRect();
            check(row("first").classList.contains("found"), `${status}: selected live row has find state`);
            check(box.width > 0 && box.left >= bounds.left - 1 && box.right <= bounds.right + 1 && box.top >= bounds.top - 1 && box.bottom <= bounds.bottom + 1,
                `${status}: match past ellipsis must be visible inside the argument`);
            setFindReveal(undefined);
            await frame();
            check(!row("first").classList.contains("found") && arg.scrollWidth > arg.clientWidth, `${status}: deselection restores truncation`);
        }

        setFindReveal({ turnId: "turn", part: "second" });
        await frame();
        // One row component draws every call; running calls are styled as live activity.
        check(row("first").querySelector(".tool-line.live") && row("second").classList.contains("tool"), "fixture must render both calls through the shared row");
        for (const status of ["running", "queued", "awaiting"] as const) {
            setTools(1, "status", status);
            await frame();
            const matches = findMatches([turn()], "Monitor");
            const ranges = textRanges(row("second"), "Monitor");
            check(matches.length === 1 && matches[0]!.part === "second", `${status}: count only the argument`);
            check(ranges.length === matches.length, `${status}: drawn matches equal counted matches`);
            check(ranges[0]!.startContainer.parentElement?.classList.contains("tool-arg"), `${status}: highlight argument, not verb`);
            const button = row("second").querySelector<HTMLButtonElement>(".tool-line")!;
            button.click();
            await frame();
            check(textRanges(row("second"), "Monitor").length === 1, `${status}: expanded details must not add live matches`);
            button.click();
        }
        setTools(1, "status", "streaming");
        await frame();
        check(findMatches([turn()], "Monitor").length === 0 && textRanges(row("second"), "Monitor").length === 0, "input still arriving is not searched in either rendering path");
        setTools(1, "status", "ok");
        await frame();
        check(findMatches([turn()], "Monitor").length === 3 && textRanges(row("second"), "Monitor").length === 3, "finished call restores verb and summary matching");
        check(findMatches([turn()], "Monitor sleep").length === 1 && textRanges(row("second"), "Monitor sleep").length === 1, "finished row retains spaces between title parts");
    } finally {
        dispose();
    }
    await checkCards();
}

/**
 * Command and edit cards: what find counts is what it can highlight, in every state. A command card is
 * folded until it's opened; find counts a finished one's output too, and opens it to show a match.
 */
async function checkCards() {
    const box = root.appendChild(document.createElement("div"));
    // More than one line, so its card opens on the whole command; its output cut short, so it offers the rest.
    const command: ToolBlock = {
        t: "tool", id: "cmd", name: "Bash", title: "echo kiwi", input: { command: "echo kiwi\necho kiwi again" }, status: "running",
        summary: "kiwi summary", output: "kiwi output\nlast kiwi line", outputTruncated: true, progress: "kiwi progress", startedAt: Date.now(),
    };
    const edit: ToolBlock = {
        t: "tool", id: "edit", name: "Edit", title: "Edit(src/kiwi.ts)", input: { file_path: "src/kiwi.ts" }, status: "running", summary: "kiwi summary", startedAt: Date.now(),
        diff: { path: "src/kiwi.ts", status: "modified", added: 1, removed: 0, hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, lines: [{ t: "add", text: "kiwi line" }] }] },
    };
    const [cards, setCards] = createStore([command, edit]);
    const dispose = render(() => <>
        <ActivityGroup tools={[cards[0]!]} steps={[cards[0]!]} card="command" turnRunning />
        <ActivityGroup tools={[cards[1]!]} steps={[cards[1]!]} card="edit" turnRunning />
    </>, box);
    const card = (id: string) => box.querySelector<HTMLElement>(`[data-find="${id}"]`)!;
    const counted = (i: 0 | 1, query: string) => findMatches([{ id: "cards", blocks: [cards[i]!], status: "running" }], query).length;
    /** What find highlights in the card matches what it counts, and every highlight can be seen. */
    const same = (i: 0 | 1, status: string, when: string) => {
        const id = cards[i]!.id;
        // The argument, summary and output, and the verb ("Run", "Edit") the screen reader hears but the card doesn't show.
        for (const query of ["kiwi", i === 0 ? "Run" : "Edit"]) {
            const drawn = textRanges(card(id), query);
            check(drawn.length === counted(i, query), `${id} ${status} ${when}: drawn matches of "${query}" (${drawn.length}) equal counted matches (${counted(i, query)})`);
            for (const r of drawn) check(visible(r), `${id} ${status} ${when}: a match of "${query}" is in "${r.startContainer.parentElement?.className}", which isn't visible`);
        }
    };
    try {
        for (const status of ["streaming", "queued", "awaiting", "running", "ok", "error", "denied"] as const) {
            for (const i of [0, 1] as const) {
                setCards(i, "status", status);
                setFindReveal(undefined);
                await frame();
                const id = cards[i]!.id;
                check(card(id).classList.contains("tcard"), `${id} ${status}: drawn as a card`);
                if (i === 1) {
                    same(i, status, "as drawn");
                    continue;
                }
                // Folded, as every command card starts (and as this one is left after find opened it).
                const head = card(id).querySelector<HTMLElement>("[role=button].cmd-h")!;
                check(head, `${id} ${status}: the row is a button`);
                if (head.getAttribute("aria-expanded") === "true") head.click();
                await frame();
                check(!card(id).querySelector(".cmd-body"), `${id} ${status}: folded, the card shows no body`);
                const folded = textRanges(card(id), "kiwi").length;
                check(folded <= counted(i, "kiwi"), `${id} ${status}: folded, no more drawn matches (${folded}) than counted`);
                // Its last line under the row isn't counted, since the body find opens has it.
                const tail = card(id).querySelector<HTMLElement>(".cmd-tail");
                check(status === "running" || status === "error" ? tail?.textContent === (status === "running" ? "kiwi progress" : "last kiwi line") : !tail, `${id} ${status}: last line in the header is "${tail?.textContent}"`);
                check(!tail || tail.closest("[data-find-skip]"), `${id} ${status}: the row's last line is skipped by find`);
                // While its command is still arriving there's nothing to open, and find counts none of it.
                if (status === "streaming") {
                    check(!head.hasAttribute("aria-expanded") && head.getAttribute("aria-disabled") === "true", `${id} ${status}: nothing to open yet`);
                    check(counted(i, "kiwi") === 0, `${id} ${status}: find counts nothing while it arrives`);
                    continue;
                }
                // Find opens it, on everything it counted.
                setFindReveal({ turnId: "cards", part: id });
                await frame();
                // (Once its command has arrived there's a body in every state: while it's live, find counts none of it.)
                check(head.getAttribute("aria-expanded") === "true", `${id} ${status}: find opens the card (aria-expanded ${head.getAttribute("aria-expanded")})`);
                check(card(id).querySelector(".cmd-body"), `${id} ${status}: the body is drawn once find opened the card`);
                same(i, status, "opened by find");
                check(textRanges(card(id), "Show full output").length === 0, `${id} ${status}: "Show full output" isn't counted`);
            }
        }
    } finally {
        setFindReveal(undefined);
        dispose();
        box.remove();
    }
}
/** A command's live output stays at its end as it grows, a burst of lines included, unless the reader scrolled up in it. */
async function checkCommandFollow() {
    const box = root.appendChild(document.createElement("div"));
    const lines = (from: number, n: number) => Array.from({ length: n }, (_, i) => `line ${from + i}\n`).join("");
    const [cmd, setCmd] = createStore<ToolBlock>({ t: "tool", id: "follow", name: "Bash", title: "make", input: { command: "make" }, status: "running", progress: lines(0, 15), startedAt: Date.now() });
    const dispose = render(() => <ActivityGroup tools={[cmd]} steps={[cmd]} card="command" turnRunning />, box);
    try {
        await paint();
        // Folded until it's opened: its last line under the row, the output only once opened.
        check(!box.querySelector(".cmd-body") && box.querySelector(".cmd-tail")?.textContent === "line 14", "follow: a running command starts folded on its last line");
        box.querySelector<HTMLElement>("[role=button].cmd-h")!.click();
        await paint();
        const out = box.querySelector<HTMLElement>(".cmd-out pre")!;
        const gap = () => out.scrollHeight - out.scrollTop - out.clientHeight;
        check(out.scrollHeight > out.clientHeight, "follow fixture: output must start scrolling");
        check(gap() < 2, `follow: starts at the end (${gap()}px from it)`);
        for (let n = 15; n < 36; n += 4) {
            setCmd("progress", (p) => p + lines(n, 4));
            await paint();
            check(gap() < 2, `follow: four more lines keep it at the end (${gap()}px from it, scrollHeight ${out.scrollHeight})`);
        }
        out.scrollTop = 0;
        out.dispatchEvent(new Event("scroll"));
        await paint();
        setCmd("progress", (p) => p + lines(40, 4));
        await paint();
        check(out.scrollTop === 0, `follow: a reader who scrolled up stays there (scrollTop ${out.scrollTop})`);
        out.scrollTop = out.scrollHeight;
        out.dispatchEvent(new Event("scroll"));
        await paint();
        setCmd("progress", (p) => p + lines(44, 4));
        await paint();
        check(gap() < 2, `follow: back at the end, it follows again (${gap()}px from it)`);
    } finally {
        dispose();
        box.remove();
    }
}

/** A notice's folded details (#300): find counts them as the lines they're drawn on, and opens the fold to show one. */
async function checkNoticeDetails() {
    const box = root.appendChild(document.createElement("div"));
    const block: NoticeBlock = { t: "notice", id: "stopped", level: "warn", text: "Stopped 2 background tasks", details: ["top", "Stop checks"] };
    const dispose = render(() => <Notice block={block} />, box);
    const notice = () => box.querySelector<HTMLElement>('[data-find="stopped"]')!;
    try {
        await frame();
        const counted = findMatches([{ id: "notice", blocks: [block], status: "done" }], "stop");
        // "Stopped" and "Stop checks": not "tasks" and "top" run together (the heading's end and the first name).
        check(counted.length === 2, `notice: counted ${counted.length} matches of "stop"`);
        check(textRanges(notice(), "stop").length === 1, "notice: folded, only the heading is drawn (the names' preview isn't counted)");
        setFindReveal({ turnId: "notice", part: "stopped" });
        await frame();
        check(notice().querySelector(".notice-h")?.getAttribute("aria-expanded") === "true", "notice: find opens the fold");
        const drawn = textRanges(notice(), "stop");
        check(drawn.length === counted.length, `notice: drawn matches (${drawn.length}) equal counted (${counted.length})`);
        check(drawn.map((r) => r.toString()).join("|") === "Stop|Stop", `notice: each match is within one line (${drawn.map((r) => r.toString()).join("|")})`);
        check(drawn[1]!.startContainer.parentElement?.closest("li")?.textContent?.includes("Stop checks"), "notice: the second match is in the second name");
    } finally {
        setFindReveal(undefined);
        dispose();
        box.remove();
    }
}

run().then(() => checkNoticeDetails()).then(() => checkCommandFollow()).then(() => checkCommandColumns(root)).then(() => checkEditorFind(root)).then(() => checkPaletteDelete(root)).then(() => checkTranscriptScroll(root)).then(() => checkDiffComments(root)).then(() => {
    result.textContent = "PASS: live tool find; notice details; command output follows; command columns; deferred file links and ranges; editor actions and find keys; deleted palette hits; transcript scroll; diff comments";
    result.dataset.status = "passed";
}).catch((error) => {
    result.textContent = String(error.stack ?? error);
    result.dataset.status = "failed";
});
