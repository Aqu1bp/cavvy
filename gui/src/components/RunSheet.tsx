// One prompt to several models (runs.start), in one sheet: asking before more
// than two paid-API models, the one trust question a run can need, then each
// model's result, started or why not.

import { For, Match, Show, Switch } from "solid-js";
import { activate, app, refreshProjects, refreshSessions, rpc } from "../state/app";
import { toWire } from "../lib/attachments";
import { createRunSheet, type RunPhase as Phase } from "../lib/run-sheet";
import { basename, tildify } from "../lib/format";
import { modelName } from "../lib/model-name";
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

/** A model's row: still making its worktree, or how its start went. */
type Row = { model: string; modelName: string; pending?: boolean; ok?: boolean; error?: string; branch?: string; path?: string; sessionId?: string };

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
    const models = () => s()?.req.models ?? [];
    const busy = () => phase()?.kind === "starting";
    return (
        <Dialog
            open={Boolean(s())}
            onClose={close}
            title={title()}
            subtitle={s() ? `“${s()!.req.text.replace(/\s+/g, " ").trim().slice(0, 90) || "Attached files"}”` : undefined}
            width={520}
            edge
            footer={
                <Switch>
                    <Match when={phase()?.kind === "starting"}>
                        <span class="dlg-foot-note">Creating a worktree for each model…</span>
                    </Match>
                    <Match when={phase()?.kind === "confirm"}>
                        <button class="btn" onClick={close}>
                            Cancel
                        </button>
                        <button class="btn btn-primary" autofocus onClick={confirm}>
                            Start {models().length} models
                        </button>
                    </Match>
                    <Match when={phase()?.kind === "trust" && (phase() as Extract<Phase, { kind: "trust" }>)}>
                        {(t) => (
                            <>
                                <Show when={t().project}>
                                    <button class="btn" onClick={() => void decide(t().folder, false)}>
                                        Open without its configuration
                                    </button>
                                </Show>
                                <button class="btn btn-primary" autofocus onClick={() => void decide(t().folder, true)}>
                                    Trust {basename(t().folder)} and start
                                </button>
                            </>
                        )}
                    </Match>
                    <Match when={phase()?.kind === "done"}>
                        <span class="dlg-foot-note">Each worktree starts from {basename(s()!.req.path)}'s last commit.</span>
                        <button class="btn" autofocus onClick={close}>
                            Done
                        </button>
                    </Match>
                    <Match when={phase()}>
                        <button class="btn" autofocus onClick={close}>
                            Close
                        </button>
                    </Match>
                </Switch>
            }
        >
            <div class="run-body">
                <Switch>
                    <Match when={(phase()?.kind === "confirm" || phase()?.kind === "trust" || phase()?.kind === "unknown") && (phase() as { message: string })}>
                        {(m) => (
                            <div class="run-pad">
                                {/* Confirm: the server counted these models and quoted their prices; our model cache may be stale. */}
                                <p class="dlg-text">{m().message}</p>
                                <Show when={phase()?.kind === "trust"}>
                                    <p class="dlg-text dim">Nothing has been created yet.</p>
                                </Show>
                            </div>
                        )}
                    </Match>
                    <Match when={phase()?.kind === "error" && (phase() as Extract<Phase, { kind: "error" }>)}>
                        {(e) => (
                            <div class="run-pad">
                                <div class="note" data-tone="red">
                                    <div class="note-body">{e().message}</div>
                                </div>
                                <p class="dlg-text dim">Nothing has been created yet.</p>
                            </div>
                        )}
                    </Match>
                    <Match when={busy() || phase()?.kind === "done"}>
                        <ul class="run-list">
                            <For each={(busy() ? models().map((m) => ({ model: m, modelName: modelName(m), pending: true })) : (phase() as Extract<Phase, { kind: "done" }>).results) as Row[]}>
                                {(r) => (
                                    <li class="row run-row">
                                        <ProviderIcon id={r.model.split(":")[0]!} size={16} />
                                        <span class="row-text">
                                            <span class="row-title">{r.modelName}</span>
                                            <Show when={r.pending} fallback={
                                                <Show when={r.ok} fallback={<span class="row-sub run-error">{r.error}</span>}>
                                                    <span class="row-sub mono" title={r.path && tildify(r.path, app.hello?.homeDir)}>{r.branch}</span>
                                                </Show>
                                            }>
                                                <span class="row-sub">Creating its worktree…</span>
                                            </Show>
                                        </span>
                                        <Show when={r.pending} fallback={
                                            <Show when={r.ok && r.sessionId}>
                                                {(id) => (
                                                    <button class="btn btn-sm" onClick={() => (close(), void activate(id()))}>
                                                        Open
                                                    </button>
                                                )}
                                            </Show>
                                        }>
                                            <Spinner size={13} class="run-spin" />
                                        </Show>
                                    </li>
                                )}
                            </For>
                        </ul>
                    </Match>
                </Switch>
            </div>
        </Dialog>
    );
}
