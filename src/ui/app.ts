// The interactive terminal app: prompt, transcript rendering, dialogs,
// permission prompts, and wiring between the agent and the screen.

import { spawnSync } from "bun";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Screen, type Entry, type Printable } from "./screen";
import { Editor } from "./editor";
import type { Key } from "./keys";
import { bold, dim, italic, strike, theme, truncate, width, wrapLine, termCols, termRows, padEnd, sanitizeLine } from "./ansi";
import { MarkdownStream, renderMarkdown } from "./markdown";
import { SelectDialog, InputDialog, MessageDialog, type Dialog } from "./dialogs";
import { BULLET, SPINNER_FRAMES, SPINNER_VERBS, formatDuration, renderDiff, renderFilePreview, resultLines, toolLine, type SelectItem } from "./components";
import { FileIndex, expandMentions } from "./mentions";
import { Agent, type AgentEvent, type PermissionRequest, type PermissionResponse, type TurnEndReason } from "../agent/agent";
import { DELEGATE_TOOL } from "../agent/delegation";
import { fireHooks, type HookEvent } from "../agent/hooks";
import { Notifier } from "./notify";
import { Session } from "../agent/session";
import { appendPromptHistory, loadPromptHistory } from "../agent/session";
import { rewindTargets } from "../agent/checkpoints";
import { buildSystemPrompt } from "../agent/system-prompt";
import { addMemoryNote } from "../agent/memory";
import type { Effort, Settings } from "../config/settings";
import { loadSettings, loadScope, addPermissionRule, onConfigWarning } from "../config/settings";
import { APP_TITLE, APP_VERSION } from "../config/paths";
import { MODE_INFO, nextMode, type PermissionMode } from "../permissions/modes";
import { PermissionChecker } from "../permissions/checker";
import { AutoClassifier, REVIEW_REQUEST, reviewText, type ReviewStage } from "../permissions/classifier";
import { toolPath } from "../permissions/rules";
import { McpManager } from "../mcp/manager";
import { BUILTIN_TOOLS } from "../tools/index";
import type { Tool, ToolState, TodoItem } from "../tools/types";
import { killAllShells, runShell, childEnv } from "../tools/bash";
import { availableSearchBackend, formatHits, searchWeb } from "../tools/web-tools";
import { clientFor, listAllModels, cachedListings, defaultModelFrom, resolveModelInfo, reviewTarget, smallModelFor, lookupModel, type ProviderListing } from "../providers/models";
import { getProvider, resolveBaseUrl } from "../providers/registry";
import { modelRef, parseModelRef, textOf, type ModelInfo, type ProviderClient, type ToolCallPart } from "../providers/types";
import { formatCost, formatTokens } from "../providers/pricing";
import { attachmentsNote } from "../providers/files";
import { configuredProviders, storageDescription } from "../auth/credentials";
import { CLAUDE_CLI, CODEX_CLI, findCli } from "../backends/cli";
import { commandList, runCommand } from "../commands/index";
import { loadCustomCommands, type CustomCommand } from "../commands/custom";
import { displayPath } from "../util/files";
import { redact } from "../util/redact";
import { SecretStore, secretValueError } from "../agent/secrets";
import { mergeLimits } from "../backends/limits";
import type { PlanLimits } from "../server/protocol";

export interface AppInit {
    cwd: string;
    trusted: boolean;
    mode: PermissionMode;
    allowBypass: boolean;
    modelRef?: string;
    resumeFile?: string;
    initialPrompt?: string;
    appendSystemPrompt?: string;
    /** --max-turns: model turns allowed per prompt. */
    maxTurns?: number;
    startupNotes: string[];
    extraAllow?: string[];
    extraDeny?: string[];
    addDirs?: string[];
    effort?: Effort;
    fastMode?: boolean;
    /** Open the session picker at startup (--resume without an id). */
    resumePicker?: boolean;
    /** Default model when settings don't name one (legacy MODEL in the harness .env). */
    fallbackModel?: string;
}

interface ActiveTool {
    call: ToolCallPart;
    title: string;
    tool?: Tool<any>;
    startedAt: number;
    progress: string;
    autoReason?: string;
    sandboxed?: boolean;
    sub?: { label: string; tools: string[]; count: number; tokens: number; startedAt: number };
}

type InputMode = "prompt" | "bash" | "memory";

export class App {
    screen = new Screen();
    editor = new Editor();
    settings: Settings;
    mode: PermissionMode;
    allowBypass: boolean;
    checker: PermissionChecker;
    classifier: AutoClassifier;
    mcp: McpManager;
    files: FileIndex;
    listings: ProviderListing[] = [];
    model?: ModelInfo;
    client?: ProviderClient;
    agent?: Agent;
    session!: Session;
    toolState: ToolState;
    customCommands: CustomCommand[] = [];
    verbose = false;
    lastResponse = "";

    private dialogs: Dialog[] = [];
    private dialogQueue: Dialog[] = [];
    busy = false;
    private abort?: AbortController;
    private queued: string[] = [];
    /** Set once the startup model choice is done. */
    private modelReady = false;
    /** The model of a session resumed at startup, tried before the default. */
    private resumedModel?: string;
    /** A model switch in progress; prompts wait for it so they go to the right model. */
    private switching?: Promise<unknown>;
    private inputMode: InputMode = "prompt";
    private md?: MarkdownStream;
    private mdLines = 0;
    /** The streaming reply: what's been printed of it, and its text so far. */
    private mdEntries: Entry[] = [];
    private mdSource = "";
    private mdCols = 0;
    private thinking = "";
    private receiving = new Map<string, { name: string; chars: number }>();
    private active = new Map<string, ActiveTool>();
    /** Sub-agents still working after the call that started them returned (Codex's own): shown until their turn ends. */
    private detached = new Map<string, ActiveTool>();
    private turnStart = 0;
    private turnTokens = 0;
    /** The agent CLIs' plan limits as last reported, by provider (/cost shows them). */
    planLimits = new Map<string, PlanLimits>();
    private streamChars = 0;
    /** The model is thinking (its thinking may not be streamed at all, so nothing else moves). */
    private thinkingNow = false;
    /** When the agent last said anything, to tell a slow model from a stuck one. */
    private lastEventAt = 0;
    /** The busy work is the agent's (a `!` command isn't), so silence means waiting on the model. */
    private agentWork = false;
    private verb = "Thinking";
    private status?: string;
    private showTodos = true;
    private frame = 0;
    private ticker?: ReturnType<typeof setInterval>;
    private ctrlCAt = 0;
    private escAt = 0;
    private flash?: { text: string; until: number };
    private showHelp = false;
    private menuIndex = 0;
    private menuHiddenFor?: string;
    private exitResolve!: () => void;
    private exiting = false;
    readonly notifier = new Notifier({
        settings: () => this.settings,
        focus: () => this.screen.focus,
        interactive: this.screen.interactive,
        cwd: () => this.toolState.cwd,
        sessionId: () => this.session?.meta.id,
        warn: (msg) => this.notice(msg, "warn"),
    });

    constructor(readonly init: AppInit) {
        this.settings = loadSettings(init.cwd, { trusted: init.trusted });
        this.applyCliRules();
        this.mode = init.mode;
        this.allowBypass = init.allowBypass;
        this.checker = new PermissionChecker(() => this.settings, init.cwd);
        this.classifier = new AutoClassifier(undefined);
        this.mcp = new McpManager(init.cwd, () => this.settings, init.trusted, () => this.reloadSettings());
        this.mcp.onChange = () => this.renderLive();
        this.files = new FileIndex(init.cwd);
        this.toolState = { cwd: init.cwd, projectRoot: init.cwd, fileState: new Map(), todos: [], shells: new Map(), secrets: new SecretStore() };
        this.editor.setHistory(loadPromptHistory(init.cwd));
    }

    get cwd(): string {
        return this.init.cwd;
    }

    private applyCliRules() {
        const p = (this.settings.permissions ??= {});
        if (this.init.extraAllow?.length) p.allow = [...(p.allow ?? []), ...this.init.extraAllow];
        if (this.init.extraDeny?.length) p.deny = [...(p.deny ?? []), ...this.init.extraDeny];
        if (this.init.addDirs?.length) p.additionalDirectories = [...(p.additionalDirectories ?? []), ...this.init.addDirs];
        if (this.init.effort) this.settings.effort = this.init.effort;
    }

    reloadSettings() {
        const reviewer = this.settings.reviewModel;
        this.settings = loadSettings(this.cwd, { trusted: this.init.trusted });
        // Another reviewer's verdicts don't stand for the one now chosen.
        if (this.settings.reviewModel !== reviewer) this.classifier.clearCache();
        this.applyCliRules();
    }

    // -----------------------------------------------------------------------
    // Lifecycle

    async run(): Promise<void> {
        const done = new Promise<void>((r) => (this.exitResolve = r));
        this.screen.start(
            (k) => this.onKey(k),
            () => this.renderLive(),
        );
        const restore = () => this.screen.stop();
        process.on("exit", restore);
        // stderr would scribble over the screen.
        onConfigWarning((msg) => this.notice(msg, "warn"));
        for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => void this.exit(0));

        this.customCommands = loadCustomCommands(this.cwd, this.init.trusted);
        this.printWelcome();
        for (const n of this.init.startupNotes) this.notice(n, "warn");

        this.mcp.load();
        const approvals = this.mcp.needsApproval();
        if (approvals.length) this.notice(`This project's .mcp.json defines ${approvals.length} MCP server${approvals.length === 1 ? "" : "s"} (${approvals.map((s) => s.name).join(", ")}). Run /mcp to review and enable them.`, "info");
        void this.mcp.startAll();

        if (this.init.resumeFile) this.resume(this.init.resumeFile);
        else this.session = Session.create(this.cwd);
        if (this.init.fastMode !== undefined) this.session.setFastMode(this.init.fastMode);
        void this.sessionHook("SessionStart", { source: this.init.resumeFile ? "resume" : "startup" });

        await this.trackSwitch(this.initModel());
        if (this.init.fastMode && !this.model?.supportsFastMode) {
            this.session.setFastMode(false);
            this.notice("Fast mode is not available for this model/backend; using standard speed.", "warn");
        }
        this.renderLive();

