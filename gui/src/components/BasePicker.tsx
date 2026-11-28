// The branch the review pane's Branch view compares with: "vs <base>" in the
// reader's toolbar, opening a short, searchable list of local and remote
// branches, most recently changed first.

import { createEffect, createMemo, createResource, createSignal, For, on, Show } from "solid-js";
import { Check, ChevronDown, Search } from "lucide-solid";
import type { GitLogEntry } from "@shared/protocol";
import { since } from "../lib/format";
import { Popover } from "./ui/Popover";

/** Shown at once; typing narrows the rest. */
const SHOWN = 80;

/** `tokens`: beside `bases`, a branch's handle when its name was shown redacted; that's what's picked then. */
/** `current`: the picked branch's key (its handle, or its name), so two shown alike aren't both the current one. */
export function BasePicker(p: { value?: string; current?: string; bases: string[]; tokens?: (string | null)[]; onPick: (base: string) => void }) {
    let anchor: HTMLButtonElement | undefined;
    let input: HTMLInputElement | undefined;
    let list: HTMLDivElement | undefined;
    const [open, setOpen] = createSignal(false);
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    const rows = createMemo(() => {
        const needle = q().trim().toLowerCase();
        const entries = p.bases.map((name, i) => ({ name, key: p.tokens?.[i] ?? name }));
        return (needle ? entries.filter((b) => b.name.toLowerCase().includes(needle)) : entries).slice(0, SHOWN);
    });
    createEffect(
        on(open, (o) => {
            if (!o) return;
            setQ("");
            setSel(Math.max(0, rows().findIndex(isCurrent)));
            requestAnimationFrame(() => {
                input?.focus();
                list?.querySelector(".menu-item.sel")?.scrollIntoView({ block: "nearest" });
            });
        }),
    );
    createEffect(on(q, () => setSel(0), { defer: true }));
    const isCurrent = (b: { name: string; key: string }) => (p.current !== undefined ? b.key === p.current : b.name === p.value);
    const choose = (b: { name: string; key: string }) => {
        setOpen(false);
        p.onPick(b.key);
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
            const b = rows()[sel()];
            if (b) choose(b);
        }
    };
    return (
        <>
            <button ref={anchor} class="tb base" title={p.value ? `Compared with ${p.value}. Compare with another branch` : "Compare with another branch"} aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(!open())}>
                <Show when={p.value} fallback={<span class="lbl">Pick a base</span>}>
                    vs <span class="mono lbl">{p.value}</span>
                </Show>
                <ChevronDown size={12} class="chev" />
            </button>
            <Popover open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="start" width={300} maxHeight={360}>
                <div role="dialog" aria-label="Choose a base branch" onKeyDown={onKey}>
                    <div class="mp-search">
                        <Search size={14} />
                        <input ref={input} value={q()} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search branches…" aria-label="Search branches" spellcheck={false} />
                    </div>
                    <div class="base-list" ref={list} role="listbox" aria-label="Branches">
                        <For each={rows()} fallback={<div class="menu-note">{p.bases.length ? "No branches match." : "No other branches."}</div>}>
                            {(b, i) => (
                                <button class={`menu-item compact ${i() === sel() ? "sel" : ""}`} role="option" aria-selected={isCurrent(b)} onMouseMove={() => setSel(i())} onClick={() => choose(b)}>
                                    <span class="menu-item-name mono truncate grow">{b.name}</span>
                                    <Show when={isCurrent(b)}>
                                        <Check size={14} class="menu-check" />
                                    </Show>
                                </button>
                            )}
                        </For>
                    </div>
                </div>
            </Popover>
        </>
    );
}

/**
 * The commit the review pane's Commit view shows: its short id and subject in the toolbar, opening a searchable list of
 * HEAD's recent commits, newest first. The list is read each time it opens (`load`), never before.
 */
