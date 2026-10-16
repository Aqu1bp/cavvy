// How an MCP server's state reads, in the side panel and the MCP dialog.

import type { McpServerInfo, McpStatus } from "@shared/protocol";

/** As the server's visible(): control, bidi and other invisible characters shown, never rendered. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}   -   　]/gu;

export function shownName(name: string): string {
    const s = name.replace(INVISIBLE, (c) => `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`);
    return s.length > 100 ? s.slice(0, 100) + "…" : s;
}

export function needsAttention(m: McpStatus): boolean {
    return m.status === "failed" || m.status === "needs-approval";
}

export function statusLabel(m: Pick<McpStatus, "status" | "tools" | "approval">): { text: string; tone?: "err" | "warn" | "ok" } {
    switch (m.status) {
        case "connected":
            return { text: `Connected · ${m.tools} ${m.tools === 1 ? "tool" : "tools"}`, tone: "ok" };
        case "failed":
            return { text: "Failed", tone: "err" };
        case "needs-approval":
            return { text: m.approval?.reason === "changed" ? "Changed · needs approval" : "Needs approval", tone: "warn" };
        case "connecting":
        case "pending":
            return { text: "Connecting…" };
        case "disabled":
            return { text: m.approval?.state === "rejected" ? "Rejected" : "Off" };
    }
}

/** Connected servers can carry a warning too (for example, a tool hidden for leaking a secret). */
export function mergeMcpStatus(server: McpServerInfo, live?: McpStatus): McpServerInfo {
    if (!live) return server;
    // Live failures contain only their first line; retain the detail response's full error.
    const error = live.status === "failed" && server.status === "failed" && server.error ? server.error : live.error;
    return { ...server, status: live.status, tools: live.tools, error };
}
