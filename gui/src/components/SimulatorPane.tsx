// The Simulator tab of the side panel: the session's iOS simulator, watched and used by hand. The simulator runs on
// the server's Mac (src/simulator); its screen arrives as pictures drawn on a canvas, and a press, a drag, the wheel
// and keys on the canvas go back to it as touches and a hardware keyboard. The agent uses the same device.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Check, ChevronDown, House, Power, Smartphone, Tablet } from "lucide-solid";
import type { SimulatorCommand, SimulatorDevice, SimulatorInput } from "@shared/protocol";
import type { SimulatorImageFrame } from "@shared/browser-wire";
import type { SessionHandle } from "../state/app";
import { app, reportError, rpc } from "../state/app";
import { adoptSimulatorState, loadSimulatorState, setSimulatorShown, simulatorState } from "../state/simulator";
import { settingsTab } from "../state/ui";
import { AGENT_ACTIVE_MS, cornerRadius, deviceDetail, paneNote, placeScreen, screenFraction, takenNote, WHEEL_JUMP, wheelPaced, WHEEL_SERIES_MS, wheelStart, wheelSwipesAgain, wheelTurn, type Rect, type Size, type WheelSwipe } from "../lib/simulator";
import { Menu } from "./ui/Menu";
import { Spinner } from "./ui/bits";

/** A wheel gesture becomes a finger drag; it lifts this long after the last turn, if it hasn't already (wheelTurn). */
const WHEEL_IDLE_MS = 120;

