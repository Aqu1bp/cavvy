// The side panel's Commands tab (RightPanel): background shells and monitors, watched pull requests, and the
// session's secrets and MCP servers that failed or ask for approval. Loaded when it's first shown.

import { For, Show } from "solid-js";
import { GitPullRequestArrow, KeyRound, Plug, X } from "lucide-solid";
import type { SessionHandle } from "../state/app";
import { reportError, rpc } from "../state/app";
import { setMcpOpen } from "../state/ui";
import { needsAttention, shownName, statusLabel } from "../lib/mcp";
import { openExternal } from "../lib/platform";
import type { WorkRow } from "../lib/background";
import { WorkList } from "./BackgroundTasks";

/** Pull requests the agent watches: it's woken when checks fail or someone comments. A click opens the pull request. */
function Watches(p: { handle: SessionHandle }) {
    // Monitors are commands of their own (time left, from the shell list).
    const watches = () => (p.handle.view.state.watches ?? []).filter((w) => w.kind !== "monitor" && w.kind !== "sign-in");
    const tone = (detail?: string) => (/failing|conflicts|can't reach/.test(detail ?? "") ? "tone-err" : /passed/.test(detail ?? "") ? "tone-ok" : "");
    return (
        <Show when={watches().length}>
            <div class="grp">
                <div class="sh">Watching</div>
                <For each={watches()}>
                    {(w) => (
                        <div class={`task swap ${w.url ? "click" : ""}`}>
                            <Show when={w.url}>{(url) => <button class="task-hit" aria-label={`Open ${w.label}`} onClick={() => void openExternal(url())} />}</Show>
                            <span class="ki watch">
                                <GitPullRequestArrow size={14} />
                            </span>
                            <span class="tx">
                                <b>{w.label.replace(/ in \S+$/, "")}</b>
                                <span>Wakes the agent on news</span>
                            </span>
                            <span class={`meta ${tone(w.detail)}`}>{w.detail}</span>
                            <button class="act" title="Stop watching" aria-label={`Stop watching ${w.label}`} onClick={() => void rpc.call("session.stopWatch", { id: p.handle.id, watchId: w.id }).catch(reportError)}>
                                <X size={14} />
                            </button>
                        </div>
                    )}
                </For>
            </div>
        </Show>
    );
}

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
            <div class="grp">
                <div class="sh">Session</div>
                <For each={names()}>
                    {(name) => (
                        <div class="task swap">
                            <span class="ki">
                                <KeyRound size={14} />
                            </span>
                            <span class="tx">
                                <b class="mono">{name}</b>
                                <span>New shell commands see ${name}</span>
                            </span>
                            <span class="meta" />
                            <button class="act" title="Forget" aria-label={`Forget ${name}`} onClick={() => void rpc.call("session.forgetSecret", { id: p.handle.id, name }).catch(reportError)}>
                                <X size={14} />
                            </button>
                        </div>
                    )}
                </For>
                <For each={flagged()}>
                    {(m) => (
                        <div class="task click">
                            <button class="task-hit" aria-label={`MCP server ${shownName(m.name)}: ${statusLabel(m).text}`} onClick={() => setMcpOpen({ focus: m.name })} />
                            <span class="ki">
                                <Plug size={14} />
                                <span class={`nd ${m.status === "failed" ? "st-failed" : "st-waiting"}`} />
                            </span>
                            <span class="tx">
                                <b>{shownName(m.name)}</b>
                                <Show when={m.error} fallback={<span>Review what it runs</span>}>
                                    <span class="err selectable">{m.error}</span>
                                </Show>
                            </span>
                            <span class={`meta tone-${statusLabel(m).tone}`}>{statusLabel(m).text}</span>
                        </div>
                    )}
                </For>
            </div>
        </Show>
    );
}


/** The Commands tab: background shells and monitors, then watched pull requests, then the session's own. */
export default function CommandsPane(p: { handle: SessionHandle; rows: WorkRow[] }) {
    const st = () => p.handle.view.state;
    const any = () => p.rows.length || (st().watches ?? []).some((w) => w.kind !== "monitor" && w.kind !== "sign-in") || (st().secrets ?? []).length || st().mcp.some(needsAttention);
    return (
        <Show
            when={any()}
            fallback={
<div class="none">No commands running</div>
            }
        >
            <WorkList handle={p.handle} tab="commands" rows={p.rows} />
            <Watches handle={p.handle} />
            <SessionGroup handle={p.handle} />
        </Show>
    );
}
