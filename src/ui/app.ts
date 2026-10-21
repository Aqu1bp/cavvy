// The interactive terminal app: prompt, transcript rendering, dialogs,
// permission prompts, and wiring between the agent and the screen.

import { spawnSync } from "bun";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Screen, type Entry, type Printable } from "./screen";
import { Editor, imagesIn, plainText, withoutImage, type Draft } from "./editor";
import { followUpDefault, loadQueue, saveQueue, type FollowUp, type StoredQueued } from "../agent/queue-store";
import type { Key } from "./keys";
import { CHORD_TIMEOUT_MS, type Keymap } from "../keybindings/core";
import { TuiKeybindings, tuiStroke } from "../keybindings/tui";
import { bold, dim, italic, strike, stripAnsi, theme, truncate, width, wrapLine, termCols, termRows, padEnd, sanitizeLine } from "./ansi";
import { inline, MarkdownStream, renderMarkdown } from "./markdown";
import { SelectDialog, InputDialog, MessageDialog, type Dialog } from "./dialogs";
import { BULLET, SPINNER_FRAMES, SPINNER_VERBS, formatDuration, renderDiff, renderFilePreview, resultLines, toolLine, type SelectItem } from "./components";
import { FileIndex, expandMentions } from "./mentions";
import { formatBytes } from "../util/files";
import { loadImageFile, planPaste, prepareImage, readClipboardImage, type NamedImage, type Prepared, type PrepareOptions } from "./images";
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
import { account } from "../providers/accounts";
import { RpcError } from "../server/rpc-error";
import { modelRef, parseModelRef, textOf, type ImagePart, type Message, type ModelInfo, type ProviderClient, type TextPart, type ToolCallPart } from "../providers/types";
import { formatCost, formatTokens } from "../providers/pricing";
import { attachmentsNote } from "../providers/files";
import { configuredProviders, storageDescription } from "../auth/credentials";
import { CLAUDE_CLI, CODEX_CLI, findCli } from "../backends/cli";
import { commandList, commandRefusesImages, runCommand } from "../commands/index";
import { loadCustomCommands, type CustomCommand } from "../commands/custom";
import { loadSkills, skillMentions, withSkills, type Skill } from "../agent/skills";
import { skillTool } from "../tools/skill-tool";
import { displayPath } from "../util/files";
import { redact } from "../util/redact";
import { SecretStore, secretValueError } from "../agent/secrets";
import { planLimitKey } from "../server/protocol";
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
    skills: Skill[] = [];
    /** The commands the session's agent CLI said it runs itself (Claude Code's skills and built-ins), by provider. */
    cliCommands?: { provider: string; names: ReadonlySet<string> };
    verbose = false;
    lastResponse = "";

    private dialogs: Dialog[] = [];
    private dialogQueue: Dialog[] = [];
    busy = false;
    /** Whether the last renderLive showed just the prompt (no turn, no dialog), to tell when it's back. */
    private wasIdle = false;
    private abort?: AbortController;
    /** Prompts typed while busy, each with the images behind its placeholders, and whether it steers the turn or waits for its end. */
    private queued: QueuedDraft[] = [];
    /** Images being read or shrunk, by attachment id. */
    private preparing = new Map<number, Promise<void>>();
    /** How long sending waits for images still being prepared before going without them. */
    attachWaitMs = 3000;
    /** How images are shrunk (tests replace it). */
    imagePrep: PrepareOptions = {};
    /** A prompt sent while its images were still being prepared: out of the editor, waiting for them. */
    private pendingSubmit?: { draft: Draft; cancel: () => void };
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
    /** The agent CLIs' plan limits as last reported, by provider and account (/cost shows them). */
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
    /** When Esc last found a queued slash command it couldn't take back: the next Esc interrupts. */
    private takeBackBlockedAt = 0;
    private flash?: { text: string; until: number };
    private showHelp = false;
    /** The keybindings file, applied (and reapplied on every save). */
    readonly keys = new TuiKeybindings();
    /** Keys of a chord being typed, handled as usual if it isn't finished. */
    private chordHeld: Key[] = [];
    private chordToken = 0;
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
        this.keys.watch((km, status) => this.reportKeybindings(km, status));
        for (const sig of ["SIGTERM", "SIGHUP"] as const) process.on(sig, () => void this.exit(0));

        this.customCommands = loadCustomCommands(this.cwd, this.init.trusted);
        this.skills = loadSkills(this.cwd, this.init.trusted);
        this.printWelcome();
        for (const n of this.init.startupNotes) this.notice(n, "warn");
        if (this.keys.keymap.issues.length) this.reportKeybindings(this.keys.keymap, "start");

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
        this.keys.close();
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

    /** Keep account changes between turns, like model changes. */
    setAccount(provider: string, id: string) {
        if (this.busy) throw new RpcError("Switch accounts once this response is done, or interrupt it first.", "busy");
        const selected = account(provider, id);
        if (!this.session.setAccount(provider, selected.id)) return;
        const name = getProvider(provider)?.name ?? provider;
        const text = this.session.messages.length
            ? `Continuing on ${name} · ${selected.name}: starting a new ${name} thread with this conversation as context.`
            : `Using ${name} · ${selected.name}.`;
        this.session.recordNotice("info", text);
        this.notice(text);
        this.renderLive();
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
        const skill = skillTool(this.skills);
        return [...builtin, ...(skill ? [skill] : []), ...this.mcp.tools()];
    }

    makeAgent() {
        if (!this.model || !this.client) return;
        // Tasks the old one delegated stop with it.
        void this.agent?.dispose();
        this.agent = new Agent({
            session: this.session,
            trusted: () => this.init.trusted,
            model: this.model,
            client: this.client,
            settings: () => this.settings,
            approvedMcpServers: () => this.mcp.approvedServers(),
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
                drainQueued: () => this.drainQueued(),
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
        this.checker.resetSession();
        this.makeAgent();
        this.sessionSwitched(prev, "clear");
    }

    /** Switch to a saved session (/resume), or to one just opened (a fork). */
    resume(from: string | Session) {
        const prev = this.session;
        try {
            this.session = typeof from === "string" ? Session.load(from) : from;
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
        this.checker.resetSession();
        if (this.agent) this.makeAgent();
        this.replayTranscript();
        this.restoreSavedQueue();
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
            const out: string[] = ["", historyRule(`Resumed session ${id} · ${count} messages`, cols)];
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
                    // A Claude Code or Codex turn ends with what it did ("[Codex used: …]"): shown as its actions, one a line.
                    const { text: t, actions } = splitActionsNote(m);
                    if (t) {
                        const md = renderMarkdown(t, cols - 2);
                        out.push("", ...md.slice(0, 30).map((l, i) => (i === 0 ? `${BULLET} ` : "  ") + l));
                        if (md.length > 30) out.push(theme.subtle(`  … +${md.length - 30} lines`));
                    }
                    const tools = [...m.content.flatMap((p) => (p.type === "tool_call" ? [p.name] : [])), ...actions];
                    for (const name of tools.slice(0, 8)) out.push(theme.muted(truncate(`  ${BULLET} ${name}`, cols - 2)));
                    if (tools.length > 8) out.push(theme.subtle(`  … +${tools.length - 8} more`));
                }
            });
            noticesUpTo(Infinity);
            out.push("", historyRule("end of resumed history", cols), "");
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
            const lines = thinkingLines(t, cols);
            const shown = lines.slice(0, max);
            const out = ["", ...shown.map((l, i) => (i === 0 ? theme.muted("✻ ") : "  ") + italic(theme.muted(l)))];
            if (lines.length > max) out.push(theme.subtle(`  … +${lines.length - max} lines (${this.keys.label("app:toggleTranscript") ?? "/config"} to show more next time)`));
            return out;
        });
    }

    // -----------------------------------------------------------------------
    // Agent events

    private onAgentEvent(e: AgentEvent) {
        this.lastEventAt = Date.now();
        this.agentWork = true;
        switch (e.type) {
            case "activity":
                this.status = e.text;
                break;
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
            case "cli_commands":
                this.cliCommands = { provider: e.provider, names: new Set(e.names) };
                break;
            case "limits":
                {
                    const key = planLimitKey(e.limits.provider, e.limits.accountId);
                    const prev = this.planLimits.get(key);
                    if (!prev || prev.at <= e.limits.at) this.planLimits.set(key, mergeLimits(prev, e.limits, e.partial));
                }
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
            // A background task's time counts from its start, not from when its call returned.
            const startedAt = this.agent?.delegatedTasks.find((t) => t.callId === parentId)?.startedAt ?? Date.now();
            a = { call: { type: "tool_call", id: parentId, name: "Task", input: { description: label } }, title: `Task(${label})`, startedAt, progress: "" };
            this.detached.set(parentId, a);
        }
        if (!a) return;
        a.sub ??= { label, tools: [], count: 0, tokens: 0, startedAt: a.startedAt };
        if (e.type === "tool_start") {
            a.sub.count++;
            a.sub.tools.push(e.title);
            if (a.sub.tools.length > 3) a.sub.tools.shift();
        } else if (e.type === "usage") a.sub.tokens += e.usage.outputTokens + e.usage.inputTokens + (e.usage.cacheReadTokens ?? 0);
        else if (e.type === "activity") a.progress = e.text ?? "";
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
            if (call.name === "Task" && d?.summary === "Started in the background") {
                const id = /background task (task-\d+)/.exec(result.content)?.[1];
                out.push(theme.muted(`  ⎿  Running in the background${id ? ` as ${id}` : ""} · /tasks shows it`));
            } else if ((call.name === "Task" || call.name === DELEGATE_TOOL) && sub) {
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
        type Choice = "yes" | "session" | "always" | "session-edits" | "no";
        const items: SelectItem<Choice>[] = [{ label: "Yes", value: "yes" }];
        if (decision.grant) items.push({ label: `Yes, and allow ${bold(decision.grant.label)} for the session`, value: "session" });
        const suggestions = decision.suggestions ?? [];
        // Where a generated summary can't be checked against the command, more of the command shows.
        let hiddenNote = "";

        if (req.agentLabel) header.push(theme.muted(`Requested by sub-agent: ${req.agentLabel}`), "");
        if (tool.name === "Bash") {
            title = req.secrets?.length ? "Bash command with secrets" : "Bash command";
            const cmd = String(input.command ?? "");
            const { highlightCode } = await import("./highlight");
            const lines = highlightCode(cmd, "sh");
            const shown = req.summary ? 40 : 12;
            header.push(...lines.slice(0, shown).map((l) => "  " + l));
            if (lines.length > shown) {
                header.push(theme.subtle(`  … +${lines.length - shown} lines`));
                hiddenNote = ` (command is ${lines.length} lines; showing first ${shown})`;
            }
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
        // What it does in a line, above the command, marked as the model's.
        if (req.summary) header.unshift(theme.muted("AI summary: ") + bold(req.summary) + (hiddenNote ? theme.warning(hiddenNote) : ""), "");
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
            case "session":
                return { allow: true, grant: true };
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
        if (this.pendingSubmit && ((k.ctrl && n === "c") || n === "escape")) return this.pendingSubmit.cancel();
        // Ctrl+C and Ctrl+D can't be rebound: they always get you out.
        if (k.ctrl && n === "c") {
            this.dropChord();
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
            this.dropChord();
            if (e.isEmpty && !this.busy) return void this.exit(0);
            return e.del();
        }
        const menu = this.completions();
        // Enter on the / and @ menu takes the suggestion, whatever Enter is bound to.
        if (n === "enter" && menu?.items.length && !k.shift && !k.meta && !k.ctrl && !this.chordHeld.length) return this.applyCompletion(menu, true);
        const stroke = tuiStroke(k);
        if (!stroke) {
            this.flushChord(menu);
            return this.fixedKey(k, menu);
        }
        const r = this.keys.matcher.match(stroke, menu?.items.length ? ["Autocomplete", "Chat", "Global"] : ["Chat", "Global"]);
        if (r.kind === "pending") {
            // A new chord after one that went nowhere: the old one's keys first.
            if (r.abandoned) for (const h of this.chordHeld.splice(0)) this.fixedKey(h, menu);
            this.chordHeld.push(k);
            this.flash = { text: `${r.keys.replace(/ctrl\+enter/g, "ctrl+j")} … (waiting for the next key)`, until: Date.now() + CHORD_TIMEOUT_MS };
            const token = ++this.chordToken;
            // A chord left unfinished: its keys do what they'd do on their own.
            setTimeout(() => {
                if (token !== this.chordToken || this.keys.matcher.waiting) return;
                // A dialog opened meanwhile: its keys aren't typed into the prompt behind it.
                if (this.dialogs.length) return this.dropChord();
                this.flushChord(this.completions());
                this.renderLive();
            }, CHORD_TIMEOUT_MS + 20);
            return;
        }
        const held = this.chordHeld.splice(0);
        if (held.length) this.flash = undefined;
        if (r.abandoned) for (const h of held) this.fixedKey(h, menu);
        if (r.kind === "action") return this.runKeyAction(r.action, k, this.completions());
        // Unbinding takes away an action, not the key's editing meaning (a GUI-only null can't break the prompt).
        return this.fixedKey(k, held.length ? this.completions() : menu, r.kind === "none" && r.unbound);
    }

    /** The keys of an unfinished chord, as they'd be on their own. */
    private flushChord(menu: ReturnType<App["completions"]>) {
        const held = this.chordHeld.splice(0);
        this.keys.matcher.reset();
        this.chordToken++;
        if (held.length && this.flash?.text.endsWith("(waiting for the next key)")) this.flash = undefined;
        for (const h of held) this.fixedKey(h, menu);
    }

    private dropChord() {
        if (!this.chordHeld.length) return;
        this.chordHeld = [];
        this.keys.matcher.reset();
        this.chordToken++;
        this.flash = undefined;
    }

    /** What a bound action does in the input box. */
    private runKeyAction(action: string, k: Key, menu: ReturnType<App["completions"]>) {
        const e = this.editor;
        const items = menu?.items.length ? menu : undefined;
        switch (action) {
            case "autocomplete:accept":
                return items && this.applyCompletion(items, false);
            case "autocomplete:dismiss":
                return void (this.menuHiddenFor = e.text);
            case "autocomplete:previous":
                return void (items && (this.menuIndex = (this.menuIndex - 1 + items.items.length) % items.items.length));
            case "autocomplete:next":
                return void (items && (this.menuIndex = (this.menuIndex + 1) % items.items.length));
            case "chat:submit":
                // Enter on an open menu takes the suggestion (and runs a command).
                if (items) return this.applyCompletion(items, true);
                if (e.text.endsWith("\\") && e.cursor === e.text.length) {
                    e.backspace();
                    return e.insert("\n");
                }
                return void this.submit();
            case "chat:newline":
                return e.insert("\n");
            case "chat:cancel":
                return this.escapeKey();
            case "chat:cycleMode":
                return this.cycleMode();
            case "chat:externalEditor":
                return void this.externalEditor();
            case "chat:imagePaste":
                return void this.pasteClipboardImage();
            case "chat:undo":
                return e.undo();
            case "history:previous":
                // The arrow moves between the lines of a long prompt first.
                if (k.name === "up" && !k.ctrl && !k.meta && e.up()) return;
                if (e.historyPrev()) this.syncModeFromHistory();
                return;
            case "history:next":
                if (k.name === "down" && !k.ctrl && !k.meta && e.down()) return;
                if (e.historyNext()) this.syncModeFromHistory();
                return;
            case "app:toggleTranscript":
                this.verbose = !this.verbose;
                this.flash = { text: `Verbose output ${this.verbose ? "on" : "off"}`, until: Date.now() + 1500 };
                return;
            case "app:toggleTodos":
                this.showTodos = !this.showTodos;
                return;
            case "app:redraw":
                return this.screen.clearScreen();
        }
    }

    private escapeKey() {
        const e = this.editor;
        if (this.busy) {
            // An Esc meant to cancel a queued follow-up must not kill the running turn.
            if (this.queued.length && Date.now() - this.takeBackBlockedAt >= 3000) return this.takeBackQueued();
            this.takeBackBlockedAt = 0;
            return this.interrupt();
        }
        if (this.showHelp) return void (this.showHelp = false);
        const again = this.keys.label("chat:cancel") ?? "esc";
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
        const name = again === "escape" ? "Esc" : again;
        if (!e.isEmpty) this.flash = { text: `${name} again to clear`, until: Date.now() + 800 };
        else if (this.inputMode === "prompt" && rewindTargets(this.session.messages).length) this.flash = { text: `${name} again to rewind`, until: Date.now() + 800 };
    }

    /** Keys that aren't bindings: typing and moving around the input box. */
    private fixedKey(k: Key, menu: ReturnType<App["completions"]>, unbound = false) {
        const e = this.editor;
        const n = k.name;
        // Tab keeps the mid-turn shortcut unless a binding, chord, or explicit unbinding claims it.
        if (!unbound && n === "tab" && !k.shift && !k.ctrl && !k.meta && this.busy && this.inputMode === "prompt" && e.text.trim()) {
            const contexts = menu?.items.length ? ["Autocomplete", "Chat", "Global"] as const : ["Chat", "Global"] as const;
            // A held chord prefix also comes here on timeout; preserve an explicit null then too.
            const binding = contexts.map((context) => this.keys.keymap.table.get(context)?.get("tab")).find((value) => value !== undefined);
            if (binding !== null) return void this.submit(true);
        }
        if (n === "enter" && menu?.items.length && !k.shift && !k.meta && !k.ctrl) return this.applyCompletion(menu, true);
        // Any other modified Enter nobody unbound adds a line, in terminals that tell them apart.
        if (n === "enter" && (k.shift || k.meta || k.ctrl)) return unbound ? undefined : e.insert("\n");
        if (n === "paste" && k.paste !== undefined) return this.pasteInto(k.paste);
        if (n === "text" && k.text) {
            if (e.isEmpty && this.inputMode === "prompt") {
                if (k.text === "!") return void (this.inputMode = "bash");
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
    }

    /** Keybindings problems, shown when the file loads or changes. */
    private reportKeybindings(km: Keymap, status: "start" | "applied" | "kept") {
        if (km.issues.length) {
            const errors = km.issues.filter((i) => i.level === "error").length;
            const warnings = km.issues.length - errors;
            const counts = [errors && `${errors} error${errors === 1 ? "" : "s"}`, warnings && `${warnings} warning${warnings === 1 ? "" : "s"}`].filter(Boolean).join(", ");
            const head = `${status === "kept" ? "Keybindings not reloaded, the last good ones stay" : status === "applied" ? "Keybindings reloaded with problems" : "Problems in your keybindings"} (${counts}): ${displayPath(this.keys.path, this.cwd)}`;
            const color = errors ? theme.error : theme.warning;
            this.screen.print((cols) => [
                ...wrapLine(head, cols - 6).map((l, i) => (i === 0 ? "  ⎿  " : "     ") + color(l)),
                ...km.issues.flatMap((issue) => wrapLine(issue.message, cols - 9).map((l, i) => (i === 0 ? `     ${issue.level === "error" ? theme.error("✘") : theme.warning("!")} ` : "       ") + l)),
            ]);
        } else if (status === "applied") this.notice(`Keybindings reloaded${km.customized.size ? ` (${km.customized.size} customized)` : ""}`);
        this.renderLive();
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
        const exported = this.editor.value();
        const before = this.editor.capture();
        writeFileSync(file, exported);
        await this.screen.suspend(() => {
            spawnSync(["sh", "-c", `${editor} "$1"`, "sh", file], { stdio: ["inherit", "inherit", "inherit"], env: childEnv() });
        });
        try {
            const saved = readFileSync(file, "utf-8");
            const text = saved.replace(/\n$/, "");
            // Saved unchanged (editors may add a final newline): the draft keeps its attachments and collapsed pastes exactly as they were.
            if (saved !== exported && text !== exported) this.editor.setEdited(text, before);
        } catch {
            // ignore
        }
        rmSync(dir, { recursive: true, force: true });
        this.renderLive();
    }

    // -----------------------------------------------------------------------
    // Images in the prompt

    /**
     * A paste of image paths becomes placeholders right away, in paste order,
     * and the files are read now: a dragged screenshot thumbnail is gone by
     * the time the prompt is sent. Anything else is pasted exactly as it came.
     */
    private pasteInto(text: string) {
        const e = this.editor;
        const guard = (p: string) => this.checker.userReadRefusal(p, { sensitive: true });
        const plan = e.secret || this.inputMode !== "prompt" ? undefined : planPaste(text, this.cwd, guard);
        for (const n of plan?.notices ?? []) this.notice(n, "warn");
        if (!plan?.files.length) return e.paste(text);
        plan.files.forEach((f, i) => {
            if (i > 0) e.insert(" ");
            this.attach(loadImageFile(f.path, guard, this.imagePrep), f.raw);
        });
        e.insert(" ");
    }

    /**
     * Reserve a placeholder where the cursor is and fill it when the image is
     * ready. It's tied to that placeholder: if the prompt went without it, the
     * image goes nowhere. On failure the placeholder becomes `fallback`.
     */
    private attach(work: Promise<Prepared | undefined>, fallback = "", onMissing?: () => void) {
        const uid = this.editor.reserveImage();
        const done = work
            .catch((err): Prepared => ({ error: `Couldn't attach the image: ${(err as Error).message}` }))
            .then((r) => {
                // A prompt waiting for this image holds its own copy of the placeholder.
                const d = this.pendingSubmit?.draft.attachments.has(uid) ? this.pendingSubmit.draft : undefined;
                if (!r) {
                    this.editor.dropImage(uid);
                    if (d) withoutImage(d, uid);
                    onMissing?.();
                } else if ("error" in r) {
                    this.editor.dropImage(uid, fallback);
                    if (d) withoutImage(d, uid, fallback);
                    this.notice(r.error, "warn");
                } else {
                    const waiting = d?.attachments.get(uid);
                    if (waiting) waiting.image = r.image;
                    if (this.editor.resolveImage(uid, r.image) || waiting) this.warnImageInput(r.image);
                }
                this.renderLive();
            })
            .finally(() => this.preparing.delete(uid));
        this.preparing.set(uid, done);
        this.renderLive();
    }

    private warnImageInput(img: NamedImage) {
        const info = this.session.model ? resolveModelInfo(this.session.model) : undefined;
        if (info?.supportsImages === false) this.notice(`${info.id} can't read images, so ${img.name} won't be seen. Pick a model with image input via /model.`, "warn");
    }

    /** Ctrl+V: attach the clipboard's image, if there is one (text pastes arrive as terminal paste events). */
    private pasteClipboardImage() {
        if (this.editor.secret || this.inputMode !== "prompt") return;
        const prep = this.imagePrep;
        const work = readClipboardImage(prep.run, prep.platform).then((png) => (png ? prepareImage("clipboard.png", png, prep) : undefined));
        this.attach(work, "", () => {
            this.flash = { text: "No image on the clipboard", until: Date.now() + 1500 };
        });
    }

    /**
     * Wait (briefly) for a sent draft's images still being prepared; ones that
     * don't make it are dropped with a notice. False when Ctrl+C or Esc
     * cancelled the send meanwhile. Images pasted into the editor meanwhile
     * belong to the next prompt and aren't touched.
     */
    private async settleImages(draft: Draft, pending: { uid: number; n: number }[]): Promise<boolean> {
        const waits = pending.map((p) => this.preparing.get(p.uid)).filter((w): w is Promise<void> => w !== undefined);
        let timer: ReturnType<typeof setTimeout> | undefined;
        let cancel!: () => void;
        const cancelled = new Promise<"cancelled">((r) => (cancel = () => r("cancelled")));
        this.pendingSubmit = { draft, cancel };
        // A running turn owns the status line.
        const own = !this.busy;
        if (own) this.status = "Preparing images (esc to cancel)";
        this.renderLive();
        const how = await Promise.race([Promise.all(waits), new Promise((r) => (timer = setTimeout(r, this.attachWaitMs))), cancelled]);
        clearTimeout(timer);
        this.pendingSubmit = undefined;
        if (own && !this.busy) this.status = undefined;
        if (how === "cancelled") {
            this.cancelSubmit(draft);
            return false;
        }
        for (const p of pending) {
            const a = draft.attachments.get(p.uid);
            if (!a || a.image) continue;
            withoutImage(draft, p.uid);
            this.editor.dropImage(p.uid);
            this.notice(`Image #${p.n} wasn't ready in time, so it was left out.`, "warn");
        }
        return true;
    }

    /** Nothing goes out. The draft comes back unless something new has been typed, which is never replaced. */
    private cancelSubmit(draft: Draft) {
        if (this.editor.isEmpty && this.inputMode === "prompt") {
            this.editor.restore([draft]);
            this.flash = { text: "Not sent; your prompt is back", until: Date.now() + 2000 };
        } else this.notice("Not sent. What you've typed since stays; the cancelled prompt is in history (↑).", "warn");
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
        if (/^\$[a-zA-Z0-9:_-]*$/.test(tok.text) && !/[A-Z]/.test(tok.text)) {
            const q = tok.text.slice(1);
            const found = this.skills
                .filter((s) => s.userInvocable && (s.name.startsWith(q) || (q.length > 1 && s.name.includes(q))))
                .sort((a, b) => Number(!a.name.startsWith(q)) - Number(!b.name.startsWith(q)) || a.name.localeCompare(b.name))
                .slice(0, 8);
            if (found.length === 1 && found[0]!.name === q) return { items: [] };
            if (this.menuIndex >= found.length) this.menuIndex = 0;
            return { items: found.map((s) => ({ label: "$" + s.name, description: s.description, insert: `$${s.name} `, start: tok.start, end: e.cursor })) };
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

    /** `opposite`: Tab while working, the other of steer and queue for this message. */
    private async submit(opposite = false) {
        if (this.pendingSubmit) {
            this.flash = { text: "Still preparing images for the last prompt (esc cancels it)", until: Date.now() + 2000 };
            return;
        }
        const mode = this.inputMode;
        const text = this.editor.value();
        if (!text.trim()) return;
        // Taken out of the editor now: whatever is typed while images finish is the next prompt.
        const draft = mode === "prompt" ? this.editor.capture() : undefined;
        const refuses = draft?.attachments.size ? commandRefusesImages(this, text) : undefined;
        if (refuses) {
            this.notice(`/${refuses} can't take images, so it wasn't run. Remove the images to run it.`, "warn");
            return;
        }
        const pending = mode === "prompt" ? this.editor.pendingImages() : [];
        const histEntry = (mode === "bash" ? "!" : mode === "memory" ? "#" : "") + text;
        this.editor.pushHistory(histEntry, draft);
        appendPromptHistory(this.cwd, histEntry);
        this.editor.clear();
        this.inputMode = "prompt";
        this.showHelp = false;
        this.renderLive();
        if (mode === "bash") return this.runBashMode(text);
        if (mode === "memory") return this.addMemory(text);
        if (pending.length) {
            if (!(await this.settleImages(draft!, pending))) return;
            // Images that never came leave nothing to send when they were all there was.
            if (!plainText(draft!.text).trim() && !imagesIn(draft!.text, draft!.attachments).length) return;
        }
        await this.submitText(draft ?? text, opposite ? otherFollowUp(this.followUp()) : undefined);
    }

    /** What a message sent while a turn runs does, unless the key says otherwise. */
    followUp(): FollowUp {
        return followUpDefault(this.settings.followUpBehavior);
    }

    /** A prompt, or a draft with images, as typed: a command, queued while busy, or a turn. `followUp`: what it does if a turn is running (default: the setting). */
    async submitText(input: string | Draft, followUp?: FollowUp) {
        const draft: Draft = typeof input === "string" ? { text: input, attachments: new Map() } : input;
        const text = plainText(draft.text);
        if (this.switching) await this.switching.catch(() => undefined);
        if (text.startsWith("/") && !text.startsWith("//")) {
            const handled = await runCommand(this, text, draft);
            if (handled) return;
        }
        if (this.busy) {
            const q: QueuedDraft = { ...draft, mode: followUp ?? this.followUp() };
            this.queued.push(q);
            this.queueUpdated();
            if (q.mode === "steer" && steers(q)) this.agent?.queueChanged?.();
            return;
        }
        await this.startTurn(text, { draft });
    }

    /** `draft` carries the images typed with the prompt (or with the command that built it). */
    /** `mentionsIn`: the part of `text` the user wrote, whose @mentions attach files (a skill's instructions are sent as written). */
    async startTurn(text: string, opts: { display?: string; kind?: "prompt" | "command"; draft?: Draft; mentionsIn?: string } = {}) {
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
            const images = opts.draft ? imagesIn(opts.draft.text, opts.draft.attachments) : [];
            if (images.length) this.screen.print((cols) => wrapLine(theme.subtle(`  ⎿  ${images.map((im, i) => `Image ${i + 1}: ${im.name} (${formatBytes(im.bytes)})`).join(", ")}`), cols - 2));
            if (!this.session.meta.system) await this.freezeSystemPrompt(ac.signal);
            if (ac.signal.aborted) {
                // Nothing was sent: hand the message back rather than dropping it.
                this.screen.print(theme.error(`  ⎿  Interrupted before sending; your message is back in the prompt.`));
                this.queued.unshift({ ...(opts.draft ?? { text: opts.kind === "command" ? (opts.display ?? text) : text, attachments: new Map() }), mode: "queue" });
            } else {
                const roots = [this.cwd, ...(this.settings.permissions?.additionalDirectories ?? [])];
                // $name brings that skill's instructions along; the transcript keeps what was typed.
                const skills = opts.kind === "command" ? [] : skillMentions(text, this.skills);
                const sent = skills.length ? withSkills(text, skills) : text;
                const { parts, attached, notices } = await expandMentions(opts.mentionsIn ?? text, this.toolState, roots, this.checker, { prepare: this.imagePrep });
                parts[0] = { type: "text", text: sent };
                if (skills.length) this.notice(`Using ${skills.length === 1 ? "skill" : "skills"} ${skills.map((sk) => sk.name).join(", ")}`);
                parts.push(...images.map((im) => im.part));
                for (const n of notices) this.notice(n, "warn");
                if (attached.length) this.notice(`Attached ${attached.join(", ")}`);
                reason = await agent.run(parts, { signal: ac.signal, display: opts.display ?? text, kind: opts.kind });
            }
        } catch (e) {
            this.notice(`Unexpected error: ${redact((e as Error).message)}`, "error");
            reason = "error";
        } finally {
            this.busy = false;
            this.takeBackBlockedAt = 0;
            this.abort = undefined;
            this.stopTicker();
            this.active.clear();
            this.detached.clear();
            this.status = undefined;
            this.renderLive();
        }
        if (reason) void this.notifier.turnEnded(reason, Date.now() - this.turnStart);
        if (ac.signal.aborted) return this.returnQueued();
        const next = this.nextQueued();
        if (next === undefined) return;
        this.queued.shift();
        this.queueUpdated();
        await this.submitText(next);
    }

    /** What runs when the turn ends: the first message still waiting. */
    nextQueued(): Draft | undefined {
        return this.queued[0];
    }

    /** Shown, and saved beside the transcript so quitting mid-turn doesn't lose it. */
    private queueUpdated() {
        this.renderLive();
        if (!this.session?.persisted) return;
        const mine = this.queued.map((d): StoredQueued => {
            const images = imagesIn(d.text, d.attachments).map((im) => im.part);
            return { text: plainText(d.text), mode: d.mode, ...(images.length ? { attachments: images } : {}) };
        });
        const kept = this.keptQueue?.id === this.session.meta.id ? this.keptQueue.items : [];
        saveQueue(this.session.path, this.session.meta.id, [...mine, ...kept]);
    }

    /** A session's saved messages with files the terminal can't attach: kept in its file for the app. */
    private keptQueue?: { id: string; items: StoredQueued[] };

    /**
     * Messages that were waiting when Harness last closed on this session (it quit mid-turn) come
     * back into the prompt, images too, as an interrupt would have handed them back.
     */
    private restoreSavedQueue() {
        if (!this.session.persisted) return;
        const all = loadQueue(this.session.path, this.session.meta.id);
        // The terminal attaches images only: one with a file (a PDF) stays saved for the app, rather than lose it.
        const saved = all.filter((q) => !q.attachments?.some((a) => a.type !== "image"));
        const kept = all.filter((q) => !saved.includes(q));
        this.keptQueue = { id: this.session.meta.id, items: kept };
        if (!saved.length) {
            if (kept.length) this.notice(kept.length === 1 ? "A message with a file that was waiting when Harness closed is still saved: open this session in the app to send it." : `${kept.length} messages with files that were waiting when Harness closed are still saved: open this session in the app to send them.`);
            return;
        }
        const e = this.editor;
        const typed = e.text ? e.capture() : undefined;
        e.set("");
        saved.forEach((q, i) => {
            if (i) e.insert("\n");
            const images = (q.attachments ?? []).filter((a): a is ImagePart => a.type === "image");
            let n = 0;
            // Each [Image #k] label gets its image again, in order (the editor numbers them afresh).
            const attach = (image: ImagePart) => e.attachImage({ name: `image ${++n}`, bytes: Math.floor((image.data.length * 3) / 4), part: image });
            for (const piece of q.text.split(/(\[Image #\d+\])/)) {
                const image = /^\[Image #\d+\]$/.test(piece) ? images[n] : undefined;
                if (image) attach(image);
                else if (piece) e.insert(piece);
            }
            // The app keeps a message's images beside its text, with no labels in it: they go after the text.
            for (const image of images.slice(n)) {
                if (e.text && !/\s$/.test(e.text)) e.insert(" ");
                attach(image);
            }
        });
        if (typed) e.restore([typed]);
        saveQueue(this.session.path, this.session.meta.id, kept);
        const back = saved.length === 1 ? "A message that was waiting when Harness closed is back in the prompt." : `${saved.length} messages that were waiting when Harness closed are back in the prompt.`;
        this.notice(kept.length ? `${back} ${kept.length === 1 ? "One with a file is" : `${kept.length} with files are`} still saved: open this session in the app to send ${kept.length === 1 ? "it" : "them"}.` : back);
        this.renderLive();
    }

    // ---- /queue: what's waiting, with send now, reorder and remove

    /** The queue as it is now (oldest first), and what each will do. */
    queueEntries(): { draft: QueuedDraft; text: string; steering: boolean; canSteer: boolean }[] {
        return this.queued.map((d) => ({ draft: d, text: plainText(d.text), steering: d.mode === "steer" && steers(d), canSteer: steers(d) }));
    }

    /** "Send now": it steers the running turn instead of waiting for its end. False when it's gone, or can't (images, commands). */
    sendQueuedNow(d: QueuedDraft): "sent" | "gone" | "cant" {
        if (!this.queued.includes(d)) return "gone";
        if (!steers(d)) return "cant";
        d.mode = "steer";
        this.queueUpdated();
        this.agent?.queueChanged?.();
        return "sent";
    }

    /** Move it to position `to` (0 runs next). False when it's gone. */
    moveQueued(d: QueuedDraft, to: number): boolean {
        const i = this.queued.indexOf(d);
        if (i < 0) return false;
        this.queued.splice(i, 1);
        this.queued.splice(Math.max(0, Math.min(this.queued.length, to)), 0, d);
        this.queueUpdated();
        return true;
    }

    /** Out of the queue; with `edit`, back into the prompt (ahead of what's typed). False when it's gone. */
    takeOutQueued(d: QueuedDraft, edit: boolean): boolean {
        if (!this.queued.includes(d)) return false;
        this.queued = this.queued.filter((x) => x !== d);
        if (edit) this.editor.restore([d]);
        this.queueUpdated();
        return true;
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
            this.takeBackBlockedAt = 0;
            this.abort = undefined;
            this.stopTicker();
            this.active.clear();
            this.detached.clear();
            this.renderLive();
            this.afterTask(ac.signal.aborted);
        }
    }

    /**
     * Queued messages that join the running turn: those sent to steer it, if they
     * can (the host takes text only, so a message with images or a slash command
     * gets a turn of its own). Like a message queued for the turn's end, one of
     * those doesn't hold a steer back: steering is joining the turn now.
     */
    private drainQueued(): string[] {
        const take = this.queued.filter((d) => d.mode === "steer" && steers(d));
        if (!take.length) return [];
        this.queued = this.queued.filter((d) => !take.includes(d));
        this.queueUpdated();
        const q = take.map((d) => plainText(d.text));
        for (const t of q) this.printUser(t);
        return q;
    }

    /** Messages typed during a task run next; after a cancel they go back to the prompt. */
    private afterTask(cancelled: boolean) {
        if (!this.queued.length) return;
        if (cancelled) return this.returnQueued();
        const next = this.queued.shift()!;
        this.queueUpdated();
        // After the caller (a command like /compact) has finished.
        setTimeout(() => void this.submitText(next), 0);
    }

    /**
     * Esc while busy: the latest queued message comes back to the prompt, one per press. A slash
     * command can't share the prompt with other text (it would take that text as its arguments),
     * so with a draft in the way it stays queued and the next Esc interrupts.
     */
    private takeBackQueued() {
        const last = this.queued.at(-1)!;
        const e = this.editor;
        const prefix = this.inputMode === "bash" ? "!" : this.inputMode === "memory" ? "#" : "";
        const draft = e.text ? prefix + e.text : "";
        // A long paste shows as a placeholder; what it holds decides whether the draft is a command.
        if (draft && (isCommand(plainText(last.text)) || isCommand(prefix + e.value()))) {
            this.takeBackBlockedAt = Date.now();
            this.flash = { text: "Clear the prompt to take back the queued command · Esc again to interrupt", until: this.takeBackBlockedAt + 3000 };
            return this.renderLive();
        }
        this.queued.pop();
        this.queueUpdated();
        const cursor = e.cursor;
        if (draft && prefix) e.set(draft);
        // The queued message's images come back with it, ahead of the draft; the cursor stays where it was in the draft.
        e.restore([last]);
        if (draft) e.cursor = last.text.length + 1 + prefix.length + cursor;
        this.inputMode = "prompt";
        const left = this.queued.length;
        this.flash = { text: `Queued message moved back to the prompt · Esc again ${left ? `for the next (${left} more)` : "to interrupt"}`, until: Date.now() + 3000 };
        this.renderLive();
    }

    /**
     * After an interrupt, unsent messages go back to the prompt, ahead of anything being typed,
     * instead of running. A slash command can't share the prompt (it would take the rest as its
     * arguments), so unless it's all there is, it goes to the history (↑) instead.
     */
    private returnQueued() {
        if (!this.queued.length) return;
        const prefix = this.inputMode === "bash" ? "!" : this.inputMode === "memory" ? "#" : "";
        const e = this.editor;
        if (e.text && prefix) e.set(prefix + e.text);
        // The queue owns its images, so they come back whatever the editor's undo history has dropped.
        const queued = this.queued;
        this.queued = [];
        this.queueUpdated();
        this.inputMode = "prompt";
        // Each draft in full (paste placeholders expanded) decides whether it's a command; the prompt
        // keeps showing what's in it as it was (a long paste stays a placeholder) unless it's one.
        const draft = e.text ? e.capture() : undefined;
        const all = [...queued, ...(draft ? [draft] : [])];
        const commands = all.length > 1 ? all.filter((d) => isCommand(plainText(d.text))) : [];
        if (!commands.length) e.restore(queued);
        else {
            for (const c of commands) e.pushHistory(plainText(c.text), c);
            if (draft && commands.includes(draft)) e.set("");
            e.restore(queued.filter((d) => !commands.includes(d)));
            const names = commands.map((c) => truncate(plainText(c.text).replace(/\s+/g, " "), 40));
            this.notice(`Not run: ${names.join(", ")}. ↑ brings ${commands.length === 1 ? "it" : "them"} back.`, "warn");
        }
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
        // Back at the plain prompt (a turn ended, a dialog closed): what was shown meanwhile is gone,
        // so bring the output back down to the prompt.
        const idle = !this.busy && !this.dialogs.length;
        if (idle && !this.wasIdle) this.screen.settle();
        this.wasIdle = idle;
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
            const tl = thinkingLines(this.thinking.trim(), cols).slice(-3);
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
            status.push(`${theme.accent(glyph)} ${theme.accent(label)} ${theme.muted(`(${elapsed}${tokens ? ` · ↓ ${formatTokens(tokens)} tokens` : ""}${waiting} · ${this.queued.length ? "esc to take back the queued message" : "esc to interrupt"})`)}`);
        }
        const todos = this.toolState.todos;
        if (this.showTodos && todos.length && todos.some((t) => t.status !== "completed")) status.push(...renderTodos(todos, cols).slice(0, 10));
        for (const q of this.queued) {
            const steering = q.mode === "steer" && steers(q);
            const label = steering ? `${theme.accent("↳")} steering: ` : "⏵ queued: ";
            status.push(theme.muted(`  ${label}${truncate(plainText(q.text).replace(/\s+/g, " "), cols - 18)}`));
        }
        if (this.queued.length) status.push(theme.subtle(`    /queue to send now, reorder or remove`));
        return { flow: out, status };
    }

    private renderInput(cols: number): string[] {
        const color = this.inputMode === "bash" ? theme.bashMode : this.inputMode === "memory" ? theme.memoryMode : this.mode === "plan" ? theme.planMode : theme.subtle;
        const symbol = this.inputMode === "bash" ? "!" : this.inputMode === "memory" ? "#" : ">";
        const rule = color("─".repeat(Math.max(10, cols - 1)));
        const placeholder = this.inputMode === "bash" ? "Run a shell command" : this.inputMode === "memory" ? "Add to memory" : this.busy ? (this.followUp() === "steer" ? "Steer the current turn (enter) · tab to queue it for after" : "Queue a message for after this turn (enter) · tab to steer now") : 'Try "explain this codebase" or "fix the failing test"';
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
            out.push(...shortcutHelp(cols, this.keys));
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

/** A message typed while working: the images behind it, and whether it steers the turn or waits for its end. */
export interface QueuedDraft extends Draft {
    mode: FollowUp;
}

const otherFollowUp = (m: FollowUp): FollowUp => (m === "steer" ? "queue" : "steer");

/** One the running turn can take: not a command (it runs after), and without images (they get a turn of their own). */
function steers(d: Draft): boolean {
    return !isCommand(plainText(d.text)) && !imagesIn(d.text, d.attachments).length;
}

/** A slash command, as submitting reads it (`//` is plain text). */
function isCommand(text: string): boolean {
    return text.startsWith("/") && !text.startsWith("//");
}

function shortcutHelp(cols: number, keys: TuiKeybindings): string[] {
    // Each hint names the key bound now; one with no key isn't shown.
    const hint = (action: string, text: (key: string) => string) => {
        const key = keys.label(action);
        return key === undefined ? undefined : text(key === "escape" ? "esc" : key);
    };
    const newline = keys.all("chat:newline").filter((k) => k !== "shift+enter");
    const rows = [
        ["! for bash mode", hint("chat:cancel", (k) => `double ${k} to clear or rewind`), hint("chat:cycleMode", (k) => `${k} to cycle modes`)],
        ["/ for commands", hint("chat:externalEditor", (k) => `${k} to edit in $EDITOR`), hint("app:toggleTranscript", (k) => `${k} for verbose output`)],
        ["@ for file paths", `\\⏎${newline.length ? ` or ${newline[newline.length - 1]}` : ""} for newline`, hint("app:toggleTodos", (k) => `${k} to toggle todos`)],
        ["# to memorize", hint("chat:cancel", (k) => `${k} to interrupt (queued first)`), "ctrl+c twice to exit"],
        ["tab: steer or queue the other way", "/queue to manage queued messages", ""],
    ];
    const w = Math.floor((cols - 4) / 3);
    return [
        ...rows.map((r) => "  " + r.map((c) => padEnd(theme.muted(truncate(c ?? "", w - 1)), w)).join("")),
        "  " + theme.muted(truncate(keys.all("chat:newline").includes("shift+enter") ? "shift+enter also adds a newline, in terminals that support it" : `Keys: ${keys.path}`, cols - 4)),
    ];
}

/**
 * Thinking as it's shown: its markdown styled (Codex's summaries open with a **bold** title), wrapped to fit
 * beside the ✻. Links aren't terminal hyperlinks: thinking is cut to its last lines, which could drop a link's end.
 */
function thinkingLines(text: string, cols: number): string[] {
    // Escape codes in the model's own text (a raw hyperlink, a color) are taken out first, for the same reason.
    return text.split("\n").flatMap((l) => wrapLine(inline(stripAnsi(l), false), cols - 4));
}

/** A muted rule across the width with a label: where the resumed history starts and ends. */
function historyRule(label: string, cols: number): string {
    const head = `── ${truncate(label, Math.max(10, cols - 8))} `;
    return theme.subtle(head + "─".repeat(Math.max(2, cols - 2 - width(head))));
}

/**
 * A Claude Code or Codex turn's text without the note that closes it, "[Codex used: Bash(…), Edit(…)]",
 * and the actions the note lists. The note is the message's last text part (or that part's last
 * paragraph), on one line: a mention of one in the reply itself is just text.
 */
export function splitActionsNote(m: Message): { text: string; actions: string[] } {
    const parts = (m.content as Message["content"][number][]).filter((p): p is TextPart => p.type === "text");
    const last = parts.at(-1)?.text.trimEnd() ?? "";
    const note = /(?:^|\n\n)\[([\w][\w .-]*) used: ([^\n]*)\]$/.exec(last);
    if (!note) return { text: textOf(m).trim(), actions: [] };
    // Each action starts with a tool's name and "(": split on the commas before one.
    const actions = note[2]!.split(/, (?=(?:and \d+ more$|[\w.-]+\())/).map((a) => a.trim()).filter(Boolean);
    const text = [...parts.slice(0, -1).map((p) => p.text), last.slice(0, note.index)].join("").trim();
    return { text, actions };
}
