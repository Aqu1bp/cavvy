import { RenderBoundary } from "./components/ui/ErrorBoundary";
import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { AlertCircle, CheckCircle2, Info, PlugZap, X } from "lucide-solid";
import { activate, app, attentionCount, dismissToast, handleFor, pauseToast, restoreActiveSession, rpc, runToastChoice, toast, toasts, type Toast, type SessionHandle } from "./state/app";
import { cycleSession, interrupt, newSession, togglePanel, toggleSidebar } from "./state/actions";
import { prefs, setPrefs } from "./state/prefs";
import { agentFocus, dockHeight, inspectorWidth, paletteOpen, railOpen, requestComposerFocus, review, reviewSplit, setAgentFocus, setDockHeight, setInspectorWidth, setModelPickerOpen, setPaletteOpen, setRailOpen, setReview, setSettingsTab, setShellLayout, settingsTab, shellLayout, terminalMax, terminalShown } from "./state/ui";
import { copyText, isTauri, os } from "./lib/platform";
import { canStop } from "./lib/session-status";
import { actionOf, setEnterSends } from "./state/keybindings";
import { clampInspectorWidth, closesOnShrink, requestCloses, INSPECTOR_DEFAULT, windowLayout } from "./lib/layout";
import { warmUp } from "./lib/highlight";
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

function ToastItem(p: { toast: Toast }) {
    const t = () => p.toast;
    onCleanup(() => {
        // Failed actions move to the alert region, replacing their old DOM node.
        pauseToast(t().id, "hover", false);
        pauseToast(t().id, "focus", false);
    });
    return (
        <div
            class={`toast ${t().level}`}
            onPointerEnter={() => pauseToast(t().id, "hover", true)}
            onPointerLeave={() => pauseToast(t().id, "hover", false)}
            onFocusIn={() => pauseToast(t().id, "focus", true)}
            onFocusOut={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node | null)) pauseToast(t().id, "focus", false);
            }}
        >
            <Switch fallback={<Info size={15} />}>
                <Match when={t().level === "error"}>
                    <AlertCircle size={15} />
                </Match>
                <Match when={t().level === "success"}>
                    <CheckCircle2 size={15} />
                </Match>
            </Switch>
            <span class="toast-msg" title={t().message}>
                {t().message}
            </span>
            <Show when={t().count > 1}>
                <span class="toast-count">({t().count} times)</span>
            </Show>
            <For each={[...(t().action ? [t().action!] : []), ...(t().additionalActions ?? [])]}>
                {(action, index) => (
                    <button
                        class="link-btn"
                        disabled={t().running}
                        onClick={() => void runToastChoice(t().id, index())}
                    >
                        {action.label}
                    </button>
                )}
            </For>
            <Show when={t().level === "error"}>
                <button
                    class="link-btn"
                    onClick={async () => {
                        const copied = await copyText(t().message);
                        toast(copied ? "Copied error" : "Couldn't copy error", copied ? "success" : "info");
                    }}
                >
                    Copy
                </button>
            </Show>
            <button class="icon-btn" onClick={() => dismissToast(t().id)} aria-label="Dismiss">
                <X size={13} />
            </button>
        </div>
    );
}

function Toasts() {
    return (
        <div class="toasts">
            <div class="toast-region" role="alert" aria-live="assertive" aria-relevant="additions text">
                <For each={toasts.filter((t) => t.level === "error")}>{(t) => <ToastItem toast={t} />}</For>
            </div>
            <div class="toast-region" role="status" aria-live="polite" aria-relevant="additions text">
                <For each={toasts.filter((t) => t.level !== "error")}>{(t) => <ToastItem toast={t} />}</For>
            </div>
        </div>
    );
}

