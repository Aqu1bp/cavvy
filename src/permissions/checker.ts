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
// (commands that delete things get the reviewer's look first). With Seatbelt a
// command can list the hosts it needs (allowedHosts): the reviewer sees them,
// and the sandbox opens them for that command only. What can't be sandboxed
// (needs more than the network, or the model opted out after a sandbox
// failure) goes to the reviewer and runs unsandboxed if it's allowed. Without
// a sandbox, read-only commands run and the rest go to the reviewer.

import { existsSync, lstatSync, readdirSync, realpathSync, statSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join, resolve } from "path";
import type { HiddenReason, Tool } from "../tools/types";
import type { PermissionMode } from "./modes";
import { sandboxAllowedHosts, sandboxExcludedCommands, type Settings } from "../config/settings";
import { findMatch, EDIT_TOOLS, READ_TOOLS, toolPath, type RuleTarget } from "./rules";
import { accountTarget, analyzeCommand, commandsWithDirs, configTarget, dangerousReason, effectiveArgv, expandWord, type CommandAnalysis, HARNESS_FILES, harnessHomeReads, isReadOnlyCommand, programNames, pushesDefaultBranch, sensitiveTarget, sensitiveWord, shellVars, type ShellEnv, suggestBashRules, withoutHeredocData } from "./bash-safety";
import { accessNeeded, looksDestructive, sandboxEnabled, sandboxKind, sandboxPolicy, type SandboxKind, type SandboxPolicy } from "./sandbox";
import { stableStringify, type ApprovedAction } from "./classifier";
import { isBrowserTool, isQuietBrowserCall, isReadOnly, isShellTool } from "../tools/types";
import { canonical, expandPath, isInside, spellings } from "../util/files";
import { harnessHome, paths } from "../config/paths";
import { childEnv } from "../util/env";
import { accountCredentialFiles, accountFolders, accountProtectedPaths } from "../providers/accounts";
import { fileUrlPath, hostOf, navigationTarget, type BrowserApproval } from "../browser/url-policy";

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
    /** The sensitive target the command names (what the reviewer is told, and what a grant covers). */
    sensitive?: string;
    /** Sandboxed: every host to open for the command (what it listed, the settings' and the package managers' or gh's own). */
    hosts?: string[];
    /** Hosts the command listed that nothing opens by itself: the reason for the review. */
    listedHosts?: string[];
    /** Changes the harness's own configuration: only the exact action can be approved, never a wider grant. */
    config?: boolean;
    /** The "allow this for the session" choice the popup offers. */
    grant?: SessionGrant;
    /** Allowed because the user said yes to this exact action earlier in the session. */
    remembered?: boolean;
}

/** What "Yes, and allow this for the session" covers, derived from what triggered the popup. */
export interface SessionGrant {
    label: string;
    /** Permission rules (a command prefix, a domain, an MCP tool). */
    rules?: string[];
    /** Sensitive files or folders commands may name. */
    paths?: string[];
    /** Hosts a sandboxed command may list without review. */
    hosts?: string[];
}

const SENSITIVE_HOME = [".ssh", ".aws", ".gnupg", ".kube", ".docker/config.json", ".config/gcloud", ".netrc", ".npmrc", ".pypirc", "Library/Keychains"];

/**
 * The path as given and with symlinks resolved, each in its spellings: on a
 * case-insensitive volume `.HARNESS` and `.harneſſ` are `.harness`, and
 * resolving can't show it for a folder that doesn't exist yet.
 */
function pathForms(p: string): string[] {
    return [...new Set([p, canonical(p)].flatMap(spellings))];
}

/**
 * In a sub-agent's own memory folder, as written and where its symlinks lead:
 * notes it keeps for its own prompt, not configuration (for that agent alone).
 * The folder and the agent-memory folder holding it must be real folders: a
 * link there could make `.harness` itself (or its agents) the "memory".
 */
function inMemory(p: string, dir: string): boolean {
    const real = resolve(dir);
    if ([real, dirname(real)].some(isLink)) return false;
    const dirs = [real, canonical(real)];
    const inside = (x: string) => dirs.some((d) => x !== d && isInside(x, d));
    return inside(resolve(p)) && isInside(canonical(p), dirs[1]!) && canonical(p) !== dirs[1] && !/(^|\/)\.git(\/|$)/.test(p);
}

function isLink(p: string): boolean {
    try {
        return lstatSync(p).isSymbolicLink();
    } catch {
        return false;
    }
}

/** What isHarnessConfig looks for in a path. */
/** Tools whose yes covers only the call it answered (see approve). */
const ONE_CALL_APPROVAL = new Set(["GitCommit", "GitPush", "CreatePullRequest", "BrowserAct", "BrowserEval"]);
const CONFIG_NAMES = new Set([".harness", ".claude", ".codex", ".git", ".mcp.json"]);

/**
 * The path with each git checkout Claude Code keeps at …/.claude/worktrees/<name>
 * put aside: that's a project of its own, so the .claude/ it sits in says nothing
 * about its files. Everything else in the path still counts: the checkout's own
 * .claude/, .git and .mcp.json, and anything protected around it (one kept inside
 * a .git/ is still in there). A git repo elsewhere in ~/.claude (a plugin's hooks)
 * isn't one of these, and nor is one named like the config itself: in a session
 * run from .claude/worktrees, its .harness/ is that project's config even if it
 * has a .git of its own. Only what's in the folder is set aside, not the folder
 * itself. Looked up as given: folding case first would find another folder on a
 * case-sensitive volume.
 */
function withoutWorktrees(p: string): string {
    return p.replace(/\/\.claude\/worktrees\/([^/]+)(?=\/)/gi, (segment, name: string, at: number) =>
        !spellings(name).some((n) => CONFIG_NAMES.has(n)) && existsSync(join(p.slice(0, at + segment.length), ".git")) ? "/<worktree>" : segment,
    );
}

export class PermissionChecker {
    /** Rules granted for this session only (not persisted). */
    sessionAllow: string[] = [];
    /** "Allow for the session" grants: command prefixes, sensitive paths, hosts. Only within the workspace roots. */
    grantedRules: string[] = [];
    grantedPaths: string[] = [];
    grantedHosts: string[] = [];
    /** Actions the user said yes to: only those exact ones run unasked again. Sub-agents share it with their parent. */
    private approved = new Set<string>();
    private approvals: ApprovedAction[] = [];

