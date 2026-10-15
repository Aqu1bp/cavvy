// Non-interactive mode: `harness -p "prompt"`. Runs one prompt to completion
// and prints the result. Anything that would need an approval prompt is
// denied unless a rule, --allowedTools or the permission mode allows it.

import { Agent, type AgentEvent } from "./agent/agent";
import { fireHooks } from "./agent/hooks";
import { Session } from "./agent/session";
import { buildSystemPrompt } from "./agent/system-prompt";
import { loadSettings, type Effort, type Settings } from "./config/settings";
import type { PermissionMode } from "./permissions/modes";
import { PermissionChecker } from "./permissions/checker";
import { AutoClassifier } from "./permissions/classifier";
import { McpManager } from "./mcp/manager";
import { BUILTIN_TOOLS } from "./tools/index";
import type { Tool, ToolState } from "./tools/types";
import { killAllShells } from "./tools/bash";
import { availableSearchBackend, formatHits, searchWeb } from "./tools/web-tools";
import { cachedListings, clientFor, defaultModelFrom, listAllModels, lookupModel, resolveModelInfo, smallModelFor } from "./providers/models";
import { getProvider, resolveBaseUrl } from "./providers/registry";
import { modelRef, parseModelRef, textOf, type ModelInfo, type ProviderClient, type Usage } from "./providers/types";
import { addUsage, costOf, emptyUsage } from "./providers/pricing";
import { expandMentions } from "./ui/mentions";
import { redact, redactedJson } from "./util/redact";
import { sanitizeLine } from "./ui/ansi";
import { isAgentBackend } from "./backends/types";

export type OutputFormat = "text" | "json" | "stream-json";

export interface HeadlessOptions {
    cwd: string;
    prompt: string;
    trusted: boolean;
    modelRef?: string;
    mode: PermissionMode;
    outputFormat: OutputFormat;
    verbose: boolean;
    maxTurns?: number;
    allowedTools: string[];
    disallowedTools: string[];
    appendSystemPrompt?: string;
    resumeFile?: string;
    addDirs: string[];
    startupNotes: string[];
    effort?: Effort;
    fallbackModel?: string;
}

function sleep(ms: number) {
    return new Promise((r) => setTimeout(r, ms));
}

