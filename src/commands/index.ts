// Slash commands for the interactive app.

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "bun";
import type { App } from "../ui/app";
import { renderTodos } from "../ui/app";
import { InputDialog, MessageDialog, SelectDialog } from "../ui/dialogs";
import { bold, padEnd, termCols, theme, truncate, width } from "../ui/ansi";
import { formatDuration, type SelectItem } from "../ui/components";
import { renderMarkdown } from "../ui/markdown";
import { notificationMode, notifyAfterMs } from "../ui/notify";
import { APP_TITLE, APP_VERSION, paths } from "../config/paths";
import { EFFORT_LEVELS, JsonFileError, loadScope, removePermissionRule, addPermissionRule, settingsPath, updateSettings, readJson, readJsonForUpdate, type Effort, type SettingsScope, type Settings } from "../config/settings";
import { agentProjectConfig, isTrusted, trustedByUser, trustFolder } from "../config/trust";
import { MODE_INFO, PERMISSION_MODES, parseMode, type PermissionMode } from "../permissions/modes";
import { parseRule } from "../permissions/rules";
import { sandboxEnabled, sandboxKind } from "../permissions/sandbox";
import {
    allProviders,
    getProvider,
    readAgentConfig,
    readProvidersFileForUpdate,
    readVertexConfig,
    removeAgentConfig,
    removeVertexConfig,
    resolveBaseUrl,
    saveAgentConfig,
    saveVertexConfig,
    SEARCH_PROVIDERS,
    validVertexLocation,
    validVertexProject,
    vertexBaseUrl,
    writeProvidersFile,
    type ProviderDef,
    type VertexConfig,
    type WireKind,
} from "../providers/registry";
import { GcloudError } from "../providers/vertex";
import { checkVertex, enableVertexApi, gcloudAccounts, gcloudProjects, type VertexCheck } from "../auth/gcloud";
import { forgetClient, defaultModelFrom, type ProviderListing } from "../providers/models";
import { modelRef, parseModelRef, textOf, type ModelInfo } from "../providers/types";
import { formatPrice, formatTokens, formatUsd } from "../providers/pricing";
import { getKey, removeKey, setKey, storageDescription } from "../auth/credentials";
import { detectKeyProvider, validateKey } from "../auth/detect";
import { maskKey, redact } from "../util/redact";
import { listSessions, findSession } from "../agent/session";
import { loadMemory } from "../agent/memory";
import { BUILTIN_AGENTS, loadAgents } from "../agent/agents";
import { estimateTokens } from "../agent/compact";
import { BLOCKING_EVENTS, HOOK_EVENTS } from "../agent/hooks";
import { toSchema } from "../tools/index";
import { displayPath, expandPath } from "../util/files";
import { gitRoot } from "../util/git";
import { childEnv } from "../util/env";
import { expandCommand, type CustomCommand } from "./custom";
import { rewindCommand } from "./rewind";
import { checkAgentCli, vendorOf, type AgentCliStatus } from "../backends/index";
import { CLAUDE_CLI, CODEX_CLI, findCli } from "../backends/cli";

export interface Command {
    name: string;
    aliases?: string[];
    description: string;
    /** Argument hint; commands with arguments aren't run straight from the menu. */
    args?: string;
    /** Usable while a response is streaming. */
    whileBusy?: boolean;
    /** Don't echo "> /name" (commands that start a turn print the prompt themselves). */
    noEcho?: boolean;
    hidden?: boolean;
    custom?: CustomCommand;
    run(app: App, args: string): Promise<void> | void;
}

// ---------------------------------------------------------------------------
// Helpers

function ago(ms: number): string {
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
}

function heading(text: string): string {
    return bold(text);
}

function kv(label: string, value: string, w = 18): string {
    return `  ${padEnd(theme.muted(label), w)}${value}`;
}

async function withProgress<T>(app: App, lines: string[], fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    const ac = new AbortController();
    const d = new MessageDialog([...lines, "", theme.subtle("esc to cancel")], theme.permission, () => ac.abort());
    app.pushDialog(d);
    try {
        return await Promise.race([fn(ac.signal), new Promise<undefined>((r) => ac.signal.addEventListener("abort", () => r(undefined)))]);
    } finally {
        app.popDialog(d);
    }
}

async function confirm(app: App, title: string, header: string[] = [], yes = "Yes", no = "No"): Promise<boolean> {
    const d = new SelectDialog<boolean>({ title, header, items: [{ label: yes, value: true }, { label: no, value: false }], numbers: true });
    return (await app.showDialog(d)) === true;
}

async function copyToClipboard(text: string): Promise<string> {
    const tryCmd = (argv: string[]): boolean => {
        if (!Bun.which(argv[0]!)) return false;
        const r = spawnSync(argv, { stdin: new TextEncoder().encode(text), stdout: "ignore", stderr: "ignore", timeout: 5000, env: childEnv() });
        return r.exitCode === 0;
    };
    if (process.platform === "darwin" && tryCmd(["pbcopy"])) return "clipboard";
    if (process.platform === "win32" && tryCmd(["clip"])) return "clipboard";
    if (process.env.WAYLAND_DISPLAY && tryCmd(["wl-copy"])) return "clipboard";
    if (tryCmd(["xclip", "-selection", "clipboard"]) || tryCmd(["xsel", "--clipboard", "--input"])) return "clipboard";
    // OSC 52: works over SSH in most modern terminals.
    process.stdout.write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
    return "clipboard (via terminal OSC 52)";
}

function scopeLabel(scope: SettingsScope, cwd: string): string {
    return `${scope} (${displayPath(settingsPath(scope, cwd), cwd)})`;
}

// ---------------------------------------------------------------------------
// /model

function providerOrder(id: string): number {
    const idx = allProviders().findIndex((p) => p.id === id);
    return idx < 0 ? 999 : idx;
}

function modelDetail(m: ModelInfo): string {
    const def = getProvider(m.provider);
    if (def?.kind === "agent") return `runs in your ${def.name}`;
    return [m.contextWindow ? `${formatTokens(m.contextWindow)} ctx` : "", formatPrice(m)].filter(Boolean).join(" · ");
}

/** What adding a provider involves, for the "Add a provider" rows. */
function addDescription(p: ProviderDef): string {
    if (p.auth === "gcloud") return "set up with gcloud (Google Cloud billing and credits)";
    if (p.id === "claude-code") return "your Claude subscription, through your installed Claude Code";
    if (p.id === "codex") return "your ChatGPT plan, through your installed Codex CLI";
    return "add an API key";
}

async function modelItems(app: App): Promise<SelectItem<string>[]> {
    const items: SelectItem<string>[] = [];
    const listings = [...app.listings].sort((a, b) => providerOrder(a.provider.id) - providerOrder(b.provider.id));
    for (const l of listings) {
        const p = l.provider;
        if (l.status === "offline") continue; // local server not running
        const group = `${p.name}${l.status === "cached" && l.fetchedAt ? theme.subtle(`  · cached ${ago(l.fetchedAt)}`) : ""}`;
        if (l.status === "error") {
            items.push({ label: theme.error(`⚠ ${truncate(l.error ?? "could not list models", 90)}`), value: "", disabled: true, group: p.name });
            continue;
        }
        for (const m of l.models) {
            const named = m.name && m.name !== m.id;
            items.push({
                label: named ? m.name! : m.id,
                value: modelRef(m),
                description: named ? m.id : undefined,
                detail: modelDetail(m),
                group,
                keywords: `${p.id} ${p.name} ${m.id}`,
            });
        }
    }
    // Providers without a key: picking one starts /login for it.
    const have = new Set(listings.map((l) => l.provider.id));
    const missing = allProviders().filter((p) => p.requiresKey && !have.has(p.id));
    for (const p of missing) items.push({ label: theme.muted(`+ ${p.name}`), value: `login:${p.id}`, description: addDescription(p), group: "Add a provider", keywords: `${p.id} ${p.name} login${p.auth === "cli" ? " subscription plan" : ""}` });
    return items;
}

function effortLine(app: App): string {
    const e = app.settings.effort;
    const m = app.model;
    const levels = m?.effortLevels?.length ? m.effortLevels : EFFORT_LEVELS;
    return `${theme.muted("Effort:")} ${e ? theme.permission(`◀ ${e} ▶`) : theme.permission("◀ model default ▶")}${m?.effortLevels?.length ? theme.subtle(`  (${m.id} supports ${levels.join(", ")})`) : ""}`;
}

function cycleEffort(cur: Effort | undefined, dir: 1 | -1): Effort | undefined {
    const order: (Effort | undefined)[] = [undefined, ...EFFORT_LEVELS];
    const idx = order.indexOf(cur);
    return order[(idx + dir + order.length) % order.length];
}

function findModel(app: App, query: string): { ref?: string; matches: ModelInfo[] } {
    const q = query.trim();
    const parsed = parseModelRef(q);
    if (parsed && getProvider(parsed.provider)) return { ref: q, matches: [] };
    const all = app.listings.flatMap((l) => l.models);
    const exact = all.filter((m) => m.id === q || m.id.endsWith("/" + q));
    if (exact.length === 1) return { ref: modelRef(exact[0]!), matches: exact };
    const loose = all.filter((m) => m.id.toLowerCase().includes(q.toLowerCase()) || (m.name ?? "").toLowerCase().includes(q.toLowerCase()));
    if (loose.length === 1) return { ref: modelRef(loose[0]!), matches: loose };
    return { matches: exact.length ? exact : loose };
}

