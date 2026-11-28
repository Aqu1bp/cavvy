// A plan a session presented: read it, save it as Markdown, or carry it out in
// a new worktree with a session of its own. Opened from the plan card and from
// the side panel (once the card is gone). The server resolves the plan itself
// and checks everything again; these collect the choice and show its answer
// next to the field it's about.

import { createResource, createSignal, For, Match, onCleanup, Show, Switch } from "solid-js";
import { IMPLEMENT_MODES, type ImplementMode, type ImplementPlanResult, type PlanInfo } from "@shared/protocol";
import { RpcError } from "../lib/rpc";
import { basename, tildify } from "../lib/format";
import { copyText, revealPath } from "../lib/platform";
import { activate, app, awayMachine, revealsIn, rpc, rpcFor, sameMachine, toast } from "../state/app";
import { chooseFolder } from "../state/actions";
import { planDialog, setFolderPickerOpen, setPlanDialog } from "../state/ui";
import { errorOf, type FormError } from "./WorktreeDialogs";
import { Markdown } from "./blocks/Markdown";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import { tip } from "../lib/tip";
import "../styles/plan-dialogs.css";

export const MODE_CHOICES: Record<ImplementMode, { label: string; hint: string }> = {
    acceptEdits: { label: "Auto-accept edits", hint: "Edits files without asking; asks before commands" },
    default: { label: "Ask for edits", hint: "Asks before edits, commands and other changes" },
    auto: { label: "Auto mode", hint: "A reviewer model approves routine actions; risky ones ask" },
};

const home = (p: string) => tildify(p, app.hello?.homeDir);