export async function runHeadless(o: HeadlessOptions): Promise<number> {
    const started = Date.now();
    const json = (obj: unknown) => process.stdout.write(redactedJson(obj) + "\n");
    // Tool titles, errors and model text can carry terminal escapes (title
    // changes, clipboard writes); only colors and links get through to a terminal.
    const stderr = (s: string) => process.stderr.write(sanitizeLine(redact(s)) + "\n");
    const fail = (message: string): number => {
        if (o.outputFormat === "text") stderr(`error: ${message}`);
        else json({ type: "result", subtype: "error_during_execution", is_error: true, result: message, duration_ms: Date.now() - started });
        return 1;
    };

    const settings: Settings = loadSettings(o.cwd, { trusted: o.trusted });
    const perms = (settings.permissions ??= {});
    perms.allow = [...(perms.allow ?? []), ...o.allowedTools];
    perms.deny = [...(perms.deny ?? []), ...o.disallowedTools];
    perms.additionalDirectories = [...(perms.additionalDirectories ?? []), ...o.addDirs];
    if (o.effort) settings.effort = o.effort;
    for (const n of o.startupNotes) stderr(`warning: ${n}`);

    // ---- session to resume (its model comes before the default)
    let resumed: Session | undefined;
    if (o.resumeFile) {
        try {
            resumed = Session.load(o.resumeFile);
        } catch (e) {
            return fail(`Could not resume: ${(e as Error).message}`);
        }
    }

    // ---- model
    let listings = cachedListings();
    let ref = o.modelRef ?? settings.model ?? o.fallbackModel;
    if (!o.modelRef && resumed?.model && resumed.model !== ref) {
        const p = parseModelRef(resumed.model);
        const usable = p && getProvider(p.provider) && resolveModelInfo(resumed.model) && (await clientFor(p.provider).then(() => true, () => false));
        if (usable) ref = resumed.model;
        else stderr(`warning: this session used ${resumed.model}, which isn't available now; using ${ref ?? "the default model"}.`);
    }
    if (!ref) {
        let pick = defaultModelFrom(listings);
        if (!pick) {
            listings = await listAllModels().catch(() => []);
            pick = defaultModelFrom(listings);
        }
        if (pick) ref = modelRef(pick);
    }
    if (!ref) return fail("No model configured. Add a key with `harness auth add` (or run `harness` and use /login), or pass --model provider:model.");
    const parsed = parseModelRef(ref);
    if (!parsed || !getProvider(parsed.provider)) return fail(`Invalid model "${ref}". Use provider:model, e.g. anthropic:claude-opus-5-5. See \`harness models\`.`);
    let client: ProviderClient;
    try {
        client = await clientFor(parsed.provider);
    } catch (e) {
        return fail((e as Error).message);
    }
    let model: ModelInfo | undefined = listings.find((l) => l.provider.id === parsed.provider)?.models.find((m) => m.id === parsed.id) ?? resolveModelInfo(ref);
    if (model && !model.contextWindow) model = (await lookupModel(ref).catch(() => undefined)) ?? model;
    if (!model) return fail(`Unknown model "${ref}".`);

    // ---- session and tools
    const session: Session = resumed ?? Session.create(o.cwd);
    const toolState: ToolState = { cwd: o.cwd, projectRoot: o.cwd, fileState: new Map(), todos: [], shells: new Map() };
    const checker = new PermissionChecker(() => settings, o.cwd);
    const mcp = new McpManager(o.cwd, () => settings, o.trusted);
    mcp.load();
    await Promise.race([mcp.startAll(), sleep(15_000)]);
    for (const s of mcp.servers.values()) {
        if (s.status === "failed") stderr(`warning: MCP server ${s.name} failed: ${(s.error ?? "").split("\n")[0]}`);
        if (s.status === "needs-approval") stderr(`warning: MCP server ${s.name} from .mcp.json is not approved; run harness interactively and use /mcp to approve it.`);
    }

    const def = getProvider(model.provider)!;
    const pref = settings.webSearch ?? "auto";
    const nativeWebSearch = def.kind === "anthropic" && /^https:\/\/api\.anthropic\.com$/.test(resolveBaseUrl(def)) && (pref === "auto" || pref === "anthropic");
    let mode = o.mode;
    const tools = (): Tool<any>[] => [
        // Nobody can answer a question in -p mode.
        ...BUILTIN_TOOLS.filter((t) => t.name !== "AskUserQuestion" && !(t.name === "WebSearch" && (nativeWebSearch || pref === "off"))),
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
        return { client, model: smallModelFor(model!.provider, listings) ?? model! };
    };
    const complete = async (system: string, prompt: string, signal?: AbortSignal, opts?: { main?: boolean }) => {
        const s = opts?.main ? { client, model: model! } : await smallClient();
        // Not a session message, so redact here (WebFetch pages, reviewer prompts).
        const res = await s.client.stream({ model: s.model, system, messages: [{ role: "user", content: [{ type: "text", text: redact(prompt) }] }], tools: [], maxTokens: 2048, effort: "low", lightweight: true, signal }, () => {});
        if (res.usage) {
            const c = costOf(res.usage, s.model).usd;
            session.recordUsage(modelRef(s.model), res.usage, c);
            totalCost += c;
            totalUsage = addUsage(totalUsage, res.usage);
        }
        return textOf(res);
    };

    // --append-system-prompt isn't frozen in: the agent adds this run's to every request.
    if (!session.meta.system) session.setSystem(buildSystemPrompt({ cwd: o.cwd, model, append: mcp.instructions() || undefined }));

    // ---- output
    let lastText = "";
    let numTurns = 0;
    let totalCost = 0;
    let totalUsage: Usage = emptyUsage();
    const denials: { tool: string; reason: string }[] = [];
    const emit = (e: AgentEvent) => {
        switch (e.type) {
            case "assistant": {
                numTurns++;
                const t = textOf(e.message).trim();
                if (t) lastText = t;
                if (o.outputFormat === "stream-json") json({ type: "assistant", session_id: session.meta.id, message: { role: "assistant", content: e.message.content.filter((p) => p.type !== "thinking" || o.verbose) } });
                break;
            }
            case "tool_start":
                if (o.outputFormat === "text" && o.verbose) stderr(`⏺ ${e.title}`);
                break;
            case "tool_end": {
                const r = e.result;
                if (r.isError && /not granted \(non-interactive session\)/.test(r.content)) denials.push({ tool: e.call.name, reason: r.content });
                if (o.outputFormat === "stream-json") json({ type: "tool_result", session_id: session.meta.id, tool_use_id: e.call.id, tool: e.call.name, is_error: Boolean(r.isError), content: r.content.slice(0, 20_000) });
                else if (o.verbose) stderr(`  ⎿  ${r.isError ? "error: " : ""}${r.display?.summary ?? r.content.split("\n")[0]?.slice(0, 200) ?? ""}`);
                break;
            }
            case "notice":
                if (o.outputFormat === "stream-json") json({ type: "system", subtype: "notice", level: e.level, message: e.message });
                else if (e.level !== "info" || o.verbose) stderr(`${e.level}: ${e.message}`);
                break;
            case "retry":
                if (o.outputFormat === "stream-json") json({ type: "system", subtype: "retry", attempt: e.attempt, delay_ms: e.delayMs, reason: e.reason });
                // Always: otherwise a provider that's down looks like a hang for minutes.
                else stderr(`retrying in ${Math.ceil(e.delayMs / 1000)}s (attempt ${e.attempt}): ${e.reason}`);
                break;
            case "usage":
                totalCost += e.cost.usd;
                totalUsage = addUsage(totalUsage, e.usage);
                break;
            case "compact_end":
                if (o.outputFormat === "stream-json") json({ type: "system", subtype: "compact", summary_chars: e.summary.length });
                break;
            case "subagent":
                if (o.verbose && o.outputFormat === "text" && e.event.type === "tool_start") stderr(`  ↳ ${e.label}: ${e.event.title}`);
                break;
        }
    };

    const agent = new Agent({
        session,
        model,
        client,
        settings: () => settings,
        checker,
        classifier: new AutoClassifier(complete),
        tools,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState,
        nativeWebSearch,
        maxTurns: o.maxTurns,
        appendSystemPrompt: o.appendSystemPrompt,
        trusted: o.trusted,
        host: {
            emit,
            ui: {
                askQuestion: async () => undefined,
                approvePlan: async () => ({ approved: false, feedback: "This is a non-interactive run, so the plan can't be approved here. Give the complete plan as your final answer." }),
            },
        },
        helpers: {
            complete,
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

    if (o.outputFormat === "stream-json") {
        json({
            type: "system",
            subtype: "init",
            session_id: session.meta.id,
            cwd: o.cwd,
            model: ref,
            permission_mode: mode,
            // An agent backend (Claude Code, Codex) uses its own tools.
            tools: isAgentBackend(client) ? [] : tools().map((t) => t.name),
            ...(isAgentBackend(client) ? { agent_backend: def.name } : {}),
            mcp_servers: [...mcp.servers.values()].map((s) => ({ name: s.name, status: s.status })),
        });
    }

    const hookWarning = (m: string) => stderr(`warning: ${m}`);
    const sessionStarted = fireHooks(settings, "SessionStart", { session_id: session.meta.id, source: resumed ? "resume" : "startup" }, o.cwd, hookWarning);
    const ac = new AbortController();
    const onSig = () => ac.abort();
    process.on("SIGINT", onSig);
    process.on("SIGTERM", onSig);
    let reason: string;
    try {
        const { parts } = expandMentions(o.prompt, toolState, [o.cwd, ...(settings.permissions?.additionalDirectories ?? [])]);
        reason = await agent.run(parts, { signal: ac.signal, display: o.prompt });
    } catch (e) {
        reason = "error";
        stderr(`error: ${(e as Error).message}`);
    } finally {
        process.off("SIGINT", onSig);
        process.off("SIGTERM", onSig);
        // A SessionStart hook still running and the SessionEnd hooks get at most 5 seconds between them.
        // (Raced too: a hook's leftover background process can hold its output open after the abort.)
        const deadline = AbortSignal.timeout(5000);
        const timedOut = new Promise<void>((r) => deadline.addEventListener("abort", () => r(), { once: true }));
        const ended = Promise.race([
            Promise.race([sessionStarted, timedOut]).then(() => (deadline.aborted ? undefined : fireHooks(settings, "SessionEnd", { session_id: session.meta.id, reason: "exit" }, o.cwd, hookWarning, deadline))),
            timedOut,
        ]);
        await Promise.all([ended, killAllShells({ state: toolState }), Promise.race([mcp.closeAll(), sleep(1500)])]);
    }

    const isError = reason !== "done";
    const subtype = reason === "done" ? "success" : reason === "max_turns" ? "error_max_turns" : reason === "aborted" ? "error_aborted" : "error_during_execution";
    if (o.outputFormat === "text") {
        if (lastText) process.stdout.write((process.stdout.isTTY ? sanitizeLine(redact(lastText)) : redact(lastText)) + "\n");
        if (isError && reason !== "done") stderr(`(stopped: ${reason})`);
        if (denials.length && !o.verbose) stderr(`note: ${denials.length} tool call(s) were denied because they need approval. Use --allowedTools, --permission-mode, or permission rules.`);
    } else {
        json({
            type: "result",
            subtype,
            is_error: isError,
            result: lastText,
            session_id: session.meta.id,
            model: ref,
            num_turns: numTurns,
            duration_ms: Date.now() - started,
            total_cost_usd: Number(totalCost.toFixed(6)),
            usage: { input_tokens: totalUsage.inputTokens, output_tokens: totalUsage.outputTokens, cache_read_input_tokens: totalUsage.cacheReadTokens ?? 0, cache_creation_input_tokens: totalUsage.cacheWriteTokens ?? 0 },
            permission_denials: denials.map((d) => d.tool),
        });
    }
    return isError ? 1 : 0;
}
