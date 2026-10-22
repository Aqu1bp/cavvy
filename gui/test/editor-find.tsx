// The real transcript and find bar, with editor RPCs recorded instead of opening an app.
import { Show } from "solid-js";
import { render } from "solid-js/web";
import type { SessionState, ToolBlock, Turn } from "@shared/protocol";
import { TurnView } from "../src/components/TurnView";
import { FindBar } from "../src/components/FindBar";
import { findMatches, textRanges } from "../src/lib/find";
import { app, rpc, setApp } from "../src/state/app";
import { findOpen, setFindOpen, setFindQuery, setFindReveal } from "../src/state/ui";
import "../src/styles/markdown.css";

async function settle(ms = 0) {
    // Find focuses after two actual frames; don't assume CI can draw in 100ms.
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (ms) await new Promise<void>((resolve) => setTimeout(resolve, ms));
}
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}

export async function checkEditorFind(root: HTMLElement) {
    const sessionId = "editor-find-fixture";
    const read: ToolBlock = { t: "tool", id: "read", name: "Read", title: "Read(src/reader.ts)", input: { file_path: "src/reader.ts", offset: 7 }, status: "ok", summary: "read details", output: "src/reader.ts output" };
    const edit: ToolBlock = {
        t: "tool", id: "edit", name: "Edit", title: "Edit(src/edited.ts)", input: { file_path: "src/edited.ts" }, status: "ok",
        diff: { path: "src/edited.ts", status: "modified", added: 1, removed: 0, hunks: [{ oldStart: 9, oldLines: 0, newStart: 9, newLines: 1, lines: [{ t: "add", text: "edited text" }] }] },
    };
    const turn: Turn = {
        id: "editor-turn", status: "done", prompt: { text: "Inspect the files for needle", images: 1, files: [
            { kind: "text", name: "files-quokka.txt", size: 1024, lines: 3 },
            { kind: "pdf", name: "files.pdf", size: 512 },
        ] },
        blocks: [read, edit, { t: "text", id: "reply", text: "Inspect src/quokka.ts:12 near `src/quokka.ts:20` and [**quokka label**](src/quokka.ts:30)." }, { t: "compact", id: "compact", summary: "**Important** summary", auto: false },
            { t: "shell", id: "shell", command: `echo ${"x".repeat(2000)}needle`, output: "done", exitCode: 0, running: false },
            { t: "shell", id: "shell-ansi", command: "printf colors", output: "foo\x1b[31mbar\x1b[0m foobar", exitCode: 0, running: false },
            { t: "shell", id: "shell-exit", command: "printf 'e%sit' x", output: "exit", exitCode: 0, running: false },
        ],
    };
    const state = { id: sessionId, cwd: "/fixture", interactions: [] } as unknown as SessionState;
    const opened: { path: string; line?: number; sessionId: string }[] = [];
    let finishLookup: (() => void) | undefined;
    const originalCall = rpc.call;
    const previousId = app.activeId;
    rpc.call = (async (method: string, params: any) => {
        if (method === "fs.exists") return new Promise((resolve) => { finishLookup = () => resolve(params.paths.map((p: string) => `/fixture/${p}`)); });
        if (method === "fs.open") { opened.push(params); return {}; }
        throw new Error(`Unexpected fixture RPC: ${method}`);
    }) as typeof rpc.call;
    setApp("activeId", sessionId);
    setFindReveal(undefined);
    setFindQuery("quokka");
    setFindOpen(true);
    let scroller!: HTMLDivElement;
    let col!: HTMLDivElement;
    const dispose = render(() => <>
        <Show when={findOpen()}>
            <FindBar turns={() => [turn]} scroller={() => scroller} col={() => col} dock={() => 0} show={() => {}} anchor={() => undefined} clearAnchor={() => {}} />
        </Show>
        <div ref={scroller} style={{ height: "460px", overflow: "auto" }}>
            <div ref={col}><TurnView turn={turn} state={state} last /></div>
        </div>
    </>, root);
    const scope = (id: string) => col.querySelector<HTMLElement>(`[data-find="${id}"]`)!;
    const count = () => root.querySelector(".find-count")?.textContent;
    const current = () => [...CSS.highlights.get("find-current")!][0] as Range;
    const key = (target: HTMLElement, key: string, shiftKey = false) => {
        const event = new KeyboardEvent("keydown", { key, shiftKey, bubbles: true, cancelable: true });
        target.dispatchEvent(event);
        return event;
    };
    try {
        await settle();
        // File lookups are batched on a timer; two animation frames can finish
        // before that timer runs (especially on a fast display or a busy suite).
        for (let i = 0; i < 100 && !finishLookup; i++) await new Promise((r) => setTimeout(r, 20));
        // Above the bubble, in its row (the bubble is what find searches; the chips are skipped).
        check(scope("prompt").closest(".user-row")!.querySelectorAll(".prompt-attachments .chip").length === 3, "prompt displays image, text and PDF attachment chips");
        check(findMatches([turn], "files").length === 1 && textRanges(scope("prompt"), "files").length === 1, "attachment names do not duplicate a prompt match");
        for (const label of ["files.pdf", "1 KB", "1 image"]) {
            check(findMatches([turn], label).length === 0 && textRanges(col, label).length === 0, "attachment-only labels have no counted or painted matches");
        }
        check(finishLookup && !scope("reply").querySelector("a[data-file]"), "file lookup stays pending while find starts");
        check(count() === "1 of 3" && current().toString() === "quokka", "find selects plain path text before lookup resolves");
        finishLookup();
        await settle(350); // path render, then FindBar's MutationObserver rebuilds its ranges
        const links = scope("reply").querySelectorAll<HTMLAnchorElement>("a[data-file]");
        check(links.length === 3, "prose, inline code and a labelled link all become file links");
        check(findMatches([turn], "quokka").length === 3 && textRanges(col, "quokka").length === 3, "path links preserve counted text without doubling it");
        check(count() === "1 of 3" && current().startContainer.isConnected && current().startContainer.parentElement?.closest("a[data-file]"), "current highlight survives replacement of text by a file link");

        const input = root.querySelector<HTMLInputElement>(".find-bar input")!;
        check(key(input, "Enter").defaultPrevented, "find Enter is handled");
        await settle();
        check(count() === "2 of 3" && current().startContainer.parentElement?.closest("code"), "Enter selects the inline-code path");
        key(input, "Enter");
        await settle();
        check(count() === "3 of 3" && current().startContainer.parentElement?.closest("strong"), "Enter selects the nested label text");
        key(input, "Enter", true);
        await settle();
        check(count() === "2 of 3" && opened.length === 0, "Shift+Enter steps back without opening an editor");

        const across = "Inspect src/quokka.ts:12 near";
        setFindQuery(across);
        await settle();
        check(findMatches([turn], across).length === 1 && textRanges(scope("reply"), across).length === 1, "a phrase spanning a path link counts once");
        check(current().toString() === across && current().startContainer.isConnected, "highlight spans the anchor and its surrounding text");

        setFindQuery("reader.ts");
        await settle();
        check(count() === "1 of 1" && current().startContainer.parentElement?.closest(".tool-arg"), "find opens the tool row beneath its new editor-action wrapper");
        const readRow = scope("read");
        const readAction = readRow.querySelector<HTMLButtonElement>(".row-open")!;
        check(readAction.hasAttribute("data-find-skip"), "tool-row editor action is excluded from find");
        readAction.click();
        check(opened.at(-1)?.path === "src/reader.ts" && opened.at(-1)?.line === 7, "row editor action keeps its file and line");
        readRow.querySelector<HTMLButtonElement>(".tool-line")!.click();
        await settle();
        check(textRanges(readRow, "reader.ts").length === 1, "opening details doesn't duplicate the counted file path");
        const detailAction = readRow.querySelector<HTMLButtonElement>(".tool-open")!;
        check(detailAction.hasAttribute("data-find-skip") && textRanges(col, "Open in editor").length === 0, "the editor label isn't searchable tool text");
        detailAction.click();
        check(opened.at(-1)?.path === "src/reader.ts", "details editor action still works");

        setFindQuery("edited.ts");
        await settle();
        check(count() === "1 of 1" && textRanges(col, "edited.ts").length === 1, "changed-files card doesn't add another match");
        const changedAction = col.querySelector<HTMLButtonElement>(".files-card .row-open")!;
        check(changedAction.closest("[data-find-skip]"), "changed-files editor action is excluded from find");
        changedAction.click();
        check(opened.at(-1)?.path === "src/edited.ts" && opened.at(-1)?.line === 9 && opened.at(-1)?.sessionId === sessionId, "changed-files action keeps its session, path and line");

        const compact = scope("compact");
        check(!compact.querySelector(".compacted-summary"), "compaction summary begins folded");
        check(findMatches([turn], "summary").length === 1 && textRanges(compact, "summary").length === 0, "folded header contributes no match to the counted summary");
        setFindQuery("summary");
        await settle(350);
        check(count() === "1 of 1" && textRanges(compact, "summary").length === 1, "revealed summary has exactly the counted occurrence");
        check(current().toString() === "summary" && current().startContainer.parentElement?.closest(".compacted-summary"), "summary selects the body occurrence instead of the hide-summary header");
        key(input, "Enter");
        await settle();
        check(count() === "1 of 1" && current().startContainer.parentElement?.closest(".compacted-summary"), "stepping wraps to the body, never the header");
        compact.querySelector<HTMLButtonElement>(".compacted-rule button")!.click();
        check(!compact.querySelector(".compacted-summary"), "summary can be folded again");
        setFindQuery("Important summary");
        await settle(350);
        check(findMatches([turn], "Important summary").length === 1 && count() === "1 of 1", "formatted compaction summary is counted as rendered Markdown");
        check(current().toString() === "Important summary" && current().startContainer.parentElement?.closest("strong"), "formatted match is revealed and highlighted across the bold boundary");
        check(textRanges(col, "hide summary").length === 0 && textRanges(col, "Conversation compacted").length === 0, "compaction controls never enter highlight ranges");

        const shell = scope("shell");
        const command = shell.querySelector<HTMLElement>(".shell-head code")!;
        check(command.scrollWidth > command.clientWidth, "long shell command begins clipped");
        const hidden = textRanges(command, "needle")[0]!.getBoundingClientRect();
        check(hidden.left > command.getBoundingClientRect().right, "shell fixture match starts beyond the visible header");
        setFindQuery("needle");
        await settle(350);
        check(count() === "1 of 2" && current().startContainer.parentElement?.closest(".user-text"), "find starts at the prompt occurrence");
        key(input, "Enter");
        await settle(350);
        check(count() === "2 of 2" && current().toString() === "needle" && current().startContainer.parentElement === command, "Enter selects the shell-header occurrence");
        const matchBox = current().getBoundingClientRect();
        const commandBox = command.getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        check(shell.classList.contains("found") && command.scrollWidth <= command.clientWidth + 1, "selected shell command wraps without horizontal clipping");
        check(matchBox.width > 0 && matchBox.left >= commandBox.left - 1 && matchBox.right <= commandBox.right + 1 && matchBox.top >= commandBox.top - 1 && matchBox.bottom <= commandBox.bottom + 1, "match past character 2000 is visible inside the wrapped header");
        check(matchBox.top >= view.top && matchBox.bottom <= view.bottom, "selected shell-header match is inside the transcript viewport");
        key(input, "Enter", true);
        await settle();
        check(count() === "1 of 2" && !shell.classList.contains("found") && command.scrollWidth > command.clientWidth, "stepping away restores shell truncation");

        setFindQuery("exit");
        await settle(350);
        const output = scope("shell-exit").querySelector(".tcard-out")!;
        check(findMatches([turn], "exit").length === 1 && textRanges(col, "exit").length === 1, "shell status badges do not add output matches");
        check(count() === "1 of 1" && current().toString() === "exit" && current().startContainer.parentElement === output, "find selects shell output instead of its exit-status badge");
        key(input, "Enter");
        await settle();
        check(count() === "1 of 1" && current().startContainer.parentElement === output, "stepping wraps to shell output, never the status badge");

        setFindQuery("foobar");
        await settle(350);
        const ansiOutput = scope("shell-ansi").querySelector(".tcard-out")!;
        const ansiMatches = findMatches([turn], "foobar");
        const ansiRanges = textRanges(scope("shell-ansi"), "foobar");
        check(ansiMatches.length === 2 && ansiMatches.every((m, i) => m.part === "shell-ansi" && m.n === i), "ANSI escapes do not split displayed matches");
        check(findMatches([turn], "31").length === 0 && textRanges(scope("shell-ansi"), "31").length === 0, "invisible ANSI parameters are not searched");
        check(ansiRanges.length === 2 && ansiRanges.every((r, i) => r.toString() === "foobar" && r.startContainer.parentElement === ansiOutput && r.startOffset === i * 7 && r.endOffset === i * 7 + 6), "shell highlights use displayed text offsets");
        check(count() === "1 of 2" && current().toString() === "foobar" && current().startOffset === 0, "find selects the first colored output match");
        key(input, "Enter");
        await settle();
        check(count() === "2 of 2" && current().startOffset === 7, "find advances to the next displayed output match");

        const beforeKeys = opened.length;
        check(key(input, "Escape").defaultPrevented && !findOpen(), "Escape closes find");
        check(opened.length === beforeKeys, "find Escape does not launch an editor");
        check(key(links[0]!, "Enter").defaultPrevented, "file-link Enter still works after closing find");
        check(opened.length === beforeKeys + 1 && opened.at(-1)?.path === "/fixture/src/quokka.ts" && opened.at(-1)?.line === 12, "file-link keyboard action opens the right location");
    } finally {
        dispose();
        rpc.call = originalCall;
        setApp("activeId", previousId);
        setFindOpen(false);
        setFindQuery("");
        setFindReveal(undefined);
    }
}
