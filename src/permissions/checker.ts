// Decides whether a tool call runs, asks the user, or is refused.
//
// Order of precedence:
//   1. deny rules                       -> deny (every mode, including bypass;
//                                          matched on the path and its symlink target)
//   2. protected harness files          -> deny (also searching their directory)
//   3. catastrophic shell patterns      -> ask (every mode, including bypass)
//   4. plan mode restrictions           -> deny writes
//   5. ask rules                        -> ask (except bypass)
//   6. bypassPermissions                -> allow
//   7. edits to harness / git config    -> ask
//   8. allow rules                      -> allow
//   9. per-category defaults by mode (below)
//
// Auto mode's shell defaults: commands run in the sandbox when there is one
// (commands that delete things get the reviewer's look first); what can't be
// sandboxed (needs the network, or the model opted out after a sandbox
// failure) goes to the reviewer and runs unsandboxed if it's allowed. Without
// a sandbox, read-only commands run and the rest go to the reviewer.

import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import type { HiddenReason, Tool } from "../tools/types";
import type { PermissionMode } from "./modes";
import type { Settings } from "../config/settings";
import { findMatch, EDIT_TOOLS, READ_TOOLS, toolPath, type RuleTarget } from "./rules";
import { analyzeCommand, configTarget, dangerousReason, ENV_FILE, isReadOnlyCommand, pushesDefaultBranch, sensitiveTarget, suggestBashRules } from "./bash-safety";
import { looksDestructive, needsHostAccess, sandboxEnabled } from "./sandbox";
import { isReadOnly } from "../tools/types";
import { canonical, expandPath, isInside } from "../util/files";
import { harnessHome, paths } from "../config/paths";

export type Behavior = "allow" | "ask" | "deny";

export interface Decision {
    behavior: Behavior;
    reason?: string;
    /** Rule that decided it. */
    rule?: string;
    /** Rules to offer for "don't ask again". */
    suggestions?: string[];
    /** Offer "allow all edits this session" (switch to acceptEdits). */
    offerAcceptEdits?: boolean;
    /** Flagged as dangerous: always ask, never auto-approve. */
    dangerous?: boolean;
    /** Auto mode: run the classifier before deciding. */
    needsClassifier?: boolean;
    /** Auto mode: run the command in the sandbox. */
    sandbox?: boolean;
}

const SENSITIVE_HOME = [".ssh", ".aws", ".gnupg", ".kube", ".docker/config.json", ".config/gcloud", ".netrc", ".npmrc", ".pypirc", "Library/Keychains"];

/** macOS and Windows filesystems are case-insensitive by default: `.HARNESS` is `.harness`. */
const FOLD = process.platform === "darwin" || process.platform === "win32" ? (p: string) => p.toLowerCase() : (p: string) => p;

/** The path as given and with symlinks resolved, case-folded where the filesystem ignores case. */
function pathForms(p: string): string[] {
    const c = canonical(p);
    return [...new Set([FOLD(p), FOLD(c)])];
}

export class PermissionChecker {
    /** Rules granted for this session only (not persisted). */
    sessionAllow: string[] = [];

    constructor(
        private settings: () => Settings,
        private root: string,
        /** Whether auto mode can run shell commands sandboxed here (replaceable in tests). */
        readonly sandboxAvailable: () => boolean = () => sandboxEnabled(settings().sandbox),
    ) {}

    workspaceRoots(): string[] {
        return [this.root, ...(this.settings().permissions?.additionalDirectories ?? []).map((d) => expandPath(d, this.root))].map((p) => canonical(p));
    }

    inWorkspace(abs: string): boolean {
        const c = canonical(abs);
        return this.workspaceRoots().some((r) => isInside(c, r));
    }

