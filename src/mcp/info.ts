// What a client is shown about an MCP server: the GUI's list and approval
// card, and the terminal's /mcp. Plain types only (the GUI imports this
// through src/server/protocol.ts). Nothing here carries an env or header
// value: only their names.

export type McpServerStatus = "pending" | "connecting" | "connected" | "failed" | "disabled" | "needs-approval" | "needs-auth";

/**
 * Where a project server stands with the user. `reason` says why one asks:
 * it's new, what it runs changed since it was approved, or it was approved
 * by name only, before approvals were bound to what a server runs.
 */
export interface McpApprovalInfo {
    state: "approved" | "needs-approval" | "rejected";
    reason?: "new" | "changed" | "legacy";
    /** Approved by enableAllProjectMcpServers rather than one by one. */
    viaAll?: boolean;
}

export interface McpServerInfo {
    name: string;
    /** The name as shown: invisible characters made visible, and capped. */
    label: string;
    source: "settings" | "project";
    status: McpServerStatus;
    tools: number;
    /** Resources (and templates) and prompts it offers, when connected and it offers any. */
    resources?: number;
    prompts?: number;
    /** OAuth tokens are stored for it (it can be signed out of). */
    signedIn?: boolean;
    error?: string;
    transport: "stdio" | "http" | "sse" | "ws";
    command?: string;
    args?: string[];
    /** The folder it runs in, resolved the way it will be when it starts. */
    cwd?: string;
    envNames?: string[];
    url?: string;
    headerNames?: string[];
    /** The .mcp.json it comes from (project servers). */
    declaredIn?: string;
    approval?: McpApprovalInfo;
    /** Why it asks again, in words (it changed, or it was approved by name only). */
    why?: string;
    /** Set to "disabled" in .mcp.json itself: it can't be started from here. */
    disabledInFile?: boolean;
    /** What the approve call must carry: the configuration this description shows. */
    fingerprint?: string;
    /** Something shown was a secret, and is masked. */
    masked?: boolean;
    /** Control, bidi or other invisible characters are shown as ⟨U+XXXX⟩. */
    hidden?: boolean;
    /** What was cut to keep this bounded, in words. */
    cut?: string[];
    /** Only the summary was sent (the list was over its size budget); ask for this server by name for the rest. */
    partial?: boolean;
}

export interface McpListInfo {
    servers: McpServerInfo[];
    /** Servers left out of the list (over its cap). */
    omitted: number;
    /** Project servers are read from .mcp.json only in a trusted folder. */
    trusted: boolean;
    /** Trusted by the user, not only for having had nothing to protect when it was opened: approving needs this. */
    userTrusted: boolean;
    /** Where approvals are saved: this folder's local settings. */
    savedIn: string;
    /** What approving means for the session's provider. */
    meaning: string;
}
