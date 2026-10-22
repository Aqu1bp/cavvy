// The Background section of the side panel: everything running in the
// session's background, whoever runs it (Claude Code's or Codex's background
// sub-agents, shells and monitors; tasks delegated to other models; Harness's
// own background shells and monitors), with Stop on each and Stop all. Esc
// stops only the turn: this is where background work is stopped. And the
// composer's count of it, which opens the panel.

import { createSignal, For, Show } from "solid-js";
import { Bot, Layers, Radar, Terminal, Workflow } from "lucide-solid";
import type { BackgroundTaskInfo } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, handleFor } from "../state/app";
import { openBackground, stopBackground } from "../state/actions";
import { backgroundOf, kindName, runnerName, runningCount, taskMeta } from "../lib/background";
import { duration, plural } from "../lib/format";
import { now } from "../lib/clock";
import { ConfirmDialog } from "./ui/ConfirmDialog";

function KindIcon(p: { kind: BackgroundTaskInfo["kind"]; live: boolean }) {
    const cls = () => (p.live ? "shell-live" : "");
    return p.kind === "agent" ? <Bot size={16} class={cls()} /> : p.kind === "shell" ? <Terminal size={16} class={cls()} /> : p.kind === "monitor" ? <Radar size={16} class={cls()} /> : <Workflow size={16} class={cls()} />;
}

function TaskRow(p: { handle: SessionHandle; t: BackgroundTaskInfo }) {
    const [stopping, setStopping] = createSignal(false);
    const live = () => p.t.status === "running";
    const by = () => runnerName(p.t, app.providers);
    const stoppable = () => live() && p.t.stoppable;
    const stop = async () => {
        setStopping(true);
        try {
            await stopBackground(p.handle.id, [p.t.id]);
        } finally {
            setStopping(false);
        }
    };
    return (
        <div class={`prow ${stoppable() ? "swap" : ""} bg-row ${live() ? "" : "bg-gone"}`} title={`${kindName(p.t)} · ${by()}\n${p.t.label}${live() && !p.t.stoppable ? "\nIt can't be stopped on its own." : ""}`}>
            <KindIcon kind={p.t.kind} live={live()} />
            <span class="bg-text grow">
                <span class={`truncate ${p.t.kind === "shell" ? "mono" : ""}`}>{p.t.label}</span>
                <span class="bg-by truncate">
                    {kindName(p.t)} · {by()}
                </span>
            </span>
            <span class={`meta ${p.t.lost ? "tone-warn" : ""}`}>{taskMeta(p.t, p.handle.view.state.shells, now(), duration)}</span>
            <Show when={stoppable()}>
                <button class="act hb sm stop" title="Stop" aria-label={`Stop ${kindName(p.t).toLowerCase()}: ${p.t.label}`} disabled={stopping()} onClick={() => void stop()}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <rect x="1" y="1" width="8" height="8" rx="2" fill="currentColor" />
                    </svg>
                </button>
            </Show>
        </div>
    );
}

/** The side panel's Background section; not drawn when nothing runs. */
export function BackgroundTasks(p: { handle: SessionHandle }) {
    const [confirm, setConfirm] = createSignal(false);
    const tasks = () => backgroundOf(p.handle.view.state);
    const running = () => runningCount(tasks());
    const stoppable = () => tasks().filter((t) => t.status === "running" && t.stoppable).length;
    return (
        <Show when={tasks().length}>
            <div class="sec bg-sec" id="background-tasks" role="group" aria-label="Background tasks">
                <div class="sh">
                    Background
                    <Show when={running()}>· {running()} running</Show>
                    <span class="grow" />
                    <Show when={stoppable() > 1}>
                        <button class="btn ghost sm bg-stop-all" onClick={() => setConfirm(true)}>
                            Stop all
                        </button>
                    </Show>
                </div>
                <For each={tasks()}>{(t) => <TaskRow handle={p.handle} t={t} />}</For>
            </div>
            <ConfirmDialog open={confirm()} title="Stop all background work?" confirmLabel="Stop all" onClose={() => setConfirm(false)} onConfirm={() => stopBackground(p.handle.id)}>
                {plural(stoppable(), "task")} will stop, and won't report back. The current turn, if any, keeps going.
            </ConfirmDialog>
        </Show>
    );
}

/** In the composer: how many tasks run in the background; opens the side panel on them. */
export function BackgroundChip(p: { sessionId?: string }) {
    const n = () => runningCount(backgroundOf(p.sessionId ? handleFor(p.sessionId)?.view.state : undefined));
    return (
        <Show when={n()}>
            <button class="cb bg-chip" title={`${plural(n(), "task")} running in the background. Show them`} aria-label={`${plural(n(), "background task")} running. Show them`} onClick={() => openBackground()}>
                <Layers size={14} />
                <span class="num">{n()}</span>
            </button>
        </Show>
    );
}
