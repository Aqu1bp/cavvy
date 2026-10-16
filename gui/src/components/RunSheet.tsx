// One prompt to several models (runs.start), in one sheet: asking before more
// than two paid-API models, the one trust question a run can need, then each
// model's result, started or why not.

import { createSignal, For, Match, Show, Switch } from "solid-js";
import { AlertTriangle, CircleCheck, CircleX, ShieldAlert } from "lucide-solid";
import type { PermissionModeId, RunResult } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import { activate, app, refreshProjects, refreshSessions, rpc } from "../state/app";
import { attachmentParams, type Attachment } from "../state/actions";
import { basename, price, tildify } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import { ProviderIcon } from "./ui/ProviderIcon";

export interface RunRequest {
    path: string;
    models: string[];
    text: string;
    attachments: Attachment[];
    mode: PermissionModeId;
}

type Phase =
    | { kind: "starting" }
    | { kind: "confirm"; message: string }
    | { kind: "trust"; folder: string; message: string; project: boolean }
    | { kind: "error"; message: string }
    | { kind: "done"; results: RunResult[] };

const [sheet, setSheet] = createSignal<{ req: RunRequest; phase: Phase; confirmPaid: boolean; resolve: (started: boolean) => void }>();

/** Starts the run and shows how it went. True once anything started (the composer can be cleared); false if cancelled or nothing did. */
export function startRun(req: RunRequest): Promise<boolean> {
    return new Promise((resolve) => {
        setSheet({ req, phase: { kind: "starting" }, confirmPaid: false, resolve });
        void attempt();
    });
}

const setPhase = (phase: Phase) => setSheet((s) => s && { ...s, phase });

async function attempt() {
    const s = sheet();
    if (!s) return;
    setPhase({ kind: "starting" });
    try {
        const r = await rpc.call("runs.start", { path: s.req.path, models: s.req.models, text: s.req.text, ...attachmentParams(s.req.attachments), mode: s.req.mode, confirmPaid: s.confirmPaid });
        if (sheet()?.req !== s.req) return;
        setPhase({ kind: "done", results: r.results });
        void refreshSessions();
        void refreshProjects();
    } catch (e) {
        const message = (e as Error).message;
        if (e instanceof RpcError && e.code === "confirm_paid") return setPhase({ kind: "confirm", message });
        if (e instanceof RpcError && (e.code === "needs_trust" || e.code === "needs_project_trust")) return setPhase({ kind: "trust", folder: e.folder ?? s.req.path, message, project: e.code === "needs_project_trust" });
        setPhase({ kind: "error", message });
    }
}

function close() {
    const s = sheet();
    if (!s || s.phase.kind === "starting") return;
    setSheet(undefined);
    s.resolve(s.phase.kind === "done" && s.phase.results.some((r) => r.ok));
}

/** The user's answer to the trust question, then the same run again. */
async function decide(folder: string, trust: boolean) {
    setPhase({ kind: "starting" });
    try {
        await rpc.call("projects.trust", { path: folder, trust });
    } catch (e) {
        return setPhase({ kind: "error", message: (e as Error).message });
    }
    await attempt();
}

const modelOf = (ref: string) => app.models.flatMap((g) => g.models).find((m) => m.ref === ref);
const billingOf = (ref: string) => app.models.find((g) => g.provider === ref.split(":")[0])?.billing ?? "api";

export function RunSheet() {
    const s = () => sheet();
    const phase = () => s()?.phase;
    // Those the server counted: listed (so set up here) and billed per token.
    const paid = () => s()?.req.models.filter((ref) => modelOf(ref) && billingOf(ref) === "api") ?? [];
    const title = () => {
        const p = phase();
        if (p?.kind === "confirm") return "Start paid models?";
        if (p?.kind === "trust") return "Trust this project first?";
        if (p?.kind === "done") return `Sent to ${p.results.filter((r) => r.ok).length} of ${p.results.length} models`;
        if (p?.kind === "error") return "The run didn't start";
        return `Starting ${s()?.req.models.length ?? ""} models…`;
    };
    return (
        <Dialog open={Boolean(s())} onClose={close} title={title()} subtitle={s() ? `“${s()!.req.text.replace(/\s+/g, " ").slice(0, 90)}”` : undefined} width={560}>
            <div class="run-sheet">
                <Switch>
                    <Match when={phase()?.kind === "starting"}>
                        <div class="run-wait">
                            <Spinner size={14} />
                            <span class="muted">Creating a worktree for each model, one at a time. A big repository takes a while…</span>
                        </div>
                    </Match>
                    <Match when={phase()?.kind === "confirm"}>
                        <p class="small">These models are billed per token through your API keys, and each works on the whole task:</p>
                        <ul class="run-paid">
                            <For each={paid()}>
                                {(ref) => (
                                    <li>
                                        <ProviderIcon id={ref.split(":")[0]!} size={14} />
                                        <span class="truncate">{modelOf(ref)?.name ?? ref}</span>
                                        <span class="muted small num">{modelOf(ref)?.pricing ? `${price(modelOf(ref)!.pricing)} per M tokens` : "price unknown"}</span>
                                    </li>
                                )}
                            </For>
                        </ul>
                        <Show when={!paid().length}>
                            <p class="small">{(phase() as { message: string }).message}</p>
                        </Show>
                        <div class="dialog-actions">
                            <span class="grow" />
                            <button class="btn ghost" onClick={close}>
                                Cancel
                            </button>
                            <button class="btn primary" autofocus onClick={() => (setSheet((x) => x && { ...x, confirmPaid: true }), void attempt())}>
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
                    <Match when={phase()?.kind === "error" && (phase() as Extract<Phase, { kind: "error" }>)}>
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