    constructor(
        private settings: () => Settings,
        private root: string,
        /** The sandbox auto mode runs shell commands in here, if any (replaceable in tests). */
        readonly sandbox: () => SandboxKind | undefined = () => (sandboxEnabled(settings().sandbox) ? sandboxKind() : undefined),
    ) {}

    sandboxAvailable(): boolean {
        return this.sandbox() !== undefined;
    }

    workspaceRoots(): string[] {
        return [this.root, ...(this.settings().permissions?.additionalDirectories ?? []).map((d) => expandPath(d, this.root))].map((p) => canonical(p));
    }

    inWorkspace(abs: string): boolean {
        const c = canonical(abs);
        return this.workspaceRoots().some((r) => isInside(c, r));
    }

    target(tool: Tool<any>, input: any, cwd: string): RuleTarget {
        const t: RuleTarget = { toolName: tool.name };
        if (isShellTool(tool.name)) t.command = String(input?.command ?? "");
        // The field the tool itself uses, so an extra key can't stand in for it.
        const p = toolPath(tool.name, input);
        if ((EDIT_TOOLS.has(tool.name) || READ_TOOLS.has(tool.name)) && p !== undefined) t.path = expandPath(p, cwd);
        else if (READ_TOOLS.has(tool.name)) t.path = cwd;
        if (tool.name === "WebFetch" || tool.name === "BrowserNavigate") t.url = String(input?.url ?? "");
        if (tool.name === "Task") t.agentType = String(input?.subagent_type ?? "general-purpose");
        return t;
    }

    /** The file a BrowserNavigate call to a file: URL would show, as a Read target. */
    private openedFile(input: any): RuleTarget | undefined {
        if ((input?.action ?? "goto") !== "goto" && input?.action !== "new_tab") return undefined;
        const path = typeof input?.url === "string" ? fileUrlPath(input.url) : undefined;
        return path === undefined ? undefined : { toolName: "Read", path };
    }

    /**
     * Why a page may not go to this address by itself (a redirect, a link, a script, a popup, a frame), if it may not: a
     * deny rule for its host, a file read restriction, or an ask rule for its host. `approved`: what the tab was opened
     * to with a yes (or by a person): only that exact file bypasses asks and sensitivity; only that host, its ask rules.
     */
    urlRefusal(url: string, approved: BrowserApproval = {}): string | undefined {
        const denied = findMatch(this.settings().permissions?.deny ?? [], { toolName: "BrowserNavigate", url }, this.root, "deny");
        if (denied) return `Denied by permission rule ${denied}`;
        const ask = this.settings().permissions?.ask ?? [];
        const file = fileUrlPath(url);
        if (file !== undefined) {
            let dir = false;
            try {
                dir = statSync(file).isDirectory();
            } catch {
                // not there: the browser says so
            }
            const fileApproved = approved.file !== undefined && canonical(file) === approved.file;
            const why = this.userReadRefusal(file, { sensitive: !fileApproved, dir });
            if (why) return `${why[0]!.toUpperCase()}${why.slice(1)}`;
            const target = { toolName: "Read", path: file };
            const rule = findMatch(ask, target, this.root, "deny") ?? findMatch(ask, { ...target, path: canonical(file) }, this.root, "deny");
            return rule && !fileApproved ? `Requires approval by permission rule ${rule}. Request this file explicitly with BrowserNavigate.` : undefined;
        }
        // An ask rule for a host asks before every visit, as WebFetch never follows a redirect to another host: a page
        // can't take the agent there unasked. Within the visit that was asked for, it moves freely.
        const rule = findMatch(ask, { toolName: "BrowserNavigate", url }, this.root, "deny");
        return rule && !(approved.host !== undefined && hostOf(url) === approved.host) ? `Requires approval by permission rule ${rule}. Open it explicitly with BrowserNavigate.` : undefined;
    }

    /** A new, cleared, resumed or switched-to session: nothing approved in another one carries over. */
    resetSession() {
        this.sessionAllow = [];
        this.grantedRules = [];
        this.grantedPaths = [];
        this.grantedHosts = [];
        this.approved = new Set();
        this.approvals = [];
    }

    /** `own.memoryDir`: a sub-agent's memory folder (src/agent/agents.ts), which isn't configuration for that agent. */
    check(tool: Tool<any>, input: any, mode: PermissionMode, cwd: string, own?: { memoryDir?: string }): Decision {
        const d = this.decide(tool, input, mode, cwd, own?.memoryDir);
        if (d.behavior !== "ask") return d;
        // Rules that ask every time keep asking; anything else the user already said yes to runs.
        if (!d.rule && this.approved.has(this.actionKey(tool, input, cwd, d.sandbox))) return { behavior: "allow", remembered: true, reason: "approved earlier this session", ...(d.sandbox ? { sandbox: true } : {}), ...(d.hosts ? { hosts: d.hosts } : {}) };
        return d;
    }

    /** The decision with the scoped "allow for the session" choice the popup offers, if there is one. */
    withGrant(tool: Tool<any>, input: any, d: Decision, cwd: string): Decision {
        const grant = d.grant ?? this.grantFor(tool, input, d, cwd);
        return grant ? { ...d, grant } : d;
    }

    /**
     * The user said yes to this exact action, here: the same one in the same folder needs no
     * asking again this session. What the reviewer hears is the action itself, never a summary.
     */
    approve(tool: Tool<any>, input: any, cwd: string, opts: { sandbox?: boolean; grant?: SessionGrant } = {}) {
        // The git tools act on whatever the repo holds when they run, so the same input can mean another
        // branch, commit or set of files; a browser action, on whatever page is open, so the same click or
        // script can do something else on the next one: a yes covers the call it answered. "Don't ask again" is the rule.
        // Nor does the reviewer hear of it: it would read close variations (a push from Bash) as approved too.
        if (ONE_CALL_APPROVAL.has(tool.name)) return;
        this.approved.add(this.actionKey(tool, input, cwd, opts.sandbox));
        const a = approvedAction(tool, input, canonical(cwd), this.target(tool, input, cwd).path, opts.grant);
        const key = stableStringify(a);
        this.approvals = [...this.approvals.filter((x) => stableStringify(x) !== key), a].slice(-10);
    }

    /** What the user approved lately, oldest first, for the reviewer. */
    recentApprovals(): ApprovedAction[] {
        return [...this.approvals];
    }

