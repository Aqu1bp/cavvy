// Static analysis of shell commands: split compound commands, recognise
// read-only commands, flag catastrophic ones, and suggest allow-rule prefixes.

import { closeSync, existsSync, lstatSync, openSync, readlinkSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { CASE_INSENSITIVE_FS, spellings } from "../util/files";

export interface SimpleCommand {
    text: string;
    argv: string[];
    /** The operator before it: ";", "\n", "&&", "||", "|" or "&" (none for the first). */
    after?: string;
    /**
     * A redirection on it opens a file (`< f`, `> f`, `2>> f`) or copies a
     * descriptor past stderr (`<&9`, `>&3`, closed unless something opened
     * it): the shell can fail on that before it runs.
     */
    opensFile?: true;
}

export interface CommandAnalysis {
    commands: SimpleCommand[];
    /** $(...), backticks, <(...) etc. Can't be analysed statically. */
    hasSubstitution: boolean;
    /** Output redirection to a file (not /dev/null or a fd). */
    writesFiles: boolean;
    /** Parse trouble (unbalanced quotes). */
    unparsable: boolean;
    /**
     * Expansions we don't model and that can run code or change the words:
     * unquoted parentheses (zsh glob qualifiers `*(e:cmd:)`, `=(cmd)`,
     * subshells, extglob), brace expansion (`{-o,out}`), `$[...]` arithmetic,
     * and `${...}` with flags or operators (zsh `${(e)x}`, bash `${x@P}`).
     */
    unsafeExpansion: boolean;
    /** Targets of `>` / `>>` / `>|` / `>&file` redirections, quotes removed. */
    redirects: string[];
    /** The operator after the last command, if the line ends with one (`cmd &`). */
    trailing?: string;
}

/** `${NAME}`, `${1}`, `${#NAME}`, `${?}`... at `i` (pointing at `$`) are plain lookups. */
const ANSI_C_SIMPLE: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"', "?": "?" };

/**
 * Decode an ANSI-C quoted string (`$'...'`, bash and zsh) whose body starts
 * at `start`. Returns the text and the index of the closing quote
 * (cmd.length when unterminated).
 */
function ansiC(cmd: string, start: number): [string, number] {
    let out = "";
    let i = start;
    for (; i < cmd.length; i++) {
        const c = cmd[i]!;
        if (c === "'") break;
        if (c !== "\\" || i + 1 >= cmd.length) {
            out += c;
            continue;
        }
        const e = cmd[++i]!;
        const hex = (max: number) => cmd.slice(i + 1).match(new RegExp(`^[0-9a-fA-F]{1,${max}}`))?.[0];
        if (e in ANSI_C_SIMPLE) out += ANSI_C_SIMPLE[e];
        else if (/[0-7]/.test(e)) {
            const m = cmd.slice(i).match(/^[0-7]{1,3}/)![0];
            out += String.fromCharCode(parseInt(m, 8) & 0xff);
            i += m.length - 1;
        } else if (e === "x" || e === "u" || e === "U") {
            const m = hex(e === "x" ? 2 : e === "u" ? 4 : 8);
            if (m) {
                out += String.fromCodePoint(Math.min(parseInt(m, 16), 0x10ffff));
                i += m.length;
            } else out += "\\" + e;
        } else if (e === "c" && i + 1 < cmd.length) out += String.fromCharCode(cmd.charCodeAt(++i) & 0x1f);
        else out += "\\" + e;
    }
    return [out, i];
}

function plainBraceParam(cmd: string, i: number): boolean {
    const close = cmd.indexOf("}", i + 2);
    if (close < 0) return false;
    return /^(#?[A-Za-z_][A-Za-z0-9_]*|[0-9]+|[#?@*!$-])$/.test(cmd.slice(i + 2, close));
}

/** Tokenise and split on control operators, respecting quotes and escapes. */
export function analyzeCommand(cmd: string): CommandAnalysis {
    const commands: SimpleCommand[] = [];
    let hasSubstitution = false;
    let writesFiles = false;
    let unsafeExpansion = false;
    const redirects: string[] = [];
    let argv: string[] = [];
    let word = "";
    let wordStarted = false;
    /** Some of the word was quoted or escaped (so `''2>x`'s 2 is an argument, not an fd). */
    let wordQuoted = false;
    let text = "";
    let quote: "'" | '"' | null = null;
    /** The operator after the last command pushed (`a &&` then a blank line: still &&). */
    let lastOp: string | undefined;
    let opensFile = false;

    const endWord = () => {
        if (wordStarted) argv.push(word);
        word = "";
        wordStarted = false;
        wordQuoted = false;
    };
    const endCommand = (op?: string) => {
        endWord();
        if (argv.length) {
            commands.push({ text: text.trim(), argv, ...(lastOp !== undefined ? { after: lastOp } : {}), ...(opensFile ? { opensFile: true as const } : {}) });
            lastOp = op;
        }
        argv = [];
        text = "";
        opensFile = false;
    };

    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i]!;
        const n = cmd[i + 1];
        if (quote === "'") {
            if (c === "'") quote = null;
            else word += c;
            text += c;
            continue;
        }
        if (quote === '"') {
            if (c === "\\" && n !== undefined) {
                word += n;
                text += c + n;
                i++;
                continue;
            }
            if (c === '"') quote = null;
            else {
                if (c === "`" || (c === "$" && n === "(")) hasSubstitution = true;
                if (c === "$" && (n === "[" || (n === "{" && !plainBraceParam(cmd, i)))) unsafeExpansion = true;
                word += c;
            }
            text += c;
            continue;
        }
        if (c === "\\" && n !== undefined) {
            if (n === "\n") {
                i++;
                continue;
            }
            word += n;
            wordStarted = true;
            wordQuoted = true;
            text += c + n;
            i++;
            continue;
        }
        // $'\x2do' and (bash) $"-o" decode to text a plain reading misses
        // (`sort $'-o' out`): argv gets the decoded word so deny rules see it,
        // and the command is never read-only.
        if (c === "$" && n === "'") {
            const [decoded, end] = ansiC(cmd, i + 2);
            word += decoded;
            wordStarted = true;
            wordQuoted = true;
            unsafeExpansion = true;
            text += cmd.slice(i, end + 1);
            if (end >= cmd.length) quote = "'";
            i = end;
            continue;
        }
        if (c === "$" && n === '"') {
            unsafeExpansion = true;
            text += c;
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            wordStarted = true;
            wordQuoted = true;
            text += c;
            continue;
        }
        if (c === "`" || (c === "$" && n === "(") || ((c === "<" || c === ">") && n === "(")) {
            hasSubstitution = true;
        }
        if (c === "$" && (n === "[" || (n === "{" && !plainBraceParam(cmd, i)))) unsafeExpansion = true;
        if (c === "(" || c === ")") unsafeExpansion = true;
        // Only space, tab and newline separate words: to the shell `\r`, `\v` and Unicode spaces are letters.
        if (c === "{" && /^\{[^ \t\n;|&{}]*(,|\.\.)[^ \t\n;|&{}]*\}/.test(cmd.slice(i))) unsafeExpansion = true;
        if (c === "#" && !wordStarted && (i === 0 || /[ \t\n]/.test(cmd[i - 1]!))) {
            // comment to end of line
            while (i < cmd.length && cmd[i] !== "\n") i++;
            endCommand(i < cmd.length ? "\n" : undefined);
            continue;
        }
        if (c === ";" || c === "\n" || c === "|" || c === "&") {
            // `2>&1` / `>&2`: & directly after a redirection is not a separator.
            if (c === "&" && (cmd[i - 1] === ">" || cmd[i - 1] === "<")) {
                word += c;
                text += c;
                continue;
            }
            const doubled = (c === "|" || c === "&") && n === c;
            if (doubled) i++;
            endCommand(doubled ? c + c : c);
            continue;
        }
        if (c === ">" || c === "<") {
            // `2>`, `2>>`, `0<`: an unquoted digit right before the operator is the fd, not an argument.
            // Only one digit: zsh passes `10>x`'s 10 to the command (bash takes it as fd 10).
            if (/^\d$/.test(word) && !wordQuoted) {
                word = "";
                wordStarted = false;
            }
            endWord();
            // `< f` and `<> f` open a file, `<&9` needs fd 9 open; `<<`, `<<<`, `<&0` and `<&-` can't fail.
            if (c === "<" && n !== "<" && cmd[i - 1] !== "<" && n !== "(" && !(n === "&" && /^&([012]|-)(?![0-9])/.test(cmd.slice(i + 1)))) opensFile = true;
            // Where the redirection ends when nothing after the operator is an argument (`>&2`, `>/dev/null`).
            let end = i;
            if (c === ">") {
                // Look at the redirection target.
                let j = i + 1;
                if (cmd[j] === ">" || cmd[j] === "|") j++;
                const fd = cmd[j] === "&" ? /^(\d+|-)(?=$|[ \t\n;|&)<>])/.exec(cmd.slice(j + 1)) : null;
                if (fd) {
                    // >&2 / >&- style: fd duplication or close, harmless; past stderr (>&3) only if it's open
                    end = j + fd[0].length;
                    if (!/^([012]|-)$/.test(fd[1]!)) opensFile = true;
                } else {
                    if (cmd[j] === "&") j++; // `>&file` sends stdout and stderr to a file
                    while (cmd[j] === " " || cmd[j] === "\t") j++;
                    // The whole word, however its pieces are quoted: `"src"/../../out` is one target.
                    const raw = cmd.slice(j).match(/^(?:"[^"]*"|'[^']*'|[^ \t\n;|&<>"'])+/)?.[0] ?? "";
                    const target = raw.replace(/["']/g, "");
                    if (/^\/dev\/(null|stdout|stderr)$/.test(target)) end = j + raw.length - 1;
                    else {
                        writesFiles = true;
                        opensFile = true;
                        redirects.push(target);
                    }
                }
            }
            text += cmd.slice(i, end + 1);
            i = end;
            continue;
        }
        if (c === " " || c === "\t") {
            endWord();
            text += c;
            continue;
        }
        word += c;
        wordStarted = true;
        text += c;
    }
    const unparsable = quote !== null;
    endCommand();
    return { commands, hasSubstitution, writesFiles, unparsable, unsafeExpansion, redirects, ...(lastOp !== undefined ? { trailing: lastOp } : {}) };
}

/** Strip leading env assignments (FOO=bar cmd) and wrappers like `time`. */
export function effectiveArgv(argv: string[]): string[] {
    let i = 0;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
    const rest = argv.slice(i);
    if (rest[0] === "time" || rest[0] === "nice" || rest[0] === "command") return effectiveArgv(rest.slice(1));
    return rest;
}

// Variables that only change formatting. Anything else (GIT_EXTERNAL_DIFF,
// PAGER, LD_PRELOAD, NODE_OPTIONS, ...) can make a harmless command run code.
const SAFE_ENV = /^(LANG|LANGUAGE|LC_[A-Z]+|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|COLUMNS|LINES|TERM)=/;

/** True when every leading `NAME=value` (including after time/nice/command) is a formatting-only variable. */
export function onlySafeAssignments(argv: string[]): boolean {
    let i = 0;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) {
        if (!SAFE_ENV.test(argv[i]!)) return false;
        i++;
    }
    const rest = argv.slice(i);
    if (rest[0] === "time" || rest[0] === "nice" || rest[0] === "command") return onlySafeAssignments(rest.slice(1));
    return true;
}

// A program given by path only counts as a known read-only tool when it lives
// in a system directory; `./cat` could be anything the model just wrote.
const SYSTEM_BIN = new Set(["/bin", "/usr/bin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/sbin", "/sbin"]);

const READ_ONLY_PROGRAMS = new Set([
    "ls", "cat", "head", "tail", "wc", "pwd", "echo", "printf", "which", "whereis", "type", "file", "stat", "du", "df",
    "tree", "grep", "egrep", "fgrep", "rg", "ag", "fd", "sort", "uniq", "cut", "tr", "diff", "cmp", "comm", "date", "cal",
    "whoami", "id", "uname", "hostname", "ps", "basename", "dirname", "realpath", "readlink", "jq", "nl", "column",
    "true", "false", "test", "[", "sleep", "cd", "md5", "md5sum", "shasum", "sha256sum", "sha1sum", "base64", "hexdump",
    "xxd", "od", "strings", "uptime", "sw_vers", "arch", "nproc", "lsof", "pgrep", "ping", "dig", "nslookup", "host",
    "man", "tldr", "seq", "expr", "bc", "yes", "printenv",
]);

const GIT_READ_ONLY = new Set([
    "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "blame", "describe", "shortlog", "reflog",
    "grep", "cat-file", "merge-base", "name-rev", "for-each-ref", "show-ref", "whatchanged", "count-objects", "version", "help",
]);

// Asking a well-known program for its version or help is harmless. Only
// dash forms (`rm help` deletes a file called "help"), and only for tools we
// know: `./deploy.sh --help` would just run the script.
const KNOWN_CLIS = new Set([
    "rustc", "rustup", "java", "javac", "tsc", "eslint", "prettier", "jest", "vitest", "pytest", "ruff", "black", "mypy",
    "gcc", "g++", "clang", "cmake", "bat", "yq", "curl", "wget", "ssh", "openssl", "sqlite3", "psql", "mysql", "php",
    "perl", "lua", "zig", "tar", "zip", "unzip", "gzip", "rsync", "ffmpeg", "bash", "zsh", "sh",
]);
const VERSION_FLAGS = new Set(["--version", "-V", "--help", "-h"]);
const INTERPRETER_VERSION_FLAGS = new Set(["--version", "-v", "-V", "--help", "-h"]);

const positional = (args: string[]) => args.filter((a) => !a.startsWith("-") || a === "-");

// sed commands that only print or edit the pattern space. `w`/`W` write
// files, `e` and `s///e` run commands, `r`/`R` read other files.
const SED_ADDR = String.raw`(?:\d+|\$|\/(?:[^\/\\]|\\.)*\/)`;
const SED_CMD = new RegExp(
    String.raw`^\s*(?:${SED_ADDR}(?:\s*,\s*(?:${SED_ADDR}|[+~]\d+))?)?\s*!?\s*(?:[pPl=dDnNgGhHxzq]|s\/(?:[^\/\\]|\\.)*\/(?:[^\/\\]|\\.)*\/[gpiImM0-9]*)?\s*$`,
);

function sedScriptSafe(script: string): boolean {
    return script.split(/[;\n{}]/).every((part) => SED_CMD.test(part));
}

function sedReadOnly(args: string[]): boolean {
    const scripts: string[] = [];
    let explicit = false;
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--") break;
        if (a.startsWith("--")) {
            if (a.startsWith("--in-place") || a.startsWith("--file")) return false;
            if (a === "--expression") {
                scripts.push(args[++i] ?? "");
                explicit = true;
            } else if (a.startsWith("--expression=")) {
                scripts.push(a.slice(13));
                explicit = true;
            }
            continue;
        }
        if (!a.startsWith("-") || a === "-") continue;
        // Short options: -i edits in place, -f reads a script we can't see,
        // -e takes the script (attached or as the next argument).
        for (let k = 1; k < a.length; k++) {
            const c = a[k]!;
            if (c === "i" || c === "f") return false;
            if (c === "e") {
                const rest = a.slice(k + 1);
                scripts.push(rest || (args[++i] ?? ""));
                explicit = true;
                break;
            }
        }
    }
    if (!explicit) {
        const first = positional(args)[0];
        if (first === undefined) return false;
        scripts.push(first);
    }
    return scripts.every(sedScriptSafe);
}

