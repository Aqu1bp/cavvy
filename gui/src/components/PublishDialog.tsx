import { createEffect, createSignal, on, Show } from "solid-js";
import type { GitPublishInfo, GitPrInfo } from "@shared/protocol";
import { handleFor, rpc, toast } from "../state/app";
import { commitUnavailable, refreshGitChanges } from "../state/changes";
import { openExternal } from "../lib/platform";
import { draftedBy } from "../lib/model-name";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

/** Where the branch stands with its upstream: "Up to date", else only the counts that aren't zero. */
export const syncWords = (ahead: number, behind: number) => [ahead ? `${ahead} ahead` : "", behind ? `${behind} behind` : ""].filter(Boolean).join(" · ") || "Up to date";

export function PublishDialog(p: { id?: string; onClose: () => void; onPublished: (pr?: GitPrInfo) => void }) {
    const [view, setView] = createSignal<GitPublishInfo>();
    const [title, setTitle] = createSignal("");
    const [body, setBody] = createSignal("");
    const [base, setBase] = createSignal("");
    const [draft, setDraft] = createSignal(false);
    const [confirmed, setConfirmed] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const [loading, setLoading] = createSignal(false);
    /** What went wrong: Cavvy's own sentence, or git's output (`raw`, shown as it printed it). */
    const [error, setError] = createSignal<{ text: string; raw?: boolean }>();
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
        finally { if (revision === version) setLoading(false); }
    }));
    const blocked = () => commitUnavailable(handleFor(p.id))?.replace(/committing/g, "publishing").replace("Git runs the repository's hooks", "Git transports can run configured programs");
    const ready = () => Boolean(view()) && !loading() && !busy() && !blocked() && (!view()!.protected || confirmed());
    const publish = async (action: "push" | "pr") => {
        const info = view(), id = p.id;
        if (!info || !id || !ready() || (action === "pr" && (!info.gh || !title().trim() || !base().trim()))) return;
        const version = revision;
        setBusy(true); setError(undefined);
        try {
            const result = await rpc.call("session.gitPublish", { id, fingerprint: info.fingerprint, action, confirmProtected: confirmed(), base: base(), title: title(), body: body(), draft: draft() });
            refreshGitChanges();
            toast(result.pr ? `Pushed ${info.remote}/${info.target} · PR #${result.pr.number}` : `Pushed ${info.remote}/${info.target}`, "success");
            if (revision !== version) return;
            p.onPublished(result.pr);
            p.onClose();
        } catch (e) {
            if (revision !== version) return;
            // Signed out since the dialog opened: the button for it, not the CLI's advice.
            if ((e as { code?: string }).code === "sign_in") setView({ ...info, gh: false, ghSignedOut: true });
            else setError({ text: errorText(e), raw: (e as { code?: string }).code === "git" });
        }
        finally { setBusy(false); }
    };
    /** A title and description from the small model; the commits' text stays if it can't. */
    const generate = async () => {
        const id = p.id, version = revision;
        if (!id || !view() || busy() || generating()) return;
        setGenerating(true); setGenError(undefined);
        try {
            const r = await rpc.call("session.gitPrText", { id, base: base().trim() || undefined });
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
    return (
        <Dialog open={Boolean(p.id)} onClose={close} title="Push and open pull request" width={620}>
            <div class="commit-dialog">
                <Show when={!loading()} fallback={<Spinner />}>
                    <Show when={view()}>
                        <p>Push <strong class="mono">{view()?.branch}</strong> to <strong class="mono">{view()?.remote}/{view()?.target}</strong></p>
                        <p class="mono small publish-destination">{view()?.destination}</p>
                        <Show when={!view()?.hasUpstream} fallback={<Show when={view()?.ahead !== undefined && view()?.behind !== undefined}><p class="muted small">{syncWords(view()?.ahead ?? 0, view()?.behind ?? 0)}</p></Show>}>
                            <p class="muted small">New branch</p>
                        </Show>
                        <Show when={view()?.protected}>
                            <label class="commit-warning"><input type="checkbox" checked={confirmed()} disabled={busy()} onChange={(e) => setConfirmed(e.currentTarget.checked)} /> Push to this protected branch</label>
                        </Show>
                        <Show when={view()?.prError}><p class="commit-warning">PR state unavailable: {view()?.prError}</p></Show>
                        <Show when={view()?.pr}>
                            <button class="link-btn" onClick={() => void openExternal(view()!.pr!.url)}>#{view()?.pr?.number} {view()?.pr?.title} · {view()?.pr?.state}</button>
                        </Show>
                        <Show when={view()?.gh} fallback={<>
                            <Show when={view()?.ghSignedOut} fallback={<p class="muted small">Pull requests need the GitHub CLI.</p>}>
                                <button class="btn sm" disabled={busy()} onClick={() => void signIn()}>Sign in to GitHub</button>
                            </Show>
                            <Show when={view()?.compareUrl}><button class="link-btn" onClick={() => void openExternal(view()!.compareUrl!)}>Compare on GitHub</button></Show>
                        </>}>
                            <label class="commit-message-label" for="pr-base">Base</label>
                            <input id="pr-base" class="input mono" value={base()} disabled={busy()} onInput={(e) => setBase(e.currentTarget.value)} />
                            <label class="commit-message-label" for="pr-title">Title</label>
                            <input id="pr-title" class="input" maxlength={250} value={title()} disabled={busy() || generating()} onInput={(e) => setTitle(e.currentTarget.value)} />
                            <label class="commit-message-label" for="pr-body">Description</label>
                            <textarea id="pr-body" class="input" rows={6} maxlength={16000} value={body()} disabled={busy() || generating()} onInput={(e) => setBody(e.currentTarget.value)} />
                            <div class="commit-generate">
                                <button class="btn ghost sm" disabled={busy() || generating()} title={drafted() ? `Drafted by ${draftedBy(drafted()!.model, p.id)}` : undefined} onClick={() => void generate()}>{generating() ? "Generating…" : "Generate"}</button>
                                <Show when={drafted()}>
                                    <button class="link-btn small" disabled={busy()} onClick={undoDraft}>Undo</button>
                                </Show>
                                <Show when={genError()}><span class="commit-warning small" role="status">{genError()}</span></Show>
                            </div>
                            <label><input type="checkbox" checked={draft()} disabled={busy()} onChange={(e) => setDraft(e.currentTarget.checked)} /> Draft</label>
                        </Show>
                    </Show>
                </Show>
                <Show when={blocked()}><p class="commit-warning">{blocked()}</p></Show>
                <Show when={error()}>{(e) => (e().raw ? <pre class="commit-error" role="alert">{e().text}</pre> : <p class="commit-error" role="alert">{e().text}</p>)}</Show>
                <div class="dialog-actions">
                    <button class="btn ghost" disabled={busy()} onClick={close}>Cancel</button>
                    <span class="grow" />
                    <button class="btn" disabled={!ready()} onClick={() => void publish("push")}>{busy() ? "Pushing…" : "Push"}</button>
                    <Show when={view()?.gh}><button class="btn primary" disabled={!ready() || generating() || !title().trim() || !base().trim()} onClick={() => void publish("pr")}>Open pull request</button></Show>
                </div>
            </div>
        </Dialog>
    );
}