    /** The user chose "allow this for the session". */
    applyGrant(g: SessionGrant) {
        this.grantedRules.push(...(g.rules ?? []));
        this.grantedPaths.push(...(g.paths ?? []));
        this.grantedHosts.push(...(g.hosts ?? []));
    }

    /** Same action, same answer: the tool, its input, the folder it runs in and (file tools) the file it resolves to. */
    private actionKey(tool: Tool<any>, input: any, cwd: string, sandbox?: boolean): string {
        const where = canonical(cwd);
        if (!isShellTool(tool.name)) {
            const p = this.target(tool, input, cwd).path;
            return stableStringify([tool.name, input ?? null, where, p ? canonical(p) : null]);
        }
        const hosts = [...allowedHostsOf(input)].sort();
        return stableStringify([tool.name, String(input?.command ?? ""), Boolean(sandbox), hosts, input?.dangerouslyDisableSandbox === true, where]);
    }

    /**
     * The scoped grant a popup offers. None for what must stay exact: dangerous
     * commands, rules that ask every time and changes to the harness's own
     * configuration (a grant there would let the model widen its permissions).
     */
    private grantFor(tool: Tool<any>, input: any, d: Decision, cwd: string): SessionGrant | undefined {
        if (d.dangerous || d.config || d.rule || tool.category === "edit" || tool.category === "read") return undefined;
        if (isShellTool(tool.name)) {
            const cmd = String(input?.command ?? "");
            if (d.sensitive) {
                const paths = [...new Set(this.sensitivePaths(heredocDataBlanked(cmd), cwd))];
                return paths.length && paths.every((p) => !isInside(homedir(), p)) ? { label: paths.map((p) => displayHome(p)).join(", "), paths } : undefined;
            }
            if (d.listedHosts?.length) return { label: d.listedHosts.join(", "), hosts: d.listedHosts };
            const rules = d.suggestions ?? [];
            return rules.length ? { label: rules.map((r) => r.replace(/^Bash\((.*?)(:\*)?\)$/, "$1")).join(", "), rules } : undefined;
        }
        const rules = d.suggestions ?? [];
        if (!rules.length) return undefined;
        if (tool.name === "WebFetch" || tool.name === "BrowserNavigate") return { label: rules[0]!.replace(/^WebFetch\(domain:(.*)\)$/, "$1"), rules };
        return { label: tool.name, rules };
    }

    /** The paths a command's sensitive words name (globs by the folder before them). */
    private sensitivePaths(cmd: string, cwd: string): string[] {
        return this.sensitiveWords(cmd, cwd).map((w) => w.abs);
    }

    private sensitiveWords(cmd: string, cwd: string): { word: string; abs: string }[] {
        const a = analyzeCommand(cmd);
        if (a.unparsable || a.hasSubstitution || a.unsafeExpansion) return [];
        const look = shellVars(cmd, this.shellEnv());
        const out: { word: string; abs: string }[] = [];
        for (const word of new Set([...a.commands.flatMap((c) => c.argv), ...a.redirects])) {
            // Variables by their values, as the shell gets them: `$HARNESS_HOME/credentials.json`.
            const value = /[$~]/.test(word) ? expandWord(word, look, cwd) : word;
            if (value === undefined || !sensitiveWord(value, harnessHome())) continue;
            const abs = wordPath(value, cwd);
            if (abs) out.push({ word, abs });
        }
        return out;
    }

    /** The environment the Bash tool gives commands: what their variables hold. */
    private shellEnv(): ShellEnv {
        return childEnv(this.settings().env);
    }

    /**
     * What the command names that's sensitive and not covered: the sandbox
     * blocks the read whatever the text says, or the user allowed that path.
     * Words are taken out one by one and the rest judged again, so one
     * covered word never hides another target.
     */
    private sensitiveTarget(cmd: string, cwd: string, sandboxed: boolean): string | undefined {
        // The policy the command will run under, built as the agent builds it.
        const policy = sandboxed ? sandboxPolicy(this.workspaceRoots(), { harnessHome: harnessHome() }) : undefined;
        return this.secretTarget(cmd, cwd, policy) ?? this.harnessFilesTarget(cmd, cwd, policy);
    }

    private secretTarget(cmd: string, cwd: string, policy: SandboxPolicy | undefined): string | undefined {
        const opts = { cwd, harnessHome: harnessHome(), env: this.shellEnv() };
        const found = sensitiveTarget(cmd, opts);
        // Without the sandbox a recursive search of a folder holding the secrets reads them too.
        if (!found) return policy ? undefined : this.searchesStore(cmd, cwd);
        const granted = grantedFiles(this.grants(cwd).paths);
        if (!policy && !granted.size) return found;
        // The sandbox blocks what a path leads to, so that's what must be covered, and so is a grant.
        // Words are resolved against the folder the command starts in, so cover is only for lines of
        // plain file readers: anything that may read from another folder (`cd`, `git -C`, `env -C`,
        // `make -C`, `find -execdir`, `xargs`, a script) could make the same word another file.
        const a = analyzeCommand(cmd);
        const grantCovers = (abs: string) => insideFiles(abs, granted);
        // A folder the sandbox blocks is blocked down to what links inside it lead to; a granted one only
        // to be listed, since a link inside could lead out and `diff a/.env a` reads a/.env through it.
        if (!plainReads(cmd, a, cwd, (dir, listed) => (policy && blocks(policy, dir, true)) || (listed && grantCovers(dir)))) return found;
        const covered = this.sensitiveWords(cmd, cwd).filter((w) => (policy && blocks(policy, w.abs, false)) || grantCovers(w.abs));
        if (!covered.length) return found;
        // Blank only the covered words themselves, by where they stand: a covered `.env` must not
        // also erase the `.env` inside an uncovered `.env.prod` or "other .env file" next to it.
        // Redirect targets have no span, so they stay, and a line reading one still gets judged.
        const words = new Set(covered.map((w) => w.word));
        const spans = a.commands.flatMap((c) => c.argv.flatMap((w, i) => (words.has(w) ? [c.spans[i]!] : [])));
        let rest = cmd;
        for (const [from, to] of spans.sort((x, y) => y[0] - x[0])) rest = rest.slice(0, from) + " ".repeat(to - from) + rest.slice(to);
        return sensitiveTarget(rest, opts);
    }

