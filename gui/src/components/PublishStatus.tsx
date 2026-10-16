import { createEffect, createSignal, onCleanup, Show } from "solid-js";
import type { GitPrInfo } from "@shared/protocol";
import type { SessionHandle } from "../state/app";
import { rpc } from "../state/app";
import { sessionReadReady } from "../state/changes";
import { openExternal } from "../lib/platform";
import { PublishDialog } from "./PublishDialog";

/** Mounted only in the visible Changes pane. Focus and timer share the same 60s budget. */
export function PublishStatus(p: { handle: SessionHandle; request?: string; onClose: () => void }) {
    const [pr, setPr] = createSignal<GitPrInfo>();
    const [error, setError] = createSignal<string>();
    let last = 0, generation = 0, pending = false;
    const refresh = async () => {
        if (document.visibilityState !== "visible" || !sessionReadReady(p.handle) || !p.handle.view.state.trusted || pending || Date.now() - last < 60_000) return;
        last = Date.now(); pending = true;
        const version = generation, id = p.handle.id;
        try {
            const result = await rpc.call("session.gitPrState", { id });
            if (version === generation) { setPr(result.pr); setError(undefined); }
        } catch (e) {
            if (version === generation) { setPr(undefined); setError(e instanceof Error ? e.message : String(e)); }
        } finally { if (version === generation) pending = false; }
    };
    createEffect(() => {
        p.handle.id;
        const ready = sessionReadReady(p.handle);
        generation++; last = 0; pending = false; setPr(undefined); setError(undefined);
        if (ready) void refresh();
    });
    const timer = setInterval(() => void refresh(), 60_000);
    const focus = () => void refresh();
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    onCleanup(() => { generation++; clearInterval(timer); window.removeEventListener("focus", focus); document.removeEventListener("visibilitychange", focus); });
    return <>
        <Show when={pr()}><div class="review-note"><button class="link-btn" onClick={() => void openExternal(pr()!.url)}>#{pr()?.number} {pr()?.title} · {pr()?.state}</button> · {pr()?.checks} checks</div></Show>
        <Show when={error()}><div class="review-note" title={error()}>PR state unavailable. Open Push to check the repository.</div></Show>
        <PublishDialog id={p.request} onClose={p.onClose} onPublished={(next) => { generation++; pending = false; setPr(next); setError(undefined); last = Date.now(); }} />
    </>;
}
