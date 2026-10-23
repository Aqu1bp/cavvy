// What a run without a terminal needs before its first prompt: settings, the
// session (new or resumed), the model and its client, tools, permissions and
// MCP servers, and the agent on top. `harness -p` (headless.ts) and the SDK
// (src/sdk) both start here, so a feature added to one reaches the other.

import { Agent, type AgentHost } from "./agent/agent";
import { fireHooks, type HookNotice } from "./agent/hooks";
import { sessionHookServices, sessionStartHooks } from "./agent/session-hooks";
import { sessionHookSettings } from "./plugins/native";
import { Session } from "./agent/session";
import { buildSystemPrompt } from "./agent/system-prompt";
import { asLoaded, loadSettings, type Effort, type Settings } from "./config/settings";
import type { PermissionMode } from "./permissions/modes";
import { PermissionChecker } from "./permissions/checker";
import { AutoClassifier, REVIEW_REQUEST, reviewText, type ReviewStage } from "./permissions/classifier";
import { McpManager } from "./mcp/manager";
import { BUILTIN_TOOLS } from "./tools/index";
import { skillTool } from "./tools/skill-tool";
import { loadSkills, type Skill } from "./agent/skills";
import type { Tool, ToolState } from "./tools/types";
import { killAllShells } from "./tools/bash";
import { availableSearchBackend, formatHits, searchWeb } from "./tools/web-tools";
import { cachedListings, clientFor, defaultModelFrom, listAllModels, lookupModel, resolveModelInfo, reviewTarget, smallModelFor } from "./providers/models";
import { getProvider, resolveBaseUrl, type ProviderDef } from "./providers/registry";
import type { ProviderListing } from "./providers/models";
import { modelRef, parseModelRef, textOf, type ModelInfo, type ProviderClient, type Usage } from "./providers/types";
import { costOf } from "./providers/pricing";
import { redact } from "./util/redact";

/** A run can't start: the message says why, for the user. */
export class SetupError extends Error {}

export interface RunSetupOptions {
    cwd: string;
    trusted: boolean;
    modelRef?: string;
    /** The model from a legacy .env, after settings. */
    fallbackModel?: string;
    resumeFile?: string;
    allowedTools: string[];
    disallowedTools: string[];
    addDirs: string[];
    effort?: Effort;
    fastMode?: boolean;
    /** Merged over the settings loaded from disk (the SDK's `settings` option). */
    settings?: Settings;
    /** Save the session like an interactive one (default true). */
    persist?: boolean;
    /** Startup warnings: an unusable resumed model, MCP servers that failed. */
    warn(message: string): void;
    /** Usage of side requests (the reviewer, summaries), which aren't agent events. */
    onUsage?(usage: Usage, usd: number): void;
}

export interface RunSetup {
    cwd: string;
    trusted: boolean;
    /** The system prompt this run sends in place of the session's (see AgentOptions.systemPrompt). */
    system?: string;
    /** A resumed session that goes on unsaved in `session`, held until endRun. */
    original?: Session;
    settings: Settings;
    session: Session;
    resumed: boolean;
    /** The model as provider:model. */
    ref: string;
    model: ModelInfo;
    client: ProviderClient;
    provider: ProviderDef;
    toolState: ToolState;
    checker: PermissionChecker;
    mcp: McpManager;
    nativeWebSearch: boolean;
    skills: Skill[];
    /** The model catalog as this run last listed it. */
    listings: ProviderListing[];
    /** Built-in tools this run offers (nobody can answer AskUserQuestion) and the MCP servers' tools. */
    tools(): Tool<any>[];
    complete(system: string, prompt: string, signal?: AbortSignal, opts?: { main?: boolean; review?: ReviewStage }): Promise<string>;
}

/** `p`, or undefined after `ms`. The timer doesn't outlive the race, so a finished SDK script can exit. */
function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
    let end!: (v: undefined) => void;
    const timeout = new Promise<undefined>((r) => (end = r));
    const timer = setTimeout(() => end(undefined), ms);
    return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

