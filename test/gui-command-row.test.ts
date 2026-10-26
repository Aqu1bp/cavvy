import { expect, test } from "bun:test";
import { commandCut, commandMeta, exitCode, highlightShell, outputLines, passTally, taskOf, type ShellToken } from "../gui/src/lib/command-row";

// A command's row (gui/src/lib/command-row.ts): its command highlighted when it's opened, and what the row says
// folded (its exit code, a test run's tally, its summary). Activity.tsx draws from these; find.ts counts the same words.

const kinds = (tokens: ShellToken[], cls: ShellToken["cls"]) => tokens.filter((t) => t.cls === cls).map((t) => t.text);

test("the highlighted command is the command: its tokens join back into it", () => {
    for (const src of ["", "ls", "FOO=1 bun test --bail 'a b' | tee out.txt # go", "cat <<'EOF' > a.txt\nline $x\n  EOF\nEOF\necho done", "a && b || c; d &", 'echo "it\'s \\"q\\"" 2>&1 >> log']) {
        expect(highlightShell(src).map((t) => t.text).join("")).toBe(src);
    }
});

test("command words, flags, strings, operators and comments each have their kind", () => {
    const tokens = highlightShell("FOO=1 bun test --bail -x 'a b' \"c\" | tee out.txt && git push # go");
    // The first word of each stage, not an assignment before it, nor its arguments.
    expect(kinds(tokens, "f")).toEqual(["bun", "tee", "git"]);
    expect(kinds(tokens, "t")).toEqual([" --bail", " -x"]);
    expect(kinds(tokens, "s")).toEqual(["'a b'", '"c"']);
    expect(kinds(tokens, "k")).toEqual(["|", "&&"]);
    expect(kinds(tokens, "c")).toEqual(["# go"]);
    // A redirection's target isn't a command; what comes after a separator is.
    expect(kinds(highlightShell("make > out.log 2>&1; echo ok"), "f")).toEqual(["make", "echo"]);
    // Plain neighbours merge (" test" is one node, not a space and a word): no two in a row.
    expect(tokens.some((t, i) => i > 0 && !t.cls && !tokens[i - 1]!.cls)).toBe(false);
    expect(tokens).toContainEqual({ text: " test" });
});

test("a heredoc's body is one kind, whole, up to its end word; what follows is a command again", () => {
    const tokens = highlightShell("cat <<'EOF' > a.txt\nrm -rf / # not run\n  'quoted'\nEOF\necho done");
    expect(kinds(tokens, "hd")).toEqual(["rm -rf / # not run", "  'quoted'", "EOF"]);
    expect(kinds(tokens, "f")).toEqual(["cat", "echo"]);
    expect(kinds(tokens, "c")).toEqual([]);
    // <<- and an unquoted end word too; an end word that's only part of a line doesn't end it.
    expect(kinds(highlightShell("cat <<-END\nnot END\n\tEND\nls"), "hd")).toEqual(["not END", "\tEND"]);
    expect(kinds(highlightShell("cat <<-END\nnot END\n\tEND\nls"), "f")).toEqual(["cat", "ls"]);
});

test("the exit code is the last one the output or summary says, in Cavvy's words or Codex's", () => {
    expect(exitCode({ output: "error: x\n\nExit code: 1" })).toBe(1);
    expect(exitCode({ output: "Exit code 127" })).toBe(127);
    expect(exitCode({ summary: "Exit code 2", output: "" })).toBe(2);
    expect(exitCode({ output: "Exit code: 1\nretrying\nExit code: -9" })).toBe(-9);
    expect(exitCode({ output: "failed for no stated reason" })).toBeUndefined();
    expect(exitCode({})).toBeUndefined();
    // Only the end of a long output is read.
    expect(exitCode({ output: `Exit code: 3\n${"x".repeat(5000)}` })).toBeUndefined();
});

test("a passing test run's tally is taken from the end of its output", () => {
    expect(passTally({ output: "✓ a\n✓ b\n\n 14 pass\n 0 fail\nRan 14 tests" })).toBe("14 pass");
    expect(passTally({ output: "\x1b[32m 3 pass\x1b[0m\n" })).toBe("3 pass");
    expect(passTally({ output: `1 pass\n${"line\n".repeat(10)}` })).toBeUndefined();
    expect(passTally({ output: "passed everything" })).toBeUndefined();
    expect(passTally({})).toBeUndefined();
});

