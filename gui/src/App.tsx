import { RenderBoundary } from "./components/ui/ErrorBoundary";
import { batch, createEffect, createMemo, createSignal, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { PlugZap } from "lucide-solid";
import { Toasts } from "./components/Toasts";
import { ErrorCards } from "./components/ErrorCards";
import { activate, app, attentionCount, handleFor, restoreActiveSession, rpc, type SessionHandle } from "./state/app";
import { cycleSession, interrupt, newSession, togglePanel, toggleSidebar } from "./state/actions";
import { prefs, setPrefs } from "./state/prefs";
import { agentFocus, dockHeight, inspectorDrag, inspectorWidth, paletteOpen, railDrag, railOpen, requestComposerFocus, review, reviewDrag, reviewSplit, setAgentFocus, setDockHeight, setInspectorDrag, setInspectorWidth, setModelPickerOpen, setPaletteOpen, setRailOpen, setReview, setSettingsTab, setShellLayout, settingsTab, shellLayout, terminalDrag, terminalMax, terminalShown, panelHold, setPanelHold } from "./state/ui";
import { isTauri, os, windowCommand } from "./lib/platform";
import { installWindowDrag } from "./lib/window-drag";
import { canStop } from "./lib/session-status";
import { actionOf, setEnterSends } from "./state/keybindings";
import { clampInspectorWidth, closesOnShrink, columnSteps, heldSizes, requestCloses, tracks, COLUMN_NARROW, COLUMN_SHORT, INSPECTOR_DEFAULT, windowLayout } from "./lib/layout";
import { warmUp } from "./lib/highlight";
import { warmMarkdown } from "./lib/markdown";
import { frameDrag } from "./lib/drag";
import { skipCovered } from "./lib/cover";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { AgentView } from "./components/Agents";
import { RightPanel } from "./components/RightPanel";
import { ReviewPane } from "./components/ReviewPane";
import { TerminalPanel } from "./components/TerminalPanel";
import { openFind, terminalOpen, setTerminalOpen } from "./state/ui";
import { Home } from "./components/Home";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsNav, SettingsPage } from "./components/Settings";
import { RewindDialog } from "./components/RewindDialog";
import { McpDialog } from "./components/McpDialog";
import { FolderPicker } from "./components/FolderPicker";
import { TrustDialog } from "./components/TrustDialog";
import { PlanDialogs } from "./components/PlanDialogs";
import { ArchiveDialog } from "./components/ArchiveDialog";
import { RunSheet } from "./components/RunSheet";
import { DeleteSessionDialog } from "./components/DeleteSessionDialog";
import { CommitDialog } from "./components/CommitDialog";
import { ImageViewer } from "./components/ImageViewer";
import { Logo, Spinner } from "./components/ui/bits";

function Disconnected() {
    return (
        <div class="splash">
            <Switch
                fallback={
                    <>
                        <Logo size={44} />
                        <Spinner size={18} />
                        <div class="muted">{app.conn === "reconnecting" ? "Reconnecting to Cavvy server…" : "Starting…"}</div>
                    </>
                }
            >
                <Match when={app.conn === "unauthorized"}>
                    <Logo size={44} />
                    <h2>Open Cavvy from your terminal</h2>
                    <p class="muted">
                        Run <code>cavvy gui</code> and use the link it opens or prints. Links work once, so this page can't reconnect on its own.
                    </p>
                </Match>
                <Match when={app.conn === "unavailable"}>
                    <PlugZap size={36} class="tone-warn" />
                    <h2>Can't reach Cavvy server</h2>
                    <p class="muted">{isTauri ? "The background process stopped. Quit and reopen the app." : "Is `cavvy gui` still running? Still trying to reconnect…"}</p>
                </Match>
            </Switch>
            <button class="btn secondary" onClick={() => rpc.reconnectNow()}>
                Reconnect now
            </button>
        </div>
    );
}

