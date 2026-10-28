import { createSignal, Show } from "solid-js";
import { deleteSession, deleteSessions } from "../state/actions";
import { sessionNames } from "../lib/rail-select";
import { deleteRequest, setDeleteRequest } from "../state/ui";
import { Dialog } from "./ui/Dialog";

/** Asked before deleting a session (or several picked in the rail). Cancel has the focus; Undo comes after, in a toast. */
export function DeleteSessionDialog() {
    const [busy, setBusy] = createSignal(false);
    const close = () => setDeleteRequest(undefined);
    const many = () => {
        const req = deleteRequest();
        return req && "ids" in req ? req : undefined;
    };
    const one = () => {
        const req = deleteRequest();
        return req && "id" in req ? req : undefined;
    };
    const go = async () => {
        const req = deleteRequest();
        if (!req || busy()) return;
        setBusy(true);
        try {
            if ("ids" in req) await deleteSessions(req.ids);
            else await deleteSession(req.id);
        } finally {
            setBusy(false);
            close();
        }
    };
    return (
        <Dialog
            open={Boolean(deleteRequest())}
            onClose={close}
            title={many() ? `Delete ${many()!.ids.length} sessions?` : "Delete this session?"}
            subtitle={
                <Show when={many()} fallback={<>“{one()?.title}” in {one()?.projectName}</>}>
                    {(m) => sessionNames(m().titles)}
                </Show>
            }
            width={480}
        >
            <div class="delete-dialog">
                <p>{many() ? "Their projects' files" : "The project's files"} aren't touched.</p>
            </div>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" autofocus onClick={close}>
                    Cancel
                </button>
                <button class="btn danger" disabled={busy()} onClick={() => void go()}>
                    {many() ? `Delete ${many()!.ids.length} sessions` : "Delete"}
                </button>
            </div>
        </Dialog>
    );
}
