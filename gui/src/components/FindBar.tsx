import { createEffect, createMemo, createSignal, on, onCleanup, onMount, Show, untrack } from "solid-js";
import { ChevronDown, ChevronUp, Search, X } from "lucide-solid";
import type { Turn } from "@shared/protocol";
import { clearPaint, findMatches, MAX_MATCHES, paintMatches, revealInBoxes, textRanges, type FindMatch } from "../lib/find";
import { findFocus, findQuery, setFindOpen, setFindQuery, setFindReveal } from "../state/ui";

/** The top of the view the bar covers (prompts sit on the right, under it). */
export const BAR_ROOM = 60;

/** Where a jump from ⌘K landed: the match shown first is in this turn. */
export interface FindAnchor {
    turnId: string;
    role: "user" | "assistant";
}

/** Find in the conversation: "3 of 12", Enter / Shift+Enter to step, Esc to close. */
export function FindBar(p: {
    turns: () => readonly Turn[];
    scroller: () => HTMLElement | undefined;
    col: () => HTMLElement | undefined;
    /** Draws the turn (its page) and stops following the end. */
    show: (turnId: string) => void;
    anchor: () => FindAnchor | undefined;
    clearAnchor: () => void;
    /** Commit an explicit scroll before ResizeObserver can restore the old reading anchor. */
    onNavigate?: () => void;
}) {
    let input: HTMLInputElement | undefined;
    const [text, setText] = createSignal(findQuery());
    const [cur, setCur] = createSignal(-1);
    let typing: ReturnType<typeof setTimeout> | undefined;
    let current: Range | undefined;
    let shownMatch: FindMatch | undefined;

    // What can change under an open bar: the number of turns, and the turn being written.
    // Counted again a moment after it does, not on every streamed token.
    const [edits, setEdits] = createSignal(0);
    let recount: ReturnType<typeof setTimeout> | undefined;
    createEffect(
        on(
            () => {
                const t = p.turns();
                const last = t[t.length - 1];
                let n = 0;
                for (const b of last?.blocks ?? []) n += b.t === "text" || b.t === "notice" ? b.text.length : b.t === "tool" ? b.title.length + (b.summary?.length ?? 0) + b.status.length : b.t === "shell" ? b.command.length + b.output.length : b.t === "compact" ? b.summary.length : 1;
                return `${t.length}:${last?.id}:${last?.blocks.length}:${n}`;
            },
            () => {
                // At most every 300 ms while it streams (a pending recount isn't put off again).
                recount ??= setTimeout(() => {
                    recount = undefined;
                    setEdits((e) => e + 1);
                }, 300);
            },
            { defer: true },
        ),
    );
    const matches = createMemo(() => {
        const q = findQuery();
        edits();
        return untrack(() => findMatches(p.turns(), q));
    });

    const onInput = (v: string) => {
        setText(v);
        clearTimeout(typing);
        typing = setTimeout(() => setFindQuery(v), 120);
    };
    // Set from outside (a jump from ⌘K).
    createEffect(on(findQuery, (q) => q !== untrack(text) && setText(q), { defer: true }));
    createEffect(on(findFocus, () => requestAnimationFrame(() => (input?.focus(), input?.select()))));

    const repaint = () => {
        const col = p.col();
        if (!col || !findQuery()) return clearPaint();
        paintMatches(textRanges(col, findQuery()), current);
    };

    /** The match on the page, scrolled to when it's out of sight. */
    const focusMatch = (m: FindMatch, scroll: boolean) => {
        const col = p.col();
        const scroller = p.scroller();
        if (!col || !scroller) return;
        const turn = col.querySelector(`[data-turn="${CSS.escape(m.turnId)}"]`);
        const el = turn?.querySelector(`[data-find="${CSS.escape(m.part)}"]`) ?? turn;
        if (!el) return;
        const ranges = textRanges(el, findQuery());
        current = ranges[Math.min(m.n, ranges.length - 1)];
        repaint();
        if (!scroll) return;
        // Inside a box that scrolls on its own first, then the transcript.
        if (current) revealInBoxes(current, scroller);
        const box = (current ?? el).getBoundingClientRect();
        const view = scroller.getBoundingClientRect();
        const dock = parseFloat(getComputedStyle(scroller).getPropertyValue("--dock-h")) || 0;
        // Below the bar, above the composer.
        if (box.top >= view.top + BAR_ROOM && box.bottom <= view.bottom - dock - 24) { p.onNavigate?.(); return; }
        // With its prompt when the turn fits that far, else a third of the way down.
        const top = turn?.getBoundingClientRect().top ?? box.top;
        scroller.scrollTop += box.bottom - top < view.height - dock - BAR_ROOM - 48 ? top - view.top - BAR_ROOM : box.top - view.top - (view.height - dock) / 3;
        p.onNavigate?.();
    };

    const go = (i: number) => {
        const ms = matches();
        if (!ms.length) {
            setCur(-1);
            current = shownMatch = undefined;
            setFindReveal(undefined);
            return repaint();
        }
        const k = (i + ms.length) % ms.length;
        const m = ms[k]!;
        setCur(k);
        shownMatch = m;
        setFindReveal({ turnId: m.turnId, part: m.part });
        p.show(m.turnId);
        // Once the page and the rows opened for it are drawn.
        requestAnimationFrame(() => requestAnimationFrame(() => shownMatch === m && focusMatch(m, true)));
    };

    /** The first match in or after the turn at the top of the view; the last one when all are above. */
    const fromView = (ms: FindMatch[]) => {
        const scroller = p.scroller();
        const col = p.col();
        if (!scroller || !col) return ms.length - 1;
        const top = scroller.getBoundingClientRect().top;
        const first = [...col.querySelectorAll<HTMLElement>("[data-turn]")].find((a) => a.getBoundingClientRect().bottom > top + BAR_ROOM);
        const order = new Map(p.turns().map((t, i) => [t.id, i]));
        const from = first ? (order.get(first.dataset.turn!) ?? 0) : p.turns().length;
        const k = ms.findIndex((m) => (order.get(m.turnId) ?? 0) >= from);
        return k >= 0 ? k : ms.length - 1;
    };

    /** A jump's turn: its match is the one shown (from the prompt or the reply, as the hit was). */
    const takeAnchor = (ms: FindMatch[]): boolean => {
        const a = untrack(p.anchor);
        if (!a) return false;
        p.clearAnchor();
        counted = untrack(findQuery);
        const inTurn = ms.filter((m) => m.turnId === a.turnId);
        const pick = inTurn.find((m) => (m.part === "prompt") === (a.role === "user")) ?? inTurn[0];
        if (!pick) return false;
        go(ms.indexOf(pick));
        return true;
    };

    let counted: string | undefined;
    // A jump while open, on what it was already finding.
    createEffect(on(p.anchor, (a) => a && takeAnchor(untrack(matches)), { defer: true }));
    createEffect(
        on(matches, (ms) => {
            const q = untrack(findQuery);
            const again = q === counted;
            counted = q;
            if (takeAnchor(ms)) return;
            if (!q) {
                setCur(-1);
                current = shownMatch = undefined;
                return clearPaint();
            }
            // Same query, a turn added: stay where it was.
            if (again && shownMatch) {
                const was = shownMatch;
                const k = ms.findIndex((m) => m.turnId === was.turnId && m.part === was.part && m.n === was.n);
                if (k >= 0) return void setCur(k);
            }
            go(fromView(ms));
        }),
    );

    // Streamed text, a row opened or a code block highlighted: the marks follow.
    onMount(() => {
        const col = p.col();
        if (!col) return;
        let t: ReturnType<typeof setTimeout> | undefined;
        const mo = new MutationObserver(() => {
            clearTimeout(t);
            t = setTimeout(() => (shownMatch ? focusMatch(shownMatch, false) : repaint()), 200);
        });
        mo.observe(col, { childList: true, subtree: true, characterData: true });
        onCleanup(() => (mo.disconnect(), clearTimeout(t)));
    });

    const close = () => setFindOpen(false);
    onCleanup(() => {
        clearTimeout(typing);
        clearTimeout(recount);
        clearPaint();
        setFindReveal(undefined);
    });

    const onKey = (e: KeyboardEvent) => {
        if (e.key === "Enter") {
            e.preventDefault();
            // Typed faster than the count: count now.
            if (text() !== findQuery()) {
                clearTimeout(typing);
                setFindQuery(text());
                return;
            }
            go(cur() + (e.shiftKey ? -1 : 1));
        }
    };
    // From the input or a button: closes the bar, and goes no further (the app's Esc interrupts).
    const onBarKey = (e: KeyboardEvent) => {
        if (e.key !== "Escape") return;
        e.preventDefault();
        e.stopPropagation();
        close();
    };

    const count = () => {
        const n = matches().length;
        if (!findQuery()) return "";
        if (!n) return "No matches";
        return `${cur() + 1} of ${n >= MAX_MATCHES ? `${MAX_MATCHES}+` : n}`;
    };

    return (
        <div class="find-bar" role="search" aria-label="Conversation" on:keydown={onBarKey}>
            <Search size={14} class="muted" />
            <input ref={input} value={text()} onInput={(e) => onInput(e.currentTarget.value)} on:keydown={onKey} placeholder="Find in conversation" spellcheck={false} aria-label="Find in conversation" />
            <span class="find-count num" role="status" aria-live="polite" aria-atomic="true">{count()}</span>
            <Show when={matches().length > 1}>
                <button class="icon-btn" title="Previous (Shift+Enter)" aria-label="Previous match" onClick={() => go(cur() - 1)}>
                    <ChevronUp size={14} />
                </button>
                <button class="icon-btn" title="Next (Enter)" aria-label="Next match" onClick={() => go(cur() + 1)}>
                    <ChevronDown size={14} />
                </button>
            </Show>
            <button class="icon-btn" title="Close (Esc)" aria-label="Close find" onClick={close}>
                <X size={14} />
            </button>
        </div>
    );
}
