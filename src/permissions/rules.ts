// Permission rule syntax (compatible in spirit with Claude Code):
//   Bash                     any command
//   Bash(npm test)           exact command
//   Bash(npm run test:*)     prefix match
//   Bash(git * main)         glob over the command string
//   Read(src/**)  Edit(./docs/**)  Edit(~/notes/**)  Read(//etc/hosts)
//   WebFetch(domain:example.com)
//   mcp__github   mcp__github__create_issue   mcp__github__*
//   Task(explore)
//   SimulatorControl(launch)  one of its actions

import { isAbsolute, join } from "path";
import { homedir } from "os";
import { analyzeCommand, changesShell, commandsWithDirs, effectiveArgv, isCompound, notReadOnly, shellCommands, onlySafeAssignments, programNames, runLevels, runs, SHELLS, substitutionBodies } from "./bash-safety";
import { CASE_FOLDS, canonical, spellings } from "../util/files";
import { isShellTool } from "../tools/types";
import { APP_NAME } from "../config/name";
import { currentMcpName } from "../config/legacy";

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

/**
 * The glob as a regex. `fold` (see CASE_FOLDS) applies to its literal text
 * only, so a character that folds to `*` or `?` (fullwidth ＊) stays literal.
 */
function globToRegex(glob: string, fold: (s: string) => string = (s) => s): RegExp {
    let re = "";
    let literal = "";
    const flush = () => {
        re += fold(literal).replace(/[\\^$+.()|{}[\]*?]/g, "\\$&");
        literal = "";
    };
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i]!;
        if (c !== "*" && c !== "?") {
            literal += c;
            continue;
        }
        flush();
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
        } else re += "[^/]";
    }
    flush();
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
 * Deny/ask rules (`strict` false) are matched generously: in every spelling
 * on case-insensitive filesystems, where `.ENV` and `.env`, or `ſecrets` and
 * `secrets`, are the same file (see CASE_FOLDS), and also with symlinks in
 * the rule's own path resolved. Allow rules stay exact.
 */
export function matchPath(spec: string, absPath: string, root: string, generous = false): boolean {
    const raw = pathPattern(spec, root);
    const pats = generous ? [...new Set([raw, resolvedPattern(raw)])] : [raw];
    const folds: readonly ((s: string) => string)[] = generous ? CASE_FOLDS : [(s) => s];
    return pats.some((pat) =>
        folds.some((fold) => {
            const target = fold(absPath);
            if (globToRegex(pat, fold).test(target)) return true;
            // "dir/" or "dir" should cover everything under it (at any depth for a bare name).
            if (/[*?]/.test(spec)) return false;
            const dir = pat.replace(/\/+$/, "");
            return globToRegex(dir, fold).test(target) || globToRegex(dir + "/**", fold).test(target);
        }),
    );
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
    if (mode === "deny") return analyzeCommand(command).commands.length > 0 && denyMatches(spec, command, 0);
    // A rule that is the line itself, word for word, is a yes to exactly that line, whatever is on it.
    if (!spec.includes("*") && command.trim() === spec) return true;
    // What runs, as the shell reads it: a here-document's data isn't a command to approve (or to hide one).
    const a = shellCommands(command);
    if (!a.commands.length) return false;
    // A prefix rule must not approve whatever hides in $(...) or backticks:
    // `Bash(npm test:*)` vs `npm test $(rm -rf src)`. Only an exact rule can.
    if (a.hasSubstitution || a.unparsable || a.unsafeExpansion) return !spec.includes("*") && command.trim() === spec;
    // Nor a loop, a conditional, a group or a negation by the shell's own word for it: `Bash(!:*)` is not a rule
    // for whatever is negated, nor `Bash(do:*)` for a loop's body. Its exact text, or a rule for anything at all.
    if (spec !== "*" && isCompound(a.commands)) return command.trim() === spec;
    // `GIT_EXTERNAL_DIFF=cmd git diff` is not the `git diff` the user allowed.
    if (!a.commands.every((c) => onlySafeAssignments(c.argv))) return false;
    return a.commands.every((c) => matchCommandSpec(spec, effectiveArgv(c.argv).join(" ")));
}

