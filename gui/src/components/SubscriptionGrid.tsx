// Settings → Providers when the user has servers, in a window on any of their machines: each subscription (Claude
// Code, Codex…) and its accounts down the side, each machine across the top, and in each cell how it stands there.
// Accounts are made on the user's computer and reach the servers with sync (servers/sync-state.ts); a server only
// needs each one signed in, which its cell does in a terminal, as `cavvy servers login` does.

import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { AccountInfo, ProviderInfo } from "@shared/protocol";
import { app, linkFor, refreshProviders, reportError, rpc } from "../state/app";
import { connectCli } from "../state/actions";
import { addAccountFor, terminalActions } from "../state/ui";
import { machine } from "../lib/platform";
import type { Rpc } from "../lib/rpc";
import { ProviderIcon } from "./ui/ProviderIcon";
import { Menu } from "./ui/Menu";
import { Dialog } from "./ui/Dialog";
import { MoreHorizontal } from "lucide-solid";
import { Spinner } from "./ui/bits";
import "../styles/subscription-grid.css";

interface Column {
    /** Its key among the machines read over a connection of the grid's own: a server's name, "" the user's computer. */
    key: string;
    /** One of the user's servers; left out for their own computer. */
    server?: string;
    label: string;
}

interface Far {
    link?: Rpc;
    list?: ProviderInfo[];
    problem?: string;
}

/** While a server installs a CLI, how often its providers are read again. */
const INSTALL_RECHECK_MS = 10_000;
/** After a change here, long enough for sync to reach a server (its 1.5 s settle, then the call). */
const SYNC_SETTLE_MS = 4_000;

const planLabel = (plan?: string) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined);

/** The machine the window is on: read and changed over the window's own connection, as the rest of Settings is. */
const own = (c: Column) => c.server === machine;

/**
 * The same table whichever machine the window is on: the user's computer first, then each server. `manage`: the
 * window's own machine's card for a provider (its accounts, turning it off), shown over the grid.
 */
