import { createSignal, type JSX } from "solid-js";
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
    const close = () => {
        if (!busy()) p.onClose();
    };
    const confirm = async () => {
        if (busy()) return;
        setBusy(true);
        try {
            await p.onConfirm();
            p.onClose();
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog open={p.open} onClose={close} title={p.title} width={460}>
            <p>{p.children}</p>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" autofocus disabled={busy()} onClick={close}>
                    Cancel
                </button>
                <button class="btn danger" disabled={busy()} onClick={() => void confirm()}>
                    {p.confirmLabel}
                </button>
            </div>
        </Dialog>
    );
}
