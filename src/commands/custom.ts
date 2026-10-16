// Custom slash commands: markdown files in
//   ~/.harness/commands/<name>.md       -> /<name>        (user)
//   <project>/.harness/commands/<name>.md -> /<name>      (project, trusted folders only)
// Subdirectories namespace the command: commands/git/pr.md -> /git:pr
//
//   ---
//   description: Open a PR for the current branch
//   argument-hint: [base-branch]
//   ---
//   Create a pull request against $1 (default main). Extra notes: $ARGUMENTS
//
// The body is sent as the prompt with $ARGUMENTS / $1..$9 substituted.
// @path mentions in the body attach files like they do in normal prompts.

import { existsSync, readdirSync, readFileSync, statSync } from "fs";
import { join, relative } from "path";
import { paths } from "../config/paths";
import { parseFrontmatter } from "../agent/agents";

export interface CustomCommand {
    name: string;
    description: string;
    argumentHint?: string;
    body: string;
    source: "user" | "project";
    file: string;
}

function scan(dir: string, source: "user" | "project", out: Map<string, CustomCommand>) {
    if (!existsSync(dir)) return;
    const walk = (d: string, depth: number) => {
        if (depth > 3) return;
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else if (e.name.endsWith(".md")) {
                try {
                    if (statSync(p).size > 100_000) continue;
                    const { data, body } = parseFrontmatter(readFileSync(p, "utf-8"));
                    const name = relative(dir, p).replace(/\.md$/, "").split("/").join(":").toLowerCase();
                    if (!/^[a-z0-9][a-z0-9:_-]*$/.test(name)) continue;
                    out.set(name, {
                        name,
                        description: data.description || body.trim().split("\n")[0]!.slice(0, 80),
                        argumentHint: data["argument-hint"] || undefined,
                        body: body.trim(),
                        source,
                        file: p,
                    });
                } catch {
                    // skip unreadable command files
                }
            }
        }
    };
    walk(dir, 0);
}

export function loadCustomCommands(cwd: string, trusted: boolean): CustomCommand[] {
    const out = new Map<string, CustomCommand>();
    scan(paths.userCommands(), "user", out);
    // Project commands override user ones with the same name.
    if (trusted) scan(paths.projectCommands(cwd), "project", out);
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Substitute $ARGUMENTS and positional $1..$9 (shell-like word splitting with quotes). */
export function expandCommand(body: string, args: string): string {
    const words: string[] = [];
    for (const m of args.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) words.push(m[1] ?? m[2] ?? m[3] ?? "");
    // One pass with a replacer function: `$&`/`$$` in the arguments stay literal,
    // and a `$1` inside the inserted arguments isn't expanded again.
    let text = body.replace(/\$ARGUMENTS\b|\$([1-9])\b/g, (_, n?: string) => (n ? (words[Number(n) - 1] ?? "") : args));
    if (args && !/\$ARGUMENTS\b|\$[1-9]\b/.test(body)) text += `\n\nArguments: ${args}`;
    return text;
}

/**
 * The command a message starts with: "/review 12" is review, but "//x" and a
 * path ("/Users/me/app.ts fails to build") are messages, not commands.
 */
export function slashCommand(text: string): { name: string; args: string } | undefined {
    const t = text.trim();
    if (!t.startsWith("/") || t.startsWith("//")) return undefined;
    const [, name = "", args = ""] = t.match(/^\/(\S+)\s*([\s\S]*)$/) ?? [];
    if (!name || name.includes("/") || name.includes(".")) return undefined;
    return { name: name.toLowerCase(), args: args.trim() };
}

/**
 * The command names an agent CLI lists as its own (Claude Code's system/init
 * slash_commands: its built-ins, skills and plugins), bounded and checked like
 * custom commands' names.
 */
export function cliCommandNames(v: unknown): string[] | undefined {
    if (!Array.isArray(v)) return undefined;
    return v
        .slice(0, 1000)
        .filter((n): n is string => typeof n === "string" && n.length <= 100)
        .map((n) => n.replace(/^\//, "").toLowerCase())
        .filter((n) => /^[a-z0-9_][a-z0-9:_-]*$/.test(n));
}
