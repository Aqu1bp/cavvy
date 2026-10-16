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
import { APP_TITLE, paths } from "../config/paths";
import { redact } from "../util/redact";
import { CLAUDE_CLI, JsonLinesProcess, cliMessage, commandTitle, extraArgs, requireCli, runCli, stopTiming } from "./cli";
import { backendModel, type AgentBackendClient, type BackendHost, type BackendResult, type BackendTurn, type OrchestratorServer } from "./types";
import type { TurnEndReason } from "../agent/agent";

/** How long Claude Code may take to connect to the harness's MCP server before the prompt goes without it (changeable for tests). */
export const attachTiming = { timeoutMs: 30_000 };

/** Claude Code's tools that change files, off for a read-only sub-agent. */
const READ_ONLY_DENY = ["Write", "Edit", "MultiEdit", "NotebookEdit"];

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

/** Noninteractive fast mode via --settings was added in 2.1.205. */
export function claudeFastModeVersion(version: unknown): boolean {
    if (typeof version !== "string") return false;
    const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version);
    if (!m) return false;
    const [major, minor, patch] = m.slice(1).map(Number) as [number, number, number];
    return major > 2 || (major === 2 && (minor > 1 || (minor === 1 && patch >= 205)));
}

let requestSeq = 0;
const requestId = () => `harness-${Date.now().toString(36)}-${(++requestSeq).toString(36)}`;

