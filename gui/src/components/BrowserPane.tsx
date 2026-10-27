// The Browser tab of the side panel: the session's browser, watched and driven by hand. Chrome runs on the server
// (src/browser); the page arrives as frames drawn on a canvas, and clicks, keys and scrolls on the canvas go back to
// it. A person using the page takes the tab from the agent (until they hand it back). The page is sized to the pane.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from "lucide-solid";
import type { BrowserCommand, BrowserInput } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc } from "../state/app";
import { adoptBrowserState, browserState, loadBrowserState, setBrowserShown, type BrowserFrame } from "../state/browser";
import { settingsTab } from "../state/ui";
import { electron } from "../lib/platform";
import { setShownBrowser, unshowBrowser } from "../state/browser-host";
import { followBox } from "../lib/follow-box";
import { addressOf, currentTab, isPasteKey, isReleaseKey, keyInput, mouseInput, pagePoint, paneSize, paneStatus, placeFrame, resized, tabLabel, wheelInput, wheelPixels, type Point, type Size } from "../lib/browser";
import type { BrowserImageFrame } from "@shared/browser-wire";
import { Spinner } from "./ui/bits";

/**
 * In the Electron desktop app the page isn't pictures: the tab is a real Chromium view in the window, which the app
 * lays over the pane's page box (placed below), and the person uses it directly. The bar, tabs and notes stay here.
 */
const native = electron !== undefined;

/** The pane's size is sent this long after it stops changing (dragging the panel's edge resizes it every frame). */
const RESIZE_MS = 120;

function decode(data: string | Uint8Array<ArrayBuffer>): Promise<ImageBitmap> {
    const bytes = typeof data === "string" ? Uint8Array.from(atob(data), (c) => c.charCodeAt(0)) : data;
    return createImageBitmap(new Blob([bytes]));
}

