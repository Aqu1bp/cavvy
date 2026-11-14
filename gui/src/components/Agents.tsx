// A sub-agent's own view, in the main area, drawn as a turn of the session is: what the parent asked (on the
// right, as a prompt), what it did (runs of steps, one quiet line each, and what it said on the way), what's
// under way (the live line, at the end), and what it reported. It takes no messages, so where the composer would
// be there's one line saying how it's doing instead. An agent is a Task call, or a task Claude Code or Codex
// delegated.

import { createMemo, createSignal, Index, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { ArrowLeft, Bot, ChevronRight, CornerDownLeft, CornerLeftDown } from "lucide-solid";
import { LiveLine } from "./LiveLine";
import { liveLine, workSegments } from "../lib/live-line";
import { prefs } from "../state/prefs";
import type { AgentRun, Block, NoticeBlock, TextBlock, ThinkingBlock } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { newSession, stopAgent } from "../state/actions";
import { setAgentFocus, setDockHeight } from "../state/ui";
import { clock, duration, plural } from "../lib/format";
import { now } from "../lib/clock";
import { ActivityGroup, CardFoldsProvider, groupBlocks, Thinking, WorkRun, type Item } from "./blocks/Activity";
import { shortModelRef } from "../lib/tool-words";
import { Markdown } from "./blocks/Markdown";
import { Crumb, CrumbSep, sessionTitle, TitleBar } from "./Header";
import { Monogram } from "./Sidebar";
import { Notice } from "./blocks/Notices";
import { InteractionTab } from "./InteractionDock";
import { ErrorCards } from "./ErrorCards";
import { AgentMark } from "./ui/AgentMark";
import { agentProvider } from "../lib/agent-marks";

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
            return "Waiting for you";
        case "done":
            return `Done in ${elapsed(a)}`;
        case "failed":
            return `Failed after ${elapsed(a)}`;
        case "stopped":
            return `Stopped after ${elapsed(a)}`;
    }
}

/** Its steps as a turn's are: runs of them, one quiet line each that opens into its rows, and what it said between. */
function Log(p: { agent: AgentRun; agents: AgentRun[]; items: Item[]; lastText?: string }) {
    const running = () => live(p.agent);
    // Its own sub-agents (a delegated Codex task's) get their row, which opens each one's view.
    const own = () => p.agents.filter((x) => x.parentId === p.agent.id);
    const segs = createMemo(() => workSegments(p.items) ?? []);
    const renderItem = (it: () => Item) => (
        <Switch>
            <Match when={it().kind === "activity" && (it() as Extract<Item, { kind: "activity" }>)}>{(g) => <ActivityGroup tools={g().tools} steps={g().steps} card={g().card} turnRunning={running()} agents={own()} flat hideLive={running()} />}</Match>
            <Match when={it().kind === "block" && (it() as { block: Block }).block}>
                {(b) => (
                    <Switch>
                        <Match when={b().t === "text" && (b() as TextBlock)}>{(t) => <Markdown text={t().text} streaming={running() && t().id === p.lastText} find={t().id} />}</Match>
                        <Match when={b().t === "thinking" && (b() as ThinkingBlock)}>{(t) => <Thinking block={t()} live={false} />}</Match>
                        <Match when={b().t === "notice" && (b() as NoticeBlock)}>{(n) => <Notice block={n()} />}</Match>
                    </Switch>
                )}
            </Match>
        </Switch>
    );
    return (
        <Index each={segs()}>
            {(seg) => (
                <Show when={seg().kind === "work"} fallback={renderItem(() => (seg() as { item: Item }).item)}>
                    <div class="worklog">
                        <WorkRun items={(seg() as { items: Item[] }).items ?? []} hideLive={running()}>
                            <Index each={(seg() as { items: Item[] }).items ?? []}>{(it) => renderItem(it)}</Index>
                        </WorkRun>
                    </div>
                </Show>
            )}
        </Index>
    );
}