        if (this.init.resumePicker) await runCommand(this, "/resume");
        if (this.init.initialPrompt) void this.submitText(this.init.initialPrompt);
        await done;
    }

    async exit(code = 0) {
        if (this.exiting) return;
        this.exiting = true;
        this.abort?.abort();
        const disposed = this.agent?.dispose();
        for (const d of [...this.dialogs, ...this.dialogQueue]) d.cancel();
        this.stopTicker();
        this.screen.setLive([]);
        const hint = this.session?.messages.length && this.session.persisted ? theme.muted(`Resume this session with: harness --resume ${this.session.meta.id}`) : "";
        if (this.session?.cost || this.session?.costUnknown) this.screen.print(theme.muted(`Total cost: ${formatCost(this.session.cost, this.session.costUnknown)}${this.session.costUnknown ? " (no price known for some of the models used)" : ""}`));
        if (hint) this.screen.print(hint);
        this.screen.flushNow();
        // SessionEnd hooks get at most 5 seconds.
        const ended = this.sessionHook("SessionEnd", { reason: "exit" }, AbortSignal.timeout(5000));
        await Promise.all([ended, disposed, killAllShells({ state: this.toolState }), Promise.race([this.mcp.closeAll(), new Promise((r) => setTimeout(r, 1500))])]);
        this.screen.stop();
        this.exitResolve?.();
        process.exit(code);
    }

    printWelcome() {
        const lines = [
            `${theme.accent("✻")} Welcome to ${bold(APP_TITLE)} ${theme.muted(`v${APP_VERSION}`)}`,
            "",
            theme.muted(`  /help for help · /model to switch models · /login to add an API key`),
            "",
            theme.muted(`  cwd: ${displayPath(this.cwd, process.env.HOME ?? "/")}`),
        ];
        this.screen.print((cols) => {
            const inner = Math.min(cols, 90) - 5;
            const out = [theme.accent("╭" + "─".repeat(inner + 2) + "╮")];
            for (const l of lines) out.push(theme.accent("│") + " " + padEnd(truncate(l, inner), inner) + " " + theme.accent("│"));
            out.push(theme.accent("╰" + "─".repeat(inner + 2) + "╯"));
            return out;
        });
    }

    // -----------------------------------------------------------------------
    // Model

    private trackSwitch<T>(p: Promise<T>): Promise<T> {
        const tracked = p.finally(() => {
            if (this.switching === tracked) this.switching = undefined;
        });
        this.switching = tracked;
        return tracked;
    }

    private async initModel() {
        try {
            await this.pickStartupModel();
        } finally {
            this.modelReady = true;
        }
    }

    private async pickStartupModel() {
        // --model, then a resumed session's own model, then the saved default.
        const candidates = [this.init.modelRef, this.resumedModel, this.settings.model ?? this.init.fallbackModel].filter((r): r is string => Boolean(r && parseModelRef(r)));
        for (const ref of new Set(candidates)) {
            // An explicit --model should say why it can't be used.
            const ok = await this.setModel(ref, { quiet: ref !== this.init.modelRef, persist: false });
            if (ok) {
                if (ref !== this.resumedModel && this.resumedModel) this.notice(`This session used ${this.resumedModel}, which isn't available now.`, "warn");
                this.printModelLine();
                void this.refreshListings();
                return;
            }
        }
        this.listings = cachedListings();
        let pick = defaultModelFrom(this.listings);
        if (!pick) {
            // Includes local servers (Ollama, LM Studio), which are probed with a short timeout.
            this.status = "Loading model list";
            this.renderLive();
            this.listings = await listAllModels().catch(() => []);
            this.status = undefined;
            pick = defaultModelFrom(this.listings);
        } else void this.refreshListings();
        if (pick && (await this.setModel(modelRef(pick), { quiet: true, persist: false }))) {
            if (this.resumedModel) this.notice(`This session used ${this.resumedModel}, which isn't available now.`, "warn");
            this.printModelLine();
            return;
        }
        const providers = await configuredProviders();
        if (providers.some((p) => !p.local)) {
            this.screen.print(["", `${theme.warning("!")} No model is selected and none could be listed. Pick one with ${bold("/model")} or start with ${bold("--model provider:model")}.`]);
            return;
        }
        // A Claude Code or Codex already on this machine can be used with the user's own plan.
        const clis = (["claude-code", "codex"] as const).filter((id) => findCli(id, id === "codex" ? CODEX_CLI : CLAUDE_CLI));
        if (clis.length) {
            this.screen.print(["", `${theme.warning("!")} No model is set up yet.`]);
            const choice = (await this.showDialog(
                new SelectDialog<string>({
                    title: "How do you want to connect a model?",
                    items: [
                        ...clis.map((id) =>
                            id === "codex"
                                ? { label: "Use my ChatGPT plan", value: "/login codex", description: "through your installed Codex CLI" }
                                : { label: "Use my Claude subscription", value: "/login claude-code", description: "through your installed Claude Code" },
                        ),
                        { label: "Paste an API key", value: "/login", description: `stored in ${await storageDescription()}` },
                    ],
                    numbers: true,
                }),
            )) as string | undefined;
            if (choice) await runCommand(this, choice);
            return;
        }
        this.screen.print(["", `${theme.warning("!")} No API key configured yet. Let's add one; it will be stored in ${await storageDescription()}.`]);
        await runCommand(this, "/login");
    }

    private printModelLine() {
        if (!this.model) return;
        const p = getProvider(this.model.provider);
        this.screen.print(theme.muted(`  model: ${this.model.name ?? this.model.id} ${dim(`(${modelRef(this.model)} via ${p?.name ?? this.model.provider})`)} · mode: ${MODE_INFO[this.mode].label}`));
    }

    async refreshListings(force = false): Promise<ProviderListing[]> {
        this.listings = await listAllModels({ refresh: force }).catch(() => this.listings);
        // fill in details for the current model if it was guessed
        if (this.model) {
            const m = this.listings.find((l) => l.provider.id === this.model!.provider)?.models.find((x) => x.id === this.model!.id);
            if (m) {
                this.model = m;
                if (this.agent) this.agent.model = m;
            }
        }
        return this.listings;
    }

    /** Switch the active model. Returns false if the provider isn't usable. */
    async setModel(ref: string, opts: { quiet?: boolean; persist?: boolean } = {}): Promise<boolean> {
        const parsed = parseModelRef(ref);
        if (!parsed) {
            this.notice(`Model must be "provider:model", e.g. anthropic:claude-opus-5-5`, "error");
            return false;
        }
        const def = getProvider(parsed.provider);
        if (!def) {
            this.notice(`Unknown provider "${parsed.provider}". See /providers.`, "error");
            return false;
        }
        let client: ProviderClient;
        try {
            client = await clientFor(parsed.provider);
        } catch (e) {
            if (!opts.quiet) this.notice((e as Error).message, "error");
            return false;
        }
        let info = this.listings.find((l) => l.provider.id === parsed.provider)?.models.find((m) => m.id === parsed.id) ?? resolveModelInfo(ref);
        if (!info) return false;
        if (!info.contextWindow && def.kind !== "anthropic") info = (await lookupModel(ref).catch(() => undefined)) ?? info;
        const prev = this.model;
        this.model = info;
        this.client = client;
        this.updateHelpers();
        if (!this.agent) this.makeAgent();
        else {
            this.agent.setModel(info, client);
            this.agent.options.nativeWebSearch = this.nativeSearch();
            if (prev) this.agent.noteModelChange(modelRef(prev), info);
        }
        if (opts.persist) {
            const { updateSettings } = await import("../config/settings");
            try {
                updateSettings("user", this.cwd, (s) => (s.model = ref));
                this.settings.model = ref;
            } catch (e) {
                this.notice(`Switched for this session only. ${redact((e as Error).message)}`, "warn");
            }
        }
        if (!opts.quiet) this.screen.print(["", `${theme.success("✔")} Model set to ${bold(info.name ?? info.id)} ${theme.muted(`(${ref})`)}`]);
        this.renderLive();
        return true;
    }

    /**
     * A provider's key changed (/login, /logout): the current client still
     * holds the old one. Rebuild it; with no key left, deselect the model.
     */
    async keyChanged(providerId: string) {
        // A key can change who reviews (Sonnet 5.5 once there's an Anthropic key).
        this.classifier.clearCache();
        if (!this.model || this.model.provider !== providerId) return;
        try {
            this.client = await clientFor(providerId);
            this.agent?.setModel(this.model, this.client);
        } catch {
            this.model = undefined;
            this.client = undefined;
            void this.agent?.dispose();
            this.agent = undefined;
        }
        this.updateHelpers();
        this.renderLive();
    }

    private nativeSearch(): boolean {
        if (!this.model) return false;
        const def = getProvider(this.model.provider);
        const pref = this.settings.webSearch ?? "auto";
        return def?.kind === "anthropic" && /^https:\/\/api\.anthropic\.com$/.test(resolveBaseUrl(def)) && (pref === "auto" || pref === "anthropic");
    }

    private updateHelpers() {
        this.classifier.setComplete(this.client ? (system, prompt, signal, opts) => this.complete(system, prompt, signal, opts) : undefined);
    }

    /** One-shot completion on a cheap model (summaries), the auto-mode reviewer with `review`, or with `main` on the session's model. */
    async complete(system: string, prompt: string, signal?: AbortSignal, opts?: { main?: boolean; review?: ReviewStage }): Promise<string> {
        let model = this.model!;
        let client = this.client!;
        const smallRef = this.settings.smallModel;
        if (opts?.review) {
            const r = await reviewTarget(this.settings.reviewModel);
            if (r) ({ model, client } = r);
        } else if (opts?.main) {
            // the session's own model
        } else if (smallRef) {
            const p = parseModelRef(smallRef);
            if (p) {
                try {
                    client = await clientFor(p.provider);
                    model = resolveModelInfo(smallRef) ?? model;
                } catch {
                    // fall back to the main model
                }
            }
        } else {
            const small = smallModelFor(model.provider, this.listings);
            if (small) model = small;
        }
        const res = await client.stream(
            // Not a session message, so redact here (WebFetch pages, reviewer prompts).
            { model, system, messages: [{ role: "user", content: [{ type: "text", text: redact(prompt) }] }], tools: [], maxTokens: 2048, effort: "low", lightweight: true, signal, ...(opts?.review ? REVIEW_REQUEST[opts.review] : {}) },
            () => {},
        );
        if (res.usage) {
            const { costOf } = await import("../providers/pricing");
            const c = costOf(res.usage, model);
            this.session.recordUsage(modelRef(model), res.usage, c.usd, c.unknown);
        }
        return opts?.review ? reviewText(res) : textOf(res);
    }

    tools(): Tool<any>[] {
        const native = this.nativeSearch();
        const builtin = BUILTIN_TOOLS.filter((t) => !(native && t.name === "WebSearch") && !(t.name === "WebSearch" && this.settings.webSearch === "off"));
        return [...builtin, ...this.mcp.tools()];
    }

    makeAgent() {
        if (!this.model || !this.client) return;
        // Tasks the old one delegated stop with it.
        void this.agent?.dispose();
        this.agent = new Agent({
            session: this.session,
            model: this.model,
            client: this.client,
            settings: () => this.settings,
            checker: this.checker,
            classifier: this.classifier,
            tools: () => this.tools(),
            mode: { get: () => this.mode, set: (m) => this.setMode(m, { fromAgent: true }) },
            toolState: this.toolState,
            nativeWebSearch: this.nativeSearch(),
            listings: () => this.listings,
            maxTurns: this.init.maxTurns,
            appendSystemPrompt: this.init.appendSystemPrompt,
            host: {
                emit: (e) => this.onAgentEvent(e),
                askPermission: (req) => this.askPermission(req),
                saveRules: (rules, scope) => {
                    try {
                        for (const r of rules) addPermissionRule(scope, this.cwd, "allow", r);
                    } catch (e) {
                        this.notice(`Allowed for this session only; the rule wasn't saved. ${redact((e as Error).message)}`, "warn");
                    }
                    this.reloadSettings();
                },
                ui: {
                    askQuestion: (q, opts, multi) => this.askQuestion(q, opts, multi),
                    approvePlan: (plan) => this.approvePlan(plan),
                    requestSecret: (name, purpose, signal) => this.requestSecret(name, purpose, signal),
                },
                drainQueued: () => {
                    // Plain messages join the running turn; slash commands wait for it to end.
                    const q = this.queued.filter((t) => !t.startsWith("/"));
                    this.queued = this.queued.filter((t) => t.startsWith("/"));
                    for (const t of q) this.printUser(t);
                    return q;
                },
            },
            helpers: {
                complete: (s, p, sig) => this.complete(s, p, sig),
                webSearch: async (query, signal) => {
                    const backend = await availableSearchBackend(this.settings.webSearch);
                    if (!backend) throw new Error("Web search is turned off (settings.webSearch = off)");
                    return formatHits(query, await searchWeb(query, backend, signal));
                },
                resolveModel: async (ref) => {
                    const p = parseModelRef(ref);
                    if (!p) return undefined;
                    try {
                        const client = await clientFor(p.provider);
                        const model = resolveModelInfo(ref);
                        return model ? { model, client } : undefined;
                    } catch {
                        return undefined;
                    }
                },
            },
        });
        if (this.session.model === undefined && this.model) this.session.setModel(modelRef(this.model));
    }

    /**
     * Bypass is reachable only through the launch flag or the user's own
     * settings file, never a project's (the same rule as at startup).
     */
    bypassAllowed(): boolean {
        return this.allowBypass || Boolean(loadScope("user", this.cwd).permissions?.allowBypass);
    }

    /** Returns false when the mode change was refused. */
    setMode(m: PermissionMode, opts: { fromAgent?: boolean } = {}): boolean {
        if (m === "bypassPermissions" && this.mode !== m && !this.bypassAllowed()) {
            this.notice("Bypass mode is off for this session. Start with --dangerously-skip-permissions (or set permissions.allowBypass in user settings) to enable it.", "error");
            return false;
        }
        const from = this.mode;
        this.mode = m;
        if (!opts.fromAgent && this.agent) this.agent.noteModeChange(from, m);
        this.renderLive();
        return true;
    }

    newSession() {
        const prev = this.session;
        this.session = Session.create(this.cwd);
        prev.release();
        this.toolState.fileState.clear();
        this.toolState.todos = [];
        this.toolState.secrets?.clear();
        this.makeAgent();
        this.sessionSwitched(prev, "clear");
    }

    resume(file: string) {
        const prev = this.session;
        try {
            this.session = Session.load(file);
        } catch (e) {
            this.notice(`Could not resume: ${(e as Error).message}`, "error");
            // Stay in the current conversation; at startup there's none yet.
            if (!prev) this.session = Session.create(this.cwd);
            return;
        }
        prev?.release();
        this.toolState.fileState.clear();
        this.toolState.todos = [];
        this.toolState.secrets?.clear();
        if (this.agent) this.makeAgent();
        this.replayTranscript();
        // At startup, run() fires SessionStart.
        if (prev) this.sessionSwitched(prev, "resume");
    }

    /** /clear or /resume: SessionEnd for the old session, then SessionStart for the new one. */
    private sessionSwitched(prev: Session, how: "clear" | "resume") {
        const id = this.session.meta.id;
        void this.sessionHook("SessionEnd", { session_id: prev.meta.id, reason: how }).then(() => this.sessionHook("SessionStart", { session_id: id, source: how }));
    }

    /** SessionStart and SessionEnd hooks only inform: they run in the background, and problems show as notices. */
    private sessionHook(event: HookEvent, payload: Record<string, unknown>, signal?: AbortSignal): Promise<void> {
        return fireHooks(this.settings, event, { session_id: this.session?.meta.id, ...payload }, this.toolState.cwd, (msg) => this.notice(msg, "warn"), signal);
    }

    private replayTranscript() {
        const msgs = this.session.messages;
        const id = this.session.meta.id;
        const count = msgs.length;
        const tail = msgs.slice(-40);
        const from = count - tail.length;
        // How turns ended where the messages don't say (an error, a limit): each after the message before it.
        const notices = this.session.notices.filter((n) => n.index > from).sort((a, b) => a.index - b.index);
        this.screen.print((cols) => {
            const out: string[] = ["", theme.muted(`── Resumed session ${id} (${count} messages) ──`)];
            let next = 0;
            const noticesUpTo = (index: number) => {
                for (; next < notices.length && notices[next]!.index <= index; next++) {
                    const n = notices[next]!;
                    const color = n.level === "error" ? theme.error : n.level === "warn" ? theme.warning : theme.muted;
                    out.push(...wrapLine(n.text, cols - 6).map((l, i) => (i === 0 ? `  ⎿  ` : "     ") + color(l)));
                }
            };
            tail.forEach((m, i) => {
                noticesUpTo(from + i);
                if (m.role === "user") {
                    const kind = m.meta?.kind ?? "prompt";
                    if (kind === "prompt" || kind === "summary") {
                        const t = (m.meta?.display ?? textOf(m)).replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
                        if (t) out.push("", ...wrapLine(theme.muted("> ") + truncate(t, cols * 3), cols - 2));
                        const note = attachmentsNote(m.content);
                        if (note) out.push(...(t ? [] : [""]), ...wrapLine(theme.subtle(`  ${truncate(note, cols * 2)}`), cols - 2));
                    }
                } else {
                    const t = textOf(m).trim();
                    if (t) {
                        const md = renderMarkdown(t, cols - 2);
                        out.push("", ...md.slice(0, 30).map((l, i) => (i === 0 ? `${BULLET} ` : "  ") + l));
                        if (md.length > 30) out.push(theme.subtle(`  … +${md.length - 30} lines`));
                    }
                    for (const p of m.content) if (p.type === "tool_call") out.push(theme.muted(`  ${BULLET} ${p.name}`));
                }
            });
            noticesUpTo(Infinity);
            out.push(theme.muted("── end of resumed history ──"));
            return out;
        });
        if (!this.session.model || this.init.modelRef) return;
        // At startup initModel() picks it up; switching it here too would race that.
        if (this.modelReady) void this.trackSwitch(this.setModel(this.session.model, { quiet: true }).catch(() => false));
        else this.resumedModel = this.session.model;
    }

    // -----------------------------------------------------------------------
    // Output helpers

    /** Lines, or a function of the terminal width (so it's laid out again after a resize). */
    print(lines: Printable) {
        this.screen.print(lines);
    }

    notice(msg: string, level: "info" | "warn" | "error" = "info") {
        const color = level === "error" ? theme.error : level === "warn" ? theme.warning : theme.muted;
        this.screen.print((cols) => wrapLine(msg, cols - 6).map((l, i) => (i === 0 ? `  ⎿  ` : "     ") + color(l)));
    }

    private printUser(text: string) {
        this.screen.print((cols) => {
            const body = text.split("\n").flatMap((l) => wrapLine(l, cols - 4));
            const shown = body.length > 12 ? [...body.slice(0, 10), theme.subtle(`… +${body.length - 10} lines`)] : body;
            return ["", ...shown.map((l, i) => (i === 0 ? theme.muted("> ") : "  ") + theme.user(l))];
        });
    }

    private printAssistant(lines: string[]) {
        if (!lines.length) return;
        const out: string[] = [];
        for (const l of lines) {
            if (this.mdLines === 0) out.push("", `${BULLET} ${l}`);
            else out.push(`  ${l}`);
            this.mdLines++;
        }
        this.mdEntries.push(this.screen.print(out));
    }

    private flushStream() {
        if (this.md) {
            this.printAssistant(this.md.finish());
            this.md = undefined;
            // Streamed at the width it started with; from the next resize on, lay out the whole reply again.
            const source = redact(this.mdSource);
            if (this.mdEntries.length && source.trim()) {
                this.screen.replace(this.mdEntries, (cols) => assistantLines(renderMarkdown(source, cols - 2)));
                // Resized while it streamed: show it at the width the window has now.
                if (termCols() !== this.mdCols) this.screen.redraw();
            }
        }
        this.mdLines = 0;
        this.mdEntries = [];
        this.mdSource = "";
        this.flushThinking();
    }

    private shouldShowThinking(): boolean {
        if (this.settings.showThinking) return true;
        // Anthropic "updates" display: short progress notes, always shown (Claude Code's too).
        const provider = this.model?.provider ?? "";
        return getProvider(provider)?.kind === "anthropic" || provider === "claude-code";
    }

    private flushThinking() {
        const t = this.thinking.trim();
        this.thinking = "";
        if (!t || !this.shouldShowThinking()) return;
        const max = this.verbose ? 400 : this.settings.showThinking ? 60 : 8;
        this.screen.print((cols) => {
            const lines = t.split("\n").flatMap((l) => wrapLine(l, cols - 4));
            const shown = lines.slice(0, max);
            const out = ["", ...shown.map((l, i) => (i === 0 ? theme.muted("✻ ") : "  ") + italic(theme.muted(l)))];
            if (lines.length > max) out.push(theme.subtle(`  … +${lines.length - max} lines (ctrl+o to show more next time)`));
            return out;
        });
    }

    // -----------------------------------------------------------------------
    // Agent events

    private onAgentEvent(e: AgentEvent) {
        this.lastEventAt = Date.now();
        this.agentWork = true;
        switch (e.type) {
            case "request_start":
                this.status = undefined;
                this.thinkingNow = false;
                break;
            case "text": {
                this.thinkingNow = false;
                if (this.thinking) this.flushThinking();
                if (!this.md) {
                    this.mdCols = termCols();
                    this.md = new MarkdownStream(this.mdCols - 2);
                    this.mdLines = 0;
                }
                this.streamChars += e.text.length;
                this.mdSource += e.text;
                this.printAssistant(this.md.push(e.text));
                break;
            }
            case "thinking":
                this.thinkingNow = true;
                this.thinking += e.text;
                this.streamChars += e.text.length;
                break;
            case "tool_call_start":
                this.thinkingNow = false;
                this.flushStream();
                this.receiving.set(e.id, { name: e.name, chars: 0 });
                break;
            case "tool_call_delta": {
                const r = this.receiving.get(e.id);
                if (r) r.chars += e.partial.length;
                this.streamChars += e.partial.length;
                break;
            }
            case "server_tool":
                this.thinkingNow = false;
                this.flushStream();
                if (e.name === "web_search") this.screen.print(["", toolLine("Web Search", "ok")]);
                else if (e.name === "web_search_result") {
                    const detail = e.detail;
                    this.screen.print((cols) => resultLines(detail, cols, 1));
                }
                break;
            case "assistant": {
                this.flushStream();
                this.receiving.clear();
                const t = textOf(e.message).trim();
                if (t) this.lastResponse = t;
                break;
            }
            case "tool_start":
                this.receiving.delete(e.call.id);
                this.active.set(e.call.id, { call: e.call, title: e.title, tool: e.tool, startedAt: Date.now(), progress: "" });
                break;
            case "tool_progress": {
                const a = this.active.get(e.id);
                if (a) a.progress = (a.progress + e.text).slice(-8000);
                break;
            }
            case "tool_approved": {
                const a = this.active.get(e.id);
                if (a) {
                    a.autoReason = e.reason;
                    a.sandboxed = e.sandboxed;
                }
                break;
            }
            case "tool_end": {
                const a = this.active.get(e.call.id);
                // Retitled at its end (a backend's web search, whose query comes then).
                if (a && e.title) a.title = e.title;
                this.printToolResult(e.call, e.result, e.durationMs);
                this.active.delete(e.call.id);
                break;
            }
            case "notice":
                this.flushStream();
                this.notice(e.message, e.level);
                break;
            case "retry":
                if (this.md?.hasContent || this.mdLines) this.notice("(connection problem; the partial response above was discarded and is being retried)", "warn");
                this.md = undefined;
                this.mdLines = 0;
                this.mdEntries = [];
                this.mdSource = "";
                this.thinking = "";
                this.thinkingNow = false;
                this.receiving.clear();
                this.status = `${e.reason.slice(0, 80)} · retrying in ${Math.ceil(e.delayMs / 1000)}s (attempt ${e.attempt})`;
                break;
            case "limits":
                this.planLimits.set(e.limits.provider, mergeLimits(this.planLimits.get(e.limits.provider), e.limits, e.partial));
                break;
            case "usage":
                this.turnTokens += e.usage.outputTokens;
                this.streamChars = 0;
                this.thinkingNow = false;
                break;
            case "compact_start":
                this.verb = "Compacting conversation";
                break;
            case "compact_end":
                this.screen.print(["", theme.muted(`✻ Conversation compacted · ${this.verbose ? "summary below" : "/summary to view the summary"}`)]);
                if (this.verbose) {
                    const summary = e.summary;
                    this.screen.print((cols) => renderMarkdown(summary, cols - 4).map((l) => "  " + dim(l)));
                }
                this.verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
                break;
            case "subagent":
                this.onSubagentEvent(e.parentId, e.label, e.event);
                break;
            case "turn_end":
                this.flushStream();
                this.receiving.clear();
                if (e.reason === "aborted") {
                    this.screen.print(theme.error(`  ⎿  Interrupted · What should ${APP_TITLE} do instead?`));
                    // Messages queued for the interrupted turn go back to the prompt instead of running.
                    this.returnQueued();
                } else if (e.reason === "max_turns") this.notice(`--max-turns ${this.init.maxTurns} limits each prompt; send a message to let it continue.`);
                break;
        }
        this.renderLive();
    }

    private onSubagentEvent(parentId: string, label: string, e: AgentEvent) {
        let a = this.active.get(parentId) ?? this.detached.get(parentId);
        // One working after its call returned (Codex's spawn does at once): shown on its own while it works.
        if (!a && (e.type === "request_start" || e.type === "tool_start")) {
            a = { call: { type: "tool_call", id: parentId, name: "Task", input: { description: label } }, title: `Task(${label})`, startedAt: Date.now(), progress: "" };
            this.detached.set(parentId, a);
        }
        if (!a) return;
        a.sub ??= { label, tools: [], count: 0, tokens: 0, startedAt: Date.now() };
        if (e.type === "tool_start") {
            a.sub.count++;
            a.sub.tools.push(e.title);
            if (a.sub.tools.length > 3) a.sub.tools.shift();
        } else if (e.type === "usage") a.sub.tokens += e.usage.outputTokens + e.usage.inputTokens + (e.usage.cacheReadTokens ?? 0);
        else if (e.type === "notice" && e.level === "error") a.progress = e.message;
        else if (e.type === "turn_end" && this.detached.get(parentId) === a) {
            this.detached.delete(parentId);
            const { count, tokens, startedAt } = a.sub;
            const ok = e.reason === "done" || e.reason === "max_turns";
            this.screen.print(["", toolLine(a.title, ok ? "ok" : "error"), theme.muted(`  ⎿  ${ok ? "Done" : e.reason === "aborted" ? "Stopped" : "Failed"} (${count} tool use${count === 1 ? "" : "s"} · ${formatTokens(tokens)} tokens · ${formatDuration(Date.now() - startedAt)})`)]);
        }
    }

    private printToolResult(call: ToolCallPart, result: { content: string; isError?: boolean; display?: { summary?: string; body?: string; diff?: { path: string; before: string; after: string } } }, durationMs: number) {
        const a = this.active.get(call.id);
        const title = a?.title ?? call.name;
        const tool = a?.tool;
        const autoReason = a?.autoReason;
        const sandboxed = a?.sandboxed;
        const sub = a?.sub ? { ...a.sub } : undefined;
        const verbose = this.verbose;
        const todos = this.toolState.todos.map((t) => ({ ...t }));
        const denied = /^The user declined/.test(result.content);
        const state = denied ? "denied" : result.isError ? "error" : "ok";
        const d = result.display;
        const max = verbose ? 200 : 4;
        // Laid out again for the new width after a resize, from what was known when it finished.
        this.screen.print((cols) => {
            const out: string[] = ["", toolLine(displayTitle(title, tool), state)];
            if (sandboxed && autoReason === "sandboxed") out.push(theme.subtle("  ⎿  ran in the sandbox"));
            else if (autoReason && autoReason !== "hook") out.push(theme.subtle(`  ⎿  auto-approved${sandboxed ? " (sandboxed)" : ""}: ${truncate(autoReason, cols - 34)}`));
            if ((call.name === "Task" || call.name === DELEGATE_TOOL) && sub) {
                out.push(theme.muted(`  ⎿  ${result.isError ? "Failed" : "Done"} (${sub.count} tool use${sub.count === 1 ? "" : "s"} · ${formatTokens(sub.tokens)} tokens · ${formatDuration(durationMs)})`));
                if (verbose) out.push(...resultLines(result.content, cols, 40));
            } else if (denied) {
                const fb = result.content.match(/said:\n([\s\S]*)$/)?.[1];
                out.push(theme.warning(`  ⎿  ${fb ? `Declined: ${truncate(fb.split("\n")[0]!, cols - 18)}` : "Declined by user"}`));
            } else if (result.isError) {
                out.push(...resultLines(redact(result.content), cols, verbose ? 40 : 3, theme.error));
            } else if (call.name === "TodoWrite") {
                out.push(...renderTodos(todos, cols));
            } else if (d?.diff) {
                const { path, before, after } = d.diff;
                out.push(theme.muted(`  ⎿  ${d.summary ?? "Updated"}`));
                const body = before ? renderDiff(path, before, after, cols - 6, { maxLines: verbose ? 400 : 24 }) : renderFilePreview(path, after, cols - 6, verbose ? 400 : 10);
                out.push(...body.map((l) => "     " + l));
            } else if (d?.body !== undefined || call.name === "Bash" || call.name === "BashOutput") {
                // With a display, its body is what to show (none: the summary says it all).
                const body = d ? (d.body ?? "") : result.content;
                if (d?.summary) out.push(theme.muted(`  ⎿  ${d.summary}`));
                if (body.trim()) out.push(...resultLines(body, cols, max, (s) => s));
                else if (!d?.summary) out.push(theme.muted("  ⎿  (no output)"));
            } else if (d?.summary) {
                out.push(theme.muted(`  ⎿  ${d.summary}`));
                if (verbose) out.push(...resultLines(result.content, cols, 40).map((l) => l.replace("  ⎿  ", "     ")));
            } else {
                out.push(...resultLines(result.content, cols, max));
            }
            return out;
        });
    }

    // -----------------------------------------------------------------------
    // Permissions and UI bridges

    async showDialog<T>(d: Dialog & { done: Promise<T> }): Promise<T> {
        this.pushDialog(d);
        try {
            return await d.done;
        } finally {
            // A cancelled dialog is removed even if it hasn't been shown yet.
            this.popDialog(d);
        }
    }

    pushDialog(d: Dialog) {
        // A sub-agent must never redirect keystrokes meant for a masked input
        // into a permission or question. All interactive dialogs share the queue.
        if (this.dialogs.length || this.dialogQueue.length) this.dialogQueue.push(d);
        else this.dialogs.push(d);
        this.renderLive();
    }

    popDialog(d: Dialog) {
        this.dialogs = this.dialogs.filter((x) => x !== d);
        this.dialogQueue = this.dialogQueue.filter((x) => x !== d);
        if (!this.dialogs.length && !this.exiting) {
            // One abort can settle several dialogs together. Let their cleanup
            // remove queued prompts before deciding which one to display next.
            queueMicrotask(() => {
                if (this.dialogs.length || this.exiting) return;
                const next = this.dialogQueue.shift();
                if (next) this.dialogs.push(next);
                this.renderLive();
            });
        }
        this.renderLive();
    }

    private askPermission(req: PermissionRequest): Promise<PermissionResponse> {
        return req.signal?.aborted ? Promise.resolve({ allow: false }) : this.permissionDialog(req);
    }

    private async permissionDialog(req: PermissionRequest): Promise<PermissionResponse> {
        const { tool, input, decision } = req;
        const cols = termCols();
        const header: string[] = [];
        let title = "Tool use";
        const projectName = this.cwd.split("/").pop() || this.cwd;
        type Choice = "yes" | "always" | "session-edits" | "no";
        const items: SelectItem<Choice>[] = [{ label: "Yes", value: "yes" }];
        const suggestions = decision.suggestions ?? [];

        if (req.agentLabel) header.push(theme.muted(`Requested by sub-agent: ${req.agentLabel}`), "");
        if (tool.name === "Bash") {
            title = req.secrets?.length ? "Bash command with secrets" : "Bash command";
            const cmd = String(input.command ?? "");
            const { highlightCode } = await import("./highlight");
            const lines = highlightCode(cmd, "sh");
            header.push(...lines.slice(0, 12).map((l) => "  " + l));
            if (lines.length > 12) header.push(theme.subtle(`  … +${lines.length - 12} lines`));
            if (input.description) header.push(theme.muted(`  ${input.description}`));
            if (req.secrets?.length) header.push(theme.warning(`  It gets ${req.secrets.map((n) => `$${n}`).join(", ")} in its environment.`));
            const hosts = Array.isArray(input.allowedHosts) ? input.allowedHosts.map(String) : [];
            if (decision.sandbox && hosts.length) header.push(theme.muted(`  Sandboxed, with network access to ${hosts.join(", ")}`));
            if (!decision.dangerous && suggestions.length) {
                const label = suggestions.map((s) => s.replace(/^Bash\((.*?)(:\*)?\)$/, "$1")).join(", ");
                items.push({ label: `Yes, and don't ask again for ${bold(label)} commands in ${bold(projectName)}`, value: "always" });
            }
        } else if (tool.category === "edit") {
            const path = toolPath(tool.name, input) ?? "";
            const exists = (await import("fs")).existsSync(path.startsWith("/") ? path : join(this.toolState.cwd, path));
            title = tool.name === "Write" ? (exists ? "Overwrite file" : "Create file") : tool.name === "NotebookEdit" ? "Edit notebook" : "Edit file";
            header.push(bold(displayPath(path.startsWith("/") ? path : join(this.toolState.cwd, path), this.cwd)));
            if (req.preview?.summary) header.push(theme.muted(req.preview.summary));
            const diff = req.preview?.diff;
            if (diff) {
                const room = Math.max(6, termRows() - 16);
                const body = diff.before ? renderDiff(diff.path, diff.before, diff.after, cols - 8, { maxLines: room }) : renderFilePreview(diff.path, diff.after, cols - 8, room);
                header.push("", ...body);
            }
            if (decision.offerAcceptEdits) items.push({ label: `Yes, allow all edits during this session ${theme.muted("(shift+tab)")}`, value: "session-edits" });
            else if (suggestions.length) items.push({ label: `Yes, and allow edits in ${bold(suggestions[0]!.replace(/^Edit\(\/?(.*?)\/\*\*\)$/, "$1"))} this session`, value: "always" });
        } else if (tool.category === "read") {
            title = "Read outside the workspace";
            header.push(bold(toolPath(tool.name, input) ?? ""));
            if (suggestions.length) items.push({ label: `Yes, and allow reading from ${bold(suggestions[0]!.replace(/^Read\(\/?(.*?)\/\*\*\)$/, "$1"))} this session`, value: "always" });
        } else if (tool.name === "WebFetch") {
            title = "Fetch web page";
            header.push(bold(String(input.url ?? "")));
            if (input.prompt) header.push(theme.muted(String(input.prompt).slice(0, 200)));
            if (suggestions.length) items.push({ label: `Yes, and don't ask again for ${bold(suggestions[0]!.replace(/^WebFetch\(domain:(.*)\)$/, "$1"))}`, value: "always" });
        } else if (tool.category === "mcp") {
            title = "MCP tool";
            header.push(bold(req.title));
            const args = JSON.stringify(input, null, 2).split("\n");
            header.push(...args.slice(0, 12).map((l) => theme.muted("  " + l)));
            if (args.length > 12) header.push(theme.subtle(`  … +${args.length - 12} lines`));
            if (suggestions.length) items.push({ label: `Yes, and don't ask again for ${bold(tool.name)} in ${bold(projectName)}`, value: "always" });
        } else {
            header.push(bold(req.title));
        }
        if (decision.dangerous) header.unshift(theme.error(`⚠ ${decision.reason ?? "This action is potentially destructive."}`), "");
        else if (decision.reason && tool.name !== "Bash") header.push("", theme.muted(decision.reason));
        if (req.classifierReason) header.push("", theme.autoMode(`Auto mode asked you because: ${req.classifierReason}`));
        header.push("", "Do you want to proceed?");
        items.push({ label: `No, and tell ${APP_TITLE} what to do differently ${theme.muted("(esc)")}`, value: "no" });
        // Its sub-agent was stopped while this was put together.
        if (req.signal?.aborted) return { allow: false };

        const d = new SelectDialog<Choice>({
            title,
            header,
            items,
            numbers: true,
            color: decision.dangerous ? theme.error : theme.permission,
            hint: "↑↓ enter to choose · esc to decline",
            onExtraKey: (k, dlg) => {
                if (k.name === "tab" && k.shift && items.some((i) => i.value === "session-edits")) {
                    dlg.choose("session-edits");
                    return true;
                }
                return false;
            },
        });
        void this.notifier.notify("permission");
        // Withdrawn when its sub-agent is stopped.
        const withdraw = () => d.cancel();
        req.signal?.addEventListener("abort", withdraw, { once: true });
        const choice = ((await this.showDialog(d).finally(() => req.signal?.removeEventListener("abort", withdraw))) as Choice | undefined) ?? "no";
        if (req.signal?.aborted) return { allow: false };
        switch (choice) {
            case "yes":
                return { allow: true };
            case "always":
                return { allow: true, rules: suggestions, scope: tool.category === "read" || tool.category === "edit" ? "session" : "local" };
            case "session-edits":
                return { allow: true, setMode: "acceptEdits" };
            default:
                return { allow: false };
        }
    }

    /** A masked prompt; the value goes back to the tool and is never printed. */
    private async requestSecret(name: string, purpose: string, signal: AbortSignal): Promise<string | undefined> {
        if (signal.aborted) return undefined;
        const d = new InputDialog({
            title: `The agent asks for a secret: ${name}`,
            header: [purpose, theme.muted(`Only this session's shell commands see the value, as $${name}; the agent gets its name.`)],
            secret: true,
            exact: true,
            placeholder: "Type or paste the value (input is hidden)",
            color: theme.info,
            hint: "enter to provide · esc to decline",
            validate: (v) => secretValueError(v, name),
        });
        void this.notifier.notify("question");
        const withdraw = () => d.cancel();
        signal.addEventListener("abort", withdraw, { once: true });
        const value = await this.showDialog(d).finally(() => signal.removeEventListener("abort", withdraw));
        return signal.aborted ? undefined : value;
    }

    private async askQuestion(question: string, options: { label: string; description?: string }[], multi: boolean): Promise<string[] | undefined> {
        const OTHER = "\u0000other";
        const items: SelectItem<string>[] = options.map((o) => ({ label: o.label, value: o.label, description: o.description }));
        items.push({ label: theme.muted("Type something else…"), value: OTHER });
        const d = new SelectDialog<string>({ title: question, items, multi, numbers: true, color: theme.info });
        void this.notifier.notify("question");
        const r = await this.showDialog(d);
        if (r === undefined) return undefined;
        const arr = Array.isArray(r) ? r : [r];
        if (arr.includes(OTHER)) {
            const text = await this.showDialog(new InputDialog({ title: question, placeholder: "Your answer", color: theme.info }));
            if (text === undefined) return undefined;
            return [...arr.filter((x) => x !== OTHER), text];
        }
        return arr;
    }

    private async approvePlan(plan: string): Promise<{ approved: boolean; mode?: PermissionMode; feedback?: string }> {
        this.screen.print((cols) => ["", `${theme.planMode(BULLET)} ${bold("Plan ready for review")}`, ...renderMarkdown(plan, cols - 4).map((l) => "  " + l)]);
        type C = "accept" | "manual" | "auto" | "no";
        const d = new SelectDialog<C>({
            title: "Ready to code?",
            header: [theme.muted(`${APP_TITLE} has finished planning. Would you like to proceed?`)],
            items: [
                { label: "Yes, and auto-accept edits", value: "accept" },
                { label: "Yes, and manually approve edits", value: "manual" },
                { label: "Yes, in auto mode", value: "auto" },
                { label: "No, keep planning", value: "no", description: "tell it what to change" },
            ],
            numbers: true,
            color: theme.planMode,
        });
        void this.notifier.notify("plan");
        const c = (await this.showDialog(d)) as C | undefined;
        if (!c) return { approved: false };
        if (c === "no") {
            const fb = await this.showDialog(new InputDialog({ title: "What should change in the plan?", placeholder: "Feedback for the next revision", color: theme.planMode, multiline: true }));
            return { approved: false, feedback: fb };
        }
        return { approved: true, mode: c === "accept" ? "acceptEdits" : c === "auto" ? "auto" : "default" };
    }

    // -----------------------------------------------------------------------
    // Input

    private onKey(k: Key) {
        const top = this.dialogs[this.dialogs.length - 1];
        if (top) {
            if (k.ctrl && k.name === "c" && this.busy) {
                // cancel the prompt and the turn
                top.cancel();
                this.interrupt();
                return;
            }
            top.onKey(k);
            this.renderLive();
            return;
        }
        this.handleEditorKey(k);
        this.renderLive();
    }

    private interrupt() {
        if (!this.busy) return;
        this.abort?.abort();
        for (const d of [...this.dialogs, ...this.dialogQueue]) d.cancel();
        this.status = "Interrupting";
    }

    private handleEditorKey(k: Key) {
        const e = this.editor;
        const n = k.name;
        const menu = this.completions();
        if (menu && menu.items.length) {
            if (n === "up") return void (this.menuIndex = (this.menuIndex - 1 + menu.items.length) % menu.items.length);
            if (n === "down") return void (this.menuIndex = (this.menuIndex + 1) % menu.items.length);
            if (n === "tab" && !k.shift) return this.applyCompletion(menu, false);
            if (n === "enter" && !k.shift && !k.meta && !k.ctrl) return this.applyCompletion(menu, true);
            if (n === "escape") {
                this.menuHiddenFor = e.text;
                return;
            }
        }
        if (k.ctrl && n === "c") {
            if (this.busy) return this.interrupt();
            if (!e.isEmpty || this.inputMode !== "prompt") {
                e.clear();
                this.inputMode = "prompt";
                return;
            }
            if (Date.now() - this.ctrlCAt < 2000) return void this.exit(0);
            this.ctrlCAt = Date.now();
            this.flash = { text: "Press Ctrl-C again to exit", until: Date.now() + 2000 };
            setTimeout(() => this.renderLive(), 2100);
            return;
        }
        if (k.ctrl && n === "d") {
            if (e.isEmpty && !this.busy) return void this.exit(0);
            return e.del();
        }
        if (n === "escape") {
            if (this.busy) return this.interrupt();
            if (this.showHelp) return void (this.showHelp = false);
            if (Date.now() - this.escAt < 800) {
                this.escAt = 0;
                this.flash = undefined;
                if (!e.isEmpty) {
                    e.clear();
                    this.inputMode = "prompt";
                } else if (this.inputMode === "prompt") void runCommand(this, "/rewind");
                return;
            }
            this.escAt = Date.now();
            if (!e.isEmpty) this.flash = { text: "Esc again to clear", until: Date.now() + 800 };
            else if (this.inputMode === "prompt" && rewindTargets(this.session.messages).length) this.flash = { text: "Esc again to rewind", until: Date.now() + 800 };
            return;
        }
        if (n === "tab" && k.shift) return this.cycleMode();
        if (n === "enter") {
            if (k.shift || k.meta || k.ctrl) return e.insert("\n");
            if (e.text.endsWith("\\") && e.cursor === e.text.length) {
                e.backspace();
                return e.insert("\n");
            }
            return void this.submit();
        }
        if (n === "paste" && k.paste !== undefined) return e.paste(k.paste);
        if (n === "text" && k.text) {
            if (e.isEmpty && this.inputMode === "prompt") {
                if (k.text === "!" ) return void (this.inputMode = "bash");
                if (k.text === "#") return void (this.inputMode = "memory");
                if (k.text === "?") return void (this.showHelp = !this.showHelp);
            }
            this.showHelp = false;
            return e.insert(k.text);
        }
        if (n === "backspace") {
            if (e.isEmpty && this.inputMode !== "prompt") return void (this.inputMode = "prompt");
            return k.meta || k.ctrl ? e.killWordLeft() : e.backspace();
        }
        if (n === "delete") return k.meta ? e.killWordRight() : e.del();
        if (n === "left" || (k.ctrl && n === "b")) return k.meta || (k.ctrl && n === "left") ? e.wordLeft() : e.left();
        if (n === "right" || (k.ctrl && n === "f")) return k.meta || (k.ctrl && n === "right") ? e.wordRight() : e.right();
        if (k.meta && n === "b") return e.wordLeft();
        if (k.meta && n === "f") return e.wordRight();
        if (k.meta && n === "d") return e.killWordRight();
        if (n === "home" || (k.ctrl && n === "a")) return e.home();
        if (n === "end" || (k.ctrl && n === "e")) return e.end();
        if (k.ctrl && n === "k") return e.killToEnd();
        if (k.ctrl && n === "u") return e.killToStart();
        if (k.ctrl && n === "w") return e.killWordLeft();
        if (k.ctrl && n === "y") return e.yank();
        if (k.ctrl && (n === "_" || n === "-")) return e.undo();
        if (n === "up" || (k.ctrl && n === "p")) {
            if (n === "up" && e.up()) return;
            if (e.historyPrev()) this.syncModeFromHistory();
            return;
        }
        if (n === "down" || (k.ctrl && n === "n")) {
            if (n === "down" && e.down()) return;
            if (e.historyNext()) this.syncModeFromHistory();
            return;
        }
        if (k.ctrl && n === "o") {
            this.verbose = !this.verbose;
            this.flash = { text: `Verbose output ${this.verbose ? "on" : "off"}`, until: Date.now() + 1500 };
            return;
        }
        if (k.ctrl && n === "t") {
            this.showTodos = !this.showTodos;
            return;
        }
        if (k.ctrl && n === "l") return this.screen.clearScreen();
        if (k.ctrl && n === "g") return void this.externalEditor();
    }

    private syncModeFromHistory() {
        const t = this.editor.text;
        if (t.startsWith("!")) {
            this.inputMode = "bash";
            this.editor.set(t.slice(1));
        } else if (t.startsWith("#")) {
            this.inputMode = "memory";
            this.editor.set(t.slice(1));
        } else this.inputMode = "prompt";
    }

    cycleMode() {
        this.setMode(nextMode(this.mode, this.bypassAllowed()));
    }

    private async externalEditor() {
        const editor = process.env.VISUAL || process.env.EDITOR || "vi";
        const dir = mkdtempSync(join(tmpdir(), "harness-prompt-"));
        const file = join(dir, "prompt.md");
        writeFileSync(file, this.editor.value());
        await this.screen.suspend(() => {
            spawnSync(["sh", "-c", `${editor} "$1"`, "sh", file], { stdio: ["inherit", "inherit", "inherit"], env: childEnv() });
        });
        try {
            const text = readFileSync(file, "utf-8").replace(/\n$/, "");
            this.editor.set(text);
        } catch {
            // ignore
        }
        rmSync(dir, { recursive: true, force: true });
        this.renderLive();
    }

    // -----------------------------------------------------------------------
    // Completion menu

    private completions(): { items: { label: string; description?: string; insert: string; start: number; end: number; run?: boolean }[] } | undefined {
        if (this.dialogs.length || this.inputMode !== "prompt") return undefined;
        const e = this.editor;
        if (this.menuHiddenFor === e.text) return undefined;
        const tok = e.tokenAtCursor();
        if (e.text.startsWith("/") && tok.start === 0 && !e.text.includes(" ")) {
            const q = e.text.slice(1).toLowerCase();
            const all = commandList(this);
            const items = all
                .filter((c) => c.name.startsWith(q) || (q.length > 1 && c.name.includes(q)) || c.aliases?.some((a) => a.startsWith(q)))
                .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name))
                .slice(0, 8)
                .map((c) => ({ label: "/" + c.name + (c.args ? " " + theme.subtle(c.args) : ""), description: c.description, insert: "/" + c.name + (c.args ? " " : ""), start: 0, end: e.text.length, run: !c.args }));
            if (items.length === 1 && items[0]!.insert.trim() === e.text.trim()) return { items: [] };
            if (this.menuIndex >= items.length) this.menuIndex = 0;
            return { items };
        }
        if (tok.text.startsWith("@") && tok.text.length >= 1) {
            const q = tok.text.slice(1).replace(/^"/, "");
            const found = this.files.search(q, 8);
            if (this.menuIndex >= found.length) this.menuIndex = 0;
            return { items: found.map((p) => ({ label: "@" + p, insert: "@" + (p.includes(" ") ? `"${p}"` : p) + (p.endsWith("/") ? "" : " "), start: tok.start, end: e.cursor })) };
        }
        return undefined;
    }

    private applyCompletion(menu: NonNullable<ReturnType<App["completions"]>>, enter: boolean) {
        const item = menu.items[this.menuIndex] ?? menu.items[0];
        if (!item) return;
        this.editor.replaceRange(item.start, item.end, item.insert);
        this.menuIndex = 0;
        if (enter && item.run) void this.submit();
    }

    // -----------------------------------------------------------------------
    // Submitting

    private async submit() {
        const mode = this.inputMode;
        const text = this.editor.value();
        if (!text.trim()) return;
        const histEntry = (mode === "bash" ? "!" : mode === "memory" ? "#" : "") + text;
        this.editor.pushHistory(histEntry);
        appendPromptHistory(this.cwd, histEntry);
        this.editor.clear();
        this.inputMode = "prompt";
        this.showHelp = false;
        this.renderLive();
        if (mode === "bash") return this.runBashMode(text);
        if (mode === "memory") return this.addMemory(text);
        await this.submitText(text);
    }

    async submitText(text: string) {
        if (this.switching) await this.switching.catch(() => undefined);
        if (text.startsWith("/") && !text.startsWith("//")) {
            const handled = await runCommand(this, text);
            if (handled) return;
        }
        if (this.busy) {
            this.queued.push(text);
            this.renderLive();
            return;
        }
        await this.startTurn(text);
    }

    async startTurn(text: string, opts: { display?: string; kind?: "prompt" | "command" } = {}) {
        if (!this.agent) {
            this.notice("No model is selected. Pick one with /model (or add an API key with /login).", "error");
            return;
        }
        // Busy from here on, so prompts typed while MCP servers finish connecting queue up.
        const agent = this.agent;
        this.busy = true;
        const ac = (this.abort = new AbortController());
        this.turnStart = Date.now();
        this.turnTokens = 0;
        this.streamChars = 0;
        this.thinkingNow = false;
        this.lastEventAt = this.turnStart;
        this.agentWork = true;
        this.verb = SPINNER_VERBS[Math.floor(Math.random() * SPINNER_VERBS.length)]!;
        this.status = undefined;
        this.startTicker();
        let reason: TurnEndReason | undefined;
        try {
            this.printUser(opts.display ?? text);
            if (!this.session.meta.system) await this.freezeSystemPrompt(ac.signal);
            if (ac.signal.aborted) {
                // Nothing was sent: hand the message back rather than dropping it.
                this.screen.print(theme.error(`  ⎿  Interrupted before sending; your message is back in the prompt.`));
                this.queued.unshift(opts.kind === "command" ? (opts.display ?? text) : text);
            } else {
                const roots = [this.cwd, ...(this.settings.permissions?.additionalDirectories ?? [])];
                const { parts, attached } = expandMentions(text, this.toolState, roots);
                if (attached.length) this.notice(`Attached ${attached.join(", ")}`);
                reason = await agent.run(parts, { signal: ac.signal, display: opts.display ?? text, kind: opts.kind });
            }
        } catch (e) {
            this.notice(`Unexpected error: ${redact((e as Error).message)}`, "error");
            reason = "error";
        } finally {
            this.busy = false;
            this.abort = undefined;
            this.stopTicker();
            this.active.clear();
            this.detached.clear();
            this.status = undefined;
            this.renderLive();
        }
        if (reason) void this.notifier.turnEnded(reason, Date.now() - this.turnStart);
        if (ac.signal.aborted) return this.returnQueued();
        const next = this.queued.shift();
        if (next !== undefined) await this.submitText(next);
    }

    /** Run a non-chat task (like /compact) with the spinner and esc-to-cancel. */
    async runTask<T>(verb: string, fn: (signal: AbortSignal) => Promise<T>): Promise<T | undefined> {
        if (this.busy) {
            this.notice("Wait for the current response to finish, or press esc to interrupt it.", "warn");
            return undefined;
        }
        this.busy = true;
        const ac = (this.abort = new AbortController());
        this.turnStart = Date.now();
        this.turnTokens = 0;
        this.streamChars = 0;
        this.thinkingNow = false;
        this.lastEventAt = this.turnStart;
        this.agentWork = false;
        this.verb = verb;
        this.status = undefined;
        this.startTicker();
        try {
            return await fn(ac.signal);
        } catch (e) {
            if (!ac.signal.aborted) this.notice(redact((e as Error).message), "error");
            else this.notice("Cancelled", "warn");
            return undefined;
        } finally {
            this.busy = false;
            this.abort = undefined;
            this.stopTicker();
            this.active.clear();
            this.detached.clear();
            this.renderLive();
            this.afterTask(ac.signal.aborted);
        }
    }

    /** Messages typed during a task run next; after a cancel they go back to the prompt. */
    private afterTask(cancelled: boolean) {
        if (!this.queued.length) return;
        if (cancelled) return this.returnQueued();
        const next = this.queued.shift()!;
        // After the caller (a command like /compact) has finished.
        setTimeout(() => void this.submitText(next), 0);
    }

    /** After an interrupt, unsent messages go back to the prompt, ahead of anything being typed, instead of running. */
    private returnQueued() {
        if (!this.queued.length) return;
        const prefix = this.inputMode === "bash" ? "!" : this.inputMode === "memory" ? "#" : "";
        const draft = this.editor.text ? prefix + this.editor.text : "";
        this.editor.set([...this.queued, draft].filter(Boolean).join("\n"));
        this.queued = [];
        this.inputMode = "prompt";
        this.renderLive();
    }

    async freezeSystemPrompt(signal?: AbortSignal) {
        // Give MCP servers a moment so their instructions make it into the prompt.
        const connecting = () => [...this.mcp.servers.values()].some((s) => s.status === "connecting" || s.status === "pending");
        if (connecting()) {
            this.status = "Connecting MCP servers";
            this.renderLive();
            const until = Date.now() + 5000;
            while (connecting() && Date.now() < until && !signal?.aborted) await new Promise((r) => setTimeout(r, 100));
            this.status = undefined;
        }
        // --append-system-prompt isn't frozen in: the agent adds this run's to every request.
        this.session.setSystem(buildSystemPrompt({ cwd: this.cwd, model: this.model!, append: this.mcp.instructions() || undefined }));
    }

    private async runBashMode(cmd: string) {
        if (this.busy) {
            this.notice("Still working on the last request; press esc to interrupt it, then run the command.", "warn");
            if (this.editor.isEmpty) {
                this.editor.set(cmd);
                this.inputMode = "bash";
            }
            return;
        }
        this.screen.print(["", theme.bashMode("! ") + cmd]);
        // As a task: esc and ctrl+c stop it, and prompts typed meanwhile queue up.
        const res = await this.runTask("Running", (signal) => runShell({ command: cmd, cwd: this.toolState.cwd, timeoutMs: 120_000, signal, env: childEnv(this.settings.env) }));
        if (!res) return;
        const out = redact(res.output.replace(/\s+$/, ""));
        const note = res.aborted ? "\n(interrupted)" : res.timedOut ? "\n(stopped after 2 minutes)" : "";
        const maxLines = this.verbose ? 200 : 20;
        this.screen.print((cols) => resultLines((out || "(no output)") + note, cols, maxLines, (s) => s));
        if (res.newCwd) this.toolState.cwd = res.newCwd;
        // Let the model see it next turn.
        const text = `<bash-input>${cmd}</bash-input>\n<bash-stdout>${out.slice(0, 20_000)}</bash-stdout>${res.exitCode ? `\n<bash-exit-code>${res.exitCode}</bash-exit-code>` : ""}`;
        this.agent?.addReminder(`The user ran a shell command themselves (output shown to them):\n${text}`);
    }

    private async addMemory(note: string) {
        type S = "project" | "local" | "user";
        const d = new SelectDialog<S>({
            title: "Where should this memory go?",
            header: [theme.muted(note)],
            items: [
                { label: "Project memory", value: "project", description: "HARNESS.md, checked in and shared with the team" },
                { label: "Project memory (local)", value: "local", description: "HARNESS.local.md, git-ignored, just for you" },
                { label: "User memory", value: "user", description: "~/.harness/HARNESS.md, all your projects" },
            ],
            color: theme.memoryMode,
        });
        const scope = (await this.showDialog(d)) as S | undefined;
        if (!scope) return;
        const file = addMemoryNote(scope, this.cwd, note);
        this.screen.print(["", `${theme.memoryMode("#")} ${note}`, theme.muted(`  ⎿  Saved to ${displayPath(file, this.cwd)}`)]);
        this.agent?.addReminder(`The user added this to their memory file ${displayPath(file, this.cwd)}; follow it from now on:\n${note}`);
    }

    // -----------------------------------------------------------------------
    // Rendering

    private startTicker() {
        this.stopTicker();
        this.ticker = setInterval(() => {
            this.frame++;
            this.renderLive();
        }, 120);
    }

    private stopTicker() {
        if (this.ticker) clearInterval(this.ticker);
        this.ticker = undefined;
    }

    renderLive() {
        if (this.exiting) return;
        const cols = termCols();
        const rows = termRows();
        // The reply and running tools continue the output; the spinner, prompt and footer stay on the bottom rows.
        const { flow, status } = this.busy ? this.renderActivity(cols, rows) : { flow: [], status: [] };
        const lines = [...flow];
        if (status.length) lines.push("", ...status);
        lines.push("");
        const top = this.dialogs[this.dialogs.length - 1];
        if (top) lines.push(...top.render(cols, Math.max(8, rows - lines.length - 1)));
        else lines.push(...this.renderInput(cols));
        this.screen.setLive(lines, flow.length);
    }

    /**
     * What's happening right now: the reply so far and each running tool
     * (`flow`), then the spinner, todos and queued messages (`status`). Each
     * part of `flow` has a blank line before it, like the finished output.
     */
    private renderActivity(cols: number, rows: number): { flow: string[]; status: string[] } {
        const out: string[] = [];
        const block = (lines: string[], attached = false) => {
            if (!lines.length) return;
            if (!attached || out.length) out.push("");
            out.push(...lines);
        };
        // The reply's unfinished tail. When part of it is already printed above, this continues it.
        if (this.md) {
            const pend = this.md.pending();
            const shown = pend.slice(-Math.max(3, Math.floor(rows / 2)));
            block(
                shown.map((l, i) => (this.mdLines === 0 && i === 0 && pend.length === shown.length ? `${BULLET} ` : "  ") + l),
                this.mdLines > 0,
            );
        }
        if (this.thinking && this.shouldShowThinking() && !this.md) {
            const tl = this.thinking.trim().split("\n").flatMap((l) => wrapLine(l, cols - 4)).slice(-3);
            block(tl.map((l, i) => (i === 0 ? theme.muted("✻ ") : "  ") + italic(theme.muted(l))));
        }
        for (const [, r] of this.receiving) {
            block([`${theme.muted(BULLET)} ${bold(r.name)} ${theme.muted(r.chars ? `writing… ${formatTokens(r.chars)} chars` : "preparing…")}`]);
        }
        const progressLines = rows >= 36 ? 8 : 4;
        for (const a of [...this.active.values(), ...this.detached.values()]) {
            const lines = [toolLine(displayTitle(a.title, a.tool), "running", this.frame % 6 < 3)];
            if (a.sub) {
                for (const t of a.sub.tools) lines.push(theme.muted(`  ⎿  ${truncate(t, cols - 8)}`));
                const more = a.sub.count - a.sub.tools.length;
                lines.push(theme.subtle(`     ${more > 0 ? `+${more} more tool uses · ` : ""}${formatTokens(a.sub.tokens)} tokens · ${formatDuration(Date.now() - a.sub.startedAt)}`));
            } else if (a.progress.trim()) {
                const pl = a.progress.replace(/\x1b\[[0-9;]*m/g, "").trimEnd().split("\n").slice(-progressLines);
                pl.forEach((l, i) => lines.push(theme.muted((i === 0 ? "  ⎿  " : "     ") + truncate(l, cols - 8))));
            } else if (Date.now() - a.startedAt > 3000) lines.push(theme.subtle(`  ⎿  running… ${formatDuration(Date.now() - a.startedAt)}`));
            block(lines);
        }
        const status: string[] = [];
        const waitingForUser = this.dialogs.length > 0;
        const elapsed = formatDuration(Date.now() - this.turnStart);
        const tokens = this.turnTokens + Math.round(this.streamChars / 4);
        const glyph = SPINNER_FRAMES[this.frame % SPINNER_FRAMES.length]!;
        if (!waitingForUser) {
            const label = this.status ?? `${this.verb}…`;
            // Some models send nothing until a whole step is ready (Gemini on Vertex, or thinking that
            // isn't streamed): after a while say what's being waited on, so it doesn't look stuck.
            const quiet = Date.now() - this.lastEventAt;
            const waiting = this.thinkingNow
                ? ` · thinking${quiet >= 10_000 ? ` ${formatDuration(quiet)}` : ""}`
                : quiet >= 10_000 && this.agentWork && this.model && !this.status && !this.active.size && !this.receiving.size
                  ? ` · waiting for ${shortModel(this.model)} ${formatDuration(quiet)}`
                  : "";
            status.push(`${theme.accent(glyph)} ${theme.accent(label)} ${theme.muted(`(${elapsed}${tokens ? ` · ↓ ${formatTokens(tokens)} tokens` : ""}${waiting} · esc to interrupt)`)}`);
        }
        const todos = this.toolState.todos;
        if (this.showTodos && todos.length && todos.some((t) => t.status !== "completed")) status.push(...renderTodos(todos, cols).slice(0, 10));
        for (const q of this.queued) status.push(theme.muted(`  ⏵ queued: ${truncate(q.replace(/\s+/g, " "), cols - 16)}`));
        return { flow: out, status };
    }

    private renderInput(cols: number): string[] {
        const color = this.inputMode === "bash" ? theme.bashMode : this.inputMode === "memory" ? theme.memoryMode : this.mode === "plan" ? theme.planMode : theme.subtle;
        const symbol = this.inputMode === "bash" ? "!" : this.inputMode === "memory" ? "#" : ">";
        const rule = color("─".repeat(Math.max(10, cols - 1)));
        const placeholder = this.inputMode === "bash" ? "Run a shell command" : this.inputMode === "memory" ? "Add to memory" : this.busy ? "Type a message to queue it for the next step" : 'Try "explain this codebase" or "fix the failing test"';
        const r = this.editor.render(cols - 2, color(symbol) + " ", "  ", { showCursor: true, placeholder });
        const maxInput = Math.max(3, termRows() - 12);
        let inputLines = r.lines;
        if (inputLines.length > maxInput) {
            const start = Math.max(0, Math.min(r.cursorRow - Math.floor(maxInput / 2), inputLines.length - maxInput));
            inputLines = inputLines.slice(start, start + maxInput);
        }
        const out = [rule, ...inputLines, rule];
        const menu = this.completions();
        if (menu && menu.items.length) {
            const labelW = Math.min(36, Math.max(...menu.items.map((i) => width(i.label))) + 2);
            menu.items.forEach((it, i) => {
                const sel = i === this.menuIndex;
                const label = padEnd(sel ? theme.permission(it.label) : it.label, labelW);
                out.push(truncate(`  ${label}${it.description ? theme.muted(it.description) : ""}`, cols - 1));
            });
            return out;
        }
        if (this.showHelp) {
            out.push(...shortcutHelp(cols));
            return out;
        }
        out.push(this.footer(cols));
        return out;
    }

    private footer(cols: number): string {
        let left: string;
        if (this.flash && this.flash.until > Date.now()) left = theme.muted(this.flash.text);
        else if (this.inputMode === "bash") left = theme.bashMode("! for bash mode") + theme.muted(" · backspace to exit");
        else if (this.inputMode === "memory") left = theme.memoryMode("# to memorize") + theme.muted(" · backspace to exit");
        else if (this.mode === "default") left = theme.muted("? for shortcuts");
        else {
            const info = MODE_INFO[this.mode];
            left = info.color(`${info.symbol} ${info.short} on`) + theme.muted(" (shift+tab to cycle)");
        }
        const parts: string[] = [];
        if (this.model) parts.push(shortModel(this.model));
        if (this.model?.supportsFastMode && (this.session.fastMode ?? this.settings.fastMode)) parts.push("↯ fast");
        if (this.agent && this.model?.contextWindow) {
            const used = this.agent.contextTokens || 0;
            if (used) {
                const pct = Math.round((used / this.model.contextWindow) * 100);
                parts.push(pct >= 70 ? theme.warning(`${pct}% context`) : `${pct}% context`);
            }
        }
        if (this.session?.cost) parts.push(formatCost(this.session.cost, this.session.costUnknown));
        const mcpFailed = [...this.mcp.servers.values()].filter((s) => s.status === "failed").length;
        if (mcpFailed) parts.push(theme.error(`${mcpFailed} MCP failed · /mcp`));
        const custom = this.statusLineText();
        const right = custom !== undefined ? custom : theme.muted(parts.join(" · "));
        const gap = cols - 3 - width(left) - width(right);
        return "  " + left + (gap > 1 ? " ".repeat(gap) + right : "");
    }

    private statusLine?: { text: string; at: number; running: boolean; command: string };

    /**
     * settings.statusLine.command: a shell command that gets session info as
     * JSON on stdin; the first line of its output replaces the footer's right
     * side. Re-run at most every 2 seconds, never blocking the UI.
     */
    private statusLineText(): string | undefined {
        const command = this.settings.statusLine?.command;
        if (!command) return undefined;
        const st = this.statusLine;
        if (st?.command !== command) this.statusLine = { text: "", at: 0, running: false, command };
        const s = this.statusLine!;
        if (!s.running && Date.now() - s.at > 2000) {
            s.running = true;
            const input = JSON.stringify({
                session_id: this.session?.meta.id,
                cwd: this.toolState.cwd,
                model: this.model ? { id: modelRef(this.model), display_name: this.model.name ?? this.model.id } : null,
                permission_mode: this.mode,
                cost_usd: this.session?.cost ?? 0,
                context_tokens: this.agent?.contextTokens ?? 0,
                context_window: this.model?.contextWindow ?? null,
            });
            void (async () => {
                try {
                    const proc = Bun.spawn(["sh", "-c", command], { cwd: this.toolState.cwd, env: childEnv(this.settings.env), stdin: new TextEncoder().encode(input), stdout: "pipe", stderr: "ignore" });
                    const timer = setTimeout(() => proc.kill(), 3000);
                    const out = await new Response(proc.stdout).text();
                    clearTimeout(timer);
                    // Colors are kept; cursor moves, clears and resets are dropped.
                    s.text = redact(sanitizeLine(out.split("\n")[0] ?? ""));
                } catch {
                    s.text = theme.error("statusLine failed");
                }
                s.at = Date.now();
                s.running = false;
                this.renderLive();
            })();
        }
        return s.text;
    }
}

