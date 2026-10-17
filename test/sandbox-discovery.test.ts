// Regressions for executable bodies, stdin data, and work-based analysis limits.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
const { cleanup } = isolate();
afterAll(cleanup);
const { commandsWithDirs, analyzeCommand, pushesDefaultBranch, configTarget, shellWord, ANALYSIS_LIMIT } = await import("../src/permissions/bash-safety");
const { looksDestructive, accessNeeded } = await import("../src/permissions/sandbox");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BashTool } = await import("../src/tools/bash");
const ws = tempDir();
writeFileSync(join(ws, "README.md"), "local changes");
mkdirSync(join(ws, "sub"));
const checker = new PermissionChecker(() => ({}), ws, () => "seatbelt");

const ordinary = (cmd: string) => {
    expect(commandsWithDirs(cmd, ws).exhausted).toBe(false);
    expect(looksDestructive(cmd, ws)).toBeUndefined();
    expect(accessNeeded(cmd, ws)).toEqual({});
    expect(pushesDefaultBranch(cmd, ws)).toBeUndefined();
    expect(configTarget(cmd)).toBeUndefined();
    expect(checker.check(BashTool, { command: cmd }, "auto", ws)).toMatchObject({ behavior: "allow", sandbox: true });
};

describe("failed directory changes", () => {
    test.each([
        "cd /__missing_dir__; sh -c 'git checkout README.md'",
        "cd /__missing_dir__; eval 'git checkout README.md'",
        "cd /__missing_dir__; find . -exec git checkout README.md \\;",
        "for x in 1; do cd /__missing_dir__; sh -c 'git checkout README.md'; done",
        "while false; do cd /__missing_dir__; done; eval 'git checkout README.md'",
        "cd README.md; sh -c 'git checkout README.md'",
        "cd /__missing_dir__; cd sub; sh -c 'git checkout README.md'",
        "cd /__missing_dir__ && true; sh -c 'git checkout README.md'",
        "cd /__missing_dir__ && cd sub; sh -c 'git checkout README.md'",
        "cd /__missing_dir__ || sh -c 'git checkout README.md'",
    ])("retains destructive protection: %s", (cmd) => {
        expect(commandsWithDirs(cmd, ws).some((c) => c.argv[0] === "git" && c.dir === null)).toBe(true);
        expect(looksDestructive(cmd, ws)).toBe("git checkout (discards changes)");
        expect(checker.check(BashTool, { command: cmd }, "auto", ws)).toMatchObject({ behavior: "ask", needsClassifier: true });
    });
    test("an unavailable starting directory cannot make failed cd precise", () => {
        expect(commandsWithDirs("cd /__missing_dir__; sh -c 'git checkout README.md'", undefined).some((c) => c.argv[0] === "git" && c.dir === null)).toBe(true);
    });
    test("existing destinations cannot erase origin/main's nested checkout evidence", () => {
        expect(looksDestructive("cd sub; sh -c 'git checkout README.md'", ws)).toBeDefined();
    });
    test("unknown directories protect implicit pushes and local executable lookup", () => {
        expect(pushesDefaultBranch("cd /__missing_dir__; sh -c 'git push'", ws)).toBeDefined();
        expect(accessNeeded("cd /__missing_dir__; sh -c 'npx jest'", ws).network).toBe("npx");
    });
    test.each([
        "cd /__absent__ && git checkout topic",
        "mkdir new-repo && cd new-repo && git checkout topic",
        "cd new-repo && cd sub && git checkout topic",
    ])("success-guarded cd retains its target: %s", ordinary);
});

