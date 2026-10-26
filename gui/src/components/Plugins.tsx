// Settings → Plugins. Discover is a catalog to scan: category filters, then cards (a mark, name and maker,
// two lines of summary, one Install); a card opens the plugin's details, where the install scope is picked.
// Installed is a list to manage: on/off for the current project, what loads, problems, and a ⋯ menu.
// Marketplaces is where catalogs are added. Every change goes through the server, which reloads each open
// folder's settings, commands and MCP servers.

import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { Activity, Briefcase, CodeXml, Database, Download, Ellipsis, ExternalLink, FlaskConical, Folder, GraduationCap, Info, Palette, Puzzle, RefreshCw, Rocket, Search, Shield, Store, Trash2, X } from "lucide-solid";
import type { PluginActionParams, PluginInfo, PluginMarketplaceInfo, PluginScope, PluginsInfo } from "@shared/protocol";
import { app, reportError, rpc, toast } from "../state/app";
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
    { value: "project", label: "This project", title: (p) => `Shared with everyone in ${p ?? "the project"} (.cavvy/settings.json)` },
    { value: "local", label: "Just me, here", title: (p) => `Only you, only in ${p ?? "this project"} (.cavvy/settings.local.json)` },
];
const SCOPE_DONE: Record<PluginScope, string> = { user: "for you", project: "for this project", local: "for you, here" };

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