/** A session: the conversation, and the composer floating over its end. (Its inspector is the sheet's other column.) */
function SessionView(p: { handle: SessionHandle }) {
    let dock: HTMLDivElement | undefined;
    // Unmeasured: the transcript's boxes have --dock-h's initial value (stage.css).
    const [dockH, setDockH] = createSignal<number>();
    onMount(() => {
        // The transcript scrolls under the composer and keeps that much room at its end;
        // a floating inspector ends above it.
        const ro = new ResizeObserver(() => {
            const h = dock?.offsetHeight ?? 0;
            setDockH(h);
            setDockHeight(h);
        });
        if (dock) ro.observe(dock);
        onCleanup(() => {
            ro.disconnect();
            setDockHeight(0);
        });
    });
    return (
        <>
            <Header handle={p.handle} />
            <div class="stage">
                <Transcript handle={p.handle} dock={dockH()} />
                <div class="composer-dock" ref={dock}>
                    <div class="composer-col">
                        <ErrorCards place="composer" />
                        <Composer sessionId={p.handle.id} />
                    </div>
                </div>
            </div>
        </>
    );
}

/** The docked inspector's left edge: drag (or arrow keys) to resize; double-click for the default. */
function InspectorResizer() {
    const [dragging, setDragging] = createSignal(false);
    const clamp = (w: number) => clampInspectorWidth(w, shellLayout().sheet.w);
    const set = (w: number) => setInspectorWidth(clamp(w));
    /** Ends the drag under way, if any: on release, and when the handle goes away in the middle of one. */
    let stop: (() => void) | undefined;
    onCleanup(() => stop?.());
    const start = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        stop?.();
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        const x = e.clientX;
        const from = shellLayout().inspector.width;
        setDragging(true);
        document.body.classList.add("resizing");
        // Shown once a frame, saved (inspectorWidth, and so localStorage) on release.
        const drag = frameDrag({
            show: setInspectorDrag,
            commit: (w) => batch(() => {
                if (w !== undefined) setInspectorWidth(w);
                setInspectorDrag(undefined);
            }),
        });
        const move = (ev: PointerEvent) => drag.move(clamp(from - (ev.clientX - x)));
        const end = () => {
            stop = undefined;
            drag.end();
            setDragging(false);
            document.body.classList.remove("resizing");
            target.removeEventListener("pointermove", move);
            target.removeEventListener("lostpointercapture", end);
        };
        stop = end;
        target.addEventListener("pointermove", move);
        target.addEventListener("lostpointercapture", end);
    };
    return (
        <div
            class={`insp-resizer ${dragging() ? "drag" : ""}`}
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize side panel"
            aria-valuenow={shellLayout().inspector.width}
            tabIndex={0}
            onPointerDown={start}
            onDblClick={() => set(INSPECTOR_DEFAULT)}
            onKeyDown={(e) => {
                if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
                e.preventDefault();
                set(shellLayout().inspector.width + (e.key === "ArrowLeft" ? 24 : -24));
            }}
        />
    );
}

const INSPECTOR_KEY = "cavvy.inspectorWidth";

/** The window's tracks sliding now (shell.css): none when an edge is dragged, motion is off, or nothing changed. */
function slides(): Animation[] {
    return [".win", ".sheet"].flatMap((s) => document.querySelector(s)?.getAnimations() ?? [])
        .filter((a) => a instanceof CSSTransition && a.transitionProperty.startsWith("grid-template"));
}

/**
 * Keeps the window's layout (lib/layout.ts) for the window's size and what's open: the rail docked
 * or a drawer, the inspector docked or floating, the terminal's row. Draws nothing.
 * `panel`/`review`: the inspector's two contents are showing.
 */
