// Every MCP server of the session's folder, from settings and .mcp.json:
// status, tools, where it comes from, and what can be done with it. A
// project server that asks for approval shows a card with exactly what will
// run (the server reads .mcp.json again, and approves only what the card
// showed). Statuses follow the session's state live.

import { createEffect, createMemo, createSignal, For, Match, on, Show, Switch, type JSX } from "solid-js";
import { ChevronRight } from "lucide-solid";
import { tip } from "../lib/tip";
import type { McpListInfo, McpServerInfo } from "@shared/protocol";
import { app, awayMachine, handleFor, reportError, requestTrust, rpc, rpcFor, toast } from "../state/app";
import { machine as windowMachine, os } from "../lib/platform";
import { home } from "../lib/machines";
import { sessionReadReady } from "../state/changes";
import { mcpOpen, setMcpOpen } from "../state/ui";
import { tildify } from "../lib/format";
import { SessionRequestGate } from "../lib/session-request-gate";
import { mergeMcpStatus, statusLabel } from "../lib/mcp";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import "../styles/mcp.css";

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
    const requests = new SessionRequestGate(() => mcpOpen() ? app.activeId : undefined);
    const close = () => {
        requests.open();
        setMcpOpen(undefined);
    };

    const load = async () => {
        const request = requests.capture();
        if (!request) return;
        try {
            const result = await rpc.call("session.mcp", { id: request.id });
            if (request.current()) setList(result);
        } catch (e) {
            const h = handle();
            if (request.current() && h && sessionReadReady(h)) reportError(e);
        }
    };
    createEffect(
        on(mcpOpen, (o) => {
            requests.open(o ? app.activeId : undefined);
            if (!o) return;
            setId(app.activeId);
            setBusy(false);
            setFull(undefined);
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
    // Watch readiness independently of opening the dialog, which already loads once.
    const readReady = createMemo(() => {
        const h = handleFor(app.activeId);
        return h && sessionReadReady(h);
    });
    createEffect(
        on(
            readReady,
            (ready) => {
                if (ready && mcpOpen() && !list()) void load();
            },
            { defer: true },
        ),
    );
    // Statuses come live with the session's state. A server added or gone, or approved elsewhere (another session, the terminal), means a fresh list.
    // A sign-in finishing (needs-auth to connected) reads it again too: whether there's a sign-in to sign out of.
    const shape = createMemo(() => JSON.stringify((handle()?.view.state.mcp ?? []).map((m) => [m.name, m.approval?.state, m.approval?.reason, m.status === "needs-auth"])));
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
            return mergeMcpStatus(s, live);
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
            const request = requests.capture();
            const name = chosen();
            if (!key || !request || name === undefined) return;
            try {
                const one = (await rpc.call("session.mcp", { id: request.id, name })).servers[0];
                if (request.current() && needsFull() === key) setFull(one);
            } catch (e) {
                if (request.current()) reportError(e);
            }
        }),
    );

    const act = async (fn: (sid: string) => Promise<() => void>) => {
        const request = requests.capture();
        if (!request || busy()) return;
        setBusy(true);
        try {
            const apply = await fn(request.id);
            if (request.current()) apply();
        } catch (e) {
            if (request.current()) {
                reportError(e);
                void load();
            }
        } finally {
            if (request.current()) setBusy(false);
        }
    };
    const approve = (s: McpServerInfo) =>
        act(async (sid) => {
            const r = await rpc.call("session.mcpApprove", { id: sid, name: s.name, fingerprint: s.fingerprint ?? "" });
            return () => {
                setList(r.list);
                setFull(undefined);
                if (!r.approved) toast(`Not approved: ${s.label} changed. Review it again.`, "warn");
            };
        });
    const change = (method: "session.mcpReject" | "session.mcpRevoke" | "session.mcpReconnect" | "session.mcpSignOut", s: McpServerInfo) =>
        act(async (sid) => {
            const result = await rpc.call(method, { id: sid, name: s.name });
            return () => setList(result);
        });
    const reject = (s: McpServerInfo) => change("session.mcpReject", s);
    const revoke = (s: McpServerInfo) => change("session.mcpRevoke", s);
    const reconnect = (s: McpServerInfo) => change("session.mcpReconnect", s);
    /** The sign-in link, shown in case the browser didn't open it (a blocked pop-up). */
    const [signInLink, setSignInLink] = createSignal<{ name: string; url: string }>();
    const signIn = (s: McpServerInfo) => {
        // Opened now, while this is still the click: a window opened after the answer would be a blocked pop-up.
        const win = window.open("", "_blank");
        void act(async (sid) => {
            try {
                const { url } = await rpc.call("session.mcpSignIn", { id: sid, name: s.name });
                // The window shares this page's origin until it navigates: only ever to a web page.
                if (!/^https?:\/\//i.test(url)) throw new Error("The sign-in link isn't a web page.");
                // A session on a server: its sign-in's page ends on this computer, where the browser is. This
                // computer's Cavvy answers there and hands it on (the window's own, or the one a window on a server keeps beside it).
                // (None for this computer's own session, in a window on a server too: its page ends where it listens.)
                const on = awayMachine(sid) ?? windowMachine;
                if (on) await (windowMachine ? home! : rpc).call("servers.mcpCallback", { name: on, url });
                if (win && !win.closed) {
                    win.opener = null;
                    win.location.href = url;
                }
                // The desktop app opens no blank window: the page is asked for now, and it opens it in the browser.
                else if (!win) window.open(url, "_blank", "noopener");
                return () => {
                    setSignInLink({ name: s.name, url });
                    toast(`Sign in to ${s.label} in your browser.`);
                };
            } catch (e) {
                win?.close();
                throw e;
            }
        });
    };
    const signOut = (s: McpServerInfo) => change("session.mcpSignOut", s);
    // The existing trust flow; the list is read again after it (the folder's servers may be approved by then).
    const trust = () => {
        const cwd = handle()?.view.state.cwd;
        const request = requests.capture();
        if (cwd && request) {
            requestTrust(cwd, () => {
                if (request.current()) void load();
            }, "mcp-approval", undefined, rpcFor(id()), awayMachine(id()));
        }
    };

    return (
        <Dialog
            open={Boolean(mcpOpen())}
            onClose={close}
            title="MCP servers"
            subtitle={handle()?.view.state.projectName}
            width={600}
            edge
            class="mcp"
            footer={
                <button class="btn" onClick={close}>
                    Close
                </button>
            }
        >
            <Show when={list()} fallback={<div class="blank mcp-empty">Loading…</div>}>
                <Show when={!list()!.trusted}>
                    <div class="mcp-banner">
                        <div class="note">
                            <div class="note-body">
                                This folder isn't trusted, so its <code>.mcp.json</code> servers are off.
                            </div>
                        </div>
                    </div>
                </Show>
                <Show
                    when={servers().length}
                    fallback={
                        <div class="blank mcp-empty">
                            <p class="blank-title">
                                No MCP servers. Add one with <code>cavvy mcp add</code> or in <code>.mcp.json</code>.
                            </p>
                        </div>
                    }
                >
                    <ul class="mcp-list">
                        <For each={servers()}>
                            {(s) => {
                                const open = () => chosen() === s.name;
                                return (
                                    <li class="mcp-item" data-open={open() || undefined}>
                                        <button class="mcp-row" aria-expanded={open()} onClick={() => setChosen(open() ? undefined : s.name)}>
                                            <ChevronRight size={13} class="chev" data-open={open() || undefined} />
                                            <span class="mcp-name">{s.label}</span>
                                            <span class={`mcp-source ${s.source === "project" ? "mono" : ""}`}>{s.source === "project" ? ".mcp.json" : "settings"}</span>
                                            <span class="grow" />
                                            <StatusChip s={s} />
                                        </button>
                                        <Show when={open() && selected()}>
                                            {(sel) => <Detail s={sel()} list={list()!} busy={busy()} approve={approve} reject={reject} revoke={revoke} reconnect={reconnect} trust={trust} signIn={signIn} signOut={signOut} signInLink={signInLink()?.name === sel().name ? signInLink()!.url : undefined} />}
                                        </Show>
                                    </li>
                                );
                            }}
                        </For>
                    </ul>
                    <Show when={list()!.omitted}>
                        <div class="mcp-banner mcp-omitted">{list()!.omitted} more servers aren't listed.</div>
                    </Show>
                </Show>
            </Show>
        </Dialog>
    );
}

