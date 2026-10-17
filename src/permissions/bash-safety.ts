// Static analysis of shell commands: split compound commands, recognise
// read-only commands, flag catastrophic ones, and suggest allow-rule prefixes.

import { closeSync, existsSync, lstatSync, openSync, readlinkSync, readSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { CASE_FOLDS, canonical, CASE_INSENSITIVE_FS, expandPath, isInside, spellings } from "../util/files";
import { accountCredentialFiles, accountFolders } from "../providers/accounts";

export interface SimpleCommand {
    text: string;
    argv: string[];
    /** The operator before it: ";", "\n", "&&", "||", "|" or "&" (none for the first). */
    after?: string;
    /**
     * A redirection on it that the shell can fail on before it runs: any but
     * output to /dev/null and copies onto stdout or stderr (`2>&1`, `>&2`).
     * Input (`< f`, `<&9`), files (`> f`, `>/dev/stdout`), closes (`2>&-`)
     * and other descriptors (`>&3`) all count.
     */
    redirectMayFail?: true;
    /**
     * Indexes of the words with a glob whose first character isn't known: it starts with the
     * unquoted `*`, `?` or `[` (after nothing but empty quotes, `""*`) or with an expansion
     * (`$e*`, with e empty). Their expansion can be anything, `-v` too.
     */
    globStart?: number[];
    /** Indexes of the words with a `$` expansion in them (not in single quotes): what they'll be isn't known. */
    expands?: number[];
    /** Indexes of the words with an unquoted `*`, `?` or `[` anywhere: they can become any number of words. */
    globbed?: number[];
    /** Where each argv word is in the command line: [start, end) of its raw text, quotes included. */
    spans: [number, number][];
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
    /** A here-document (`<<EOF`): its lines aren't commands, though they're split as if they were. */
    heredoc?: true;
    /** A command of redirections alone, which isn't in `commands`. */
    bareRedirect?: true;
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
    let spans: [number, number][] = [];
    let word = "";
    let wordStarted = false;
    /** The raw text of the word so far: [start, end). */
    let wordStart = -1;
    let wordEnd = -1;
    const mark = (from: number, to: number) => {
        if (wordStart < 0) wordStart = from;
        wordEnd = to;
    };
    /** Some of the word was quoted or escaped (so `''2>x`'s 2 is an argument, not an fd). */
    let wordQuoted = false;
    let text = "";
    let quote: "'" | '"' | null = null;
    /** The operator after the last command pushed (`a &&` then a blank line: still &&). */
    let lastOp: string | undefined;
    let redirectMayFail = false;
    let heredoc = false;
    /** A command that's only redirections (`2>/dev/null 1>&9`): it has a status of its own, though no words. */
    let bareRedirect = false;
    /** What the word starts with so far: nothing yet, a known character, or a glob or expansion. */
    let wordLead: "none" | "known" | "unknown" = "none";
    const lead = (unknown: boolean) => {
        if (wordLead === "none") wordLead = unknown ? "unknown" : "known";
    };
    let globStart: number[] = [];
    let wordExpands = false;
    let expands: number[] = [];
    let wordGlobbed = false;
    let globbed: number[] = [];
    /** `$` at `i` starts an expansion (`$x`, `${x}`, `$1`, `$?`), not a literal dollar (`a$`, `$ `). */
    const expansionAt = (i: number) => cmd[i] === "$" && /[A-Za-z_{0-9?#@*!$=~^+-]/.test(cmd[i + 1] ?? "");

    const endWord = () => {
        if (wordStarted) {
            // A lone `[` matches nothing (it's the test command): no glob.
            if (word === "[" && !wordQuoted) wordGlobbed = false;
            if (wordGlobbed && wordLead === "unknown") globStart.push(argv.length);
            if (wordExpands) expands.push(argv.length);
            if (wordGlobbed) globbed.push(argv.length);
            argv.push(word);
            spans.push([wordStart, wordEnd]);
        }
        word = "";
        wordStarted = false;
        wordQuoted = false;
        wordLead = "none";
        wordExpands = false;
        wordGlobbed = false;
        wordStart = wordEnd = -1;
    };
    const endCommand = (op?: string) => {
        endWord();
        if (argv.length) {
            commands.push({ text: text.trim(), argv, spans, ...(lastOp !== undefined ? { after: lastOp } : {}), ...(redirectMayFail ? { redirectMayFail: true as const } : {}), ...(globStart.length ? { globStart } : {}), ...(expands.length ? { expands } : {}), ...(globbed.length ? { globbed } : {}) });
            lastOp = op;
        } else if (/[<>]/.test(text)) bareRedirect = true;
        globStart = [];
        expands = [];
        globbed = [];
        argv = [];
        spans = [];
        text = "";
        redirectMayFail = false;
    };

    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i]!;
        const n = cmd[i + 1];
        if (quote === "'") {
            if (c === "'") quote = null;
            else {
                lead(false);
                word += c;
            }
            mark(i, i + 1);
            text += c;
            continue;
        }
        if (quote === '"') {
            mark(i, i + 1);
            if (c === "\\" && n !== undefined) {
                // In double quotes a backslash only escapes $ ` " \ and a newline; before anything else it stays (`"\u0025d"`).
                if (n !== "\n") {
                    lead(false);
                    word += '$`"\\'.includes(n) ? n : c + n;
                }
                text += c + n;
                mark(i, i + 2);
                i++;
                continue;
            }
            if (c === '"') quote = null;
            else {
                if (c === "`" || (c === "$" && n === "(")) hasSubstitution = true;
                if (c === "$" && (n === "[" || (n === "{" && !plainBraceParam(cmd, i)))) unsafeExpansion = true;
                if (expansionAt(i)) wordExpands = true;
                lead(expansionAt(i));
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
            lead(false);
            word += n;
            wordStarted = true;
            wordQuoted = true;
            mark(i, i + 2);
            text += c + n;
            i++;
            continue;
        }
        // $'\x2do' and (bash) $"-o" decode to text a plain reading misses
        // (`sort $'-o' out`): argv gets the decoded word so deny rules see it,
        // and the command is never read-only.
        if (c === "$" && n === "'") {
            const [decoded, end] = ansiC(cmd, i + 2);
            if (decoded) lead(false);
            word += decoded;
            wordStarted = true;
            wordQuoted = true;
            unsafeExpansion = true;
            mark(i, Math.min(end + 1, cmd.length));
            text += cmd.slice(i, end + 1);
            if (end >= cmd.length) quote = "'";
            i = end;
            continue;
        }
        if (c === "$" && n === '"') {
            unsafeExpansion = true;
            mark(i, i + 1);
            text += c;
            continue;
        }
        if (c === "'" || c === '"') {
            quote = c;
            wordStarted = true;
            wordQuoted = true;
            mark(i, i + 1);
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
                mark(i, i + 1);
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
                // A redirection of a descriptor other than stdout and stderr: 0 and 3+ may be closed.
                if (c === ">" && word !== "1" && word !== "2") redirectMayFail = true;
                word = "";
                wordStarted = false;
            } else if (/^\d+$/.test(word) && !wordQuoted) redirectMayFail = true; // bash takes `10>x` as fd 10
            endWord();
            if (c === "<") {
                redirectMayFail = true;
                if (n === "<" && cmd[i - 1] !== "<" && cmd[i + 2] !== "<") heredoc = true;
            }
            // Where the redirection ends when nothing after the operator is an argument (`>&2`, `>/dev/null`).
            let end = i;
            if (c === ">") {
                // Look at the redirection target.
                let j = i + 1;
                if (cmd[j] === ">" || cmd[j] === "|") j++;
                const fd = cmd[j] === "&" ? /^(\d+|-)(?=$|[ \t\n;|&)<>])/.exec(cmd.slice(j + 1)) : null;
                if (fd) {
                    // >&2 / >&- style: fd duplication or close, harmless (onto stdout or stderr, which are open, it can't fail)
                    end = j + fd[0].length;
                    if (fd[1] !== "1" && fd[1] !== "2") redirectMayFail = true;
                } else {
                    if (cmd[j] === "&") j++; // `>&file` sends stdout and stderr to a file
                    while (cmd[j] === " " || cmd[j] === "\t") j++;
                    // The whole word, however its pieces are quoted: `"src"/../../out` is one target.
                    const raw = cmd.slice(j).match(/^(?:"[^"]*"|'[^']*'|[^ \t\n;|&<>"'])+/)?.[0] ?? "";
                    // Quotes removed as the shell does: `'"x"'` is the name "x" with its double quotes.
                    const target = (raw.match(/"[^"]*"|'[^']*'|\\.?|[^"'\\]+/g) ?? []).map((p) => (p[0] === "'" || p[0] === '"' ? p.slice(1, -1) : p[0] === "\\" ? p.slice(1) : p)).join("");
                    if (/^\/dev\/(null|stdout|stderr)$/.test(target)) {
                        end = j + raw.length - 1;
                        // Opening /dev/stdout or /dev/stderr fails when that descriptor is closed.
                        if (target !== "/dev/null") redirectMayFail = true;
                    } else {
                        writesFiles = true;
                        redirectMayFail = true;
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
        if (c === "*" || c === "?" || c === "[") wordGlobbed = true;
        if (expansionAt(i)) wordExpands = true;
        lead(c === "*" || c === "?" || c === "[" || expansionAt(i));
        word += c;
        wordStarted = true;
        mark(i, i + 1);
        text += c;
    }
    const unparsable = quote !== null;
    endCommand();
    return { commands, hasSubstitution, writesFiles, unparsable, unsafeExpansion, redirects, ...(lastOp !== undefined ? { trailing: lastOp } : {}), ...(heredoc ? { heredoc: true as const } : {}), ...(bareRedirect ? { bareRedirect: true as const } : {}) };
}

/**
 * Strip leading env assignments (FOO=bar cmd) and wrappers like `time`. For
 * what can approve a command (allow rules, the read-only check), so only the
 * plain forms, spelled exactly: `command -v x` looks x up, it doesn't run it.
 */
export function effectiveArgv(argv: string[]): string[] {
    let i = 0;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) i++;
    const rest = argv.slice(i);
    if (rest[0] === "time" || rest[0] === "nice") return effectiveArgv(rest.slice(1));
    if (rest[0] === "command" && !/^-/.test(rest[1] ?? "")) return effectiveArgv(rest.slice(1));
    if (rest[0] === "command" && rest[1] === "-p" && !/^-/.test(rest[2] ?? "")) return effectiveArgv(rest.slice(2));
    return rest;
}

/**
 * The names a program word can run as: its base name, and on a
 * case-insensitive volume its other spellings too, since the shell finds
 * /bin/rm for `RM` and /bin/sh for `ſh` there (builtins and keywords, which
 * the shell itself matches exactly, aren't found that way, but treating
 * `EVAL` like eval only ever asks more). For checks that protect.
 */
export function programNames(word: string): string[] {
    const base = word.slice(word.lastIndexOf("/") + 1);
    return [...new Set([base, ...spellings(base)])];
}

/** Does the program word run one of these programs, in any spelling the volume finds it by? */
export function runs(word: string | undefined, ...names: string[]): boolean {
    return word !== undefined && programNames(word).some((n) => names.includes(n));
}

const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

/**
 * Programs that run another one named after their own options, which they
 * read up to the first word that isn't one (they all stop there). `short`
 * and `long`: the options that take a value, the rest of a short cluster or
 * else the next word (a long one by any prefix, as getopt_long takes them);
 * `attached`: ones whose value can only be the rest of the cluster (GNU
 * xargs's -e, -i, -l). Options of GNU's, BSD's and sudo's own are all
 * counted: one a program doesn't have makes it fail. `operands`: words
 * before the program (timeout's duration). `split`: env's -S, whose value
 * is more arguments. `query`: options that make it look the program up
 * instead (`command -v`).
 */
interface Wrapper {
    short: string;
    attached?: string;
    long?: string[];
    operands?: number;
    split?: { short: string; long: string };
    query?: string;
}
const TIMEOUT: Wrapper = { short: "sk", long: ["signal", "kill-after"], operands: 1 };
const WRAPPERS = new Map<string, Wrapper>([
    ["time", { short: "of", long: ["output", "format"] }],
    ["nice", { short: "n", long: ["adjustment"] }],
    ["nohup", { short: "" }],
    ["command", { short: "", query: "vV" }],
    ["builtin", { short: "" }],
    ["exec", { short: "a" }],
    ["env", { short: "uPCa", long: ["unset", "chdir", "argv0"], split: { short: "S", long: "split-string" } }],
    ["timeout", TIMEOUT],
    ["gtimeout", TIMEOUT],
    ["xargs", { short: "aEILnsPdJRS", attached: "eil", long: ["arg-file", "delimiter", "max-args", "max-procs", "max-chars", "process-slot-var"] }],
    ["sudo", { short: "aCcDgpRrTtUu", attached: "h", long: ["user", "group", "close-from", "chdir", "chroot", "host", "prompt", "role", "type", "command-timeout", "other-user", "login-class", "auth-type"] }],
    ["doas", { short: "aCu" }],
    ["stdbuf", { short: "ioe", long: ["input", "output", "error"] }],
    ["caffeinate", { short: "tw" }],
]);

function wrapperOf(word: string | undefined): Wrapper | undefined {
    if (word === undefined) return undefined;
    for (const n of programNames(word)) {
        const w = WRAPPERS.get(n);
        if (w) return w;
    }
    return undefined;
}

const ENV_ESCAPES: Record<string, string> = { f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "#": "#", $: "$", '"': '"', "'": "'", "\\": "\\" };

/**
 * The words env -S makes of its string, as macOS's env(1) describes it
 * (GNU's follows the same rules): spaces and tabs separate, and so do
 * newlines, returns, vertical tabs and form feeds (tried); '…' keeps all
 * but \' and \\; "…" and bare text take the escapes, \_ being a space
 * inside "…" and a separator outside; \c ends the string, as does a word
 * that starts with #. ${NAME} (env's own environment) is left as written.
 * Text env would refuse (an open quote, an unknown escape) is split at
 * whitespace and \_ instead, so it's still looked at.
 */
function envSplit(s: string): string[] {
    const loose = () => s.split(/\s|\\_/).filter(Boolean);
    const words: string[] = [];
    let cur: string | undefined;
    const end = () => {
        if (cur !== undefined) words.push(cur);
        cur = undefined;
    };
    for (let i = 0; i < s.length; i++) {
        const ch = s[i]!;
        if (/[ \t\n\r\v\f]/.test(ch)) end();
        else if (ch === "#" && cur === undefined) break;
        else if (ch === "'" || ch === '"') {
            let w = cur ?? "";
            for (i++; i < s.length && s[i] !== ch; i++) {
                if (s[i] !== "\\") {
                    w += s[i];
                    continue;
                }
                const e = s[i + 1];
                if (ch === "'") w += e === "'" || e === "\\" ? s[++i] : "\\";
                else if (e === "_") (w += " "), i++;
                else if (e !== undefined && ENV_ESCAPES[e] !== undefined) (w += ENV_ESCAPES[e]), i++;
                else return loose();
            }
            if (i >= s.length) return loose();
            cur = w;
        } else if (ch === "\\") {
            const e = s[++i];
            if (e === "_") end();
            else if (e === "c") break;
            else if (e !== undefined && ENV_ESCAPES[e] !== undefined) cur = (cur ?? "") + ENV_ESCAPES[e];
            else return loose();
        } else cur = (cur ?? "") + ch;
    }
    end();
    return words;
}

/**
 * Every program a simple command runs, for the checks that protect (deny and
 * ask rules, catastrophic commands, deletions): the command past its env
 * assignments, then, through each wrapper (`env`, `exec`, `nohup`, `nice -n 5`,
 * `command -p`, `timeout 5`, `xargs -n 1`, `sudo -u x`, in any spelling), the
 * one it runs. `at` is where it starts in argv (-1 for one that env -S's
 * string gave, whose levels come last and start with that env's own).
 */
export function runLevels(argv0: string[], depth = 0): { argv: string[]; at: number }[] {
    const out: { argv: string[]; at: number }[] = [];
    let at = 0;
    for (let n = 0; n < 16 && at < argv0.length; n++) {
        while (at < argv0.length && ASSIGNMENT.test(argv0[at]!)) at++;
        if (at >= argv0.length) break;
        const argv = argv0.slice(at);
        out.push({ argv, at: depth ? -1 : at });
        const w = wrapperOf(argv[0]);
        if (!w) break;
        const env = runs(argv[0], "env");
        let operands = w.operands ?? 0;
        let optsDone = false;
        let script: string | undefined;
        let j = 1;
        for (; j < argv.length && script === undefined; j++) {
            const a = argv[j]!;
            if (!optsDone && a === "--") optsDone = true;
            else if (env && (ASSIGNMENT.test(a) || (!optsDone && a === "-"))) continue;
            else if (!optsDone && a.startsWith("--")) {
                const eq = a.indexOf("=");
                const name = a.slice(2, eq < 0 ? undefined : eq);
                if (w.split?.long.startsWith(name)) script = eq < 0 ? (argv[++j] ?? "") : a.slice(eq + 1);
                else if (eq < 0 && w.long?.some((l) => l.startsWith(name))) j++;
            } else if (!optsDone && a.startsWith("-") && a.length > 1) {
                // A cluster: the first option that takes a value takes the rest of the word, or the next word.
                for (let k = 1; k < a.length; k++) {
                    const ch = a[k]!;
                    if (w.query?.includes(ch)) return out;
                    if (w.attached?.includes(ch)) break;
                    const split = w.split?.short === ch;
                    if (!split && !w.short.includes(ch)) continue;
                    const value = k + 1 < a.length ? a.slice(k + 1) : argv[++j];
                    if (split) script = value ?? "";
                    break;
                }
            } else if (operands > 0) operands--;
            else break;
        }
        if (script !== undefined) {
            // `env -S 'rm -rf' ~` runs `rm -rf ~`: env goes on with the string's words, then the rest.
            if (depth < 4) out.push(...runLevels([argv[0]!, ...envSplit(script), ...argv.slice(j)], depth + 1));
            return out;
        }
        at += j;
    }
    return out;
}

// Variables that only change formatting. Anything else (GIT_EXTERNAL_DIFF,
// PAGER, LD_PRELOAD, NODE_OPTIONS, ...) can make a harmless command run code.
// COLUMNS and LINES are integers to zsh, which evaluates their value as
// arithmetic: `COLUMNS='PATH=0'` empties PATH, `COLUMNS='a[$(cmd)]'` runs cmd.
// So only a number, written out.
const SAFE_ENV = /^(?:(?:LANG|LANGUAGE|LC_[A-Z]+|TZ|NO_COLOR|FORCE_COLOR|CLICOLOR|CLICOLOR_FORCE|TERM)=|(?:COLUMNS|LINES)=\d*$)/;

/** True when every leading `NAME=value` (including after time/nice/command) is a formatting-only variable. */
export function onlySafeAssignments(argv: string[]): boolean {
    let i = 0;
    while (i < argv.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(argv[i]!)) {
        if (!SAFE_ENV.test(argv[i]!)) return false;
        i++;
    }
    const rest = argv.slice(i);
    if (rest[0] === "time" || rest[0] === "nice" || (rest[0] === "command" && !/^-/.test(rest[1] ?? ""))) return onlySafeAssignments(rest.slice(1));
    if (rest[0] === "command" && rest[1] === "-p" && !/^-/.test(rest[2] ?? "")) return onlySafeAssignments(rest.slice(2));
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
    "status", "log", "diff", "show", "rev-parse", "ls-files", "ls-tree", "check-ignore", "blame", "describe", "shortlog", "reflog",
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
// `--exec-path=<dir>`, `-p` (pager) and friends can all execute commands.
const GIT_SAFE_GLOBAL = new Set(["--no-pager", "-P", "--no-optional-locks", "--literal-pathspecs", "--glob-pathspecs", "--noglob-pathspecs", "--icase-pathspecs"]);
// Print where git keeps its programs or docs and exit, before reading any config
// (checked against git 2.55: `git --exec-path status` prints the path, runs no status).
const GIT_PRINT_PATH = new Set(["--exec-path", "--html-path", "--man-path", "--info-path"]);

/** `--name` or `--name=value` where name is at least `min` letters of `option` (getopt and git take unambiguous abbreviations). */
function longPrefixOf(arg: string, option: string, min: number): boolean {
    if (!arg.startsWith("--")) return false;
    const name = arg.slice(2).split("=")[0]!;
    return name.length >= min && option.startsWith(name);
}

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
        else return GIT_PRINT_PATH.has(args[i]!);
    }
    const sub = args[i];
    if (!sub) return false;
    const subArgs = args.slice(i + 1);
    // Options that write files or run programs even on read-only subcommands. git grep takes any
    // unambiguous start of a long option (`--open=sh` is --open-files-in-pager=sh), and -O after
    // other letters or a context count in one word (`-n1Osh`).
    if (subArgs.some((a) => /^--(output|ext-diff|open-files-in-pager)(=|$)/.test(a) || (sub === "grep" && (/^-[a-zA-Z0-9]*O/.test(a) || longPrefixOf(a, "open-files-in-pager", 2))))) return false;
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
    // zsh's stat builtin (zmodload zsh/stat) stores into the array -A or -H names: `stat -A 'a[$(cmd)]' f`.
    if (base === "stat" && args.some((a) => /^-[a-zA-Z]*[AH]/.test(a))) return false;
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
    // `command -v x` and `-V` say what x is without running it. Its options come
    // first: in `command cp -v a b` the -v is cp's, and cp runs.
    if (base === "command") {
        const opts = args.slice(0, Math.max(0, args.findIndex((a) => !a.startsWith("-") || a === "--")));
        return opts.every((a) => /^-[pvV]+$/.test(a)) && opts.some((a) => /[vV]/.test(a)) && args.length > opts.length;
    }
    if (base === "printenv") return args.every((a) => !a.startsWith("-"));
    if (base === "awk" || base === "gawk") return false; // can write files / run commands
    if (base === "xargs") return false;
    return READ_ONLY_PROGRAMS.has(base);
}

export function isReadOnlyCommand(cmd: string): boolean {
    return notReadOnly(cmd) === undefined;
}

/**
 * What keeps a command from being read-only, naming the part (for a
 * read-only agent, so it can drop or replace just that), or undefined.
 */
export function notReadOnly(cmd: string): string | undefined {
    const a = analyzeCommand(cmd);
    const clip = (s: string) => (s.length > 120 ? s.slice(0, 117) + "…" : s).replace(/\s+/g, " ");
    if (a.unparsable) return "its quotes aren't closed";
    if (a.hasSubstitution) return /\$\(\(/.test(cmd) && !/`|\$\((?!\()|<\(/.test(cmd) ? "it has $((…)) arithmetic, which the checks don't follow (it can run commands)" : "it runs a command inside $(…), backticks or <(…)";
    if (a.writesFiles) return `it writes to ${clip(a.redirects[0] || "a file")} with a > redirect`;
    if (a.unsafeExpansion) return "it has an expansion that can run code or change its words: unquoted parentheses (a subshell or glob qualifier), braces, $'…' or ${…} with an operator";
    if (!a.commands.length) return undefined;
    // A variable set on the line can expand to anything after (`X=-Oprog; git grep $X ...`), options included.
    for (const [i, c] of a.commands.entries()) {
        if (effectiveArgv(c.argv).length) continue;
        for (const assignment of c.argv) {
            if (!/^[A-Za-z_][A-Za-z0-9_]*=/.test(assignment)) continue;
            const name = assignment.slice(0, assignment.indexOf("="));
            const use = new RegExp(`\\$[{=~^#+]*${name}(?![A-Za-z0-9_])`);
            if (a.commands.slice(i + 1).some((d) => (d.expands ?? []).some((j) => use.test(d.argv[j]!)))) return `it sets \`${name}\` and then uses it, and the checks can't see what it holds`;
        }
    }
    // `$_` is the last word of the command before, which the line itself chose: `echo -delete; find . $_`.
    if (a.commands.some((c) => c.expands?.some((i) => /\$\{?_(?![A-Za-z0-9_])/.test(c.argv[i]!)))) return "it uses `$_`, the last word of the command before";
    // The checks read words as written. An expansion inside other text can be empty and leave text they
    // never saw (an option, say); one standing alone, or before a path, is a value, not hidden text.
    const spliced = a.commands.flatMap((c) => (c.expands ?? []).map((i) => c.argv[i]!)).find((w) => !STANDALONE_EXPANSION.test(w));
    if (spliced !== undefined) return `\`${clip(spliced)}\` has an expansion inside other text, which can leave words the checks never saw (an option, say)`;
    const g = a.commands.find((c) => globTurnsUnsafe(c));
    if (g) return `a glob in \`${clip(g.text)}\` can expand to a file name that's an option for it`;
    const m = a.commands.find((c) => mathRuns(c));
    if (m) return `\`${clip(m.text)}\` has arithmetic that can assign or run code (zsh evaluates it)`;
    const c = a.commands.find((c) => !isReadOnlySimple(c.argv));
    return c ? `\`${clip(c.text)}\` isn't one of the read-only commands` : undefined;
}

/** A word that's one parameter (`$x`, `${x}`, `$1`, `${#x}`, `$?`), alone or before a path: its value, nothing spliced into text. */
const STANDALONE_EXPANSION = /^\$(?:[A-Za-z_][A-Za-z0-9_]*|\d|[#?$!@*-]|\{#?(?:[A-Za-z_][A-Za-z0-9_]*|\d+|[#?$!@*-])\})(?:\/.*)?$/;

/** Read-only whatever options or operands they're given (none runs a program or writes a file). Not stat: zsh/stat's -A names a parameter. */
const GLOB_SAFE = new Set(["cat", "head", "tail", "wc", "ls", "echo", "du", "df", "grep", "egrep", "fgrep", "cut", "tr", "diff", "cmp", "comm", "nl", "column", "basename", "dirname", "realpath", "readlink", "md5", "md5sum", "shasum", "sha256sum", "sha1sum", "hexdump", "od", "strings", "true", "false", "which", "whereis", "type", "sleep", "seq", "expr", "cd", "pwd"]);

/**
 * The read-only checks see the words as written, but a glob becomes the
 * names it matches: a file named `-Osh` makes `git grep -l x *` run sh, one
 * named `-i.txt` makes `sed -n p *` edit in place, and `uniq src/*` writes
 * to its second match. A glob that could start with `-` (it's first, after
 * an expansion or empty quotes, or after a `-`: `--open*`), before any `--`,
 * is fine only for programs no option makes unsafe; uniq and xxd take no
 * glob at all (a second operand is their output file).
 */
function globTurnsUnsafe(c: SimpleCommand): boolean {
    if (!c.globbed?.length) return false;
    const words = effectiveArgv(c.argv);
    const base = (words[0] ?? "").split("/").pop()!;
    if (base === "uniq" || base === "xxd") return true;
    // printf takes options only before its format, which mathRuns checks with its arguments.
    if (GLOB_SAFE.has(base) || base === "printf") return false;
    // find takes `-delete` and `-exec` after its paths, `--` or not.
    const end = base === "find" ? -1 : optionsEnd(c);
    return c.globbed.some((i) => (end < 0 || i < end) && (c.globStart?.includes(i) || c.argv[i]!.startsWith("-")));
}

/** printf conversions that print their argument as text; zsh evaluates any other's (and `*`'s) as arithmetic. */
const TEXT_CONVERSION = /^%(?:%|[-+ #0'0-9.$]*[sbqc])$/;
/** An argument arithmetic can only read: a plain number. */
const PLAIN_NUMBER = /^[-+]?(?:0[xX][0-9a-fA-F]+|\d+\.?\d*|\.\d+)$/;

/**
 * zsh evaluates some builtins' arguments as arithmetic, and arithmetic can
 * assign: `printf %d 'a[$(cmd)]=1'` runs cmd, `printf %d PATH=1` empties
 * PATH for what follows. So do printf's `%n` and `*`, and `test -t`. Such an
 * argument must be a plain number, written out (not an expansion or glob);
 * bash's `test -v` and `-R` take a name, which must be a plain one.
 * A format that's an expansion or glob can be anything, `%n` too.
 */
function mathRuns(c: SimpleCommand): boolean {
    const words = effectiveArgv(c.argv);
    const base = (words[0] ?? "").split("/").pop()!;
    const off = c.argv.length - words.length;
    const plain = (i: number) => i < words.length && !c.expands?.includes(off + i) && !c.globbed?.includes(off + i) && PLAIN_NUMBER.test(words[i]!);
    // bash (4.2+) reads `-v`'s and `-R`'s operand as a name, `a[$(cmd)]` included: it must be a plain name.
    const name = (i: number) => i < words.length && !c.expands?.includes(off + i) && !c.globbed?.includes(off + i) && /^[A-Za-z_][A-Za-z0-9_]*$/.test(words[i]!);
    // An operator we can't read (an expansion or glob: `echo -t; test $_ …`) could be `-t`/`-v`/`-R`; if the
    // operand it would govern is a literal carrying a command substitution, that substitution runs.
    const hiddenOp = (i: number) => !!(c.expands?.includes(off + i) || c.globbed?.includes(off + i));
    const inject = (i: number) => i < words.length && !c.expands?.includes(off + i) && !c.globbed?.includes(off + i) && /\$\(|`/.test(words[i]!);
    if (base === "test" || base === "[") return words.some((w, i) => i + 1 < words.length && words[i + 1] !== "]" && ((w === "-t" && !plain(i + 1)) || ((w === "-v" || w === "-R") && !name(i + 1)) || (hiddenOp(i) && inject(i + 1))));
    if (base !== "printf") return false;
    const f = words[1] === "--" ? 2 : 1;
    if (f >= words.length) return false;
    if (c.expands?.includes(off + f) || c.globbed?.includes(off + f)) return true;
    // zsh reads `\u0025d` as `%d` before it looks for conversions: other than plain ones (`\n`), an escape could be one.
    const format = words[f]!.replace(/\\[ntrabfve\\"']/g, "");
    const specs = format.match(/%[^a-zA-Z%]*[a-zA-Z%]?/g) ?? [];
    if (!format.includes("\\") && specs.every((sp) => TEXT_CONVERSION.test(sp))) return false;
    return words.slice(f + 1).some((_, k) => !plain(f + 1 + k));
}

/**
 * Where the options surely end: at a `--` no option could take as its value
 * (`git grep -e -- *` searches for `--`, and the `*` can still be options).
 * Only after a word that isn't an option, a `--`, or a `--name=value`, and
 * isn't an expansion (`-e $empty -- *` is `-e -- *`).
 */
function optionsEnd(c: SimpleCommand): number {
    const { argv } = c;
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] !== "--") continue;
        const prev = argv[i - 1]!;
        if (c.expands?.includes(i - 1)) continue;
        if (!prev.startsWith("-") || prev === "-" || prev === "--" || (prev.startsWith("--") && prev.includes("="))) return i;
    }
    return -1;
}

// Not zgrep: it exits 1 for errors of its own (macOS: "Illegal seek" on a bad stream).
const GREPS = new Set(["grep", "egrep", "fgrep", "ggrep", "rg"]);
const SHELL_SYNTAX = /(^|[\s;&|])(if|then|else|elif|fi|for|while|until|do|done|case|esac|function|select|exit|return|set|setopt|trap)(?=$|[\s;&|])|[{}]|pipe_?fail/i;
/**
 * Reserved words, and builtins that change what a later command is or how
 * its errors show, or end the shell (an error in a POSIX special builtin ends
 * a POSIX shell, silently with `2>/dev/null`). Before the search, it can't
 * run, quoted or not (`e""xit 1`, `command -p eval ...`).
 */
const SHELL_WORDS = new Set([
    "if", "then", "else", "elif", "fi", "for", "while", "until", "do", "done", "case", "esac", "function", "select", "coproc", "repeat", "foreach", "end",
    "break", "continue", "eval", "exec", "exit", "export", "readonly", "return", "set", "shift", "times", "trap", "unset",
    "source", "alias", "unalias", "builtin", "emulate", "setopt", "unsetopt", "typeset", "declare", "local", "integer", "float", "hash", "rehash", "unhash",
    "enable", "disable", "functions", "unfunction", "autoload", "zmodload", "shopt", "logout", "bye", "ulimit", "limit", "unlimit",
]);
/** Special builtins whose names are common arguments too (`ls .`): only where a command starts. */
const SHELL_COMMANDS = new Set([".", ":"]);

interface SearchOptions {
    /** Short options on their own. Digits (`-3`, context lines) are always fine. */
    flags: string;
    /** Short options that take a value: the rest of the word, or the next word. */
    valued: string;
    long: Set<string>;
    /** Long options that take a value: after `=`, or the next word. */
    longValued: Set<string>;
}

/**
 * Search options whose status 1 still means "no match". Anything else, or an
 * abbreviation (getopt takes them), and the status isn't read as no match:
 * -v and -L invert it, BSD grep's -Z/-J/-X/-M and rg's -z exit 1 on a stream
 * they can't decompress, git grep's --not inverts too.
 */
const SEARCH_OPTIONS: Record<string, SearchOptions> = {
    grep: {
        flags: "abcEFGhHiIlnoPqrRswxU",
        valued: "ABCefm",
        long: new Set(["text", "byte-offset", "count", "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "no-filename", "with-filename", "ignore-case", "no-ignore-case", "files-with-matches", "line-number", "only-matching", "quiet", "silent", "no-messages", "word-regexp", "line-regexp", "recursive", "dereference-recursive", "line-buffered", "binary", "color", "colour", "null"]),
        longValued: new Set(["include", "exclude", "exclude-dir", "exclude-from", "binary-files", "context", "after-context", "before-context", "max-count", "regexp", "file", "label", "color", "colour", "directories", "devices"]),
    },
    rg: {
        flags: "iSsFwxnNlcoqHIaUPLp.u0",
        valued: "ABCefgtTmMjdE",
        long: new Set(["hidden", "no-ignore", "no-ignore-vcs", "ignore-case", "smart-case", "case-sensitive", "fixed-strings", "word-regexp", "line-regexp", "line-number", "no-line-number", "files-with-matches", "count", "count-matches", "only-matching", "quiet", "multiline", "pcre2", "follow", "no-heading", "heading", "no-messages", "with-filename", "no-filename", "text", "unrestricted", "vimgrep", "column", "no-config", "null"]),
        longValued: new Set(["glob", "iglob", "type", "type-not", "max-count", "max-depth", "context", "after-context", "before-context", "regexp", "file", "color", "colors", "sort", "sortr", "max-columns", "threads", "encoding", "max-filesize"]),
    },
    git: {
        flags: "niwlchHEFGPoqWIa",
        valued: "ABCefm",
        long: new Set(["line-number", "ignore-case", "word-regexp", "files-with-matches", "name-only", "count", "no-index", "untracked", "cached", "heading", "break", "extended-regexp", "fixed-strings", "basic-regexp", "perl-regexp", "only-matching", "quiet", "and", "or", "all-match", "full-name", "recurse-submodules", "column", "show-function", "function-context", "text", "null"]),
        longValued: new Set(["max-depth", "context", "after-context", "before-context", "max-count", "regexp", "file", "color", "threads"]),
    },
};

/** A max count that makes it look: a plain number above 0 (`-m 0`, `+0`, `-0` and `0x0` don't, or aren't plain). */
const searchingCount = (value: string | undefined) => value === undefined || (/^\d+$/.test(value) && Number(value) > 0);

/**
 * Every option in `args` is one of `o`'s, and none is a max count of 0 (then
 * it doesn't look). The long options it takes as options go in `seen`.
 */
function plainSearch(args: string[], o: SearchOptions, seen = new Set<string>()): boolean {
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (a === "--") return true;
        // An operand (a pattern, a path); GNU grep takes options after them too, so keep looking.
        if (!a.startsWith("-") || a === "-") continue;
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            const name = a.slice(2, eq < 0 ? undefined : eq);
            let value = eq < 0 ? undefined : a.slice(eq + 1);
            seen.add(name);
            if (eq < 0 && o.long.has(name)) continue;
            if (!o.longValued.has(name)) return false;
            // --color and --context take theirs only after `=`.
            if (value === undefined && !["color", "colour", "context"].includes(name)) value = args[++i];
            if (name === "max-count" && !searchingCount(value)) return false;
            continue;
        }
        for (let k = 1; k < a.length; k++) {
            const ch = a[k]!;
            if (/[0-9]/.test(ch)) continue;
            if (o.valued.includes(ch)) {
                // -C only takes the next word when it's a number: BSD grep's takes its own only in the
                // same word, so in `-C -v` the -v is an option. The others always take the next word (`-m +0`).
                const value = k + 1 < a.length ? a.slice(k + 1) : ch !== "C" || /^\d+$/.test(args[i + 1] ?? "") ? args[++i] : undefined;
                if (ch === "m" && !searchingCount(value)) return false;
                break;
            }
            if (!o.flags.includes(ch)) return false;
        }
    }
    return true;
}

/**
 * The search program (grep, rg, git grep) whose exit status is the whole
 * command's, when the text makes that certain. Their status 1 means "no
 * match", not a failure. It must be:
 * - last, the real one (`./grep`, `rg --pre`, `git grep -O` run something else),
 *   run directly (`nice grep` exits 1 itself when it can't lower the priority),
 *   and not inverted (`-v`, `-L`: then 1 isn't "no match");
 * - run (not after `&&`, where an earlier failure ends the list with its own status),
 *   not backgrounded, negated (`! a | grep x`) or behind pipefail;
 * - with no redirection in its pipeline the shell can fail on before it runs
 *   (`grep x < f`: if f can't be opened, the 1 is the shell's);
 * - after nothing that changes the shell or can end it (builtins, assignments
 *   other than formatting ones: `UID=5 true 2>/dev/null` ends zsh with 1),
 *   and with no here-document, whose lines aren't commands.
 * `piped`: other commands feed it, and their failures don't show in its status.
 */
export function finalSearch(cmd: string, env: Record<string, string | undefined> = process.env): { name: string; piped: boolean } | undefined {
    const a = analyzeCommand(cmd);
    if (a.unparsable || a.hasSubstitution || a.unsafeExpansion || a.heredoc || a.bareRedirect || SHELL_SYNTAX.test(cmd) || !a.commands.length) return undefined;
    if (a.trailing !== undefined && a.trailing !== ";" && a.trailing !== "\n") return undefined;
    const last = a.commands.length - 1;
    const argv = effectiveArgv(a.commands[last]!.argv);
    const prog = (argv[0] ?? "").split("/").pop()!;
    const name = GREPS.has(prog) ? prog : prog === "git" && argv[gitSubcommand(argv).index] === "grep" ? "git grep" : undefined;
    if (!name) return undefined;
    const raw = a.commands[last]!.argv;
    if (raw.length - raw.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) !== argv.length) return undefined;
    // ggrep is GNU grep.
    if (!isReadOnlySimple(name === "ggrep" ? [argv[0]!.replace(/[^/]*$/, "grep"), ...argv.slice(1)] : argv)) return undefined;
    // Its words are what it gets: none may expand to an option (`grep $o x f`, or `grep x *` with a file named -v).
    if (a.commands[last]!.expands?.length || a.commands[last]!.globStart?.length) return undefined;
    // Only options known to leave status 1 meaning "no match" (not -v, -L, git's --not, decompressing, -m 0).
    const kind = name === "git grep" ? "git" : name === "rg" ? "rg" : "grep";
    const args = name === "git grep" ? argv.slice(gitSubcommand(argv).index + 1) : argv.slice(1);
    const seen = new Set<string>();
    if (!plainSearch(args, SEARCH_OPTIONS[kind]!, seen)) return undefined;
    // Options from the environment count too: BSD grep reads GREP_OPTIONS, rg its config file (one per
    // line) unless told --no-config. A relative config path is the shell's cwd's, which isn't known here.
    if (kind === "grep" && env.GREP_OPTIONS?.trim() && !plainSearch(env.GREP_OPTIONS.trim().split(/\s+/), SEARCH_OPTIONS.grep!)) return undefined;
    // --no-config as an option, not a pattern (`-e --no-config`).
    if (kind === "rg" && env.RIPGREP_CONFIG_PATH && !seen.has("no-config")) {
        // All of it, or not at all: options past what's read would go unseen.
        const config = env.RIPGREP_CONFIG_PATH.startsWith("/") ? readSmallFile(env.RIPGREP_CONFIG_PATH, 65537) : undefined;
        if (config === undefined || Buffer.byteLength(config) > 65536) return undefined;
        if (!plainSearch(config.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")), SEARCH_OPTIONS.rg!)) return undefined;
    }
    for (const [i, c] of a.commands.entries()) {
        if (!onlySafeAssignments(c.argv)) return undefined;
        if (i === last) continue;
        if (c.argv.some((w) => SHELL_WORDS.has(w))) return undefined;
        const words = effectiveArgv(c.argv);
        const command = words.find((w) => !w.startsWith("-")) ?? "";
        // A command name that's an expansion can be any builtin (`$X 1` with X=exit).
        const at = c.argv.length - words.length + words.indexOf(command);
        if (SHELL_COMMANDS.has(command) || c.expands?.includes(at) || c.globStart?.includes(at)) return undefined;
    }
    // The pipeline it ends, and what comes before that.
    let first = last;
    while (first > 0 && a.commands[first]!.after === "|") first--;
    if (a.commands[first]!.after === "&&") return undefined;
    const pipeline = a.commands.slice(first, last + 1);
    // Negated anywhere in it (`time -p ! a | grep x` negates the pipeline too).
    if (pipeline.some((c) => c.redirectMayFail || c.argv.includes("!"))) return undefined;
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
 * `cwdOk`) the current/parent directory. In every spelling: on a
 * case-insensitive volume `/USERS/ME` is your home.
 */
function criticalTarget(t: string, cwdOk = false): boolean {
    const homes = [homedir(), ...spellings(homedir())];
    return [t, ...spellings(t)].some((s) => criticalSpelling(s, homes, cwdOk));
}

const USERS_DIR = anyCase(/^\/(Users|home)\/[^/]+$/);

function criticalSpelling(t: string, homes: string[], cwdOk: boolean): boolean {
    let p = t.replace(/^\$\{?HOME\}?(?=\/|$)/, "~");
    const home = homes.find((h) => p === h || p.startsWith(h + "/"));
    if (home) p = "~" + p.slice(home.length);
    while (p.length > 1 && /(\/|\/\.|\/\*)$/.test(p)) p = p.replace(/(\/|\/\.|\/\*)$/, "");
    if (p === "" || p === "/" || /^~[^/]*$/.test(p)) return true;
    if (!cwdOk && (p === "." || p === "*" || /^\.\.(\/\.\.)*$/.test(p))) return true;
    return /^\/[^/]+$/.test(p) || USERS_DIR.test(p);
}

/** A word as the shell reads it back. */
export function shellWord(w: string): string {
    return /^[\w@%+=:,./~-]+$/.test(w) ? w : "'" + w.replace(/'/g, "'\\''") + "'";
}

/** The argv checks of dangerousReason, for each program the command runs (through env, exec, nohup…), by any name it's found by. */
function dangerousArgv(argv0: string[], depth: number): string | undefined {
    for (const { argv, at } of runLevels(argv0)) {
        // What env -S's string runs: checked as a command line of its own, so the patterns see it too.
        if (at < 0) return depth < 4 ? dangerousReason(argv.map(shellWord).join(" "), depth + 1) : undefined;
        const prog = argv[0];
        const args = argv.slice(1);
        const dd = args.indexOf("--");
        const opts = dd < 0 ? args : args.slice(0, dd);
        const operands = dd < 0 ? positional(args) : [...positional(args.slice(0, dd)), ...args.slice(dd + 1)];
        if (runs(prog, "rm") && opts.some((a) => /^-[a-zA-Z]*[rR]/.test(a) || a === "--recursive") && operands.some((o) => criticalTarget(o))) {
            return "recursive delete of a root, home or parent directory";
        }
        if (runs(prog, "find") && args.some((a) => a === "-delete" || a === "-exec" || a === "-execdir") && criticalTarget(args[0] ?? ".", true)) {
            return "deletes or runs commands across a root or home directory";
        }
        // Look inside `sh -c '...'` and `eval ...`.
        if (runs(prog, ...SHELLS)) {
            const c = args.findIndex((a) => /^-[a-zA-Z]*c$/.test(a));
            if (c >= 0 && args[c + 1] !== undefined) {
                const r = dangerousReason(args[c + 1]!);
                if (r) return r;
            }
        }
        if (runs(prog, "eval") && args.length) {
            const r = dangerousReason(args.join(" "));
            if (r) return r;
        }
    }
    return undefined;
}

/** Shells whose `-c` script the checks look inside. */
export const SHELLS = ["sh", "bash", "zsh", "dash", "ksh"];

/**
 * The command line with each program's name as the volume finds it (`RM`
 * as rm, `/BIN/SH` as /bin/sh) and unquoted (`"sudo"` as sudo), so the
 * patterns above see it; the rest is left as written. One per spelling.
 */
function programsSpelled(cmd: string): string[] {
    const a = analyzeCommand(cmd);
    const out = new Set<string>();
    for (const fold of [...CASE_FOLDS]) {
        const edits: [number, number, string][] = [];
        for (const c of a.commands) {
            for (const { argv, at } of runLevels(c.argv)) {
                const span = at >= 0 ? c.spans[at] : undefined;
                if (span) edits.push([span[0], span[1], fold(argv[0]!)]);
            }
        }
        let t = cmd;
        for (const [from, to, name] of edits.sort((x, y) => y[0] - x[0])) t = t.slice(0, from) + name + t.slice(to);
        if (t !== cmd) out.add(t);
    }
    return [...out];
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
const STARTUP_FILE = anyCase(/>\s*~\/\.(bash|zsh)(rc|_profile|env)|>\s*~\/\.profile/);

/** Returns a reason if the command matches a known-catastrophic pattern. */
export function dangerousReason(cmd: string, depth = 0): string | undefined {
    const said = withoutMessages(cmd);
    for (const text of [said, ...programsSpelled(said)]) for (const [re, reason] of DANGEROUS) if (re.test(text)) return reason;
    const spelled = [said, ...spellings(said)];
    if (spelled.some((t) => CREDENTIAL_STORE.test(t))) return "touches the harness credential store";
    if (spelled.some((t) => STARTUP_FILE.test(t))) return "overwrites a shell startup file";
    if (depth > 4) return undefined;
    const a = analyzeCommand(cmd);
    for (const c of a.commands) {
        const r = dangerousArgv(c.argv, depth);
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

function recursiveGrep(args: string[]): boolean {
    return args.some((a, i) => /^-[^-]*[rR]/.test(a) || /^--(recursive|dereference-recursive|directories=recurse)$/.test(a) || ((a === "-d" || a === "--directories") && args[i + 1] === "recurse"));
}

/** Search operands and file-valued options, keeping patterns and formatting values out of path checks. */
function accountSearchArgs(program: string, args: string[]) {
    if (program === "find") {
        const first = args.find((a) => !["-H", "-L", "-P"].includes(a));
        return { paths: args, files: [], cwd: first === undefined || /^[-!(]/.test(first), flags: args };
    }
    const listing = program === "ls" || program === "tree";
    const grep = /^(grep|egrep|fgrep)$/.test(program);
    const valued = program === "rg" ? RG_VALUE_SHORT : grep ? SEARCH_OPTIONS.grep!.valued + "dD" : program === "ls" ? "ITw" : program === "tree" ? "LPIo" : program === "fd" ? "eEtdj" : "";
    const longValued = program === "rg" ? RG_VALUE_LONG : grep ? SEARCH_OPTIONS.grep!.longValued : new Set(["glob", "iglob", "include", "exclude", "ignore", "hide", "type", "extension", "max-depth", "threads"]);
    const knownFlags = program === "rg" ? SEARCH_OPTIONS.rg!.flags : grep ? SEARCH_OPTIONS.grep!.flags : program === "ls" ? "ABCFGHLOPRSTUW@abcdefghiklmnopqrstuwx1" : program === "tree" ? "adfFlpqrstuxACDSQNhv" : "";
    const operands: string[] = [];
    const files: string[] = [];
    const flags: string[] = [];
    let pattern = listing;
    let end = false;
    let uncertain = false;
    const value = (name: string, v: string | undefined) => {
        if (/^(rg|grep|egrep|fgrep|ag|ack)$/.test(program) && ["e", "f", "regexp", "file"].includes(name)) pattern = true;
        if (v !== undefined && ["f", "file", "exclude-from", "ignore-file", "pre"].includes(name)) files.push(v);
        if ((name === "d" || name === "directories") && v === "recurse") flags.push("--recursive");
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (end || !a.startsWith("-") || a === "-") { operands.push(a); continue; }
        if (a === "--") { end = true; continue; }
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            const name = a.slice(2, eq < 0 ? undefined : eq);
            flags.push("--" + name);
            if (program === "rg" && name === "files") pattern = true;
            if (longValued.has(name)) {
                // grep's optional long values only follow '='.
                const v = eq >= 0 ? a.slice(eq + 1) : grep && ["color", "colour", "context"].includes(name) ? undefined : args[++i];
                value(name, v);
            } else if (program !== "rg" && !grep) uncertain = true;
            // rg/grep's unknown long flags do not turn explicit paths into a cwd search.
            // Other tools retain the conservative fallback for options we cannot parse.
            continue;
        }
        for (let k = 1; k < a.length; k++) {
            const ch = a[k]!;
            flags.push("-" + ch);
            if (valued.includes(ch)) {
                value(ch, k + 1 < a.length ? a.slice(k + 1) : args[++i]);
                break;
            }
            if (!knownFlags.includes(ch) && !/\d/.test(ch)) uncertain = true;
        }
    }
    const paths = operands.slice(pattern ? 0 : 1);
    // Plain grep without files reads stdin; recursive grep defaults to cwd.
    const cwd = (!grep || recursiveGrep(flags)) && (uncertain || paths.length === 0);
    return { paths, files, cwd, flags };
}

/** Copying or archiving a directory reads its descendants even without naming them. */
function accountRecursiveRead(program: string, args: string[]): boolean {
    if (["rsync", "ditto", "cpio", "pax", "rclone"].includes(program)) return true;
    if (program === "tar") return args.some((a, i) => /^--(create|append|update)$/.test(a) || (/^-[^-]*[cru]/.test(a)) || (i === 0 && /^[a-zA-Z]+$/.test(a) && /[cru]/.test(a)));
    const flags = program === "cp" ? "rRa" : program === "zip" || program === "scp" ? "r" : "";
    return (!!flags && args.some((a) => a.startsWith("-") && !a.startsWith("--") && [...a.slice(1)].some((c) => flags.includes(c))))
        || (program === "cp" && args.some((a) => ["--recursive", "--archive"].includes(a)));
}

/** Preserve wrapper operands and expose attached file-option values to path checks. */
function accountWrapperPaths(argv: string[]): string[] {
    const paths = [...argv];
    const w = wrapperOf(argv[0]);
    const file = runs(argv[0], "xargs") ? { short: "a", long: "arg-file" }
        : runs(argv[0], "time") ? { short: "o", long: "output" } : undefined;
    if (!w || !file) return paths;
    for (let i = 1; i < argv.length; i++) {
        const a = argv[i]!;
        if (a === "--" || !a.startsWith("-")) break;
        if (a.startsWith("--")) {
            const eq = a.indexOf("=");
            const name = a.slice(2, eq < 0 ? undefined : eq);
            if (w.long?.some((l) => l.startsWith(name))) {
                const value = eq < 0 ? argv[++i] : a.slice(eq + 1);
                if (file.long.startsWith(name) && value !== undefined) paths.push(value);
            }
        } else for (let k = 1; k < a.length; k++) {
            const ch = a[k]!;
            if (w.attached?.includes(ch)) break;
            if (!w.short.includes(ch)) continue;
            const value = k + 1 < a.length ? a.slice(k + 1) : argv[++i];
            if (ch === file.short && value !== undefined) paths.push(value);
            break;
        }
    }
    return paths;
}

/** Copy/archive sources recurse; destinations and archive files only touch their own paths. */
function accountCopyPaths(program: string, args: string[]): { paths: string[]; outputs: string[] } {
    const paths: string[] = [];
    const outputs: string[] = [];
    const operands: number[] = [];
    const rcloneCopy = program === "rclone" && ["copy", "copyto", "sync", "move", "moveto"].includes(args[0] ?? "");
    const copy = ["cp", "rsync", "scp", "ditto"].includes(program) || rcloneCopy;
    const short = program === "cp" ? "tS" : program === "rsync" ? "efBT" : program === "scp" ? "cDFiJloPS"
        : program === "tar" ? "fCbTX" : program === "zip" ? "bntP" : "";
    const flags = program === "cp" ? "abdfHiILlnPpRrsTuvxZ" : program === "rsync" ? "0468aAbcCdDEghHiklKLmnNoOpPqrRsStuUvWxXyz"
        : program === "scp" ? "346ABCOpqRrsTv" : program === "ditto" ? "vVX" : program === "rclone" ? "Pqv"
        : program === "zip" ? "rRqv09jmuFSXy" : "";
    const long = new Set(["exclude", "include", "exclude-from", "include-from", "filter", "files-from", "rsh", "suffix", "target-directory", "file", "directory", "block-size", "temp-dir", "backup-dir", "compress-level", "bwlimit", "max-size", "min-size"]);
    const longFlags = new Set(["recursive", "archive", "verbose", "quiet", "force", "no-clobber", "no-target-directory", "dry-run", "progress", "delete", "checksum", "list-only"]);
    let target = false;
    let end = false;
    let uncertain = false;
    const value = (name: string, v: string | undefined) => {
        if (v === undefined) return;
        if ((program === "cp" && ["t", "target-directory"].includes(name)) || (program === "tar" && ["f", "file"].includes(name))) {
            outputs.push(v);
            if (program === "cp") target = true;
        } else if (!["exclude", "include"].includes(name)) paths.push(v);
    };
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        if (rcloneCopy && i === 0) continue;
        if (!end && a === "--") { end = true; continue; }
        const traditionalTar = !end && program === "tar" && i === 0 && /^[a-zA-Z]+$/.test(a);
        if (!end && a.startsWith("--")) {
            const eq = a.indexOf("=");
            const name = a.slice(2, eq < 0 ? undefined : eq);
            const matches = [...long, ...longFlags].filter((n) => n.startsWith(name));
            const option = long.has(name) || longFlags.has(name) ? name : matches.length === 1 ? matches[0]! : name;
            if (long.has(option)) value(option, eq < 0 ? args[++i] : a.slice(eq + 1));
            else {
                if (!longFlags.has(option)) uncertain = true;
                paths.push(a);
            }
        } else if (!end && ((a.startsWith("-") && a !== "-") || traditionalTar)) {
            paths.push(traditionalTar ? "-" + a : a);
            for (let k = traditionalTar ? 0 : 1; k < a.length; k++) {
                const ch = a[k]!;
                if (!short.includes(ch)) {
                    if (!flags.includes(ch)) uncertain = true;
                    continue;
                }
                value(ch, traditionalTar || k + 1 === a.length ? args[++i] : a.slice(k + 1));
                if (!traditionalTar) break;
            }
        } else {
            operands.push(paths.length);
            paths.push(a);
        }
    }
    // Unknown options may consume a word that looks like a source. Do not then
    // demote the only real source to a destination (e.g. a one-path rsync listing).
    const output = uncertain ? undefined : program === "zip" ? operands[0]
        : copy && !target && !args.includes("--list-only") && operands.length >= 2 ? operands.at(-1) : undefined;
    if (output !== undefined) outputs.push(...paths.splice(output, 1));
    return { paths, outputs };
}

/** A later stage can turn a name-only listing into reads or execution. */
function accountListingConsumer(commands: SimpleCommand[], index: number): boolean {
    for (let i = index + 1; i < commands.length && commands[i]!.after === "|"; i++) {
        const c = commands[i]!;
        const words = analyzeCommand(c.text.replace(/^[\s({]+/, "")).commands[0]?.argv ?? [];
        if (runLevels(words).some(({ argv }) => runs(argv[0], "xargs", "parallel", ...SHELLS))) return true;
        if (words[0] === "while" && words.slice(1).some((w) => w === "read")) return true;
    }
    return false;
}

/** Account directories are private even when a command has an explicit allow rule. */
export function accountTarget(cmd: string, cwd: string): boolean {
    const folders = [...new Set(accountFolders().flatMap((p) => [p, canonical(p)]).flatMap(spellings))];
    const files = accountCredentialFiles().flatMap(spellings);
    if (!folders.length && !files.length) return false;
    const analysis = analyzeCommand(cmd);
    const forms = (p: string, dir: string) => {
        const abs = expandPath(p.replace(/^\$\{?HOME\}?(?=\/|$)/, homedir()), dir);
        return [abs, canonical(abs)].flatMap(spellings);
    };
    const touches = (word: string, dir: string, search = false, contents = false, namesOnly = false) => {
        if (!word || word.startsWith("-")) return false;
        // A static prefix suffices to reject globs without enumerating private files.
        const at = word.search(/[*?\[]/);
        const p = at < 0 ? word : word.slice(0, at).replace(/[^/]*$/, "") || ".";
        return forms(p, dir).some((f) =>
            folders.some((a) => isInside(f, a) || ((search || at >= 0) && isInside(a, f))) ||
            files.some((a) => f === a || ((contents || (at >= 0 && !namesOnly)) && isInside(a, f))));
    };
    let dirs = [cwd];
    for (const [index, c] of analysis.commands.entries()) {
        const levels = runLevels(c.argv);
        const argv = effectiveArgv(levels.at(-1)?.argv ?? c.argv);
        // Wrappers can open files of their own (xargs -a, time -o). Keep their operands.
        const wrappers = levels.flatMap((l, i) => i + 1 < levels.length
            ? accountWrapperPaths(l.argv.slice(0, Math.max(1, l.argv.length - levels[i + 1]!.argv.length)))
            : wrapperOf(l.argv[0]) ? accountWrapperPaths(l.argv) : []);
        const program = programNames(argv[0] ?? "").at(-1)!;
        const search = /^(rg|grep|egrep|fgrep|ag|ack|find|fd|ls|tree)$/.test(program);
        const args = argv.slice(1);
        const parsed = search ? accountSearchArgs(program, args) : undefined;
        const recursive = accountRecursiveRead(program, args);
        const copied = recursive ? accountCopyPaths(program, args) : undefined;
        const operands = parsed?.paths ?? copied?.paths ?? args;
        const direct = [...wrappers, ...(parsed?.files ?? []), ...(copied?.outputs ?? [])];
        const flags = parsed?.flags ?? args;
        // Inspect embedded paths too (python -c 'open("/private/account/auth.json")').
        // Search patterns and option values are not filesystem operands.
        const texts = (parsed || recursive ? [...direct, ...operands] : [c.text, ...argv]).flatMap(spellings);
        if ([...folders, ...files].some((f) => texts.some((t) => t.includes(f)))) return true;
        const executes = program === "find" ? args.some((a) => /^-(exec|execdir|ok|okdir|delete)$/.test(a))
            : program === "fd" ? flags.some((a) => /^-[xX]$|^--exec(?:-batch)?$/.test(a))
            : program === "rg" && flags.includes("--pre");
        const namesOnly = !executes && (/^(ls|tree|find|fd)$/.test(program) || (program === "rg" && flags.includes("--files")));
        const contents = executes || (namesOnly && accountListingConsumer(analysis.commands, index)) || recursive
            || (/^(rg|ag|ack)$/.test(program) && !namesOnly) || (/^(grep|egrep|fgrep)$/.test(program) && recursiveGrep(flags));
        if (dirs.some((d) => touches(d, d))) return true;
        if (parsed?.cwd && dirs.some((d) => touches(d, d, true, contents, namesOnly))) return true;
        for (const word of operands) {
            if (dirs.some((d) => touches(word, d, search || contents, contents, namesOnly))) return true;
        }
        for (const word of direct) {
            if (dirs.some((d) => touches(word, d))) return true;
        }
        if (analysis.redirects.some((p) => dirs.some((d) => touches(p, d)))) return true;
        const to = cdDestination(effectiveArgv(c.argv), c.text);
        if (to !== undefined) dirs = [...new Set([...dirs, ...dirs.map((d) => expandPath(to, d))])].slice(0, 32);
    }
    return analysis.redirects.some((p) => dirs.some((d) => touches(p, d)));
}

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

// ripgrep's options that take the next word as their value (ripgrep 15.2's --help).
const RG_VALUE_SHORT = "efEmjgdtTABCMr";
const RG_VALUE_LONG = new Set([
    "regexp", "file", "pre", "pre-glob", "dfa-size-limit", "encoding", "engine", "max-count", "regex-size-limit", "threads", "glob", "iglob",
    "ignore-file", "max-depth", "maxdepth", "max-filesize", "type", "type-not", "type-add", "type-clear", "after-context", "before-context",
    "color", "colors", "context", "context-separator", "field-context-separator", "field-match-separator", "hostname-bin", "hyperlink-format",
    "max-columns", "path-separator", "replace", "sort", "sortr", "generate",
]);

/**
 * Words of a search that only keep files out of it: ripgrep's `!` globs
 * (`-g '!.env*'`, `--glob=!…`, `--iglob …`) and grep's `--exclude=` and
 * `--exclude-dir=`. Naming a .env there isn't reading it. The program must be
 * the real one, spelled exactly (as for the read-only check), and its options
 * are followed one by one, so a `-g` that's another option's value doesn't
 * count (in `rg -e -g '!/.env'` the last word is a path), and nothing after
 * `--` does. Indexes into argv.
 */
function exclusionWords(argv: string[]): number[] {
    const eff = effectiveArgv(argv);
    const off = argv.length - eff.length;
    const word = eff[0] ?? "";
    const slash = word.lastIndexOf("/");
    if (slash >= 0 && !SYSTEM_BIN.has(word.slice(0, slash))) return [];
    const prog = word.slice(slash + 1);
    const out: number[] = [];
    if (prog === "rg") {
        for (let i = 1; i < eff.length; i++) {
            const a = eff[i]!;
            if (a === "--") break;
            if (/^--(glob|iglob)=!/.test(a) || /^-g!/.test(a)) out.push(off + i);
            else if (a.startsWith("--")) {
                if (!a.includes("=") && RG_VALUE_LONG.has(a.slice(2))) {
                    if ((a === "--glob" || a === "--iglob") && eff[i + 1]?.startsWith("!")) out.push(off + i + 1);
                    i++;
                }
            } else if (a.startsWith("-") && a.length > 1) {
                // A cluster: the first letter that takes a value takes the rest of the word, or the next word.
                const k = [...a.slice(1)].findIndex((ch) => RG_VALUE_SHORT.includes(ch));
                if (k >= 0 && k === a.length - 2) {
                    if (a[k + 1] === "g" && eff[i + 1]?.startsWith("!")) out.push(off + i + 1);
                    i++;
                }
            }
        }
    } else if (["grep", "egrep", "fgrep", "ggrep"].includes(prog)) {
        for (let i = 1; i < eff.length; i++) {
            const a = eff[i]!;
            if (a === "--") break;
            if (a.startsWith("--")) {
                const eq = a.indexOf("=");
                const name = a.slice(2, eq < 0 ? undefined : eq);
                if (name === "exclude" || name === "exclude-dir") out.push(off + i + (eq < 0 ? 1 : 0));
                // By any prefix, as getopt_long takes them: `--fil x` is `--file x`.
                if (eq < 0 && name && GREP_VALUE_LONG.some((l) => l.startsWith(name))) i++;
            } else if (a.startsWith("-") && a.length > 1) {
                const k = [...a.slice(1)].findIndex((ch) => GREP_VALUE_SHORT.includes(ch));
                if (k >= 0 && k === a.length - 2) i++;
            }
        }
    }
    return out.filter((i) => i < argv.length);
}

// grep's options that take a value, BSD grep's (macOS) and GNU grep's (with its undocumented -X).
const GREP_VALUE_SHORT = "ABCDdefmX";
const GREP_VALUE_LONG = [
    "after-context", "before-context", "context", "devices", "directories", "regexp", "file", "max-count", "exclude", "exclude-dir",
    "exclude-from", "include", "include-dir", "label", "binary-files", "group-separator",
];

/**
 * The messages of git commit, tag and the like (`-m`, `--message`), by
 * argv index, per simple command: git neither runs nor opens them, so
 * "Fix .claude worktrees" or "Remove the rm calls" in one isn't a path or a
 * command. Only on a line of nothing but git, written out (`git add -A &&
 * git commit -m …`): anything else on it could change what `git` is (a
 * function, alias, PATH, hash, sourced file) or feed it (a substitution, a
 * pipe that could take git's output to a shell), and a redirect, expansion
 * or glob could move the words (`-m >~/.zshrc`, `$X -m .env` with X=-F).
 */
export function messageWords(a: CommandAnalysis): number[][] {
    const none = a.commands.map(() => []);
    if (a.unparsable || a.hasSubstitution || a.unsafeExpansion || a.commands.some((c) => c.after === "|")) return none;
    const plainGit = (c: SimpleCommand) => (c.argv[0] === "git" || c.argv[0] === "/usr/bin/git") && !c.redirectMayFail && !c.expands?.length && !c.globbed?.length;
    if (!a.commands.every(plainGit)) return none;
    return a.commands.map((c) => {
        const argv = c.argv;
        const { index } = gitSubcommand(argv);
        if (!["commit", "tag", "notes", "merge", "revert", "stash"].includes(argv[index] ?? "")) return [];
        const out: number[] = [];
        // Only past options known to take no value: after any other (`-F`, `--fil`, which git
        // takes for --file), the next word may be its value, so the rest stays as it is.
        for (let i = index + 1; i < argv.length && argv[i] !== "--"; i++) {
            const w = argv[i]!;
            if (w === "--message" || /^-[aqvsne]*m$/.test(w)) out.push(++i);
            else if (w.startsWith("--message=") || /^-[aqvsne]*m./.test(w)) out.push(i);
            else if (w.startsWith("-") && !/^-[aqvsne]+$/.test(w) && !GIT_FLAGS.has(w)) break;
        }
        return out.filter((i) => i < c.argv.length);
    });
}

// Options of git commit, tag and the like that take no value.
const GIT_FLAGS = new Set(["--all", "--quiet", "--verbose", "--signoff", "--no-verify", "--amend", "--allow-empty", "--no-edit", "--edit", "--annotate", "--force", "--no-ff", "--ff-only"]);

/** The command line with those messages blanked out, everything else in its place. */
export function withoutMessages(cmd: string): string {
    const a = analyzeCommand(cmd);
    let t = cmd;
    const spans = messageWords(a).flatMap((m, k) => m.map((i) => a.commands[k]!.spans[i]!));
    for (const [from, to] of spans.sort((x, y) => y[0] - x[0])) t = t.slice(0, from) + " ".repeat(to - from) + t.slice(to);
    return t;
}

/**
 * Commands that look at credential files ask first even when read-only.
 * Output is redacted either way; this keeps the model from going fishing.
 * With `cwd`, glob words are expanded so `cat .e*` is caught too. A search's
 * exclusions (`rg -g '!.env*'`) don't count when the command line has
 * nothing the analysis can't follow (expansions, substitutions).
 */
export function sensitiveTarget(cmd: string, opts: { cwd?: string; harnessHome?: string } = {}): string | undefined {
    const a = analyzeCommand(cmd);
    const plain = !a.unparsable && !a.hasSubstitution && !a.unsafeExpansion;
    // Words count by position, so not when one can turn into more or fewer (an
    // expansion, a glob: `--exclude dir*/.env`) or isn't the command's (`<.env`).
    // And only when nothing on the line can change what `rg` or `grep` is: the line is read-only
    // (all of notReadOnly's checks: `printf 'x%n' PATH` assigns), each command written out (no `PATH=./bin grep`, `path=./bin;`, `. ./defs.sh`, `hash`).
    const plainLine = isReadOnlyCommand(cmd) && a.commands.every((c) => c.argv[0] === effectiveArgv(c.argv)[0] && !runs(c.argv[0], "hash"));
    const fixed = (c: SimpleCommand) => plain && plainLine && !c.redirectMayFail && !c.expands?.length && !c.globbed?.length;
    const excluded = a.commands.map((c) => new Set(fixed(c) ? exclusionWords(c.argv) : []));
    messageWords(a).forEach((m, k) => m.forEach((i) => excluded[k]!.add(i)));
    // The command line without them: blanked where they were, so the rest keeps its places.
    let text = cmd;
    for (const [from, to] of a.commands.flatMap((c, k) => [...excluded[k]!].map((i) => c.spans[i]!)).sort((x, y) => y[0] - x[0])) text = text.slice(0, from) + " ".repeat(to - from) + text.slice(to);
    const commands = a.commands.map((c, k) => ({ ...c, argv: c.argv.filter((_, i) => !excluded[k]!.has(i)) }));
    // The words as the shell reads them too, so quoting (`cat .e''nv`) doesn't hide a name.
    const unquoted = commands.map((c) => c.argv.join(" ")).join(" ; ");
    const direct = matchSensitive(text, opts.harnessHome) ?? matchSensitive(unquoted, opts.harnessHome);
    if (direct || !opts.cwd) return direct;
    // Each pattern in every folder its command might run in (`cd private && cat .e*`). A cd
    // can fail (`cd x || cat .e*`) or run in a pipeline's subshell (`cd x | cat .e*`), so the
    // folders before it count too.
    let dirs: string[] | null = [opts.cwd];
    for (const c of commands) {
        const argv = effectiveArgv(c.argv);
        if (argv[0] === "cd" || argv[0] === "pushd") {
            const to = cdDestination(argv, c.text);
            if (to === undefined) dirs = null;
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
    for (const chunk of text.split(/[/\s'"]/)) {
        let dot = false;
        let firstDot = false;
        let boundary = true;
        for (let i = 0; i < chunk.length; i++) {
            const c = chunk[i]!;
            if (c === "`") return true;
            if (c === "$") {
                // These expand to digits (or nothing); consume the pair so $$? isn't scanned as $? again.
                if (chunk[i - 1] === "\\" || !/[?#!$]/.test(chunk[i + 1] ?? "")) return true;
                // With no background job, $! is empty: .$!. can still become .. .
                if (chunk[i + 1] !== "!") firstDot = boundary = false;
                i++;
                continue;
            }
            if ((dot && /[*?[]/.test(c)) || (firstDot && c === ".")) return true;
            firstDot = boundary && c === ".";
            dot ||= firstDot;
            boundary = c === "=" || c === ":";
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
    for (const { programs, dir } of commandsWithDirs(cmd, cwd)) {
        for (const argv of programs) {
            if (!runs(argv[0], "git")) continue;
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
function cdDestination(argv: string[], text: string): string | undefined {
    if (argv[0] !== "cd" && argv[0] !== "pushd") return undefined;
    let i = 1;
    while (/^-[PL]+$/.test(argv[i] ?? "")) i++;
    if (argv[i] === "--") i++;
    const to = argv[i];
    return to !== undefined && argv.length === i + 1 && !/^[-~+]|\$|[*?[]/.test(to) && !/\$/.test(text) ? to : undefined;
}

/**
 * The commands of a command line with the directory each runs in, following
 * `cd`. null: a `cd` the text doesn't settle (see cdDestination). `programs`: what
 * each one runs, through its wrappers (runLevels). `cd` is matched exactly:
 * `CD x` is /usr/bin/cd, which changes the directory of its own process only.
 */
export function commandsWithDirs(cmd: string, cwd: string | undefined): { argv: string[]; programs: string[][]; dir: string | null | undefined; text: string }[] {
    const out: { argv: string[]; programs: string[][]; dir: string | null | undefined; text: string }[] = [];
    let dir: string | null | undefined = cwd;
    for (const c of analyzeCommand(cmd).commands) {
        const argv = effectiveArgv(c.argv);
        if (argv[0] === "cd" || argv[0] === "pushd") {
            const to = cdDestination(argv, c.text);
            if (dir !== undefined) dir = dir === null || to === undefined ? null : resolve(dir, to);
            continue;
        }
        out.push({ argv, programs: runLevels(c.argv).map((l) => l.argv), dir, text: c.text });
    }
    return out;
}

export function configTarget(cmd: string, harnessHome?: string): string | undefined {
    if (isReadOnlyCommand(cmd)) return undefined;
    const a = analyzeCommand(cmd);
    const messages = messageWords(a);
    const unquoted = a.commands.map((c, k) => c.argv.filter((_, i) => !messages[k]!.includes(i)).join(" ")).join(" ; ");
    // In every spelling: on a case-insensitive volume `.harneſſ/` is `.harness/`.
    const homes = harnessHome ? spellings(harnessHome) : [];
    for (const text of [withoutMessages(cmd), unquoted].flatMap(spellings)) {
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
