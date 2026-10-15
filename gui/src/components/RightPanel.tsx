import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { Check, ChevronRight, ExternalLink, FolderOpen, Plug, RefreshCw, SquareTerminal, X } from "lucide-solid";
import type { ChangesInfo, FileDiff, TodoEntry } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { reportError, rpc } from "../state/app";
import { prefs, setPrefs } from "../state/prefs";
import { canReveal, revealPath } from "../lib/platform";
import { ago, plural, tokens, usd } from "../lib/format";
import { now } from "../lib/clock";
import { DiffStat, DiffView, FileIcon } from "./blocks/DiffView";
import { Ring, Segmented, Spinner } from "./ui/bits";
import { MODE_LABELS } from "@shared/protocol";

function ChangeFile(p: { file: FileDiff; cwd: string; open: boolean; toggle: () => void }) {
    return (
        <div class={`cf ${p.open ? "open" : ""}`}>
            <button class="cf-line" onClick={p.toggle}>
                <ChevronRight size={13} class="cf-chev" />
                <FileIcon status={p.file.status} size={14} />
                <span class="cf-path truncate" title={p.file.path}>
                    <span class="cf-dir">{p.file.path.includes("/") ? p.file.path.slice(0, p.file.path.lastIndexOf("/") + 1) : ""}</span>
                    <span class="cf-name">{p.file.path.split("/").pop()}</span>
                </span>
                <DiffStat added={p.file.added} removed={p.file.removed} />
            </button>
            <Show when={p.open}>
                <div class="cf-body">
                    <DiffView diff={p.file} maxLines={400} />
                    <Show when={canReveal}>
                        <button class="link-btn cf-reveal" onClick={() => void revealPath(p.file.path.startsWith("/") ? p.file.path : `${p.cwd}/${p.file.path}`)}>
                            <FolderOpen size={12} /> Reveal in file manager
                        </button>
                    </Show>
                </div>
            </Show>
        </div>
    );
}

function Changes(p: { handle: SessionHandle }) {
    const [openFiles, setOpenFiles] = createSignal<Set<string>>(new Set());
    const [data, { refetch }] = createResource(
        () => ({ id: p.handle.id, n: p.handle.view.state.filesChanged, busy: p.handle.view.state.busy }),
        async ({ id }) => rpc.call("session.changes", { id }).catch((e): ChangesInfo => (reportError(e), { files: [], added: 0, removed: 0, tracked: true })),
    );
    // Open the only file automatically.
    createEffect(on(data, (d) => d?.files.length === 1 && setOpenFiles(new Set([d.files[0]!.path]))));
    return (
        <div class="panel-section">
            <div class="panel-sum" classList={{ hidden: data()?.files.length === 0 }}>
                <Show when={data()} fallback={<Spinner size={14} />}>
                    <span class="panel-sum-title">{plural(data()!.files.length, "file")} changed</span>
                    <DiffStat added={data()!.added} removed={data()!.removed} />
                </Show>
                <span class="grow" />
                <button class="icon-btn" title="Refresh" onClick={() => void refetch()}>
                    <RefreshCw size={13} />
                </button>
            </div>
            <Show when={data()?.files.length} fallback={<div class="panel-empty">{data()?.tracked === false ? "This session isn't saved yet." : "No file changes yet. Edits the agent makes show up here as a reviewable diff."}</div>}>
                <div class="cf-list">
                    <For each={data()!.files}>
                        {(f) => (
                            <ChangeFile
                                file={f}
                                cwd={p.handle.view.state.cwd}
                                open={openFiles().has(f.path)}
                                toggle={() =>
                                    setOpenFiles((s) => {
                                        const n = new Set(s);
                                        if (n.has(f.path)) n.delete(f.path);
                                        else n.add(f.path);
                                        return n;
                                    })
                                }
                            />
                        )}
                    </For>
                </div>
                <div class="panel-note">Changes made by the agent's edit tools in this session. Shell commands' changes aren't tracked.</div>
            </Show>
        </div>
    );
}

function Plan(p: { todos: TodoEntry[] }) {
    const done = () => p.todos.filter((t) => t.status === "completed").length;
    return (
        <div class="panel-section">
            <Show when={p.todos.length} fallback={<div class="panel-empty">No plan yet. For multi-step work the agent keeps a checklist here as it goes.</div>}>
                <div class="panel-sum">
                    <span class="panel-sum-title">
                        {done()} of {p.todos.length} done
                    </span>
                </div>
                <div class="progress">
                    <div class="progress-bar" style={{ width: `${(done() / p.todos.length) * 100}%` }} />
                </div>
                <ul class="todo-list big">
                    <For each={p.todos}>
                        {(t) => (
                            <li class={t.status}>
                                <span class="todo-box">
                                    <Show when={t.status === "completed"} fallback={<Show when={t.status === "in_progress"}><Spinner size={11} /></Show>}>
                                        <Check size={11} />
                                    </Show>
                                </span>
                                <span>{t.status === "in_progress" ? (t.activeForm ?? t.content) : t.content}</span>
                            </li>
                        )}
                    </For>
                </ul>
            </Show>
        </div>
    );
}

