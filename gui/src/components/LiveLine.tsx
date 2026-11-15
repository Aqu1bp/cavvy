// The running turn's live line: one row at the end of the turn that says what's
// happening now, with its own timer. A new state fades in where the old one
// fades out, so the row never moves or changes height, and its one glyph spins
// on through it. Each
// state stays long enough to be read (DWELL_MS): a fast agent's states that
// come and go sooner are skipped, the line going straight to the latest. A
// running command's line is just its row, and a button: it opens (a click,
// Enter or Space) to the block its row opens to, the command over its output
// as it comes (Activity.tsx's CommandBody). That's kept in the command rows'
// folds, by call: a roll doesn't close it, and the row the command commits as
// is open too. What it says, and DWELL_MS, are in lib/live-line.ts.

import { createEffect, createMemo, createSignal, For, on, onCleanup, Show, untrack } from "solid-js";
import { ChevronRight, Hand } from "lucide-solid";
import { now } from "../lib/clock";
import { turnDuration } from "../lib/format";
import { dwellLeft, stepOf, urgent, type LiveLineState } from "../lib/live-line";
import { prefs } from "../state/prefs";
import { LiveCommandBody, useCardFolds } from "./blocks/Activity";

/**
 * The move between two states, before Settings → Motion scales it: a crossfade in place. The old one fades out
 * quickly; the new one fades in a moment later, so the two are barely ever seen over each other. Words the two
 * share at the start (the same label, "Reading" and "Reading") hold still: only what changed fades.
 */
const OUT_MS = 120;
const IN_MS = 180;
const IN_DELAY_MS = 60;

