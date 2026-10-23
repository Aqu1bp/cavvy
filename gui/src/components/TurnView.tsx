import { RenderBoundary } from "./ui/ErrorBoundary";
import { createComputed, createEffect, createMemo, createResource, createSignal, For, Index, Match, on, Show, Switch, untrack } from "solid-js";
import { AlertCircle, AlertTriangle, BellRing, Check, CircleCheck, CircleStop, CircleX, ChevronRight, Clock, CornerDownRight, FileDiff, FileText, GitFork, Goal, Info, MessageSquareText, RotateCcw, SquareArrowOutUpRight, SquareTerminal, X } from "lucide-solid";
import type { AgentRun, Block, CompactBlock, FileDiff as Diff, ImportedBlock, NoticeBlock, SessionState, ShellBlock, TextBlock, ThinkingBlock, Turn } from "@shared/protocol";
import { firstChangedLine, plural, promptTime, shortPrompt, stripAnsi } from "../lib/format";
import { liveLine, workedLabel, workSegments } from "../lib/live-line";
import { formatSize } from "../lib/attachments";
import { linesLabel, linesPhrase, splitComments } from "../lib/review-comments";
import { prefs } from "../state/prefs";
import { fetchGitChanges, type GitView } from "../state/changes";
import { openInEditor, openReview } from "../state/actions";
import { findReveal, setViewedImage } from "../state/ui";
import { imagesReady, promptImages, type PromptImage } from "../state/images";
import { ActivityGroup, groupBlocks, Thinking, type Item } from "./blocks/Activity";
import { Markdown } from "./blocks/Markdown";
import { CopyButton, Spinner } from "./ui/bits";
import { LiveLine, motionMs } from "./LiveLine";

/** A prompt's images as thumbnails; the count alone when they can't be had (asked again after a reconnect). */
function PromptImages(p: { sessionId?: string; turn: Turn; count: number }) {
    const key = () => p.turn.prompt?.imagesKey;
    const [fetched] = createResource(
        () => {
            const k = key();
            return p.sessionId && p.turn.pos && k && imagesReady(p.sessionId) ? { id: p.sessionId, pos: p.turn.pos, key: k } : undefined;
        },
        (k) => promptImages(k.id, k.pos, k.key).then((images) => ({ key: k.key, images }), () => ({ key: k.key, images: [] as PromptImage[] })),
    );
    // Only the images the prompt has now: the last ones fetched stay while offline, never another prompt's.
    const images = () => {
        const f = fetched();
        const k = key();
        return f && k && f.key === k ? f.images : undefined;
    };
    const label = () => `${p.count} image${p.count === 1 ? "" : "s"}`;
    return (
        <Show when={images()?.length} fallback={<span class="chip tiny">{label()}</span>}>
            <For each={images()}>
                {(img, i) => (
                    <button class="prompt-image" title="View full size" aria-label={`View image ${i() + 1} of ${images()!.length}`} onClick={() => setViewedImage({ src: img.src, alt: `Image ${i() + 1} attached to the prompt` })}>
                        <img src={img.thumb} alt="" />
                    </button>
                )}
            </For>
        </Show>
    );
}

