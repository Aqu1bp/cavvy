// Every MCP server of the session's folder, from settings and .mcp.json:
// status, tools, where it comes from, and what can be done with it. A
// project server that asks for approval shows a card with exactly what will
// run (the server reads .mcp.json again, and approves only what the card
// showed). Statuses follow the session's state live.

import { createEffect, createMemo, createSignal, For, on, Show, type JSX } from "solid-js";
import { AlertTriangle, Plug, ShieldAlert } from "lucide-solid";
import type { McpListInfo, McpServerInfo } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast } from "../state/app";
import { mcpOpen, setMcpOpen } from "../state/ui";
import { tildify } from "../lib/format";
import { statusLabel } from "../lib/mcp";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

export function McpDialog() {
    /** The session it was opened for; it closes if another one is shown. */
    const [id, setId] = createSignal<string>();
    const [list, setListOnly] = createSignal<McpListInfo>();
    /** Bumped with each list, so a server it only summarises is fetched in full again (its details may have changed). */
    const [rev, setRev] = createSignal(0);
    const setList = (l: McpListInfo | undefined) => {
        setListOnly(l);
        setRev((n) => n + 1);
    };
    const [chosen, setChosen] = createSignal<string>();
    /** The chosen server in full, when the list only had room for its summary. */
    const [full, setFull] = createSignal<McpServerInfo>();
    const [busy, setBusy] = createSignal(false);
    const handle = () => handleFor(id());
    const close = () => setMcpOpen(undefined);

    const load = async () => {
        const sid = id();
        if (!sid) return;
        try {
            setList(await rpc.call("session.mcp", { id: sid }));
        } catch (e) {
            reportError(e);
        }
    };
    createEffect(
        on(mcpOpen, (o) => {
            if (!o) return;
            setId(app.activeId);
            setList(undefined);
            setChosen(o.focus);
            void load();
        }),
    );
    createEffect(
        on(
            () => app.activeId,
            (active) => {
                if (mcpOpen() && active !== id()) close();
            },
            { defer: true },
        ),
    );
    // Statuses come live with the session's state. A server added or gone, or approved elsewhere (another session, the terminal), means a fresh list.
    const shape = createMemo(() => JSON.stringify((handle()?.view.state.mcp ?? []).map((m) => [m.name, m.approval?.state, m.approval?.reason])));
    createEffect(
        on(
            shape,
            () => {
                if (mcpOpen() && list()) void load();
            },
            { defer: true },
        ),
    );

    const servers = (): McpServerInfo[] =>
        (list()?.servers ?? []).map((s) => {
            const live = handle()?.view.state.mcp.find((m) => m.name === s.name);
            if (!live) return s;
            const error = live.status !== "failed" ? undefined : s.status === "failed" && s.error ? s.error : live.error;
            return { ...s, status: live.status, tools: live.tools, error };
        });
    const selected = (): McpServerInfo | undefined => {
        const s = servers().find((x) => x.name === chosen());
        if (!s) return undefined;
        const f = full();
        return s.partial && f?.name === s.name ? { ...f, status: s.status, tools: s.tools, error: s.error } : s;
    };
    // A server the list only had a summary of is fetched in full once it's chosen, and again whenever the list comes back with only its summary.
    const needsFull = createMemo(() => {
        const s = list()?.servers.find((x) => x.name === chosen());
        return s?.partial ? `${id()}\0${s.name}\0${rev()}` : undefined;
    });
    createEffect(
        on(needsFull, async (key) => {
            setFull(undefined);
            const sid = id();
            const name = chosen();
            if (!key || !sid || name === undefined) return;
            try {
                const one = (await rpc.call("session.mcp", { id: sid, name })).servers[0];
                if (needsFull() === key) setFull(one);
            } catch (e) {
                reportError(e);
            }
        }),
    );

    const act = async (fn: (sid: string) => Promise<void>) => {
        const sid = id();
        if (!sid || busy()) return;
        setBusy(true);
        try {
            await fn(sid);
        } catch (e) {
            reportError(e);
            void load();
        } finally {
            setBusy(false);
        }
    };
    const approve = (s: McpServerInfo) =>
        act(async (sid) => {
            const r = await rpc.call("session.mcpApprove", { id: sid, name: s.name, fingerprint: s.fingerprint ?? "" });
            setList(r.list);
            setFull(undefined);
            if (!r.approved) toast(`What ${s.label} runs changed since it was shown. Nothing was approved: look at it again.`, "warn");
        });
    const reject = (s: McpServerInfo) => act(async (sid) => void setList(await rpc.call("session.mcpReject", { id: sid, name: s.name })));
    const revoke = (s: McpServerInfo) => act(async (sid) => void setList(await rpc.call("session.mcpRevoke", { id: sid, name: s.name })));
    const reconnect = (s: McpServerInfo) => act(async (sid) => void setList(await rpc.call("session.mcpReconnect", { id: sid, name: s.name })));

    return (
        <Dialog open={Boolean(mcpOpen())} onClose={close} title="MCP servers" subtitle={handle()?.view.state.projectName} width={640}>
            <Show when={list()} fallback={<Spinner />}>
                <Show when={!list()!.trusted}>
                    <div class="mcp-note">
                        <AlertTriangle size={13} />
                        <span>This folder isn't trusted, so its .mcp.json isn't read: none of its servers start or can be approved.</span>
                    </div>
                </Show>
                <Show
                    when={servers().length}
                    fallback={
                        <div class="panel-empty">
                            No MCP servers for this folder. Add one with <code>harness mcp add</code>, or in a project <code>.mcp.json</code>.
                        </div>
                    }
                >
                    <div class="rw-list">
                        <For each={servers()}>
                            {(s) => {
                                const st = () => statusLabel(s);
                                return (
                                    <button class={`rw-item ${chosen() === s.name ? "on" : ""}`} onClick={() => setChosen(s.name)}>
                                        <Plug size={14} />
                                        <span class="truncate">{s.label}</span>
                                        <span class="muted small">{s.source === "project" ? ".mcp.json" : "settings"}</span>
                                        <span class={`chip tiny ${st().tone ?? ""}`}>{st().text}</span>
                                    </button>
                                );
                            }}
                        </For>
                    </div>
                    <Show when={list()!.omitted}>
                        <div class="muted small">{list()!.omitted} more servers aren't listed.</div>
                    </Show>
                </Show>
                <Show when={selected()}>{(s) => <Detail s={s()} list={list()!} busy={busy()} approve={approve} reject={reject} revoke={revoke} reconnect={reconnect} />}</Show>
            </Show>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" onClick={close}>
                    Close
                </button>
            </div>
        </Dialog>
    );
}

