// User-defined hooks: handlers run at lifecycle points, configured in
// settings.json under "hooks" (src/config/hook-config.ts reads both our flat
// format and Claude Code's nested one). Each gets the event as JSON:
//
//   command   on stdin. exit 0 -> continue (stdout may carry a JSON decision);
//             exit 2 -> block, stderr is the reason (on the events that can
//             block; elsewhere it's reported like any other failure); other
//             codes -> a non-blocking error, shown to the user.
//   http      POSTed as the body. 2xx with an empty or JSON body -> as exit 0;
//             anything else is a non-blocking error.
//   prompt    asked of a small model, which answers {"ok": bool, "reason"}.
//   mcp_tool  a tool on a connected MCP server; its text is read like stdout.
//
// JSON output follows Claude Code's: top-level continue/stopReason,
// systemMessage, decision: "block" + reason, and hookSpecificOutput (or the
// same fields at the top level) with permissionDecision, additionalContext,
// updatedInput, decision (PermissionRequest), watchPaths, worktreePath.
//
// All handlers matching an event run at once; identical ones run once.

import { basename, isAbsolute } from "path";
import type { HookConfig, Settings } from "../config/settings";
import { HOOK_EVENTS as ALL_EVENTS, type HookEvent } from "../config/hook-config";
import { parseRule, ruleMatches, toolPath, type RuleTarget } from "../permissions/rules";
import { expandPath } from "../util/files";
import { childEnv } from "../tools/bash";
import { redactedJson } from "../util/redact";
import { isShellTool } from "../tools/types";
import { APP_NAME } from "../config/name";
import { legacyMcpMatcher, legacyMcpName } from "../config/legacy";

export type { HookEvent };

/** In the order /hooks lists them. */
export const HOOK_EVENTS: readonly HookEvent[] = ALL_EVENTS;

/** Events whose hooks can block (exit 2, decision "block", a prompt hook's ok: false). */
export const BLOCKING_EVENTS = new Set<HookEvent>(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "UserPromptSubmit", "Stop", "SubagentStop", "PreCompact", "WorktreeCreate"]);

/** Events where a hook's plain stdout is context for the model, as in Claude Code. */
const TEXT_CONTEXT = new Set<HookEvent>(["UserPromptSubmit", "SessionStart", "SubagentStart"]);