async function modelCommand(app: App, args: string) {
    if (!app.listings.length) {
        await withProgress(app, [theme.permission(bold("Loading models")), theme.muted("Asking each configured provider for its model list…")], () => app.refreshListings());
    }
    if (args) {
        const { ref, matches } = findModel(app, args);
        if (ref) {
            await app.setModel(ref, { persist: true });
            return;
        }
        if (!matches.length) {
            app.notice(`No model matches "${args}". Run /model to browse, or use provider:model (e.g. anthropic:claude-opus-5-5).`, "error");
            return;
        }
        app.notice(`"${args}" matches ${matches.length} models; pick one below.`, "info");
    }
    const items = await modelItems(app);
    if (!items.some((i) => !i.disabled && !i.value.startsWith("login:"))) {
        app.notice("No models available yet. Add an API key with /login (Anthropic, OpenAI, Gemini, OpenRouter, Groq, DeepSeek, xAI, Mistral, …), use your Claude or ChatGPT subscription with /login claude-code or /login codex, or start Ollama / LM Studio.", "warn");
        if (await confirm(app, "Add an API key now?")) await runCommand(app, "/login");
        return;
    }
    const current = app.model ? modelRef(app.model) : undefined;
    const initialEffort = app.settings.effort;
    let refreshing = false;
    const d: SelectDialog<string> = new SelectDialog<string>({
        title: "Select model",
        header: [theme.muted("All models from every provider you have a key for. Type to filter."), effortLine(app)],
        items,
        initial: Math.max(0, items.findIndex((i) => i.value === current)),
        searchable: true,
        current: (v) => v === current,
        maxRows: 18,
        hint: "↑↓ select · type to filter · ←→ effort · ctrl+r refresh · enter confirm · esc cancel",
        onExtraKey: (k, dlg) => {
            if (k.name === "left" || k.name === "right") {
                app.settings.effort = cycleEffort(app.settings.effort, k.name === "right" ? 1 : -1);
                dlg.header[1] = effortLine(app);
                return true;
            }
            if (k.ctrl && k.name === "r" && !refreshing) {
                refreshing = true;
                dlg.header[0] = theme.muted("Refreshing model lists…");
                void app.refreshListings(true).then(async () => {
                    dlg.list.items = await modelItems(app);
                    dlg.list.setQuery(dlg.list.query);
                    dlg.header[0] = theme.muted(`Refreshed ${new Date().toLocaleTimeString()}. Type to filter.`);
                    refreshing = false;
                    app.renderLive();
                });
                return true;
            }
            return false;
        },
    });
    // Pull fresh lists in the background if anything is stale; update the open picker.
    void app.refreshListings().then(async () => {
        if (refreshing) return;
        const fresh = await modelItems(app);
        // Same length isn't same list: a provider can swap one model for another.
        const sig = (items: SelectItem<string>[]) => JSON.stringify(items.map((i) => [i.value, i.label, i.description, i.detail, i.group, i.disabled, i.keywords]));
        if (sig(fresh) === sig(d.list.items)) return;
        d.list.items = fresh;
        d.list.setQuery(d.list.query);
        app.renderLive();
    });
    const choice = (await app.showDialog(d)) as string | undefined;
    const effortChanged = app.settings.effort !== initialEffort;
    if (effortChanged) {
        const e = app.settings.effort;
        updateSettings("user", app.cwd, (s) => (s.effort = e));
        app.print(["", `${theme.success("✔")} Effort set to ${bold(e ?? "model default")}`]);
    }
    if (!choice) return;
    if (choice.startsWith("login:")) return runCommand(app, `/login ${choice.slice(6)}`).then(() => undefined);
    if (choice === current) {
        if (!effortChanged) app.notice(`Kept ${app.model?.name ?? app.model?.id}`);
        return;
    }
    await app.setModel(choice, { persist: true });
}

// ---------------------------------------------------------------------------
// /login, /logout, /providers

async function loginCommand(app: App, args: string) {
    let providerId: string | undefined = args.trim().toLowerCase() || undefined;
    if (providerId === "custom") return addCustomProvider(app);
    if (providerId && getProvider(providerId)?.auth === "gcloud") return vertexLogin(app);
    if (providerId && getProvider(providerId)?.auth === "cli") return agentLogin(app, providerId);
    const known = (id: string) => getProvider(id) ?? SEARCH_PROVIDERS.find((s) => s.id === id);
    if (providerId && !known(providerId)) {
        app.notice(`Unknown provider "${providerId}". Known: ${[...allProviders().map((p) => p.id), ...SEARCH_PROVIDERS.map((s) => s.id)].join(", ")}, or "custom".`, "error");
        return;
    }
    const storage = await storageDescription();
    const target = providerId ? known(providerId)! : undefined;
    if (target && "local" in target && target.local && !target.requiresKey) {
        app.notice(`${target.name} runs locally and needs no key. Start it, then pick a model with /model.`);
        return;
    }
    const header = target
        ? [theme.muted(`Create one at ${(target as { keyUrl?: string }).keyUrl ?? "your provider's dashboard"}.`)]
        : [
              theme.muted("Paste a key from any supported provider; it's recognized automatically:"),
              theme.muted("  Anthropic · OpenAI · Google Gemini · OpenRouter · Groq · DeepSeek · xAI · Mistral"),
              theme.muted("  Together · Fireworks · Cerebras · Brave / Tavily (web search)"),
              theme.muted(`Gemini billed to Google Cloud (credits apply): ${bold("/login vertex")} · other OpenAI-compatible endpoints: ${bold("/login custom")}`),
              theme.muted(`A Claude or ChatGPT subscription, through your own installed CLI: ${bold("/login claude-code")} · ${bold("/login codex")}`),
          ];
    header.push("", theme.subtle(`Stored in ${storage}. Never written to transcripts, logs or settings, and only sent to its own provider.`));
    const key = await app.showDialog(
        new InputDialog({
            title: target ? `${target.name} API key` : "Add an API key",
            header,
            secret: true,
            placeholder: "Paste the key (input is hidden)",
            validate: (v) => (v.trim() ? (/\s/.test(v.trim()) ? "That doesn't look like a single key (it contains spaces)." : undefined) : "Paste a key, or press esc to cancel."),
        }),
    );
    if (!key) return;
    const value = key.trim();

    if (!providerId) {
        const guesses = detectKeyProvider(value);
        if (guesses.length === 1) providerId = guesses[0]!.id;
        else {
            const ids = new Set(guesses.map((g) => g.id));
            const items: SelectItem<string>[] = [
                ...guesses.map((g) => ({ label: g.name, value: g.id, description: "matches this key's format" })),
                ...allProviders()
                    .filter((p) => p.requiresKey && !p.auth && !ids.has(p.id))
                    .map((p) => ({ label: p.name, value: p.id, description: p.custom ? "custom" : undefined })),
                ...SEARCH_PROVIDERS.filter((s) => !ids.has(s.id)).map((s) => ({ label: s.name, value: s.id, description: "web search" })),
            ];
            const pick = (await app.showDialog(
                new SelectDialog<string>({ title: "Which provider is this key for?", header: [theme.muted(`Key: ${maskKey(value)}`)], items, searchable: true }),
            )) as string | undefined;
            if (!pick) return;
            providerId = pick;
        }
    }
    const def = getProvider(providerId);
    const name = def?.name ?? SEARCH_PROVIDERS.find((s) => s.id === providerId)?.name ?? providerId;

    if (def) {
        const res = await withProgress(app, [theme.permission(bold(`Checking the key with ${name}…`)), theme.muted(`GET ${resolveBaseUrl(def)} (model listing)`)], (signal) => validateKey(def, value, signal));
        if (!res) return;
        if (!res.ok) {
            if (res.definitive) {
                app.notice(`${name} rejected this key: ${redact(res.reason)}. Nothing was saved.`, "error");
                return;
            }
            const save = await confirm(app, "Couldn't verify the key", [theme.warning(redact(res.reason)), "", "Save it anyway?"], "Save anyway", "Cancel");
            if (!save) return;
        }
    }
    const source = await setKey(providerId, value);
    forgetClient(providerId);
    await app.keyChanged(providerId);
    app.print(["", `${theme.success("✔")} Saved ${bold(name)} key ${theme.muted(maskKey(value))} to ${source === "keychain" ? (await storageDescription()) : `${paths.credentialsFile()} (chmod 600)`}`]);
    const effective = await getKey(providerId);
    if (effective?.source === "env") app.notice(`Note: $${effective.envVar} is set in your environment and takes precedence over the saved key.`, "warn");
    if (!def) {
        app.notice(`${name} will be used by the WebSearch tool.`);
        return;
    }
    const listings = await withProgress(app, [theme.permission(bold(`Loading ${name} models…`))], () => app.refreshListings());
    const l = listings?.find((x) => x.provider.id === providerId);
    if (l?.error) app.notice(`Couldn't list ${name} models: ${l.error}`, "warn");
    else if (l && !l.models.length) app.notice(`${name} returned no models for this key. Check the key's permissions, then /model (ctrl+r refreshes).`, "warn");
    else if (l) app.notice(`${l.models.length} ${name} model${l.models.length === 1 ? " is" : "s are"} now in /model.`);
    if (!app.model) {
        const pick = defaultModelFrom(l ? [l] : []);
        if (pick) await app.setModel(modelRef(pick), { persist: true });
    }
}

/**
 * /login claude-code, /login codex: use the user's own installed CLI, signed
 * in to their own plan. Signing in happens in that CLI, through the vendor's
 * own flow; this only checks it's installed and signed in, and saves nothing
 * secret (just that it's turned on).
 */
async function agentLogin(app: App, providerId: string) {
    const def = getProvider(providerId)!;
    const cli = providerId === "codex" ? CODEX_CLI : CLAUDE_CLI;
    let st: AgentCliStatus | undefined;
    try {
        st = await withProgress(app, [theme.permission(bold(`Checking ${def.name}…`)), theme.muted(providerId === "codex" ? "codex app-server · account/read" : "claude auth status")], (signal) => checkAgentCli(providerId, signal));
    } catch (e) {
        if ((e as Error).message !== "aborted") app.notice(`Couldn't check ${def.name}: ${redact((e as Error).message)}`, "error");
        return;
    }
    if (!st) return;
    if (!st.installed) {
        app.notice(`${def.name} isn't installed (no \`${cli.command}\` on your PATH). ${st.installHint}, sign in with \`${st.signIn}\`, then /login ${providerId} again.`, "warn");
        return;
    }
    if (!st.signedIn) {
        app.notice(`${def.name} isn't signed in. In a terminal, run \`${st.signIn}\` (${vendorOf(providerId)}'s own sign-in), then /login ${providerId} again.`, "warn");
        return;
    }
    try {
        saveAgentConfig(providerId);
    } catch (e) {
        app.notice(redact((e as Error).message), "error");
        return;
    }
    forgetClient(providerId);
    await app.keyChanged(providerId);
    app.print([
        "",
        `${theme.success("✔")} ${bold(def.name)} turned on: ${st.description} ${theme.muted(`(${st.path})`)}`,
        theme.muted(`  Each turn runs in your ${def.name}, with its own tools; ${APP_TITLE} shows it and asks you when it needs permission.`),
        theme.muted(`  Its sign-in stays in ${def.name}: ${APP_TITLE} never reads or stores it.`),
    ]);
    if (st.apiKey) app.notice(`${def.name} is signed in with an API key, so its usage is billed to that key, not a subscription. \`${st.signIn}\` switches it to your account.`, "warn");
    // It loads this folder's own configuration (hooks, skills, MCP servers) only if you trust the folder.
    const projectConfig = [...agentProjectConfig(app.cwd, providerId as "claude-code" | "codex"), ...(providerId === "claude-code" && existsSync(paths.projectMcp(app.cwd)) ? [".mcp.json"] : [])];
    if (projectConfig.length && !trustedByUser(app.cwd)) {
        const trust = await confirm(
            app,
            `Trust this folder's ${def.name} configuration?`,
            [
                bold(app.cwd),
                "",
                `${def.name} would load ${projectConfig.join(", ")} from this folder.`,
                theme.muted("Hooks, MCP servers and skills there can run commands on your machine; permission rules there can approve actions."),
                theme.muted(`Until you trust the folder, ${def.name} runs without them.`),
            ],
            "Yes, trust this folder",
            "No, run without them",
        );
        if (trust) {
            try {
                trustFolder(app.cwd);
            } catch (e) {
                app.notice(`Trusted for this session only. ${redact((e as Error).message)}`, "warn");
            }
        }
    }
    const listings = await withProgress(app, [theme.permission(bold(`Loading ${def.name} models…`))], () => app.refreshListings());
    const l = listings?.find((x) => x.provider.id === providerId);
    if (l?.error) app.notice(`Couldn't list ${def.name} models: ${l.error}`, "warn");
    else if (l) app.notice(`${l.models.length} ${def.name} model${l.models.length === 1 ? " is" : "s are"} now in /model.`);
    const pick = defaultModelFrom(l ? [l] : []);
    if (!pick) return;
    if (!app.model) await app.setModel(modelRef(pick), { persist: true });
    else if (app.model.provider !== providerId && (await confirm(app, `Switch to ${pick.name ?? pick.id} in ${def.name}?`, [theme.muted(`Now: ${app.model.name ?? app.model.id} (${app.model.provider})`)], "Switch", "Keep the current model"))) {
        await app.setModel(modelRef(pick), { persist: true });
    }
}