function Context(p: { handle: SessionHandle }) {
    const st = () => p.handle.view.state;
    const pct = () => (st().model?.contextWindow ? st().contextTokens / st().model!.contextWindow! : 0);
    return (
        <div class="panel-section">
            <div class="ctx-card">
                <Ring value={pct()} size={54} stroke={5} title="Context used" />
                <div>
                    <div class="ctx-big">{Math.round(pct() * 100)}%</div>
                    <div class="muted small">
                        {tokens(st().contextTokens)} of {st().model?.contextWindow ? tokens(st().model!.contextWindow!) : "?"} tokens in context
                    </div>
                </div>
            </div>
            <dl class="kv">
                <dt>Model</dt>
                <dd>{st().model?.name ?? "—"}</dd>
                <dt>Provider</dt>
                <dd>{st().model?.providerName ?? st().model?.provider ?? "—"}</dd>
                <dt>Mode</dt>
                <dd>{MODE_LABELS[st().mode].label}</dd>
                <dt>Effort</dt>
                <dd>{st().effort ?? "default"}</dd>
                <dt>Spent</dt>
                <dd>{usd(st().cost)}</dd>
                <dt>Tokens</dt>
                <dd>
                    {tokens(st().tokensIn)} in · {tokens(st().tokensOut)} out
                </dd>
            </dl>
            <Show when={st().shells.length}>
                <div class="panel-sub">Background shells</div>
                <For each={st().shells}>
                    {(sh) => (
                        <div class="shell-row">
                            <SquareTerminal size={13} />
                            <code class="truncate" title={sh.command}>
                                {sh.command}
                            </code>
                            <span class="muted small">{sh.running ? (now(), ago(sh.startedAt)) : `exit ${sh.exitCode ?? "?"}`}</span>
                            <Show when={sh.running}>
                                <button class="icon-btn" title="Stop" onClick={() => void rpc.call("session.killShell", { id: p.handle.id, shellId: sh.id }).catch(reportError)}>
                                    <X size={13} />
                                </button>
                            </Show>
                        </div>
                    )}
                </For>
            </Show>
            <Show when={st().mcp.length}>
                <div class="panel-sub">MCP servers</div>
                <For each={st().mcp}>
                    {(m) => (
                        <div class="mcp-row" title={m.error}>
                            <Plug size={13} />
                            <span class="truncate">{m.name}</span>
                            <span class={`dot ${m.status === "connected" ? "ok" : m.status === "failed" ? "err" : m.status === "needs-approval" ? "warn" : ""}`} />
                            <span class="muted small">{m.status === "connected" ? plural(m.tools, "tool") : m.status.replace("-", " ")}</span>
                        </div>
                    )}
                </For>
            </Show>
            <div class="panel-note">
                Session <code>{st().id}</code> · <a href="#" onClick={(e) => (e.preventDefault(), void navigator.clipboard?.writeText(`harness --resume ${st().id}`))}>copy resume command <ExternalLink size={11} /></a>
            </div>
        </div>
    );
}

export function RightPanel(p: { handle: SessionHandle }) {
    let dragStart = 0;
    let widthStart = 0;
    const onResize = (e: PointerEvent) => {
        dragStart = e.clientX;
        widthStart = prefs.panelWidth;
        const move = (ev: PointerEvent) => setPrefs("panelWidth", Math.max(320, Math.min(900, widthStart - (ev.clientX - dragStart))));
        const up = () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            document.body.classList.remove("resizing");
        };
        document.body.classList.add("resizing");
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
    };
    const todos = () => p.handle.view.state.todos;
    return (
        <aside class="panel">
            <div class="resize-handle left" onPointerDown={onResize} />
            <div class="panel-card">
                <div class="panel-head">
                    <Segmented
                        value={prefs.panelTab}
                        onChange={(v) => setPrefs("panelTab", v)}
                        options={[
                            { value: "changes", label: <>Changes{p.handle.view.state.filesChanged ? <span class="tab-count">{p.handle.view.state.filesChanged}</span> : null}</> },
                            { value: "plan", label: <>Plan{todos().length ? <span class="tab-count">{todos().filter((t) => t.status === "completed").length}/{todos().length}</span> : null}</> },
                            { value: "context", label: "Context" },
                        ]}
                    />
                    <span class="grow" />
                    <button class="icon-btn" title="Close panel" onClick={() => setPrefs("panel", false)}>
                        <X size={15} />
                    </button>
                </div>
                <div class="panel-scroll">
                    <Show when={prefs.panelTab === "changes"}>
                        <Changes handle={p.handle} />
                    </Show>
                    <Show when={prefs.panelTab === "plan"}>
                        <Plan todos={todos()} />
                    </Show>
                    <Show when={prefs.panelTab === "context"}>
                        <Context handle={p.handle} />
                    </Show>
                </div>
            </div>
        </aside>
    );
}
