import { createEffect, createMemo, createResource, createSignal, For, on, onCleanup, Show } from "solid-js";
import { promptPreview } from "../lib/review-comments";
import { AlertTriangle } from "lucide-solid";
import type { RewindPlanInfo, RewindTargetInfo } from "@shared/protocol";
import { app, connFor, handleFor, reportError, rpc, toast } from "../state/app";
import { rewindOpen, rewindTarget, setRewindOpen } from "../state/ui";
import { plural } from "../lib/format";
import { rewindTimes } from "../lib/rewind-times";
import { refreshGitChanges } from "../state/changes";
import { undoRestore } from "../state/actions";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import { userMovedFocus } from "../lib/focus-trap";

/** "Claude Code", "Claude Code and Codex". */
const names = (backends: string[]) => backends.join(" and ");
/**
 * Why everything can't be restored, and what can: one line ("Another session is working here: only Cavvy's edits can be
 * restored."), which also says where the rest is when Claude Code or Codex answered since ("Use git for Claude Code's").
 * With none of Cavvy's edits to restore either (`any` false): "…, so files can't be restored. Use git."
 */
const onlyOwnEdits = (refused: string, backends: string[] | undefined, any: boolean) =>
    any ? `${refused.replace(/\.$/, "")}: only Cavvy's edits can be restored.${backends?.length ? ` Use git for ${names(backends.map((b) => `${b}'s`))}.` : ""}` : `${refused.replace(/\.$/, "")}, so files can't be restored. Use git.`;

