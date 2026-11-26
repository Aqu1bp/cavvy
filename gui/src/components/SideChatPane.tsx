// The side panel's Side chat: questions about the session, answered without
// adding to it (src/agent/side-chat.ts). The conversation's own views in a
// narrower column: its turns (Transcript, read-only: no rewind or fork) and
// its composer, with the composer's model and mode menus for the side chat's
// own model and mode (the session's to start). It takes no commands or shell
// lines. With none open, the composer asks one. Bring back attaches its last
// answer, or what's selected in it, to the session's message as a chip.
// Closing it discards it, after a while in which Undo brings it back. Loaded
// when the tab is first shown.

import "../styles/side-chat.css";
import { CornerDownLeft, X } from "lucide-solid";
import { createEffect, createResource, createSignal, on, onCleanup, onMount, Show, type JSX } from "solid-js";
import { lastAnswer } from "../lib/side-chat";
import { columnSteps, PANE_NARROW } from "../lib/layout";
import { sideChatText, type Attachment } from "../lib/attachments";
import { awayMachine, openSession, reportError, rpcFor, toast, type SessionHandle } from "../state/app";
import { send } from "../state/actions";
import { askSideChat, setAskSideChat, setComposerAdd } from "../state/ui";
import { asideFocused, PaneContext, setAsideFocused, showAside } from "../state/split";
import type { Transcript } from "./Transcript";
import type { Composer } from "./Composer";

/**
 * The conversation's own views, handed in by the side panel (RightPanel.tsx) rather than imported here: imported by
 * this chunk, loaded later, they and what they use were split out of the startup chunk into chunks of their own, which
 * cost 2.4 KB more to load at startup.
 */
export interface ChatViews {
    Transcript: typeof Transcript;
    Composer: typeof Composer;
}

/** The keyboard and the composer's menus are the side chat's while a press or the focus is in it (state/split.ts asideFocused). */
const pane = { aside: true, focused: asideFocused, parked: () => false, split: () => false, rightmost: () => false, share: () => 1, wasFocused: asideFocused };

