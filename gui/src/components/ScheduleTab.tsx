// The session's schedules, as rows inside the composer card (like the
// queue's): what runs when, with pause or resume, run now and delete.

import { createSignal, For, Show } from "solid-js";
import { CalendarClock, Clock, CornerDownRight, Pause, Play, Repeat, RotateCw, Trash2, X } from "lucide-solid";
import type { ScheduleInfo } from "@shared/protocol";
import { reportError, rpc, toast } from "../state/app";
import { now } from "../lib/clock";
import { until } from "../lib/limits";

/** Shown before "Show all": more than this and the tab would crowd the transcript. */
const SHOWN = 3;

/** "10:08 AM" today, "Thu 10:08 AM" on another day. */
function timeText(ms: number, at: number): string {
    const d = new Date(ms);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    return d.toDateString() === new Date(at).toDateString() ? time : `${d.toLocaleDateString(undefined, { weekday: "short" })} ${time}`;
}

function nextText(s: ScheduleInfo, at: number): string {
    if (s.paused) return "Paused";
    if (s.due) return "Runs when this turn ends";
    if (s.nextAt === undefined) return "";
    return s.nextAt - at < 60_000 ? `Next ${timeText(s.nextAt, at)}` : `Next ${timeText(s.nextAt, at)} · in ${until(s.nextAt, at)}`;
}

/**
 * The resume after a usage limit, in a few words: when it picks up again (its prompt is for the agent, not the user).
 * Listed only where no limit card shows it (lib/notices.ts listedSchedules).
 */
function resumeText(s: ScheduleInfo, at: number): string {
    if (s.due || s.nextAt === undefined) return "Continues when this turn ends";
    return `Continues after the limit resets · ${timeText(s.nextAt, at)}${s.nextAt - at >= 60_000 ? `, in ${until(s.nextAt, at)}` : ""}`;
}

function KindIcon(p: { s: ScheduleInfo }) {
    return p.s.kind === "loop" ? <Repeat size={14} /> : p.s.kind === "resume" ? <RotateCw size={14} /> : p.s.recurring ? <CalendarClock size={14} /> : <Clock size={14} />;
}

export function ScheduleTab(p: { sessionId: string; items: ScheduleInfo[] }) {
    const [all, setAll] = createSignal(false);
    const [busy, setBusy] = createSignal<string>();
    const shown = () => (all() ? p.items : p.items.slice(0, SHOWN));
    const act = async (s: ScheduleInfo, action: "pause" | "resume" | "run" | "delete") => {
        setBusy(s.id);
        try {
            const r = await rpc.call("session.schedule", { id: p.sessionId, scheduleId: s.id, action });
            if (!r.found) toast("That schedule has already finished", "info");
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(undefined);
        }
    };
    return (
        <div class="crow-list" role="list" aria-label="Schedules">
            <For each={shown()}>
                {(s) => (
                    <div class="crow crow-schedule" data-paused={s.paused ? "" : undefined} role="listitem">
                        <div class="crow-line">
                            <span class="crow-icon" title={s.kind === "loop" ? "Loop" : s.kind === "resume" ? "Continues when the limit resets" : s.recurring ? "Recurring schedule" : "One-time schedule"}>
                                <KindIcon s={s} />
                            </span>
                            <Show
                                when={s.kind === "resume" && resumeText(s, now())}
                                fallback={
                                    <>
                                        <span class="crow-text" title={s.prompt}>
                                            {s.prompt}
                                        </span>
                                        {/* When it repeats is in the tooltip: the row says when it runs next. */}
                                        <span class="crow-when" classList={{ due: Boolean(s.due) }} title={s.durable ? `${s.when} · kept when you quit` : s.when}>
                                            {nextText(s, now()) || s.when}
                                        </span>
                                    </>
                                }
                            >
                                {(text) => <span class="crow-text">{text()}</span>}
                            </Show>
                            <Show when={s.kind !== "resume"}>
                                <button
                                    class="icon-btn icon-btn-sm"
                                    disabled={busy() === s.id}
                                    title={s.paused ? "Resume" : "Pause"}
                                    aria-label={s.paused ? "Resume schedule" : "Pause schedule"}
                                    onClick={() => void act(s, s.paused ? "resume" : "pause")}
                                >
                                    {s.paused ? <Play size={13} /> : <Pause size={13} />}
                                </button>
                                {/* Not the resume: before the reset it would only hit the limit again. */}
                                <button class="icon-btn icon-btn-sm" disabled={busy() === s.id || s.due} title="Run now" aria-label="Run schedule now" onClick={() => void act(s, "run")}>
                                    <CornerDownRight size={13} />
                                </button>
                            </Show>
                            <button class="icon-btn icon-btn-sm" disabled={busy() === s.id} title={s.kind === "resume" ? "Don't continue" : "Delete"} aria-label={s.kind === "resume" ? "Cancel the automatic resume" : "Delete schedule"} onClick={() => void act(s, "delete")}>
                                {s.kind === "resume" ? <X size={13} /> : <Trash2 size={13} />}
                            </button>
                        </div>
                    </div>
                )}
            </For>
            <Show when={p.items.length > SHOWN}>
                <button class="crow-more" aria-expanded={all()} onClick={() => setAll(!all())}>
                    {all() ? "Show fewer" : `Show all ${p.items.length} schedules`}
                </button>
            </Show>
        </div>
    );
}
