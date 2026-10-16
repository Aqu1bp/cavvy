import { createEffect, createResource, createSignal, For, on, Show } from "solid-js";
import { AlertTriangle, FileMinus2, FilePen, History } from "lucide-solid";
import type { RewindPlanInfo } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast } from "../state/app";
import { rewindOpen, setRewindOpen } from "../state/ui";
import { plural } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

/** A prompt to preselect when the dialog opens (from a message's rewind button). */
const [target, setTarget] = createSignal<number | undefined>();
export const rewindTarget = { set: setTarget };

export function RewindDialog() {
    /** The session the dialog was opened for; it closes if another one is shown. */
    const [id, setId] = createSignal<string>();
    const [chosen, setChosen] = createSignal<number>();
    const [plan, setPlan] = createSignal<RewindPlanInfo>();
    const [busy, setBusy] = createSignal(false);
    /** Files changed outside Harness: restoring them needs a second, explicit click. */
    const [confirming, setConfirming] = createSignal<{ code: boolean; conversation: boolean }>();
    const [targets, { refetch }] = createResource(
        () => (rewindOpen() && id() ? id() : undefined),
        (sid) => rpc.call("session.rewindTargets", { id: sid }),
    );
    createEffect(
        on(rewindOpen, (open) => {
            if (!open) return;
            setId(app.activeId);
            setPlan(undefined);
            // Through undefined, so the plan is fetched again even for the prompt chosen last time.
            setChosen(undefined);
            setChosen(target());
            setTarget(undefined);
            void refetch();
        }),
    );
    createEffect(
        on(
            () => app.activeId,
            (active) => {
                if (rewindOpen() && active !== id()) close();
            },
            { defer: true },
        ),
    );
    createEffect(
        on(chosen, async (index) => {
            setPlan(undefined);
            setConfirming(undefined);
            if (index === undefined || !id()) return;
            try {
                setPlan(await rpc.call("session.rewindPlan", { id: id()!, index }));
            } catch (e) {
                reportError(e);
            }
        }),
    );
    const close = () => setRewindOpen(false);
    const go = async (code: boolean, conversation: boolean) => {
        const p = plan();
        if (!p || !id()) return;
        const sid = id()!;
        const outside = p.restore.filter((r) => r.outside);
        if (code && outside.length && !confirming()) {
            setConfirming({ code, conversation });
            return;
        }
        setConfirming(undefined);
        setBusy(true);
        try {
            const r = await rpc.call("session.rewind", { id: sid, index: p.index, planId: p.planId, code, conversation });
            if (conversation && !r.failed.length) handleFor(sid)?.setDraft({ text: r.text });
            for (const f of r.failed) toast(`Couldn't restore ${f.path}: ${f.error}`, "error");
            toast(code && r.restored.length ? `Restored ${plural(r.restored.length, "file")}${conversation ? " and the conversation" : ""}` : "Rewound the conversation; the prompt is back in the input box", "success");
            close();
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(false);
        }
    };
    const busySession = () => Boolean(handleFor(id())?.view.state.busy);
    return (
        <Dialog open={rewindOpen()} onClose={close} title="Rewind" subtitle="Go back to before one of your prompts" width={620}>
            <Show when={!busySession()} fallback={<div class="panel-empty">Wait for the current response to finish (or interrupt it) before rewinding.</div>}>
                <Show when={targets()} fallback={<Spinner />}>
                    <Show when={targets()!.length} fallback={<div class="panel-empty">Nothing to rewind to yet. (Prompts from before a compaction can't be rewound to.)</div>}>
                        <div class="rw-list">
                            <For each={targets()}>
                                {(t) => (
                                    <button class={`rw-item ${chosen() === t.index ? "on" : ""}`} onClick={() => setChosen(t.index)}>
                                        <History size={14} />
                                        <span class="truncate">{t.text || "(empty prompt)"}</span>
                                        <span class="muted small">{t.forked ? "from before the fork" : t.tracked ? (t.files ? `${plural(t.files, "file")} changed` : "no file changes") : "files not tracked"}</span>
                                    </button>
                                )}
                            </For>
                        </div>
                        <Show when={plan()}>
                            <div class="rw-plan">
                                <Show when={plan()!.forked}>
                                    <div class="rw-file warn">
                                        <AlertTriangle size={13} />
                                        <span class="small">This prompt is from before the fork. Files changed before the fork can only be restored from the original session.</span>
                                    </div>
                                </Show>
                                <Show
                                    when={plan()!.restore.length}
                                    fallback={<div class="muted small">{plan()!.forked ? "No file changes in this session since the fork; only the conversation can be restored." : plan()!.tracked ? "No file changes to undo since then." : "File changes from then weren't tracked; only the conversation can be restored."}</div>}
                                >
                                    <div class="small">Harness changed {plural(plan()!.restore.length, "file")} {plan()!.forked ? "in this session since the fork" : "since then"}:</div>
                                    <For each={plan()!.restore}>
                                        {(r) => (
                                            <div class="rw-file">
                                                {r.action === "delete" ? <FileMinus2 size={13} class="tone-del" /> : <FilePen size={13} />}
                                                <span class="mono truncate">{r.path}</span>
                                                <span class="muted small">{r.action === "delete" ? "delete" : "restore"}</span>
                                                <Show when={r.outside}>
                                                    <span class="chip tiny warn">changed outside</span>
                                                </Show>
                                            </div>
                                        )}
                                    </For>
                                </Show>
                                <For each={plan()!.skipped}>
                                    {(s) => (
                                        <div class="rw-file warn">
                                            <AlertTriangle size={13} />
                                            <span class="mono truncate">{s.path}</span>
                                            <span class="small">{s.reason}</span>
                                        </div>
                                    )}
                                </For>
                                <div class="muted small">Changes made by shell commands aren't tracked and won't be undone.</div>
                                <Show when={confirming()}>
                                    <div class="rw-confirm">
                                        <AlertTriangle size={14} />
                                        <span>Files marked “changed outside” were edited after Harness last wrote them (by you, another program, or a shell command). Restoring them loses those changes.</span>
                                        <button class="btn danger sm" onClick={() => void go(confirming()!.code, confirming()!.conversation)}>
                                            Restore anyway
                                        </button>
                                    </div>
                                </Show>
                            </div>
                        </Show>
                    </Show>
                </Show>
            </Show>
            <div class="dialog-actions">
                <button class="btn ghost" onClick={close}>
                    Cancel
                </button>
                <span class="grow" />
                <button class="btn secondary" disabled={!plan() || busy() || !plan()!.restore.length} onClick={() => void go(true, false)}>
                    Code only
                </button>
                <button class="btn secondary" disabled={!plan() || busy()} onClick={() => void go(false, true)}>
                    Conversation only
                </button>
                <button class="btn primary" disabled={!plan() || busy() || !plan()!.restore.length} onClick={() => void go(true, true)}>
                    Restore both
                </button>
            </div>
        </Dialog>
    );
}
