// Recently deleted: the sessions in the trash (kept a week), each with Restore.
// Deleting doesn't ask first (its toast has Undo); this is the way back once
// that toast has gone. A restored session is back in the rail at once, and its
// row here offers to open it.

import { createEffect, createSignal, For, on, Show } from "solid-js";
import { ArchiveRestore } from "lucide-solid";
import type { TrashedSessionSummary } from "@shared/protocol";
import { activate, reportError, rpc } from "../state/app";
import { deletedOpen, setDeletedOpen } from "../state/ui";
import { ago } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

export function RecentlyDeleted() {
    const [list, setList] = createSignal<TrashedSessionSummary[]>();
    const [busy, setBusy] = createSignal<string>();
    const [restored, setRestored] = createSignal<ReadonlySet<string>>(new Set());
    const close = () => setDeletedOpen(false);
    createEffect(
        on(deletedOpen, (open) => {
            if (!open) return;
            setList(undefined);
            setRestored(new Set<string>());
            rpc.call("sessions.trash", {}).then(setList, (e) => (setList([]), reportError(e)));
        }),
    );
    const restore = async (id: string) => {
        setBusy(id);
        try {
            await rpc.call("session.restore", { id });
            setRestored((s) => new Set([...s, id]));
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(undefined);
        }
    };
    return (
        <Dialog open={deletedOpen()} onClose={close} title="Recently deleted" subtitle="Deleted sessions are kept for 7 days." width={480} class="deleted-dialog">
            <Show when={list()} fallback={<div class="deleted-empty"><Spinner /></div>}>
                {(items) => (
                    <Show when={items().length} fallback={<div class="deleted-empty">Nothing deleted in the past week.</div>}>
                        <ul class="deleted-list">
                            <For each={items()}>
                                {(s) => {
                                    const back = () => restored().has(s.id);
                                    return (
                                        <li class={`deleted-row ${back() ? "back" : ""}`}>
                                            <div class="deleted-text">
                                                <span class="deleted-title truncate">{s.title}</span>
                                                <span class="deleted-meta truncate">
                                                    {s.projectName ? `${s.projectName} · ` : ""}
                                                    {back() ? "Restored" : `Deleted ${ago(s.deletedAt) === "now" ? "just now" : `${ago(s.deletedAt)} ago`}`}
                                                </span>
                                            </div>
                                            <Show
                                                when={back()}
                                                fallback={
                                                    <button class="btn sm secondary" disabled={busy() !== undefined} onClick={() => void restore(s.id)}>
                                                        <Show when={busy() === s.id} fallback={<ArchiveRestore size={14} />}>
                                                            <Spinner />
                                                        </Show>
                                                        Restore
                                                    </button>
                                                }
                                            >
                                                <button class="btn sm secondary" onClick={() => (close(), void activate(s.id))}>
                                                    Open
                                                </button>
                                            </Show>
                                        </li>
                                    );
                                }}
                            </For>
                        </ul>
                    </Show>
                )}
            </Show>
        </Dialog>
    );
}
