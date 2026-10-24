// "Continue from your terminal": Claude Code and Codex conversations started in a
// terminal in this project, to carry on here. Home lists the newest few not yet in
// Harness; "Show all" lists every one, then those already here. Importing opens a
// Harness session on the same backend; one already in Harness just opens.

import { createEffect, createResource, createSignal, For, Show } from "solid-js";
import { ArrowRight } from "lucide-solid";
import type { CliSessionInfo } from "@shared/protocol";
import { app, rpc } from "../state/app";
import { continueCliSession } from "../state/actions";
import { setSettingsTab } from "../state/ui";
import { ago, basename } from "../lib/format";
import { now } from "../lib/clock";
import { Dialog } from "./ui/Dialog";
import { ProviderIcon } from "./ui/ProviderIcon";

/** Using it here and in the terminal at once mixes the two: said wherever one still open shows. */
const STILL_OPEN = "This session may still be open in a terminal; using it in both places at once mixes the two.";

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
    const [list, { refetch }] = createResource(
        () => app.conn === "open" && p.cwd,
        (cwd) => rpc.call("cliSessions.list", { cwd }).catch(() => undefined),
    );
    const sessions = () => list()?.sessions ?? [];
    // Ones already in Harness aren't offered on Home: "Show all" lists them after the rest.
    const fresh = () => sessions().filter((s) => !s.harnessId).sort((a, b) => b.updatedAt - a.updatedAt);
    const held = () => sessions().filter((s) => s.harnessId);
    const moreHeld = () => (list()?.sources ?? []).reduce((n, s) => n + s.moreInHarness, 0);
    const source = (s: CliSessionInfo) => list()?.sources.find((x) => x.source === s.source);
    const name = (s: CliSessionInfo) => source(s)?.name ?? s.source;
    // Turned on in Settings → Providers: read from the providers, which follow a change made there while Home is up.
    const enabled = (s: CliSessionInfo) => app.providers.find((x) => x.id === s.source)?.configured ?? source(s)?.enabled;
    const more = () => (list()?.sources ?? []).filter((s) => s.more > 0);
    const shown = () => fresh().slice(0, Math.max(0, Math.min(3, p.rows ?? 3)));
    // Worth opening when it lists something these rows don't.
    const hasMore = () => fresh().length > shown().length || held().length > 0 || moreHeld() > 0 || more().length > 0;
    createEffect(() => p.onShown?.(shown().length, fresh().length > 0));

    const go = async (s: CliSessionInfo) => {
        if (busy()) return;
        setBusy(s.id);
        const ok = await continueCliSession(p.cwd, s);
        setBusy(undefined);
        if (!ok) void refetch();
    };
    /** What a row does: import it, open the one already here, or (its CLI not turned on) go where it's turned on. */
    const act = (s: CliSessionInfo) => {
        setAll(false);
        if (!s.harnessId && !enabled(s)) setSettingsTab("providers");
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
                    {name(s)} · {count(s)}
                    <Show when={s.model}> · {s.model}</Show>
                    <Show when={s.recent}> · <span class="cli-live" title={STILL_OPEN}>Still open in a terminal</span></Show>
                </span>
            </span>
            <span class="cli-end">
                <Show when={enabled(s)} fallback={<span class="cli-off">{turnOn(s)}</span>}>
                    <span class="cli-ago">{(now(), agoText(s.updatedAt))}</span>
                    <span class="cli-go">
                        {busy() === s.id ? "Importing…" : "Import"}
                        <ArrowRight size={13} stroke-width={2.25} />
                    </span>
                </Show>
            </span>
        </div>
    );

    /** A row of "Show all": the ones to import, then the ones already here (Open). */
    const item = (s: CliSessionInfo) => (
        <button class="cl-item" disabled={busy() === s.id} title={s.recent && !s.harnessId ? STILL_OPEN : undefined} onClick={() => act(s)}>
            <span class="cli-pv"><ProviderIcon id={s.source} name={name(s)} size={16} /></span>
            <span class="cl-main">
                <span class="truncate">{s.title}</span>
                <span class="cli-meta">
                    {name(s)} · {(now(), agoText(s.updatedAt))} · {count(s)}
                    <Show when={s.recent && !s.harnessId}> · <span class="cli-live">Still open in a terminal</span></Show>
                </span>
            </span>
            <span class="cl-act">{s.harnessId ? "Open" : enabled(s) ? "Import" : "Turn on in Settings"}</span>
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
                <p>{sourceNames()} sessions started in {basename(p.cwd)}. Importing one opens it here on the same session.</p>
                <div class="cl-list">
                    <Show when={list.loading || sessions().length}>
                        <For each={fresh()}>{item}</For>
                    </Show>
                    <Show when={!list.loading && !sessions().length}>
                        <div class="cl-note">Couldn't list the sessions from your terminal just now.</div>
                    </Show>
                    <Show when={held().length || moreHeld()}>
                        <div class="cl-sub">Already in Harness</div>
                        <For each={held()}>{item}</For>
                        <Show when={moreHeld()}>
                            <div class="cl-note">{moreHeld()} more already in Harness not shown</div>
                        </Show>
                    </Show>
                    <For each={more()}>{(m) => <div class="cl-note">{m.more} more {m.name} {m.more === 1 ? "session" : "sessions"} not shown</div>}</For>
                </div>
            </Dialog>
        </>
    );
}
