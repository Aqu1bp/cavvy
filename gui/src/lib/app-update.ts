// What Settings → About and the rail say about the desktop app's updates from
// main (src/server/app-update.ts), from the server's AppUpdateInfo.

import type { AppUpdateInfo } from "@shared/protocol";
import { ago } from "./format";

export interface UpdateView {
    title: string;
    detail?: string;
    /** The row's button: check again, or update. */
    action?: "check" | "update";
    /** A check or an update under way: a spinner in place of the button. */
    busy: boolean;
    /** Sessions working now, which the restart would stop. */
    warn?: string;
    /**
     * The rail's icon beside Settings, while there's an update or one is running: ready (click
     * to update), busy (a spinner), failed (red; click to try again). `label`: its tooltip, the words it doesn't show.
     */
    rail?: { state: "ready" | "busy" | "failed"; label: string };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** `working`: sessions running a turn now. */
export function updateView(u: AppUpdateInfo | undefined, working: number, now = Date.now()): UpdateView | undefined {
    if (!u) return undefined;
    if (u.unavailable) return { title: "Updates from main", detail: u.unavailable, busy: false };
    if (u.updating) {
        if (u.updating.restarting) return { title: "Restarting Harness…", detail: "The new build is installed.", busy: true, rail: { state: "busy", label: "The update is installed: Harness is restarting" } };
        return {
            title: u.latest ? `Updating to main (${u.latest})…` : "Updating…",
            detail: u.updating.line,
            busy: true,
            warn: working ? `Harness restarts when the build is done: ${plural(working, "session")} working then will stop.` : undefined,
            rail: { state: "busy", label: `Updating Harness: ${u.updating.line}` },
        };
    }
    const failed = u.failed ? { state: "failed" as const, label: `${u.failed.replace(/[.!?]?$/, ".")} Click to try again.` } : undefined;
    if (u.available) {
        const title = u.behind ? `${plural(u.behind, "new change")} on main` : "An update from main";
        return {
            title,
            detail: [`This build ${u.installed} · main ${u.latest}`, u.note].filter(Boolean).join(" · "),
            action: "update",
            busy: u.checking,
            warn: working ? `${plural(working, "session")} working: restarting stops ${working === 1 ? "it" : "them"}.` : undefined,
            rail: failed ?? { state: "ready", label: `${title}. Click to update and restart Harness.` },
        };
    }
    if (u.checking) return { title: "Checking for updates…", detail: u.installed ? `This build ${u.installed}` : undefined, busy: true };
    if (!u.checkedAt) return { title: "Updates from main", detail: "Not checked yet.", action: "check", busy: false };
    const when = ago(u.checkedAt, now);
    return { title: "Harness is up to date", detail: `Built from main ${u.installed} · checked ${when === "now" ? "just now" : `${when} ago`}`, action: "check", busy: false };
}
