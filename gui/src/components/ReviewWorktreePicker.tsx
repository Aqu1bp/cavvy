// Which worktree the diff reader looks at: the session's own folder, or
// another worktree of its repository (one an agent works in, say). Each is
// marked with what's working in it, its branch's lead on the main branch and
// when it was last committed. A searchable list like BasePicker's.

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Bot, Check, ChevronDown, FolderGit2, MessageSquare, Search } from "lucide-solid";
import type { SessionWorktreeInfo } from "@shared/protocol";
import { app } from "../state/app";
import { plural, since, tildify } from "../lib/format";
import type { WorktreeWork } from "../lib/worktree-work";
import { Popover } from "./ui/Popover";

/** Work named per row; the rest are counted. */
const NAMED = 3;

export const worktreeLabel = (w: Pick<SessionWorktreeInfo, "branch" | "detached" | "head">) => w.branch || (w.detached ? `Detached · ${w.head?.slice(0, 7) ?? "HEAD"}` : "Worktree");

/** Where it is, short: inside the main checkout (.claude/worktrees), from the checkout's folder on; elsewhere, from ~. */
function where(w: SessionWorktreeInfo, main: SessionWorktreeInfo | undefined): string {
    if (main && !w.main && w.path.startsWith(`${main.path}/`)) return `${main.path.slice(main.path.lastIndexOf("/") + 1)}${w.path.slice(main.path.length)}`;
    return tildify(w.path, app.hello?.homeDir);
}

/** Usable: its folder is there and git can read it. */
const usable = (w: SessionWorktreeInfo) => w.exists && w.prunable === undefined;

/** "3 ahead of origin/main · committed 5m ago" */
function facts(w: SessionWorktreeInfo): string {
    const parts: string[] = [];
    if (w.ahead !== undefined && w.base) parts.push(w.ahead ? `${plural(w.ahead, "commit")} ahead of ${w.base}` : `Even with ${w.base}`);
    if (w.committedAt) parts.push(`committed ${since(w.committedAt)}${since(w.committedAt) === "now" ? "" : " ago"}`);
    if (!w.exists) parts.push("Folder missing");
    else if (w.prunable !== undefined) parts.push(`Unavailable${w.prunable ? `: ${w.prunable}` : ""}`);
    return parts.join(" · ");
}

function busy(work: WorktreeWork | undefined): boolean {
    return Boolean(work && (work.agents.length || work.sessions.some((s) => s.running)));
}

