// Settings → Plugins: installed plugins (on/off for the current project,
// update, uninstall), what the marketplaces offer (install at a scope), and
// the marketplaces themselves. Every change goes through the server, which
// reloads each open folder's settings, commands and MCP servers.

import { createMemo, createSignal, For, Match, onMount, Show, Switch } from "solid-js";
import { Download, Puzzle, RefreshCw, Search, Store, Trash2, TriangleAlert } from "lucide-solid";
import type { PluginActionParams, PluginInfo, PluginScope, PluginsInfo } from "@shared/protocol";
import { app, reportError, rpc, toast } from "../state/app";
import { tildify } from "../lib/format";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { Segmented, Spinner, Toggle } from "./ui/bits";

/** Offered when no marketplace is added yet. */
const SUGGESTED = "anthropics/claude-plugins-official";

type View = "installed" | "discover" | "marketplaces";

const SCOPES: { value: PluginScope; label: string; title: string }[] = [
    { value: "user", label: "For me", title: "On in every folder, for you" },
    { value: "project", label: "This project", title: "Shared with everyone in the project (.harness/settings.json)" },
    { value: "local", label: "Me, here", title: "Just you, in this project (.harness/settings.local.json)" },
];

export function countsText(c: NonNullable<PluginInfo["installed"]>["counts"]): string {
    const parts: string[] = [];
    const add = (n: number, one: string) => n && parts.push(`${n} ${one}${n === 1 ? "" : "s"}`);
    add(c.commands, "command");
    add(c.agents, "agent");
    add(c.skills, "skill");
    add(c.hooks, "hook");
    add(c.mcpServers, "MCP server");
    add(c.lspServers, "language server");
    // Language servers are counted, but only Claude Code runs them (it loads the plugin itself).
    const pending = c.lspServers ? " (language servers run on Claude Code only)" : "";
    return parts.join(" · ") + pending;
}

const projectName = (cwd?: string) => (cwd ? (cwd.split(/[\\/]/).filter(Boolean).at(-1) ?? cwd) : undefined);

