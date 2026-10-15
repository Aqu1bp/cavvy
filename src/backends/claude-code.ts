// Claude Code as an agent backend: the user's own installed `claude`, signed
// in by the user (their Claude plan, or whatever they set up in Claude Code).
//
// Each turn starts `claude -p` with stream-json input and output, the protocol
// Anthropic documents for driving Claude Code from another program (the Agent
// SDK speaks it too). Claude Code runs the turn with its own system prompt,
// tools and context management; the harness shows the stream and answers the
// permission prompts Claude Code sends over stdio (can_use_tool). Sessions
// continue with --resume.
//
// What this never does: read, copy or forward Claude Code's credentials (its
// keychain entry, ~/.claude/.credentials.json, CLAUDE_CODE_OAUTH_TOKEN), call
// Anthropic's API with them, or change the binary. Anthropic's terms allow an
// end user to sign in to the unmodified Claude Code binary with their own
// subscription, and forbid other programs collecting or routing requests
// through those credentials. The harness's own provider keys are removed from
// the CLI's environment (childEnv), so it can't be pointed at one of those.

import { homedir } from "os";
import type { AssistantMessage, ModelInfo, Usage } from "../providers/types";
import { ProviderError } from "../providers/types";
import type { ProviderDef } from "../providers/registry";
import type { PermissionMode } from "../permissions/modes";
import type { ToolDisplay } from "../tools/types";
import { diffLines, diffStats } from "../util/diff";
import { parseRule, pathPattern } from "../permissions/rules";
import { paths } from "../config/paths";
import { redact } from "../util/redact";
import { CLAUDE_CLI, JsonLinesProcess, cliMessage, commandTitle, extraArgs, requireCli, runCli, stopTiming } from "./cli";
import { backendModel, type AgentBackendClient, type BackendHost, type BackendResult, type BackendTurn } from "./types";

const STREAM_ARGS = ["-p", "--output-format", "stream-json", "--input-format", "stream-json", "--verbose"];

/**
 * Claude Code's modes for the harness's. Not acceptEdits for acceptEdits:
 * Claude Code's own also runs file commands (rm, mv, sed) without asking,
 * where the harness's still asks for shell commands. It runs in default mode
 * instead, and the harness approves its edits inside the workspace itself.
 */
const MODES: Record<PermissionMode, string> = {
    default: "default",
    acceptEdits: "default",
    plan: "plan",
    auto: "auto",
    bypassPermissions: "bypassPermissions",
};

export interface ClaudeStatus {
    loggedIn: boolean;
    /** oauth_token (a Claude plan), api_key, or how else Claude Code authenticates. */
    authMethod?: string;
    apiProvider?: string;
    email?: string;
    subscriptionType?: string;
}

/** `claude auth status --json`: Claude Code's own report of its sign-in. */
export async function claudeStatus(providerId = "claude-code", signal?: AbortSignal): Promise<ClaudeStatus> {
    const bin = requireCli(providerId, CLAUDE_CLI);
    const r = await runCli(bin, ["auth", "status", "--json"], { signal, timeoutMs: 20_000 });
    let j: Record<string, unknown> | undefined;
    try {
        j = JSON.parse(r.stdout);
    } catch {
        // older versions print text
    }
    if (!j || typeof j !== "object") {
        if (r.code !== 0) throw new ProviderError(`claude auth status failed: ${cliMessage(r.stderr || r.stdout) || `exit ${r.code}`}`);
        return { loggedIn: !/not (logged|signed) in/i.test(r.stdout) };
    }
    const str = (k: string) => (typeof j![k] === "string" ? (j![k] as string) : undefined);
    return { loggedIn: j.loggedIn === true, authMethod: str("authMethod"), apiProvider: str("apiProvider"), email: str("email"), subscriptionType: str("subscriptionType") };
}

export function describeClaudeAuth(s: ClaudeStatus): string {
    if (!s.loggedIn) return "not signed in";
    const via = s.apiProvider && s.apiProvider !== "firstParty" ? ` via ${s.apiProvider}` : "";
    if (s.authMethod === "api_key") return `signed in with an API key${via} (usage is billed to that key, not a plan)`;
    if (s.authMethod === "oauth_token" || s.subscriptionType) return `signed in with your Claude account${s.subscriptionType ? ` (${s.subscriptionType})` : ""}${via}`;
    return `signed in${s.authMethod ? ` (${s.authMethod})` : ""}${via}`;
}

