// /plugin in the terminal: with arguments it runs like `cavvy plugin …`;
// bare, it opens a browser over every marketplace's plugins, the installed
// ones first, with install, enable/disable, update and uninstall per scope.

import type { App } from "../ui/app";
import { bold, theme, truncate } from "../ui/ansi";
import { MessageDialog, SelectDialog, InputDialog } from "../ui/dialogs";
import type { SelectItem } from "../ui/components";
import { loadCustomCommands } from "./custom";
import { loadSkills, sameSkills } from "../agent/skills";
import { countsText, runPluginCli, scopesText, type Style } from "../plugins/cli";
import { listPlugins, type PluginInfo, type PluginListing } from "../plugins/install";
import { pluginServerMatch } from "../plugins/loader";
import { withPluginCommands } from "../plugins/native";
import type { SettingsScope } from "../config/settings";
import { redact } from "../util/redact";

const style: Style = { bold, muted: theme.muted, success: theme.success, warning: theme.warning, error: theme.error };

/** A well-known catalog to offer when none is added yet. */
export const SUGGESTED_MARKETPLACE = "anthropics/claude-plugins-official";

const SCOPE_TEXT: Record<SettingsScope, string> = {
    user: "for you, in every folder",
    project: "for everyone in this project (.cavvy/settings.json)",
    local: "just for you, in this project (.cavvy/settings.local.json)",
};

/** Settings, commands, skills and MCP servers read again after a change. */
export async function reload(app: App, restart?: string[]) {
    app.reloadSettings();
    app.customCommands = loadCustomCommands(app.cwd, app.init.trusted);
    app.skills = sameSkills(app.skills, loadSkills(app.cwd, app.init.trusted));
    // What Claude Code listed predates the change: it runs the plugins' commands now enabled too.
    if (app.cliCommands) app.cliCommands = { ...app.cliCommands, names: withPluginCommands(app.cliCommands.names, app.customCommands) };
    await app.mcp.sync();
    // An update can change a server's program without changing its configuration.
    const match = pluginServerMatch(restart);
    if (match) await app.mcp.restartWhere(match);
}

/** Run one `plugin …` command line, with a progress card while it fetches. */
async function run(app: App, argv: string[]): Promise<boolean> {
    let card: MessageDialog | undefined;
    const progress = (msg: string) => {
        if (card) app.popDialog(card);
        card = new MessageDialog([theme.permission(bold(msg)), theme.muted("Fetching from git or npm can take a moment.")], theme.permission);
        app.pushDialog(card);
        app.renderLive();
    };
    let r;
    try {
        r = await runPluginCli(argv, app.cwd, app.init.trusted, style, progress);
    } finally {
        if (card) app.popDialog(card);
    }
    app.print(["", ...r.lines.map((l) => "  " + redact(l))]);
    if (r.changed) {
        await reload(app, r.restart);
        if (r.ok) app.print([theme.muted("  Plugin changes apply now: commands, agents and hooks are loaded, and MCP servers are starting.")]);
    }
    app.renderLive();
    return r.ok;
}

export async function pluginCommand(app: App, args: string) {
    const argv = [...args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3] ?? "");
    if (argv.length) {
        await run(app, argv);
        return;
    }
    await browse(app);
}

function stateText(p: PluginInfo): string {
    if (p.missing) return theme.warning("not installed");
    if (!p.installed) return theme.muted("available");
    if (p.errors.length) return p.enabled ? theme.warning("on · has problems") : theme.muted("off · has problems");
    return p.enabled ? theme.success("on") : theme.muted("off");
}

type Pick = { kind: "plugin"; id: string } | { kind: "add" } | { kind: "suggest" } | { kind: "markets" } | { kind: "update" };

