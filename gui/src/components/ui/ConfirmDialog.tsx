import { createSignal, onCleanup, type JSX } from "solid-js";
import { Dialog } from "./Dialog";

/** Mutations only begin on explicit confirmation; Cancel is the initial focus. */
export function ConfirmDialog(p: {
    open: boolean;
    title: string;
    children: JSX.Element;
    confirmLabel: string;
    busy?: boolean;
    onClose: () => void;
    onConfirm: () => void | Promise<void>;
}) {
    const [busy, setBusy] = createSignal(false);
    const isBusy = () => busy() || !!p.busy;
    let dismissed = false;
    onCleanup(() => (dismissed = true));
    const close = () => {
        dismissed = true;
        p.onClose();
    };
    const confirm = async () => {
        if (isBusy()) return;
        dismissed = false;
        setBusy(true);
        try {
            await p.onConfirm();
            if (!dismissed) close();
        } finally {
            setBusy(false);
        }
    };
    // The design's confirm: the question, one sentence under it, the buttons in the foot.
    return (
        <Dialog
            open={p.open}
            onClose={close}
            title={p.title}
            subtitle={p.children}
            width={400}
            footer={
                <>
                    <button class="btn" autofocus onClick={close}>
                        {/* Once confirmed it can't be undone from here: closing leaves it running, and its result still shows. */}
                        {isBusy() ? "Close" : "Cancel"}
                    </button>
                    <button class="btn btn-danger-solid" disabled={isBusy()} aria-busy={isBusy()} onClick={() => void confirm()}>
                        {p.confirmLabel}
                    </button>
                </>
            }
        />
    );
}