/** A gcloud step behind a progress dialog: undefined when cancelled, or after showing its error. */
async function gcloudStep<T>(app: App, lines: string[], fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
    try {
        return await withProgress(app, lines, fn);
    } catch (e) {
        if ((e as Error).message !== "aborted") app.notice(redact((e as Error).message), e instanceof GcloudError && e.missing ? "warn" : "error");
        return undefined;
    }
}

/**
 * /login vertex: pick a Google account (from gcloud), a project and a
 * location, check it, and save the setup. Nothing secret is stored: every
 * request gets a fresh-enough token from gcloud for that account.
 */
async function vertexLogin(app: App) {
    const def = getProvider("vertex")!;
    const current = readVertexConfig();
    const accounts = await gcloudStep(app, [theme.permission(bold("Checking gcloud…")), theme.muted("gcloud auth list")], (s) => gcloudAccounts(s));
    if (!accounts) return;
    if (!accounts.length) {
        app.notice("gcloud has no signed-in Google account. In a terminal, run gcloud auth login (with the account that has your Cloud billing or credits), then /login vertex again.", "warn");
        return;
    }
    let account = accounts[0]!.account;
    if (accounts.length > 1) {
        const initial = Math.max(0, accounts.findIndex((a) => a.account === (current?.account ?? accounts.find((x) => x.active)?.account)));
        const pick = (await app.showDialog(
            new SelectDialog<string>({
                title: "Which Google account?",
                header: [theme.muted("Vertex AI usage is billed to a project this account can use.")],
                items: accounts.map((a) => ({ label: a.account, value: a.account, description: [a.account === current?.account ? "current setup" : "", a.active ? "gcloud's active account" : ""].filter(Boolean).join(" · ") || undefined })),
                initial,
                numbers: true,
            }),
        )) as string | undefined;
        if (!pick) return;
        account = pick;
    }

    const projects = await gcloudStep(app, [theme.permission(bold(`Listing projects for ${account}…`)), theme.muted("gcloud projects list, gcloud billing projects list")], (s) => gcloudProjects(account, s));
    if (!projects) return;
    projects.sort((a, b) => Number(b.billing === true) - Number(a.billing === true) || a.projectId.localeCompare(b.projectId));
    let project: string | undefined;
    if (projects.length) {
        const items: SelectItem<string>[] = projects.map((p) => ({
            label: p.projectId,
            value: p.projectId,
            description: p.name && p.name !== p.projectId ? p.name : undefined,
            detail: p.billing === true ? theme.success("billing on") : p.billing === false ? theme.warning("no billing") : undefined,
        }));
        items.push({ label: theme.muted("Enter a project ID…"), value: "" });
        const pick = (await app.showDialog(
            new SelectDialog<string>({
                title: "Which project should be billed?",
                header: [theme.muted("Free-trial and other Cloud credits apply to the project's billing account.")],
                items,
                initial: Math.max(0, items.findIndex((i) => i.value === current?.project)),
                searchable: projects.length > 8,
            }),
        )) as string | undefined;
        if (pick === undefined) return;
        project = pick || undefined;
    }
    if (!project) {
        const typed = await app.showDialog(new InputDialog({ title: "Google Cloud project ID", placeholder: "my-project-123", validate: (v) => (validVertexProject(v.trim()) ? undefined : "Project IDs are lowercase letters, digits and hyphens, like my-project-123.") }));
        if (!typed) return;
        project = typed.trim();
    }
    const billing = projects.find((p) => p.projectId === project)?.billing;
    if (billing === false) {
        const ok = await confirm(app, `${project} has no billing account`, [theme.warning("Vertex AI won't answer until the project is linked to one (Cloud console → Billing)."), "", "Use this project anyway?"], "Use it anyway", "Cancel");
        if (!ok) return;
    }

    const loc = (await app.showDialog(
        new SelectDialog<string>({
            title: "Where should requests go?",
            items: [
                { label: "global", value: "global", description: "recommended: Google picks where each request runs" },
                { label: "A specific region…", value: "", description: "for data-residency needs, e.g. us-central1 or europe-west4" },
            ],
            initial: current && current.location !== "global" ? 1 : 0,
            numbers: true,
        }),
    )) as string | undefined;
    if (loc === undefined) return;
    let location = loc;
    if (!location) {
        const typed = await app.showDialog(new InputDialog({ title: "Region", placeholder: current?.location !== "global" ? current?.location : "us-central1", validate: (v) => (validVertexLocation(v.trim()) ? undefined : "A region looks like us-central1 or europe-west4.") }));
        if (!typed) return;
        location = typed.trim();
    }

    const cfg: VertexConfig = { project, location, account };
    const check = (label: string) => gcloudStep(app, [theme.permission(bold(label)), theme.muted(`Model catalog for ${project} (nothing is billed)`)], (s): Promise<VertexCheck> => checkVertex(cfg, s));
    let res = await check(`Checking Vertex AI in ${project}…`);
    if (!res) return;
    if (!res.ok && res.apiDisabled) {
        const on = await confirm(
            app,
            `Turn on the Vertex AI API in ${project}?`,
            [theme.muted("It's off in this project. Turning it on is free; only model usage is billed."), theme.muted(`Runs: gcloud services enable aiplatform.googleapis.com --project=${project}`)],
            "Turn it on",
            "Cancel",
        );
        if (!on) return;
        const done = await gcloudStep(app, [theme.permission(bold("Turning on the Vertex AI API…")), theme.muted("This can take a minute.")], (s) => enableVertexApi(account, project!, s).then(() => true));
        if (!done) return;
        // Google says it can take a few minutes to take effect.
        res = await gcloudStep(app, [theme.permission(bold("Waiting for the Vertex AI API to come on…")), theme.muted("Google says this can take a few minutes.")], async (s) => {
            for (let i = 0; ; i++) {
                const r = await checkVertex(cfg, s);
                if (r.ok || !r.apiDisabled || i >= 11 || s.aborted) return r;
                await Bun.sleep(5000);
            }
        });
        if (!res) return;
        if (!res.ok && res.apiDisabled) res = { ok: false, reason: "The API is turned on, but Google hasn't finished switching it on yet.", definitive: false };
    }
    if (!res.ok) {
        if (res.definitive) {
            app.notice(`${redact(res.reason).replace(/[.\s]*$/, ".")} Nothing was saved.`, "error");
            return;
        }
        const save = await confirm(app, "Couldn't check the setup", [theme.warning(redact(res.reason)), "", "Save it anyway?"], "Save anyway", "Cancel");
        if (!save) return;
    }
    try {
        saveVertexConfig(cfg);
    } catch (e) {
        app.notice(redact((e as Error).message), "error");
        return;
    }
    forgetClient("vertex");
    await app.keyChanged("vertex");
    app.print([
        "",
        `${theme.success("✔")} ${bold(def.name)} set up: project ${bold(project)} (${location}), as ${account}`,
        theme.muted(`  Usage is billed to ${project}. Tokens come from gcloud as needed; nothing secret is saved.`),
    ]);
    const listings = await withProgress(app, [theme.permission(bold(`Loading ${def.name} models…`))], () => app.refreshListings());
    const l = listings?.find((x) => x.provider.id === "vertex");
    if (l?.error) app.notice(`Couldn't list ${def.name} models: ${l.error}`, "warn");
    else if (l) app.notice(`${l.models.length} ${def.name} model${l.models.length === 1 ? " is" : "s are"} now in /model.`);
    const pick = defaultModelFrom(l ? [l] : []);
    if (!pick) return;
    if (!app.model) await app.setModel(modelRef(pick), { persist: true });
    else if (app.model.provider !== "vertex" && (await confirm(app, `Switch to ${pick.id} on Vertex AI?`, [theme.muted(`Now: ${app.model.name ?? app.model.id} (${app.model.provider})`)], "Switch", "Keep the current model"))) {
        await app.setModel(modelRef(pick), { persist: true });
    }
}

async function addCustomProvider(app: App) {
    const nameIn = await app.showDialog(new InputDialog({ title: "Custom provider: name", header: [theme.muted("Any OpenAI-compatible (or Anthropic-compatible) API: vLLM, LiteLLM, Azure, a company gateway…")], placeholder: "e.g. My Gateway" }));
    if (!nameIn?.trim()) return;
    const id = nameIn.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!id || BUILTIN_PROVIDERS_IDS().has(id)) {
        app.notice(`"${id}" is reserved or invalid; choose another name.`, "error");
        return;
    }
    const baseUrl = await app.showDialog(
        new InputDialog({
            title: `${nameIn.trim()}: base URL`,
            header: [theme.muted("The API root, e.g. https://llm.example.com/v1 (the part before /chat/completions).")],
            placeholder: "https://…/v1",
            validate: (v) => {
                try {
                    const u = new URL(v.trim());
                    if (u.protocol === "https:") return undefined;
                    if (u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return undefined;
                    return "Use https:// (plain http is only allowed for localhost, so keys aren't sent unencrypted).";
                } catch {
                    return "Not a valid URL.";
                }
            },
        }),
    );
    if (!baseUrl) return;
    const kind = (await app.showDialog(
        new SelectDialog<WireKind>({
            title: "Which API format does it speak?",
            items: [
                { label: "OpenAI Chat Completions", value: "openai", description: "most providers and gateways" },
                { label: "OpenAI Responses API", value: "responses", description: "/v1/responses" },
                { label: "Anthropic Messages API", value: "anthropic", description: "/v1/messages" },
            ],
            numbers: true,
        }),
    )) as WireKind | undefined;
    if (!kind) return;
    const key = await app.showDialog(new InputDialog({ title: `${nameIn.trim()}: API key`, header: [theme.muted("Leave empty if the endpoint needs no key.")], secret: true, placeholder: "(optional, input is hidden)" }));
    if (key === undefined) return;
    const models = await app.showDialog(new InputDialog({ title: "Model ids (optional)", header: [theme.muted("Comma-separated. Only needed if the endpoint has no /models listing.")], placeholder: "model-a, model-b" }));
    if (models === undefined) return;
    const pf = readProvidersFileForUpdate();
    pf.custom = (pf.custom ?? []).filter((c) => c.id !== id);
    pf.custom.push({
        id,
        name: nameIn.trim(),
        baseUrl: baseUrl.trim().replace(/\/+$/, ""),
        kind,
        requiresKey: Boolean(key.trim()),
        models: models
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
    });
    writeProvidersFile(pf);
    if (key.trim()) await setKey(id, key.trim());
    forgetClient(id);
    await app.keyChanged(id);
    app.print(["", `${theme.success("✔")} Added provider ${bold(nameIn.trim())} (${id}) → ${baseUrl.trim()}`]);
    const listings = await withProgress(app, [theme.permission(bold("Loading models…"))], () => app.refreshListings());
    const l = listings?.find((x) => x.provider.id === id);
    if (l?.models.length) app.notice(`${l.models.length} models found. Pick one with /model.`);
    else app.notice(`No models listed${l?.error ? ` (${l.error})` : ""}. Use /model ${id}:<model-id>.`, "warn");
}

