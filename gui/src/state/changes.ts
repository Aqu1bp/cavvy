import { createResource, createSignal } from "solid-js";
import type { ChangesInfo, GitChangesInfo, GitScope } from "@shared/protocol";
import { coalesce, type Slot } from "@shared/coalesce";
import type { SessionHandle } from "./app";
import { app, reportError, rpc } from "./app";

/** The review pane's views: what git says changed, or only what Harness's edit tools did. */
export type ReviewScope = GitScope | "harness";

/** A socket opens before its sessions reopen; keep resources paused until adoption. */
export function sessionReadReady(handle: SessionHandle): boolean {
    return app.conn === "open" && handle.ready();
}

/** Visible work that can still edit the folder; the server also enforces idle. */
export function commitUnavailable(handle: SessionHandle | undefined): string | undefined {
    if (!handle) return "This session is no longer open.";
    const state = handle.view.state;
    if ((state.busy && !state.activity?.idle) || state.queued.length || state.interactions.length || state.shells.some((s) => s.running && !s.monitor) || handle.view.agents.some((a) => !a.replayed && (a.status === "running" || a.status === "waiting"))) return "Wait for the session's responses, questions, shells, and tasks to finish before committing.";
    if (!state.trusted) return "Trust this folder before committing: Git runs the repository's hooks.";
}

/** What the agent's edit tools changed in a session; fetched again as edits land and when a turn ends. */
export function useChanges(handle: () => SessionHandle) {
    return createResource(
        () => sessionReadReady(handle()) && { id: handle().id, n: handle().view.state.filesChanged, busy: handle().view.state.busy },
        async ({ id }) =>
            rpc.call("session.changes", { id }).catch((e): ChangesInfo => {
                if (sessionReadReady(handle())) reportError(e);
                return { files: [], added: 0, removed: 0, tracked: true };
            }),
    );
}

/** Git's answer, or why there isn't one (a base that's gone, a folder too big). */
export type GitView = GitChangesInfo & { error?: string };

const asked = new Map<string, Slot<GitView>>();

/**
 * One request per session, scope and base at a time: the panel and the pane asking together
 * share it, and a refresh asked for mid-request (a turn ending during the scan its start
 * began) gets one more, after it.
 */
export function fetchGitChanges(id: string, scope: GitScope, base?: string, path?: string, turnId?: number, worktree?: string): Promise<GitView> {
    return coalesce(asked, JSON.stringify([id, scope, base, path, turnId, worktree]), () =>
        rpc
            .call("session.gitChanges", { id, scope, ...(base ? { base } : {}), ...(path !== undefined ? { path } : {}), ...(turnId !== undefined ? { turnId } : {}), ...(worktree !== undefined ? { worktree } : {}) })
            .catch((e): GitView => ({ repo: true, scope, files: [], added: 0, removed: 0, tracked: true, bases: [], more: 0, error: e instanceof Error ? e.message : String(e) })),
    );
}

const [outside, setOutside] = createSignal(0);
/** Refresh every mounted git view after a user commits. */
export const refreshGitChanges = () => setOutside((n) => n + 1);
let watching = false;

/**
 * Bumped when a folder may have changed behind the sessions' backs: on coming
 * back to the window, and once a terminal panel's shell goes quiet.
 */
export function changedOutside(): number {
    if (!watching) {
        watching = true;
        const bump = () => document.visibilityState === "visible" && setOutside((n) => n + 1);
        window.addEventListener("focus", bump);
        document.addEventListener("visibilitychange", bump);
        let quiet: ReturnType<typeof setTimeout> | undefined;
        rpc.onEvent((e) => {
            if (e.type !== "terminal.data" && e.type !== "terminal.exit") return;
            clearTimeout(quiet);
            quiet = setTimeout(bump, 1500);
        });
    }
    return outside();
}

/**
 * Git's view of a session's folder, or of another `worktree` of its repository; fetched again as edits land,
 * when a turn starts or ends, and on changedOutside().
 */
export function useGitChanges(handle: () => SessionHandle, scope: () => GitScope = () => "uncommitted", base: () => string | undefined = () => undefined, turnId: () => number | undefined = () => undefined, worktree: () => string | undefined = () => undefined) {
    return createResource(
        () => sessionReadReady(handle()) && { id: handle().id, scope: scope(), base: base(), turnId: turnId(), worktree: worktree(), n: handle().view.state.filesChanged, busy: handle().view.state.busy, outside: changedOutside() },
        ({ id, scope, base, turnId, worktree }) => fetchGitChanges(id, scope, base, undefined, turnId, worktree),
    );
}

/**
 * The view last used per session, so the pane reopens the way it was left; for as long as the app runs.
 * `worktree`: another worktree being looked at (the session's own folder when unset), and the view it had.
 */
export const lastView = new Map<string, { scope?: ReviewScope; base?: string; turnId?: number; worktree?: string; own?: { scope: ReviewScope; base?: string } }>();