let requestSeq = 0;
const requestId = () => `harness-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;

export class ClaudeCodeBackend implements AgentBackendClient {
    readonly agentBackend = true as const;
    private turn?: ClaudeTurn;

    constructor(readonly def: ProviderDef) {}

    async stream(): Promise<AssistantMessage> {
        throw new ProviderError(`${this.def.name} runs whole turns with its own tools, so it can't answer one-off requests. Set smallModel to another provider's model for those.`);
    }

    /**
     * Claude Code's model list, from its initialize reply: the CLI starts and
     * answers without making any API request.
     */
    async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        const bin = requireCli(this.def.id, CLAUDE_CLI);
        // No settings, MCP servers or session file: this only asks for the list.
        const proc = new JsonLinesProcess(bin, [...extraArgs(this.def.id), ...STREAM_ARGS, "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"], { cwd: homedir() });
        const kill = () => void proc.kill();
        signal?.addEventListener("abort", kill, { once: true });
        const timer = setTimeout(kill, 30_000);
        try {
            const id = requestId();
            proc.send({ type: "control_request", request_id: id, request: { subtype: "initialize" } });
            for await (const m of proc.messages()) {
                if (m.type !== "control_response" || m.response?.request_id !== id) continue;
                if (m.response.subtype !== "success") throw new ProviderError(`Claude Code: ${String(m.response.error ?? "initialize failed")}`);
                const models: any[] = Array.isArray(m.response.response?.models) ? m.response.response.models : [];
                return models
                    .filter((x) => typeof x?.value === "string" && x.value)
                    .map((x) =>
                        backendModel(this.def.id, x.value, typeof x.displayName === "string" ? `${x.displayName}${x.resolvedModel && x.resolvedModel !== x.value ? ` (${x.resolvedModel})` : ""}` : undefined, {
                            effortLevels: Array.isArray(x.supportedEffortLevels) ? x.supportedEffortLevels : undefined,
                        }),
                    );
            }
            throw new ProviderError(`Claude Code exited without listing its models${proc.stderr() ? `: ${cliMessage(proc.stderr())}` : ""}`);
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", kill);
            void proc.kill();
        }
    }

    async runTurn(t: BackendTurn): Promise<BackendResult> {
        const bin = requireCli(this.def.id, CLAUDE_CLI);
        const turn = new ClaudeTurn(this.def, bin, t);
        this.turn = turn;
        try {
            return await turn.run([{ type: "text", text: t.prompt }, ...t.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }))]);
        } finally {
            if (this.turn === turn) this.turn = undefined;
        }
    }

    /** Claude Code's own /compact, on the session being continued. */
    async compact(t: Omit<BackendTurn, "prompt" | "images"> & { instructions?: string }): Promise<BackendResult> {
        if (!t.resumeId) return { reason: "done", text: "", actions: [] };
        return this.runTurn({ ...t, prompt: `/compact${t.instructions ? ` ${t.instructions}` : ""}`, images: [] });
    }

    setMode(m: PermissionMode) {
        this.turn?.setMode(m);
    }
}

interface PendingTool {
    name: string;
    input: Record<string, unknown>;
    title: string;
    started: number;
}

/** One `claude -p` run: a prompt, plus any messages queued while it worked. */
class ClaudeTurn {
    private proc!: JsonLinesProcess;
    private tools = new Map<string, PendingTool>();
    /** Content block index → tool_use id, for streamed input. */
    private streamingTools = new Map<number, string>();
    /** Agent tool calls: their description labels the sub-agent's activity. */
    private agentLabels = new Map<string, string>();
    private texts: string[] = [];
    private actions: string[] = [];
    private sessionId?: string;
    private billedToPlan = false;
    private contextTokens?: number;
    private aborted = false;
    private failure?: string;
    private reason?: BackendResult["reason"];
    private signedOut = false;

    constructor(
        private def: ProviderDef,
        private bin: string,
        private t: BackendTurn,
    ) {}

    private get host(): BackendHost {
        return this.t.host;
    }

    private args(): string[] {
        const t = this.t;
        const a = [...extraArgs(this.def.id), ...STREAM_ARGS, "--include-partial-messages", "--permission-prompt-tool=stdio", "--permission-mode", MODES[t.mode]];
        if (t.model.id !== "default") a.push("--model", t.model.id);
        if (t.effort && (!t.model.effortLevels || t.model.effortLevels.includes(t.effort))) a.push("--effort", t.effort);
        if (t.resumeId) a.push("--resume", t.resumeId);
        if (t.maxTurns && Number.isFinite(t.maxTurns)) a.push("--max-turns", String(t.maxTurns));
        if (t.appendSystemPrompt) a.push("--append-system-prompt", t.appendSystemPrompt);
        for (const d of t.additionalDirectories) a.push("--add-dir", d);
        // An untrusted folder's Claude Code settings (hooks, permission rules), skills, agents and .mcp.json stay off.
        if (!t.trusted) a.push("--setting-sources", "user", "--strict-mcp-config");
        // The harness's deny and ask rules also cover what Claude Code would do without asking.
        a.push("--settings", JSON.stringify({ permissions: claudePermissions(t.rules) }));
        return a;
    }

    setMode(m: PermissionMode) {
        this.proc?.send({ type: "control_request", request_id: requestId(), request: { subtype: "set_permission_mode", mode: MODES[m] } });
    }

    private sendUser(content: unknown[]) {
        this.proc.send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: this.sessionId ?? "" });
    }

    async run(content: unknown[]): Promise<BackendResult> {
        const { signal } = this.t;
        if (signal.aborted) return { reason: "aborted", text: "", actions: [] };
        this.proc = new JsonLinesProcess(this.bin, this.args(), { cwd: this.t.cwd });
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            this.aborted = true;
            this.proc.send({ type: "control_request", request_id: requestId(), request: { subtype: "interrupt" } });
            // It answers an interrupt with a result; if it doesn't, stop it (SIGKILL if need be).
            killTimer = setTimeout(() => void this.proc.kill(), stopTiming.interruptMs);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.proc.send({ type: "control_request", request_id: requestId(), request: { subtype: "initialize" } });
        this.sendUser(content);
        let gotResult = false;
        try {
            for await (const m of this.proc.messages()) {
                if (m.type === "result") {
                    gotResult = true;
                    this.onResult(m);
                    const queued = this.aborted ? [] : this.host.drainQueued();
                    if (queued.length) {
                        // The turn now ends with the queued prompt's result; without one, it failed.
                        gotResult = false;
                        this.reason = undefined;
                        this.sendUser([{ type: "text", text: queued.join("\n\n") }]);
                        continue;
                    }
                    break;
                }
                this.onMessage(m);
            }
        } finally {
            signal.removeEventListener("abort", onAbort);
            await this.proc.stop(this.aborted ? 1000 : 3000);
            if (killTimer) clearTimeout(killTimer);
        }
        // Anything still open never got a result.
        for (const [id, p] of this.tools) this.endTool(id, p, this.aborted ? "Interrupted by user" : "Claude Code stopped before this finished.", true);
        const text = this.texts.join("\n\n");
        if (this.aborted) return { reason: "aborted", text, actions: this.actions };
        // A session it can't find ends with an error result (or exit) before init.
        const err = this.proc.stderr();
        const resumeFailed = Boolean(this.t.resumeId && !this.sessionId && /no conversation found|session.{0,40}(not found|doesn't exist|does not exist)/i.test(`${this.failure ?? ""}\n${err}`));
        if (!gotResult || resumeFailed) {
            const code = await this.proc.exited;
            const why = (resumeFailed && this.failure) || cliMessage(err) || `claude exited with code ${code}`;
            return { reason: "error", text, actions: this.actions, error: resumeFailed ? `Couldn't resume the Claude Code session: ${why}` : `Claude Code stopped: ${why}`, resumeFailed };
        }
        return { reason: this.reason ?? "done", text, actions: this.actions, error: this.failure };
    }

    private onMessage(m: Record<string, any>) {
        switch (m.type) {
            case "control_request":
                void this.onControlRequest(m);
                break;
            case "system":
                this.onSystem(m);
                break;
            case "stream_event":
                if (!m.parent_tool_use_id) this.onStreamEvent(m.event ?? {});
                break;
            case "assistant":
                this.onAssistant(m);
                break;
            case "user":
                if (!m.parent_tool_use_id) this.onToolResults(m);
                break;
            case "rate_limit_event":
                this.onRateLimit(m.rate_limit_info ?? {});
                break;
        }
    }

    private onSystem(m: Record<string, any>) {
        switch (m.subtype) {
            case "init":
                if (typeof m.session_id === "string" && m.session_id) {
                    this.sessionId = m.session_id;
                    this.host.sessionId(m.session_id);
                }
                // No API key behind it: the turn runs on the user's plan, not per-token billing.
                this.billedToPlan = m.apiKeySource === "none";
                break;
            case "api_retry": {
                const delay = Number(m.retry_delay_ms ?? m.delay_ms ?? 0);
                const why = [m.error_status, typeof m.error === "string" ? m.error : m.error?.message].filter(Boolean).join(" ");
                this.host.emit({ type: "retry", attempt: Number(m.attempt ?? 1), delayMs: delay, reason: why || "Claude Code is retrying the request" });
                break;
            }
            case "compact_boundary":
                this.host.emit({ type: "notice", level: "info", message: "Claude Code compacted its context." });
                break;
            case "informational":
                if (typeof m.content === "string" && m.content.trim()) this.host.emit({ type: "notice", level: m.level === "warning" ? "warn" : m.level === "error" ? "error" : "info", message: m.content });
                break;
        }
    }

    private onStreamEvent(e: Record<string, any>) {
        switch (e.type) {
            case "message_start":
                this.host.emit({ type: "request_start" });
                break;
            case "content_block_start":
                if (e.content_block?.type === "tool_use") {
                    this.streamingTools.set(e.index, e.content_block.id);
                    this.host.emit({ type: "tool_call_start", id: e.content_block.id, name: e.content_block.name });
                }
                break;
            case "content_block_delta": {
                const d = e.delta ?? {};
                if (d.type === "text_delta" && d.text) this.host.emit({ type: "text", text: d.text });
                else if (d.type === "thinking_delta" && d.thinking) this.host.emit({ type: "thinking", text: d.thinking });
                else if (d.type === "input_json_delta" && d.partial_json) {
                    const id = this.streamingTools.get(e.index);
                    if (id) this.host.emit({ type: "tool_call_delta", id, partial: d.partial_json });
                }
                break;
            }
        }
    }

    private onAssistant(m: Record<string, any>) {
        const msg = m.message ?? {};
        const blocks: any[] = Array.isArray(msg.content) ? msg.content : [];
        const parent: string | undefined = m.parent_tool_use_id ?? undefined;
        if (parent) {
            // A sub-agent's step: show its tool calls under the Agent call.
            const label = this.agentLabels.get(parent) ?? "sub-agent";
            for (const b of blocks) {
                if (b?.type !== "tool_use") continue;
                const { name, input } = toHarness(b.name, b.input ?? {});
                this.host.emit({ type: "subagent", parentId: parent, label, event: { type: "tool_start", call: { type: "tool_call", id: b.id, name, input }, title: titleFor(name, input) } });
            }
            return;
        }
        if (msg.usage) {
            const u = msg.usage;
            this.contextTokens = Number(u.input_tokens ?? 0) + Number(u.cache_read_input_tokens ?? 0) + Number(u.cache_creation_input_tokens ?? 0) + Number(u.output_tokens ?? 0);
        }
        if (m.error) this.onAssistantError(String(m.error));
        for (const b of blocks) {
            if (b?.type === "text" && typeof b.text === "string" && b.text.trim()) {
                this.texts.push(b.text);
                this.host.emit({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: b.text }], provider: this.def.id, model: this.t.model.id } });
            } else if (b?.type === "tool_use" && typeof b.id === "string") {
                const { name, input } = toHarness(b.name, b.input ?? {});
                const title = titleFor(name, input);
                this.tools.set(b.id, { name, input, title, started: Date.now() });
                if (b.name === "Agent" || b.name === "Task") this.agentLabels.set(b.id, String(input.description ?? input.subagent_type ?? "sub-agent"));
                this.host.emit({ type: "tool_start", call: { type: "tool_call", id: b.id, name, input }, title });
            }
        }
    }

    private onAssistantError(error: string) {
        if (error === "authentication_failed") {
            this.signedOut = true;
            this.failure = `Claude Code isn't signed in, or its sign-in expired. In a terminal, run \`${CLAUDE_CLI.signIn}\`, then try again.`;
        } else if (error === "rate_limit") this.failure = "Your Claude usage limit was reached. Claude Code says when it resets; switch models with /model meanwhile.";
        else if (error === "billing_error") this.failure = "Claude Code reported a billing problem with the account it's signed in to.";
        else this.failure = `Claude Code reported an error: ${error}`;
    }

    private onToolResults(m: Record<string, any>) {
        const blocks: any[] = (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: any) => b?.type === "tool_result");
        for (const b of blocks) {
            const p = this.tools.get(b.tool_use_id);
            if (!p) continue;
            // The structured result (for diffs) describes the message's one tool result.
            const structured = blocks.length === 1 && !b.is_error ? resultDisplay(p, m.tool_use_result, this.t.cwd) : undefined;
            this.endTool(b.tool_use_id, p, resultText(b.content), Boolean(b.is_error), structured);
        }
    }

    private endTool(id: string, p: PendingTool, content: string, isError: boolean, display?: ToolDisplay) {
        this.tools.delete(id);
        this.actions.push(p.title);
        this.host.emit({ type: "tool_end", call: { type: "tool_call", id, name: p.name, input: p.input }, result: { content, isError, display }, durationMs: Date.now() - p.started });
    }

    private onRateLimit(info: Record<string, any>) {
        if (info.status !== "rejected" && info.status !== "allowed_warning") return;
        const when = typeof info.resetsAt === "number" ? ` It resets ${new Date(info.resetsAt * 1000).toLocaleString()}.` : "";
        const which = typeof info.rateLimitType === "string" ? ` (${info.rateLimitType.replace(/_/g, " ")})` : "";
        if (info.status === "rejected") this.host.emit({ type: "notice", level: "warn", message: `Your Claude usage limit${which} has been reached.${when}` });
        else this.host.emit({ type: "notice", level: "info", message: `You're close to your Claude usage limit${which}.${when}` });
    }

    private onResult(m: Record<string, any>) {
        const u = m.usage ?? {};
        const usage: Usage = {
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? 0),
            cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
            cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
            // On a plan nothing is billed per token; with an API key, Claude Code reports the cost.
            cost: this.billedToPlan ? 0 : typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
        };
        const window = Object.values((m.modelUsage ?? {}) as Record<string, { contextWindow?: number }>).find((x) => typeof x?.contextWindow === "number")?.contextWindow;
        this.host.usage(usage, { contextTokens: this.contextTokens, contextWindow: window });
        if (this.aborted) return;
        if (m.subtype === "error_max_turns") this.reason = "max_turns";
        else if (m.subtype !== "success" || m.is_error) {
            this.reason = "error";
            const errs = Array.isArray(m.errors) ? m.errors.filter((x: unknown) => typeof x === "string") : [];
            this.failure ??= redact(errs.join("; ") || (typeof m.result === "string" && m.result) || `Claude Code ended the turn with ${m.subtype}`);
            if (this.signedOut) this.failure = `Claude Code isn't signed in, or its sign-in expired. In a terminal, run \`${CLAUDE_CLI.signIn}\`, then try again.`;
        } else this.reason = "done";
    }

    private async onControlRequest(m: Record<string, any>) {
        const req = m.request ?? {};
        const reply = (response: Record<string, unknown>) => this.proc.send({ type: "control_response", response: { subtype: "success", request_id: m.request_id, response } });
        if (req.subtype !== "can_use_tool") {
            this.proc.send({ type: "control_response", response: { subtype: "error", request_id: m.request_id, error: `${String(req.subtype)} isn't supported by this host` } });
            return;
        }
        try {
            reply({ ...(await this.permission(req)), toolUseID: req.tool_use_id });
        } catch (e) {
            reply({ behavior: "deny", message: `The permission check failed: ${redact((e as Error).message)}`, interrupt: true, toolUseID: req.tool_use_id });
        }
    }

    private async permission(req: Record<string, any>): Promise<Record<string, unknown>> {
        const raw: Record<string, unknown> = req.input && typeof req.input === "object" ? req.input : {};
        if (req.tool_name === "AskUserQuestion") {
            const qs: any[] = Array.isArray(raw.questions) ? raw.questions : [];
            const questions = qs.map((q) => ({
                question: String(q?.question ?? ""),
                header: typeof q?.header === "string" ? q.header : undefined,
                options: (Array.isArray(q?.options) ? q.options : []).map((o: any) => ({ label: String(o?.label ?? ""), description: typeof o?.description === "string" ? o.description : undefined })),
                multiSelect: Boolean(q?.multiSelect),
            }));
            const answers = await this.host.askQuestions(questions);
            if (!answers) return { behavior: "deny", message: "The user dismissed the question without answering.", interrupt: true };
            return { behavior: "allow", updatedInput: { ...raw, answers: Object.fromEntries(questions.map((q, i) => [q.question, (answers[i] ?? []).join(", ")])) } };
        }
        if (req.tool_name === "ExitPlanMode") {
            const r = await this.host.approvePlan(String(raw.plan ?? ""));
            if (r.approved) {
                const mode = r.mode ?? "default";
                this.host.setMode(mode);
                return { behavior: "allow", updatedInput: raw, updatedPermissions: [{ type: "setMode", mode: MODES[mode], destination: "session" }] };
            }
            const fb = r.feedback?.trim();
            return fb ? { behavior: "deny", message: `The user wants changes to the plan:\n${fb}` } : { behavior: "deny", message: "The user rejected the plan. Wait for them to say how to proceed.", interrupt: true };
        }
        const { name, input } = toHarness(String(req.tool_name ?? ""), raw);
        const reason = typeof req.decision_reason === "string" && req.decision_reason.trim() ? req.decision_reason : undefined;
        const a = await this.host.permission({ toolName: name, input, title: titleFor(name, input), reason });
        if (a.allow) return { behavior: "allow", updatedInput: raw, ...(a.mode ? { updatedPermissions: [{ type: "setMode", mode: MODES[a.mode], destination: "session" }] } : {}) };
        return { behavior: "deny", message: a.message, interrupt: a.stop };
    }
}