function BUILTIN_PROVIDERS_IDS(): Set<string> {
    return new Set([...allProviders().filter((p) => !p.custom).map((p) => p.id), ...SEARCH_PROVIDERS.map((s) => s.id), "custom"]);
}

async function logoutCommand(app: App, args: string) {
    const rows: { id: string; name: string; source?: string; envVar?: string; description?: string }[] = [];
    for (const p of [...allProviders(), ...SEARCH_PROVIDERS.map((s) => ({ id: s.id, name: s.name, auth: undefined }))]) {
        if (p.auth === "gcloud") {
            const cfg = readVertexConfig();
            if (cfg) rows.push({ id: p.id, name: p.name, source: "gcloud", description: `project ${cfg.project} as ${cfg.account} (gcloud stays signed in)` });
            continue;
        }
        if (p.auth === "cli") {
            if (readAgentConfig(p.id)) rows.push({ id: p.id, name: p.name, source: "cli", description: `turn it off here (${p.name} stays signed in)` });
            continue;
        }
        const k = await getKey(p.id);
        if (k) rows.push({ id: p.id, name: p.name, source: k.source, envVar: k.envVar });
    }
    if (!rows.length) {
        app.notice("No API keys are configured.");
        return;
    }
    let id = args.trim().toLowerCase() || undefined;
    if (!id) {
        id = (await app.showDialog(
            new SelectDialog<string>({
                title: "Remove which key?",
                items: rows.map((r) => ({ label: r.name, value: r.id, description: r.description ?? (r.source === "env" ? `from $${r.envVar} (unset it in your shell)` : `stored in ${r.source}`), disabled: r.source === "env" })),
                numbers: true,
            }),
        )) as string | undefined;
        if (!id) return;
    }
    const row = rows.find((r) => r.id === id);
    if (!row) {
        app.notice(`No key stored for "${id}".`, "error");
        return;
    }
    if (row.source === "env") {
        app.notice(`The ${row.name} key comes from $${row.envVar}. Unset it in your shell (and any .env loaded by ${APP_TITLE}) to remove it.`, "warn");
        return;
    }
    if (row.source === "gcloud" || row.source === "cli") {
        try {
            if (row.source === "gcloud") removeVertexConfig();
            else removeAgentConfig(id);
        } catch (e) {
            app.notice(redact((e as Error).message), "error");
            return;
        }
    } else await removeKey(id);
    forgetClient(id);
    const signOut = id === "codex" ? "codex logout" : "claude auth logout";
    app.print([
        "",
        row.source === "gcloud"
            ? `${theme.success("✔")} Removed the ${bold(row.name)} setup ${theme.muted("(gcloud itself stays signed in; gcloud auth revoke signs it out)")}`
            : row.source === "cli"
              ? `${theme.success("✔")} Turned off ${bold(row.name)} ${theme.muted(`(it stays signed in; ${signOut} signs it out)`)}`
              : `${theme.success("✔")} Removed the ${bold(row.name)} key`,
    ]);
    const current = app.model?.provider === id ? app.model.id : undefined;
    await app.keyChanged(id);
    if (current && !app.model) app.notice(`The current model (${current}) used ${row.source === "gcloud" || row.source === "cli" ? "this setup" : "this key"}; pick another with /model.`, "warn");
    void app.refreshListings();
}

async function providersCommand(app: App) {
    const lines = ["", heading("Providers")];
    for (const p of allProviders()) {
        const l = app.listings.find((x) => x.provider.id === p.id);
        const count = l ? ` · ${l.status === "error" ? theme.error("error") : `${l.models.length} models`}` : "";
        if (p.auth === "gcloud") {
            const cfg = readVertexConfig();
            const status = cfg ? theme.success(`✔ gcloud${count}`) : theme.subtle("not set up (/login vertex)");
            lines.push(`  ${padEnd(bold(p.name), 22)}${padEnd(theme.muted(p.id), 14)}${padEnd(status, 34)}${theme.subtle(cfg ? `${cfg.project} (${cfg.location}) as ${cfg.account}` : resolveBaseUrl(p))}`);
            continue;
        }
        if (p.auth === "cli") {
            const on = readAgentConfig(p.id);
            const bin = findCli(p.id, p.id === "codex" ? CODEX_CLI : CLAUDE_CLI);
            const status = on ? theme.success(`✔ on${count}`) : theme.subtle(`off (/login ${p.id})`);
            lines.push(`  ${padEnd(bold(p.name), 22)}${padEnd(theme.muted(p.id), 14)}${padEnd(status, 34)}${theme.subtle(bin ? `your CLI: ${bin}` : "not installed")}`);
            continue;
        }
        const k = p.requiresKey ? await getKey(p.id) : undefined;
        const status = !p.requiresKey ? (l?.status === "offline" || !l ? theme.muted("local · not running") : theme.success(`local · ${l.models.length} models`)) : k ? theme.success(`✔ ${k.source === "env" ? `$${k.envVar}` : k.source}${count}`) : theme.subtle("no key");
        lines.push(`  ${padEnd(bold(p.name), 22)}${padEnd(theme.muted(p.id), 14)}${padEnd(status, 34)}${theme.subtle(resolveBaseUrl(p))}`);
    }
    lines.push("", heading("Web search"));
    for (const s of SEARCH_PROVIDERS) {
        const k = await getKey(s.id);
        lines.push(`  ${padEnd(bold(s.name), 22)}${padEnd(theme.muted(s.id), 14)}${k ? theme.success(`✔ ${k.source === "env" ? `$${k.envVar}` : k.source}`) : theme.subtle("no key")}`);
    }
    lines.push(`  ${padEnd(bold("DuckDuckGo"), 22)}${padEnd(theme.muted("duckduckgo"), 14)}${theme.muted("no key needed (fallback)")}`);
    lines.push("", theme.muted(`Add a key: /login · add any OpenAI-compatible endpoint: /login custom · keys live in ${await storageDescription()}`));
    lines.push(theme.muted(`Use a Claude or ChatGPT subscription through your own installed CLI: /login claude-code · /login codex`));
    app.print(lines);
}

// ---------------------------------------------------------------------------
// /permissions, /mode

const RULE_HELP = [
    theme.muted("Rule syntax:"),
    theme.muted(`  ${bold("Bash(npm test:*)")}  commands starting with "npm test"    ${bold("Bash(git status)")}  exact command`),
    theme.muted(`  ${bold("Edit(src/**)")}  edits under src/    ${bold("Read(~/.config/**)")}  reads outside the project`),
    theme.muted(`  ${bold("WebFetch(domain:docs.python.org)")}    ${bold("mcp__github")}  every tool of an MCP server    ${bold("Bash")}  the whole tool`),
];

async function permissionsCommand(app: App) {
    for (;;) {
        type V = { action: "add" } | { action: "remove"; scope: SettingsScope | "session"; rule: string } | { action: "mode" };
        const items: SelectItem<V>[] = [
            { label: theme.success("+ Add a rule…"), value: { action: "add" } },
            { label: `Mode: ${MODE_INFO[app.mode].color(MODE_INFO[app.mode].label)}`, value: { action: "mode" }, description: "change the permission mode" },
        ];
        for (const list of ["deny", "ask", "allow"] as const) {
            for (const scope of ["local", "project", "user"] as SettingsScope[]) {
                const s = loadScope(scope, app.cwd);
                for (const rule of s.permissions?.[list] ?? []) {
                    const color = list === "deny" ? theme.error : list === "ask" ? theme.warning : theme.success;
                    items.push({ label: `${color(list.padEnd(5))} ${rule}`, value: { action: "remove", scope, rule }, detail: scope, group: `${list[0]!.toUpperCase()}${list.slice(1)} rules` });
                }
            }
        }
        for (const rule of app.checker.sessionAllow) items.push({ label: `${theme.success("allow")} ${rule}`, value: { action: "remove", scope: "session", rule }, detail: "this session", group: "Allow rules" });
        if (!app.init.trusted && existsSync(settingsPath("project", app.cwd))) items.push({ label: theme.warning("Project settings are ignored until you trust this folder (only its deny/ask rules apply)."), value: { action: "mode" }, disabled: true });
        const d = new SelectDialog<V>({
            title: "Permissions",
            header: [theme.muted("Deny rules always win, then ask, then allow. Select a rule to remove it."), ...RULE_HELP],
            items,
            searchable: false,
            numbers: false,
            maxRows: 16,
        });
        const v = (await app.showDialog(d)) as V | undefined;
        if (!v) return;
        if (v.action === "mode") {
            await modeCommand(app, "");
            continue;
        }
        if (v.action === "remove") {
            if (!(await confirm(app, `Remove rule ${v.rule}?`, [theme.muted(`from ${v.scope === "session" ? "this session" : scopeLabel(v.scope, app.cwd)}`)]))) continue;
            if (v.scope === "session") app.checker.sessionAllow = app.checker.sessionAllow.filter((r) => r !== v.rule);
            else removePermissionRule(v.scope, app.cwd, v.rule);
            app.reloadSettings();
            continue;
        }
        const list = (await app.showDialog(
            new SelectDialog<"allow" | "ask" | "deny">({
                title: "Rule type",
                items: [
                    { label: theme.success("Allow"), value: "allow", description: "run without asking" },
                    { label: theme.warning("Ask"), value: "ask", description: "always ask, even in accept-edits/auto modes" },
                    { label: theme.error("Deny"), value: "deny", description: "never allow, in every mode" },
                ],
                numbers: true,
            }),
        )) as "allow" | "ask" | "deny" | undefined;
        if (!list) continue;
        const rule = await app.showDialog(
            new InputDialog({
                title: `New ${list} rule`,
                header: RULE_HELP,
                placeholder: "Bash(npm run test:*)",
                validate: (r) => {
                    const t = r.trim();
                    if (!t) return "Enter a rule.";
                    if (!/^[A-Za-z_][A-Za-z0-9_]*(\(.*\))?$/.test(t)) return 'Rules look like Tool or Tool(specifier), e.g. "Bash(git diff:*)".';
                    try {
                        parseRule(t);
                    } catch (e) {
                        return (e as Error).message;
                    }
                    return undefined;
                },
            }),
        );
        if (!rule) continue;
        const scope = (await app.showDialog(
            new SelectDialog<SettingsScope>({
                title: "Save the rule where?",
                items: [
                    { label: "This project, just me", value: "local", description: displayPath(settingsPath("local", app.cwd), app.cwd) },
                    { label: "This project, shared", value: "project", description: displayPath(settingsPath("project", app.cwd), app.cwd) },
                    { label: "All my projects", value: "user", description: displayPath(settingsPath("user", app.cwd), app.cwd) },
                ],
                numbers: true,
            }),
        )) as SettingsScope | undefined;
        if (!scope) continue;
        addPermissionRule(scope, app.cwd, list, rule.trim());
        app.reloadSettings();
        app.print(["", `${theme.success("✔")} Added ${list} rule ${bold(rule.trim())} to ${scopeLabel(scope, app.cwd)}`]);
    }
}

