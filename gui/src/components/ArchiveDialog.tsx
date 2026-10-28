// Archiving a session that works in a managed worktree: archive it only (the
// default), or remove the worktree too. Removal is PR 13's, unchanged (the
// branch stays, ignored files are listed first), plus a check that every
// commit is on a remote branch; the server checks it all again.

import { createSignal, onCleanup, Show } from "solid-js";
import { AlertTriangle, Info } from "lucide-solid";
import { tildify } from "../lib/format";
import { app, rpc } from "../state/app";
import { archivedWithWorktree } from "../state/actions";
import { archiveRequest, setArchiveRequest } from "../state/ui";
import { errorOf, IgnoredFiles, type FormError } from "./WorktreeDialogs";
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
        <Dialog open onClose={close} title="Archive this session?" subtitle={`“${p.title}”`} width={520}>
            <p class="wt-confirm">
                It works in worktree <span class="mono">{tildify(w.path, app.hello?.homeDir)}</span>
                <Show when={w.branch}>
                    {" "}on branch <span class="mono">{w.branch}</span>
                </Show>
                .
            </p>
            <Show when={!p.offer.removable && p.offer.reason}>
                <div class="plan-note-box">
                    <Info size={14} />
                    <span>The worktree will be kept: {p.offer.reason}</span>
                </div>
            </Show>
            <p class="muted small">
                The branch is kept.
                <Show when={p.offer.removable}> Removing the worktree can't be undone; one with uncommitted changes is kept.</Show>
            </p>
            <Show when={ignored()}>{(i) => <IgnoredFiles names={i().names} total={i().total} />}</Show>
            <Show when={error()}>
                {(m) => (
                    <div class="rw-confirm">
                        <AlertTriangle size={14} />
                        <span>{m().message}</span>
                        <Show when={m().code === "needs_trust"}>
                            <button class="btn secondary sm" disabled={busy()} onClick={() => void remove(ignored()?.confirm, m().folder ?? w.path)}>
                                Trust and remove
                            </button>
                        </Show>
                    </div>
                )}
            </Show>
            <div class="dialog-actions">
                <button class="btn ghost" disabled={busy()} onClick={close}>
                    Cancel
                </button>
                <span class="grow" />
                <Show when={p.offer.removable}>
                    <Show
                        when={ignored()}
                        fallback={
                            <button class="btn danger" disabled={busy()} onClick={() => void remove()}>
                                {busy() ? <Spinner size={12} /> : "Archive and remove worktree"}
                            </button>
                        }
                    >
                        {(i) => (
                            <button class="btn danger" disabled={busy()} onClick={() => void remove(i().confirm)}>
                                {busy() ? <Spinner size={12} /> : "Delete them and remove"}
                            </button>
                        )}
                    </Show>
                </Show>
                <button class="btn primary" autofocus disabled={busy()} onClick={() => void archiveOnly()}>
                    Archive only
                </button>
            </div>
        </Dialog>
    );
}