    /**
     * Reading the harness home's other files (settings, session logs). Listing them is fine. In the
     * sandbox, only if its policy doesn't already keep the home's file contents from being read.
     */
    private harnessFilesTarget(cmd: string, cwd: string, policy: SandboxPolicy | undefined): string | undefined {
        const reads = harnessHomeReads(cmd, cwd, harnessHome(), this.shellEnv());
        if (!reads) return undefined;
        if (!policy) return HARNESS_FILES;
        // Each path by where it leads; what it can't pin down (a folder, a pattern, an expansion) only when no symlink leads out of the home.
        const home = harnessHome();
        if (reads.unsure && !blocks(policy, home, true)) return HARNESS_FILES;
        return reads.paths.every((p) => blocks(policy, p, true)) ? undefined : HARNESS_FILES;
    }

    /** Does a search command (rg, grep -r, find) have a folder that holds the harness's secret files as an operand? */
    private searchesStore(cmd: string, cwd: string): string | undefined {
        const a = analyzeCommand(cmd);
        if (a.unparsable || a.hasSubstitution || a.unsafeExpansion) return undefined;
        const store = [paths.credentialsFile(), paths.mcpOAuth(), paths.providers(), harnessAccounts(), ...accountCredentialFiles()].flatMap(pathForms);
        for (const c of a.commands) {
            const argv = effectiveArgv(c.argv);
            const prog = (argv[0] ?? "").split("/").pop()!;
            if (!/^(rg|ag|ack|grep|egrep|fgrep|find|fd)$/.test(prog)) continue;
            // Names alone aren't the secrets: find and fd count only when they run something on what they find.
            if (/^(find|fd)$/.test(prog) && !argv.some((w) => /^(-(exec|execdir|ok|okdir|delete|fprint0?|fprintf|fls|x|X)|--exec(-batch)?)(=|$)/.test(w))) continue;
            for (const word of argv.slice(1)) {
                const abs = word.startsWith("-") ? undefined : wordPath(word, cwd);
                if (abs && pathForms(abs).some((f) => store.some((file) => isInside(file, f)))) return "the harness credential store";
            }
        }
        return undefined;
    }

    /** The session's scoped grants, which hold only within the workspace roots. */
    private grants(cwd: string): { rules: string[]; paths: string[]; hosts: string[] } {
        return this.inWorkspace(cwd) ? { rules: this.grantedRules, paths: this.grantedPaths, hosts: this.grantedHosts } : { rules: [], paths: [], hosts: [] };
    }

