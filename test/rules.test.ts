import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "fs";
import { homedir, tmpdir } from "os";
import { join } from "path";

// Isolate from the real ~/.cavvy before loading anything that reads paths.
const prevCavvyHome = process.env.CAVVY_HOME;
const CAVVY_HOME = mkdtempSync(join(tmpdir(), "cavvy-test-"));
process.env.CAVVY_HOME = CAVVY_HOME;

const { parseRule, matchPath, bashRuleMatches, ruleMatches, findMatch, EDIT_TOOLS, READ_TOOLS } = await import("../src/permissions/rules");

afterAll(() => {
    if (prevCavvyHome === undefined) delete process.env.CAVVY_HOME;
    else process.env.CAVVY_HOME = prevCavvyHome;
    rmSync(CAVVY_HOME, { recursive: true, force: true });
});

// matchPath/ruleMatches are pure string logic; a synthetic root keeps them
// independent of the filesystem.
const ROOT = "/w";

describe("parseRule", () => {
    test("bare tool name has no spec", () => {
        expect(parseRule("Bash")).toEqual({ tool: "Bash", spec: undefined, raw: "Bash" });
    });

    test("tool with spec", () => {
        expect(parseRule("Bash(npm test)")).toEqual({ tool: "Bash", spec: "npm test", raw: "Bash(npm test)" });
    });

    test("trims the rule and the spec", () => {
        expect(parseRule("  Read( src/** )  ")).toEqual({ tool: "Read", spec: "src/**", raw: "Read( src/** )" });
    });

    test("empty parentheses mean no spec (whole tool)", () => {
        expect(parseRule("Bash()").spec).toBeUndefined();
        expect(parseRule("Bash(   )").spec).toBeUndefined();
    });

    test("nested parentheses stay inside the spec", () => {
        expect(parseRule("Bash(echo (x))")).toMatchObject({ tool: "Bash", spec: "echo (x)" });
    });

    test("multi-line specs are kept whole", () => {
        expect(parseRule("Bash(echo a\necho b)").spec).toBe("echo a\necho b");
    });

    test("MCP names with wildcards parse as the tool", () => {
        expect(parseRule("mcp__github__*")).toEqual({ tool: "mcp__github__*", spec: undefined, raw: "mcp__github__*" });
    });

    test("malformed rule becomes a literal tool name that matches nothing real", () => {
        const r = parseRule("Bash(unbalanced");
        expect(r.tool).toBe("Bash(unbalanced");
        expect(r.spec).toBeUndefined();
        expect(ruleMatches(r, { toolName: "Bash", command: "unbalanced" }, ROOT, "allow")).toBe(false);
    });
});

describe("matchPath", () => {
    test.each([
        // spec, absolute path, expected
        ["src/**", "/w/src/a/b.ts", true],
        ["src/**", "/w/lib/a.ts", false],
        ["src/**", "/w/srcx/a.ts", false],
        ["src/*.ts", "/w/src/a.ts", true],
        ["src/*.ts", "/w/src/x/a.ts", false],
        ["/src/*.ts", "/w/src/a.ts", true],
        ["./docs/**", "/w/docs/x.md", true],
        ["./docs/**", "/w/other/docs/x.md", false],
        ["**/*.ts", "/w/a.ts", true],
        ["**/*.ts", "/w/a/b/c.ts", true],
        ["*.env", "/w/a/b/prod.env", true],
        [".env", "/w/.env", true],
        [".env", "/w/sub/.env", true],
        [".env", "/w/.envrc", false],
        ["a?.ts", "/w/ab.ts", true],
        ["a?.ts", "/w/a/.ts", false],
        ["//etc/hosts", "/etc/hosts", true],
        ["//etc/hosts", "/w/etc/hosts", false],
        // Regex metacharacters in specs are literal.
        ["/x.(ts)", "/w/x.(ts)", true],
        ["/x.ts", "/w/xxts", false],
    ] as const)("%p vs %p -> %p", (spec, abs, expected) => {
        expect(matchPath(spec, abs, ROOT)).toBe(expected);
    });

    test("a non-glob directory spec covers everything under it", () => {
        expect(matchPath("/src", "/w/src/a.ts", ROOT)).toBe(true);
        expect(matchPath("secrets/", "/w/secrets/key.pem", ROOT)).toBe(true);
        expect(matchPath("//etc", "/etc/passwd", ROOT)).toBe(true);
    });

    test("directory specs do not match sibling prefixes", () => {
        expect(matchPath("/src", "/w/srcx", ROOT)).toBe(false);
        expect(matchPath("/src", "/w/srcx/a.ts", ROOT)).toBe(false);
    });

    test("~/ specs are relative to the home directory", () => {
        expect(matchPath("~/notes/**", join(homedir(), "notes", "a.md"), ROOT)).toBe(true);
        expect(matchPath("~/notes/**", "/w/notes/a.md", ROOT)).toBe(false);
    });

    // BUG: the comment in rules.ts says '"dir/" or "dir" should cover
    // everything under it', but a bare name without a slash is rewritten to
    // <root>/**/dir, and the directory fallback then runs relative() against
    // that literal "**" path, so it never matches files inside the directory.
    // A deny rule like Read(secrets) therefore does not protect secrets/key.pem.
    test("a bare directory name covers files inside it (Read(secrets) -> secrets/key.pem)", () => {
        expect(matchPath("secrets", "/w/secrets", ROOT)).toBe(true);
        expect(matchPath("secrets", "/w/secrets/key.pem", ROOT)).toBe(true);
    });
});

