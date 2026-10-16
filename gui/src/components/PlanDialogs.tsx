// A plan a session presented: read it, save it as Markdown, or carry it out in
// a new worktree with a session of its own. Opened from the plan card and from
// the side panel (once the card is gone). The server resolves the plan itself
// and checks everything again; these collect the choice and show its answer
// next to the field it's about.

import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { AlertTriangle, Copy, FolderGit2, Save } from "lucide-solid";
import { IMPLEMENT_MODES, type ImplementMode, type ImplementPlanResult, type PlanInfo } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import { basename, tildify } from "../lib/format";
import { canReveal, copyText, revealPath } from "../lib/platform";
import { activate, app, rpc, toast } from "../state/app";
import { chooseFolder } from "../state/actions";
import { planDialog, setPlanDialog } from "../state/ui";
import { errorOf, type FormError } from "./WorktreeDialogs";
import { Markdown } from "./blocks/Markdown";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

export const MODE_CHOICES: Record<ImplementMode, { label: string; hint: string }> = {
    acceptEdits: { label: "Auto-accept edits", hint: "Edits files without asking; asks before commands" },
    default: { label: "Ask for edits", hint: "Asks before edits, commands and other changes" },
    auto: { label: "Auto mode", hint: "A reviewer model approves routine actions; risky ones ask" },
};

const home = (p: string) => tildify(p, app.hello?.homeDir);

/** "Saved …" with what can be done with the file here. */
export function savedToast(path: string) {
    const actions = [
        ...(canReveal ? [{ label: "Reveal in Finder", run: () => revealPath(path) }] : []),
        { label: "Copy path", run: () => copyText(path) },
    ];
    toast(`Saved the plan to ${home(path)}`, "success", actions);
}

export function PlanDialogs() {
    return <Show when={planDialog()} keyed>{(req) => <PlanDialog sessionId={req.sessionId} planId={req.planId} kind={req.kind} />}</Show>;
}

function PlanDialog(p: { sessionId: string; planId?: string; kind: "view" | "save" | "worktree" }) {
    const [info] = createResource(() => rpc.call("session.planInfo", { id: p.sessionId, toolId: p.planId }));
    const [kind, setKind] = createSignal(p.kind);
    /** A dialog that's working can't be closed midway. */
    const [busy, setBusy] = createSignal(false);
    const close = () => !busy() && setPlanDialog(undefined);
    return (
        <Show
            when={info()}
            fallback={
                <Dialog open onClose={close} title="Plan" width={480}>
                    <Show when={info.error} fallback={<Spinner size={16} />}>
                        <div class="rw-confirm">
                            <AlertTriangle size={14} />
                            <span>{info.error instanceof Error ? info.error.message : String(info.error)}</span>
                        </div>
                    </Show>
                </Dialog>
            }
        >
            {(i) => (
                <Switch>
                    <Match when={kind() === "view"}>
                        <ViewPlan info={i()} onClose={close} onSave={() => setKind("save")} onWorktree={() => setKind("worktree")} />
                    </Match>
                    <Match when={kind() === "save"}>
                        <SavePlan sessionId={p.sessionId} info={i()} busy={busy()} setBusy={setBusy} onClose={close} />
                    </Match>
                    <Match when={kind() === "worktree" && !i().git}>
                        <ViewPlan info={i()} onClose={close} onSave={() => setKind("save")} onWorktree={() => undefined} />
                    </Match>
                    <Match when={kind() === "worktree"}>
                        <ImplementPlan sessionId={p.sessionId} info={i()} busy={busy()} setBusy={setBusy} onClose={close} />
                    </Match>
                </Switch>
            )}
        </Show>
    );
}

function ViewPlan(p: { info: PlanInfo; onClose: () => void; onSave: () => void; onWorktree: () => void }) {
    return (
        <Dialog open onClose={p.onClose} title={p.info.title || "Plan"} subtitle={p.info.pending ? "Waiting for your review" : "Presented earlier in this session"} width={680}>
            <div class="plan-body plan-dialog-body">
                <Markdown text={p.info.plan} />
            </div>
            <div class="dialog-actions">
                <button class="btn ghost" onClick={() => void copyText(p.info.plan).then((ok) => ok && toast("Copied the plan", "success"))}>
                    <Copy size={14} /> Copy
                </button>
                <span class="grow" />
                <button class="btn secondary" onClick={p.onSave}>
                    <Save size={14} /> Save plan…
                </button>
                <button class="btn primary" disabled={!p.info.git} title={p.info.notGit} onClick={p.onWorktree}>
                    <FolderGit2 size={14} /> Implement in a new worktree…
                </button>
            </div>
            <Show when={p.info.notGit}>
                <p class="muted small plan-note">{p.info.notGit}</p>
            </Show>
        </Dialog>
    );
}

