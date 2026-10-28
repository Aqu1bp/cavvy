import { createEffect, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { promptPreview } from "../lib/review-comments";
import { AlertTriangle, FileMinus2, FilePen, History } from "lucide-solid";
import type { RewindPlanInfo, RewindTargetInfo } from "@shared/protocol";
import { app, handleFor, reportError, rpc, toast } from "../state/app";
import { rewindOpen, setRewindOpen } from "../state/ui";
import { plural } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

/** "Claude Code", "Claude Code and Codex". */
const names = (backends: string[]) => backends.join(" and ");

/** What answering the prompt changed in files, as far as Cavvy knows. */
function changedLabel(t: RewindTargetInfo): string {
    if (t.forked) return "from before the fork";
    // Claude Code and Codex change files with their own tools: Cavvy doesn't see what they did.
    const untracked = t.backends?.length ? `${names(t.backends)} changes not tracked` : undefined;
    if (!t.tracked) return untracked ?? "files not tracked";
    if (t.files) return untracked ? `${plural(t.files, "file")} changed · ${untracked}` : `${plural(t.files, "file")} changed`;
    return untracked ?? "no file changes";
}

/** A prompt to preselect when the dialog opens (from a message's rewind button). */
const [target, setTarget] = createSignal<number | undefined>();
export const rewindTarget = { set: setTarget };

export function RewindDialog() {
    /** The session the dialog was opened for; it closes if another one is shown. */
    const [id, setId] = createSignal<string>();
    const [chosen, setChosen] = createSignal<number>();
    const [plan, setPlan] = createSignal<RewindPlanInfo>();
    const [busy, setBusy] = createSignal(false);
    /** Files changed outside Cavvy: restoring them needs a second, explicit click. */
    const [confirming, setConfirming] = createSignal<{ code: boolean; conversation: boolean }>();
    createEffect(() => {
        // Reconnect reopens sessions later; a plan against the old view is no longer safe.
        if (rewindOpen() && app.conn !== "open") setRewindOpen(false);
    });
    const [targets, { refetch }] = createResource(
        () => (app.conn === "open" && rewindOpen() && id() ? id() : undefined),
        (sid) =>
            rpc.call("session.rewindTargets", { id: sid }).catch((e) => {
                if (app.conn === "open") reportError(e);
                return [];
            }),
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
    // Open, the user is back: the session doesn't compact while idle under it (that would change what can be rewound to).
    createEffect(
        on([id, rewindOpen, () => app.conn === "open"], ([sid, open, connected]) => {
            if (!sid || !open || !connected) return;
            void rpc.call("session.draft", { id: sid, present: true, dialog: true }).catch(() => undefined);
            onCleanup(() => void rpc.call("session.draft", { id: sid, present: false, dialog: true }).catch(() => undefined));
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
        on([chosen, () => app.conn === "open", id, rewindOpen], ([index, connected, sid, open]) => {
            let current = true;
            onCleanup(() => {
                current = false;
            });
            setPlan(undefined);
            setConfirming(undefined);
            if (index === undefined || !sid || !connected || !open) return;
            void rpc.call("session.rewindPlan", { id: sid, index }).then(
                (value) => {
                    if (current) setPlan(value);
                },
                (e) => {
                    if (current) reportError(e);
                },
            );
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
            if (conversation && !r.failed.length) handleFor(sid)?.setDraft({ text: r.text, images: r.images, files: r.files });
            for (const f of r.failed) toast(`Couldn't restore ${f.path}: ${f.error}`, "error");
            toast(code && r.restored.length ? `Restored ${plural(r.restored.length, "file")}${conversation ? " and the conversation" : ""}` : "Rewound the conversation", "success");
            close();
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(false);
        }
    };
    // An idle compaction stops for a rewind.
    const busySession = () => Boolean(handleFor(id())?.view.state.busy && !handleFor(id())?.view.state.activity?.idle);
    return (
        <Dialog open={rewindOpen()} onClose={close} title="Rewind" subtitle="Go back to before one of your prompts" width={620}>
            <Show when={!busySession()} fallback={<div class="panel-empty">Wait for the response to finish, or stop it.</div>}>
                <Show when={targets()} fallback={<Spinner />}>
                    <Show when={targets()!.length} fallback={<div class="panel-empty">Nothing to rewind to yet.</div>}>
                        <div class="rw-list">
                            <For each={targets()}>
                                {(t) => (
                                    <button class={`rw-item ${chosen() === t.index ? "on" : ""}`} aria-pressed={chosen() === t.index} onClick={() => setChosen(t.index)}>
                                        <History size={14} />
                                        <span class="truncate">{promptPreview(t.text) || "(empty prompt)"}</span>
                                        <span class="muted small">{changedLabel(t)}</span>
                                    </button>
                                )}
                            </For>
                        </div>
                        <Show when={plan()}>
                            <div class="rw-plan">
                                <Show when={plan()!.forked}>
                                    <div class="rw-file warn">
                                        <AlertTriangle size={13} />
                                        <span class="small">Files changed before the fork can only be restored in the original session.</span>
                                    </div>
                                </Show>
                                <Show when={plan()!.backends?.length}>
                                    <div class="rw-file warn">
                                        <AlertTriangle size={13} />
                                        <span class="small">
                                            What {names(plan()!.backends!)} changed in files isn't undone{plan()!.restore.length ? ", except in the files below" : ""}. Use git for that.
                                        </span>
                                    </div>
                                </Show>
                                <Show when={plan()!.restore.length} fallback={<div class="muted small">{plan()!.forked ? "No file changes to undo since the fork." : plan()!.tracked ? (plan()!.backends?.length ? "Cavvy made no file changes to undo since then." : "No file changes to undo since then.") : "File changes from then can't be undone."}</div>}>
                                    <div class="small">Cavvy changed {plural(plan()!.restore.length, "file")} {plan()!.forked ? "in this session since the fork" : "since then"}:</div>
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
                                <div class="muted small">Changes made by shell commands aren't undone.</div>
                                <Show when={confirming()}>
                                    <div class="rw-confirm">
                                        <AlertTriangle size={14} />
                                        <span>Restoring files marked “changed outside” loses the edits made to them since.</span>
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
