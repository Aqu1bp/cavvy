// The session's schedules, as rows inside the composer card (like the
// queue's): what runs when, with pause or resume, run now and delete.

import { createSignal, For, Show } from "solid-js";
import { CalendarClock, FastForward, Hourglass, Pause, Play, Repeat, X } from "lucide-solid";
import type { ScheduleInfo } from "@shared/protocol";
import { reportError, rpc, toast } from "../state/app";
import { now } from "../lib/clock";
import { until } from "../lib/limits";

/** Shown before "Show all": more than this and the tab would crowd the transcript. */
const SHOWN = 3;

function nextText(s: ScheduleInfo, at: number): string {
    if (s.paused) return "Paused";
    if (s.due) return "Runs when this turn ends";
    if (s.nextAt === undefined) return "";
    const d = new Date(s.nextAt);
    const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    const day = d.toDateString() === new Date(at).toDateString() ? "" : `${d.toLocaleDateString(undefined, { weekday: "short" })} `;
    return s.nextAt - at < 60_000 ? `Next ${day}${time}` : `Next ${day}${time} · in ${until(s.nextAt, at)}`;
}

function KindIcon(p: { kind: ScheduleInfo["kind"] }) {
    return p.kind === "loop" ? <Repeat size={14} /> : p.kind === "resume" ? <Hourglass size={14} /> : <CalendarClock size={14} />;
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
        <div class="queue queue-tab schedule-tab" role="list" aria-label="Schedules">
            <For each={shown()}>
                {(s) => (
                    <div class={`queue-row schedule-row ${s.paused ? "paused" : ""}`} role="listitem">
                        <span class="queue-icon" title={s.kind === "loop" ? "Loop" : s.kind === "resume" ? "Resumes after the usage limit" : s.recurring ? "Recurring schedule" : "One-time schedule"}>
                            <KindIcon kind={s.kind} />
                        </span>
                        <span class="queue-text truncate" title={s.prompt}>
                            {s.prompt}
                        </span>
                        <span class="schedule-when" title={s.durable ? `${s.when} · kept when you quit` : s.when}>
                            {s.when}
                        </span>
                        <span class={`queue-hint schedule-next ${s.due ? "due" : ""}`}>{nextText(s, now())}</span>
                        <Show when={s.kind !== "resume"}>
                            <button
                                class="hb sm"
                                disabled={busy() === s.id}
                                title={s.paused ? "Resume" : "Pause"}
                                aria-label={s.paused ? "Resume schedule" : "Pause schedule"}
                                onClick={() => void act(s, s.paused ? "resume" : "pause")}
                            >
                                {s.paused ? <Play size={13} /> : <Pause size={13} />}
                            </button>
                        </Show>
                        <button class="hb sm" disabled={busy() === s.id || s.due} title="Run now" aria-label="Run schedule now" onClick={() => void act(s, "run")}>
                            <FastForward size={13} />
                        </button>
                        <button class="hb sm" disabled={busy() === s.id} title={s.kind === "resume" ? "Don't resume" : "Delete"} aria-label={s.kind === "resume" ? "Cancel the automatic resume" : "Delete schedule"} onClick={() => void act(s, "delete")}>
                            <X size={14} />
                        </button>
                    </div>
                )}
            </For>
            <Show when={p.items.length > SHOWN}>
                <button class="link-btn schedule-more" aria-expanded={all()} onClick={() => setAll(!all())}>
                    {all() ? "Show fewer" : `Show all ${p.items.length} schedules`}
                </button>
            </Show>
        </div>
    );
}
