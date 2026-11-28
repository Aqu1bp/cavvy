import { createEffect, createSignal, on, Show } from "solid-js";
import type { GitPublishInfo, GitPrInfo } from "@shared/protocol";
import { handleFor, rpc, toast } from "../state/app";
import { commitUnavailable, refreshGitChanges } from "../state/changes";
import { openExternal } from "../lib/platform";
import { draftedBy } from "../lib/model-name";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import { takeFocus } from "../lib/focus-trap";

/** Where the branch stands with its upstream: "Up to date", else only the counts that aren't zero. */
export const syncWords = (ahead: number, behind: number) => [ahead ? `${ahead} ahead` : "", behind ? `${behind} behind` : ""].filter(Boolean).join(" · ") || "Up to date";

/**
 * How a failed push is shown: a refused push (`push_failed`), or a pull request that wasn't opened (`pr_failed`), leads
 * with what happened, git's or GitHub's output after it; other git failures are only git's output; anything else is
 * Cavvy's own sentence.
 */
export function publishError(message: string, code?: string): { text?: string; raw?: string } {
    if (code === "push_failed" || code === "pr_failed") {
        const at = message.indexOf("\n");
        const raw = at < 0 ? "" : message.slice(at + 1).trim();
        return { text: at < 0 ? message : message.slice(0, at), ...(raw ? { raw } : {}) };
    }
    return code === "git" ? { raw: message } : { text: message };
}