function LayoutKeeper(p: { panel: boolean; review: boolean }) {
    const size = () => ({ w: window.innerWidth, h: window.innerHeight });
    const [win, setWin] = createSignal(size());
    try {
        const saved = Number(localStorage.getItem(INSPECTOR_KEY));
        if (saved) setInspectorWidth(saved);
    } catch { /* private mode: the default width */ }
    onMount(() => {
        const resized = () => setWin(size());
        window.addEventListener("resize", resized);
        onCleanup(() => window.removeEventListener("resize", resized));
    });
    createEffect(on(inspectorWidth, (w) => {
        try { localStorage.setItem(INSPECTOR_KEY, String(w)); } catch { /* private mode */ }
    }, { defer: true }));

    // A size being dragged shows in place of the saved one until the release saves it.
    const layout = createMemo(() => windowLayout({
        win: win(),
        rail: prefs.sidebar,
        railOpen: railOpen(),
        railWidth: railDrag() ?? prefs.sidebarWidth,
        panel: p.panel,
        review: p.review,
        split: reviewSplit(),
        reviewBase: reviewDrag() ?? prefs.reviewWidth,
        inspectorWidth: inspectorDrag() ?? inspectorWidth(),
        terminalShown: terminalShown(),
        terminalPreferred: terminalDrag() ?? prefs.terminalHeight,
        terminalMax: terminalMax(),
        dock: dockHeight(),
    }));

    createEffect(() => setShellLayout(layout()));

    // Opening or closing a panel slides the window's tracks (shell.css). Meanwhile the conversation and
    // the terminal hold one size (lib/layout.ts heldSizes): they're laid out as the slide starts and as it
    // ends, not on every frame of it.
    let slide = 0;
    createEffect(on(layout, (to, from) => {
        if (!from || tracks(to) === tracks(from)) {
            const held = panelHold();
            // The window resizing meanwhile: the slide goes on, to the new sizes.
            if (from && held) setPanelHold({ ...heldSizes(held, from, to), from: held.from, slide: held.slide });
            return;
        }
        const now = ++slide;
        // Once the tracks' new sizes are in the DOM (this update's render), their transitions have begun.
        queueMicrotask(() => {
            if (slide !== now) return;
            const sliding = slides();
            if (!sliding.length) return setPanelHold(undefined);
            setPanelHold({ ...heldSizes(panelHold(), from, to), slide: sliding[0]! });
            // A slide cut short by another one hands the hold on to it.
            void Promise.allSettled(sliding.map((a) => a.finished)).then(() => { if (slide === now) setPanelHold(undefined); });
        });
    }));

    // Shrinking the window past the docking point closes a docked inspector (the diff reader fills the sheet instead).
    createEffect(on(() => layout().inspector.mode, (mode, from) => {
        if (closesOnShrink(from, mode, prefs.panel, p.review)) setPrefs("panel", false);
    }));
    // A request arriving closes a floating inspector too short to sit above it.
    let cleared: string | undefined;
    let wasOpen = false;
    createEffect(() => {
        const asks = handleFor(app.activeId)?.view.state.interactions ?? [];
        const request = asks.length ? `${app.activeId}:${asks.map((a) => a.id).join(",")}` : undefined;
        const { mode, short } = layout().inspector;
        const open = p.panel || p.review;
        const next = requestCloses(cleared, wasOpen, { request, mode, short, open });
        cleared = next.cleared;
        wasOpen = open && !next.close;
        if (!next.close) return;
        setPrefs("panel", false);
        setReview(undefined);
    });
    // The rail's drawer closes when the rail docks, and on going somewhere else.
    createEffect(() => {
        if (layout().railMode === "dock") setRailOpen(false);
    });
    createEffect(on([() => app.activeId, settingsTab], () => setRailOpen(false), { defer: true }));
    return null;
}

function Reconnecting() {
    return (
        <>
            <Show when={app.conn !== "open"}>
                <div class="banner" role="status">
                    <Spinner size={12} /> Not connected · Reconnecting…
                    <button class="link-btn" onClick={() => rpc.reconnectNow()}>
                        Reconnect now
                    </button>
                </div>
            </Show>
            <Show when={app.conn === "open" && app.slowRequest}>
                <div class="banner" role="status">
                    The server is taking a while…
                </div>
            </Show>
        </>
    );
}