async function modeCommand(app: App, args: string) {
    const allowBypass = app.bypassAllowed();
    let mode: PermissionMode | undefined;
    if (args) {
        mode = parseMode(args);
        if (!mode) {
            app.notice(`Unknown mode "${args}". Modes: manual, acceptEdits, plan, auto, bypass.`, "error");
            return;
        }
    } else {
        mode = (await app.showDialog(
            new SelectDialog<PermissionMode>({
                title: "Permission mode",
                header: [theme.muted("shift+tab cycles through these from the prompt.")],
                items: PERMISSION_MODES.map((m) => ({
                    label: MODE_INFO[m].color(MODE_INFO[m].label),
                    value: m,
                    description: m === "bypassPermissions" && !allowBypass ? "start with --dangerously-skip-permissions to enable" : MODE_INFO[m].description,
                    disabled: m === "bypassPermissions" && !allowBypass,
                })),
                initial: PERMISSION_MODES.indexOf(app.mode),
                current: (v) => v === app.mode,
                numbers: true,
            }),
        )) as PermissionMode | undefined;
        if (!mode) return;
    }
    if (!app.setMode(mode)) return;
    app.print(["", `${MODE_INFO[mode].color(MODE_INFO[mode].symbol || "●")} ${bold(MODE_INFO[mode].label)} ${theme.muted(MODE_INFO[mode].description)}`]);
}

// ---------------------------------------------------------------------------
// Session commands

async function resumeCommand(app: App, args: string) {
    let file: string | undefined;
    if (args) {
        file = findSession(app.cwd, args.trim());
        if (!file) {
            app.notice(`No session matching "${args}" in this project.`, "error");
            return;
        }
    } else {
        const sessions = listSessions(app.cwd, 200).filter((s) => s.id !== app.session.meta.id);
        if (!sessions.length) {
            app.notice("No earlier sessions in this project.");
            return;
        }
        file = (await app.showDialog(
            new SelectDialog<string>({
                title: "Resume a session",
                items: sessions.map((s) => ({ label: truncate(s.title, 70), value: s.file, detail: `${ago(s.updatedAt)} · ${s.messages} msgs`, keywords: s.id })),
                searchable: true,
                maxRows: 14,
            }),
        )) as string | undefined;
        if (!file) return;
    }
    app.resume(file);
}

function costCommand(app: App) {
    const s = app.session;
    const lines = ["", heading("Session cost")];
    if (!s.usageByModel.size) lines.push(theme.muted("  No API usage yet."));
    for (const [model, { usage, cost }] of s.usageByModel) {
        lines.push(`  ${bold(model)}`);
        lines.push(
            theme.muted(
                `    input ${formatTokens(usage.inputTokens)} · cache read ${formatTokens(usage.cacheReadTokens ?? 0)} · cache write ${formatTokens(usage.cacheWriteTokens ?? 0)} · output ${formatTokens(usage.outputTokens)}  →  ${formatUsd(cost)}`,
            ),
        );
    }
    lines.push(kv("Total", bold(formatUsd(s.cost)), 10), kv("Wall time", formatDuration(Date.now() - s.meta.createdAt), 10));
    lines.push(theme.subtle("  Prices come from each provider's model listing (or OpenRouter's catalog when marked ~); treat them as estimates."));
    app.print(lines);
}

async function statusCommand(app: App) {
    const m = app.model;
    const def = m ? getProvider(m.provider) : undefined;
    const vertex = def?.auth === "gcloud" ? readVertexConfig() : undefined;
    const key = def?.requiresKey && !def.auth ? await getKey(def.id) : undefined;
    const servers = [...app.mcp.servers.values()];
    const memory = loadMemory(app.cwd);
    const lines = [
        "",
        heading(`${APP_TITLE} v${APP_VERSION}`),
        kv("Session", `${app.session.meta.id}${app.session.title ? ` · ${app.session.title}` : ""}`),
        kv("Directory", displayPath(app.cwd, process.env.HOME ?? "/") + (app.init.trusted ? "" : theme.warning(" (not trusted: project config ignored)"))),
        ...(app.settings.permissions?.additionalDirectories ?? []).map((d) => kv("", theme.muted(`+ ${d}`))),
        kv("Model", m ? `${m.name ?? m.id} ${theme.muted(`(${modelRef(m)})`)}` : theme.warning("none — run /login")),
        kv("Provider", def ? `${def.name} · ${def.auth === "cli" ? (findCli(def.id, def.id === "codex" ? CODEX_CLI : CLAUDE_CLI) ?? theme.warning("CLI not found")) : vertex ? vertexBaseUrl(vertex) : resolveBaseUrl(def)}` : "—"),
        def?.auth === "cli"
            ? kv("Credentials", `${def.name}'s own sign-in ${theme.muted(`(${APP_TITLE} never sees it)`)}`)
            : vertex
            ? kv("Credentials", `gcloud token for ${vertex.account} ${theme.muted(`· billed to project ${vertex.project}`)}`)
            : kv("API key", key ? `${maskKey(key.value)} ${theme.muted(`from ${key.source === "env" ? `$${key.envVar}` : key.source}`)}` : def?.requiresKey === false ? theme.muted("not needed") : "—"),
        kv("Context window", m?.contextWindow ? formatTokens(m.contextWindow) : theme.muted("unknown")),
        kv("Effort", app.settings.effort ?? theme.muted("model default")),
        kv("Thinking text", app.settings.showThinking ? "shown" : theme.muted("hidden (summaries only)")),
        kv("Permission mode", MODE_INFO[app.mode].color(MODE_INFO[app.mode].label)),
        kv("MCP servers", servers.length ? servers.map((s) => `${s.name} ${s.status === "connected" ? theme.success("✔") : s.status === "failed" ? theme.error("✘") : theme.muted(s.status)}`).join(", ") : theme.muted("none")),
        kv("Memory files", memory.length ? memory.map((f) => displayPath(f.path, app.cwd)).join(", ") : theme.muted("none (/init creates HARNESS.md)")),
        kv("Settings", (["user", "project", "local"] as SettingsScope[]).filter((s) => existsSync(settingsPath(s, app.cwd))).map((s) => displayPath(settingsPath(s, app.cwd), app.cwd)).join(", ") || theme.muted("defaults")),
        kv("Cost so far", formatUsd(app.session.cost)),
    ];
    app.print(lines);
}

function contextCommand(app: App) {
    const m = app.model;
    const win = m?.contextWindow;
    const sys = Math.ceil((app.agent?.systemPrompt() ?? app.session.meta.system ?? "").length / 3.5);
    const tools = Math.ceil(JSON.stringify(app.tools().map(toSchema)).length / 3.5);
    const msgs = estimateTokens(app.session.messages);
    const measured = app.agent?.contextTokens ?? 0;
    const total = measured || sys + tools + msgs;
    const lines = ["", heading("Context usage")];
    if (win) {
        const W = Math.min(50, termCols() - 20);
        const cell = (n: number) => Math.round((n / win) * W);
        const parts = [
            { n: sys, c: theme.accent, label: "System prompt" },
            { n: tools, c: theme.info, label: "Tool definitions" },
            { n: Math.max(0, total - sys - tools), c: theme.success, label: "Messages" },
        ];
        let bar = "";
        for (const p of parts) bar += p.c("█".repeat(cell(p.n)));
        bar += theme.subtle("░".repeat(Math.max(0, W - width(bar))));
        lines.push(`  ${bar}  ${bold(`${Math.round((total / win) * 100)}%`)} ${theme.muted(`of ${formatTokens(win)}`)}`);
        for (const p of parts) lines.push(`  ${p.c("█")} ${padEnd(p.label, 18)}${formatTokens(p.n)}`);
        const threshold = app.settings.autoCompactThreshold ?? 0.92;
        lines.push(theme.muted(`  Auto-compact ${app.settings.autoCompact === false ? "off" : `at ~${Math.round(threshold * 100)}%`} · /compact to summarize now`));
    } else lines.push(kv("Estimated", formatTokens(total)), theme.muted("  (this model's context window is unknown)"));
    if (!measured) lines.push(theme.subtle("  Estimates (≈3.5 chars/token) until the first response reports real usage."));
    if (!app.session.meta.system) lines.push(theme.subtle("  The system prompt is built when you send the first message."));
    app.print(lines);
}

async function exportCommand(app: App, args: string) {
    const out: string[] = [`# ${APP_TITLE} session ${app.session.meta.id}`, "", `- Directory: ${app.cwd}`, `- Model: ${app.session.model ?? "?"}`, `- Exported: ${new Date().toISOString()}`, ""];
    for (const msg of app.session.messages) {
        if (msg.role === "user") {
            const kind = msg.meta?.kind ?? "prompt";
            if (kind === "tool_results") {
                for (const p of msg.content) if (p.type === "tool_result") out.push(`<details><summary>Result: ${p.toolName}${p.isError ? " (error)" : ""}</summary>`, "", "```", truncate(typeof p.content === "string" ? p.content : "", 4000), "```", "</details>", "");
                continue;
            }
            const t = (msg.meta?.display ?? textOf(msg)).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            if (t) out.push(kind === "summary" ? "## Summary of earlier conversation" : "## User", "", t, "");
        } else {
            const t = textOf(msg).trim();
            if (t) out.push("## Assistant", "", t, "");
            for (const p of msg.content) if (p.type === "tool_call") out.push(`**${p.name}** \`${truncate(JSON.stringify(p.input), 300)}\``, "");
        }
    }
    const text = redact(out.join("\n"));
    if (args.trim() === "--copy" || args.trim() === "clipboard") {
        app.notice(`Copied the conversation to the ${await copyToClipboard(text)}.`);
        return;
    }
    let file = args.trim() ? expandPath(args.trim(), app.cwd) : join(app.cwd, `harness-${app.session.meta.id}.md`);
    if (existsSync(file) && !(await confirm(app, `Overwrite ${displayPath(file, app.cwd)}?`))) return;
    writeFileSync(file, text);
    app.notice(`Exported the conversation to ${displayPath(file, app.cwd)}`);
}

