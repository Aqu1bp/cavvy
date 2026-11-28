// Settings → Plugins. Discover is a catalog to scan: category filters, then cards (a mark, name and maker,
// two lines of summary, one Install); a card opens the plugin's details, where the install scope is picked.
// Installed is a list to manage: on/off for the current project, what loads, problems, and a ⋯ menu.
// Marketplaces is where catalogs are added. Every change goes through the server, which reloads each open
// folder's settings, commands and MCP servers.

import { createMemo, createSignal, For, Match, onMount, Show, Switch, type JSX } from "solid-js";
import { Activity, Briefcase, CodeXml, Database, Ellipsis, ExternalLink, FlaskConical, GraduationCap, Palette, Puzzle, RefreshCw, Rocket, RotateCw, Search, Shield, Trash2, X } from "lucide-solid";
import "../styles/plugins.css";
import type { PluginActionParams, PluginInfo, PluginMarketplaceInfo, PluginScope, PluginsInfo } from "@shared/protocol";
import { app, awayMachine, awayUnopened, linkFor, machineOf, reportError, rpc, toast } from "../state/app";
import { machine as windowMachine, os } from "../lib/platform";
import { ago, tildify } from "../lib/format";
import { openExternal } from "../lib/platform";
import { categoryOf, logoOwner, type CategoryIcon } from "../lib/plugins";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Dialog } from "./ui/Dialog";
import { Menu } from "./ui/Menu";
import { Segmented, Spinner, Toggle } from "./ui/bits";

/** Offered when no marketplace is added yet. */
const SUGGESTED = "anthropics/claude-plugins-official";

type View = "installed" | "discover" | "marketplaces";
type Act = (key: string, params: PluginActionParams, done?: () => void) => Promise<void>;
type Confirm = { title: string; body: string; label: string; run: () => Promise<void> };

const SCOPES: { value: PluginScope; label: string; title: (project?: string) => string }[] = [
    { value: "user", label: "For me", title: () => "On in every project, just for you" },
    { value: "project", label: "This project", title: (p) => `Shared with everyone in ${p ?? "the project"}` },
    { value: "local", label: "Just me, here", title: (p) => `Only you, only in ${p ?? "this project"}` },
];
const SCOPE_DONE: Record<PluginScope, string> = { user: "for me", project: "for this project", local: "just for me, here" };

export function countsText(c: NonNullable<PluginInfo["installed"]>["counts"]): string {
    const parts: string[] = [];
    const add = (n: number, one: string) => n && parts.push(`${n} ${one}${n === 1 ? "" : "s"}`);
    add(c.commands, "command");
    add(c.agents, "agent");
    add(c.skills, "skill");
    add(c.hooks, "hook");
    add(c.mcpServers, "MCP server");
    add(c.lspServers, "language server");
    return parts.join(", ");
}

const projectName = (cwd?: string) => (cwd ? (cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd) : undefined);
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

const ICONS: Record<CategoryIcon, typeof Puzzle> = { code: CodeXml, briefcase: Briefcase, palette: Palette, shield: Shield, flask: FlaskConical, database: Database, graduation: GraduationCap, activity: Activity, rocket: Rocket, puzzle: Puzzle };

/** Makers' logos, fetched by the server once per account (the page loads no outside images itself). */
const logos = new Map<string, Promise<string | undefined>>();
function logoFor(owner: string): Promise<string | undefined> {
    let hit = logos.get(owner);
    if (!hit) {
        // Only a logo is kept here. Without one (none, GitHub busy, offline) it's asked again the next time the
        // page shows it, and the server answers an account without an avatar from its own memory.
        hit = rpc.call("plugins.logo", { owner }).then(
            (l) => (l ? `data:${l.mediaType};base64,${l.data}` : undefined),
            () => undefined,
        );
        void hit.then((src) => src || logos.delete(owner));
        logos.set(owner, hit);
    }
    return hit;
}