/** A motion's duration as Settings → Motion and the system's reduced-motion setting have it: 0 for none. */
export function motionMs(base: number): number {
    if (typeof matchMedia !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
    return prefs.motion === "instant" ? 0 : prefs.motion === "smooth" ? Math.round(base * 1.4) : base;
}

type Layer = {
    id: number;
    key: string;
    state: () => LiveLineState;
    since: number;
    enter: boolean;
    /** The label of the state it took over from: the same one holds still as it comes in. */
    from?: string;
    leaving: () => boolean;
    /** It goes, for a state with label `next`: the same label holds still, the new one's in its place. */
    leave: (next: string) => void;
    next?: string;
};


/** `state` undefined: the line steps aside (the answer is streaming; its caret says so). `hint`: what the user can do. */
export function LiveLine(p: { state: LiveLineState | undefined; hint?: string }) {
    const [layers, setLayers] = createSignal<Layer[]>([]);
    let seq = 0;
    const drop = (id: number) => setLayers((list) => list.filter((l) => l.id !== id));
    // A memo, so the state changing within its key (a thought's next words) doesn't count as a new state:
    // `on` alone runs again whenever the state object does, which would roll the line on every update.
    const key = createMemo(() => p.state?.key);
    /** When the current state began showing; a timer for the move to a state that came before it had been read. */
    let shownAt: number | undefined;
    let wait: ReturnType<typeof setTimeout> | undefined;
    onCleanup(() => clearTimeout(wait));
    const show = (key: string | undefined) => {
        const first = p.state;
        // Stepping aside for what takes its place (the answer, the thought it became): at once. What comes fades in
        // there itself; the line fading out over it would show two lines of text on top of each other.
        if (key === undefined || !first) {
            shownAt = undefined;
            return setLayers([]);
        }
        const ms = motionMs(IN_MS);
        const old = layers().filter((l) => !l.leaving());
        // One roll at a time: a state still leaving from the roll before goes at once, so three don't
        // show together (a state back again would show twice: the one leaving and the one coming).
        const gone = new Set(layers().filter((l) => l.leaving()).map((l) => l.id));
        // Each layer keeps reading the line's state while it's the current one, then holds its last.
        let last = first;
        const state = () => {
            const s = p.state;
            if (s && s.key === key) last = s;
            return last;
        };
        const [leaving, setLeaving] = createSignal(false);
        const layer: Layer = {
            id: ++seq,
            key,
            state,
            since: first.since ?? Date.now(),
            enter: ms > 0 && old.length > 0,
            from: old.at(-1)?.state().label,
            leaving,
            leave: (next) => ((layer.next = next), setLeaving(true)),
        };
        shownAt = performance.now();
        if (ms > 0) old.forEach((l) => l.leave(first.label));
        setLayers((list) => [...(ms > 0 ? list.filter((l) => !gone.has(l.id)) : []), layer]);
    };
    createEffect(
        on(key, (key) =>
            untrack(() => {
                clearTimeout(wait);
                wait = undefined;
                const shown = layers().findLast((l) => !l.leaving());
                // Back to the state on show (it came and went while it dwelt): nothing to do.
                if (shown && shown.key === key) return;
                // A state that came too soon after the one on show waits for it to be read; whichever is latest
                // then is shown, and those in between never are. Some come at once: one the user must act on
                // (an approval, a question) or a special state (a retry, a stop), and stepping aside for the
                // answer, whose text takes the line's place (the line lingering under it would leave a gap as it went).
                const left = shown && key !== undefined && !urgent(p.state) ? dwellLeft(shownAt, performance.now()) : 0;
                if (left > 0) wait = setTimeout(() => (wait = undefined, show(untrack(() => p.state?.key))), left);
                else show(key);
            }),
        ),
    );
    const current = createMemo(() => layers().findLast((l) => !l.leaving()));
    /** What the line shows: the state on show, which may be behind the latest for a moment (DWELL_MS). */
    const showing = () => current()?.state();
    const folds = useCardFolds();
    /** Whether a command is open: as the reader left it, else as Settings has rows start (activity open), as its row does. */
    const isOpen = (id: string) => folds.get(id) ?? prefs.expandActivity;
    /** The running command the line shows: the line opens to it. Not once it's done (its row has it then), dwelling or not. */
    const command = () => {
        const t = showing()?.opens;
        return t?.status === "running" ? t : undefined;
    };
    const opened = createMemo(() => {
        const t = command();
        return t && isOpen(t.id) ? t.id : undefined;
    });
    const toggle = () => {
        const t = command();
        if (t) folds.set(t.id, !isOpen(t.id));
    };
    return (
        <Show when={layers().length}>
            <div class="live-line" data-find-skip>
                <div
                    class="live-stack"
                    role={command() ? "button" : undefined}
                    tabindex={command() ? 0 : undefined}
                    aria-expanded={command() ? Boolean(opened()) : undefined}
                    onClick={toggle}
                    onKeyDown={(e) => {
                        if (!command() || e.target !== e.currentTarget || (e.key !== "Enter" && e.key !== " ")) return;
                        e.preventDefault();
                        toggle();
                    }}
                >
                    {/* What the line says, for a screen reader: only the current state, not the one rolling away. A command's
                        line is a button, named by it: what it's for and the command. */}
                    <span class="sr-only">{command() ? [showing()?.label, showing()?.detail].filter(Boolean).join(": ") : (stepOf(showing()?.steps) ?? showing()?.label)}</span>
                    {/* No spinner: the light sweeping the label says it's working. The hand when it waits on the user. */}
                    <Show when={showing()?.kind === "wait"}>
                        <span class="lic" aria-hidden="true">
                            <Hand size={14} />
                        </span>
                    </Show>
                    <For each={layers()}>{(l) => <LayerRow layer={l} hint={p.hint} isOpen={isOpen} onGone={() => drop(l.id)} />}</For>
                </div>
                <Show when={opened()} keyed>
                    {(id) => {
                        // Its call as the line has it now; the last one while the line moves on from it.
                        let last = command()!;
                        const tool = () => {
                            const t = command();
                            if (t?.id === id) last = t;
                            return last;
                        };
                        return <LiveCommandBody tool={tool()} />;
                    }}
                </Show>
            </div>
        </Show>
    );
}

function LayerRow(p: { layer: Layer; hint?: string; isOpen: (id: string) => boolean; onGone: () => void }) {
    const s = () => p.layer.state();
    // The step a long call says it's at is the line, and nothing beside it. Read here, for this one call: its steps
    // arrive often, and nothing about the rest of the turn hangs on them.
    const at = createMemo(() => stepOf(s().steps));
    const label = () => at() ?? s().label;
    let el: HTMLDivElement | undefined;
    /** Its time, from a second on: a state that's over sooner never says "0s". */
    const time = () => {
        const ms = now() - p.layer.since;
        return ms < 1000 ? undefined : turnDuration(ms);
    };
    const started = () => {
        const at = s().jobSince;
        return at === undefined ? undefined : `started ${turnDuration(Math.max(0, now() - at))} ago`;
    };
    /** What fades: the row, or all but its label when the state on the other side has the same one. */
    const parts = (sameLabel: boolean): Element[] => (!el ? [] : sameLabel ? [...el.children].filter((c) => !c.classList.contains("lbl")) : [el]);
    // Fading in where it is, a moment after the old state began to fade out: opacity only.
    queueMicrotask(() => {
        const ms = motionMs(IN_MS);
        if (!p.layer.enter || !ms || typeof el?.animate !== "function") return;
        for (const c of parts(p.layer.from === s().label)) c.animate([{ opacity: 0 }, { opacity: 1 }], { duration: ms, delay: motionMs(IN_DELAY_MS), easing: "ease-out", fill: "backwards" });
    });
    createEffect(
        on(p.layer.leaving, (gone) => {
            if (!gone) return;
            const ms = motionMs(OUT_MS);
            if (!el || !ms || typeof el.animate !== "function") return p.onGone();
            // The same label: the new state's is drawn in its place already, so this one's goes at once.
            const same = p.layer.next === s().label;
            if (same) el.querySelector<HTMLElement>(".lbl")?.style.setProperty("visibility", "hidden");
            const runs = parts(same).map((c) => c.animate([{ opacity: 1 }, { opacity: 0 }], { duration: ms, easing: "ease-out", fill: "forwards" }));
            if (!runs.length) return p.onGone();
            runs[0]!.onfinish = p.onGone;
        }),
    );
    return (
        <div ref={el} class={`layer k-${s().kind} ${p.layer.leaving() ? "leaving" : ""}`} title={s().title} aria-hidden="true">
            {/* A bright copy of the label in a soft-edged window: the window slides one way and the copy the other, so
                the words hold still and only the light moves (transforms, on the stream clock's steps). */}
            <Show when={s().kind !== "wait"} fallback={<span class="lbl">{s().label}</span>}>
                <span class="lbl shim">
                    {label()}
                    <span class="shim-win">
                        <span class="shim-hi">{label()}</span>
                    </span>
                </span>
            </Show>
            <Show when={!at() && s().detail}>
                {/* Find counts a running call's argument (find.ts): it's here while the call runs. */}
                <span class={`det ${s().mono ? "mono" : ""}`} data-find={!p.layer.leaving() && s().toolId ? s().toolId : undefined}>
                    {s().detail}
                </span>
            </Show>
            {/* Its time, right after what it says ("12s of 4m" for a wait), each part after a dot. */}
            <span class="lend">
                <Show when={started()}>{(t) => <span>{t()}</span>}</Show>
                <Show when={p.hint}>{(h) => <span class="hint">{h()}</span>}</Show>
                <Show when={time()}>
                    {(t) => (
                        <span class="tm num">
                            {t()}
                            <Show when={s().meta}>{(m) => ` ${m()}`}</Show>
                        </span>
                    )}
                </Show>
            </span>
            {/* A running command opens, like its row: the chevron at the end, on hover and while it's open. */}
            <Show when={s().opens?.status === "running" && s().opens}>{(t) => <ChevronRight size={14} class={`chev ${p.isOpen(t().id) ? "open" : ""}`} />}</Show>
        </div>
    );
}
