// The branch the review pane's Branch view compares with: a short,
// searchable list of local and remote branches, most recently changed first.

import { createEffect, createMemo, createSignal, For, on, Show } from "solid-js";
import { Check, ChevronDown, Search } from "lucide-solid";
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
            <button ref={anchor} class="strip-ctl base-ctl mono" title="Compare with another branch" aria-haspopup="dialog" aria-expanded={open()} onClick={() => setOpen(!open())}>
                <span class="truncate">{p.value ?? "Pick a base"}</span>
                <ChevronDown size={12} class="chv" />
            </button>
            <Popover open={open()} anchor={() => anchor} onClose={() => setOpen(false)} placement="bottom" align="end" width={300} maxHeight={360}>
                <div role="dialog" aria-label="Choose a base branch" onKeyDown={onKey}>
                    <div class="mp-search">
                        <Search size={14} />
                        <input ref={input} value={q()} onInput={(e) => setQ(e.currentTarget.value)} placeholder="Search branches…" aria-label="Search branches" spellcheck={false} />
                    </div>
                    <div class="base-list" ref={list} role="listbox" aria-label="Branches">
                        <For each={rows()} fallback={<div class="menu-note">{p.bases.length ? "No branches match." : "No other branches."}</div>}>
                            {(b, i) => (
                                <button class={`menu-item compact ${i() === sel() ? "sel" : ""}`} role="option" aria-selected={isCurrent(b)} onMouseMove={() => setSel(i())} onClick={() => choose(b)}>
                                    <span class="menu-label mono truncate grow">{b.name}</span>
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