function SavePlan(p: { sessionId: string; info: PlanInfo; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void }) {
    const [path, setPath] = createSignal(p.info.savePath);
    const [error, setError] = createSignal<FormError>();
    /** The file named exists: Save becomes Replace, for exactly that path. */
    const [exists, setExists] = createSignal<string>();
    const name = () => basename(path()) || basename(p.info.savePath);
    const inProject = () => `${p.info.cwd.replace(/\/+$/, "")}/plans/${name()}`;
    const inHome = () => p.info.savePath.replace(/[^/]+$/, name());
    const edit = (v: string) => {
        setPath(v);
        setExists(undefined);
        setError(undefined);
    };
    const choose = async () => {
        const dir = await chooseFolder({ title: "Choose where to save the plan", action: "Save it here", start: p.info.cwd });
        if (dir) edit(`${dir.replace(/\/+$/, "")}/${name()}`);
    };
    let open = true;
    onCleanup(() => (open = false));
    const save = async () => {
        if (p.busy) return;
        const target = path().trim();
        if (!target) return setError({ field: "location", message: "Enter where to save it." });
        const replace = exists() === target;
        setError(undefined);
        p.setBusy(true);
        try {
            const r = await rpc.call("session.savePlan", { id: p.sessionId, toolId: p.info.id, path: target, replace });
            p.setBusy(false);
            if (open) p.onClose();
            savedToast(r.path);
        } catch (e) {
            if (e instanceof RpcError && e.code === "file_exists") setExists(target);
            else setError(errorOf(e));
        } finally {
            p.setBusy(false);
        }
    };
    return (
        <Dialog open onClose={p.onClose} title="Save plan" subtitle="As a Markdown file, in this project or in the Harness home." width={560}>
            <form
                class="wt-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <label class="wt-field">
                    <span class="wt-label">File</span>
                    <input class="input mono" autofocus spellcheck={false} autocomplete="off" maxLength={4096} disabled={p.busy} value={path()} onInput={(e) => edit(e.currentTarget.value)} aria-invalid={Boolean(error())} />
                    <span class="wt-hint">
                        <button type="button" class="link-btn" disabled={p.busy} onClick={() => edit(inHome())}>
                            Harness home
                        </button>{" "}
                        (never touches the repository) ·{" "}
                        <button type="button" class="link-btn" disabled={p.busy} onClick={() => edit(inProject())}>
                            This project
                        </button>{" "}
                        (to commit with it) ·{" "}
                        <button type="button" class="link-btn" disabled={p.busy} onClick={() => void choose()}>
                            Choose a folder…
                        </button>
                    </span>
                    <span class="wt-hint">Only in {home(p.info.cwd)} or {home(p.info.home)}; a name ending in .md.</span>
                    <Show when={error()}>{(m) => <span class="wt-error">{m().message}</span>}</Show>
                </label>
                <Show when={exists()}>
                    <div class="rw-confirm">
                        <AlertTriangle size={14} />
                        <span>
                            <span class="mono">{home(exists()!)}</span> already exists. Replace it with the plan?
                        </span>
                    </div>
                </Show>
                <div class="dialog-actions">
                    <span class="grow" />
                    <button type="button" class="btn ghost" disabled={p.busy} onClick={p.onClose}>
                        Cancel
                    </button>
                    <Show
                        when={exists() === path().trim() && exists()}
                        fallback={
                            <button type="submit" class="btn primary" disabled={p.busy || !path().trim()}>
                                {p.busy ? <Spinner size={12} /> : "Save"}
                            </button>
                        }
                    >
                        <button type="submit" class="btn danger" disabled={p.busy}>
                            {p.busy ? <Spinner size={12} /> : "Replace"}
                        </button>
                    </Show>
                </div>
            </form>
        </Dialog>
    );
}

