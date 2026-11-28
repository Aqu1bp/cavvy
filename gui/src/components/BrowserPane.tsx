// The Browser tab of the side panel: the session's browser, watched and driven by hand. Chrome runs on the server
// (src/browser); the page arrives as frames drawn on a canvas, and clicks, keys and scrolls on the canvas go back to
// it. A person using the page takes the tab from the agent (until they hand it back). The page is sized to the pane.

import { batch, createEffect, createMemo, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ArrowLeft, ArrowRight, Check, Plus, RotateCw, X } from "lucide-solid";
import type { BrowserCommand, BrowserInput } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, awayMachine, connOn, reportError, rpcFor } from "../state/app";
import { adoptBrowserState, browserState, loadBrowserState, setBrowserShown, type BrowserFrame } from "../state/browser";
import { panelHold, settingsTab } from "../state/ui";
import { electron, machine } from "../lib/platform";
import type { Follow } from "../lib/follow-box";
import { addressOf, currentTab, isPasteKey, isReleaseKey, keyInput, mouseInput, pagePoint, paneSize, paneStatus, placeFrame, resized, tabLabel, wheelInput, wheelPixels, type Point, type Size } from "../lib/browser";
import type { BrowserImageFrame } from "@shared/browser-wire";
import { Kbd, Spinner } from "./ui/bits";
import { pageTarget, type PageView } from "../lib/browser-view";
import { paneTools, savedView } from "./BrowserTools";
import { hostedTargets } from "../state/browser-host";
import "../styles/browser-pane.css";

/**
 * In the Electron desktop app the page isn't pictures: the tab is a real Chromium view in the window, which the app
 * lays over the pane's page box (placed below), and the person uses it directly. The bar, tabs and notes stay here.
 */

/** The pane's size is sent this long after it stops changing (dragging the panel's edge resizes it every frame). */
const RESIZE_MS = 120;

function decode(data: string | Uint8Array<ArrayBuffer>): Promise<ImageBitmap> {
    const bytes = typeof data === "string" ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : data;
    return createImageBitmap(new Blob([bytes]));
}

/**
 * The pane of a session's browser. One on another machine than the window's (a server's, in a window on this computer)
 * is watched over that machine's connection (the panel is made again for each session: App).
 */
