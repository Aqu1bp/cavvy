import { createEffect, createSignal, For, on, Show } from "solid-js";
import type { GitChangesInfo, GitFileDiff } from "@shared/protocol";
import { app, handleFor, rpc } from "../state/app";
import { gitCommit, gitCommitMessage } from "../state/actions";
import { commitUnavailable } from "../state/changes";
import { commitRequest, setCommitRequest } from "../state/ui";
import { mod, os } from "../lib/platform";
import { plural } from "../lib/format";
import { draftedBy } from "../lib/model-name";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import { takeFocus } from "../lib/focus-trap";

/** A file as the Review pane names it in a commit request: its handle when its name was shown redacted, else its name. */
const key = (f: GitFileDiff) => f.pathToken ?? f.path;

export function CommitDialog() {
    const [view, setView] = createSignal<GitChangesInfo>();
    const [paths, setPaths] = createSignal<string[]>([]);
    const [message, setMessage] = createSignal("");
    const [model, setModel] = createSignal<string>();
    /** What was typed before Generate replaced it, for Undo; gone once the box is typed in. */
    const [before, setBefore] = createSignal<string>();
    /** The last draft put in the box: Generate again keeps what was typed before it, not the draft. */
    let lastDraft: string | undefined;
    const [error, setError] = createSignal<string>();
    /** Why Generate couldn't draft a message: under its button, as Suggest's is under its own. */
    const [genError, setGenError] = createSignal<string>();
    const [loading, setLoading] = createSignal(false);
    const [generating, setGenerating] = createSignal(false);
    const [committing, setCommitting] = createSignal(false);
    // Commit to a new branch (offered on the main branch or a detached HEAD): its name, suggested by the small model as
    // the box is ticked and on Suggest, or typed.
    const [toNew, setToNew] = createSignal(false);
    const [newName, setNewName] = createSignal("");
    const [naming, setNaming] = createSignal(false);
    const [nameNote, setNameNote] = createSignal<{ model?: string; error?: string }>();
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
            setBefore(undefined);
            lastDraft = undefined;
            setError(undefined);
            setGenError(undefined);
            setGenerating(false);
            setToNew(false);
            setNewName("");
            setNaming(false);
            setNameNote(undefined);
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
            ? "This commit won't be on a branch."
            : view()!.head!.branch === mainBranch()
              ? "This is the default branch."
              : undefined;

    let messageEl: HTMLTextAreaElement | undefined;
    const generate = async () => {
        const request = commitRequest();
        if (!request || !ready() || generating() || committing()) return;
        const version = revision;
        setGenerating(true);
        setGenError(undefined);
        try {
            const { paths: names, tokens } = chosen();
            const result = await gitCommitMessage(request.id, names, tokens);
            if (commitRequest() !== request) return;
            if (revision !== version) {
                setGenError("Changed while generating. Generate again.");
                return;
            }
            const typed = message();
            if (typed !== lastDraft) setBefore(typed.trim() && typed !== result.message ? typed : undefined);
            lastDraft = result.message;
            setMessage(result.message);
            setModel(result.model);
        } catch (e) {
            if (commitRequest() === request) setGenError(errorText(e).split("\n")[0]!.slice(0, 200));
        } finally {
            if (commitRequest() === request) {
                setGenerating(false);
                // Generate gave up the keyboard as it went busy: back to the message's end, to go on from there.
                if (messageEl && (!document.activeElement || document.activeElement === document.body)) {
                    messageEl.focus();
                    messageEl.setSelectionRange(messageEl.value.length, messageEl.value.length);
                }
            }
        }
    };
    /** What the new branch is for: the message's subject, else what the session is about. */
    const about = () => {
        const h = handleFor(commitRequest()?.id);
        return message().split("\n")[0]!.trim() || h?.view.state.title || h?.view.turns.find((t) => t.prompt)?.prompt?.text || "";
    };
    const suggestName = async () => {
        const request = commitRequest();
        const text = about();
        if (!request || naming()) return;
        if (!text.trim()) return setNameNote({ error: "Write a commit message first." });
        setNaming(true);
        setNameNote(undefined);
        try {
            const r = await rpc.call("session.gitBranchName", { id: request.id, text });
            if (commitRequest() !== request) return;
            setNewName(r.branch);
            setNameNote({ model: r.model });
        } catch (e) {
            if (commitRequest() === request) setNameNote({ error: errorText(e).split("\n")[0]!.slice(0, 200) });
        } finally {
            if (commitRequest() === request) setNaming(false);
        }
    };
    const branching = () => Boolean(warning() && toNew());
    const commit = async () => {
        const request = commitRequest();
        if (!request || !ready() || !message().trim() || committing() || generating() || naming() || (branching() && !newName().trim())) return;
        setCommitting(true);
        setError(undefined);
        setGenError(undefined);
        try {
            const head = view()?.head;
            const { paths: names, tokens } = chosen();
            await gitCommit(request.id, names, message(), head?.branchToken
                ? { branchToken: head.branchToken, detached: false }
                : head?.branch
                  ? { branch: head.branch, detached: false }
                  : { sha: head?.sha, detached: true }, tokens, branching() ? newName().trim() : undefined);
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
                            {/* Ticked, the box below says where the commit goes. */}
                            <Show when={!toNew()}>
                                <p class="commit-warning" role="status">{warning()}</p>
                            </Show>
                            <div class="commit-branch">
                                <label class="check-row">
                                    <input
                                        type="checkbox"
                                        checked={toNew()}
                                        disabled={committing()}
                                        onChange={(e) => {
                                            setToNew(e.currentTarget.checked);
                                            if (e.currentTarget.checked && !newName()) void suggestName();
                                        }}
                                    />
                                    <span>Commit to a new branch</span>
                                </label>
                                <Show when={toNew()}>
                                    <div class="commit-generate">
                                        <input class="input mono grow" aria-label="New branch name" placeholder={naming() ? "Suggesting…" : "feature/my-change"} spellcheck={false} autocomplete="off" maxLength={200} value={newName()} disabled={committing() || naming()} onInput={(e) => setNewName(e.currentTarget.value)} />
                                        <button class="btn ghost sm" disabled={committing() || naming()} title={nameNote()?.model ? `Suggested by ${draftedBy(nameNote()!.model!, commitRequest()?.id)}` : undefined} onClick={() => void suggestName()}>
                                            {naming() ? "Suggesting…" : "Suggest"}
                                        </button>
                                    </div>
                                    <Show when={nameNote()?.error}>{(m) => <span class="wt-error" role="status">{m()}</span>}</Show>
                                </Show>
                            </div>
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
                                <p class="muted">No changes left in these files.</p>
                            </Show>
                        </div>
                    </Show>
                </Show>
                {/* There at once, while the changes load: what's typed straight away lands in it. */}
                <Show when={loading() || view()?.repo}>
                    <label class="sr-only" for="commit-message">
                        Commit message
                    </label>
                    <textarea
                        id="commit-message"
                        class="input mono"
                        rows={7}
                        autofocus
                        // The message takes the keyboard, unless it has been moved on purpose since the dialog opened.
                        ref={(el) => {
                            messageEl = el;
                            // As soon as it's in the page (a key pressed straight after the click is dispatched after this).
                            queueMicrotask(() => (el.isConnected ? takeFocus(el) : requestAnimationFrame(() => takeFocus(el))));
                        }}
                        placeholder="Commit message"
                        value={message()}
                        disabled={committing()}
                        onKeyDown={onMessageKey}
                        onInput={(e) => {
                            revision++;
                            setBefore(undefined);
                            setMessage(e.currentTarget.value);
                        }}
                    />
                    <div class="commit-generate">
                        <button class="btn ghost" disabled={!ready() || generating() || committing()} title={model() ? `Drafted by ${draftedBy(model()!, commitRequest()?.id)}` : undefined} onClick={() => void generate()}>
                            {generating() ? "Generating…" : "Generate message"}
                        </button>
                        <Show when={before() !== undefined && !generating()}>
                            <button class="link-btn small" disabled={committing()} onClick={() => { revision++; setMessage(before()!); setBefore(undefined); messageEl?.focus(); }}>Undo</button>
                        </Show>
                        <Show when={genError()}>{(m) => <span class="wt-error" role="status">{m()}</span>}</Show>
                    </div>
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
                        <button class="btn primary" disabled={!ready() || !message().trim() || committing() || generating() || naming() || (branching() && !newName().trim())} onClick={() => void commit()}>
                            {committing() ? "Committing…" : branching() ? "Commit to new branch" : "Commit"}
                            <kbd aria-hidden="true">{os === "macos" ? "⌘↵" : `${mod}+↵`}</kbd>
                        </button>
                    </span>
                </div>
            </div>
        </Dialog>
    );
}
