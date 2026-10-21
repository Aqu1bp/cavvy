// Where a running sub-agent (Claude Code's, Codex's, Harness's own) is
// working, for the diff reader's worktree picker. A sub-agent has no folder of
// its own on record, so this goes by the paths its recent tool calls name: the
// commands' `cd <dir>` (Codex's commands run elsewhere come as one),
// `git -C <dir>`, `git worktree add <path>`, and the files it reads and edits.
// Only absolute paths count: a relative one's base isn't known. Pure: the GUI
// uses the path helpers too.

import type { AgentRun, ToolBlock, WorktreeAgent } from "./protocol";

/** Tool calls, from the latest back, whose paths decide a sub-agent's worktree. */
const RECENT = 20;

/**
 * An absolute path with `.`, `..` and repeated slashes taken out, `~/` expanded, and macOS's
 * /private/tmp (/var, /etc) written as /tmp, the way both forms reach the same folder.
 * Undefined for a relative path.
 */
export function normalPath(path: string, home?: string): string | undefined {
    let s = path.trim();
    if (s === "~" || s.startsWith("~/")) {
        if (!home) return undefined;
        s = home + s.slice(1);
    }
    if (!s.startsWith("/")) return undefined;
    const parts: string[] = [];
    for (const part of s.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") parts.pop();
        else parts.push(part);
    }
    return `/${parts.join("/")}`.replace(/^\/private(?=\/(?:tmp|var|etc)(?:\/|$))/, "");
}

const within = (path: string, dir: string) => path === dir || path.startsWith(dir === "/" ? "/" : `${dir}/`);

/** The worktree (of `worktrees`, normalized) holding `path`: the deepest, since one can sit inside another (.claude/worktrees). */
export function worktreeOf(path: string, worktrees: string[]): string | undefined {
    let best: string | undefined;
    for (const w of worktrees) if (within(path, w) && (!best || w.length > best.length)) best = w;
    return best;
}

