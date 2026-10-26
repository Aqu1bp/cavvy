// Custom sub-agents: markdown files with YAML frontmatter in
//   ~/.cavvy/agents/*.md  and  <project>/.cavvy/agents/*.md
//
//   ---
//   name: reviewer
//   description: Reviews diffs for bugs
//   tools: Read, Grep, Glob, Bash      (optional; default: all but Task)
//   disallowedTools: WebFetch          (optional; taken out of what it gets)
//   model: anthropic:claude-sonnet-5-5 (optional; default, or "inherit": current model)
//   permissionMode: acceptEdits        (optional; default: the session's)
//   effort: high                       (optional; default: the session's)
//   maxTurns: 40                       (optional; default 200)
//   isolation: worktree                (optional; works in a git worktree of its own)
//   background: true                   (optional; always runs as a background task)
//   memory: project                    (optional; user | project | local: a MEMORY.md it keeps)
//   skills: [code-review]              (optional; skills preloaded into its prompt)
//   mcpServers:                        (optional; configured servers by name, or its own)
//     - github
//     - scratch: { command: scratch-mcp }
//   hooks:                             (optional; like settings.json's, for this agent only)
//     PreToolUse:
//       - matcher: Bash
//         command: ./check.sh
//   ---
//   System prompt for the agent...
//
// The fields follow Claude Code's sub-agent definitions. A field with a value
// that can't be used is left out, and the agent says why in its `warnings`.

import { existsSync, readdirSync, readFileSync } from "fs";
import { homedir } from "os";
import { basename, join } from "path";
import { APP_NAME, paths, cavvyHome } from "../config/paths";
import { inProjectDir, withCurrentMcpNames } from "../config/legacy";
import { isTrusted } from "../config/trust";
import { loadPlugins } from "../plugins/loader";
import { EFFORT_LEVELS, type Effort, type HookConfig, type McpServerConfig, type Settings } from "../config/settings";
import { PERMISSION_MODES, type PermissionMode } from "../permissions/modes";
import { HOOK_EVENTS, type HookEvent } from "./hooks";
import { normalizeHooks } from "../config/hook-config";
import { parseModelRef } from "../providers/types";
import { gitRoot } from "../util/git";

export type AgentHooks = NonNullable<Settings["hooks"]>;

/** A server the agent uses: one configured for the session (by name), or its own (`config`). */
export interface AgentMcpServer {
    name: string;
    config?: McpServerConfig;
}

export type AgentMemoryScope = "user" | "project" | "local";

export interface AgentDef {
    name: string;
    description: string;
    tools?: string[];
    disallowedTools?: string[];
    model?: string;
    prompt: string;
    source: "user" | "project" | "plugin" | "builtin";
    readOnly?: boolean;
    permissionMode?: PermissionMode;
    effort?: Effort;
    maxTurns?: number;
    isolation?: "worktree";
    skills?: string[];
    hooks?: AgentHooks;
    mcpServers?: AgentMcpServer[];
    background?: boolean;
    memory?: AgentMemoryScope;
    /** The file it's defined in. */
    file?: string;
    /** Fields that were left out, and why. */
    warnings?: string[];
}

/** Model turns a sub-agent gets when its definition doesn't say. */
export const DEFAULT_MAX_TURNS = 200;

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { data: {}, body: text };
    return { data: parseLines(m[1]!), body: m[2]! };
}

