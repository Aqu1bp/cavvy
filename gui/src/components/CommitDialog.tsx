import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { GitChangesInfo } from "@shared/protocol";
import { app, handleFor, rpc } from "../state/app";
import { gitCommit, gitCommitMessage } from "../state/actions";
import { commitUnavailable } from "../state/changes";
import { commitRequest, setCommitRequest } from "../state/ui";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

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
    const close = () => { if (!committing()) setCommitRequest(undefined); };
    const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);

    createEffect(on(commitRequest, async (request) => {
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
            setPaths(request.paths.filter((path) => result.files.some((f) => f.path === path && f.kind !== "folder" && f.kind !== "repo")));
            if (!result.repo) setError(result.reason ?? "This folder is not a Git repository.");
        } catch (e) {
            if (commitRequest() === request) setError(errorText(e));
        } finally {
            if (commitRequest() === request) setLoading(false);
        }
    }));
    createEffect(on(() => app.activeId, (id) => {
        if (commitRequest() && commitRequest()!.id !== id) close();
    }, { defer: true }));

    const blocked = () => commitUnavailable(handleFor(commitRequest()?.id));
    const ready = () => !loading() && view()?.repo && paths().length > 0 && !blocked();
    const files = () => view()?.files.filter((f) => commitRequest()?.paths.includes(f.path) && f.kind !== "folder" && f.kind !== "repo") ?? [];
    const mainBranch = () => view()?.defaultBase?.replace(/^origin\//, "") ?? (["main", "master"].includes(view()?.head?.branch ?? "") ? view()?.head?.branch : undefined);
    const warning = () => !view()?.head?.branch ? "Detached HEAD: this commit will not belong to a branch." : view()!.head!.branch === mainBranch() ? "You are committing directly to the repository's main branch." : undefined;

    const generate = async () => {
        const request = commitRequest();
        if (!request || !ready() || generating() || committing()) return;
        const version = revision;
        setGenerating(true);
        setError(undefined);
        try {
            const result = await gitCommitMessage(request.id, paths());
            if (commitRequest() !== request) return;
            if (revision !== version) {
                setError("The message or selected files changed while generating. Click Generate message again to replace the draft.");
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
            await gitCommit(request.id, paths(), message());
            setCommitRequest(undefined);
        } catch (e) {
            setError(errorText(e));
        } finally {
            setCommitting(false);
        }
    };

    return (
        <Dialog open={Boolean(commitRequest())} onClose={close} title="Commit changes" width={620}>
            <div class="commit-dialog">
                <Show when={!loading()} fallback={<Spinner />}>
                    <Show when={view()?.repo}>
                        <div>Branch: <strong class="mono">{view()?.head?.branch ?? `Detached HEAD ${view()?.head?.sha?.slice(0, 7) ?? ""}`}</strong></div>
                        <Show when={warning()}><p class="commit-warning" role="status">{warning()}</p></Show>
                        <div class="commit-files" aria-label="Files to commit">
                            <For each={files()}>{(f) => (
                                <label class="commit-file">
                                    <input type="checkbox" checked={paths().includes(f.path)} disabled={committing()} onChange={(e) => {
                                        revision++;
                                        setPaths((old) => e.currentTarget.checked ? [...old, f.path] : old.filter((p) => p !== f.path));
                                    }} />
                                    <span class="mono">{f.from ? `${f.from} → ${f.path}` : f.path}</span>
                                </label>
                            )}</For>
                            <Show when={!files().length}><p class="muted">The selected files no longer have changes. Refresh the Review pane.</p></Show>
                        </div>
                        <label class="commit-message-label" for="commit-message">Commit message</label>
                        <textarea id="commit-message" class="input mono" rows={7} autofocus placeholder={"Subject (about 72 characters)\n\nOptional body"} value={message()} disabled={committing()} onInput={(e) => { revision++; setMessage(e.currentTarget.value); }} />
                        <div class="commit-generate">
                            <button class="btn ghost" disabled={!ready() || generating() || committing()} onClick={() => void generate()}>{generating() ? "Generating…" : "Generate message"}</button>
                            <Show when={model()}><span class="muted small">Draft generated by {model()}; you can edit it.</span></Show>
                        </div>
                        <p class="muted small">Commits the checked files' current contents. Other files keep their staged and unstaged changes. Repository hooks run when you commit.</p>
                    </Show>
                </Show>
                <Show when={blocked()}><p class="commit-warning">{blocked()}</p></Show>
                <Show when={error()}><pre class="commit-error" role="alert">{error()}</pre></Show>
                <div class="dialog-actions">
                    <span class="grow" />
                    <button class="btn ghost" disabled={committing()} onClick={close}>Cancel</button>
                    <span title={blocked()}><button class="btn primary" disabled={!ready() || !message().trim() || committing() || generating()} onClick={() => void commit()}>{committing() ? "Committing…" : "Commit"}</button></span>
                </div>
            </div>
        </Dialog>
    );
}