// Global git options that don't change what runs. `-c`, `--config-env`,
// `--exec-path`, `-p` (pager) and friends can all execute commands.
const GIT_SAFE_GLOBAL = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]);

/** `git branch` options that only filter or format the listing. */
const BRANCH_DISPLAY = new Set(["-a", "--all", "-r", "--remotes", "-v", "-vv", "--verbose", "--show-current", "-i", "--ignore-case", "--no-color", "--no-column", "--no-abbrev", "--omit-empty"]);
/** Filters that put `git branch` in list mode, with the commit they take (`--merged` and friends default to HEAD). */
const BRANCH_FILTERS = new Set(["--merged", "--no-merged", "--contains", "--no-contains", "--points-at"]);

/**
 * `git branch` that only lists. Its other words are patterns only in list
 * mode (--list, or a filter such as --merged, which takes a commit); without
 * one, `git branch -v name` and `git branch --sort=x name` create `name`.
 */
function gitBranchListsOnly(args: string[]): boolean {
    let list = false;
    let words = 0;
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--") {
            words += args.length - i - 1;
            break;
        }
        if (!a.startsWith("-") || a === "-") {
            words++;
            continue;
        }
        if (BRANCH_DISPLAY.has(a)) continue;
        if (a === "--list" || /^-[arvil]*l[arvil]*$/.test(a)) {
            list = true;
            continue;
        }
        if (/^-[arvi]+$/.test(a)) continue;
        if (BRANCH_FILTERS.has(a)) {
            list = true;
            // The commit: --points-at needs one; the others take the next word unless it's an option.
            if (a === "--points-at" || (args[i + 1] !== undefined && !args[i + 1]!.startsWith("-"))) i++;
            continue;
        }
        const name = a.match(/^--([a-z-]+)=/)?.[1];
        if (name && BRANCH_FILTERS.has(`--${name}`)) {
            list = true;
            continue;
        }
        if (name && ["sort", "format", "color", "column", "abbrev"].includes(name)) continue;
        if (a === "--sort" || a === "--format") {
            i++;
            continue;
        }
        if (a === "--color" || a === "--column") continue;
        return false;
    }
    return list || words === 0;
}

