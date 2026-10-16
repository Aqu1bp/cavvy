import { createEffect, For, Match, on, onCleanup, onMount, Show, Switch } from "solid-js";
import { AlertCircle, CheckCircle2, Info, PlugZap, X } from "lucide-solid";
import { app, attentionCount, dismissToast, handleFor, pauseToast, rpc, runToastAction, toast, toasts, type Toast, type SessionHandle } from "./state/app";
import { cycleSession, interrupt, newSession, togglePanel, toggleSidebar } from "./state/actions";
import { prefs } from "./state/prefs";
import { agentFocus, paletteOpen, requestComposerFocus, review, setAgentFocus, setModelPickerOpen, setPaletteOpen, setReview, setSettingsTab, settingsTab } from "./state/ui";
import { copyText, isMod, isTauri, isTerminalToggle, os } from "./lib/platform";
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
import { DeleteSessionDialog } from "./components/DeleteSessionDialog";
import { CommitDialog } from "./components/CommitDialog";
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
            <Show when={t().action}>
                <button
                    class="link-btn"
                    disabled={t().running}
                    onClick={() => void runToastAction(t().id)}
                >
                    {t().action!.label}
                </button>
            </Show>
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

    // Global shortcuts.
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isTerminalToggle(e) && !document.querySelector(".dialog-backdrop")) return e.preventDefault(), setTerminalOpen(!terminalOpen());
            if (isMod(e) && !e.altKey) {
                const k = e.key.toLowerCase();
                if ((e.target as HTMLElement)?.closest(".terminal-emulator")) return;
                if (k === "k") return e.preventDefault(), setPaletteOpen(!paletteOpen());
                if (k === ",") return e.preventDefault(), setSettingsTab(settingsTab() ? undefined : "general");
                // Nothing behind an open dialog changes (it may be about the session in view).
                if (document.querySelector(".dialog-backdrop")) return;
                if (k === "n" && !e.shiftKey) return e.preventDefault(), setSettingsTab(undefined), newSession(app.homeCwd);
                if (k === "b") return e.preventDefault(), toggleSidebar();
                if (k === ".") return e.preventDefault(), togglePanel();
                if (k === "/") return e.preventDefault(), setModelPickerOpen(true);
                if (k === "l") return e.preventDefault(), requestComposerFocus();
                // Find in the conversation in view (pages not drawn yet included), rather than the page's own find.
                if (k === "f" && !e.shiftKey && active() && !agent() && !settingsTab()) return e.preventDefault(), openFind();
                if (k === "[" || (e.altKey && k === "arrowup")) return e.preventDefault(), cycleSession(-1);
                if (k === "]" || (e.altKey && k === "arrowdown")) return e.preventDefault(), cycleSession(1);
            }
            if ((e.target as HTMLElement)?.closest(".terminal-emulator")) return;
            if (e.key !== "Escape" || e.defaultPrevented || blocked()) return;
            const typing = (document.activeElement as HTMLElement | null)?.matches?.("input, textarea, select, [contenteditable]");
            // Esc leaves Settings, a sub-agent's view and the review, and otherwise interrupts a working session.
            if (settingsTab()) return typing ? undefined : (e.preventDefault(), setSettingsTab(undefined));
            // A sub-agent's own goes back to the one it's under.
            if (agent()) return typing ? undefined : (e.preventDefault(), setAgentFocus(agent()!.parentId));
            if (review()) return e.preventDefault(), setReview(undefined);
            if (active()?.view.state.busy && !active()?.view.state.interactions.length) interrupt();
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
                        <Match when={active() && agent()}>
                            <AgentView handle={active()!} agent={agent()!} />
                        </Match>
                        <Match when={active()} keyed>
                            {(h) => <SessionView handle={h} />}
                        </Match>
                    </Switch>
                    <TerminalPanel cwd={active()?.view.state.cwd ?? app.homeCwd} hidden={!!settingsTab()} />
                </main>
                <Show when={review() && active() && !settingsTab()}>
                    <ReviewPane handle={active()!} />
                </Show>
            </Show>
            <CommandPalette />
            <RewindDialog />
            <McpDialog />
            <FolderPicker />
            <TrustDialog />
            <DeleteSessionDialog />
            <CommitDialog />
            <Toasts />
        </div>
    );
}
