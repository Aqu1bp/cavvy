import "../styles/accounts.css";
import { createSignal, For, onMount, Show } from "solid-js";
import type { AccountInfo, ProviderInfo } from "@shared/protocol";
import { refreshModels, refreshProviders, reportError, rpc } from "../state/app";
import { terminalActions } from "../state/ui";

/** Status is never persisted: identity comes only from the CLI's own command. */
export function Accounts(p: { provider: ProviderInfo }) {
    const [adding, setAdding] = createSignal(false);
    const [name, setName] = createSignal("");
    const [folder, setFolder] = createSignal("");
    const [busy, setBusy] = createSignal(false);
    const [editing, setEditing] = createSignal<string>();
    const [newName, setNewName] = createSignal("");
    const [removing, setRemoving] = createSignal<AccountInfo>();
    const accounts = () => p.provider.agentCli?.accounts ?? [];
    const refresh = async () => {
        await rpc.call("accounts.list", { provider: p.provider.id, refresh: true });
        await refreshProviders();
    };
    onMount(() => { if (accounts().length) void refresh().catch(reportError); });
    const work = async (fn: () => Promise<void>) => {
        setBusy(true);
        try { await fn(); } catch (e) { reportError(e); } finally { setBusy(false); }
    };
    const login = (a: AccountInfo) => terminalActions.loginAccount?.(p.provider.id, a.id, `${p.provider.name} · ${a.name}`);
    const add = () => work(async () => {
        const a = await rpc.call("accounts.add", { provider: p.provider.id, id: crypto.randomUUID(), name: name(), ...(folder() ? { folder: folder() } : {}) });
        setAdding(false); setName(""); setFolder("");
        await refreshProviders();
        login(a);
        void refreshModels();
    });
    return <div class="accounts">
        <button class="btn secondary sm" disabled={busy()} onClick={() => setAdding(!adding())}>Add account</button>
        <Show when={adding()}>
            <form class="account-form" onSubmit={(e) => { e.preventDefault(); void add(); }}>
                <label>Name <input aria-label="Account name" value={name()} maxLength={64} onInput={(e) => setName(e.currentTarget.value)} required pattern="[a-zA-Z0-9][a-zA-Z0-9 ._-]*" placeholder="Personal" /></label>
                <label>Existing folder (optional) <input aria-label="Account folder" value={folder()} maxLength={1024} onInput={(e) => setFolder(e.currentTarget.value)} placeholder="Leave blank for a new Harness account folder" /></label>
                <button class="btn secondary sm" type="submit" disabled={busy()}>Create and sign in</button>
            </form>
        </Show>
        <Show when={accounts().length > 1}>
            <label class="small">New sessions use <select aria-label={`${p.provider.name} default account`} value={p.provider.agentCli?.defaultAccount ?? "default"} disabled={busy()} onChange={(e) => { const id = e.currentTarget.value; void work(async () => { await rpc.call("accounts.setDefault", { provider: p.provider.id, id }); await refreshProviders(); }); }}>
                <For each={accounts()}>{(a) => <option value={a.id}>{a.name}</option>}</For>
            </select></label>
            <button class="btn secondary sm" disabled={busy()} onClick={() => void work(refresh)}>Refresh</button>
            <For each={accounts()}>{(a) => <div class="account-row">
                <strong>{a.name}</strong><span class="small">{a.description ?? "Status not checked"}{a.email ? ` · ${a.email}` : ""}{a.plan ? ` · ${a.plan}` : ""}</span>
                <code class="small account-path">{a.folder}</code>
                <Show when={!a.signedIn}><button class="btn secondary sm" onClick={() => login(a)}>Sign in</button></Show>
                <Show when={a.id !== "default"}>
                    <button class="btn secondary sm" onClick={() => { setEditing(a.id); setNewName(a.name); }}>Rename</button>
                    <button class="btn secondary sm" onClick={() => setRemoving(a)}>Remove</button>
                </Show>
                <Show when={editing() === a.id}><form onSubmit={(e) => { e.preventDefault(); void work(async () => { await rpc.call("accounts.rename", { provider: p.provider.id, id: a.id, name: newName() }); setEditing(undefined); await refreshProviders(); }); }}>
                    <input aria-label="New account name" maxLength={64} value={newName()} onInput={(e) => setNewName(e.currentTarget.value)} /><button class="btn secondary sm" disabled={busy()}>Save</button><button type="button" class="btn secondary sm" onClick={() => setEditing(undefined)}>Cancel</button>
                </form></Show>
            </div>}</For>
        </Show>
        <Show when={adding() || accounts().length > 1}><p class="small muted">Sign in yourself in the CLI terminal. A new folder has separate settings and history. {p.provider.id === "claude-code" ? "Claude Console sign-in without an API key is stored outside this folder and is not isolated per account." : "A new Codex home does not inherit your settings or MCP servers."}</p></Show>
        <Show when={removing()}>{(a) => <div role="alertdialog" aria-label="Remove account" class="account-row">
            <p>{a().managed ? "Delete the Harness-created folder" : "Forget this account and leave its folder untouched"}: <code>{a().folder}</code>?</p>
            <p>Sign-out is your responsibility: run {p.provider.id === "codex" ? "codex logout" : "claude auth logout"} with this account's folder before removing it. Removing it does not revoke its sign-in.</p>
            <button class="btn secondary sm" disabled={busy()} onClick={() => void work(async () => { await rpc.call("accounts.remove", { provider: p.provider.id, id: a().id, confirmedFolder: a().folder }); setRemoving(undefined); await refreshProviders(); })}>Confirm removal</button>
            <button class="btn secondary sm" onClick={() => setRemoving(undefined)}>Cancel</button>
        </div>}</Show>
    </div>;
}