export function UserPrompt(p: { turn: Turn; sessionId?: string; onRewind?: (index: number) => void }) {
    const [expanded, setExpanded] = createSignal(false);
    const raw = () => p.turn.prompt?.text ?? "";
    /** What was typed, and the review comments sent with it (drawn as cards, not markup). */
    const parts = createMemo(() => splitComments(raw()));
    const text = () => parts().text;
    const long = () => text().split("\n").length > 14 || text().length > 1400;
    const shell = () => text().startsWith("!");
    createEffect(on(findReveal, (r) => r?.turnId === p.turn.id && r.part === "prompt" && long() && setExpanded(true)));
    // Started by an event the agent asked to be woken for (a watched pull request), not by the user.
    if (p.turn.prompt?.wake) {
        return (
            <div class="wake-row" data-find="prompt" title="The agent asked to be woken for this event">
                <BellRing size={13} aria-hidden="true" />
                <span class="wake-text">{text()}</span>
            </div>
        );
    }
    // At the right, as wide as its text: attachments above it, and under it (over the gap, on hover
    // or focus) when it was sent, Copy and Rewind.
    return (
        <div class={`user-row ${p.turn.prompt?.steered ? "steered" : ""}`}>
            {/* Sent while the turn before ran, and joined it at its next step (that turn ended for it). */}
            <Show when={p.turn.prompt?.steered}>
                <span class="steered-tag" data-find-skip title="Sent while it worked: joined the work at its next step">
                    <CornerDownRight size={12} aria-hidden="true" />
                    Steered in
                </span>
            </Show>
            <Show when={p.turn.prompt?.scheduled}>
                {(label) => (
                    <span class="prompt-scheduled" data-find-skip>
                        <Clock size={12} /> {label()}
                    </span>
                )}
            </Show>
            <Show when={p.turn.prompt?.images || p.turn.prompt?.files?.length}>
                <span class="prompt-attachments" data-find-skip>
                    <Show when={p.turn.prompt?.images}>
                        {(n) => <PromptImages sessionId={p.sessionId} turn={p.turn} count={n()} />}
                    </Show>
                    <For each={p.turn.prompt?.files ?? []}>
                        {(f) => (
                            <span class="chip tiny" title={`${f.name} · ${formatSize(f.size)}${f.lines !== undefined ? ` · ${plural(f.lines, "line")}` : ""}`}>
                                <FileText size={11} /> <span class="truncate">{f.name}</span> · {formatSize(f.size)}
                            </span>
                        )}
                    </For>
                </span>
            </Show>
            <div class={`user-bubble ${p.turn.prompt?.command ? "command" : ""} ${shell() ? "shell" : ""} ${long() && !expanded() ? "clamped" : ""} ${shortPrompt(text()) && !parts().comments.length ? "short" : ""}`} data-find="prompt">
                <Show when={shell()} fallback={<span class="user-text">{text()}</span>}>
                    <span class="user-text mono">
                        <SquareTerminal size={13} /> {text().slice(1)}
                    </span>
                </Show>
                <Show when={parts().comments.length}>
                    <div class="prompt-comments">
                        <For each={parts().comments}>
                            {(c) => (
                                <div class="prompt-comment">
                                    <button class="prompt-comment-where mono" data-find-skip title={`Show ${c.path} in the review`} aria-label={`Comment on ${c.path}, ${linesPhrase(c)}. Show the file in the review`} onClick={() => openReview(c.path)}>
                                        <MessageSquareText size={12} aria-hidden="true" />
                                        <span class="truncate">{c.path}:{linesLabel(c)}</span>
                                    </button>
                                    <span class="prompt-comment-text">{c.text}</span>
                                </div>
                            )}
                        </For>
                    </div>
                </Show>
                <Show when={long()}>
                    <button class="link-btn more" aria-expanded={expanded()} onClick={() => setExpanded(!expanded())}>
                        {expanded() ? "Show less" : "Show more"}
                    </button>
                </Show>
            </div>
            <div class="user-actions" data-find-skip>
                <Show when={p.turn.startedAt}>
                    {(at) => (
                        <time class="user-when" dateTime={new Date(at()).toISOString()} title={new Date(at()).toLocaleString()}>
                            {promptTime(at())}
                        </time>
                    )}
                </Show>
                <CopyButton text={raw} label="Copy prompt" />
                <Show when={p.turn.prompt?.index != null && p.onRewind && !p.turn.archived}>
                    <button class="icon-btn" title="Rewind to before this prompt" aria-label="Rewind to before this prompt" onClick={() => p.onRewind!(p.turn.prompt!.index!)}>
                        <RotateCcw size={14} />
                    </button>
                </Show>
            </div>
        </div>
    );
}

