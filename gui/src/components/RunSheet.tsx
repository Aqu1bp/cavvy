// One prompt to several models (runs.start), in one sheet: asking before more
// than two paid-API models, the one trust question a run can need, then each
// model's result, started or why not.

import { For, Match, Show, Switch } from "solid-js";
import { AlertTriangle, CircleCheck, CircleX, ShieldAlert } from "lucide-solid";
import { activate, app, refreshProjects, refreshSessions, rpc } from "../state/app";
import { toWire } from "../lib/attachments";
import { createRunSheet, type RunPhase as Phase } from "../lib/run-sheet";
import { basename, tildify } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";

const controller = createRunSheet({
    start: (req, confirmPaid) => rpc.call("runs.start", { path: req.path, models: req.models, text: req.text, ...toWire(req.attachments), mode: req.mode, confirmPaid }),
    trust: (folder, trust) => rpc.call("projects.trust", { path: folder, trust }),
    refresh: () => { void refreshSessions(); void refreshProjects(); },
});
export const { startRun } = controller;
const { sheet, close, confirm, decide } = controller;

export function RunSheet() {
    const s = () => sheet();
    const phase = () => s()?.phase;
    const title = () => {
        const p = phase();
        if (p?.kind === "confirm") return "Start paid models?";
        if (p?.kind === "trust") return "Trust this project first?";
        if (p?.kind === "done") return `Sent to ${p.results.filter((r) => r.ok).length} of ${p.results.length} models`;
        if (p?.kind === "error") return "The run didn't start";
        if (p?.kind === "unknown") return "Run outcome unknown";
        return `Starting ${s()?.req.models.length ?? ""} models…`;
    };
    return (
        <Dialog open={Boolean(s())} onClose={close} title={title()} subtitle={s() ? `“${s()!.req.text.replace(/\s+/g, " ").trim().slice(0, 90) || "Attached files"}”` : undefined} width={560}>
            <div class="run-sheet">
                <Switch>
                    <Match when={phase()?.kind === "starting"}>
                        <div class="run-wait">
                            <Spinner size={14} />
                            <span class="muted">Creating a worktree for each model, one at a time. A big repository takes a while…</span>
                        </div>
                    </Match>
                    <Match when={phase()?.kind === "confirm"}>
                        {/* The server counted these models and quoted their prices; our model cache may be stale. */}
                        <p class="small">{(phase() as Extract<Phase, { kind: "confirm" }>).message}</p>
                        <div class="dialog-actions">
                            <span class="grow" />
                            <button class="btn ghost" onClick={close}>
                                Cancel
                            </button>
                            <button class="btn primary" autofocus onClick={confirm}>
                                Start {s()?.req.models.length} models
                            </button>
                        </div>
                    </Match>
                    <Match when={phase()?.kind === "trust" && (phase() as Extract<Phase, { kind: "trust" }>)}>
                        {(t) => (
                            <>
                                <div class="rw-confirm">
                                    <ShieldAlert size={14} />
                                    <span>{t().message}</span>
                                </div>
                                <p class="muted small">Nothing has been created yet. Your answer covers every model in this run.</p>
                                <div class="dialog-actions">
                                    <span class="grow" />
                                    <button class="btn ghost" onClick={close}>
                                        Cancel
                                    </button>
                                    <Show when={t().project}>
                                        <button class="btn secondary" onClick={() => void decide(t().folder, false)}>
                                            Open without its configuration
                                        </button>
                                    </Show>
                                    <button class="btn primary" onClick={() => void decide(t().folder, true)}>
                                        Trust {basename(t().folder)} and start
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={(phase()?.kind === "error" || phase()?.kind === "unknown") && (phase() as Extract<Phase, { kind: "error" | "unknown" }>)}>
                        {(e) => (
                            <>
                                <div class="rw-confirm">
                                    <AlertTriangle size={14} />
                                    <span>{e().message}</span>
                                </div>
                                <div class="dialog-actions">
                                    <span class="grow" />
                                    <button class="btn primary" onClick={close}>
                                        Close
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={phase()?.kind === "done" && (phase() as Extract<Phase, { kind: "done" }>)}>
                        {(d) => (
                            <>
                                <ul class="run-results">
                                    <For each={d().results}>
                                        {(r) => (
                                            <li class={r.ok ? "ok" : "failed"}>
                                                <span class="run-icon">{r.ok ? <CircleCheck size={15} class="tone-ok" /> : <CircleX size={15} class="tone-err" />}</span>
                                                <div class="run-body">
                                                    <div class="run-name">
                                                        <ProviderIcon id={r.model.split(":")[0]!} size={13} />
                                                        <span class="truncate">{r.modelName}</span>
                                                    </div>
                                                    <Show when={r.branch}>
                                                        <div class="run-where mono small truncate" title={r.path}>
                                                            {r.branch} · {tildify(r.path!, app.hello?.homeDir)}
                                                        </div>
                                                    </Show>
                                                    <Show when={!r.ok && (r as { error: string }).error}>{(m) => <div class="run-error small">{m()}</div>}</Show>
                                                </div>
                                                <Show when={r.ok && (r as { sessionId: string }).sessionId}>
                                                    {(id) => (
                                                        <button class="btn secondary sm" onClick={() => (close(), void activate(id()))}>
                                                            Open
                                                        </button>
                                                    )}
                                                </Show>
                                            </li>
                                        )}
                                    </For>
                                </ul>
                                <p class="muted small">Each worktree starts from {basename(s()!.req.path)}'s last commit: uncommitted changes there weren't carried over. Worktrees are kept until you remove them.</p>
                                <div class="dialog-actions">
                                    <span class="grow" />
                                    <button class="btn primary" autofocus onClick={close}>
                                        Done
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                </Switch>
            </div>
        </Dialog>
    );
}
