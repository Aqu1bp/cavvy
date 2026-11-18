import "../styles/cli-env.css";
import { createMemo, createSignal, createUniqueId, Index, Show } from "solid-js";
import { ChevronRight, Lock, LockOpen, Plus, X } from "lucide-solid";
import type { AgentEnvVar, AgentInstanceInfo, ProviderInfo } from "@shared/protocol";
import { refreshModels, refreshProviders, rpc, toast } from "../state/app";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";
import { envNameProblem, looksSecret } from "@shared/env-names";
import { resetToast } from "../lib/reset-toast";

/**
 * A variable being edited. `saved`: a secret with a value already saved, kept when its value is left blank. `auto`: a
 * new row whose lock follows its name (a credential's name locks it) until the lock is used by hand.
 */
export interface EnvRow {
    key: number;
    name: string;
    value: string;
    secret: boolean;
    saved: boolean;
    auto: boolean;
}

let next = 0;
const blankRow = (): EnvRow => ({ key: next++, name: "", value: "", secret: false, saved: false, auto: true });
export const envRows = (vars: readonly AgentEnvVar[] | undefined): EnvRow[] =>
    vars?.length ? vars.map((v) => ({ key: next++, name: v.name, value: v.value ?? "", secret: Boolean(v.secret), saved: Boolean(v.secret), auto: false })) : [blankRow()];

/** What's saved: blank rows dropped; a saved secret left blank keeps its value (sent without one). */
export const envVars = (rows: readonly EnvRow[]): AgentEnvVar[] =>
    rows
        .filter((r) => r.name.trim() || r.value)
        .map((r) => ({ name: r.name.trim(), ...(r.secret ? { secret: true } : {}), ...(r.secret && !r.value && r.saved ? {} : { value: r.value }) }));

/** What's wrong with each row's name, as the server would refuse it on Save (a reserved name, a bad one, one twice), by row. */
export function envProblems(rows: readonly EnvRow[]): Map<number, string> {
    const out = new Map<number, string>();
    const seen = new Set<string>();
    for (const r of rows) {
        const name = r.name.trim();
        if (!name) continue;
        const problem = envNameProblem(name) ?? (seen.has(name) ? `${name} is there twice.` : undefined);
        if (problem) out.set(r.key, problem);
        seen.add(name);
    }
    return out;
}

