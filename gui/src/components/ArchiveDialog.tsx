// Archiving a session that works in a managed worktree: archive it only (the
// default), or remove the worktree too. Removal is PR 13's, unchanged (the
// branch stays, ignored files are listed first), plus a check that every
// commit is on a remote branch; the server checks it all again.

import { createSignal, For, onCleanup, Show } from "solid-js";
import { tildify } from "../lib/format";
import { app, rpc } from "../state/app";
import { archivedWithWorktree } from "../state/actions";
import { archiveRequest, setArchiveRequest } from "../state/ui";
import { errorOf, type FormError } from "./WorktreeDialogs";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

export function ArchiveDialog() {
    return <Show when={archiveRequest()} keyed>{(r) => <ArchiveWorktree id={r.id} title={r.title} offer={r.offer} />}</Show>;
}

function ArchiveWorktree(p: { id: string; title: string; offer: NonNullable<ReturnType<typeof archiveRequest>>["offer"] }) {
    const w = p.offer.worktree!;
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<FormError>();
    const [ignored, setIgnored] = createSignal<{ names: string[]; total: number; confirm: string }>();
    const close = () => !busy() && setArchiveRequest(undefined);
    let open = true;
    onCleanup(() => (open = false));

    const archiveOnly = async () => {
        if (busy()) return;
        setBusy(true);
        setError(undefined);
        try {
            await rpc.call("session.archive", { id: p.id, archived: true });
            setArchiveRequest(undefined);
            archivedWithWorktree(p.id, { archived: true, removed: false, kept: p.offer.reason ?? "you chose Archive only." });
        } catch (e) {
            setError(errorOf(e));
        } finally {
            setBusy(false);
        }
    };

    /** Busy from start to end: two clicks start one removal. `trust`: a folder the user just agreed to trust, trusted first. */
    const remove = async (deleteIgnored?: string, trust?: string) => {
        if (busy()) return;
        setError(undefined);
        setBusy(true);
        try {
            if (trust) await rpc.call("projects.trust", { path: trust, trust: true });
            if (!open) return;
            const r = await rpc.call("session.archive", { id: p.id, archived: true, removeWorktree: true, deleteIgnored });
            if (!r) return;
            if (!r.archived) return setIgnored({ names: r.ignored, total: r.total, confirm: r.confirm });
            setBusy(false);
            setArchiveRequest(undefined);
            archivedWithWorktree(p.id, r);
        } catch (e) {
            setError(errorOf(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Dialog
            open
            onClose={close}
            title="Archive this session?"
            subtitle={`“${p.title}”`}
            width={480}
            footer={[
                <button class="btn btn-ghost dlg-foot-left" disabled={busy()} onClick={close}>
                    Cancel
                </button>,
                <Show when={p.offer.removable}>
                    <Show
                        when={ignored()}
                        fallback={
                            <button class="btn btn-danger" disabled={busy()} onClick={() => void remove()}>
                                {busy() ? <Spinner size={12} /> : "Archive and remove worktree"}
                            </button>
                        }
                    >
                        {(i) => (
                            <button class="btn btn-danger" disabled={busy()} onClick={() => void remove(i().confirm)}>
                                {busy() ? <Spinner size={12} /> : "Delete them and remove"}
                            </button>
                        )}
                    </Show>
                </Show>,
                <button class="btn btn-primary" autofocus disabled={busy()} onClick={() => void archiveOnly()}>
                    Archive only
                </button>,
            ]}
        >
            <dl class="facts">
                <dt>Worktree</dt>
                <dd class="mono">{tildify(w.path, app.hello?.homeDir)}</dd>
                <Show when={w.branch}>
                    <dt>Branch</dt>
                    <dd>
                        <span class="mono">{w.branch}</span>
                        <span class="dim"> · kept</span>
                    </dd>
                </Show>
            </dl>
            <Show
                when={!p.offer.removable && p.offer.reason}
                fallback={
                    <Show
                        when={ignored()}
                        fallback={<p class="dlg-text">Removing the worktree can't be undone; one with uncommitted changes is kept.</p>}
                    >
                        {(i) => (
                            <div class="note" data-tone="amber">
                                <div class="note-body">
                                    Removing the worktree deletes its ignored files:
                                    <ul class="arc-ignored">
                                        <For each={i().names}>{(n) => <li class="mono">{n}</li>}</For>
                                        <Show when={i().total > i().names.length}>
                                            <li>and {i().total - i().names.length} more</li>
                                        </Show>
                                    </ul>
                                </div>
                            </div>
                        )}
                    </Show>
                }
            >
                {(reason) => (
                    <div class="note">
                        <div class="note-body">{reason()}</div>
                    </div>
                )}
            </Show>
            <Show when={error()}>
                {(m) => (
                    <div class="note" data-tone="red" role="alert">
                        <div class="note-body">{m().message}</div>
                        <Show when={m().code === "needs_trust"}>
                            <button class="btn btn-sm" disabled={busy()} onClick={() => void remove(ignored()?.confirm, m().folder ?? w.path)}>
                                Trust and remove
                            </button>
                        </Show>
                    </div>
                )}
            </Show>
        </Dialog>
    );
}
