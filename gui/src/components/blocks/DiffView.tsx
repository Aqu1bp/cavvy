import { createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ChevronDown, FileMinus2, FilePlus2, FileText } from "lucide-solid";
import type { DiffLine, FileDiff } from "@shared/protocol";
import { highlightLines } from "../../lib/highlight";
import { langOf, plural } from "../../lib/format";
import { escapeHtml } from "../../lib/markdown";

type Row = { kind: "line"; line: DiffLine; old?: number; new?: number; idx: number } | { kind: "sep"; text: string };
type Line = Extract<Row, { kind: "line" }>;
/** Side by side: the old line on the left, the new one on the right; a lone side leaves the other blank. */
type Pair = { kind: "pair"; left?: Line; right?: Line } | { kind: "sep"; text: string };

function pairUp(rows: Row[]): Pair[] {
    const out: Pair[] = [];
    let dels: Line[] = [];
    let adds: Line[] = [];
    const flush = () => {
        for (let i = 0; i < Math.max(dels.length, adds.length); i++) out.push({ kind: "pair", left: dels[i], right: adds[i] });
        dels = [];
        adds = [];
    };
    for (const r of rows) {
        if (r.kind === "sep") {
            flush();
            out.push(r);
        } else if (r.line.t === "del") {
            if (adds.length) flush();
            dels.push(r);
        } else if (r.line.t === "add") adds.push(r);
        else {
            flush();
            out.push({ kind: "pair", left: r, right: r });
        }
    }
    flush();
    return out;
}

export function DiffStat(p: { added: number; removed: number; class?: string }) {
    return (
        <span class={`diffstat ${p.class ?? ""}`}>
            <Show when={p.added || !p.removed}>
                <span class="add">+{p.added}</span>
            </Show>
            <Show when={p.removed}>
                <span class="del">−{p.removed}</span>
            </Show>
        </span>
    );
}

export function FileIcon(p: { status: FileDiff["status"]; size?: number }) {
    const s = p.size ?? 14;
    return (
        <Show when={p.status === "added"} fallback={<Show when={p.status === "deleted"} fallback={<FileText size={s} />}><FileMinus2 size={s} class="tone-del" /></Show>}>
            <FilePlus2 size={s} class="tone-add" />
        </Show>
    );
}

export function DiffView(p: { diff: FileDiff; maxLines?: number; header?: boolean; split?: boolean; class?: string }) {
    const [expanded, setExpanded] = createSignal(false);
    const [visible, setVisible] = createSignal(false);
    const [oldHl, setOldHl] = createSignal<string[]>();
    const [newHl, setNewHl] = createSignal<string[]>();
    let el: HTMLDivElement | undefined;

    const rows = createMemo<Row[]>(() => {
        const out: Row[] = [];
        let oi = 0;
        let ni = 0;
        p.diff.hunks.forEach((h, hi) => {
            if (hi > 0 || h.oldStart > 1) out.push({ kind: "sep", text: `@@ −${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@` });
            for (const l of h.lines) {
                const r: Row = { kind: "line", line: l, idx: out.length };
                if (l.t !== "add") r.old = oi++;
                if (l.t !== "del") r.new = ni++;
                out.push(r);
            }
        });
        return out;
    });
    const total = () => rows().filter((r) => r.kind === "line").length;
    const limit = () => (expanded() || !p.maxLines ? Infinity : p.maxLines);
    const shown = createMemo(() => {
        let n = 0;
        return rows().filter((r) => (r.kind === "line" ? ++n <= limit() : n < limit()));
    });

    onMount(() => {
        if (!el) return;
        const io = new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && setVisible(true), { rootMargin: "300px" });
        io.observe(el);
        onCleanup(() => io.disconnect());
    });

    // Highlight each side once the diff is on screen.
    createEffect(
        on([visible, () => p.diff], ([v, d]) => {
            if (!v) return;
            const lang = langOf(d.path);
            if (!lang) return;
            const lines = d.hunks.flatMap((h) => h.lines);
            void highlightLines(lines.filter((l) => l.t !== "add").map((l) => l.text).join("\n"), lang).then(setOldHl);
            void highlightLines(lines.filter((l) => l.t !== "del").map((l) => l.text).join("\n"), lang).then(setNewHl);
        }),
    );

    const pairs = createMemo(() => (p.split ? pairUp(shown()) : []));
    const html = (r: Line) => {
        const hl = r.line.t === "del" ? oldHl()?.[r.old ?? -1] : newHl()?.[r.new ?? -1];
        return hl ?? escapeHtml(r.line.text);
    };

    return (
        <div ref={el} class={`diff ${p.class ?? ""}`}>
            <Show when={p.header}>
                <div class="diff-head">
                    <FileIcon status={p.diff.status} />
                    <span class="diff-path">{p.diff.path}</span>
                    <DiffStat added={p.diff.added} removed={p.diff.removed} />
                </div>
            </Show>
            <Show when={p.diff.note && !p.diff.hunks.length}>
                <div class="diff-note">{p.diff.note}</div>
            </Show>
            <Show when={p.diff.hunks.length && p.split}>
                <div class="diff-scroll">
                    <div class="diff-rows split">
                        <For each={pairs()}>
                            {(r) =>
                                r.kind === "sep" ? (
                                    <div class="sl sep">
                                        <span class="txt">{r.text}</span>
                                    </div>
                                ) : (
                                    <div class="sl">
                                        <span class={`ln ${r.left ? r.left.line.t : "none"}`}>{r.left?.line.a ?? ""}</span>
                                        <span class={`txt ${r.left ? r.left.line.t : "none"}`} innerHTML={r.left ? html(r.left) : ""} />
                                        <span class={`ln ${r.right ? r.right.line.t : "none"}`}>{r.right?.line.b ?? ""}</span>
                                        <span class={`txt ${r.right ? r.right.line.t : "none"}`} innerHTML={r.right ? html(r.right) : ""} />
                                    </div>
                                )
                            }
                        </For>
                    </div>
                </div>
            </Show>
            <Show when={p.diff.hunks.length && !p.split}>
                <div class="diff-scroll">
                    <div class="diff-rows">
                        <For each={shown()}>
                            {(r) =>
                                r.kind === "sep" ? (
                                    <div class="dl sep">
                                        <span class="ln" />
                                        <span class="ln" />
                                        <span class="txt">{r.text}</span>
                                    </div>
                                ) : (
                                    <div class={`dl ${r.line.t}`}>
                                        <span class="ln">{r.line.a ?? ""}</span>
                                        <span class="ln">{r.line.b ?? ""}</span>
                                        <span class="txt" innerHTML={html(r)} />
                                    </div>
                                )
                            }
                        </For>
                    </div>
                </div>
            </Show>
            <Show when={total() > limit()}>
                <button class="diff-more" onClick={() => setExpanded(true)}>
                    <ChevronDown size={14} /> Show {plural(total() - (p.maxLines ?? 0), "more line")}
                </button>
            </Show>
            <Show when={p.diff.truncated && (expanded() || !p.maxLines || total() <= limit())}>
                <div class="diff-note">The rest of this diff is too long to show here.</div>
            </Show>
        </div>
    );
}