/** What answering the prompt changed in files, as far as Cavvy knows. */
function changedLabel(t: RewindTargetInfo): string {
    if (t.forked) return "from before the fork";
    // Without a record of the whole folder, Claude Code and Codex change files with their own tools that Cavvy doesn't see.
    const untracked = t.backends?.length && !t.whole ? `${names(t.backends)} changes not tracked` : undefined;
    if (!t.tracked) return untracked ?? "files not tracked";
    if (t.files) return untracked ? `${plural(t.files, "file")} changed · ${untracked}` : `${plural(t.files, "file")} changed`;
    return untracked ?? "";
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
    // An idle compaction stops for a rewind.
    const busySession = () => Boolean(handleFor(id())?.view.state.busy && !handleFor(id())?.view.state.activity?.idle);
    // Read once the dialog has its session, and again when a response that ran as it opened ends: what can be rewound
    // to, and each one's plan, are only known then.
    const readFor = createMemo(() => (conn() === "open" && rewindOpen() && !busySession() ? id() : undefined));
    const [targets, { mutate }] = createResource(
        readFor,
        (sid) =>
            rpc.call("session.rewindTargets", { id: sid }).catch((e) => {
                if (conn() === "open") reportError(e);
                return [];
            }),
    );
    /** The session's last file restore can still be undone: after a restart too, once the toast's Undo is gone. */
    const [canUndo, { mutate: setCanUndo }] = createResource(readFor, (sid) => rpc.call("session.rewindCanUndo", { id: sid }).catch(() => false));
    /** The prompts, once read for the session the dialog is open for (not while they're read again). */
    const list = () => (targets.state === "ready" ? targets() : undefined);
    /** When each was sent; to the second where the next one up or down would read the same. */
    const times = createMemo(() => rewindTimes(list()?.map((t) => t.at) ?? []));
    createEffect(
        on(rewindOpen, (open) => {
            // Closed, it's for no session: opened next, it doesn't first ask for this one's prompts (deleted by then, say).
            if (!open) {
                setId(undefined);
                mutate(undefined);
                return;
            }
            setId(app.activeId);
            setPlan(undefined);
            // Through undefined, so the plan is fetched again even for the prompt chosen last time.
            setChosen(undefined);
            setChosen(rewindTarget.get());
            rewindTarget.set(undefined);
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
        on([chosen, () => conn() === "open", id, rewindOpen, readFor], ([index, connected, sid, open, reading]) => {
            let current = true;
            onCleanup(() => {
                current = false;
            });
            setPlan(undefined);
            setConfirming(undefined);
            setPlanning(false);
            if (index === undefined || !sid || !connected || !open || !reading) return;
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
        on([list, () => busySession()], ([t, waiting]) => {
            if (!t?.length || waiting || !rewindOpen()) return;
            requestAnimationFrame(() => {
                if (!listEl?.isConnected) return;
                // Not if the user has moved it since the dialog opened.
                const dialog = listEl.closest('[role="dialog"]');
                if (!dialog || userMovedFocus(dialog)) return;
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
    /** How many files the plan restores, those past the list's end too. */
    const listedCount = () => (plan()?.restore.length ?? 0) + (plan()?.more ?? 0);
    /** Nothing to rewind to (yet, or while a response runs): the line, and Close alone. */
    const empty = () => busySession() || list()?.length === 0;
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
    return (
        <Dialog open={rewindOpen()} onClose={close} title={empty() ? "Rewind" : "Rewind to before which prompt?"} width={560} class="rw">
            <Show when={!busySession()} fallback={<div class="panel-empty">Wait for the response to finish, or stop it.</div>}>
                <Show when={list()} fallback={<Spinner />}>
                    <Show when={list()!.length} fallback={<div class="panel-empty">Nothing to rewind to yet.</div>}>
                        <div class="rw-list" ref={listEl} onKeyDown={onListKey}>
                            <For each={list()}>
                                {(t, i) => (
                                    <button class={`rw-item ${chosen() === t.index ? "on" : ""}`} aria-pressed={chosen() === t.index} onClick={() => setChosen(t.index)}>
                                        <span class="radio-dot" />
                                        <span class="rw-text">{promptPreview(t.text) || "(empty prompt)"}</span>
                                        <Show when={changedLabel(t)}>{(label) => <span class="rw-changed">{label()}</span>}</Show>
                                        <Show when={t.at}>{(at) => <time class="rw-changed" dateTime={new Date(at()).toISOString()} title={new Date(at()).toLocaleString()}>{times()[i()]}</time>}</Show>
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
                                    <div class="rw-warn">
                                        <AlertTriangle size={13} />
                                        <span>Files changed before the fork can only be restored in the original session.</span>
                                    </div>
                                </Show>
                                <Show when={plan()!.refused}>
                                    <div class="rw-warn">
                                        <AlertTriangle size={13} />
                                        <span>{onlyOwnEdits(plan()!.refused!, plan()!.backends, plan()!.restore.length > 0)}</span>
                                    </div>
                                </Show>
                                {/* With a refusal, its line says this too. */}
                                <Show when={plan()!.backends?.length && !plan()!.whole && !plan()!.refused}>
                                    <div class="rw-warn">
                                        <AlertTriangle size={13} />
                                        <span>
                                            What {names(plan()!.backends!)} changed in files isn't undone{plan()!.restore.length ? ", except in the files below" : ""}. Use git for that.
                                        </span>
                                    </div>
                                </Show>
                                <Show when={plan()!.restore.length} fallback={<Show when={!plan()!.refused}><div class="rw-none">{plan()!.forked ? "No file changes to undo since the fork." : plan()!.tracked ? (plan()!.backends?.length && !plan()!.whole ? "Cavvy made no file changes to undo since then." : "No file changes to undo since then.") : "File changes from then can't be undone."}</div></Show>}>
                                    {/* Said only when it isn't the row's own count: changes since then, from later prompts or by hand. */}
                                    <Show when={listedCount() !== list()?.find((t) => t.index === chosen())?.files}>
                                        <div class="rw-head">{plan()!.whole ? `${plural(listedCount(), "file")} changed since then:` : `Cavvy changed ${plural(listedCount(), "file")} ${plan()!.forked ? "in this session since the fork" : "since then"}:`}</div>
                                    </Show>
                                    <div class="rw-files">
                                        <For each={plan()!.restore}>
                                            {(r) => (
                                                <div class="rw-file">
                                                    <span class={`rw-action ${r.action === "delete" ? "del" : ""}`}>{r.action === "delete" ? "Delete" : r.action === "create" ? "Recreate" : "Restore"}</span>
                                                    <span class="mono truncate split-path" title={r.path}>
                                                        <span class="dir">{r.path.slice(0, r.path.lastIndexOf("/") + 1)}</span>
                                                        <span class="name">{r.path.slice(r.path.lastIndexOf("/") + 1)}</span>
                                                    </span>
                                                    <Show when={r.outside}>
                                                        <span class="pill warn">changed outside</span>
                                                    </Show>
                                                </div>
                                            )}
                                        </For>
                                    </div>
                                    <Show when={plan()!.more}>
                                        <div class="rw-foot">and {plan()!.more} more</div>
                                    </Show>
                                </Show>
                                <For each={plan()!.skipped}>
                                    {(s) => (
                                        <div class="rw-warn">
                                            <AlertTriangle size={13} />
                                            <span class="mono truncate">{s.path}</span>
                                            <span>{s.reason}</span>
                                        </div>
                                    )}
                                </For>
                                {/* Said already by the line on why only Cavvy's edits can be restored. */}
                                <Show when={!plan()!.whole && !plan()!.refused}>
                                    <div class="rw-foot">Changes made by shell commands aren't undone.</div>
                                </Show>
                                <Show when={confirming()}>
                                    <div class="rw-confirm">
                                        <AlertTriangle size={13} />
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
            {/* Above the buttons: beside them, the row is too wide for the dialog. */}
            <Show when={canUndo.state === "ready" && canUndo() && !busySession()}>
                <div class="rw-undo">
                    <button
                        class="link-btn"
                        disabled={busy()}
                        onClick={() => {
                            const sid = id();
                            if (!sid) return;
                            setCanUndo(false);
                            close();
                            void undoRestore(sid);
                        }}
                    >
                        Undo last restore
                    </button>
                </div>
            </Show>
            <div class="dialog-actions">
                <Show when={empty()}>
                    <span class="grow" />
                </Show>
                <button class="btn ghost" onClick={close}>
                    {empty() ? "Close" : "Cancel"}
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