/** "Saved …" with what can be done with the file here. */
export function savedToast(path: string, sessionId: string) {
    const actions = [
        ...(revealsIn(sessionId) ? [{ label: "Reveal in Finder", run: () => revealPath(path) }] : []),
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
            when={!info.error && info()}
            fallback={
                <Dialog open onClose={close} title="Plan" width={480}>
                    <Show when={info.error} fallback={<div class="blank"><Spinner size={14} class="blank-spinner" /></div>}>
                        <div class="note" data-tone="red">
                            <span class="note-body">{info.error instanceof Error ? info.error.message : String(info.error)}</span>
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
        <Dialog
            open
            onClose={p.onClose}
            title={p.info.title || "Plan"}
            subtitle={p.info.pending ? "Waiting for your review" : "Presented earlier in this session"}
            width={680}
            class="plan-view"
            footer={[
                <button class="copy-btn btn dlg-foot-left" onClick={() => void copyText(p.info.plan).then((ok) => ok && toast("Copied the plan", "success"))}>
                    Copy
                </button>,
                <button class="btn" onClick={p.onSave}>
                    Save plan…
                </button>,
                <button class="btn btn-primary" disabled={!p.info.git} {...(p.info.notGit ? tip(p.info.notGit) : {})} onClick={p.onWorktree}>
                    Implement in a new worktree…
                </button>,
            ]}
        >
            <Markdown text={p.info.plan} />
            <Show when={p.info.notGit}>
                <div class="note">
                    <div class="note-body">{p.info.notGit}</div>
                </div>
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
        const o = { title: "Choose where to save the plan", action: "Save it here", start: p.info.cwd };
        // Saved on the session's machine: another machine's folders are chosen from its own, not this computer's picker.
        const dir = await (awayMachine(p.sessionId) === undefined ? chooseFolder(o) : new Promise<string | undefined>((then) => setFolderPickerOpen({ then, link: rpcFor(p.sessionId), ...o })));
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
            savedToast(r.path, p.sessionId);
        } catch (e) {
            if (e instanceof RpcError && e.code === "file_exists") setExists(target);
            else setError(errorOf(e));
        } finally {
            p.setBusy(false);
        }
    };
    const formId = "plan-save-form";
    const replacing = () => Boolean(exists()) && exists() === path().trim();
    return (
        <Dialog
            open
            onClose={p.onClose}
            title="Save plan"
            subtitle="As a Markdown file"
            width={500}
            footer={[
                <button type="button" class="btn" disabled={p.busy} onClick={p.onClose}>
                    Cancel
                </button>,
                <button type="submit" form={formId} class={replacing() ? "btn btn-danger-solid" : "btn btn-primary"} disabled={p.busy || !path().trim()}>
                    {p.busy ? <Spinner size={12} /> : replacing() ? "Replace" : "Save"}
                </button>,
            ]}
        >
            <form
                id={formId}
                class="form-stack"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <label class="field">
                    <span class="field-label">File</span>
                    <input class="input mono" autofocus spellcheck={false} autocomplete="off" maxLength={4096} disabled={p.busy} value={path()} onInput={(e) => edit(e.currentTarget.value)} aria-invalid={Boolean(error() || replacing())} />
                    <Show
                        when={error() ?? (replacing() ? { message: "That file exists." } : undefined)}
                    >
                        {(m) => <span class="field-hint field-error">{m().message}</span>}
                    </Show>
                </label>
                <div class="plan-quick">
                    <button type="button" class="btn btn-sm" disabled={p.busy} {...tip("Never touches the repository")} onClick={() => edit(inHome())}>
                        Cavvy home
                    </button>
                    <button type="button" class="btn btn-sm" disabled={p.busy} {...tip("To commit with it")} onClick={() => edit(inProject())}>
                        This project
                    </button>
                    <button type="button" class="btn btn-sm" disabled={p.busy} onClick={() => void choose()}>
                        Choose a folder…
                    </button>
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
            // On the plan's session's machine, where it's carried out.
            if (trust) await rpcFor(p.sessionId).call("projects.trust", { path: trust, trust: true });
            if (!open) return;
            const before = made();
            const r = await rpc.call("session.implementPlan", { id: p.sessionId, toolId: p.info.id, branch: before?.branch ?? b, base: base().trim() || undefined, mode: mode(), resume: before?.path });
            // Made where the plan's session is: on another machine, if that's where it was opened from.
            if (r.sessionId) sameMachine(p.sessionId, r.sessionId);
            if (r.failed || !r.sessionId) {
                setMade(r);
                return;
            }
            p.setBusy(false);
            p.onClose();
            toast(`Implementing the plan on ${r.branch}`, "success");
            await activate(r.sessionId);
        } catch (e) {
            setError(errorOf(e));
        } finally {
            p.setBusy(false);
        }
    };

    const formId = "plan-implement-form";
    return (
        <Dialog
            open
            onClose={p.onClose}
            title="Implement in a new worktree"
            subtitle={p.info.pending ? "This session stops here, still in plan mode." : "A new branch, folder and session for the plan."}
            width={480}
            footer={[
                <Show when={p.busy}>
                    <span class="dlg-foot-note plan-busy">
                        <Spinner size={12} />
                        Checking out files…
                    </span>
                </Show>,
                <button type="button" class="btn" disabled={p.busy} onClick={p.onClose}>
                    {made() ? "Close" : "Cancel"}
                </button>,
                <Switch
                    fallback={
                        <button type="submit" form={formId} class="btn btn-primary" disabled={p.busy || !branch().trim()}>
                            {made() ? "Start the session" : "Create and start"}
                        </button>
                    }
                >
                    <Match when={made()?.sessionId}>
                        {(id) => (
                            <button
                                type="button"
                                class="btn btn-primary"
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
                        <button type="button" class="btn btn-primary" disabled={p.busy} onClick={() => void start(error()?.folder ?? p.info.cwd)}>
                            Trust and continue
                        </button>
                    </Match>
                    <Match when={made()?.failed?.code === "needs_trust"}>
                        <button type="submit" form={formId} class="btn btn-primary" disabled={p.busy}>
                            Trust and continue
                        </button>
                    </Match>
                </Switch>,
            ]}
        >
            <form
                id={formId}
                class="form-stack"
                onSubmit={(e) => {
                    e.preventDefault();
                    void start(made()?.failed?.code === "needs_trust" ? made()!.failed!.folder : undefined);
                }}
            >
                <label class="field">
                    <span class="field-label">Branch name</span>
                    <input class="input mono" autofocus spellcheck={false} autocomplete="off" placeholder="feature/my-change" maxLength={200} disabled={p.busy || Boolean(made())} value={branch()} onInput={(e) => setBranch(e.currentTarget.value)} aria-invalid={Boolean(errorFor("branch"))} />
                    <Show when={errorFor("branch") ?? errorFor("location")} fallback={<span class="field-hint"><span class="mono" title={target()}>{target()}</span></span>}>
                        {(m) => <span class="field-hint field-error">{m()}</span>}
                    </Show>
                </label>
                <label class="field">
                    <span class="field-label">Base</span>
                    <input class="input mono" spellcheck={false} autocomplete="off" placeholder="HEAD" maxLength={200} disabled={p.busy || Boolean(made())} value={base()} onInput={(e) => setBase(e.currentTarget.value)} aria-invalid={Boolean(errorFor("base"))} />
                    <Show when={errorFor("base")} fallback={<span class="field-hint">Uncommitted changes in {home(p.info.cwd)} don't come along.</span>}>
                        {(m) => <span class="field-hint field-error">{m()}</span>}
                    </Show>
                </label>
                <div class="field">
                    <span class="field-label" id="plan-mode-label">
                        The new session
                    </span>
                    <div class="option-list" role="radiogroup" aria-labelledby="plan-mode-label">
                        <For each={[...IMPLEMENT_MODES]}>
                            {(m) => (
                                <button type="button" role="radio" aria-checked={mode() === m} class="option plan-option" disabled={p.busy} data-tip={MODE_CHOICES[m].hint} onClick={() => setMode(m)}>
                                    <span class="radio-dot" />
                                    <span class="option-title">{MODE_CHOICES[m].label}</span>
                                </button>
                            )}
                        </For>
                    </div>
                </div>
                <Show when={made()?.failed}>
                    {(f) => (
                        <div class="note" data-tone="red" role="alert">
                            <div class="note-body">
                                Created worktree <span class="mono">{home(made()!.path)}</span> on branch <span class="mono">{made()!.branch}</span>, but {made()!.sessionId ? "its session didn't get the plan" : "the session couldn't start"}: {f().message}{" "}
                                The worktree is kept. {made()!.sessionId ? "Open its session and send the plan again." : "Start again to use it, or remove it from the worktree picker."}
                            </div>
                        </div>
                    )}
                </Show>
                <Show when={errorFor("general")}>
                    {(m) => (
                        <div class="note" data-tone="red" role="alert">
                            <div class="note-body">{m()}</div>
                        </div>
                    )}
                </Show>
            </form>
        </Dialog>
    );
}