/**
 * The rule's program word in each spelling a program word has (programWords),
 * for matching it against those. A spelling that would turn it into a
 * pattern (fullwidth ＊ or ：) isn't used.
 */
function specSpellings(spec: string): string[] {
    const name = spec.match(/^[^\s*?:]*/)![0];
    const dir = name.slice(0, name.lastIndexOf("/") + 1);
    // Folding never adds a `/`, so each spelling has the rule's directories.
    const others = [...programNames(name).map((n) => dir + n), ...spellings(name)].filter((n) => !/[\s*?:]/.test(n));
    return [...new Set([spec, ...others.map((n) => n + spec.slice(name.length))])];
}

/**
 * A program word as the deny rules see it: as written, in each spelling the
 * volume finds it by (`/BIN/RM` is /bin/rm on macOS), and its name alone in
 * each (`rm`), so `Bash(rm:*)` and `Bash(/bin/rm:*)` both cover it.
 */
function programWords(word: string): string[] {
    return [...new Set([word, ...spellings(word), ...programNames(word)])];
}

/** The programs of the last command asked about (each rule of a list asks about the same one). */
let located: { command: string; programs: string[][] } | undefined;

/** Every program a command line runs, compound commands' bodies included (commandsWithDirs). */
function bodyPrograms(command: string): string[][] {
    if (located?.command !== command) located = { command, programs: commandsWithDirs(command, undefined).flatMap((c) => c.programs).filter((argv) => argv.length > 0) };
    return located.programs;
}

/**
 * Deny if ANY part matches: the whole string, each program a simple command
 * runs (through `env`, `exec`, `nohup` and other wrappers; with a
 * path-qualified program reduced to its name, so `/bin/rm` hits `rm`; and in
 * each spelling the volume finds it by, so on macOS `RM` hits `rm` too), and
 * recursively the bodies of substitutions and `sh -c` / `eval` strings.
 */
function denyMatches(spec: string, command: string, depth: number): boolean {
    if (matchCommandSpec(spec, command)) return true;
    const specs = specSpellings(spec);
    // What runs inside a loop, a conditional, a group, a function or a `case` too (`for f in *; do rm $f; done`),
    // as the other checks that protect find it.
    if (depth === 0 && bodyPrograms(command).some((argv) => programWords(argv[0]!).some((name) => specs.some((s) => matchCommandSpec(s, [name, ...argv.slice(1)].join(" ")))))) return true;
    for (const c of analyzeCommand(command).commands) {
        for (const { argv } of runLevels(c.argv)) {
            const rest = argv.slice(1);
            for (const name of programWords(argv[0]!)) {
                const text = [name, ...rest].join(" ");
                if (specs.some((s) => matchCommandSpec(s, text))) return true;
            }
            if (depth < 4) {
                const ci = argv.findIndex((x) => /^-[a-zA-Z]*c$/.test(x));
                if (runs(argv[0], ...SHELLS) && ci > 0 && argv[ci + 1] !== undefined && denyMatches(spec, argv[ci + 1]!, depth + 1)) return true;
                if (runs(argv[0], "eval") && argv.length > 1 && denyMatches(spec, argv.slice(1).join(" "), depth + 1)) return true;
            }
        }
    }
    if (depth < 4) for (const body of substitutionBodies(command)) if (denyMatches(spec, body, depth + 1)) return true;
    // The shell joins escaped newlines before it reads `$(`: `$\⏎(touch x)` runs touch, also in an
    // unquoted here-document. Joined everywhere, quotes or not, so this can only find more.
    const joined = command.replace(/\\\n/g, "");
    if (depth < 4 && joined !== command) for (const body of substitutionBodies(joined)) if (denyMatches(spec, body, depth + 1)) return true;
    return false;
}

