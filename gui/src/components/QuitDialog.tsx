import { electron, type QuitAsk } from "../lib/platform";
import { ConfirmDialog } from "./ui/ConfirmDialog";

/**
 * The desktop app's question before it quits (desktop-electron/src/main.ts askInPage): sessions working, or work
 * that couldn't be saved. Cancel has the focus, so Enter doesn't quit; Esc and a click outside cancel.
 */
export function QuitDialog(p: { ask: QuitAsk; onDone: () => void }) {
    let answered = false;
    const answer = (a: "quit" | "cancel") => {
        if (answered) return;
        answered = true;
        electron?.quitReply?.(p.ask.id, a);
        p.onDone();
    };
    return (
        <ConfirmDialog open title={p.ask.title} confirmLabel="Quit" onClose={() => answer("cancel")} onConfirm={() => answer("quit")}>
            {p.ask.detail}
        </ConfirmDialog>
    );
}
