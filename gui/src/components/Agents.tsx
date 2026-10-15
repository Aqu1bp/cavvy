// Sub-agents: the bar above the input (one chip per agent), and their
// activity in the side panel. An agent is a Task call, or a task Claude Code
// or Codex delegated to another provider's model.

import { createMemo, createSignal, For, Match, Show, Switch } from "solid-js";
import { Bot, ChevronLeft, CircleAlert, CircleCheck, Clock, Hand, Sparkles, Square, Wrench } from "lucide-solid";
import type { AgentRun } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { openAgents, stopAgent } from "../state/actions";
import { prefs } from "../state/prefs";
import { agentFocus, setAgentFocus } from "../state/ui";
import { duration, plural, tokens } from "../lib/format";
import { now } from "../lib/clock";
import { shortModelRef, ToolRow } from "./blocks/Activity";
import { Markdown } from "./blocks/Markdown";
import { Spinner } from "./ui/bits";

const live = (a: AgentRun) => a.status === "running" || a.status === "waiting";

/** How long it ran, or has been running. */
function elapsed(a: AgentRun): string {
    return duration((a.endedAt ?? (live(a) ? now() : a.startedAt)) - a.startedAt);
}

function name(a: AgentRun, i: number): string {
    return a.description.trim() || `Agent ${i + 1}`;
}

export function AgentStatusIcon(p: { status: AgentRun["status"]; size?: number }) {
    const s = () => p.size ?? 14;
    return (
        <span class={`agent-st st-${p.status}`}>
            <Switch>
                <Match when={p.status === "running"}>
                    <Spinner size={s() - 1} />
                </Match>
                <Match when={p.status === "waiting"}>
                    <Hand size={s()} />
                </Match>
                <Match when={p.status === "done"}>
                    <CircleCheck size={s()} />
                </Match>
                <Match when={p.status === "failed"}>
                    <CircleAlert size={s()} />
                </Match>
                <Match when={p.status === "stopped"}>
                    <Square size={s() - 3} />
                </Match>
            </Switch>
        </span>
    );
}

const STATUS_TEXT: Record<AgentRun["status"], string> = {
    running: "Working",
    waiting: "Needs your approval",
    done: "Finished",
    failed: "Failed",
    stopped: "Stopped",
};

/**
 * Above the input: the agents working now, and the ones the latest prompt
 * started. A chip opens that agent's activity in the side panel.
 */
export function AgentsBar(p: { handle: SessionHandle }) {
    const MAX = 5;
    const lastTurn = createMemo(() => [...p.handle.view.turns].reverse().find((t) => t.prompt)?.id);
    const shown = createMemo(() => p.handle.view.agents.filter((a) => live(a) || a.turnId === lastTurn()));
    const working = () => shown().filter(live).length;
    const index = (a: AgentRun) => p.handle.view.agents.indexOf(a);
    const focused = (a: AgentRun) => prefs.panel && prefs.panelTab === "agents" && agentFocus() === a.id;
    return (
        <Show when={shown().length}>
            <div class="agents-bar">
                <span class="agents-label">
                    <Bot size={14} />
                    {working() ? `${plural(working(), "agent")} working` : "Agents"}
                </span>
                <For each={shown().slice(0, MAX)}>
                    {(a) => (
                        <button
                            class={`agent-chip st-${a.status} ${focused(a) ? "on" : ""}`}
                            title={`${name(a, index(a))}${a.model ? ` · ${a.model}` : ""}\n${live(a) ? (a.activity ?? "Working") : STATUS_TEXT[a.status]} · ${elapsed(a)}`}
                            onClick={() => (focused(a) ? setAgentFocus(undefined) : openAgents(a.id))}
                        >
                            <AgentStatusIcon status={a.status} size={13} />
                            <span class="agent-chip-name truncate">{name(a, index(a))}</span>
                            <Show when={a.model}>
                                <span class="agent-chip-model truncate">{shortModelRef(a.model)}</span>
                            </Show>
                        </button>
                    )}
                </For>
                <Show when={shown().length > MAX}>
                    <button class="agent-chip more" onClick={() => openAgents()}>
                        +{shown().length - MAX} more
                    </button>
                </Show>
            </div>
        </Show>
    );
}

/** The side panel's Agents tab: every sub-agent of the session, newest first. */
export function AgentsList(p: { handle: SessionHandle }) {
    const agents = () => [...p.handle.view.agents].reverse();
    const running = () => p.handle.view.agents.filter((a) => live(a) && a.taskId).length;
    return (
        <div class="panel-section">
            <Show
                when={agents().length}
                fallback={
                    <div class="panel-empty">
                        No sub-agents yet. The agent can hand a self-contained task to a sub-agent, on its own model or another provider's (a review, a second opinion, research), and its work shows here.
                    </div>
                }
            >
                <div class="panel-sum">
                    <span class="panel-sum-title">{plural(agents().length, "agent")}</span>
                    <span class="grow" />
                    <Show when={running() > 1}>
                        <button class="btn secondary sm" onClick={() => void stopAgent(p.handle.id)}>
                            <Square size={11} /> Stop all
                        </button>
                    </Show>
                </div>
                <div class="agent-list">
                    <For each={agents()}>
                        {(a) => (
                            <button class="agent-row" onClick={() => setAgentFocus(a.id)}>
                                <AgentStatusIcon status={a.status} />
                                <span class="agent-row-main">
                                    <span class="agent-row-name truncate">{name(a, p.handle.view.agents.indexOf(a))}</span>
                                    <span class="agent-row-sub truncate">
                                        {[a.model ? shortModelRef(a.model) : undefined, a.agentType !== "general-purpose" ? a.agentType : undefined, live(a) ? (a.activity ?? "Working") : STATUS_TEXT[a.status]].filter(Boolean).join(" · ")}
                                    </span>
                                </span>
                                <span class="agent-row-time">{elapsed(a)}</span>
                            </button>
                        )}
                    </For>
                </div>
            </Show>
        </div>
    );
}

