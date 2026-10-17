// Compare against real origin/main modules, never a hand-authored expected-policy clone.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { dirname, join, resolve } from "path";
import { pathToFileURL } from "url";
import { isolate, tempDir } from "./helpers/isolate";
const { cleanup } = isolate();
const baselineDir = tempDir();
const ws = tempDir();
afterAll(() => { cleanup(); rmSync(baselineDir, { recursive: true, force: true }); rmSync(ws, { recursive: true, force: true }); });
writeFileSync(join(ws, "README.md"), "local changes");
writeFileSync(join(ws, "tracked.txt"), "local changes");
mkdirSync(join(ws, "sub"));
mkdirSync(join(ws, ".git"));
writeFileSync(join(ws, ".git", "HEAD"), "ref: refs/heads/topic\n");
const root = resolve(import.meta.dir, "..");
const modules = ["bash-safety", "sandbox", "rules", "checker"];
for (const name of modules) {
    const sourcePath = `src/permissions/${name}.ts`;
    const result = Bun.spawnSync(["git", "show", `origin/main:${sourcePath}`], { cwd: root, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`Cannot load baseline ${sourcePath}: ${result.stderr.toString()}`);
    // Keep the baseline permission modules together; unchanged dependencies resolve
    // into the working tree. Only these named TypeScript sources are ever read.
    const source = result.stdout.toString().replace(/(from\s+["'])(\.[^"']+)(["'])/g, (_, prefix, path: string, suffix) => {
        const localName = path.replace(/^\.\//, "").replace(/\.ts$/, "");
        const target = modules.includes(localName) ? join(baselineDir, `${localName}.ts`) : resolve(root, dirname(sourcePath), path);
        return prefix + target + suffix;
    });
    writeFileSync(join(baselineDir, `${name}.ts`), source);
}
const originalSafety = await import(pathToFileURL(join(baselineDir, "bash-safety.ts")).href);
const originalSandbox = await import(pathToFileURL(join(baselineDir, "sandbox.ts")).href);
const { PermissionChecker: OriginalChecker } = await import(pathToFileURL(join(baselineDir, "checker.ts")).href);
const safety = await import("../src/permissions/bash-safety");
const sandbox = await import("../src/permissions/sandbox");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BashTool } = await import("../src/tools/bash");
import type { Decision } from "../src/permissions/checker";

const ordinary = [
    "cat <<'EOF'\nEO\\\nF\nsh -c 'curl https://example.com'\nEOF",
    'cat <<"E\\\nOF"\nfirst\n\nif true; then curl https://example.com; fi\nEOF',
    "pwd", "ls -la", "git status --short", "git diff", "git diff --check", "git log -5 --oneline",
    "git add src/index.ts", "git commit -m 'update docs'", "git checkout -b feature", "git checkout topic",
    "git restore --staged README.md", "git switch topic", "mkdir -p build", "cp README.md build/copy.md",
    "mv old.txt new.txt", "touch output.txt", "printf '%s' hello > output.txt", "bun test", "bun run typecheck",
    "python -c 'print(42)'", "node -e 'console.log(42)'", "rg -n TODO src", "find src -name '*.ts'",
    "sh -c 'echo hello'", "eval 'echo hello'", "find . -exec echo {} \\;", "time bun test",
    "for x in 1 2; do echo $x; done", "if true; then echo yes; fi", "case gh in gh) echo gh;; esac",
    "cat > out.txt <<'EOF'\nsh -c 'echo hello'\nEOF",
    "cat <<EOF\nhello\nEOF\nsh -c 'echo hello'",
    "python - <<'PY'\n" + "print('x')\n".repeat(511) + "PY",
    "git add " + Array.from({ length: 1023 }, (_, i) => `file${i}`).join(" "),
    "git add " + Array.from({ length: 6000 }, (_, i) => `file${i}.ts`).join(" "),
    "sh -c " + safety.shellWord("echo " + "x".repeat(110_000)),
    "sh -c " + safety.shellWord("echo " + "x".repeat(260_000)),
    Array.from({ length: 350 }, (_, i) => `echo ${i}`).join("; "),
    "python - <<'PY'\n" + "print('x')\n".repeat(12_000) + "PY",
    "echo 'for n in 1; do gh issue view 29; done'",
    "cat <<'EOF'\nsh -c 'curl https://example.com'\nEOF",
    "sh -c " + safety.shellWord("python - <<'PY'\n" + "print('x')\n".repeat(5000) + "PY"),
    ...['bash -c "echo hello"', "bash --version", "bash --help", "bash -n", "bash -o noexec", "bash script.sh", "bash 3"].map((prefix) => `${prefix}<<EOF\nif true; then curl https://example.com; fi\nEOF`),
    "bash <<A <<B\nif true; then curl https://example.com; fi\nA\necho hello\nB",
    "bash <<A </dev/null\nif true; then curl https://example.com; fi\nA",
];
const protectedCommands = [
    'cat <<EOF\nEO\\\nF\nsh -c "curl https://example.com"',
    'cat <<"E\\\nOF"\nfirst\nEOF\nsh -c "curl https://example.com"',
    "rm -rf build", "git restore README.md", "git checkout README.md", "git reset --hard",
    "git push origin main", "git config core.hooksPath /tmp/hooks", "curl https://example.com", "gh issue view 29",
    "cd /__missing_dir__; sh -c 'git checkout README.md'",
    "cd /__missing_dir__; eval 'git checkout README.md'",
    "cd /__missing_dir__; find . -exec git checkout README.md \\;",
    "for x in 1; do cd /__missing_dir__; sh -c 'git checkout README.md'; done",
    "cd sub; sh -c 'git checkout README.md'",
    "cat <<'EOF'\nsh -c 'git checkout README.md'\nEOF",
    "bash <<'EOF'\nrm -rf build\nEOF",
    "for n in $(seq 1 3); do curl -s https://example.com; done",
    "for n in 1; do for m in 2; do gh issue view 29; done; done",
    "case x in a) true;; b) case y in *) gh issue view 29;; esac;; esac",
    "find . -name -exec -exec git restore tracked.txt \\;",
    `sh -c 'python -c "os.'remove'(path)"'`,
    "sh -c 'git checkout tracked.txt'; find . -execdir git checkout tracked.txt \\;",
    "cat <<EOF\nhello\nEOF\nsh -c 'git restore tracked.txt'",
    "sh -c 'git restore tracked.txt'; cat <<EOF\nhello\nEOF",
    ...["cat <<'EOF'\ncase x in\nEOF\n", "case x in case ) true;; esac; "].flatMap((prefix) => [
        "git restore tracked.txt", "git push origin main", "curl https://example.com", "git config core.hooksPath /tmp/hooks",
    ].map((suffix) => prefix + suffix)),
    // Earlier timing reproducers are also compared with the baseline. The
    // dedicated regression suite additionally enforces the HEAD latency bound.
    Array(20).fill("sh -c " + safety.shellWord("parallel ".repeat(20) + "echo hi")).join("; "),
    Array(1500).fill("echo hi").join("; "),
    "time ".repeat(4000) + "echo hi",
    "find . " + "-exec ".repeat(900) + "echo hi \\;",
    "parallel ".repeat(100) + "echo hi",
    "eval ".repeat(40) + "git push origin main",
    Array.from({ length: 8 }).reduce<string>((cmd) => "sh -c " + safety.shellWord(cmd), "git restore tracked.txt"),
    "if ".repeat(40) + "git restore tracked.txt",
];

function protection(d: Decision): number {
    return d.behavior === "deny" ? 3 : d.behavior === "ask" ? (d.needsClassifier ? 1 : 2) : 0;
}
function restrictions(d: Decision) {
    return { behavior: d.behavior, classifier: !!d.needsClassifier, sandbox: !!d.sandbox, dangerous: !!d.dangerous };
}

describe("origin/main differential policy invariants", () => {
    test.each([...ordinary.map((cmd, i) => [true, `ordinary ${i}`, cmd] as const), ...protectedCommands.map((cmd, i) => [false, `protective ${i}`, cmd] as const)])("%s %s", (routine, _name, cmd) => {
        // Test actual checker decisions, with and without sandbox and explicit rules.
        for (const kind of ["seatbelt", undefined] as const) for (const settings of [{}, { permissions: { allow: ["Bash(*)"] } }, { permissions: { deny: ["Bash(git restore:*)"] } }]) {
            const old = new OriginalChecker(() => settings, ws, () => kind);
            const current = new PermissionChecker(() => settings, ws, () => kind);
            for (const mode of ["auto", "default", "plan", "bypassPermissions"] as const) {
                const before: Decision = old.check(BashTool, { command: cmd }, mode, ws);
                const after = current.check(BashTool, { command: cmd }, mode, ws);
                expect(protection(after), `${_name}: ${mode}/${kind}: ${JSON.stringify({ before, after })}`).toBeGreaterThanOrEqual(protection(before));
                if (before.dangerous) expect(after.dangerous).toBe(true);
                if (before.behavior === "allow" && before.sandbox && after.behavior === "allow") expect(after.sandbox).toBe(true);
                if (routine) expect(restrictions(after)).toEqual(restrictions(before));
            }
        }
        const oldAccess = originalSandbox.accessNeeded(cmd, ws);
        const newAccess = sandbox.accessNeeded(cmd, ws);
        for (const key of ["host", "network"] as const) if (oldAccess[key]) expect(newAccess[key]).toBeDefined();
        for (const [before, after] of [
            [originalSandbox.looksDestructive(cmd, ws), sandbox.looksDestructive(cmd, ws)],
            [originalSafety.pushesDefaultBranch(cmd, ws), safety.pushesDefaultBranch(cmd, ws)],
            [originalSafety.configTarget(cmd), safety.configTarget(cmd)],
        ]) {
            if (before) expect(after).toBeDefined();
            if (routine) expect(!!after).toBe(!!before);
        }
        if (routine) expect(newAccess).toEqual(oldAccess);
    }, 30_000);
});