async function browse(app: App) {
    let initial = 0;
    for (;;) {
        const l = listPlugins(app.cwd, app.init.trusted);
        const items: SelectItem<Pick>[] = [];
        const installed = l.plugins.filter((p) => p.installed || p.missing);
        const available = l.plugins.filter((p) => !p.installed && !p.missing);
        for (const p of installed) items.push({ group: "Installed", label: bold(p.name), value: { kind: "plugin", id: p.id }, description: `${stateText(p)}${p.installed ? theme.muted(` · ${countsText(p.installed.counts)}`) : ""}`, detail: p.marketplace, keywords: `${p.description ?? ""} ${p.category ?? ""}` });
        for (const p of available) items.push({ group: `Available (${available.length})`, label: p.name, value: { kind: "plugin", id: p.id }, description: theme.muted(truncate(p.description ?? "", 60)), detail: p.marketplace, keywords: `${p.description ?? ""} ${p.category ?? ""}` });
        if (!l.marketplaces.length) items.push({ group: "Get started", label: `Add ${SUGGESTED_MARKETPLACE}`, value: { kind: "suggest" }, description: theme.muted("Anthropic's plugin catalog") });
        items.push({ group: "Marketplaces", label: "+ Add a marketplace…", value: { kind: "add" }, description: theme.muted("owner/repo, a git URL, a folder or a marketplace.json") });
        if (l.marketplaces.length) items.push({ group: "Marketplaces", label: `Manage marketplaces (${l.marketplaces.length})`, value: { kind: "markets" }, description: theme.muted(l.marketplaces.map((m) => m.name).join(", ")) });
        if (installed.some((p) => p.installed)) items.push({ group: "Marketplaces", label: "Update all plugins", value: { kind: "update" }, description: theme.muted("refresh marketplaces, then fetch newer versions") });
        const header = !l.marketplaces.length
            ? [theme.muted("Plugins bundle commands, agents, skills, hooks and MCP servers. They come from marketplaces:"), theme.muted("add one to browse what it offers. Claude Code plugins work as they are.")]
            : [theme.muted(`${installed.length} installed · ${available.length} more in ${l.marketplaces.length} marketplace${l.marketplaces.length === 1 ? "" : "s"} · type to filter`)];
        const pick = (await app.showDialog(new SelectDialog<Pick>({ title: "Plugins", header, items, searchable: true, initial: Math.min(initial, items.length - 1), maxRows: 16 }))) as Pick | undefined;
        if (!pick) return;
        initial = Math.max(0, items.findIndex((i) => JSON.stringify(i.value) === JSON.stringify(pick)));
        if (pick.kind === "suggest") await run(app, ["marketplace", "add", SUGGESTED_MARKETPLACE]);
        else if (pick.kind === "add") await addMarketplace(app);
        else if (pick.kind === "markets") await markets(app);
        else if (pick.kind === "update") await run(app, ["update", "--all"]);
        else await pluginCard(app, pick.id);
    }
}

async function addMarketplace(app: App) {
    const src = (await app.showDialog(
        new InputDialog({
            title: "Add a marketplace",
            header: [theme.muted("A GitHub owner/repo, a git URL (add #branch for a branch or tag), a folder on this computer,"), theme.muted("or a path or https URL to a marketplace.json.")],
            placeholder: "owner/repo",
            validate: (v) => (v.trim() ? undefined : "Type a source"),
        }),
    )) as string | undefined;
    if (src?.trim()) await run(app, ["marketplace", "add", src.trim()]);
}

async function markets(app: App) {
    for (;;) {
        const l: PluginListing = listPlugins(app.cwd, app.init.trusted);
        if (!l.marketplaces.length) return;
        const name = (await app.showDialog(
            new SelectDialog<string>({
                title: "Marketplaces",
                items: l.marketplaces.map((m) => ({ label: bold(m.name), value: m.name, description: m.error ? theme.error(truncate(m.error, 60)) : theme.muted(`${m.plugins} plugin${m.plugins === 1 ? "" : "s"} · ${m.source}`), detail: m.kind })),
                numbers: true,
            }),
        )) as string | undefined;
        if (!name) return;
        const m = l.marketplaces.find((x) => x.name === name)!;
        const local = m.kind === "directory" || m.kind === "file";
        const a = (await app.showDialog(
            new SelectDialog<"update" | "remove">({
                title: m.name,
                header: [theme.muted(m.source), ...(m.description ? [theme.muted(m.description)] : []), ...(m.lastUpdated ? [theme.subtle(`updated ${m.lastUpdated.slice(0, 16).replace("T", " ")}`)] : []), ...m.warnings.map((w) => theme.warning(w))],
                items: [
                    { label: local ? "Re-read" : "Update", value: "update", description: theme.muted(local ? "read from disk again" : "fetch the latest catalog") },
                    { label: "Remove", value: "remove", description: theme.muted("also uninstalls its plugins") },
                ],
                numbers: true,
            }),
        )) as "update" | "remove" | undefined;
        if (a === "update") await run(app, ["marketplace", "update", name]);
        if (a === "remove") {
            const installedFrom = l.plugins.filter((p) => p.marketplace === name && p.installed).map((p) => p.name);
            const sure = (await app.showDialog(new SelectDialog<boolean>({ title: `Remove ${name}?`, header: installedFrom.length ? [theme.warning(`This uninstalls ${installedFrom.join(", ")}.`)] : [], items: [{ label: "Remove", value: true }, { label: "Keep", value: false }], numbers: true }))) === true;
            if (sure) await run(app, ["marketplace", "remove", name]);
        }
    }
}

