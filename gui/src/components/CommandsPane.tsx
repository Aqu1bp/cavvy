// The side panel's Commands tab (RightPanel): background shells and monitors, watched pull requests, and the
// session's secrets and MCP servers that failed or ask for approval. Loaded when it's first shown.

import { For, Show } from "solid-js";
import { GitPullRequest, KeyRound, Plug } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { reportError, rpc } from "../state/app";
import { setMcpOpen } from "../state/ui";
import { needsAttention, shownName, statusLabel } from "../lib/mcp";
import { openExternal } from "../lib/platform";
import type { WorkRow } from "../lib/background";
import { Blank, Group, WorkList } from "./BackgroundTasks";

/** Pull requests the agent watches: it's woken when checks fail or someone comments. A click opens the pull request. */
function Watches(p: { handle: SessionHandle }) {
    // Monitors are commands of their own (time left, from the shell list).
    const watches = () => (p.handle.view.state.watches ?? []).filter((w) => w.kind !== "monitor" && w.kind !== "sign-in");
    const tone = (detail?: string) => (/failing|conflicts|can't reach/.test(detail ?? "") ? "red" : /passed/.test(detail ?? "") ? "green" : "neutral");
    return (
        <Show when={watches().length}>
            <Group title="Watching">
                <For each={watches()}>
                    {(w) => {
                        const text = (
                            <>
                                <span class="bg-icon">
                                    <GitPullRequest size={14} />
                                </span>
                                <span class="row-text">
                                    <span class="row-title">{w.label.replace(/ in \S+$/, "")}</span>
                                    <span class="row-sub">Wakes the agent on news</span>
                                </span>
                                <Show when={w.detail}>
                                    <span class="tag" data-tone={tone(w.detail)}>
                                        {w.detail}
                                    </span>
                                </Show>
                            </>
                        );
                        return (
                            <div class="bg-row">
                                <Show when={w.url} fallback={<span class="bg-main bg-static">{text}</span>}>
                                    {(url) => (
                                        <button type="button" class="bg-main" aria-label={`Open ${w.label}`} onClick={() => void openExternal(url())}>
                                            {text}
                                        </button>
                                    )}
                                </Show>
                                <button type="button" class="btn btn-sm btn-ghost" aria-label={`Stop watching ${w.label}`} onClick={() => void rpc.call("session.stopWatch", { id: p.handle.id, watchId: w.id }).catch(reportError)}>
                                    Stop watching
                                </button>
                            </div>
                        );
                    }}
                </For>
            </Group>
        </Show>
    );
}

/** An MCP server's state, in the kit's tones. */
const TONE: Record<string, string> = { err: "red", warn: "amber", ok: "green" };

/**
 * The session's own: the secrets the user gave it, by name (its shell commands see them until forgotten or the
 * session closes), and MCP servers that failed or ask for approval (healthy ones stay out of the way). A server
 * opens the MCP list on it.
 */
function SessionGroup(p: { handle: SessionHandle }) {
    const names = () => p.handle.view.state.secrets ?? [];
    const flagged = () => p.handle.view.state.mcp.filter(needsAttention);
    return (
        <Show when={names().length || flagged().length}>
            <Group title="Session">
                <For each={names()}>
                    {(name) => (
                        <div class="bg-row">
                            <span class="bg-main bg-static">
                                <span class="bg-icon">
                                    <KeyRound size={14} />
                                </span>
                                <span class="row-text">
                                    <span class="row-title mono">${name}</span>
                                    <span class="row-sub">New shell commands see it</span>
                                </span>
                            </span>
                            <button type="button" class="btn btn-sm btn-ghost" aria-label={`Forget ${name}`} onClick={() => void rpc.call("session.forgetSecret", { id: p.handle.id, name }).catch(reportError)}>
                                Forget
                            </button>
                        </div>
                    )}
                </For>
                <For each={flagged()}>
                    {(m) => (
                        <div class="bg-row">
                            <button type="button" class="bg-main" aria-label={`MCP server ${shownName(m.name)}: ${statusLabel(m).text}`} onClick={() => setMcpOpen({ focus: m.name })}>
                                <span class="bg-icon">
                                    <Plug size={14} />
                                </span>
                                <span class="row-text">
                                    <span class="row-title">{shownName(m.name)}</span>
                                    <Show when={m.error} fallback={<span class="row-sub">Review what it runs</span>}>
                                        <span class="row-sub bg-err selectable">{m.error}</span>
                                    </Show>
                                </span>
                                <span class="tag" data-tone={TONE[statusLabel(m).tone ?? ""] ?? "neutral"}>
                                    {statusLabel(m).text}
                                </span>
                            </button>
                        </div>
                    )}
                </For>
            </Group>
        </Show>
    );
}

/** The Commands tab: background shells and monitors, then watched pull requests, then the session's own. */
export default function CommandsPane(p: { handle: SessionHandle; rows: WorkRow[] }) {
    const st = () => p.handle.view.state;
    const any = () => p.rows.length || (st().watches ?? []).some((w) => w.kind !== "monitor" && w.kind !== "sign-in") || (st().secrets ?? []).length || st().mcp.some(needsAttention);
    return (
        <Show when={any()} fallback={<Blank title="No commands running" />}>
            <div class="bg">
                <WorkList handle={p.handle} tab="commands" rows={p.rows} />
                <Watches handle={p.handle} />
                <SessionGroup handle={p.handle} />
            </div>
        </Show>
    );
}