export function AgentView(p: { handle: SessionHandle; agent: AgentRun }) {
    const a = () => p.agent;
    const st = () => p.handle.view.state;
    const [unfolded, setUnfolded] = createSignal(false);
    const [fullTask, setFullTask] = createSignal(false);
    /** A task this long opens and closes: an agent's instructions run long. */
    const longTask = () => Boolean(a().prompt && (a().prompt!.split("\n").length > 6 || a().prompt!.length > 520));
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
    /** What's under way, on the live line at the end of its steps: what it waits on you for, else its call running. */
    const line = createMemo(() => {
        if (!live(a())) return undefined;
        if (a().status === "waiting") return { key: "wait", kind: "wait" as const, label: "Waiting for you" };
        return liveLine({ blocks: a().blocks, activity: undefined, interactions: [], showThinking: prefs.showThinking });
    });
    /** What it's waiting on you for (its own sub-agents' requests too): answered here as in the session. */
    const asks = () => st().interactions.filter((i) => i.kind === "permission" && i.agentId !== undefined && within(p.handle.view.agents, i.agentId, a().id));
    // The transcript keeps room at its end for the dock, which grows while it asks. (--dock-h goes on
    // the box that reads it: not inherited, and not passed down with `inherit`; stage.css.) A floating
    // inspector or diff reader ends above it, as in the session (App.tsx SessionView).
    let dock: HTMLDivElement | undefined;
    const [dockH, setDockH] = createSignal(72);
    onMount(() => {
        const ro = new ResizeObserver(() => {
            const h = dock?.offsetHeight ?? 0;
            setDockH(h);
            setDockHeight(h);
        });
        if (dock) ro.observe(dock);
        onCleanup(() => {
            ro.disconnect();
            setDockHeight(0);
        });
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
                    <section class="transcript" aria-label="Sub-agent transcript" style={{ "--dock-h": `${dockH()}px` }}>
                        <div class="transcript-col agent-col">
                            {/* What the parent asked: on the right, as a prompt, under where it came from. */}
                            <div class="user-row agent-task">
                                <span class="agent-from" data-find-skip>
                                    <CornerLeftDown size={12} aria-hidden="true" /> {parent() ? `From ${parentName()}` : "From the session"}
                                </span>
                                <div class={`user-bubble ${longTask() && !fullTask() ? "clamped" : ""}`}>
                                    <span class="user-text">{a().prompt || a().description || "No instructions were recorded."}</span>
                                    <Show when={longTask()}>
                                        <button class="link-btn more" aria-expanded={fullTask()} onClick={() => setFullTask(!fullTask())}>
                                            {fullTask() ? "Show less" : "Show more"}
                                        </button>
                                    </Show>
                                </div>
                                <div class="user-actions" data-find-skip>
                                    <time class="user-when" dateTime={new Date(a().startedAt).toISOString()}>{clock(a().startedAt)}</time>
                                </div>
                            </div>
                            <div class="reply agent-reply">
                                <Show when={!live(a()) && items().length}>
                                    <button class="fold acts-h worked" aria-expanded={unfolded()} onClick={() => setUnfolded(!unfolded())}>
                                        <ChevronRight size={14} class="chev" />
                                        <span class="num">Worked for {elapsed(a())}</span>
                                    </button>
                                </Show>
                                <Show when={a().dropped && showWork()}>
                                    <div class="agent-dropped">{plural(a().dropped!, "earlier step")} not shown</div>
                                </Show>
                                <Show when={showWork()}>
                                    <CardFoldsProvider sessionId={p.handle.id}>
                                        <Log agent={a()} agents={p.handle.view.agents} items={items()} lastText={lastText()?.id} />
                                    </CardFoldsProvider>
                                </Show>
                                <Show when={live(a())}>
                                    <LiveLine state={line()} />
                                </Show>
                                <Show when={a().replayed && !a().blocks.length}>
                                    <div class="agent-dropped">Its steps aren't kept once the session is reopened.</div>
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
                        <div class="agent-bar card-surface" role="status">
                            <span class="av">
                                <AgentMark provider={provider()} />
                                <span class={`nd st-${a().status}`} />
                            </span>
                            <span class={`agent-bar-state num st-${a().status}`}>{statusLine(a())}</span>
                            <span class="grow" />
                            <span class="agent-bar-model truncate" title={a().model ?? st().model?.ref}>
                                {model()}<Show when={a().effort}>{(effort) => ` · ${effort()}`}</Show>
                            </span>
                            <span class="agent-sep" aria-hidden="true" />
                            <button class="agent-back" onClick={back} title={parent() ? `Back to ${parentName()} (Esc)` : "Back to session (Esc)"}>
                                <ArrowLeft size={14} /> Back
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
