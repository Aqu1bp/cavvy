import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { promptPreview } from "../lib/review-comments";
import { AlertTriangle, FileMinus2, FilePen, FilePlus2, History } from "lucide-solid";
import type { RewindPlanInfo, RewindTargetInfo } from "@shared/protocol";
import { app, connFor, handleFor, reportError, rpc, toast } from "../state/app";
import { rewindOpen, rewindTarget, setRewindOpen } from "../state/ui";
import { plural } from "../lib/format";
import { rewindTimes } from "../lib/rewind-times";
import { refreshGitChanges } from "../state/changes";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

/** "Claude Code", "Claude Code and Codex". */
const names = (backends: string[]) => backends.join(" and ");
/** Why everything can't be restored, and what can: one line ("Another session is working here: only Cavvy's edits can be restored."). As the terminal's /rewind says it (src/commands/rewind.ts). */
const onlyOwnEdits = (refused: string) => `${refused.replace(/\.$/, "")}: only Cavvy's edits can be restored.`;

/** What answering the prompt changed in files, as far as Cavvy knows. */
function changedLabel(t: RewindTargetInfo): string {
    if (t.forked) return "from before the fork";
    // Without a record of the whole folder, Claude Code and Codex change files with their own tools that Cavvy doesn't see.
    const untracked = t.backends?.length && !t.whole ? `${names(t.backends)} changes not tracked` : undefined;
    if (!t.tracked) return untracked ?? "files not tracked";
    if (t.files) return untracked ? `${plural(t.files, "file")} changed · ${untracked}` : `${plural(t.files, "file")} changed`;
    return untracked ?? "no file changes";
}


/** Put back the files a rewind restored. A failure keeps the toast's Undo, to try again. */
async function undoRestore(sid: string, undo: string): Promise<boolean> {
    try {
        const r = await rpc.call("session.rewindUndo", { id: sid, undo });
        refreshGitChanges();
        for (const f of r.failed) toast(`Couldn't put back ${f.path}: ${f.error}`, "error");
        if (r.restored.length) toast(`Put back ${plural(r.restored.length, "file")}`, "success");
        return true;
    } catch (e) {
        reportError(e);
        return true;
    }
}

