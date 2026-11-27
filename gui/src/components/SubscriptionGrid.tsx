// Settings → Providers, from the user's own computer when it has servers: each subscription (Claude Code, Codex…)
// and its accounts down the side, each machine across the top, and in each cell how it stands there. Accounts are
// made here and reach the servers with sync (servers/sync-state.ts); a server only needs each one signed in, which
// its cell does in a terminal here, as `cavvy servers login` does.

import { createEffect, createMemo, createSignal, For, Match, on, onCleanup, onMount, Show, Switch, type JSX } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import type { AccountInfo, ProviderInfo } from "@shared/protocol";
import { app, linkFor, refreshProviders, reportError, rpc } from "../state/app";
import { connectCli } from "../state/actions";
import { terminalActions } from "../state/ui";
import type { Rpc } from "../lib/rpc";
import { ProviderIcon } from "./ui/ProviderIcon";
import { Menu } from "./ui/Menu";
import { Spinner } from "./ui/bits";
import "../styles/subscription-grid.css";

interface Column {
    /** Left out for the machine the window is on. */
    server?: string;
    label: string;
}

interface Far {
    link?: Rpc;
    list?: ProviderInfo[];
    problem?: string;
}

const planLabel = (plan?: string) => (plan ? plan.charAt(0).toUpperCase() + plan.slice(1) : undefined);

