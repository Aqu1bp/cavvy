// Permission rule syntax (compatible in spirit with Claude Code):
//   Bash                     any command
//   Bash(npm test)           exact command
//   Bash(npm run test:*)     prefix match
//   Bash(git * main)         glob over the command string
//   Read(src/**)  Edit(./docs/**)  Edit(~/notes/**)  Read(//etc/hosts)
//   WebFetch(domain:example.com)
//   mcp__github   mcp__github__create_issue   mcp__github__*
//   Task(explore)

import { isAbsolute, join } from "path";
import { homedir } from "os";
import { analyzeCommand, effectiveArgv, onlySafeAssignments, substitutionBodies } from "./bash-safety";
import { canonical, isInside } from "../util/files";

/** macOS and Windows filesystems are case-insensitive by default. */
const CASE_INSENSITIVE_FS = process.platform === "darwin" || process.platform === "win32";

export interface ParsedRule {
    tool: string;
    spec?: string;
    raw: string;
}

export function parseRule(raw: string): ParsedRule {
    const s = raw.trim();
    const m = s.match(/^([A-Za-z0-9_*-]+)(?:\((.*)\))?$/s);
    if (!m) return { tool: s, raw: s };
    return { tool: m[1]!, spec: m[2]?.trim() || undefined, raw: s };
}

export const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
export const READ_TOOLS = new Set(["Read", "Glob", "Grep", "LS"]);

/**
 * The input field each file tool acts on. Checks must read the same field the
 * tool does: inputs can carry extra keys, so a decoy `file_path` next to a
 * Grep's real `path` must not be what gets checked.
 */
const PATH_FIELD: Record<string, string> = {
    Read: "file_path",
    Write: "file_path",
    Edit: "file_path",
    MultiEdit: "file_path",
    NotebookEdit: "notebook_path",
    Glob: "path",
    Grep: "path",
    LS: "path",
};

export function toolPath(toolName: string, input: unknown): string | undefined {
    const field = PATH_FIELD[toolName];
    const v = field ? (input as Record<string, unknown> | undefined)?.[field] : undefined;
    return typeof v === "string" ? v : undefined;
}

function globToRegex(glob: string): RegExp {
    let re = "";
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c === "*") {
            if (glob[i + 1] === "*") {
                // ** matches across directories; **/ also matches zero dirs
                if (glob[i + 2] === "/") {
                    re += "(?:.*/)?";
                    i += 2;
                } else {
                    re += ".*";
                    i++;
                }
            } else re += "[^/]*";
        } else if (c === "?") re += "[^/]";
        else if ("\\^$+.()|{}[]".includes(c)) re += "\\" + c;
        else re += c;
    }
    return new RegExp(`^${re}$`);
}

/** Resolve a path pattern relative to the project root (gitignore-ish anchoring). */
export function pathPattern(spec: string, root: string): string {
    if (spec.startsWith("//")) return spec.slice(1);
    if (spec.startsWith("~/")) return join(homedir(), spec.slice(2));
    if (spec.startsWith("/")) return join(root, spec.slice(1));
    if (spec.startsWith("./")) return join(root, spec.slice(2));
    if (isAbsolute(spec)) return spec;
    // bare pattern like "*.env" or "src/**": anchored at root, but a pattern
    // without a slash matches at any depth.
    return spec.includes("/") ? join(root, spec) : join(root, "**", spec);
}

/** The pattern with symlinks in its literal leading directories resolved (/tmp -> /private/tmp). */
function resolvedPattern(pat: string): string {
    const segs = pat.split("/");
    const first = segs.findIndex((s) => /[*?]/.test(s));
    const lit = (first < 0 ? segs : segs.slice(0, first)).join("/");
    if (!lit) return pat;
    const c = canonical(lit);
    return c === lit ? pat : [c, ...(first < 0 ? [] : segs.slice(first))].join("/");
}

/**
 * Deny/ask rules (`strict` false) are matched generously: case-insensitively
 * on case-insensitive filesystems, where `.ENV` and `.env` are the same file,
 * and also with symlinks in the rule's own path resolved. Allow rules stay exact.
 */
export function matchPath(spec: string, absPath: string, root: string, generous = false): boolean {
    const raw = pathPattern(spec, root);
    const pats = generous ? [...new Set([raw, resolvedPattern(raw)])] : [raw];
    return pats.some((pat) => {
        let target = absPath;
        if (generous && CASE_INSENSITIVE_FS) {
            pat = pat.toLowerCase();
            target = target.toLowerCase();
        }
        if (globToRegex(pat).test(target)) return true;
        // "dir/" or "dir" should cover everything under it (at any depth for a bare name).
        if (/[*?]/.test(spec)) return false;
        const dir = pat.replace(/\/+$/, "");
        return globToRegex(dir).test(target) || globToRegex(dir + "/**").test(target);
    });
}

