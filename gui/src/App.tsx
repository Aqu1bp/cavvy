import { createEffect, For, Match, onCleanup, onMount, Show, Switch } from "solid-js";
import { AlertCircle, CheckCircle2, Info, PlugZap, X } from "lucide-solid";
import { app, attentionCount, dismissToast, handleFor, toasts } from "./state/app";
import { cycleSession, interrupt, newSession, togglePanel, toggleSidebar } from "./state/actions";
import { prefs } from "./state/prefs";
import { paletteOpen, requestComposerFocus, setModelPickerOpen, setPaletteOpen, setSettingsTab, settingsTab } from "./state/ui";
import { isMod, isTauri, os } from "./lib/platform";
import { warmUp } from "./lib/highlight";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { Transcript } from "./components/Transcript";
import { Composer } from "./components/Composer";
import { InteractionDock } from "./components/InteractionDock";
import { AgentsBar } from "./components/Agents";
import { RightPanel } from "./components/RightPanel";
import { Home } from "./components/Home";
import { CommandPalette } from "./components/CommandPalette";
import { SettingsDialog } from "./components/SettingsDialog";
import { RewindDialog } from "./components/RewindDialog";
import { FolderPicker } from "./components/FolderPicker";
import { TrustDialog } from "./components/TrustDialog";
import { Logo, Spinner } from "./components/ui/bits";

function Toasts() {
    return (
        <div class="toasts" role="status" aria-live="polite">
            <For each={toasts}>
                {(t) => (
                    <div class={`toast ${t.level}`}>
                        <Switch fallback={<Info size={15} />}>
                            <Match when={t.level === "error"}>
                                <AlertCircle size={15} />
                            </Match>
                            <Match when={t.level === "success"}>
                                <CheckCircle2 size={15} />
                            </Match>
                        </Switch>
                        <span class="toast-msg">{t.message}</span>
                        <Show when={t.action}>
                            <button
                                class="link-btn"
                                onClick={() => {
                                    t.action!.run();
                                    dismissToast(t.id);
                                }}
                            >
                                {t.action!.label}
                            </button>
                        </Show>
                        <button class="icon-btn" onClick={() => dismissToast(t.id)} aria-label="Dismiss">
                            <X size={13} />
                        </button>
                    </div>
                )}
            </For>
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
        </div>
    );
}

export function App() {
    const active = () => handleFor(app.activeId);

    // Global shortcuts.
    onMount(() => {
        const onKey = (e: KeyboardEvent) => {
            if (isMod(e) && !e.altKey) {
                const k = e.key.toLowerCase();
                if (k === "k") return e.preventDefault(), setPaletteOpen(!paletteOpen());
                if (k === ",") return e.preventDefault(), setSettingsTab(settingsTab() ? undefined : "general");
                // Nothing behind an open dialog changes (it may be about the session in view).
                if (document.querySelector(".dialog-backdrop")) return;
                if (k === "n" && !e.shiftKey) return e.preventDefault(), newSession(app.homeCwd);
                if (k === "b") return e.preventDefault(), toggleSidebar();
                if (k === ".") return e.preventDefault(), togglePanel();
                if (k === "/") return e.preventDefault(), setModelPickerOpen(true);
                if (k === "l") return e.preventDefault(), requestComposerFocus();
                if (k === "[" || (e.altKey && k === "arrowup")) return e.preventDefault(), cycleSession(-1);
                if (k === "]" || (e.altKey && k === "arrowdown")) return e.preventDefault(), cycleSession(1);
            }
            // Esc anywhere interrupts a working session (when nothing else wants it).
            if (e.key === "Escape" && !e.defaultPrevented && active()?.view.state.busy && !active()?.view.state.interactions.length && !document.querySelector(".dialog-backdrop, .popover")) {
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
        <div class={`app ${prefs.sidebar ? "" : "no-sidebar"} ${prefs.panel && active() ? "with-panel" : ""} ${isTauri ? `tauri os-${os}` : "browser"}`}>
            <Show when={app.conn === "open" || app.hello} fallback={<Disconnected />}>
                <Show when={prefs.sidebar}>
                    <Sidebar />
                </Show>
                <main class="main">
                    <Header handle={active()} />
                    <Show when={app.conn !== "open"}>
                        <div class="banner">
                            <Spinner size={12} /> Reconnecting…
                        </div>
                    </Show>
                    <Show when={active()} fallback={<Home />} keyed>
                        {(h) => (
                            <div class="session">
                                <Transcript handle={h} />
                                <div class="bottom">
                                    <div class="bottom-col">
                                        <InteractionDock sessionId={h.id} items={h.view.state.interactions} />
                                        <AgentsBar handle={h} />
                                        <Composer sessionId={h.id} />
                                    </div>
                                </div>
                            </div>
                        )}
                    </Show>
                </main>
                <Show when={prefs.panel && active()}>
                    <RightPanel handle={active()!} />
                </Show>
            </Show>
            <CommandPalette />
            <SettingsDialog />
            <RewindDialog />
            <FolderPicker />
            <TrustDialog />
            <Toasts />
        </div>
    );
}
