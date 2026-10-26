// Real-browser layout: a run of command rows in a work log lines up its right-hand parts in columns.
import { render } from "solid-js/web";
import type { ToolBlock } from "@shared/protocol";
import { ActivityGroup } from "../src/components/blocks/Activity";
import "../src/styles/tokens.css";
import "../src/styles/base.css";
import "../src/styles/transcript.css";
// The app's other styles are on the page too (a class of the same name there once made rows taller).
import "../src/styles/panel.css";

function check(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));

const run = (id: string, description: string | undefined, more: Partial<ToolBlock> = {}): ToolBlock => ({
    t: "tool", id, name: "Bash", title: "", status: "ok", durationMs: 2000, output: "done\n",
    input: { command: `cd /Users/me/project && bun test ./test/${id}.test.ts`, ...(description ? { description } : {}) }, ...more,
});
// Labels of every length; with and without the sandbox tag; a tally or not; a failure with its last line under it.
const rows: ToolBlock[] = [
    run("a", "Run GUI markdown streaming test", { sandboxed: true, output: "ok\n 5 pass\n", durationMs: 2000 }),
    run("b", "Run GUI live line test", { sandboxed: true, output: "ok\n 8 pass\n", durationMs: 68 }),
    run("c", "Typecheck", { sandboxed: true, durationMs: 701 }),
    run("d", "Run UX and transcript fixes tests", { sandboxed: true, output: "ok\n 306 pass\n", durationMs: 11_000 }),
    run("e", "Build", { status: "error", output: "error: kiwi\nExit code: 1", durationMs: 325 }),
    run("f", undefined, { durationMs: 1_500 }),
    run("g", "A very long description of what this command is for, much longer than the column has room for", { output: "ok\n 14 pass\n", durationMs: 90_000 }),
];

/** At each text size and width: each column's edge is the same on every row that has that part. */
export async function checkCommandColumns(target: HTMLElement) {
    const box = target.appendChild(document.createElement("div"));
    box.className = "worklog";
    const html = document.documentElement.style;
    const dispose = render(() => rows.map((t) => <ActivityGroup tools={[t]} steps={[t]} card="command" turnRunning={false} flat />), box);
    try {
        for (const scale of [12 / 14, 1, 18 / 14]) {
            for (const width of [720, 460]) {
                html.setProperty("--font-scale", String(scale));
                box.style.width = `${width}px`;
                await frame();
                const at = (sel: string, edge: "left" | "right") => rows.map((t) => {
                    const el = box.querySelector<HTMLElement>(`[data-find="${t.id}"] ${sel}`);
                    return el && el.childElementCount ? Math.round(el.getBoundingClientRect()[edge]) : undefined;
                }).filter((x) => x !== undefined);
                const same = (xs: number[], what: string) => check(xs.length > 1 && xs.every((x) => Math.abs(x - xs[0]!) <= 1), `${what} at text ${Math.round(scale * 14)}px, ${width}px wide: ${xs.join(", ")}`);
                same(at(".cmd-tags", "left"), "the tags start together");
                same(at(".cmd-res", "right"), "the results end together");
                same(at(".chev-w", "left"), "the chevrons line up");
                const times = rows.map((t) => box.querySelector<HTMLElement>(`[data-find="${t.id}"] .cmd-time`)!.getBoundingClientRect().right);
                same(times.map(Math.round), "the times end together");
                // Each row is one line, its label cut to fit; nothing spills past the row.
                for (const t of rows) {
                    const head = box.querySelector<HTMLElement>(`[data-find="${t.id}"] .cmd-h`)!;
                    const label = head.querySelector<HTMLElement>(".cmd-l")!;
                    check(head.scrollWidth <= head.clientWidth + 1, `${t.id}: the row fits its width (${head.scrollWidth} > ${head.clientWidth})`);
                    check(label.getBoundingClientRect().right <= head.querySelector<HTMLElement>(".cmd-tags")!.getBoundingClientRect().left + 1, `${t.id}: the label stops before the tags`);
                    // Its parts sit on one line, in the middle of the row, whatever's in them.
                    const line = head.getBoundingClientRect();
                    for (const cell of head.children) {
                        const b = cell.getBoundingClientRect();
                        if (b.height) check(b.top >= line.top - 0.5 && b.bottom <= line.bottom + 0.5 && Math.abs((b.top + b.bottom) / 2 - (line.top + line.bottom) / 2) <= 1, `${t.id}: ${cell.className} is centred in the row (${b.top}–${b.bottom} in ${line.top}–${line.bottom})`);
                    }
                }
            }
        }
        // Folded, a row shows what it's for, not the command; with no description (Codex), the command, past its cd.
        check(!box.querySelector('[data-find="a"] .cmd-h')!.textContent!.includes("bun test"), "a described row doesn't show its command folded");
        check(box.querySelector('[data-find="f"] .cmd-l')!.textContent === "bun test ./test/f.test.ts", "a row with no description is labelled with its command, shortened");
    } finally {
        html.removeProperty("--font-scale");
        dispose();
        box.remove();
    }
}