const PATH_RULE: Record<string, "Read" | "Edit"> = { Read: "Read", Glob: "Read", Grep: "Read", LS: "Read", Edit: "Edit", Write: "Edit", MultiEdit: "Edit", NotebookEdit: "Edit" };

/**
 * One harness rule as Claude Code permission rules, or none when Claude Code
 * has no equivalent (those still apply to whatever it asks about). Paths are
 * resolved the way the harness resolves them and passed as absolute (//…)
 * patterns, plus everything under them for a plain path, as the harness
 * matches; edit and read rules widen to all of Claude Code's edit or read
 * tools, which only makes a deny or ask rule stricter.
 */
export function claudeRule(raw: string, root: string): string[] {
    const { tool, spec } = parseRule(raw);
    const kind = PATH_RULE[tool];
    if (kind) {
        if (!spec) return [kind];
        const abs = pathPattern(spec, root);
        const rules = [`${kind}(/${abs})`];
        if (!/[*?]/.test(spec)) rules.push(`${kind}(/${abs.replace(/\/+$/, "")}/**)`);
        return rules;
    }
    if (tool === "Bash" || tool === "WebSearch") return [spec ? `${tool}(${spec})` : tool];
    if (tool === "WebFetch") return !spec ? ["WebFetch"] : /^domain:/.test(spec) ? [`WebFetch(${spec})`] : [];
    if (tool === "Task") return [spec ? `Agent(${spec})` : "Agent"];
    if (tool.startsWith("mcp__")) return [tool];
    return [];
}