export function Plugins() {
    const [info, setInfo] = createSignal<PluginsInfo>();
    const [loading, setLoading] = createSignal(true);
    /** What's under way: an action key ("install:fmt@m"), so only that row shows a spinner. */
    const [busy, setBusy] = createSignal<string>();
    const [view, setView] = createSignal<View>("installed");
    const [query, setQuery] = createSignal("");
    const [source, setSource] = createSignal("");
    const [confirm, setConfirm] = createSignal<{ title: string; body: string; label: string; run: () => Promise<void> }>();
    const cwd = () => app.homeCwd;

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

    const act = async (key: string, params: PluginActionParams, done?: () => void) => {
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

    const match = (p: PluginInfo) => {
        const q = query().trim().toLowerCase();
        return !q || `${p.name} ${p.description ?? ""} ${p.marketplace} ${p.category ?? ""}`.toLowerCase().includes(q);
    };
    const installed = createMemo(() => (info()?.plugins ?? []).filter((p) => p.installed || p.missing));
    const available = createMemo(() => (info()?.plugins ?? []).filter((p) => !p.installed && !p.missing));
    const shown = () => (view() === "installed" ? installed() : available()).filter(match);
    const projectScopes = () => Boolean(info()?.cwd && info()?.trusted);

    const addMarketplace = (src = source().trim()) => {
        if (!src) return;
        void act(`market:add`, { action: "marketplaceAdd", source: src }, () => {
            setSource("");
            setView("discover");
        });
    };

    return (
        <div class="plg">
            <ConfirmDialog open={Boolean(confirm())} onClose={() => setConfirm(undefined)} title={confirm()?.title ?? ""} confirmLabel={confirm()?.label ?? "OK"} onConfirm={() => confirm()?.run()}>
                {confirm()?.body}
            </ConfirmDialog>
            <div class="prov-quick">
                <Store size={16} />
                <input
                    class="input mono"
                    aria-label="Marketplace source"
                    placeholder="owner/repo, git URL, folder or marketplace.json"
                    value={source()}
                    onInput={(e) => setSource(e.currentTarget.value)}
                    onKeyDown={(e) => e.key === "Enter" && addMarketplace()}
                />
                <button class="btn primary sm" disabled={!source().trim() || Boolean(busy())} onClick={() => addMarketplace()}>
                    {busy() === "market:add" ? <Spinner size={12} /> : "Add"}
                </button>
            </div>
            <div class="set-note">
                Add a marketplace to browse its plugins. Claude Code plugins and marketplaces work as they are.{" "}
                <Show when={info()?.cwd} fallback={<>Open a project to turn plugins on for just that project.</>}>
                    On/off below is for <b>{projectName(info()?.cwd)}</b>
                    <Show when={!info()?.trusted}> (not trusted yet, so only your own settings count there)</Show>.
                </Show>
            </div>
            <div class="plg-bar">
                <Segmented
                    label="Show"
                    size="sm"
                    value={view()}
                    onChange={setView}
                    options={[
                        { value: "installed", label: <>Installed <span class="plg-n">{installed().length}</span></> },
                        { value: "discover", label: <>Discover <span class="plg-n">{available().length}</span></> },
                        { value: "marketplaces", label: <>Marketplaces <span class="plg-n">{info()?.marketplaces.length ?? 0}</span></> },
                    ]}
                />
                <span class="grow" />
                <Show when={view() !== "marketplaces"}>
                    <label class="plg-search">
                        <Search size={14} />
                        <input class="input" aria-label="Filter plugins" placeholder="Filter" value={query()} onInput={(e) => setQuery(e.currentTarget.value)} />
                    </label>
                </Show>
                <Show when={view() === "installed" && installed().some((p) => p.installed)}>
                    <button class="btn secondary sm" disabled={Boolean(busy())} title="Refresh marketplaces and fetch newer versions" onClick={() => void act("update:all", { action: "update" })}>
                        {busy() === "update:all" ? <Spinner size={12} /> : <RefreshCw size={13} />} Update all
                    </button>
                </Show>
            </div>
            <Show when={!loading()} fallback={<div class="plg-empty"><Spinner size={16} /> Loading plugins…</div>}>
                <Switch>
                    <Match when={view() === "marketplaces"}>
                        <Show
                            when={info()?.marketplaces.length}
                            fallback={
                                <div class="plg-empty">
                                    <Puzzle size={22} />
                                    <div>
                                        <div class="plg-empty-title">No marketplaces yet</div>
                                        <div class="muted small">A marketplace is a catalog of plugins. Add one above, or start with Anthropic's.</div>
                                    </div>
                                    <button class="btn secondary sm" disabled={Boolean(busy())} onClick={() => addMarketplace(SUGGESTED)}>
                                        {busy() === "market:add" ? <Spinner size={12} /> : `Add ${SUGGESTED}`}
                                    </button>
                                </div>
                            }
                        >
                            <For each={info()!.marketplaces}>
                                {(m) => (
                                    <div class="plg-row">
                                        <div class="plg-main">
                                            <div class="plg-title">
                                                <span class="plg-name">{m.name}</span>
                                                <span class="chip tiny">{m.plugins} plugin{m.plugins === 1 ? "" : "s"}</span>
                                                <Show when={m.error}>
                                                    <span class="chip tiny err">can't read</span>
                                                </Show>
                                            </div>
                                            <div class="plg-desc mono">{m.kind === "directory" || m.kind === "file" ? tildify(m.source) : m.source}</div>
                                            <Show when={m.description}>
                                                <div class="plg-desc">{m.description}</div>
                                            </Show>
                                            <Show when={m.error}>
                                                <div class="plg-err">{m.error}</div>
                                            </Show>
                                            <For each={m.warnings.slice(0, 3)}>{(w) => <div class="plg-warn">{w}</div>}</For>
                                        </div>
                                        <div class="plg-actions">
                                            <button class="hb sm" disabled={Boolean(busy())} title={m.kind === "directory" || m.kind === "file" ? "Read again" : "Fetch the latest catalog"} aria-label={`Update ${m.name}`} onClick={() => void act(`market:update:${m.name}`, { action: "marketplaceUpdate", name: m.name })}>
                                                {busy() === `market:update:${m.name}` ? <Spinner size={12} /> : <RefreshCw size={14} />}
                                            </button>
                                            <button
                                                class="hb sm"
                                                disabled={Boolean(busy())}
                                                title="Remove"
                                                aria-label={`Remove ${m.name}`}
                                                onClick={() => {
                                                    const from = installed().filter((p) => p.marketplace === m.name && p.installed);
                                                    setConfirm({
                                                        title: `Remove ${m.name}?`,
                                                        body: from.length ? `This also uninstalls ${from.map((p) => p.name).join(", ")}.` : "Its plugins won't be offered any more.",
                                                        label: "Remove",
                                                        run: () => act(`market:remove:${m.name}`, { action: "marketplaceRemove", name: m.name }),
                                                    });
                                                }}
                                            >
                                                <Trash2 size={14} />
                                            </button>
                                        </div>
                                    </div>
                                )}
                            </For>
                        </Show>
                    </Match>
                    <Match when={!shown().length}>
                        <div class="plg-empty">
                            <Puzzle size={22} />
                            <div>
                                <Show
                                    when={query().trim()}
                                    fallback={
                                        <>
                                            <div class="plg-empty-title">{view() === "installed" ? "No plugins installed" : info()?.marketplaces.length ? "Everything is installed" : "Nothing to discover yet"}</div>
                                            <div class="muted small">{view() === "installed" ? (available().length ? `${available().length} available in Discover.` : "Add a marketplace to find plugins.") : info()?.marketplaces.length ? "Every plugin your marketplaces offer is installed." : "Add a marketplace to see its plugins here."}</div>
                                        </>
                                    }
                                >
                                    <div class="plg-empty-title">No plugins match “{query().trim()}”</div>
                                </Show>
                            </div>
                            <Show when={!query().trim() && view() === "installed" && available().length}>
                                <button class="btn secondary sm" onClick={() => setView("discover")}>
                                    Browse
                                </button>
                            </Show>
                            <Show when={!query().trim() && !info()?.marketplaces.length}>
                                <button class="btn secondary sm" onClick={() => setView("marketplaces")}>
                                    Marketplaces
                                </button>
                            </Show>
                        </div>
                    </Match>
                    <Match when={true}>
                        <For each={shown()}>{(p) => <PluginRow p={p} busy={busy()} act={act} projectScopes={projectScopes()} confirm={setConfirm} />}</For>
                    </Match>
                </Switch>
            </Show>
        </div>
    );
}

function PluginRow(p: {
    p: PluginInfo;
    busy?: string;
    projectScopes: boolean;
    act: (key: string, params: PluginActionParams, done?: () => void) => Promise<void>;
    confirm: (c: { title: string; body: string; label: string; run: () => Promise<void> }) => void;
}) {
    const [scope, setScope] = createSignal<PluginScope>("user");
    const pl = () => p.p;
    const key = (a: string) => `${a}:${pl().id}`;
    const scopes = () => (p.projectScopes ? SCOPES : SCOPES.filter((s) => s.value === "user"));
    const where = () =>
        (["user", "project", "local"] as const)
            .filter((s) => pl().scopes[s] !== undefined)
            .map((s) => `${pl().scopes[s] ? "on" : "off"} for ${s === "user" ? "you" : s === "project" ? "the project" : "you here"}`)
            .join(" · ");
    return (
        <div class={`plg-row ${pl().installed && !pl().enabled ? "off" : ""}`}>
            <div class="plg-main">
                <div class="plg-title">
                    <span class="plg-name">{pl().name}</span>
                    <Show when={pl().installed?.version ?? pl().version}>{(v) => <span class="chip tiny">v{v()}</span>}</Show>
                    <span class="chip tiny" title="Marketplace">
                        {pl().marketplace}
                    </span>
                    <Show when={pl().category}>
                        <span class="chip tiny">{pl().category}</span>
                    </Show>
                    <Show when={pl().missing}>
                        <span class="chip tiny warn">not installed</span>
                    </Show>
                    <Show when={pl().errors.length}>
                        <span class="chip tiny warn" title={pl().errors.join("\n")}>
                            <TriangleAlert size={11} /> {pl().errors.length === 1 ? "1 problem" : `${pl().errors.length} problems`}
                        </span>
                    </Show>
                </div>
                <Show when={pl().description}>
                    <div class="plg-desc">{pl().description}</div>
                </Show>
                <Show when={pl().installed}>
                    {(i) => (
                        <div class="plg-meta">
                            {countsText(i().counts) || "Nothing loads from it"}
                            <Show when={where()}> · {where()}</Show>
                        </div>
                    )}
                </Show>
                <Show when={pl().missing}>
                    <div class="plg-meta">Turned on in settings, but not installed on this computer.</div>
                </Show>
                <For each={pl().errors.slice(0, 3)}>{(e) => <div class="plg-warn">{e}</div>}</For>
            </div>
            <div class="plg-actions">
                <Show
                    when={pl().installed}
                    fallback={
                        <>
                            <Show when={scopes().length > 1}>
                                <select class="select sm" aria-label={`Install ${pl().name} for`} value={scope()} onChange={(e) => setScope(e.currentTarget.value as PluginScope)}>
                                    <For each={scopes()}>{(s) => <option value={s.value} title={s.title}>{s.label}</option>}</For>
                                </select>
                            </Show>
                            <button class="btn secondary sm" disabled={Boolean(p.busy)} title="Hooks and MCP servers in a plugin run commands on this computer" onClick={() => void p.act(key("install"), { action: "install", id: pl().id, scope: scope() })}>
                                {p.busy === key("install") ? <Spinner size={12} /> : <Download size={13} />} Install
                            </button>
                        </>
                    }
                >
                    <Toggle label={`${pl().enabled ? "Disable" : "Enable"} ${pl().name}`} checked={pl().enabled} onChange={(on) => void p.act(key("toggle"), { action: on ? "enable" : "disable", id: pl().id })} />
                    <Show when={!pl().orphaned}>
                        <button class="hb sm" disabled={Boolean(p.busy)} title="Update" aria-label={`Update ${pl().name}`} onClick={() => void p.act(key("update"), { action: "update", id: pl().id })}>
                            {p.busy === key("update") ? <Spinner size={12} /> : <RefreshCw size={14} />}
                        </button>
                    </Show>
                    <button
                        class="hb sm"
                        disabled={Boolean(p.busy)}
                        title="Uninstall"
                        aria-label={`Uninstall ${pl().name}`}
                        onClick={() =>
                            p.confirm({
                                title: `Uninstall ${pl().name}?`,
                                body: "Removes it from every scope in this project and your own settings. Its commands, agents, hooks and MCP servers stop loading.",
                                label: "Uninstall",
                                run: () => p.act(key("uninstall"), { action: "uninstall", id: pl().id }),
                            })
                        }
                    >
                        <Trash2 size={14} />
                    </button>
                </Show>
            </div>
        </div>
    );
}
