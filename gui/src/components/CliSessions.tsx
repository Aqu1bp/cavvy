// "Continue from your terminal": Claude Code and Codex conversations started in a
// terminal in this project, to carry on here. Home lists the newest few not already
// in Cavvy; "Show all" lists every one of those. Importing opens a Cavvy session on
// the same backend.

import { createResource, createSignal, For, Show } from "solid-js";
import type { CliSessionInfo } from "@shared/protocol";
import { app, rpc } from "../state/app";
import { continueCliSession } from "../state/actions";
import { cliListedBefore, listCli } from "../state/home-ahead";
import { setSettingsTab } from "../state/ui";
import { ago } from "../lib/format";
import { now } from "../lib/clock";
import { Dialog } from "./ui/Dialog";
import { ProviderIcon } from "./ui/ProviderIcon";

/** Using it here and in the terminal at once mixes the two: said wherever one still open shows. */
const STILL_OPEN = "Using both at once mixes them.";

/** "6m ago", "just now"; an older one by its date. */
const agoText = (at: number) => {
    const t = ago(at);
    return t === "now" ? "just now" : /^\d+[mhd]$/.test(t) ? `${t} ago` : t;
};

/**
 * `rows`: how many Home has room for (3 at most). With no room for a row the card is still there, its heading and
 * Show all, so what's to import stays reachable.
 */
export function CliSessions(p: { cwd: string; rows?: number }) {
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
    const older = () => more().reduce((n, s) => n + s.more, 0);
    const shown = () => fresh().slice(0, Math.max(0, Math.min(3, p.rows ?? 3)));
    // Worth opening when it lists something these rows don't.
    const hasMore = () => fresh().length > shown().length || more().length > 0;

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
            class={`row home-cli-row ${busy() === s.id ? "busy" : ""}`}
            role="button"
            tabIndex={0}
            aria-label={enabled(s) ? `Import “${s.title}” from ${name(s)}` : `${turnOn(s)} to import “${s.title}”`}
            aria-busy={busy() === s.id}
            title={`${name(s)} · ${(now(), agoText(s.updatedAt))} · ${count(s)}`}
            onClick={() => act(s)}
            onKeyDown={keys(s)}
        >
            <ProviderIcon id={s.source} name={name(s)} size={14} />
            <span class="row-text">
                <span class="row-title">{s.title}</span>
                <Show when={s.recent}>
                    <span class="row-sub" title={STILL_OPEN}>Still open in a terminal</span>
                </Show>
            </span>
            <Show when={enabled(s)} fallback={<span class="link-btn">Turn on in Settings</span>}>
                <span class="btn btn-sm">{busy() === s.id ? "Importing…" : "Import"}</span>
            </Show>
        </div>
    );

    /** A row of "Show all": the design's dialog row, its button the action. */
    const item = (s: CliSessionInfo) => (
        <li class="row cli-row" title={`${name(s)} · ${(now(), agoText(s.updatedAt))} · ${count(s)}`}>
            <ProviderIcon id={s.source} name={name(s)} size={15} />
            <span class="row-text">
                <span class="row-title cli-title">{s.title}</span>
                <Show when={busy() === s.id} fallback={<Show when={s.recent}><span class="row-sub" title={STILL_OPEN}>Still open in a terminal</span></Show>}>
                    <span class="row-sub">Importing…</span>
                </Show>
            </span>
            <Show
                when={enabled(s)}
                fallback={
                    <button type="button" class="link-btn" onClick={() => act(s)}>
                        Turn on in Settings
                    </button>
                }
            >
                <button type="button" class="btn btn-sm cli-btn" disabled={busy() === s.id} onClick={() => act(s)}>
                    Import
                </button>
            </Show>
        </li>
    );
    /** Whose sessions they are, as the design says it: "Claude Code and Codex". */
    const names = () => [...new Set(fresh().map(name))].sort().join(" and ") || "Terminal";
    const project = () => p.cwd.replace(/\/+$/, "").split("/").pop() || p.cwd;

    return (
        <>
            <Show when={fresh().length}>
                <section class="home-card card-surface card home-cli" aria-label="Continue from your terminal">
                    <header class="home-cli-head">
                        <h2 class="home-cli-title">Continue from your terminal</h2>
                        <Show when={hasMore()}>
                            <button class="link-btn" onClick={() => { setAll(true); void refetch(); }}>Show all {fresh().length}</button>
                        </Show>
                    </header>
                    <For each={shown()}>{row}</For>
                </section>
            </Show>
            {/* Outside the section: open, it stays while the list reloads (or fails to). */}
            <Dialog
                open={all()}
                onClose={() => setAll(false)}
                title="Continue from your terminal"
                subtitle={`${names()} sessions started in ${project()}.`}
                width={540}
                edge
                footer={
                    <>
                        <Show when={older()}>
                            {(n) => <span class="dlg-foot-note">{n()} older {n() === 1 ? "session" : "sessions"} not shown</span>}
                        </Show>
                        <button type="button" class="btn" onClick={() => setAll(false)}>
                            Done
                        </button>
                    </>
                }
            >
                <Show
                    when={list.loading || fresh().length}
                    fallback={
                        <div class="blank">
                            <p class="blank-title">{list() ? "No terminal sessions in this folder." : "Couldn’t list the sessions from your terminal just now."}</p>
                        </div>
                    }
                >
                    <ul class="dlg-rows">
                        <For each={fresh()}>{item}</For>
                    </ul>
                </Show>
            </Dialog>
        </>
    );
}