/** A plugin's mark: its maker's logo when it has one, else its category's icon. */
function PluginMark(p: { plugin: PluginInfo; markets: PluginMarketplaceInfo[] }) {
    const cat = () => categoryOf(p.plugin.category);
    const [logo, setLogo] = createSignal<string>();
    const owner = logoOwner(p.plugin, p.markets);
    if (owner) void logoFor(owner).then(setLogo);
    const Icon = ICONS[cat().icon];
    return (
        <span class={`plugin-mark ${logo() ? "plugin-logo" : ""}`} aria-hidden="true">
            <Show when={logo()} fallback={<Icon size={16} />}>
                {(src) => <img src={src()} alt="" />}
            </Show>
        </span>
    );
}

/** What a card shows when it has nothing: one line, and the way on when there is one. */
function Blank(p: { title: string; children?: JSX.Element }) {
    return (
        <div class="card plugins-card">
            <div class="blank">
                <p class="blank-title">{p.title}</p>
                {p.children}
            </div>
        </div>
    );
}

export function Plugins() {
    const [info, setInfo] = createSignal<PluginsInfo>();
    const [loading, setLoading] = createSignal(true);
    /** What's under way: an action key ("install:fmt@m"), so only that row shows a spinner. */
    const [busy, setBusy] = createSignal<string>();
    const [view, setView] = createSignal<View>("installed");
    const [query, setQuery] = createSignal("");
    const [category, setCategory] = createSignal<string>();
    const [source, setSource] = createSignal("");
    /** The details dialog, one object per opening: an install started in one closes only that one. */
    const [details, setDetails] = createSignal<{ pl: PluginInfo }>();
    const [confirm, setConfirm] = createSignal<Confirm>();
    /**
     * Whose plugins these are: the window's own machine's, or a server's picked here ("": the window's own). Not the
     * session's in view: that changes under Settings, and what's listed and what's done must be one machine's.
     */
    const [where, setWhere] = createSignal("");
    /** The user's servers, to pick from (in a window on this computer; a window on a server has its own only). */
    const [servers, setServers] = createSignal<string[]>([]);
    /** Where the rows shown came from: what's done to one is done there, in the folder it was listed for. */
    let origin: { link: typeof rpc; cwd?: string } | undefined;
    let asked = 0;
    /** The folder in view, when it's on that machine: its project's own plugins count there, and nowhere else. */
    const folderOn = (on: string) => {
        const id = app.activeId;
        // By name, each as the user's own computer names it ("" itself): the window's own machine is a server's
        // name in a window on one, where "" from awayMachine is this computer's.
        const own = windowMachine ?? "";
        const its = awayMachine(id) ?? (awayUnopened(id) ? (machineOf(id!) ?? "") : own);
        return its === (on || own) ? app.homeCwd : undefined;
    };
    let searchEl: HTMLInputElement | undefined;
    let sourceEl: HTMLInputElement | undefined;

    const load = async () => {
        const mine = ++asked;
        const on = where();
        try {
            // The window's own Cavvy, or that server's, reached first.
            const from = { link: on ? await linkFor(on) : rpc, cwd: folderOn(on) };
            const got = await from.link.call("plugins.list", { cwd: from.cwd });
            // Another machine was picked meanwhile: its list is on its way.
            if (mine !== asked) return;
            origin = from;
            setInfo(got);
        } catch (e) {
            if (mine !== asked) return;
            // Nothing of the machine shown before stays under this one's name.
            origin = undefined;
            setInfo(undefined);
            reportError(e);
        } finally {
            if (mine === asked) setLoading(false);
        }
    };
    const pick = (on: string) => {
        // The one shown, picked again, only when its list didn't come: tried again.
        if ((on === where() && origin) || busy()) return;
        setWhere(on);
        setDetails(undefined);
        setConfirm(undefined);
        // What was typed for one machine (a marketplace's path there) isn't sent to another.
        setSource("");
        origin = undefined;
        setInfo(undefined);
        setLoading(true);
        void load();
    };
    onMount(() => {
        if (!windowMachine) void rpc.call("servers.list", {}).then((r) => setServers(r.servers.map((s) => s.name)), () => undefined);
        void load().then(() => {
            const i = info();
            // First visit with nothing installed: show what there is to install.
            if (i && !i.plugins.some((p) => p.installed || p.missing)) setView(i.marketplaces.length ? "discover" : "marketplaces");
        });
    });

    const act: Act = async (key, params, done) => {
        const from = origin;
        if (busy() || !from) return;
        setBusy(key);
        try {
            const r = await from.link.call("plugins.action", { ...params, cwd: from.cwd } as PluginActionParams);
            if (origin === from) setInfo(r);
            toast(r.message.split("\n")[0]!.replace(/^✔\s*/, ""), "success");
            done?.();
        } catch (e) {
            reportError(e);
        } finally {
            setBusy(undefined);
        }
    };
    const install = (pl: PluginInfo, scope: PluginScope = "user", done?: () => void) => act(`install:${pl.id}`, { action: "install", id: pl.id, scope }, done);

    const markets = () => info()?.marketplaces ?? [];
    const match = (p: PluginInfo) => {
        const q = query().trim().toLowerCase();
        return !q || `${p.name} ${p.description ?? ""} ${p.author ?? ""} ${p.marketplace} ${categoryOf(p.category).name}`.toLowerCase().includes(q);
    };
    const installed = createMemo(() => (info()?.plugins ?? []).filter((p) => p.installed || p.missing));
    const available = createMemo(() => (info()?.plugins ?? []).filter((p) => !p.installed && !p.missing));
    /** Discover's categories, in a stable order (most plugins first), each with what the search leaves in it. */
    const categories = createMemo(() => {
        const counts = new Map<string, number>();
        for (const p of available()) counts.set(categoryOf(p.category).name, (counts.get(categoryOf(p.category).name) ?? 0) + 1);
        return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([name]) => ({ name, hue: categoryOf(available().find((p) => categoryOf(p.category).name === name)?.category).hue, n: available().filter((p) => categoryOf(p.category).name === name && match(p)).length }));
    });
    const discovered = () => available().filter((p) => (!category() || categoryOf(p.category).name === category()) && match(p));
    const installedShown = () => installed().filter(match);
    const projectScopes = () => Boolean(info()?.cwd && info()?.trusted);
    const project = () => projectName(info()?.cwd);

    const show = (v: View) => {
        setView(v);
        setQuery("");
    };
    const addMarketplace = (src = source().trim()) => {
        if (!src) return sourceEl?.focus();
        void act(`market:add`, { action: "marketplaceAdd", source: src }, () => {
            setSource("");
            setView("discover");
        });
    };

    const busyRow = (pl: PluginInfo) => {
        const b = busy();
        return b === `update:${pl.id}` ? "Updating…" : b === `uninstall:${pl.id}` ? "Uninstalling…" : b === `toggle:${pl.id}` ? (pl.enabled ? "Turning off…" : "Turning on…") : undefined;
    };
    const showSearch = () => view() !== "marketplaces" && !loading() && Boolean(info());

    return (
        <div class="plugins">
            <ConfirmDialog open={Boolean(confirm())} onClose={() => setConfirm(undefined)} title={confirm()?.title ?? ""} confirmLabel={confirm()?.label ?? "OK"} onConfirm={() => confirm()?.run()}>
                {confirm()?.body}
            </ConfirmDialog>
            <Show when={details()} keyed>
                {(d) => <PluginDetails plugin={d.pl} markets={markets()} on={where() || windowMachine} project={project()} projectScopes={projectScopes()} busy={busy()} onClose={() => setDetails(undefined)} install={(scope) => install(d.pl, scope, () => details() === d && setDetails(undefined))} />}
            </Show>
            <Show when={servers().length || showSearch()}>
                <div class="plugins-bar">
                    <Show when={servers().length}>
                        <Segmented label="Machine" value={where()} onChange={pick} options={[{ value: "", label: os === "macos" ? "This Mac" : "This computer" }, ...servers().map((s) => ({ value: s, label: s }))]} />
                    </Show>
                    <span class="grow" />
                    <Show when={showSearch()}>
                        <label class="plugins-search">
                            <Search size={14} />
                            <input ref={searchEl} aria-label="Search plugins" placeholder="Search plugins" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} spellcheck={false} autocomplete="off" />
                            <Show when={query()}>
                                <button class="search-clear" aria-label="Clear search" onClick={() => (setQuery(""), searchEl?.focus())}>
                                    <X size={13} />
                                </button>
                            </Show>
                        </label>
                    </Show>
                </div>
            </Show>
            <div class="plugins-tabs">
                <Segmented
                    label="Show"
                    value={view()}
                    onChange={show}
                    options={[
                        { value: "installed", label: <>Installed<Show when={!loading() && info()}> {installed().length}</Show></> },
                        { value: "discover", label: <>Discover<Show when={!loading() && info()}> {available().length}</Show></> },
                        { value: "marketplaces", label: <>Marketplaces<Show when={!loading() && info()}> {markets().length}</Show></> },
                    ]}
                />
                <span class="grow" />
                <Show when={view() === "installed" && !loading() && installed().some((p) => p.installed && !p.orphaned)}>
                    <button class="btn btn-sm" disabled={Boolean(busy())} data-tip="Refresh marketplaces and fetch newer versions" onClick={() => void act("update:all", { action: "update" })}>
                        <RotateCw size={12} />
                        {busy() === "update:all" ? "Checking…" : "Check for updates"}
                    </button>
                </Show>
            </div>
            <Show when={!loading()} fallback={<div role="status"><Blank title="Reading your marketplaces…" /></div>}>
                <Switch>
                    {/* The list didn't come (the machine didn't answer): not an empty one, which would offer to add a marketplace there. */}
                    <Match when={!info()}>
                        <Blank title={where() || windowMachine ? `Couldn't load ${where() || windowMachine}'s plugins` : "Couldn't load plugins"}>
                            <button class="btn btn-sm" onClick={() => (setLoading(true), void load())}>
                                Try again
                            </button>
                        </Blank>
                    </Match>
                    <Match when={view() === "marketplaces"}>
                        <div class="paste">
                            <div class="paste-line">
                                <input class="input mono" ref={sourceEl} aria-label="Marketplace source" placeholder="owner/repo, git URL, folder or marketplace.json" value={source()} onInput={(e) => setSource(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && addMarketplace()} spellcheck={false} autocomplete="off" />
                                <button class="btn" disabled={!source().trim() || Boolean(busy())} onClick={() => addMarketplace()}>
                                    {busy() === "market:add" && source().trim() ? "Adding…" : "Add marketplace"}
                                </button>
                            </div>
                        </div>
                        <Show
                            when={markets().length}
                            fallback={
                                <Blank title="No marketplaces yet">
                                    <p class="plugins-blank-sub">Add one above, or start with Anthropic's official catalog.</p>
                                    <button class="btn btn-sm" disabled={Boolean(busy())} onClick={() => addMarketplace(SUGGESTED)}>
                                        {busy() === "market:add" ? "Adding…" : `Add ${SUGGESTED}`}
                                    </button>
                                </Blank>
                            }
                        >
                            <div class="card plugins-card">
                                <For each={markets()}>{(m) => <MarketRow m={m} busy={busy()} act={act} installed={installed()} confirm={setConfirm} />}</For>
                            </div>
                        </Show>
                    </Match>
                    <Match when={view() === "discover"}>
                        <Show
                            when={markets().length}
                            fallback={
                                <Blank title="No marketplaces yet">
                                    <p class="plugins-blank-sub">A marketplace is a catalog of plugins.</p>
                                    <span class="plugins-blank-actions">
                                        <button class="btn btn-sm" disabled={Boolean(busy())} onClick={() => addMarketplace(SUGGESTED)}>
                                            {busy() === "market:add" ? "Adding…" : "Add Anthropic’s marketplace"}
                                        </button>
                                        <button class="btn btn-ghost btn-sm" onClick={() => show("marketplaces")}>
                                            Add another
                                        </button>
                                    </span>
                                </Blank>
                            }
                        >
                            <Show when={available().length} fallback={<Blank title="Everything here is installed" />}>
                                <Show when={categories().length > 1}>
                                    <div class="chips" role="radiogroup" aria-label="Category">
                                        <button class="chip" role="radio" aria-checked={!category()} onClick={() => setCategory(undefined)}>
                                            All <span class="chip-n num">{available().filter(match).length}</span>
                                        </button>
                                        <For each={categories().filter((c) => c.n || c.name === category())}>
                                            {(c) => (
                                                <button class="chip" role="radio" aria-checked={category() === c.name} onClick={() => setCategory(category() === c.name ? undefined : c.name)}>
                                                    {c.name} <span class="chip-n num">{c.n}</span>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                                <Show
                                    when={discovered().length}
                                    fallback={
                                        <Blank title={query().trim() ? `No plugins match “${query().trim()}”.` : `Nothing in ${category()}`}>
                                            <Show when={category()}>
                                                <button class="btn btn-sm" onClick={() => setCategory(undefined)}>
                                                    Search all categories
                                                </button>
                                            </Show>
                                        </Blank>
                                    }
                                >
                                    <div class="plugin-grid">
                                        <For each={discovered()}>{(pl) => <PluginCard plugin={pl} markets={markets()} busy={busy()} open={() => setDetails({ pl })} install={() => void install(pl)} />}</For>
                                    </div>
                                </Show>
                                <p class="plugins-foot">Plugins can run commands on {where() || "this computer"}, so install only from people you trust.</p>
                            </Show>
                        </Show>
                    </Match>
                    <Match when={!installed().length}>
                        <Blank title="No plugins installed">
                            <Show
                                when={available().length}
                                fallback={
                                    <button class="btn btn-sm" onClick={() => show("marketplaces")}>
                                        Add a marketplace
                                    </button>
                                }
                            >
                                <button class="btn btn-sm" onClick={() => show("discover")}>
                                    Discover plugins
                                </button>
                            </Show>
                        </Blank>
                    </Match>
                    <Match when={!installedShown().length}>
                        <Blank title={`No plugins match “${query().trim()}”.`} />
                    </Match>
                    <Match when={true}>
                        <div class="card plugins-card">
                            <For each={installedShown()}>{(pl) => <PluginRow plugin={pl} markets={markets()} busy={busy()} working={busyRow(pl)} act={act} confirm={setConfirm} details={() => setDetails({ pl })} sameName={installed().some((x) => x !== pl && x.name === pl.name)} />}</For>
                        </div>
                        <p class="plugins-foot">
                            <Show when={info()?.cwd} fallback="Open a project to turn plugins on for just that project.">
                                On and off apply to {project()}
                                <Show when={!info()?.trusted}> (not trusted yet)</Show>
                            </Show>
                        </p>
                    </Match>
                </Switch>
            </Show>
        </div>
    );
}

/** A plugin in Discover: its mark and name open its details; Install installs it for you, everywhere. */
function PluginCard(p: { plugin: PluginInfo; markets: PluginMarketplaceInfo[]; busy?: string; open: () => void; install: () => void }) {
    const pl = () => p.plugin;
    const cat = () => categoryOf(pl().category);
    const installing = () => p.busy === `install:${pl().id}`;
    return (
        <article class="card plugin-card">
            <button class="plugin-card-main" aria-label={`${pl().name}, ${cat().name}. Details`} onClick={p.open}>
                <PluginMark plugin={pl()} markets={p.markets} />
                <span class="row-text">
                    <span class="row-title mono">{pl().name}</span>
                    <span class="row-sub">{pl().author ?? pl().marketplace}</span>
                </span>
            </button>
            <p class="plugin-summary">{pl().description ?? "No description."}</p>
            <div class="plugin-card-foot">
                <span class="row-sub">{cat().name}</span>
                <Show
                    when={!installing()}
                    fallback={
                        <span class="prow-busy">
                            <Spinner size={13} />
                            Installing…
                        </span>
                    }
                >
                    <button class="btn btn-sm" disabled={Boolean(p.busy)} data-tip="Install for you, in every project" aria-label={`Install ${pl().name}`} onClick={() => p.install()}>
                        Install
                    </button>
                </Show>
            </div>
        </article>
    );
}

/** A plugin's details: its full summary, who makes it, and where to install it. */
function PluginDetails(p: { plugin: PluginInfo; markets: PluginMarketplaceInfo[]; on?: string; project?: string; projectScopes: boolean; busy?: string; onClose: () => void; install: (scope: PluginScope) => Promise<void> }) {
    const [scope, setScope] = createSignal<PluginScope>("user");
    const pl = p.plugin;
    const cat = categoryOf(pl.category);
    const scopes = () => (p.projectScopes ? SCOPES : SCOPES.filter((s) => s.value === "user"));
    const installing = () => p.busy === `install:${pl.id}`;
    let group: HTMLDivElement | undefined;
    const move = (e: KeyboardEvent) => {
        const keys = ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"];
        if (!keys.includes(e.key)) return;
        e.preventDefault();
        const list = scopes();
        const i = list.findIndex((s) => s.value === scope());
        const next = list[(i + (keys.indexOf(e.key) < 2 ? 1 : -1) + list.length) % list.length]!;
        setScope(next.value);
        group?.querySelector<HTMLElement>(`[data-scope="${next.value}"]`)?.focus();
    };
    return (
        <Dialog
            open
            onClose={p.onClose}
            title={`Install ${pl.name}?`}
            subtitle={[pl.author, pl.version].filter(Boolean).join(" · ") || pl.marketplace}
            icon={<PluginMark plugin={pl} markets={p.markets} />}
            width={440}
            class="plugin-dlg"
            footer={
                <>
                    <button class="btn" onClick={p.onClose}>
                        Cancel
                    </button>
                    <button class="btn btn-primary" disabled={Boolean(p.busy)} onClick={() => void p.install(scope())}>
                        {installing() ? "Installing…" : `Install ${SCOPE_DONE[scope()]}`}
                    </button>
                </>
            }
        >
            <Show when={pl.description}>
                <p class="dlg-text">{pl.description}</p>
            </Show>
            <p class="dlg-text dim plugin-facts">
                {cat.name} · {pl.marketplace}
                <Show when={pl.homepage}>
                    {(url) => (
                        <>
                            {" · "}
                            <a class="link-btn" href={url()} onClick={(e) => (e.preventDefault(), void openExternal(url()))}>
                                Homepage
                            </a>
                        </>
                    )}
                </Show>
            </p>
            <div class="option-list" role="radiogroup" aria-label="Install for" ref={group} onKeyDown={move}>
                <For each={scopes()}>
                    {(s) => (
                        <button class="option" data-scope={s.value} role="radio" aria-checked={scope() === s.value} tabIndex={scope() === s.value ? 0 : -1} onClick={() => setScope(s.value)}>
                            <span class="radio-dot" />
                            <span class="option-text">
                                <span class="option-title">{s.label}</span>
                                <span class="option-sub">{s.title(p.project)}</span>
                            </span>
                        </button>
                    )}
                </For>
            </div>
            <Show when={!p.projectScopes}>
                <p class="dlg-text dim">{p.project ? `Trust ${p.project} to install for just that project.` : "Open a project to install for just that project."}</p>
            </Show>
            <div class="note" data-tone="amber">
                <Shield size={14} />
                <span class="note-body">It can run commands on {p.on || "this computer"}.</span>
            </div>
        </Dialog>
    );
}

/** Where an installed plugin is on: "On for you everywhere", "Off here". */
function whereText(pl: PluginInfo): string {
    if (!pl.enabled) return "Off here";
    const on = (["local", "project", "user"] as const).find((s) => pl.scopes[s]);
    return on === "local" ? "On just for you here" : on === "project" ? "On for everyone in this project" : "On for you everywhere";
}

/** What uninstalling takes it out of: the settings it's set in (as the server removes it: every scope that names it, on or off). */
function uninstallText(pl: PluginInfo): string {
    const here = pl.scopes.project !== undefined || pl.scopes.local !== undefined;
    return here && pl.scopes.user !== undefined ? "It's removed from this project and from your own settings." : here ? "It's removed from this project." : "It's removed from your own settings.";
}

function PluginRow(p: { plugin: PluginInfo; markets: PluginMarketplaceInfo[]; busy?: string; working?: string; act: Act; confirm: (c: Confirm) => void; details: () => void; sameName?: boolean }) {
    let more: HTMLButtonElement | undefined;
    const [menu, setMenu] = createSignal(false);
    const pl = () => p.plugin;
    const key = (a: string) => `${a}:${pl().id}`;
    const choose = (run: () => void) => {
        setMenu(false);
        run();
    };
    return (
        <div class="row plugin-row">
            <PluginMark plugin={pl()} markets={p.markets} />
            <div class="row-text">
                <span class="prow-name">
                    <span class="row-title mono" data-tip={`${pl().name}, from ${pl().marketplace}`}>{pl().name}</span>
                    <Show when={pl().installed?.version ?? pl().version}>{(v) => <span class="plugin-version num">{v()}</span>}</Show>
                    <Show when={p.sameName}>
                        <span class="tag">{pl().marketplace}</span>
                    </Show>
                    <Show when={pl().missing}>
                        <span class="tag" data-tone="amber">Not installed</span>
                    </Show>
                    <Show when={pl().orphaned}>
                        <span class="tag" data-tip="Its marketplace doesn't list it any more">no longer listed</span>
                    </Show>
                    <Show when={pl().errors.length}>
                        <span class="tag" data-tone="red" data-tip={pl().errors.join("\n")}>
                            {plural(pl().errors.length, "problem")}
                        </span>
                    </Show>
                </span>
                <Show when={pl().installed} fallback={<span class="row-sub">Turned on in settings, but not installed on this computer.</span>}>
                    {(i) => (
                        <span class="row-sub">
                            {countsText(i().counts) || "Nothing loads from it"} · {whereText(pl())}
                        </span>
                    )}
                </Show>
                <For each={pl().errors.slice(0, 3)}>{(e) => <span class="row-sub plugin-problem">{e}</span>}</For>
            </div>
            <Show
                when={!p.working}
                fallback={
                    <span class="prow-busy">
                        <Spinner size={13} />
                        {p.working}
                    </span>
                }
            >
                <Show
                    when={pl().installed}
                    fallback={
                        <button class="btn btn-sm" disabled={Boolean(p.busy)} onClick={p.details}>
                            Install…
                        </button>
                    }
                >
                    <Toggle label={`${pl().name} on${pl().enabled ? "" : " (off now)"}`} checked={pl().enabled} onChange={(on) => void p.act(key("toggle"), { action: on ? "enable" : "disable", id: pl().id })} />
                </Show>
            </Show>
            <button ref={more} class="icon-btn icon-btn-sm" aria-label={`More for ${pl().name}`} aria-haspopup="menu" aria-expanded={menu()} data-state={menu() ? "open" : undefined} onClick={() => setMenu(!menu())}>
                <Ellipsis size={14} />
            </button>
            <Menu open={menu()} anchor={() => more} onClose={() => setMenu(false)} label={`${pl().name} (${pl().marketplace}) actions`} width={200} align="end">
                <Show when={pl().installed && !pl().orphaned}>
                    <button class="menu-item" role="menuitem" disabled={Boolean(p.busy)} onClick={() => choose(() => void p.act(key("update"), { action: "update", id: pl().id }))}>
                        <RefreshCw size={14} /> Update
                    </button>
                </Show>
                <Show when={pl().homepage}>
                    {(url) => (
                        <button class="menu-item" role="menuitem" onClick={() => choose(() => void openExternal(url()))}>
                            <ExternalLink size={14} /> Homepage
                        </button>
                    )}
                </Show>
                <Show when={pl().installed && (!pl().orphaned || pl().homepage)}>
                    <div class="menu-sep" role="separator" />
                </Show>
                <button
                    class="menu-item danger"
                    role="menuitem"
                    data-danger=""
                    disabled={Boolean(p.busy)}
                    onClick={() =>
                        choose(() =>
                            p.confirm({
                                title: `Uninstall ${pl().name}?`,
                                body: uninstallText(pl()),
                                label: "Uninstall",
                                run: () => p.act(key("uninstall"), { action: "uninstall", id: pl().id }),
                            }),
                        )
                    }
                >
                    <Trash2 size={14} /> Uninstall
                </button>
            </Menu>
        </div>
    );
}

function MarketRow(p: { m: PluginMarketplaceInfo; busy?: string; act: Act; installed: PluginInfo[]; confirm: (c: Confirm) => void }) {
    const m = () => p.m;
    const local = () => m().kind === "directory" || m().kind === "file";
    const updated = () => (m().lastUpdated ? Date.parse(m().lastUpdated!) : NaN);
    return (
        <div class="row plugin-row">
            <div class="row-text">
                <Show when={m().error} fallback={<span class="row-title mono">{m().name}</span>}>
                    <span class="prow-name">
                        <span class="row-title mono">{m().name}</span>
                        <span class="tag" data-tone="red">Can't read</span>
                    </span>
                </Show>
                <span class="row-sub">
                    <span class="mono">{local() ? tildify(m().source) : m().source}</span> · {plural(m().plugins, "plugin")}
                    <Show when={!Number.isNaN(updated())}> · updated {ago(updated()) === "now" ? "just now" : `${ago(updated())} ago`}</Show>
                </span>
                <Show when={m().description}>
                    <span class="row-sub">{m().description}</span>
                </Show>
                <Show when={m().error}>
                    <span class="row-sub plugin-problem">{m().error}</span>
                </Show>
                <For each={m().warnings.slice(0, 3)}>{(w) => <span class="row-sub plugin-warning">{w}</span>}</For>
            </div>
            <Show
                when={p.busy !== `market:update:${m().name}`}
                fallback={
                    <span class="prow-busy">
                        <Spinner size={13} />
                        Updating…
                    </span>
                }
            >
                <button class="icon-btn icon-btn-sm" disabled={Boolean(p.busy)} data-tip={local() ? "Read again" : "Fetch the latest catalog"} aria-label={`Update ${m().name}`} onClick={() => void p.act(`market:update:${m().name}`, { action: "marketplaceUpdate", name: m().name })}>
                    <RotateCw size={13} />
                </button>
            </Show>
            <button
                class="icon-btn icon-btn-sm"
                disabled={Boolean(p.busy)}
                data-tip="Remove"
                aria-label={`Remove ${m().name}`}
                onClick={() => {
                    const from = p.installed.filter((pl) => pl.marketplace === m().name && pl.installed);
                    p.confirm({
                        title: `Remove ${m().name}?`,
                        body: from.length ? `This also uninstalls ${from.map((pl) => pl.name).join(", ")}.` : "Its plugins won't be offered any more.",
                        label: "Remove",
                        run: () => p.act(`market:remove:${m().name}`, { action: "marketplaceRemove", name: m().name }),
                    });
                }}
            >
                <X size={13} />
            </button>
        </div>
    );
}
