// Browser regression fixture: actual Solid rows, find ranges and transcript CSS.
import { render } from "solid-js/web";
import { createStore } from "solid-js/store";
import type { ToolBlock, Turn } from "@shared/protocol";
import { ActivityGroup } from "../src/components/blocks/Activity";
import { findMatches, textRanges } from "../src/lib/find";
import { setFindReveal } from "../src/state/ui";
import { checkEditorFind } from "./editor-find";
import { checkTranscriptScroll } from "./transcript-scroll";
import { checkPaletteDelete } from "./palette-delete";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/transcript.css";

const root = document.getElementById("root")!;
const result = document.getElementById("result")!;
const frame = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function check(ok: unknown, message: string): asserts ok {
    if (!ok) throw new Error(message);
}
const tool = (id: string, command: string): ToolBlock => ({
    t: "tool", id, name: "Bash", title: command, input: { command }, status: "running",
    summary: "Run summary", progress: "Run output", startedAt: Date.now(),
});
const [tools, setTools] = createStore([
    tool("first", `echo ${"long-argument-".repeat(45)}quokka-end`),
    tool("second", "sleep 60; echo Run"),
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
            const matches = findMatches([turn()], "Run");
            const ranges = textRanges(row("second"), "Run");
            check(matches.length === 1 && matches[0]!.part === "second", `${status}: count only the argument`);
            check(ranges.length === matches.length, `${status}: drawn matches equal counted matches`);
            check(ranges[0]!.startContainer.parentElement?.classList.contains("tool-arg"), `${status}: highlight argument, not verb`);
            const button = row("second").querySelector<HTMLButtonElement>(".tool-line")!;
            button.click();
            await frame();
            check(textRanges(row("second"), "Run").length === 1, `${status}: expanded details must not add live matches`);
            button.click();
        }
        setTools(1, "status", "streaming");
        await frame();
        check(findMatches([turn()], "Run").length === 0 && textRanges(row("second"), "Run").length === 0, "input still arriving is not searched in either rendering path");
        setTools(1, "status", "ok");
        await frame();
        check(findMatches([turn()], "Run").length === 3 && textRanges(row("second"), "Run").length === 3, "finished call restores verb and summary matching");
        check(findMatches([turn()], "Run sleep").length === 1 && textRanges(row("second"), "Run sleep").length === 1, "finished row retains spaces between title parts");
    } finally {
        dispose();
    }
}
run().then(() => checkEditorFind(root)).then(() => checkPaletteDelete(root)).then(() => checkTranscriptScroll(root)).then(() => {
    result.textContent = "PASS: live tool find; deferred file links and ranges; editor actions and find keys; deleted palette hits; transcript scroll";
    result.dataset.status = "passed";
}).catch((error) => {
    result.textContent = String(error.stack ?? error);
    result.dataset.status = "failed";
});
