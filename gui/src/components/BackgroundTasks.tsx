// The side panel's lists of background work, for its Agents and Commands tabs:
// what runs (Claude Code's or Codex's background sub-agents, shells and
// monitors; tasks delegated to other models; Cavvy's own sub-agents, shells
// and monitors), with Stop on each and Stop all. Esc stops only the turn: this
// is where background work is stopped. Finished ones fold away under the
// running ones, with how they ended, until cleared. The Agents tab lists each
// sub-agent once (lib/background.ts agentRows), and a click opens it.

import { createEffect, createMemo, createSignal, For, Show, type JSX } from "solid-js";
import { Bot, ChevronRight, Radar, Square, SquareTerminal, Workflow } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { app, loadAgentList } from "../state/app";
import { clearBackground, openAgents, stopAgent, stopBackground } from "../state/actions";
import { agentRows, backgroundOf, clearKey, commandRows, endedAllCleared, kindName, rowLive, rowMeta, rowProvider, rowTone, runnerName, stopAllOf, stopTarget, workSection, type Placed, type WorkRow, type WorkTab } from "../lib/background";
import { shortModelRef } from "../lib/tool-words";
import { duration, plural } from "../lib/format";
import { now } from "../lib/clock";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { AgentMark } from "./ui/AgentMark";
import { agentStep } from "../lib/agent-marks";
import { cleared, setCleared } from "../lib/background-cleared";

/** The Agents tab: every sub-agent once, and tasks given to other models. Loaded when the panel first shows it. */
export function AgentsPane(p: { handle: SessionHandle; rows: WorkRow[] }) {
    return (
        <Show when={p.rows.length || p.handle.view.agentsMore} fallback={<Blank title="No agents yet" />}>
            <div class="bg">
                <WorkList handle={p.handle} tab="agents" rows={p.rows} />
            </div>
        </Show>
    );
}

/** What a pane shows with nothing in it: one quiet line (the design's Empty). */
export function Blank(p: { title: string }) {
    return (
        <div class="blank">
            <p class="blank-title">{p.title}</p>
        </div>
    );
}

/** A section of a pane: its title and count, a fold for the finished ones, and its action on the right. */
export function Group(p: { title: string; count?: number; fold?: { open: boolean; toggle: () => void }; tag?: JSX.Element; action?: JSX.Element; children: JSX.Element }) {
    const open = () => !p.fold || p.fold.open;
    const label = (
        <>
            <span class="bg-title">{p.title}</span>
            <Show when={p.count !== undefined}>
                <span class="bg-count num">{p.count}</span>
            </Show>
        </>
    );
    return (
        <section class="bg-group">
            <header class="bg-head">
                <Show when={p.fold} fallback={label}>
                    {(f) => (
                        <button type="button" class="bg-fold" aria-expanded={f().open} onClick={() => f().toggle()}>
                            <ChevronRight size={12} class="chev" data-open={f().open || undefined} />
                            {label}
                        </button>
                    )}
                </Show>
                {p.tag}
                <span class="grow" />
                <Show when={open()}>{p.action}</Show>
            </header>
            {/* Folded, its rows stay made (hidden): opening it shows the same rows, nothing is drawn anew. */}
            <div class="bg-rows" hidden={!open()} inert={!open()}>
                {p.children}
            </div>
        </section>
    );
}

function KindIcon(p: { kind: WorkRow["kind"] }) {
    return p.kind === "shell" ? <SquareTerminal size={14} /> : p.kind === "monitor" ? <Radar size={14} /> : p.kind === "agent" ? <Bot size={14} /> : <Workflow size={14} />;
}

/** The icon's colour says how it stands: working (the accent), waiting on you, failed. */
const STATE: Partial<Record<WorkRow["status"], string>> = { running: "working", waiting: "waiting", failed: "failed" };

