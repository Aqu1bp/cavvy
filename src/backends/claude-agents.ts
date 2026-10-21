// The harness's agent definitions (src/agent/agents.ts) in the form Claude
// Code's --agents flag takes, so a session on the Claude Code backend runs
// them with its own Agent tool rather than through the harness's delegate
// tool. Agents pinned to another provider's model stay with delegate.

import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Effort, McpServerConfig, Settings } from "../config/settings";
import { approvalOf } from "../mcp/approval";
import { serverSegment } from "../mcp/manager";
import type { PermissionMode } from "../permissions/modes";
import { parseModelRef } from "../providers/types";
import { findSkill, type AgentDef } from "../agent/agents";

/** One entry of --agents: the fields Claude Code reads from a sub-agent file, plus its prompt. */
export interface ClaudeAgentDefinition {
    description: string;
    prompt: string;
    tools?: string[];
    disallowedTools?: string[];
    model?: string;
    effort?: Effort;
    permissionMode?: string;
    maxTurns?: number;
    skills?: string[];
    hooks?: Record<string, { matcher?: string; hooks: { type: "command"; command: string; timeout?: number }[] }[]>;
    mcpServers?: (string | Record<string, Record<string, unknown>>)[];
    background?: boolean;
    isolation?: "worktree";
    memory?: "user" | "project" | "local";
}

/**
 * Claude Code's mode for each harness mode, as for the session (MODES in
 * claude-code.ts): its acceptEdits also runs file commands without asking, so
 * an acceptEdits agent runs in default there and the harness approves its edits.
 */
const CLAUDE_MODES: Record<PermissionMode, string> = {
    default: "default",
    acceptEdits: "default",
    plan: "plan",
    auto: "auto",
    bypassPermissions: "bypassPermissions",
};

/** The Claude model an agent's model names, `inherit` when it names none; undefined for another provider's. */
export function claudeModel(model: string | undefined): string | undefined {
    if (!model) return "inherit";
    const ref = parseModelRef(model);
    if (!ref) return "inherit";
    if (ref.provider === "claude-code" || ref.provider === "anthropic") return ref.id === "default" ? "inherit" : ref.id;
    if (ref.provider === "openrouter" && ref.id.startsWith("anthropic/")) return ref.id.slice("anthropic/".length);
    return undefined;
}

export interface ClaudeAgentsOptions {
    /** The session's mode now: plan, auto and bypass win over an agent's own. */
    mode: PermissionMode;
    /** The user trusted the folder: project agents are passed only then. */
    trusted: boolean;
    projectRoot: string;
    settings: Settings;
}

/** The definitions Claude Code runs itself, by name. */
export function claudeAgents(defs: AgentDef[], o: ClaudeAgentsOptions): Record<string, ClaudeAgentDefinition> {
    const out: Record<string, ClaudeAgentDefinition> = {};
    for (const def of defs) {
        // Claude Code has its own general-purpose and Explore agents, and loads plugins' agents with the plugin (--plugin-dir).
        if (def.source === "builtin" || def.source === "plugin" || (def.source === "project" && !o.trusted)) continue;
        const model = claudeModel(def.model);
        if (!model || def.name.startsWith("-")) continue;
        out[def.name] = claudeAgent(def, model, o);
    }
    return out;
}

function claudeAgent(def: AgentDef, model: string, o: ClaudeAgentsOptions): ClaudeAgentDefinition {
    // The harness's skills folders aren't Claude Code's: what it finds goes in the prompt, the rest Claude Code looks up.
    const found: string[] = [];
    const unknown: string[] = [];
    for (const name of def.skills ?? []) {
        const skill = findSkill(name, o.projectRoot);
        if (skill) found.push(`# Skill: ${name}\n\n${skill.body}`);
        else unknown.push(name);
    }
    const a: ClaudeAgentDefinition = {
        description: def.description.trim() || `${def.name} agent`,
        prompt: [def.prompt, ...found].filter(Boolean).join("\n\n"),
        model,
    };
    if (def.tools?.length) a.tools = def.tools;
    if (def.disallowedTools?.length) a.disallowedTools = def.disallowedTools;
    if (def.effort) a.effort = def.effort;
    if (def.permissionMode && !["plan", "auto", "bypassPermissions"].includes(o.mode)) a.permissionMode = CLAUDE_MODES[def.permissionMode];
    if (def.maxTurns) a.maxTurns = def.maxTurns;
    if (unknown.length) a.skills = unknown;
    if (def.background) a.background = true;
    if (def.isolation) a.isolation = def.isolation;
    if (def.memory) a.memory = def.memory;
    const hooks = claudeHooks(def);
    if (hooks) a.hooks = hooks;
    const servers = claudeServers(def, o);
    if (servers.length) a.mcpServers = servers;
    return a;
}

/** Claude Code's nested form; an agent's Stop hooks are its SubagentStop there, as the harness reads them. */
function claudeHooks(def: AgentDef): ClaudeAgentDefinition["hooks"] {
    if (!def.hooks) return undefined;
    const out: NonNullable<ClaudeAgentDefinition["hooks"]> = {};
    for (const [event, list] of Object.entries(def.hooks)) {
        if (!list?.length) continue;
        const name = event === "SubagentStop" ? "Stop" : event;
        for (const h of list) (out[name] ??= []).push({ ...(h.matcher ? { matcher: h.matcher } : {}), hooks: [{ type: "command", command: h.command, ...(h.timeout ? { timeout: h.timeout } : {}) }] });
    }
    return Object.keys(out).length ? out : undefined;
}

/** Names as they are; its own servers with the approval and name rules the harness applies when it runs them. */
function claudeServers(def: AgentDef, o: ClaudeAgentsOptions): NonNullable<ClaudeAgentDefinition["mcpServers"]> {
    const out: NonNullable<ClaudeAgentDefinition["mcpServers"]> = [];
    const configured = Object.keys(o.settings.mcpServers ?? {});
    for (const s of def.mcpServers ?? []) {
        if (!s.config) {
            out.push(s.name);
            continue;
        }
        if (s.config.disabled || configured.some((n) => serverSegment(n) === serverSegment(s.name))) continue;
        if (def.source === "project" && approvalOf(s.name, s.config, o.settings, o.projectRoot, o.trusted).state !== "approved") continue;
        out.push({ [s.name]: claudeServer(s.config) });
    }
    return out;
}

function claudeServer(c: McpServerConfig): Record<string, unknown> {
    if (c.url) return { type: "http", url: c.url, ...(c.headers ? { headers: c.headers } : {}) };
    return { type: "stdio", command: c.command, ...(c.args ? { args: c.args } : {}), ...(c.env ? { env: c.env } : {}) };
}

/** Writes them where only this user can read them; `remove` deletes the file. */
export function writeAgentsFile(agents: Record<string, ClaudeAgentDefinition>): { path: string; remove: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "harness-agents-"));
    const path = join(dir, "agents.json");
    writeFileSync(path, JSON.stringify(agents), { mode: 0o600 });
    return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
