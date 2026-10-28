// Agent backends: which program runs each one.

import { accountEnv } from "../providers/accounts";
import type { ProviderDef } from "../providers/registry";
import type { AgentBackendClient } from "./types";
import { ClaudeCodeBackend, claudeStatus, describeClaudeAuth } from "./claude-code";
import { CodexBackend, codexAccount, codexPlan, describeCodexAuth, type CodexAccount } from "./codex";
import type { PlanLimits } from "../server/protocol";
import { findCli } from "./cli";
import { agentCli } from "./defs";
import { AcpBackend, acpStatus } from "./acp/backend";
import { AgyBackend, agyStatus } from "./agy/backend";

export function createBackend(def: ProviderDef): AgentBackendClient {
    switch (agentCli(def.id)?.protocol) {
        case "claude-stream-json":
            return new ClaudeCodeBackend(def);
        case "codex-app-server":
            return new CodexBackend(def);
        case "acp":
            return new AcpBackend(def);
        case "agy-stream-json":
            return new AgyBackend(def);
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
 * (claude auth status, codex app-server account/read); Cavvy reads no
 * credential files.
 */
export async function checkAgentCli(providerId: string, signal?: AbortSignal, accountId?: string): Promise<AgentCliStatus> {
    return (await checkCli(providerId, signal, accountId, false)).status;
}

/**
 * As checkAgentCli, and for Codex on a ChatGPT plan, where its limits stand
 * (from the same app-server). Claude Code reports its limits only in a turn.
 */
export async function checkAgentPlan(providerId: string, signal?: AbortSignal, accountId?: string): Promise<{ status: AgentCliStatus; limits?: PlanLimits }> {
    return checkCli(providerId, signal, accountId, true);
}

async function checkCli(providerId: string, signal: AbortSignal | undefined, accountId: string | undefined, limits: boolean): Promise<{ status: AgentCliStatus; limits?: PlanLimits }> {
    const def = agentCli(providerId);
    if (!def) throw new Error(`${providerId} isn't an agent CLI`);
    // An ACP agent has its default sign-in only, and no plan limits to report.
    if (def.protocol === "acp") return { status: await acpStatus(providerId, signal) };
    if (def.protocol === "agy-stream-json") return { status: await agyStatus(providerId, signal) };
    accountEnv(providerId, accountId);
    const cli = def.cli;
    const base = { signIn: cli.signIn, signOut: cli.signOut, installHint: cli.install };
    const path = findCli(providerId, cli);
    if (!path) return { status: { ...base, installed: false, signedIn: false, description: "not installed" } };
    if (providerId === "codex") {
        const plan: { account: CodexAccount; limits?: PlanLimits } = limits ? await codexPlan(providerId, signal, accountId) : { account: await codexAccount(providerId, signal, accountId) };
        const a = plan.account;
        return { status: { ...base, installed: true, path, signedIn: Boolean(a.type) || !a.requiresAuth, description: describeCodexAuth(a), apiKey: a.type === "apiKey", email: a.email, plan: a.planType }, limits: plan.limits };
    }
    const s = await claudeStatus(providerId, signal, accountId);
    return { status: { ...base, installed: true, path, signedIn: s.loggedIn, description: describeClaudeAuth(s), apiKey: s.authMethod === "api_key", email: s.email, plan: s.subscriptionType } };
}

/** What a vendor's own sign-in is called, for messages. */
export function vendorOf(providerId: string): string {
    return agentCli(providerId)?.vendor ?? providerId;
}
