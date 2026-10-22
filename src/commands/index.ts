// Slash commands for the interactive app.

import { existsSync, readFileSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { spawnSync } from "bun";
import type { App, QueuedDraft } from "../ui/app";
import type { Draft } from "../ui/editor";
import { describeTask } from "../agent/background";
import { renderTodos } from "../ui/app";
import { InputDialog, MessageDialog, SelectDialog } from "../ui/dialogs";
import { bold, padEnd, termCols, theme, truncate, width } from "../ui/ansi";
import { formatDuration, type SelectItem } from "../ui/components";
import { renderMarkdown } from "../ui/markdown";
import { notificationMode, notifyAfterMs } from "../ui/notify";
import { APP_TITLE, APP_VERSION, paths } from "../config/paths";
import { EFFORT_LEVELS, JsonFileError, loadScope, removePermissionRule, addPermissionRule, settingsPath, updateSettings, readJson, readJsonForUpdate, sandboxSwitch, hookConfigWarnings, type Effort, type SettingsScope, type Settings } from "../config/settings";
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
import { continuationGroups, modelRef, parseModelRef, textOf, type ModelInfo } from "../providers/types";
import { formatCost, formatPrice, formatTokens, formatUsd } from "../providers/pricing";
import { attachmentsNote } from "../providers/files";
import { getKey, removeKey, setKey, storageDescription } from "../auth/credentials";
import { detectKeyProvider, validateKey } from "../auth/detect";
import { maskKey, redact } from "../util/redact";
import { listSessions, findSession, type Session } from "../agent/session";
import { forkSession, forkTargets } from "../agent/fork";
import { forkUiLog } from "../server/history";
import { budgetNotice, loadMemory } from "../agent/memory";
import { BUILTIN_AGENTS, loadAgents } from "../agent/agents";
import { claudeModel } from "../backends/claude-agents";
import { agentTraits } from "../agent/delegation";
import { estimateTokens } from "../agent/compact";
import { BLOCKING_EVENTS, HOOK_EVENTS } from "../agent/hooks";
import { toSchema } from "../tools/index";
import { displayPath, expandPath } from "../util/files";
import { gitRoot } from "../util/git";
import { childEnv } from "../util/env";
import { expandCommand, pluginCommandFor, type CustomCommand } from "./custom";
import { pluginCommand } from "./plugins";
import { runsPluginCommand } from "../plugins/native";
import { formatSkill, loadSkills, sameSkills, skillRoots, type Skill } from "../agent/skills";
import { cliRunsSkills } from "../backends/native-skills";
import { rewindCommand } from "./rewind";
import { GoalController, goalClearedNotice, goalSummary, parseGoalCommand } from "../agent/goal";
import { checkAgentCli, vendorOf, type AgentCliStatus } from "../backends/index";
import { CLAUDE_CLI, CODEX_CLI, findCli } from "../backends/cli";
import { account, addAccount, listAccounts } from "../providers/accounts";
import { loginCommand as accountLoginCommand } from "../backends/account-login";
import { clockTime, limitAccountLabel, limitLines } from "../backends/limits";
import { describeJob, shortTime } from "../agent/schedule";
import { NO_SCHEDULES } from "../agent/schedule-host";
import { approvalMeaning, maskConfigValues, McpApprovalError, visible } from "../mcp/approval";
import type { McpServerInfo } from "../mcp/info";
import { mayStart } from "../mcp/manager";
import { ACTIONS, CONTEXTS, KEYBINDINGS_DOCS } from "../keybindings/core";
import { ensureKeybindingsFile } from "../keybindings/file";
import { isWebUrl } from "../mcp/oauth";
import { stoppedMonitorNote } from "../tools/monitor";

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
    skill?: Skill;
    /** Starts a model turn, which takes the images typed with the command (`draft`). Other commands refuse images. */
    images?: boolean;
    /** An MCP server's prompt (mcp__server__prompt): fetched, then sent as the prompt. */
    mcpPrompt?: boolean;
    run(app: App, args: string, draft?: Draft): Promise<void> | void;
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

/** Names only: the values never reach the screen. */
function secretsCommand(app: App, args: string) {
    const store = app.toolState.secrets;
    const [verb, name, ...rest] = args.trim().split(/\s+/).filter(Boolean);
    if (verb === "forget") {
        if (!name || rest.length) return app.notice("Usage: /secrets forget NAME", "warn");
        if (!store?.forget(name)) return app.notice(`This session doesn't hold a secret named ${redact(name)}.`, "warn");
        return app.notice(`Forgot ${name}: new shell commands won't see it. Output that shows its value stays redacted.`);
    }
    if (verb) return app.notice("Usage: /secrets, or /secrets forget NAME", "warn");
    const names = store?.names() ?? [];
    if (!names.length) return app.notice("No secrets in this session. The agent can ask for one with RequestSecret.");
    app.print(() => ["", heading("Secrets"), ...names.map((n) => `  $${n}`), theme.muted("  Shell commands in this session see these. Forget one with /secrets forget NAME."), ""]);
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
    d.yields = true;
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
    const accountArgs = args.trim().split(/\s+/);
    if ((accountArgs[0] === "claude-code" || accountArgs[0] === "codex") && accountArgs.length > 1) {
        const provider = accountArgs[0];
        if (accountArgs[1] === "add" && accountArgs.length === 2) return addCliAccount(app, provider);
        if (accountArgs.length === 2) return signInCliAccount(app, provider, accountArgs[1]!);
        throw new Error(`Use /login ${provider} add or /login ${provider} <account-id>.`);
    }
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

/** Launch only the vendor's own flow; credentials never pass through a Harness input dialog. */
async function signInCliAccount(app: App, provider: string, id: string) {
    const selected = account(provider, id);
    const command = accountLoginCommand(provider, selected.id);
    await app.screen.suspend(() => {
        spawnSync(command.argv, { cwd: app.cwd, env: command.env, stdio: ["inherit", "inherit", "inherit"] });
    });
    const status = await withProgress(app, [theme.muted("Checking sign-in…")], (signal) => checkAgentCli(provider, signal, selected.id));
    if (status) app.notice(`${getProvider(provider)!.name} · ${selected.name}: ${status.signedIn ? status.description : "not signed in"}`);
    await app.refreshListings();
}

async function addCliAccount(app: App, provider: string) {
    const id = await app.showDialog(new InputDialog({ title: "Account id", header: [theme.muted("A short id using letters, numbers, hyphens or underscores.")], placeholder: "personal" }));
    if (id === undefined) return;
    const name = await app.showDialog(new InputDialog({ title: "Account name", placeholder: "Personal" }));
    if (name === undefined) return;
    const folder = await app.showDialog(new InputDialog({ title: "Account folder (optional)", header: [theme.muted("Leave empty for a private folder in Harness's accounts directory."), theme.muted("A new folder starts with separate CLI settings and history.")], placeholder: "/absolute/path" }));
    if (folder === undefined) return;
    const selected = addAccount(provider, { id: id.trim(), name: name.trim(), ...(folder.trim() ? { folder: folder.trim() } : {}) }, [app.cwd]);
    app.notice(`Created ${selected.name}: ${selected.folder}`);
    if (provider === "claude-code") app.notice("Claude Console sign-ins without an API key are stored outside the config folder and are not isolated per account.", "warn");
    await signInCliAccount(app, provider, selected.id);
}

async function accountCommand(app: App, args: string) {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const providers = ["claude-code", "codex"];
    if (parts.length) {
        const provider = providers.includes(parts[0]!) ? parts.shift()! : app.model?.provider;
        if (!provider || !providers.includes(provider) || parts.length > 1) throw new Error("Use /account [claude-code|codex] [account-id].");
        if (parts.length) return app.setAccount(provider, parts[0]!);
        return pickAccount(app, [provider]);
    }
    return pickAccount(app, providers);
}

async function pickAccount(app: App, providers: string[]) {
    const items = providers.flatMap((provider) => listAccounts(provider).map((a) => ({
        label: a.name, value: `${provider}:${a.id}`, group: getProvider(provider)!.name,
        description: a.folder || "The CLI's normal configuration", detail: app.session.accountId(provider) === a.id ? "current" : undefined,
    })));
    const choice = await app.showDialog(new SelectDialog<string>({ title: "Session account", items, searchable: true, footer: [theme.muted("A switch starts a new CLI thread with this conversation as context."), theme.muted("Add one: /login claude-code add or /login codex add")] })) as string | undefined;
    if (choice) {
        const [provider, id] = choice.split(":");
        app.setAccount(provider!, id!);
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

/** A new session with this conversation so far, switched to; the original stays as it is (/resume goes back). */
function forkCommand(app: App) {
    const origin = app.session;
    if (!forkTargets(origin.messages).length) return app.notice("Nothing to fork yet.");
    let fork: Session;
    try {
        fork = forkSession(origin, { cut: origin.messages.length, model: app.model && modelRef(app.model) });
    } catch (e) {
        return app.notice(`Couldn't fork the session: ${(e as Error).message}`, "error");
    }
    // Its timeline, for when the app opens it.
    forkUiLog({ file: origin.path, id: origin.meta.id }, { file: fork.path, id: fork.meta.id });
    app.resume(fork);
    // Resume creates a new agent; tell it the current mode, as GUI forks do.
    if (app.mode === "plan") app.agent?.noteModeChange("default", "plan");
    else app.agent?.addReminder(`The permission mode is "${MODE_INFO[app.mode].label}": ${MODE_INFO[app.mode].description}`);
    app.notice(`Forked into "${fork.title}" (${fork.meta.id}). /resume ${origin.meta.id} goes back to the original.`);
}

function costCommand(app: App) {
    const s = app.session;
    const lines = ["", heading("Session cost")];
    if (!s.usageByModel.size) lines.push(theme.muted("  No API usage yet."));
    for (const [model, { usage, cost, unknown }] of s.usageByModel) {
        lines.push(`  ${bold(model)}`);
        lines.push(
            theme.muted(
                `    input ${formatTokens(usage.inputTokens)} · cache read ${formatTokens(usage.cacheReadTokens ?? 0)} · cache write ${formatTokens(usage.cacheWriteTokens ?? 0)} · output ${formatTokens(usage.outputTokens)}  →  ${unknown && !cost ? "price unknown" : formatCost(cost, unknown)}`,
            ),
        );
    }
    lines.push(kv("Total", bold(formatCost(s.cost, s.costUnknown)), 10), kv("Wall time", formatDuration(Date.now() - s.meta.createdAt), 10));
    if (s.costUnknown) lines.push(theme.subtle("  No price is known for some of the models used, so their usage isn't in the total."));
    lines.push(theme.subtle("  Prices come from each provider's model listing (or OpenRouter's catalog when marked ~); treat them as estimates."));
    for (const l of app.planLimits.values()) {
        const name = limitAccountLabel(l.provider, l.accountId);
        lines.push("", heading(`${name} plan limits`));
        for (const line of limitLines(l)) lines.push(`  ${line}`);
        lines.push(theme.subtle(`  As ${name} reported them at ${clockTime(l.at)}.`));
    }
    app.print(lines);
}

/**
 * /tasks: the session's background work (src/agent/background.ts): tasks delegated to other models, an agent
 * CLI's background sub-agents, shells and monitors, and the harness's own background shells. /tasks stop
 * <id|all> stops them; Esc doesn't (#228).
 */
async function tasksCommand(app: App, args: string) {
    const agent = app.agent;
    const [verb, id] = args.trim().split(/\s+/);
    if (verb === "stop") {
        const running = (agent?.backgroundTasks() ?? []).filter((t) => t.status === "running");
        if (!id || id === "all") {
            if (!running.length) return app.notice("No background tasks are running.");
        } else if (!running.some((t) => t.id === id)) return app.notice(`No running background task ${id}. /tasks lists them.`, "error");
        // The user's own stop: the ends of those it stops aren't announced.
        const stop = async () => (await agent?.stopBackground(!id || id === "all" ? undefined : [id])) ?? {};
        const bg = app.toolState.background;
        const results = bg ? await bg.userStop(!id || id === "all" ? running.map((t) => t.id) : [id], stop) : await stop();
        const ok = Object.values(results).filter((r) => r === "stopped").length;
        const ended = Object.entries(results).filter(([, r]) => r === "ended");
        const bad = Object.entries(results).filter(([, r]) => r !== "stopped" && r !== "ended");
        if (ok) app.notice(`Stopping ${ok} background task${ok === 1 ? "" : "s"}.`);
        // Ended on its own before the stop could: it keeps its own outcome (and its notice).
        for (const [t] of ended) app.notice(`${t} had already ended.`);
        for (const [t, r] of bad) app.notice(`Couldn't stop ${t}: ${r === "not_stoppable" ? "it can't be stopped on its own" : r === "timeout" ? "it didn't confirm in time" : r === "failed" ? "the CLI refused" : "no such task"}.`, "warn");
        return;
    }
    if (verb === "restart") {
        if (!(await agent?.restartBackend())) return app.notice("This session has no agent CLI process to restart.", "error");
        return app.notice("Restarted the agent CLI's process. What it ran in the background was stopped.");
    }
    if (verb) return app.notice("Usage: /tasks, or /tasks stop <task-id|all>, or /tasks restart", "error");
    const delegated = agent?.delegatedTasks ?? [];
    const others = (agent?.backgroundTasks() ?? []).filter((t) => !delegated.some((d) => d.id === t.id));
    if (!delegated.length && !others.length) return app.notice("No background tasks in this session. Sub-agents run in the background when the model asks (Task with run_in_background) or their definition says background: true; Claude Code and Codex can hand tasks to other providers' models, and run sub-agents and commands in the background.");
    const lines = [""];
    if (delegated.length) {
        lines.push(heading("Background and delegated tasks"));
        for (const t of delegated) {
            const r = t.result;
            const state = t.status === "running" ? theme.warning(`running ${formatDuration(Date.now() - t.startedAt)}`) : t.status === "done" ? theme.success("done") : t.status === "failed" ? theme.error("failed") : theme.muted("stopped");
            const spend = r ? theme.muted(` · ${formatTokens(r.tokens)} tokens${r.cost ? ` · ${formatUsd(r.cost)}` : ""} · ${formatDuration(r.durationMs)}`) : "";
            lines.push(`  ${bold(t.id)}  ${truncate(t.description, 50)}  ${theme.muted(`${t.agent} on ${t.model}${t.effort ? `, ${t.effort} effort` : ""}`)}  ${state}${spend}`);
        }
    }
    const shown = others.filter((t) => t.status === "running").slice(-20);
    if (shown.length) {
        lines.push(heading("Running in the background"));
        for (const t of shown) {
            const by = getProvider(t.provider)?.name ?? (t.provider === "harness" ? "" : t.provider);
            lines.push(`  ${bold(t.id)}  ${truncate(describeTask(t), 60)}  ${theme.muted(by)}  ${theme.warning(`running ${formatDuration(Date.now() - t.startedAt)}`)}${t.stoppable ? "" : theme.muted(" · can't be stopped on its own")}`);
        }
    }
    if ((agent?.backgroundTasks() ?? []).some((t) => t.status === "running")) lines.push(theme.subtle("  /tasks stop all stops them all; /tasks stop <id> stops one. Esc stops only the current turn."));
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
        kv("Fast mode", m?.supportsFastMode ? ((app.session.fastMode ?? app.settings.fastMode) ? "on (higher usage/cost)" : "off") : "not supported"),
        kv("Effort", app.settings.effort ?? theme.muted("model default")),
        kv("Thinking text", app.settings.showThinking ? "shown" : theme.muted("hidden (summaries only)")),
        kv("Permission mode", MODE_INFO[app.mode].color(MODE_INFO[app.mode].label)),
        kv("MCP servers", servers.length ? servers.map((s) => `${s.name} ${s.status === "connected" ? theme.success("✔") : s.status === "failed" ? theme.error("✘") : theme.muted(s.status)}`).join(", ") : theme.muted("none")),
        kv("Memory files", memory.length ? memory.map((f) => displayPath(f.path, app.cwd)).join(", ") : theme.muted("none (/init creates HARNESS.md)")),
        kv("Settings", (["user", "project", "local"] as SettingsScope[]).filter((s) => existsSync(settingsPath(s, app.cwd))).map((s) => displayPath(settingsPath(s, app.cwd), app.cwd)).join(", ") || theme.muted("defaults")),
        kv("Cost so far", formatCost(app.session.cost, app.session.costUnknown)),
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
        const due = app.idleCompact.due;
        if (due !== undefined) lines.push(theme.muted(`  Left idle, it compacts in ${Math.max(1, Math.ceil((due - Date.now()) / 60_000))}m, before the prompt cache expires`));
    } else lines.push(kv("Estimated", formatTokens(total)), theme.muted("  (this model's context window is unknown)"));
    if (!measured) lines.push(theme.subtle("  Estimates (≈3.5 chars/token) until the first response reports real usage."));
    if (!app.session.meta.system) lines.push(theme.subtle("  The system prompt is built when you send the first message."));
    app.print(lines);
}

async function exportCommand(app: App, args: string) {
    const out: string[] = [`# ${APP_TITLE} session ${app.session.meta.id}`, "", `- Directory: ${app.cwd}`, `- Model: ${app.session.model ?? "?"}`, `- Exported: ${new Date().toISOString()}`, ""];
    for (const group of continuationGroups(app.session.messages)) {
        const msg = group[0]!;
        if (msg.role === "user") {
            const kind = msg.meta?.kind ?? "prompt";
            if (kind === "tool_results") {
                for (const p of msg.content) if (p.type === "tool_result") out.push(`<details><summary>Result: ${p.toolName}${p.isError ? " (error)" : ""}</summary>`, "", "```", truncate(typeof p.content === "string" ? p.content : "", 4000), "```", "</details>", "");
                continue;
            }
            const t = (msg.meta?.display ?? textOf(msg)).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
            const note = attachmentsNote(msg.content);
            if (t || note) out.push(kind === "summary" ? "## Summary of earlier conversation" : "## User", "", ...(t ? [t] : []), ...(note ? [`*${note}*`] : []), "");
        } else {
            const t = group.map(textOf).join("").trim();
            if (t) out.push("## Assistant", "", t, "");
            for (const part of group) for (const p of part.content) if (p.type === "tool_call") out.push(`**${p.name}** \`${truncate(JSON.stringify(p.input), 300)}\``, "");
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

async function fastCommand(app: App, args: string) {
    const arg = args.trim().toLowerCase();
    if (arg && !["on", "off", "status"].includes(arg)) { app.notice("Usage: /fast [on|off|status]", "error"); return; }
    if (!app.model?.supportsFastMode && arg !== "off") { app.notice("Fast mode is not available for this model/backend. Refresh /model to check for updates.", "error"); return; }
    const current = Boolean(app.model?.supportsFastMode && (app.session.fastMode ?? app.settings.fastMode));
    if (arg === "status") { app.notice(`Fast mode ${current ? "on" : "off"}`); return; }
    if (app.busy) { app.notice("Change speed once this response is done, or interrupt it first.", "error"); return; }
    const enabled = arg === "on" ? true : arg === "off" ? false : !current;
    updateSettings("user", app.cwd, (s) => { s.fastMode = enabled; });
    app.settings.fastMode = enabled;
    app.session.setFastMode(enabled);
    app.notice(enabled ? "Fast mode on — faster service at higher usage/cost; reasoning effort unchanged." : "Fast mode off");
}

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

/**
 * The messages sent while a turn runs. Enter sends the selected one now (it steers the turn
 * instead of waiting for its end); shift or alt with ↑↓ moves it; e takes it back to edit;
 * x or delete removes it. The list stays open until esc, or the queue empties.
 */
async function queueCommand(app: App) {
    if (!app.queueEntries().length) return app.notice("Nothing is queued. Messages you send while a turn runs wait here.");
    const items = () =>
        app.queueEntries().map((q): SelectItem<QueuedDraft> => ({
            label: truncate(q.text.replace(/\s+/g, " ") || "(images)", 70),
            value: q.draft,
            detail: q.steering ? theme.accent("next step") : theme.muted("after this turn"),
            description: q.steering ? undefined : q.canSteer ? undefined : "images and commands can't join a running turn",
        }));
    const hint = "enter send now · shift+↑↓ move · e edit · x remove · esc close";
    const d = new SelectDialog<QueuedDraft>({
        title: "Queued messages",
        header: [theme.muted("Next step: joins the running turn. After this turn: runs once it ends.")],
        items: items(),
        numbers: false,
        hint,
        onExtraKey: (k, dlg) => {
            const cur = dlg.list.current()?.value;
            const refresh = (select?: QueuedDraft) => {
                const next = items();
                if (!next.length) return dlg.choose(undefined);
                dlg.list.items = next;
                dlg.list.index = Math.max(0, select ? next.findIndex((i) => i.value === select) : Math.min(dlg.list.index, next.length - 1));
                app.renderLive();
            };
            const gone = () => {
                dlg.header[0] = theme.warning("That one has already been sent.");
                refresh();
            };
            if (!cur) return k.name === "enter";
            if (k.name === "enter") {
                const r = app.sendQueuedNow(cur);
                if (r === "gone") gone();
                else if (r === "cant") dlg.header[0] = theme.warning("Images and commands can't join a running turn: it runs after it.");
                else {
                    dlg.header[0] = theme.muted("Sent: it joins the turn at its next step.");
                    refresh(cur);
                }
                return true;
            }
            if ((k.name === "up" || k.name === "down") && (k.shift || k.meta)) {
                const i = app.queueEntries().findIndex((q) => q.draft === cur);
                if (i < 0) gone();
                else if (app.moveQueued(cur, i + (k.name === "up" ? -1 : 1))) refresh(cur);
                return true;
            }
            const text = k.name === "text" ? k.text : undefined;
            if (text === "e" || text === "x" || k.name === "delete" || k.name === "backspace") {
                if (!app.takeOutQueued(cur, text === "e")) gone();
                else if (text === "e") dlg.choose(undefined);
                else refresh();
                return true;
            }
            return false;
        },
    });
    await app.showDialog(d);
}

async function configCommand(app: App) {
    let index = 0;
    for (;;) {
        type K = "showThinking" | "autoCompact" | "idleCompaction" | "webSearch" | "notifications" | "followUpBehavior" | "defaultMode" | "allowBypass" | "smallModel" | "reviewModel" | "verbose";
        const s = app.settings;
        const onOff = (b: boolean | undefined) => (b ? theme.success("on") : theme.muted("off"));
        const items: SelectItem<K>[] = [
            { label: "Show thinking text", value: "showThinking", detail: onOff(s.showThinking), description: "full reasoning text when the provider returns it" },
            { label: "Auto-compact", value: "autoCompact", detail: onOff(s.autoCompact !== false), description: "summarize the conversation near the context limit" },
            {
                label: "Compact while idle",
                value: "idleCompaction",
                detail: s.autoCompact === false || s.idleCompaction === false ? theme.muted("off") : s.idleCompaction === "always" ? theme.success("after 5 min too") : theme.success("after an hour"),
                description: "summarize a long conversation before its prompt cache expires (needs auto-compact)",
            },
            { label: "Web search backend", value: "webSearch", detail: s.webSearch ?? "auto", description: "auto · anthropic · brave · tavily · duckduckgo · off" },
            { label: "Notifications", value: "notifications", detail: notificationMode(s), description: `auto · terminal · bell · system · off (prompts, turns over ${notifyAfterMs(s) / 1000}s)` },
            { label: "Messages sent while working", value: "followUpBehavior", detail: s.followUpBehavior === "queue" ? "queue" : "steer", description: "steer joins the turn at its next step · queue waits for it to end (tab does the other)" },
            { label: "Default permission mode", value: "defaultMode", detail: MODE_INFO[s.permissions?.defaultMode ?? "default"].label, description: "mode at startup" },
            { label: "Bypass in shift+tab cycle", value: "allowBypass", detail: onOff(s.permissions?.allowBypass), description: "lets shift+tab reach bypass permissions" },
            { label: "Small model", value: "smallModel", detail: s.smallModel ?? "auto", description: "for session titles and summaries" },
            { label: "Auto-mode reviewer", value: "reviewModel", detail: s.reviewModel ?? "auto", description: "checks actions in auto mode (auto: Sonnet 5.5 with an Anthropic key)" },
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
            case "idleCompaction": {
                // On (one-hour caches) → five-minute ones too → off → on.
                const next = s.idleCompaction === false ? undefined : s.idleCompaction === "always" ? false : "always";
                save((x) => (x.idleCompaction = next));
                break;
            }
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
            case "followUpBehavior":
                save((x) => (x.followUpBehavior = s.followUpBehavior === "queue" ? undefined : "queue"));
                break;
            case "smallModel": {
                const items2: SelectItem<string>[] = [{ label: "Auto", value: "", description: "the cheapest model from the current provider" }, ...(await modelItems(app)).filter((i) => !i.value.startsWith("login:") && !i.disabled)];
                const pick = (await app.showDialog(new SelectDialog<string>({ title: "Small model", items: items2, searchable: true, current: (v) => v === (s.smallModel ?? "") }))) as string | undefined;
                if (pick !== undefined) save((x) => (x.smallModel = pick || undefined));
                break;
            }
            case "reviewModel": {
                // Claude Code and Codex run whole turns: they can't answer a one-off request.
                const api = (ref: string) => getProvider(ref.split(":")[0] ?? "")?.kind !== "agent";
                const items2: SelectItem<string>[] = [{ label: "Auto", value: "", description: "Claude Sonnet 5.5 with an Anthropic key, else the session's model" }, ...(await modelItems(app)).filter((i) => !i.value.startsWith("login:") && !i.disabled && api(i.value))];
                const pick = (await app.showDialog(new SelectDialog<string>({ title: "Auto-mode reviewer", items: items2, searchable: true, current: (v) => v === (s.reviewModel ?? "") }))) as string | undefined;
                if (pick !== undefined) save((x) => (x.reviewModel = pick || undefined));
                break;
            }
            case "verbose":
                app.verbose = !app.verbose;
                break;
        }
    }
}

/** The approval card, as lines: what will run, where it's declared, and what approving does. Same facts as the GUI's. */
function mcpCardLines(app: App, info: McpServerInfo): string[] {
    const row = (label: string, value: string) => `${theme.muted(padEnd(label, 12))}${value}`;
    const out: string[] = [theme.warning("MCP servers run with your user permissions. Only approve servers you trust.")];
    if (info.why) out.push(theme.warning(info.why));
    out.push("");
    if (info.transport !== "stdio") {
        out.push(row("URL", `${info.url ?? ""}${info.transport !== "http" ? theme.muted(` (${info.transport === "sse" ? "SSE" : "WebSocket"})`) : ""}`));
        out.push(row("Headers", info.headerNames?.length ? `${info.headerNames.join(", ")} ${theme.muted("(values not shown)")}` : theme.muted("none")));
    } else {
        out.push(row("Command", info.command ?? ""));
        if (!info.args?.length) out.push(row("Arguments", theme.muted("none")));
        else info.args.forEach((a, i) => out.push(row(i ? "" : "Arguments", `${theme.muted(`${i + 1}.`)} ‹${a}›`)));
        out.push(row("Runs in", info.cwd ?? ""));
        out.push(row("Env", info.envNames?.length ? `${info.envNames.join(", ")} ${theme.muted("(values not shown)")}` : theme.muted("none")));
    }
    if (info.declaredIn) out.push(row("Declared in", displayPath(info.declaredIn, app.cwd)));
    out.push(row("Saved in", `${displayPath(paths.localSettings(app.cwd), app.cwd)} ${theme.muted("(this folder only)")}`));
    if (info.masked) out.push(theme.muted("Values that look like secrets are masked."));
    if (info.hidden) out.push(theme.warning("It contains invisible or control characters, shown as ⟨U+…⟩."));
    for (const c of info.cut ?? []) out.push(theme.warning(`Cut to fit: ${c}.`));
    out.push("", theme.muted(approvalMeaning(app.model?.provider, trustedByUser(app.cwd))));
    return out;
}

/**
 * A folder trusted for this session only (it had nothing to protect at
 * startup) isn't trusted by the user: approving its .mcp.json servers asks
 * for that first.
 */
async function trustForApproval(app: App): Promise<boolean> {
    if (trustedByUser(app.cwd)) return true;
    const header = [
        theme.warning("You haven't trusted this folder yourself: Harness trusted it for this session only, because it had nothing to protect when it was opened."),
        theme.muted(app.cwd),
        "",
        theme.muted("Its settings, hooks and memory files already apply this session. Trusting it is saved, and lets you approve its .mcp.json servers."),
    ];
    if (!(await confirm(app, "Trust this folder first?", header, "Trust this folder", "Cancel"))) return false;
    try {
        trustFolder(app.cwd);
    } catch (e) {
        app.notice(redact((e as Error).message), "warn");
    }
    return trustedByUser(app.cwd);
}

/** /trust: trust the folder yourself, which a folder trusted for this session only (nothing to protect when opened) isn't. */
async function trustCommand(app: App) {
    if (trustedByUser(app.cwd)) return app.notice(`You've trusted ${app.cwd}.`);
    const header = [
        theme.muted(app.cwd),
        "",
        theme.muted("Trusting it is saved. It lets you approve its .mcp.json servers, and turns on diagnostics after edits: language servers run the project's own code (its TypeScript, build scripts)."),
    ];
    if (!(await confirm(app, "Trust this folder?", header, "Trust this folder", "Cancel"))) return;
    try {
        trustFolder(app.cwd);
    } catch (e) {
        return app.notice(redact((e as Error).message), "warn");
    }
    const late = app.projectTrusted();
    app.notice(`Trusted ${app.cwd}.${late ? " Its settings, language servers, commands and skills apply now; its MCP servers load when you next start here." : ""}`);
}

/** Shown the card, and approved if the user says yes; false if they didn't (or it changed meanwhile). */
async function approveMcp(app: App, name: string): Promise<boolean> {
    for (;;) {
        if (!(await trustForApproval(app))) return false;
        const info = app.mcp.describe(name);
        if (!info?.fingerprint) return false;
        if (!(await confirm(app, `Allow ${info.label} to run?`, mcpCardLines(app, info)))) return false;
        try {
            const st = await app.mcp.approve(name, info.fingerprint);
            await withProgress(app, [theme.permission(bold(`Connecting ${info.label}…`))], () => app.mcp.start(st));
            return true;
        } catch (e) {
            if (!(e instanceof McpApprovalError)) throw e;
            app.notice(e.message, "warn");
            // Changed while the card was open (or trust was taken back): look again.
            if (e.code !== "changed" && e.code !== "needs_trust") return false;
        }
    }
}

/** What a connected server offers, in a few words. */
function offered(s: { tools: unknown[]; resources?: unknown[]; templates?: unknown[]; prompts?: unknown[] }): string {
    const n = (k: number, one: string) => `${k} ${one}${k === 1 ? "" : "s"}`;
    const parts = [n(s.tools.length, "tool")];
    const res = (s.resources?.length ?? 0) + (s.templates?.length ?? 0);
    if (res) parts.push(n(res, "resource"));
    if (s.prompts?.length) parts.push(n(s.prompts.length, "prompt"));
    return parts.join(" · ");
}

/** Open a link in the user's browser; the link is printed too, for when this can't. */
function openInBrowser(url: string) {
    if (!isWebUrl(url)) return;
    // Not cmd /c start: cmd would take the URL's & as a command separator.
    const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["rundll32", "url.dll,FileProtocolHandler", url] : ["xdg-open", url];
    try {
        Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore", env: childEnv() }).exited.catch(() => undefined);
    } catch {
        // printed above
    }
}

async function mcpCommand(app: App, args: string) {
    const [sub, name] = args.split(/\s+/);
    const guarded = async (fn: () => Promise<unknown>) => {
        try {
            await fn();
        } catch (e) {
            if (!(e instanceof McpApprovalError)) throw e;
            app.notice(e.message, "warn");
        }
    };
    if (sub === "reconnect" && name) {
        await guarded(async () => {
            const st = await app.mcp.reconnect(name);
            if (st.status === "needs-approval") app.notice(`${name} needs approval${st.approval?.reason === "changed" ? " again: what it runs changed" : ""}. Run /mcp to review it.`, "warn");
        });
        return;
    }
    // What the GUI (or an edit to .mcp.json) changed since.
    await app.mcp.sync();
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
                    return theme.success(`✔ connected · ${offered(s)}${s.era ? ` · ${s.era}` : ""}`);
                case "needs-auth":
                    return theme.warning("needs sign-in");
                case "failed":
                    return theme.error(`✘ failed: ${truncate(visible((s.error ?? "").split("\n")[0]!).text, 60)}`);
                case "needs-approval":
                    return theme.warning(s.approval?.reason === "changed" ? "needs approval again (changed)" : s.approval?.reason === "legacy" ? "needs approval once more" : "needs approval");
                case "connecting":
                case "pending":
                    return theme.muted("connecting…");
                case "disabled":
                    return theme.muted(s.approval?.state === "rejected" ? "rejected" : "disabled");
                default:
                    return theme.muted(s.status);
            }
        };
        const pick = (await app.showDialog(
            new SelectDialog<string>({
                title: "MCP servers",
                items: servers.map((s) => ({ label: bold(visible(s.name).text), value: s.name, description: statusText(s), detail: s.source === "project" ? ".mcp.json" : s.config.plugin ? `plugin ${s.config.plugin.split("@")[0]}` : "settings" })),
                numbers: true,
            }),
        )) as string | undefined;
        if (!pick) return;
        const st = app.mcp.servers.get(pick);
        const info = app.mcp.describe(pick);
        if (!st || !info) continue;
        type A = "approve" | "reject" | "revoke" | "reconnect" | "tools" | "resources" | "prompts" | "error" | "disable" | "enable" | "signin" | "signout";
        const actions: SelectItem<A>[] = [];
        const project = st.source === "project";
        const approval = st.approval?.state;
        const offInFile = st.config.disabled === true;
        if (project && !offInFile && (approval === "needs-approval" || approval === "rejected")) actions.push({ label: approval === "rejected" ? "Enable (review and approve)…" : "Review and approve…", value: "approve", description: "saved to this folder's local settings" });
        if (project && (approval === "needs-approval" || approval === "approved")) actions.push({ label: "Reject", value: "reject", description: "keeps it off until you approve it again" });
        if (st.status === "needs-auth") actions.push({ label: "Sign in…", value: "signin", description: "opens your browser" });
        if (st.status === "connected") {
            actions.push({ label: "Show tools", value: "tools" });
            if (st.resources?.length || st.templates?.length) actions.push({ label: "Show resources", value: "resources", description: "attach one with @" });
            if (st.prompts?.length) actions.push({ label: "Show prompts", value: "prompts", description: "run one as /mcp__…" });
            actions.push({ label: "Reconnect", value: "reconnect" }, { label: "Disable for this session", value: "disable" });
        }
        if (info.transport !== "stdio" && app.mcp.signedIn(st.name)) actions.push({ label: "Sign out", value: "signout", description: "forgets the stored token" });
        if (st.status === "failed") actions.push({ label: "Show error", value: "error" }, { label: "Reconnect", value: "reconnect" });
        // A rejected project server is enabled through the card above, never straight away.
        if (st.status === "disabled" && (!project || mayStart(st))) actions.push({ label: "Enable", value: "enable", description: "for this session" });
        if (project && approval === "approved" && !st.approval?.viaAll) actions.push({ label: "Revoke approval", value: "revoke", description: "stops it; it asks again" });
        const header = project
            ? mcpCardLines(app, info)
            : [theme.muted(info.transport !== "stdio" ? `${info.url ?? ""}${info.transport !== "http" ? ` (${info.transport === "sse" ? "SSE" : "WebSocket"})` : ""}` : [info.command, ...(info.args ?? []).map((a) => `‹${a}›`)].join(" ")), theme.muted(st.config.plugin ? `source: plugin ${st.config.plugin}` : "source: settings")];
        if (st.status === "needs-auth") header.unshift(theme.warning("This server needs you to sign in. Choose Sign in to open the sign-in page in your browser."));
        if (project && offInFile) header.unshift(theme.muted('Turned off in .mcp.json ("disabled": true).'));
        if (approval === "rejected") header.unshift(theme.muted("You rejected this server."));
        const a = (await app.showDialog(new SelectDialog<A>({ title: info.label, header, items: actions, numbers: true }))) as A | undefined;
        if (!a) continue;
        if (a === "approve") {
            await approveMcp(app, st.name);
        } else if (a === "enable") {
            await app.mcp.enable(st.name);
        } else if (a === "reject") {
            await guarded(() => app.mcp.reject(st.name));
        } else if (a === "revoke") {
            await guarded(() => app.mcp.revoke(st.name));
        } else if (a === "reconnect") {
            await guarded(() => withProgress(app, [theme.permission(bold(`Reconnecting ${info.label}…`))], () => app.mcp.reconnect(st.name)));
        } else if (a === "disable") {
            await st.client?.close();
            st.client = undefined;
            st.status = "disabled";
        } else if (a === "signin") {
            const shown = { url: "" };
            const r = await withProgress(
                app,
                [theme.permission(bold(`Signing in to ${info.label}…`)), "", theme.muted("Finish signing in in your browser. If it didn't open, open the link printed above.")],
                (signal) =>
                    app.mcp.signIn(st.name, (url) => {
                        shown.url = url;
                        app.print(["", theme.muted(`  Sign-in link for ${info.label}:`), `  ${url}`]);
                        openInBrowser(url);
                    }, signal),
            ).catch((e: Error) => {
                app.notice(`Sign-in to ${info.label} didn't finish: ${redact(e.message)}`, "error");
                return null;
            });
            if (r === undefined) app.notice(`Sign-in to ${info.label} cancelled.`, "warn");
            else if (r) app.notice(r.status === "connected" ? `Signed in to ${info.label}: connected.` : `Signed in to ${info.label}, but it didn't connect: ${redact((r.error ?? r.status).split("\n")[0]!)}`, r.status === "connected" ? "info" : "warn");
        } else if (a === "signout") {
            await app.mcp.signOut(st.name);
            app.notice(`Signed out of ${info.label}.`);
        } else if (a === "resources") {
            app.print(["", heading(`${info.label} resources`), ...(st.resources ?? []).slice(0, 200).map((r) => `  ${bold(`@${visible(st.name).text}:${visible(maskConfigValues(r.uri, st.config)).text}`)} ${theme.muted(truncate(visible(maskConfigValues(r.title ?? r.description ?? r.name ?? "", st.config).split("\n")[0]!).text, Math.max(10, termCols() - r.uri.length - st.name.length - 10)))}`), ...((st.resources?.length ?? 0) > 200 ? [theme.muted(`  … and ${st.resources!.length - 200} more (type @${visible(st.name).text}: to search them)`)] : []), ...(st.templates ?? []).map((t) => `  ${theme.muted("template")} ${bold(visible(maskConfigValues(t.uriTemplate, st.config)).text)} ${theme.muted(truncate(visible(maskConfigValues(t.description ?? t.name ?? "", st.config).split("\n")[0]!).text, 60))}`)]);
            return;
        } else if (a === "prompts") {
            const cmds = app.mcp.promptCommands().filter((p) => p.server === st.name);
            app.print(["", heading(`${info.label} prompts`), ...cmds.map((p) => `  ${bold(`/${p.command}`)}${p.args ? " " + theme.subtle(p.args) : ""} ${theme.muted(truncate(visible(p.description).text, 70))}`)]);
            return;
        } else if (a === "tools") {
            app.print(["", heading(`${info.label} tools`), ...st.tools.map((t) => `  ${bold(visible(t.name).text)}${t.annotations?.readOnlyHint ? theme.muted(" (read-only)") : ""} ${theme.muted(truncate(visible(maskConfigValues((t.description ?? "").split("\n")[0]!, st.config)).text, termCols() - t.name.length - 20))}`)]);
            return;
        } else if (a === "error") {
            app.print(["", heading(`${info.label} error`), ...(info.error ?? "").split("\n").map((l) => theme.error("  " + l))]);
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
    const pick = (await app.showDialog(new SelectDialog<string>({ title: "Memory files", header: [theme.muted("Loaded into the system prompt at the start of a session. Select one to edit in $EDITOR."), ...(files.budget ? [theme.warning(budgetNotice(files, (p) => displayPath(p, app.cwd)))] : [])], items: candidates, numbers: true }))) as string | undefined;
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
    // On Claude Code its own Agent tool runs them, except those on another provider's model (the delegate tool's).
    const claude = app.model?.provider === "claude-code";
    const lines = ["", heading("Sub-agents"), theme.muted(claude ? "  Claude Code runs these with its own Agent tool (built-in ones are its own)." : "  The model starts these with the Task tool.")];
    for (const a of agents) {
        const where = claude && a.source !== "builtin" && !claudeModel(a.model) ? "through delegate on Claude Code" : "";
        lines.push(`  ${bold(a.name)} ${theme.muted(`(${[a.source, ...agentTraits(a), where].filter(Boolean).join(", ")})`)}`);
        lines.push(theme.muted(`    ${truncate(a.description, termCols() - 8)}`));
        const more = [
            a.tools?.length ? `tools: ${a.tools.join(", ")}` : "",
            a.disallowedTools?.length ? `disallowed tools: ${a.disallowedTools.join(", ")}` : "",
            a.maxTurns ? `max turns: ${a.maxTurns}` : "",
            a.skills?.length ? `skills: ${a.skills.join(", ")}` : "",
            a.mcpServers?.length ? `MCP: ${a.mcpServers.map((s) => s.name + (s.config ? " (own)" : "")).join(", ")}` : "",
            a.hooks ? `hooks: ${Object.entries(a.hooks).map(([e, l]) => `${e}${(l?.length ?? 0) > 1 ? ` ×${l!.length}` : ""}`).join(", ")}` : "",
        ].filter(Boolean);
        for (const m of more) lines.push(theme.subtle(`    ${truncate(m, termCols() - 6)}`));
        for (const w of a.warnings ?? []) lines.push(theme.warning(`    ⚠ ${truncate(w, termCols() - 8)}`));
    }
    if (agents.length === BUILTIN_AGENTS.length) lines.push("", theme.muted(`  Add your own as markdown files in ${displayPath(paths.userAgents(), app.cwd)}/ or .harness/agents/ (frontmatter: name, description, tools, disallowedTools, model, permissionMode, effort, maxTurns, isolation, background, memory, skills, mcpServers, hooks).`));
    app.print(lines);
}

function skillsCommand(app: App, args: string) {
    // Read again, so a skill added since startup shows up (and runs) without a restart.
    app.skills = sameSkills(app.skills, loadSkills(app.cwd, app.init.trusted));
    const q = args.trim().toLowerCase();
    const skills = app.skills.filter((s) => !q || s.name.includes(q) || s.description.toLowerCase().includes(q));
    app.print((cols) => {
        const lines = ["", heading("Skills"), theme.muted(`  /name runs one, $name adds one to a prompt, and the model loads them when they fit.`)];
        for (const s of skills) {
            const who = !s.userInvocable ? "model only" : !s.modelInvocable ? "you only" : undefined;
            lines.push(`  ${bold(s.name)}${s.argumentHint ? " " + theme.subtle(s.argumentHint) : ""} ${theme.muted(`(${[s.source, who].filter(Boolean).join(", ")})`)}`);
            lines.push(theme.muted(`    ${truncate(s.description, cols - 8)}`));
            // The end of a long path says which skill it is.
            const path = displayPath(s.file, app.cwd);
            lines.push(theme.subtle(`    ${path.length > cols - 8 ? "…" + path.slice(path.length - (cols - 9)) : path}`));
        }
        if (!skills.length) lines.push(theme.muted(q ? `  No skill matches "${q}".` : "  None yet."));
        if (!app.skills.length) {
            const dirs = skillRoots(app.cwd, app.init.trusted).map((r) => displayPath(r.dir, app.cwd) + "/");
            lines.push(theme.muted(`  Add one as <name>/SKILL.md in ${dirs.join(", ")} (frontmatter: name, description).`));
        }
        if (!app.init.trusted) lines.push(theme.warning("  This folder isn't trusted, so its skills (.harness/skills, .claude/skills) are ignored."));
        return lines;
    });
}

/** The keys and what they do now, after the keybindings file. */
function keyHelp(app: App, cols: number): string[] {
    const items: string[] = [];
    for (const a of ACTIONS) {
        const keys = app.keys.all(a.id);
        if (!a.defaults.tui) continue;
        const shown = keys.length ? keys.map((k) => (k === "escape" ? "esc" : k)).join("/") : theme.subtle("unbound");
        items.push(`${bold(shown)} ${a.description.toLowerCase()}${app.keys.keymap.customized.has(a.id) ? theme.accent(" *") : ""}`);
    }
    items.push(`${bold("ctrl+c ×2")} exit`);
    const lines: string[] = [];
    let line = " ";
    for (const it of items) {
        if (width(line) + width(it) + 4 > cols - 1 && line.trim()) {
            lines.push(line);
            line = " ";
        }
        line += `   ${it}`;
    }
    if (line.trim()) lines.push(line);
    lines.push(theme.subtle(`  Change them in ${displayPath(app.keys.path, app.cwd)} (/keybindings)${app.keys.keymap.customized.size ? "; * is a custom key" : ""}.`));
    return lines;
}

async function keybindingsCommand(app: App, args: string) {
    const path = app.keys.path;
    if (args.trim() === "edit") {
        ensureKeybindingsFile(path);
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        await app.screen.suspend(() => {
            spawnSync(["sh", "-c", `${editor} "$1"`, "sh", path], { stdio: ["inherit", "inherit", "inherit"], env: childEnv() });
        });
        app.renderLive();
        return;
    }
    const km = app.keys.keymap;
    const lines = ["", heading("Keybindings")];
    lines.push(theme.muted(`  File: ${displayPath(path, app.cwd)}${existsSync(path) ? "" : " (not created yet: /keybindings edit creates it)"}`));
    lines.push(theme.muted("  Changes apply when you save. /keybindings edit opens it in $EDITOR. Same format as Claude Code's."));
    lines.push(theme.subtle(`  e.g. { "bindings": [{ "context": "Chat", "bindings": { "ctrl+e": "chat:externalEditor", "ctrl+g": null } }] }`));
    const keyW = Math.min(36, Math.max(16, ...ACTIONS.filter((a) => a.defaults.tui).map((a) => width(app.keys.all(a.id).join(", ")) + 2)));
    for (const ctx of CONTEXTS) {
        const actions = ACTIONS.filter((a) => a.context === ctx && a.defaults.tui);
        if (!actions.length) continue;
        lines.push("", `  ${bold(ctx)}`);
        for (const a of actions) {
            const keys = app.keys.all(a.id);
            const shown = keys.length ? keys.join(", ") : theme.subtle("not bound");
            lines.push(truncate(`    ${padEnd(km.customized.has(a.id) ? theme.accent(shown) : shown, keyW)}${padEnd(theme.muted(a.id), 24)}${theme.subtle(a.description)}`, termCols() - 1));
        }
    }
    if (km.issues.length) {
        lines.push("", `  ${bold("Problems")}`);
        for (const i of km.issues) lines.push(`    ${i.level === "error" ? theme.error("✘") : theme.warning("!")} ${i.message}`);
    }
    lines.push("", theme.subtle(`  Modifiers: ctrl, alt (opt, meta), shift, mod (ctrl in the terminal). Chords: "ctrl+x ctrl+e".`), theme.subtle(`  Docs: ${KEYBINDINGS_DOCS}`));
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
        lines.push(`  ${bold(event)}${BLOCKING_EVENTS.has(event) || event === "PermissionRequest" ? "" : theme.subtle(" (informational)")}`);
        for (const x of list) {
            const what = x.type === "http" ? `POST ${x.url}` : x.type === "prompt" ? `prompt: ${truncate(x.prompt ?? "", 60)}` : x.type === "mcp_tool" ? `mcp__${x.server}__${x.tool}` : [x.command, ...(x.args ?? [])].join(" ");
            const notes = [x.if ? `if ${x.if}` : "", x.async ? "async" : "", x.timeout ? `timeout ${x.timeout}s` : ""].filter(Boolean).join(", ");
            lines.push(`    ${theme.muted(x.matcher ? `[${x.matcher}]` : "[*]")} ${what}${notes ? theme.subtle(` (${notes})`) : ""}${x.plugin ? theme.subtle(` (plugin ${x.plugin})`) : ""}`);
        }
    }
    if (!any) lines.push(theme.muted("  None configured."));
    for (const w of hookConfigWarnings(app.settings)) lines.push(theme.warning(`  Skipped: ${w.replace(/^hooks: /, "")}`));
    lines.push(
        theme.muted(`  Configure under "hooks" in settings (Claude Code's format works too). A command hook gets JSON on stdin; exit code 2 blocks the action and shows stderr to the model (informational events can't block). Hooks can also be http, prompt or mcp_tool.`),
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
    if (sandboxSwitch(app.settings) === false) lines.push(warn('The auto-mode sandbox is off ("sandbox": false): auto mode sends every shell command to its reviewer'));
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
        app.notice("No background shells or monitors.");
        return;
    }
    const pick = (await app.showDialog(
        new SelectDialog<string>({
            title: "Background shells and monitors",
            items: shells.map((s) => ({
                label: s.monitor ? `Monitor · ${truncate(redact(s.monitor.description), 50)}` : truncate(s.command, 60),
                value: s.id,
                description: s.exitCode === null ? theme.success(s.monitor ? "watching" : "running") : theme.muted(`exited ${s.exitCode}`),
                detail: s.monitor && s.exitCode === null ? `${s.monitor.events} event${s.monitor.events === 1 ? "" : "s"} · ${formatDuration(Math.max(0, s.monitor.expiresAt - Date.now()))} left` : formatDuration(Date.now() - s.startedAt),
            })),
            numbers: true,
        }),
    )) as string | undefined;
    if (!pick) return;
    const sh = app.toolState.shells.get(pick);
    if (!sh) return;
    const tail = redact(sh.output).split("\n").slice(-20);
    app.print(["", heading(`${sh.id}: ${truncate(sh.monitor ? redact(sh.monitor.description) : sh.command, 80)}`), ...tail.map((l) => theme.muted("  " + l))]);
    if (sh.exitCode === null && (await confirm(app, `Stop ${sh.id}?`))) {
        if (sh.monitor) app.agent?.addReminder(stoppedMonitorNote(sh));
        const how = await sh.kill();
        app.toolState.shells.delete(sh.id);
        app.notice(how === "killed" ? `Stopped ${sh.id} (it ignored SIGTERM, so it was force-killed)` : `Stopped ${sh.id}`);
    }
}

/** /loop [interval] <prompt>, /loop stop, /loop (what's looping). */
function loopCommand(app: App, args: string) {
    const r = app.schedules.loop(args);
    app.notice(r.text, r.level ?? "info");
}

type ScheduleAction = { do: "pause" | "run" | "delete"; id: string; index: number };

/** /schedules: this session's schedules, to pause, resume, run now or delete. With arguments, does one of those. */
async function schedulesCommand(app: App, args: string) {
    const direct = app.schedules.manage(args);
    if (direct) return app.notice(direct.text, direct.level ?? "info");
    let index = 0;
    while (true) {
        const jobs = app.schedules.scheduler.list();
        if (!jobs.length) {
            app.notice(NO_SCHEDULES);
            return;
        }
        const now = Date.now();
        const dialog = new SelectDialog<ScheduleAction>({
            title: "Schedules",
            header: [theme.muted("They run in this session while it's idle. Recurring ones stop after 7 days.")],
            items: jobs.map((j, i) => ({
                label: truncate(j.prompt.replace(/\s+/g, " "), 48),
                value: { do: "pause", id: j.id, index: i },
                description: describeJob(j) + (j.durable ? theme.subtle(" · saved") : ""),
                detail: j.paused ? theme.warning("paused") : j.due ? theme.accent("due") : j.nextAt ? `next ${shortTime(j.nextAt, now)}` : "",
            })),
            initial: Math.min(index, jobs.length - 1),
            numbers: false,
            hint: "enter pause or resume · r run now · d delete · esc close",
            onExtraKey: (k, d) => {
                const cur = d.list.current();
                if (!cur) return false;
                const i = jobs.findIndex((j) => j.id === cur.value.id);
                if (k.name === "text" && k.text === " ") return (d.choose({ do: "pause", id: cur.value.id, index: i }), true);
                if (k.name === "text" && (k.text === "r" || k.text === "R")) return (d.choose({ do: "run", id: cur.value.id, index: i }), true);
                if ((k.name === "text" && (k.text === "d" || k.text === "D")) || k.name === "delete") return (d.choose({ do: "delete", id: cur.value.id, index: i }), true);
                return false;
            },
        });
        const pick = (await app.showDialog(dialog)) as ScheduleAction | undefined;
        if (!pick) return;
        index = pick.index;
        const job = jobs.find((j) => j.id === pick.id);
        if (!job) continue;
        const verb = pick.do === "pause" ? (job.paused ? "resume" : "pause") : pick.do;
        const r = app.schedules.manage(`${verb} ${job.id}`);
        if (r) app.notice(r.text, r.level ?? "info");
        // Running one closes the list: its turn starts.
        if (pick.do === "run") return;
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
    void app.agent?.hooks("DirectoryAdded", { directory: dir, source: "slash_command" });
}

// ---------------------------------------------------------------------------
// Prompts

export const INIT_PROMPT = `Please analyze this codebase and create a HARNESS.md file at the repository root. It will be loaded into your context in future sessions in this repository.

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

export function reviewPrompt(args: string): string {
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
    { name: "login", description: "Add an API key or CLI account", args: "[provider|custom] [add|account-id]", run: loginCommand },
    { name: "account", description: "Choose the session account for Claude Code or Codex", args: "[provider] [account-id]", run: accountCommand },
    { name: "logout", description: "Remove a stored API key", run: logoutCommand },
    { name: "providers", description: "Providers, key status and endpoints", whileBusy: true, run: (app) => providersCommand(app) },
    { name: "fast", description: "Toggle fast service on supported models (higher usage/cost)", args: "[on|off|status]", run: fastCommand },
    { name: "effort", description: "Set reasoning effort (low … max)", args: "[level]", run: effortCommand },
    { name: "permissions", aliases: ["allowed-tools"], description: "View and edit allow / ask / deny rules", run: permissionsCommand },
    { name: "mode", description: "Switch permission mode (manual, accept edits, plan, auto, bypass)", args: "[mode]", whileBusy: true, run: modeCommand },
    {
        name: "plan",
        description: "Enter plan mode (optionally with a task)",
        args: "[task]",
        noEcho: true,
        images: true,
        run: async (app, args, draft) => {
            app.setMode("plan");
            app.print(["", `${MODE_INFO.plan.color(MODE_INFO.plan.symbol)} ${bold("Plan mode")} ${theme.muted(MODE_INFO.plan.description)}`]);
            if (args) await app.startTurn(args, { draft });
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
    { name: "queue", description: "Messages waiting for the turn: send one now, reorder, edit or remove", whileBusy: true, run: (app) => queueCommand(app) },
    { name: "tasks", description: "Background work: sub-agents, shells and monitors, and tasks delegated to other models (stop them with /tasks stop)", args: "[stop <task-id|all> | restart]", whileBusy: true, run: (app, args) => tasksCommand(app, args) },
    { name: "context", description: "How much of the context window is used", whileBusy: true, run: (app) => contextCommand(app) },
    { name: "status", description: "Version, model, key source, mode, MCP, memory", whileBusy: true, run: (app) => statusCommand(app) },
    { name: "resume", aliases: ["continue"], description: "Resume an earlier conversation", args: "[session-id]", run: resumeCommand },
    { name: "rewind", description: "Go back to before an earlier prompt: restore files, the conversation, or both", noEcho: true, run: rewindCommand },
    { name: "fork", description: "Continue in a new session from here, keeping this one as it is", run: forkCommand },
    { name: "rename", description: "Name this conversation", args: "<title>", run: (app, args) => (args ? (app.session.setTitle(args), app.notice(`Renamed to "${args}"`)) : app.notice("Usage: /rename <title>", "error")) },
    { name: "export", description: "Save the conversation as markdown (or --copy)", args: "[file|--copy]", run: exportCommand },
    {
        name: "copy",
        description: "Copy the last response to the clipboard",
        whileBusy: true,
        run: async (app) => (app.lastResponse ? app.notice(`Copied the last response to the ${await copyToClipboard(app.lastResponse)}.`) : app.notice("Nothing to copy yet.")),
    },
    { name: "goal", description: "Keep working until a condition holds (/goal clear stops)", args: "[condition]", whileBusy: true, noEcho: true, images: true, run: goalCommand },
    { name: "init", description: "Create a HARNESS.md with notes about this codebase", noEcho: true, images: true, run: (app, _args, draft) => app.startTurn(INIT_PROMPT, { display: "/init", kind: "command", draft }) },
    { name: "review", description: "Review the current changes (or a PR number) for bugs", args: "[pr-number|focus]", noEcho: true, images: true, run: (app, args, draft) => app.startTurn(reviewPrompt(args), { display: `/review${args ? " " + args : ""}`, kind: "command", draft }) },
    { name: "memory", description: "Edit memory files (HARNESS.md)", run: memoryCommand },
    { name: "config", aliases: ["settings"], description: "Change settings", run: configCommand },
    { name: "thinking", description: "Toggle showing the model's thinking text", whileBusy: true, run: (app) => {
        updateSettings("user", app.cwd, (s) => (s.showThinking = !app.settings.showThinking));
        app.reloadSettings();
        app.notice(`Thinking text ${app.settings.showThinking ? "shown" : "hidden"}`);
    } },
    { name: "mcp", description: "MCP servers: status, approval, tools, reconnect", run: mcpCommand },
    { name: "plugin", aliases: ["plugins"], description: "Browse, install and manage plugins and marketplaces", args: "[install|uninstall|enable|disable|update|marketplace …]", run: pluginCommand },
    { name: "agents", description: "List sub-agents", whileBusy: true, run: (app) => agentsCommand(app) },
    { name: "skills", description: "List skills (and pick up new ones)", args: "[filter]", whileBusy: true, run: skillsCommand },
    { name: "keybindings", description: "Customize keyboard shortcuts (keybindings.json)", args: "[edit]", whileBusy: true, run: keybindingsCommand },
    { name: "hooks", description: "List configured hooks", whileBusy: true, run: (app) => hooksCommand(app) },
    { name: "trust", description: "Trust this folder (MCP approvals, diagnostics after edits)", run: (app) => trustCommand(app) },
    { name: "todos", description: "Show the current todo list", whileBusy: true, run: (app) => {
            const todos = app.toolState.todos.map((t) => ({ ...t }));
            if (!todos.length) return app.notice("No todos.");
            app.print((cols) => ["", heading("Todos"), ...renderTodos(todos, cols)]);
        } },
    { name: "bashes", aliases: ["monitors"], description: "List and stop background shells and monitors", run: bashesCommand },
    { name: "loop", description: "Run a prompt now and then every interval (default 10m); /loop stop stops it", args: "[interval] <prompt>", whileBusy: true, run: (app, args) => loopCommand(app, args) },
    { name: "schedules", description: "This session's schedules: pause, resume, run now or delete", args: "[pause|resume|delete|run <id>]", run: schedulesCommand },
    { name: "secrets", description: "List the secrets this session holds (names only), or forget one", args: "[forget NAME]", whileBusy: true, run: secretsCommand },
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
        images: true,
        run: (app, args, draft) => {
            const display = `/${c.name}${args ? " " + args : ""}`;
            // Claude Code loads the plugins itself, so it runs their commands with its own handling.
            const listed = app.cliCommands?.provider === app.model?.provider ? app.cliCommands?.names : undefined;
            if (c.source === "plugin" && runsPluginCommand(app.model?.provider, c.name, listed)) return app.startTurn(display, { draft });
            return app.startTurn(expandCommand(c.body, args), { display, kind: "command", draft });
        },
    };
}

function skillToCommand(s: Skill): Command {
    return {
        name: s.name,
        description: `${s.description} ${theme.subtle("(skill)")}`,
        args: s.argumentHint,
        noEcho: true,
        skill: s,
        images: true,
        run: (app, args, draft) => {
            const display = `/${s.name}${args ? " " + args : ""}`;
            // Claude Code and Codex run skills themselves, with their own handling (allowed-tools and the rest): they're sent the /name.
            if (cliRunsSkills(app.model?.provider)) return app.startTurn(display, { draft });
            const text = formatSkill(s, args);
            if (text === undefined) {
                app.notice(`The ${s.name} skill is gone: ${displayPath(s.file, app.cwd)} can't be read. Run /skills to read them again.`, "error");
                if (draft) app.editor.restore([draft]);
                return;
            }
            return app.startTurn(text, { display, kind: "command", draft, mentionsIn: args });
        },
    };
}

/** An MCP prompt as a command: its arguments in order, fetched when run, then sent like a typed prompt. */
function promptToCommand(p: ReturnType<App["mcp"]["promptCommands"]>[number]): Command {
    return {
        name: p.command,
        description: p.description,
        args: p.args,
        noEcho: true,
        images: true,
        mcpPrompt: true,
        run: async (app, args, draft) => {
            const display = `/${p.command}${args ? " " + args : ""}`;
            let r: Awaited<ReturnType<App["mcp"]["runPrompt"]>> | undefined;
            try {
                r = await withProgress(app, [theme.permission(bold(`Getting ${visible(p.prompt.name).text} from ${visible(p.server).text}…`))], (signal) => app.mcp.runPrompt(p.command, args, app.mcpAsker(), signal));
            } catch (e) {
                app.notice(redact((e as Error).message), "error");
                if (draft) app.editor.restore([draft]);
                return;
            }
            if (!r) {
                if (draft) app.editor.restore([draft]);
                return;
            }
            // What the server wrote isn't the user's: only the arguments they typed attach files or resources.
            await app.startTurn(r.text, { display, kind: "command", draft, extra: r.images, mentionsIn: args });
        },
    };
}

/** Built-ins, then custom commands, then skills, then MCP prompts: a name the one before has is taken. */
function allCommands(app: App): Command[] {
    const names = new Set(BUILTIN.flatMap((c) => [c.name, ...(c.aliases ?? [])]));
    const custom = app.customCommands.filter((c) => !names.has(c.name));
    for (const c of custom) names.add(c.name);
    const skills = (app.skills ?? []).filter((s) => s.userInvocable && !names.has(s.name));
    for (const sk of skills) names.add(sk.name);
    const prompts = (app.mcp?.promptCommands() ?? []).filter((p) => !names.has(p.command));
    return [...BUILTIN, ...custom.map(customToCommand), ...skills.map(skillToCommand), ...prompts.map(promptToCommand)];
}

export function commandList(app: App): Command[] {
    return allCommands(app).filter((c) => !c.hidden);
}

function findCommand(app: App, name: string): Command | undefined {
    const all = allCommands(app);
    // A bare name finds a plugin's command only when nothing else has it, the agent CLI's own commands included.
    const cli = app.cliCommands?.provider === app.model?.provider ? app.cliCommands?.names : undefined;
    const plugin = () => (cli?.has(name) ? undefined : pluginCommandFor(app.customCommands, name));
    return all.find((c) => c.name === name) ?? all.find((c) => c.aliases?.includes(name)) ?? (plugin() && customToCommand(plugin()!));
}

function parseCommand(text: string): { name: string; args: string } | undefined {
    const m = text.match(/^\/(\S+)\s*([\s\S]*)$/);
    return m ? { name: m[1]!.toLowerCase(), args: m[2]!.trim() } : undefined;
}

/** The name of the command `text` runs when that command can't take images; undefined for prompts and commands that can. */
export function commandRefusesImages(app: App, text: string): string | undefined {
    const p = text.startsWith("//") ? undefined : parseCommand(text);
    const cmd = p && findCommand(app, p.name);
    return cmd && !cmd.images ? cmd.name : undefined;
}

/**
 * Returns false when the text isn't a command and should be sent as a prompt.
 * `draft` holds the images typed with it; a command that can't use them isn't
 * run, and the draft goes back to the prompt.
 */
export async function runCommand(app: App, text: string, draft?: Draft): Promise<boolean> {
    const p = parseCommand(text);
    if (!p) return false;
    const { name, args } = p;
    let cmd = findCommand(app, name);
    if (!cmd && !name.includes("/") && !name.includes(".")) {
        // A skill added since startup.
        app.skills = sameSkills(app.skills ?? [], loadSkills(app.cwd, app.init?.trusted ?? false));
        cmd = findCommand(app, name);
    }
    if (!cmd) {
        // "/usr/bin/foo is broken" is a prompt, not a command.
        if (name.includes("/") || name.includes(".")) return false;
        // One the session's agent CLI runs itself (Claude Code's /code-review, its skills and plugins).
        // Until it has listed them (before the first turn), let Claude Code resolve the name.
        const cli = app.cliCommands?.provider === app.model?.provider ? app.cliCommands?.names : undefined;
        if (cli?.has(name) || (!cli && app.model?.provider === "claude-code")) return false;
        app.notice(`Unknown command /${name}. Type /help to see the commands${app.skills?.length ? " and /skills for skills" : ""}.`, "error");
        if (draft?.attachments.size) app.editor.restore([draft]);
        return true;
    }
    if (draft?.attachments.size && !cmd.images) {
        app.notice(`/${cmd.name} can't take images, so it wasn't run. Remove the images to run it.`, "warn");
        app.editor.restore([draft]);
        return true;
    }
    // A command means the user is back: an idle compaction gives way to it (and to /goal, which may start or steer a turn).
    if (app.busy && (!cmd.whileBusy || cmd.name === "goal")) await app.yieldIdleCompaction?.();
    // On Claude Code and Codex, /goal is theirs: it goes to them (src/ui/app.ts nativeGoalCommand).
    if (cmd.name === "goal" && app.nativeGoals()) return app.nativeGoalCommand(text.trim(), args);
    // A new goal waits its turn in the queue like a prompt (with its images); the rest of /goal answers at once.
    if (app.busy && cmd.name === "goal" && parseGoalCommand(args).kind === "set") return false;
    if (app.busy && !cmd.whileBusy) {
        // Turn-starting commands queue like a prompt (by the caller); a bare /plan only switches mode, so it can't wait.
        if (cmd.custom || cmd.skill || cmd.mcpPrompt || cmd.name === "init" || cmd.name === "review" || (cmd.name === "plan" && args)) return false;
        app.notice(`/${cmd.name} isn't available while ${APP_TITLE} is working. Press esc to interrupt first.`, "warn");
        if (draft) app.editor.restore([draft]);
        return true;
    }
    if (!cmd.noEcho) app.print(["", theme.muted(`> /${name}${args ? " " + args : ""}`)]);
    try {
        await cmd.run(app, args, draft);
    } catch (e) {
        app.notice(redact((e as Error).message), "error");
    }
    app.renderLive();
    return true;
}

/** /goal: set, show, pause, resume or clear the session's goal (src/agent/goal.ts). */
async function goalCommand(app: App, args: string, draft?: Draft) {
    const goal = app.goal;
    if (!goal) return app.notice("No session yet.", "error");
    const c = parseGoalCommand(args);
    if (c.kind !== "set") app.print(["", theme.muted(`> /goal${args.trim() ? " " + args.trim() : ""}`)]);
    if (draft?.attachments.size && c.kind !== "set") {
        app.editor.restore([draft]);
        return app.notice("Only /goal <condition> takes images.", "warn");
    }
    switch (c.kind) {
        case "invalid":
            return app.notice(c.message, "error");
        case "status":
            return app.print(() => goalStatusLines(goal));
        case "clear": {
            const was = goal.clear();
            // A new goal sent mid-turn waits in the queue: cleared with it, not set after.
            return app.notice(goalClearedNotice(was, app.dropQueuedGoals()));
        }
        case "pause":
            if (!goal.active) return app.notice("No goal set");
            goal.pause("Paused with /goal pause. /goal resume continues it.");
            return app.notice(app.busy ? "Goal paused: the current turn finishes, then it waits for you. /goal resume continues it." : "Goal paused. /goal resume continues it.");
        case "resume":
            if (!goal.active) return app.notice("No goal set. /goal <condition> sets one.");
            goal.resume();
            if (app.busy) app.notice("Goal resumed: it's checked when the current turn ends.");
            return;
        case "set": {
            if (!app.agent) return app.notice("No model is selected. Pick one with /model (or add an API key with /login).", "error");
            const { prompt, display } = goal.set(c.condition);
            if (!app.helperAnswers()) app.notice(`No model besides ${app.model?.name ?? "this one"} can check the goal, so it reports for itself each turn. Set smallModel (/config) to another provider's model for an independent check.`, "info");
            await app.startTurn(prompt, { display, kind: "command", draft, goal: true });
            return;
        }
    }
}

function goalStatusLines(goal: GoalController): string[] {
    const v = goal.view();
    if (!v) {
        const last = goal.last;
        if (last && last.result !== "cleared") {
            return ["", heading(last.result === "met" ? "Goal achieved" : "Goal stopped (judged impossible)"), kv("Condition", last.condition), kv("Took", goalSummary(last.turns, last.ms, last.tokens)), ...(last.reason ? [kv("Reason", last.reason)] : []), ""];
        }
        return ["", "No goal set.", theme.muted("  /goal <condition> keeps working, turn after turn, until the condition holds. A check after each turn decides."), theme.muted("  Example: /goal all tests in test/auth pass and the linter is clean"), ""];
    }
    const state = { active: "active", checking: "checking…", waiting: "waiting", paused: "paused" }[v.state];
    return [
        "",
        heading("Goal"),
        kv("Condition", v.condition),
        kv("State", v.note ? `${state} · ${v.note}` : state),
        kv("Running", `${formatDuration(Date.now() - v.since)}${v.tokens ? ` · ${formatTokens(v.tokens)} tokens` : ""}`),
        kv("Turns checked", String(v.turns)),
        kv("Checked by", v.judge === "model" ? "a separate model, after each turn" : "the working model's own report (no other model can answer one-off requests)"),
        ...(v.lastReason ? [kv("Last check", v.lastReason)] : []),
        theme.muted("  /goal clear removes it · /goal pause · /goal resume"),
        "",
    ];
}

function helpCommand(app: App) {
    const cmds = commandList(app);
    const custom = app.customCommands.length + (app.skills?.length ?? 0);
    app.print((cols) => helpLines(app, cmds, custom, cols));
}

function helpLines(app: App, cmds: ReturnType<typeof commandList>, custom: number, cols: number): string[] {
    const lines = ["", `${theme.accent("✻")} ${bold(APP_TITLE)} ${theme.muted(`v${APP_VERSION} · a coding agent for your terminal, with any model`)}`, "", heading("Commands")];
    const w = Math.min(28, Math.max(...cmds.map((c) => width(c.name) + (c.args ? width(c.args) + 1 : 0))) + 4);
    for (const c of cmds) lines.push(truncate(`  ${padEnd(`/${c.name}${c.args ? " " + theme.subtle(c.args) : ""}`, w)}${theme.muted(c.description)}`, cols - 1));
    if (!custom) lines.push(theme.subtle(`  Add your own: markdown files in ${displayPath(paths.userCommands(), app.cwd)}/ or .harness/commands/, or skills (<name>/SKILL.md) in ${displayPath(join(paths.home(), "skills"), app.cwd)}/ or .harness/skills/`));
    lines.push(
        "",
        heading("Input"),
        `  ${theme.bashMode("!")} run a shell command    ${theme.memoryMode("#")} save a memory    ${bold("@")} attach a file    ${bold("$")} skills    ${bold("/")} commands    ${bold("\\⏎")} or ${bold("shift+⏎")} newline`,
        "",
        heading("Keys"),
        ...keyHelp(app, cols),
        "",
        heading("Permission modes"),
        ...PERMISSION_MODES.map((m) => `  ${padEnd(MODE_INFO[m].color(MODE_INFO[m].label), 22)}${theme.muted(truncate(MODE_INFO[m].description, cols - 26))}`),
    );
    return lines;
}