function gitReadOnly(args: string[]): boolean {
    let i = 0;
    while (i < args.length && args[i]!.startsWith("-")) {
        if (args[i] === "-C") i += 2;
        else if (GIT_SAFE_GLOBAL.has(args[i]!)) i++;
        else return false;
    }
    const sub = args[i];
    if (!sub) return false;
    const subArgs = args.slice(i + 1);
    // Options that write files or run programs even on read-only subcommands.
    if (subArgs.some((a) => /^--(output|ext-diff|open-files-in-pager)(=|$)/.test(a) || (sub === "grep" && /^-[a-zA-Z]*O/.test(a)))) return false;
    if (sub === "reflog") return !["expire", "delete", "drop"].includes(subArgs[0] ?? "");
    if (GIT_READ_ONLY.has(sub)) return true;
    if (sub === "branch") return gitBranchListsOnly(subArgs);
    if (sub === "remote") return subArgs.every((a) => a === "-v" || a === "--verbose") || ((subArgs[0] === "show" || subArgs[0] === "get-url") && subArgs.slice(1).every((a) => !a.startsWith("-") || a === "-n" || a === "--all" || a === "--push"));
    if (sub === "tag") return subArgs.length === 0 || subArgs.every((a) => a === "-l" || a === "--list" || a.startsWith("--sort") || a === "-n");
    if (sub === "stash") return subArgs[0] === "list" || subArgs[0] === "show";
    if (sub === "config") {
        const READ = ["--get", "--get-all", "--get-regexp", "--list", "-l"];
        const OK = [...READ, "--show-origin", "--show-scope", "--global", "--local", "--system", "--name-only", "-z", "--null", "--includes", "--no-includes"];
        return subArgs.some((a) => READ.includes(a)) && subArgs.every((a) => !a.startsWith("-") || OK.includes(a) || a.startsWith("--type=")) && positional(subArgs).length <= 2;
    }
    if (sub === "worktree") return subArgs[0] === "list";
    return false;
}