/** Settings from disk with `over` on top: lists of rules add up, maps merge by key. */
export function mergeSettings(base: Settings, over: Settings | undefined): Settings {
    if (!over) return base;
    const out: Settings = { ...base, ...over };
    if (base.permissions || over.permissions) {
        const a = base.permissions ?? {};
        const b = over.permissions ?? {};
        out.permissions = { ...a, ...b };
        for (const k of ["allow", "ask", "deny", "additionalDirectories"] as const) if (a[k] || b[k]) out.permissions[k] = [...(a[k] ?? []), ...(b[k] ?? [])];
    }
    if (base.hooks || over.hooks) {
        const hooks: Record<string, unknown[]> = { ...(base.hooks as Record<string, unknown[]>) };
        for (const [k, v] of Object.entries(over.hooks ?? {})) hooks[k] = [...(hooks[k] ?? []), ...(v ?? [])];
        out.hooks = hooks as Settings["hooks"];
    }
    for (const k of ["mcpServers", "env"] as const) if (base[k] || over[k]) (out as any)[k] = { ...base[k], ...over[k] };
    return asLoaded(out, base);
}

/** Everything up to the agent. Throws SetupError when the run can't start. */
export async function setupRun(o: RunSetupOptions): Promise<RunSetup> {
    const settings: Settings = mergeSettings(loadSettings(o.cwd, { trusted: o.trusted }), o.settings);
    const perms = (settings.permissions ??= {});
    perms.allow = [...(perms.allow ?? []), ...o.allowedTools];
    perms.deny = [...(perms.deny ?? []), ...o.disallowedTools];
    perms.additionalDirectories = [...(perms.additionalDirectories ?? []), ...o.addDirs];
    if (o.effort) settings.effort = o.effort;

    // ---- session to resume (its model comes before the default)
    let resumed: Session | undefined;
    if (o.resumeFile) {
        try {
            // Not saved: read only, so even a crash's repair isn't written to the original.
            resumed = Session.load(o.resumeFile, { persist: o.persist !== false });
        } catch (e) {
            throw new SetupError(`Could not resume: ${(e as Error).message}`);
        }
    }
    // Let go of the resumed session if anything below fails.
    try {
        return await setupWith(o, settings, resumed);
    } catch (e) {
        resumed?.release();
        throw e;
    }
}

