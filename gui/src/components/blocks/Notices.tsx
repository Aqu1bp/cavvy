// A notice, drawn as what it is (#426): the UI explains, not words. An account switch is one centred line between
// turns; info is one quiet line (a CLI's logo as its icon); a warning is an amber pill with its title, what the CLI
// said folded under it; an error is a red card with one short sentence and what to do. lib/notices.ts says what each
// reads as (find counts that), here is how it's drawn.

import { createEffect, createMemo, createSignal, For, Index, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { AlertCircle, AlertTriangle, Check, ChevronRight, CircleCheck, CircleStop, CircleX, Copy, ExternalLink, Goal, Info } from "lucide-solid";
import { stoppedTasksTip, switchMeaning, switchWord, type AccountInfo, type NoticeBlock, type SessionState, type StoppedTask } from "@shared/protocol";
import { codeRuns, errorParts, noticeKind, warnParts } from "../../lib/notices";
import { limitAlternatives } from "../../lib/limits";
import { now } from "../../lib/clock";
import { copyText, openExternal } from "../../lib/platform";
import { app, reportError, rpc, toast } from "../../state/app";
import { findReveal, setContextCardOpen } from "../../state/ui";
import { ProviderIcon } from "../ui/ProviderIcon";

const CLI_NAMES: Record<string, string> = { "claude-code": "Claude Code", codex: "Codex" };
const cliName = (id: string) => CLI_NAMES[id] ?? app.providers.find((p) => p.id === id)?.name ?? id;

/** Text with `code` in it, as code. */
function Runs(p: { text: string }) {
    return <Index each={codeRuns(p.text)}>{(run, i) => (i % 2 ? <code>{run()}</code> : run())}</Index>;
}

/** Whether an element's text is cut short (an ellipsis): checked as it's laid out, and whenever its size changes. */
function useCut(el: () => HTMLElement | undefined) {
    const [cut, setCut] = createSignal(false);
    onMount(() => {
        const e = el();
        if (!e) return;
        const check = () => setCut(e.scrollWidth > e.clientWidth + 1);
        const ro = new ResizeObserver(check);
        ro.observe(e);
        requestAnimationFrame(check);
        onCleanup(() => ro.disconnect());
    });
    return cut;
}

/** Opens when find lands in it. */
function onFound(id: () => string, open: () => void) {
    createEffect(on(findReveal, (r) => r?.part === id() && open()));
}

/** A /goal verdict starts with its own mark (src/agent/goal.ts): shown as an icon instead. */
const GOAL_MARK = /^([◎✓✗]) /;

/** Info: one quiet line, the CLI's logo its icon. Cut short, it opens on click (or when find lands in it). */
function InfoLine(p: { block: NoticeBlock }) {
    let tx: HTMLSpanElement | undefined;
    const mark = () => GOAL_MARK.exec(p.block.text)?.[1];
    const text = () => (mark() ? p.block.text.slice(2) : p.block.text);
    const cut = useCut(() => tx);
    const [open, setOpen] = createSignal(false);
    const long = () => cut() || open() || Boolean(p.block.details?.length);
    onFound(() => p.block.id, () => setOpen(true));
    const toggle = () => long() && setOpen(!open());
    return (
        <div
            class={`nt ${long() ? "long" : ""} ${open() ? "open" : ""} ${mark() === "✓" ? "goal-met" : ""}`}
            data-find={p.block.id}
            role={long() ? "button" : "note"}
            tabIndex={long() ? 0 : undefined}
            aria-expanded={long() ? open() : undefined}
            onClick={toggle}
            onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggle();
            }}
        >
            <span class={`ic ${p.block.source ? "logo" : ""}`} title={p.block.source ? cliName(p.block.source) : undefined}>
                <Show when={p.block.source} fallback={<GoalOrInfo mark={mark()} />}>
                    {(s) => <ProviderIcon id={s()} size={14} />}
                </Show>
            </span>
            <span class="tx" ref={tx}>
                <Runs text={text()} />
                <Show when={open() && p.block.details?.length}>
                    <For each={p.block.details}>{(d) => <span class="nt-detail"><span class="sr-only">{"\n"}</span>{d}</span>}</For>
                </Show>
            </span>
            <Show when={long()}>
                <span class="more" aria-hidden="true">
                    <ChevronRight size={12} />
                </span>
            </Show>
        </div>
    );
}

function GoalOrInfo(p: { mark?: string }) {
    return (
        <Show when={p.mark} fallback={<Info size={14} />}>
            {(m) => (m() === "◎" ? <Goal size={14} /> : m() === "✓" ? <CircleCheck size={14} /> : <CircleX size={14} />)}
        </Show>
    );
}