type Action = { do: "install" | "enable" | "disable" | "uninstall"; scope?: SettingsScope } | { do: "update" };

async function pluginCard(app: App, id: string) {
    for (;;) {
        const p = listPlugins(app.cwd, app.init.trusted).plugins.find((x) => x.id === id);
        if (!p) return;
        const trusted = app.init.trusted;
        const header: string[] = [];
        if (p.description) header.push(p.description);
        const facts = [p.installed ? `v${p.installed.version}` : p.version ? `v${p.version}` : "", p.author ? `by ${p.author}` : "", p.marketplace ? `from ${p.marketplace}` : "", p.category ?? ""].filter(Boolean);
        if (facts.length) header.push(theme.muted(facts.join(" · ")));
        if (p.installed) header.push(theme.muted(`Adds ${countsText(p.installed.counts)}.`));
        if (scopesText(p)) header.push(theme.muted(`Settings: ${scopesText(p)}`));
        if (p.homepage) header.push(theme.subtle(p.homepage));
        if (p.missing) header.push(theme.warning("Turned on in settings, but not installed on this computer."));
        if (p.orphaned) header.push(theme.warning("Its marketplace no longer lists it, so it can't be updated."));
        for (const e of p.errors) header.push(theme.warning(e));
        const items: SelectItem<Action>[] = [];
        const scopes: SettingsScope[] = trusted ? ["user", "project", "local"] : ["user"];
        if (!p.installed) {
            for (const s of scopes) items.push({ label: `Install ${s === "user" ? "for you" : s === "project" ? "for this project" : "locally"}`, value: { do: "install", scope: s }, description: theme.muted(SCOPE_TEXT[s]) });
            if (!trusted) header.push(theme.subtle("This folder isn't trusted, so project and local installs aren't offered."));
            header.push(theme.subtle("Hooks and MCP servers in a plugin run commands on this computer: install plugins you trust."));
        } else {
            if (p.enabled) items.push({ label: "Disable", value: { do: "disable" }, description: theme.muted("keeps it installed") });
            else items.push({ label: "Enable", value: { do: "enable" }, description: theme.muted(p.scopes.user === false || !Object.keys(p.scopes).length ? "for you, in every folder" : "where it was turned off") });
            if (p.enabled) for (const s of scopes) if (p.scopes[s] === undefined) items.push({ label: `Also enable ${s === "user" ? "everywhere" : s === "project" ? "for this project" : "locally"}`, value: { do: "enable", scope: s }, description: theme.muted(SCOPE_TEXT[s]) });
            if (!p.orphaned) items.push({ label: "Update", value: { do: "update" }, description: theme.muted("fetch the newest version") });
            items.push({ label: "Uninstall", value: { do: "uninstall" }, description: theme.muted("from every scope in this folder") });
        }
        const a = (await app.showDialog(new SelectDialog<Action>({ title: p.name, header, items, numbers: true }))) as Action | undefined;
        if (!a) return;
        if (a.do === "update") await run(app, ["update", id]);
        else await run(app, [a.do, id, ...(a.scope ? ["--scope", a.scope] : [])]);
    }
}