/** Is this single command free of side effects? */
export function isReadOnlySimple(argv0: string[]): boolean {
    if (!onlySafeAssignments(argv0)) return false;
    const argv = effectiveArgv(argv0);
    const prog = argv[0];
    if (!prog) return true;
    const slash = prog.lastIndexOf("/");
    if (slash >= 0 && !SYSTEM_BIN.has(prog.slice(0, slash))) return false;
    const base = prog.slice(slash + 1);
    const args = argv.slice(1);
    if (args.length === 1 && VERSION_FLAGS.has(args[0]!) && (READ_ONLY_PROGRAMS.has(base) || TWO_WORD.has(base) || KNOWN_CLIS.has(base))) return true;
    // `printf -v 'a[$(cmd)]' x`: zsh evaluates the subscript.
    if (base === "printf" && args.some((a) => /^-[a-zA-Z]*v/.test(a))) return false;
    if (base === "find") return !args.some((a) => /^-(exec|execdir|ok|okdir|delete|fprint|fprintf|fls)/.test(a));
    if (base === "sed") return sedReadOnly(args);
    if (base === "sort") return !args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith("--output") || a.startsWith("--compress-program"));
    if (base === "uniq" || base === "xxd") return positional(args).length <= 1; // a second operand is the output file
    if (base === "base64") return !args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith("--output"));
    if (base === "rg") return !args.some((a) => /^--(pre|hostname-bin)(=|$)/.test(a));
    if (base === "ag") return !args.some((a) => a.startsWith("--pager"));
    if (base === "fd") return !args.some((a) => /^-[a-zA-Z]*[xX]/.test(a) || /^--exec(-batch)?(=|$)/.test(a));
    if (base === "tree") return !args.some((a) => /^-[a-zA-Z]*o/.test(a) || a.startsWith("--output"));
    if (base === "file") return !args.some((a) => /^-[a-zA-Z]*C/.test(a) || a === "--compile");
    if (base === "man") return args.every((a) => !a.startsWith("-") || ["-k", "-f", "-a", "-w"].includes(a));
    if (base === "hostname") return positional(args).length === 0; // `hostname name` sets it
    if (base === "ls") return true;
    if (base === "git") return gitReadOnly(args);
    if (["npm", "pnpm", "yarn", "bun"].includes(base)) {
        const sub = args[0];
        return ["ls", "list", "view", "info", "outdated", "why", "explain", "audit"].includes(sub ?? "") && !args.includes("fix");
    }
    if (base === "cargo") return ["tree", "metadata", "search"].includes(args[0] ?? "");
    if (base === "go") {
        if (args.some((a) => /^--?(toolexec|vettool|exec|overlay|modfile)(=|$)/.test(a))) return false;
        if (args[0] === "env" && args.some((a) => a === "-w" || a === "-u")) return false;
        return ["version", "env", "list", "doc", "vet"].includes(args[0] ?? "");
    }
    if (base === "docker") return ["ps", "images", "logs", "inspect", "version", "info"].includes(args[0] ?? "");
    if (base === "kubectl") return ["get", "describe", "logs", "version", "explain", "api-resources", "config"].includes(args[0] ?? "") && !(args[0] === "config" && !["view", "get-contexts", "current-context"].includes(args[1] ?? ""));
    if (base === "gh") return ["status"].includes(args[0] ?? "") || (["pr", "issue", "run", "repo", "release"].includes(args[0] ?? "") && ["list", "view", "status", "diff", "checks"].includes(args[1] ?? ""));
    if (base === "brew") return ["list", "info", "search", "outdated", "deps", "--prefix", "config"].includes(args[0] ?? "");
    if (base === "pip" || base === "pip3") return ["list", "show", "freeze"].includes(args[0] ?? "");
    if (base === "node" || base === "python" || base === "python3" || base === "ruby") return args.length === 1 && INTERPRETER_VERSION_FLAGS.has(args[0]!);
    // `env CMD` runs CMD; only the bare form just prints.
    if (base === "env") return args.length === 0;
    if (base === "printenv") return args.every((a) => !a.startsWith("-"));
    if (base === "awk" || base === "gawk") return false; // can write files / run commands
    if (base === "xargs") return false;
    return READ_ONLY_PROGRAMS.has(base);
}

export function isReadOnlyCommand(cmd: string): boolean {
    const a = analyzeCommand(cmd);
    if (a.unparsable || a.hasSubstitution || a.writesFiles || a.unsafeExpansion) return false;
    if (!a.commands.length) return true;
    return a.commands.every((c) => isReadOnlySimple(c.argv));
}

const GREPS = new Set(["grep", "egrep", "fgrep", "zgrep", "ggrep", "rg"]);
const SHELL_SYNTAX = /(^|[\s;&|])(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|exit|return|set|setopt|trap)(?=$|[\s;&|])|[{}]|pipe_?fail/i;
/** Builtins that can redefine what `grep` runs, or hide the shell's own errors (`exec 2>/dev/null`). */
const RESHAPES_SHELL = new Set(["eval", "alias", "source", ".", "exec", "builtin", "emulate", "unalias", "unset", "functions", "autoload", "hash", "enable", "disable", "shopt"]);

/**
 * The search program (grep, rg, git grep) whose exit status is the whole
 * command's, when the text makes that certain: it's last, it ran (not after
 * `&&`, where an earlier failure ends the list with its own status), and it
 * isn't backgrounded, negated (`! a | grep x`) or behind pipefail, and no
 * redirection in its pipeline opens a file (`grep x < f`: if the shell can't
 * open it, grep never runs and the status 1 is the shell's). Their status 1
 * means "no match", not a failure. `piped`: other commands feed it, and their
 * failures don't show in its status.
 */