export function SimulatorPane(p: { handle: SessionHandle }) {
    const id = () => p.handle.id;
    const stream = rpc.browserStream();
    const [connected, setConnected] = createSignal(stream.state === "open");
    const state = () => simulatorState(id());
    const device = () => state()?.device;
    const note = () => paneNote(state());
    const [visible, setVisible] = createSignal(document.visibilityState === "visible");
    const [hasPicture, setHasPicture] = createSignal(false);
    const [menu, setMenu] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const [agentActive, setAgentActive] = createSignal(false);
    const [at, setAt] = createSignal<Rect>({ x: 0, y: 0, width: 0, height: 0 });
    let box: HTMLDivElement | undefined;
    let canvas: HTMLCanvasElement | undefined;
    let keyboard: HTMLTextAreaElement | undefined;
    let menuButton: HTMLButtonElement | undefined;
    let disposed = false;
    let generation = 0;
    /** The screen's size in device pixels, from the pictures. */
    let screen: Size | undefined;

    // "Agent is using this" shows for a while after each thing the agent does, then goes by itself.
    let ticker: ReturnType<typeof setTimeout> | undefined;
    createEffect(
        on(
            () => state()?.agentAt,
            (t) => {
                clearTimeout(ticker);
                const left = t === undefined ? 0 : t + AGENT_ACTIVE_MS - Date.now();
                setAgentActive(left > 0);
                if (left > 0) ticker = setTimeout(() => setAgentActive(false), left);
            },
        ),
    );

    // -----------------------------------------------------------------------
    // The screen's picture

    const boxSize = (): Size => ({ width: box?.clientWidth ?? 0, height: box?.clientHeight ?? 0 });
    const scale = () => state()?.screen?.scale ?? 3;
    const buttonsTaken = () => !!state()?.inputCut?.includes("buttons");

    const place = () => {
        const s = screen ?? (state()?.screen ? { width: state()!.screen!.width, height: state()!.screen!.height } : undefined);
        setAt(s ? placeScreen(boxSize(), s, scale()) : { x: 0, y: 0, width: 0, height: 0 });
    };

    // The canvas takes each picture as it is, without copying it, and its CSS size scales it to at(): pictures come
    // at the size it's drawn at, and after a resize one at the new size follows.
    const show = (picture: ImageBitmap | null) => {
        const ctx = canvas?.getContext("bitmaprenderer");
        if (ctx) ctx.transferFromImageBitmap(picture);
        else picture?.close();
    };

    let decoding = false;
    let waiting: { picture: SimulatorImageFrame; epoch: number } | undefined;
    const paint = async (f: SimulatorImageFrame, epoch: number) => {
        decoding = true;
        try {
            if (!disposed && epoch === generation && watching()) {
                const next = await createImageBitmap(new Blob([f.data]));
                if (disposed || epoch !== generation || !watching()) {
                    next.close();
                    return;
                }
                const sized = !screen || screen.width !== f.width || screen.height !== f.height;
                screen = { width: f.width, height: f.height };
                if (sized) {
                    place();
                    // Now the screen's shape is known: the pictures can be the size it's drawn at.
                    sideChanged();
                }
                show(next);
                setHasPicture(true);
            }
        } catch {
            // An undecodable picture doesn't stall the next.
        } finally {
            decoding = false;
            const next = waiting;
            waiting = undefined;
            if (next && !disposed) void paint(next.picture, next.epoch);
        }
    };
    const onPicture = (f: SimulatorImageFrame) => {
        stream.notify("simulator.ack", { id: f.sessionId, frameId: f.frameId });
        if (disposed || f.sessionId !== id()) return;
        if (decoding) waiting = { picture: f, epoch: generation };
        else void paint(f, generation);
    };

    // -----------------------------------------------------------------------
    // Watching: pictures come while the pane shows and the device runs.

    const watching = () => visible() && !settingsTab() && app.conn === "open" && connected() && state()?.status === "ready";
    /** The longest side the screen is drawn at, in device pixels: pictures come no larger. */
    const side = () => {
        const dpr = window.devicePixelRatio || 1;
        const r = at();
        return Math.ceil((r.width > 0 ? Math.max(r.width, r.height) : boxSize().height) * dpr);
    };
    let sentSide = 0;
    const watch = () => {
        sentSide = side();
        void stream.call("simulator.watch", { id: id(), side: sentSide }).then((s) => adoptSimulatorState(id(), s), reportError);
    };
    // A pane resized enough to want pictures of another size asks for them (after it stops resizing).
    let sideTimer: ReturnType<typeof setTimeout> | undefined;
    const sideChanged = () => {
        clearTimeout(sideTimer);
        sideTimer = setTimeout(() => {
            if (watching() && sentSide && Math.abs(side() - sentSide) / sentSide > 0.15) watch();
        }, 250);
    };

    onMount(() => {
        const unframe = stream.onSimulatorFrame(onPicture);
        const unevent = stream.onEvent((e) => {
            if (e.type === "simulator.state" && e.sessionId === id()) adoptSimulatorState(id(), e.state);
        });
        const unstate = stream.onState((s) => setConnected(s === "open"));
        void stream.connect();
        setSimulatorShown(id(), true);
        void loadSimulatorState(id()).catch(() => undefined);
        const observer = new ResizeObserver(() => {
            place();
            sideChanged();
        });
        observer.observe(box!);
        const seen = () => setVisible(document.visibilityState === "visible");
        document.addEventListener("visibilitychange", seen);
        window.addEventListener("blur", cancelInput);
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
        clearTimeout(ticker);
        clearTimeout(sideTimer);
        setSimulatorShown(id(), false);
        void stream.call("simulator.unwatch", { id: id() }).catch(() => undefined);
        stream.close();
        waiting = undefined;
    });

    // Watched again after a reconnect or once the device runs, and not while hidden or covered. While the pane is
    // open but the device isn't running, the server is still asked to watch, so devices started elsewhere show.
    createEffect(
        on([visible, connected, () => app.conn, settingsTab], () => {
            if (visible() && connected() && app.conn === "open" && !settingsTab()) watch();
            else void stream.call("simulator.unwatch", { id: id() }).catch(() => undefined);
        }),
    );
    createEffect(
        on(
            () => (watching() ? device()?.udid : undefined),
            (udid) => {
                // Another device, or none running: what was drawn belongs to the one before.
                generation++;
                cancelInput();
                show(null);
                screen = undefined;
                setHasPicture(false);
                place();
                if (udid) watch();
            },
            { defer: true },
        ),
    );

    // -----------------------------------------------------------------------
    // The person's input

    const send = (input: SimulatorInput) => {
        if (!disposed && watching()) stream.notify("simulator.input", { id: id(), input });
    };
    const heldKeys = new Set<string>();
    let finger: { x: number; y: number } | undefined;
    let wheel:
        | {
              x: number;
              y: number;
              timer: ReturnType<typeof setTimeout>;
              swipe: WheelSwipe;
              /** When the last turn came. */
              at: number;
              /** Where the finger is going at the pace (wheelPaced), and the frame moving it. */
              to?: { x: number; y: number };
              frame?: number;
          }
        | undefined;
    let moving = 0;
    let move: { x: number; y: number } | undefined;

    const lift = () => {
        if (finger) send({ kind: "touch", phase: "up", ...finger });
        finger = undefined;
    };
    const endWheel = () => {
        if (!wheel) return;
        clearTimeout(wheel.timer);
        if (wheel.frame) cancelAnimationFrame(wheel.frame);
        if (!wheel.swipe.coasting) send({ kind: "touch", phase: "up", x: wheel.x, y: wheel.y });
        wheel = undefined;
    };
    const cancelInput = () => {
        cancelAnimationFrame(moving);
        moving = 0;
        move = undefined;
        lift();
        endWheel();
        for (const code of heldKeys) send({ kind: "key", code, down: false });
        heldKeys.clear();
    };
    const pointOf = (e: MouseEvent, clamp = false) => {
        const r = box!.getBoundingClientRect();
        return screenFraction({ x: e.clientX - r.left, y: e.clientY - r.top }, at(), clamp);
    };
    const flush = () => {
        moving = 0;
        if (move && finger) {
            finger = move;
            send({ kind: "touch", phase: "move", ...move });
        }
        move = undefined;
    };

    const onPointerDown = (e: PointerEvent) => {
        if (e.button !== 0) return;
        const p0 = pointOf(e);
        if (!p0) return;
        e.preventDefault();
        keyboard?.focus({ preventScroll: true });
        canvas?.setPointerCapture(e.pointerId);
        lift();
        endWheel();
        finger = p0;
        send({ kind: "touch", phase: "down", ...p0 });
    };
    const onPointerMove = (e: PointerEvent) => {
        if (!finger) return;
        // A finger dragged off the screen stays at its edge, as on the device.
        move = pointOf(e, true);
        moving ||= requestAnimationFrame(flush);
    };
    const onPointerUp = (e: PointerEvent) => {
        if (!finger) return;
        cancelAnimationFrame(moving);
        moving = 0;
        move = undefined;
        finger = pointOf(e, true) ?? finger;
        lift();
    };
    const paceWheel = (now: number, before: number) => {
        if (!wheel?.to) return;
        const p = wheelPaced(wheel, wheel.to, now - before);
        wheel.x = p.x;
        wheel.y = p.y;
        if (now !== before) send({ kind: "touch", phase: "move", ...p });
        if (p.x === wheel.to.x && p.y === wheel.to.y) {
            wheel.to = wheel.frame = undefined;
            wheel.timer = setTimeout(endWheel, WHEEL_IDLE_MS);
        } else wheel.frame = requestAnimationFrame((t) => paceWheel(t, now));
    };
    const onWheel = (e: WheelEvent) => {
        const p0 = pointOf(e);
        if (!p0 && !wheel) return;
        e.preventDefault();
        if (finger) return;
        const r = at();
        const pxY = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
        const pxX = e.deltaMode === 1 ? e.deltaX * 16 : e.deltaX;
        const dy = pxY / r.height;
        const dx = pxX / r.width;
        const size = Math.abs(pxX) + Math.abs(pxY);
        if (wheel && p0 && wheelSwipesAgain(wheel.swipe, size)) endWheel();
        const alone = !wheel || e.timeStamp - wheel.at >= WHEEL_SERIES_MS;
        if (!wheel) {
            wheel = { ...p0!, timer: 0 as unknown as ReturnType<typeof setTimeout>, swipe: wheelStart(size), at: e.timeStamp };
            send({ kind: "touch", phase: "down", x: wheel.x, y: wheel.y });
        }
        wheel.at = e.timeStamp;
        clearTimeout(wheel.timer);
        // Content follows the finger: turning the wheel down moves the finger up, as a trackpad scrolls.
        const from = wheel.to ?? wheel;
        if (!wheel.swipe.coasting && alone && (wheel.to || Math.abs(dx) + Math.abs(dy) >= WHEEL_JUMP)) {
            wheel.swipe = wheelTurn(wheel.swipe, size, false);
            wheel.to = { x: Math.min(Math.max(from.x - dx, 0), 1), y: Math.min(Math.max(from.y - dy, 0), 1) };
            wheel.frame ??= requestAnimationFrame((t) => paceWheel(t, t));
            return;
        }
        // A series after all: it starts from where the finger was going.
        if (wheel.to) {
            cancelAnimationFrame(wheel.frame!);
            wheel.x = wheel.to.x;
            wheel.y = wheel.to.y;
            wheel.to = wheel.frame = undefined;
        }
        wheel.timer = setTimeout(endWheel, WHEEL_IDLE_MS);
        const coasted = wheel.swipe.coasting;
        const x = wheel.x - dx;
        const y = wheel.y - dy;
        const along = Math.abs(dx) >= Math.abs(dy) ? x : y;
        wheel.swipe = wheelTurn(wheel.swipe, size, along < 0 || along > 1);
        if (coasted) return;
        wheel.x = Math.min(Math.max(x, 0), 1);
        wheel.y = Math.min(Math.max(y, 0), 1);
        send({ kind: "touch", phase: "move", x: wheel.x, y: wheel.y });
        if (wheel.swipe.coasting) send({ kind: "touch", phase: "up", x: wheel.x, y: wheel.y });
    };
    let composing = false;
    const onKey = (down: boolean) => (e: KeyboardEvent) => {
        // Pasting arrives as a paste event, with the text.
        if (down && (e.metaKey || e.ctrlKey) && e.code === "KeyV") {
            e.stopPropagation();
            return;
        }
        if (composing || e.isComposing || e.key === "Dead" || e.key === "Process") return;
        e.preventDefault();
        e.stopPropagation();
        if (down) {
            if (e.repeat && heldKeys.has(e.code)) {
                // A held key repeats on the device by itself.
                return;
            }
            heldKeys.add(e.code);
        } else heldKeys.delete(e.code);
        send({ kind: "key", code: e.code, down });
    };
    const onPaste = (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text/plain");
        if (!text) return;
        e.preventDefault();
        // Typed with ⌘ (or another key) still down, the text would be shortcuts.
        for (const code of heldKeys) send({ kind: "key", code, down: false });
        heldKeys.clear();
        send({ kind: "text", text });
    };

    // -----------------------------------------------------------------------
    // The device menu and buttons

    const command = (c: SimulatorCommand, udid?: string) => {
        setBusy(true);
        void stream
            .call("simulator.command", { id: id(), command: c, ...(udid ? { udid } : {}) })
            .then((s) => adoptSimulatorState(id(), s), reportError)
            .finally(() => setBusy(false));
    };
    const pick = (d: SimulatorDevice) => {
        setMenu(false);
        // Choosing a device is choosing to use it: one that's off starts.
        command(d.state === "booted" ? "select" : "boot", d.udid);
    };
    const DeviceIcon = (q: { kind?: SimulatorDevice["kind"]; size: number; class?: string }) => (q.kind === "ipad" ? <Tablet size={q.size} class={q.class} /> : <Smartphone size={q.size} class={q.class} />);
    const running = () => state()?.status === "ready";

    return (
        <div class="simulator-pane">
            <div class="sim-bar">
                <button ref={menuButton} class="tb sim-device" aria-haspopup="menu" aria-expanded={menu()} disabled={!state()?.devices.length} title="Choose a simulator" onClick={() => setMenu(!menu())}>
                    <DeviceIcon kind={device()?.kind} size={14} />
                    <span class="truncate">{device()?.name ?? "Simulator"}</span>
                    <Show when={device()}>{(d) => <span class="sim-runtime">{d().runtime}</span>}</Show>
                    <ChevronDown size={12} class="chev" />
                </button>
                <span class="grow" />
                <Show when={agentActive()}>
                    <span class="br-who" title="You can use it too: the agent is told when you have">
                        <span class="br-dot" />
                        <span class="truncate">Agent is using this</span>
                    </span>
                </Show>
                <button class="hb sm" aria-label="Home" title={buttonsTaken() ? "Another app took the buttons" : "Home"} disabled={!running() || buttonsTaken()} onClick={() => send({ kind: "button", name: "home" })}>
                    <House size={14} />
                </button>
                <button class="hb sm" aria-label={`Shut down ${device()?.name ?? "the simulator"}`} title="Shut down" disabled={!running() || busy()} onClick={() => command("shutdown")}>
                    <Power size={14} />
                </button>
            </div>
            <Menu label="Simulators" open={menu()} anchor={() => menuButton} onClose={() => setMenu(false)} placement="bottom" align="start" width={280} maxHeight={480}>
                <For each={state()?.devices ?? []}>
                    {(d) => (
                        <button class="menu-item compact sim-pick" role="menuitemradio" aria-checked={d.udid === device()?.udid} onClick={() => pick(d)}>
                            <DeviceIcon kind={d.kind} size={14} />
                            <span class="menu-text">
                                <span class="menu-label truncate">{d.name}</span>
                                <span class="menu-desc">{deviceDetail(d)}</span>
                            </span>
                            <Show when={d.udid === device()?.udid}>
                                <Check size={14} class="menu-check" />
                            </Show>
                        </button>
                    )}
                </For>
            </Menu>
            <div class="sim-view" ref={box}>
                <canvas
                    ref={canvas}
                    class="sim-screen"
                    classList={{ shown: hasPicture() && running() }}
                    style={{ left: `${at().x}px`, top: `${at().y}px`, width: `${at().width}px`, height: `${at().height}px`, "border-radius": `${cornerRadius(device()?.kind, at().width)}px` }}
                    tabindex="0"
                    aria-label={`${device()?.name ?? "Simulator"} screen. Click to touch, drag to swipe; type to use its keyboard.`}
                    onPointerDown={onPointerDown}
                    onPointerMove={onPointerMove}
                    onPointerUp={onPointerUp}
                    onPointerCancel={onPointerUp}
                    onWheel={onWheel}
                    onFocus={() => keyboard?.focus({ preventScroll: true })}
                    onContextMenu={(e) => e.preventDefault()}
                />
                <textarea
                    ref={keyboard}
                    class="br-keyboard"
                    aria-label="Simulator keyboard input"
                    autocomplete="off"
                    autocapitalize="off"
                    spellcheck={false}
                    onKeyDown={onKey(true)}
                    onKeyUp={onKey(false)}
                    onPaste={onPaste}
                    onBlur={cancelInput}
                    onCompositionStart={() => (composing = true)}
                    onCompositionEnd={(e) => {
                        composing = false;
                        if (e.data) send({ kind: "text", text: e.data });
                        e.currentTarget.value = "";
                    }}
                    onInput={(e) => {
                        if (composing || e.isComposing) return;
                        if (e.currentTarget.value) send({ kind: "text", text: e.currentTarget.value });
                        e.currentTarget.value = "";
                    }}
                />
                <Show when={running() && (!hasPicture() || !connected())}>
                    <div class="br-connection" role="status">
                        <Spinner size={14} />
                        {connected() ? "Connecting…" : "Reconnecting…"}
                    </div>
                </Show>
                <Show when={running() && takenNote(state()?.inputCut, state()?.inputUncertain)}>
                    {(taken) => (
                        <div class="sim-taken" role="status">
                            <span>{taken()}</span>
                            <button class="btn sm" disabled={busy()} title="Restarts its home screen, closing its apps" onClick={() => command("take_control")}>
                                Take control
                            </button>
                        </div>
                    )}
                </Show>
                <Show when={note()}>
                    {(n) => (
                        <div class="br-blank">
                            <div class="blank">
                                <Show when={n().busy || busy()} fallback={<DeviceIcon kind={device()?.kind} size={22} class="ic" />}>
                                    <Spinner size={22} class="ic" />
                                </Show>
                                <b>{n().title}</b>
                                <Show when={n().detail}>
                                    <span class="selectable">{n().detail}</span>
                                </Show>
                                <Show when={n().start}>
                                    <button class="btn primary sm sim-start" disabled={busy()} onClick={() => command("boot")}>
                                        Start
                                    </button>
                                </Show>
                                <Show when={n().retry}>
                                    <button class="btn sm sim-start" onClick={() => watch()}>
                                        Try again
                                    </button>
                                </Show>
                            </div>
                        </div>
                    )}
                </Show>
            </div>
        </div>
    );
}