/** Events whose prompt hooks make sense (the rest have nothing a yes/no could decide). */
const PROMPT_EVENTS = new Set<HookEvent>(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PostToolBatch", "UserPromptSubmit", "Stop", "SubagentStop", "PermissionRequest", "PermissionDenied"]);

/** The input field each event's matcher is compared with; events not listed run every hook. */
const MATCH_FIELD: Partial<Record<HookEvent, string>> = {
    PreToolUse: "tool_name",
    PermissionRequest: "tool_name",
    PermissionDenied: "tool_name",
    PostToolUse: "tool_name",
    PostToolUseFailure: "tool_name",
    SessionStart: "source",
    SessionEnd: "reason",
    PreCompact: "trigger",
    PostCompact: "trigger",
    SubagentStart: "agent_type",
    SubagentStop: "agent_type",
    Notification: "notification_type",
    StopFailure: "error",
    InstructionsLoaded: "load_reason",
    DirectoryAdded: "source",
};

/** Events that take `if` (a permission rule about the tool call). */
const TOOL_EVENTS = new Set<HookEvent>(["PreToolUse", "PermissionRequest", "PermissionDenied", "PostToolUse", "PostToolUseFailure"]);

const DEFAULT_TIMEOUT = 60;
const PROMPT_TIMEOUT = 30;
/** Claude Code's cap on a hook's additionalContext. */
const MAX_CONTEXT = 10_000;

export interface HookOutcome {
    /** Exit 2, decision "block" or a prompt hook's no: the reason. */
    blocked?: string;
    /** A prompt hook on Stop/SubagentStop judged its condition can never hold. */
    impossible?: boolean;
    /** PreToolUse: the strictest permissionDecision. */
    decision?: "allow" | "deny" | "ask";
    reason?: string;
    /** PreToolUse or PermissionRequest: the input to run the tool with instead. */
    updatedInput?: Record<string, unknown>;
    /** PermissionRequest: answered for the user. */
    permission?: { behavior: "allow" | "deny"; message?: string; interrupt?: boolean };
    additionalContext?: string;
    /** PostToolUse: what the model sees instead of the tool's output. */
    updatedToolOutput?: string;
    /** continue: false: end the turn, with this reason. */
    stop?: string;
    /** systemMessage: shown to the user. */
    messages: string[];
    /** SessionStart, CwdChanged, FileChanged: files FileChanged watches. */
    watchPaths?: string[];
    /** WorktreeCreate: the folder the hook made. */
    worktreePath?: string;
    errors: string[];
}

export interface HookServices {
    signal?: AbortSignal;
    /** For prompt hooks: one answer from a small model (`model`, when the hook names one). */
    complete?(system: string, prompt: string, signal: AbortSignal, model?: string): Promise<string>;
    /** For mcp_tool hooks: call a tool on a connected server. */
    callTool?(server: string, tool: string, input: Record<string, unknown>, signal: AbortSignal): Promise<{ text: string; isError: boolean }>;
    /** An async command hook finished: what it sent back, for the next request. */
    onAsync?(o: HookOutcome): void;
}

/** What one handler came back with. */
export type HookResult = { kind: "output"; json?: Record<string, any>; text?: string } | { kind: "block"; reason: string; impossible?: boolean } | { kind: "error"; message: string } | { kind: "none" };

const matcherCache = new Map<string, (v: string) => boolean>();

/** Claude Code's rules: all for "", "*" or none; a plain name or list (a|b, a,b) exactly; anything else an unanchored regex. */
export function matcherFn(m: string | undefined): (v: string) => boolean {
    if (!m || m === "*") return () => true;
    let f = matcherCache.get(m);
    if (f) return f;
    if (/^[A-Za-z0-9_\-, |]+$/.test(m)) {
        const names = new Set(m.split(/[|,]/).map((s) => s.trim()).filter(Boolean));
        f = (v) => names.has(v);
    } else {
        try {
            const re = new RegExp(m);
            f = (v) => re.test(v);
        } catch {
            f = () => false;
        }
    }
    matcherCache.set(m, f);
    return f;
}

function target(toolName: string, input: any, cwd: string): RuleTarget {
    const t: RuleTarget = { toolName };
    if (isShellTool(toolName)) t.command = String(input?.command ?? "");
    const p = toolPath(toolName, input);
    if (p !== undefined) t.path = expandPath(p, cwd);
    if (toolName === "WebFetch") t.url = String(input?.url ?? "");
    if (toolName === "Task") t.agentType = String(input?.subagent_type ?? "general-purpose");
    return t;
}

/**
 * A FileChanged matcher as the files it names (`.envrc|config/app.json`), or
 * undefined when it's a pattern: those match a file's name but watch nothing.
 */
export function fileMatcherNames(m: string | undefined): string[] | undefined {
    if (!m || m === "*" || /[\\^$*+?()[\]{}]/.test(m)) return undefined;
    return m.split("|").map((s) => s.trim()).filter(Boolean);
}

/** A FileChanged handler's matcher against the file that changed: a name its file name, a path the file itself. */
function fileMatches(m: string, file: string): boolean {
    const names = fileMatcherNames(m);
    if (!names) return matcherFn(m)(basename(file));
    // A relative path is the watcher's, under the project folder; whatever the working directory is now, it ends the file's path.
    return names.some((n) => (isAbsolute(n) ? n === file : n.includes("/") ? file.endsWith(`/${n.replace(/^\.\//, "")}`) : n === basename(file)));
}

/**
 * A tool event's matcher for a backend that matches hooks itself (Claude Code), covering what
 * hookApplies does: Monitor for one that covers Bash, since a Monitor command runs like a Bash one,
 * and Cavvy's MCP tools for one written for Harness's (mcp__harness__…, legacy.ts).
 */
export function backendMatcher(event: string, m: string | undefined): string | undefined {
    if (!m || MATCH_FIELD[event as HookEvent] !== "tool_name") return m;
    const extra: string[] = [];
    if (matcherFn(m)("Bash") && !matcherFn(m)("Monitor")) extra.push("Monitor");
    const renamed = legacyMcpMatcher(m, APP_NAME);
    if (renamed !== m) extra.push(renamed);
    return matcherOr(m, extra);
}

/** A matcher for what `m` matches or any of `extra` does (each a list of names or a regex, as matcherFn reads them). */
export function matcherOr(m: string, extra: string[]): string {
    if (!extra.length) return m;
    const simple = (x: string) => /^[A-Za-z0-9_\-, |]+$/.test(x);
    if (simple(m) && extra.every(simple)) return [m, ...extra].join("|");
    return [m, ...extra].map((x) => (simple(x) ? `^(?:${x.split(/[|,]/).map((n) => n.trim()).filter(Boolean).join("|")})$` : `(?:${x})`)).join("|");
}

/** Other names a tool's hooks may know it by: Bash for Monitor, Harness's for a tool of Cavvy's MCP server. */
function toolAliases(name: string): string[] {
    if (name === "Monitor") return ["Bash"];
    const old = legacyMcpName(name, APP_NAME);
    return old ? [old] : [];
}

/** Does this handler run for this occurrence of the event? */
export function hookApplies(h: HookConfig, event: HookEvent, payload: Record<string, unknown>, cwd: string): boolean {
    const field = MATCH_FIELD[event];
    if (field) {
        const v = payload[field];
        // A Monitor command runs like a Bash one: hooks that guard Bash guard it too. And hooks written
        // for Harness's MCP server's tools (mcp__harness__…) guard Cavvy's.
        if (typeof v === "string" && !matcherFn(h.matcher)(v) && !(field === "tool_name" && toolAliases(v).some(matcherFn(h.matcher)))) return false;
    }
    if (event === "FileChanged" && h.matcher && h.matcher !== "*" && typeof payload.file_path === "string" && !fileMatches(h.matcher, payload.file_path)) return false;
    if (h.if && TOOL_EVENTS.has(event) && typeof payload.tool_name === "string") {
        if (!ruleMatches(parseRule(h.if), target(payload.tool_name, payload.tool_input, cwd), cwd, "allow")) return false;
    }
    return true;
}

/** How a handler is named in messages. */
export function hookLabel(h: HookConfig): string {
    switch (h.type ?? "command") {
        case "http":
            return `http hook ${h.url}`;
        case "prompt":
            return "prompt hook";
        case "mcp_tool":
            return `hook mcp__${h.server}__${h.tool}`;
        default:
            return `hook "${[h.command, ...(h.args ?? [])].join(" ")}"`;
    }
}

function hookKey(h: HookConfig): string {
    const { matcher: _m, if: _i, statusMessage: _s, ...rest } = h;
    return JSON.stringify(rest);
}

function shell(): string {
    return process.env.SHELL && /(ba|z)sh$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
}

function hookEnv(event: HookEvent, cwd: string, h: HookConfig): Record<string, string> {
    return childEnv({
        CAVVY_HOOK_EVENT: event,
        CAVVY_PROJECT_DIR: cwd,
        // Scripts written for Claude Code read these, and ones written for Harness the HARNESS_ ones (legacy.ts).
        CLAUDE_PROJECT_DIR: cwd,
        HARNESS_HOOK_EVENT: event,
        HARNESS_PROJECT_DIR: cwd,
        ...(h.pluginRoot ? { CAVVY_PLUGIN_ROOT: h.pluginRoot, CLAUDE_PLUGIN_ROOT: h.pluginRoot, HARNESS_PLUGIN_ROOT: h.pluginRoot } : {}),
    });
}

/** ${CLAUDE_PROJECT_DIR} and the like in an exec-form hook's command and args (no shell to expand them). */
function expandVars(s: string, env: Record<string, string>): string {
    return s.replace(/\$\{(\w+)\}|\$(\w+)/g, (all, a, b) => env[a ?? b] ?? all);
}

/** The output of a command (or the text of a tool result), read as Claude Code reads stdout. */
function readOutput(stdout: string): HookResult {
    const s = stdout.trim();
    if (!s) return { kind: "output" };
    if (s.startsWith("{")) {
        try {
            const j = JSON.parse(s);
            if (j && typeof j === "object" && !Array.isArray(j)) return { kind: "output", json: j };
        } catch {
            // plain output
        }
    }
    return { kind: "output", text: s };
}

function timeoutSignal(h: HookConfig, services: HookServices, fallback: number): AbortSignal {
    const t = AbortSignal.timeout((h.timeout ?? fallback) * 1000);
    return services.signal ? AbortSignal.any([services.signal, t]) : t;
}

async function runCommand(h: HookConfig, event: HookEvent, stdin: string, cwd: string, services: HookServices): Promise<HookResult> {
    const env = hookEnv(event, cwd, h);
    const argv = h.args ? [expandVars(h.command!, env), ...h.args.map((a) => expandVars(a, env))] : [shell(), "-c", h.command!];
    const seconds = h.timeout ?? DEFAULT_TIMEOUT;
    let timedOut = false;
    let proc;
    try {
        proc = Bun.spawn(argv, { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", env, signal: services.signal });
    } catch (e) {
        return { kind: "error", message: `${event} hook failed to start: ${(e as Error).message}` };
    }
    const timer = setTimeout(() => {
        timedOut = true;
        proc.kill();
    }, seconds * 1000);
    try {
        // A hook that exits without reading its input (`exit 0`, a bare echo) closes
        // the pipe first: EPIPE just means it didn't want it, and its output still counts.
        // (Bun's stdin is a socket pair on macOS, which says ENOTCONN or ECONNRESET instead.)
        // write() returns a promise when the input doesn't fit in the pipe, so await that too.
        try {
            await proc.stdin.write(stdin);
            await proc.stdin.end();
        } catch (e) {
            if (!["EPIPE", "ENOTCONN", "ECONNRESET"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
        }
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (timedOut) return { kind: "error", message: `${event} ${hookLabel(h)} timed out after ${seconds}s` };
        if (services.signal?.aborted) return { kind: "none" };
        if (code === 2) {
            // PermissionRequest ignores exit 2: only a decision object answers for the user.
            if (event === "PermissionRequest") return { kind: "none" };
            if (BLOCKING_EVENTS.has(event)) return { kind: "block", reason: stderr.trim() || `Blocked by ${event} hook` };
        }
        if (code !== 0) return { kind: "error", message: `${event} ${hookLabel(h)} exited with ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}` };
        // WorktreeCreate: the path is the last line, whatever came before it (a shell's banner).
        if (event === "WorktreeCreate") {
            const last = stdout.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim().split("\n").pop()?.trim();
            return last?.startsWith("{") ? readOutput(last) : { kind: "output", json: last ? { worktreePath: last } : undefined };
        }
        return readOutput(stdout);
    } finally {
        clearTimeout(timer);
    }
}

async function runHttp(h: HookConfig, event: HookEvent, body: string, services: HookServices): Promise<HookResult> {
    const allowed = new Set(h.allowedEnvVars ?? []);
    // From the hook environment, so provider keys can't be sent anywhere, even when listed.
    const env = allowed.size ? childEnv() : {};
    const headers: Record<string, string> = { "content-type": "application/json" };
    for (const [k, v] of Object.entries(h.headers ?? {})) headers[k] = v.replace(/\$\{(\w+)\}|\$(\w+)/g, (_, a, b) => (allowed.has(a ?? b) ? (env[a ?? b] ?? "") : ""));
    const signal = timeoutSignal(h, services, DEFAULT_TIMEOUT);
    let res: Response;
    try {
        res = await fetch(h.url!, { method: "POST", headers, body, signal, redirect: "error" });
    } catch (e) {
        if (services.signal?.aborted) return { kind: "none" };
        const timedOut = signal.aborted;
        return { kind: "error", message: `${event} ${hookLabel(h)} ${timedOut ? `timed out after ${h.timeout ?? DEFAULT_TIMEOUT}s` : `failed: ${(e as Error).message}`}` };
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) return { kind: "error", message: `${event} ${hookLabel(h)} returned ${res.status}${text.trim() ? `: ${text.trim().slice(0, 300)}` : ""}` };
    const out = readOutput(text);
    if (out.kind === "output" && out.text !== undefined) return { kind: "error", message: `${event} ${hookLabel(h)} returned text, not JSON: ${out.text.slice(0, 300)}` };
    return out;
}

const PROMPT_SYSTEM = `You are a hook in a coding agent: you check one event against the user's rule. You get the rule and the event as JSON. Reply with only a JSON object, no other text:
{"ok": true} when the rule allows it or the condition holds,
{"ok": false, "reason": "<what is wrong, addressed to the agent>"} when it doesn't.
Add "impossible": true to a "no" only when the condition can never be met.`;

async function runPrompt(h: HookConfig, event: HookEvent, input: string, services: HookServices): Promise<HookResult> {
    if (!PROMPT_EVENTS.has(event)) return { kind: "error", message: `${event} doesn't run prompt hooks (use a command hook)` };
    if (!services.complete) return { kind: "error", message: `${event} prompt hook skipped: no model is set up to answer it` };
    // $ARGUMENTS is the input; \$ is a literal $. No $ARGUMENTS: the input goes after the prompt.
    const raw = h.prompt!;
    // One pass over the prompt as written, so a \$ inside the input stays as it is.
    let used = false;
    const filled = raw.replace(/\\\$|\$ARGUMENTS/g, (m) => (m === "$ARGUMENTS" ? ((used = true), input) : "$"));
    const prompt = used ? filled : `${filled}\n\n${input}`;
    const signal = timeoutSignal(h, services, PROMPT_TIMEOUT);
    let answer: string;
    try {
        answer = await services.complete(PROMPT_SYSTEM, prompt, signal, h.model);
    } catch (e) {
        if (services.signal?.aborted) return { kind: "none" };
        return { kind: "error", message: `${event} prompt hook ${signal.aborted ? `timed out after ${h.timeout ?? PROMPT_TIMEOUT}s` : `failed: ${(e as Error).message}`}` };
    }
    const m = answer.match(/\{[\s\S]*\}/);
    let j: any;
    try {
        j = m ? JSON.parse(m[0]) : undefined;
    } catch {
        // below
    }
    if (!j || typeof j.ok !== "boolean") return { kind: "error", message: `${event} prompt hook gave no {"ok": …} answer: ${answer.trim().slice(0, 200)}` };
    if (j.ok) return { kind: "output" };
    const reason = typeof j.reason === "string" && j.reason.trim() ? j.reason.trim() : `A ${event} prompt hook said no`;
    // A no on these changes nothing (the user answers permission prompts, and a denial already happened).
    if (event === "PermissionRequest" || event === "PermissionDenied") return { kind: "output" };
    if (event === "PreToolUse") return { kind: "output", json: { permissionDecision: "deny", permissionDecisionReason: reason } };
    if ((event === "Stop" || event === "SubagentStop") && j.impossible === true) return { kind: "output" };
    return { kind: "block", reason };
}

/** ${a.b} in the hook's input template, from the event's input. A string that is one placeholder keeps the value's type. */
function substitute(v: unknown, input: Record<string, unknown>): unknown {
    const get = (path: string) => path.split(".").reduce<any>((o, k) => (o && typeof o === "object" ? o[k] : undefined), input);
    if (typeof v === "string") {
        const whole = v.match(/^\$\{([\w.]+)\}$/);
        if (whole) return get(whole[1]!) ?? "";
        return v.replace(/\$\{([\w.]+)\}/g, (_, p) => {
            const x = get(p);
            return x === undefined || x === null ? "" : typeof x === "string" ? x : JSON.stringify(x);
        });
    }
    if (Array.isArray(v)) return v.map((x) => substitute(x, input));
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, substitute(x, input)]));
    return v;
}

async function runMcpTool(h: HookConfig, event: HookEvent, input: Record<string, unknown>, services: HookServices): Promise<HookResult> {
    if (!services.callTool) return { kind: "error", message: `${event} ${hookLabel(h)} skipped: no MCP servers are connected here` };
    const signal = timeoutSignal(h, services, DEFAULT_TIMEOUT);
    try {
        const r = await services.callTool(h.server!, h.tool!, substitute(h.input ?? {}, input) as Record<string, unknown>, signal);
        if (r.isError) return { kind: "error", message: `${event} ${hookLabel(h)} failed: ${r.text.trim().slice(0, 300)}` };
        return readOutput(r.text);
    } catch (e) {
        if (services.signal?.aborted) return { kind: "none" };
        return { kind: "error", message: `${event} ${hookLabel(h)} ${signal.aborted ? `timed out after ${h.timeout ?? DEFAULT_TIMEOUT}s` : `failed: ${(e as Error).message}`}` };
    }
}

/**
 * Run one handler. `input` is the full hook input (hook_event_name and cwd
 * included); hooks see it as the model does, with known keys redacted.
 */
export function runHandler(h: HookConfig, event: HookEvent, input: Record<string, unknown>, cwd: string, services: HookServices = {}, json = redactedJson(input)): Promise<HookResult> {
    switch (h.type ?? "command") {
        case "http":
            return runHttp(h, event, json, services);
        case "prompt":
            return runPrompt(h, event, json, services);
        case "mcp_tool":
            return runMcpTool(h, event, JSON.parse(json), services);
        default:
            return runCommand(h, event, json, cwd, services);
    }
}

const DECISION_RANK = { allow: 1, ask: 2, deny: 3 } as const;

const join = (a: string | undefined, b: string) => (a ? `${a}\n${b}` : b);

/** Fold one handler's result into the event's outcome. */
export function absorb(event: HookEvent, r: HookResult, out: HookOutcome) {
    if (r.kind === "none") return;
    if (r.kind === "error") return void out.errors.push(r.message);
    if (r.kind === "block") {
        out.blocked = join(out.blocked, r.reason);
        return;
    }
    if (r.text !== undefined) {
        if (TEXT_CONTEXT.has(event)) out.additionalContext = join(out.additionalContext, r.text);
        return;
    }
    const j = r.json;
    if (!j) return;
    const spec: Record<string, any> = j.hookSpecificOutput && typeof j.hookSpecificOutput === "object" ? { ...j, ...j.hookSpecificOutput } : j;
    if (j.continue === false) out.stop ??= typeof j.stopReason === "string" && j.stopReason.trim() ? j.stopReason : `Stopped by a ${event} hook`;
    if (typeof j.systemMessage === "string" && j.systemMessage.trim()) out.messages.push(j.systemMessage);
    if (typeof spec.additionalContext === "string" && spec.additionalContext) out.additionalContext = join(out.additionalContext, spec.additionalContext).slice(0, MAX_CONTEXT);
    // Each hook's paths are watched: parallel hooks add to one another's.
    if (Array.isArray(spec.watchPaths)) out.watchPaths = [...new Set([...(out.watchPaths ?? []), ...spec.watchPaths.filter((p: unknown): p is string => typeof p === "string")])];
    if (typeof spec.worktreePath === "string" && spec.worktreePath.trim()) out.worktreePath = spec.worktreePath.trim();
    if (event === "PermissionRequest") {
        const d = spec.decision;
        if (d && typeof d === "object" && (d.behavior === "allow" || d.behavior === "deny")) {
            // A deny from any hook wins over another's allow.
            if (!out.permission || (d.behavior === "deny" && out.permission.behavior === "allow")) {
                out.permission = { behavior: d.behavior, message: typeof d.message === "string" ? d.message : undefined, interrupt: d.interrupt === true };
                if (d.behavior === "allow" && d.updatedInput && typeof d.updatedInput === "object") out.updatedInput = d.updatedInput;
                else if (d.behavior === "deny") delete out.updatedInput;
            }
        }
        return;
    }
    if (event === "PreToolUse") {
        const d: unknown = spec.permissionDecision ?? (j.decision === "block" ? "deny" : j.decision === "approve" ? "allow" : undefined);
        // The strictest answer wins (deny > ask > allow): one hook can't approve what another refused.
        if ((d === "allow" || d === "deny" || d === "ask") && DECISION_RANK[d] > (out.decision ? DECISION_RANK[out.decision] : 0)) {
            out.decision = d;
            out.reason = spec.permissionDecisionReason ?? j.reason;
        }
        if (spec.updatedInput && typeof spec.updatedInput === "object" && !Array.isArray(spec.updatedInput)) out.updatedInput = spec.updatedInput;
        return;
    }
    if (event === "PostToolUse" && typeof spec.updatedToolOutput === "string") out.updatedToolOutput = spec.updatedToolOutput;
    if (j.decision === "block" && BLOCKING_EVENTS.has(event)) out.blocked = join(out.blocked, typeof j.reason === "string" && j.reason.trim() ? j.reason : `Blocked by ${event} hook`);
}

/** The handlers that run for this occurrence, identical ones once. */
export function hooksFor(settings: Settings, event: HookEvent, payload: Record<string, unknown>, cwd: string): HookConfig[] {
    const list = settings.hooks?.[event];
    if (!list?.length) return [];
    const seen = new Set<string>();
    const out: HookConfig[] = [];
    for (const h of list) {
        if (!hookApplies(h, event, payload, cwd)) continue;
        const k = hookKey(h);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push(h);
    }
    return out;
}

export async function runHooks(settings: Settings, event: HookEvent, payload: Record<string, unknown>, cwd: string, opts?: AbortSignal | HookServices): Promise<HookOutcome> {
    const services: HookServices = opts instanceof AbortSignal ? { signal: opts } : (opts ?? {});
    const out: HookOutcome = { errors: [], messages: [] };
    const list = hooksFor(settings, event, payload, cwd);
    if (!list.length) return out;
    const input = { hook_event_name: event, cwd, ...payload };
    const json = redactedJson(input);
    const sync: Promise<HookResult>[] = [];
    for (const h of list) {
        if (isAsync(h)) {
            runInBackground(h, event, input, cwd, services, json);
            continue;
        }
        sync.push(runHandler(h, event, input, cwd, services, json).catch((e) => ({ kind: "error", message: `${event} ${hookLabel(h)} failed: ${(e as Error).message}` }) as HookResult));
    }
    // In config order, so contexts and reasons read as configured.
    for (const r of await Promise.all(sync)) absorb(event, r, out);
    return out;
}

/** A command hook with `async: true`: it runs in the background, whatever the event. */
export function isAsync(h: HookConfig): boolean {
    return Boolean(h.async) && (h.type ?? "command") === "command";
}

/** Run an async hook in the background: it can't block, and what it says reaches `onAsync` (with the next request). */
export function runInBackground(h: HookConfig, event: HookEvent, input: Record<string, unknown>, cwd: string, services: HookServices, json?: string) {
    void runHandler(h, event, input, cwd, { ...services, signal: undefined }, json)
        .catch((e): HookResult => ({ kind: "error", message: `${event} ${hookLabel(h)} failed: ${(e as Error).message}` }))
        .then((r) => {
            const o: HookOutcome = { errors: [], messages: [] };
            absorb(event, r.kind === "block" ? { kind: "output" } : r, o);
            if (o.additionalContext || o.messages.length || o.errors.length) services.onAsync?.(o);
        })
        .catch(() => {});
}

/** Where fireHooks reports: problems as warnings, a hook's systemMessage as info. */
export type HookNotice = (msg: string, level?: "info" | "warn") => void;

/** Run an informational event's hooks for their side effects. Never throws; problems go to `warn`. */
export async function fireHooks(settings: Settings, event: HookEvent, payload: Record<string, unknown>, cwd: string, warn: HookNotice, opts?: AbortSignal | HookServices): Promise<HookOutcome | undefined> {
    if (!settings.hooks?.[event]?.length) return undefined;
    const h = await runHooks(settings, event, payload, cwd, opts).catch((e): HookOutcome => ({ errors: [`${event} hook failed: ${(e as Error).message}`], messages: [] }));
    for (const err of h.errors) warn(err);
    for (const m of h.messages) warn(m, "info");
    return h;
}

/** Fields Claude Code reads from hookSpecificOutput (our flat format has them at the top level). */
const SPECIFIC = ["permissionDecision", "permissionDecisionReason", "updatedInput", "additionalContext", "updatedToolOutput", "worktreePath", "watchPaths", "retry"];

/** A handler's result as Claude Code's hook_callback answer: its JSON output schema. */
export function claudeCodeHookOutput(event: HookEvent, r: HookResult): Record<string, unknown> {
    if (r.kind === "none" || r.kind === "error") return {};
    if (r.kind === "block") {
        if (event === "PreToolUse") return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: r.reason } };
        return { decision: "block", reason: r.reason };
    }
    const j = r.json;
    // Plain text is context where Cavvy takes it as context (Claude Code wants it as JSON).
    if (!j) return r.text?.trim() && TEXT_CONTEXT.has(event) ? { hookSpecificOutput: { hookEventName: event, additionalContext: r.text.trim().slice(0, MAX_CONTEXT) } } : {};
    const out: Record<string, unknown> = {};
    for (const k of ["continue", "stopReason", "systemMessage", "reason"]) if (j[k] !== undefined) out[k] = j[k];
    if (j.decision === "block" || j.decision === "approve") out.decision = j.decision;
    const specific: Record<string, unknown> = {};
    for (const k of SPECIFIC) if (j[k] !== undefined) specific[k] = j[k];
    if (j.hookSpecificOutput && typeof j.hookSpecificOutput === "object") Object.assign(specific, j.hookSpecificOutput);
    delete specific.hookEventName;
    if (Object.keys(specific).length) out.hookSpecificOutput = { hookEventName: event, ...specific };
    return out;
}
