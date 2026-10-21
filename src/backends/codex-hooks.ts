/**
 * The harness's PreToolUse hooks as one of Codex's own hooks (Codex 0.160 and
 * later). Codex calls a tool on the harness's MCP server before every tool
 * call, in every mode, and the harness runs its handlers there, as Claude
 * Code's hook_callback does. Codex only runs hooks it trusts, so the hook
 * goes in with its trust (the hash Codex computes for it), and hooks/list
 * confirms Codex took it before the turn counts on it.
 */
import { createHash } from "crypto";
import { isAbsolute, resolve } from "path";

/** The MCP server Codex calls for the harness's hooks, beside the delegation one. Its one tool is hidden from the model. */
export const CODEX_HOOK_SERVER = "harness_hooks";
export const CODEX_HOOK_TOOL = "pre_tool_use";

/** What Codex passes to the tool: placeholders it fills in from its PreToolUse input. */
const HOOK_INPUT = { tool_name: "${tool_name}", tool_input: "${tool_input}", tool_use_id: "${tool_use_id}" };
const HANDLER = { type: "mcp_tool", server: CODEX_HOOK_SERVER, tool: CODEX_HOOK_TOOL, input: HOOK_INPUT };
/** Codex's own default, which its trust hash includes. */
const TIMEOUT_SEC = 600;

/** The key Codex keeps the hook's state under: hooks given with -c come from a "session flags" layer of its own. */
const HOOK_KEY = `${process.platform === "win32" ? "C:\\" : "/"}<session-flags>/config.toml:pre_tool_use:0:0`;

const sorted = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(sorted) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sorted((v as Record<string, unknown>)[k])])) : v;

/** The hash Codex trusts a hook by: sha256 of its normalized config as sorted JSON. */
export function codexHookHash(event: string, group: { matcher?: string; hooks: Record<string, unknown>[] }): string {
    return `sha256:${createHash("sha256")
        .update(JSON.stringify(sorted({ event_name: event, ...group })))
        .digest("hex")}`;
}

const toml = (v: unknown): string =>
    Array.isArray(v) ? `[${v.map(toml).join(",")}]` : v && typeof v === "object" ? `{${Object.entries(v).map(([k, x]) => `${JSON.stringify(k)}=${toml(x)}`).join(",")}}` : JSON.stringify(v);

/** The app-server arguments that add the hook, trusted. Nothing secret: the server's address and token go in the thread's config. */
export function codexHookArgs(): string[] {
    const hash = codexHookHash("pre_tool_use", { hooks: [{ ...HANDLER, timeout: TIMEOUT_SEC }] });
    return ["-c", `hooks=${toml({ PreToolUse: [{ hooks: [HANDLER] }], state: { [HOOK_KEY]: { trusted_hash: hash } } })}`];
}

/** hooks/list says Codex has the hook, trusted and on. Anything else (an older Codex, another hash) and the turn asks about every command instead. */
export function codexHookTaken(list: any): boolean {
    const hooks: any[] = Array.isArray(list?.data) ? list.data.flatMap((e: any) => (Array.isArray(e?.hooks) ? e.hooks : [])) : [];
    return hooks.some((h) => h?.handlerType === "mcpTool" && h.server === CODEX_HOOK_SERVER && h.tool === CODEX_HOOK_TOOL && h.trustStatus === "trusted" && h.enabled !== false);
}

/** A run of the hook that failed (the server wasn't reached): Codex goes on with the call, so the turn must not. */
export function codexHookFailed(p: any): boolean {
    const run = p?.run;
    return run?.eventName === "preToolUse" && run.handlerType === "mcpTool" && run.source === "sessionFlags" && run.status === "failed";
}

export interface NativeCall {
    /** The harness's name for it, which its matchers and rules use. */
    toolName: string;
    input: Record<string, unknown>;
    /** Codex's input can't be rebuilt from a rewrite in the harness's shape (a patch). */
    rewritable: boolean;
}

/**
 * Codex's tool call as the harness names it: Bash as is, apply_patch as Write
 * (only new files) or Edit with the first file it touches, spawn_agent as
 * Task, MCP tools as mcp__server__tool. Codex's other tools keep their names.
 */
export function nativeCall(toolName: string, input: unknown, cwd: string): NativeCall {
    const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
    if (toolName === "apply_patch") {
        const patch = String(raw.command ?? "");
        const files = [...patch.matchAll(/^\*\*\* (Add|Update|Delete) File: (.+)$/gm)].map((m) => ({ kind: m[1]!, path: m[2]!.trim() }));
        const first = files[0]?.path;
        return {
            toolName: files.length && files.every((f) => f.kind === "Add") ? "Write" : "Edit",
            input: { file_path: first ? (isAbsolute(first) ? first : resolve(cwd, first)) : "", patch },
            rewritable: false,
        };
    }
    if (toolName === "spawn_agent") return { toolName: "Task", input: raw, rewritable: false };
    return { toolName, input: raw, rewritable: true };
}

/** Codex's PreToolUse answer: a deny with its reason, a rewrite, or nothing (and context for the model with any of them). */
export function preToolUseAnswer(a: { deny?: string; updatedInput?: Record<string, unknown>; context?: string }): string {
    const out: Record<string, unknown> = { hookEventName: "PreToolUse" };
    if (a.deny !== undefined) Object.assign(out, { permissionDecision: "deny", permissionDecisionReason: a.deny });
    else if (a.updatedInput) Object.assign(out, { permissionDecision: "allow", updatedInput: a.updatedInput });
    if (a.context) out.additionalContext = a.context;
    return Object.keys(out).length > 1 ? JSON.stringify({ hookSpecificOutput: out }) : "";
}