export function BrowserPane(p: { handle: SessionHandle }) {
    const id = () => p.handle.id;
    const its = awayMachine(p.handle.id);
    // The desktop app shows this computer's pages in views of its own; a server's are pictures sent from there, as in a browser.
    const native = electron !== undefined && !machine && its === undefined;
    const stream = rpcFor(p.handle.id).browserStream();
    const [connected, setConnected] = createSignal(stream.state === "open");
    const state = () => browserState(id());
    const tab = () => currentTab(state());
    const status = () => paneStatus(state());
    /** The agent drove the tab last and its turn is still going: what's said beside the tabs. */
    const agentUsing = createMemo(() => status() === "agent" && app.sessions.find((s) => s.id === id())?.status === "running");
    let box: HTMLDivElement | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let address: HTMLInputElement | undefined;
    let keyboard: HTMLTextAreaElement | undefined;
    let disposed = false;
    let generation = 0;
    let composing = false;
    let compositionTab: number | undefined;
    let dragEnd: (() => void) | undefined;
    const heldKeys = new Map<string, BrowserInput>();
    let inputTab: number | undefined;
    /** The frame drawn, with the page's size it shows. */
    let bitmap: ImageBitmap | undefined;
    let frame: Size | undefined;
    let sized: Size | undefined;
    const [draft, setDraft] = createSignal<string>();
    const [hasPicture, setHasPicture] = createSignal(false);
    const [dialogText, setDialogText] = createSignal("");
    const [visible, setVisible] = createSignal(document.visibilityState === "visible");
    /** A device size or zoom picked in the pane's menu (BrowserTools.tsx); none: the page fills the pane. */
    const [view, setView] = createSignal<PageView | undefined>(savedView(id()));
    let root: HTMLDivElement | undefined;

    // -----------------------------------------------------------------------
    // The page's picture

    const boxSize = (): Size => ({ width: box?.clientWidth ?? 0, height: box?.clientHeight ?? 0 });
    /** The box's size as last seen, for what the strip says of it (BrowserTools.tsx). */
    const [paneBox, setPaneBox] = createSignal<Size>({ width: 0, height: 0 });
    /** Where a frame is drawn: a device's page no larger than it is (at its zoom). */
    const placed = (f: Size) => placeFrame(boxSize(), f, view()?.device ? view()!.zoom : undefined);

    const draw = () => {
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!bitmap || !frame) return;
        const at = placed(frame);
        ctx.drawImage(bitmap, at.x, at.y, at.width, at.height);
    };

    const fit = () => {
        if (!canvas) return;
        const { width, height } = boxSize();
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        draw();
    };

    type Picture = BrowserFrame | BrowserImageFrame;
    let decoding = false;
    let waiting: { picture: Picture; epoch: number } | undefined;
    const paint = async (f: Picture, epoch: number) => {
        decoding = true;
        try {
            if (!disposed && epoch === generation && watching() && f.tab === tab()?.id) {
                const next = await decode(f.data);
                if (disposed || epoch !== generation || !watching() || f.tab !== tab()?.id) {
                    next.close();
                    return;
                }
                bitmap?.close();
                bitmap = next;
                setHasPicture(true);
                frame = { width: f.width, height: f.height };
                draw();
            }
        } catch {
            // An undecodable picture does not stall subsequent frames.
        } finally {
            decoding = false;
            const next = waiting;
            waiting = undefined;
            if (next && !disposed) void paint(next.picture, next.epoch);
        }
    };
    const onFrame = (f: Picture) => {
        // Receipt releases transport backpressure. Decoding has its own bounded, latest-frame queue.
        stream.notify("browser.ack", { id: f.sessionId, frameId: f.frameId });
        if (disposed || f.sessionId !== id()) return;
        if (decoding) waiting = { picture: f, epoch: generation };
        else void paint(f, generation);
    };

    // -----------------------------------------------------------------------
    // Watching: the server sizes the page to the pane and streams it while the pane shows.

    // Once the session is open on its machine again after a reconnect: watched before, it's refused there.
    const watching = () => visible() && !settingsTab() && connOn(its) === "open" && connected() && p.handle.ready();
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
        if (native) return;
        const size = paneSize(boxSize());
        if (size.width < 1 || size.height < 1) return;
        sized = size;
        void stream.call("browser.watch", { id: id(), ...pageTarget(size, window.devicePixelRatio || 1, view()) }).then((s) => adoptBrowserState(id(), s), reportError);
    };

    onMount(() => {
        const unframe = stream.onFrame(onFrame);
        const unevent = stream.onEvent(e => {
            if (e.type === "browser.frame") onFrame(e);
            else if (e.type === "browser.state" && e.sessionId === id()) adoptBrowserState(id(), e.state);
        });
        const unstate = stream.onState(s => setConnected(s === "open"));
        void stream.connect();
        setBrowserShown(id(), true);
        void loadBrowserState(id()).catch(() => undefined);
        const observer = new ResizeObserver(() => {
            fit();
            setPaneBox(boxSize());
            if (!watching()) return;
            clearTimeout(resizeTimer);
            resizeTimer = setTimeout(() => resized(sized, paneSize(boxSize())) && watch(), RESIZE_MS);
        });
        observer.observe(box!);
        const seen = () => setVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", seen);
        window.addEventListener("blur", cancelInput);
        fit();
        stop = () => {
            unframe();
            unevent();
            unstate();
            observer.disconnect();
            document.removeEventListener("visibilitychange", seen);
            window.removeEventListener("blur", cancelInput);
        };
    });
    let stop = () => {};
    onCleanup(() => {
        cancelInput();
        disposed = true;
        generation++;
        stop();
        clearTimeout(resizeTimer);
        cancelAnimationFrame(moving);
        setBrowserShown(id(), false);
        void stream.call("browser.unwatch", { id: id() }).catch(() => undefined);
        stream.close();
        waiting = undefined;
        bitmap?.close();
        bitmap = undefined;
    });

    // Watched again after a reconnect (the server lets go of a window that went away), and not while hidden or covered.
    createEffect(
        on(watching, (on) => {
            if (native) return;
            if (on) {
                sized = undefined;
                watch();
            } else {
                generation++;
                cancelInput();
                void stream.call("browser.unwatch", { id: id() }).catch(() => undefined);
            }
        }),
    );

    // Another size or zoom from the menu: the page is asked for it, and what's drawn is placed for it.
    createEffect(on(view, () => {
        draw();
        if (!native && watching()) watch();
    }, { defer: true }));

    // The tab's own page (BrowserHostLayer) is kept over the page box (lib/page-follow.ts, loaded here: only the
    // desktop app has such a page). What moves or hides it besides the box itself: a panel's slide beginning or
    // ending, another tab, the pane covered or uncovered.
    // `grow`: height a bar over the page is about to give back, which the page takes first (giveBack).
    const [grow, setGrow] = createSignal(0);
    let follow: Follow | undefined;
    if (native) {
        onMount(() => {
            void import("../lib/page-follow").then((m) => {
                if (!disposed) follow = m.followPage(box!, () => (watching() ? tab()?.targetId : undefined), () => !!panelHold()?.slide, () => view()?.device, grow);
            }, reportError);
            createEffect(on([() => panelHold()?.slide, () => tab()?.targetId, watching, view, grow], () => follow?.kick()));
            onCleanup(() => follow?.stop());
        });
    }
    /**
     * A bar over the page (find) closes, giving back `px` of height: in the desktop app the page is given that height
     * first, under the bar, and the bar goes once it has drawn at it. Closed at once, the page drew at the new height a
     * moment after the box had it, and that strip of the box was blank meanwhile. `close` is the bar going.
     */
    let giving = 0;
    const giveBack = (px: number, close: () => void) => {
        const target = tab()?.targetId;
        const mine = ++giving;
        // A device's page keeps its size (drawn a little larger): nothing to wait for. Nor on a headless page's frames.
        if (!native || !target || !watching() || view()?.device || px <= 0) return close();
        setGrow(px);
        // The follow places it on the next frame, at that height; then it's drawn at it.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            void import("../lib/page-painted").then((m) => m.pagePainted(target)).finally(() => {
                if (mine !== giving || disposed) return;
                follow?.kick();
                batch(() => {
                    close();
                    setGrow(0);
                });
            });
        }));
    };

    const tools = paneTools({ id, native, tab, view, setView, box: paneBox, giveBack, root: () => root, address: () => address, keyboard: () => keyboard, status, reload: () => command("reload", { tab: tab()?.id }), dropDraft: () => setDraft(undefined) });

    // The tab changed: what was drawn belongs to the one before. Its id alone, kept: `on` runs again whenever what it
    // read changes, and finding the tab reads the whole list, so another tab opening or closing would clear this one's
    // picture, which an idle page doesn't send again.
    const shownTab = createMemo(() => tab()?.id);
    createEffect(
        on(
            shownTab,
            () => {
                generation++;
                cancelInput();
                bitmap?.close();
                bitmap = undefined;
                frame = undefined;
                setHasPicture(false);
                draw();
            },
            { defer: true },
        ),
    );

    // -----------------------------------------------------------------------
    // The person's input

    const sendTo = (target: number | undefined, input: BrowserInput) => {
        if (disposed || target === undefined) return;
        stream.notify("browser.input", { id: id(), tab: target, input });
    };
    const send = (input: BrowserInput) => sendTo(tab()?.id, input);
    const cancelInput = () => {
        dragEnd?.();
        dragEnd = undefined;
        for (const input of heldKeys.values()) sendTo(inputTab, input);
        heldKeys.clear();
        cancelAnimationFrame(moving);
        moving = 0;
        move = undefined;
        composing = false;
        if (keyboard) keyboard.value = "";
    };
    const pointOf = (e: MouseEvent): Point | undefined => {
        const rect = canvas!.getBoundingClientRect();
        return frame ? pagePoint({ x: e.clientX - rect.left, y: e.clientY - rect.top }, placed(frame), frame) : undefined;
    };

    // Pointer moves come faster than frames: the latest goes once a frame.
    let moving = 0;
    let move: BrowserInput | undefined;
    const flush = () => {
        moving = 0;
        if (move) send(move);
        move = undefined;
    };
    const later = () => (moving ||= requestAnimationFrame(flush));

    const onMouseDown = (e: MouseEvent) => {
        keyboard!.focus({ preventScroll: true });
        const at = pointOf(e);
        if (!at) return;
        e.preventDefault();
        flush();
        dragEnd?.();
        const target = tab()?.id;
        sendTo(target, mouseInput("down", at, e));
        // A drag that leaves the canvas still ends where it's released.
        const up = (u: MouseEvent) => {
            window.removeEventListener("mouseup", up);
            const to = pointOf(u);
            dragEnd = undefined;
            sendTo(target, mouseInput("up", to ?? at, u));
        };
        window.addEventListener("mouseup", up);
        dragEnd = () => {
            window.removeEventListener("mouseup", up);
            sendTo(target, mouseInput("up", at, { ...e, button: e.button, detail: e.detail, buttons: 0, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }));
        };
    };
    const onMouseMove = (e: MouseEvent) => {
        const at = pointOf(e);
        if (!at) return;
        move = mouseInput("move", at, e);
        later();
    };
    const onWheel = (e: WheelEvent) => {
        const at = pointOf(e);
        if (!at || !frame) return;
        e.preventDefault();
        // At once, not on the next frame: a wheel turn's latency is what scrolling feels like, and Chrome merges turns
        // the page hasn't taken yet itself.
        if (move) flush();
        send(wheelInput(at, wheelPixels(e, frame.height), e));
    };
    const onKey = (type: "down" | "up") => (e: KeyboardEvent) => {
        // The one key that isn't the page's: it gives the keyboard back to the window.
        if (isReleaseKey(e)) {
            e.preventDefault();
            e.stopPropagation();
            if (type === "down") address?.focus();
            return;
        }
        // Pasting arrives as a paste event, with the text.
        if (isPasteKey(e)) { e.stopPropagation(); return; }
        if (composing || e.isComposing || e.key === "Dead" || e.key === "Process") {
            e.stopPropagation();
            return;
        }
        const input = keyInput(type, e);
        if (!input) return;
        e.preventDefault();
        e.stopPropagation();
        if (type === "down") {
            inputTab = tab()?.id;
            heldKeys.set(e.code, { ...input, type: "up" } as BrowserInput);
        } else heldKeys.delete(e.code);
        send(input);
    };
    const onPaste = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        send({ kind: "text", text });
    };

    // -----------------------------------------------------------------------
    // The address bar and the tabs

    const call = (c: BrowserCommand, extra: { url?: string; tab?: number } = {}) => stream.call("browser.command", { id: id(), command: c, ...extra }).then((s) => adoptBrowserState(id(), s), reportError);
    const command = (c: BrowserCommand, extra: { url?: string; tab?: number } = {}) => void call(c, extra);
    /** A new tab, the address bar ready for where it goes (as a browser's own new tab is). */
    const newTab = () => {
        address?.focus();
        void call("new_tab").then(() => requestAnimationFrame(() => address?.focus()));
    };
    /** The desktop app's own view of the current tab's page (BrowserHostLayer). */
    const pageView = () => {
        const target = tab()?.targetId;
        const key = target ? Object.entries(hostedTargets()).find(([, t]) => t === target)?.[0] : undefined;
        return (key ? document.querySelector<HTMLElement>(`webview[data-key="${key}"]`) : null) ?? undefined;
    };
    const go = (e: SubmitEvent) => {
        e.preventDefault();
        const url = draft();
        setDraft(undefined);
        if (url?.trim()) command("goto", { url, tab: tab()?.id });
        // The keyboard to the page, as a browser's address bar gives it: in the desktop app that's the page's own view.
        if (native) pageView()?.focus();
        else keyboard?.focus({ preventScroll: true });
    };
    // `list`: the list the person picked in, as this pane had it (another may have been opened since, from elsewhere).
    const choose = (list: number, index?: number) => void stream.call("browser.choose", { id: id(), index, tab: tab()?.id, list }).catch(reportError);
    const answer = (accept: boolean) => {
        const text = dialogText();
        setDialogText("");
        void stream.call("browser.dialog", { id: id(), accept, ...(tab()?.dialog?.type === "prompt" ? { text } : {}), tab: tab()?.id }).catch(reportError);
    };

    /** The page has the keyboard (its input field has the focus): said on its edge, with the key that gives it back. */
    const [driving, setDriving] = createSignal(false);
    const host = () => {
        try {
            return new URL(tab()?.url ?? "").host || addressOf(tab()?.url ?? "");
        } catch {
            return addressOf(tab()?.url ?? "");
        }
    };
    /** What the page asks shows over its foot, with the first answer ready for the keyboard. */
    const ready = (el: HTMLElement) => requestAnimationFrame(() => el.isConnected && el.focus({ preventScroll: true }));

    return (
        <div class="br" ref={root}>
            <div class="br-tabs" role="tablist" aria-label="Browser tabs">
                <For each={state()?.tabs}>
                    {(t) => (
                        <div class="br-tab" data-on={t.id === state()?.active || undefined}>
                            <button role="tab" aria-selected={t.id === state()?.active} class="br-tab-main" title={t.url || undefined} onClick={() => t.id !== state()?.active && command("switch_tab", { tab: t.id })}>
                                <Show when={agentUsing() && t.id === state()?.active}>
                                    <span class="br-live on" role="img" aria-label="Agent is using this tab" />
                                </Show>
                                <span class="br-tab-title">{tabLabel(t)}</span>
                            </button>
                            <button class="br-tab-x" aria-label={`Close ${tabLabel(t)}`} title="Close tab" onClick={() => command("close_tab", { tab: t.id })}>
                                <X size={12} />
                            </button>
                        </div>
                    )}
                </For>
                <button class="icon-btn icon-btn-sm" aria-label="New tab" title="New tab" disabled={status() === "unavailable"} onClick={newTab}>
                    <Plus size={14} />
                </button>
            </div>
            <div class="br-bar">
                <button class="icon-btn icon-btn-sm" aria-label="Back" title="Back" disabled={!tab()?.canGoBack} onClick={() => command("back", { tab: tab()?.id })}>
                    <ArrowLeft size={15} />
                </button>
                <button class="icon-btn icon-btn-sm" aria-label="Forward" title="Forward" disabled={!tab()?.canGoForward} onClick={() => command("forward", { tab: tab()?.id })}>
                    <ArrowRight size={15} />
                </button>
                <button class="icon-btn icon-btn-sm" aria-label="Reload" title="Reload" disabled={!tab()} onClick={() => command("reload", { tab: tab()?.id })}>
                    <Show when={tab()?.loading} fallback={<RotateCw size={14} />}>
                        <Spinner size={14} />
                    </Show>
                </button>
                <form class="br-addr" onSubmit={go}>
                    <input
                        ref={address}
                        type="text"
                        inputMode="url"
                        spellcheck={false}
                        autocomplete="off"
                        autocapitalize="off"
                        aria-label="Address"
                        placeholder="Enter an address, like localhost:3000"
                        value={draft() ?? addressOf(tab()?.url ?? "")}
                        disabled={status() === "unavailable"}
                        onFocus={(e) => e.currentTarget.select()}
                        onInput={(e) => setDraft(e.currentTarget.value)}
                        // Left, what was typed goes; to Find in page (Ctrl+F) it stays, and the keyboard comes back to it.
                        onBlur={(e) => tools.keepsDraft(e.relatedTarget) || setDraft(undefined)}
                        onKeyDown={(e) => {
                            if (e.key !== "Escape") return;
                            e.stopPropagation();
                            setDraft(undefined);
                            e.currentTarget.blur();
                        }}
                    />
                    <Show when={driving()}>
                        <Kbd keys="⇧+Esc" />
                    </Show>
                </form>
                {tools.menu()}
            </div>
            <Show when={agentUsing()}>
                <div class="br-who" role="status" title="The agent is using this tab. You can too.">
                    <span class="br-live on" />
                    Agent is using this tab
                </div>
            </Show>
            {tools.bars()}
            <div class="br-view" ref={box} data-device={view()?.device ? "" : undefined} data-wait={!native && tab() ? (!hasPicture() ? "load" : !connected() ? "reconnect" : undefined) : undefined}>
                <Show when={!native}>
                    <canvas
                        ref={canvas}
                        class="br-canvas"
                        tabindex="0"
                        aria-label="Browser page. Click to use it with your mouse and keyboard; Shift+Escape returns to the address bar."
                        onMouseDown={onMouseDown}
                        onMouseMove={onMouseMove}
                        onWheel={onWheel}
                        onFocus={() => keyboard?.focus({ preventScroll: true })}
                        onContextMenu={(e) => e.preventDefault()}
                    />
                    <textarea
                        ref={keyboard}
                        class="br-keyboard"
                        aria-label="Browser keyboard input"
                        autocomplete="off"
                        autocapitalize="off"
                        spellcheck={false}
                        onKeyDown={onKey("down")}
                        onKeyUp={onKey("up")}
                        onPaste={onPaste}
                        onFocus={() => setDriving(true)}
                        onBlur={() => (setDriving(false), cancelInput())}
                        onCompositionStart={() => { composing = true; compositionTab = tab()?.id; }}
                        onCompositionEnd={(e) => {
                            const commit = composing && compositionTab === tab()?.id;
                            composing = false;
                            if (commit && e.data) sendTo(compositionTab, { kind: "text", text: e.data });
                            e.currentTarget.value = "";
                        }}
                        onInput={(e) => {
                            // Dead-key and mobile text entry may arrive without composition events.
                            if (composing || e.isComposing) return;
                            if (e.currentTarget.value) send({ kind: "text", text: e.currentTarget.value });
                            e.currentTarget.value = "";
                        }}
                    />
                </Show>
                <Show when={!native && tab() && (!connected() || !hasPicture())}>
                    <div class="br-status" role="status"><Spinner size={13} />{connected() ? "Loading page…" : "Reconnecting browser…"}</div>
                </Show>
                <Show when={!tab()}>
                    <div class="blank">
                        <Show when={status() === "starting"}>
                            <Spinner size={14} class="blank-spinner" />
                        </Show>
                        <p class="blank-title">{status() === "unavailable" ? "No browser to run" : status() === "starting" ? "Starting the browser…" : status() === "crashed" ? "The browser stopped" : "No page open"}</p>
                        <Show when={(status() === "unavailable" || status() === "crashed") && state()?.error}>
                            {(error) => <p class="br-fix selectable">{error()}</p>}
                        </Show>
                    </div>
                </Show>
                {/* A dropdown's options: the list the page would open takes no click from here (src/browser/interact.ts).
                    Over the page's foot, which the desktop app's page stops short of (lib/page-follow.ts, .br-dialog). */}
                <Show when={tab()?.choice}>
                    {(c) => (
                        <div
                            class="br-sheet br-dialog"
                            role="listbox"
                            aria-label={c().label || "Options"}
                            onKeyDown={(e) => {
                                if (e.key !== "Escape") return;
                                e.stopPropagation();
                                choose(c().id);
                            }}
                        >
                            <Show when={c().label}><p class="br-sheet-label">{c().label}</p></Show>
                            <div class="br-options">
                                <For each={c().options}>
                                    {(o, i) => (
                                        <button ref={(el) => i() === c().selected && ready(el)} class="menu-item" role="option" aria-selected={i() === c().selected} disabled={o.disabled} onClick={() => choose(c().id, i())}>
                                            <span class="menu-check">
                                                <Show when={i() === c().selected}><Check size={14} /></Show>
                                            </span>
                                            <span class="menu-item-name">{o.label}</span>
                                        </button>
                                    )}
                                </For>
                            </div>
                            <div class="br-sheet-foot">
                                <button class="btn btn-sm" onClick={() => choose(c().id)}>
                                    Cancel
                                </button>
                            </div>
                        </div>
                    )}
                </Show>
                {/* Over the page, which it blocks anyway: the page keeps its size. */}
                <Show when={tab()?.dialog}>
                    {(d) => (
                        <form
                            class="br-sheet br-ask br-dialog"
                            role="alertdialog"
                            aria-label={`The page asks: ${d().message}`}
                            onSubmit={(e) => (e.preventDefault(), answer(true))}
                            onKeyDown={(e) => {
                                if (e.key !== "Escape") return;
                                e.stopPropagation();
                                answer(false);
                            }}
                        >
                            <p class="br-sheet-label">{host() ? `${host()} says` : "The page says"}</p>
                            <p class="br-ask-text selectable">{d().message}</p>
                            <Show when={d().type === "prompt"}>
                                <input ref={ready} class="input input-sm" aria-label="Answer" value={dialogText()} placeholder={d().defaultPrompt} onInput={(e) => setDialogText(e.currentTarget.value)} />
                            </Show>
                            <div class="br-sheet-foot">
                                <Show when={d().type !== "alert"}>
                                    <button type="button" class="btn btn-sm" onClick={() => answer(false)}>
                                        Cancel
                                    </button>
                                </Show>
                                <button ref={(el) => d().type !== "prompt" && ready(el)} type="submit" class="btn btn-sm btn-primary">
                                    OK
                                </button>
                            </div>
                        </form>
                    )}
                </Show>
            </div>
        </div>
    );
}
