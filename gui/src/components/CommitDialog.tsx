import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { GitChangesInfo, GitFileDiff } from "@shared/protocol";
import { app, handleFor, rpc } from "../state/app";
import { gitCommit, gitCommitMessage } from "../state/actions";
import { commitUnavailable } from "../state/changes";
import { commitRequest, setCommitRequest } from "../state/ui";
import { mod, os } from "../lib/platform";
import { plural } from "../lib/format";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

/** A file as the Review pane names it in a commit request: its handle when its name was shown redacted, else its name. */
const key = (f: GitFileDiff) => f.pathToken ?? f.path;

export function CommitDialog() {
    const [view, setView] = createSignal<GitChangesInfo>();
    const [paths, setPaths] = createSignal<string[]>([]);
    const [message, setMessage] = createSignal("");
    const [model, setModel] = createSignal<string>();
    const [error, setError] = createSignal<string>();
    const [loading, setLoading] = createSignal(false);
    const [generating, setGenerating] = createSignal(false);
    const [committing, setCommitting] = createSignal(false);
    let revision = 0;
    const close = () => {
        if (!committing()) setCommitRequest(undefined);
    };
    const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

    createEffect(
        on(commitRequest, async (request) => {
            revision++;
            setView(undefined);
            setPaths([]);
            setMessage("");
            setModel(undefined);
            setError(undefined);
            setGenerating(false);
            setLoading(Boolean(request));
            if (!request) return;
            try {
                // Fetch again on opening: the pane may have been left open while git changed.
                const result = await rpc.call("session.gitChanges", { id: request.id, scope: "uncommitted" });
                if (commitRequest() !== request) return;
                setView(result);
                setPaths(request.paths.filter((path) => result.files.some((f) => key(f) === path && f.kind !== "folder" && f.kind !== "repo")));
                if (!result.repo) setError(result.reason ?? "This folder is not a Git repository.");
            } catch (e) {
                if (commitRequest() === request) setError(errorText(e));
            } finally {
                if (commitRequest() === request) setLoading(false);
            }
        }),
    );
    createEffect(
        on(
            () => app.activeId,
            (id) => {
                if (commitRequest() && commitRequest()!.id !== id) close();
            },
            { defer: true },
        ),
    );

    const blocked = () => commitUnavailable(handleFor(commitRequest()?.id));
    const ready = () => !loading() && view()?.repo && paths().length > 0 && !blocked();
    const files = () =>
        view()?.files.filter((f) => commitRequest()?.paths.includes(key(f)) && f.kind !== "folder" && f.kind !== "repo") ?? [];
    /** What's selected, as the server takes it: names, and handles for names shown redacted. */
    const chosen = () => {
        const picked = view()?.files.filter((f) => paths().includes(key(f))) ?? [];
        return { paths: picked.filter((f) => !f.pathToken).map((f) => f.path), tokens: picked.flatMap((f) => (f.pathToken ? [f.pathToken] : [])) };
    };
    const mainBranch = () =>
        view()?.defaultBase?.replace(/^origin\//, "") ??
        (["main", "master"].includes(view()?.head?.branch ?? "") ? view()?.head?.branch : undefined);
    const warning = () =>
        !view()?.head?.branch
            ? "Detached HEAD: this commit will not belong to a branch."
            : view()!.head!.branch === mainBranch()
              ? "You're committing straight to the main branch."
              : undefined;

    const generate = async () => {
        const request = commitRequest();
        if (!request || !ready() || generating() || committing()) return;
        const version = revision;
        setGenerating(true);
        setError(undefined);
        try {
            const { paths: names, tokens } = chosen();
            const result = await gitCommitMessage(request.id, names, tokens);
            if (commitRequest() !== request) return;
            if (revision !== version) {
                setError("The message or files changed while generating. Generate again to replace the draft.");
                return;
            }
            setMessage(result.message);
            setModel(result.model);
        } catch (e) {
            if (commitRequest() === request) setError(errorText(e));
        } finally {
            if (commitRequest() === request) setGenerating(false);
        }
    };
    const commit = async () => {
        const request = commitRequest();
        if (!request || !ready() || !message().trim() || committing() || generating()) return;
        setCommitting(true);
        setError(undefined);
        try {
            const head = view()?.head;
            const { paths: names, tokens } = chosen();
            await gitCommit(request.id, names, message(), head?.branchToken
                ? { branchToken: head.branchToken, detached: false }
                : head?.branch
                  ? { branch: head.branch, detached: false }
                  : { sha: head?.sha, detached: true }, tokens);
            setCommitRequest(undefined);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setCommitting(false);
        }
    };

    // ⌘↵ (Ctrl+Enter elsewhere) in the message commits, as the button's key cap says.
    const onMessageKey = (e: KeyboardEvent) => {
        if (e.key !== "Enter" || e.isComposing || !(os === "macos" ? e.metaKey : e.ctrlKey)) return;
        e.preventDefault();
        void commit();
    };

    return (
        <Dialog
            open={Boolean(commitRequest())}
            onClose={close}
            title={paths().length ? `Commit ${plural(paths().length, "file")}` : "Commit changes"}
            subtitle={view()?.repo ? <>On <span class="mono">{view()?.head?.branch ?? `detached HEAD ${view()?.head?.sha?.slice(0, 7) ?? ""}`}</span></> : undefined}
            width={560}
        >
            <div class="commit-dialog">
                <Show when={!loading()} fallback={<Spinner />}>
                    <Show when={view()?.repo}>
                        <Show when={warning()}>
                            <p class="commit-warning" role="status">{warning()}</p>
                        </Show>
                        <div class="commit-files" role="group" aria-label="Files to commit">
                            <For each={files()}>
                                {(f) => (
                                    <label class="commit-file">
                                        <input
                                            type="checkbox"
                                            checked={paths().includes(key(f))}
                                            disabled={committing()}
                                            onChange={(e) => {
                                                revision++;
                                                // By its handle when its name was shown redacted, as the request and `chosen` go.
                                                setPaths((old) => (e.currentTarget.checked ? [...old, key(f)] : old.filter((p) => p !== key(f))));
                                            }}
                                        />
                                        <span class="mono">{f.from ? `${f.from} → ${f.path}` : f.path}</span>
                                    </label>
                                )}
                            </For>
                            <Show when={!files().length}>
                                <p class="muted">The selected files no longer have changes. Refresh the Review pane.</p>
                            </Show>
                        </div>
                        <label class="sr-only" for="commit-message">
                            Commit message
                        </label>
                        <textarea
                            id="commit-message"
                            class="input mono"
                            rows={7}
                            autofocus
                            placeholder={"Subject (about 72 characters)\n\nOptional body"}
                            value={message()}
                            disabled={committing()}
                            onKeyDown={onMessageKey}
                            onInput={(e) => {
                                revision++;
                                setMessage(e.currentTarget.value);
                            }}
                        />
                        <div class="commit-generate">
                            <button class="btn ghost" disabled={!ready() || generating() || committing()} onClick={() => void generate()}>
                                {generating() ? "Generating…" : "Generate message"}
                            </button>
                            <Show when={model()}>
                                <span class="muted small">Drafted by {model()}.</span>
                            </Show>
                        </div>
                        <p class="muted small">Only the checked files are committed; other changes stay as they are.</p>
                    </Show>
                </Show>
                <Show when={blocked()}>
                    <p class="commit-warning">{blocked()}</p>
                </Show>
                <Show when={error()}>
                    <pre class="commit-error" role="alert">{error()}</pre>
                </Show>
                <div class="dialog-actions">
                    <span class="grow" />
                    <button class="btn ghost" disabled={committing()} onClick={close}>
                        Cancel
                    </button>
                    <span title={blocked()}>
                        <button class="btn primary" disabled={!ready() || !message().trim() || committing() || generating()} onClick={() => void commit()}>
                            {committing() ? "Committing…" : "Commit"}
                            <kbd aria-hidden="true">{os === "macos" ? "⌘↵" : `${mod}+↵`}</kbd>
                        </button>
                    </span>
                </div>
            </div>
        </Dialog>
    );
}