export default function SideChatPane(p: { handle: SessionHandle; views: ChatViews }) {
    const { Composer } = p.views;
    let root: HTMLDivElement | undefined;
    // Its own widths' steps, as a split's pane has (shell.css data-narrow): request cards and the composer's bar give way.
    const [narrow, setNarrow] = createSignal<string>();
    onMount(() => {
        if (!root) return;
        const ro = new ResizeObserver(() => setNarrow(columnSteps(root!.clientWidth, PANE_NARROW)));
        ro.observe(root);
        // A press or the focus somewhere else (not a menu it opened, which is in a portal) gives them back to the session.
        const where = (e: Event) => {
            const t = e.target;
            if (!(t instanceof Node)) return;
            if (root!.contains(t)) setAsideFocused(true);
            else if (!(t instanceof Element && t.closest(".popover"))) setAsideFocused(false);
        };
        document.addEventListener("pointerdown", where, true);
        document.addEventListener("focusin", where, true);
        onCleanup(() => {
            ro.disconnect();
            document.removeEventListener("pointerdown", where, true);
            document.removeEventListener("focusin", where, true);
            setAsideFocused(false);
        });
    });
    // Asked for with none open yet (a bare /btw): the empty tab's box takes the keyboard, for the question. The ask stays
    // until the side chat is shown (Chat), which takes it then.
    createEffect(
        on(askSideChat, (id) => {
            if (id === p.handle.id && !p.handle.view.state.sideChat) requestAnimationFrame(() => root?.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
        }),
    );
    /** With none open: the question opens one, and goes to it with what's attached. */
    const open = async (text: string, attachments: Attachment[]) => {
        // Asked from here: the side chat's own box keeps the keyboard once it's shown.
        setAskSideChat(p.handle.id);
        try {
            const { id } = await rpcFor(p.handle.id).call("session.sideChat", { id: p.handle.id });
            return Boolean(await send(text, attachments, { to: { id }, literal: true }));
        } catch (e) {
            reportError(e);
            return false;
        }
    };
    return (
        <PaneContext.Provider value={pane}>
            <div ref={root} class="side-chat stage-pane" data-narrow={narrow()}>
                {/* Another machine's session: its side chat is there, as its browser is. */}
                <Show
                    when={awayMachine(p.handle.id) === undefined}
                    fallback={
                        <>
                            <Head />
                            <div class="none sc-none">Its side chat is on {awayMachine(p.handle.id) || "this computer"}.</div>
                        </>
                    }
                >
                    <Show
                        when={p.handle.view.state.sideChat?.id}
                        keyed
                        fallback={
                            <>
                                <Head />
                                <div class="none sc-none">Ask about this session without adding to it.</div>
                                <div class="sc-body">
                                    <div class="stage">
                                        <Dock>
                                            <Composer aside={{ of: p.handle.id, open }} placeholder="Ask about this session" />
                                        </Dock>
                                    </div>
                                </div>
                            </>
                        }
                    >
                        {(id) => <Chat parent={p.handle} id={id} views={p.views} />}
                    </Show>
                </Show>
            </div>
        </PaneContext.Provider>
    );
}

/** The pane's title line, as the panel's other views have, and what it can do. */
function Head(p: { children?: JSX.Element }) {
    return (
        <div class="insp-t sc-head">
            <h2>Side chat</h2>
            <span class="grow" />
            {p.children}
        </div>
    );
}

/** The composer at the foot of the column, as the conversation's (stage.css). */
function Dock(p: { ref?: (el: HTMLDivElement) => void; children: JSX.Element }) {
    return (
        <div class="composer-dock" ref={p.ref}>
            <div class="composer-col">{p.children}</div>
        </div>
    );
}

function Chat(p: { parent: SessionHandle; id: string; views: ChatViews }) {
    const { Transcript, Composer } = p.views;
    const [h] = createResource(() => p.id, (id) => openSession(id).catch((e) => (reportError(e), undefined)));
    showAside(p.id);
    onCleanup(() => showAside(undefined));
    let stage: HTMLDivElement | undefined;
    // The conversation scrolls under the composer and keeps that much room at its end (Panes.tsx SessionView).
    const [dockH, setDockH] = createSignal<number>();
    const observeDock = (el: HTMLDivElement) => {
        const ro = new ResizeObserver(() => setDockH(el.offsetHeight));
        ro.observe(el);
        onCleanup(() => ro.disconnect());
    };
    // Just asked for (/btw, or from the empty tab): its box takes the keyboard, once. Not when the session is opened with
    // a side chat already there: the keyboard stays in the session's box.
    createEffect(
        on([() => Boolean(h()), askSideChat], ([shown, asked]) => {
            if (!shown || asked !== p.parent.id) return;
            setAskSideChat(undefined);
            requestAnimationFrame(() => stage?.querySelector<HTMLTextAreaElement>(".composer textarea")?.focus());
        }),
    );

    /** Closed at once; Undo brings it back as it was, for a while (the server keeps it: Engine.closeSideChat). */
    const close = () => {
        const rpc = rpcFor(p.parent.id);
        const id = p.parent.id;
        void rpc.call("session.closeSideChat", { id }).then(
            () => toast("Side chat closed", "info", { label: "Undo", run: () => rpc.call("session.reopenSideChat", { id }).then(() => undefined, reportError) }),
            reportError,
        );
    };
    const answer = () => lastAnswer(h()?.view.turns ?? []);
    /** What's selected in its conversation, else its last answer, attached to the session's message. */
    const bringBack = () => {
        const sel = window.getSelection();
        const picked = sel && !sel.isCollapsed && stage?.querySelector(".transcript")?.contains(sel.anchorNode) ? sel.toString() : "";
        const text = picked.trim() || answer();
        if (!text?.trim()) return;
        setComposerAdd({ sessionId: p.parent.id, attach: (list) => sideChatText(text, list) });
    };

    return (
        <>
            <Head>
                <button class="btn secondary sm sc-back" title="Attach the last answer, or what's selected, to your message" aria-label="Bring back" disabled={!answer()} onMouseDown={(e) => e.preventDefault()} onClick={bringBack}>
                    <CornerDownLeft size={13} />
                    <span class="sc-back-l">Bring back</span>
                </button>
                <button class="hb" title="Close side chat" aria-label="Close side chat" onClick={close}>
                    <X size={15} />
                </button>
            </Head>
            <div class="sc-body">
                <Show when={h()}>
                    {(handle) => (
                        <div class="stage" ref={stage}>
                            <Transcript handle={handle()} dock={dockH()} aside />
                            <Dock ref={observeDock}>
                                <Composer sessionId={p.id} aside={{ of: p.parent.id }} placeholder="Ask a follow-up" />
                            </Dock>
                        </div>
                    )}
                </Show>
            </div>
        </>
    );
}
