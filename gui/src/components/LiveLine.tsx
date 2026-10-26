// The running turn's live line: one row at the end of the turn that says what's
// happening now, with its own timer. A new state rolls in from below as the old
// one leaves upward, clipped to the row, so the row never changes height. Each
// state stays long enough to be read (DWELL_MS): a fast agent's states that
// come and go sooner are skipped, the line going straight to the latest. A
// running command's line is just its row, and a button: it opens (a click,
// Enter or Space) to the block its row opens to, the command over its output
// as it comes (Activity.tsx's CommandBody). That's kept in the command rows'
// folds, by call: a roll doesn't close it, and the row the command commits as
// is open too. What it says, and DWELL_MS, are in lib/live-line.ts.

import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, Show, Switch, untrack } from "solid-js";
import { ChevronRight, Clock, Hand } from "lucide-solid";
import { now } from "../lib/clock";
import { turnDuration } from "../lib/format";
import { dwellLeft, urgent, type LiveLineState } from "../lib/live-line";
import { prefs } from "../state/prefs";
import { Spinner } from "./ui/bits";
import { LiveCommandBody, useCardFolds } from "./blocks/Activity";

/** How long the roll between two states takes, before Settings → Motion scales it. */
const ROLL_MS = 260;

/** A motion's duration as Settings → Motion and the system's reduced-motion setting have it: 0 for none. */
export function motionMs(base: number): number {
    if (typeof matchMedia !== "function" || matchMedia("(prefers-reduced-motion: reduce)").matches) return 0;
    return prefs.motion === "instant" ? 0 : prefs.motion === "smooth" ? Math.round(base * 1.4) : base;
}

const EASE = "cubic-bezier(0.32, 0.72, 0, 1)";

type Layer = { id: number; key: string; state: () => LiveLineState; since: number; enter: boolean; leaving: () => boolean; leave: () => void };


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
        if (key === undefined || !first) {
            shownAt = undefined;
            return setLayers([]);
        }
        const ms = motionMs(ROLL_MS);
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
        const layer: Layer = { id: ++seq, key, state, since: first.since ?? Date.now(), enter: ms > 0 && old.length > 0, leaving, leave: () => setLeaving(true) };
        shownAt = performance.now();
        if (ms > 0) old.forEach((l) => l.leave());
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
                    <span class="sr-only">{command() ? [showing()?.label, showing()?.detail].filter(Boolean).join(": ") : showing()?.label}</span>
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
    let el: HTMLDivElement | undefined;
    const time = () => turnDuration(Math.max(0, now() - p.layer.since));
    const started = () => {
        const at = s().jobSince;
        return at === undefined ? undefined : `started ${turnDuration(Math.max(0, now() - at))} ago`;
    };
    const ms = () => motionMs(ROLL_MS);
    const animate = (frames: Keyframe[], done?: () => void) => {
        if (!el || typeof el.animate !== "function" || !ms()) return done?.();
        const a = el.animate(frames, { duration: ms(), easing: EASE, fill: done ? "forwards" : "none" });
        if (done) a.onfinish = done;
    };
    // Coming up from below as the old state leaves upward: transform and opacity only.
    queueMicrotask(() => {
        if (p.layer.enter) animate([{ opacity: 0, transform: "translateY(70%)" }, { opacity: 1, transform: "none" }]);
    });
    createEffect(
        on(p.layer.leaving, (gone) => {
            if (gone) animate([{ opacity: 1, transform: "none" }, { opacity: 0, transform: "translateY(-70%)" }], p.onGone);
        }),
    );
    return (
        <div ref={el} class={`layer k-${s().kind}`} title={s().title} aria-hidden="true">
            <span class="lic">
                <Switch fallback={<Spinner size={13} />}>
                    <Match when={s().kind === "think"}>
                        <span class="orb" />
                    </Match>
                    <Match when={s().kind === "wait"}>
                        <Hand size={14} />
                    </Match>
                    <Match when={s().kind === "bg"}>
                        <Clock size={14} />
                    </Match>
                </Switch>
            </span>
            <span class={`lbl ${s().kind === "wait" ? "" : "shimmer"}`}>{s().label}</span>
            <Show when={s().detail}>
                {/* Find counts a running call's argument (find.ts): it's here while the call runs. */}
                <span class={`det ${s().mono ? "mono" : ""}`} data-find={!p.layer.leaving() && s().toolId ? s().toolId : undefined}>
                    {s().detail}
                </span>
            </Show>
            {/* A running command opens, like its row: the chevron after the command, on hover and while it's open. */}
            <Show when={s().opens?.status === "running" && s().opens}>{(t) => <ChevronRight size={14} class={`chev ${p.isOpen(t().id) ? "open" : ""}`} />}</Show>
            <span class="lend">
                <Show when={started()}>{(t) => <span>{t()}</span>}</Show>
                <Show when={s().meta}>{(m) => <span>{m()}</span>}</Show>
                <Show when={p.hint}>{(h) => <span class="hint">{h()}</span>}</Show>
                <span class="tm num">{time()}</span>
            </span>
        </div>
    );
}