function parseLines(front: string): Record<string, string> {
    const data: Record<string, string> = {};
    for (const line of front.split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (kv) data[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
    }
    return data;
}

/**
 * YAML frontmatter, keys lower-cased. Frontmatter that isn't valid YAML (an
 * unquoted "a: b" in a description, as the line-by-line reading allowed) is
 * read line by line as before: `yaml` is false then.
 */
export function parseYamlFrontmatter(text: string): { data: Record<string, unknown>; body: string; yaml: boolean } {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { data: {}, body: text, yaml: true };
    let parsed: unknown;
    try {
        parsed = Bun.YAML.parse(m[1]!);
    } catch {
        return { data: parseLines(m[1]!), body: m[2]!, yaml: false };
    }
    const data: Record<string, unknown> = {};
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) for (const [k, v] of Object.entries(parsed)) data[k.toLowerCase()] = v;
    // An unquoted " #" starts a YAML comment, where the line-by-line reading kept it in free text ("tagged #frontend"): keep it still.
    const lines = parseLines(m[1]!);
    for (const k of ["name", "description"]) {
        const v = data[k];
        const line = lines[k];
        if (typeof v === "string" && line !== undefined && line.startsWith(v) && /^\s+#/.test(line.slice(v.length))) data[k] = line;
    }
    return { data, body: m[2]!, yaml: true };
}

export const BUILTIN_AGENTS: AgentDef[] = [
    {
        name: "general-purpose",
        description: "Multi-step research or implementation with the full tool set",
        prompt: "",
        source: "builtin",
    },
    {
        name: "explore",
        description: "Read-only codebase search and investigation: reads, searches and read-only commands; no edits, tests, builds or scripts",
        prompt: "",
        source: "builtin",
        readOnly: true,
    },
];

const str = (v: unknown): string | undefined => (typeof v === "string" ? v.trim() || undefined : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);

/** "Read, Grep" or a YAML list ("[Read, Grep]" too, as frontmatter read line by line has it). */
function names(v: unknown): string[] | undefined {
    const items = Array.isArray(v)
        ? v.map(str).filter((x): x is string => Boolean(x))
        : (str(v)
              ?.replace(/^\[([\s\S]*)\]$/, "$1")
              .split(/[,\s]+/)
              .map((x) => x.replace(/^["']|["']$/g, ""))
              .filter(Boolean) ?? []);
    return items.length ? items : undefined;
}

function bool(v: unknown): boolean | undefined {
    if (typeof v === "boolean") return v;
    const s = str(v)?.toLowerCase();
    return s === "true" || s === "yes" ? true : s === "false" || s === "no" ? false : undefined;
}

/** Hooks as settings.json has them, or Claude Code's nested form: every handler type, read as settings' are (normalizeHooks). */
function parseHooks(v: unknown, warn: (m: string) => void): AgentHooks | undefined {
    if (!v || typeof v !== "object" || Array.isArray(v)) {
        warn("hooks: expected a map of events to lists of hooks");
        return undefined;
    }
    // A sub-agent's turn ends with SubagentStop, as in Claude Code (its Stop hooks and SubagentStop ones together).
    const raw: Record<string, unknown[]> = {};
    for (const [event, list] of Object.entries(v)) {
        const name = event === "Stop" ? "SubagentStop" : event;
        raw[name] = [...(raw[name] ?? []), ...(Array.isArray(list) ? list : [list])];
    }
    const out = normalizeHooks(raw, warn);
    return out && Object.keys(out).length ? (out as AgentHooks) : undefined;
}

function serverConfig(name: string, v: unknown, warn: (m: string) => void): AgentMcpServer | undefined {
    const c = v as McpServerConfig | undefined;
    if (!c || typeof c !== "object" || Array.isArray(c) || (typeof c.command !== "string" && typeof c.url !== "string")) {
        warn(`mcpServers.${name}: needs a command or a url`);
        return undefined;
    }
    return { name, config: c };
}

/** Names of configured servers, and maps of the agent's own (name: config). */
function parseMcpServers(v: unknown, warn: (m: string) => void): AgentMcpServer[] | undefined {
    const out: AgentMcpServer[] = [];
    const entries = Array.isArray(v) ? v : v && typeof v === "object" ? [v] : names(v) ?? [];
    for (const e of entries) {
        if (typeof e === "string") {
            if (e.trim()) out.push({ name: e.trim() });
        } else if (e && typeof e === "object" && !Array.isArray(e)) {
            for (const [name, config] of Object.entries(e)) {
                const s = serverConfig(name, config, warn);
                if (s) out.push(s);
            }
        } else warn(`mcpServers: can't use ${JSON.stringify(e)}`);
    }
    // The first of a name counts.
    const unique = out.filter((s, i) => out.findIndex((x) => x.name === s.name) === i);
    return unique.length ? unique : undefined;
}

/** An agent definition from its file's text. */
export function parseAgentFile(text: string, fallbackName: string, source: AgentDef["source"], file?: string): AgentDef {
    const { data, body, yaml } = parseYamlFrontmatter(text);
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    const def: AgentDef = { name: str(data.name) || fallbackName, description: str(data.description) ?? "", prompt: body.trim(), source, ...(file ? { file } : {}) };
    if (!yaml && ["hooks", "mcpservers", "skills"].some((k) => k in data)) warn("the frontmatter isn't valid YAML, so it was read line by line: hooks, mcpServers and skills need YAML");

    // Tools of Cavvy's MCP server named as Harness's (mcp__harness__…) still count (legacy.ts).
    const tools = names(data.tools);
    if (tools) def.tools = withCurrentMcpNames(tools, APP_NAME);
    const disallowed = names(data.disallowedtools);
    if (disallowed) def.disallowedTools = withCurrentMcpNames(disallowed, APP_NAME);

    const model = str(data.model);
    if (model && model !== "inherit") {
        if (parseModelRef(model)) def.model = model;
        else warn(`model "${model}" isn't provider:model (e.g. anthropic:claude-sonnet-5-5), so it runs on the session's model`);
    }

    const mode = str(data.permissionmode);
    if (mode) {
        if (!PERMISSION_MODES.includes(mode as PermissionMode)) warn(`permissionMode "${mode}" isn't one of ${PERMISSION_MODES.join(", ")}`);
        // Like defaultMode in project settings: only the user's own files can turn bypass on.
        else if (mode === "bypassPermissions" && source !== "user") warn(`permissionMode bypassPermissions is only honored in your own agents (${paths.userAgents().replace(homedir(), "~")})`);
        else def.permissionMode = mode as PermissionMode;
    }

    const effort = str(data.effort);
    if (effort) {
        if (EFFORT_LEVELS.includes(effort as Effort)) def.effort = effort as Effort;
        else warn(`effort "${effort}" isn't one of ${EFFORT_LEVELS.join(", ")}`);
    }

    if (data.maxturns !== undefined) {
        const n = Number(str(data.maxturns));
        if (Number.isInteger(n) && n > 0) def.maxTurns = n;
        else warn(`maxTurns "${str(data.maxturns) ?? ""}" isn't a positive whole number`);
    }

    const isolation = str(data.isolation);
    if (isolation) {
        if (isolation === "worktree") def.isolation = "worktree";
        else warn(`isolation "${isolation}" isn't supported (only "worktree")`);
    }

    if (data.background !== undefined) {
        const b = bool(data.background);
        if (b === undefined) warn(`background "${str(data.background) ?? ""}" isn't true or false`);
        else if (b) def.background = true;
    }

    const memory = str(data.memory);
    if (memory) {
        if (memory === "user" || memory === "project" || memory === "local") def.memory = memory;
        else warn(`memory "${memory}" isn't one of user, project, local`);
    }

    const skills = names(data.skills);
    if (skills) def.skills = skills;

    // Plugin agents can't bring hooks, servers or a permission mode, as in Claude Code.
    const plugin = source === "plugin";
    if (data.hooks !== undefined && yaml) {
        if (plugin) warn("hooks are ignored in a plugin's agents");
        else {
            const h = parseHooks(data.hooks, warn);
            if (h) def.hooks = h;
        }
    }
    if (data.mcpservers !== undefined && yaml) {
        if (plugin) warn("mcpServers are ignored in a plugin's agents");
        else {
            const s = parseMcpServers(data.mcpservers, warn);
            if (s) def.mcpServers = s;
        }
    }
    if (plugin && def.permissionMode) {
        warn("permissionMode is ignored in a plugin's agents");
        delete def.permissionMode;
    }
    if (warnings.length) def.warnings = warnings;
    return def;
}

/** `prefix`: a plugin's name, which its agents' names start with ("<plugin>:<name>"). `dir` may be one .md file. */
function loadDir(dir: string, source: AgentDef["source"], prefix?: string): AgentDef[] {
    if (!existsSync(dir)) return [];
    const out: AgentDef[] = [];
    const single = prefix !== undefined && dir.endsWith(".md");
    let files: string[];
    try {
        files = single ? [basename(dir)] : readdirSync(dir);
    } catch {
        return []; // not a folder: one bad entry doesn't hide every other agent
    }
    for (const f of files) {
        if (!f.endsWith(".md")) continue;
        try {
            const file = single ? dir : join(dir, f);
            const def = parseAgentFile(readFileSync(file, "utf-8"), f.replace(/\.md$/, ""), source, file);
            if (prefix) def.name = `${prefix}:${def.name}`;
            out.push(def);
        } catch {
            // skip unreadable files
        }
    }
    return out;
}

/** `trusted`: the run's decision about the folder, as loadMemory takes it. Left out, the folder's trust decides. */
export function loadAgents(cwd: string, trusted?: boolean): AgentDef[] {
    const byName = new Map<string, AgentDef>();
    // Project agents only in trusted folders: their prompts and tool lists come from the repository.
    const projectTrusted = trusted ?? isTrusted(cwd);
    const project = projectTrusted ? loadDir(paths.projectAgents(cwd), "project") : [];
    const plugin = loadPlugins(cwd, projectTrusted).flatMap((p) => p.agentPaths.flatMap((d) => loadDir(d, "plugin", p.name)));
    for (const a of [...BUILTIN_AGENTS, ...plugin, ...loadDir(paths.userAgents(), "user"), ...project]) byName.set(a.name, a);
    return [...byName.values()];
}

// ---------------------------------------------------------------------------
// Skills a definition preloads

/**
 * A skill's SKILL.md, by its folder's name: <root>/<name>/SKILL.md in the
 * project's .cavvy/skills and .claude/skills (trusted folders only), then
 * the user's ~/.cavvy/skills and ~/.claude/skills. The body, without
 * its frontmatter.
 */
export function findSkill(name: string, cwd: string, trusted?: boolean): { path: string; body: string } | undefined {
    if (!/^[A-Za-z0-9][\w.:-]*$/.test(name) || name.includes("..")) return undefined;
    const root = gitRoot(cwd) ?? cwd;
    const roots = [...((trusted ?? isTrusted(cwd)) ? [paths.projectSkills(root), join(root, ".claude", "skills")] : []), join(cavvyHome(), "skills"), join(homedir(), ".claude", "skills")];
    for (const r of roots) {
        const path = join(r, name, "SKILL.md");
        try {
            return { path, body: parseFrontmatter(readFileSync(path, "utf-8")).body.trim() };
        } catch {
            // not here
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Memory a definition keeps

/** At most this much of MEMORY.md goes in the prompt, as in Claude Code. */
export const MEMORY_LINES = 200;
export const MEMORY_BYTES = 25_000;

/** Where an agent's memory lives. Project and local memory is in the project's .cavvy/ (or .harness/, inProjectDir). */
export function agentMemoryDir(scope: AgentMemoryScope, name: string, projectRoot: string): string {
    const safe = name.replace(/[^\w.-]+/g, "-").replace(/^\.+/, "") || "agent";
    if (scope === "user") return join(cavvyHome(), "agent-memory", safe);
    return join(inProjectDir(projectRoot, scope === "local" ? "agent-memory-local" : "agent-memory"), safe);
}

/** The first lines of MEMORY.md, and whether there was more. */
export function readAgentMemory(dir: string): { text: string; truncated: boolean } {
    let text = "";
    try {
        text = readFileSync(join(dir, "MEMORY.md"), "utf-8");
    } catch {
        return { text: "", truncated: false };
    }
    const lines = text.split("\n");
    let shown = lines.slice(0, MEMORY_LINES).join("\n");
    if (shown.length > MEMORY_BYTES) shown = shown.slice(0, MEMORY_BYTES);
    return { text: shown.trim(), truncated: shown.length < text.trimEnd().length };
}

/** What the agent is told about its memory. */
export function agentMemoryPrompt(scope: AgentMemoryScope, dir: string, memory: { text: string; truncated: boolean } | undefined): string {
    const where = scope === "user" ? "across all your projects" : scope === "local" ? "for this project, on this machine only (not checked in)" : "for this project (it can be checked in and shared)";
    const lines = [
        "# Your memory",
        `You keep a memory ${where} in ${dir}. Before you start, read what's below. As you work, record what would help you next time: patterns, conventions, file locations, decisions and pitfalls you learned. Keep MEMORY.md short and current (its first ${MEMORY_LINES} lines are loaded); put details in other files in that folder and link them from MEMORY.md. Use Read, Write and Edit for it.`,
    ];
    if (!memory) lines.push("", "(Its contents weren't loaded: this folder isn't trusted.)");
    else if (!memory.text) lines.push("", "MEMORY.md is empty or doesn't exist yet.");
    else lines.push("", "Contents of MEMORY.md:", "", memory.text, ...(memory.truncated ? ["", `(Cut at ${MEMORY_LINES} lines: move details out of MEMORY.md into other files.)`] : []));
    return lines.join("\n");
}
