import { createMemo, createSignal, Index, Match, Show, Switch } from "solid-js";
import { AlertCircle, AlertTriangle, ChevronRight, Info, RotateCcw, SquareTerminal } from "lucide-solid";
import type { Block, CompactBlock, NoticeBlock, SessionState, ShellBlock, TextBlock, ThinkingBlock, Turn } from "@shared/protocol";
import { clock, duration, stripAnsi } from "../lib/format";
import { now } from "../lib/clock";
import { prefs } from "../state/prefs";
import { ActivityGroup, groupBlocks } from "./blocks/Activity";
import { Markdown } from "./blocks/Markdown";
import { CopyButton, Logo, Spinner } from "./ui/bits";

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

function Thinking(p: { block: ThinkingBlock; live: boolean }) {
    const [open, setOpen] = createSignal(false);
    const label = () => (p.live ? "Thinking" : p.block.durationMs && p.block.durationMs >= 1500 ? `Thought for ${duration(p.block.durationMs)}` : "Thought briefly");
    const preview = () => p.block.text.trim().split("\n").filter(Boolean).slice(-2).join(" ");
    return (
        <Show when={prefs.showThinking || p.live}>
            <div class={`thinking ${open() ? "open" : ""}`}>
                <button class="activity-line" onClick={() => setOpen(!open())} aria-expanded={open()}>
                    <span class="activity-chevron">
                        <ChevronRight size={14} />
                    </span>
                    <span class={`activity-text ${p.live ? "shimmer" : ""}`}>{label()}</span>
                </button>
                <Show when={open()} fallback={<Show when={p.live && preview()}><div class="thinking-peek">{preview()}</div></Show>}>
                    <div class="thinking-text">{p.block.text.trim()}</div>
                </Show>
            </div>
        </Show>
    );
}

function Notice(p: { block: NoticeBlock }) {
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

export function LiveStatus(p: { state: SessionState; since?: number }) {
    const label = () => p.state.activity?.label ?? "Working";
    const elapsed = () => duration(Math.max(0, now() - (p.since ?? p.state.activity?.since ?? now())));
    return (
        <div class="live-status">
            <Spinner size={13} class="tone-accent" />
            <span class="shimmer">{label()}</span>
            <span class="live-meta">
                {elapsed()}
                <Show when={p.state.activity?.detail}> · {p.state.activity!.detail}</Show>
            </span>
            <span class="live-hint">
                <kbd>Esc</kbd> to interrupt
            </span>
        </div>
    );
}

const END_TEXT: Partial<Record<Turn["status"], string>> = {
    aborted: "Interrupted",
    error: "Stopped with an error",
    denied: "Stopped after a declined tool call",
    max_turns: "Stopped at the turn limit",
    blocked: "Blocked by a hook",
};

export function TurnView(p: { turn: Turn; state: SessionState; last: boolean; onRewind?: (index: number) => void }) {
    const items = createMemo(() => groupBlocks(p.turn.blocks));
    const running = () => p.turn.status === "running";
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
    const waitingOnUser = () => running() && p.state.interactions.length > 0;
    const showStatus = () => running() && p.last && !waitingOnUser();

    return (
        <article class={`turn ${p.turn.archived ? "archived" : ""}`} data-turn={p.turn.id}>
            <Show when={p.turn.prompt}>
                <UserPrompt turn={p.turn} onRewind={p.onRewind} />
            </Show>
            <Show when={hasOutput()}>
                <div class="assistant">
                    <Show when={p.turn.prompt}>
                        <div class="assistant-head">
                            <Logo size={20} />
                            <span class="assistant-name">Harness</span>
                            <Show when={p.turn.startedAt}>
                                <span class="assistant-time">{clock(p.turn.startedAt!)}</span>
                            </Show>
                        </div>
                    </Show>
                    <div class="assistant-body">
                        <Index each={items()}>
                            {(item) => (
                                <Switch>
                                    <Match when={item().kind === "activity" && (item() as Extract<ReturnType<typeof items>[number], { kind: "activity" }>)}>
                                        {(g) => <ActivityGroup tools={g().tools} steps={g().steps} turnRunning={running()} />}
                                    </Match>
                                    <Match when={item().kind === "block" && (item() as { block: Block }).block}>
                                        {(b) => (
                                            <Switch>
                                                <Match when={b().t === "text" && (b() as TextBlock)}>{(t) => <Markdown text={t().text} streaming={running() && t().id === lastText()} />}</Match>
                                                <Match when={b().t === "thinking" && (b() as ThinkingBlock)}>{(t) => <Thinking block={t()} live={running() && p.last && t().id === p.turn.blocks[p.turn.blocks.length - 1]?.id} />}</Match>
                                                <Match when={b().t === "notice" && (b() as NoticeBlock)}>{(n) => <Notice block={n()} />}</Match>
                                                <Match when={b().t === "compact" && (b() as CompactBlock)}>{(c) => <Compacted block={c()} />}</Match>
                                                <Match when={b().t === "shell" && (b() as ShellBlock)}>{(s) => <Shell block={s()} />}</Match>
                                            </Switch>
                                        )}
                                    </Match>
                                </Switch>
                            )}
                        </Index>
                        <Show when={showStatus()}>
                            <LiveStatus state={p.state} />
                        </Show>
                        <Show when={!running() && p.turn.prompt}>
                            <div class="turn-foot">
                                <Show when={END_TEXT[p.turn.status]} fallback={<Show when={p.turn.endedAt && p.turn.startedAt}><span>Worked for {duration(p.turn.endedAt! - p.turn.startedAt!)}</span></Show>}>
                                    <span class={`end-${p.turn.status}`}>{END_TEXT[p.turn.status]}</span>
                                </Show>
                                <Show when={reply().trim()}>
                                    <CopyButton text={reply} label="Copy response" class="foot-btn" />
                                </Show>
                            </div>
                        </Show>
                    </div>
                </div>
            </Show>
        </article>
    );
}
