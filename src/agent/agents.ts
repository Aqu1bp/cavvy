// Custom sub-agents: markdown files with frontmatter in
//   ~/.harness/agents/*.md  and  <project>/.harness/agents/*.md
//
//   ---
//   name: reviewer
//   description: Reviews diffs for bugs
//   tools: Read, Grep, Glob, Bash      (optional; default: all but Task)
//   model: anthropic:claude-sonnet-5-5 (optional; default: current model)
//   ---
//   System prompt for the agent...

import { existsSync, readdirSync, readFileSync } from "fs";
import { join } from "path";
import { paths } from "../config/paths";
import { isTrusted } from "../config/trust";

export interface AgentDef {
    name: string;
    description: string;
    tools?: string[];
    model?: string;
    prompt: string;
    source: "user" | "project" | "builtin";
    readOnly?: boolean;
}

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
    const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
    if (!m) return { data: {}, body: text };
    const data: Record<string, string> = {};
    for (const line of m[1]!.split(/\r?\n/)) {
        const kv = line.match(/^([A-Za-z0-9_-]+)\s*:\s*(.*)$/);
        if (kv) data[kv[1]!.toLowerCase()] = kv[2]!.trim().replace(/^["']|["']$/g, "");
    }
    return { data, body: m[2]! };
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

function loadDir(dir: string, source: "user" | "project"): AgentDef[] {
    if (!existsSync(dir)) return [];
    const out: AgentDef[] = [];
    for (const f of readdirSync(dir)) {
        if (!f.endsWith(".md")) continue;
        try {
            const { data, body } = parseFrontmatter(readFileSync(join(dir, f), "utf-8"));
            const name = data.name || f.replace(/\.md$/, "");
            out.push({
                name,
                description: data.description || "",
                tools: data.tools ? data.tools.split(/[,\s]+/).filter(Boolean) : undefined,
                model: data.model || undefined,
                prompt: body.trim(),
                source,
            });
        } catch {
            // skip unreadable files
        }
    }
    return out;
}

export function loadAgents(cwd: string): AgentDef[] {
    const byName = new Map<string, AgentDef>();
    // Project agents only in trusted folders: their prompts and tool lists come from the repository.
    const project = isTrusted(cwd) ? loadDir(paths.projectAgents(cwd), "project") : [];
    for (const a of [...BUILTIN_AGENTS, ...loadDir(paths.userAgents(), "user"), ...project]) byName.set(a.name, a);
    return [...byName.values()];
}