function Disconnected() {
    return (
        <div class="splash">
            <Switch
                fallback={
                    <>
                        <Logo size={44} />
                        <Spinner size={18} />
                        <div class="muted">{app.conn === "reconnecting" ? "Reconnecting to the harness server…" : "Starting…"}</div>
                    </>
                }
            >
                <Match when={app.conn === "unauthorized"}>
                    <Logo size={44} />
                    <h2>Open Harness from your terminal</h2>
                    <p class="muted">
                        Run <code>harness gui</code> and use the link it opens or prints. Links work once, so this page can't reconnect on its own.
                    </p>
                </Match>
                <Match when={app.conn === "unavailable"}>
                    <PlugZap size={36} class="tone-warn" />
                    <h2>Can't reach the harness server</h2>
                    <p class="muted">{isTauri ? "The background process stopped. Quit and reopen the app." : "Is `harness gui` still running? Still trying to reconnect…"}</p>
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
    let stage: HTMLDivElement | undefined;
    let dock: HTMLDivElement | undefined;
    onMount(() => {
        // The transcript scrolls under the composer and keeps that much room at its end;
        // a floating inspector ends above it.
        const ro = new ResizeObserver(() => {
            const h = dock?.offsetHeight ?? 0;
            stage?.style.setProperty("--dock-h", `${h}px`);
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
            <div ref={stage} class="stage">
                <Transcript handle={p.handle} />
                <div class="composer-dock" ref={dock}>
                    <div class="composer-col">
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
    const set = (w: number) => setInspectorWidth(clampInspectorWidth(w, shellLayout().sheet.w));
    const start = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        const x = e.clientX;
        const from = shellLayout().inspector.width;
        setDragging(true);
        document.body.classList.add("resizing");
        const move = (ev: PointerEvent) => set(from - (ev.clientX - x));
        const end = () => {
            setDragging(false);
            document.body.classList.remove("resizing");
            target.removeEventListener("pointermove", move);
            target.removeEventListener("lostpointercapture", end);
        };
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

const INSPECTOR_KEY = "harness.inspectorWidth";

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

    const layout = createMemo(() => windowLayout({
        win: win(),
        rail: prefs.sidebar,
        railOpen: railOpen(),
        railWidth: prefs.sidebarWidth,
        panel: p.panel,
        review: p.review,
        split: reviewSplit(),
        reviewBase: prefs.reviewWidth,
        inspectorWidth: inspectorWidth(),
        terminalShown: terminalShown(),
        terminalPreferred: prefs.terminalHeight,
        terminalMax: terminalMax(),
        dock: dockHeight(),
    }));
    createEffect(() => setShellLayout(layout()));

    // Shrinking the window past the docking point closes a docked inspector (the diff reader floats instead).
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

    // Global shortcuts.
    onMount(() => {
        // Bound keys (the keybindings file over the defaults); Esc's ways out stay on Esc.
        const run: Record<string, (e: KeyboardEvent) => boolean | void> = {
            "app:commandPalette": () => void setPaletteOpen(!paletteOpen()),
            "app:settings": () => void setSettingsTab(settingsTab() ? undefined : "general"),
            "app:newSession": () => void (setSettingsTab(undefined), newSession(app.homeCwd)),
            "app:toggleSidebar": () => void toggleSidebar(),
            "app:togglePanel": () => void togglePanel(),
            "chat:modelPicker": () => void setModelPickerOpen(true),
            "chat:focusInput": () => void requestComposerFocus(),
            // Find in the conversation in view (pages not drawn yet included), rather than the page's own find.
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
        // Highlighting is ready by the time the first reply arrives.
        setTimeout(warmUp, 1500);
    });

    // "(2) Harness" while sessions wait for you.
    createEffect(() => {
        const n = attentionCount();
        const title = active()?.view.state.title;
        document.title = `${n ? `(${n}) ` : ""}${title ? `${title} · ` : ""}Harness`;
    });

    // The inspector column shows the diff reader while a review is open, else the session's panel.
    const reviewing = () => Boolean(review() && active() && !settingsTab());
    const panelShown = () => Boolean(prefs.panel && active() && !agent() && !settingsTab() && app.opening?.id !== app.activeId);
    const layout = () => shellLayout();
    const inspOpen = () => reviewing() || panelShown();

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
            style={{
                "--insp-w": `${layout().inspector.width}px`,
                "--insp-col": inspOpen() && layout().inspector.mode === "dock" ? `${layout().inspector.width}px` : "0px",
                "--insp-bottom": `${layout().inspector.bottom}px`,
                "--term-h": `${layout().terminal.height}px`,
            }}
        >
            <Show when={app.conn === "open" || app.hello} fallback={<Disconnected />}>
                <div class="win">
                    {/* The window's edges drag it, under the rail and the sheet (the rail's top and the title bar drag too). */}
                    <div class="win-drag" data-tauri-drag-region />
                    <div class="rail-scrim" aria-hidden="true" onClick={() => setRailOpen(false)} />
                    {/* The rail sits straight on the window glass; in narrow windows it's a drawer over the sheet. */}
                    <div class="win-rail" inert={!layout().railShown}>
                        <Show when={prefs.sidebar || layout().railMode === "overlay"}>
                            <Show when={settingsTab()} fallback={<Sidebar />}>
                                <SettingsNav />
                            </Show>
                        </Show>
                    </div>
                    {/* One opaque sheet: the conversation | the inspector, and the terminal under both. */}
                    <div class="sheet">
                        <main class="main">
                            <Reconnecting />
                            <RenderBoundary resetKey={() => `${app.activeId}:${settingsTab()}:${agentFocus()}`}>
                                <Switch
                                    fallback={
                                        <>
                                            <Header />
                                            <Home />
                                        </>
                                    }
                                >
                                    <Match when={settingsTab()}>
                                        <SettingsPage />
                                    </Match>
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
                        </main>
                        <div class="insp">
                            <Show when={panelShown() && !reviewing() && layout().inspector.mode === "dock"}>
                                <InspectorResizer />
                            </Show>
                            <Show
                                when={reviewing()}
                                fallback={
                                    <Show when={panelShown() && active()} keyed>
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
        </div>
    );
}