export function ReviewWorktreePicker(p: {
    /** The worktree looked at; undefined for the session's own folder. */
    value?: string;
    /** The label while the list isn't known: the branch shown. */
    fallbackLabel: string;
    worktrees?: SessionWorktreeInfo[];
    loading: boolean;
    error?: string;
    /** What works in each worktree; worked out only while the list is open. */
    work: () => Map<string, WorktreeWork>;
    onOpen: () => void;
    onPick: (worktree: string | undefined) => void;
}) {
    let anchor: HTMLButtonElement | undefined;
    let input: HTMLInputElement | undefined;
    let list: HTMLDivElement | undefined;
    const [open, setOpen] = createSignal(false);
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    const own = () => p.worktrees?.find((w) => w.current);
    const work = createMemo(() => (open() ? p.work() : new Map<string, WorktreeWork>()));
    const shown = () => (p.value === undefined ? own() : p.worktrees?.find((w) => w.path === p.value));
    /** The session's own first, then those with work going on, then the latest committed; ones that can't be read last. */
    const rows = createMemo(() => {
        const needle = q().trim().toLowerCase();
        const all = (p.worktrees ?? []).filter((w) => {
            if (!needle) return true;
            const there = work().get(w.path);
            return [worktreeLabel(w), w.path, ...(there?.agents.map((a) => a.description) ?? []), ...(there?.sessions.map((s) => s.title) ?? [])].some((s) => s.toLowerCase().includes(needle));
        });
        const rank = (w: SessionWorktreeInfo) => (w.current ? 0 : !usable(w) ? 3 : busy(work().get(w.path)) ? 1 : 2);
        return all.sort((a, b) => rank(a) - rank(b) || (b.committedAt ?? 0) - (a.committedAt ?? 0));
    });
    const isOn = (w: SessionWorktreeInfo) => (p.value === undefined ? w.current : w.path === p.value);
    createEffect(
        on(open, (o) => {
            if (!o) return;
            p.onOpen();
            setQ("");
            setSel(Math.max(0, rows().findIndex(isOn)));
            requestAnimationFrame(() => {
                input?.focus();
                list?.querySelector(".menu-item.sel")?.scrollIntoView({ block: "nearest" });
            });
        }),
    );
    createEffect(on(q, () => setSel(0), { defer: true }));
    const choose = (w: SessionWorktreeInfo) => {
        if (!usable(w)) return;
        setOpen(false);
        p.onPick(w.current ? undefined : w.path);
    };
    const onKey = (e: KeyboardEvent) => {
        const n = rows().length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (!n) return;
            setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
            requestAnimationFrame(() => list?.querySelector(".menu-item.sel")?.scrollIntoView({ block: "nearest" }));
        } else if (e.key === "Enter") {
            e.preventDefault();
            const w = rows()[sel()];
            if (w) choose(w);
        }
    };
    const label = () => (shown() ? worktreeLabel(shown()!) : p.fallbackLabel);
    return (
        <>
            <button
                ref={anchor}
                class={`rv-wt-ctl ${p.value !== undefined ? "away" : ""}`}
                title={p.value === undefined ? "Looking at this session's folder. Choose another worktree" : `Looking at ${tildify(p.value, app.hello?.homeDir)}. Choose another worktree`}
                aria-label="Choose the worktree to review"
                aria-haspopup="dialog"
                aria-expanded={open()}
                onClick={() => setOpen(!open())}
            >
                <FolderGit2 size={13} />
                <span class="mono truncate">{label()}</span>
                <Show when={p.value === undefined}>
                    <span class="rv-wt-self">This session</span>
                </Show>
                <ChevronDown size={12} class="chv" />
            </button>
            <Popover open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="start" width={400} maxHeight={680}>
                <div role="dialog" aria-label="Choose a worktree" onKeyDown={onKey}>
                    <div class="mp-search">
                        <Search size={14} />
                        <input ref={input} value={q()} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search worktrees, agents, sessions…" aria-label="Search worktrees" spellcheck={false} />
                    </div>
                    <div class="base-list rv-wt-list" ref={list} role="listbox" aria-label="Worktrees">
                        <Show when={!p.error} fallback={<div class="menu-note">{p.error}</div>}>
                            <Show when={p.worktrees || !p.loading} fallback={<div class="menu-note">Loading worktrees…</div>}>
                                <For each={rows()} fallback={<div class="menu-note">{p.worktrees?.length ? "No worktrees match." : "This folder isn't in a Git repository."}</div>}>
                                    {(w, i) => {
                                        const there = () => work().get(w.path);
                                        const named = () => [...(there()?.agents.map((a) => ({ key: `a${a.id}`, agent: true, text: a.description, dot: a.waiting ? "st-waiting" : "st-running" })) ?? []), ...(there()?.sessions.map((s) => ({ key: `s${s.id}`, agent: false, text: s.title, dot: s.running ? "st-running" : "" })) ?? [])];
                                        return (
                                            <button
                                                class={`menu-item rv-wt-item ${i() === sel() ? "sel" : ""} ${isOn(w) ? "current" : ""}`}
                                                role="option"
                                                aria-selected={isOn(w)}
                                                aria-disabled={!usable(w)}
                                                title={w.path}
                                                onMouseMove={() => setSel(i())}
                                                onClick={() => choose(w)}
                                            >
                                                <FolderGit2 size={15} />
                                                <span class="menu-text">
                                                    <span class="rv-wt-name">
                                                        <span class="menu-label mono truncate">{worktreeLabel(w)}</span>
                                                        <Show when={w.current}>
                                                            <span class="rv-wt-self">This session</span>
                                                        </Show>
                                                    </span>
                                                    <span class="menu-desc mono truncate">{where(w, p.worktrees?.find((x) => x.main))}</span>
                                                    <Show when={facts(w)}>
                                                        <span class="menu-desc">{facts(w)}</span>
                                                    </Show>
                                                    <Show when={named().length}>
                                                        <span class="rv-wt-work">
                                                            <For each={named().slice(0, NAMED)}>
                                                                {(n) => (
                                                                    <span class="rv-wt-who" title={n.agent ? `Sub-agent: ${n.text}` : `Session: ${n.text}`}>
                                                                        <span class="rv-wt-ico">
                                                                            <Show when={n.agent} fallback={<MessageSquare size={12} />}>
                                                                                <Bot size={12} />
                                                                            </Show>
                                                                            <Show when={n.dot}>
                                                                                <span class={`rv-wt-dot ${n.dot}`} aria-label={n.dot === "st-waiting" ? "Waiting for you" : "Running"} />
                                                                            </Show>
                                                                        </span>
                                                                        <span class="truncate">{n.text}</span>
                                                                    </span>
                                                                )}
                                                            </For>
                                                            <Show when={named().length > NAMED}>
                                                                <span class="rv-wt-more">+{named().length - NAMED} more</span>
                                                            </Show>
                                                        </span>
                                                    </Show>
                                                </span>
                                                <Show when={isOn(w)}>
                                                    <Check size={14} class="menu-check" />
                                                </Show>
                                            </button>
                                        );
                                    }}
                                </For>
                            </Show>
                        </Show>
                    </div>
                    <div class="menu-note">Other worktrees show their branch and uncommitted changes; turns and Harness edits are this session's.</div>
                </div>
            </Popover>
        </>
    );
}