// ---------------------------------------------------------------------------
// Settings-ish commands

async function effortCommand(app: App, args: string) {
    const set = (e: Effort | undefined) => {
        app.settings.effort = e;
        updateSettings("user", app.cwd, (s) => (s.effort = e));
        const levels = app.model?.effortLevels;
        const note = e && levels?.length && !levels.includes(e) ? theme.muted(` (${app.model!.id} doesn't support ${e}; the nearest level is used)`) : "";
        app.print(["", `${theme.success("✔")} Effort set to ${bold(e ?? "model default")}${note}`]);
    };
    if (args) {
        const a = args.trim().toLowerCase();
        if (["default", "auto", "none", "unset"].includes(a)) return set(undefined);
        if ((EFFORT_LEVELS as string[]).includes(a)) return set(a as Effort);
        app.notice(`Effort must be one of ${EFFORT_LEVELS.join(", ")} or default.`, "error");
        return;
    }
    const desc: Record<Effort, string> = {
        low: "fastest and cheapest; little reasoning",
        medium: "balanced speed and depth",
        high: "thorough reasoning; good for most coding",
        xhigh: "extra reasoning for hard problems",
        max: "maximum reasoning; slowest and most expensive",
    };
    type V = Effort | "default";
    const levels = app.model?.effortLevels;
    const v = (await app.showDialog(
        new SelectDialog<V>({
            title: "Reasoning effort",
            header: [theme.muted(levels?.length ? `${app.model!.id} supports: ${levels.join(", ")}` : "Applies to models that support reasoning; others ignore it.")],
            items: [{ label: "Model default", value: "default" as V, description: "let the provider decide" }, ...EFFORT_LEVELS.map((e) => ({ label: e, value: e as V, description: desc[e], disabled: Boolean(levels?.length && !levels.includes(e)) }))],
            current: (x) => (x === "default" ? !app.settings.effort : x === app.settings.effort),
            numbers: true,
        }),
    )) as V | undefined;
    if (!v) return;
    set(v === "default" ? undefined : v);
}

async function configCommand(app: App) {
    let index = 0;
    for (;;) {
        type K = "showThinking" | "autoCompact" | "webSearch" | "notifications" | "defaultMode" | "allowBypass" | "smallModel" | "verbose";
        const s = app.settings;
        const onOff = (b: boolean | undefined) => (b ? theme.success("on") : theme.muted("off"));
        const items: SelectItem<K>[] = [
            { label: "Show thinking text", value: "showThinking", detail: onOff(s.showThinking), description: "full reasoning text when the provider returns it" },
            { label: "Auto-compact", value: "autoCompact", detail: onOff(s.autoCompact !== false), description: "summarize the conversation near the context limit" },
            { label: "Web search backend", value: "webSearch", detail: s.webSearch ?? "auto", description: "auto · anthropic · brave · tavily · duckduckgo · off" },
            { label: "Notifications", value: "notifications", detail: notificationMode(s), description: `auto · terminal · bell · system · off (prompts, turns over ${notifyAfterMs(s) / 1000}s)` },
            { label: "Default permission mode", value: "defaultMode", detail: MODE_INFO[s.permissions?.defaultMode ?? "default"].label, description: "mode at startup" },
            { label: "Bypass in shift+tab cycle", value: "allowBypass", detail: onOff(s.permissions?.allowBypass), description: "lets shift+tab reach bypass permissions" },
            { label: "Small model", value: "smallModel", detail: s.smallModel ?? "auto", description: "for the auto-mode classifier and summaries" },
            { label: "Verbose output", value: "verbose", detail: onOff(app.verbose), description: "this session only (ctrl+o)" },
        ];
        const d = new SelectDialog<K>({ title: "Settings", header: [theme.muted(`Saved to ${displayPath(settingsPath("user", app.cwd), app.cwd)}. Enter to change.`)], items, initial: index, numbers: true });
        const k = (await app.showDialog(d)) as K | undefined;
        if (!k) return;
        index = items.findIndex((i) => i.value === k);
        const save = (fn: (x: Settings) => void) => {
            updateSettings("user", app.cwd, fn);
            app.reloadSettings();
        };
        switch (k) {
            case "showThinking":
                save((x) => (x.showThinking = !s.showThinking));
                break;
            case "autoCompact":
                save((x) => (x.autoCompact = s.autoCompact === false));
                break;
            case "webSearch": {
                const order = ["auto", "anthropic", "brave", "tavily", "duckduckgo", "off"] as const;
                const next = order[(order.indexOf(s.webSearch ?? "auto") + 1) % order.length]!;
                save((x) => (x.webSearch = next));
                if (app.agent) app.agent.options.nativeWebSearch = app.tools().every((t) => t.name !== "WebSearch") && next !== "off";
                break;
            }
            case "notifications": {
                const order = ["auto", "terminal", "bell", "system", "off"] as const;
                const next = order[(order.indexOf(notificationMode(s)) + 1) % order.length]!;
                save((x) => (x.notifications = next));
                break;
            }
            case "defaultMode": {
                const order: PermissionMode[] = ["default", "acceptEdits", "plan", "auto"];
                const cur = s.permissions?.defaultMode ?? "default";
                const next = order[(order.indexOf(cur) + 1) % order.length]!;
                save((x) => ((x.permissions ??= {}).defaultMode = next));
                break;
            }
            case "allowBypass":
                save((x) => ((x.permissions ??= {}).allowBypass = !s.permissions?.allowBypass));
                break;
            case "smallModel": {
                const items2: SelectItem<string>[] = [{ label: "Auto", value: "", description: "the cheapest model from the current provider" }, ...(await modelItems(app)).filter((i) => !i.value.startsWith("login:") && !i.disabled)];
                const pick = (await app.showDialog(new SelectDialog<string>({ title: "Small model", items: items2, searchable: true, current: (v) => v === (s.smallModel ?? "") }))) as string | undefined;
                if (pick !== undefined) save((x) => (x.smallModel = pick || undefined));
                break;
            }
            case "verbose":
                app.verbose = !app.verbose;
                break;
        }
    }
}

async function mcpCommand(app: App, args: string) {
    const [sub, name] = args.split(/\s+/);
    if (sub === "reconnect" && name) {
        await app.mcp.restart(name);
        return;
    }
    for (;;) {
        const servers = [...app.mcp.servers.values()];
        if (!servers.length) {
            app.print([
                "",
                heading("MCP servers"),
                theme.muted("  None configured. Add one with:"),
                `    ${bold("harness mcp add <name> -- <command> [args…]")}        ${theme.muted("(stdio)")}`,
                `    ${bold("harness mcp add --transport http <name> <url>")}   ${theme.muted("(HTTP)")}`,
                theme.muted(`  or edit "mcpServers" in ${displayPath(paths.userSettings(), app.cwd)} / a project .mcp.json.`),
            ]);
            return;
        }
        const statusText = (s: (typeof servers)[number]) => {
            switch (s.status) {
                case "connected":
                    return theme.success(`✔ connected · ${s.tools.length} tools${s.era ? ` · ${s.era}` : ""}`);
                case "failed":
                    return theme.error(`✘ failed: ${truncate((s.error ?? "").split("\n")[0]!, 60)}`);
                case "needs-approval":
                    return theme.warning("needs approval");
                case "connecting":
                case "pending":
                    return theme.muted("connecting…");
                default:
                    return theme.muted(s.status);
            }
        };
        const pick = (await app.showDialog(
            new SelectDialog<string>({
                title: "MCP servers",
                items: servers.map((s) => ({ label: bold(s.name), value: s.name, description: statusText(s), detail: s.source === "project" ? ".mcp.json" : "settings" })),
                numbers: true,
            }),
        )) as string | undefined;
        if (!pick) return;
        const st = app.mcp.servers.get(pick);
        if (!st) continue;
        type A = "approve" | "reject" | "reconnect" | "tools" | "error" | "disable" | "enable";
        const actions: SelectItem<A>[] = [];
        const cfgLine = st.config.url ? `${st.config.url}` : `${st.config.command ?? ""} ${(st.config.args ?? []).join(" ")}`;
        if (st.status === "needs-approval") actions.push({ label: "Approve and connect", value: "approve", description: "saved to this project's local settings" }, { label: "Reject", value: "reject" });
        if (st.status === "connected") actions.push({ label: "Show tools", value: "tools" }, { label: "Reconnect", value: "reconnect" }, { label: "Disable for this session", value: "disable" });
        if (st.status === "failed") actions.push({ label: "Show error", value: "error" }, { label: "Reconnect", value: "reconnect" });
        if (st.status === "disabled") actions.push({ label: "Enable", value: "enable" });
        const a = (await app.showDialog(new SelectDialog<A>({ title: st.name, header: [theme.muted(truncate(cfgLine, 200)), theme.muted(`source: ${st.source === "project" ? ".mcp.json (project)" : "settings"}`)], items: actions, numbers: true }))) as A | undefined;
        if (!a) continue;
        if (a === "approve" || a === "enable") {
            if (st.source === "project") {
                if (a === "approve" && !(await confirm(app, `Allow ${st.name} to run?`, [theme.warning("MCP servers run with your user permissions. Only approve servers you trust."), theme.muted(truncate(cfgLine, 200))]))) continue;
                updateSettings("local", app.cwd, (s) => {
                    s.enabledMcpjsonServers = [...new Set([...(s.enabledMcpjsonServers ?? []), st.name])];
                    s.disabledMcpjsonServers = (s.disabledMcpjsonServers ?? []).filter((n) => n !== st.name);
                });
                app.reloadSettings();
                app.mcp.load();
            } else st.status = "pending";
            const s2 = app.mcp.servers.get(st.name);
            if (s2) await app.mcp.start(s2);
        } else if (a === "reject") {
            updateSettings("local", app.cwd, (s) => {
                s.disabledMcpjsonServers = [...new Set([...(s.disabledMcpjsonServers ?? []), st.name])];
                s.enabledMcpjsonServers = (s.enabledMcpjsonServers ?? []).filter((n) => n !== st.name);
            });
            app.reloadSettings();
            app.mcp.load();
        } else if (a === "reconnect") {
            await withProgress(app, [theme.permission(bold(`Reconnecting ${st.name}…`))], () => app.mcp.restart(st.name));
        } else if (a === "disable") {
            await st.client?.close();
            st.client = undefined;
            st.status = "disabled";
        } else if (a === "tools") {
            app.print(["", heading(`${st.name} tools`), ...st.tools.map((t) => `  ${bold(t.name)}${t.annotations?.readOnlyHint ? theme.muted(" (read-only)") : ""} ${theme.muted(truncate((t.description ?? "").split("\n")[0]!, termCols() - t.name.length - 20))}`)]);
            return;
        } else if (a === "error") {
            app.print(["", heading(`${st.name} error`), ...(st.error ?? "").split("\n").map((l) => theme.error("  " + l))]);
            return;
        }
    }
}