export class ClaudeCodeBackend implements AgentBackendClient {
    readonly agentBackend = true as const;
    /** Turns running now: the main agent's, and sub-agents' on Claude Code. */
    private turns = new Set<ClaudeTurn>();

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
                            supportsFastMode: x.supportsFastMode === true && claudeFastModeVersion(m.response.response?.claude_code_version),
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
        this.turns.add(turn);
        try {
            return await turn.run([{ type: "text", text: t.prompt }, ...t.images.map((i) => ({ type: "image", source: { type: "base64", media_type: i.mediaType, data: i.data } }))]);
        } finally {
            this.turns.delete(turn);
        }
    }

    /** Claude Code's own /compact, on the session being continued. */
    async compact(t: Omit<BackendTurn, "prompt" | "images"> & { instructions?: string }): Promise<BackendResult> {
        if (!t.resumeId) return { reason: "done", text: "", actions: [] };
        return this.runTurn({ ...t, prompt: `/compact${t.instructions ? ` ${t.instructions}` : ""}`, images: [] });
    }

    /** Each running turn takes its own agent's mode now (a read-only sub-agent's stays read-only). */
    setMode(_m: PermissionMode) {
        for (const turn of this.turns) turn.setMode(turn.agentMode());
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
    /** Agent calls whose sub-agent has started and hasn't finished, and those that have finished (and how). */
    private liveAgents = new Set<string>();
    private endedAgents = new Map<string, TurnEndReason>();
    /** Sub-agents' tool calls still waiting for their result, with the Agent call they're under. */
    private subTools = new Map<string, PendingTool & { parent: string }>();
    /** What each sub-agent handed back (its SubagentHandback message), by Agent call. */
    private reports = new Map<string, string>();
    private texts: string[] = [];
    private actions: string[] = [];
    private sessionId?: string;
    private billedToPlan = false;
    private contextTokens?: number;
    private aborted = false;
    private failure?: string;
    private reason?: BackendResult["reason"];
    private signedOut = false;
    /** Control requests sent to Claude Code, waiting for its answer. */
    private controls = new Map<string, (response: Record<string, any>) => void>();
    /** The prompt has been sent. */
    private prompted = false;

    constructor(
        private def: ProviderDef,
        private bin: string,
        private t: BackendTurn,
    ) {}

    private get host(): BackendHost {
        return this.t.host;
    }

    /** The mode of the agent running this turn, as it is now. */
    agentMode(): PermissionMode {
        return this.host.mode();
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
        const permissions = claudePermissions(t.rules);
        // Always override external preferences: an unsupported model must not silently switch to Opus.
        const fastMode = Boolean(t.fastMode && t.model.supportsFastMode);
        if (!t.readOnly) {
            a.push("--settings", JSON.stringify({ permissions, fastMode }));
            return a;
        }
        // A read-only sub-agent: no edit tools, no MCP servers of its own, and every command asks (the harness lets read-only ones run).
        a.push("--disallowedTools", READ_ONLY_DENY.join(","));
        if (t.trusted) a.push("--strict-mcp-config");
        const settings = { fastMode, permissions: { deny: [...permissions.deny, ...READ_ONLY_DENY], ask: [...permissions.ask, "Bash"] }, sandbox: { autoAllowBashIfSandboxed: false } };
        a.push("--settings", JSON.stringify(settings));
        return a;
    }

    setMode(m: PermissionMode) {
        this.proc?.send({ type: "control_request", request_id: requestId(), request: { subtype: "set_permission_mode", mode: MODES[m] } });
    }

    private sendUser(content: unknown[]) {
        this.prompted = true;
        this.proc.send({ type: "user", message: { role: "user", content }, parent_tool_use_id: null, session_id: this.sessionId ?? "" });
    }

    /**
     * Give Claude Code the harness's MCP server for this run. It goes over
     * stdin (mcp_set_servers, as the Agent SDK sends it), so the token is in
     * neither its arguments, which other local users can list, nor the
     * environment its commands inherit. Claude Code answers once it has
     * connected (or given up); the harness's tools need no prompt.
     */
    private async attach(o: OrchestratorServer) {
        const id = requestId();
        const answered = new Promise<Record<string, any>>((resolve) => this.controls.set(id, resolve));
        this.proc.send({
            type: "control_request",
            request_id: id,
            request: {
                subtype: "mcp_set_servers",
                servers: {
                    [o.name]: {
                        type: "http",
                        url: o.url,
                        headers: { Authorization: o.authorization },
                        timeout: o.toolTimeoutSec * 1000,
                        alwaysLoad: true,
                        tools: o.tools.map((name) => ({ name, permission_policy: "always_allow" })),
                    },
                },
            },
        });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const r = await Promise.race([answered, this.proc.exited.then(() => undefined), new Promise<undefined>((resolve) => (timer = setTimeout(() => resolve(undefined), attachTiming.timeoutMs)))]);
        clearTimeout(timer);
        this.controls.delete(id);
        if (this.aborted) return;
        const why = !r ? "it didn't answer" : r.subtype !== "success" ? String(r.error ?? "it refused") : r.response?.errors?.[o.name];
        if (why) this.host.emit({ type: "notice", level: "warn", message: `Claude Code couldn't connect to ${APP_TITLE}'s delegation tools (${redact(String(why))}); this turn runs without them.` });
    }

    async run(content: unknown[]): Promise<BackendResult> {
        const { signal } = this.t;
        if (signal.aborted) return { reason: "aborted", text: "", actions: [] };
        this.proc = new JsonLinesProcess(this.bin, this.args(), { cwd: this.t.cwd });
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
            this.aborted = true;
            // Nothing to interrupt before the prompt is sent.
            if (!this.prompted) return void this.proc.kill();
            this.proc.send({ type: "control_request", request_id: requestId(), request: { subtype: "interrupt" } });
            // It answers an interrupt with a result; if it doesn't, stop it (SIGKILL if need be).
            killTimer = setTimeout(() => void this.proc.kill(), stopTiming.interruptMs);
        };
        signal.addEventListener("abort", onAbort, { once: true });
        this.proc.send({ type: "control_request", request_id: requestId(), request: { subtype: "initialize" } });
        // The prompt waits for the MCP server, so its first request has the harness's tools.
        const o = this.t.orchestrator;
        if (o) void this.attach(o).then(() => this.aborted || this.sendUser(content));
        else this.sendUser(content);
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
        // Anything still open never got a result. Sub-agents still working (in the background) stopped with Claude Code.
        for (const id of [...this.liveAgents]) this.endAgent(id, "aborted");
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

    private fastModeNotice?: string;
    private fastModeObserved = false;

    private reportFastMode(m: Record<string, any>) {
        if (m.fast_mode_state === "on") this.fastModeObserved = true;
        if (!this.t.fastMode || typeof m.fast_mode_state !== "string" || m.fast_mode_state === "on") return;
        const reason = typeof m.fast_mode_disabled_reason === "string" ? m.fast_mode_disabled_reason.replace(/_/g, " ") : m.fast_mode_state;
        if (reason === this.fastModeNotice) return;
        this.fastModeNotice = reason;
        this.host.emit({ type: "notice", level: "warn", message: `Claude Code is not using fast mode (${reason}). Account, organization settings or capacity can limit availability.` });
    }

    private onMessage(m: Record<string, any>) {
        switch (m.type) {
            case "control_request":
                void this.onControlRequest(m);
                break;
            case "control_response": {
                const r = m.response ?? {};
                this.reportFastMode(r.response ?? {});
                this.controls.get(String(r.request_id ?? ""))?.(r);
                break;
            }
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
                else this.onSubToolResults(m);
                break;
            case "rate_limit_event":
                this.onRateLimit(m.rate_limit_info ?? {});
                break;
        }
    }

    private onSystem(m: Record<string, any>) {
        this.reportFastMode(m);
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
            case "task_started":
                this.agentStarted(String(m.tool_use_id ?? ""));
                break;
            case "task_notification": {
                // A sub-agent finished (in the foreground, this comes before its Agent call's result). It
                // ran even if nothing of it showed. A later one replaces what this one said (the report it
                // was waiting on, or how it ended).
                const id = String(m.tool_use_id ?? "");
                const report = typeof m.handback_report?.text === "string" ? m.handback_report.text : undefined;
                this.agentStarted(id);
                this.endAgent(id, m.status === "completed" ? "done" : m.status === "failed" ? "error" : "aborted", report);
                break;
            }
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
            this.agentStarted(parent);
            // One Claude Code said has finished shows no more steps (they'd never be closed), only its report.
            const over = this.endedAgents.has(parent);
            for (const b of blocks) {
                if (b?.type !== "tool_use") continue;
                // Its report to the main agent: what it says last, not a tool of its own.
                if (b.name === "SubagentHandback") {
                    const fresh = typeof b.input?.message === "string" && this.report(parent, b.input.message);
                    // One that ended before it (waiting on work of its own) takes it as its report: it ends again, as it did.
                    const was = this.endedAgents.get(parent);
                    if (fresh && over && was !== undefined) this.host.emit({ type: "subagent", parentId: parent, label, event: { type: "turn_end", reason: was } });
                    continue;
                }
                if (over) continue;
                const { name, input } = toHarness(b.name, b.input ?? {});
                const title = titleFor(name, input);
                this.subTools.set(b.id, { name, input, title, started: Date.now(), parent });
                this.host.emit({ type: "subagent", parentId: parent, label, event: { type: "tool_start", call: { type: "tool_call", id: b.id, name, input }, title } });
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
            let content = resultText(b.content);
            if (p.name === "Task") {
                // A sub-agent in the background goes on after this; one in the foreground is over.
                const background = m.tool_use_result?.status === "async_launched";
                // Once Claude Code has said how it ended, the result only brings its report.
                const report = handedBack(m);
                if (!background && !this.endedAgents.has(b.tool_use_id)) this.endAgent(b.tool_use_id, b.is_error ? "error" : "done", report);
                else if (!background && report) this.report(b.tool_use_id, report, true);
                // Its report came as a handback: the result only says where to find it.
                content = (!background && this.reports.get(b.tool_use_id)) || content;
            }
            // The structured result (for diffs) describes the message's one tool result.
            const structured = blocks.length === 1 && !b.is_error ? resultDisplay(p, m.tool_use_result, this.t.cwd) : undefined;
            this.endTool(b.tool_use_id, p, content, Boolean(b.is_error), structured);
        }
    }

    /** A sub-agent's tool results: its tool calls under the Agent call finish. */
    private onSubToolResults(m: Record<string, any>) {
        this.agentStarted(String(m.parent_tool_use_id));
        const blocks: any[] = (Array.isArray(m.message?.content) ? m.message.content : []).filter((b: any) => b?.type === "tool_result");
        for (const b of blocks) {
            const p = this.subTools.get(b.tool_use_id);
            if (!p) continue;
            // A sub-agent's own Agent call: its report rather than where it went, as at the top level.
            const content = (p.name === "Task" && (this.reports.get(b.tool_use_id) || (blocks.length === 1 && handedBack(m)))) || resultText(b.content);
            const structured = blocks.length === 1 && !b.is_error ? resultDisplay(p, m.tool_use_result, this.t.cwd) : undefined;
            this.endSubTool(b.tool_use_id, p, content, Boolean(b.is_error), structured);
        }
    }

    private endSubTool(id: string, p: PendingTool & { parent: string }, content: string, isError: boolean, display?: ToolDisplay) {
        this.subTools.delete(id);
        const label = this.agentLabels.get(p.parent) ?? "sub-agent";
        this.host.emit({ type: "subagent", parentId: p.parent, label, event: { type: "tool_end", call: { type: "tool_call", id, name: p.name, input: p.input }, result: { content, isError, display }, durationMs: Date.now() - p.started } });
    }

    /**
     * A sub-agent's report, shown as the last thing it says; whether it's new.
     * Claude Code's word on it (a notification, the call's result) replaces an
     * earlier one; its own SubagentHandback calls don't (a second is turned down).
     */
    private report(parent: string, text: string, replace = false): boolean {
        const had = this.reports.get(parent);
        if (!text.trim() || (had !== undefined && (!replace || had.trim() === text.trim()))) return false;
        this.reports.set(parent, text);
        // Only on a sub-agent that has a chip: one that never started would get one that never ends.
        if (this.liveAgents.has(parent) || this.endedAgents.has(parent)) this.host.emit({ type: "subagent", parentId: parent, label: this.agentLabels.get(parent) ?? "sub-agent", event: { type: "text", text } });
        return true;
    }

    private agentStarted(id: string) {
        if (this.agentLabels.has(id) && !this.endedAgents.has(id)) this.liveAgents.add(id);
    }

    /** A sub-agent is over (or Claude Code says again how it ended): its open tool calls with it, and its chip says how. */
    private endAgent(id: string, reason: TurnEndReason, report?: string) {
        const live = this.liveAgents.delete(id);
        const was = this.endedAgents.get(id);
        if (!live && was === undefined) {
            // One that never showed has no chip: its report is for its Agent call's result.
            if (report) this.report(id, report, true);
            return;
        }
        this.endedAgents.set(id, reason);
        const reported = report ? this.report(id, report, true) : false;
        if (!live && !reported && reason === was) return;
        for (const [sub, p] of this.subTools) if (p.parent === id) this.endSubTool(sub, p, reason === "done" ? "Claude Code didn't report a result for this." : "Stopped with the sub-agent.", true);
        this.host.emit({ type: "subagent", parentId: id, label: this.agentLabels.get(id) ?? "sub-agent", event: { type: "turn_end", reason } });
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
        this.reportFastMode(m);
        const u = m.usage ?? {};
        const mixedPlanCost = this.billedToPlan && this.fastModeObserved && m.fast_mode_state !== "on";
        if (mixedPlanCost) this.host.emit({ type: "notice", level: "info", message: "Claude Code changed speed during this turn. The displayed cost is its total estimate; the share covered by your plan is not reported." });
        const usage: Usage = {
            inputTokens: Number(u.input_tokens ?? 0),
            outputTokens: Number(u.output_tokens ?? 0),
            cacheReadTokens: Number(u.cache_read_input_tokens ?? 0),
            cacheWriteTokens: Number(u.cache_creation_input_tokens ?? 0),
            // Fast service uses paid credits even on a subscription. A final cooldown
            // must not erase earlier fast spend; the CLI only gives a whole-turn total.
            cost: this.billedToPlan && !this.fastModeObserved ? 0 : typeof m.total_cost_usd === "number" ? m.total_cost_usd : undefined,
            ...(mixedPlanCost ? { costEstimated: true } : {}),
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
        // The harness's own tools (delegating to other models): what a delegated agent does is checked when it does it.
        const own = this.t.orchestrator;
        if (own && String(req.tool_name ?? "").startsWith(`mcp__${own.name}__`)) return { behavior: "allow", updatedInput: raw };
        const { name, input } = toHarness(String(req.tool_name ?? ""), raw);
        const reason = typeof req.decision_reason === "string" && req.decision_reason.trim() ? req.decision_reason : undefined;
        const a = await this.host.permission({ toolName: name, input, title: titleFor(name, input), reason });
        if (a.allow) return { behavior: "allow", updatedInput: raw, ...(a.mode ? { updatedPermissions: [{ type: "setMode", mode: MODES[a.mode], destination: "session" }] } : {}) };
        return { behavior: "deny", message: a.message, interrupt: a.stop };
    }
}

/** The report a sub-agent handed back, as its Agent call's structured result carries it. */
function handedBack(m: Record<string, any>): string | undefined {
    const text = m.tool_use_result?.handbackReport?.text;
    return typeof text === "string" ? text : undefined;
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
    if (tool === "WebFetch") {
        if (!spec) return ["WebFetch"];
        const domain = spec.match(/^domain:(.+)$/)?.[1];
        if (!domain) return [];
        // The harness's domain:example.com covers its subdomains; Claude Code's needs *.example.com for those.
        return domain.startsWith("*.") ? [`WebFetch(${spec})`] : [`WebFetch(${spec})`, `WebFetch(domain:*.${domain})`];
    }
    // Every tool: Claude Code takes a bare *; with a path (or a domain), every tool that reads or edits it.
    if (tool === "*") {
        if (!spec) return ["*"];
        if (/^domain:/.test(spec)) return claudeRule(`WebFetch(${spec})`, root);
        return [...claudeRule(`Read(${spec})`, root), ...claudeRule(`Edit(${spec})`, root)];
    }
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