describe("bashRuleMatches", () => {
    test("no spec matches any command", () => {
        expect(bashRuleMatches(undefined, "rm -rf build", "allow")).toBe(true);
    });

    test.each([
        // spec, command, expected (allow mode)
        ["npm test", "npm test", true],
        ["npm test", "  npm test  ", true],
        ["npm test", "npm test x", false],
        ["npm test:*", "npm test", true],
        ["npm test:*", "npm test --watch", true],
        ["npm test:*", "npm testx", false],
        ["npm test:*", "time npm test", true],
        ["git * main", "git push origin main", true],
        ["git * main", "git push origin dev", false],
        ["npm test:*", "", false],
    ] as const)("allow %p vs %p -> %p", (spec, cmd, expected) => {
        expect(bashRuleMatches(spec, cmd, "allow")).toBe(expected);
    });

    test("allow rules must match every simple command in a compound command", () => {
        expect(bashRuleMatches("npm test:*", "npm test && rm -rf ~", "allow")).toBe(false);
        expect(bashRuleMatches("npm test:*", "npm test; rm -rf build", "allow")).toBe(false);
        expect(bashRuleMatches("npm test:*", "npm test | tee log", "allow")).toBe(false);
        expect(bashRuleMatches("git * main", "git push origin main; rm x", "allow")).toBe(false);
        expect(bashRuleMatches("npm test:*", "npm test && npm test -- --watch", "allow")).toBe(true);
    });

    test("deny rules match if ANY simple command matches", () => {
        expect(bashRuleMatches("rm:*", "ls && rm x", "deny")).toBe(true);
        expect(bashRuleMatches("rm:*", "ls | rm x", "deny")).toBe(true);
        expect(bashRuleMatches("rm:*", "ls", "deny")).toBe(false);
    });

    test("deny rules see through env prefixes, wrappers, quoting and escapes", () => {
        expect(bashRuleMatches("rm:*", "FOO=1 rm x", "deny")).toBe(true);
        expect(bashRuleMatches("rm:*", "time rm x", "deny")).toBe(true);
        expect(bashRuleMatches("rm:*", "command rm x", "deny")).toBe(true);
        expect(bashRuleMatches("rm:*", '"rm" x', "deny")).toBe(true);
        expect(bashRuleMatches("rm:*", "\\rm x", "deny")).toBe(true);
        expect(bashRuleMatches("git push:*", "git  push", "deny")).toBe(true);
    });

    // BUG: with command substitution the allow check falls back to matching
    // the raw string, so a prefix rule approves whatever runs inside $(...)
    // or backticks. `Bash(npm test:*)` approves `npm test $(rm -rf src)`.
    test("prefix allow rules do not approve commands hidden in $(...) or backticks", () => {
        expect(bashRuleMatches("npm test:*", "npm test $(rm -rf src)", "allow")).toBe(false);
        expect(bashRuleMatches("npm test:*", "npm test `rm -rf src`", "allow")).toBe(false);
    });
});

