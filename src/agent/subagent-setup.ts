// What a sub-agent's definition sets up around it (src/agent/agents.ts): its
// permission mode, the git worktree it works in (isolation: worktree), the
// MCP servers it brings, and the hooks it adds. Agent.runChild uses these.

import { randomBytes } from "crypto";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join, relative } from "path";
import type { Settings } from "../config/settings";
import { trustedByUser } from "../config/trust";
import type { PermissionMode } from "../permissions/modes";
import { McpManager, serverSegment } from "../mcp/manager";
import { approvalOf } from "../mcp/approval";
import { createWorktree, runGitAsync } from "../server/worktrees";
import type { Tool } from "../tools/types";
import { canonical } from "../util/files";
import type { AgentDef, AgentHooks } from "./agents";

// ---------------------------------------------------------------------------
// Permission mode

/**
 * The mode a sub-agent runs in, given the parent's now. Bypass and auto in
 * the parent win (as in Claude Code), and so does plan: a session that's
 * planning changes nothing, whatever its agents say.
 */
export function childMode(parent: PermissionMode, own: PermissionMode | undefined): PermissionMode {
    if (!own || parent === "bypassPermissions" || parent === "auto" || parent === "plan") return parent;
    return own;
}

// ---------------------------------------------------------------------------
// Hooks

/** The session's hooks with the agent's added after them, for that agent only. */
export function withAgentHooks(hooks: Settings["hooks"], own: AgentHooks | undefined): Settings["hooks"] {
    if (!own) return hooks;
    const out: AgentHooks = { ...hooks };
    for (const [event, list] of Object.entries(own) as [keyof AgentHooks, AgentHooks[keyof AgentHooks]][]) out[event] = [...(out[event] ?? []), ...(list ?? [])];
    return out;
}

// ---------------------------------------------------------------------------
// Worktree

export interface AgentWorktree {
    /** Where Git runs to remove it: the checkout it was made from. */
    main: string;
    /** The new worktree's root. */
    path: string;
    branch: string;
    /** The commit it started at. */
    base: string;
    /** Where the agent works in it: the folder matching the parent's. */
    cwd: string;
    projectRoot: string;
}

const GIT_TIMEOUT_MS = 60_000;
const NO_HOOKS = ["-c", "core.hooksPath=/dev/null"];

function slug(name: string): string {
    return (
        name
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "agent"
    );
}

/** A worktree of the repository `cwd` is in, on a new branch from its HEAD, under .claude/worktrees. */
export async function createAgentWorktree(o: { cwd: string; projectRoot: string; agent: string }): Promise<AgentWorktree> {
    const branch = `agent/${slug(o.agent)}-${randomBytes(3).toString("hex")}`;
    const r = await createWorktree({ path: o.cwd, branch });
    const top = (await runGitAsync(o.cwd, ["rev-parse", "--show-toplevel"], GIT_TIMEOUT_MS)).stdout.replace(/\n$/, "");
    // The same folder within the new checkout, so relative paths in its task mean what they meant.
    const inside = (p: string) => {
        const rel = top ? relative(canonical(top), canonical(p)) : "";
        return rel && !rel.startsWith("..") ? join(r.path, rel) : r.path;
    };
    return { main: top || o.cwd, path: r.path, branch: r.branch, base: r.commit, cwd: inside(o.cwd), projectRoot: inside(o.projectRoot) };
}

export interface WorktreeOutcome {
    removed: boolean;
    /** What's in it, when it's kept. */
    changes?: { uncommitted: number; commits: number };
    /** Why it couldn't be checked or removed. */
    error?: string;
}

/**
 * Removed, with its branch, when the agent left nothing in it: no commits
 * since the base and a clean status (ignored files, a build's output, don't
 * count). Otherwise kept, for the user to look at and merge.
 */