export function RewindDialog() {
    /** The session the dialog was opened for; it closes if another one is shown. */
    const [id, setId] = createSignal<string>();
    const [chosen, setChosen] = createSignal<number>();
    const [plan, setPlan] = createSignal<RewindPlanInfo>();
    const [busy, setBusy] = createSignal(false);
    /** The chosen prompt's plan is being worked out (the files are read for it). */
    const [planning, setPlanning] = createSignal(false);
    /** Files changed outside Cavvy: restoring them needs a second, explicit click. */
    const [confirming, setConfirming] = createSignal<{ code: boolean; conversation: boolean }>();
    /** The connection the session's shown over: another machine's, for one of its sessions opened here. */
    const conn = () => connFor(id() ?? app.activeId);
    createEffect(() => {
        // Reconnect reopens sessions later; a plan against the old view is no longer safe.
        if (rewindOpen() && conn() !== "open") setRewindOpen(false);
    });
    const [targets, { refetch }] = createResource(
        () => (conn() === "open" && rewindOpen() && id() ? id() : undefined),
        (sid) =>
            rpc.call("session.rewindTargets", { id: sid }).catch((e) => {
                if (conn() === "open") reportError(e);
                return [];
            }),
    );
    /** When each was sent; to the second where the next one up or down would read the same. */
    const times = createMemo(() => rewindTimes(targets()?.map((t) => t.at) ?? []));
    createEffect(
        on(rewindOpen, (open) => {
            if (!open) return;
            setId(app.activeId);
            setPlan(undefined);
            // Through undefined, so the plan is fetched again even for the prompt chosen last time.
            setChosen(undefined);
            setChosen(rewindTarget.get());
            rewindTarget.set(undefined);
            void refetch();
        }),
    );
    // Open, the user is back: the session doesn't compact while idle under it (that would change what can be rewound to).
    createEffect(
        on([id, rewindOpen, () => conn() === "open"], ([sid, open, connected]) => {
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
        on([chosen, () => conn() === "open", id, rewindOpen], ([index, connected, sid, open]) => {
            let current = true;
            onCleanup(() => {
                current = false;
            });
            setPlan(undefined);
            setConfirming(undefined);
            setPlanning(false);
            if (index === undefined || !sid || !connected || !open) return;
            setPlanning(true);
            void rpc.call("session.rewindPlan", { id: sid, index }).then(
                (value) => {
                    if (current) setPlan(value);
                },
                (e) => {
                    if (current) reportError(e);
                },
            ).finally(() => {
                if (current) setPlanning(false);
            });
        }),
    );
    const close = () => setRewindOpen(false);
    // The prompts come after the dialog has put the keyboard on what it had (Cancel, the first row of the last list, or
    // nothing yet): once they're here (or shown, once a reply ends), it goes to the chosen prompt, else the first, so
    // Tab and Enter start from the list.
    let listEl: HTMLDivElement | undefined;
    createEffect(
        on([targets, () => busySession()], ([t, waiting]) => {
            if (!t?.length || waiting || !rewindOpen()) return;
            requestAnimationFrame(() => {
                if (!listEl?.isConnected) return;
                const chosenRow = listEl.querySelector<HTMLElement>(".rw-item.on");
                const at = document.activeElement;
                if (at === chosenRow || (!chosenRow && listEl.contains(at))) return;
                (chosenRow ?? listEl.querySelector<HTMLElement>(".rw-item"))?.focus();
            });
        }),
    );
    /** Up and Down (round the ends, as the branch dialog's list goes), Home and End move between the prompts; Enter picks one. */
    const onListKey = (e: KeyboardEvent) => {
        const rows = [...(listEl?.querySelectorAll<HTMLElement>(".rw-item") ?? [])];
        const at = rows.indexOf(document.activeElement as HTMLElement);
        if (at < 0 || e.altKey || e.ctrlKey || e.metaKey) return;
        const n = rows.length;
        const to = e.key === "ArrowDown" ? (at + 1) % n : e.key === "ArrowUp" ? (at - 1 + n) % n : e.key === "Home" ? 0 : e.key === "End" ? n - 1 : -1;
        if (to < 0) return;
        e.preventDefault();
        rows[to]!.focus();
    };
    /** Nothing to rewind to: the line, and Cancel alone. */
    const empty = () => !busySession() && targets.state === "ready" && !targets()!.length;
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
            // The files moved under every view of them: the changes chip and pane read them again.
            if (code) refreshGitChanges();
            if (conversation && !r.failed.length) handleFor(sid)?.setDraft({ text: r.text, images: r.images, files: r.files });
            for (const f of r.failed) toast(`Couldn't restore ${f.path}: ${f.error}`, "error");
            const message = code && r.restored.length ? `Restored ${plural(r.restored.length, "file")}${conversation && !r.failed.length ? " and the conversation" : ""}` : "Rewound the conversation";
            const undo = r.undo;
            toast(message, "success", undo ? { label: conversation && !r.failed.length ? "Undo files" : "Undo", run: () => undoRestore(sid, undo) } : undefined);
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
        <Dialog open={rewindOpen()} onClose={close} title="Rewind to before which prompt?" width={620}>
            <Show when={!busySession()} fallback={<div class="panel-empty">Wait for the response to finish, or stop it.</div>}>
                <Show when={targets()} fallback={<Spinner />}>
                    <Show when={targets()!.length} fallback={<div class="panel-empty">Nothing to rewind to yet.</div>}>
                        <div class="rw-list" ref={listEl} onKeyDown={onListKey}>
                            <For each={targets()}>
                                {(t, i) => (
                                    <button class={`rw-item ${chosen() === t.index ? "on" : ""}`} aria-pressed={chosen() === t.index} onClick={() => setChosen(t.index)}>
                                        <History size={14} />
                                        <span class="truncate">{promptPreview(t.text) || "(empty prompt)"}</span>
                                        <span class="muted small">{changedLabel(t)}</span>
                                        <Show when={t.at}>{(at) => <time class="muted small rw-when" dateTime={new Date(at()).toISOString()} title={new Date(at()).toLocaleString()}>{times()[i()]}</time>}</Show>
                                    </button>
                                )}
                            </For>
                        </div>
                        <Show when={planning()}>
                            <Spinner />
                        </Show>
                        <Show when={plan()}>
                            <div class="rw-plan">
                                <Show when={plan()!.forked}>
                                    <div class="rw-file warn">
                                        <AlertTriangle size={13} />
                                        <span class="small">Files changed before the fork can only be restored in the original session.</span>
                                    </div>
                                </Show>
                                <Show when={plan()!.refused}>
                                    <div class="rw-file warn">
                                        <AlertTriangle size={13} />
                                        <span class="small">{onlyOwnEdits(plan()!.refused!)}</span>
                                    </div>
                                </Show>
                                <Show when={plan()!.backends?.length && !plan()!.whole}>
                                    <div class="rw-file warn">
                                        <AlertTriangle size={13} />
                                        <span class="small">
                                            What {names(plan()!.backends!)} changed in files isn't undone{plan()!.restore.length ? ", except in the files below" : ""}. Use git for that.
                                        </span>
                                    </div>
                                </Show>
                                <Show when={plan()!.restore.length} fallback={<Show when={!plan()!.refused}><div class="muted small">{plan()!.forked ? "No file changes to undo since the fork." : plan()!.tracked ? (plan()!.backends?.length && !plan()!.whole ? "Cavvy made no file changes to undo since then." : "No file changes to undo since then.") : "File changes from then can't be undone."}</div></Show>}>
                                    <div class="small">{plan()!.whole ? `${plural(plan()!.restore.length + (plan()!.more ?? 0), "file")} changed since then:` : `Cavvy changed ${plural(plan()!.restore.length + (plan()!.more ?? 0), "file")} ${plan()!.forked ? "in this session since the fork" : "since then"}:`}</div>
                                    <For each={plan()!.restore}>
                                        {(r) => (
                                            <div class="rw-file">
                                                {r.action === "delete" ? <FileMinus2 size={13} class="tone-del" /> : r.action === "create" ? <FilePlus2 size={13} /> : <FilePen size={13} />}
                                                <span class="mono truncate">{r.path}</span>
                                                <span class="muted small">{r.action === "delete" ? "delete" : r.action === "create" ? "recreate" : "restore"}</span>
                                                <Show when={r.outside}>
                                                    <span class="chip tiny warn">changed outside</span>
                                                </Show>
                                            </div>
                                        )}
                                    </For>
                                    <Show when={plan()!.more}>
                                        <div class="muted small">and {plan()!.more} more</div>
                                    </Show>
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
                                {/* Said already by the line on why only Cavvy's edits can be restored. */}
                                <Show when={!plan()!.whole && !plan()!.refused}>
                                    <div class="muted small">Changes made by shell commands aren't undone.</div>
                                </Show>
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
                <Show when={empty()}>
                    <span class="grow" />
                </Show>
                <button class="btn ghost" onClick={close}>
                    Cancel
                </button>
                <Show when={!empty()}>
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
                </Show>
            </div>
        </Dialog>
    );
}
