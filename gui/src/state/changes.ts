import { createResource } from "solid-js";
import type { ChangesInfo } from "@shared/protocol";
import type { SessionHandle } from "./app";
import { reportError, rpc } from "./app";

/** What the agent's edit tools changed in a session; fetched again as edits land and when a turn ends. */
export function useChanges(handle: () => SessionHandle) {
    return createResource(
        () => ({ id: handle().id, n: handle().view.state.filesChanged, busy: handle().view.state.busy }),
        async ({ id }) => rpc.call("session.changes", { id }).catch((e): ChangesInfo => (reportError(e), { files: [], added: 0, removed: 0, tracked: true })),
    );
}
