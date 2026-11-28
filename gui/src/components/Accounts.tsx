import "../styles/accounts.css";
import { createEffect, createSignal, createUniqueId, For, onMount, Show } from "solid-js";
import { Check, ChevronRight, ExternalLink, Info, MoreHorizontal } from "lucide-solid";
import type { AccountInfo, AgentInstanceInfo, ProviderInfo } from "@shared/protocol";
import { useProvidersAt } from "../state/providers-at";
import { addAccountFor, setAddAccountFor, terminalActions } from "../state/ui";
import { openExternal } from "../lib/platform";
import { Menu } from "./ui/Menu";
import { Dialog } from "./ui/Dialog";
import { ProviderIcon } from "./ui/ProviderIcon";
import { Spinner } from "./ui/bits";
import { EnvDialog, InstanceDialog } from "./CliEnv";
import { removedToast } from "../lib/reset-toast";

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
    // The machine these are on: the window's own, or a server shown from here (state/providers-at.ts).
    const at = useProvidersAt();
    const rpc = at.link;
    const refreshProviders = at.refresh;
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
    const [envOpen, setEnvOpen] = createSignal(false);
    const env = () => cli()?.env ?? [];
    const instances = () => cli()?.instances ?? [];
    /** The instance dialog: "new" to add one, else the one being changed. */
    const [instanceOpen, setInstanceOpen] = createSignal<AgentInstanceInfo | "new">();
    const [removingInstance, setRemovingInstance] = createSignal<AgentInstanceInfo>();
    const [removeInstanceError, setRemoveInstanceError] = createSignal<string>();
    /** What an instance is set up with, beside its name. */
    const instanceMeta = (i: AgentInstanceInfo) => [i.env.length ? (i.env.length === 1 ? "1 variable" : `${i.env.length} variables`) : "", i.models?.length ? (i.models.length === 1 ? "1 more model" : `${i.models.length} more models`) : ""].filter(Boolean).join(" · ");
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
    let section: HTMLElement | undefined;
    // "Add account…" in the model picker: open the form here, in view.
    createEffect(() => {
        if (at.server || addAccountFor() !== p.provider.id) return;
        setAddAccountFor(undefined);
        if (!installed()) return;
        setActionError(undefined);
        setAdding(true);
        requestAnimationFrame(() => section?.scrollIntoView({ block: "nearest" }));
    });
    const work = async (fn: () => Promise<void>, fail = setActionError) => {
        if (busy()) return;
        setBusy(true); fail(undefined);
        try { await fn(); } catch (e) { fail(message(e)); } finally { setBusy(false); }
    };
    const refreshNow = () => void work(async () => {
        setRefreshing(true);
        try { await refresh(); } finally { setRefreshing(false); }
    });
    // A server's: the CLI's sign-in there, in a terminal here, where its link is opened.
    const login = (a: AccountInfo) => terminalActions.loginAccount?.(p.provider.id, a.id, [p.provider.name, at.server && a.id === "default" ? undefined : a.name, at.server].filter(Boolean).join(" · "), at.server);
    // In a terminal on the machine these are on, as signing in is: a web page would install nothing there.
    const install = () => terminalActions.installCli?.(p.provider.id, ["Install", p.provider.name, at.server].filter(Boolean).join(" · "), at.server);
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
            void at.changed().catch((e) => setActionError(message(e)));
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
            <button type="button" class="btn ghost sm" disabled={busy()} onClick={() => { setEditing(undefined); back()?.focus(); }}>Cancel</button><button class="btn primary sm" disabled={busy()}>Save</button>
            <Show when={renameError()}><span id={`${uid}-rename-error`} class="account-error" role="alert">{renameError()}</span></Show>
        </form>
    </Show>;
    // Beside the name: a green dot once the account new sessions use is known to be signed in here, or what's wrong
    // with its one account (several say theirs on their own rows). Not checked yet says nothing.
    const problem = () => {
        const a = single();
        return a?.invalid ? "Unavailable" : a?.signedIn === false ? "Not signed in" : undefined;
    };
    // On its free models without a sign-in (OpenCode): no dot, and a sign-in offered.
    const signedIn = () => { const a = main(); return !!a && !a.invalid && a.signedIn === true && !a.free; };
    // Under the name: what's missing, or the one account's email.
    const sub = () => !installed() ? (cli()?.installing ? "Installing…" : cli()?.installError ? "Couldn't install" : "Not installed") : !p.provider.configured ? "Not set up" : single()?.free ? "Free models only" : single()?.email;
    return <section ref={section} class="cli-prov" aria-label={p.provider.name}>
        <div class="prov-line">
            <span class="prov-logo"><ProviderIcon id={p.provider.id} name={p.provider.name} size={18} /></span>
            <div class="prov-lab">
                <div class="prov-name">
                    <span class="truncate">{p.provider.name}</span>
                    {/* Turned off (not set up), it has no plan in Cavvy: none is shown. */}
                    <Show when={p.provider.configured && planLabel(main()?.plan)}>{(plan) => <span class="tag">{plan()}</span>}</Show>
                    <Show when={p.provider.configured && env().length}>
                        <button class="tag env-tag" title={env().map((v) => v.name).join(", ")} onClick={() => setEnvOpen(true)}>
                            {env().length === 1 ? "1 variable" : `${env().length} variables`}
                        </button>
                    </Show>
                    <Show when={p.provider.configured}>
                        <Show when={problem()} fallback={<Show when={signedIn()}><span class="cli-dot" role="img" aria-label="Signed in" title="Signed in" /></Show>}>
                            <span class="cli-problem">{problem()}</span>
                        </Show>
                    </Show>
                </div>
                <Show when={sub()}><div class="prov-sub truncate" title={single()?.email ? single()?.description : undefined}>{sub()}</div></Show>
            </div>
            <span class="prov-end">
                <Show when={refreshing()}><Spinner size={12} /></Show>
                <Show when={!installed() && (cli()?.installable && terminalActions.installCli ? !cli()?.installing : p.provider.keyUrl)}>
                    <Show when={cli()?.installable && terminalActions.installCli} fallback={<button class="link-btn" onClick={() => void openExternal(p.provider.keyUrl!)}>Install <ExternalLink size={11} /></button>}>
                        <button class="btn secondary sm" title={cli()?.installError} onClick={install}>Install</button>
                    </Show>
                </Show>
                <Show when={installed() && p.provider.configured && (single()?.signedIn === false || single()?.free) && !single()?.invalid}>
                    <button class="btn secondary sm" disabled={busy()} onClick={() => login(single()!)}>Sign in</button>
                </Show>
                <Show when={installed() && !p.provider.configured && p.onConnect}>
                    <button class="btn secondary sm" disabled={p.connecting} onClick={() => p.onConnect!()}>{p.connecting ? <Spinner size={12} /> : `Use my ${cli()?.plan ?? "plan"}`}</button>
                </Show>
                <Show when={installed()}>
                    <button ref={providerMenu} class="hb sm" aria-label={`${p.provider.name} actions`} aria-haspopup="menu" aria-expanded={menu() === ""} onClick={() => setMenu(menu() === "" ? undefined : "")}><MoreHorizontal size={16} /></button>
                    <Menu open={menu() === ""} anchor={() => providerMenu} onClose={() => setMenu(undefined)} label={`${p.provider.name} actions`} width={220} align="end">
                        <Show when={cli()?.multiAccount !== false}>
                            <button class="menu-item" role="menuitem" disabled={busy() || adding()} onClick={() => choose(() => { setActionError(undefined); setAdding(true); })}>Add account…</button>
                        </Show>
                        <Show when={single()} keyed>{(a) => accountItems(a)}</Show>
                        <Show when={p.provider.configured}>
                            <button class="menu-item" role="menuitem" onClick={() => choose(() => setEnvOpen(true))}>Environment variables…</button>
                        </Show>
                        <button class="menu-item" role="menuitem" onClick={() => choose(() => setInstanceOpen("new"))}>Add another {p.provider.name}…</button>
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
                        {/* Some of Default's setup isn't linked into this account: what, and why, on hover. */}
                        <Show when={a.sharing}>{(why) => {
                            const said = () => `Some of your ${p.provider.name} setup isn't shared with this account.\n\n${why()}`;
                            return <span class="account-sharing" role="img" tabIndex={0} aria-label={said()} title={said()}><Info size={14} /></span>;
                        }}</Show>
                        <Show when={a.signedIn === false && !a.invalid}><button class="btn secondary sm" disabled={busy()} aria-label={`Sign in to ${a.name}`} onClick={() => login(a)}>Sign in</button></Show>
                        <Show when={isDefault(a)}><span class="account-default" role="img" aria-label="Default" title="Used for new sessions"><Check size={14} /></span></Show>
                        <button ref={anchor} class="hb sm account-more" disabled={busy()} aria-label={`Actions for ${a.name}`} aria-haspopup="menu" aria-expanded={menu() === a.id} onClick={() => setMenu(menu() === a.id ? undefined : a.id)}><MoreHorizontal size={16} /></button>
                        <Menu open={menu() === a.id} anchor={() => anchor} onClose={() => setMenu(undefined)} label={`${a.name} account actions`} width={200} align="end">{accountItems(a)}</Menu>
                        {renameForm(a, () => anchor)}
                    </div>;
                }}</For>
            </div>
        </Show>
        <Show when={installed() && instances().length}>
            <div class="account-list" role="list" aria-label={`Other ${p.provider.name} setups`}>
                <For each={instances()}>{(i) => {
                    let anchor: HTMLButtonElement | undefined;
                    const key = `instance:${i.id}`;
                    return <div class="account-row" role="listitem" classList={{ open: menu() === key }}>
                        <div class="account-identity">
                            <span class="account-name truncate">{p.provider.name} · {i.name}</span>
                            <Show when={instanceMeta(i)}><span class="account-meta truncate">{instanceMeta(i)}</span></Show>
                        </div>
                        <button ref={anchor} class="hb sm account-more" aria-label={`Actions for ${p.provider.name} · ${i.name}`} aria-haspopup="menu" aria-expanded={menu() === key} onClick={() => setMenu(menu() === key ? undefined : key)}><MoreHorizontal size={16} /></button>
                        <Menu open={menu() === key} anchor={() => anchor} onClose={() => setMenu(undefined)} label={`${i.name} actions`} width={200} align="end">
                            <button class="menu-item" role="menuitem" onClick={() => choose(() => setInstanceOpen(i))}>Edit…</button>
                            <button class="menu-item danger" role="menuitem" onClick={() => choose(() => { setRemoveInstanceError(undefined); setRemovingInstance(i); })}>Remove…</button>
                        </Menu>
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
                    <summary><ChevronRight size={14} class="chev" />Use an existing folder</summary>
                    <input id={`${uid}-folder`} class="input mono" aria-label="Account folder" aria-invalid={error()?.field === "folder"} aria-describedby={`${uid}-folder-help${error()?.field === "folder" ? ` ${uid}-folder-error` : ""}`} value={folder()} maxLength={1024} disabled={busy()} onInput={(e) => { setFolder(e.currentTarget.value); setError(undefined); }} placeholder="/path/to/cli-home" />
                    <span id={`${uid}-folder-help`} class="account-hint">Used as it is, without Default's settings and history.</span>
                    <Show when={error()?.field === "folder"}><span id={`${uid}-folder-error`} class="account-error" role="alert">{error()?.message}</span></Show>
                </details>
                <Show when={error()?.field === "form"}><span class="account-error" role="alert">{error()?.message}</span></Show>
                {/* Cancel, then the form's own action, at the trailing edge, as in the app's dialogs and Settings' other forms. */}
                <div class="account-actions">
                    <button class="btn ghost sm" type="button" disabled={busy()} onClick={cancelAdd}>Cancel</button>
                    <button class="btn primary sm" type="submit" disabled={busy()}>{busy() && <Spinner size={12} />}{busy() ? "Creating…" : "Create and sign in"}</button>
                </div>
            </form>
        </Show>
        <Show when={actionError()}><span class="account-error account-note" role="alert">{actionError()}</span></Show>
        <Dialog open={help()} onClose={() => setHelp(false)} title={`${p.provider.name} accounts`} width={420}>
            <p>Keep separate sign-ins, like personal and work.</p>
            <p>{p.provider.id === "claude-code"
                ? "A new account shares Default's settings and history, but not your user MCP servers. Claude Console sign-ins without an API key aren't kept separate."
                : "A new account shares Default's settings and history; only the sign-in differs."}</p>
            <p>A folder you choose is used as it is, with nothing shared.</p>
        </Dialog>
        <Show when={envOpen()}><EnvDialog provider={p.provider} onClose={() => setEnvOpen(false)} /></Show>
        <Show when={instanceOpen()} keyed>{(i) => <InstanceDialog provider={p.provider} instance={i === "new" ? undefined : i} onClose={() => setInstanceOpen(undefined)} />}</Show>
        <Show when={removingInstance()}>{(i) => <Dialog open onClose={() => { if (!busy()) setRemovingInstance(undefined); }} title={`Remove ${i().name}?`} width={460}>
            <p>Sessions using it will need another model.</p>
            <Show when={removeInstanceError()}><p class="account-error" role="alert">{removeInstanceError()}</p></Show>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" autofocus disabled={busy()} onClick={() => setRemovingInstance(undefined)}>Cancel</button>
                <button class="btn danger" disabled={busy()} aria-busy={busy()} onClick={() => void work(async () => {
                    // Read before the dialog closes: its accessor goes with it.
                    const { id, name } = i();
                    const r = await rpc.call("providers.removeInstance", { id });
                    setRemovingInstance(undefined);
                    removedToast(name, r?.reset);
                    // Its row is gone: back to the provider's menu button, not the page.
                    providerMenu?.focus();
                    await at.changed().catch((e) => setActionError(message(e)));
                }, setRemoveInstanceError)}>{busy() ? "Removing…" : "Remove"}</button>
            </div>
        </Dialog>}</Show>
        <Show when={removing()}>{(a) => <Dialog open onClose={() => { if (!busy()) setRemoving(undefined); }} title={`Remove ${a().name}?`} width={460}>
            <p>{a().managed && !a().invalid ? "Deletes the folder Cavvy made" : "Leaves its folder untouched"}: <code class="account-path">{a().folder}</code></p>
            <p>This doesn't sign it out: run <code>{p.provider.id === "codex" ? "codex logout" : "claude auth logout"}</code> with its folder first.</p>
            <Show when={removeError()}><p class="account-error" role="alert">{removeError()}</p></Show>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" autofocus disabled={busy()} onClick={() => setRemoving(undefined)}>Cancel</button>
                <button class="btn danger" disabled={busy()} aria-busy={busy()} onClick={() => void work(async () => { await rpc.call("accounts.remove", { provider: p.provider.id, id: a().id, confirmedFolder: a().folder }); setRemoving(undefined); await refreshProviders().catch((e) => setActionError(message(e))); }, setRemoveError)}>{busy() ? "Removing…" : "Remove"}</button>
            </div>
        </Dialog>}</Show>
    </section>;
}