/** One sub-agent in the side panel: what it was asked, what it's doing, and what it reported. */
export function AgentDetail(p: { handle: SessionHandle; agent: AgentRun }) {
    const a = () => p.agent;
    const [fullTask, setFullTask] = createSignal(false);
    const kind = () => (a().status === "failed" ? "error" : a().status);
    const lastText = () => {
        for (let i = a().blocks.length - 1; i >= 0; i--) {
            const b = a().blocks[i]!;
            if (b.t === "text") return b.id;
            if (b.t === "tool") return undefined;
        }
        return undefined;
    };
    // The report repeats its last message; don't show that twice.
    const showReport = () => !live(a()) && a().report?.trim() && (a().replayed || !a().blocks.some((b) => b.t === "text" && b.text.trim() === a().report!.trim()));
    return (
        <div class="overview agent-detail">
            <button class="link-btn agent-back" onClick={() => setAgentFocus(undefined)}>
                <ChevronLeft size={14} /> All agents
            </button>
            <div class={`status-chip ${kind()}`}>
                <AgentStatusIcon status={a().status} size={15} />
                <span class="truncate">{live(a()) ? (a().status === "waiting" ? STATUS_TEXT.waiting : (a().activity ?? "Working")) : STATUS_TEXT[a().status]}</span>
                <span class="sep">·</span>
                <span class="muted">{a().agentType}</span>
            </div>
            <h2 class="overview-title">{a().description || "Sub-agent"}</h2>
            <div class="overview-meta">
                <span class="meta">
                    <Sparkles size={14} /> {a().model ? shortModelRef(a().model) : (p.handle.view.state.model?.name ?? "Session model")}
                </span>
                <span class="meta">
                    <Clock size={14} /> {live(a()) ? "Running for" : "Ran for"} {elapsed(a())}
                </span>
                <Show when={a().toolCount}>
                    <span class="meta">
                        <Wrench size={14} /> {plural(a().toolCount, "tool use")}
                    </span>
                </Show>
                <Show when={a().tokens}>
                    <span class="meta">{tokens(a().tokens)} tokens</span>
                </Show>
            </div>
            <Show when={live(a())}>
                <div class="agent-actions">
                    <Show when={a().taskId} fallback={<span class="muted small">Stops with the turn (Esc).</span>}>
                        <button class="btn secondary sm" onClick={() => void stopAgent(p.handle.id, a().id)}>
                            <Square size={11} /> Stop
                        </button>
                    </Show>
                    <Show when={a().status === "waiting"}>
                        <span class="agent-waiting">
                            <Hand size={13} /> It's asking you something below the conversation
                        </span>
                    </Show>
                </div>
            </Show>

            <Show when={a().prompt}>
                <div class="overview-section">
                    <div class="overview-label">Task</div>
                    <div class={`agent-task ${fullTask() ? "full" : ""}`}>
                        <Markdown text={a().prompt!} class="small" />
                    </div>
                    <Show when={a().prompt!.length > 360}>
                        <button class="link-btn" onClick={() => setFullTask(!fullTask())}>
                            {fullTask() ? "Show less" : "Show all"}
                        </button>
                    </Show>
                </div>
            </Show>

            <div class="overview-section">
                <div class="overview-label">Activity</div>
                <Show when={a().dropped}>
                    <div class="muted small agent-dropped">{plural(a().dropped!, "earlier step")} not shown</div>
                </Show>
                <Show
                    when={a().blocks.length}
                    fallback={<div class="muted small">{a().replayed ? "What it did along the way isn't kept after the session is reopened; its result is below." : live(a()) ? "Starting…" : "Nothing to show."}</div>}
                >
                    <div class="agent-activity">
                        <For each={a().blocks}>
                            {(b) => (
                                <Switch>
                                    <Match when={b.t === "text" && b}>{(t) => <Markdown text={t().text} class="small" streaming={live(a()) && t().id === lastText()} />}</Match>
                                    <Match when={b.t === "tool" && b}>{(t) => <ToolRow tool={t()} nested />}</Match>
                                    <Match when={b.t === "notice" && b}>{(n) => <div class={`notice ${n().level === "info" ? "" : n().level}`}>{n().text}</div>}</Match>
                                </Switch>
                            )}
                        </For>
                    </div>
                </Show>
            </div>

            <Show when={showReport()}>
                <div class="overview-section">
                    <div class="overview-label">Report</div>
                    <div class="agent-report">
                        <Markdown text={a().report!} class="small" />
                    </div>
                </div>
            </Show>
        </div>
    );
}