export interface RuleTarget {
    toolName: string;
    command?: string;
    path?: string;
    url?: string;
    agentType?: string;
    /** SimulatorControl's action (launch, shutdown, …). */
    action?: string;
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
    // A rule written for Harness's own MCP server (mcp__harness__…) covers Cavvy's too, and still any server named harness.
    if (tool.startsWith("mcp__")) return mcpToolMatches(tool, t.toolName) || mcpToolMatches(currentMcpName(tool, APP_NAME), t.toolName);
    const toolMatches =
        tool === "*" ||
        tool === t.toolName ||
        // A Monitor command runs like a Bash one: Bash rules cover it too.
        (tool === "Bash" && isShellTool(t.toolName)) ||
        (tool === "Edit" && EDIT_TOOLS.has(t.toolName)) ||
        (tool === "Read" && READ_TOOLS.has(t.toolName)) ||
        // Opening a page in the browser is as much a visit to its host as fetching it: WebFetch(domain:…) rules cover it.
        (tool === "WebFetch" && t.toolName === "BrowserNavigate" && Boolean(rule.spec));
    if (!toolMatches) return false;
    if (!rule.spec) return true;
    if (isShellTool(t.toolName)) return t.command !== undefined && bashRuleMatches(rule.spec, t.command, mode);
    if (EDIT_TOOLS.has(t.toolName) || READ_TOOLS.has(t.toolName)) return t.path !== undefined && matchPath(rule.spec, t.path, root, mode === "deny");
    if (t.toolName === "WebFetch" || t.toolName === "BrowserNavigate") {
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
    if (t.toolName === "SimulatorControl") return rule.spec === t.action;
    return false;
}

/**
 * Could a pattern (absolute, "/"-separated, ** spanning any number of
 * folders) match the folder or anything inside it? Walks both segment by
 * segment: once the folder's segments run out, whatever is left of the
 * pattern can still name something inside it.
 */
function couldMatchWithin(pattern: string[], dir: string[], fold: (s: string) => string): boolean {
    if (!dir.length) return true;
    if (!pattern.length) return false;
    const [p, ...restP] = pattern;
    if (p === "**") return couldMatchWithin(restP, dir, fold) || couldMatchWithin(pattern, dir.slice(1), fold);
    // ** inside a name (src/**.pem) spans folders too: past a folder that matches its start, it can reach anything.
    const span = p!.indexOf("**");
    if (span >= 0) return globToRegex(p!.slice(0, span) + "*", fold).test(dir[0]!);
    return globToRegex(p!, fold).test(dir[0]!) && couldMatchWithin(restP, dir.slice(1), fold);
}

/**
 * For a grant of a whole folder (a sandbox asking to read or write it): the
 * first deny rule that could match the folder or anything in it. Paths are
 * compared as written and with symlinks resolved, on both sides. A write
 * grant is checked against read rules too, since writing a folder exposes
 * it. Rules for other tools don't count.
 */
export function deniedWithin(rules: string[], dir: string, root: string, access: "read" | "write"): string | undefined {
    // "/a/b" -> ["", "a", "b"]; the root itself is just [""].
    const segments = (p: string) => p.replace(/\/+$/, "").split("/");
    const dirs = [...new Set([dir, canonical(dir)])];
    for (const raw of rules) {
        const r = parseRule(raw);
        const kinds = r.tool === "*" ? ["Edit", "Read"] : EDIT_TOOLS.has(r.tool) ? ["Edit"] : READ_TOOLS.has(r.tool) ? ["Read"] : [];
        if (!kinds.includes("Read") && !(access === "write" && kinds.includes("Edit"))) continue;
        if (!r.spec) return raw;
        const pat = pathPattern(r.spec, root);
        // A plain path also covers everything under it, as matchPath has it.
        const pats = [pat, resolvedPattern(pat)].flatMap((x) => (/[*?]/.test(r.spec!) ? [x] : [x, `${x.replace(/\/+$/, "")}/**`]));
        // In every spelling, as matchPath has it.
        if (CASE_FOLDS.some((f) => pats.some((x) => dirs.some((d) => couldMatchWithin(segments(x), segments(f(d)), f))))) return raw;
    }
    return undefined;
}

export function findMatch(rules: string[], t: RuleTarget, root: string, mode: "allow" | "deny"): string | undefined {
    for (const r of rules) if (ruleMatches(parseRule(r), t, root, mode)) return r;
    return undefined;
}

/** An allow rule that is the shell line itself, word for word: the user's yes to exactly that line. */
export function exactRule(rules: string[], t: RuleTarget): boolean {
    const line = t.command?.trim();
    return line !== undefined && rules.map(parseRule).some((r) => r.spec === line && (r.tool === "Bash" || r.tool === "*" || r.tool === t.toolName));
}

/** An allow rule for every shell command there is (`Bash`, `Bash(*)`): no program is named for it to be about. */
export function blanketRule(rules: string[], t: RuleTarget): boolean {
    return rules.map(parseRule).some((r) => (!r.spec || r.spec === "*") && (r.tool === "Bash" || r.tool === "*" || r.tool === t.toolName));
}

/**
 * The allow rule that lets a shell command line run. One rule can cover the whole line (findMatch). Rules also add
 * up: each simple command on the line matches one of them (`git add -A && git commit -m x` under a rule for
 * each), or the rest of the line is read-only as the read-only check judges a line (`cd pkg && npm test` under
 * `Bash(npm test:*)`): no file written through a redirect, no variable set and then used, no `$_`, no glob that can
 * turn into an option. A command of the shell's own that changes what follows it is never the matched one. That's what "don't ask again" saves for such a line (suggestBashRules), so the same line
 * runs next time. The first rule that matched is named. A line with a substitution, or an expansion rules can't
 * see into, is still covered only by its exact text; a loop or a conditional by no rule but that (its words
 * aren't programs).
 */
export function allowedCommand(rules: string[], t: RuleTarget, root: string, o: { readOnlyRest?: boolean } = {}): string | undefined {
    const whole = findMatch(rules, t, root, "allow");
    if (whole || t.command === undefined || !isShellTool(t.toolName)) return whole;
    const specs = rules.map(parseRule).filter((r) => r.spec && (r.tool === "Bash" || r.tool === "*" || r.tool === t.toolName));
    if (!specs.length) return undefined;
    const a = shellCommands(t.command);
    if (!a.commands.length || a.hasSubstitution || a.unparsable || a.unsafeExpansion || isCompound(a.commands)) return undefined;
    if (!a.commands.every((c) => onlySafeAssignments(c.argv))) return undefined;
    // One of the shell's own commands that changes what the next ones do (`export`, `read`, `cd`, `pushd`, `hash`)
    // is never one a rule answers for here: `export X=-delete; find . $X`, `pushd ~ && make > .zshrc`.
    const covering = a.commands.map((c) => (changesShell(c.argv) ? undefined : specs.find((r) => matchCommandSpec(r.spec!, effectiveArgv(c.argv).join(" ")))?.raw));
    const first = covering.find((r) => r !== undefined);
    if (first === undefined) return undefined;
    if (covering.every((r) => r !== undefined)) return first;
    // What no rule covers is judged with the rest of its line, not word by word: `npm test; echo > README.md`
    // under a rule for `npm test` writes a file, whatever `echo` is by itself. Not at all where a read-only
    // command wouldn't simply run (`readOnlyRest` false: auto mode keeps those in the sandbox, and a rule's line
    // runs outside it).
    return o.readOnlyRest !== false && notReadOnly(t.command, (i) => covering[i] !== undefined) === undefined ? first : undefined;
}
