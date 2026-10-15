// User-defined hooks: shell commands run at lifecycle points, configured in
// settings.json under "hooks". Each receives a JSON payload on stdin.
//
//   exit 0  -> continue (stdout may carry a JSON decision, see below)
//   exit 2  -> block; stderr is shown to the model (PreToolUse, PostToolUse,
//              UserPromptSubmit, Stop, SubagentStop). The other events are
//              informational: there exit 2 is reported like any other failure.
//   other   -> non-blocking error, shown to the user
//
// PreToolUse may print {"permissionDecision": "allow"|"deny"|"ask", "reason": "..."}.
// UserPromptSubmit and PostToolUse may print {"additionalContext": "..."} to add context.

import type { HookConfig, Settings } from "../config/settings";
import { childEnv } from "../tools/bash";
import { redactedJson } from "../util/redact";

export type HookEvent = keyof NonNullable<Settings["hooks"]>;

/** In the order /hooks lists them. */
export const HOOK_EVENTS: HookEvent[] = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "PreCompact", "Stop", "SubagentStop", "SessionEnd"];

/** Events whose hooks can block (exit 2). */
export const BLOCKING_EVENTS = new Set<HookEvent>(["PreToolUse", "PostToolUse", "UserPromptSubmit", "Stop", "SubagentStop"]);

export interface HookOutcome {
    blocked?: string;
    decision?: "allow" | "deny" | "ask";
    reason?: string;
    additionalContext?: string;
    errors: string[];
}

const DECISION_RANK = { allow: 1, ask: 2, deny: 3 } as const;

function matches(h: HookConfig, toolName: string | undefined): boolean {
    if (!h.matcher || h.matcher === "*" || toolName === undefined) return true;
    if (h.matcher === toolName) return true;
    try {
        return new RegExp(`^(?:${h.matcher})$`).test(toolName);
    } catch {
        return false;
    }
}

export async function runHooks(settings: Settings, event: HookEvent, payload: Record<string, unknown>, cwd: string, signal?: AbortSignal): Promise<HookOutcome> {
    const list = settings.hooks?.[event] ?? [];
    const out: HookOutcome = { errors: [] };
    const toolName = typeof payload.tool_name === "string" ? payload.tool_name : undefined;
    for (const h of list) {
        if (!matches(h, toolName)) continue;
        const shell = process.env.SHELL && /(ba|z)sh$/.test(process.env.SHELL) ? process.env.SHELL : "/bin/sh";
        let proc;
        try {
            proc = Bun.spawn([shell, "-c", h.command], {
                cwd,
                stdin: "pipe",
                stdout: "pipe",
                stderr: "pipe",
                env: childEnv({ HARNESS_HOOK_EVENT: event, HARNESS_PROJECT_DIR: cwd }),
                timeout: (h.timeout ?? 60) * 1000,
                signal,
            });
        } catch (e) {
            out.errors.push(`${event} hook failed to start: ${(e as Error).message}`);
            continue;
        }
        // Hooks see prompts and tool input as the model does: with known keys redacted.
        // A hook that exits without reading its input (`exit 0`, a bare echo) closes
        // the pipe first: EPIPE just means it didn't want it, and its output still counts.
        // (Bun's stdin is a socket pair on macOS, which says ENOTCONN or ECONNRESET instead.)
        // write() returns a promise when the input doesn't fit in the pipe, so await that too.
        try {
            await proc.stdin.write(redactedJson({ hook_event_name: event, cwd, ...payload }));
            await proc.stdin.end();
        } catch (e) {
            if (!["EPIPE", "ENOTCONN", "ECONNRESET"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
        }
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (code === 2 && BLOCKING_EVENTS.has(event)) {
            out.blocked = stderr.trim() || `Blocked by ${event} hook`;
            return out;
        }
        if (code !== 0) {
            out.errors.push(`${event} hook "${h.command}" exited with ${code}${stderr.trim() ? `: ${stderr.trim().slice(0, 300)}` : ""}`);
            continue;
        }
        const s = stdout.trim();
        if (s.startsWith("{")) {
            try {
                const j = JSON.parse(s) as Record<string, any>;
                const spec = j.hookSpecificOutput ?? j;
                const d: unknown = spec.permissionDecision ?? (j.decision === "block" ? "deny" : j.decision === "approve" ? "allow" : undefined);
                if (typeof spec.additionalContext === "string") out.additionalContext = (out.additionalContext ? out.additionalContext + "\n" : "") + spec.additionalContext;
                // The strictest answer wins (deny > ask > allow): a later
                // hook can't approve what an earlier one refused.
                if ((d === "allow" || d === "deny" || d === "ask") && DECISION_RANK[d] > (out.decision ? DECISION_RANK[out.decision] : 0)) {
                    out.decision = d;
                    out.reason = spec.permissionDecisionReason ?? j.reason;
                    if (d === "deny") return out;
                }
            } catch {
                // plain output
            }
        } else if (s && event === "UserPromptSubmit") {
            out.additionalContext = (out.additionalContext ? out.additionalContext + "\n" : "") + s;
        }
    }
    return out;
}

/** Run an informational event's hooks for their side effects. Never throws; problems go to `warn`. */
export async function fireHooks(settings: Settings, event: HookEvent, payload: Record<string, unknown>, cwd: string, warn: (msg: string) => void, signal?: AbortSignal): Promise<void> {
    if (!settings.hooks?.[event]?.length) return;
    const h = await runHooks(settings, event, payload, cwd, signal).catch((e) => ({ errors: [`${event} hook failed: ${(e as Error).message}`] }));
    for (const err of h.errors) warn(err);
}