export function finalSearch(cmd: string): { name: string; piped: boolean } | undefined {
    const a = analyzeCommand(cmd);
    if (a.unparsable || a.hasSubstitution || a.unsafeExpansion || SHELL_SYNTAX.test(cmd) || !a.commands.length) return undefined;
    if (a.commands.some((c) => RESHAPES_SHELL.has(effectiveArgv(c.argv)[0] ?? ""))) return undefined;
    if (a.trailing !== undefined && a.trailing !== ";" && a.trailing !== "\n") return undefined;
    const last = a.commands.length - 1;
    const argv = effectiveArgv(a.commands[last]!.argv);
    const prog = (argv[0] ?? "").split("/").pop()!;
    const name = GREPS.has(prog) ? prog : prog === "git" && argv[gitSubcommand(argv).index] === "grep" ? "git grep" : undefined;
    if (!name) return undefined;
    // The pipeline it ends, and what comes before that.
    let first = last;
    while (first > 0 && a.commands[first]!.after === "|") first--;
    if (a.commands[first]!.after === "&&") return undefined;
    const pipeline = a.commands.slice(first, last + 1);
    if (pipeline.some((c) => c.opensFile || c.argv[0] === "!" || effectiveArgv(c.argv)[0] === "!")) return undefined;
    return { name, piped: first < last };
}

const DANGEROUS: [RegExp, string][] = [
    [/\brm\s+(-[a-zA-Z]*[rR][a-zA-Z]*\s+|--recursive\s+)*(-[a-zA-Z]*f[a-zA-Z]*\s+)*(--no-preserve-root\s+)?(\/|\/\*|~|~\/|\$HOME|\$\{HOME\}|\/Users\/?|\/home\/?|\.\.?\/?)(\s|$|;|&|\|)/, "recursive delete of a root, home or parent directory"],
    [/:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, "fork bomb"],
    [/\bmkfs(\.\w+)?\b/, "formats a filesystem"],
    [/\bdd\b[^\n]*\bof=\/dev\/(?!null)/, "writes directly to a device"],
    [/>\s*\/dev\/(sd|disk|nvme|hd)/, "writes directly to a disk device"],
    [/\b(diskutil)\s+(erase|partition|zero|secureErase)/i, "erases a disk"],
    [/\bchmod\s+(-R\s+)?[0-7]*777\s+\/(\s|$)/, "makes the filesystem world-writable"],
    [/\bchown\s+-R\s+\S+\s+\/(\s|$)/, "recursively changes ownership of /"],
    [/\b(shutdown|reboot|halt|poweroff)\b/, "shuts down or reboots the machine"],
    [/\bkill\s+-9\s+-1\b/, "kills every process"],
    [/\b(curl|wget|fetch)\b[^|\n]*\|\s*(sudo\s+)?(\S*\/)?(env\s+)?(ba|z|da|k)?sh\b/, "pipes a downloaded script into a shell"],
    [/\b(curl|wget)\b[^|\n]*\|\s*(sudo\s+)?(\S*\/)?(env\s+)?(python[0-9.]*|node|ruby|perl|php)\b/, "pipes downloaded code into an interpreter"],
    [/\b((ba|z|da|k)?sh|source|\.)\s+(-s\s+)?<\(\s*(curl|wget)\b/, "runs a downloaded script"],
    [/\b((ba|z|da|k)?sh\s+-c|eval)\s+["']?\$\(\s*(curl|wget)\b/, "runs a downloaded script"],
    [/\bsudo\b/, "runs with elevated privileges"],
    [/\bsecurity\s+(find-generic-password|find-internet-password|dump-keychain|export)\b/, "reads secrets from the keychain"],
    [/\bgit\s+push\b[^\n]*(\s--force\b|\s-f\b|\s--force-with-lease\b|\s\+\S)/, "force-pushes to a remote"],
    [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f)/, "discards uncommitted work"],
    [/\b(crontab\s+-r|launchctl\s+(unload|remove|bootout))\b/, "removes scheduled jobs or system services"],
    [/\b(npm|pnpm|yarn)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bgem\s+push\b/, "publishes a package"],
    [/\bhistory\s+-c\b/, "clears shell history"],
    [/>\s*~\/\.(bash|zsh)(rc|_profile|env)|>\s*~\/\.profile/, "overwrites a shell startup file"],
];

/** Bodies of $(...), `...`, <(...) and >(...), outermost first (nested ones come from recursing). */
export function substitutionBodies(cmd: string): string[] {
    const out: string[] = [];
    let quote: "'" | '"' | null = null;
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i]!;
        if (c === "\\") {
            i++;
            continue;
        }
        if (quote === "'") {
            if (c === "'") quote = null;
            continue;
        }
        if (c === "'" && !quote) {
            quote = "'";
            continue;
        }
        if (c === '"') {
            quote = quote ? null : '"';
            continue;
        }
        if (c === "`") {
            let j = i + 1;
            while (j < cmd.length && cmd[j] !== "`") j += cmd[j] === "\\" ? 2 : 1;
            out.push(cmd.slice(i + 1, j));
            i = j;
            continue;
        }
        if ((c === "$" || c === "<" || c === ">") && cmd[i + 1] === "(") {
            let depth = 0;
            let j = i + 1;
            for (; j < cmd.length; j++) {
                if (cmd[j] === "(") depth++;
                else if (cmd[j] === ")" && --depth === 0) break;
            }
            out.push(cmd.slice(i + 2, j));
            i = j;
        }
    }
    return out;
}

/**
 * `rm -r` of /, a top-level directory, a home directory, or (unless
 * `cwdOk`) the current/parent directory.
 */
function criticalTarget(t: string, cwdOk = false): boolean {
    const home = homedir();
    let p = t.replace(/^\$\{?HOME\}?(?=\/|$)/, "~");
    if (p === home || p.startsWith(home + "/")) p = "~" + p.slice(home.length);
    while (p.length > 1 && /(\/|\/\.|\/\*)$/.test(p)) p = p.replace(/(\/|\/\.|\/\*)$/, "");
    if (p === "" || p === "/" || /^~[^/]*$/.test(p)) return true;
    if (!cwdOk && (p === "." || p === "*" || /^\.\.(\/\.\.)*$/.test(p))) return true;
    return /^\/[^/]+$/.test(p) || /^\/(Users|home)\/[^/]+$/.test(p);
}

