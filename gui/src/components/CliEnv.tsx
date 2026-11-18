import "../styles/cli-env.css";
import { createSignal, Index, Show } from "solid-js";
import { Lock, LockOpen, Plus, X } from "lucide-solid";
import type { AgentEnvVar, AgentInstanceInfo, ProviderInfo } from "@shared/protocol";
import { refreshModels, refreshProviders, rpc, toast } from "../state/app";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

/** A variable being edited. `saved`: a secret with a value already saved, kept when its value is left blank. */
export interface EnvRow {
    key: number;
    name: string;
    value: string;
    secret: boolean;
    saved: boolean;
}

let next = 0;
export const envRows = (vars: readonly AgentEnvVar[] | undefined): EnvRow[] =>
    (vars ?? []).map((v) => ({ key: next++, name: v.name, value: v.value ?? "", secret: Boolean(v.secret), saved: Boolean(v.secret) }));

/** What's saved: blank rows dropped; a saved secret left blank keeps its value (sent without one). */
export const envVars = (rows: readonly EnvRow[]): AgentEnvVar[] =>
    rows
        .filter((r) => r.name.trim() || r.value)
        .map((r) => ({ name: r.name.trim(), ...(r.secret ? { secret: true } : {}), ...(r.secret && !r.value && r.saved ? {} : { value: r.value }) }));

/** Name and value rows, each with a lock that makes it secret, and a row more. */
export function EnvEditor(p: { rows: EnvRow[]; onChange: (rows: EnvRow[]) => void; disabled?: boolean }) {
    const set = (key: number, patch: Partial<EnvRow>) => p.onChange(p.rows.map((r) => (r.key === key ? { ...r, ...patch } : r)));
    const add = () => p.onChange([...p.rows, { key: next++, name: "", value: "", secret: false, saved: false }]);
    return (
        <div class="env-editor">
            {/* By position, so a row's inputs (and the focus) stay as it's typed into. */}
            <Index each={p.rows}>
                {(row) => {
                    const r = (): EnvRow => row();
                    return (
                    <div class="env-row">
                        <input
                            class="input mono env-name"
                            aria-label="Variable name"
                            placeholder="NAME"
                            spellcheck={false}
                            autocapitalize="off"
                            value={r().name}
                            disabled={p.disabled}
                            onInput={(e) => set(r().key, { name: e.currentTarget.value })}
                        />
                        <input
                            class="input mono env-value"
                            aria-label={`Value of ${r().name || "the variable"}`}
                            type={r().secret ? "password" : "text"}
                            autocomplete="off"
                            spellcheck={false}
                            placeholder={r().secret && r().saved ? "Saved" : "value"}
                            value={r().value}
                            disabled={p.disabled}
                            onInput={(e) => set(r().key, { value: e.currentTarget.value })}
                        />
                        <button
                            type="button"
                            class="hb sm env-lock"
                            classList={{ on: r().secret }}
                            aria-pressed={r().secret}
                            aria-label={`Secret: ${r().name || "this variable"}`}
                            title={r().secret ? "Secret: hidden once saved" : "Make secret"}
                            disabled={p.disabled}
                            // A saved secret made plain needs its value typed again: it's never sent back.
                            onClick={() => set(r().key, { secret: !r().secret, ...(r().secret ? { saved: false } : {}) })}
                        >
                            {r().secret ? <Lock size={14} /> : <LockOpen size={14} />}
                        </button>
                        <button type="button" class="hb sm" aria-label={`Remove ${r().name || "this variable"}`} disabled={p.disabled} onClick={() => p.onChange(p.rows.filter((x) => x.key !== r().key))}>
                            <X size={14} />
                        </button>
                    </div>
                    );
                }}
            </Index>
            <button type="button" class="btn ghost sm env-add" disabled={p.disabled} onClick={add}>
                <Plus size={13} />
                Add variable
            </button>
        </div>
    );
}

/** The environment variables a CLI provider is started with, in a dialog. */
export function EnvDialog(p: { provider: ProviderInfo; onClose: () => void }) {
    const [rows, setRows] = createSignal(envRows(p.provider.agentCli?.env));
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<string>();
    if (!rows().length) setRows(envRows([{ name: "", value: "" }]));
    const save = async () => {
        if (busy()) return;
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
            footer={
                <>
                    <button class="btn ghost" disabled={busy()} onClick={() => p.onClose()}>
                        Cancel
                    </button>
                    <button class="btn primary" disabled={busy()} onClick={() => void save()}>
                        {busy() ? <Spinner size={12} /> : "Save"}
                    </button>
                </>
            }
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
    const [rows, setRows] = createSignal(envRows(p.instance?.env?.length ? p.instance.env : [{ name: "", value: "" }]));
    const [busy, setBusy] = createSignal(false);
    const [error, setError] = createSignal<string>();
    const save = async () => {
        if (busy()) return;
        if (!name().trim()) {
            setError("Give it a name.");
            return;
        }
        setBusy(true);
        setError(undefined);
        const fields = { name: name().trim(), path: path().trim() || undefined, args: lines(args()), env: envVars(rows()), models: lines(models()) };
        try {
            if (p.instance) await rpc.call("providers.updateInstance", { id: p.instance.id, ...fields });
            else await rpc.call("providers.addInstance", { base: p.provider.id, ...fields });
            toast(p.instance ? "Saved. Applies from the next message." : `Added ${cli} · ${fields.name}`, "success");
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
            footer={
                <>
                    <button class="btn ghost" disabled={busy()} onClick={() => p.onClose()}>
                        Cancel
                    </button>
                    <button class="btn primary" disabled={busy()} onClick={() => void save()}>
                        {busy() ? <Spinner size={12} /> : p.instance ? "Save" : "Add"}
                    </button>
                </>
            }
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
                <div class="instance-field">
                    <span>Environment variables</span>
                    <EnvEditor rows={rows()} onChange={setRows} disabled={busy()} />
                </div>
                <label>
                    <span>More models</span>
                    <textarea class="input mono" rows={2} spellcheck={false} placeholder="One model id a line, as the CLI takes it" value={models()} disabled={busy()} onInput={(e) => setModels(e.currentTarget.value)} />
                </label>
                <details class="account-advanced" open={Boolean(p.instance?.path || p.instance?.args?.length)}>
                    <summary>Program and arguments</summary>
                    <label>
                        <span>Path</span>
                        <input class="input mono" spellcheck={false} placeholder={`The ${cli} on your PATH`} value={path()} disabled={busy()} onInput={(e) => setPath(e.currentTarget.value)} />
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