export function App() {
    const active = () => handleFor(app.activeId);
    const agent = () => {
        const id = agentFocus();
        return id ? active()?.view.agents.find((a) => a.id === id) : undefined;
    };
    const blocked = () => Boolean(document.querySelector(".dialog-backdrop, .popover"));

    // Another session: its own view, not the last one's sub-agent or review.
    createEffect(
        on(
            () => app.activeId,
            () => {
                setAgentFocus(undefined);
                setReview(undefined);
            },
            { defer: true },
        ),
    );

    // Enter-sends decides what Enter and Mod+Enter are bound to.
    createEffect(() => setEnterSends(prefs.enterSends));

    // What Settings covers stays mounted (lib/cover.ts): focus in it (the composer, say) leaves as Settings opens,
    // so typing there doesn't edit, or Enter send, a prompt out of sight.
    createEffect(on(settingsTab, (tab) => {
        if (!tab) return;
        const focused = document.activeElement as HTMLElement | null;
        if (focused?.closest?.("[data-covered], .keep.covered")) focused.blur();
    }, { defer: true }));

    // The window moves from its top strip and its edges (lib/window-drag.ts).
    onMount(() => {
        if (isTauri) onCleanup(installWindowDrag({ invoke: windowCommand, mac: os === "macos" }));
    });

    // Global shortcuts.
    onMount(() => {
        // Bound keys (the keybindings file over the defaults); Esc's ways out stay on Esc.
        const run: Record<string, (e: KeyboardEvent) => boolean | void> = {
            "app:commandPalette": () => void setPaletteOpen(!paletteOpen()),
            "app:settings": () => void setSettingsTab(settingsTab() ? undefined : "general"),
            "app:newSession": () => void (setSettingsTab(undefined), newSession(app.homeCwd)),
            "app:toggleSidebar": () => void toggleSidebar(),
            "app:togglePanel": () => void togglePanel(),
            // Not while Settings covers the session (it stays mounted under it): they'd act on it out of sight.
            "chat:modelPicker": () => void (!settingsTab() && setModelPickerOpen(true)),
            "chat:focusInput": () => void (!settingsTab() && requestComposerFocus()),
            // Find in the conversation in view (pages not drawn yet included), rather than the page's own find.
            // Nothing under Settings: the page's own find would match the conversation it covers (kept mounted).
            "app:find": () => (active() && !agent() && !settingsTab() ? void openFind() : false),
            "app:previousSession": () => void cycleSession(-1),
            "app:nextSession": () => void cycleSession(1),
        };
        /** Those that work with a dialog open (nothing behind one changes otherwise: it may be about the session in view). */
        const overDialogs = new Set(["app:commandPalette", "app:settings"]);
        const onKey = (e: KeyboardEvent) => {
            const action = actionOf(e, ["Global"]);
            // Most keys are typing: nothing below looks at the page for them.
            if (!action && e.key !== "Escape") return;
            // ⌘F does nothing under Settings, a dialog open or not: the page's own find would match the
            // conversation it covers (kept mounted under it).
            if (action === "app:find" && settingsTab()) return e.preventDefault();
            const dialog = () => document.querySelector(".dialog-backdrop");
            if (action === "app:toggleTerminal") {
                if (!dialog()) e.preventDefault(), setTerminalOpen(!terminalOpen());
                return;
            }
            // The terminal keeps its keys.
            if ((e.target as HTMLElement)?.closest?.(".terminal-emulator")) return;
            if (action && run[action] && !e.defaultPrevented && (overDialogs.has(action) || !dialog())) {
                if (run[action]!(e) !== false) e.preventDefault();
                return;
            }
            if (e.defaultPrevented || blocked()) return;
            const typing = (document.activeElement as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable]");
            if (e.key === "Escape" && !e.ctrlKey && !e.metaKey && !e.altKey) {
                // Esc closes the rail's drawer first.
                if (railOpen()) return e.preventDefault(), setRailOpen(false);
                // Esc leaves Settings, a sub-agent's view and the review.
                if (settingsTab()) return typing ? undefined : (e.preventDefault(), setSettingsTab(undefined));
                // A sub-agent's own goes back to the one it's under.
                if (agent()) return typing ? undefined : (e.preventDefault(), setAgentFocus(agent()!.parentId));
                if (review()) return e.preventDefault(), setReview(undefined);
            }
            // And otherwise interrupts a working session.
            if (action === "app:interrupt" && canStop(active()?.view.state) && !active()?.view.state.interactions.length) {
                e.preventDefault();
                interrupt();
            }
        };
        // The rail's drawer is over the session: Esc closes it, and a request card behind it
        // (which listens first, in the capture phase) doesn't take Esc or its number keys meanwhile.
        // Registered before any card's, so it runs first.
        const drawerKeys = (e: KeyboardEvent) => {
            if (!railOpen() || e.metaKey || e.ctrlKey || e.altKey || blocked()) return;
            if ((e.target as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable]")) return;
            if (e.key === "Escape") {
                e.preventDefault();
                setRailOpen(false);
            } else if (!/^[0-9]$/.test(e.key)) return;
            e.stopImmediatePropagation();
        };
        window.addEventListener("keydown", drawerKeys, true);
        window.addEventListener("keydown", onKey);
        onCleanup(() => {
            window.removeEventListener("keydown", drawerKeys, true);
            window.removeEventListener("keydown", onKey);
        });
        // Highlighting and markdown are ready by the time the first reply arrives.
        setTimeout(warmUp, 1500);
        setTimeout(warmMarkdown, 1500);
    });

    // "(2) Cavvy" while sessions wait for you.
    createEffect(() => {
        const n = attentionCount();
        const title = active()?.view.state.title;
        document.title = `${n ? `(${n}) ` : ""}${title ? `${title} · ` : ""}Cavvy`;
    });

    // The inspector column shows the diff reader while a review is open, else the session's panel.
    const reviewing = () => Boolean(review() && active() && !settingsTab());
    const panelShown = () => Boolean(prefs.panel && active() && !agent() && !settingsTab() && app.opening?.id !== app.activeId);
    const layout = () => shellLayout();
    const drawerOpen = () => layout().railMode === "overlay" && railOpen();
    // The drawer takes focus as it opens, so nothing behind it keeps it.
    createEffect(on(drawerOpen, (open) => {
        if (open) queueMicrotask(() => document.querySelector<HTMLElement>(".win-rail button:not([disabled])")?.focus());
    }, { defer: true }));
    const inspOpen = () => reviewing() || panelShown();
    // Under Settings the inspector's column closes, but what was in it stays mounted (covered), as the session does.
    const reviewKept = () => Boolean(review() && active());
    const panelKept = () => Boolean(prefs.panel && active() && !agent() && app.opening?.id !== app.activeId);
    // The sizes go on the elements that use them, not on .app: a custom property changing on an
    // element restyles everything under it, so on .app each frame of a drag restyled the window.
    // shell.css registers them as not inherited, and nothing takes one with `inherit` (WebKit keeps a
    // stale value there): each element that reads a size has it set here, on itself.
    const railWidth = () => railDrag() ?? prefs.sidebarWidth;
    // The steps of the column's size that its contents' styles read (shell.css .main); none until it's measured.
    const narrow = createMemo(() => (layout().sheet.w ? columnSteps(layout().column.w, COLUMN_NARROW) : undefined));
    const short = createMemo(() => (layout().sheet.h ? columnSteps(layout().column.h, COLUMN_SHORT) : undefined));

    return (
        <div
            class={`app ${isTauri ? `tauri os-${os}` : "browser"} ${prefs.sidebar ? "" : "rail-off"}`}
            data-rail={layout().railMode === "overlay" ? "overlay" : "docked"}
            data-railopen={layout().railMode === "overlay" && layout().railShown ? "on" : "off"}
            data-insp={inspOpen() ? "on" : "off"}
            data-inspmode={layout().inspector.mode}
            data-inspshort={layout().inspector.short ? "on" : "off"}
            data-term={layout().terminal.shown ? "on" : "off"}
            data-tmax={layout().terminal.maximized ? "on" : "off"}
            data-settings={settingsTab() ? "on" : "off"}
        >
            <Show when={app.conn === "open" || app.hello} fallback={<Disconnected />}>
                <div class="win" style={{ "--rail-w": `${railWidth()}px` }}>
                    {/* The window's edges move it, under the rail and the sheet (and so does its whole top strip: lib/window-drag.ts). */}
                    <div class="win-drag" data-window-drag />
                    <div class="rail-scrim" aria-hidden="true" onClick={() => setRailOpen(false)} />
                    {/* The rail sits straight on the window glass; in narrow windows it's a drawer over the sheet. */}
                    <div class="win-rail" inert={!layout().railShown} style={{ "--rail-w": `${railWidth()}px` }}>
                        <Show when={prefs.sidebar || layout().railMode === "overlay"}>
                            <div class="settings-host">
                                <Show when={settingsTab()}>
                                    <SettingsNav />
                                </Show>
                            </div>
                            {/* Kept under Settings, hidden, so coming back doesn't build the rail again. */}
                            <div class="keep" classList={{ covered: !!settingsTab() }}>
                                <Sidebar />
                            </div>
                        </Show>
                    </div>
                    {/* One opaque sheet: the conversation | the inspector, and the terminal under both. */}
                    {/* Behind the open drawer the sheet takes no focus, clicks or keys (Enter on a focused Allow, say). */}
                    <div
                        class="sheet"
                        inert={drawerOpen()}
                        style={{
                            "--insp-col": inspOpen() && layout().inspector.mode === "dock" ? `${layout().inspector.width}px` : "0px",
                            "--term-h": `${layout().terminal.height}px`,
                        }}
                    >
                        <main class="main" data-narrow={narrow()} data-short={short()}>
                            <Reconnecting />
                            {/* In a box of its own: adding or removing it beside the session would restyle all of it. */}
                            <div class="settings-host">
                                <Show when={settingsTab()}>
                                    <RenderBoundary>
                                        <SettingsPage />
                                    </RenderBoundary>
                                    <ErrorCards place="settings" />
                                </Show>
                            </div>
                            {/* What the settings page covers stays mounted and laid out under it: coming back shows it
                                as it was (scrolled where it was, nothing to build, lay out or fetch again). See lib/cover.ts. */}
                            <div class="keep" data-covered={settingsTab() ? "" : undefined} aria-hidden={settingsTab() ? "true" : undefined} onFocusIn={skipCovered}>
                                <RenderBoundary resetKey={() => `${app.activeId}:${agentFocus()}`}>
                                    <Switch
                                        fallback={
                                            <>
                                                <Header />
                                                <Home />
                                            </>
                                        }
                                    >
                                        <Match when={app.opening?.id === app.activeId && app.opening}>
                                            {(opening) => <>
                                                <Header />
                                                <div class="session-opening" aria-busy={!opening().error}>
                                                    <Show when={opening().error} fallback={<Show when={opening().visible}><div role="status"><Spinner size={16} /> Opening session…</div><div class="session-skeleton" aria-hidden="true"><i /><i /><i /></div></Show>}>
                                                        <p role="alert" class="selectable">Couldn't open this session: {opening().error}</p>
                                                        <button class="ghost-btn" disabled={app.conn !== "open"} onClick={() => void activate(opening().id)}>Retry opening session</button>
                                                    </Show>
                                                </div>
                                            </>}
                                        </Match>
                                        <Match when={active() && agent()}>
                                            <AgentView handle={active()!} agent={agent()!} />
                                        </Match>
                                        <Match when={active()} keyed>
                                            {(h) => <SessionView handle={h} />}
                                        </Match>
                                        <Match when={app.activeId}>
                                            <Header />
                                            <div class="home-wait">
                                                <p class="muted" role="status">Waiting to reopen your session…</p>
                                                <button class="ghost-btn" disabled={app.conn !== "open"} onClick={() => void restoreActiveSession()}>Retry opening session</button>
                                            </div>
                                        </Match>
                                    </Switch>
                                </RenderBoundary>
                            </div>
                        </main>
                        <div class="insp" data-covered={settingsTab() ? "" : undefined} aria-hidden={settingsTab() ? "true" : undefined} onFocusIn={skipCovered} style={{ "--insp-w": `${layout().inspector.width}px`, "--insp-bottom": `${layout().inspector.bottom}px` }}>
                            <Show when={panelShown() && !reviewing() && layout().inspector.mode === "dock"}>
                                <InspectorResizer />
                            </Show>
                            <Show
                                when={reviewKept()}
                                fallback={
                                    <Show when={panelKept() && active()} keyed>
                                        {(h) => <RenderBoundary resetKey={() => app.activeId}><RightPanel handle={h} /></RenderBoundary>}
                                    </Show>
                                }
                            >
                                <RenderBoundary resetKey={() => app.activeId}><ReviewPane handle={active()!} /></RenderBoundary>
                            </Show>
                        </div>
                        <RenderBoundary><TerminalPanel cwd={active()?.view.state.cwd ?? app.homeCwd} hidden={!!settingsTab()} /></RenderBoundary>
                    </div>
                </div>
                <LayoutKeeper panel={panelShown()} review={reviewing()} />
            </Show>
            <CommandPalette />
            <RewindDialog />
            <McpDialog />
            <FolderPicker />
            <TrustDialog />
            <PlanDialogs />
            <ArchiveDialog />
            <RunSheet />
            <DeleteSessionDialog />
            <CommitDialog />
            <ImageViewer />
            <Toasts />
            {/* Errors' last resort: shows only when none of the places above is on screen (ErrorCards.tsx). */}
            <ErrorCards place="window" />
        </div>
    );
}
