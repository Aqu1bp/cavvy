// The rail's update button (Sidebar.tsx loads it only while there's an update): the desktop app's update from main,
// or a downloaded app's to the latest release (lib/app-update.ts says which state it's in).

import { Show } from "solid-js";
import { Download } from "lucide-solid";
import { app } from "../state/app";
import { updateView } from "../lib/app-update";
import { createUpdateAction } from "./UpdateAction";
import { Spinner } from "./ui/bits";

/**
 * Beside Settings while the desktop app has an update from main, or one is running: one click updates it, and Cavvy
 * restarts once the new build is installed. Its look says how it stands (the accent: ready; a spinner: building or
 * restarting; red: the last one failed, click to try again), its tooltip the rest. Settings → About has the detail.
 */
export function UpdateButton() {
    const rail = () => updateView(app.update, 0)?.rail;
    const update = createUpdateAction();
    return (
        <>
            <Show when={rail()}>
                {(r) => (
                    <button class="icon-btn update-btn" data-state={r().state} title={r().label} aria-label={r().label} aria-busy={r().state === "busy" || undefined} aria-disabled={r().state === "busy" || update.pending() || undefined} onClick={update.request}>
                        {r().state === "busy" ? (r().progress !== undefined ? <ProgressRing share={r().progress!} /> : <Spinner size={14} />) : <Download size={15} />}
                    </button>
                )}
            </Show>
            <update.Confirm />
        </>
    );
}

/** How much of a download has come, as a ring that fills: drawn anew only when the share moves (every 2%). */
function ProgressRing(p: { share: number }) {
    const r = 6.5;
    const c = 2 * Math.PI * r;
    return (
        <svg class="upd-ring" width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" stroke-opacity="0.25" stroke-width="2" />
            <circle cx="8" cy="8" r={r} fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-dasharray={`${c}`} stroke-dashoffset={`${c * (1 - Math.min(1, Math.max(0, p.share)))}`} transform="rotate(-90 8 8)" />
        </svg>
    );
}