    target(tool: Tool<any>, input: any, cwd: string): RuleTarget {
        const t: RuleTarget = { toolName: tool.name };
        if (tool.name === "Bash") t.command = String(input?.command ?? "");
        // The field the tool itself uses, so an extra key can't stand in for it.
        const p = toolPath(tool.name, input);
        if ((EDIT_TOOLS.has(tool.name) || READ_TOOLS.has(tool.name)) && p !== undefined) t.path = expandPath(p, cwd);
        else if (READ_TOOLS.has(tool.name)) t.path = cwd;
        if (tool.name === "WebFetch") t.url = String(input?.url ?? "");
        if (tool.name === "Task") t.agentType = String(input?.subagent_type ?? "general-purpose");
        return t;
    }

    check(tool: Tool<any>, input: any, mode: PermissionMode, cwd: string): Decision {
        const s = this.settings();
        const allow = [...(s.permissions?.allow ?? []), ...this.sessionAllow];
        const deny = s.permissions?.deny ?? [];
        const ask = s.permissions?.ask ?? [];
        const t = this.target(tool, input, cwd);

        // Deny/ask rules see the path as given and where its symlinks lead, so
        // a link can't sidestep `Read(secrets/**)`.
        const resolved: RuleTarget | undefined = t.path && canonical(t.path) !== t.path ? { ...t, path: canonical(t.path) } : undefined;
        const denied = findMatch(deny, t, this.root, "deny") ?? (resolved && findMatch(deny, resolved, this.root, "deny"));
        if (denied) return { behavior: "deny", rule: denied, reason: `Denied by permission rule ${denied}` };

        if (t.path && this.isProtected(t.path, tool.name)) {
            return { behavior: "deny", reason: "Access to the harness credential store is blocked." };
        }

        let dangerous: string | undefined;
        if (tool.name === "Bash") dangerous = dangerousReason(t.command ?? "");

        // Plan mode: research only.
        if (mode === "plan") {
            if (tool.category === "edit") return { behavior: "deny", reason: "Plan mode is active: files can't be modified. Finish planning and call ExitPlanMode to present the plan." };
            if (tool.name === "Bash" && !isReadOnlyCommand(t.command ?? "")) {
                return { behavior: "deny", reason: "Plan mode is active: only read-only shell commands are allowed. Call ExitPlanMode with your plan before making changes." };
            }
            if (tool.name === "Task" && t.agentType !== "explore") {
                return { behavior: "deny", reason: 'Plan mode is active: only "explore" sub-agents can run.' };
            }
            if (tool.category === "mcp" && !isReadOnly(tool, input)) {
                return { behavior: "deny", reason: "Plan mode is active: only MCP tools marked read-only can run. Call ExitPlanMode with your plan first." };
            }
        }

        if (dangerous) {
            return { behavior: "ask", dangerous: true, reason: `This command ${dangerous}.` };
        }

        const askRule = findMatch(ask, t, this.root, "deny") ?? (resolved && findMatch(ask, resolved, this.root, "deny"));
        if (askRule && mode !== "bypassPermissions") return { behavior: "ask", rule: askRule, reason: `Rule ${askRule} requires confirmation` };

        if (mode === "bypassPermissions") return { behavior: "allow", reason: "bypass mode" };

        // The model must not be able to widen its own permissions (settings,
        // hooks, MCP servers) or plant git hooks without the user seeing it.
        if (tool.category === "edit" && t.path && this.isHarnessConfig(t.path)) {
            return { behavior: "ask", reason: "This file configures the harness or git itself (permissions, hooks, MCP servers); changes always need your approval." };
        }
        if (tool.name === "Bash") {
            const cfg = configTarget(t.command ?? "", harnessHome());
            if (cfg) return { behavior: "ask", reason: `This command changes ${cfg} (permissions, hooks, MCP servers or programs git runs); it always needs your approval.` };
        }

        const allowed = findMatch(allow, t, this.root, "allow");
        // A prefix rule approves the program, not where its output goes:
        // `Bash(cat:*)` must not approve `cat x > ~/.zshrc`.
        if (allowed && !(tool.name === "Bash" && this.redirectsEscape(t.command ?? "", cwd))) return { behavior: "allow", rule: allowed };

        switch (tool.category) {
            case "meta":
                return { behavior: "allow" };
            case "read": {
                // Secrets files ask even inside the workspace (results are
                // redacted too, but the model shouldn't go fishing for keys).
                if (t.path && (tool.name === "Read" || tool.name === "Grep") && this.isSensitive(t.path)) {
                    return { behavior: "ask", reason: "This file may contain credentials." };
                }
                if (!t.path || this.inWorkspace(t.path)) return { behavior: "allow" };
                if (this.isSensitive(t.path)) return { behavior: "ask", reason: "This path may contain credentials." };
                if (mode === "auto") return { behavior: "allow" };
                return { behavior: "ask", reason: "Outside the workspace", suggestions: [`Read(${dirGlob(t.path)})`] };
            }
            case "edit": {
                if (!t.path) return { behavior: "ask" };
                const inside = this.inWorkspace(t.path);
                if (inside && (mode === "acceptEdits" || mode === "auto")) return { behavior: "allow" };
                // Scratch files: auto mode writes them like the sandboxed shell can.
                if (mode === "auto" && this.inTemp(t.path)) return { behavior: "allow" };
                if (!inside) return { behavior: "ask", reason: "Outside the workspace", suggestions: [`Edit(${dirGlob(t.path)})`] };
                return { behavior: "ask", offerAcceptEdits: true };
            }
            case "execute": {
                if (tool.name === "Bash") {
                    const cmd = t.command ?? "";
                    const suggestions = suggestBashRules(cmd);
                    const sandbox = mode === "auto" && this.canSandbox(input, cmd);
                    const sensitive = sensitiveTarget(cmd, { cwd, harnessHome: harnessHome() });
                    if (sensitive) {
                        const reason = `This command reads or touches ${sensitive}, which may contain credentials.`;
                        // Using a .env (loading it to run the tests, creating one from the
                        // example) is routine; printing or sending it isn't. The reviewer tells them apart.
                        if (mode === "auto" && sensitive === ENV_FILE) return { behavior: "ask", needsClassifier: true, sandbox, reason, suggestions };
                        return { behavior: "ask", reason };
                    }
                    if (isReadOnlyCommand(cmd)) {
                        // Even read-only git runs programs from a repo's config (core.fsmonitor,
                        // core.sshCommand), and a sandboxed command can set one up (in /tmp, say).
                        // So in auto mode with a sandbox these run in it, and one that can't (it
                        // needs the network, or the model opted out) takes the reviewer.
                        const unsandboxed = mode === "auto" && !sandbox && this.sandboxAvailable();
                        if (!unsandboxed) return { behavior: "allow", reason: "read-only command", ...(sandbox ? { sandbox } : {}) };
                    }
                    if (mode !== "auto") return { behavior: "ask", suggestions };
                    const push = pushesDefaultBranch(cmd, cwd);
                    if (push) return { behavior: "ask", reason: `This command updates the main branch on the remote (${push}); auto mode always asks for that.`, suggestions };
                    if (sandbox) {
                        // The sandbox contains everything but damage inside the project, so deletions get a look.
                        const destructive = looksDestructive(cmd, cwd);
                        if (destructive) return { behavior: "ask", needsClassifier: true, sandbox, reason: `This command deletes or discards work (${destructive}).`, suggestions };
                        return { behavior: "allow", sandbox, reason: "sandboxed" };
                    }
                    return { behavior: "ask", needsClassifier: true, suggestions };
                }
                return mode === "auto" ? { behavior: "ask", needsClassifier: true } : { behavior: "ask" };
            }
            case "network": {
                if (tool.name === "WebSearch") return { behavior: "allow" };
                let host = "";
                try {
                    host = new URL(t.url ?? "").hostname;
                } catch {
                    // ignore
                }
                const suggestions = host ? [`WebFetch(domain:${host})`] : [];
                if (mode === "auto") return { behavior: "ask", needsClassifier: true, suggestions };
                return { behavior: "ask", suggestions };
            }
            case "mcp": {
                const suggestions = [tool.name];
                if (mode === "auto") return { behavior: "ask", needsClassifier: true, suggestions };
                return { behavior: "ask", suggestions };
            }
        }
        return { behavior: "ask" };
    }