async function memoryCommand(app: App) {
    const files = loadMemory(app.cwd);
    const root = gitRoot(app.cwd) ?? app.cwd;
    const candidates: SelectItem<string>[] = [
        ...files.map((f) => ({ label: displayPath(f.path, app.cwd), value: f.path, description: `${f.scope} · ${Math.round(f.content.length / 100) / 10} KB` })),
    ];
    for (const [label, p] of [
        ["Project memory (HARNESS.md)", join(root, "HARNESS.md")],
        ["Local project memory (HARNESS.local.md)", join(root, "HARNESS.local.md")],
        ["User memory", paths.userMemory()],
    ] as const) {
        if (!files.some((f) => f.path === p)) candidates.push({ label: theme.muted(`+ ${label}`), value: p, description: "create" });
    }
    const pick = (await app.showDialog(new SelectDialog<string>({ title: "Memory files", header: [theme.muted("Loaded into the system prompt at the start of a session. Select one to edit in $EDITOR.")], items: candidates, numbers: true }))) as string | undefined;
    if (!pick) return;
    const before = existsSync(pick) ? readFileSync(pick, "utf-8") : "";
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    await app.screen.suspend(() => {
        spawnSync(["sh", "-c", `${editor} "$1"`, "sh", pick], { stdio: ["inherit", "inherit", "inherit"], env: childEnv() });
    });
    const after = existsSync(pick) ? readFileSync(pick, "utf-8") : "";
    if (after !== before) {
        app.notice(`Updated ${displayPath(pick, app.cwd)}`);
        app.agent?.addReminder(`The user edited the memory file ${displayPath(pick, app.cwd)}. Its current contents (these instructions take precedence over the earlier version):\n${after.slice(0, 40_000)}`);
    }
    app.renderLive();
}

function agentsCommand(app: App) {
    const agents = loadAgents(app.cwd);
    const lines = ["", heading("Sub-agents"), theme.muted("  The model starts these with the Task tool.")];
    for (const a of agents) {
        lines.push(`  ${bold(a.name)} ${theme.muted(`(${a.source}${a.readOnly ? ", read-only" : ""}${a.model ? `, ${a.model}` : ""})`)}`);
        lines.push(theme.muted(`    ${truncate(a.description, termCols() - 8)}`));
        if (a.tools?.length) lines.push(theme.subtle(`    tools: ${a.tools.join(", ")}`));
    }
    if (agents.length === BUILTIN_AGENTS.length) lines.push("", theme.muted(`  Add your own as markdown files in ${displayPath(paths.userAgents(), app.cwd)}/ or .harness/agents/ (frontmatter: name, description, tools, model).`));
    app.print(lines);
}

function hooksCommand(app: App) {
    const h = app.settings.hooks ?? {};
    const lines = ["", heading("Hooks")];
    let any = false;
    for (const event of HOOK_EVENTS) {
        const list = h[event] ?? [];
        if (!list.length) continue;
        any = true;
        lines.push(`  ${bold(event)}${BLOCKING_EVENTS.has(event) ? "" : theme.subtle(" (informational)")}`);
        for (const x of list) lines.push(`    ${theme.muted(x.matcher ? `[${x.matcher}]` : "[*]")} ${x.command}${x.timeout ? theme.subtle(` (timeout ${x.timeout}s)`) : ""}`);
    }
    if (!any) lines.push(theme.muted("  None configured."));
    lines.push(
        theme.muted(`  Configure under "hooks" in settings. A hook gets JSON on stdin; exit code 2 blocks the action and shows stderr to the model (informational events can't block).`),
        ...(app.init.trusted ? [] : [theme.warning("  This folder isn't trusted, so project hooks are ignored.")]),
    );
    app.print(lines);
}

async function doctorCommand(app: App) {
    const ok = (s: string) => `  ${theme.success("✔")} ${s}`;
    const bad = (s: string) => `  ${theme.error("✘")} ${s}`;
    const warn = (s: string) => `  ${theme.warning("!")} ${s}`;
    const lines = ["", heading("Doctor")];
    lines.push(ok(`Bun ${Bun.version} on ${process.platform}/${process.arch}`));
    lines.push(process.stdout.isTTY ? ok(`Terminal ${process.stdout.columns}×${process.stdout.rows} (${process.env.TERM_PROGRAM ?? process.env.TERM ?? "unknown"})`) : warn("stdout is not a TTY"));
    lines.push(ok(`Keys are stored in ${await storageDescription()}`));
    lines.push(Bun.which("git") ? ok("git found") : warn("git not found: git context and @-file completion are limited"));
    lines.push(Bun.which("rg") ? ok("ripgrep found (fast Grep)") : warn("ripgrep (rg) not found: Grep falls back to a slower built-in search"));
    const sandbox = sandboxKind();
    if (app.settings.sandbox === false) lines.push(warn('The auto-mode sandbox is off ("sandbox": false): auto mode sends every shell command to its reviewer'));
    else if (sandbox && sandboxEnabled(app.settings.sandbox)) lines.push(ok(`Auto mode runs shell commands in a sandbox (${sandbox === "seatbelt" ? "Seatbelt" : "bubblewrap, experimental"})`));
    else if (sandbox === "bwrap") lines.push(warn('bubblewrap is here, but the Linux sandbox is experimental and off unless "sandbox": true: auto mode sends every shell command to its reviewer'));
    else lines.push(warn(`No sandbox here${process.platform === "linux" ? " (install bubblewrap, and allow unprivileged user namespaces)" : ""}: auto mode sends every shell command to its reviewer`));
    for (const scope of ["user", "project", "local"] as SettingsScope[]) {
        const f = settingsPath(scope, app.cwd);
        if (!existsSync(f)) continue;
        try {
            // The settings loader's parser: comments and trailing commas are fine.
            readJsonForUpdate(f);
            lines.push(ok(`${displayPath(f, app.cwd)} parses`));
        } catch (e) {
            lines.push(bad(`${displayPath(f, app.cwd)}: ${e instanceof JsonFileError ? e.reason : (e as Error).message}`));
        }
    }
    if (existsSync(paths.credentialsFile())) {
        const mode = statSync(paths.credentialsFile()).mode & 0o777;
        lines.push(mode & 0o077 ? bad(`${paths.credentialsFile()} is readable by others (mode ${mode.toString(8)})`) : ok(`${displayPath(paths.credentialsFile(), app.cwd)} is private (600)`));
    }
    lines.push(isTrusted(app.cwd) ? ok("This folder is trusted") : warn("This folder isn't trusted: project settings, hooks and .mcp.json servers are ignored"));
    app.print(lines);
    const listings = await withProgress(app, [theme.permission(bold("Checking providers…"))], () => app.refreshListings(true));
    const out: string[] = [];
    for (const l of (listings ?? []) as ProviderListing[]) {
        if (l.status === "ok" || l.status === "cached") out.push(ok(`${l.provider.name}: ${l.models.length} models`));
        else if (l.status === "offline") continue;
        else out.push(bad(`${l.provider.name}: ${l.error ?? l.status}`));
    }
    if (!out.length) out.push(warn("No providers configured; run /login"));
    for (const s of app.mcp.servers.values()) out.push(s.status === "connected" ? ok(`MCP ${s.name}: ${s.tools.length} tools`) : s.status === "failed" ? bad(`MCP ${s.name}: ${(s.error ?? "").split("\n")[0]}`) : warn(`MCP ${s.name}: ${s.status}`));
    app.print(out);
}

async function bashesCommand(app: App) {
    const shells = [...app.toolState.shells.values()];
    if (!shells.length) {
        app.notice("No background shells.");
        return;
    }
    const pick = (await app.showDialog(
        new SelectDialog<string>({
            title: "Background shells",
            items: shells.map((s) => ({ label: truncate(s.command, 60), value: s.id, description: s.exitCode === null ? theme.success("running") : theme.muted(`exited ${s.exitCode}`), detail: formatDuration(Date.now() - s.startedAt) })),
            numbers: true,
        }),
    )) as string | undefined;
    if (!pick) return;
    const sh = app.toolState.shells.get(pick);
    if (!sh) return;
    const tail = redact(sh.output).split("\n").slice(-20);
    app.print(["", heading(`${sh.id}: ${truncate(sh.command, 80)}`), ...tail.map((l) => theme.muted("  " + l))]);
    if (sh.exitCode === null && (await confirm(app, `Stop ${sh.id}?`))) {
        const how = await sh.kill();
        app.toolState.shells.delete(sh.id);
        app.notice(how === "killed" ? `Stopped ${sh.id} (it ignored SIGTERM, so it was force-killed)` : `Stopped ${sh.id}`);
    }
}

async function addDirCommand(app: App, args: string) {
    if (!args) {
        app.notice("Usage: /add-dir <path>", "error");
        return;
    }
    const dir = resolve(expandPath(args.trim(), app.cwd));
    if (!existsSync(dir) || !statSync(dir).isDirectory()) {
        app.notice(`${dir} is not a directory.`, "error");
        return;
    }
    (app.init.addDirs ??= []).push(dir);
    app.reloadSettings();
    const remember = await confirm(app, `Added ${dir} for this session. Remember it for this project?`, [], "Yes, save to local settings", "No, just this session");
    if (remember) updateSettings("local", app.cwd, (s) => ((s.permissions ??= {}).additionalDirectories = [...new Set([...(s.permissions?.additionalDirectories ?? []), dir])]));
    app.agent?.addReminder(`The user added ${dir} as an additional working directory; you may read and edit files there.`);
    app.notice(`${APP_TITLE} can now read and edit files in ${dir}`);
}

// ---------------------------------------------------------------------------
// Prompts

const INIT_PROMPT = `Please analyze this codebase and create a HARNESS.md file at the repository root. It will be loaded into your context in future sessions in this repository.

What to include:
1. Commands that are commonly used: how to build, lint, run the tests, and run a single test.
2. High-level architecture and code structure: the "big picture" that takes reading several files to understand.

Guidelines:
- If a HARNESS.md, CLAUDE.md or AGENTS.md already exists, suggest improvements to it instead of starting over.
- Don't repeat yourself, and don't include obvious instructions ("write clean code", "handle errors") or generic advice.
- Don't list every file or component; those are easy to discover.
- Include important parts of the README, and of any Cursor rules (.cursor/rules/, .cursorrules) or Copilot rules (.github/copilot-instructions.md).
- Don't make up information that isn't backed by the files you read.
- Start the file with a one-line title and a short note that this file guides coding agents working in this repository.`;