export default function SubscriptionGrid(p: { here: string; servers: readonly string[]; touched: () => number }) {
    const [far, setFar] = createStore<Record<string, Far>>({});
    const read = async (name: string) => {
        const link = far[name]?.link;
        if (!link) return;
        try {
            setFar(name, "list", reconcile(await link.call("providers.list", {}), { key: "id" }));
        } catch (e) {
            setFar(name, "problem", e instanceof Error ? e.message : String(e));
        }
    };
    /** How its accounts stand, asked there (the list alone doesn't say until they've been checked), then read again. */
    const check = async (name: string) => {
        const f = far[name];
        if (!f?.link || !f.list) return;
        await Promise.all(f.list.filter((pr) => pr.agentCli?.installed && pr.configured).map((pr) => f.link!.call("accounts.list", { provider: pr.id, refresh: true }).catch(() => undefined)));
        await read(name);
    };
    const open = (name: string) => {
        if (far[name]) return;
        setFar(name, {});
        linkFor(name)
            .then(async (link) => {
                setFar(name, "link", link);
                await read(name);
                await check(name);
            })
            .catch((e) => setFar(name, "problem", e instanceof Error ? e.message : String(e)));
    };
    /** This computer's, the same way. */
    const checkHere = async () => {
        await Promise.all(app.providers.filter((pr) => pr.agentCli?.installed && pr.configured).map((pr) => rpc.call("accounts.list", { provider: pr.id, refresh: true }).catch(() => undefined)));
        await refreshProviders().catch(() => undefined);
    };
    // A subscription can sign itself out (its sign-in expires): every machine is asked again when this shows, and when
    // the user comes back to the window (from signing in elsewhere, or after a while). Nothing polls.
    // Each check runs every CLI's own status command on every machine: not again within a few seconds of the last.
    let checkedAt = 0;
    const checkAll = () => {
        if (Date.now() - checkedAt < 15_000) return;
        checkedAt = Date.now();
        void checkHere();
        for (const name of p.servers) void check(name);
    };
    onMount(() => {
        p.servers.forEach(open);
        checkedAt = Date.now();
        void checkHere();
        window.addEventListener("focus", checkAll);
    });
    onCleanup(() => window.removeEventListener("focus", checkAll));
    createEffect(on(() => [...p.servers], (names) => names.forEach(open), { defer: true }));
    // Signed in on a server from here, or its keys changed: how its accounts stand is asked again there.
    createEffect(on(p.touched, () => p.servers.forEach((name) => void check(name)), { defer: true }));

    const columns = (): Column[] => [{ label: p.here }, ...p.servers.map((server) => ({ server, label: server }))];
    const listOn = (c: Column): readonly ProviderInfo[] | undefined => (c.server ? far[c.server]?.list : app.providers);
    const subs = (list?: readonly ProviderInfo[]) => (list ?? []).filter((pr) => pr.agentCli && !pr.search);
    // This computer's order, then any only a server has.
    const all = createMemo(() => {
        const out = [...subs(app.providers)];
        for (const s of p.servers) for (const pr of subs(far[s]?.list)) if (!out.some((o) => o.id === pr.id)) out.push(pr);
        return out;
    });
    /** Turned on on some machine: a row. The rest are offered under the table. */
    const used = (id: string) => columns().some((c) => listOn(c)?.find((pr) => pr.id === id)?.configured);
    const providers = () => all().filter((pr) => used(pr.id));
    const unused = () => all().filter((pr) => !used(pr.id));
    /** The account new sessions use, as this computer says (sync gives the servers the same): on the provider's own row. */
    const mainOf = (id: string) => (app.providers.find((pr) => pr.id === id) ?? all().find((pr) => pr.id === id))?.agentCli?.defaultAccount ?? "default";
    /** Its other accounts, on any machine: a row each, under it. */
    const othersOf = (id: string): { id: string; name: string }[] => {
        const seen = new Map<string, string>();
        for (const c of columns()) for (const a of listOn(c)?.find((pr) => pr.id === id)?.agentCli?.accounts ?? []) if (!a.invalid && a.id !== mainOf(id) && !seen.has(a.id)) seen.set(a.id, a.name);
        return [...seen].map(([id, name]) => ({ id, name }));
    };

    const signIn = (c: Column, pr: ProviderInfo, a: AccountInfo) =>
        terminalActions.loginAccount?.(pr.id, a.id, [pr.name, a.id === "default" ? undefined : a.name, c.server].filter(Boolean).join(" · "), c.server);
    const turnOn = async (c: Column, pr: ProviderInfo) => {
        if (!c.server) return void (await connectCli(pr));
        const link = far[c.server]?.link;
        if (!link) return;
        try {
            await link.call("providers.connectCli", { provider: pr.id });
            await read(c.server);
        } catch (e) {
            reportError(e);
        }
    };
    /** Its installer, run on that machine in a terminal here. */
    const install = (c: Column, pr: ProviderInfo) => terminalActions.installCli?.(pr.id, ["Install", pr.name, c.server].filter(Boolean).join(" · "), c.server);

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
        const problem = () => (q.c.server ? far[q.c.server]?.problem : undefined);
        return (
            <div class="sg-cell" role="cell">
                <Switch fallback={<span class="sg-none" aria-label="Not on this machine">–</span>}>
                    <Match when={problem()}>
                        <Show when={q.head}><span class="sg-muted" title={problem()}>Offline</span></Show>
                    </Match>
                    <Match when={!list()}>
                        <Show when={q.head}><Spinner size={11} /></Show>
                    </Match>
                    <Match when={!cli()?.installed}>
                        <Show when={q.head} fallback={<span />}>
                            <Show when={(pr() ?? any())?.agentCli?.installable} fallback={<span class="sg-muted" title={(pr() ?? any())?.agentCli?.install}>Not installed</span>}>
                                <button class="sg-link" aria-label={`Install ${(pr() ?? any())!.name} on ${q.c.label}`} onClick={() => install(q.c, (pr() ?? any())!)}>Install</button>
                            </Show>
                        </Show>
                    </Match>
                    <Match when={!pr()?.configured}>
                        <Show when={q.head} fallback={<span />}>
                            <button class="btn secondary sm" onClick={() => void turnOn(q.c, pr()!)}>Turn on</button>
                        </Show>
                    </Match>
                    <Match when={account()}>
                        {(a) => (
                            <Switch fallback={<span class="sg-muted" title="Not checked yet" />}>
                                <Match when={a().invalid}><span class="sg-muted">Unavailable</span></Match>
                                <Match when={a().signedIn === true}><span class="cli-dot" role="img" aria-label="Signed in" title={a().email ?? "Signed in"} /></Match>
                                <Match when={a().signedIn === false}>
                                    <button class="btn secondary sm" aria-label={`Sign in to ${pr()!.name} ${a().name} on ${q.c.label}`} onClick={() => signIn(q.c, pr()!, a())}>Sign in</button>
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
    // Provider, then account, then a column per machine: every account of a provider in the same column.
    const cols = () => `calc(150 * var(--sp)) minmax(0, 1fr) repeat(${columns().length}, minmax(calc(76 * var(--sp)), calc(96 * var(--sp))))`;
    /** This computer's account, for its name and plan. */
    const accountHere = (id: string, account: string) => app.providers.find((x) => x.id === id)?.agentCli?.accounts?.find((a) => a.id === account);
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
                                <button class="menu-item" role="menuitem" onClick={() => { setMore(false); void turnOn({ label: p.here }, pr); }}>
                                    <ProviderIcon id={pr.id} name={pr.name} size={14} /> {pr.name}
                                </button>
                            )}
                        </For>
                    </Menu>
                </div>
            </Show>
        </div>
    );
}
