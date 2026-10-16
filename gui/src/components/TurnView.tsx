import { createMemo, createSignal, For, Index, Match, Show, Switch } from "solid-js";
import { AlertCircle, AlertTriangle, Brain, ChevronRight, FileDiff, Info, MessageSquareText, RotateCcw, SquareArrowOutUpRight, SquareTerminal } from "lucide-solid";
import type { AgentRun, Block, CompactBlock, FileDiff as Diff, NoticeBlock, SessionState, ShellBlock, TextBlock, ThinkingBlock, Turn } from "@shared/protocol";
import { duration, firstChangedLine, plural, stripAnsi } from "../lib/format";
import { now } from "../lib/clock";
import { prefs } from "../state/prefs";
import { openInEditor, openReview } from "../state/actions";
import { ActivityGroup, groupBlocks, type Item } from "./blocks/Activity";
import { Markdown } from "./blocks/Markdown";
import { CopyButton, Spinner } from "./ui/bits";

export function UserPrompt(p: { turn: Turn; onRewind?: (index: number) => void }) {
    const [expanded, setExpanded] = createSignal(false);
    const text = () => p.turn.prompt?.text ?? "";
    const long = () => text().split("\n").length > 14 || text().length > 1400;
    const shell = () => text().startsWith("!");
    return (
        <div class="user-row">
            <div class="user-actions">
                <CopyButton text={text} label="Copy prompt" />
                <Show when={p.turn.prompt?.index != null && p.onRewind && !p.turn.archived}>
                    <button class="icon-btn" title="Rewind to before this prompt" aria-label="Rewind to before this prompt" onClick={() => p.onRewind!(p.turn.prompt!.index!)}>
                        <RotateCcw size={14} />
                    </button>
                </Show>
            </div>
            <div class={`user-bubble ${p.turn.prompt?.command ? "command" : ""} ${shell() ? "shell" : ""} ${long() && !expanded() ? "clamped" : ""}`}>
                <Show when={shell()} fallback={<span class="user-text">{text()}</span>}>
                    <span class="user-text mono">
                        <SquareTerminal size={13} /> {text().slice(1)}
                    </span>
                </Show>
                <Show when={p.turn.prompt?.images}>
                    <span class="chip tiny">{p.turn.prompt!.images} image{p.turn.prompt!.images === 1 ? "" : "s"}</span>
                </Show>
                <Show when={long()}>
                    <button class="link-btn more" onClick={() => setExpanded(!expanded())}>
                        {expanded() ? "Show less" : "Show more"}
                    </button>
                </Show>
            </div>
        </div>
    );
}

/** The model's reasoning, as a work-log row: "Thought for 41s", opening into the text. */
export function Thinking(p: { block: ThinkingBlock; live: boolean }) {
    const [open, setOpen] = createSignal(false);
    const label = () => (p.live ? "Thinking" : p.block.durationMs && p.block.durationMs >= 1500 ? `Thought for ${duration(p.block.durationMs)}` : "Thought briefly");
    const preview = () => p.block.text.trim().split("\n").filter(Boolean).slice(-2).join(" ");
    return (
        <Show when={prefs.showThinking || p.live}>
            <div class={`wgroup ${open() ? "open" : ""}`}>
                <button class="wrow" onClick={() => setOpen(!open())} aria-expanded={open()}>
                    <span class="slot">
                        <Brain size={16} />
                    </span>
                    <span class={`wtext ${p.live ? "shimmer" : ""}`}>{label()}</span>
                    <span class="end">
                        <ChevronRight size={14} class="chev" />
                    </span>
                </button>
                <Show when={open()} fallback={<Show when={p.live && preview()}><div class="thinking-peek">{preview()}</div></Show>}>
                    <div class="thinking-text">{p.block.text.trim()}</div>
                </Show>
            </div>
        </Show>
    );
}