/** The harness's deny and ask rules for Claude Code, with its credential store denied outright. */
export function claudePermissions(r: { deny: string[]; ask: string[]; root: string }): { deny: string[]; ask: string[] } {
    const store = [paths.credentialsFile(), paths.providers()].flatMap((f) => [`Read(/${f})`, `Edit(/${f})`]);
    const map = (rules: string[]) => [...new Set(rules.flatMap((x) => claudeRule(x, r.root)))];
    return { deny: [...map(r.deny), ...store], ask: map(r.ask) };
}

/** Claude Code's tool name and input as the harness's own tool sees them (for rules, titles, previews). */
export function toHarness(name: string, input: Record<string, unknown>): { name: string; input: Record<string, unknown> } {
    if (name === "Agent") return { name: "Task", input };
    return { name, input };
}

/** A transcript title like the harness's own tools use. */
export function titleFor(name: string, input: Record<string, unknown>): string {
    const s = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : "");
    switch (name) {
        case "Bash":
            return commandTitle(s("command"));
        case "Read":
        case "Write":
        case "Edit":
        case "MultiEdit":
            return `${name}(${s("file_path")})`;
        case "NotebookEdit":
            return `NotebookEdit(${s("notebook_path")})`;
        case "Glob":
        case "Grep":
            return `${name}(${s("pattern")}${s("path") ? ` in ${s("path")}` : ""})`;
        case "WebFetch":
            return `WebFetch(${s("url")})`;
        case "WebSearch":
            return `WebSearch(${s("query")})`;
        case "Task":
            return `Task(${s("description") || s("subagent_type")})`;
        case "Skill":
            return `Skill(${s("skill") || s("name")})`;
        default:
            return name;
    }
}