async function setupWith(o: RunSetupOptions, settings: Settings, resumed: Session | undefined): Promise<RunSetup> {
    // ---- model
    let listings = cachedListings();
    let ref = o.modelRef ?? settings.model ?? o.fallbackModel;
    if (!o.modelRef && resumed?.model && resumed.model !== ref) {
        const p = parseModelRef(resumed.model);
        const usable = p && getProvider(p.provider) && resolveModelInfo(resumed.model) && (await clientFor(p.provider).then(() => true, () => false));
        if (usable) ref = resumed.model;
        else o.warn(`this session used ${resumed.model}, which isn't available now; using ${ref ?? "the default model"}.`);
    }
    if (!ref) {
        let pick = defaultModelFrom(listings);
        if (!pick) {
            listings = await listAllModels().catch(() => []);
            pick = defaultModelFrom(listings);
        }
        if (pick) ref = modelRef(pick);
    }
    if (!ref) throw new SetupError("No model configured. Add a key with `harness auth add` (or run `harness` and use /login), or pass --model provider:model.");
    const parsed = parseModelRef(ref);
    if (!parsed || !getProvider(parsed.provider)) throw new SetupError(`Invalid model "${ref}". Use provider:model, e.g. anthropic:claude-opus-5-5. See \`harness models\`.`);
    let client: ProviderClient;
    try {
        client = await clientFor(parsed.provider);
    } catch (e) {
        throw new SetupError((e as Error).message);
    }
    let model: ModelInfo | undefined = listings.find((l) => l.provider.id === parsed.provider)?.models.find((m) => m.id === parsed.id) ?? resolveModelInfo(ref);
    if (model && !model.contextWindow) model = (await lookupModel(ref).catch(() => undefined)) ?? model;
    if (!model) throw new SetupError(`Unknown model "${ref}".`);
    if (o.fastMode && !model.supportsFastMode) throw new SetupError("Fast mode is not available for this model/backend. Refresh the model list or choose a supported model.");
    const mainModel = model;

    // ---- session and tools
    // Not saved: a resumed session goes on in a copy, and the file stays as it was. The original stays
    // held until the run ends, so its agent backends' sessions, which the copy forks, don't move on meanwhile.
    let session: Session;
    let original: Session | undefined;
    if (resumed && o.persist === false) {
        session = resumed.fork({ persist: false, shareBackends: true });
        original = resumed;
    } else session = resumed ?? Session.create(o.cwd, { persist: o.persist ?? true });
    if (o.fastMode !== undefined) session.setFastMode(o.fastMode);
    const toolState: ToolState = { cwd: o.cwd, projectRoot: o.cwd, fileState: new Map(), todos: [], shells: new Map() };
    const checker = new PermissionChecker(() => settings, o.cwd);
    const mcp = new McpManager(o.cwd, () => settings, o.trusted);
    mcp.load();
    await within(mcp.startAll(), 15_000);
    for (const s of mcp.servers.values()) {
        if (s.status === "failed") o.warn(`MCP server ${s.name} failed: ${(s.error ?? "").split("\n")[0]}`);
        if (s.status === "needs-approval") o.warn(`MCP server ${s.name} from .mcp.json is not approved${s.approval?.reason === "changed" ? " (what it runs changed since it was approved)" : ""}; run harness interactively and use /mcp to approve it.`);
    }

    const provider = getProvider(model.provider)!;
    const pref = settings.webSearch ?? "auto";
    const nativeWebSearch = provider.kind === "anthropic" && /^https:\/\/api\.anthropic\.com$/.test(resolveBaseUrl(provider)) && (pref === "auto" || pref === "anthropic");
    const skills = loadSkills(o.cwd, o.trusted);
    const skill = skillTool(skills);
    const tools = (): Tool<any>[] => [
        // Nobody can answer a question here.
        ...BUILTIN_TOOLS.filter((t) => t.name !== "AskUserQuestion" && !(t.name === "WebSearch" && (nativeWebSearch || pref === "off"))),
        ...(skill ? [skill] : []),
        ...mcp.tools(),
    ];

    const smallClient = async (): Promise<{ client: ProviderClient; model: ModelInfo }> => {
        const smallRef = settings.smallModel;
        if (smallRef) {
            const p = parseModelRef(smallRef);
            const m = resolveModelInfo(smallRef);
            if (p && m) {
                try {
                    return { client: await clientFor(p.provider), model: m };
                } catch {
                    // fall through
                }
            }
        }
        return { client, model: smallModelFor(mainModel.provider, listings) ?? mainModel };
    };
    const complete = async (system: string, prompt: string, signal?: AbortSignal, opts?: { main?: boolean; review?: ReviewStage }) => {
        // The reviewer (with none, the session's own model), the session's model, or the small one.
        const s = opts?.review ? ((await reviewTarget(settings.reviewModel)) ?? { client, model: mainModel }) : opts?.main ? { client, model: mainModel } : await smallClient();
        // Not a session message, so redact here (WebFetch pages, reviewer prompts).
        const res = await s.client.stream({ model: s.model, system, messages: [{ role: "user", content: [{ type: "text", text: redact(prompt) }] }], tools: [], maxTokens: 2048, effort: "low", lightweight: true, signal, ...(opts?.review ? REVIEW_REQUEST[opts.review] : {}) }, () => {});
        if (res.usage) {
            const est = costOf(res.usage, s.model);
            session.recordUsage(modelRef(s.model), res.usage, est.usd, est.unknown);
            o.onUsage?.(res.usage, est.usd);
        }
        return opts?.review ? reviewText(res) : textOf(res);
    };

    const prompt = () => buildSystemPrompt({ cwd: o.cwd, model, append: mcp.instructions() || undefined, projectFiles: o.trusted });
    if (!session.meta.system) session.setSystem(await prompt());
    // A resumed session's prompt was frozen with the project's memory files when it was trusted; a run
    // that doesn't trust the folder sends one without them, and leaves the saved one as it was.
    const system = resumed && !o.trusted ? await prompt() : undefined;

    return { cwd: o.cwd, trusted: o.trusted, system, settings, session, original, resumed: Boolean(resumed), ref, model, client, provider, toolState, checker, mcp, nativeWebSearch, skills, listings, tools, complete };
}