/** Something the model said on its way (more work followed): one quoted line. */
export function Narration(p: { block: TextBlock }) {
    const [open, setOpen] = createSignal(false);
    const line = () => p.block.text.replace(/```[\s\S]*?```/g, " ").replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim();
    return (
        <div class={`wgroup ${open() ? "open" : ""}`}>
            <button class="wrow" onClick={() => setOpen(!open())} aria-expanded={open()}>
                <span class="slot">
                    <MessageSquareText size={16} />
                </span>
                <span class="wtext truncate">“{line()}”</span>
                <span class="end">
                    <ChevronRight size={14} class="chev" />
                </span>
            </button>
            <Show when={open()}>
                <div class="wkids narration">
                    <Markdown text={p.block.text} />
                </div>
            </Show>
        </div>
    );
}

export function Notice(p: { block: NoticeBlock }) {
    return (
        <div class={`notice ${p.block.level}`}>
            <Switch fallback={<Info size={14} />}>
                <Match when={p.block.level === "error"}>
                    <AlertCircle size={14} />
                </Match>
                <Match when={p.block.level === "warn"}>
                    <AlertTriangle size={14} />
                </Match>
            </Switch>
            <span>{p.block.text}</span>
        </div>
    );
}

function Compacted(p: { block: CompactBlock }) {
    const [open, setOpen] = createSignal(false);
    return (
        <div class="compacted">
            <div class="compacted-rule">
                <span />
                <button class="link-btn" onClick={() => setOpen(!open())}>
                    Conversation compacted · {open() ? "hide summary" : "view summary"}
                </button>
                <span />
            </div>
            <Show when={open()}>
                <div class="compacted-summary">
                    <Markdown text={p.block.summary} class="small" />
                </div>
            </Show>
        </div>
    );
}

function Shell(p: { block: ShellBlock }) {
    return (
        <div class="shell-block">
            <div class="shell-head">
                <SquareTerminal size={13} />
                <code class="truncate">{p.block.command}</code>
                <Show when={p.block.running} fallback={<span class={`chip tiny ${p.block.exitCode ? "err" : "ok"}`}>exit {p.block.exitCode ?? "?"}</span>}>
                    <Spinner size={12} />
                </Show>
            </div>
            <Show when={p.block.output}>
                <pre class="term">{stripAnsi(p.block.output)}</pre>
            </Show>
        </div>
    );
}

/** Labels that say more than "Working": the turn is in a special state. */
const SPECIAL = /^(Retrying|Compacting|Interrupting|Connecting)/;

/** At the top of the turn while it runs: "Working for 48s", Esc to interrupt. */
export function LiveHead(p: { state: SessionState; since?: number; waiting?: boolean }) {
    const elapsed = () => duration(Math.max(0, now() - (p.since ?? p.state.activity?.since ?? now()))).replace(/^(\d+)ms$/, "0s");
    const special = () => (p.state.activity && SPECIAL.test(p.state.activity.label) ? p.state.activity : undefined);
    return (
        <>
            <div class="live-head">
                <Show
                    when={!p.waiting}
                    fallback={
                        <span class="tone-warn live-label">
                            Waiting for you <span class="muted num">· {elapsed()}</span>
                        </span>
                    }
                >
                    <Show when={special()} fallback={<span class="shimmer num live-label">Working for {elapsed()}</span>}>
                        {(a) => (
                            <span class="live-label" title={a().detail}>
                                <span class="shimmer">{a().label}</span>
                                <span class="muted num"> · {elapsed()}</span>
                            </span>
                        )}
                    </Show>
                </Show>
                <span class="grow" />
                <span class="live-hint">
                    <kbd>Esc</kbd> to interrupt
                </span>
            </div>
            <div class="rule" />
        </>
    );
}

type Changed = { path: string; status: Diff["status"]; added: number; removed: number; line?: number };

/** What a finished turn changed, file by file (its edits' diffs, added up), with where the first edit landed. */
function turnChanges(t: Turn): Changed[] {
    const files = new Map<string, Changed>();
    for (const b of t.blocks) {
        if (b.t !== "tool" || b.status !== "ok" || !b.diff) continue;
        const f = files.get(b.diff.path) ?? { path: b.diff.path, status: b.diff.status, added: 0, removed: 0, line: firstChangedLine(b.diff) };
        f.added += b.diff.added;
        f.removed += b.diff.removed;
        files.set(b.diff.path, f);
    }
    return [...files.values()];
}