export function CommitPicker(p: { value?: GitLogEntry; load: () => Promise<{ commits: GitLogEntry[]; more: boolean }>; onPick: (sha: string) => void }) {
    let anchor: HTMLButtonElement | undefined;
    let input: HTMLInputElement | undefined;
    let list: HTMLDivElement | undefined;
    const [open, setOpen] = createSignal(false);
    const [q, setQ] = createSignal("");
    const [sel, setSel] = createSignal(0);
    const [log] = createResource(open, () => p.load().then((r) => ({ ...r, error: undefined }), (e: unknown) => ({ commits: [] as GitLogEntry[], more: false, error: e instanceof Error ? e.message : String(e) })));
    const rows = createMemo(() => {
        const needle = q().trim().toLowerCase();
        const all = log()?.commits ?? [];
        return needle ? all.filter((c) => c.subject.toLowerCase().includes(needle) || c.sha.startsWith(needle) || c.author.toLowerCase().includes(needle)) : all;
    });
    createEffect(on(open, (o) => o && (setQ(""), requestAnimationFrame(() => input?.focus()))));
    // Once listed, on the commit shown.
    createEffect(on(() => log(), (l) => l && setSel(Math.max(0, rows().findIndex((c) => c.sha === p.value?.sha)))));
    createEffect(on(q, () => setSel(0), { defer: true }));
    createEffect(on(sel, () => requestAnimationFrame(() => list?.querySelector(".menu-item.sel")?.scrollIntoView({ block: "nearest" }))));
    const choose = (c: GitLogEntry) => {
        setOpen(false);
        p.onPick(c.sha);
    };
    const onKey = (e: KeyboardEvent) => {
        const n = rows().length;
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            if (n) setSel((s) => (s + (e.key === "ArrowDown" ? 1 : -1) + n) % n);
        } else if (e.key === "Enter") {
            e.preventDefault();
            const c = rows()[sel()];
            if (c) choose(c);
        }
    };
    const label = () => (p.value ? `${p.value.sha.slice(0, 7)} ${p.value.subject}` : undefined);
    return (
        <>
            <button ref={anchor} class="tb base rv-pick" title={label() ? `${label()}\nShow another commit` : "Show another commit"} aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(!open())}>
                <Show when={p.value} fallback={<span class="lbl">Pick a commit</span>}>
                    {/* The subject is in the tooltip and the list: beside the hash, the toolbar has room for a letter or two of it. */}
                    {(c) => <span class="mono">{c().sha.slice(0, 7)}</span>}
                </Show>
                <ChevronDown size={12} class="chev" />
            </button>
            <Popover open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="start" width={380} maxHeight={420}>
                <div role="dialog" aria-label="Choose a commit" onKeyDown={onKey}>
                    <div class="mp-search">
                        <Search size={14} />
                        <input ref={input} value={q()} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search commits…" aria-label="Search commits" spellcheck={false} />
                    </div>
                    <div class="base-list rv-commits" ref={list} role="listbox" aria-label="Commits">
                        <Show when={!log.loading} fallback={<div class="menu-note">Loading commits…</div>}>
                            <For each={rows()} fallback={<div class="menu-note">{log()?.error ?? (log()?.commits.length ? "No commits match." : "No commits yet.")}</div>}>
                                {(c, i) => (
                                    <button class={`menu-item compact rv-commit ${i() === sel() ? "sel" : ""}`} role="option" aria-selected={c.sha === p.value?.sha} title={`${c.subject}\n${c.author} · ${new Date(c.time).toLocaleString()}${c.parents > 1 ? "\nMerge: shown against its first parent" : ""}`} onMouseMove={() => setSel(i())} onClick={() => choose(c)}>
                                        <span class="mono sha">{c.sha.slice(0, 7)}</span>
                                        <span class="menu-item-name truncate grow">{c.subject}</span>
                                        <span class="menu-item-sub when">{since(c.time) === "now" ? "now" : since(c.time)}</span>
                                        <Show when={c.sha === p.value?.sha}>
                                            <Check size={14} class="menu-check" />
                                        </Show>
                                    </button>
                                )}
                            </For>
                            <Show when={log()?.more && !q()}>
                                <div class="menu-note">The last {log()!.commits.length} commits</div>
                            </Show>
                        </Show>
                    </div>
                </div>
            </Popover>
        </>
    );
}
