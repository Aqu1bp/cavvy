// Cavvy's agent definitions (src/agent/agents.ts) in the form Claude
// Code's --agents flag takes, so a session on the Claude Code backend runs
// them with its own Agent tool rather than through Cavvy's delegate
// tool. Agents pinned to another provider's model stay with delegate.

import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { Effort, McpServerConfig, Settings } from "../config/settings";
import { approvalOf, serverCwd } from "../mcp/approval";
import { paths } from "../config/paths";
import { serverSegment } from "../mcp/manager";
import type { PermissionMode } from "../permissions/modes";
import { parseModelRef } from "../providers/types";
import { findSkill, type AgentDef } from "../agent/agents";
import { MCP_SERVER_NAME } from "../agent/delegation";

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
    hooks?: Record<string, { matcher?: string; hooks: ({ type: string } & Record<string, unknown>)[] }[]>;
    mcpServers?: (string | Record<string, Record<string, unknown>>)[];
    background?: boolean;
    isolation?: "worktree";
    memory?: "user" | "project" | "local";
}

/**
 * Claude Code's mode for each Cavvy mode, as for the session (MODES in
 * claude-code.ts): its acceptEdits also runs file commands without asking, so
 * an acceptEdits agent runs in default there, and Cavvy approves its
 * edits with the agent's own mode (its asks name it: Agent.backendPermission).
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
    /** Where Claude Code runs, and so where it starts an agent's stdio servers (it has no cwd for them). */
    cwd: string;
    projectRoot: string;
    settings: Settings;
    /** Gets what was left out of a definition, and why. */
    notes?: string[];
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
    // Cavvy's skills folders aren't Claude Code's: what it finds goes in the prompt, the rest Claude Code looks up.
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
    // Cavvy's own tools (delegate, secrets, schedules) run under the session's mode as it is when they're
    // called, which Claude Code approves without asking: an agent with a mode of its own (a plan agent, while
    // the session is or becomes acceptEdits) doesn't get them.
    const disallowed = [...(def.disallowedTools ?? []), ...(def.permissionMode ? [`mcp__${MCP_SERVER_NAME}`] : [])];
    if (disallowed.length) a.disallowedTools = disallowed;
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

/** Claude Code's nested form; an agent's Stop hooks are its SubagentStop there, as Cavvy reads them. */
function claudeHooks(def: AgentDef): ClaudeAgentDefinition["hooks"] {
    if (!def.hooks) return undefined;
    const out: NonNullable<ClaudeAgentDefinition["hooks"]> = {};
    for (const [event, list] of Object.entries(def.hooks)) {
        if (!list?.length) continue;
        const name = event === "SubagentStop" ? "Stop" : event;
        for (const h of list) {
            // Every handler type as written (http, prompt, mcp_tool too); the matcher is the group's, and a
            // prompt hook's Cavvy model ref ("provider:model") means nothing to Claude Code, so its own is used.
            const { matcher, pluginRoot: _, type, ...rest } = h;
            if (type === "prompt" && typeof rest.model === "string" && rest.model.includes(":")) delete rest.model;
            (out[name] ??= []).push({ ...(matcher ? { matcher } : {}), hooks: [{ type: type ?? "command", ...rest }] });
        }
    }
    return Object.keys(out).length ? out : undefined;
}

/**
 * Names as they are; its own servers only where Claude Code would run what
 * Cavvy would (startAgentServers): no name a configured or .mcp.json
 * server has, a project agent's approved as .mcp.json servers are, and none
 * Claude Code would read differently. It ignores a server's cwd (stdio servers
 * start where it runs) and expands ${VAR}, which an approval doesn't cover.
 */
function claudeServers(def: AgentDef, o: ClaudeAgentsOptions): NonNullable<ClaudeAgentDefinition["mcpServers"]> {
    const out: NonNullable<ClaudeAgentDefinition["mcpServers"]> = [];
    const configured = [...Object.keys(o.settings.mcpServers ?? {}), ...(o.trusted ? projectServers(o.projectRoot) : [])];
    for (const s of def.mcpServers ?? []) {
        const skip = (why: string) => o.notes?.push(`The ${def.name} agent's MCP server "${s.name}" isn't passed to Claude Code: ${why}.`);
        // Cavvy's own server isn't an agent's to name: its tools are approved by their names.
        if (serverSegment(s.name) === serverSegment(MCP_SERVER_NAME)) skip("that name is Cavvy's own server's");
        else if (!s.config) out.push(s.name);
        else if (s.config.disabled) continue;
        else if (configured.some((n) => serverSegment(n) === serverSegment(s.name))) skip("a configured server has that name");
        else if (!s.config.url && !sameFolder(serverCwd(s.config, o.projectRoot), o.cwd)) skip("Claude Code would start it in this folder, not the one it names (it has no cwd for servers)");
        else if (def.source === "project" && expands(s.config)) skip("Claude Code would expand its ${VAR}s, which its approval doesn't cover");
        else if (def.source === "project" && approvalOf(s.name, s.config, o.settings, o.projectRoot, o.trusted).state !== "approved") skip("a project's agent's servers need the approval .mcp.json servers do (/mcp)");
        else out.push({ [s.name]: claudeServer(s.config) });
    }
    return out;
}

/** The project's .mcp.json server names. */
function projectServers(root: string): string[] {
    try {
        const f = JSON.parse(readFileSync(paths.projectMcp(root), "utf-8"));
        return f?.mcpServers && typeof f.mcpServers === "object" ? Object.keys(f.mcpServers) : [];
    } catch {
        return [];
    }
}

function sameFolder(a: string, b: string): boolean {
    try {
        return realpathSync(a) === realpathSync(b);
    } catch {
        return false;
    }
}

const expands = (v: unknown): boolean => (typeof v === "string" ? v.includes("${") : Array.isArray(v) ? v.some(expands) : v && typeof v === "object" ? Object.values(v).some(expands) : false);

function claudeServer(c: McpServerConfig): Record<string, unknown> {
    if (c.url) return { type: "http", url: c.url, ...(c.headers ? { headers: c.headers } : {}) };
    return { type: "stdio", command: c.command, ...(c.args ? { args: c.args } : {}), ...(c.env ? { env: c.env } : {}) };
}

/** Writes them where only this user can read them; `remove` deletes the file. */
export function writeAgentsFile(agents: Record<string, ClaudeAgentDefinition>): { path: string; remove: () => void } {
    const dir = mkdtempSync(join(tmpdir(), "cavvy-agents-"));
    const path = join(dir, "agents.json");
    writeFileSync(path, JSON.stringify(agents), { mode: 0o600 });
    return { path, remove: () => rmSync(dir, { recursive: true, force: true }) };
}
