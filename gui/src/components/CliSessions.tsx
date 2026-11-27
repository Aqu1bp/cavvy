// "Continue from your terminal": Claude Code and Codex conversations started in a
// terminal in this project, to carry on here. Home lists the newest few not already
// in Cavvy; "Show all" lists every one of those. Importing opens a Cavvy session on
// the same backend.

import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import type { CliSessionInfo } from "@shared/protocol";
import { app, rpc } from "../state/app";
import { continueCliSession } from "../state/actions";
import { cliListedBefore, listCli } from "../state/home-ahead";
import { setSettingsTab } from "../state/ui";
import { ago, basename } from "../lib/format";
import { now } from "../lib/clock";
import { Dialog } from "./ui/Dialog";
import { ProviderIcon } from "./ui/ProviderIcon";

/** Using it here and in the terminal at once mixes the two: said wherever one still open shows. */
const STILL_OPEN = "Using it here and in the terminal at once mixes the two.";

/** "6m ago", "just now"; an older one by its date. */
const agoText = (at: number) => {
    const t = ago(at);
    return t === "now" ? "just now" : /^\d+[mhd]$/.test(t) ? `${t} ago` : t;
};

/**
 * `rows`: how many Home has room for (3 at most); `onShown`: how many it shows, and whether the section shows at all
 * (with no room for a row it's still there, its heading and Show all, so what's to import stays reachable).
 */
export function CliSessions(p: { cwd: string; rows?: number; onShown?: (rows: number, section: boolean) => void }) {
    const [all, setAll] = createSignal(false);
    const [busy, setBusy] = createSignal<string>();
    const [list, { refetch, mutate }] = createResource(
        () => app.conn === "open" && p.cwd,
        (cwd) => {
            const fresh = listCli(rpc, cwd).catch(() => undefined);
            // Listed before Home came here (state/home-ahead.ts): shown with the folder, and replaced by what's listed now.
            const before = cliListedBefore(cwd);
            if (!before) return fresh;
            void fresh.then((r) => r && p.cwd === cwd && mutate(r));
            return before;
        },
    );
    const sessions = () => list()?.sessions ?? [];
    // Ones already in Cavvy aren't offered: they're in the sidebar.
    const fresh = () => sessions().filter((s) => !s.cavvyId).sort((a, b) => b.updatedAt - a.updatedAt);
    const source = (s: CliSessionInfo) => list()?.sources.find((x) => x.source === s.source);
    const name = (s: CliSessionInfo) => source(s)?.name ?? s.source;
    // Turned on in Settings → Providers: read from the providers, which follow a change made there while Home is up.
    const enabled = (s: CliSessionInfo) => app.providers.find((x) => x.id === s.source)?.configured ?? source(s)?.enabled;
    const more = () => (list()?.sources ?? []).filter((s) => s.more > 0);
    const shown = () => fresh().slice(0, Math.max(0, Math.min(3, p.rows ?? 3)));
    // Worth opening when it lists something these rows don't.
    const hasMore = () => fresh().length > shown().length || more().length > 0;
    createEffect(() => p.onShown?.(shown().length, fresh().length > 0));

    const go = async (s: CliSessionInfo) => {
        if (busy()) return;
        setBusy(s.id);
        const ok = await continueCliSession(p.cwd, s);
        setBusy(undefined);
        if (!ok) void refetch();
    };
    /** What a row does: import it, or (its CLI not turned on) go where it's turned on. */
    const act = (s: CliSessionInfo) => {
        setAll(false);
        if (!enabled(s)) setSettingsTab("providers");
        else void go(s);
    };
    const count = (s: CliSessionInfo) => `${s.messages}${s.partial ? "+" : ""} ${s.messages === 1 && !s.partial ? "message" : "messages"}`;
    const turnOn = (s: CliSessionInfo) => `Turn on ${name(s)} in Settings → Providers`;
    const keys = (s: CliSessionInfo) => (e: KeyboardEvent) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        e.preventDefault();
        act(s);
    };

    const row = (s: CliSessionInfo) => (
        <div
            class={`cli-row ${busy() === s.id ? "busy" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={enabled(s) ? `Import “${s.title}” from ${name(s)}` : `${turnOn(s)} to import “${s.title}”`}
            aria-busy={busy() === s.id}
            onClick={() => act(s)}
            onKeyDown={keys(s)}
        >
            <span class="cli-pv"><ProviderIcon id={s.source} name={name(s)} size={16} /></span>
            <span class="cli-main">
                <span class="cli-title truncate">{s.title}</span>
                <span class="cli-meta">
                    {name(s)} · {(now(), agoText(s.updatedAt))} · {count(s)}
                    <Show when={s.recent}> · <span class="cli-live" title={STILL_OPEN}>Still open in a terminal</span></Show>
                </span>
            </span>
            <Show when={enabled(s)} fallback={<span class="cli-off">Turn on in Settings</span>}>
                <span class="cli-go">{busy() === s.id ? "Importing…" : "Import"}</span>
            </Show>
        </div>
    );

    /** A row of "Show all". */
    const item = (s: CliSessionInfo) => (
        <button class="cl-item" disabled={busy() === s.id} title={s.recent ? STILL_OPEN : undefined} onClick={() => act(s)}>
            <span class="cli-pv"><ProviderIcon id={s.source} name={name(s)} size={16} /></span>
            <span class="cl-main">
                <span class="truncate">{s.title}</span>
                <span class="cli-meta">
                    {name(s)} · {(now(), agoText(s.updatedAt))} · {count(s)}
                    <Show when={s.recent}> · <span class="cli-live">Still open in a terminal</span></Show>
                </span>
            </span>
            <span class="cl-act">{enabled(s) ? "Import" : "Turn on in Settings"}</span>
        </button>
    );
    const sourceNames = () => [...new Set((list()?.sources ?? []).map((s) => s.name))].join(" and ") || "Claude Code and Codex";

    return (
        <>
            <Show when={fresh().length}>
            <section class="cli-sessions" aria-label="Continue from your terminal">
                <div class="cli-h">
                    <span>Continue from your terminal</span>
                    <span class="grow" />
                    <Show when={hasMore()}>
                        <button class="cli-all" onClick={() => { setAll(true); void refetch(); }}>Show all {fresh().length}</button>
                    </Show>
                </div>
                <Show when={shown().length}>
                    <div class="cli-rows">
                        <For each={shown()}>{row}</For>
                    </div>
                </Show>
            </section>
            </Show>
            {/* Outside the section: open, it stays while the list reloads (or fails to). */}
            <Dialog open={all()} onClose={() => setAll(false)} title="Continue from your terminal" width={520} class="cli-dialog" footer={<button class="btn secondary" onClick={() => setAll(false)}>Done</button>}>
                <p>{sourceNames()} sessions started in {basename(p.cwd)}.</p>
                <div class="cl-list">
                    <Show when={list.loading || sessions().length}>
                        <For each={fresh()}>{item}</For>
                    </Show>
                    <Show when={!list.loading && !sessions().length}>
                        <div class="cl-note">Couldn't list the sessions from your terminal just now.</div>
                    </Show>
                    <For each={more()}>{(m) => <div class="cl-note">{m.more} more {m.name} {m.more === 1 ? "session" : "sessions"} not shown</div>}</For>
                </div>
            </Dialog>
        </>
    );
}