/** A warning: a compact amber pill with its title; what the CLI said (and its link) folds under it. */
function WarnPill(p: { block: NoticeBlock }) {
    let title: HTMLSpanElement | undefined;
    const parts = createMemo(() => warnParts(p.block, now()));
    const cut = useCut(() => title);
    const [open, setOpen] = createSignal(false);
    const hasBody = () => Boolean(parts().body || p.block.link || p.block.details?.length);
    const folds = () => hasBody() || cut() || open();
    onFound(() => p.block.id, () => setOpen(true));
    const host = () => {
        try {
            return new URL(p.block.link!).host;
        } catch {
            return "";
        }
    };
    const toggle = () => folds() && setOpen(!open());
    // One element whether it folds or not (it starts to once its title is found cut short): what measures it stays.
    const head = (): JSX.Element => (
        <div
            class="nw-h"
            role={folds() ? "button" : undefined}
            tabIndex={folds() ? 0 : undefined}
            aria-expanded={folds() ? open() : undefined}
            onClick={toggle}
            onKeyDown={(e) => {
                if (e.key !== "Enter" && e.key !== " ") return;
                e.preventDefault();
                toggle();
            }}
        >
            <span class="ic">
                <AlertTriangle size={14} />
            </span>
            <span class="nw-title" ref={title}>
                <Runs text={parts().title} />
            </span>
            <Show when={p.block.source}>
                {(s) => (
                    <span class="nw-src" title={cliName(s())} data-find-skip>
                        <ProviderIcon id={s()} size={13} />
                        <span class="sr-only">{` · ${cliName(s())}`}</span>
                    </span>
                )}
            </Show>
            <Show when={folds()}>
                <ChevronRight size={12} class="chev" />
            </Show>
        </div>
    );
    return (
        <div class={`nw ${open() ? "open" : ""}`} data-find={p.block.id}>
            {head()}
            {/* Drawn once it's open: folded, only the title reads (find opens it to a match in what's under it). */}
            <Show when={hasBody() && open()}>
                <div class="nw-body">
                    <Show when={parts().body}>
                        {(b) => (
                            <p>
                                <span class="sr-only">{"\n"}</span>
                                <Runs text={b()} />
                            </p>
                        )}
                    </Show>
                    <Show when={p.block.details?.length}>
                        <ul class="nw-details">
                            <For each={p.block.details}>{(d) => <li class="truncate" title={d}><span class="sr-only">{"\n"}</span>{d}</li>}</For>
                        </ul>
                    </Show>
                    <Show when={p.block.link}>
                        <div class="row" data-find-skip>
                            <a
                                class="nlink"
                                href={p.block.link}
                                title={p.block.link}
                                onClick={(e) => {
                                    e.preventDefault();
                                    void openExternal(p.block.link!);
                                }}
                            >
                                Docs <span class="host">{host()}</span>
                                <ExternalLink size={12} />
                            </a>
                        </div>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

/** An error: a red card, never cut short: one short sentence, what was said with it, and what to do. */
function ErrorCard(p: { block: NoticeBlock; state?: SessionState }) {
    const parts = createMemo(() => errorParts(p.block, now()));
    const limit = () => p.block.limit;
    const [copied, setCopied] = createSignal(false);
    return (
        <div class="ne" data-find={p.block.id}>
            <span class="ic">
                <AlertCircle size={14} />
            </span>
            <div class="ne-title">
                <Runs text={parts().title} />
            </div>
            <Show when={parts().body}>
                {(b) => (
                    <div class="ne-body">
                        <span class="sr-only">{"\n"}</span>
                        <span class={p.block.title ? undefined : "mono"}>
                            <Runs text={b()} />
                        </span>
                    </div>
                )}
            </Show>
            <div class="ne-foot" data-find-skip>
                <Show
                    when={limit()}
                    fallback={
                        <button
                            class="cbtn"
                            title="Copy the error"
                            onClick={async () => {
                                if (await copyText(p.block.text)) {
                                    setCopied(true);
                                    setTimeout(() => setCopied(false), 1400);
                                }
                            }}
                        >
                            <Show when={copied()} fallback={<Copy size={12} />}>
                                <Check size={12} />
                            </Show>
                            {copied() ? "Copied" : "Copy"}
                        </button>
                    }
                >
                    {(l) => <LimitActions provider={l().provider} accountId={l().accountId} resetsAt={l().resetsAt} state={p.state} />}
                </Show>
            </div>
        </div>
    );
}

/**
 * What a limit's card offers: another account (the plan meter's switch: a new CLI thread with this conversation,
 * and the message sent again), and the plan meter's card. Another account only while the session is still on the
 * one that's out, and it isn't past its reset.
 */
function LimitActions(p: { provider: string; accountId: string; resetsAt?: number; state?: SessionState }) {
    const [accounts, setAccounts] = createSignal<AccountInfo[]>([]);
    const [switching, setSwitching] = createSignal(false);
    const current = () => p.state && (p.state.accounts?.[p.provider] ?? "default") === p.accountId && p.state.model?.provider === p.provider;
    const live = () => Boolean(current()) && (p.resetsAt === undefined || p.resetsAt > now());
    // Asked when the card is drawn (as the plan meter asks once a limit is reached): only a signed-in account helps.
    createEffect(
        on(live, (on) => {
            if (!on) return;
            let active = true;
            void rpc
                .call("accounts.list", { provider: p.provider, refresh: true })
                .then((items) => active && setAccounts(items))
                .catch(() => undefined);
            onCleanup(() => (active = false));
        }),
    );
    const others = () => (live() ? limitAlternatives(accounts(), p.accountId) : []);
    async function switchTo(id: string) {
        if (!p.state) return;
        setSwitching(true);
        try {
            await rpc.call("session.setAccount", { id: p.state.id, provider: p.provider, accountId: id });
            toast("Account switched. Send your message again to continue.", "info");
        } catch (error) {
            reportError(error);
        } finally {
            setSwitching(false);
        }
    }
    return (
        <>
            <For each={others()}>
                {(a) => (
                    <button class="cbtn" disabled={(p.state?.busy && !p.state.activity?.idle) || switching()} title="Starts a new CLI thread with this conversation; send your message again" onClick={() => void switchTo(a.id)}>
                        Switch to {a.name}
                    </button>
                )}
            </For>
            <button class="cbtn quiet" aria-label="Plan limits" onClick={() => setContextCardOpen(true)}>
                Limits
            </button>
        </>
    );
}

/**
 * An account switch, between turns: neither yours nor the reply, so one centred line across the column, hairlines
 * either side. Who, and one word for how the conversation goes on; the tooltip (and a screen reader) has the rest.
 * Background work its restart stopped is a second line: one task by its description (Codex's by its command), cut
 * short; two or more by their count.
 */
function SwitchLine(p: { block: NoticeBlock }) {
    const a = () => p.block.account!;
    const stopped = () => a().stopped ?? [];
    const meaning = () => switchMeaning(a());
    return (
        <div class="ev" data-find={p.block.id}>
            <div class="ev-line">
                <span class="ev-h" tabIndex={0} title={meaning()}>
                    <span class="prov" aria-hidden="true">
                        <ProviderIcon id={a().provider} size={14} />
                    </span>
                    <span class="ev-t" aria-hidden="true">
                        <b>
                            {a().cli} · {a().name}
                        </b>{" "}
                        <span class="how">{switchWord(a().how)}</span>
                    </span>
                    <span class="sr-only" data-find-skip>
                        {meaning()}
                    </span>
                </span>
            </div>
            <Show when={stopped().length}>
                <StoppedLine provider={a().provider} tasks={stopped()} under />
            </Show>
        </div>
    );
}

/** What a switch's restart stopped: under its line, or (`under` unset: said after a message came) a line of its own. */
function StoppedLine(p: { provider: string; tasks: StoppedTask[]; under?: boolean }) {
    const tip = () => stoppedTasksTip(p.provider, p.tasks);
    return (
        <div class="ev-sub" tabIndex={0} title={tip()}>
            <Show when={p.under}>
                <span class="sr-only">{"\n"}</span>
            </Show>
            <CircleStop size={12} aria-hidden="true" />
            <span class="n" aria-hidden="true">
                {p.tasks.length === 1 ? "Stopped: " : `${p.tasks.length} tasks stopped`}
            </span>
            <Show when={p.tasks.length === 1}>
                <span class={`what ${p.provider === "codex" ? "mono" : ""}`} aria-hidden="true">
                    {p.tasks[0]!.label}
                </span>
            </Show>
            <span class="sr-only" data-find-skip>
                {tip()}
            </span>
        </div>
    );
}

/** A notice block, drawn as what it is (lib/notices.ts noticeKind). */
export function Notice(p: { block: NoticeBlock; state?: SessionState }) {
    const kind = () => noticeKind(p.block);
    return (
        <Switch fallback={<InfoLine block={p.block} />}>
            <Match when={kind() === "switch"}>
                <SwitchLine block={p.block} />
            </Match>
            <Match when={kind() === "stopped"}>
                <div class="ev" data-find={p.block.id}>
                    <StoppedLine provider={p.block.stopped!.provider} tasks={p.block.stopped!.tasks} />
                </div>
            </Match>
            <Match when={kind() === "error"}>
                <ErrorCard block={p.block} state={p.state} />
            </Match>
            <Match when={kind() === "warn"}>
                <WarnPill block={p.block} />
            </Match>
        </Switch>
    );
}
