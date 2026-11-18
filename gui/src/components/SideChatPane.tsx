// The side panel's Side chat: questions about the session, answered without
// adding to it (src/agent/side-chat.ts). With none open, a field to ask one;
// open, its turns, what it asks for, and a field to go on. Its model and mode
// are its own (read-only to start). Bring back quotes its last answer, or what's
// selected in it, into the session's message box. Closing it discards it.
// Loaded when the tab is first shown.

import "../styles/side-chat.css";
import { ArrowUp, CornerDownLeft, Square, X } from "lucide-solid";
import { MODE_LABELS, type PermissionModeId, type SessionState, type Turn } from "@shared/protocol";
import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { awayMachine, modelsFor, openSession, reportError, rpcFor, type SessionHandle } from "../state/app";
import { PaneContext } from "../state/split";
import { InteractionTab } from "./InteractionDock";
import { Markdown } from "./blocks/Markdown";
import { LiveLine } from "./LiveLine";
import { liveLine } from "../lib/live-line";
import { MODES } from "./ModePicker";

/** Quoted, a line at a time, for the message box: what it's about, not what's asked. */
export function quoted(text: string): string {
    return `${text.trim().split("\n").map((l) => (l.trim() ? `> ${l}` : ">")).join("\n")}\n\n`;
}

/** The last thing the side chat said: its latest turn's last words. */
export function lastAnswer(turns: readonly Turn[]): string | undefined {
    for (let i = turns.length - 1; i >= 0; i--) {
        const blocks = turns[i]!.blocks;
        for (let j = blocks.length - 1; j >= 0; j--) {
            const b = blocks[j]!;
            if (b.t === "text" && b.text.trim()) return b.text;
        }
    }
    return undefined;
}

/**
 * A turn of the side chat, as it reads in a narrow column: the question, then what was said, each step of the work as
 * a line (its name and how it went), and while it runs what it's doing.
 */
function SideTurn(p: { turn: Turn; state: SessionState; last: boolean }) {
    const live = () => p.last && p.state.busy && p.turn.status === "running";
    return (
        <div class="sc-turn">
            <Show when={p.turn.prompt?.text}>
                <div class="sc-q selectable">{p.turn.prompt!.text}</div>
            </Show>
            <div class="sc-a selectable">
                <For each={p.turn.blocks}>
                    {(b) =>
                        b.t === "text" ? (
                            <Markdown text={b.text} streaming={live()} sessionId={p.state.id} />
                        ) : b.t === "tool" ? (
                            <div class={`sc-step ${b.status === "error" ? "bad" : ""}`}>
                                <span class="truncate">{b.title}</span>
                                <Show when={b.summary}>
                                    <span class="sc-sum truncate">{b.summary}</span>
                                </Show>
                            </div>
                        ) : b.t === "notice" ? (
                            <div class={`sc-step ${b.level === "error" ? "bad" : ""}`}>{b.text}</div>
                        ) : null
                    }
                </For>
                <Show when={live()}>
                    <LiveLine state={liveLine({ blocks: p.turn.blocks, activity: p.state.activity, interactions: p.state.interactions, showThinking: false })} />
                </Show>
            </div>
        </div>
    );
}

/** A field that sends on Enter (Shift+Enter for a new line). */
function Ask(p: { placeholder: string; busy?: boolean; onSend: (text: string) => Promise<boolean>; onStop?: () => void; autofocus?: boolean }) {
    const [text, setText] = createSignal("");
    const [sending, setSending] = createSignal(false);
    let ta: HTMLTextAreaElement | undefined;
    const send = async () => {
        const t = text().trim();
        if (!t || sending()) return;
        setSending(true);
        if (await p.onSend(t)) setText("");
        setSending(false);
        ta?.focus();
    };
    if (p.autofocus) requestAnimationFrame(() => ta?.focus());
    return (
        <div class="sc-ask">
            <textarea
                ref={ta}
                rows={2}
                value={text()}
                placeholder={p.placeholder}
                aria-label={p.placeholder}
                onInput={(e) => setText(e.currentTarget.value)}
                onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
                        e.preventDefault();
                        void send();
                    }
                }}
            />
            <Show
                when={p.busy && !text().trim()}
                fallback={
                    <button class="sc-send" title="Send" aria-label="Send" disabled={!text().trim() || sending()} onClick={() => void send()}>
                        <ArrowUp size={15} />
                    </button>
                }
            >
                <button class="sc-send stop" title="Stop" aria-label="Stop" onClick={() => p.onStop?.()}>
                    <Square size={11} fill="currentColor" />
                </button>
            </Show>
        </div>
    );
}

export default function SideChatPane(p: { handle: SessionHandle }) {
    const parent = () => p.handle;
    const rpc = () => rpcFor(parent().id);
    /** Asked in the parent: it opens the side chat with the question. */
    const start = async (text: string) => {
        try {
            await rpc().call("session.sideChat", { id: parent().id, text });
            return true;
        } catch (e) {
            reportError(e);
            return false;
        }
    };
    return (
        <div class="side-chat">
            {/* Another machine's session: its side chat is there, as its browser is. */}
            <Show when={awayMachine(parent().id) === undefined} fallback={<p class="sc-hint">This session runs on {awayMachine(parent().id) || "this computer"}. Its side chat is in a window there.</p>}>
            <Show
                when={parent().view.state.sideChat?.id}
                keyed
                fallback={
                    <div class="sc-start">
                        <div class="sc-head">
                            <h2>Side chat</h2>
                        </div>
                        <p class="sc-hint">Ask about this session. Nothing here is added to it.</p>
                        <Ask placeholder="Ask about this session" onSend={start} autofocus />
                    </div>
                }
            >
                {(id) => <Chat parent={parent()} id={id} />}
            </Show>
            </Show>
        </div>
    );
}

