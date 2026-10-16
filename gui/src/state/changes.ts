import { createResource, createSignal } from "solid-js";
import type { ChangesInfo, GitChangesInfo, GitScope } from "@shared/protocol";
import type { SessionHandle } from "./app";
import { reportError, rpc } from "./app";

/** The review pane's views: what git says changed, or only what Harness's edit tools did. */
export type ReviewScope = GitScope | "harness";

/** What the agent's edit tools changed in a session; fetched again as edits land and when a turn ends. */
export function useChanges(handle: () => SessionHandle) {
    return createResource(
        () => ({ id: handle().id, n: handle().view.state.filesChanged, busy: handle().view.state.busy }),
        async ({ id }) => rpc.call("session.changes", { id }).catch((e): ChangesInfo => (reportError(e), { files: [], added: 0, removed: 0, tracked: true })),
    );
}

/** Git's answer, or why there isn't one (a base that's gone, a folder too big). */
export type GitView = GitChangesInfo & { error?: string };

const asked = new Map<string, Promise<GitView>>();

/** One request per session, scope and base at a time: the panel and the pane asking together share it. */
export function fetchGitChanges(id: string, scope: GitScope, base?: string, path?: string): Promise<GitView> {
    const key = JSON.stringify([id, scope, base, path]);
    let p = asked.get(key);
    if (!p) {
        p = rpc
            .call("session.gitChanges", { id, scope, ...(base ? { base } : {}), ...(path !== undefined ? { path } : {}) })
            .catch((e): GitView => ({ repo: true, scope, files: [], added: 0, removed: 0, tracked: true, bases: [], more: 0, error: e instanceof Error ? e.message : String(e) }))
            .finally(() => asked.delete(key));
        asked.set(key, p);
    }
    return p;
}

const [outside, setOutside] = createSignal(0);
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

/** Git's view of a session's folder; fetched again as edits land, when a turn starts or ends, and on changedOutside(). */
export function useGitChanges(handle: () => SessionHandle, scope: () => GitScope = () => "uncommitted", base: () => string | undefined = () => undefined) {
    return createResource(
        () => ({ id: handle().id, scope: scope(), base: base(), n: handle().view.state.filesChanged, busy: handle().view.state.busy, outside: changedOutside() }),
        ({ id, scope, base }) => fetchGitChanges(id, scope, base),
    );
}

/** The view and base last used per session, so the pane reopens the way it was left. */
export const lastView = new Map<string, { scope?: ReviewScope; base?: string }>();