/** The path relative to the project, split for the eye: a faint folder, a clear name. */
export function SplitPath(p: { path: string; cwd?: string }) {
    const rel = () => (p.cwd && p.path.startsWith(p.cwd + "/") ? p.path.slice(p.cwd.length + 1) : p.path);
    const cut = () => rel().lastIndexOf("/");
    return (
        <span class="truncate split-path" title={p.path}>
            <span class="dir">{cut() >= 0 ? rel().slice(0, cut() + 1) : ""}</span>
            <span class="name">{cut() >= 0 ? rel().slice(cut() + 1) : rel()}</span>
        </span>
    );
}

const FILES_SHOWN = 6;

function ChangesCard(p: { turn: Turn; cwd: string; sessionId: string }) {
    const files = createMemo(() => turnChanges(p.turn));
    const total = () => files().reduce((a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }), { added: 0, removed: 0 });
    const [all, setAll] = createSignal(false);
    return (
        <Show when={files().length}>
            <div class="files-card">
                <div class="files-head">
                    <span class="files-title">{plural(files().length, "changed file")}</span>
                    <span class="stat">
                        <span class="add">+{total().added}</span>
                        <span class="del">−{total().removed}</span>
                    </span>
                    <span class="grow" />
                    <button class="ghost-btn" onClick={() => openReview()}>
                        <FileDiff size={14} /> Review changes
                    </button>
                </div>
                <For each={all() ? files() : files().slice(0, FILES_SHOWN)}>
                    {(f) => (
                        <div class="frow-line">
                            <button class="frow" onClick={() => openReview(f.path)}>
                                <SplitPath path={f.path} cwd={p.cwd} />
                                <Show when={f.status === "added"}>
                                    <span class="frow-tag">new</span>
                                </Show>
                                <span class="stat">
                                    <span class="add">+{f.added}</span>
                                    <span class="del">−{f.removed}</span>
                                </span>
                            </button>
                            <Show when={f.status !== "deleted"}>
                                <button class="icon-btn row-open" title="Open in editor" aria-label={`Open ${f.path} in editor`} onClick={() => void openInEditor(f.path, f.line, { sessionId: p.sessionId })}>
                                    <SquareArrowOutUpRight size={13} />
                                </button>
                            </Show>
                        </div>
                    )}
                </For>
                <Show when={files().length > FILES_SHOWN && !all()}>
                    <button class="frow more" onClick={() => setAll(true)}>
                        {plural(files().length - FILES_SHOWN, "more file")}
                    </button>
                </Show>
            </div>
        </Show>
    );
}

const END_TEXT: Partial<Record<Turn["status"], string>> = {
    aborted: "Interrupted",
    error: "Stopped with an error",
    denied: "Stopped after a declined tool call",
    max_turns: "Stopped at the turn limit",
    blocked: "Blocked by a hook",
};

type Seg = { kind: "work"; items: Item[] } | { kind: "item"; item: Item; interim: boolean };

/**
 * Work (tool runs, thinking) vs what's said: the reply, notices. What the
 * model said on its way (more work followed) is prose between the work, and
 * folds away with it once the turn is done.
 */
function segments(items: Item[]): Seg[] {
    const isWork = (it: Item) => it.kind === "activity" || (it.kind === "block" && it.block.t === "thinking");
    const lastWork = items.findLastIndex(isWork);
    const out: Seg[] = [];
    items.forEach((it, i) => {
        if (isWork(it)) {
            const prev = out[out.length - 1];
            if (prev?.kind === "work") prev.items.push(it);
            else out.push({ kind: "work", items: [it] });
        } else out.push({ kind: "item", item: it, interim: i < lastWork && it.kind === "block" && it.block.t === "text" });
    });
    return out;
}