export async function finishAgentWorktree(w: AgentWorktree): Promise<WorktreeOutcome> {
    const status = await runGitAsync(w.path, [...NO_HOOKS, "status", "--porcelain=v1", "--untracked-files=normal"], GIT_TIMEOUT_MS);
    const commits = await runGitAsync(w.path, ["rev-list", "--count", `${w.base}..HEAD`], GIT_TIMEOUT_MS);
    if (status.code !== 0 || status.timedOut || commits.code !== 0 || commits.timedOut) return { removed: false, error: "Git couldn't tell whether it has changes, so it was kept." };
    const changes = { uncommitted: status.stdout.split("\n").filter(Boolean).length, commits: Number(commits.stdout.trim()) || 0 };
    if (changes.uncommitted || changes.commits) return { removed: false, changes };
    const removed = await runGitAsync(w.main, [...NO_HOOKS, "worktree", "remove", "--force", w.path], GIT_TIMEOUT_MS);
    if (removed.code !== 0 || removed.timedOut) return { removed: false, changes, error: "Git couldn't remove it." };
    await runGitAsync(w.main, ["branch", "-D", w.branch], GIT_TIMEOUT_MS);
    return { removed: true };
}

/** For the agent's report. */
export function worktreeNote(w: AgentWorktree, o: WorktreeOutcome): string {
    if (o.removed) return "It made no changes, so its worktree was removed.";
    const what = o.changes ? [o.changes.commits ? `${o.changes.commits} commit${o.changes.commits === 1 ? "" : "s"}` : "", o.changes.uncommitted ? `${o.changes.uncommitted} uncommitted change${o.changes.uncommitted === 1 ? "" : "s"}` : ""].filter(Boolean).join(" and ") : "";
    return `It worked in the git worktree ${w.path} on branch ${w.branch}${what ? `, which has ${what}` : ""}. ${o.error ?? "The worktree is kept: review it, then merge the branch or remove the worktree."}`;
}

// ---------------------------------------------------------------------------
// MCP servers

export interface AgentServers {
    /** Its own servers' tools. */
    tools: Tool<any>[];
    /** Configured servers it names: their tools stay available even when its tools list doesn't name them. */
    referenced: string[];
    /** What didn't start, and why. */
    notes: string[];
    instructions: string;
    close(): Promise<void>;
}

/**
 * Start the servers an agent defines itself; they stop with it. One a
 * project's agent defines runs only with the approval a .mcp.json server
 * needs (the same name and configuration approved, or every project server).
 */
export async function startAgentServers(def: AgentDef, o: { projectRoot: string; settings: Settings; has: (name: string) => boolean; signal: AbortSignal }): Promise<AgentServers | undefined> {
    const servers = def.mcpServers ?? [];
    if (!servers.length) return undefined;
    const notes: string[] = [];
    const referenced: string[] = [];
    const own: NonNullable<Settings["mcpServers"]> = {};
    for (const s of servers) {
        if (!s.config) {
            if (o.has(s.name)) referenced.push(s.name);
            else notes.push(`MCP server "${s.name}" isn't configured in this session.`);
            continue;
        }
        if (def.source === "project") {
            const approval = approvalOf(s.name, s.config, o.settings, o.projectRoot, trustedByUser(o.projectRoot));
            if (approval.state !== "approved") {
                notes.push(`MCP server "${s.name}" wasn't started: a server a project's agent defines needs the approval a .mcp.json server does (the same server approved in /mcp, or enableAllProjectMcpServers).`);
                continue;
            }
        }
        own[s.name] = s.config;
    }
    let manager: McpManager | undefined;
    if (Object.keys(own).length) {
        manager = new McpManager(o.projectRoot, () => ({ mcpServers: own }), false);
        await manager.load();
        await manager.startAll(o.signal);
        for (const st of manager.servers.values()) if (st.status !== "connected") notes.push(`MCP server "${st.name}" didn't start${st.error ? `: ${st.error.split("\n")[0]}` : "."}`);
    }
    return {
        tools: manager?.tools() ?? [],
        referenced,
        notes,
        instructions: manager?.instructions() ?? "",
        close: async () => {
            await manager?.closeAll();
        },
    };
}

/** Whether a tool belongs to one of these servers (by its mcp__<server>__ prefix). */
export function fromServers(toolName: string, servers: string[]): boolean {
    return servers.some((s) => toolName.startsWith(`mcp__${serverSegment(s)}__`));
}

// ---------------------------------------------------------------------------
// Memory

/** Local memory stays out of Git: its folder ignores everything in it. */
export function keepLocal(dir: string) {
    try {
        mkdirSync(dir, { recursive: true });
        const ignore = join(dirname(dir), ".gitignore");
        if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
    } catch {
        // It can still be written to; Git may just see it.
    }
}