/** Name and value rows, each with a lock that makes it secret, and a row more. */
export function EnvEditor(p: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void; disabled?: boolean }) {
    const uid = createUniqueId();
    let addButton: HTMLButtonElement | undefined;
    let list: HTMLDivElement | undefined;
    const set = (key: number, patch: Partial<EnvRow>) => p.onChange(p.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    const problems = createMemo(() => envProblems(p.rows));
    /** The name input of the row at `i` (after a row is added or removed), else Add variable. */
    const focusRow = (i: number) =>
        requestAnimationFrame(() => {
            const names = list?.querySelectorAll<HTMLInputElement>(".env-name");
            (names?.[Math.min(i, names.length - 1)] ?? addButton)?.focus();
        });
    const add = () => {
        p.onChange([...p.rows, blankRow()]);
        focusRow(p.rows.length);
    };
    const remove = (key: number) => {
        const at = p.rows.findIndex((r) => r.key === key);
        p.onChange(p.rows.filter((x) => x.key !== key));
        focusRow(at);
    };
    return (
        <div class="env-editor" ref={list}>
            {/* By position, so a row's inputs (and the focus) stay as it's typed into. */}
            <Index each={p.rows}>
                {(row) => {
                    const r = (): EnvRow => row();
                    const problem = () => problems().get(r().key);
                    const errorId = () => `${uid}-${r().key}-error`;
                    const named = () => r().name.trim() || "this variable";
                    return (
                        <div class="env-item">
                            <div class="env-row">
                                <input
                                    class="input mono env-name"
                                    aria-label="Variable name"
                                    aria-invalid={Boolean(problem())}
                                    aria-describedby={problem() ? errorId() : undefined}
                                    placeholder="NAME"
                                    spellcheck={false}
                                    autocapitalize="off"
                                    autocomplete="off"
                                    value={r().name}
                                    disabled={p.disabled}
                                    // A credential's name starts its value hidden, unless the lock was set by hand.
                                    onInput={(e) => set(r().key, { name: e.currentTarget.value, ...(r().auto ? { secret: looksSecret(e.currentTarget.value) } : {}) })}
                                />
                                <input
                                    class="input mono env-value"
                                    aria-label={`Value of ${named()}`}
                                    type={r().secret ? "password" : "text"}
                                    autocomplete="off"
                                    spellcheck={false}
                                    placeholder={r().secret && r().saved ? "Saved" : "value"}
                                    value={r().value}
                                    // A long value, whole, on hover (never a secret's).
                                    title={!r().secret && r().value.length > 40 ? r().value : undefined}
                                    disabled={p.disabled}
                                    onInput={(e) => set(r().key, { value: e.currentTarget.value })}
                                />
                                <button
                                    type="button"
                                    class="hb sm env-lock"
                                    classList={{ on: r().secret }}
                                    aria-pressed={r().secret}
                                    aria-label={`Keep ${named()} secret`}
                                    title={r().secret ? "Secret: hidden once saved" : "Make secret"}
                                    disabled={p.disabled}
                                    // A saved secret made plain needs its value typed again: it's never sent back.
                                    onClick={() => set(r().key, { secret: !r().secret, auto: false, ...(r().secret ? { saved: false } : {}) })}
                                >
                                    {r().secret ? <Lock size={14} /> : <LockOpen size={14} />}
                                </button>
                                <button type="button" class="hb sm env-remove" aria-label={`Remove ${named()}`} title="Remove" disabled={p.disabled} onClick={() => remove(r().key)}>
                                    <X size={14} />
                                </button>
                            </div>
                            <Show when={problem()}>
                                <span id={errorId()} class="env-error">
                                    {problem()}
                                </span>
                            </Show>
                        </div>
                    );
                }}
            </Index>
            <button ref={addButton} type="button" class="btn ghost sm env-add" disabled={p.disabled} onClick={add}>
                <Plus size={13} />
                Add variable
            </button>
        </div>
    );
}

/** Cancel and the dialog's own action, at the trailing edge as in the app's other dialogs. */
function Actions(p: { busy: boolean; blocked: boolean; label: string; onCancel: () => void; onSave: () => void }) {
    return (
        <div class="dialog-actions">
            <span class="grow" />
            <button type="button" class="btn ghost" disabled={p.busy} onClick={() => p.onCancel()}>
                Cancel
            </button>
            <button type="button" class="btn primary" disabled={p.busy || p.blocked} aria-busy={p.busy} onClick={() => p.onSave()}>
                {p.busy ? <Spinner size={12} /> : p.label}
            </button>
        </div>
    );
}

/** The environment variables a CLI provider is started with, in a dialog. */
export function EnvDialog(p: { provider: ProviderInfo; onClose: () => void }) {
    const [rows, setRows] = createSignal(envRows(p.provider.agentCli?.env));
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<string>();
    const blocked = () => envProblems(rows()).size > 0;
    const save = async () => {
        if (busy() || blocked()) return;
        setBusy(true);
        setError(undefined);
        try {
            await rpc.call("providers.setEnv", { provider: p.provider.id, vars: envVars(rows()) });
            toast("Saved. Applies from the next message.", "success");
            p.onClose();
            await Promise.all([refreshProviders(), refreshModels()]).catch(() => undefined);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog
            open
            onClose={() => !busy() && p.onClose()}
            title={`${p.provider.name} environment`}
            width={560}
            footer={<Actions busy={busy()} blocked={blocked()} label="Save" onCancel={p.onClose} onSave={() => void save()} />}
        >
            <form
                class="env-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <p class="env-hint">Set for {p.provider.name} only, over what Cavvy passes it.</p>
                <EnvEditor rows={rows()} onChange={setRows} disabled={busy()} />
                <Show when={error()}>
                    <p class="account-error" role="alert">
                        {error()}
                    </p>
                </Show>
                <button type="submit" hidden />
            </form>
        </Dialog>
    );
}

/** The lines of a box, trimmed, without blank ones. */
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter(Boolean);

/** Add a named instance of a CLI, or change one: its name, path, arguments, variables and models. */
export function InstanceDialog(p: { provider: ProviderInfo; instance?: AgentInstanceInfo; onClose: () => void }) {
    const cli = p.provider.name;
    const [name, setName] = createSignal(p.instance?.name ?? "");
    const [path, setPath] = createSignal(p.instance?.path ?? "");
    const [args, setArgs] = createSignal((p.instance?.args ?? []).join("\n"));
    const [models, setModels] = createSignal((p.instance?.models ?? []).join("\n"));
    const [rows, setRows] = createSignal(envRows(p.instance?.env));
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<string>();
    const blocked = () => !name().trim() || envProblems(rows()).size > 0;
    const save = async () => {
        if (busy() || blocked()) return;
        setBusy(true);
        setError(undefined);
        const fields = { name: name().trim(), path: path().trim() || undefined, args: lines(args()), env: envVars(rows()), models: lines(models()) };
        try {
            const r = p.instance ? await rpc.call("providers.updateInstance", { id: p.instance.id, ...fields }) : (await rpc.call("providers.addInstance", { base: p.provider.id, ...fields }), undefined);
            toast(p.instance ? "Saved. Applies from the next message." : `Added ${cli} · ${fields.name}`, "success");
            if (r) resetToast(r.reset);
            p.onClose();
            await Promise.all([refreshProviders(), refreshModels()]).catch(() => undefined);
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };
    return (
        <Dialog
            open
            onClose={() => !busy() && p.onClose()}
            title={p.instance ? `${cli} · ${p.instance.name}` : `Add another ${cli}`}
            width={560}
            footer={<Actions busy={busy()} blocked={blocked()} label={p.instance ? "Save" : "Add"} onCancel={p.onClose} onSave={() => void save()} />}
        >
            <form
                class="env-form instance-form"
                onSubmit={(e) => {
                    e.preventDefault();
                    void save();
                }}
            >
                <label>
                    <span>Name</span>
                    <input class="input" autofocus maxLength={64} placeholder="OpenRouter" value={name()} disabled={busy()} onInput={(e) => setName(e.currentTarget.value)} />
                </label>
                <div class="instance-field" role="group" aria-label="Environment variables">
                    <span aria-hidden="true">Environment variables</span>
                    <EnvEditor rows={rows()} onChange={setRows} disabled={busy()} />
                </div>
                <label>
                    <span>More models</span>
                    <textarea class="input mono" rows={2} spellcheck={false} placeholder="One model id a line, as the CLI takes it" value={models()} disabled={busy()} onInput={(e) => setModels(e.currentTarget.value)} />
                </label>
                <details class="account-advanced" open={Boolean(p.instance?.path || p.instance?.args?.length)}>
                    <summary><ChevronRight size={14} class="chev" />Program and arguments</summary>
                    <label>
                        <span>Path</span>
                        {/* Left blank, it runs what its CLI runs: that program's path, or the one on PATH. */}
                        <input class="input mono" spellcheck={false} autocomplete="off" placeholder={p.provider.agentCli?.path ? `Same as ${cli}: ${p.provider.agentCli.path}` : `The ${cli} on your PATH`} title={p.provider.agentCli?.path} value={path()} disabled={busy()} onInput={(e) => setPath(e.currentTarget.value)} />
                    </label>
                    <label>
                        <span>Arguments</span>
                        <textarea class="input mono" rows={2} spellcheck={false} placeholder="One argument a line, before Cavvy's own" value={args()} disabled={busy()} onInput={(e) => setArgs(e.currentTarget.value)} />
                    </label>
                </details>
                <Show when={error()}>
                    <p class="account-error" role="alert">
                        {error()}
                    </p>
                </Show>
                <button type="submit" hidden />
            </form>
        </Dialog>
    );
}
