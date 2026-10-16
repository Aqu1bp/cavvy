// "Continue a Claude Code or Codex session": conversations started in a
// terminal in this project, to carry on here. Importing opens a Harness
// session on the same backend; one already in Harness just opens.

import { createResource, createSignal, For, Show } from "solid-js";
import { AlertTriangle, ChevronRight, SquareTerminal } from "lucide-solid";
import type { CliSessionInfo } from "@shared/protocol";
import { app, rpc } from "../state/app";
import { continueCliSession } from "../state/actions";
import { setSettingsTab } from "../state/ui";
import { ago } from "../lib/format";
import { now } from "../lib/clock";

export function CliSessions(p: { cwd: string }) {
    const [open, setOpen] = createSignal(false);
    const [showHeld, setShowHeld] = createSignal(false);
    const [busy, setBusy] = createSignal<string>();
    const [list, { refetch }] = createResource(
        () => app.conn === "open" && p.cwd,
        (cwd) => rpc.call("cliSessions.list", { cwd }).catch(() => undefined),
    );
    const sessions = () => list()?.sessions ?? [];
    // Ones already in Harness are folded into a line of their own, after the rest.
    const fresh = () => sessions().filter((s) => !s.harnessId);
    const held = () => sessions().filter((s) => s.harnessId);
    const heldCount = () => held().length + (list()?.sources ?? []).reduce((n, s) => n + s.moreInHarness, 0);
    const source = (s: CliSessionInfo) => list()?.sources.find((x) => x.source === s.source);
    const more = () => (list()?.sources ?? []).filter((s) => s.more > 0);

    const go = async (s: CliSessionInfo) => {
        setBusy(s.id);
        const ok = await continueCliSession(p.cwd, s);
        setBusy(undefined);
        if (!ok) void refetch();
    };

    const row = (s: CliSessionInfo) => (
        <li class="cli-row">
            <div class="cli-main">
                <div class="cli-title">
                    <span class={`cli-source ${s.source}`}>{source(s)?.name ?? s.source}</span>
                    <span class="truncate">{s.title}</span>
                </div>
                <div class="muted small cli-meta">
                    {(now(), ago(s.updatedAt))} · {s.messages}
                    {s.partial ? "+" : ""} {s.messages === 1 && !s.partial ? "message" : "messages"}
                    <Show when={s.model}> · <span class="mono">{s.model}</span></Show>
                </div>
                <Show when={s.recent && !s.harnessId}>
                    <div class="cli-warn small">
                        <AlertTriangle size={12} />
                        This session may still be open in a terminal; using it in both places at once mixes the two.
                    </div>
                </Show>
            </div>
            <Show
                when={s.harnessId || source(s)?.enabled}
                fallback={
                    <button class="link-btn small cli-off" onClick={() => setSettingsTab("providers")}>
                        Turn on {source(s)?.name ?? s.source} in Settings → Providers
                    </button>
                }
            >
                <button class={`btn sm ${s.harnessId ? "secondary" : "primary"}`} disabled={busy() === s.id} onClick={() => void go(s)}>
                    {s.harnessId ? "In Harness · Open" : busy() === s.id ? "Importing…" : "Import"}
                </button>
            </Show>
        </li>
    );

    return (
        <Show when={sessions().length}>
            <section class="cli-sessions">
                <button class="cli-head" aria-expanded={open()} onClick={() => { setOpen(!open()); if (!open()) return; void refetch(); }}>
                    <SquareTerminal size={15} />
                    <span>Continue a Claude Code or Codex session</span>
                    <span class="muted small">{fresh().length}</span>
                    <span class="grow" />
                    <ChevronRight size={14} class={`chv ${open() ? "open" : ""}`} />
                </button>
                <Show when={open()}>
                    <ul class="cli-list">
                        <For each={fresh()}>{row}</For>
                        <Show when={heldCount()}>
                            <li class="cli-row cli-fold">
                                <button class="link-btn small" aria-expanded={showHeld()} onClick={() => setShowHeld(!showHeld())}>
                                    {heldCount()} already in Harness · {showHeld() ? "hide" : "show"}
                                </button>
                            </li>
                            <Show when={showHeld()}>
                                <For each={held()}>{row}</For>
                            </Show>
                        </Show>
                    </ul>
                    <For each={more()}>{(m) => <div class="muted small cli-more">{m.more} more {m.name} {m.more === 1 ? "session" : "sessions"} not shown</div>}</For>
                </Show>
            </section>
        </Show>
    );
}
