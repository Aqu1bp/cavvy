import { RenderBoundary } from "./ui/ErrorBoundary";
import { createComputed, createEffect, createMemo, createResource, createSignal, For, Index, Match, on, Show, Switch, untrack } from "solid-js";
import { AlertCircle, AlertTriangle, BellRing, Check, CircleStop, ChevronRight, Clock, CornerDownRight, FileDiff, FileText, Folder, FolderGit2, GitFork, Info, MessageSquareText, RotateCcw, SquareArrowOutUpRight, SquareTerminal, X } from "lucide-solid";
import type { AgentRun, Block, CompactBlock, FileDiff as Diff, ImportedBlock, NoticeBlock, SessionState, ShellBlock, TextBlock, ThinkingBlock, Turn, TurnPlace } from "@shared/protocol";
import { basename, firstChangedLine, plural, promptTime, shortPrompt, stripAnsi, tildify } from "../lib/format";
import { cardShape, incompleteLine, PLACES_SHOWN, placeRows, placesTotal, WHO_NAMED, workers, type OwnPlace } from "../lib/turn-places";
import { agentProvider } from "../lib/agent-marks";
import { liveLine, workedLabel, workSegments } from "../lib/live-line";
import { formatSize } from "../lib/attachments";
import { linesLabel, linesPhrase, splitComments } from "../lib/review-comments";
import { prefs } from "../state/prefs";
import { fetchGitChanges, type GitView } from "../state/changes";
import { openInEditor, openReview, openWorktreeReview } from "../state/actions";
import { findReveal, setViewedImage } from "../state/ui";
import { imagesReady, promptImages, type PromptImage } from "../state/images";
import { ActivityGroup, groupBlocks, Thinking, type Item } from "./blocks/Activity";
import { Markdown } from "./blocks/Markdown";
import { CopyButton, Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";
import { app } from "../state/app";
import { Notice } from "./blocks/Notices";
import { hasErrorCard, leadingNotices, shownBlocks } from "../lib/notices";
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
                    <button
                        class="prompt-image"
                        title="View full size"
                        aria-label={`View image ${i() + 1} of ${images()!.length}`}
                        onClick={(e) => setViewedImage({ images: images()!.map((m, k) => ({ name: `Image ${k + 1}`, full: m, preview: m.thumb })), index: i(), from: e.currentTarget })}
                    >
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
type Recorded = Pick<GitView, "repo" | "turnId" | "error" | "snapshotAvailable" | "incomplete" | "notes" | "more" | "places"> & { files: Changed[] };
/**
 * Turns' recorded diffs, by session and snapshot. A finished turn's never changes, so a card
 * mounted again (switching back to the session) has it at once instead of asking the server to
 * diff the turn again and sending every hunk (megabytes for a turn that touched hundreds of files).
 */
const recordedTurns = new Map<string, Recorded>();
const RECORDED_KEPT = 400;

function summarize(view: GitView): Recorded {
    const { repo, turnId, error, snapshotAvailable, incomplete, notes, more, places } = view;
    return { repo, turnId, error, snapshotAvailable, incomplete, notes, more, places, files: view.files.map((f) => ({ path: f.path, status: f.status, added: f.added, removed: f.removed, line: firstChangedLine(f), ...(f.pathToken ? { pathToken: f.pathToken } : {}) })) };
}

function ChangesCard(p: { turn: Turn; cwd: string; sessionId: string; busy: boolean; agents?: AgentRun[]; provider?: string }) {
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
    const reviewTurn = () => captured() ? openReview(undefined, "turn", p.turn.snapshotId) : reviewChanges(files()[0]?.path, files()[0]?.pathToken);
    const total = () => files().reduce((a, f) => ({ added: a.added + f.added, removed: a.removed + f.removed }), { added: 0, removed: 0 });
    const [all, setAll] = createSignal(false);
    // The other worktrees the turn worked in (sub-agents' own, one it entered): with its own folder, the card's places.
    const places = () => (captured() ? recorded()?.places ?? [] : []);
    const own = createMemo<OwnPlace | undefined>(() => (files().length ? { files: files().length + (snapshotDiff() ? recorded()?.more ?? 0 : 0), ...total() } : undefined));
    const shape = () => cardShape(own(), places());
    const rows = createMemo(() => placeRows(own(), places()));
    const who = createMemo(() => workers(places(), { turnId: p.turn.id, agents: p.agents, blocks: p.turn.blocks, home: app.hello?.homeDir, provider: (a) => agentProvider(a, p.provider, p.agents), own: p.provider }));
    const [allPlaces, setAllPlaces] = createSignal(false);
    const incomplete = () => (captured() && recorded()?.incomplete ? incompleteLine(recorded()?.notes) : undefined);
    const one = () => places()[0]!;
    const commits = (n?: number) => (n ? ` · ${plural(n, "commit")}` : "");
    const Stat = (s: { added?: number; removed?: number }) => (
        <span class="stat">
            <span class="add">+{(s.added ?? 0).toLocaleString()}</span>
            <span class="del">−{(s.removed ?? 0).toLocaleString()}</span>
        </span>
    );
    return (
        <Show when={files().length || places().length || incomplete()}>
            <div class="tcard files-card" data-find-skip>
                <Switch>
                    {/* Its own folder: the files, as before. */}
                    <Match when={shape() === "files"}>
                        <div class="tcard-h files-head">
                            <span class="tcard-ic">
                                <FileDiff size={14} />
                            </span>
                            <span class="files-title">{!snapshotDiff() && !files().length ? "Turn snapshot incomplete" : plural(own()?.files ?? 0, "changed file")}</span>
                            <Show when={files().length}>
                                <Stat {...total()} />
                            </Show>
                            <span class="grow" />
                            {/* Keep recorded changes tied to this turn, even after later edits. */}
                            <button class="tbtn" onClick={reviewTurn}>
                                Review changes
                            </button>
                        </div>
                        <div class="files-rows">
                            <For each={all() ? files() : files().slice(0, FILES_SHOWN)}>
                                {(f) => (
                                    <div class="frow-line">
                                        <button class="frow" onClick={() => reviewChanges(f.path, f.pathToken)}>
                                            <SplitPath path={f.path} cwd={p.cwd} />
                                            <Show when={f.status === "added"}>
                                                <span class="frow-tag">new</span>
                                            </Show>
                                            <Stat {...f} />
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
                    </Match>
                    {/* One other worktree: its files, with its branch beside Review. */}
                    <Match when={shape() === "worktree"}>
                        <div class="tcard-h files-head">
                            <span class="tcard-ic">
                                <FileDiff size={14} />
                            </span>
                            <span class="files-title">{one().files !== undefined ? plural(one().files!, "changed file") : `Changes in ${basename(one().path)}`}</span>
                            <Show when={one().files !== undefined}>
                                <Stat {...one()} />
                            </Show>
                            <Show when={one().commits}>
                                <span class="files-sub">· {plural(one().commits!, "commit")}</span>
                            </Show>
                            <span class="grow" />
                            <span class="place-chip" title={`Worktree ${tildify(one().path, app.hello?.homeDir)}${one().base ? `, against ${one().base}` : ""}`}>
                                <FolderGit2 size={13} />
                                <span class="truncate">{one().branch ?? basename(one().path)}</span>
                            </span>
                            <button class="tbtn" onClick={() => openWorktreeReview(one().path)}>
                                Review changes
                            </button>
                        </div>
                        <Show when={one().top?.length}>
                            <div class="files-rows">
                                <For each={one().top}>
                                    {(f) => (
                                        <div class="frow-line">
                                            <button class="frow" onClick={() => openWorktreeReview(one().path, f.path, f.pathToken)}>
                                                <SplitPath path={f.path} />
                                                <Show when={f.change === "added"}>
                                                    <span class="frow-tag">new</span>
                                                </Show>
                                                <Stat {...f} />
                                            </button>
                                        </div>
                                    )}
                                </For>
                                <Show when={(one().files ?? 0) > (one().top?.length ?? 0)}>
                                    <button class="frow more" onClick={() => openWorktreeReview(one().path)}>
                                        {plural((one().files ?? 0) - (one().top?.length ?? 0), "more file")}
                                    </button>
                                </Show>
                            </div>
                        </Show>
                    </Match>
                    {/* Several places: a row each, its own folder first, then the busiest, with who worked there. */}
                    <Match when={shape() === "places"}>
                        <div class="tcard-h files-head">
                            <span class="tcard-ic">
                                <FolderGit2 size={14} />
                            </span>
                            <span class="files-title">Changes in {rows().length} places</span>
                            <span class="files-sub">{plural(placesTotal(rows()).files, "file")}</span>
                            <Stat {...placesTotal(rows())} />
                            <span class="grow" />
                        </div>
                        <div class="files-rows">
                            <For each={allPlaces() ? rows() : rows().slice(0, PLACES_SHOWN)}>
                                {(r) => {
                                    const folk = () => (r.own ? [] : who().get(r.place.path) ?? []);
                                    return (
                                        <div class="place-row">
                                            <span class="place-ic">{r.own ? <Folder size={15} /> : <FolderGit2 size={15} />}</span>
                                            <span class="place-name">
                                                <span class="truncate place-title">
                                                    {r.own ? basename(p.cwd) : basename(r.place.path)}
                                                    <Show when={r.own}>
                                                        <span class="place-own">this folder</span>
                                                    </Show>
                                                </span>
                                                <Show when={!r.own && (r.place as TurnPlace).branch}>
                                                    <span class="truncate place-branch">{(r.place as TurnPlace).branch}{commits((r.place as TurnPlace).commits)}</span>
                                                </Show>
                                            </span>
                                            <span class="place-who">
                                                <For each={folk().slice(0, WHO_NAMED)}>
                                                    {(w) => (
                                                        <span class="place-ag" title={w.you ? "This session" : w.label}>
                                                            <Show when={w.provider}>
                                                                <ProviderIcon id={w.provider!} size={12} />
                                                            </Show>
                                                            <span class="truncate">{w.label}</span>
                                                        </span>
                                                    )}
                                                </For>
                                                <Show when={folk().length > WHO_NAMED}>
                                                    <span class="place-ag more" title={folk().slice(WHO_NAMED).map((w) => w.label).join(", ")}>+{folk().length - WHO_NAMED}</span>
                                                </Show>
                                            </span>
                                            <span class="place-files">{r.place.files !== undefined ? plural(r.place.files, "file") : ""}</span>
                                            <Show when={r.place.files !== undefined} fallback={<span class="stat" />}>
                                                <Stat {...r.place} />
                                            </Show>
                                            <button class="tbtn" onClick={() => (r.own ? reviewTurn() : openWorktreeReview((r.place as TurnPlace).path))}>
                                                Review
                                            </button>
                                        </div>
                                    );
                                }}
                            </For>
                            <Show when={rows().length > PLACES_SHOWN}>
                                <button class="frow more" onClick={() => setAllPlaces(!allPlaces())}>
                                    {allPlaces() ? "Show fewer" : plural(rows().length - PLACES_SHOWN, "more place")}
                                </button>
                            </Show>
                        </div>
                    </Match>
                </Switch>
                {/* What the snapshot left out, in a line; why, in its tooltip. */}
                <Show when={incomplete()}>
                    {(line) => (
                        <div class="review-note files-note" title={line().detail}>
                            <Info size={13} />
                            {line().text}
                        </div>
                    )}
                </Show>
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
    // A limit's card takes the place of the turn's earlier "limit reached" (lib/notices.ts).
    const items = createMemo(() => groupBlocks(shownBlocks(p.turn.blocks)));
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
    // A prompt stopped before anything came still says how it ended (its line is in the reply's place).
    const hasOutput = () => p.turn.blocks.length > 0 || running() || Boolean(p.turn.prompt && END_TEXT[p.turn.status]);
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
                        <Match when={b().t === "notice" && (b() as NoticeBlock)}>{(n) => <Notice block={n()} state={p.state} />}</Match>
                        <Match when={b().t === "compact" && (b() as CompactBlock)}>{(c) => <Compacted block={c()} />}</Match>
                        <Match when={b().t === "imported" && (b() as ImportedBlock)}>{(c) => <Imported block={c()} />}</Match>
                        <Match when={b().t === "shell" && (b() as ShellBlock)}>{(s) => <Shell block={s()} />}</Match>
                    </Switch>
                )}
            </Match>
        </Switch>
    );

    const renderSeg = (seg: () => (typeof segs extends () => (infer S)[] ? S : never)) => (
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
    );
    // How many of its first rows are notices from before its first step (lib/notices.ts).
    const lead = createMemo(() => (hasWork() ? leadingNotices(segs()) : 0));

    return (
        <article class={`turn ${p.turn.archived ? "archived" : ""} ${p.turn.imported ? "imported" : ""} ${p.held ? "chained" : ""} ${foldable() ? "done" : ""}`} data-turn={p.turn.id} aria-busy={running()} ref={(el) => (article = el, p.onElement?.(el, p.turn.id))}>
            <Show when={p.turn.prompt}>
                <h2 class="sr-only" data-find-skip>You said</h2>
                <UserPrompt turn={p.turn} sessionId={p.state.id} onRewind={p.onRewind} />
            </Show>
            <Show when={hasOutput()}>
                <div class="reply">
                    <h2 class="sr-only" data-find-skip>{running() ? "Cavvy is working" : "Cavvy replied"}</h2>
                    {/* Notices from before its first step, where they happened: above "Worked for". */}
                    <Index each={segs().slice(0, lead())}>{renderSeg}</Index>
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
                    <Index each={segs().slice(lead())}>{renderSeg}</Index>
                    <Show when={foldable() && !p.turn.archived && !p.turn.imported}>
                        <ChangesCard turn={p.turn} cwd={p.state.cwd} sessionId={p.state.id} busy={p.state.busy} agents={p.agents} provider={p.state.model?.provider} />
                    </Show>
                    <Show when={foldable() && p.turn.prompt}>
                        {/* An error's card says how the turn ended: no second line under it. */}
                        <Show when={END_TEXT[p.turn.status] && !(p.turn.status === "error" && hasErrorCard(p.turn.blocks))}>
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