export function BrowserPane(p: { handle: SessionHandle }) {
    const id = () => p.handle.id;
    const stream = rpc.browserStream();
    const [connected, setConnected] = createSignal(stream.state === "open");
    const state = () => browserState(id());
    const tab = () => currentTab(state());
    const status = () => paneStatus(state());
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

    // -----------------------------------------------------------------------
    // The page's picture

    const boxSize = (): Size => ({ width: box?.clientWidth ?? 0, height: box?.clientHeight ?? 0 });

    const draw = () => {
        const ctx = canvas?.getContext("2d");
        if (!canvas || !ctx) return;
        const dpr = window.devicePixelRatio || 1;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (!bitmap || !frame) return;
        const at = placeFrame(boxSize(), frame);
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

    const watching = () => visible() && !settingsTab() && app.conn === "open" && connected();
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
        if (native) return;
        const size = paneSize(boxSize());
        if (size.width < 1 || size.height < 1) return;
        sized = size;
        void stream.call("browser.watch", { id: id(), ...size, scale: window.devicePixelRatio || 1 }).then((s) => adoptBrowserState(id(), s), reportError);
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

    // The tab's own page (BrowserHostLayer) follows the page box every frame: panels slide and resize without the box
    // resizing. A page's dialog at the foot of the box stays visible above it.
    if (native) {
        let placed = "";
        const place = () => {
            const t = tab();
            if (!disposed && box && watching() && t?.targetId) {
                const r = box.getBoundingClientRect();
                const dialog = box.querySelector(".br-dialog")?.getBoundingClientRect();
                const height = dialog ? Math.max(0, dialog.top - r.top - 8) : r.height;
                // Clear of the panel's edge handle: a page drawn over it would take the press that resizes the panel.
                const edge = document.querySelector(".insp-resizer")?.getBoundingClientRect();
                const left = edge && edge.right > r.left && edge.left < r.right ? Math.max(r.left, edge.right) : r.left;
                const shown = { x: Math.round(left), y: Math.round(r.top), width: Math.round(r.right - left), height: Math.round(height) };
                const key = `${t.targetId} ${shown.x} ${shown.y} ${shown.width} ${shown.height}`;
                if (key !== placed && shown.width > 0 && shown.height > 0) {
                    placed = key;
                    setShownBrowser({ targetId: t.targetId, box: shown, by: "pane" });
                }
            } else if (placed) {
                placed = "";
                unshowBrowser("pane");
            }
        };
        onMount(() => {
            const follow = followBox(box!, place);
            // What else moves or hides it: another tab, the pane covered or uncovered.
            createEffect(on([() => tab()?.targetId, watching], () => follow.kick()));
            onCleanup(() => {
                follow.stop();
                if (placed) unshowBrowser("pane");
            });
        });
    }

    // The tab changed: what was drawn belongs to the one before.
    createEffect(
        on(
            () => tab()?.id,
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
        return frame ? pagePoint({ x: e.clientX - rect.left, y: e.clientY - rect.top }, placeFrame(boxSize(), frame), frame) : undefined;
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

    const command = (c: BrowserCommand, extra: { url?: string; tab?: number } = {}) => void stream.call("browser.command", { id: id(), command: c, ...extra }).then((s) => adoptBrowserState(id(), s), reportError);
    const go = (e: SubmitEvent) => {
        e.preventDefault();
        const url = draft();
        setDraft(undefined);
        if (url?.trim()) command("goto", { url, tab: tab()?.id });
        keyboard?.focus({ preventScroll: true });
    };
    const answer = (accept: boolean) => {
        const text = dialogText();
        setDialogText("");
        void stream.call("browser.dialog", { id: id(), accept, ...(tab()?.dialog?.type === "prompt" ? { text } : {}), tab: tab()?.id }).catch(reportError);
    };

    return (
        <div class="browser-pane">
            <div class="br-bar">
                <button class="hb sm" aria-label="Back" title="Back" disabled={!tab()?.canGoBack} onClick={() => command("back", { tab: tab()?.id })}>
                    <ArrowLeft size={14} />
                </button>
                <button class="hb sm" aria-label="Forward" title="Forward" disabled={!tab()?.canGoForward} onClick={() => command("forward", { tab: tab()?.id })}>
                    <ArrowRight size={14} />
                </button>
                <button class="hb sm" aria-label="Reload" title="Reload" disabled={!tab()} onClick={() => command("reload", { tab: tab()?.id })}>
                    <Show when={tab()?.loading} fallback={<RotateCw size={14} />}>
                        <Spinner size={14} />
                    </Show>
                </button>
                <form class="br-address" onSubmit={go}>
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
                        onBlur={() => setDraft(undefined)}
                        onKeyDown={(e) => {
                            if (e.key !== "Escape") return;
                            e.stopPropagation();
                            setDraft(undefined);
                            e.currentTarget.blur();
                        }}
                    />
                </form>
            </div>
            <div class="br-tabs" role="tablist" aria-label="Browser tabs">
                <For each={state()?.tabs}>
                    {(t) => (
                        <div class="br-tab" classList={{ on: t.id === state()?.active }}>
                            <button role="tab" aria-selected={t.id === state()?.active} class="br-tab-main" title={t.url || undefined} onClick={() => t.id !== state()?.active && command("switch_tab", { tab: t.id })}>
                                <span class="truncate">{tabLabel(t)}</span>
                            </button>
                            <button class="br-tab-x" aria-label={`Close ${tabLabel(t)}`} title="Close tab" onClick={() => command("close_tab", { tab: t.id })}>
                                <X size={12} />
                            </button>
                        </div>
                    )}
                </For>
                <button class="hb sm" aria-label="New tab" title="New tab" disabled={status() === "unavailable"} onClick={() => command("new_tab")}>
                    <Plus size={14} />
                </button>
                <span class="grow" />
                <Show when={status() === "agent"}>
                    <span class="br-who" title="You can use the page too: the agent is told when you have">
                        <span class="br-dot" />
                        <span class="truncate">Agent is using this tab</span>
                    </span>
                </Show>
            </div>
            <div class="br-view" ref={box}>
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
                        onBlur={cancelInput}
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
                    <div class="br-connection" role="status"><Spinner size={14} />{connected() ? "Loading page…" : "Reconnecting browser…"}</div>
                </Show>
                <Show when={!tab()}>
                    <div class="br-blank">
                        <Show
                            when={status() !== "unavailable"}
                            fallback={
                                <div class="blank">
                                    <Globe size={22} class="ic" />
                                    <b>No browser to run</b>
                                    <span class="selectable">{state()?.error}</span>
                                </div>
                            }
                        >
                            <div class="blank">
                                <Show when={status() === "starting"} fallback={<Globe size={22} class="ic" />}>
                                    <Spinner size={22} class="ic" />
                                </Show>
                                <b>{status() === "starting" ? "Starting the browser…" : status() === "crashed" ? "The browser stopped" : "No page open"}</b>
                                <Show when={status() === "crashed"} fallback="The agent's pages show up here as it opens them. Enter an address above to open one yourself.">
                                    {state()?.error}
                                </Show>
                            </div>
                        </Show>
                    </div>
                </Show>
                {/* Over the page, which it blocks anyway: the page keeps its size. */}
                <Show when={tab()?.dialog}>
                    {(d) => (
                        <div class="br-note br-dialog" role="alertdialog" aria-label={`The page asks: ${d().message}`}>
                            <span class="br-note-text selectable">{d().message}</span>
                            <Show when={d().type === "prompt"}>
                                <input aria-label="Answer" value={dialogText()} placeholder={d().defaultPrompt} onInput={(e) => setDialogText(e.currentTarget.value)} />
                            </Show>
                            <button class="btn primary sm" onClick={() => answer(true)}>
                                OK
                            </button>
                            <button class="btn ghost sm" onClick={() => answer(false)}>
                                Cancel
                            </button>
                        </div>
                    )}
                </Show>
            </div>
        </div>
    );
}
