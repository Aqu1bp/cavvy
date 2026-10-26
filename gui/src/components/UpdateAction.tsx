import { createSignal } from "solid-js";
import { reconcile } from "solid-js/store";
import { app, reportError, rpc, setApp } from "../state/app";
import { ConfirmDialog } from "./ui/ConfirmDialog";

/**
 * Starting the desktop app's update, wherever it's asked for (the rail's icon, Settings → About): at once, or, while
 * sessions are working, once you confirm, since the restart stops whatever is still running when the build is done.
 * `Confirm` goes wherever `request` is used.
 */
export function createUpdateAction() {
    /** Sessions working when it was asked, while the confirmation is open. */
    const [asking, setAsking] = createSignal(0);
    const [pending, setPending] = createSignal(false);
    const start = async () => {
        setPending(true);
        try {
            setApp("update", reconcile(await rpc.call("app.update.start", {})));
        } catch (e) {
            reportError(e);
        } finally {
            setPending(false);
        }
    };
    const request = () => {
        if (pending() || app.update?.updating) return;
        const working = app.sessions.filter((s) => s.status === "running").length;
        if (working) setAsking(working);
        else void start();
    };
    const Confirm = () => (
        <ConfirmDialog open={asking() > 0} title="Update Cavvy now?" confirmLabel="Update" onClose={() => setAsking(0)} onConfirm={start}>
            {asking() === 1 ? "A session is" : `${asking()} sessions are`} working. Cavvy restarts once the update is built, which stops whatever is still running then.
        </ConfirmDialog>
    );
    return { request, pending, Confirm };
}
