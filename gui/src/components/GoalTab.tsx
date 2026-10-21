// The session's /goal, as a row inside the composer card: what it's working toward,
// where it stands, and buttons to pause, resume or clear it.

import { createSignal, Show } from "solid-js";
import { ChevronDown, ChevronRight, Goal, LoaderCircle, Pause, Play, X } from "lucide-solid";
import type { GoalState } from "@shared/protocol";
import { reportError, rpc } from "../state/app";
import { now } from "../lib/clock";
import { plural, tokens, turnDuration } from "../lib/format";

/** "Working · 4m 10s · 3 checks · 120k tokens" and the like. */
export function goalStatus(g: GoalState, at: number): string {
    const parts: string[] = [];
    if (g.state === "checking") parts.push("Checking the goal…");
    else if (g.state === "waiting") parts.push(g.retryAt ? `Retrying in ${turnDuration(Math.max(0, g.retryAt - at))}` : "Waiting for background tasks");
    // A CLI's own goal between turns waits for the user's next message (Claude Code has no pause of its own).
    else if (g.state === "paused") parts.push(g.judge === "native" && !g.canPause ? "Waiting for you" : "Paused");
    else parts.push("Working");
    // A paused goal's clock isn't running.
    if (g.state !== "paused") parts.push(turnDuration(Math.max(0, at - g.since)));
    if (g.turns) parts.push(plural(g.turns, "check"));
    if (g.tokens) parts.push(`${tokens(g.tokens)} tokens`);
    return parts.join(" · ");
}

export function GoalTab(p: { sessionId: string; goal: GoalState }) {
    const [open, setOpen] = createSignal(false);
    const [sending, setSending] = createSignal(false);
    const run = async (args: string) => {
        if (sending()) return;
        setSending(true);
        try {
            await rpc.call("session.send", { id: p.sessionId, text: `/goal ${args}` });
        } catch (e) {
            reportError(e);
        } finally {
            setSending(false);
        }
    };
    const g = () => p.goal;
    const native = () => g().judge === "native";
    const details = () => [g().note, g().lastReason ? `Last check: ${g().lastReason}` : undefined, g().judge === "self" ? "Checked by the working model's own report: no other model can answer one-off requests. Set a small model on another provider in Settings for an independent check." : native() ? `${g().by} keeps and checks this goal itself.` : undefined].filter(Boolean) as string[];
    // Claude Code's goals don't pause (Stop interrupts the turn, and it carries on with the next message).
    const pausable = () => !native() || g().canPause;
    return (
        <div class={`queue goal-tab st-${g().state}`} role="status" aria-label="Goal">
            <div class="goal-row">
                <Show when={g().state === "checking" || g().state === "waiting"} fallback={<Goal size={14} class="goal-icon" aria-hidden="true" />}>
                    <LoaderCircle size={14} class="goal-icon spinner" aria-hidden="true" />
                </Show>
                <span class="goal-label">Goal</span>
                <Show when={native()}>
                    <span class="goal-by">{g().by}</span>
                </Show>
                <span class="goal-text truncate" title={g().condition}>
                    {g().condition}
                </span>
                <span class="goal-status">{goalStatus(g(), now())}</span>
                <Show when={details().length}>
                    <button class="hb sm" title={open() ? "Hide details" : "Show details"} aria-label={open() ? "Hide goal details" : "Show goal details"} aria-expanded={open()} onClick={() => setOpen(!open())}>
                        {open() ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                    </button>
                </Show>
                <Show when={pausable()}>
                    <Show
                        when={g().state === "paused"}
                        fallback={
                            <button class="hb sm" title="Pause the goal (it stops after this step)" aria-label="Pause goal" disabled={sending()} onClick={() => void run("pause")}>
                                <Pause size={13} />
                            </button>
                        }
                    >
                        <button class="hb sm" title="Resume the goal" aria-label="Resume goal" disabled={sending()} onClick={() => void run("resume")}>
                            <Play size={13} />
                        </button>
                    </Show>
                </Show>
                <button class="hb sm" title="Clear the goal" aria-label="Clear goal" disabled={sending()} onClick={() => void run("clear")}>
                    <X size={14} />
                </button>
            </div>
            <Show when={open() && details().length}>
                <div class="goal-details selectable">
                    {details().map((d) => (
                        <p>{d}</p>
                    ))}
                </div>
            </Show>
        </div>
    );
}