    /**
     * Should a Grep/Glob/LS over a directory leave this file out? Deny and ask
     * rules, the credential store and credential files apply per file, not
     * just to the search root the permission check saw.
     */
    hiddenFromSearch(toolName: string, abs: string): HiddenReason | undefined {
        const s = this.settings();
        const t: RuleTarget = { toolName, path: abs };
        const c = canonical(abs);
        const resolved = c !== abs ? { ...t, path: c } : undefined;
        const hit = (rule: string) => Boolean(findMatch([rule], t, this.root, "deny") || (resolved && findMatch([rule], resolved, this.root, "deny")));
        if ((s.permissions?.deny ?? []).some(hit)) return "deny";
        if (this.isProtected(abs, "Grep")) return "protected";
        // Credential files only need hiding where contents are shown; Glob lists names.
        if (toolName === "Grep" && this.isSensitive(abs)) return "sensitive";
        // All matching ask rules, so approving `src` doesn't also lift a narrower rule inside it.
        const asks = (s.permissions?.ask ?? []).filter(hit);
        return asks.length ? `ask:${[...new Set(asks)].sort().join("\0")}` : undefined;
    }

    /** Auto mode can run this command in the sandbox: one exists, the model didn't opt out, and it doesn't plainly need the network. */
    private canSandbox(input: any, cmd: string): boolean {
        return input?.dangerouslyDisableSandbox !== true && this.sandboxAvailable() && !needsHostAccess(cmd);
    }