describe("heredoc executable view", () => {
    test.each([
        "cat > out.txt <<'EOF'\nsh -c 'echo hello'\nEOF",
        "cat <<EOF\nhello\nEOF\nsh -c 'echo hello'",
        "sh -c 'echo hello'; cat <<EOF\nhello\nEOF",
        "cat <<EOF # comment\nsh -c 'echo hello'\nEOF\nsh -c 'echo hello'",
        "cat <<-EOF\n\tsh -c 'echo hello'\n\tEOF\nsh -c 'echo hello'",
        "cat <<\"EOF\"\nsh -c 'echo hello'\nEOF",
        "cat <<E'OF'\nsh -c 'echo hello'\nEOF",
        "cat <<\\EOF\nsh -c 'echo hello'\nEOF",
        "cat <<A <<'B'\nsh -c 'echo hello'\nA\neval 'echo hello'\nB\nsh -c 'echo hello'",
        "python - <<'PY'\nprint('hello')\nPY\nsh -c 'echo hello'",
        "cat <<< 'hello'; sh -c 'echo hello'",
        "cat <<'EOF'\nif true; then sh -c 'echo hello'; fi\nEOF",
    ])("ordinary stdin stays allowed: %s", ordinary);

    test("body discovery skips data but retains the entire original lexer view", () => {
        const cmd = "cat <<'EOF'\nif true; then sh -c 'curl https://example.com'; fi\nEOF\nsh -c 'echo outside'";
        const actual = commandsWithDirs(cmd, ws);
        for (const c of analyzeCommand(cmd).commands) expect(actual.some((a) => a.text === c.text && JSON.stringify(a.argv) === JSON.stringify(c.argv))).toBe(true);
        expect(actual.some((c) => c.argv[0] === "curl")).toBe(false);
        expect(actual.some((c) => c.text === "echo outside")).toBe(true);
        expect(accessNeeded(cmd, ws)).toEqual({});
    });

    test.each(["sh", "bash", "zsh", "dash", "ksh", "eval", "source /dev/stdin", ". /dev/stdin", "xargs sh", "env bash", "bash -n +n", "bash -o noexec +o noexec"])("analyzes stdin scripts for %s", (interpreter) => {
        const cmd = `${interpreter} <<'EOF'\nif true; then git restore README.md; fi\nEOF`;
        expect(commandsWithDirs(cmd, ws).some((c) => c.argv[0] === "git")).toBe(true);
        expect(looksDestructive(cmd, ws)).toBeDefined();
        expect(commandsWithDirs(cmd, ws).exhausted).toBe(false);
    });
    test("shell stdin deletion and real commands after multiple heredocs are protected", () => {
        expect(looksDestructive("bash <<'EOF'\nrm -rf build\nEOF", ws)).toBeDefined();
        expect(accessNeeded("cat <<A <<-B\ndata\nA\n\tdata\n\tB\nsh -c 'curl https://example.com'", ws)).toEqual({ network: "curl" });
        expect(accessNeeded("bash <<'EOF'\nif true; then curl https://example.com; fi\nEOF", ws)).toEqual({ network: "curl" });
        expect(accessNeeded("bash <<< 'if true; then curl https://example.com; fi'", ws)).toEqual({ network: "curl" });
    });
    test.each([
        'bash -c "echo hello"', "bash --version", "bash --help", "bash -n", "bash -o noexec", "bash script.sh", "bash -- script.sh", "bash 3",
    ])("shell stdin is data when %s does not execute it", (shell) => {
        const command = shell === "bash 3" ? "bash 3<<EOF" : shell + " <<EOF";
        ordinary(command + "\nif true; then curl https://example.com; fi\nEOF");
    });
    test("only the final stdin redirection supplies shell code", () => {
        ordinary("bash <<A <<B\nif true; then curl https://example.com; fi\nA\necho hello\nB");
        ordinary("bash <<A </dev/null\nif true; then curl https://example.com; fi\nA");
        expect(accessNeeded("bash <<A <<B\necho hello\nA\nif true; then curl https://example.com; fi\nB", ws)).toEqual({ network: "curl" });
    });
    test("unquoted data joins escaped newlines before matching the delimiter", () => {
        expect(accessNeeded('cat <<EOF\nEO\\\nF\nsh -c "curl https://example.com"', ws)).toEqual({ network: "curl" });
        ordinary("cat <<'EOF'\nEO\\\nF\nsh -c 'curl https://example.com'\nEOF");
    });
    test.each(["EOF", "'EOF'", '"EOF"'])("joins before stripping tabs only for an unquoted delimiter: %s", (delimiter) => {
        const cmd = `cat <<-${delimiter}\n\tEO\\\n\tF\nif true; then curl https://example.com; fi\nEOF`;
        const data = (delimiter === "EOF" ? "EO\tF\n" : "EO\\\nF\n") + "if true; then curl https://example.com; fi\n";
        expect(analyzeCommand(cmd, true).commands[0]?.stdinScripts).toEqual([data]);
        ordinary("bash -c " + shellWord(cmd));
    });
    test("joined unquoted delimiter still ends a tab-stripped heredoc", () => {
        expect(accessNeeded("cat <<-EOF\n\tEO\\\nF\nif true; then curl https://example.com; fi", ws)).toEqual({ network: "curl" });
    });
    test.each(["0>/dev/null", "0>>/dev/null", "0>|/dev/null", "0</dev/null", "0<>/dev/null", "0>&1", "<&1", "0<&-", "0>&-"])("stdin redirections apply left to right: %s", (redirect) => {
        const data = "\nif true; then curl https://example.com; fi\nEOF";
        ordinary(`bash <<'EOF' ${redirect}` + data);
        expect(accessNeeded(`bash ${redirect} <<'EOF'` + data, ws)).toEqual({ network: "curl" });
    });
    test.each([">/dev/null", "2>/dev/null", "3>/dev/null", "0>&0", "0<&0", "0>&'0'", '0>&"0"', "0>&\\0", "0>&$FD", "3<&0 0>/dev/null 0<&3", '3<&0 0>/dev/null 0<&"3"'])("redirections retain live heredoc input: %s", (redirect) => {
        expect(accessNeeded(`bash <<'EOF' ${redirect}\nif true; then curl https://example.com; fi\nEOF`, ws)).toEqual({ network: "curl" });
    });
    test("quoted delimiter continuations preserve data boundaries", () => {
        const prefix = 'cat <<"E\\\nOF"\nfirst\n';
        ordinary(prefix + "\nif true; then curl https://example.com; fi\nEOF");
        expect(accessNeeded(prefix + 'EOF\nsh -c "curl https://example.com"', ws)).toEqual({ network: "curl" });
    });
    test("data with unmatched shell quotes cannot hide a subsequent real command", () => {
        expect(accessNeeded("cat <<EOF\n'\nEOF\nsh -c 'curl https://example.com'", ws)).toEqual({ network: "curl" });
    });
    test("Python input is data even when it resembles a shell body", () => {
        const cmd = "python - <<'PY'\nif true; then sh -c 'curl https://example.com'; fi\nPY";
        expect(accessNeeded(cmd, ws)).toEqual({});
        expect(commandsWithDirs(cmd, ws).exhausted).toBe(false);
    });
});