function dangerousArgv(argv0: string[]): string | undefined {
    const argv = effectiveArgv(argv0);
    const base = (argv[0] ?? "").split("/").pop()!;
    const args = argv.slice(1);
    const dd = args.indexOf("--");
    const opts = dd < 0 ? args : args.slice(0, dd);
    const operands = dd < 0 ? positional(args) : [...positional(args.slice(0, dd)), ...args.slice(dd + 1)];
    if (base === "rm" && opts.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive") && operands.some((o) => criticalTarget(o))) {
        return "recursive delete of a root, home or parent directory";
    }
    if (base === "find" && args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir") && criticalTarget(args[0] ?? ".", true)) {
        return "deletes or runs commands across a root or home directory";
    }
    // Look inside `sh -c '...'` and `eval ...`.
    if (["sh", "bash", "zsh", "dash", "ksh"].includes(base)) {
        const c = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
        if (c >= 0 && args[c + 1] !== undefined) return dangerousReason(args[c + 1]!);
    }
    if (base === "eval" && args.length) return dangerousReason(args.join(" "));
    return undefined;
}

/**
 * A path pattern for text that `spellings` folded: on a case-insensitive
 * volume `~/.AWS/credentials` and `~/.harneſſ` name the real thing, and the
 * spellings are lower-cased, so the pattern ignores case too.
 */
function anyCase(re: RegExp): RegExp {
    return CASE_INSENSITIVE_FS && !re.flags.includes("i") ? new RegExp(re.source, re.flags + "i") : re;
}

/** Matched in every spelling of the command, like SENSITIVE. */
const CREDENTIAL_STORE = anyCase(/\.harness\/(credentials|providers)\.json/);

/** Returns a reason if the command matches a known-catastrophic pattern. */
export function dangerousReason(cmd: string, depth = 0): string | undefined {
    for (const [re, reason] of DANGEROUS) if (re.test(cmd)) return reason;
    if (spellings(cmd).some((t) => CREDENTIAL_STORE.test(t))) return "touches the harness credential store";
    if (depth > 4) return undefined;
    const a = analyzeCommand(cmd);
    for (const c of a.commands) {
        const r = dangerousArgv(c.argv);
        if (r) return r;
    }
    for (const body of substitutionBodies(cmd)) {
        const r = dangerousReason(body, depth + 1);
        if (r) return r;
    }
    return undefined;
}

/** What sensitiveTarget() calls a project's .env file. */
export const ENV_FILE = "a .env file";

