// The side panel's lists of background work, for its Agents and Commands tabs:
// what runs (Claude Code's or Codex's background sub-agents, shells and
// monitors; tasks delegated to other models; Harness's own sub-agents, shells
// and monitors), with Stop on each and Stop all. Esc stops only the turn: this
// is where background work is stopped. Finished ones fold away under the
// running ones, with how they ended, until cleared. The Agents tab lists each
// sub-agent once (lib/background.ts agentRows), and a click opens it. And the
// composer's count of it, which opens the panel.

import { createMemo, createSignal, For, Show } from "solid-js";
import { Bot, ChevronRight, Layers, Radar, Terminal, Workflow } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { app, handleFor } from "../state/app";
import { clearBackground, openAgents, openBackground, stopAgent, stopBackground } from "../state/actions";
import { agentRows, backgroundOf, clearKey, commandRows, endedAllCleared, kindName, rowLive, rowMeta, rowProvider, rowTone, runnerName, runningCount, stopAllOf, stopTarget, workSection, type Placed, type WorkRow, type WorkTab } from "../lib/background";
import { shortModelRef } from "../lib/tool-words";
import { duration, plural } from "../lib/format";
import { now } from "../lib/clock";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { AgentMark } from "./ui/AgentMark";
import { agentStep } from "../lib/agent-marks";

/** Rows cleared from a session's Finished folds, by clearKey: the server keeps no list of sub-agents to clear. */
const [cleared, setCleared] = createSignal<Record<string, readonly string[]>>({});

/** A tab's rows without those cleared from its fold (running ones always show). */
export function uncleared(sessionId: string, rows: WorkRow[]): WorkRow[] {
    const gone = new Set(cleared()[sessionId] ?? []);
    return gone.size ? rows.filter((r) => rowLive(r) || !gone.has(clearKey(r))) : rows;
}

function KindIcon(p: { kind: WorkRow["kind"] }) {
    return p.kind === "shell" ? <Terminal size={14} /> : p.kind === "monitor" ? <Radar size={14} /> : p.kind === "agent" ? <Bot size={14} /> : <Workflow size={14} />;
}

function Item(p: { handle: SessionHandle; at: Placed }) {
    const [stopping, setStopping] = createSignal(false);
    const r = () => p.at.row;
    const live = () => rowLive(r());
    const target = () => stopTarget(r());
    const provider = () => rowProvider(r(), p.handle.view.state.model?.provider, p.handle.view.agents);
    const runner = () => (provider() ? runnerName({ provider: provider()! }, app.providers) : "Harness");
    const command = () => r().kind === "shell" || r().kind === "monitor";
    // Who runs it: the provider and model for a sub-agent; a command's (or another task's) kind and runner.
    const who = () => (r().kind === "agent" ? [runner(), shortModelRef(r().agent?.model)].filter(Boolean).join(" · ") : `${kindName(r())} · ${runner()}`);
    // What it does now, in a few words (the whole call in its tooltip), while it runs; who ran it once it's over.
    const step = () => (live() && r().agent ? agentStep(r().agent!) : undefined);
    const doing = () => step()?.text;
    // A sub-agent's (or another task's) provider's mark, as the transcript's card draws it; a command's kind.
    const mark = () => !command() && r().kind !== "workflow" && provider();
    const stop = async () => {
        const t = target();
        if (!t) return;
        setStopping(true);
        try {
            if ("tasks" in t) await stopBackground(p.handle.id, t.tasks);
            else await stopAgent(p.handle.id, t.agent);
        } finally {
            setStopping(false);
        }
    };
    return (
        <div class={`task k-${r().kind} ${target() ? "swap" : ""} ${r().agent ? "click" : ""} ${live() ? "" : "gone"} ${p.at.depth ? "child" : ""}`} style={p.at.depth ? { "--depth": Math.min(p.at.depth, 4) } : undefined}>
            <Show when={r().agent}>{(a) => <button class="task-hit" aria-label={`Open ${r().label}`} onClick={() => openAgents(a().id)} />}</Show>
            {/* Who runs it is said on the second line, except while that says what it's doing. */}
            <span class="ki" title={doing() ? who() : undefined}>
                <Show when={mark()} fallback={<KindIcon kind={r().kind} />}>
                    {(id) => <AgentMark provider={id()} class="pm" />}
                </Show>
                <span class={`nd st-${r().status}`} />
            </span>
            <span class="tx">
                <b class={r().kind === "shell" ? "mono" : ""}>{r().label}</b>
                <span class={doing() ? "doing" : ""} title={step()?.full} aria-label={step()?.full}>
                    {doing() ?? who()}
                </span>
            </span>
            <span class={`meta ${rowTone(r()) ? `tone-${rowTone(r())}` : ""}`}>{rowMeta(r(), p.handle.view.state.shells, now(), duration, runner())}</span>
            <Show when={target()}>
                <button class="act stop" title="Stop" aria-label={`Stop ${kindName(r()).toLowerCase()}: ${r().label}`} disabled={stopping()} onClick={() => void stop()}>
                    <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
                        <rect x="1" y="1" width="8" height="8" rx="2" fill="currentColor" />
                    </svg>
                </button>
            </Show>
        </div>
    );
}