/** Something the model said on its way (more work followed): one quoted line. */
export function Narration(p: { block: TextBlock }) {
    const [open, setOpen] = createSignal(false);
    const line = () => p.block.text.replace(/```[\s\S]*?```/g, " ").replace(/[*_`>#]/g, "").replace(/\s+/g, " ").trim();
    createEffect(on(findReveal, (r) => r?.part === p.block.id && setOpen(true)));
    return (
        <div class={`wgroup ${open() ? "open" : ""}`} data-find={p.block.id}>
            <button class="acts-h wrow" onClick={() => setOpen(!open())} aria-expanded={open()}>
                <ChevronRight size={14} class="chev" />
                <span class="wtext truncate" data-find-skip>
                    “{line()}”
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

/** A /goal verdict starts with its own mark (src/agent/goal.ts): shown as an icon instead. */
const GOAL_MARK = /^([◎✓✗]) /;

export function Notice(p: { block: NoticeBlock }) {
    const mark = () => GOAL_MARK.exec(p.block.text)?.[1];
    const text = () => (mark() ? p.block.text.slice(2) : p.block.text);
    const icon = () => (
        <Switch fallback={<Info size={14} />}>
            <Match when={mark() === "◎"}>
                <Goal size={14} />
            </Match>
            <Match when={mark() === "✓"}>
                <CircleCheck size={14} />
            </Match>
            <Match when={mark() === "✗"}>
                <CircleX size={14} />
            </Match>
            <Match when={p.block.level === "error"}>
                <AlertCircle size={14} />
            </Match>
            <Match when={p.block.level === "warn"}>
                <AlertTriangle size={14} />
            </Match>
        </Switch>
    );
    // What it's about (the background tasks it stopped): one line, the names folded under it.
    const [open, setOpen] = createSignal(false);
    createEffect(on(findReveal, (r) => r?.part === p.block.id && p.block.details?.length && setOpen(true)));
    return (
        <Show
            when={p.block.details?.length}
            fallback={
                <div class={`notice ${p.block.level}${mark() === "✓" ? " goal-met" : ""}`} data-find={p.block.id}>
                    {icon()}
                    <span>{text()}</span>
                </div>
            }
        >
            <div class={`notice ${p.block.level} folds`} data-find={p.block.id}>
                <button class="notice-h" aria-expanded={open()} onClick={() => setOpen(!open())}>
                    {icon()}
                    <span class="truncate">
                        {text()}
                        <Show when={!open()}>
                            <span class="notice-peek" data-find-skip>
                                {" · "}
                                {p.block.details!.join(", ")}
                            </span>
                        </Show>
                    </span>
                    <ChevronRight size={14} class="chev" />
                </button>
                <Show when={open()}>
                    <ul class="notice-details">
                        <For each={p.block.details}>
                            {(d) => (
                                <li class="truncate" title={d}>
                                    {/* A line break between them, as find reads them (find.ts): no match runs from one into the next. */}
                                    <span class="sr-only">{"\n"}</span>
                                    {d}
                                </li>
                            )}
                        </For>
                    </ul>
                </Show>
            </div>
        </Show>
    );
}

/** Heads a conversation brought in from Claude Code or Codex: shown, but it can't be rewound or edited. */
function Imported(p: { block: ImportedBlock }) {
    const date = () => (p.block.startedAt ? new Date(p.block.startedAt).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }) : undefined);
    return (
        <div class="compacted imported">
            <div class="compacted-rule">
                <span />
                <span class="imported-label">
                    Imported from {p.block.source}
                    <Show when={date()}> · {date()}</Show>
                    <Show when={p.block.omitted}> · {plural(p.block.omitted, "earlier message")} not imported</Show>
                </span>
                <span />
            </div>
        </div>
    );
}

function Compacted(p: { block: CompactBlock }) {
    const [open, setOpen] = createSignal(false);
    createEffect(on(findReveal, (r) => r?.part === p.block.id && setOpen(true)));
    return (
        <div class="compacted" data-find={p.block.id}>
            <div class="compacted-rule" data-find-skip>
                <span />
                <button
                    class="link-btn"
                    aria-expanded={open()}
                    title={p.block.idle ? "Summarized before the prompt cache expired, so the next message doesn't re-read the whole conversation" : undefined}
                    onClick={() => setOpen(!open())}
                >
                    {p.block.idle ? "Compacted while idle" : "Conversation compacted"} · {open() ? "hide summary" : "view summary"}
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

/** A command you ran yourself ("!cmd"): a command card, marked as yours. */
function Shell(p: { block: ShellBlock }) {
    return (
        <div class={`tcard cmd-card you-ran shell-block ${findReveal()?.part === p.block.id ? "found" : ""}`} data-find={p.block.id}>
            <div class="tcard-h shell-head">
                <span class="tcard-ic">
                    <SquareTerminal size={14} />
                </span>
                <span class="tcard-who" data-find-skip>You ran</span>
                <code class="tcard-p truncate" title={p.block.command}>{p.block.command}</code>
                <span class="grow" />
                <Show
                    when={p.block.running}
                    fallback={
                        <span class={`tpill ${p.block.exitCode ? "fail" : "ok"}`} data-find-skip>
                            {p.block.exitCode ? <X size={12} /> : <Check size={12} />} Exit {p.block.exitCode ?? "?"}
                        </span>
                    }
                >
                    <span class="tpill run" data-find-skip>
                        <Spinner size={11} /> Running
                    </span>
                </Show>
            </div>
            <Show when={p.block.output}>
                <div class="tcard-body">
                    <pre class="tcard-out">{stripAnsi(p.block.output)}</pre>
                </div>
            </Show>
        </div>
    );
}

/** `pathToken`: the name hides a registered value (GitFileDiff.pathToken): reviewed and opened by it. */
type Changed = { path: string; status: Diff["status"]; added: number; removed: number; line?: number; pathToken?: string };

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

/** What a changes card keeps of a turn's recorded diff: the file list, without the hunks. */
type Recorded = Pick<GitView, "repo" | "turnId" | "error" | "snapshotAvailable" | "incomplete" | "notes" | "more"> & { files: Changed[] };
/**
 * Turns' recorded diffs, by session and snapshot. A finished turn's never changes, so a card
 * mounted again (switching back to the session) has it at once instead of asking the server to
 * diff the turn again and sending every hunk (megabytes for a turn that touched hundreds of files).
 */
const recordedTurns = new Map<string, Recorded>();
const RECORDED_KEPT = 400;

function summarize(view: GitView): Recorded {
    const { repo, turnId, error, snapshotAvailable, incomplete, notes, more } = view;
    return { repo, turnId, error, snapshotAvailable, incomplete, notes, more, files: view.files.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed, line: firstChangedLine(f), ...(f.pathToken ? { pathToken: f.pathToken } : {}) })) };
}

function ChangesCard(p: { turn: Turn; cwd: string; sessionId: string; busy: boolean }) {
    // Load after the closing snapshot is saved. Once ready, a completed turn's
    // key stays stable while later turns run, so its immutable diff is not fetched again.
    const snapshotKey = createMemo<string | undefined>((previous) => {
        if (p.turn.snapshotId === undefined) return undefined;
        const key = JSON.stringify([p.sessionId, p.turn.snapshotId]);
        return !p.busy || previous === key ? key : undefined;
    });
    const [snapshot] = createResource(snapshotKey, (key) => {
        const [id, turnId] = JSON.parse(key) as [string, number];
        const kept = recordedTurns.get(key);
        if (kept) return { id, turnId, view: kept };
        return fetchGitChanges(id, "turn", undefined, undefined, turnId).then((view) => {
            const summary = summarize(view);
            // Only a complete result: after an error or an incomplete read the next card to mount asks again.
            if (!view.error && !view.incomplete) {
                recordedTurns.delete(key);
                recordedTurns.set(key, summary);
                if (recordedTurns.size > RECORDED_KEPT) recordedTurns.delete(recordedTurns.keys().next().value!);
            }
            return { id, turnId, view: summary };
        });
    });
    const recorded = () => snapshot()?.id === p.sessionId && snapshot()?.turnId === p.turn.snapshotId ? snapshot()?.view : undefined;
    const captured = () => recorded()?.repo && recorded()?.turnId === p.turn.snapshotId && !recorded()?.error;
    const snapshotDiff = () => captured() && recorded()?.snapshotAvailable;
    const files = createMemo<Changed[]>(() => snapshotDiff() ? recorded()!.files : turnChanges(p.turn));
    const reviewChanges = (path?: string, token?: string) => openReview(path, snapshotDiff() ? "turn" : "uncommitted", snapshotDiff() ? p.turn.snapshotId : undefined, token);
    const total = () => files().reduce((a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }), { added: 0, removed: 0 });
    const [all, setAll] = createSignal(false);
    return (
        <Show when={files().length || (captured() && recorded()?.incomplete)}>
            <div class="tcard files-card" data-find-skip>
                <div class="tcard-h files-head">
                    <span class="tcard-ic">
                        <FileDiff size={14} />
                    </span>
                    <span class="files-title">{!snapshotDiff() && !files().length ? "Turn snapshot incomplete" : plural(files().length + (snapshotDiff() ? recorded()?.more ?? 0 : 0), "changed file")}</span>
                    <Show when={files().length}>
                        <span class="stat">
                            <span class="add">+{total().added}</span>
                            <span class="del">−{total().removed}</span>
                        </span>
                    </Show>
                    <span class="grow" />
                    {/* Keep recorded changes tied to this turn, even after later edits. */}
                    <button class="tbtn" onClick={() => captured() ? openReview(undefined, "turn", p.turn.snapshotId) : reviewChanges(files()[0]?.path, files()[0]?.pathToken)}>
                        Review changes
                    </button>
                </div>
                <div class="files-rows">
                <Show when={captured() && recorded()?.incomplete}><div class="review-note">{"This turn’s snapshot is incomplete. " + (recorded()?.notes?.join(" ") ?? "")}</div></Show>
                <For each={all() ? files() : files().slice(0, FILES_SHOWN)}>
                    {(f) => (
                        <div class="frow-line">
                            <button class="frow" onClick={() => reviewChanges(f.path, f.pathToken)}>
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
                                <button class="icon-btn row-open" title="Open in editor" aria-label={`Open ${f.path} in editor`} onClick={() => void openInEditor(f.path, f.line, { sessionId: p.sessionId, gitToken: f.pathToken })}>
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
            </div>
        </Show>
    );
}

const END_TEXT: Partial<Record<Turn["status"], string>> = {
    aborted: "Stopped. Nothing after this point ran.",
    error: "Stopped with an error",
    denied: "Stopped after a declined tool call",
    max_turns: "Stopped at the turn limit",
    blocked: "Blocked by a hook",
};

type TurnViewProps = {
    turn: Turn;
    state: SessionState;
    last: boolean;
    agents?: AgentRun[];
    onRewind?: (index: number) => void;
    onFork?: () => void;
    workOpen?: boolean;
    keepWorkOpen?: () => boolean;
    onWorkOpen?: (open: boolean) => void;
    onToggleWork?: (el: HTMLElement, toggle: () => void) => void;
    /** Ended by a steer whose turn (or one after it) still runs: its work stays open until that chain ends. */
    held?: boolean;
    /** The turn's element, once (Transcript tracks how far it is from the view, and finds it by id). */
    onElement?: (el: HTMLElement, turnId: string) => void;
    /** The work, faded out, folds away now (`fold`): Transcript keeps what's in sight from jumping as it does. */
    onFold?: (el: HTMLElement, fold: () => void) => void;
};

export function TurnView(p: TurnViewProps) {
    return <RenderBoundary raw={() => p.turn}><TurnViewContent {...p} /></RenderBoundary>;
}

function TurnViewContent(p: TurnViewProps) {
    let article: HTMLElement | undefined;
    const items = createMemo(() => groupBlocks(p.turn.blocks));
    const segs = createMemo(() => workSegments(items()));
    const running = () => p.turn.status === "running";
    const live = () => running() && p.last && p.state.busy;
    const writing = () => live() && p.state.activity?.label === "Writing";
    // The turn's one indicator, at its end: what's under way now (nothing while the answer streams).
    const line = createMemo(() => (live() ? liveLine({ blocks: p.turn.blocks, activity: p.state.activity, interactions: p.state.interactions, showThinking: prefs.showThinking }) : undefined));
    const lastBlockId = () => p.turn.blocks[p.turn.blocks.length - 1]?.id;
    /** The thought being written: the live line shows it, not a row. */
    const liveThought = (b: ThinkingBlock) => line()?.kind === "think" && b.durationMs === undefined && b.id === lastBlockId();
    const hasWork = () => segs().some((s) => s.kind === "work");
    // Over, and not carried on by a steer (the turn it started, or one after, still runs): its work folds away.
    // A memo, made before the computation below and the work's <Show>: they hear of a change in that order, so
    // the reader's open work is kept open before the <Show> would take it away (and remount it).
    const foldable = createMemo(() => !running() && !p.held);
    const [unfolded, setUnfolded] = createSignal(p.workOpen ?? prefs.expandActivity);
    const unfold = (open: boolean) => { setUnfolded(open); p.onWorkOpen?.(open); };
    // Fading out before it folds: the work's last moment on screen, then "Worked for".
    const [folding, setFolding] = createSignal(false);
    // Run before DOM effects can remove the work the reader is inspecting.
    createComputed(on(foldable, (value, previous) => {
        if (previous !== false || !value || untrack(unfolded)) return;
        if (p.keepWorkOpen?.()) return unfold(true);
        const ms = motionMs(200);
        if (!ms) return;
        setFolding(true);
        setTimeout(() => (article && p.onFold ? p.onFold(article, () => setFolding(false)) : setFolding(false)), ms);
    }));
    const showWork = () => !foldable() || unfolded() || folding();
    // A match in the work log (or in what was said on the way) opens it.
    createEffect(
        on(findReveal, (r) => {
            if (r?.turnId !== p.turn.id || r.part === "prompt") return;
            const has = (it: Item) => (it.kind === "block" ? it.block.id === r.part : it.steps.some((b) => b.id === r.part));
            if (segs().some((s) => (s.kind === "work" ? s.items.some(has) : s.interim && has(s.item)))) unfold(true);
        }),
    );
    const hasOutput = () => p.turn.blocks.length > 0 || running();
    const lastText = () => {
        for (let i = p.turn.blocks.length - 1; i >= 0; i--) {
            const b = p.turn.blocks[i]!;
            if (b.t === "text") return b.id;
            if (b.t === "tool") return undefined;
        }
        return undefined;
    };
    const reply = () =>
        p.turn.blocks
            .filter((b): b is TextBlock => b.t === "text")
            .map((b) => b.text)
            .join("\n\n");
    const worked = () => workedLabel(p.turn.startedAt, p.turn.endedAt);

    // By position, not by object: the items are rebuilt on every streamed token, the rows mustn't be.
    // `leaving`: what was said on the way, fading out with the work it's folding away with.
    const renderItem = (it: () => Item, leaving?: () => boolean) => (
        <Switch>
            <Match when={it().kind === "activity" && (it() as Extract<Item, { kind: "activity" }>)}>
                {(g) => <ActivityGroup tools={g().tools} steps={g().steps} card={g().card} turnRunning={running()} agents={p.agents} flat hideLive={live()} />}
            </Match>
            <Match when={it().kind === "block" && (it() as { block: Block }).block}>
                {(b) => (
                    <Switch>
                        <Match when={b().t === "text" && (b() as TextBlock)}>
                            {(t) => <Markdown text={t().text} streaming={writing() && t().id === lastText()} sessionId={p.state.id} find={t().id} class={leaving?.() ? "leaving" : undefined} />}
                        </Match>
                        <Match when={b().t === "thinking" && (b() as ThinkingBlock)}>{(t) => <Show when={!liveThought(t())}><Thinking block={t()} live={false} /></Show>}</Match>
                        <Match when={b().t === "notice" && (b() as NoticeBlock)}>{(n) => <Notice block={n()} />}</Match>
                        <Match when={b().t === "compact" && (b() as CompactBlock)}>{(c) => <Compacted block={c()} />}</Match>
                        <Match when={b().t === "imported" && (b() as ImportedBlock)}>{(c) => <Imported block={c()} />}</Match>
                        <Match when={b().t === "shell" && (b() as ShellBlock)}>{(s) => <Shell block={s()} />}</Match>
                    </Switch>
                )}
            </Match>
        </Switch>
    );

    return (
        <article class={`turn ${p.turn.archived ? "archived" : ""} ${p.turn.imported ? "imported" : ""} ${p.held ? "chained" : ""} ${foldable() ? "done" : ""}`} data-turn={p.turn.id} aria-busy={running()} ref={(el) => (article = el, p.onElement?.(el, p.turn.id))}>
            <Show when={p.turn.prompt}>
                <h2 class="sr-only" data-find-skip>You said</h2>
                <UserPrompt turn={p.turn} sessionId={p.state.id} onRewind={p.onRewind} />
            </Show>
            <Show when={hasOutput()}>
                <div class="reply">
                    <h2 class="sr-only" data-find-skip>{running() ? "Harness is working" : "Harness replied"}</h2>
                    <Show when={foldable() && hasWork() && !folding()}>
                        <button class="fold acts-h worked" aria-expanded={unfolded()} onClick={(event) => {
                            const toggle = () => unfold(!unfolded());
                            if (p.onToggleWork) p.onToggleWork(event.currentTarget, toggle);
                            else toggle();
                        }}>
                            <ChevronRight size={14} class="chev" />
                            <span class="num">{worked() ?? "Work log"}</span>
                        </button>
                    </Show>
                    <Index each={segs()}>
                        {(seg) => (
                            <Show
                                when={seg().kind === "work"}
                                fallback={
                                    <Show when={!(seg() as { interim: boolean }).interim || showWork()}>
                                        {renderItem(() => (seg() as { item: Item }).item, () => (seg() as { interim: boolean }).interim && folding())}
                                    </Show>
                                }
                            >
                                <Show when={showWork()}>
                                    <div class={`worklog ${folding() ? "leaving" : ""}`}>
                                        <Index each={(seg() as { items: Item[] }).items ?? []}>{(it) => renderItem(it)}</Index>
                                    </div>
                                </Show>
                            </Show>
                        )}
                    </Index>
                    <Show when={foldable() && !p.turn.archived && !p.turn.imported}>
                        <ChangesCard turn={p.turn} cwd={p.state.cwd} sessionId={p.state.id} busy={p.state.busy} />
                    </Show>
                    <Show when={foldable() && p.turn.prompt}>
                        <Show when={END_TEXT[p.turn.status]}>
                            <div class={`notice end-note end-${p.turn.status}`} data-find-skip>
                                {p.turn.status === "aborted" ? <CircleStop size={14} /> : p.turn.status === "error" || p.turn.status === "blocked" ? <AlertCircle size={14} /> : <AlertTriangle size={14} />}
                                <span>{END_TEXT[p.turn.status]}</span>
                            </div>
                        </Show>
                        <div class="turn-foot">
                            <Show when={reply().trim()}>
                                <CopyButton text={reply} label="Copy response" class="foot-btn" />
                            </Show>
                            <Show when={p.onFork && !p.turn.archived}>
                                <button class="icon-btn foot-btn" title="Fork from here" aria-label="Fork from here" onClick={() => p.onFork?.()}>
                                    <GitFork size={14} />
                                </button>
                            </Show>
                        </div>
                    </Show>
                    <Show when={live()}>
                        <LiveLine state={line()} />
                    </Show>
                </div>
            </Show>
        </article>
    );
}
