import "../styles/cli-env.css";
import { createSignal, For, Show } from "solid-js";
import { Lock, LockOpen, Plus, X } from "lucide-solid";
import type { AgentEnvVar, ProviderInfo } from "@shared/protocol";
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
            <For each={p.rows}>
                {(r) => (
                    <div class="env-row">
                        <input
                            class="input mono env-name"
                            aria-label="Variable name"
                            placeholder="NAME"
                            spellcheck={false}
                            autocapitalize="off"
                            value={r.name}
                            disabled={p.disabled}
                            onInput={(e) => set(r.key, { name: e.currentTarget.value })}
                        />
                        <input
                            class="input mono env-value"
                            aria-label={`Value of ${r.name || "the variable"}`}
                            type={r.secret ? "password" : "text"}
                            autocomplete="off"
                            spellcheck={false}
                            placeholder={r.secret && r.saved ? "Saved" : "value"}
                            value={r.value}
                            disabled={p.disabled}
                            onInput={(e) => set(r.key, { value: e.currentTarget.value })}
                        />
                        <button
                            type="button"
                            class="hb sm env-lock"
                            classList={{ on: r.secret }}
                            aria-pressed={r.secret}
                            aria-label={`Secret: ${r.name || "this variable"}`}
                            title={r.secret ? "Secret: hidden once saved" : "Make secret"}
                            disabled={p.disabled}
                            // A saved secret made plain needs its value typed again: it's never sent back.
                            onClick={() => set(r.key, { secret: !r.secret, ...(r.secret ? { saved: false } : {}) })}
                        >
                            {r.secret ? <Lock size={14} /> : <LockOpen size={14} />}
                        </button>
                        <button type="button" class="hb sm" aria-label={`Remove ${r.name || "this variable"}`} disabled={p.disabled} onClick={() => p.onChange(p.rows.filter((x) => x.key !== r.key))}>
                            <X size={14} />
                        </button>
                    </div>
                )}
            </For>
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