/** A reply's rendered lines, as they're printed while streaming. */
function assistantLines(lines: string[]): string[] {
    return lines.flatMap((l, i) => (i === 0 ? ["", `${BULLET} ${l}`] : [`  ${l}`]));
}

function shortModel(m: ModelInfo): string {
    return m.name ?? m.id.replace(/^claude-/, "").replace(/^(anthropic|openai|google|meta-llama|mistralai|x-ai|deepseek|qwen)\//, "");
}

function displayTitle(title: string, tool?: Tool<any>): string {
    if (!tool) return title;
    // "Edit(src/x.ts)" reads better as "Update(src/x.ts)"
    if (tool.name === "Edit" || tool.name === "MultiEdit") return title.replace(/^(Multi)?Edit\(/, "Update(");
    return title;
}

export function renderTodos(todos: TodoItem[], cols: number): string[] {
    return todos.map((t, i) => {
        const prefix = i === 0 ? "  ⎿  " : "     ";
        if (t.status === "completed") return theme.muted(prefix) + theme.success("☒ ") + strike(theme.muted(truncate(t.content, cols - 10)));
        if (t.status === "in_progress") return theme.muted(prefix) + theme.accent("◼ ") + bold(truncate(t.activeForm ?? t.content, cols - 10));
        return theme.muted(prefix) + "☐ " + truncate(t.content, cols - 10);
    });
}

function shortcutHelp(cols: number): string[] {
    const rows = [
        ["! for bash mode", "double esc to clear or rewind", "shift+tab to cycle modes"],
        ["/ for commands", "ctrl+g to edit in $EDITOR", "ctrl+o for verbose output"],
        ["@ for file paths", "\\⏎ or ctrl+j for newline", "ctrl+t to toggle todos"],
        ["# to memorize", "esc to interrupt", "ctrl+c twice to exit"],
    ];
    const w = Math.floor((cols - 4) / 3);
    return [
        ...rows.map((r) => "  " + r.map((c) => padEnd(theme.muted(truncate(c, w - 1)), w)).join("")),
        "  " + theme.muted(truncate("shift+enter also adds a newline, in terminals that support it", cols - 4)),
    ];
}
