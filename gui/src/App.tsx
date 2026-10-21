import { RenderBoundary } from "./components/ui/ErrorBoundary";
import { createEffect, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { AlertCircle, CheckCircle2, Info, PlugZap, X } from "lucide-solid";
import { activate, app, attentionCount, dismissToast, handleFor, pauseToast, restoreActiveSession, rpc, runToastChoice, toast, toasts, type Toast, type SessionHandle } from "./state/app";
import { cycleSession, interrupt, newSession, togglePanel, toggleSidebar } from "./state/actions";
import { prefs } from "./state/prefs";
import { agentFocus, paletteOpen, requestComposerFocus, review, setAgentFocus, setModelPickerOpen, setPaletteOpen, setReview, setSettingsTab, settingsTab } from "./state/ui";
import { copyText, isTauri, os } from "./lib/platform";
import { canStop } from "./lib/session-status";
import { actionOf, setEnterSends } from "./state/keybindings";
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

/** A session: the conversation, the composer floating over its end, and the panel card. */
function SessionView(p: { handle: SessionHandle }) {
    let stage: HTMLDivElement | undefined;
    // The card steps aside while the review pane is open.
    const panel = () => prefs.panel && !review();
    let dock: HTMLDivElement | undefined;
    onMount(() => {
        // The transcript scrolls under the composer; it keeps that much room at its end.
        const ro = new ResizeObserver(() => stage?.style.setProperty("--dock-h", `${dock?.offsetHeight ?? 0}px`));
        if (dock) ro.observe(dock);
        onCleanup(() => ro.disconnect());
    });
    return (
        <>
            <Header handle={p.handle} />
            <div ref={stage} class={`stage ${panel() ? "with-panel" : ""}`}>
                <Transcript handle={p.handle} />
                <div class="composer-dock" ref={dock}>
                    <div class="composer-col">
                        <Composer sessionId={p.handle.id} />
                    </div>
                </div>
                <Show when={panel()}>
                    <RightPanel handle={p.handle} />
                </Show>
            </div>
        </>
    );
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
        window.addEventListener("keydown", onKey);
        onCleanup(() => window.removeEventListener("keydown", onKey));
        // Highlighting is ready by the time the first reply arrives.
        setTimeout(warmUp, 1500);
    });

    // "(2) Harness" while sessions wait for you.
    createEffect(() => {
        const n = attentionCount();
        const title = active()?.view.state.title;
        document.title = `${n ? `(${n}) ` : ""}${title ? `${title} · ` : ""}Harness`;
    });

    return (
        <div class={`app ${prefs.sidebar ? "" : "no-sidebar"} ${isTauri ? `tauri os-${os}` : "browser"}`}>
            <Show when={app.conn === "open" || app.hello} fallback={<Disconnected />}>
                <Show when={prefs.sidebar}>
                    <Show when={settingsTab()} fallback={<Sidebar />}>
                        <SettingsNav />
                    </Show>
                </Show>
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
                                            <p role="alert">Couldn't open this session: {opening().error}</p>
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
                                <div class="home">
                                    <div class="home-inner">
                                        <p class="muted" role="status">Waiting to reopen your session…</p>
                                        <button class="ghost-btn" disabled={app.conn !== "open"} onClick={() => void restoreActiveSession()}>Retry opening session</button>
                                    </div>
                                </div>
                            </Match>
                        </Switch>
                    </RenderBoundary>
                    <RenderBoundary><TerminalPanel cwd={active()?.view.state.cwd ?? app.homeCwd} hidden={!!settingsTab()} /></RenderBoundary>
                </main>
                <Show when={review() && active() && !settingsTab()}>
                    <RenderBoundary resetKey={() => app.activeId}><ReviewPane handle={active()!} /></RenderBoundary>
                </Show>
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
