// A sub-agent's own view, in the main area: what the parent asked, what it
// did (the transcript's own rows), and what it reported. It takes no
// messages, so where the composer would be there's a status bar instead.
// An agent is a Task call, or a task Claude Code or Codex delegated.

import { createMemo, createSignal, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { ArrowLeft, Bot, ChevronRight, CornerDownLeft, CornerLeftDown } from "lucide-solid";
import type { AgentRun, Block, NoticeBlock, TextBlock, ThinkingBlock } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { newSession, stopAgent } from "../state/actions";
import { setAgentFocus } from "../state/ui";
import { clock, duration, plural } from "../lib/format";
import { now } from "../lib/clock";
import { ActivityGroup, CardFoldsProvider, groupBlocks, Thinking, type Item } from "./blocks/Activity";
import { shortModelRef } from "../lib/tool-words";
import { Markdown } from "./blocks/Markdown";
import { Crumb, CrumbSep, sessionTitle, TitleBar } from "./Header";
import { Monogram } from "./Sidebar";
import { Narration } from "./TurnView";
import { Notice } from "./blocks/Notices";
import { InteractionTab } from "./InteractionDock";
import { ErrorCards } from "./ErrorCards";
import { ProviderIcon } from "./ui/ProviderIcon";
import { AgentMark } from "./ui/AgentMark";
import { agentProvider, agentStep } from "../lib/agent-marks";

const live = (a: AgentRun) => a.status === "running" || a.status === "waiting";

/** How long it ran, or has been running. */
function elapsed(a: AgentRun): string {
    return duration(Math.max(0, (a.endedAt ?? (live(a) ? now() : a.startedAt)) - a.startedAt)).replace(/^(\d+)ms$/, "0s");
}

/** Whether agent `id` is `top`, or one of its own sub-agents (or theirs). */
function within(agents: AgentRun[], id: string, top: string): boolean {
    let cur: string | undefined = id;
    for (let depth = 0; cur !== undefined && depth < 9; depth++) {
        if (cur === top) return true;
        cur = agents.find((x) => x.id === cur)?.parentId;
    }
    return false;
}

function statusLine(a: AgentRun): string {
    switch (a.status) {
        case "running":
            return `Working · ${elapsed(a)}`;
        case "waiting":
            return "Needs your approval";
        case "done":
            return `Done in ${elapsed(a)}`;
        case "failed":
            return `Failed after ${elapsed(a)}`;
        case "stopped":
            return `Stopped after ${elapsed(a)}`;
    }
}

function Log(p: { agent: AgentRun; agents: AgentRun[]; items: Item[]; lastText?: string }) {
    const running = () => live(p.agent);
    // Its own sub-agents (a delegated Codex task's) get their row, which opens each one's view.
    const own = () => p.agents.filter((x) => x.parentId === p.agent.id);
    return (
        <Index each={p.items}>
            {(it) => (
                <Switch>
                    <Match when={it().kind === "activity" && (it() as Extract<Item, { kind: "activity" }>)}>{(g) => <ActivityGroup tools={g().tools} steps={g().steps} card={g().card} turnRunning={running()} agents={own()} />}</Match>
                    <Match when={it().kind === "block" && (it() as { block: Block }).block}>
                        {(b) => (
                            <Switch>
                                <Match when={b().t === "text" && (b() as TextBlock)}>{(t) => (running() && t().id === p.lastText ? <Markdown text={t().text} streaming /> : <Narration block={t()} />)}</Match>
                                <Match when={b().t === "thinking" && (b() as ThinkingBlock)}>{(t) => <Thinking block={t()} live={false} />}</Match>
                                <Match when={b().t === "notice" && (b() as NoticeBlock)}>{(n) => <Notice block={n()} />}</Match>
                            </Switch>
                        )}
                    </Match>
                </Switch>
            )}
        </Index>
    );
}

export function AgentView(p: { handle: SessionHandle; agent: AgentRun }) {
    const a = () => p.agent;
    const st = () => p.handle.view.state;
    const [unfolded, setUnfolded] = createSignal(false);
    const [fullTask, setFullTask] = createSignal(false);
    /** The sub-agent whose own this one is (a delegated task's): what it came from, and goes back to. */
    const parent = () => (a().parentId ? p.handle.view.agents.find((x) => x.id === a().parentId) : undefined);
    const parentName = () => parent()?.description || "Sub-agent";
    const back = () => setAgentFocus(parent()?.id);

    const lastText = () => {
        for (let i = a().blocks.length - 1; i >= 0; i--) {
            const b = a().blocks[i]!;
            // Its earlier turns' words aren't what its latest turn ended on.
            if (b.id === a().turnAfter) return undefined;
            if (b.t === "text") return b;
            if (b.t === "tool") return undefined;
        }
        return undefined;
    };
    /** What it handed back: its report, or the words it ended on. */
    const result = () => (live(a()) ? undefined : a().report?.trim() || lastText()?.text.trim() || undefined);
    // Finished, the work folds away under its result; the result isn't in the fold too.
    const items = createMemo(() => groupBlocks(!live(a()) && lastText() && result() === lastText()!.text.trim() ? a().blocks.filter((b) => b.id !== lastText()!.id) : a().blocks));
    const showWork = () => live(a()) || unfolded();
    const model = () => (a().model ? shortModelRef(a().model) : (st().model?.name ?? "Session model"));
    const provider = () => agentProvider(a(), st().model?.provider, p.handle.view.agents);
    /** What it's doing, in a few words; the whole call in the tooltip. */
    const step = () => agentStep(a());
    /** What it's waiting on you for (its own sub-agents' requests too): answered here as in the session. */
    const asks = () => st().interactions.filter((i) => i.kind === "permission" && i.agentId !== undefined && within(p.handle.view.agents, i.agentId, a().id));
    // The transcript keeps room at its end for the dock, which grows while it asks. (--dock-h goes on
    // the box that reads it: not inherited, and not passed down with `inherit`; stage.css.)
    let dock: HTMLDivElement | undefined;
    const [dockH, setDockH] = createSignal(72);
    onMount(() => {
        const ro = new ResizeObserver(() => setDockH(dock?.offsetHeight ?? 0));
        if (dock) ro.observe(dock);
        onCleanup(() => ro.disconnect());
    });

    return (
        <>
            <TitleBar>
                <Crumb title={`New session in ${st().projectName}`} onClick={() => newSession(st().cwd)}>
                    <Monogram name={st().projectName} size={14} />
                    <span class="truncate">{st().projectName}</span>
                </Crumb>
                <CrumbSep />
                <Crumb title={parent() ? "Back to the session" : "Back to the session (Esc)"} onClick={() => setAgentFocus(undefined)}>
                    <span class="truncate">{sessionTitle(p.handle)}</span>
                </Crumb>
                <CrumbSep />
                <Show when={parent()}>
                    {(up) => (
                        <>
                            <Crumb title={`Back to ${parentName()} (Esc)`} onClick={() => setAgentFocus(up().id)}>
                                <Bot size={14} />
                                <span class="truncate">{parentName()}</span>
                            </Crumb>
                            <CrumbSep />
                        </>
                    )}
                </Show>
                <span class="bc static current">
                    <Bot size={14} />
                    <span class="truncate">{a().description || "Sub-agent"}</span>
                </span>
            </TitleBar>
            <div class="stage">
                <div class="transcript-wrap">
                    <div class="transcript-fade" />
                    <section class="transcript" aria-label="Sub-agent transcript">
                        <div class="transcript-col agent-col">
                            <div class="from-parent">
                                <span class="from-parent-label">
                                    <CornerLeftDown size={13} /> {parent() ? `From ${parentName()}` : "From the parent session"} · {clock(a().startedAt)}
                                </span>
                                <div class={`user-bubble ${fullTask() ? "" : "clamped"}`}>
                                    <Show when={a().prompt} fallback={<span class="user-text">{a().description || "No instructions were recorded."}</span>}>
                                        <span class="user-text">{a().prompt}</span>
                                        <Show when={a().prompt!.length > 1400 || a().prompt!.split("\n").length > 14}>
                                            <button class="link-btn more" onClick={() => setFullTask(!fullTask())}>
                                                {fullTask() ? "Show less" : "Show more"}
                                            </button>
                                        </Show>
                                    </Show>
                                </div>
                            </div>
                            <div class="reply agent-reply">
                                <Show
                                    when={live(a())}
                                    fallback={
                                        <Show when={items().length}>
                                            <button class="fold acts-h" aria-expanded={unfolded()} onClick={() => setUnfolded(!unfolded())}>
                                                <ChevronRight size={14} class="chev" />
                                                <span>
                                                    Worked for <span class="num">{elapsed(a())}</span>
                                                </span>
                                            </button>
                                        </Show>
                                    }
                                >
                                    <div class="live-head">
                                        <Show when={a().status === "waiting"} fallback={<span class="shimmer num live-label" title={step()?.full}>{step() && step()!.text !== "Working" ? step()!.text : `Working for ${elapsed(a())}`}</span>}>
                                            <span class="tone-warn live-label">{asks().length ? "Waiting for you" : "Waiting for you. Answer in the parent session."}</span>
                                        </Show>
                                    </div>
                                </Show>
                                <Show when={a().dropped && showWork()}>
                                    <div class="agent-dropped">{plural(a().dropped!, "earlier step")} not shown</div>
                                </Show>
                                <Show when={showWork()}>
                                    <div class="worklog">
                                        <CardFoldsProvider sessionId={p.handle.id}>
                                            <Log agent={a()} agents={p.handle.view.agents} items={items()} lastText={lastText()?.id} />
                                        </CardFoldsProvider>
                                    </div>
                                </Show>
                                <Show when={a().replayed && !a().blocks.length}>
                                    <div class="agent-dropped">What it did along the way isn't kept after the session is reopened; its result is below.</div>
                                </Show>
                                <Show when={result()}>
                                    <Markdown text={result()!} sessionId={p.handle.id} />
                                    <button class="agent-returned" onClick={back}>
                                        <CornerDownLeft size={13} /> Report returned to <span class="link">{parent() ? parentName() : sessionTitle(p.handle)}</span>
                                    </button>
                                </Show>
                            </div>
                            <div class="transcript-end" style={{ "--dock-h": `${dockH()}px` }} />
                        </div>
                    </section>
                </div>
                <div class="composer-dock" ref={dock}>
                    <div class="composer-col">
                        <ErrorCards place="composer" />
                        <Show when={asks().length}>
                            <InteractionTab sessionId={p.handle.id} items={asks()} />
                        </Show>
                        <div class="agent-bar glass" role="status">
                            <span class="av">
                                <AgentMark provider={provider()} />
                                <span class={`nd st-${a().status}`} />
                            </span>
                            <span class="agent-bar-text">
                                <span class={`agent-bar-state num st-${a().status}`}>{statusLine(a())}</span>
                                <span class="agent-bar-note truncate">Sub-agents take no messages. Reply in the parent session.</span>
                            </span>
                            <span class="grow" />
                            <span class="agent-bar-model truncate" title={a().model ?? st().model?.ref}>
                                <Show when={provider()}>{(id) => <ProviderIcon id={id()} size={14} />}</Show> {model()}<Show when={a().effort}>{(effort) => ` · ${effort()} effort`}</Show>
                            </span>
                            <span class="agent-sep" aria-hidden="true" />
                            <button class="agent-back" onClick={back} title={parent() ? `Back to ${parentName()} (Esc)` : "Back to session (Esc)"}>
                                <ArrowLeft size={15} /> {parent() ? "Back" : "Back to session"}
                            </button>
                            <Show when={live(a()) && a().taskId}>
                                <button class="stop-btn" title="Stop this agent" aria-label="Stop this agent" onClick={() => void stopAgent(p.handle.id, a().id)}>
                                    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                                        <rect x="1" y="1" width="10" height="10" rx="2.5" fill="currentColor" />
                                    </svg>
                                </button>
                            </Show>
                        </div>
                    </div>
                </div>
            </div>
        </>
    );
}
