import "../styles/accounts.css";
import { createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { MoreHorizontal, Plus } from "lucide-solid";
import type { AccountInfo, ProviderInfo } from "@shared/protocol";
import { refreshModels, refreshProviders, rpc } from "../state/app";
import { terminalActions } from "../state/ui";
import { Menu } from "./ui/Menu";
import { Dialog } from "./ui/Dialog";
import { Spinner } from "./ui/bits";

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const nameError = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(name) && name === name.trim() && !name.includes("..") ? undefined : "Use 1–64 plain characters, starting with a letter or number, without '..'.";

/** Status is never persisted: identity comes only from the CLI's own command. */
export function Accounts(p: { provider: ProviderInfo }) {
    const uid = createUniqueId();
    const [adding, setAdding] = createSignal(false);
    const [name, setName] = createSignal("");
    const [folder, setFolder] = createSignal("");
    const [advanced, setAdvanced] = createSignal(false);
    const [error, setError] = createSignal<{ field: "name" | "folder" | "form"; message: string }>();
    const [actionError, setActionError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    const [menu, setMenu] = createSignal<string>();
    const [editing, setEditing] = createSignal<string>();
    const [newName, setNewName] = createSignal("");
    const [renameError, setRenameError] = createSignal<string>();
    const [removing, setRemoving] = createSignal<AccountInfo>();
    const [removeError, setRemoveError] = createSignal<string>();
    let addButton: HTMLButtonElement | undefined;
    const accounts = () => p.provider.agentCli?.accounts ?? [];
    const refresh = async () => {
        await rpc.call("accounts.list", { provider: p.provider.id, refresh: true });
        await refreshProviders();
    };
    onMount(() => { if (p.provider.configured || accounts().length > 1) void refresh().catch((e) => setActionError(message(e))); });
    const work = async (fn: () => Promise<void>, fail = setActionError) => {
        if (busy()) return;
        setBusy(true); fail(undefined);
        try { await fn(); } catch (e) { fail(message(e)); } finally { setBusy(false); }
    };
    const login = (a: AccountInfo) => terminalActions.loginAccount?.(p.provider.id, a.id, `${p.provider.name} · ${a.name}`);
    const cancelAdd = () => {
        if (busy()) return;
        setAdding(false); setName(""); setFolder(""); setError(undefined); setAdvanced(false);
        addButton?.focus();
    };
    const escape = (e: KeyboardEvent, close: () => void) => {
        if (e.key !== "Escape") return;
        e.preventDefault(); e.stopPropagation(); close();
    };
    const add = async () => {
        if (busy()) return;
        setError(undefined);
        const invalidName = nameError(name());
        if (invalidName) { setError({ field: "name", message: invalidName }); return; }
        if (folder() && (!folder().startsWith("/") || folder().length > 1024 || !/^[a-zA-Z0-9 /_.-]+$/.test(folder()) || folder().split("/").includes(".."))) {
            setAdvanced(true); setError({ field: "folder", message: "Use an absolute folder with plain characters and no '..'." }); return;
        }
        setBusy(true);
        try {
            const a = await rpc.call("accounts.add", { provider: p.provider.id, id: crypto.randomUUID(), name: name(), ...(folder() ? { folder: folder() } : {}) });
            setAdding(false); setName(""); setFolder(""); setAdvanced(false);
            login(a);
            // Creation has succeeded: a refresh failure must not offer to create it again.
            await refreshProviders().catch((e) => setActionError(message(e)));
            void refreshModels().catch((e) => setActionError(message(e)));
        } catch (e) {
            const detail = message(e);
            const field = /name/i.test(detail) ? "name" : folder() && /folder|director|project|symlink/i.test(detail) ? "folder" : "form";
            if (field === "folder") setAdvanced(true);
            setError({ field, message: detail });
        } finally { setBusy(false); }
    };
    return <section class="accounts" aria-label={`${p.provider.name} accounts`}>
        <div class="account-toolbar">
            <span class="small muted">Separate sign-ins for personal and work accounts.</span>
            <button ref={addButton} class="btn secondary sm" disabled={busy() || adding()} aria-expanded={adding()} aria-controls={`${uid}-add`} onClick={() => { setActionError(undefined); setAdding(true); }}><Plus size={12} /> Add account</button>
        </div>
        <details class="account-help small muted"><summary>Learn more</summary><p>Sign in yourself in the CLI terminal. A new folder has separate settings and history. {p.provider.id === "claude-code" ? "Claude Console sign-in without an API key is stored outside this folder and is not isolated per account." : "A new Codex home does not inherit your settings or MCP servers."}</p></details>
        <Show when={adding()}>
            <form id={`${uid}-add`} class="account-form" aria-label="Add account" noValidate aria-busy={busy()} onKeyDown={(e) => escape(e, cancelAdd)} onSubmit={(e) => { e.preventDefault(); void add(); }}>
                <label for={`${uid}-name`}>Name</label>
                <input id={`${uid}-name`} class="input" autofocus ref={(el) => queueMicrotask(() => { if (el.isConnected) el.focus(); })} aria-label="Account name" aria-invalid={error()?.field === "name"} aria-describedby={error()?.field === "name" ? `${uid}-name-error` : undefined} value={name()} maxLength={64} disabled={busy()} onInput={(e) => { setName(e.currentTarget.value); setError(undefined); }} placeholder="Personal" />
                <Show when={error()?.field === "name"}><span id={`${uid}-name-error`} class="account-error" role="alert">{error()?.message}</span></Show>
                <details class="account-advanced" open={advanced()} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
                    <summary>Advanced: use an existing folder</summary>
                    <label for={`${uid}-folder`}>Existing folder (optional)</label>
                    <input id={`${uid}-folder`} class="input mono" aria-label="Account folder" aria-invalid={error()?.field === "folder"} aria-describedby={`${uid}-folder-help${error()?.field === "folder" ? ` ${uid}-folder-error` : ""}`} value={folder()} maxLength={1024} disabled={busy()} onInput={(e) => { setFolder(e.currentTarget.value); setError(undefined); }} placeholder="/path/to/cli-home" />
                    <span id={`${uid}-folder-help`} class="small muted">Leave blank to let Harness create a separate account folder.</span>
                    <Show when={error()?.field === "folder"}><span id={`${uid}-folder-error`} class="account-error" role="alert">{error()?.message}</span></Show>
                </details>
                <Show when={error()?.field === "form"}><span class="account-error" role="alert">{error()?.message}</span></Show>
                <div class="account-actions">
                    <button class="btn primary sm" type="submit" disabled={busy()}>{busy() && <Spinner size={12} />}{busy() ? "Creating…" : "Create and sign in"}</button>
                    <button class="btn ghost sm" type="button" disabled={busy()} onClick={cancelAdd}>Cancel</button>
                </div>
            </form>
        </Show>
        <div class="account-list">
            <For each={accounts()}>{(a) => {
                let anchor: HTMLButtonElement | undefined;
                const choose = (fn: () => void) => { setMenu(undefined); fn(); };
                return <div class="account-row">
                    <div class="account-identity">
                        <div class="account-title"><strong>{a.name}</strong><Show when={a.id === (p.provider.agentCli?.defaultAccount ?? "default")}><span class="chip tiny" title="Used for new sessions">Default for new sessions</span></Show></div>
                        <div class="small muted account-status" title={a.description}>{a.invalid ? "Unavailable" : a.signedIn === true ? "Signed in" : a.signedIn === false ? "Not signed in" : "Status not checked"}{a.email ? ` · ${a.email}` : ""}{a.plan ? ` · ${a.plan}` : ""}</div>
                    </div>
                    <button ref={anchor} class="hb sm" disabled={busy()} aria-label={`Actions for ${a.name}`} aria-haspopup="menu" aria-expanded={menu() === a.id} onClick={() => setMenu(menu() === a.id ? undefined : a.id)}><MoreHorizontal size={16} /></button>
                    <Menu open={menu() === a.id} anchor={() => anchor} onClose={() => setMenu(undefined)} label={`${a.name} account actions`} width={220} align="end">
                        <button class="menu-item" role="menuitem" disabled={busy()} onClick={() => choose(() => login(a))}>{a.signedIn ? "Re-sign in" : "Sign in"}</button>
                        <Show when={a.id !== (p.provider.agentCli?.defaultAccount ?? "default")}><button class="menu-item" role="menuitem" disabled={busy()} onClick={() => choose(() => void work(async () => { await rpc.call("accounts.setDefault", { provider: p.provider.id, id: a.id }); await refreshProviders(); }))}>Use for new sessions</button></Show>
                        <Show when={a.id !== "default"}>
                            <button class="menu-item" role="menuitem" disabled={busy()} onClick={() => choose(() => { setEditing(a.id); setNewName(a.name); setRenameError(undefined); })}>Rename</button>
                            <button class="menu-item danger" role="menuitem" disabled={busy()} onClick={() => choose(() => { setRemoveError(undefined); setRemoving(a); })}>Remove</button>
                        </Show>
                    </Menu>
                    <Show when={editing() === a.id}>
                        <form class="account-rename" aria-label={`Rename ${a.name}`} onKeyDown={(e) => escape(e, () => { if (!busy()) { setEditing(undefined); anchor?.focus(); } })} onSubmit={(e) => {
                            e.preventDefault();
                            const invalid = nameError(newName());
                            if (invalid) { setRenameError(invalid); return; }
                            void work(async () => { await rpc.call("accounts.rename", { provider: p.provider.id, id: a.id, name: newName() }); setEditing(undefined); await refreshProviders().catch((e) => setActionError(message(e))); }, setRenameError);
                        }}>
                            <input class="input" autofocus ref={(el) => queueMicrotask(() => { if (el.isConnected) el.focus(); })} aria-label="New account name" aria-invalid={!!renameError()} aria-describedby={renameError() ? `${uid}-rename-error` : undefined} maxLength={64} disabled={busy()} value={newName()} onInput={(e) => { setNewName(e.currentTarget.value); setRenameError(undefined); }} />
                            <button class="btn primary sm" disabled={busy()}>Save</button><button type="button" class="btn ghost sm" disabled={busy()} onClick={() => { setEditing(undefined); anchor?.focus(); }}>Cancel</button>
                            <Show when={renameError()}><span id={`${uid}-rename-error`} class="account-error" role="alert">{renameError()}</span></Show>
                        </form>
                    </Show>
                </div>;
            }}</For>
        </div>
        <div class="account-actions"><button class="link-btn small" disabled={busy()} onClick={() => void work(refresh)}>Refresh status</button></div>
        <Show when={actionError()}><span class="account-error" role="alert">{actionError()}</span></Show>
        <Show when={removing()}>{(a) => <Dialog open onClose={() => { if (!busy()) setRemoving(undefined); }} title={`Remove ${a().name}?`} width={460}>
            <p>{a().managed && !a().invalid ? "Delete the Harness-created folder" : "Forget this account and leave its folder untouched"}: <code class="account-path">{a().folder}</code>?</p>
            <p>Removing an account does not revoke its sign-in. To sign out first, run <code>{p.provider.id === "codex" ? "codex logout" : "claude auth logout"}</code> with this account's folder.</p>
            <Show when={removeError()}><p class="account-error" role="alert">{removeError()}</p></Show>
            <div class="dialog-actions">
                <button class="btn ghost" autofocus disabled={busy()} onClick={() => setRemoving(undefined)}>Cancel</button>
                <button class="btn danger" disabled={busy()} aria-busy={busy()} onClick={() => void work(async () => { await rpc.call("accounts.remove", { provider: p.provider.id, id: a().id, confirmedFolder: a().folder }); setRemoving(undefined); await refreshProviders().catch((e) => setActionError(message(e))); }, setRemoveError)}>{busy() ? "Removing…" : "Confirm removal"}</button>
            </div>
        </Dialog>}</Show>
    </section>;
}