function Item(p: { handle: SessionHandle; at: Placed }) {
    const [stopping, setStopping] = createSignal(false);
    const r = () => p.at.row;
    const live = () => rowLive(r());
    const target = () => stopTarget(r());
    const provider = () => rowProvider(r(), p.handle.view.state.model?.provider, p.handle.view.agents);
    const runner = () => (provider() ? runnerName({ provider: provider()! }, app.providers) : "Cavvy");
    // Who runs it: the provider and model for a sub-agent; a command's (or another task's) kind and runner.
    const who = () => (r().kind === "agent" ? [runner(), shortModelRef(r().agent?.model)].filter(Boolean).join(" · ") : `${kindName(r())} · ${runner()}`);
    // What it does now, in a few words (the whole call in its tooltip), while it runs; who ran it once it's over.
    const step = () => (live() && r().agent ? agentStep(r().agent!) : undefined);
    const doing = () => step()?.text;
    // A sub-agent's (or another task's) provider's mark, as the transcript's card draws it; a command's kind.
    const mark = () => r().kind !== "shell" && r().kind !== "monitor" && r().kind !== "workflow" && provider();
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
    const text = (
        <>
            {/* Who runs it is said on the second line, except while that says what it's doing. */}
            <span class="bg-icon" data-state={STATE[r().status]} title={doing() ? who() : undefined}>
                <Show when={mark()} fallback={<KindIcon kind={r().kind} />}>
                    {(id) => <AgentMark provider={id()} class="pm" />}
                </Show>
            </span>
            <span class="row-text">
                <span class={r().kind === "shell" ? "row-title mono" : "row-title"}>{r().label}</span>
                <span class="row-sub" title={step()?.full} aria-label={step()?.full}>
                    {doing() ?? who()}
                </span>
            </span>
            <span class="bg-when num" data-tone={rowTone(r()) || undefined}>
                {rowMeta(r(), p.handle.view.state.shells, now(), duration, runner())}
            </span>
        </>
    );
    return (
        <div class="bg-row" data-depth={p.at.depth || undefined} style={p.at.depth ? { "--depth": Math.min(p.at.depth, 4) } : undefined}>
            <Show when={r().agent} fallback={<span class="bg-main bg-static">{text}</span>}>
                {(a) => (
                    <button type="button" class="bg-main" aria-label={`Open ${r().label}`} onClick={() => openAgents(a().id)}>
                        {text}
                    </button>
                )}
            </Show>
            <Show when={target()}>
                <button type="button" class="icon-btn icon-btn-sm" title="Stop" data-tip-side="left" aria-label={`Stop ${kindName(r()).toLowerCase()}: ${r().label}`} disabled={stopping()} onClick={() => void stop()}>
                    <Square size={9} fill="currentColor" stroke-width={0} />
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
 * finished ones, folded while something runs, with Clear finished. Not drawn when it has no rows.
 * `rows`: the tab's, without those cleared (uncleared).
 */
export function WorkList(p: { handle: SessionHandle; tab: WorkTab; rows: WorkRow[] }) {
    const [confirm, setConfirm] = createSignal(false);
    /** The user's choice to show the finished ones while something runs; until then, folded. */
    const [showDone, setShowDone] = createSignal(false);
    const [held, setHeld] = createSignal<ReadonlySet<string>>();
    const sec = createMemo(() => workSection(p.rows, held()));
    const folds = createMemo(() => sec().running.length > 0);
    const expanded = createMemo(() => !folds() || showDone());
    // Finished sub-agents the window was only told the number of (of turns it hasn't been sent): their rows are
    // asked for as the fold shows them.
    const more = () => (p.tab === "agents" ? p.handle.view.agentsMore : undefined);
    createEffect(() => {
        if (more() && expanded()) void loadAgentList(p.handle);
    });
    const what = () => (p.tab === "agents" ? "agent" : "command");
    const stopAll = async () => {
        const { tasks, agents } = stopAllOf(sec().running.map((x) => x.row));
        await Promise.all([...(tasks.length ? [stopBackground(p.handle.id, tasks, p.tab === "commands")] : []), ...agents.map((id) => stopAgent(p.handle.id, id))]);
    };
    const clear = async () => {
        // All of them, those not here yet too.
        if (more()) await loadAgentList(p.handle);
        const id = p.handle.id;
        const keys = [...(cleared()[id] ?? []), ...sec().finished.map((x) => clearKey(x.row))];
        setCleared((c) => ({ ...c, [id]: keys }));
        // The server keeps one list of finished tasks for both tabs: it's cleared once neither shows one.
        const tasks = backgroundOf(p.handle.view.state);
        if (endedAllCleared([...agentRows(tasks, p.handle.view.agents), ...commandRows(tasks)], new Set(keys))) void clearBackground(id);
    };
    const failed = () => sec().failed + (more()?.failed ?? 0);
    return (
        <Show when={p.rows.length || more()}>
            <div class="bg-work" role="group" aria-label={p.tab === "agents" ? "Agents" : "Background commands"} onPointerEnter={() => setHeld(new Set(workSection(p.rows).finished.filter((x) => !x.depth).map((x) => x.row.key)))} onPointerLeave={() => setHeld(undefined)}>
                <Show when={sec().running.length}>
                    <Group
                        title="Running"
                        count={sec().live}
                        action={
                            <Show when={sec().stoppable > 1}>
                                <button type="button" class="btn btn-sm btn-ghost" onClick={() => setConfirm(true)}>
                                    Stop all
                                </button>
                            </Show>
                        }
                    >
                        <Rows handle={p.handle} placed={sec().running} />
                    </Group>
                </Show>
                <Show when={sec().finished.length || more()}>
                    <Group
                        title="Finished"
                        count={sec().finished.length + (more()?.count ?? 0)}
                        fold={folds() ? { open: showDone(), toggle: () => setShowDone(!showDone()) } : undefined}
                        tag={
                            <Show when={failed()}>
                                <span class="tag" data-tone="red">
                                    {failed()} failed
                                </span>
                            </Show>
                        }
                        action={
                            <button type="button" class="btn btn-sm btn-ghost" onClick={clear}>
                                Clear finished
                            </button>
                        }
                    >
                        <Rows handle={p.handle} placed={sec().finished} />
                    </Group>
                </Show>
            </div>
            <ConfirmDialog open={confirm()} title={`Stop all background ${what()}s?`} confirmLabel="Stop all" onClose={() => setConfirm(false)} onConfirm={stopAll}>
                {plural(sec().stoppable, what())} will stop, and won't report back. The current turn, if any, keeps going.
            </ConfirmDialog>
        </Show>
    );
}