export interface RunAgentOptions {
    host: AgentHost;
    mode: { get(): PermissionMode; set(m: PermissionMode): void };
    /** Defaults to the setup's tools. */
    tools?: () => Tool<any>[];
    maxTurns?: number;
    /** Added to every request, not stored in the session (see AgentOptions). */
    appendSystemPrompt?: string;
}

export function createRunAgent(s: RunSetup, o: RunAgentOptions): Agent {
    const { settings } = s;
    return new Agent({
        session: s.session,
        trusted: () => s.trusted,
        skills: () => s.skills,
        model: s.model,
        client: s.client,
        settings: () => settings,
        approvedMcpServers: () => s.mcp.approvedServers(),
        checker: s.checker,
        classifier: new AutoClassifier(s.complete),
        tools: o.tools ?? s.tools,
        mode: o.mode,
        toolState: s.toolState,
        nativeWebSearch: s.nativeWebSearch,
        listings: () => s.listings,
        maxTurns: o.maxTurns,
        appendSystemPrompt: o.appendSystemPrompt,
        systemPrompt: s.system,
        host: o.host,
        helpers: {
            complete: s.complete,
            webSearch: async (query, signal) => {
                const backend = await availableSearchBackend(settings.webSearch);
                if (!backend) throw new Error("Web search is turned off (settings.webSearch = off)");
                return formatHits(query, await searchWeb(query, backend, signal));
            },
            resolveModel: async (r) => {
                const p = parseModelRef(r);
                const m = resolveModelInfo(r);
                if (!p || !m) return undefined;
                try {
                    return { model: m, client: await clientFor(p.provider) };
                } catch {
                    return undefined;
                }
            },
        },
    });
}

/** SessionStart hooks; the promise ends when they have. */
export function startRun(s: RunSetup, warn: HookNotice): Promise<unknown> {
    // Claude Code runs the plugins' own (src/plugins/native.ts).
    return sessionStartHooks(sessionHookSettings(s.settings, s.model.provider), s.session, s.resumed ? "resume" : "startup", s.cwd, warn, sessionHookServices({ session: () => s.session, warn, complete: s.complete, mcpTools: () => s.mcp.tools() }));
}

/**
 * The end of a run: SessionEnd hooks, delegated tasks, background shells and
 * MCP servers. `started` is startRun's promise.
 */
export async function endRun(s: RunSetup, agent: Agent | undefined, started: Promise<unknown> | undefined, warn: HookNotice): Promise<void> {
    // A SessionStart hook still running and the SessionEnd hooks get at most 5 seconds between them.
    // (Raced too: a hook's leftover background process can hold its output open after the abort.)
    const deadline = AbortSignal.timeout(5000);
    const timedOut = new Promise<void>((r) => deadline.addEventListener("abort", () => r(), { once: true }));
    const ended = started
        ? Promise.race([
              Promise.race([started, timedOut]).then(() => (deadline.aborted ? undefined : fireHooks(sessionHookSettings(s.settings, s.model.provider), "SessionEnd", { session_id: s.session.meta.id, reason: "exit" }, s.cwd, warn, deadline))),
              timedOut,
          ])
        : undefined;
    // Delegated tasks still running end with the run.
    try {
        await Promise.all([ended, agent?.dispose(), killAllShells({ state: s.toolState }), s.toolState.lsp?.dispose(), within(s.mcp.closeAll(), 1500)]);
    } finally {
        s.original?.release();
    }
}