function reviewPrompt(args: string): string {
    if (/^#?\d+$/.test(args.trim())) {
        const n = args.trim().replace("#", "");
        return `Review pull request #${n}. Use \`gh pr view ${n}\` and \`gh pr diff ${n}\` to read it. Look for bugs, security problems, missing error handling, behavior changes the description doesn't mention, and missing tests. For each finding give the file and line, why it's a problem, and a concrete fix. Verify each finding against the code before reporting it; leave out style nits. Do not modify any files.`;
    }
    return `Review the changes in this repository${args ? ` (focus: ${args})` : ""}. Start with \`git status\`, \`git diff\` and \`git diff --staged\`; if the working tree is clean, review the current branch against its base (\`git log --oneline main..HEAD\`, \`git diff main...HEAD\`, adapting the base branch name). Look for bugs, regressions, security problems, missing error handling, and missing tests. For each finding give the file and line, why it's a problem, and a concrete fix. Verify each finding against the code before reporting it; leave out style nits. Do not modify any files.`;
}

// ---------------------------------------------------------------------------
// Registry

const BUILTIN: Command[] = [
    { name: "help", aliases: ["?"], description: "Show commands and shortcuts", whileBusy: true, run: (app) => helpCommand(app) },
    { name: "model", description: "Pick a model from every configured provider", args: "[provider:model]", run: modelCommand },
    { name: "login", description: "Add an API key (any provider, auto-detected)", args: "[provider|custom]", run: loginCommand },
    { name: "logout", description: "Remove a stored API key", run: logoutCommand },
    { name: "providers", description: "Providers, key status and endpoints", whileBusy: true, run: (app) => providersCommand(app) },
    { name: "effort", description: "Set reasoning effort (low … max)", args: "[level]", run: effortCommand },
    { name: "permissions", aliases: ["allowed-tools"], description: "View and edit allow / ask / deny rules", run: permissionsCommand },
    { name: "mode", description: "Switch permission mode (manual, accept edits, plan, auto, bypass)", args: "[mode]", whileBusy: true, run: modeCommand },
    {
        name: "plan",
        description: "Enter plan mode (optionally with a task)",
        args: "[task]",
        noEcho: true,
        run: async (app, args) => {
            app.setMode("plan");
            app.print(["", `${MODE_INFO.plan.color(MODE_INFO.plan.symbol)} ${bold("Plan mode")} ${theme.muted(MODE_INFO.plan.description)}`]);
            if (args) await app.startTurn(args);
        },
    },
    {
        name: "clear",
        aliases: ["new", "reset"],
        description: "Start a fresh conversation (the old one stays resumable)",
        noEcho: true,
        run: (app) => {
            app.newSession();
            app.lastResponse = "";
            app.screen.clearScreen();
            app.printWelcome();
        },
    },
    {
        name: "compact",
        description: "Summarize the conversation to free up context",
        args: "[instructions]",
        run: async (app, args) => {
            if (!app.agent) return app.notice("No model configured.", "error");
            if (app.session.messages.length < 2) return app.notice("Nothing to compact yet.");
            await app.runTask("Compacting conversation", (signal) => app.agent!.compact({ auto: false, signal, instructions: args || undefined }));
        },
    },
    {
        name: "summary",
        description: "Show the latest compaction summary",
        whileBusy: true,
        hidden: true,
        run: (app) => {
            const summary = app.session.summary;
            if (!summary) return app.notice("No compaction has happened in this session.");
            app.print((cols) => ["", ...renderMarkdown(summary, cols - 4).map((l) => "  " + l)]);
        },
    },
    { name: "cost", description: "Token usage and cost for this session", whileBusy: true, run: (app) => costCommand(app) },
    { name: "context", description: "How much of the context window is used", whileBusy: true, run: (app) => contextCommand(app) },
    { name: "status", description: "Version, model, key source, mode, MCP, memory", whileBusy: true, run: (app) => statusCommand(app) },
    { name: "resume", aliases: ["continue"], description: "Resume an earlier conversation", args: "[session-id]", run: resumeCommand },
    { name: "rewind", description: "Go back to before an earlier prompt: restore files, the conversation, or both", noEcho: true, run: rewindCommand },
    { name: "rename", description: "Name this conversation", args: "<title>", run: (app, args) => (args ? (app.session.setTitle(args), app.notice(`Renamed to "${args}"`)) : app.notice("Usage: /rename <title>", "error")) },
    { name: "export", description: "Save the conversation as markdown (or --copy)", args: "[file|--copy]", run: exportCommand },
    {
        name: "copy",
        description: "Copy the last response to the clipboard",
        whileBusy: true,
        run: async (app) => (app.lastResponse ? app.notice(`Copied the last response to the ${await copyToClipboard(app.lastResponse)}.`) : app.notice("Nothing to copy yet.")),
    },
    { name: "init", description: "Create a HARNESS.md with notes about this codebase", noEcho: true, run: (app) => app.startTurn(INIT_PROMPT, { display: "/init", kind: "command" }) },
    { name: "review", description: "Review the current changes (or a PR number) for bugs", args: "[pr-number|focus]", noEcho: true, run: (app, args) => app.startTurn(reviewPrompt(args), { display: `/review${args ? " " + args : ""}`, kind: "command" }) },
    { name: "memory", description: "Edit memory files (HARNESS.md)", run: memoryCommand },
    { name: "config", aliases: ["settings"], description: "Change settings", run: configCommand },
    { name: "thinking", description: "Toggle showing the model's thinking text", whileBusy: true, run: (app) => {
        updateSettings("user", app.cwd, (s) => (s.showThinking = !app.settings.showThinking));
        app.reloadSettings();
        app.notice(`Thinking text ${app.settings.showThinking ? "shown" : "hidden"}`);
    } },
    { name: "mcp", description: "MCP servers: status, approval, tools, reconnect", run: mcpCommand },
    { name: "agents", description: "List sub-agents", whileBusy: true, run: (app) => agentsCommand(app) },
    { name: "hooks", description: "List configured hooks", whileBusy: true, run: (app) => hooksCommand(app) },
    { name: "todos", description: "Show the current todo list", whileBusy: true, run: (app) => {
            const todos = app.toolState.todos.map((t) => ({ ...t }));
            if (!todos.length) return app.notice("No todos.");
            app.print((cols) => ["", heading("Todos"), ...renderTodos(todos, cols)]);
        } },
    { name: "bashes", description: "List and stop background shells", run: bashesCommand },
    { name: "add-dir", description: "Allow working in another directory", args: "<path>", run: addDirCommand },
    { name: "doctor", description: "Check the installation and providers", run: doctorCommand },
    { name: "exit", aliases: ["quit", "q"], description: "Exit", whileBusy: true, noEcho: true, run: (app) => app.exit(0) },
];

function customToCommand(c: CustomCommand): Command {
    return {
        name: c.name,
        description: `${c.description} ${theme.subtle(`(${c.source})`)}`,
        args: c.argumentHint ?? (/\$ARGUMENTS|\$[1-9]/.test(c.body) ? "[args]" : undefined),
        noEcho: true,
        custom: c,
        run: (app, args) => app.startTurn(expandCommand(c.body, args), { display: `/${c.name}${args ? " " + args : ""}`, kind: "command" }),
    };
}

export function commandList(app: App): Command[] {
    const names = new Set(BUILTIN.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    return [...BUILTIN.filter((c) => !c.hidden), ...app.customCommands.filter((c) => !names.has(c.name)).map(customToCommand)];
}

function findCommand(app: App, name: string): Command | undefined {
    const all = [...BUILTIN, ...app.customCommands.map(customToCommand)];
    return all.find((c) => c.name === name) ?? all.find((c) => c.aliases?.includes(name));
}

/** Returns false when the text isn't a command and should be sent as a prompt. */
export async function runCommand(app: App, text: string): Promise<boolean> {
    const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    if (!m) return false;
    const name = m[1]!.toLowerCase();
    const args = m[2]!.trim();
    const cmd = findCommand(app, name);
    if (!cmd) {
        // "/usr/bin/foo is broken" is a prompt, not a command.
        if (name.includes("/") || name.includes(".")) return false;
        app.notice(`Unknown command /${name}. Type /help to see the commands.`, "error");
        return true;
    }
    if (app.busy && !cmd.whileBusy) {
        if (cmd.custom || cmd.name === "init" || cmd.name === "review") return false; // queued like a prompt by the caller
        app.notice(`/${cmd.name} isn't available while ${APP_TITLE} is working. Press esc to interrupt first.`, "warn");
        return true;
    }
    if (!cmd.noEcho) app.print(["", theme.muted(`> /${name}${args ? " " + args : ""}`)]);
    try {
        await cmd.run(app, args);
    } catch (e) {
        app.notice(redact((e as Error).message), "error");
    }
    app.renderLive();
    return true;
}

function helpCommand(app: App) {
    const cmds = commandList(app);
    const custom = app.customCommands.length;
    app.print((cols) => helpLines(app, cmds, custom, cols));
}

function helpLines(app: App, cmds: ReturnType<typeof commandList>, custom: number, cols: number): string[] {
    const lines = ["", `${theme.accent("✻")} ${bold(APP_TITLE)} ${theme.muted(`v${APP_VERSION} · a coding agent for your terminal, with any model`)}`, "", heading("Commands")];
    const w = Math.min(28, Math.max(...cmds.map((c) => width(c.name) + (c.args ? width(c.args) + 1 : 0))) + 4);
    for (const c of cmds) lines.push(truncate(`  ${padEnd(`/${c.name}${c.args ? " " + theme.subtle(c.args) : ""}`, w)}${theme.muted(c.description)}`, cols - 1));
    if (!custom) lines.push(theme.subtle(`  Add your own: markdown files in ${displayPath(paths.userCommands(), app.cwd)}/ or .harness/commands/`));
    lines.push(
        "",
        heading("Input"),
        `  ${theme.bashMode("!")} run a shell command    ${theme.memoryMode("#")} save a memory    ${bold("@")} attach a file    ${bold("/")} commands    ${bold("\\⏎")} or ${bold("shift+⏎")} newline`,
        "",
        heading("Keys"),
        `  ${bold("shift+tab")} cycle permission modes    ${bold("esc")} interrupt    ${bold("esc esc")} clear or rewind    ${bold("ctrl+c ×2")} exit`,
        `  ${bold("ctrl+o")} verbose output    ${bold("ctrl+t")} todos    ${bold("ctrl+g")} edit in $EDITOR    ${bold("ctrl+l")} clear screen    ${bold("↑/↓")} history`,
        "",
        heading("Permission modes"),
        ...PERMISSION_MODES.map((m) => `  ${padEnd(MODE_INFO[m].color(MODE_INFO[m].label), 22)}${theme.muted(truncate(MODE_INFO[m].description, cols - 26))}`),
    );
    return lines;
}