describe("ruleMatches", () => {
    const r = (s: string) => parseRule(s);

    test("* matches any tool", () => {
        expect(ruleMatches(r("*"), { toolName: "Bash", command: "ls" }, ROOT, "allow")).toBe(true);
        expect(ruleMatches(r("*"), { toolName: "WebFetch", url: "https://x.dev" }, ROOT, "allow")).toBe(true);
    });

    test("Edit covers every edit tool, Read covers every read tool", () => {
        for (const name of EDIT_TOOLS) expect(ruleMatches(r("Edit"), { toolName: name, path: "/w/a" }, ROOT, "allow")).toBe(true);
        for (const name of READ_TOOLS) expect(ruleMatches(r("Read"), { toolName: name, path: "/w/a" }, ROOT, "allow")).toBe(true);
        expect([...EDIT_TOOLS].sort()).toEqual(["Edit", "MultiEdit", "NotebookEdit", "Write"]);
        expect([...READ_TOOLS].sort()).toEqual(["Glob", "Grep", "LS", "Read"]);
    });

    test("specific tool names do not widen", () => {
        expect(ruleMatches(r("Write"), { toolName: "Edit", path: "/w/a" }, ROOT, "allow")).toBe(false);
        expect(ruleMatches(r("Read"), { toolName: "Edit", path: "/w/a" }, ROOT, "allow")).toBe(false);
        expect(ruleMatches(r("Edit"), { toolName: "Read", path: "/w/a" }, ROOT, "allow")).toBe(false);
    });

    test("path specs apply to read and edit tools", () => {
        expect(ruleMatches(r("Read(src/**)"), { toolName: "Glob", path: "/w/src/a" }, ROOT, "allow")).toBe(true);
        expect(ruleMatches(r("Edit(src/**)"), { toolName: "Write", path: "/w/lib/a" }, ROOT, "allow")).toBe(false);
    });

    test("a spec never matches a target that lacks the field it needs", () => {
        expect(ruleMatches(r("Read(src/**)"), { toolName: "Read" }, ROOT, "allow")).toBe(false);
        expect(ruleMatches(r("Bash(ls)"), { toolName: "Bash" }, ROOT, "allow")).toBe(false);
        expect(ruleMatches(r("WebFetch(domain:example.com)"), { toolName: "WebFetch" }, ROOT, "allow")).toBe(false);
    });

    test("tools without spec semantics never match a spec", () => {
        expect(ruleMatches(r("TodoWrite(x)"), { toolName: "TodoWrite" }, ROOT, "allow")).toBe(false);
    });

    test.each([
        ["domain:example.com", "https://example.com/a", true],
        ["domain:example.com", "https://docs.example.com/a", true],
        ["domain:example.com", "https://EXAMPLE.com/a", true],
        ["domain:Example.COM", "https://example.com/a", true],
        ["domain:example.com", "https://notexample.com/", false],
        ["domain:example.com", "https://example.com.evil.net/", false],
        ["domain:example.com", "https://example.com@evil.net/", false],
        ["domain:*.example.com", "https://api.example.com/", true],
        ["domain:*.example.com", "https://example.com/", false],
        ["domain:example.com", "not a url", false],
        ["https://example.com", "https://example.com/", false],
    ] as const)("WebFetch(%s) vs %s -> %p", (spec, url, expected) => {
        expect(ruleMatches(r(`WebFetch(${spec})`), { toolName: "WebFetch", url }, ROOT, "allow")).toBe(expected);
    });

    test.each([
        ["mcp__github", "mcp__github__create_issue", true],
        ["mcp__github", "mcp__github", true],
        ["mcp__github__*", "mcp__github__create_issue", true],
        ["mcp__github__create_issue", "mcp__github__create_issue", true],
        ["mcp__github__create_issue", "mcp__github__delete_repo", false],
        ["mcp__git", "mcp__github__create_issue", false],
        ["mcp__github", "Bash", false],
        ["Bash", "mcp__github__create_issue", false],
    ] as const)("%s vs tool %s -> %p", (rule, toolName, expected) => {
        expect(ruleMatches(r(rule), { toolName, command: "x" }, ROOT, "allow")).toBe(expected);
    });

    test("Task rules match the sub-agent type exactly", () => {
        expect(ruleMatches(r("Task(explore)"), { toolName: "Task", agentType: "explore" }, ROOT, "allow")).toBe(true);
        expect(ruleMatches(r("Task(explore)"), { toolName: "Task", agentType: "general-purpose" }, ROOT, "allow")).toBe(false);
    });
});

describe("findMatch", () => {
    test("returns the first matching raw rule string", () => {
        const rules = ["Read(docs/**)", "Bash(npm test:*)", "Bash"];
        expect(findMatch(rules, { toolName: "Bash", command: "npm test" }, ROOT, "allow")).toBe("Bash(npm test:*)");
        expect(findMatch(rules, { toolName: "Bash", command: "rm x" }, ROOT, "allow")).toBe("Bash");
    });

    test("returns undefined when nothing matches", () => {
        expect(findMatch([], { toolName: "Bash", command: "ls" }, ROOT, "allow")).toBeUndefined();
        expect(findMatch(["Read(docs/**)"], { toolName: "Read", path: "/w/src/a" }, ROOT, "allow")).toBeUndefined();
    });

    test("passes the matching mode through to Bash rules", () => {
        const t = { toolName: "Bash", command: "ls && rm x" };
        expect(findMatch(["Bash(rm:*)"], t, ROOT, "deny")).toBe("Bash(rm:*)");
        expect(findMatch(["Bash(rm:*)"], t, ROOT, "allow")).toBeUndefined();
    });
});