interface DetailProps {
    s: McpServerInfo;
    list: McpListInfo;
    busy: boolean;
    approve: (s: McpServerInfo) => void;
    reject: (s: McpServerInfo) => void;
    revoke: (s: McpServerInfo) => void;
    reconnect: (s: McpServerInfo) => void;
}

function Detail(p: DetailProps) {
    const asks = () => p.s.source === "project" && (p.s.approval?.state === "needs-approval" || p.s.approval?.state === "rejected");
    return (
        <Show when={!p.s.partial || p.s.command !== undefined || p.s.url !== undefined} fallback={<Spinner />}>
            <Show when={asks()} fallback={<Info {...p} />}>
                <div class="mcp-card">
                    <div class="mcp-card-head">
                        <ShieldAlert size={18} class="tone-warn" />
                        <b class="truncate">Allow {p.s.label} to run?</b>
                    </div>
                    <div class="small">MCP servers run with your user permissions. Only approve servers you trust.</div>
                    <Show when={p.s.approval?.state === "rejected"}>
                        <div class="muted small">You rejected this server. Approving it starts it.</div>
                    </Show>
                    <Show when={p.s.why}>
                        <div class="mcp-note warn">
                            <AlertTriangle size={13} />
                            <span>{p.s.why}</span>
                        </div>
                    </Show>
                    <Facts s={p.s} />
                    <div class="muted small">
                        The approval is for this folder, saved in its local settings (<span class="mono">{tildify(p.list.savedIn, app.hello?.homeDir)}</span>). If what it runs changes, it asks again.
                    </div>
                    <Notes s={p.s} />
                    <div class="muted small">{p.list.meaning}</div>
                    <Show when={p.s.disabledInFile}>
                        <div class="mcp-note">
                            <span>It's turned off in .mcp.json ("disabled": true), so it can't be approved from here.</span>
                        </div>
                    </Show>
                    <div class="dialog-actions">
                        <Show when={p.s.approval?.state === "needs-approval"}>
                            <button class="btn secondary" disabled={p.busy} onClick={() => p.reject(p.s)}>
                                Reject
                            </button>
                        </Show>
                        <span class="grow" />
                        <button class="btn primary" disabled={p.busy || !p.s.fingerprint || p.s.disabledInFile || !p.list.trusted} onClick={() => p.approve(p.s)}>
                            Approve and connect
                        </button>
                    </div>
                </div>
            </Show>
        </Show>
    );
}

