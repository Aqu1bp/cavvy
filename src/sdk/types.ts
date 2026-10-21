// The SDK's options and callbacks. Type-only: importing it costs nothing.

import type { Effort, Settings } from "../config/settings";
import type { PermissionMode } from "../permissions/modes";
import type { SdkTool } from "./tool";

export type { Effort, PermissionMode, Settings };

/** A message for a streaming query: plain text, or the SDK's user-message shape. */
export type SDKUserMessage = string | { type: "user"; content: string };

export interface CanUseToolContext {
    /** Ends when the answer no longer matters (the turn was interrupted, the query closed). */
    signal: AbortSignal;
    /** How the call reads in the transcript: `Bash(npm test)`, `Edit(src/a.ts)`. */
    title: string;
    /** Why it needs approval, when the permission check said (outside the workspace, a credentials file). */
    reason?: string;
    /** Permission rules that would allow calls like this one, to pass back as `rules`. */
    suggestions: string[];
    /** The tool call's id, matching `tool_call` blocks and `tool_result` messages. */
    toolUseId?: string;
    /** Set when a sub-agent asks. */
    agent?: string;
}

export type PermissionResult =
    /** `rules`: allow calls they match for the rest of the query, without asking again. */
    | { behavior: "allow"; rules?: string[] }
    /**
     * With a `message`, the model is told it and carries on. Without one, the
     * turn stops there, as when a user declines in the terminal.
     */
    | { behavior: "deny"; message?: string };

/**
 * Answers the calls that would otherwise prompt the user. Calls that rules or
 * the permission mode decide never reach it. A rejection or throw denies the
 * call (the error is reported as a notice).
 */
export type CanUseTool = (toolName: string, input: Record<string, unknown>, context: CanUseToolContext) => Promise<PermissionResult> | PermissionResult;

export interface Options {
    /** The project folder. Default: process.cwd(). */
    cwd?: string;
    /** "provider:model", e.g. "anthropic:claude-opus-5-5". Default: as the CLI (settings, then the first model with a key). */
    model?: string;
    /** Default: settings' defaultMode (bypassPermissions only from user settings), else "default". */
    permissionMode?: PermissionMode;
    /** Permission rules that allow without asking, as --allowedTools: "Bash(npm test:*)", "Edit". */
    allowedTools?: string[];
    /** Permission rules that always deny, as --disallowedTools. They beat everything else. */
    disallowedTools?: string[];
    /** More folders the agent may read and edit, as --add-dir. */
    additionalDirectories?: string[];
    /** Without it, calls that need approval are denied, as in `harness -p`. */
    canUseTool?: CanUseTool;
    /** Tools of your own, made with tool(). Not offered to agent backends (Claude Code, Codex). */
    tools?: SdkTool[];
    /** Most model responses in one turn. */
    maxTurns?: number;
    /** Added to the system prompt on every request (not stored in the session). */
    appendSystemPrompt?: string;
    effort?: Effort;
    fastMode?: boolean;
    /** A session id (or the start of one) in `cwd` to continue. */
    resume?: string;
    /** Continue the latest session in `cwd` (ignored with `resume`). */
    continue?: boolean;
    /**
     * Save the session like the CLI does, so `harness -r <id>` opens it. Default true. False with
     * `resume`: an unsaved copy, nothing written to the original; agent CLIs fork their own session.
     */
    persistSession?: boolean;
    /**
     * Load the project's own settings, .mcp.json, memory files, agents and
     * skills. True trusts the folder until the process exits (not saved), as
     * the trust prompt's yes does, so agent CLIs get the project's own
     * configuration too. False keeps it all out, even in a folder the user
     * trusted, and a resumed session goes without the memory files frozen into
     * its prompt. Default: as `harness -p`, true for folders the user trusted
     * and, for this query only, for folders without project configuration.
     */
    trusted?: boolean;
    /** Settings over those loaded from disk: hooks, mcpServers, env, permissions, … Rule lists add up. */
    settings?: Settings;
    /** Aborting it ends the query; a turn that was running reports `error_aborted`. */
    abortController?: AbortController;
    /** Also yield `stream_event` messages with text as it streams in. */
    includePartialMessages?: boolean;
}

export interface QueryParams {
    /**
     * One turn, or a conversation: each message is a turn, taken in order once
     * the turn before it ends. To add to the running turn, use Query.steer().
     */
    prompt: string | AsyncIterable<SDKUserMessage>;
    options?: Options;
}