/** The rows by key, so a row keeps its element while what it shows changes. */
function Rows(p: { handle: SessionHandle; placed: Placed[] }) {
    const by = createMemo(() => new Map(p.placed.map((x) => [x.row.key, x])));
    return <For each={p.placed.map((x) => x.row.key)}>{(key) => <Show when={by().get(key)}>{(at) => <Item handle={p.handle} at={at()} />}</Show>}</For>;
}

/**
 * A tab's background work: Running, with Stop all behind a confirm when more than one can stop; then the
 * finished ones in a fold that opens and closes in place, with Clear finished. Not drawn when it has no rows.
 * `rows`: the tab's, without those cleared (uncleared).
 */
export function WorkList(p: { handle: SessionHandle; tab: WorkTab; rows: WorkRow[] }) {
    const [confirm, setConfirm] = createSignal(false);
    /** The user's choice to show the finished ones; until then, shown when nothing runs. */
    const [showDone, setShowDone] = createSignal<boolean>();
    const [held, setHeld] = createSignal<ReadonlySet<string>>();
    const sec = createMemo(() => workSection(p.rows, held()));
    const expanded = () => showDone() ?? sec().running.length === 0;
    const what = () => (p.tab === "agents" ? "agent" : "command");
    const stopAll = async () => {
        const { tasks, agents } = stopAllOf(sec().running.map((x) => x.row));
        await Promise.all([...(tasks.length ? [stopBackground(p.handle.id, tasks)] : []), ...agents.map((id) => stopAgent(p.handle.id, id))]);
    };
    const clear = () => {
        const id = p.handle.id;
        const keys = [...(cleared()[id] ?? []), ...sec().finished.map((x) => clearKey(x.row))];
        setCleared((c) => ({ ...c, [id]: keys }));
        // The server keeps one list of finished tasks for both tabs: it's cleared once neither shows one.
        const tasks = backgroundOf(p.handle.view.state);
        if (endedAllCleared([...agentRows(tasks, p.handle.view.agents), ...commandRows(tasks)], new Set(keys))) void clearBackground(id);
    };
    return (
        <Show when={p.rows.length}>
            <div class="work" role="group" aria-label={p.tab === "agents" ? "Agents" : "Background commands"} onPointerEnter={() => setHeld(new Set(workSection(p.rows).finished.filter((x) => !x.depth).map((x) => x.row.key)))} onPointerLeave={() => setHeld(undefined)}>
                <Show when={sec().running.length}>
                    <div class="grp">
                        <div class="sh">
                            Running<span class="n">{sec().live}</span>
                            <span class="grow" />
                            <Show when={sec().stoppable > 1}>
                                <button class="qbtn" onClick={() => setConfirm(true)}>
                                    Stop all
                                </button>
                            </Show>
                        </div>
                        <Rows handle={p.handle} placed={sec().running} />
                    </div>
                </Show>
                <Show when={sec().finished.length}>
                    <div class="grp">
                        <button class="divi" aria-expanded={expanded()} onClick={() => setShowDone(!expanded())}>
                            <span>
                                Finished<span class="n">{sec().finished.length}</span>
                            </span>
                            <i />
                            <Show when={sec().failed}>
                                <span class="tag">{sec().failed} failed</span>
                            </Show>
                            <ChevronRight size={14} class="chev" />
                        </button>
                        <div class={`fold-b ${expanded() ? "open" : ""}`} inert={!expanded()}>
                            <div>
                                <Rows handle={p.handle} placed={sec().finished} />
                                <div class="clear-row">
                                    <button class="link-btn" onClick={clear}>
                                        Clear finished
                                    </button>
                                </div>
                            </div>
                        </div>
                    </div>
                </Show>
            </div>
            <ConfirmDialog open={confirm()} title={`Stop all background ${what()}s?`} confirmLabel="Stop all" onClose={() => setConfirm(false)} onConfirm={stopAll}>
                {plural(sec().stoppable, what())} will stop, and won't report back. The current turn, if any, keeps going.
            </ConfirmDialog>
        </Show>
    );
}

/** In the composer: how many tasks run in the background; opens the side panel on them. */
export function BackgroundChip(p: { sessionId?: string }) {
    const n = () => runningCount(backgroundOf(p.sessionId ? handleFor(p.sessionId)?.view.state : undefined));
    return (
        <Show when={n()}>
            <button class="cb bg-chip" title={`${plural(n(), "task")} running in the background. Show them`} aria-label={`${plural(n(), "background task")} running. Show them`} onClick={() => openBackground(p.sessionId)}>
                <Layers size={14} />
                <span class="num">{n()}</span>
            </button>
        </Show>
    );
}
