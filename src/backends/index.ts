// Agent backends: which program runs each one.

import type { ProviderDef } from "../providers/registry";
import type { AgentBackendClient } from "./types";
import { ClaudeCodeBackend, claudeStatus, describeClaudeAuth } from "./claude-code";
import { CodexBackend, codexAccount, describeCodexAuth } from "./codex";
import { CLAUDE_CLI, CODEX_CLI, findCli } from "./cli";

export function createBackend(def: ProviderDef): AgentBackendClient {
    switch (def.id) {
        case "claude-code":
            return new ClaudeCodeBackend(def);
        case "codex":
            return new CodexBackend(def);
        default:
            throw new Error(`No agent backend for ${def.id}`);
    }
}

export interface AgentCliStatus {
    installed: boolean;
    /** Where the CLI is. */
    path?: string;
    signedIn: boolean;
    /** How it's signed in, from the CLI itself. */
    description: string;
    /** Signed in with an API key: usage is billed to that, not a plan. */
    apiKey?: boolean;
    /** CLI-reported identity and plan, for the settings UI only. */
    email?: string;
    plan?: string;
    /** The command that signs it in (the vendor's own flow). */
    signIn: string;
    /** The command that signs it out. */
    signOut: string;
    installHint: string;
}

/**
 * Is the CLI installed, and is it signed in? Both answers come from the CLI
 * (claude auth status, codex app-server account/read); the harness reads no
 * credential files.
 */
export async function checkAgentCli(providerId: string, signal?: AbortSignal, accountId?: string): Promise<AgentCliStatus> {
    const cli = providerId === "codex" ? CODEX_CLI : CLAUDE_CLI;
    const base = { signIn: cli.signIn, signOut: providerId === "codex" ? "codex logout" : "claude auth logout", installHint: cli.install };
    const path = findCli(providerId, cli);
    if (!path) return { ...base, installed: false, signedIn: false, description: "not installed" };
    if (providerId === "codex") {
        const a = await codexAccount(providerId, signal, accountId);
        return { ...base, installed: true, path, signedIn: Boolean(a.type) || !a.requiresAuth, description: describeCodexAuth(a), apiKey: a.type === "apiKey", email: a.email, plan: a.planType };
    }
    const s = await claudeStatus(providerId, signal, accountId);
    return { ...base, installed: true, path, signedIn: s.loggedIn, description: describeClaudeAuth(s), apiKey: s.authMethod === "api_key", email: s.email, plan: s.subscriptionType };
}

/** What a vendor's own sign-in is called, for messages. */
export function vendorOf(providerId: string): string {
    return providerId === "codex" ? "OpenAI" : "Anthropic";
}