test("the row's words after the command: its summary, Declined, and no second exit code", () => {
    expect(commandMeta({ status: "ok", summary: "(no output)" })).toBe("(no output)");
    expect(commandMeta({ status: "denied", summary: "anything" })).toBe("Declined");
    expect(commandMeta({ status: "error", summary: "Exit code 1" })).toBeUndefined();
    expect(commandMeta({ status: "error", summary: "Exit code: 2" })).toBeUndefined();
    expect(commandMeta({ status: "error", summary: "Timed out" })).toBe("Timed out");
    expect(commandMeta({ status: "ok", summary: "" })).toBeUndefined();
    expect(commandMeta({ status: "ok" })).toBeUndefined();
    // A background start's summary: the row's tag says it.
    expect(commandMeta({ status: "ok", summary: "Running in background as bash_1", input: { command: "npm run dev", run_in_background: true } })).toBeUndefined();
    expect(commandMeta({ status: "ok", summary: "Running in background as bash_1", input: { command: "npm run dev" } })).toBe("Running in background as bash_1");
    expect(commandMeta({ status: "ok", summary: "2 lines", input: { command: "npm run dev", run_in_background: true } })).toBe("2 lines");
});

test("an opened command's output lines: no terminal codes, no trailing blank lines, any line ending", () => {
    expect(outputLines("\x1b[31mred\x1b[0m\r\nnext\rlast\n\n  \n")).toEqual(["red", "next", "last"]);
    expect(outputLines("\n\nafter blank lines")).toEqual(["", "", "after blank lines"]);
    expect(outputLines("")).toEqual([]);
    expect(outputLines(undefined)).toEqual([]);
    expect(outputLines("\n \n")).toEqual([]);
    // The exit code the tool adds at the end of a failure is the footer's to say; one said earlier is the command's own.
    expect(outputLines("Compiling\nerror: x\n\nExit code: 1", true)).toEqual(["Compiling", "error: x"]);
    expect(outputLines("oops\nExit code 127\n", true)).toEqual(["oops"]);
    expect(outputLines("Exit code: 1\nretrying\n", true)).toEqual(["Exit code: 1", "retrying"]);
    expect(outputLines("Exit code: 2", true)).toEqual([]);
});

test("a command that succeeded keeps a last line that reads like the tool's exit code: it printed it itself", () => {
    // printf 'Exit code: 42\n' exits 0: the tool adds no trailer, so this is the command's whole output.
    expect(outputLines("Exit code: 42\n")).toEqual(["Exit code: 42"]);
    expect(outputLines("build ok\nExit code 0")).toEqual(["build ok", "Exit code 0"]);
});

test("a command the server cut short isn't offered for copying", () => {
    expect(commandCut(`${"x".repeat(4000)}\n… (812 more characters)`)).toBe(true);
    expect(commandCut("echo '… (3 more characters)'")).toBe(false);
    expect(commandCut("bun test")).toBe(false);
});

test("a command's background task: the one linked to its call, else the Cavvy shell its result names", () => {
    const task = (o: Record<string, unknown>) => ({ provider: "cavvy", kind: "shell", label: "npm run dev", startedAt: 1, status: "running", stoppable: true, ...o }) as any;
    const linked = task({ id: "b7", toolUseId: "call1", provider: "claude-code" });
    const shell = task({ id: "bash_2" });
    const tasks = [task({ id: "bash_1" }), shell, linked];
    expect(taskOf({ id: "call1", input: { command: "npm run dev" } }, tasks)).toBe(linked);
    // Cavvy's shells aren't linked to their call: its result names the shell.
    const started = { id: "call2", input: { command: "npm run dev", run_in_background: true }, output: "Started background shell bash_2 (pid 41). Use BashOutput…", startedAt: 1, durationMs: 20 };
    expect(taskOf(started, tasks)).toBe(shell);
    expect(taskOf({ ...started, output: undefined, summary: "Running in background as bash_2" }, tasks)).toBe(shell);
    // Only a command started in the background, and only an unlinked shell: bash_1 isn't bash_10, nor someone else's task.
    expect(taskOf({ ...started, input: { command: "echo Started background shell bash_2." } }, tasks)).toBeUndefined();
    expect(taskOf({ ...started, output: "Started background shell bash_10 (pid 3)" }, tasks)).toBeUndefined();
    expect(taskOf({ ...started, output: "Started background shell b7 (pid 3)" }, tasks)).toBeUndefined();
    expect(taskOf({ id: "call3", input: { command: "ls" } }, tasks)).toBeUndefined();
});

test("a Cavvy shell id used again after a restart doesn't link an old command's row to the new shell", () => {
    // Shell ids are counted per process: before a restart, call2 started bash_1 at t=1000; after it, a new bash_1 starts at t=900000.
    const fresh = { id: "bash_1", provider: "cavvy", kind: "shell", label: "npm run dev", startedAt: 900_000, status: "running", stoppable: true } as any;
    const old = { id: "call2", input: { command: "npm run dev", run_in_background: true }, output: "Started background shell bash_1 (pid 41).", startedAt: 1000, durationMs: 15 };
    expect(taskOf(old, [fresh])).toBeUndefined();
    // Its own shell, started while the call ran, still matches; a call with no start time can't be matched by id at all.
    expect(taskOf(old, [{ ...fresh, startedAt: 1010 }])?.id).toBe("bash_1");
    expect(taskOf({ ...old, startedAt: undefined }, [{ ...fresh, startedAt: 1010 }])).toBeUndefined();
});
