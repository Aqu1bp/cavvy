// The session's /goal, as a row inside the composer card: what it's working toward,
// where it stands, and buttons to pause, resume or clear it.

import { createSignal, Show } from "solid-js";
import { ChevronRight, Pause, Play, Target, X } from "lucide-solid";
import type { GoalState } from "@shared/protocol";
import { reportError, rpc } from "../state/app";
import { now } from "../lib/clock";
import { plural, tokens, turnDuration } from "../lib/format";
import { Spinner } from "./ui/bits";

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
    const details = () => [g().note, g().lastReason ? `Last check: ${g().lastReason}` : undefined, g().judge === "self" ? "Checked by the working model itself." : native() ? `${g().by} keeps and checks this goal itself.` : undefined].filter(Boolean) as string[];
    // Claude Code's goals don't pause (Stop interrupts the turn, and it carries on with the next message).
    const pausable = () => !native() || g().canPause;
    return (
        <div class={`crow crow-goal st-${g().state}`} data-open={open() ? "" : undefined} role="status" aria-label="Goal">
            <div class="crow-line">
                <Show when={g().state === "checking" || g().state === "waiting"} fallback={<Target size={14} class="crow-icon" aria-hidden="true" />}>
                    <Spinner size={14} class="crow-icon" />
                </Show>
                <span class="crow-label">Goal</span>
                {/* A CLI's own goal: whose it is. */}
                <Show when={native()}>
                    <span class="tag">{g().by}</span>
                </Show>
                <span class="crow-text" title={g().condition}>
                    {g().condition}
                </span>
                <span class="crow-when">{goalStatus(g(), now())}</span>
                <Show when={details().length}>
                    <button class="icon-btn icon-btn-sm" title={open() ? "Hide details" : "Show details"} aria-label={open() ? "Hide goal details" : "Show goal details"} aria-expanded={open()} onClick={() => setOpen(!open())}>
                        <ChevronRight size={13} class="chev" data-open={open() ? "" : undefined} />
                    </button>
                </Show>
                <Show when={pausable()}>
                    <Show
                        when={g().state === "paused"}
                        fallback={
                            <button class="icon-btn icon-btn-sm" title="Pause after this step" aria-label="Pause goal" disabled={sending()} onClick={() => void run("pause")}>
                                <Pause size={13} />
                            </button>
                        }
                    >
                        <button class="icon-btn icon-btn-sm" title="Resume the goal" aria-label="Resume goal" disabled={sending()} onClick={() => void run("resume")}>
                            <Play size={13} />
                        </button>
                    </Show>
                </Show>
                <button class="icon-btn icon-btn-sm" title="Clear the goal" aria-label="Clear goal" disabled={sending()} onClick={() => void run("clear")}>
                    <X size={13} />
                </button>
            </div>
            <Show when={open() && details().length}>
                <ul class="goal-checks selectable">
                    {details().map((d) => (
                        <li>{d}</li>
                    ))}
                </ul>
            </Show>
        </div>
    );
}