/** A command's words and control operators (&&, ||, ;, |, &, parentheses, newlines), with quotes and escapes taken off. */
export function shellWords(cmd: string): string[] {
    const out: string[] = [];
    let word: string | undefined;
    const end = () => {
        if (word !== undefined) out.push(word);
        word = undefined;
    };
    for (let i = 0; i < cmd.length; i++) {
        const c = cmd[i]!;
        if (c === "'") {
            const close = cmd.indexOf("'", i + 1);
            const stop = close < 0 ? cmd.length : close;
            word = (word ?? "") + cmd.slice(i + 1, stop);
            i = stop;
        } else if (c === '"') {
            word ??= "";
            for (i++; i < cmd.length && cmd[i] !== '"'; i++) {
                if (cmd[i] === "\\" && i + 1 < cmd.length && /["\\$`]/.test(cmd[i + 1]!)) i++;
                word += cmd[i];
            }
        } else if (c === "\\" && i + 1 < cmd.length) {
            if (cmd[i + 1] !== "\n") word = (word ?? "") + cmd[i + 1];
            i++;
        } else if (c === " " || c === "\t") {
            end();
        } else if (c === "\n" || c === ";" || c === "(" || c === ")") {
            end();
            out.push(c === "\n" ? ";" : c);
        } else if (c === "&" || c === "|") {
            end();
            const two = cmd[i + 1] === c;
            out.push(two ? c + c : c);
            if (two) i++;
        } else {
            word = (word ?? "") + c;
        }
    }
    end();
    return out;
}

const OPERATORS = new Set([";", "&&", "||", "|", "&", "(", ")"]);
/** `git worktree add`'s options that take a value. */
const WORKTREE_ADD_VALUES = new Set(["-b", "-B", "--reason"]);
/** git's own options that take a value (besides -C). */
const GIT_VALUES = new Set(["-c", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--config-env"]);

/**
 * The folders a shell command points at, in order: where `cd` (or `pushd`) goes, `git -C`'s folder,
 * and the path `git worktree add` makes. A relative one counts from the last absolute folder the
 * command went to, if any; `home` expands `~`.
 */
export function commandPaths(cmd: string, home?: string): string[] {
    const words = shellWords(cmd);
    const out: string[] = [];
    let dir: string | undefined;
    // Not a variable, a substitution, a glob or `cd -`: where those go isn't in the words.
    const at = (p: string, from = dir) => (/[$`*?]/.test(p) || p === "-" ? undefined : (normalPath(p, home) ?? (from && !p.startsWith("~") ? normalPath(`${from}/${p}`) : undefined)));
    let start = true;
    for (let i = 0; i < words.length; i++) {
        const w = words[i]!;
        if (OPERATORS.has(w)) {
            start = true;
            continue;
        }
        if (!start) continue;
        // Assignments before the command (FOO=1 git …) aren't it.
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) continue;
        start = false;
        if ((w === "cd" || w === "pushd") && i + 1 < words.length && !OPERATORS.has(words[i + 1]!)) {
            const next = words[i + 1]!;
            const target = next === "--" && i + 2 < words.length ? words[i + 2]! : next;
            const p = at(target);
            if (p) out.push((dir = p));
        } else if (w === "git") {
            let gitDir = dir;
            let j = i + 1;
            for (; j < words.length && !OPERATORS.has(words[j]!) && words[j]!.startsWith("-"); j++) {
                const opt = words[j]!;
                if (opt === "-C" && j + 1 < words.length) {
                    const p = at(words[++j]!, gitDir);
                    if (p) out.push((gitDir = p));
                } else if (GIT_VALUES.has(opt)) j++;
            }
            if (words[j] === "worktree" && words[j + 1] === "add") {
                for (let k = j + 2; k < words.length && !OPERATORS.has(words[k]!); k++) {
                    const a = words[k]!;
                    if (WORKTREE_ADD_VALUES.has(a)) k++;
                    else if (a === "--") continue;
                    else if (!a.startsWith("-")) {
                        const p = at(a, gitDir);
                        if (p) out.push(p);
                        break;
                    }
                }
            }
        }
    }
    return out;
}

/** The absolute paths a tool call names, in order: its folder, its command's (a shell's), then the file it reads or edits. */
export function toolPaths(b: Pick<ToolBlock, "name" | "input">, home?: string): string[] {
    const i = b.input ?? {};
    const out: string[] = [];
    const add = (v: unknown) => {
        const p = typeof v === "string" ? normalPath(v, home) : undefined;
        if (p) out.push(p);
    };
    add(i.cwd);
    add(i.workdir);
    if (typeof i.command === "string" && /^(Bash|Shell|shell|exec_command)$/.test(b.name)) out.push(...commandPaths(i.command, home));
    add(i.file_path);
    add(i.notebook_path);
    add(i.path);
    return out;
}

/**
 * The worktree a sub-agent is working in, by its last tool calls: each names the worktree of the
 * last path it holds that's in one, and the worktree named most wins (the latest, on a tie), so
 * a look at another checkout's file doesn't move it.
 */
export function agentWorktree(a: Pick<AgentRun, "blocks">, worktrees: string[], home?: string): string | undefined {
    const votes = new Map<string, { n: number; last: number }>();
    let seen = 0;
    for (let i = a.blocks.length - 1; i >= 0 && seen < RECENT; i--) {
        const b = a.blocks[i]!;
        if (b.t !== "tool") continue;
        seen++;
        const paths = toolPaths(b, home);
        for (let j = paths.length - 1; j >= 0; j--) {
            const w = worktreeOf(paths[j]!, worktrees);
            if (!w) continue;
            const v = votes.get(w);
            votes.set(w, { n: (v?.n ?? 0) + 1, last: v?.last ?? seen });
            break;
        }
    }
    let best: string | undefined;
    for (const [w, v] of votes) {
        const b = best ? votes.get(best)! : undefined;
        if (!b || v.n > b.n || (v.n === b.n && v.last < b.last)) best = w;
    }
    return best;
}

/** A sub-agent that's working now (not one from before the session was reopened). */
export const agentLive = (a: AgentRun) => !a.replayed && (a.status === "running" || a.status === "waiting");

/** The running sub-agents in each of `worktrees` (keyed by its path as listed). */
export function agentsByWorktree(worktrees: string[], runs: { sessionId: string; agent: AgentRun }[], home?: string): Map<string, WorktreeAgent[]> {
    const byNormal = new Map<string, string>();
    for (const w of worktrees) {
        const n = normalPath(w, home);
        if (n && !byNormal.has(n)) byNormal.set(n, w);
    }
    const normals = [...byNormal.keys()];
    const out = new Map<string, WorktreeAgent[]>();
    for (const { sessionId, agent } of runs) {
        if (!agentLive(agent)) continue;
        const w = agentWorktree(agent, normals, home);
        if (!w) continue;
        const key = byNormal.get(w)!;
        out.set(key, [...(out.get(key) ?? []), { id: agent.id, sessionId, description: agent.description || "Sub-agent", waiting: agent.status === "waiting" }]);
    }
    return out;
}