export default function SubscriptionGrid(p: { here: string; servers: readonly string[]; touched: () => number; manage: (pr: ProviderInfo) => JSX.Element }) {
    const [far, setFar] = createStore<Record<string, Far>>({});
    const columns = (): Column[] => [{ key: "", label: p.here }, ...p.servers.map((server) => ({ key: server, server, label: server }))];
    const others = () => columns().filter((c) => !own(c));
    const read = async (key: string) => {
        const link = far[key]?.link;
        if (!link) return;
        try {
            setFar(key, "list", reconcile(await link.call("providers.list", {}), { key: "id" }));
        } catch (e) {
            setFar(key, "problem", e instanceof Error ? e.message : String(e));
        }
    };
    /** How its accounts stand, asked there (the list alone doesn't say until they've been checked), then read again. */
    const check = async (key: string) => {
        const f = far[key];
        if (!f?.link || !f.list) return;
        await Promise.all(f.list.filter((pr) => pr.agentCli?.installed && pr.configured).map((pr) => f.link!.call("accounts.list", { provider: pr.id, refresh: true }).catch(() => undefined)));
        await read(key);
    };
    const open = (key: string) => {
        if (far[key]) return;
        setFar(key, {});
        linkFor(key || undefined)
            .then(async (link) => {
                setFar(key, "link", link);
                await read(key);
                await check(key);
            })
            .catch((e) => setFar(key, "problem", e instanceof Error ? e.message : String(e)));
    };
    /** The window's own machine's, the same way. */
    const checkOwn = async () => {
        await Promise.all(app.providers.filter((pr) => pr.agentCli?.installed && pr.configured).map((pr) => rpc.call("accounts.list", { provider: pr.id, refresh: true }).catch(() => undefined)));
        await refreshProviders().catch(() => undefined);
    };
    /** One machine's, read again and asked how its accounts stand. */
    const recheck = (c: Column) => (own(c) ? checkOwn() : read(c.key).then(() => check(c.key)));
    // A subscription can sign itself out (its sign-in expires): every machine is asked again when this shows, and when
    // the user comes back to the window (from signing in elsewhere, or after a while). Nothing polls.
    // Each check runs every CLI's own status command on every machine: not again within a few seconds of the last.
    let checkedAt = 0;
    const checkAll = () => {
        if (Date.now() - checkedAt < 15_000) return;
        checkedAt = Date.now();
        void checkOwn();
        for (const c of others()) void check(c.key);
    };
    onMount(() => {
        others().forEach((c) => open(c.key));
        checkedAt = Date.now();
        void checkOwn();
        window.addEventListener("focus", checkAll);
    });
    onCleanup(() => window.removeEventListener("focus", checkAll));
    createEffect(on(() => others().map((c) => c.key), (keys) => keys.forEach(open), { defer: true }));
    // Signed in on another machine from here, or its keys changed: how its accounts stand is asked again there.
    createEffect(on(p.touched, () => others().forEach((c) => void check(c.key)), { defer: true }));
    /** The user's computer's providers: what the servers sync from, and whose accounts name the rows. */
    const homeList = () => listOn(columns()[0]!);
    // A subscription turned on or off on the user's computer: sync takes it to the servers (installing it where it's
    // missing), so they're read again once that's had time to start.
    createEffect(on(() => (homeList() ?? []).filter((pr) => pr.agentCli && pr.configured).map((pr) => pr.id).join(","), () => {
        const t = setTimeout(() => columns().forEach((c) => c.server && void recheck(c)), SYNC_SETTLE_MS);
        onCleanup(() => clearTimeout(t));
    }, { defer: true }));
    // A server installing a CLI by sync (src/servers/sync-install.ts): read again until it's done. Only meanwhile.
    createEffect(() => {
        for (const c of columns()) {
            if (!c.server || !listOn(c)?.some((pr) => pr.agentCli?.installing)) continue;
            // Then how it stands there: installed is "Sign in" or signed in, not unknown.
            const t = setTimeout(() => void recheck(c), INSTALL_RECHECK_MS);
            onCleanup(() => clearTimeout(t));
        }
    });

    function listOn(c: Column): readonly ProviderInfo[] | undefined {
        return own(c) ? app.providers : far[c.key]?.list;
    }
    const subs = (list?: readonly ProviderInfo[]) => (list ?? []).filter((pr) => pr.agentCli && !pr.search);
    // The user's computer's order, then any only another machine has.
    const all = createMemo(() => {
        const out: ProviderInfo[] = [];
        for (const c of columns()) for (const pr of subs(listOn(c))) if (!out.some((o) => o.id === pr.id)) out.push(pr);
        return out;
    });
    /** Turned on on some machine: a row. The rest are offered under the table. */
    const used = (id: string) => columns().some((c) => listOn(c)?.find((pr) => pr.id === id)?.configured);
    const providers = () => all().filter((pr) => used(pr.id));
    const unused = () => all().filter((pr) => !used(pr.id));
    /** The account new sessions use, as the user's computer says (sync gives the servers the same): on the provider's own row. */
    const mainOf = (id: string) => (homeList()?.find((pr) => pr.id === id) ?? all().find((pr) => pr.id === id))?.agentCli?.defaultAccount ?? "default";
    /** Its other accounts, on any machine: a row each, under it. */
    const othersOf = (id: string): { id: string; name: string }[] => {
        const seen = new Map<string, string>();
        for (const c of columns()) for (const a of listOn(c)?.find((pr) => pr.id === id)?.agentCli?.accounts ?? []) if (!a.invalid && a.id !== mainOf(id) && !seen.has(a.id)) seen.set(a.id, a.name);
        return [...seen].map(([id, name]) => ({ id, name }));
    };

    /**
     * A sign-in or install on machine `c`, in a terminal. The window's own machine's runs there; in a window on a
     * server, another machine's runs on the user's computer (a server's from there, as `cavvy servers login` does),
     * which is where a server is reached from.
     */
    const inTerminal = (c: Column, ask: { provider: string; accountId: string; name: string; install?: boolean }) => {
        if (own(c)) return ask.install ? terminalActions.installCli?.(ask.provider, ask.name) : terminalActions.loginAccount?.(ask.provider, ask.accountId, ask.name);
        if (machine) return terminalActions.loginOnHome?.({ ...ask, ...(c.server ? { server: c.server } : {}) });
        return ask.install ? terminalActions.installCli?.(ask.provider, ask.name, c.server) : terminalActions.loginAccount?.(ask.provider, ask.accountId, ask.name, c.server);
    };
    /** In a terminal's tab, which machine it's on: all but the user's computer in a window there. */
    const where = (c: Column) => (c.server || machine ? c.label : undefined);
    const signIn = (c: Column, pr: ProviderInfo, a: AccountInfo) =>
        inTerminal(c, { provider: pr.id, accountId: a.id, name: [pr.name, a.id === "default" ? undefined : a.name, where(c)].filter(Boolean).join(" · ") });
    const turnOn = async (c: Column, pr: ProviderInfo) => {
        // Signed in first when it isn't (the sign-in turns it on), installed first when it isn't there.
        const refused = (e: unknown) => {
            const code = (e as { code?: string }).code;
            if (code === "not_signed_in") signIn(c, pr, { id: "default", name: "Default", folder: "", managed: false });
            else if (code === "not_installed" && pr.agentCli?.installable) install(c, pr);
            else reportError(e);
        };
        if (own(c)) return void (await connectCli(pr, refused));
        const link = far[c.key]?.link;
        if (!link) return;
        try {
            await link.call("providers.connectCli", { provider: pr.id });
            await read(c.key);
        } catch (e) {
            refused(e);
        }
    };
    /** Its installer, run on that machine in a terminal here. */
    const install = (c: Column, pr: ProviderInfo) => inTerminal(c, { provider: pr.id, accountId: "default", name: ["Install", pr.name, where(c)].filter(Boolean).join(" · "), install: true });

    /** How one account (or a provider with only Default) stands on one machine. */
    const Cell = (q: { c: Column; id: string; account: string; head: boolean }): JSX.Element => {
        const list = () => listOn(q.c);
        const pr = () => list()?.find((x) => x.id === q.id);
        /** As another machine has it, for one this machine doesn't list. */
        const any = () => all().find((x) => x.id === q.id);
        const cli = () => pr()?.agentCli;
        const account = () => {
            const all = cli()?.accounts ?? [];
            return all.find((a) => a.id === q.account) ?? (q.account === "default" && !all.length ? { id: "default", name: "Default", folder: "", managed: false } : undefined);
        };
        const problem = () => (own(q.c) ? undefined : far[q.c.key]?.problem);
        return (
            <div class="sg-cell" role="cell">
                <Switch fallback={<span class="sg-none" aria-label="Not on this machine">–</span>}>
                    <Match when={problem()}>
                        <Show when={q.head}><span class="sg-muted" title={problem()}>Offline</span></Show>
                    </Match>
                    <Match when={!list()}>
                        <Show when={q.head}><Spinner size={11} /></Show>
                    </Match>
                    <Match when={!cli()?.installed && cli()?.installing}>
                        <Show when={q.head} fallback={<span />}>
                            <span class="sg-muted sg-installing"><Spinner size={11} /> Installing</span>
                        </Show>
                    </Match>
                    <Match when={!cli()?.installed}>
                        <Show when={q.head} fallback={<span />}>
                            <Show when={(pr() ?? any())?.agentCli?.installable} fallback={<span class="sg-muted" title={(pr() ?? any())?.agentCli?.install}>Not installed</span>}>
                                <Show
                                    when={cli()?.installError}
                                    fallback={<button class="sg-link" aria-label={`Install ${(pr() ?? any())!.name} on ${q.c.label}`} onClick={() => install(q.c, (pr() ?? any())!)}>Install</button>}
                                >
                                    {/* Sync tried and it failed: the installer runs again where the user sees why. */}
                                    {(why) => <button class="sg-link sg-failed" title={why()} aria-label={`Couldn't install ${(pr() ?? any())!.name} on ${q.c.label}: ${why()}. Try again`} onClick={() => install(q.c, (pr() ?? any())!)}>Couldn't install</button>}
                                </Show>
                            </Show>
                        </Show>
                    </Match>
                    <Match when={!pr()?.configured}>
                        <Show when={q.head} fallback={<span />}>
                            <button class="btn btn-sm" onClick={() => void turnOn(q.c, pr()!)}>Turn on</button>
                        </Show>
                    </Match>
                    <Match when={account()}>
                        {(a) => (
                            <Switch fallback={<span class="sg-muted" title="Not checked yet" />}>
                                <Match when={a().invalid}><span class="sg-muted">Unavailable</span></Match>
                                {/* On its free models without a sign-in (OpenCode): it runs, and signing in is offered. */}
                                <Match when={a().free}>
                                    <span class="sg-free">
                                        <span class="sg-muted">Free</span>
                                        <button class="btn btn-sm" aria-label={`Sign in to ${pr()!.name} ${a().name} on ${q.c.label}`} onClick={() => signIn(q.c, pr()!, a())}>Sign in</button>
                                    </span>
                                </Match>
                                <Match when={a().signedIn === true}><span class="cli-dot" role="img" aria-label="Signed in" title={a().email ?? "Signed in"} /></Match>
                                <Match when={a().signedIn === false}>
                                    <button class="btn btn-sm" aria-label={`Sign in to ${pr()!.name} ${a().name} on ${q.c.label}`} onClick={() => signIn(q.c, pr()!, a())}>Sign in</button>
                                </Match>
                            </Switch>
                        )}
                    </Match>
                </Switch>
            </div>
        );
    };

    const [more, setMore] = createSignal(false);
    let moreBtn: HTMLButtonElement | undefined;
    /** The provider whose card for the window's own machine is open over the grid. */
    const [managing, setManaging] = createSignal<string>();
    const managed = () => app.providers.find((x) => x.id === managing() && x.agentCli);
    // "Add account…" in the model picker: the card opens, and its form with it (Accounts.tsx).
    createEffect(() => {
        const id = addAccountFor();
        if (id && app.providers.some((x) => x.id === id && x.agentCli)) setManaging(id);
    });
    // Provider, then account, then a column per machine: every account of a provider in the same column.
    const cols = () => `calc(150 * var(--sp)) minmax(0, 1fr) repeat(${columns().length}, minmax(calc(76 * var(--sp)), calc(96 * var(--sp))))`;
    /** The user's computer's account, for its name and plan. */
    const accountHere = (id: string, account: string) => homeList()?.find((x) => x.id === id)?.agentCli?.accounts?.find((a) => a.id === account);
    /** The window's own machine, whose card the ••• opens. */
    const ownLabel = () => machine ?? p.here;
    const AccountName = (q: { id: string; account: string; name?: string }) => (
        <div class="sg-account" role="rowheader">
            <span class="truncate">{q.name ?? accountHere(q.id, q.account)?.name ?? "Default"}</span>
            <Show when={planLabel(accountHere(q.id, q.account)?.plan)}>{(t) => <span class="sg-muted">{t()}</span>}</Show>
        </div>
    );
    return (
        <div class="sg" role="table" aria-label="Subscriptions on each machine" style={{ "--sg-cols": cols() }}>
            <div class="sg-row sg-head" role="row">
                <span role="columnheader" />
                <span role="columnheader" />
                <For each={columns()}>{(c) => <span class="sg-machine truncate" role="columnheader" title={c.label}>{c.label}</span>}</For>
            </div>
            <For each={providers()}>
                {(pr) => {
                    const accounts = () => othersOf(pr.id);
                    return (
                        <div class="sg-prov" role="rowgroup">
                            <div class="sg-row" role="row">
                                <div class="sg-name" role="rowheader">
                                    <span class="prov-logo"><ProviderIcon id={pr.id} name={pr.name} size={18} /></span>
                                    <span class="truncate">{pr.name}</span>
                                    <Show when={app.providers.some((x) => x.id === pr.id && x.agentCli)}>
                                        <button class="hb sm sg-manage" aria-label={`${pr.name} on ${ownLabel()}`} title={`${pr.name} on ${ownLabel()}`} onClick={() => setManaging(pr.id)}><MoreHorizontal size={14} /></button>
                                    </Show>
                                </div>
                                <AccountName id={pr.id} account={mainOf(pr.id)} />
                                <For each={columns()}>{(c) => <Cell c={c} id={pr.id} account={mainOf(pr.id)} head={true} />}</For>
                            </div>
                            <For each={accounts()}>
                                {(a) => (
                                    <div class="sg-row sg-acct" role="row">
                                        <span />
                                        <AccountName id={pr.id} account={a.id} name={a.name} />
                                        <For each={columns()}>{(c) => <Cell c={c} id={pr.id} account={a.id} head={false} />}</For>
                                    </div>
                                )}
                            </For>
                        </div>
                    );
                }}
            </For>
            <Show when={unused().length}>
                <div class="sg-more">
                    <button ref={moreBtn} class="sg-link" aria-haspopup="menu" aria-expanded={more()} onClick={() => setMore(!more())}>Add a subscription</button>
                    <Menu open={more()} anchor={() => moreBtn} onClose={() => setMore(false)} label="Add a subscription" width={220} align="start">
                        <For each={unused()}>
                            {(pr) => (
                                <button class="menu-item" role="menuitem" onClick={() => { setMore(false); void turnOn(columns()[0]!, pr); }}>
                                    <ProviderIcon id={pr.id} name={pr.name} size={14} /> {pr.name}
                                </button>
                            )}
                        </For>
                    </Menu>
                </div>
            </Show>
            <Dialog open={Boolean(managed())} onClose={() => setManaging()} title={`${managed()?.name ?? ""} on ${ownLabel()}`} width={560}>
                <Show when={managed()}>{(pr) => p.manage(pr())}</Show>
            </Dialog>
        </div>
    );
}