export function PublishDialog(p: { id?: string; onClose: () => void; onPublished: (pr?: GitPrInfo) => void }) {
    const [view, setView] = createSignal<GitPublishInfo>();
    const [title, setTitle] = createSignal("");
    const [body, setBody] = createSignal("");
    const [base, setBase] = createSignal("");
    const [draft, setDraft] = createSignal(false);
    const [confirmed, setConfirmed] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const [loading, setLoading] = createSignal(false);
    /** What went wrong: Cavvy's own sentence (`text`), git's output (`raw`, shown as it printed it), or both. */
    const [error, setError] = createSignal<{ text?: string; raw?: string }>();
    // Generate: the model that drafted the title and description, what they were before (for Undo), or why it couldn't.
    const [generating, setGenerating] = createSignal(false);
    const [drafted, setDrafted] = createSignal<{ model: string; title: string; body: string }>();
    const [genError, setGenError] = createSignal<string>();
    let revision = 0;
    const close = () => { if (!busy()) p.onClose(); };
    const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
    createEffect(on(() => p.id, async (id) => {
        const version = ++revision;
        setView(undefined);
        setTitle(""); setBody(""); setBase(""); setDraft(false); setConfirmed(false); setError(undefined);
        setGenerating(false); setDrafted(undefined); setGenError(undefined);
        setLoading(Boolean(id));
        if (!id) return;
        try {
            const info = await rpc.call("session.gitPublishInfo", { id });
            if (revision !== version) return;
            setView(info); setTitle(info.title); setBody(info.body); setBase(info.base ?? "");
        } catch (e) {
            // Said as the branch dialog's "Can't fetch: …" says it (GitBranches.tsx).
            const why = errorText(e);
            if (revision === version) setError({ text: `Can't push: ${/^[A-Z][a-z]/.test(why) ? why[0]!.toLowerCase() + why.slice(1) : why}` });
        }
        finally {
            if (revision === version) {
                setLoading(false);
                // The form came (drawn as loading ends) after the dialog gave the keyboard to what it had (Cancel, or
                // nothing): to what's first needed. Not if it was moved since.
                takeFocus(firstNeeded(), firstNeeded() === titleEl);
            }
        }
    }));
    let titleEl: HTMLInputElement | undefined, confirmEl: HTMLInputElement | undefined, pushEl: HTMLButtonElement | undefined;
    /** The protected-branch box (Push waits on it), else the pull request's title, else Push. Marked autofocus too, for the dialog's own first pick. */
    const first = () => (view()?.protected ? "confirm" : prs() ? "title" : "push");
    const firstNeeded = () => ({ confirm: confirmEl, title: titleEl, push: pushEl })[first()];
    const blocked = () => commitUnavailable(handleFor(p.id))?.replace(/committing/g, "publishing").replace("Git runs the repository's hooks", "Git transports can run configured programs");
    const ready = () => Boolean(view()) && !loading() && !busy() && !blocked() && (!view()!.protected || confirmed());
    /** The base typed, else the remote's default the field shows greyed (left empty). */
    const baseOr = () => base().trim() || view()?.base || "";
    const publish = async (action: "push" | "pr") => {
        const info = view(), id = p.id;
        if (!info || !id || !ready() || (action === "pr" && (!prs() || !title().trim() || !baseOr()))) return;
        const version = revision;
        // A new pull request opens on GitHub: what comes next is looking at it. In a browser the tab is opened now,
        // while this is still the click (one opened after the answer would be a blocked pop-up); the desktop app
        // opens none, and opens the page once it's known.
        const tab = action === "pr" ? window.open("", "_blank") : null;
        setBusy(true); setError(undefined);
        try {
            const result = await rpc.call("session.gitPublish", { id, fingerprint: info.fingerprint, action, confirmProtected: confirmed(), base: baseOr(), title: title(), body: body(), draft: draft() });
            refreshGitChanges();
            const pr = result.pr;
            if (pr && action === "pr" && /^https:\/\//i.test(pr.url)) {
                if (tab && !tab.closed) {
                    tab.opener = null;
                    tab.location.href = pr.url;
                } else if (!tab) void openExternal(pr.url);
            } else tab?.close();
            toast(pr && result.created ? `Created PR #${pr.number}` : pr ? `Pushed ${info.remote}/${info.target} · PR #${pr.number}` : `Pushed ${info.remote}/${info.target}`, "success", pr ? { label: "Open", run: () => void openExternal(pr.url) } : undefined);
            if (revision !== version) return;
            p.onPublished(result.pr);
            p.onClose();
        } catch (e) {
            tab?.close();
            if (revision !== version) return;
            // Signed out since the dialog opened: the button for it, not the CLI's advice.
            const code = (e as { code?: string }).code;
            if (code === "sign_in") setView({ ...info, gh: false, ghSignedOut: true });
            else setError(publishError(errorText(e), code));
        }
        finally { setBusy(false); }
    };
    /** A title and description from the small model; the commits' text stays if it can't. */
    const generate = async () => {
        const id = p.id, version = revision;
        if (!id || !view() || busy() || generating()) return;
        setGenerating(true); setGenError(undefined);
        try {
            const r = await rpc.call("session.gitPrText", { id, base: baseOr() || undefined });
            if (revision !== version) return;
            setDrafted({ model: r.model, title: title(), body: body() });
            setTitle(r.title); setBody(r.body);
        } catch (e) {
            if (revision === version) setGenError(errorText(e).split("\n")[0]!.slice(0, 200));
        } finally {
            if (revision === version) setGenerating(false);
        }
    };
    const undoDraft = () => {
        const d = drafted();
        if (!d) return;
        setTitle(d.title); setBody(d.body); setDrafted(undefined);
    };
    // GitHub is only signed out: the session's own card takes it from here, and this closes to let it show.
    const signIn = async () => {
        const id = p.id;
        if (!id) return;
        p.onClose();
        try {
            if ((await rpc.call("session.askSignIn", { id, target: "gh" })) === "signed-in") toast("Signed in to GitHub", "success");
        } catch (e) { toast(errorText(e), "error"); }
    };
    /** The dialog scrolled to its end, where what went wrong is said: the form above may fill it. */
    const reveal = (el: HTMLElement) => requestAnimationFrame(() => el.closest(".dialog-body")?.scrollTo({ top: el.closest(".dialog-body")!.scrollHeight }));
    // In the dialog's footer, so a long error above can't push them out of view. As the other dialogs place them: with
    // two ways to go ahead, Cancel alone on the left; with Push alone, Cancel beside it at the right.
    const cancel = () => <button class="btn ghost" disabled={busy()} onClick={close}>Cancel</button>;
    // A pull request needs the GitHub CLI, and a base that isn't the branch itself (the default branch is only pushed).
    // A branch with an open pull request already: pushing updates it, so there's nothing to fill in (its link is shown).
    const openPr = () => view()?.pr?.state === "open" || view()?.pr?.state === "draft";
    const prs = () => Boolean(view()?.gh) && !(view()?.base && view()?.base === view()?.target) && !openPr();
    const actions = () => (
        <div class="dialog-actions">
            {/* One Cancel, moved by the space around it as the form comes: the keyboard may be on it. */}
            <Show when={!prs()}><span class="grow" /></Show>
            {cancel()}
            <Show when={prs()}><span class="grow" /></Show>
            <button ref={pushEl} autofocus={first() === "push"} class={`btn ${prs() ? "secondary" : "primary"}`} disabled={!ready()} onClick={() => void publish("push")}>{busy() ? "Pushing…" : "Push"}</button>
            <Show when={prs()}><button class="btn primary" disabled={!ready() || generating() || !title().trim() || !baseOr()} onClick={() => void publish("pr")}>Open pull request</button></Show>
        </div>
    );
    // Without the GitHub CLI, signed out of it, or on the base branch, it can only push: titled for that.
    const heading = () => (view() && !prs() ? `Push ${view()!.branch}?` : "Push and open pull request");
    return (
        <Dialog open={Boolean(p.id)} onClose={close} title={heading()} width={620} footer={actions()}>
            <div class="commit-dialog">
                <Show when={!loading()} fallback={<Spinner />}>
                    <Show when={view()}>
                        {/* The title names the branch; this, where it goes (its URL on hover). */}
                        <p title={view()?.destination}>
                            <Show when={view()?.branch !== view()?.target} fallback="To ">Push <strong class="mono">{view()?.branch}</strong> to </Show>
                            <strong class="mono">{view()?.remote}/{view()?.target}</strong>
                        </p>
                        <Show when={!view()?.hasUpstream && view()?.ahead == null} fallback={<Show when={view()?.ahead != null && view()?.behind != null}><p class="muted small">{syncWords(view()?.ahead ?? 0, view()?.behind ?? 0)}</p></Show>}>
                            <p class="muted small">New branch</p>
                        </Show>
                        <Show when={view()?.protected}>
                            <label class="check-row"><input ref={confirmEl} autofocus={first() === "confirm"} type="checkbox" checked={confirmed()} disabled={busy()} onChange={(e) => setConfirmed(e.currentTarget.checked)} /><span class="commit-warning">Push to this protected branch</span></label>
                        </Show>
                        <Show when={view()?.prError}><p class="commit-warning">PR state unavailable: {view()?.prError}</p></Show>
                        <Show when={view()?.pr}>
                            <button class="link-btn" onClick={() => void openExternal(view()!.pr!.url)}>#{view()?.pr?.number} {view()?.pr?.title} · {view()?.pr?.state}</button>
                        </Show>
                        <Show when={prs()} fallback={<Show when={!view()?.gh}>
                            <Show when={!view()?.ghSignedOut}><p class="muted small">Pull requests need the GitHub CLI.</p></Show>
                            {/* Its own width, as the pull request dialog's Sign in to GitHub; the comparison beside it. */}
                            <Show when={view()?.ghSignedOut || view()?.compareUrl}>
                                <div class="commit-generate">
                                    <Show when={view()?.ghSignedOut}>
                                        <button class="btn sm" disabled={busy()} onClick={() => void signIn()}>Sign in to GitHub</button>
                                    </Show>
                                    <Show when={view()?.compareUrl}><button class="link-btn" onClick={() => void openExternal(view()!.compareUrl!)}>Compare on GitHub</button></Show>
                                </div>
                            </Show>
                        </Show>}>
                            <label class="commit-message-label" for="pr-base">Base</label>
                            <input id="pr-base" class="input mono" placeholder={view()?.base ?? "main"} value={base()} disabled={busy()} onInput={(e) => setBase(e.currentTarget.value)} />
                            <label class="commit-message-label" for="pr-title">Title</label>
                            <input ref={titleEl} autofocus={first() === "title"} id="pr-title" class="input" maxlength={250} value={title()} disabled={busy() || generating()} onInput={(e) => setTitle(e.currentTarget.value)} />
                            <label class="commit-message-label" for="pr-body">Description</label>
                            <textarea id="pr-body" class="input" rows={6} maxlength={16000} value={body()} disabled={busy() || generating()} onInput={(e) => setBody(e.currentTarget.value)} />
                            <div class="commit-generate">
                                <button class="btn ghost sm" disabled={busy() || generating()} title={drafted() ? `Drafted by ${draftedBy(drafted()!.model, p.id)}` : undefined} onClick={() => void generate()}>{generating() ? "Generating…" : "Generate"}</button>
                                <Show when={drafted()}>
                                    <button class="link-btn small" disabled={busy()} onClick={undoDraft}>Undo</button>
                                </Show>
                                {/* The pull request's own option, at the row's end, under the description it goes with. */}
                                <label class="check-row pr-draft"><input type="checkbox" checked={draft()} disabled={busy()} onChange={(e) => setDraft(e.currentTarget.checked)} /><span>Draft</span></label>
                                <Show when={genError()}><span class="wt-error" role="status">{genError()}</span></Show>
                            </div>
                        </Show>
                    </Show>
                </Show>
                <Show when={blocked()}><p class="commit-warning">{blocked()}</p></Show>
                {/* Cavvy's sentence in the dialog's own type, then what git printed, as it printed it. */}
                <Show when={error()}>
                    {(e) => (
                        <div class="publish-error" role="alert" ref={reveal}>
                            <Show when={e().text}><p class="tone-err">{e().text}</p></Show>
                            <Show when={e().raw}><pre class="commit-error">{e().raw}</pre></Show>
                        </div>
                    )}
                </Show>
            </div>
        </Dialog>
    );
}