    /** Does a user-scope exclusion cover the whole call? Every command in a chain must match. */
    private excluded(cmd: string): boolean {
        const rules = sandboxExcludedCommands(this.settings()).map((r) => (/^Bash(\(|$)/.test(r.trim()) ? r.trim() : `Bash(${r.trim()})`));
        return rules.length > 0 && findMatch(rules, { toolName: "Bash", command: cmd }, this.root, "allow") !== undefined;
    }

    private decide(tool: Tool<any>, input: any, mode: PermissionMode, cwd: string, memoryDir?: string): Decision {
        const s = this.settings();
        const allow = [...(s.permissions?.allow ?? []), ...this.sessionAllow, ...this.grants(cwd).rules];
        const deny = s.permissions?.deny ?? [];
        const ask = s.permissions?.ask ?? [];
        const t = this.target(tool, input, cwd);

        // Deny/ask rules see the path as given and where its symlinks lead, so
        // a link can't sidestep `Read(secrets/**)`.
        const resolved: RuleTarget | undefined = t.path && canonical(t.path) !== t.path ? { ...t, path: canonical(t.path) } : undefined;
        const denied = findMatch(deny, t, this.root, "deny") ?? (resolved && findMatch(deny, resolved, this.root, "deny"));
        if (denied) return { behavior: "deny", rule: denied, reason: `Denied by permission rule ${denied}` };

        if (t.path && this.isProtected(t.path, tool.name, tool.name === "Grep", true)) {
            return { behavior: "deny", reason: "Access to the harness credential store is blocked." };
        }
        // A page opened from a file shows the file: the rules for reading it apply as they do to Read.
        const opened = tool.name === "BrowserNavigate" ? this.openedFile(input) : undefined;
        if (opened) {
            const rule = findMatch(deny, opened, this.root, "deny") ?? findMatch(deny, { ...opened, path: canonical(opened.path!) }, this.root, "deny");
            if (rule) return { behavior: "deny", rule, reason: `Denied by permission rule ${rule}` };
            if (this.isProtected(opened.path!, "Read", false, true)) return { behavior: "deny", reason: "Access to the harness credential store is blocked." };
        }
        // What the content checks read: a here-document's data blanked when nothing on the line can run it.
        const judged = isShellTool(tool.name) ? heredocDataBlanked(t.command ?? "") : "";
        if (isShellTool(tool.name) && accountTarget(judged, cwd, this.shellEnv())) {
            return { behavior: "deny", reason: "Access to CLI account folders is blocked." };
        }

        let dangerous: string | undefined;
        if (isShellTool(tool.name)) dangerous = dangerousReason(t.command ?? "");

        // Plan mode: research only.
        if (mode === "plan") {
            if (tool.category === "edit") return { behavior: "deny", reason: "Plan mode is active: files can't be modified. Finish planning and call ExitPlanMode to present the plan." };
            if (isShellTool(tool.name) && !isReadOnlyCommand(t.command ?? "")) {
                return { behavior: "deny", reason: "Plan mode is active: only read-only shell commands are allowed. Call ExitPlanMode with your plan before making changes." };
            }
            if (isBrowserTool(tool.name) && tool.category === "execute" && !isReadOnly(tool, input)) {
                return { behavior: "deny", reason: "Plan mode is active: the browser can be opened and read (snapshots, screenshots, logs), but not clicked, typed into or scripted. Call ExitPlanMode with your plan first." };
            }
            // Commit, push, open a pull request.
            if (tool.category === "execute" && !isShellTool(tool.name) && !isReadOnly(tool, input)) {
                return { behavior: "deny", reason: "Plan mode is active: nothing can be committed or pushed. Call ExitPlanMode with your plan first." };
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

        const askRule = findMatch(ask, t, this.root, "deny") ?? (resolved && findMatch(ask, resolved, this.root, "deny")) ?? (opened && (findMatch(ask, opened, this.root, "deny") ?? findMatch(ask, { ...opened, path: canonical(opened.path!) }, this.root, "deny")));
        if (askRule && mode !== "bypassPermissions") return { behavior: "ask", rule: askRule, reason: `Rule ${askRule} requires confirmation` };

        if (mode === "bypassPermissions") return { behavior: "allow", reason: "bypass mode" };

        // The model must not be able to widen its own permissions (settings,
        // hooks, MCP servers) or plant git hooks without the user seeing it.
        if (tool.category === "edit" && t.path && this.isHarnessConfig(t.path) && !(memoryDir && inMemory(t.path, memoryDir))) {
            return { behavior: "ask", config: true, reason: "This file configures the harness or git itself (permissions, hooks, MCP servers); changes always need your approval." };
        }
        if (isShellTool(tool.name)) {
            const cfg = configTarget(judged, harnessHome());
            if (cfg) return { behavior: "ask", config: true, reason: `This command changes ${cfg} (permissions, hooks, MCP servers or programs git runs); it always needs your approval.` };
        }

        const allowed = findMatch(allow, t, this.root, "allow");
        // A prefix rule approves the program, not where its output goes:
        // `Bash(cat:*)` must not approve `cat x > ~/.zshrc`.
        if (allowed && !(isShellTool(tool.name) && this.redirectsEscape(t.command ?? "", cwd))) return { behavior: "allow", rule: allowed };

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
                if (isShellTool(tool.name)) {
                    const cmd = t.command ?? "";
                    const suggestions = suggestBashRules(cmd);
                    const access = accessNeeded(judged, cwd);
                    const listed = allowedHostsOf(input);
                    const kind = mode === "auto" && input?.dangerouslyDisableSandbox !== true && !this.excluded(cmd) ? this.sandbox() : undefined;
                    // Seatbelt can open hosts for a command (through its proxy); bubblewrap can't, so
                    // there a command that wants the network runs outside, after review.
                    const sandbox = kind !== undefined && !access.host && (kind === "seatbelt" || (!access.network && !listed.length));
                    // Hosts nothing needs the model to list: the user's own (settings), and a package manager's
                    // registry when all the line does besides installing needs no network.
                    const auto = sandbox && kind === "seatbelt" ? [...sandboxAllowedHosts(s), ...(installsOnly(cmd, cwd) ? registryHosts(cmd) : [])] : [];
                    const needReview = listed.filter((h) => !auto.includes(h) && !this.grants(cwd).hosts.includes(h));
                    const hosts = [...new Set([...auto, ...listed])];
                    const opensHosts = sandbox && needReview.length > 0;
                    const sensitive = this.sensitiveTarget(judged, cwd, sandbox);
                    if (sensitive && mode !== "auto") return { behavior: "ask", sensitive, reason: `This command reads or touches ${sensitive}, which may contain credentials.` };
                    // It would only fail in the sandbox: say how to ask for the network before running it.
                    if (sandbox && access.network && !hosts.length) return { behavior: "deny", reason: networkAdvice(access.network, cmd) };
                    const open = sandbox && hosts.length ? { hosts } : {};
                    const push = mode === "auto" ? pushesDefaultBranch(judged, cwd) : undefined;
                    // Naming something sensitive doesn't take a push to main past the user.
                    if (push) return { behavior: "ask", reason: `This command updates the main branch on the remote (${push}); auto mode always asks for that.`, suggestions };
                    if (sensitive) {
                        // Using a .env (loading it to run the tests, creating one from the example) is routine;
                        // printing or sending it isn't. The reviewer tells them apart, and the user hears only if it won't allow it.
                        return { behavior: "ask", needsClassifier: true, sandbox, sensitive, ...open, reason: `This command reads or touches ${sensitive}, which may contain credentials.`, suggestions };
                    }
                    // Opening hosts always takes the reviewer, read-only command or not.
                    if (isReadOnlyCommand(cmd) && !opensHosts) {
                        // Even read-only git runs programs from a repo's config (core.fsmonitor,
                        // core.sshCommand), and a sandboxed command can set one up (in /tmp, say).
                        // So in auto mode with a sandbox these run in it, and one that can't (it
                        // needs the network, or the model opted out) takes the reviewer.
                        const unsandboxed = mode === "auto" && !sandbox && this.sandboxAvailable();
                        if (!unsandboxed) return { behavior: "allow", reason: "read-only command", ...(sandbox ? { sandbox } : {}), ...open };
                    }
                    if (mode !== "auto") return { behavior: "ask", suggestions };
                    if (sandbox) {
                        // The sandbox contains everything but damage inside the project, so deletions get a look.
                        const destructive = looksDestructive(judged, cwd);
                        if (destructive) return { behavior: "ask", needsClassifier: true, sandbox, ...open, reason: `This command deletes or discards work (${destructive}).`, suggestions };
                        if (opensHosts) return { behavior: "ask", needsClassifier: true, sandbox, ...open, listedHosts: needReview, reason: `This command opens network access to ${needReview.join(", ")}.`, suggestions };
                        return { behavior: "allow", sandbox, ...open, reason: "sandboxed" };
                    }
                    return { behavior: "ask", needsClassifier: true, suggestions };
                }
                // What a page does is the page's: clicking and typing run its scripts and can submit its forms. Hovering,
                // scrolling and waiting change nothing, so they go unasked; the rest asks once, then "don't ask again" allows the tool.
                if (isBrowserTool(tool.name) && (isReadOnly(tool, input) || isQuietBrowserCall(tool.name, input))) return { behavior: "allow" };
                // GitCommit, GitPush, CreatePullRequest: "don't ask again" allows the tool in this project.
                const suggestions = [tool.name];
                // Publishing reaches other people and can't be taken back: auto mode's reviewer doesn't decide it, the user does.
                if (tool.name === "GitPush" || tool.name === "CreatePullRequest") return { behavior: "ask", suggestions, ...(mode === "auto" ? { reason: "Pushing to the remote always asks in auto mode." } : {}) };
                return mode === "auto" ? { behavior: "ask", needsClassifier: true, suggestions } : { behavior: "ask", suggestions };
            }
            case "network": {
                if (tool.name === "WebSearch") return { behavior: "allow" };
                if (tool.name === "BrowserNavigate") {
                    // A dev server, a file in the project or a blank page isn't the network; a host is (and one the browser would refuse always asks).
                    const target = navigationTarget(input);
                    if (opened && this.isSensitive(opened.path!)) return { behavior: "ask", reason: "This file may contain credentials." };
                    if (!target || target.kind === "local") return { behavior: "allow" };
                    const suggestions = target.kind === "host" ? [`WebFetch(domain:${target.host})`] : [];
                    return mode === "auto" ? { behavior: "ask", needsClassifier: true, suggestions } : { behavior: "ask", suggestions };
                }
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
        // What's in a private folder, or a sign-in file. A folder that merely holds one isn't (a search root, a
        // listed folder): so a search of it is never "protected" itself, and can't make its secrets fair game.
        if (this.isProtected(abs, "Grep", false, true)) return "protected";
        // Credential files only need hiding where contents are shown; Glob lists names.
        if (toolName === "Grep" && this.isSensitive(abs)) return "sensitive";
        // All matching ask rules, so approving `src` doesn't also lift a narrower rule inside it.
        const asks = (s.permissions?.ask ?? []).filter(hit);
        return asks.length ? `ask:${[...new Set(asks)].sort().join("\0")}` : undefined;
    }

    /**
     * Why a path the user handed over themselves (an @-mention, a pasted or
     * dropped image) still can't be read. Their say-so stands in for "outside
     * the workspace", never for deny rules or the credential store, judged on
     * the path and where its symlinks lead. `sensitive` also refuses files that
     * may hold credentials (~/.ssh, .env …): an image's bytes go out unredacted.
     */
    userReadRefusal(abs: string, opts: { sensitive?: boolean; dir?: boolean } = {}): string | undefined {
        const toolName = opts.dir ? "LS" : "Read";
        const t: RuleTarget = { toolName, path: abs };
        const c = canonical(abs);
        const deny = this.settings().permissions?.deny ?? [];
        const rule = findMatch(deny, t, this.root, "deny") ?? (c !== abs ? findMatch(deny, { ...t, path: c }, this.root, "deny") : undefined);
        if (rule) return `denied by permission rule ${rule}`;
        if (this.isProtected(abs, toolName)) return "access to the harness credential store is blocked";
        if (opts.sensitive && this.isSensitive(abs)) return "it may contain credentials";
        return undefined;
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

    /** A folder that is, or holds, the harness's credential store (for grants of whole folders). */
    isProtectedArea(dir: string): boolean {
        const forms = pathForms(dir);
        const store = [paths.credentialsFile(), paths.mcpOAuth(), paths.providers(), ...accountCredentialFiles()].flatMap(pathForms);
        const accounts = [harnessAccounts(), ...accountFolders()].flatMap(pathForms);
        return store.some((f) => forms.some((d) => isInside(f, d))) || accounts.some((f) => forms.some((d) => isInside(f, d) || isInside(d, f)));
    }

    /**
     * Is this a secret file or inside a secret folder (accounts/, registered or not)? For the
     * read tools the user settings count too: they can hold env values and MCP auth headers.
     * The rest of the harness home doesn't. A search root that merely holds some (`root`)
     * isn't refused, wherever it is (a home folder holding an account, #375): its secrets are
     * hidden file by file (hiddenFromSearch).
     */
    private isProtected(p: string, toolName: string, contents = toolName === "Grep", root = false): boolean {
        const forms = pathForms(p);
        const accounts = accountFolders().flatMap(pathForms);
        const credentials = accountCredentialFiles().flatMap(pathForms);
        if (forms.some((f) => credentials.some((a) => f === a || (contents && !root && isInside(a, f))))) return true;
        const search = toolName === "Grep" || toolName === "Glob" || toolName === "LS";
        if (forms.some((f) => accounts.some((a) => isInside(f, a) || (search && !root && isInside(a, f))))) return true;
        if (forms.some((f) => pathForms(harnessAccounts()).some((a) => isInside(f, a)))) return true;
        const store = [paths.credentialsFile(), paths.mcpOAuth(), paths.providers(), ...(READ_TOOLS.has(toolName) ? [paths.userSettings()] : [])].flatMap(pathForms);
        return forms.some((f) => store.includes(f));
    }

    private isHarnessConfig(p: string): boolean {
        const forms = pathForms(p);
        const home = pathForms(harnessHome());
        if (forms.some((f) => home.some((h) => isInside(f, h)))) return true;
        if (accountProtectedPaths().flatMap(pathForms).some((a) => forms.some((f) => isInside(f, a)))) return true;
        // `.git` may be a file too (worktrees, submodules): it says where the repo lives.
        // .claude/ and .codex/ configure the agent CLIs the harness can run (hooks, skills, rules).
        const judged = new Set([p, canonical(p)].map(withoutWorktrees).flatMap(spellings));
        return [...judged].some((c) => /(^|\/)\.(harness|claude|codex)\//.test(c) || /(^|\/)\.mcp\.json$/.test(c) || /(^|\/)\.git(\/|$)/.test(c));
    }

    private isSensitive(p: string): boolean {
        const secrets = SENSITIVE_HOME.flatMap((s) => spellings(join(homedir(), s)));
        // Any spelling that's a .env counts: the lower-cased one isn't wider than the volume, so a
        // name only the wider fold turns into `.env.example` (`.env.ｅxample`) isn't exempt.
        return pathForms(p).some((f) => secrets.some((s) => isInside(f, s)) || /(^|\/)\.env(?!\.(example|sample|template|dist)$)(\.|$)/.test(f));
    }
}

/**
 * Does the policy keep the contents of what `p` leads to from being read? By its
 * canonical target, as Seatbelt matches it. A folder (and with `deep`, anything
 * read through it) only when no symlink under it leads somewhere uncovered.
 */
function blocks(policy: SandboxPolicy, p: string, deep: boolean): boolean {
    const roots = [...(policy.contentsUnreadable ?? []), ...policy.unreadable].flatMap((r) => spellings(r));
    const covered = (x: string) => spellings(canonical(x)).some((f) => roots.some((r) => isInside(f, r)));
    if (!covered(p)) return false;
    if (!deep) return true;
    let dir = false;
    try {
        dir = statSync(p).isDirectory();
    } catch {
        return true;
    }
    return !dir || !linksOut(p, covered);
}

/** Is there a symlink under `dir` whose target isn't `covered`? Yes too when there's more than it will look through. */
function linksOut(dir: string, covered: (p: string) => boolean): boolean {
    const queue: [string, number][] = [[dir, 0]];
    let seen = 0;
    while (queue.length) {
        const [d, depth] = queue.shift()!;
        let entries;
        try {
            entries = readdirSync(d, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const e of entries) {
            if (++seen > 20_000) return true;
            const p = join(d, e.name);
            if (e.isSymbolicLink()) {
                if (!covered(p)) return true;
            } else if (e.isDirectory()) {
                if (depth >= 8) return true;
                queue.push([p, depth + 1]);
            }
        }
    }
    return false;
}

/**
 * The command with its here-documents' data blanked when nothing on the line can run
 * it (withoutHeredocData), for the checks that read a command's words and text: a
 * `.env` or `git push` that `cat <<EOF` writes into a file is neither read nor run.
 */
function heredocDataBlanked(cmd: string): string {
    return withoutHeredocData(cmd) ?? cmd;
}

/** The harness's own accounts folder: private whether or not any account is registered. */
function harnessAccounts(): string {
    return join(harnessHome(), "accounts");
}

/** An approval as the reviewer hears it: the exact action and what it granted, nothing model-written. */
function approvedAction(tool: Tool<any>, input: any, cwd: string, path: string | undefined, grant: SessionGrant | undefined): ApprovedAction {
    const i = (input ?? {}) as Record<string, unknown>;
    const a: ApprovedAction = { tool: tool.name, cwd };
    if (isShellTool(tool.name)) a.command = String(i.command ?? "");
    else if (path) a.path = path;
    else if (typeof i.url === "string") a.url = i.url;
    else a.input = stableStringify(input ?? {});
    if (grant) {
        const scope = [...(grant.rules ?? []), ...(grant.paths ?? []), ...(grant.hosts ?? [])];
        if (scope.length) a.scope = scope;
    }
    return a;
}

/**
 * Is the line nothing but package-manager installs from their registry, and cds into
 * folders written out? Only then does the registry open by itself. Any other program
 * on the line could send what it reads there, and even harmless-looking ones can change
 * what runs next (`printf -v PATH`), so none are allowed. Residual: the install's own
 * lifecycle scripts (postinstall) run with the registry open too; they reach only the
 * registry hosts, and installing the package is what was asked.
 */
export function installsOnly(cmd: string, cwd: string): boolean {
    const a = analyzeCommand(cmd);
    if (a.unparsable || a.hasSubstitution || a.unsafeExpansion) return false;
    // Each program written out by name: an assignment (`PATH=./bin npm i`, `PATH=x;`) or a
    // wrapper (`env`, `command`, `nice`) could run something else than the package manager.
    if (a.commands.some((c) => /^[A-Za-z_]\w*=/.test(c.argv[0] ?? "") || c.argv[0] !== effectiveArgv(c.argv)[0])) return false;
    // cds are taken as folder changes below, so they're checked here: only folders written out.
    if (a.commands.some((c) => c.argv[0] === "cd" && !installCompanion(c.argv))) return false;
    const commands = commandsWithDirs(cmd, cwd);
    if (commands.exhausted) return false;
    let installs = false;
    for (const { programs } of commands) for (const argv of programs) {
        if (installsPackages(argv)) installs = true;
        else if (!installCompanion(argv)) return false;
    }
    return installs;
}

/** Programs that read the files they're named, from the folder they start in, and run nothing. */
const PLAIN_READERS = new Set(["cat", "head", "tail", "wc", "grep", "egrep", "fgrep", "diff", "cmp", "file", "stat", "ls", "cut", "sort", "uniq", "tr", "nl", "od", "xxd", "hexdump", "strings", "md5", "md5sum", "shasum", "sha256sum"]);

/**
 * Does the line only read the files it names, from the folder it starts in? Each command is a
 * plain reader with options that name no files and don't recurse, and no word is an uncovered
 * folder, a pattern or a variable: a folder or a recursive search opens what's inside (`diff .env other`,
 * `grep -r`), and an option's value may be a filter or a list of files (`--include .env`,
 * `--files0-from=list`, `md5sum -c sums`) rather than the file it looks like.
 */
function plainReads(cmd: string, a: CommandAnalysis, cwd: string, folderCovered: (abs: string, listed: boolean) => boolean): boolean {
    if (a.unparsable || a.hasSubstitution || a.unsafeExpansion) return false;
    return a.commands.every((c) => {
        const prog = c.argv[0] ?? "";
        if (prog !== effectiveArgv(c.argv)[0] || !PLAIN_READERS.has(prog)) return false;
        const letters = new RegExp(`^-(\\d+|[${PLAIN_OPTIONS[prog] ?? ""}nivlhHsa]+)$`);
        // grep's first operand is its pattern, not a file (no option here gives it another way).
        let pattern = /^[ef]?grep$/.test(prog);
        let options = true;
        return c.argv.every((w, i) => {
            if (i === 0) return true;
            if (options && w === "--") {
                options = false;
                return true;
            }
            if (options && w.startsWith("-")) return letters.test(w);
            // Shell globs, braces and variables can become other words; `..` is taken away before a symlink
            // in front of it is followed (`link/../.env` isn't ./.env); spaces around a name are part of it.
            if (c.globbed?.includes(i) || c.expands?.includes(i) || /^~(?!\/|$)/.test(w) || /(^|\/)\.\.(\/|$)/.test(w) || w !== w.trim()) return false;
            const special = /[$`*?[{]/.test(w);
            const raw = cmd.slice(...c.spans[i]!);
            if (pattern) {
                pattern = false;
                // A regex in one quoted string is literal to the shell; an unquoted one mustn't be able to expand.
                return !special || /^'[^']*'$/.test(raw) || /^"[^"$`\\]*"$/.test(raw);
            }
            // Even quoted: the grant check reads `$X` in a name as the variable, `~` as home, which a
            // quoted or escaped `~` isn't (`'~/.env'` is a folder named ~), and `X=a` as the path a.
            if (special || w.includes("=") || (w.startsWith("~") && raw !== "~" && !raw.startsWith("~/"))) return false;
            const abs = expandPath(w, cwd);
            try {
                return !statSync(abs).isDirectory() || folderCovered(abs, prog === "ls");
            } catch {
                return true;
            }
        });
    });
}

/**
 * The files and folders granted paths lead to, by what the volume knows them as: two paths are the
 * same place only if they're the same file, however they're spelled (`/tmp` and `/private/tmp`,
 * `.ENV` and `.env` on a volume that ignores case), and never just because they look alike (`ａ` and `a`).
 */
function grantedFiles(paths: string[]): Set<string> {
    const ids = new Set<string>();
    for (const p of paths) {
        try {
            const s = statSync(p);
            ids.add(`${s.dev}:${s.ino}`);
        } catch {
            // gone since it was granted: covers nothing
        }
    }
    return ids;
}

/** Is the file at `abs` (symlinks followed all the way) one of `files`, or in one? Not if it isn't there. */
function insideFiles(abs: string, files: Set<string>): boolean {
    let p: string;
    try {
        p = realpathSync(abs);
    } catch {
        return false;
    }
    for (;;) {
        try {
            const s = statSync(p);
            if (files.has(`${s.dev}:${s.ino}`)) return true;
        } catch {
            return false;
        }
        const up = dirname(p);
        if (up === p) return false;
        p = up;
    }
}

/** Option letters, beyond those every plain reader shares, that name no file and don't recurse for that program. */
const PLAIN_OPTIONS: Record<string, string> = { cat: "bestuvA", grep: "EFwxcoq", egrep: "wxcoq", fgrep: "wxcoq" };

/** The only thing that may share a line with an install: a cd into a folder written out. */
function installCompanion(argv: string[]): boolean {
    return argv[0] === "cd" && argv.length === 2 && !/^[-~+]|[$*?[{`]/.test(argv[1]!);
}

const INSTALLS: Record<string, RegExp> = { npm: /^(install|i|ci|add)$/, pnpm: /^(install|i|ci|add)$/, bun: /^(install|add|i)$/, yarn: /^(install|add)$/, pip: /^install$/, pip3: /^install$/, uv: /^(sync|add)$/ };

/** A package manager's install-type operation, by its bare name (no `./npm`). */
function installsPackages(argv: string[]): boolean {
    const name = argv[0] ?? "";
    if (name.includes("/")) return false;
    const names = programNames(name);
    let rest = argv.slice(1);
    let prog = names.find((n) => Object.hasOwn(INSTALLS, n));
    if (!prog && names.some((n) => /^python[\d.]*$/.test(n)) && argv[1] === "-m" && /^pip3?$/.test(argv[2] ?? "")) {
        prog = "pip";
        rest = argv.slice(3);
    }
    if (!prog) return false;
    // The subcommand comes first: an option before it may take the next word as its value
    // (`npm --prefix install run x` runs a script), which can't be told apart here.
    if (rest[0]?.startsWith("-")) return false;
    const words = rest.filter((w) => !w.startsWith("-"));
    // Plain `yarn` installs; `uv pip install` too, written out with nothing between (`uv pip --directory install uninstall`).
    if (prog === "yarn" && words.length === 0) return true;
    if (prog === "uv" && rest[0] === "pip") return rest[1] === "install";
    return INSTALLS[prog]!.test(words[0] ?? "");
}

function displayHome(p: string): string {
    const h = homedir();
    return p === h ? "~" : p.startsWith(h + "/") ? "~" + p.slice(h.length) : p;
}

/** Where a command word points: `~` and $HOME expanded, a glob cut back to the folder before it. Not for words with other variables. */
function wordPath(word: string, cwd: string): string | undefined {
    const w = /^[\w-]*=/.test(word) && !word.startsWith("-") ? word.slice(word.indexOf("=") + 1) : word.replace(/^--?[\w-]+=/, "");
    if (!w || /[$`]/.test(w.replace(/^\$\{?HOME\}?(?=\/|$)/, ""))) return undefined;
    const at = w.search(/[*?[]/);
    const p = at < 0 ? w : w.slice(0, at).replace(/[^/]*$/, "") || ".";
    return expandPath(p.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir()), cwd);
}

/** The Bash tool's allowedHosts (validated by the tool before the check). */
function allowedHostsOf(input: any): string[] {
    const h = input?.allowedHosts;
    return Array.isArray(h) ? h.filter((x): x is string => typeof x === "string") : [];
}

/** For a command that needs the network but listed no hosts. */
function networkAdvice(what: string, cmd: string): string {
    const likely = likelyHosts(cmd);
    return `In auto mode, a command that uses the network (here ${what}) runs in the sandbox, which opens only the hosts the command lists. Run it again with allowedHosts naming the hosts it needs${likely.length ? ` (probably ${JSON.stringify(likely)}, unless the project uses another registry)` : ""}; the safety reviewer checks them. If it needs more than the network (SSH keys, stored credentials, other programs), set dangerouslyDisableSandbox: true instead.`;
}

/** Hosts a command probably needs: the ones in its URLs, and the default registries of the package managers in it. */
export function likelyHosts(cmd: string): string[] {
    const out = new Set<string>();
    // Userinfo may hold shell punctuation inside quotes (`'https://u:p;w@host'`); the host can't.
    for (const m of cmd.matchAll(/\bhttps?:\/\/(?:[^/\s@'"]*@)?(\[[^\]\s]+\]|[^/\s:'"`;&|()<>$\\,{}?#]+)/g)) {
        const h = m[1]!.toLowerCase().replace(/\.+$/, "");
        if (!h) continue;
        if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(h)) out.add(h);
    }
    for (const h of registryHosts(cmd)) out.add(h);
    return [...out];
}

/** The default registries of the package managers a command runs (npm, pnpm, bun, yarn, pip, uv). A project's own registry isn't one. */
export function registryHosts(cmd: string): string[] {
    const out = new Set<string>();
    for (const c of analyzeCommand(cmd).commands) {
        const argv = effectiveArgv(c.argv);
        const prog = (argv[0] ?? "").split("/").pop()!;
        if (/^(npm|npx|pnpm|pnpx|bun|bunx|yarn)$/.test(prog)) out.add("registry.npmjs.org");
        if (prog === "yarn") out.add("registry.yarnpkg.com");
        if (/^(pip3?|uv)$/.test(prog) || (/^python[\d.]*$/.test(prog) && argv[1] === "-m" && /^pip/.test(argv[2] ?? ""))) out.add("pypi.org").add("files.pythonhosted.org");
    }
    return [...out];
}

/** `//abs/dir/**` rule for the directory containing an absolute path. */
function dirGlob(abs: string): string {
    const dir = dirname(abs);
    return dir === "/" ? "//**" : `/${dir}/**`;
}
