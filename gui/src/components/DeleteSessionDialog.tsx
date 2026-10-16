import { createSignal } from "solid-js";
import { deleteSession } from "../state/actions";
import { UNDO_DELETE_MS } from "../lib/toasts";
import { deleteRequest, setDeleteRequest } from "../state/ui";
import { Dialog } from "./ui/Dialog";

/** Asked before deleting a session: what goes, what stays. Cancel has the focus. */
export function DeleteSessionDialog() {
    const [busy, setBusy] = createSignal(false);
    const close = () => setDeleteRequest(undefined);
    const go = async () => {
        const req = deleteRequest();
        if (!req || busy()) return;
        setBusy(true);
        try {
            await deleteSession(req.id);
        } finally {
            setBusy(false);
            close();
        }
    };
    return (
        <Dialog
            open={Boolean(deleteRequest())}
            onClose={close}
            title="Delete this session?"
            subtitle={
                <>
                    “{deleteRequest()?.title}” in {deleteRequest()?.projectName}
                </>
            }
            width={480}
        >
            <div class="delete-dialog">
                <p>Deletes the conversation, the file copies Harness saved for /rewind, and its pin and unread state. You can undo it for about {UNDO_DELETE_MS / 1000} seconds afterwards.</p>
                <p class="muted">The project's files and git aren't touched. Claude Code and Codex keep their own copies of their conversations in their own stores, which Harness leaves alone.</p>
            </div>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" autofocus onClick={close}>
                    Cancel
                </button>
                <button class="btn danger" disabled={busy()} onClick={() => void go()}>
                    Delete
                </button>
            </div>
        </Dialog>
    );
}