const SENSITIVE = ([
    // Any suffix (.env.prodüction too); a template only when that's the whole name, as for Read.
    [/(^|[\s'"=:/<])\.env(?!\.(example|sample|template|dist)(?=$|[\s'";|&)>]))([.*?[][^\s'";|&)>/]*)?(?=$|[\s'";|&)>])/, ENV_FILE],
    [/(^|[\s'"=:/~])\.(ssh|aws|gnupg|azure)(\/|\b)|\.kube\/config|\.docker\/config\.json|\.config\/gcloud/, "a credentials directory"],
    [/\.(netrc|npmrc|pypirc|pgpass|git-credentials)\b/, "a credentials file"],
    [/\bid_(rsa|ed25519|ecdsa|dsa)\b(?!\.pub)/, "an SSH private key"],
    [/Library\/Keychains|\bsecurity\s+(find|dump|export)-/, "the system keychain"],
    [/\.harness\/(credentials|providers)\.json/, "the harness credential store"],
    [/\.codex\/auth\.json|\.claude\/\.credentials\.json|\.config\/gh\/hosts\.yml/, "a CLI's sign-in file"],
    [/(^|[\s'"=:])(~|\$HOME|\$\{HOME\})\/\.harness(?=$|[/\s'";|&)])/, "the harness credential store"],
    [/\b(grep|egrep|fgrep|rg|ag|ack)\b[^|;&\n]*\s(~|\$HOME|\$\{HOME\}|\/Users\/[^\s/]+|\/home\/[^\s/]+|\/)\/?(?=$|[\s;|&)])/, "your whole home directory"],
    [/\bkubectl\s+get\s+secrets?\b|\bkubectl\s+config\s+view\b[^|;&\n]*--raw/, "cluster secrets"],
    [/\bgcloud\b[^|;&\n]*\b(print-(access|identity|refresh)-token|config-helper)\b/, "a Google Cloud access token"],
] satisfies [RegExp, string][]).map(([re, what]): [RegExp, string] => [anyCase(re), what]);

function matchSensitive(text: string, harnessHome?: string): string | undefined {
    // Every spelling counts. The lower-cased one is no wider than the volume, so
    // `.env.ｅxample`, which only the wider fold makes a template, still asks.
    const texts = spellings(text);
    for (const t of texts) for (const [re, what] of SENSITIVE) if (re.test(t)) return what;
    if (harnessHome) {
        for (const h of spellings(harnessHome)) {
            const esc = h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const re = anyCase(new RegExp(`(^|[\\s'"=:])${esc}(?=$|[/\\s'";|&)])`));
            if (texts.some((t) => re.test(t))) return "the harness credential store";
        }
    }
    return undefined;
}

/** Expand a glob word against the filesystem the way bash would (no globstar), capped. */
function expandGlob(word: string, cwd: string): string[] {
    const p = word.replace(/^(~|\$\{?HOME\}?)(?=\/|$)/, homedir()).replace(/\*\*+/g, "*");
    const segs = p.split("/");
    const first = segs.findIndex((x) => /[*?[]/.test(x));
    if (first < 0) return [];
    const base = p.startsWith("/") ? "/" + segs.slice(1, first).join("/") : join(cwd, segs.slice(0, first).join("/"));
    const pattern = segs.slice(first).join("/");
    // Bun's glob never matches dotfiles unless asked; bash does when the pattern starts with a dot.
    const dot = segs.slice(first).some((x) => x.startsWith("."));
    const out: string[] = [];
    try {
        for (const f of new Bun.Glob(pattern).scanSync({ cwd: base, dot, onlyFiles: false, absolute: true })) {
            out.push(f);
            if (out.length >= 500) break;
        }
    } catch {
        // unreadable directory: nothing to expand
    }
    return out;
}

/**
 * Commands that look at credential files ask first even when read-only.
 * Output is redacted either way; this keeps the model from going fishing.
 * With `cwd`, glob words are expanded so `cat .e*` is caught too.
 */
export function sensitiveTarget(cmd: string, opts: { cwd?: string; harnessHome?: string } = {}): string | undefined {
    const commands = analyzeCommand(cmd).commands;
    // The words as the shell reads them too, so quoting (`cat .e''nv`) doesn't hide a name.
    const unquoted = commands.map((c) => c.argv.join(" ")).join(" ; ");
    const direct = matchSensitive(cmd, opts.harnessHome) ?? matchSensitive(unquoted, opts.harnessHome);
    if (direct || !opts.cwd) return direct;
    // Each pattern in every folder its command might run in (`cd private && cat .e*`). A cd
    // can fail (`cd x || cat .e*`) or run in a pipeline's subshell (`cd x | cat .e*`), so the
    // folders before it count too.
    let dirs: string[] | null = [opts.cwd];
    for (const c of commands) {
        const argv = effectiveArgv(c.argv);
        if (argv[0] === "cd" || argv[0] === "pushd") {
            const to = argv[1];
            if (!settledCd(argv, c.text)) dirs = null;
            else if (dirs) dirs = [...new Set([...dirs, ...dirs.map((d) => resolve(d, to!))])];
            if (dirs && dirs.length > 32) dirs = null;
            continue;
        }
        for (const w of argv) {
            if (!/[*?[]/.test(w)) continue;
            const relative = !/^(\/|~|\$\{?HOME\}?(\/|$))/.test(w);
            if (relative && !dirs) return "files a pattern matches in a folder the harness can't work out";
            for (const d of relative ? dirs! : [opts.cwd]) {
                for (const hit of expandGlob(w, d)) {
                    const r = matchSensitive(" " + hit, opts.harnessHome);
                    if (r) return r;
                }
            }
        }
    }
    return undefined;
}

// Paths whose contents configure the harness, the agent CLIs it runs, or git:
// permissions, hooks, MCP servers, skills, git hooks/fsmonitor. A shell command
// that isn't read-only and names one asks, like an Edit of the same file would.
const CONFIG_PATH = /(^|[\s'"=:/])(\.harness|\.codex|\.mcp\.json|\.git)(?=$|[/\s'";|&)>])/i;
// .claude/ too, but see claudeConfigIn.
const CLAUDE_DIR = /(^|[\s'"=:/])\.claude(?=$|[/\s'";|&)>])/gi;
const WORKTREE = /\/worktrees\/([^/\s'"`;|&()<>*?[\]{}$\\]+)(?=$|[/\s'";|&)>])/iy;

/**
 * Could something in the text lead a path back up out of a folder: a `..`, a
 * pattern that could match one (`.*`), or an expansion? A name starts at a
 * separator, `=` or `:`, and runs to the next separator. In one pass, so a
 * long command can't make it slow.
 */
function climbs(text: string): boolean {
    if (/[$`]/.test(text)) return true;
    for (const chunk of text.split(/[/\s'"]/)) {
        const lastPattern = Math.max(chunk.lastIndexOf("*"), chunk.lastIndexOf("?"), chunk.lastIndexOf("["));
        for (let i = 0; i < chunk.length; i++) {
            if (chunk[i] !== "." || (i > 0 && chunk[i - 1] !== "=" && chunk[i - 1] !== ":")) continue;
            if (chunk[i + 1] === "." || i < lastPattern) return true;
        }
    }
    return false;
}

/**
 * Does the text name something in a .claude/ folder? Not what's in a Claude
 * Code worktree (.claude/worktrees/<name>/): those are git checkouts, projects
 * of their own (see withoutWorktrees in checker.ts), and `cd
 * .claude/worktrees/x && bun test` isn't about .claude config. Text can't
 * show where a quoted name ends, so one only counts as a worktree when
 * nothing in the command could climb back out (after it, or before it, in a
 * link made to point up: `ln -s ../.. .claude/worktrees/x/up`), and its name
 * isn't like the config's.
 */
function claudeConfigIn(text: string): boolean {
    let climbing: boolean | undefined;
    for (const m of text.matchAll(CLAUDE_DIR)) {
        WORKTREE.lastIndex = m.index + m[0].length;
        const w = WORKTREE.exec(text);
        if (!w || (climbing ??= climbs(text))) return true;
        const name = w[1]!;
        if (name === "." || name === ".." || spellings(name).some((n) => /^\.(harness|claude|codex|git|mcp\.json)$/.test(n))) return true;
    }
    return false;
}

// `git config` keys that make later read-only git commands run programs.
const GIT_EXEC_CONFIG = /\bgit\b[^|;&\n]*\bconfig\b[^|;&\n]*\b(core\.(fsmonitor|pager|editor|sshcommand|hookspath|askpass)|diff\.[^\s=]*(external|textconv|command)|filter\.|alias\.|credential\.|gpg\.|sequence\.editor|uploadpack\.|merge\.[^\s=]*driver|include\.|includeif\.)/i;

const DEFAULT_BRANCH = /^(refs\/heads\/)?(main|master|trunk)$/;
// `git push` options that take a value as the next word.
const PUSH_VALUE_OPTS = new Set(["-o", "--push-option", "--repo", "--receive-pack", "--exec"]);

/**
 * A `git push` that updates the default branch (main/master/trunk) by name,
 * or every branch at once. Auto mode always asks for these: what the
 * developer asked for rarely spells out the destination, and the reviewer
 * can read "push the branch" as covering it.
 */
export function pushesDefaultBranch(cmd: string, cwd?: string): string | undefined {
    for (const { argv, dir } of commandsWithDirs(cmd, cwd)) {
        if ((argv[0] ?? "").split("/").pop() !== "git") continue;
        const { index: i, dirs } = gitSubcommand(argv);
        if (argv[i] !== "push") continue;
        const positional: string[] = [];
        for (let j = i + 1; j < argv.length; j++) {
            const a = argv[j]!;
            if (a === "--all" || a === "--mirror" || a === "--branches") return `git push ${a}`;
            if (PUSH_VALUE_OPTS.has(a)) j++;
            else if (!a.startsWith("-")) positional.push(a);
        }
        // positional[0] is the remote; the rest are refspecs ([+]src[:dst]).
        const specs = positional.slice(1);
        const branch = typeof dir === "string" ? headBranch(resolve(dir, ...dirs)) : undefined;
        // Without a refspec git pushes the current branch (push.default "simple").
        if (!specs.length && branch && DEFAULT_BRANCH.test(branch)) return `git push from ${branch}`;
        for (const spec of specs) {
            let dst = spec.replace(/^\+/, "").split(":").pop()!;
            if ((dst === "HEAD" || dst === "@") && branch) dst = branch;
            if (DEFAULT_BRANCH.test(dst)) return `git push to ${dst.replace(/^refs\/heads\//, "")}`;
        }
    }
    return undefined;
}

// git's own options that take a value as the next word.
const GIT_VALUE_OPTS = new Set(["-C", "-c", "--git-dir", "--work-tree", "--namespace", "--super-prefix", "--config-env", "--attr-source"]);

/** Where git's subcommand is in argv (argv[0] is git), past git's own options, and the `-C` directories on the way. */
export function gitSubcommand(argv: string[]): { index: number; dirs: string[] } {
    const dirs: string[] = [];
    let i = 1;
    while (i < argv.length && argv[i]!.startsWith("-")) {
        if (argv[i] === "-C") dirs.push(argv[i + 1] ?? "");
        i += GIT_VALUE_OPTS.has(argv[i]!) ? 2 : 1;
    }
    return { index: i, dirs };
}

/**
 * The start of a small regular file, or undefined. For files a sandboxed
 * command could have replaced: a FIFO would block, a huge file would stall.
 */
export function readSmallFile(path: string, max = 4096): string | undefined {
    try {
        if (!statSync(path).isFile()) return undefined;
        const fd = openSync(path, "r");
        try {
            const buf = Buffer.alloc(max);
            return buf.toString("utf-8", 0, readSync(fd, buf, 0, max, 0));
        } finally {
            closeSync(fd);
        }
    } catch {
        return undefined;
    }
}

/** The branch checked out in the repo that contains dir, from its HEAD file (without running git). */
export function headBranch(dir: string): string | undefined {
    for (let d = resolve(dir); ; d = dirname(d)) {
        const dotGit = join(d, ".git");
        if (existsSync(dotGit)) {
            try {
                let gitDir = dotGit;
                if (!statSync(dotGit).isDirectory()) {
                    const m = readSmallFile(dotGit)?.match(/^gitdir:\s*(.+?)\s*$/m);
                    if (!m) return undefined;
                    gitDir = resolve(d, m[1]!);
                }
                const head = join(gitDir, "HEAD");
                // git still follows a HEAD that's a symlink to the branch's ref file.
                if (lstatSync(head).isSymbolicLink()) return readlinkSync(head).match(/(?:^|\/)refs\/heads\/(.+)$/)?.[1];
                return readSmallFile(head)?.match(/^ref:\s*refs\/heads\/(.+?)\s*$/m)?.[1];
            } catch {
                return undefined;
            }
        }
        if (dirname(d) === d) return undefined;
    }
}

/**
 * A cd/pushd whose destination is its one operand, spelled out. Not `cd $DIR`,
 * `cd -`, `cd ~x`, `cd pri*`, `pushd +1` (the directory stack), or zsh's
 * `cd old new` (which swaps text in the current path).
 */
function settledCd(argv: string[], text: string): boolean {
    const to = argv[1];
    return to !== undefined && argv.length === 2 && !/^[-~+]|\$|[*?[]/.test(to) && !/\$/.test(text);
}

/**
 * The commands of a command line with the directory each runs in, following
 * `cd`. null: a `cd` the text doesn't settle (see settledCd).
 */
export function commandsWithDirs(cmd: string, cwd: string | undefined): { argv: string[]; dir: string | null | undefined; text: string }[] {
    const out: { argv: string[]; dir: string | null | undefined; text: string }[] = [];
    let dir: string | null | undefined = cwd;
    for (const c of analyzeCommand(cmd).commands) {
        const argv = effectiveArgv(c.argv);
        if (argv[0] === "cd" || argv[0] === "pushd") {
            if (dir !== undefined) dir = dir === null || !settledCd(argv, c.text) ? null : resolve(dir, argv[1]!);
            continue;
        }
        out.push({ argv, dir, text: c.text });
    }
    return out;
}

export function configTarget(cmd: string, harnessHome?: string): string | undefined {
    if (isReadOnlyCommand(cmd)) return undefined;
    const unquoted = analyzeCommand(cmd).commands.map((c) => c.argv.join(" ")).join(" ; ");
    // In every spelling: on a case-insensitive volume `.harneſſ/` is `.harness/`.
    const homes = harnessHome ? spellings(harnessHome) : [];
    for (const text of [cmd, unquoted].flatMap(spellings)) {
        if (CONFIG_PATH.test(text) || claudeConfigIn(text)) return "harness or git configuration";
        if (GIT_EXEC_CONFIG.test(text)) return "git settings that run programs";
        if (homes.some((h) => text.includes(h))) return "harness configuration";
    }
    return undefined;
}

const TWO_WORD = new Set(["git", "npm", "pnpm", "yarn", "bun", "cargo", "go", "docker", "kubectl", "make", "pip", "pip3", "uv", "poetry", "npx", "bunx", "gh", "brew", "deno", "dotnet", "mvn", "gradle", "./gradlew", "rails", "python", "python3", "node", "swift", "terraform", "helm", "aws", "gcloud", "az"]);

/** Suggest prefix rules for each simple command (`npm run test:*`). */
export function suggestBashRules(cmd: string): string[] {
    const a = analyzeCommand(cmd);
    const out: string[] = [];
    for (const c of a.commands) {
        const argv = effectiveArgv(c.argv);
        if (!argv.length || isReadOnlySimple(argv)) continue;
        const prog = argv[0]!;
        let n = TWO_WORD.has(prog) ? 2 : 1;
        if (["npm", "pnpm", "yarn", "bun"].includes(prog) && argv[1] === "run") n = 3;
        if ((prog === "python" || prog === "python3") && argv[1] === "-m") n = 3;
        const words = argv.slice(0, n).filter((w, i) => i === 0 || !w.startsWith("-") || (n === 3 && i === 1 && w === "-m"));
        const rule = `Bash(${words.join(" ")}:*)`;
        if (!out.includes(rule)) out.push(rule);
    }
    return out.slice(0, 3);
}