/** A plugin's mark: its maker's logo when it has one, else its category's icon on the category's tint. */
function PluginMark(p: { plugin: PluginInfo; markets: PluginMarketplaceInfo[]; size: number }) {
    const cat = () => categoryOf(p.plugin.category);
    const [logo, setLogo] = createSignal<string>();
    const owner = logoOwner(p.plugin, p.markets);
    if (owner) void logoFor(owner).then(setLogo);
    const Icon = ICONS[cat().icon];
    return (
        <span class={`pg-mark ${logo() ? "logo" : ""}`} style={{ "--h": cat().hue, width: `calc(${p.size} * var(--sp))`, height: `calc(${p.size} * var(--sp))` }} aria-hidden="true">
            <Show when={logo()} fallback={<Icon size={Math.round(p.size * 0.5)} stroke-width={1.75} />}>
                {(src) => <img src={src()} alt="" />}
            </Show>
        </span>
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
    const cwd = () => app.homeCwd;
    let searchEl: HTMLInputElement | undefined;
    let sourceEl: HTMLInputElement | undefined;

    const load = async () => {
        try {
            setInfo(await rpc.call("plugins.list", { cwd: cwd() }));
        } catch (e) {
            reportError(e);
        } finally {
            setLoading(false);
        }
    };
    onMount(() => {
        void load().then(() => {
            const i = info();
            // First visit with nothing installed: show what there is to install.
            if (i && !i.plugins.some((p) => p.installed || p.missing)) setView(i.marketplaces.length ? "discover" : "marketplaces");
        });
    });

    const act: Act = async (key, params, done) => {
        if (busy()) return;
        setBusy(key);
        try {
            const r = await rpc.call("plugins.action", { ...params, cwd: cwd() } as PluginActionParams);
            setInfo(r);
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

    const empty = (icon: typeof Puzzle, title: string, body?: string, actions?: () => any) => {
        const Icon = icon;
        return (
            <div class="pg-empty">
                <span class="pg-eic">
                    <Icon size={20} />
                </span>
                <b>{title}</b>
                <Show when={body}>
                    <p>{body}</p>
                </Show>
                <Show when={actions}>
                    <div class="pg-eact">{actions!()}</div>
                </Show>
            </div>
        );
    };

    return (
        <div class="plg">
            <ConfirmDialog open={Boolean(confirm())} onClose={() => setConfirm(undefined)} title={confirm()?.title ?? ""} confirmLabel={confirm()?.label ?? "OK"} onConfirm={() => confirm()?.run()}>
                {confirm()?.body}
            </ConfirmDialog>
            <Show when={details()} keyed>
                {(d) => <PluginDetails plugin={d.pl} markets={markets()} project={project()} projectScopes={projectScopes()} busy={busy()} onClose={() => setDetails(undefined)} install={(scope) => install(d.pl, scope, () => details() === d && setDetails(undefined))} />}
            </Show>
            <div class="pg-bar">
                <Segmented
                    label="Show"
                    size="sm"
                    value={view()}
                    onChange={show}
                    options={[
                        { value: "installed", label: <>Installed <Show when={!loading()}><span class="plg-n">{installed().length}</span></Show></> },
                        { value: "discover", label: <>Discover <Show when={!loading()}><span class="plg-n">{available().length}</span></Show></> },
                        { value: "marketplaces", label: <>Marketplaces <Show when={!loading()}><span class="plg-n">{markets().length}</span></Show></> },
                    ]}
                />
                <span class="grow" />
                <Show when={view() !== "marketplaces" && !loading()}>
                    <label class="pg-search">
                        <Search size={14} />
                        <input ref={searchEl} aria-label="Search plugins" placeholder={view() === "installed" ? "Search installed plugins" : `Search ${plural(available().length, "plugin")}`} value={query()} onInput={(e) => setQuery(e.currentTarget.value)} spellcheck={false} autocomplete="off" />
                        <Show when={query()}>
                            <button class="hb sm" title="Clear" aria-label="Clear search" onClick={() => (setQuery(""), searchEl?.focus())}>
                                <X size={13} />
                            </button>
                        </Show>
                    </label>
                </Show>
            </div>
            <Show when={!loading()} fallback={<div class="pg-load" role="status"><Spinner size={14} /> Reading your marketplaces…</div>}>
                <Switch>
                    <Match when={view() === "marketplaces"}>
                        <div class="pg-add">
                            <label>
                                <Store size={15} />
                                <input ref={sourceEl} aria-label="Marketplace source" placeholder="owner/repo, git URL, folder or marketplace.json" value={source()} onInput={(e) => setSource(e.currentTarget.value)} onKeyDown={(e) => e.key === "Enter" && addMarketplace()} spellcheck={false} autocomplete="off" />
                            </label>
                            <button class="btn primary sm" disabled={!source().trim() || Boolean(busy())} onClick={() => addMarketplace()}>
                                {busy() === "market:add" && source().trim() ? <Spinner size={12} /> : "Add marketplace"}
                            </button>
                        </div>
                        <Show
                            when={markets().length}
                            fallback={empty(Store, "No marketplaces yet", "Paste a GitHub repo, a git URL or a folder above, or start with Anthropic's official catalog.", () => (
                                <button class="btn secondary sm" disabled={Boolean(busy())} onClick={() => addMarketplace(SUGGESTED)}>
                                    {busy() === "market:add" ? <Spinner size={12} /> : `Add ${SUGGESTED}`}
                                </button>
                            ))}
                        >
                            <div class="set-h pg-h">Added</div>
                            <div class="pg-list">
                                <For each={markets()}>{(m) => <MarketRow m={m} busy={busy()} act={act} installed={installed()} confirm={setConfirm} />}</For>
                            </div>
                            <p class="set-note">Claude Code plugins and marketplaces work as they are, and the ones you added in Claude Code show up here.</p>
                        </Show>
                    </Match>
                    <Match when={view() === "discover"}>
                        <Show
                            when={markets().length}
                            fallback={empty(Store, "No marketplaces yet", "A marketplace is a catalog of plugins. Anthropic's official one is a good place to start.", () => (
                                <>
                                    <button class="btn primary sm" disabled={Boolean(busy())} onClick={() => addMarketplace(SUGGESTED)}>
                                        {busy() === "market:add" ? <Spinner size={12} /> : "Add Anthropic's marketplace"}
                                    </button>
                                    <button class="btn ghost sm" onClick={() => show("marketplaces")}>
                                        Add another
                                    </button>
                                </>
                            ))}
                        >
                            <Show when={available().length} fallback={empty(Puzzle, "Everything is installed", "Every plugin your marketplaces offer is installed.")}>
                                <Show when={categories().length > 1}>
                                    <div class="pg-cats" role="group" aria-label="Category">
                                        <button class={!category() ? "on" : ""} aria-pressed={!category()} onClick={() => setCategory(undefined)}>
                                            All<span>{available().filter(match).length}</span>
                                        </button>
                                        <For each={categories().filter((c) => c.n || c.name === category())}>
                                            {(c) => (
                                                <button class={category() === c.name ? "on" : ""} aria-pressed={category() === c.name} onClick={() => setCategory(category() === c.name ? undefined : c.name)}>
                                                    <i style={{ "--h": c.hue }} />
                                                    {c.name}
                                                    <span>{c.n}</span>
                                                </button>
                                            )}
                                        </For>
                                    </div>
                                </Show>
                                <Show
                                    when={discovered().length}
                                    fallback={empty(Search, query().trim() ? `No plugins match “${query().trim()}”` : `Nothing in ${category()}`, category() ? `Nothing in ${category()}. Try all categories.` : "Try a shorter word, or a category.", category() ? () => (
                                        <button class="btn ghost sm" onClick={() => setCategory(undefined)}>
                                            Search all categories
                                        </button>
                                    ) : undefined)}
                                >
                                    <div class="pg-grid">
                                        <For each={discovered()}>{(pl) => <PluginCard plugin={pl} markets={markets()} busy={busy()} open={() => setDetails({ pl })} install={() => void install(pl)} />}</For>
                                    </div>
                                </Show>
                                <p class="set-note pg-note">Plugins can add commands, agents, skills, hooks and MCP servers. Hooks and MCP servers run commands on this computer, so install from people you trust.</p>
                            </Show>
                        </Show>
                    </Match>
                    <Match when={!installed().length}>
                        {available().length
                            ? empty(Puzzle, "No plugins installed", `${plural(available().length, "plugin")} ${available().length === 1 ? "is" : "are"} ready to install in Discover.`, () => (
                                  <button class="btn primary sm" onClick={() => show("discover")}>
                                      Browse plugins
                                  </button>
                              ))
                            : empty(Puzzle, "No plugins installed", "Add a marketplace to find plugins to install.", () => (
                                  <button class="btn primary sm" onClick={() => show("marketplaces")}>
                                      Add a marketplace
                                  </button>
                              ))}
                    </Match>
                    <Match when={!installedShown().length}>{empty(Search, `No installed plugins match “${query().trim()}”`)}</Match>
                    <Match when={true}>
                        <p class="pg-scope">
                            <Folder size={14} />
                            <Show when={info()?.cwd} fallback={<span>Open a project to turn plugins on for just that project.</span>}>
                                <span>
                                    On and off apply to <b>{project()}</b>
                                    <Show when={!info()?.trusted}> (not trusted yet, so only your own settings count there)</Show>.
                                </span>
                            </Show>
                        </p>
                        <div class="pg-list">
                            <For each={installedShown()}>{(pl) => <PluginRow plugin={pl} markets={markets()} busy={busy()} act={act} confirm={setConfirm} details={() => setDetails({ pl })} sameName={installed().some((x) => x !== pl && x.name === pl.name)} />}</For>
                        </div>
                        <Show when={installed().some((p) => p.installed && !p.orphaned)}>
                            <div class="pg-after">
                                <button class="btn ghost sm" disabled={Boolean(busy())} title="Refresh marketplaces and fetch newer versions" onClick={() => void act("update:all", { action: "update" })}>
                                    {busy() === "update:all" ? <Spinner size={12} /> : <RefreshCw size={13} />} Check for updates
                                </button>
                            </div>
                        </Show>
                    </Match>
                </Switch>
            </Show>
        </div>
    );
}

/** A plugin in Discover: the whole card opens its details; Install installs it for you, everywhere. */
function PluginCard(p: { plugin: PluginInfo; markets: PluginMarketplaceInfo[]; busy?: string; open: () => void; install: () => void }) {
    const pl = () => p.plugin;
    const cat = () => categoryOf(pl().category);
    const installing = () => p.busy === `install:${pl().id}`;
    return (
        // Not a button holding a button: the name opens the details, and its hit area covers the card (CSS).
        <article class="pg-card">
            <div class="pg-top">
                <PluginMark plugin={pl()} markets={p.markets} size={36} />
                <div class="pg-id">
                    <button class="pg-open" aria-label={`${pl().name}, ${cat().name}. Details`} onClick={p.open}>
                        {pl().name}
                    </button>
                    <span>{pl().author ?? pl().marketplace}</span>
                </div>
            </div>
            <p>{pl().description ?? "No description."}</p>
            <div class="pg-foot">
                <span class="pg-cat">
                    <i style={{ "--h": cat().hue }} />
                    {cat().name}
                </span>
                <button
                    class="btn ghost sm pg-install"
                    disabled={Boolean(p.busy)}
                    title="Install for you, in every project. Hooks and MCP servers in a plugin run commands on this computer."
                    aria-label={`Install ${pl().name}`}
                    onClick={() => p.install()}
                >
                    {installing() ? <Spinner size={12} /> : <Download size={13} />}
                    {installing() ? "Installing" : "Install"}
                </button>
            </div>
        </article>
    );
}

/** A plugin's details: its full summary, who makes it, and where to install it. */
function PluginDetails(p: { plugin: PluginInfo; markets: PluginMarketplaceInfo[]; project?: string; projectScopes: boolean; busy?: string; onClose: () => void; install: (scope: PluginScope) => Promise<void> }) {
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
        <Dialog open onClose={p.onClose} bare labelledBy="pg-dlg-title" width={480} class="pg-dlg">
            <div class="pg-top">
                <PluginMark plugin={pl} markets={p.markets} size={48} />
                <div class="pg-id">
                    <h3 id="pg-dlg-title">{pl.name}</h3>
                    <span>{[pl.author, pl.version ? `version ${pl.version}` : undefined].filter(Boolean).join(", ") || pl.marketplace}</span>
                </div>
            </div>
            <Show when={pl.description}>
                <p class="pg-full">{pl.description}</p>
            </Show>
            <div class="pg-facts">
                <span>
                    <i style={{ "--h": cat.hue }} />
                    {cat.name}
                </span>
                <span>
                    <Store size={13} />
                    {pl.marketplace}
                </span>
                <Show when={pl.homepage}>
                    {(url) => (
                        <a href={url()} onClick={(e) => (e.preventDefault(), void openExternal(url()))}>
                            <ExternalLink size={13} />
                            Homepage
                        </a>
                    )}
                </Show>
            </div>
            <div class="pg-sh" id="pg-scope-label">
                Install for
            </div>
            <div class="pg-scs" role="radiogroup" aria-labelledby="pg-scope-label" ref={group} onKeyDown={move}>
                <For each={scopes()}>
                    {(s) => (
                        <button class={`pg-sc ${scope() === s.value ? "on" : ""}`} data-scope={s.value} role="radio" aria-checked={scope() === s.value} tabIndex={scope() === s.value ? 0 : -1} onClick={() => setScope(s.value)}>
                            <span class="rd" />
                            <span>
                                <b>{s.label}</b>
                                <span>{s.title(p.project)}</span>
                            </span>
                        </button>
                    )}
                </For>
            </div>
            <Show when={!p.projectScopes}>
                <p class="pg-sub">{p.project ? `${p.project} isn't trusted yet, so plugins install for you only.` : "Open a project to install a plugin for just that project."}</p>
            </Show>
            <p class="pg-warn">
                <Info size={13} />
                Its hooks and MCP servers can run commands on this computer.
            </p>
            <div class="dialog-actions">
                <span class="grow" />
                <button class="btn ghost" onClick={p.onClose}>
                    Cancel
                </button>
                <button class="btn primary" disabled={Boolean(p.busy)} onClick={() => void p.install(scope())}>
                    {installing() ? <Spinner size={13} /> : <Download size={14} />}
                    {installing() ? "Installing" : `Install ${SCOPE_DONE[scope()]}`}
                </button>
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

function PluginRow(p: { plugin: PluginInfo; markets: PluginMarketplaceInfo[]; busy?: string; act: Act; confirm: (c: Confirm) => void; details: () => void; sameName?: boolean }) {
    let more: HTMLButtonElement | undefined;
    const [menu, setMenu] = createSignal(false);
    const pl = () => p.plugin;
    const key = (a: string) => `${a}:${pl().id}`;
    const choose = (run: () => void) => {
        setMenu(false);
        run();
    };
    return (
        <div class={`pg-row ${pl().installed && !pl().enabled ? "off" : ""}`}>
            <PluginMark plugin={pl()} markets={p.markets} size={32} />
            <div class="pg-rmain">
                <div class="pg-rname">
                    <b class="truncate" title={`${pl().name}, from ${pl().marketplace}`}>{pl().name}</b>
                    <Show when={pl().installed?.version ?? pl().version}>{(v) => <span class="pg-ver">{v()}</span>}</Show>
                    <Show when={p.sameName}>
                        <span class="pg-ver">{pl().marketplace}</span>
                    </Show>
                    <Show when={pl().missing}>
                        <span class="pg-prob">Not installed</span>
                    </Show>
                    <Show when={pl().orphaned}>
                        <span class="pg-ver" title="Its marketplace doesn't list it any more">no longer listed</span>
                    </Show>
                    <Show when={pl().errors.length}>
                        <span class="pg-prob" title={pl().errors.join("\n")}>
                            <Info size={12} />
                            {plural(pl().errors.length, "problem")}
                        </span>
                    </Show>
                </div>
                <Show when={pl().installed} fallback={<div class="pg-rmeta">Turned on in settings, but not installed on this computer.</div>}>
                    {(i) => (
                        <div class="pg-rmeta">
                            {countsText(i().counts) || "Nothing loads from it"}. {whereText(pl())}.
                        </div>
                    )}
                </Show>
                <For each={pl().errors.slice(0, 3)}>{(e) => <div class="pg-rprob">{e}</div>}</For>
            </div>
            <Show
                when={pl().installed}
                fallback={
                    <button class="btn secondary sm" disabled={Boolean(p.busy)} onClick={p.details}>
                        <Download size={13} /> Install…
                    </button>
                }
            >
                <Toggle label={`${pl().name} on${pl().enabled ? "" : " (off now)"}`} checked={pl().enabled} onChange={(on) => void p.act(key("toggle"), { action: on ? "enable" : "disable", id: pl().id })} />
            </Show>
            <button ref={more} class="hb sm" aria-label={`More for ${pl().name}`} title="More" aria-haspopup="menu" aria-expanded={menu()} onClick={() => setMenu(!menu())}>
                {p.busy === key("update") || p.busy === key("uninstall") ? <Spinner size={12} /> : <Ellipsis size={16} />}
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
                    disabled={Boolean(p.busy)}
                    onClick={() =>
                        choose(() =>
                            p.confirm({
                                title: `Uninstall ${pl().name}?`,
                                body: `${pl().name} from ${pl().marketplace} is removed from every scope in this project and your own settings. Its commands, agents, hooks and MCP servers stop loading.`,
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
        <div class="pg-row">
            <span class="pg-mark mk" aria-hidden="true">
                <Store size={16} />
            </span>
            <div class="pg-rmain">
                <div class="pg-rname">
                    <b class="truncate">{m().name}</b>
                    <span class="pg-ver">{plural(m().plugins, "plugin")}</span>
                    <Show when={m().error}>
                        <span class="pg-prob err">Can't read</span>
                    </Show>
                </div>
                <div class="pg-rmeta">
                    <code>{local() ? tildify(m().source) : m().source}</code>
                    <Show when={!Number.isNaN(updated())}>, updated {ago(updated()) === "now" ? "just now" : `${ago(updated())} ago`}</Show>
                </div>
                <Show when={m().description}>
                    <div class="pg-rmeta">{m().description}</div>
                </Show>
                <Show when={m().error}>
                    <div class="pg-rprob err">{m().error}</div>
                </Show>
                <For each={m().warnings.slice(0, 3)}>{(w) => <div class="pg-rprob">{w}</div>}</For>
            </div>
            <button class="hb sm" disabled={Boolean(p.busy)} title={local() ? "Read again" : "Fetch the latest catalog"} aria-label={`Update ${m().name}`} onClick={() => void p.act(`market:update:${m().name}`, { action: "marketplaceUpdate", name: m().name })}>
                {p.busy === `market:update:${m().name}` ? <Spinner size={12} /> : <RefreshCw size={15} />}
            </button>
            <button
                class="hb sm"
                disabled={Boolean(p.busy)}
                title="Remove"
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
                <X size={15} />
            </button>
        </div>
    );
}