/** A server's state at its row's end: connecting, connected with what it offers, or a tag for what it needs. */
function StatusChip(p: { s: McpServerInfo }) {
    const st = () => statusLabel(p.s);
    return (
        <Switch fallback={<span class="tag" data-tone={st().tone === "err" ? "red" : st().tone === "warn" ? "amber" : "neutral"}>{st().text}</span>}>
            <Match when={p.s.status === "connecting" || p.s.status === "pending"}>
                <span class="mcp-status">
                    <Spinner size={12} />
                    Connecting…
                </span>
            </Match>
            <Match when={p.s.status === "connected"}>
                <span class="mcp-status">
                    <span class="dot" data-tone="green" />
                    <span class="mcp-status-word">Connected</span>
                    <span class="dim">· {st().text.split(" · ").slice(1).join(" · ")}</span>
                </span>
            </Match>
        </Switch>
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
    trust: () => void;
    signIn: (s: McpServerInfo) => void;
    signOut: (s: McpServerInfo) => void;
    /** The link of a sign-in under way, in case the browser didn't open it. */
    signInLink?: string;
}

function Detail(p: DetailProps) {
    const asks = () => p.s.source === "project" && (p.s.approval?.state === "needs-approval" || p.s.approval?.state === "rejected");
    return (
        <div class="mcp-detail">
            <Show when={!p.s.partial || p.s.command !== undefined || p.s.url !== undefined} fallback={<p class="dim">Loading…</p>}>
                <Show when={asks()} fallback={<Info {...p} />}>
                    <Show when={p.s.approval?.state === "needs-approval"}>
                        <div class="note" data-tone="amber">
                            <div class="note-body">
                                {p.s.approval?.reason === "changed" ? "What it runs changed since you approved it. " : ""}MCP servers run with your permissions.
                            </div>
                        </div>
                    </Show>
                    <Show when={p.s.why}>
                        <div class="note" data-tone="amber">
                            <div class="note-body">{p.s.why}</div>
                        </div>
                    </Show>
                    <Facts s={p.s} />
                    <Notes s={p.s} />
                    <p class="mcp-meaning">{p.list.meaning}</p>
                    <Show when={p.s.disabledInFile}>
                        <p class="mcp-meaning">It's turned off in .mcp.json.</p>
                    </Show>
                    <Show when={p.list.trusted && !p.list.userTrusted}>
                        <div class="note" data-tone="amber">
                            <div class="note-body">Trust this folder to approve its servers.</div>
                        </div>
                    </Show>
                    <div class="mcp-actions">
                        <Show when={p.s.approval?.state === "needs-approval"}>
                            <button class="btn btn-sm" disabled={p.busy} onClick={() => p.reject(p.s)}>
                                Reject
                            </button>
                        </Show>
                        <Show
                            when={p.list.userTrusted}
                            fallback={
                                <button class="btn btn-sm" disabled={p.busy || !p.list.trusted} onClick={() => p.trust()}>
                                    Trust this folder…
                                </button>
                            }
                        >
                            <button class="btn btn-sm btn-primary" disabled={p.busy || !p.s.fingerprint || p.s.disabledInFile || !p.list.trusted} onClick={() => p.approve(p.s)}>
                                Approve and connect
                            </button>
                        </Show>
                    </div>
                </Show>
            </Show>
        </div>
    );
}

/** A server that isn't asking: what it runs, why it failed, and what can be done. */
function Info(p: DetailProps) {
    const approved = () => p.s.source === "project" && p.s.approval?.state === "approved";
    const revocable = () => approved() && !p.s.approval?.viaAll;
    const reconnectable = () => p.s.status === "failed" || p.s.status === "connected";
    const needsAuth = () => p.s.status === "needs-auth";
    return (
        <>
            <Show when={needsAuth()}>
                <div class="note" data-tone="amber" role="status">
                    <div class="note-body">
                        This server needs you to sign in.
                        <Show when={p.signInLink}>
                            {" "}Didn't open?{" "}
                            <a href={p.signInLink} target="_blank" rel="noopener noreferrer">
                                Open the sign-in page
                            </a>
                        </Show>
                    </div>
                </div>
            </Show>
            <Show when={p.s.error && !needsAuth()}>
                <div class="note" data-tone="red">
                    <div class="note-body mono mcp-error">{p.s.error}</div>
                </div>
            </Show>
            <Facts s={p.s} />
            <Show when={p.s.approval?.viaAll}>
                <p class="mcp-meaning">Your settings approve every .mcp.json server, whatever it runs.</p>
            </Show>
            <Show when={p.s.disabledInFile}>
                <p class="mcp-meaning">Turned off in .mcp.json.</p>
            </Show>
            <Notes s={p.s} />
            <div class="mcp-actions">
                <Show when={p.s.signedIn}>
                    <button class="btn btn-sm" disabled={p.busy} onClick={() => p.signOut(p.s)}>
                        Sign out
                    </button>
                </Show>
                <Show when={revocable()}>
                    <button class="btn btn-sm" disabled={p.busy} {...tip("It stops, and asks for approval again")} onClick={() => p.revoke(p.s)}>
                        Revoke approval
                    </button>
                </Show>
                <Show when={approved()}>
                    <button class="btn btn-sm" disabled={p.busy} {...tip("It stops, and stays off until you approve it again")} onClick={() => p.reject(p.s)}>
                        Reject
                    </button>
                </Show>
                <Show when={reconnectable()}>
                    <button class={`btn btn-sm ${p.s.status === "failed" ? "btn-primary" : ""}`} disabled={p.busy} onClick={() => p.reconnect(p.s)}>
                        Reconnect
                    </button>
                </Show>
                <Show when={needsAuth()}>
                    <button class="btn btn-sm btn-primary" disabled={p.busy} onClick={() => p.signIn(p.s)}>
                        {p.signInLink ? "Sign in again…" : "Sign in…"}
                    </button>
                </Show>
            </div>
        </>
    );
}

function Fact(p: { label: string; mono?: boolean; class?: string; children: JSX.Element }) {
    return (
        <>
            <dt>{p.label}</dt>
            <dd class={`${p.mono ? "mono" : ""} ${p.class ?? ""}`}>{p.children}</dd>
        </>
    );
}

function Names(p: { names?: string[] }) {
    return (
        <Show when={p.names?.length} fallback={<span class="dim">none</span>}>
            {p.names!.join(", ")} <span class="dim">· values not shown</span>
        </Show>
    );
}

function Facts(p: { s: McpServerInfo }) {
    return (
        <dl class="facts">
            <Show
                when={p.s.transport !== "stdio"}
                fallback={
                    <>
                        <Fact label="Command" mono>{p.s.command}</Fact>
                        <Show when={p.s.args?.length}>
                            {/* Each argument on a line of its own, so its spaces and quotes show. */}
                            <Fact label="Arguments" mono class="facts-lines">
                                <For each={p.s.args}>{(a) => <span class="mcp-arg">{a}</span>}</For>
                            </Fact>
                        </Show>
                        <Fact label="Runs in" mono>{p.s.cwd}</Fact>
                        <Show when={p.s.envNames?.length}>
                            <Fact label="Environment" mono>
                                <Names names={p.s.envNames} />
                            </Fact>
                        </Show>
                    </>
                }
            >
                <Fact label="Address" mono>{p.s.url}</Fact>
                <Show when={p.s.headerNames?.length}>
                    <Fact label="Headers" mono>
                        <Names names={p.s.headerNames} />
                    </Fact>
                </Show>
            </Show>
            <Fact label="Transport">
                {p.s.transport === "stdio" ? "stdio" : p.s.transport === "sse" ? "SSE" : p.s.transport === "ws" ? "WebSocket" : "Streamable HTTP"} on {awayMachine(app.activeId) ?? windowMachine ?? (os === "macos" ? "This Mac" : "this computer")}
            </Fact>
            <Show when={p.s.status === "connected"}>
                <Fact label="Offers">
                    {[`${p.s.tools} ${p.s.tools === 1 ? "tool" : "tools"}`, ...(p.s.resources ? [`${p.s.resources} ${p.s.resources === 1 ? "resource" : "resources"} (attach with @)`] : []), ...(p.s.prompts ? [`${p.s.prompts} ${p.s.prompts === 1 ? "prompt" : "prompts"} (run as /mcp__…)`] : [])].join(" · ")}
                </Fact>
            </Show>
            <Fact label="Declared in" mono={Boolean(p.s.declaredIn)}>
                {p.s.declaredIn ? tildify(p.s.declaredIn, app.hello?.homeDir) : "Your settings"}
            </Fact>
        </dl>
    );
}

function Notes(p: { s: McpServerInfo }) {
    return (
        <>
            <Show when={p.s.masked}>
                <p class="mcp-meaning">Values that look like secrets are masked.</p>
            </Show>
            <Show when={p.s.hidden}>
                <div class="note" data-tone="amber">
                    <div class="note-body">It contains invisible or control characters, shown as ⟨U+…⟩.</div>
                </div>
            </Show>
            <For each={p.s.cut}>
                {(c) => (
                    <div class="note" data-tone="amber">
                        <div class="note-body">Cut to fit: {c}.</div>
                    </div>
                )}
            </For>
        </>
    );
}
