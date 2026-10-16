import { createSignal, onCleanup, type JSX } from "solid-js";
import { Dialog } from "./Dialog";

/** Mutations only begin on explicit confirmation; Cancel is the initial focus. */
export function ConfirmDialog(p: {
    open: boolean;
    title: string;
    children: JSX.Element;
    confirmLabel: string;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
}) {
    const [busy, setBusy] = createSignal(false);
    let dismissed = false;
    onCleanup(() => (dismissed = true));
    const close = () => {
        dismissed = true;
        p.onClose();
    };
    const confirm = async () => {
        if (busy()) return;
        dismissed = false;
        setBusy(true);
        try {
            await p.onConfirm();
            if (!dismissed) close();
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open={p.open} onClose={close} title={p.title} width={460}>
            <p>{p.children}</p>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" autofocus onClick={close}>
                    {/* Once confirmed it can't be undone from here: closing leaves it running, and its result still shows. */}
                    {busy() ? "Close" : "Cancel"}
                </button>
                <button class="btn danger" disabled={busy()} onClick={() => void confirm()}>
                    {p.confirmLabel}
                </button>
            </div>
        </Dialog>
    );
}