/** A server that isn't asking: what it runs, why it failed, and what can be done. */
function Info(p: DetailProps) {
    const approved = () => p.s.source === "project" && p.s.approval?.state === "approved";
    const revocable = () => approved() && !p.s.approval?.viaAll;
    const reconnectable = () => p.s.status === "failed" || p.s.status === "connected";
    return (
        <div class="rw-plan">
            <Facts s={p.s} />
            <Show when={p.s.error}>
                <div class="mcp-error mono small">{p.s.error}</div>
            </Show>
            <Show when={p.s.approval?.viaAll}>
                <div class="muted small">Approved for every .mcp.json server by enableAllProjectMcpServers in your settings, including changes to what they run.</div>
            </Show>
            <Show when={p.s.disabledInFile}>
                <div class="muted small">Turned off in .mcp.json ("disabled": true).</div>
            </Show>
            <Notes s={p.s} />
            <Show when={approved() || reconnectable()}>
                <div class="dialog-actions">
                    <Show when={revocable()}>
                        <button class="btn ghost" disabled={p.busy} title="It stops, and asks for approval again" onClick={() => p.revoke(p.s)}>
                            Revoke approval
                        </button>
                    </Show>
                    <Show when={approved()}>
                        <button class="btn ghost" disabled={p.busy} title="It stops, and stays off until you approve it again" onClick={() => p.reject(p.s)}>
                            Reject
                        </button>
                    </Show>
                    <span class="grow" />
                    <Show when={reconnectable()}>
                        <button class="btn secondary" disabled={p.busy} onClick={() => p.reconnect(p.s)}>
                            Reconnect
                        </button>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

function Fact(p: { label: string; children: JSX.Element }) {
    return (
        <>
            <div class="mcp-fact-label">{p.label}</div>
            <div class="mcp-fact">{p.children}</div>
        </>
    );
}

function Names(p: { names?: string[] }) {
    return (
        <Show when={p.names?.length} fallback={<span class="muted">none</span>}>
            <span class="mcp-names">
                <For each={p.names}>{(n) => <code class="mcp-arg">{n}</code>}</For>
                <span class="muted small">values not shown</span>
            </span>
        </Show>
    );
}

function Facts(p: { s: McpServerInfo }) {
    return (
        <div class="mcp-facts">
            <Show
                when={p.s.transport === "http"}
                fallback={
                    <>
                        <Fact label="Command">
                            <code class="mcp-val">{p.s.command}</code>
                        </Fact>
                        <Fact label="Arguments">
                            <Show when={p.s.args?.length} fallback={<span class="muted">none</span>}>
                                <ol class="mcp-args">
                                    <For each={p.s.args}>
                                        {(a) => (
                                            <li>
                                                <code class="mcp-arg">{a}</code>
                                            </li>
                                        )}
                                    </For>
                                </ol>
                            </Show>
                        </Fact>
                        <Fact label="Runs in">
                            <code class="mcp-val">{p.s.cwd}</code>
                        </Fact>
                        <Fact label="Env">
                            <Names names={p.s.envNames} />
                        </Fact>
                    </>
                }
            >
                <Fact label="URL">
                    <code class="mcp-val">{p.s.url}</code>
                </Fact>
                <Fact label="Headers">
                    <Names names={p.s.headerNames} />
                </Fact>
            </Show>
            <Fact label="From">
                <Show when={p.s.declaredIn} fallback={<span>Your settings</span>}>
                    <code class="mcp-val">{tildify(p.s.declaredIn!, app.hello?.homeDir)}</code>
                </Show>
            </Fact>
        </div>
    );
}

function Notes(p: { s: McpServerInfo }) {
    return (
        <>
            <Show when={p.s.masked}>
                <div class="muted small">Values that look like secrets are masked.</div>
            </Show>
            <Show when={p.s.hidden}>
                <div class="mcp-note warn">
                    <AlertTriangle size={13} />
                    <span>It contains invisible or control characters, shown as ⟨U+…⟩.</span>
                </div>
            </Show>
            <For each={p.s.cut}>
                {(c) => (
                    <div class="mcp-note warn">
                        <AlertTriangle size={13} />
                        <span>Cut to fit: {c}.</span>
                    </div>
                )}
            </For>
        </>
    );
}