describe("budgets measure work, not operands or data bytes", () => {
    test.each([
        "git add " + Array.from({ length: 1023 }, (_, i) => `file${i}`).join(" "),
        "git add " + Array.from({ length: 6000 }, (_, i) => `file${i}.ts`).join(" "),
        "python - <<'PY'\n" + "print('x')\n".repeat(511) + "PY",
        "python - <<'PY'\n" + "print('x')\n".repeat(12_000) + "PY",
        "sh -c " + shellWord("python - <<'PY'\n" + "print('x')\n".repeat(5000) + "PY"),
        "sh -c " + shellWord("echo " + "x".repeat(110_000)),
        "sh -c " + shellWord("echo " + "x".repeat(260_000)),
        Array.from({ length: 350 }, (_, i) => `echo ${i}`).join("; "),
    ].map((cmd, index) => [index, cmd] as const))("ordinary large command %i", (_, cmd) => ordinary(cmd));

    test.each([
        Array(20).fill("sh -c " + shellWord("parallel ".repeat(20) + "echo hi")).join("; "),
        "parallel ".repeat(100) + "echo hi",
        "time ".repeat(4000) + "echo hi",
        "find . " + "-exec ".repeat(900) + "echo hi \\;",
        "eval ".repeat(40) + "echo hi",
        Array.from({ length: 8 }).reduce<string>((s) => "sh -c " + shellWord(s), "echo hi"),
    ].map((cmd, index) => [index, cmd] as const))("pathological nesting %i remains fast and protective", (_, cmd) => {
        const start = performance.now();
        const decision = checker.check(BashTool, { command: cmd }, "auto", ws);
        expect(performance.now() - start).toBeLessThan(200);
        expect(decision.behavior).toBe("ask");
        expect(decision.needsClassifier).toBeUndefined();
        expect(commandsWithDirs(cmd, ws).exhausted).toBe(true);
        expect(looksDestructive(cmd, ws)).toBe(ANALYSIS_LIMIT);
    });
});