export function TurnView(p: { turn: Turn; state: SessionState; last: boolean; agents?: AgentRun[]; onRewind?: (index: number) => void }) {
    const items = createMemo(() => groupBlocks(p.turn.blocks));
    const segs = createMemo(() => segments(items()));
    const running = () => p.turn.status === "running";
    const hasWork = () => segs().some((s) => s.kind === "work");
    const [unfolded, setUnfolded] = createSignal(false);
    const showWork = () => running() || unfolded();
    const hasOutput = () => p.turn.blocks.length > 0 || running();
    const lastText = () => {
        for (let i = p.turn.blocks.length - 1; i >= 0; i--) {
            const b = p.turn.blocks[i]!;
            if (b.t === "text") return b.id;
            if (b.t === "tool") return undefined;
        }
        return undefined;
    };
    const lastBlockId = () => p.turn.blocks[p.turn.blocks.length - 1]?.id;
    const reply = () =>
        p.turn.blocks
            .filter((b): b is TextBlock => b.t === "text")
            .map((b) => b.text)
            .join("\n\n");
    const waitingOnUser = () => running() && p.state.interactions.length > 0;
    const worked = () => (p.turn.endedAt && p.turn.startedAt ? duration(p.turn.endedAt - p.turn.startedAt) : undefined);

    // By position, not by object: the items are rebuilt on every streamed token, the rows mustn't be.
    const renderItem = (it: () => Item) => (
        <Switch>
            <Match when={it().kind === "activity" && (it() as Extract<Item, { kind: "activity" }>)}>
                {(g) => <ActivityGroup tools={g().tools} steps={g().steps} turnRunning={running()} agents={p.agents} />}
            </Match>
            <Match when={it().kind === "block" && (it() as { block: Block }).block}>
                {(b) => (
                    <Switch>
                        <Match when={b().t === "text" && (b() as TextBlock)}>
                            {(t) => <Markdown text={t().text} streaming={running() && t().id === lastText()} sessionId={p.state.id} />}
                        </Match>
                        <Match when={b().t === "thinking" && (b() as ThinkingBlock)}>{(t) => <Thinking block={t()} live={running() && p.last && t().id === lastBlockId()} />}</Match>
                        <Match when={b().t === "notice" && (b() as NoticeBlock)}>{(n) => <Notice block={n()} />}</Match>
                        <Match when={b().t === "compact" && (b() as CompactBlock)}>{(c) => <Compacted block={c()} />}</Match>
                        <Match when={b().t === "shell" && (b() as ShellBlock)}>{(s) => <Shell block={s()} />}</Match>
                    </Switch>
                )}
            </Match>
        </Switch>
    );

    return (
        <article class={`turn ${p.turn.archived ? "archived" : ""}`} data-turn={p.turn.id}>
            <Show when={p.turn.prompt}>
                <UserPrompt turn={p.turn} onRewind={p.onRewind} />
            </Show>
            <Show when={hasOutput()}>
                <div class="reply">
                    <Show when={running() && p.last}>
                        <LiveHead state={p.state} since={p.turn.startedAt} waiting={waitingOnUser()} />
                    </Show>
                    <Show when={!running() && hasWork()}>
                        <button class="fold" aria-expanded={unfolded()} onClick={() => setUnfolded(!unfolded())}>
                            {worked() ? (
                                <>
                                    Worked for <span class="num">{worked()}</span>
                                </>
                            ) : (
                                "Work log"
                            )}
                            <ChevronRight size={14} class="chev" />
                        </button>
                        <div class="rule" />
                    </Show>
                    <Index each={segs()}>
                        {(seg) => (
                            <Show
                                when={seg().kind === "work"}
                                fallback={
                                    <Show when={!(seg() as { interim: boolean }).interim || showWork()}>
                                        {renderItem(() => (seg() as { item: Item }).item)}
                                    </Show>
                                }
                            >
                                <Show when={showWork()}>
                                    <div class="worklog">
                                        <Index each={(seg() as { items: Item[] }).items ?? []}>{(it) => renderItem(it)}</Index>
                                    </div>
                                </Show>
                            </Show>
                        )}
                    </Index>
                    <Show when={!running() && !p.turn.archived}>
                        <ChangesCard turn={p.turn} cwd={p.state.cwd} sessionId={p.state.id} />
                    </Show>
                    <Show when={!running() && p.turn.prompt}>
                        <div class="turn-foot">
                            <Show when={END_TEXT[p.turn.status]}>
                                <span class={`end-${p.turn.status}`}>{END_TEXT[p.turn.status]}</span>
                            </Show>
                            <Show when={reply().trim()}>
                                <CopyButton text={reply} label="Copy response" class="foot-btn" />
                            </Show>
                        </div>
                    </Show>
                </div>
            </Show>
        </article>
    );
}
