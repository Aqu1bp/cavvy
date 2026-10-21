import "../styles/accounts.css";
import { createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { Check, ExternalLink, MoreHorizontal } from "lucide-solid";
import type { AccountInfo, ProviderInfo } from "@shared/protocol";
import { refreshModels, refreshProviders, rpc } from "../state/app";
import { terminalActions } from "../state/ui";
import { openExternal } from "../lib/platform";
import { Menu } from "./ui/Menu";
import { Dialog } from "./ui/Dialog";
import { ProviderIcon } from "./ui/ProviderIcon";
import { Spinner } from "./ui/bits";

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const nameError = (name: string) => /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(name) && name === name.trim() && !name.includes("..") ? undefined : "Use 1–64 plain characters, starting with a letter or number, without '..'.";
/** The CLIs report plans in lower case ("max", "plus"). */
const planLabel = (plan?: string) => plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined;
/** What's wrong with an account, if anything: signed in says nothing. */
const accountStatus = (a: AccountInfo) => a.invalid ? "Unavailable" : a.signedIn === false ? "Not signed in" : a.signedIn === undefined ? "Status not checked" : undefined;

/**
 * A CLI provider (Claude Code, Codex) in Settings → Providers: one row with
 * its plan and state, and its accounts as indented rows under it (a lone
 * account folds into the provider's row). The actions are in ••• menus.
 * Status is never persisted: identity comes only from the CLI's own command.
 */
export function Accounts(p: { provider: ProviderInfo; connecting?: boolean; onConnect?: () => void; onTurnOff?: () => void }) {
    const uid = createUniqueId();
    const [adding, setAdding] = createSignal(false);
    const [name, setName] = createSignal("");
    const [folder, setFolder] = createSignal("");
    const [advanced, setAdvanced] = createSignal(false);
    const [error, setError] = createSignal<{ field: "name" | "folder" | "form"; message: string }>();
    const [actionError, setActionError] = createSignal<string>();
    const [busy, setBusy] = createSignal(false);
    const [refreshing, setRefreshing] = createSignal(false);
    /** The open menu: "" for the provider's, else an account's id. */
    const [menu, setMenu] = createSignal<string>();
    const [help, setHelp] = createSignal(false);
    const [editing, setEditing] = createSignal<string>();
    const [newName, setNewName] = createSignal("");
    const [renameError, setRenameError] = createSignal<string>();
    const [removing, setRemoving] = createSignal<AccountInfo>();
    const [removeError, setRemoveError] = createSignal<string>();
    let providerMenu: HTMLButtonElement | undefined;
    const cli = () => p.provider.agentCli;
    const installed = () => cli()?.installed !== false;
    const accounts = () => cli()?.accounts ?? [];
    const isDefault = (a: AccountInfo) => a.id === (cli()?.defaultAccount ?? "default");
    /** The account new sessions use: its plan is the provider's. */
    const main = () => accounts().find(isDefault) ?? accounts()[0];
    /** With one account there's no list: it folds into the provider's row. */
    const single = () => accounts().length === 1 ? accounts()[0] : undefined;
    const refresh = async () => {
        await rpc.call("accounts.list", { provider: p.provider.id, refresh: true });
        await refreshProviders();
    };
    onMount(() => { if (installed() && (p.provider.configured || accounts().length > 1)) void refresh().catch((e) => setActionError(message(e))); });
    const work = async (fn: () => Promise<void>, fail = setActionError) => {
        if (busy()) return;
        setBusy(true); fail(undefined);
        try { await fn(); } catch (e) { fail(message(e)); } finally { setBusy(false); }
    };
    const refreshNow = () => void work(async () => {
        setRefreshing(true);
        try { await refresh(); } finally { setRefreshing(false); }
    });
    const login = (a: AccountInfo) => terminalActions.loginAccount?.(p.provider.id, a.id, `${p.provider.name} · ${a.name}`);
    const cancelAdd = () => {
        if (busy()) return;
        setAdding(false); setName(""); setFolder(""); setError(undefined); setAdvanced(false);
        providerMenu?.focus();
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
    const choose = (fn: () => void) => { setMenu(undefined); fn(); };
    /** An account's own actions: in its row's menu, or in the provider's when it's the only one. */
    const accountItems = (a: AccountInfo) => <>
        <button class="menu-item" role="menuitem" disabled={busy()} onClick={() => choose(() => login(a))}>{a.signedIn ? "Sign in again" : "Sign in"}</button>
        <Show when={!isDefault(a)}><button class="menu-item" role="menuitem" disabled={busy()} onClick={() => choose(() => void work(async () => { await rpc.call("accounts.setDefault", { provider: p.provider.id, id: a.id }); await refreshProviders(); }))}>Make default</button></Show>
        <Show when={a.id !== "default"}>
            <button class="menu-item" role="menuitem" disabled={busy()} onClick={() => choose(() => { setEditing(a.id); setNewName(a.name); setRenameError(undefined); })}>Rename…</button>
            <button class="menu-item danger" role="menuitem" disabled={busy()} onClick={() => choose(() => { setRemoveError(undefined); setRemoving(a); })}>Remove…</button>
        </Show>
    </>;
    const renameForm = (a: AccountInfo, back: () => HTMLElement | undefined) => <Show when={editing() === a.id}>
        <form class="account-rename" aria-label={`Rename ${a.name}`} onKeyDown={(e) => escape(e, () => { if (!busy()) { setEditing(undefined); back()?.focus(); } })} onSubmit={(e) => {
            e.preventDefault();
            const invalid = nameError(newName());
            if (invalid) { setRenameError(invalid); return; }
            void work(async () => { await rpc.call("accounts.rename", { provider: p.provider.id, id: a.id, name: newName() }); setEditing(undefined); await refreshProviders().catch((e) => setActionError(message(e))); }, setRenameError);
        }}>
            <input class="input" autofocus ref={(el) => queueMicrotask(() => { if (el.isConnected) el.focus(); })} aria-label="New account name" aria-invalid={!!renameError()} aria-describedby={renameError() ? `${uid}-rename-error` : undefined} maxLength={64} disabled={busy()} value={newName()} onInput={(e) => { setNewName(e.currentTarget.value); setRenameError(undefined); }} />
            <button class="btn primary sm" disabled={busy()}>Save</button><button type="button" class="btn ghost sm" disabled={busy()} onClick={() => { setEditing(undefined); back()?.focus(); }}>Cancel</button>
            <Show when={renameError()}><span id={`${uid}-rename-error`} class="account-error" role="alert">{renameError()}</span></Show>
        </form>
    </Show>;
    // Beside the name: a green dot while it's on, or what's wrong with its one account.
    const problem = () => {
        const a = single();
        return a?.invalid ? "Unavailable" : a?.signedIn === false ? "Not signed in" : undefined;
    };
    // Under the name: what's missing, or the one account's email.
    const sub = () => !installed() ? "Not installed" : !p.provider.configured ? "Not set up" : single()?.email;
    return <section class="cli-prov" aria-label={p.provider.name}>
        <div class="prov-line">
            <span class="prov-logo"><ProviderIcon id={p.provider.id} name={p.provider.name} size={18} /></span>
            <div class="prov-lab">
                <div class="prov-name">
                    <span class="truncate">{p.provider.name}</span>
                    <Show when={planLabel(main()?.plan)}>{(plan) => <span class="tag">{plan()}</span>}</Show>
                    <Show when={p.provider.configured}>
                        <Show when={problem()} fallback={<span class="cli-dot" role="img" aria-label="Connected" title="Connected" />}>
                            <span class="cli-problem">{problem()}</span>
                        </Show>
                    </Show>
                </div>
                <Show when={sub()}><div class="prov-sub truncate" title={single()?.email ? single()?.description : undefined}>{sub()}</div></Show>
            </div>
            <span class="prov-end">
                <Show when={refreshing()}><Spinner size={12} /></Show>
                <Show when={!installed() && p.provider.keyUrl}>
                    <button class="link-btn" onClick={() => void openExternal(p.provider.keyUrl!)}>Install <ExternalLink size={11} /></button>
                </Show>
                <Show when={installed() && !p.provider.configured && p.onConnect}>
                    <button class="btn secondary sm" disabled={p.connecting} onClick={() => p.onConnect!()}>{p.connecting ? <Spinner size={12} /> : `Use my ${cli()?.plan ?? "plan"}`}</button>
                </Show>
                <Show when={installed()}>
                    <button ref={providerMenu} class="hb sm" aria-label={`${p.provider.name} actions`} aria-haspopup="menu" aria-expanded={menu() === ""} onClick={() => setMenu(menu() === "" ? undefined : "")}><MoreHorizontal size={16} /></button>
                    <Menu open={menu() === ""} anchor={() => providerMenu} onClose={() => setMenu(undefined)} label={`${p.provider.name} actions`} width={220} align="end">
                        <button class="menu-item" role="menuitem" disabled={busy() || adding()} onClick={() => choose(() => { setActionError(undefined); setAdding(true); })}>Add account…</button>
                        <Show when={single()} keyed>{(a) => accountItems(a)}</Show>
                        <button class="menu-item" role="menuitem" disabled={busy()} onClick={() => choose(refreshNow)}>Refresh status</button>
                        <button class="menu-item" role="menuitem" onClick={() => choose(() => setHelp(true))}>Learn more…</button>
                        <Show when={p.provider.configured && p.onTurnOff}>
                            <div class="menu-sep" role="separator" />
                            <button class="menu-item danger" role="menuitem" onClick={() => choose(() => p.onTurnOff!())}>Turn off…</button>
                        </Show>
                    </Menu>
                </Show>
            </span>
        </div>
        <Show when={single()}>{(a) => renameForm(a(), () => providerMenu)}</Show>
        <Show when={installed() && accounts().length > 1}>
            <div class="account-list" role="list" aria-label={`${p.provider.name} accounts`}>
                <For each={accounts()}>{(a) => {
                    let anchor: HTMLButtonElement | undefined;
                    // The email names an account best; a named account keeps its name beside it.
                    const meta = () => [a.email && a.id !== "default" ? a.name : undefined, planLabel(a.plan), accountStatus(a)].filter(Boolean).join(" · ");
                    return <div class="account-row" role="listitem" classList={{ open: menu() === a.id }}>
                        <div class="account-identity" title={a.description}>
                            <span class="account-name truncate">{a.email ?? a.name}</span>
                            <Show when={meta()}><span class="account-meta truncate">{meta()}</span></Show>
                        </div>
                        <Show when={isDefault(a)}><span class="account-default" role="img" aria-label="Default" title="Used for new sessions"><Check size={14} /></span></Show>
                        <button ref={anchor} class="hb sm account-more" disabled={busy()} aria-label={`Actions for ${a.name}`} aria-haspopup="menu" aria-expanded={menu() === a.id} onClick={() => setMenu(menu() === a.id ? undefined : a.id)}><MoreHorizontal size={16} /></button>
                        <Menu open={menu() === a.id} anchor={() => anchor} onClose={() => setMenu(undefined)} label={`${a.name} account actions`} width={200} align="end">{accountItems(a)}</Menu>
                        {renameForm(a, () => anchor)}
                    </div>;
                }}</For>
            </div>
        </Show>
        <Show when={adding()}>
            <form id={`${uid}-add`} class="account-form" aria-label="Add account" noValidate aria-busy={busy()} onKeyDown={(e) => escape(e, cancelAdd)} onSubmit={(e) => { e.preventDefault(); void add(); }}>
                <label for={`${uid}-name`}>New account</label>
                <input id={`${uid}-name`} class="input" autofocus ref={(el) => queueMicrotask(() => { if (el.isConnected) el.focus(); })} aria-label="Account name" aria-invalid={error()?.field === "name"} aria-describedby={error()?.field === "name" ? `${uid}-name-error` : undefined} value={name()} maxLength={64} disabled={busy()} onInput={(e) => { setName(e.currentTarget.value); setError(undefined); }} placeholder="Work" />
                <Show when={error()?.field === "name"}><span id={`${uid}-name-error`} class="account-error" role="alert">{error()?.message}</span></Show>
                <details class="account-advanced" open={advanced()} onToggle={(e) => setAdvanced(e.currentTarget.open)}>
                    <summary>Use an existing folder</summary>
                    <input id={`${uid}-folder`} class="input mono" aria-label="Account folder" aria-invalid={error()?.field === "folder"} aria-describedby={`${uid}-folder-help${error()?.field === "folder" ? ` ${uid}-folder-error` : ""}`} value={folder()} maxLength={1024} disabled={busy()} onInput={(e) => { setFolder(e.currentTarget.value); setError(undefined); }} placeholder="/path/to/cli-home" />
                    <span id={`${uid}-folder-help`} class="account-hint">Leave blank and Harness makes a separate folder.</span>
                    <Show when={error()?.field === "folder"}><span id={`${uid}-folder-error`} class="account-error" role="alert">{error()?.message}</span></Show>
                </details>
                <Show when={error()?.field === "form"}><span class="account-error" role="alert">{error()?.message}</span></Show>
                <div class="account-actions">
                    <button class="btn primary sm" type="submit" disabled={busy()}>{busy() && <Spinner size={12} />}{busy() ? "Creating…" : "Create and sign in"}</button>
                    <button class="btn ghost sm" type="button" disabled={busy()} onClick={cancelAdd}>Cancel</button>
                </div>
            </form>
        </Show>
        <Show when={actionError()}><span class="account-error account-note" role="alert">{actionError()}</span></Show>
        <Dialog open={help()} onClose={() => setHelp(false)} title={`${p.provider.name} accounts`} width={420}>
            <p>Add an account to keep separate sign-ins, for example personal and work. Each one signs in on its own in the CLI terminal, and its folder keeps separate settings and history.</p>
            <p>{p.provider.id === "claude-code" ? "Claude Console sign-in without an API key is stored outside this folder and is not isolated per account." : "A new Codex home does not inherit your settings or MCP servers."}</p>
        </Dialog>
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
