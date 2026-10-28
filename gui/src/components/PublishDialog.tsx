import { createEffect, createSignal, on, Show } from "solid-js";
import type { GitPublishInfo, GitPrInfo } from "@shared/protocol";
import { handleFor, rpc, toast } from "../state/app";
import { commitUnavailable, refreshGitChanges } from "../state/changes";
import { openExternal } from "../lib/platform";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

export function PublishDialog(p: { id?: string; onClose: () => void; onPublished: (pr?: GitPrInfo) => void }) {
    const [view, setView] = createSignal<GitPublishInfo>();
    const [title, setTitle] = createSignal("");
    const [body, setBody] = createSignal("");
    const [base, setBase] = createSignal("");
    const [draft, setDraft] = createSignal(false);
    const [confirmed, setConfirmed] = createSignal(false);
    const [busy, setBusy] = createSignal(false);
    const [loading, setLoading] = createSignal(false);
    const [error, setError] = createSignal<string>();
    let revision = 0;
    const close = () => { if (!busy()) p.onClose(); };
    const errorText = (e: unknown) => e instanceof Error ? e.message : String(e);
    createEffect(on(() => p.id, async (id) => {
        const version = ++revision;
        setView(undefined);
        setTitle(""); setBody(""); setBase(""); setDraft(false); setConfirmed(false); setError(undefined);
        setLoading(Boolean(id));
        if (!id) return;
        try {
            const info = await rpc.call("session.gitPublishInfo", { id });
            if (revision !== version) return;
            setView(info); setTitle(info.title); setBody(info.body); setBase(info.base ?? "");
        } catch (e) { if (revision === version) setError(errorText(e)); }
        finally { if (revision === version) setLoading(false); }
    }));
    const blocked = () => commitUnavailable(handleFor(p.id))?.replace(/committing/g, "publishing").replace("Git runs the repository's hooks", "Git transports can run configured programs");
    const ready = () => Boolean(view()) && !loading() && !busy() && !blocked() && (!(view()!.protected || view()!.defaultUnknown) || confirmed());
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
        } catch (e) { if (revision === version) setError(errorText(e)); }
        finally { setBusy(false); }
    };
    return (
        <Dialog open={Boolean(p.id)} onClose={close} title="Push and open pull request" width={620}>
            <div class="commit-dialog">
                <Show when={!loading()} fallback={<Spinner />}>
                    <Show when={view()}>
                        <p>Push <strong class="mono">{view()?.branch}</strong> to <strong class="mono">{view()?.remote}/{view()?.target}</strong></p>
                        <p class="mono small publish-destination">{view()?.destination}</p>
                        <p class="muted small">{view()?.ahead ?? "Unknown"} ahead · {view()?.behind ?? "Unknown"} behind</p>
                        <Show when={view()?.protected || view()?.defaultUnknown}>
                            <label class="commit-warning"><input type="checkbox" checked={confirmed()} disabled={busy()} onChange={(e) => setConfirmed(e.currentTarget.checked)} /> I confirm pushing to this protected branch{view()?.defaultUnknown ? " (remote default is unknown)" : ""}.</label>
                        </Show>
                        <Show when={view()?.prError}><p class="commit-warning">PR state unavailable: {view()?.prError}</p></Show>
                        <Show when={view()?.pr}>
                            <button class="link-btn" onClick={() => void openExternal(view()!.pr!.url)}>#{view()?.pr?.number} {view()?.pr?.title} · {view()?.pr?.state}</button>
                        </Show>
                        <Show when={view()?.gh} fallback={<>
                            <p class="muted small">To open pull requests here, install GitHub CLI and run gh auth login.</p>
                            <Show when={view()?.compareUrl}><button class="link-btn" onClick={() => void openExternal(view()!.compareUrl!)}>Compare on GitHub</button></Show>
                        </>}>
                            <label class="commit-message-label" for="pr-base">Base branch</label>
                            <input id="pr-base" class="input mono" value={base()} disabled={busy()} onInput={(e) => setBase(e.currentTarget.value)} />
                            <label class="commit-message-label" for="pr-title">Pull request title</label>
                            <input id="pr-title" class="input" maxlength={250} value={title()} disabled={busy()} onInput={(e) => setTitle(e.currentTarget.value)} />
                            <label class="commit-message-label" for="pr-body">Description</label>
                            <textarea id="pr-body" class="input" rows={6} maxlength={16000} value={body()} disabled={busy()} onInput={(e) => setBody(e.currentTarget.value)} />
                            <label><input type="checkbox" checked={draft()} disabled={busy()} onChange={(e) => setDraft(e.currentTarget.checked)} /> Draft</label>
                        </Show>
                    </Show>
                </Show>
                <Show when={blocked()}><p class="commit-warning">{blocked()}</p></Show>
                <Show when={error()}><pre class="commit-error" role="alert">{error()}</pre></Show>
                <div class="dialog-actions">
                    <button class="btn ghost" disabled={busy()} onClick={close}>Cancel</button>
                    <span class="grow" />
                    <button class="btn" disabled={!ready()} onClick={() => void publish("push")}>{busy() ? "Publishing…" : "Confirm push"}</button>
                    <Show when={view()?.gh}><button class="btn primary" disabled={!ready() || !title().trim() || !base().trim()} onClick={() => void publish("pr")}>Confirm · Open pull request</button></Show>
                </div>
            </div>
        </Dialog>
    );
}
