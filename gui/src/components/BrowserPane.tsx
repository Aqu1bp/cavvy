// The Browser tab of the side panel: the session's browser, watched and driven by hand. Chrome runs on the server
// (src/browser); the page arrives as frames drawn on a canvas, and clicks, keys and scrolls on the canvas go back to
// it. A person using the page takes the tab from the agent (until they hand it back). The page is sized to the pane.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ArrowLeft, ArrowRight, Globe, Plus, RotateCw, X } from "lucide-solid";
import type { BrowserCommand, BrowserInput } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc } from "../state/app";
import { adoptBrowserState, browserState, loadBrowserState, onBrowserFrame, setBrowserShown, type BrowserFrame } from "../state/browser";
import { settingsTab } from "../state/ui";
import { addressOf, currentTab, isPasteKey, isReleaseKey, keyInput, mouseInput, pagePoint, paneSize, paneStatus, placeFrame, resized, tabLabel, wheelInput, wheelPixels, type Point, type Size } from "../lib/browser";
import { Spinner } from "./ui/bits";

/** The pane's size is sent this long after it stops changing (dragging the panel's edge resizes it every frame). */
const RESIZE_MS = 120;

function decode(base64: string): Promise<ImageBitmap> {
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
    return createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
}

export function BrowserPane(p: { handle: SessionHandle }) {
    const id = () => p.handle.id;
    const state = () => browserState(id());
    const tab = () => currentTab(state());
    const status = () => paneStatus(state());
    let box: HTMLDivElement | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let address: HTMLInputElement | undefined;
    /** The frame drawn, with the page's size it shows. */
    let bitmap: ImageBitmap | undefined;
    let frame: Size | undefined;
    let sized: Size | undefined;
    const [draft, setDraft] = createSignal<string>();
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

    const onFrame = async (f: BrowserFrame) => {
        try {
            // A frame of a tab that isn't the one shown any more (the agent moved on) is only acknowledged.
            if (f.tab === tab()?.id) {
                const next = await decode(f.data);
                bitmap?.close();
                bitmap = next;
                frame = { width: f.width, height: f.height };
                draw();
            }
        } catch {
            // an undecodable frame: the next one will do
        } finally {
            // The server sends the next frame once this one is drawn, so a slow window is given fewer, never a backlog.
            void rpc.call("browser.ack", { id: id() }).catch(() => undefined);
        }
    };

    // -----------------------------------------------------------------------
    // Watching: the server sizes the page to the pane and streams it while the pane shows.

    const watching = () => visible() && !settingsTab() && app.conn === "open";
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const watch = () => {
        const size = paneSize(boxSize());
        if (size.width < 1 || size.height < 1) return;
        sized = size;
        void rpc.call("browser.watch", { id: id(), ...size, scale: window.devicePixelRatio || 1 }).then((s) => adoptBrowserState(id(), s), reportError);
    };

    onMount(() => {
        const unframe = onBrowserFrame(id(), (f) => void onFrame(f));
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
        fit();
        stop = () => {
            unframe();
            observer.disconnect();
            document.removeEventListener("visibilitychange", seen);
        };
    });
    let stop = () => {};
    onCleanup(() => {
        stop();
        clearTimeout(resizeTimer);
        cancelAnimationFrame(moving);
        setBrowserShown(id(), false);
        void rpc.call("browser.unwatch", { id: id() }).catch(() => undefined);
        bitmap?.close();
        bitmap = undefined;
    });

    // Watched again after a reconnect (the server lets go of a window that went away), and not while hidden or covered.
    createEffect(
        on(watching, (on) => {
            if (on) {
                sized = undefined;
                watch();
            } else void rpc.call("browser.unwatch", { id: id() }).catch(() => undefined);
        }),
    );

    // The tab changed: what was drawn belongs to the one before.
    createEffect(
        on(
            () => tab()?.id,
            () => {
                bitmap?.close();
                bitmap = undefined;
                frame = undefined;
                draw();
            },
            { defer: true },
        ),
    );

    // -----------------------------------------------------------------------
    // The person's input

    const send = (input: BrowserInput) => void rpc.call("browser.input", { id: id(), tab: tab()?.id, input }).catch(() => undefined);
    const pointOf = (e: MouseEvent): Point | undefined => {
        const rect = canvas!.getBoundingClientRect();
        return frame ? pagePoint({ x: e.clientX - rect.left, y: e.clientY - rect.top }, placeFrame(boxSize(), frame), frame) : undefined;
    };

    // Pointer moves and wheel turns come faster than frames: the latest of each goes once a frame.
    let moving = 0;
    let move: BrowserInput | undefined;
    let wheel: { at: Point; pixels: { x: number; y: number }; keys: WheelEvent } | undefined;
    const flush = () => {
        moving = 0;
        if (move) send(move);
        move = undefined;
        if (wheel) send(wheelInput(wheel.at, wheel.pixels, wheel.keys));
        wheel = undefined;
    };
    const later = () => (moving ||= requestAnimationFrame(flush));

    const onMouseDown = (e: MouseEvent) => {
        canvas!.focus();
        const at = pointOf(e);
        if (!at) return;
        e.preventDefault();
        flush();
        send(mouseInput("down", at, e));
        // A drag that leaves the canvas still ends where it's released.
        const up = (u: MouseEvent) => {
            window.removeEventListener("mouseup", up);
            const to = pointOf(u);
            if (to) send(mouseInput("up", to, u));
            else if (frame) send(mouseInput("up", at, u));
        };
        window.addEventListener("mouseup", up);
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
        const turn = wheelPixels(e, frame.height);
        wheel = { at, pixels: { x: (wheel?.pixels.x ?? 0) + turn.x, y: (wheel?.pixels.y ?? 0) + turn.y }, keys: e };
        later();
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
        if (isPasteKey(e)) return;
        const input = keyInput(type, e);
        if (!input) return;
        e.preventDefault();
        e.stopPropagation();
        send(input);
    };
    const onPaste = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        send({ kind: "text", text });
    };

    // -----------------------------------------------------------------------
    // The address bar, the tabs, and handing back

    const command = (c: BrowserCommand, extra: { url?: string; tab?: number } = {}) => void rpc.call("browser.command", { id: id(), command: c, ...extra }).then((s) => adoptBrowserState(id(), s), reportError);
    const go = (e: SubmitEvent) => {
        e.preventDefault();
        const url = draft();
        setDraft(undefined);
        if (url?.trim()) command("goto", { url, tab: tab()?.id });
        canvas?.focus();
    };
    const handBack = () => void rpc.call("browser.handBack", { id: id(), tab: tab()?.id }).catch(reportError);
    const answer = (accept: boolean) => {
        const text = dialogText();
        setDialogText("");
        void rpc.call("browser.dialog", { id: id(), accept, ...(tab()?.dialog?.type === "prompt" ? { text } : {}), tab: tab()?.id }).catch(reportError);
    };

    return (
        <div class="br">
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
                    <span class="br-who" title="Click or type in the page to take over">
                        <span class="br-dot" />
                        Agent is using this tab
                    </span>
                </Show>
            </div>
            <div class="br-view" ref={box}>
                <canvas
                    ref={canvas}
                    class="br-canvas"
                    tabindex="0"
                    aria-label="Browser page. Click to use it with your mouse and keyboard; Shift+Escape returns to the address bar."
                    onMouseDown={onMouseDown}
                    onMouseMove={onMouseMove}
                    onWheel={onWheel}
                    onKeyDown={onKey("down")}
                    onKeyUp={onKey("up")}
                    onPaste={onPaste}
                    onContextMenu={(e) => e.preventDefault()}
                />
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
            </div>
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
            <Show when={status() === "human"}>
                <div class="br-note">
                    <span class="br-note-text">You're in control of this tab. The agent can look at it, but not act on it.</span>
                    <button class="btn primary sm" onClick={handBack}>
                        Hand back to agent
                    </button>
                </div>
            </Show>
        </div>
    );
}
