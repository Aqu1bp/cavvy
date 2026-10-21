// The diff reader switching back from another worktree (run by gui-review-worktrees.test.ts): the git
// view keeps the other worktree's answer while the session's loads, and that answer says whose it
// is, so the session's own actions (comments above all) stay off until the session's answer comes.
import assert from "node:assert/strict";
import { createRoot, createSignal } from "../../gui/node_modules/solid-js/dist/solid.js";
import { Socket } from "../helpers/gui-socket";

Object.assign(globalThis, {
    window: new EventTarget(),
    document: Object.assign(new EventTarget(), {
        hidden: false,
        visibilityState: "visible",
        documentElement: { dataset: {}, style: { setProperty() {} } },
    }),
});

const { start, rpc, openSession } = await import("../../gui/src/state/app");
const { useGitChanges } = await import("../../gui/src/state/changes");
const { ownOnScreen } = await import("../../gui/src/lib/worktree-work");
const OTHER = "/repo/.claude/worktrees/agent";
const snapshot = { seq: 0, state: { id: "session", cwd: "/repo", filesChanged: 0, busy: false }, turns: [], agents: [] };
const answer = (path: string) => ({ files: [{ path, added: 1, removed: 0 }], added: 1, removed: 0, tracked: true, repo: true, scope: "uncommitted", bases: [], more: 0 });
/** The session's own answer, held back until released. */
let release: (() => void) | undefined;

class ServerSocket extends Socket {
    send(raw: string) {
        super.send(raw);
        const { id, method, params } = JSON.parse(raw);
        const reply = (result: unknown) => queueMicrotask(() => this.message({ id, result }));
        if (method === "hello" || method === "settings.get") reply({});
        else if (["sessions.list", "projects.recent", "providers.list", "models.list"].includes(method)) reply([]);
        else if (method === "session.open") reply(structuredClone(snapshot));
        else if (method === "session.gitChanges") {
            if (params.worktree === OTHER) reply(answer("other-checkout.ts"));
            else release = () => reply(answer("own.ts"));
        } else throw new Error(`Unexpected RPC: ${method}`);
    }
}

globalThis.WebSocket = ServerSocket as unknown as typeof WebSocket;
Object.assign(rpc, { credentials: async () => ({ url: "ws://test", token: "test" }) });
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
let dispose: (() => void) | undefined;

try {
    start();
    await settle();
    Socket.instances[0]!.open();
    await settle();
    const handle = await openSession("session");
    const [worktree, setWorktree] = createSignal<string | undefined>(OTHER);
    const [git] = createRoot((cleanup) => {
        dispose = cleanup;
        return useGitChanges(() => handle, () => "uncommitted", () => undefined, () => undefined, worktree);
    });
    await settle();
    assert.equal(git()?.files[0]?.path, "other-checkout.ts");
    assert.equal(git()?.worktree, OTHER);
    assert.equal(ownOnScreen(worktree(), "uncommitted", git()), false);

    // Back to the session's folder: the other checkout's diff is still the one shown, and isn't taken for the session's.
    setWorktree(undefined);
    await settle();
    assert.equal(git.loading, true);
    assert.equal(git()?.files[0]?.path, "other-checkout.ts");
    assert.equal(ownOnScreen(worktree(), "uncommitted", git()), false);

    release!();
    await settle();
    await settle();
    assert.equal(git()?.files[0]?.path, "own.ts");
    assert.equal(git()?.worktree, undefined);
    assert.equal(ownOnScreen(worktree(), "uncommitted", git()), true);
} finally {
    dispose?.();
    rpc.close();
}
process.exit(0);