function Chat(p: { parent: SessionHandle; id: string }) {
    const [h] = createResource(() => p.id, (id) => openSession(id).catch((e) => (reportError(e), undefined)));
    const rpc = () => rpcFor(p.parent.id);
    const st = () => h()?.view.state;
    const turns = () => h()?.view.turns ?? [];
    let scroller: HTMLDivElement | undefined;
    let list: HTMLDivElement | undefined;
    // Keyboard and cards: this pane's own while the focus is in it, not the conversation's beside it.
    const [focused, setFocused] = createSignal(false);
    let root: HTMLDivElement | undefined;
    const pane = { focused, parked: () => false, split: () => false, rightmost: () => true, share: () => 1, wasFocused: focused };

    // Kept at its end while it was there: a new answer scrolls into view, unless the reader has scrolled up.
    let atEnd = true;
    const toEnd = () => scroller && (scroller.scrollTop = scroller.scrollHeight);
    createEffect(on(h, (handle) => {
        if (!handle || !list || typeof ResizeObserver === "undefined") return;
        const ro = new ResizeObserver(() => atEnd && toEnd());
        ro.observe(list);
        onCleanup(() => ro.disconnect());
        requestAnimationFrame(toEnd);
    }));

    const send = async (text: string) => {
        try {
            await rpc().call("session.send", { id: p.id, text });
            atEnd = true;
            requestAnimationFrame(toEnd);
            return true;
        } catch (e) {
            reportError(e);
            return false;
        }
    };
    const close = () => void rpc().call("session.closeSideChat", { id: p.parent.id }).catch(reportError);
    /** What's selected in the side chat's answers, else its last answer, quoted into the session's message box. */
    const bringBack = () => {
        const sel = window.getSelection();
        const picked = sel && !sel.isCollapsed && list?.contains(sel.anchorNode) ? sel.toString() : "";
        const text = picked.trim() || lastAnswer(turns());
        if (!text) return;
        p.parent.addDraft({ text: quoted(text), after: true });
    };
    const setMode = (mode: PermissionModeId) => void rpc().call("session.setMode", { id: p.id, mode }).catch(reportError);
    const setModel = (ref: string) => void rpc().call("session.setModel", { id: p.id, ref, persist: false }).catch(reportError);

    return (
        <PaneContext.Provider value={pane}>
            <div ref={root} class="sc-chat" onFocusIn={() => setFocused(true)} onFocusOut={(e) => !root?.contains(e.relatedTarget as Node | null) && setFocused(false)}>
                <div class="sc-head">
                    <h2>Side chat</h2>
                    <span class="grow" />
                    <button class="btn secondary sm" title="Quote the last answer, or what's selected, in your message" disabled={!lastAnswer(turns())} onMouseDown={(e) => e.preventDefault()} onClick={bringBack}>
                        <CornerDownLeft size={13} /> Bring back
                    </button>
                    <button class="hb" title="Close side chat" aria-label="Close side chat" onClick={close}>
                        <X size={15} />
                    </button>
                </div>
                <div class="sc-turns" ref={scroller} onScroll={(e) => (atEnd = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 24)}>
                    <div ref={list} class="sc-list">
                        <Show when={h()}>
                            {(handle) => (
                                <For each={handle().view.turns}>
                                    {(t, i) => <SideTurn turn={t} state={handle().view.state} last={i() === handle().view.turns.length - 1} />}
                                </For>
                            )}
                        </Show>
                    </div>
                </div>
                <Show when={st()?.interactions.length}>
                    <InteractionTab sessionId={p.id} items={st()!.interactions} />
                </Show>
                <Ask placeholder="Ask a follow-up" busy={st()?.busy} onSend={send} onStop={() => void rpc().call("session.interrupt", { id: p.id }).catch(reportError)} autofocus />
                <div class="sc-bar">
                    <select class="sc-select" aria-label="Model" value={st()?.model?.ref ?? ""} disabled={st()?.busy} onChange={(e) => setModel(e.currentTarget.value)}>
                        <Show when={st()?.model && !modelsFor(p.parent.id).some((g) => g.models.some((m) => m.ref === st()!.model!.ref))}>
                            <option value={st()!.model!.ref}>{st()!.model!.name}</option>
                        </Show>
                        <For each={modelsFor(p.parent.id).filter((g) => g.models.length)}>
                            {(g) => (
                                <optgroup label={g.providerName}>
                                    <For each={g.models}>{(m) => <option value={m.ref}>{m.name}</option>}</For>
                                </optgroup>
                            )}
                        </For>
                    </select>
                    <select class="sc-select" aria-label="Permission mode" value={st()?.mode ?? "plan"} onChange={(e) => setMode(e.currentTarget.value as PermissionModeId)}>
                        <For each={MODES.filter((m) => m !== "bypassPermissions" || st()?.bypassAllowed)}>{(m) => <option value={m}>{MODE_LABELS[m].label}</option>}</For>
                    </select>
                </div>
            </div>
        </PaneContext.Provider>
    );
}