    /** Inside the system temp directories (symlinks resolved, so a link can't point elsewhere). */
    private inTemp(p: string): boolean {
        const c = canonical(p);
        const temps = [canonical("/tmp"), canonical(tmpdir())];
        return temps.some((t) => t !== "/" && isInside(c, t) && c !== t);
    }

    /** Does the command redirect output outside the workspace or into config? */
    private redirectsEscape(cmd: string, cwd: string): boolean {
        return analyzeCommand(cmd).redirects.some((r) => {
            // Variables, globs and `~user` can't be resolved here: assume the worst.
            if (!r || /[$`*?[{]/.test(r) || /~/.test(r.startsWith("~/") ? r.slice(2) : r)) return true;
            const abs = expandPath(r, cwd);
            return !this.inWorkspace(abs) || this.isHarnessConfig(abs);
        });
    }

    private isProtected(p: string, toolName: string): boolean {
        const forms = pathForms(p);
        const store = [paths.credentialsFile(), paths.providers()].flatMap(pathForms);
        if (forms.some((f) => store.includes(f))) return true;
        // Searching the store's directory reads the store.
        if (toolName === "Grep" || toolName === "Glob") {
            const home = pathForms(harnessHome());
            return forms.some((f) => home.some((h) => isInside(f, h)));
        }
        return false;
    }

    private isHarnessConfig(p: string): boolean {
        const forms = pathForms(p);
        const home = pathForms(harnessHome());
        if (forms.some((f) => home.some((h) => isInside(f, h)))) return true;
        // `.git` may be a file too (worktrees, submodules): it says where the repo lives.
        return forms.some((c) => /(^|\/)\.harness\//.test(c) || /(^|\/)\.mcp\.json$/.test(c) || /(^|\/)\.git(\/|$)/.test(c));
    }

    private isSensitive(p: string): boolean {
        const home = FOLD(homedir());
        return pathForms(p).some((f) => SENSITIVE_HOME.some((s) => isInside(f, join(home, FOLD(s)))) || /(^|\/)\.env(?!\.(example|sample|template|dist)$)(\.|$)/.test(f));
    }
}

/** `//abs/dir/**` rule for the directory containing an absolute path. */
function dirGlob(abs: string): string {
    const dir = dirname(abs);
    return dir === "/" ? "//**" : `/${dir}/**`;
}
