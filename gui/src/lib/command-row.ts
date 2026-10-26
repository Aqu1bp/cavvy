// A command's row (Activity.tsx CommandCard): what it says folded (its label, its exit, its tally), and its
// command highlighted when it's opened. Find (find.ts) counts the same words the row shows.

import type { BackgroundTaskInfo, ToolBlock } from "@shared/protocol";
import { stripAnsi } from "./format";
import { commandDescription } from "./tool-words";

/**
 * What a command's row says folded: what it's for (Claude Code's description), or, with none (Codex), the command
 * itself, shortened: its first line, past a cd to where it runs ("cd '/repo' && bun test" says "bun test").
 */
export function commandLabel(t: ToolBlock): string | undefined {
    const description = commandDescription(t);
    if (description) return description;
    const first = String(t.input?.command ?? "").trim().split("\n")[0]!;
    return /^cd\s+(?:'[^']*'|"[^"]*"|[^\s;&|'"]+)\s*&&\s*(\S.*)$/.exec(first)?.[1] ?? (first || undefined);
}

/** A piece of a highlighted command: `cls` is its kind (f command, t flag, s string, k operator, c comment, hd heredoc body). */
export type ShellToken = { text: string; cls?: "f" | "t" | "s" | "k" | "c" | "hd" };

const TOKEN = /(#.*$)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|(&&|\|\||[|;]|<<-?|>>?|2>&1)|(\s--?[\w-]+(?:=\S+)?)|([^\s'"|;&<>]+)|(\s+)|(.)/g;

/**
 * A small shell highlighter: the command words (the first of each pipeline stage), flags, strings, operators
 * and comments; a heredoc's body is one kind, whole, up to its end word. Concatenated, the tokens are `src`.
 */
export function highlightShell(src: string): ShellToken[] {
    const out: ShellToken[] = [];
    let inDoc: string | undefined;
    src.split("\n").forEach((line, i) => {
        if (i > 0) out.push({ text: "\n" });
        if (inDoc !== undefined) {
            out.push({ text: line, cls: "hd" });
            if (line.trim() === inDoc) inDoc = undefined;
            return;
        }
        const doc = /<<-?\s*['"]?(\w+)['"]?/.exec(line);
        if (doc) inDoc = doc[1];
        let cmdNext = true;
        for (const m of line.matchAll(TOKEN)) {
            const [all, comment, str, op, flag, word] = m;
            if (comment) out.push({ text: comment, cls: "c" });
            else if (str) {
                cmdNext = false;
                out.push({ text: str, cls: "s" });
            } else if (op) {
                // After a pipe or a separator comes another command; after a redirection, its target.
                cmdNext = op !== "<<" && op !== "<<-" && !op.startsWith(">") && op !== "2>&1";
                out.push({ text: op, cls: "k" });
            } else if (flag) out.push({ text: flag, cls: "t" });
            else if (word) {
                // An assignment before the command (FOO=1 bun test) isn't the command.
                const assign = /^\w+=/.test(word);
                out.push(cmdNext && !assign ? { text: word, cls: "f" } : { text: word });
                if (!assign) cmdNext = false;
            } else out.push({ text: all });
        }
    });
    // Neighbours of no kind merge: fewer nodes for the same text.
    return out.reduce<ShellToken[]>((acc, t) => {
        const last = acc.at(-1);
        if (last && !last.cls && !t.cls) last.text += t.text;
        else acc.push({ ...t });
        return acc;
    }, []);
}

/** Highlighted tokens split after the first line: that line's, then the rest's (from its newline on). */
export function firstLine(tokens: ShellToken[]): [ShellToken[], ShellToken[]] {
    const i = tokens.findIndex((t) => t.text.includes("\n"));
    if (i < 0) return [tokens, []];
    const t = tokens[i]!;
    const at = t.text.indexOf("\n");
    const head = at ? [...tokens.slice(0, i), { ...t, text: t.text.slice(0, at) }] : tokens.slice(0, i);
    return [head, [{ ...t, text: t.text.slice(at) }, ...tokens.slice(i + 1)]];
}

/** The exit code a failed command's output reports ("Exit code: 1", Codex's "Exit code 1"), the last one said. */
export function exitCode(t: Pick<ToolBlock, "output" | "summary">): number | undefined {
    const text = `${t.summary ?? ""}\n${(t.output ?? "").slice(-4096)}`;
    let code: number | undefined;
    for (const m of text.matchAll(/\bExit code:? (-?\d+)\b/g)) code = Number(m[1]);
    return code;
}

/** A test run's tally ("14 pass") when its output ends with one: said on a command that passed. */
export function passTally(t: Pick<ToolBlock, "output">): string | undefined {
    const lines = stripAnsi(t.output ?? "").split("\n");
    for (let i = lines.length - 1; i >= Math.max(0, lines.length - 8); i--) {
        const m = /^\s*(\d+ pass)\b/.exec(lines[i]!);
        if (m) return m[1];
    }
    return undefined;
}

/**
 * The words a command's row says after the command (find counts them): its summary ("Timed out",
 * "(no output)"), "Declined", or nothing. What the row says otherwise isn't repeated: a failure's
 * "Exit code 1" (the row's "Exit 1"), a background start's "Running in background as bash_1" (its tag).
 */
export function commandMeta(t: Pick<ToolBlock, "status" | "summary" | "input">): string | undefined {
    if (t.status === "denied") return "Declined";
    if (t.status === "error" && /^Exit code:? -?\d+$/.test(t.summary ?? "")) return undefined;
    if (t.input?.run_in_background === true && /\bbackground\b/i.test(t.summary ?? "")) return undefined;
    return t.summary || undefined;
}

/**
 * What a finished command printed, as its row shows it opened: cleaned of terminal codes, without trailing
 * blank lines, nor the exit code the tool adds at the end of a failure ("Exit code: 1"), which the row's
 * footer says. A command that succeeded keeps every line, even one that reads like that trailer (the tool
 * only adds it for a nonzero exit, so there it's the command's own output).
 */
export function outputLines(output: string | undefined, failed = false): string[] {
    if (!output) return [];
    const lines = stripAnsi(output).split(/\r\n|\r|\n/);
    const trim = () => {
        while (lines.length && !lines.at(-1)!.trim()) lines.pop();
    };
    trim();
    if (failed && /^Exit code:? -?\d+$/.test(lines.at(-1)?.trim() ?? "")) {
        lines.pop();
        trim();
    }
    return lines;
}

/** A command the server cut short on its way here (inputs over 4,000 characters, src/server/diffs.ts trimInput): not the whole command, so not one to copy. */
export function commandCut(command: string): boolean {
    return /\n… \(\d+ more characters\)$/.test(command);
}

/** How far apart a Cavvy shell's start and its call's start can be and still be the same run (the call returns once the shell is up). */
const SHELL_START_SLACK_MS = 10_000;

/**
 * The background task a command started: the one linked to its call (Claude Code's, Codex's), else, for a
 * Cavvy shell (which isn't linked), the shell its result names ("Started background shell bash_1", "Running in background as bash_1").
 */
export function taskOf(t: Pick<ToolBlock, "id" | "input" | "summary" | "output" | "startedAt" | "durationMs">, tasks: readonly BackgroundTaskInfo[]): BackgroundTaskInfo | undefined {
    const linked = tasks.find((x) => x.toolUseId === t.id);
    if (linked || t.input?.run_in_background !== true) return linked;
    const said = `${t.summary ?? ""}\n${(t.output ?? "").slice(0, 400)}`;
    const id = /\b(?:background shell|in background as) (\S+?)[\s.,]/.exec(`${said} `)?.[1];
    // Shell ids are counted per Cavvy process (bash_1, bash_2, …), so after a restart a new shell can have
    // an old call's id: the shell must also have started while this call ran, or a Stop here would stop it.
    const at = t.startedAt;
    if (!id || at === undefined) return undefined;
    const until = at + (t.durationMs ?? 0) + SHELL_START_SLACK_MS;
    return tasks.find((x) => x.id === id && !x.toolUseId && x.kind === "shell" && x.startedAt >= at - 1000 && x.startedAt <= until);
}
