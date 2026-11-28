// Recently deleted: the sessions in the trash (kept a week), each with Restore.
// Deleting doesn't ask first (its toast has Undo); this is the way back once
// that toast has gone. A restored session is back in the rail at once, and its
// row here offers to open it.

import { createEffect, createSignal, For, on, Show } from "solid-js";
import { ArchiveRestore } from "lucide-solid";
import type { TrashedSessionSummary } from "@shared/protocol";
import { activate, reportError, restoredFrom, rpc } from "../state/app";
import { deletedOpen, setDeletedOpen } from "../state/ui";
import { ago } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

export function RecentlyDeleted() {
    const [list, setList] = createSignal<TrashedSessionSummary[]>();
    const [busy, setBusy] = createSignal<string>();
    const [restored, setRestored] = createSignal<ReadonlySet<string>>(new Set());
    const close = () => setDeletedOpen(false);
    /** Each opening asks for its own lists; the servers' are still on their way (nothing's said to be empty meanwhile). */
    let opened = 0;
    const [more, setMore] = createSignal(false);
    /** The servers that didn't say what's deleted there. */
    const [silent, setSilent] = createSignal<string[]>([]);
    createEffect(
        on(deletedOpen, (open) => {
            if (!open) return;
            setList(undefined);
            setRestored(new Set<string>());
            const opening = ++opened;
            const mine = () => opening === opened && deletedOpen();
            setMore(true);
            setSilent([]);
            rpc.call("sessions.trash", {}).then((r) => (Array.isArray(r) ? r : r.rows)).then((here) => mine() && setList((l) => [...here, ...(l ?? [])].sort((a, b) => b.deletedAt - a.deletedAt)), (e) => mine() && (setList((l) => l ?? []), reportError(e)));
            // The servers' follow this machine's own: one that's slow doesn't hold the list.
            rpc.call("sessions.trash", { servers: true }).then((r) => {
                if (!mine()) return;
                const there = Array.isArray(r) ? { rows: r, silent: [] } : r;
                setMore(false);
                setSilent(there.silent);
                if (there.rows.length) setList((l) => [...(l ?? []), ...there.rows].sort((a, b) => b.deletedAt - a.deletedAt));
            }, () => mine() && setMore(false));
        }),
    );
    const restore = async (id: string, on?: string) => {
        setBusy(id);
        try {
            // One deleted on a server is brought back there, through this computer's Cavvy.
            await (on ? rpc.call("servers.relay", { name: on, method: "session.restore", params: { id } }) : rpc.call("session.restore", { id }));
            setRestored((s) => new Set([...s, id]));
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(undefined);
        }
    };
    return (
        <Dialog open={deletedOpen()} onClose={close} title="Recently deleted" subtitle="Deleted sessions are kept for 7 days." width={480} class="deleted-dialog">
            <Show when={list()?.length || !more() ? list() : undefined} fallback={<div class="deleted-empty"><Spinner /></div>}>
                {(items) => (
                    <Show when={items().length} fallback={<div class="deleted-empty">{silent().length ? `Not shown: ${silent().join(", ")}.` : "Nothing deleted in the past week."}</div>}>
                        <ul class="deleted-list">
                            <For each={items()}>
                                {(s) => {
                                    const back = () => restored().has(s.id);
                                    return (
                                        <li class={`deleted-row ${back() ? "back" : ""}`}>
                                            <div class="deleted-text">
                                                <span class="deleted-title truncate">{s.title}</span>
                                                <span class="deleted-meta truncate">
                                                    {s.machine ? `${s.machine} · ` : ""}{s.projectName ? `${s.projectName} · ` : ""}
                                                    {back() ? "Restored" : `Deleted ${ago(s.deletedAt) === "now" ? "just now" : `${ago(s.deletedAt)} ago`}`}
                                                </span>
                                            </div>
                                            <Show
                                                when={back()}
                                                fallback={
                                                    <button class="btn btn-sm" disabled={busy() !== undefined} onClick={() => void restore(s.id, s.machine)}>
                                                        <Show when={busy() === s.id} fallback={<ArchiveRestore size={14} />}>
                                                            <Spinner />
                                                        </Show>
                                                        Restore
                                                    </button>
                                                }
                                            >
                                                <button class="btn btn-sm" onClick={() => (close(), s.machine && restoredFrom(s.id, s.machine), void activate(s.id))}>
                                                    Open
                                                </button>
                                            </Show>
                                        </li>
                                    );
                                }}
                            </For>
                            <Show when={silent().length}><li class="deleted-row" role="status"><span class="deleted-meta">Not shown: {silent().join(", ")}.</span></li></Show>
                        </ul>
                    </Show>
                )}
            </Show>
        </Dialog>
    );
}
