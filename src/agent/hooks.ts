// User-defined hooks: shell commands run at lifecycle points, configured in
// settings.json under "hooks". Each receives a JSON payload on stdin.
//
//   exit 0  -> continue (stdout may carry a JSON decision, see below)
//   exit 2  -> block; stderr is shown to the model (PreToolUse/UserPromptSubmit)
//   other   -> non-blocking error, shown to the user
//
// PreToolUse may print {"permissionDecision": "allow"|"deny"|"ask", "reason": "..."}.
// UserPromptSubmit may print {"additionalContext": "..."} to add context.

import type { HookConfig, Settings } from "../config/settings";
import { childEnv } from "../tools/bash";
import { redactedJson } from "../util/redact";

export type HookEvent = "PreToolUse" | "PostToolUse" | "UserPromptSubmit" | "Stop";

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
        proc.stdin.write(redactedJson({ hook_event_name: event, cwd, ...payload }));
        await proc.stdin.end();
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (code === 2) {
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
