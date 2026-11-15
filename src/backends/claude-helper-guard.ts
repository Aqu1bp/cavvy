// A PreToolUse hook Cavvy installs in every Claude Code it runs (claude-code.ts, claude-live.ts), so a shell command
// that names Cavvy's helper for Mac apps comes to Cavvy whatever Claude Code's mode: in bypass, and for commands Claude
// Code takes for read-only (`ls`), it would otherwise run them without asking. Cavvy's checker then has the person
// answer (src/permissions/checker.ts, namesDesktopHelper), and the hook gives Claude Code that answer: allow or deny.

import { namesDesktopHelper } from "../permissions/checker";

export const HELPER_GUARD_ID = "cavvy_helper_guard";

/**
 * Its registration: Claude Code's shell tools, with the longest wait it may take (the person may be away), since a
 * hook that times out lets the command go on.
 */
export const HELPER_GUARD = { matcher: "Bash|Monitor", hookCallbackIds: [HELPER_GUARD_ID], timeout: 7 * 24 * 3600 };

/** Cavvy's hooks for Claude Code's initialize, with the guard added to its PreToolUse ones. */
export function withHelperGuard(hooks: Record<string, { matcher?: string; hookCallbackIds: string[]; timeout?: number }[]> | undefined) {
    return { hooks: { ...hooks, PreToolUse: [...(hooks?.PreToolUse ?? []), HELPER_GUARD] } };
}

/**
 * The guard's answer for one call: nothing for a command that doesn't name the helper, else the person's, asked
 * through `ask` (the CLI session's permission request, which Cavvy's checker decides).
 */
export async function helperGuard(input: Record<string, unknown>, ask: (command: { toolName: string; input: Record<string, unknown>; callId?: string }) => Promise<{ allow: boolean; message?: string }>): Promise<Record<string, unknown>> {
    const toolInput = input.tool_input && typeof input.tool_input === "object" ? (input.tool_input as Record<string, unknown>) : {};
    const command = typeof toolInput.command === "string" ? toolInput.command : "";
    if (!namesDesktopHelper(command)) return {};
    const a = await ask({ toolName: "Bash", input: toolInput, callId: typeof input.tool_use_id === "string" ? input.tool_use_id : undefined }).catch((e: Error) => ({ allow: false, message: e.message }));
    return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: a.allow ? "allow" : "deny", permissionDecisionReason: a.allow ? "The user allowed it." : (a.message ?? "The user declined it.") } };
}