function matchCommandSpec(spec: string, command: string): boolean {
    const cmd = command.trim();
    if (spec.endsWith(":*")) {
        const prefix = spec.slice(0, -2).trim();
        return cmd === prefix || cmd.startsWith(prefix + " ") || cmd.startsWith(prefix + "\t");
    }
    if (spec.includes("*")) {
        const re = new RegExp("^" + spec.split("*").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
        return re.test(cmd);
    }
    return cmd === spec;
}

/**
 * Bash rules must match every simple command in a compound command, so
 * `Bash(npm test:*)` doesn't approve `npm test && rm -rf ~`.
 */
export function bashRuleMatches(spec: string | undefined, command: string, mode: "allow" | "deny"): boolean {
    if (!spec) return true;
    const a = analyzeCommand(command);
    if (!a.commands.length) return false;
    if (mode === "deny") return denyMatches(spec, command, 0);
    // A prefix rule must not approve whatever hides in $(...) or backticks:
    // `Bash(npm test:*)` vs `npm test $(rm -rf src)`. Only an exact rule can.
    if (a.hasSubstitution || a.unparsable || a.unsafeExpansion) return !spec.includes("*") && command.trim() === spec;
    // `GIT_EXTERNAL_DIFF=cmd git diff` is not the `git diff` the user allowed.
    if (!a.commands.every((c) => onlySafeAssignments(c.argv))) return false;
    return a.commands.every((c) => matchCommandSpec(spec, effectiveArgv(c.argv).join(" ")));
}

/**
 * Deny if ANY part matches: the whole string, each simple command (also with
 * a path-qualified program reduced to its name, so `/bin/rm` hits `rm`), and
 * recursively the bodies of substitutions and `sh -c` / `eval` strings.
 */
function denyMatches(spec: string, command: string, depth: number): boolean {
    if (matchCommandSpec(spec, command)) return true;
    for (const c of analyzeCommand(command).commands) {
        const argv = effectiveArgv(c.argv);
        if (!argv.length) continue;
        const base = argv[0]!.split("/").pop()!;
        if (matchCommandSpec(spec, argv.join(" ")) || matchCommandSpec(spec, [base, ...argv.slice(1)].join(" "))) return true;
        if (depth < 4) {
            const ci = argv.findIndex((x) => /^-[a-zA-Z]*c$/.test(x));
            if (["sh", "bash", "zsh", "dash", "ksh"].includes(base) && ci > 0 && argv[ci + 1] !== undefined && denyMatches(spec, argv[ci + 1]!, depth + 1)) return true;
            if (base === "eval" && argv.length > 1 && denyMatches(spec, argv.slice(1).join(" "), depth + 1)) return true;
        }
    }
    if (depth < 4) for (const body of substitutionBodies(command)) if (denyMatches(spec, body, depth + 1)) return true;
    return false;
}

export interface RuleTarget {
    toolName: string;
    command?: string;
    path?: string;
    url?: string;
    agentType?: string;
}

/**
 * MCP names: `mcp__server` and `mcp__server__*` match all of that server's
 * tools; anything naming a tool (`mcp__server__tool`) matches only that tool,
 * not `mcp__server__tool__delete`. Server segments never contain "__".
 */
export function mcpToolMatches(pattern: string, toolName: string): boolean {
    if (!pattern.startsWith("mcp__") || !toolName.startsWith("mcp__")) return false;
    if (pattern === toolName) return true;
    const p = pattern.slice(5);
    const server = p.endsWith("__*") ? p.slice(0, -3) : p;
    if (!server || server.includes("__")) return false;
    return toolName.startsWith(`mcp__${server}__`);
}

export function ruleMatches(rule: ParsedRule, t: RuleTarget, root: string, mode: "allow" | "deny"): boolean {
    const tool = rule.tool;
    if (tool.startsWith("mcp__")) return mcpToolMatches(tool, t.toolName);
    const toolMatches =
        tool === "*" ||
        tool === t.toolName ||
        (tool === "Edit" && EDIT_TOOLS.has(t.toolName)) ||
        (tool === "Read" && READ_TOOLS.has(t.toolName));
    if (!toolMatches) return false;
    if (!rule.spec) return true;
    if (t.toolName === "Bash") return t.command !== undefined && bashRuleMatches(rule.spec, t.command, mode);
    if (EDIT_TOOLS.has(t.toolName) || READ_TOOLS.has(t.toolName)) return t.path !== undefined && matchPath(rule.spec, t.path, root, mode === "deny");
    if (t.toolName === "WebFetch") {
        if (!t.url) return false;
        const m = rule.spec.match(/^domain:(.+)$/);
        if (!m) return false;
        try {
            const host = new URL(t.url).hostname.toLowerCase();
            const d = m[1]!.toLowerCase();
            return host === d || host.endsWith("." + d) || (d.startsWith("*.") && host.endsWith(d.slice(1)));
        } catch {
            return false;
        }
    }
    if (t.toolName === "Task") return rule.spec === t.agentType;
    return false;
}

/**
 * For a grant of a whole folder (a sandbox asking to read or write it): the
 * first deny rule that applies to anything in it, or to the folder itself. A
 * write grant is checked against read rules too, since writing a folder
 * exposes it. Rules for other tools don't count.
 */
export function deniedWithin(rules: string[], dir: string, root: string, access: "read" | "write"): string | undefined {
    for (const raw of rules) {
        const r = parseRule(raw);
        const kinds = r.tool === "*" ? ["Edit", "Read"] : EDIT_TOOLS.has(r.tool) ? ["Edit"] : READ_TOOLS.has(r.tool) ? ["Read"] : [];
        if (!kinds.includes("Read") && !(access === "write" && kinds.includes("Edit"))) continue;
        if (!r.spec) return raw;
        if (matchPath(r.spec, dir, root, true) || matchPath(r.spec, join(dir, "*"), root, true)) return raw;
        // Or the rule names something inside the folder.
        const segs = pathPattern(r.spec, root).split("/");
        const firstGlob = segs.findIndex((s) => /[*?]/.test(s));
        const literal = (firstGlob < 0 ? segs : segs.slice(0, firstGlob)).join("/") || "/";
        if (isInside(literal, dir)) return raw;
    }
    return undefined;
}

export function findMatch(rules: string[], t: RuleTarget, root: string, mode: "allow" | "deny"): string | undefined {
    for (const r of rules) if (ruleMatches(parseRule(r), t, root, mode)) return r;
    return undefined;
}