function ImplementPlan(p: { sessionId: string; info: PlanInfo; busy: boolean; setBusy: (b: boolean) => void; onClose: () => void }) {
    const git = p.info.git!;
    const [branch, setBranch] = createSignal(git.branch);
    const [base, setBase] = createSignal(git.base);
    const [mode, setMode] = createSignal<ImplementMode>(p.info.mode);
    const [error, setError] = createSignal<FormError>();
    /** The worktree was made but its session didn't start: it's kept, and starting again uses it. */
    const [made, setMade] = createSignal<ImplementPlanResult>();
    const folder = () => branch().trim().replaceAll("/", "-");
    const target = () => made()?.path ?? `${git.main}/.claude/worktrees/${folder()}`;
    const errorFor = (f: FormError["field"]) => (error()?.field === f ? error()!.message : undefined);
    let open = true;
    onCleanup(() => (open = false));

    /** `trust`: a folder the user just agreed to trust, trusted first. */
    const start = async (trust?: string) => {
        if (p.busy) return;
        const b = branch().trim();
        if (!b) return setError({ field: "branch", message: "Enter a branch name." });
        setError(undefined);
        p.setBusy(true);
        try {
            if (trust) await rpc.call("projects.trust", { path: trust, trust: true });
            if (!open) return;
            const before = made();
            const r = await rpc.call("session.implementPlan", { id: p.sessionId, toolId: p.info.id, branch: before?.branch ?? b, base: before ? undefined : base().trim() || undefined, mode: mode(), resume: before?.path });
            if (r.failed || !r.sessionId) {
                setMade(r);
                return;
            }
            p.setBusy(false);
            p.onClose();
            toast(`Implementing the plan on ${r.branch}, in ${home(r.path)}`, "success");
            await activate(r.sessionId);
        } catch (e) {
            setError(errorOf(e));
        } finally {
            p.setBusy(false);
        }
    };

    return (
        <Dialog open onClose={p.onClose} title="Implement in a new worktree" subtitle="A new branch in a folder of its own, and a new session there working on the plan." width={560}>
            <form
                class="wt-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void start(made()?.failed?.code === "needs_trust" ? made()!.failed!.folder : undefined);
                }}
            >
                <label class="wt-field">
                    <span class="wt-label">Branch name</span>
                    <input class="input mono" autofocus spellcheck={false} autocomplete="off" maxLength={200} disabled={p.busy || Boolean(made())} value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} aria-invalid={Boolean(errorFor("branch"))} />
                    <span class="wt-path mono" title={target()}>
                        {target()}
                    </span>
                    <Show when={errorFor("branch") ?? errorFor("location")}>{(m) => <span class="wt-error">{m()}</span>}</Show>
                </label>
                <label class="wt-field">
                    <span class="wt-label">Base</span>
                    <input class="input mono" spellcheck={false} autocomplete="off" placeholder="HEAD" maxLength={200} disabled={p.busy || Boolean(made())} value={base()} onInput={(e) => setBase(e.currentTarget.value)} aria-invalid={Boolean(errorFor("base"))} />
                    <span class="wt-hint">The worktree starts from this commit, so uncommitted changes in {home(p.info.cwd)} don't come along.</span>
                    <Show when={errorFor("base")}>{(m) => <span class="wt-error">{m()}</span>}</Show>
                </label>
                <div class="wt-field" role="radiogroup" aria-label="Permission mode for the new session">
                    <span class="wt-label">The new session</span>
                    <div class="plan-modes">
                        <For each={[...IMPLEMENT_MODES]}>
                            {(m) => (
                                <label class={`plan-mode ${mode() === m ? "on" : ""}`} title={MODE_CHOICES[m].hint}>
                                    <input type="radio" name="plan-mode" value={m} checked={mode() === m} disabled={p.busy} onChange={() => setMode(m)} />
                                    {MODE_CHOICES[m].label}
                                </label>
                            )}
                        </For>
                    </div>
                    <span class="wt-hint">
                        {MODE_CHOICES[p.info.mode].label} is preselected: {p.info.modeWhy}. It gets this session's model, effort and speed, and the plan as its first message.
                    </span>
                </div>
                <Show when={p.info.pending}>
                    <p class="muted small plan-note">This session's plan card is answered without approving it: it stops here, still in plan mode, and changes nothing.</p>
                </Show>
                <Show when={made()?.failed}>
                    {(f) => (
                        <div class="rw-confirm wt-ignored">
                            <AlertTriangle size={14} />
                            <div>
                                <div>
                                    Created worktree <span class="mono">{home(made()!.path)}</span> on branch <span class="mono">{made()!.branch}</span>, but {made()!.sessionId ? "its session didn't get the plan" : "the session couldn't start"}: {f().message}
                                </div>
                                <div>
                                    The worktree is kept, as it's yours now. {made()!.sessionId ? "Open its session to inspect what happened and send the plan again." : "Start again to use it, or remove it from the worktree picker."} Nothing was answered in this session.
                                </div>
                            </div>
                        </div>
                    )}
                </Show>
                <Show when={errorFor("general")}>
                    {(m) => (
                        <div class="rw-confirm">
                            <AlertTriangle size={14} />
                            <span>{m()}</span>
                        </div>
                    )}
                </Show>
                <div class="dialog-actions">
                    <Show when={p.busy}>
                        <span class="muted small">Checking out files; a big repository takes a while…</span>
                    </Show>
                    <span class="grow" />
                    <button type="button" class="btn ghost" disabled={p.busy} onClick={p.onClose}>
                        {made() ? "Close" : "Cancel"}
                    </button>
                    <Switch
                        fallback={
                            <button type="submit" class="btn primary" disabled={p.busy || !branch().trim()}>
                                {p.busy ? <Spinner size={12} /> : made() ? "Start the session" : "Create and start"}
                            </button>
                        }
                    >
                        <Match when={made()?.sessionId}>
                            {(id) => (
                                <button
                                    type="button"
                                    class="btn primary"
                                    onClick={() => {
                                        p.onClose();
                                        void activate(id());
                                    }}
                                >
                                    Open the session
                                </button>
                            )}
                        </Match>
                        <Match when={error()?.code === "needs_trust"}>
                            <button type="button" class="btn primary" disabled={p.busy} onClick={() => void start(error()?.folder ?? p.info.cwd)}>
                                {p.busy ? <Spinner size={12} /> : "Trust and continue"}
                            </button>
                        </Match>
                        <Match when={made()?.failed?.code === "needs_trust"}>
                            <button type="submit" class="btn primary" disabled={p.busy}>
                                {p.busy ? <Spinner size={12} /> : "Trust and continue"}
                            </button>
                        </Match>
                    </Switch>
                </div>
            </form>
        </Dialog>
    );
}