function resultText(content: unknown): string {
    if (typeof content === "string") return content;
    if (Array.isArray(content)) {
        return content
            .map((c: any) => (c?.type === "text" ? String(c.text ?? "") : c?.type === "image" ? "[image]" : ""))
            .filter(Boolean)
            .join("\n");
    }
    return content == null ? "" : JSON.stringify(content);
}

function rel(path: string, cwd: string): string {
    return path.startsWith(cwd + "/") ? path.slice(cwd.length + 1) : path;
}

/** Diffs for Claude Code's file edits, from the structured result it reports. */
function resultDisplay(p: PendingTool, r: unknown, cwd: string): ToolDisplay | undefined {
    if (!r || typeof r !== "object") return undefined;
    const x = r as Record<string, unknown>;
    const path = typeof x.filePath === "string" ? x.filePath : undefined;
    const original = typeof x.originalFile === "string" ? x.originalFile : null;
    const summary = (before: string, after: string) => {
        const st = diffStats(diffLines(before, after));
        return `Updated with ${st.added} addition${st.added === 1 ? "" : "s"} and ${st.removed} removal${st.removed === 1 ? "" : "s"}`;
    };
    if (p.name === "Write" && path && typeof x.content === "string") {
        if (original === null) {
            const lines = x.content ? x.content.replace(/\n$/, "").split("\n").length : 0;
            return { summary: `Wrote ${lines} line${lines === 1 ? "" : "s"}`, diff: { path: rel(path, cwd), before: "", after: x.content } };
        }
        return { summary: summary(original, x.content), diff: { path: rel(path, cwd), before: original, after: x.content } };
    }
    if (p.name === "Edit" && path && original !== null && typeof x.oldString === "string" && typeof x.newString === "string" && x.oldString) {
        const newString = x.newString;
        const after = x.replaceAll ? original.split(x.oldString).join(newString) : original.replace(x.oldString, () => newString);
        return { summary: summary(original, after), diff: { path: rel(path, cwd), before: original, after } };
    }
    // Reads and searches: a count, like the harness's own tools, rather than the contents.
    const file = x.file && typeof x.file === "object" ? (x.file as Record<string, unknown>) : undefined;
    if (p.name === "Read" && typeof file?.numLines === "number") {
        const n = file.numLines;
        const total = typeof file.totalLines === "number" && file.totalLines > n ? ` (of ${file.totalLines})` : "";
        return { summary: `Read ${n} line${n === 1 ? "" : "s"}${total}` };
    }
    if ((p.name === "Glob" || p.name === "Grep") && typeof x.numFiles === "number") {
        const n = typeof x.numMatches === "number" ? x.numMatches : typeof x.numLines === "number" && x.mode === "content" ? x.numLines : x.numFiles;
        const what = n === x.numFiles ? "file" : "match";
        return { summary: `Found ${n} ${what}${n === 1 ? "" : what === "match" ? "es" : "s"}` };
    }
    return undefined;
}
