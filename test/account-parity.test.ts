// #375: a named CLI account only selects the wrapped CLI's config folder. What Harness asks, allows
// and injects into Claude Code is the same with and without named accounts; only direct access to
// an account's folder or a sign-in file stays denied.
import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { PermissionMode } from "../src/permissions/modes";

const iso = isolate();
const workspace = realpathSync(tempDir("account-parity-ws-"));
// A folder that merely holds a named account's folder (as a home directory does).
const parent = realpathSync(tempDir("account-parity-parent-"));
const folder = join(parent, "work-account");
mkdirSync(folder);
writeFileSync(join(folder, ".credentials.json"), "fake-account-marker");
writeFileSync(join(parent, "notes.txt"), "foo");
const { saveAgentConfig } = await import("../src/providers/registry");
const { claudeArgs } = await import("../src/backends/claude-code");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { searchFilter } = await import("../src/tools/search-tools");
afterAll(() => {
    iso.cleanup();
    rmSync(workspace, { recursive: true, force: true });
    rmSync(parent, { recursive: true, force: true });
});

const withAccount = () => saveAgentConfig("claude-code", { accounts: [{ id: "work", name: "Work", folder, managed: false }] });
const withoutAccounts = () => saveAgentConfig("claude-code", { accounts: [] });
const MODES: PermissionMode[] = ["default", "acceptEdits", "auto", "bypassPermissions", "plan"];

function settings(mode: PermissionMode, readOnly: boolean) {
    return {
        mode, model: { provider: "claude-code", id: "default" }, additionalDirectories: [], readOnly, trusted: true, cwd: workspace,
        rules: { deny: ["Read(secrets/**)"], ask: ["Bash(git push:*)"], root: workspace },
    } as unknown as Parameters<typeof claudeArgs>[1];
}

/** claudeArgs with its --settings parsed, and the static deny rules apart. */
function spawn(mode: PermissionMode, readOnly: boolean) {
    const { args } = claudeArgs("claude-code", settings(mode, readOnly), { append: [] });
    const at = args.indexOf("--settings");
    const parsed = JSON.parse(args[at + 1]!);
    const deny: string[] = parsed.permissions.deny;
    delete parsed.permissions.deny;
    return { args: args.filter((_, i) => i !== at + 1), settings: parsed, deny };
}

test("Claude Code spawn arguments and settings are the same with and without named accounts", () => {
    for (const mode of MODES) {
        for (const readOnly of [false, true]) {
            withoutAccounts();
            const before = spawn(mode, readOnly);
            withAccount();
            const after = spawn(mode, readOnly);
            // No OS sandbox switched on, no forced Bash ask: the CLI's own mode decides.
            expect({ mode, readOnly, args: after.args, settings: after.settings }).toEqual({ mode, readOnly, args: before.args, settings: before.settings });
            // Only static Read/Edit deny rules for account paths are added (they never prompt).
            const added = after.deny.filter((rule) => !before.deny.includes(rule));
            expect(before.deny.every((rule) => after.deny.includes(rule))).toBe(true);
            expect(added.length).toBeGreaterThan(0);
            expect(added.every((rule) => /^(Read|Edit)\(\//.test(rule))).toBe(true);
        }
    }
    withoutAccounts();
});

test("a read-only sub-agent keeps its own Bash ask without the account sandbox", () => {
    withAccount();
    try {
        const { settings: s } = spawn("auto", true);
        expect(s.permissions.ask).toContain("Bash");
        expect(s.sandbox).toEqual({ autoAllowBashIfSandboxed: false });
        expect(spawn("auto", false).settings.sandbox).toBeUndefined();
        expect(spawn("auto", false).settings.permissions.ask).not.toContain("Bash");
    } finally {
        withoutAccounts();
    }
});

const checker = new PermissionChecker(() => ({}), workspace);
const tool = (name: string) => BUILTIN_TOOLS.find((t) => t.name === name)!;
const decide = (name: string, input: unknown, mode: PermissionMode) => {
    const d = checker.check(tool(name), input, mode, workspace);
    return { behavior: d.behavior, reason: d.reason };
};
const CONTAINING: [string, unknown][] = [
    ["Bash", { command: `ls '${parent}'` }],
    ["Bash", { command: `ls -la '${parent}'` }],
    ["Bash", { command: `rg foo '${parent}'` }],
    ["Bash", { command: `grep -rn foo '${parent}'` }],
    ["Bash", { command: `find '${parent}' -name '*.txt'` }],
    ["Bash", { command: `tree '${parent}'` }],
    ["Bash", { command: `cd '${parent}' && rg foo` }],
    ["Grep", { pattern: "foo", path: parent }],
    ["Glob", { pattern: "**/*.txt", path: parent }],
    ["LS", { path: parent }],
];

test("searches and listings of a folder that merely holds an account decide as without accounts", () => {
    for (const mode of ["default", "auto", "bypassPermissions", "acceptEdits", "plan"] as PermissionMode[]) {
        for (const [name, input] of CONTAINING) {
            withoutAccounts();
            const before = decide(name, input, mode);
            withAccount();
            const after = decide(name, input, mode);
            expect({ name, input, mode, ...after }).toEqual({ name, input, mode, ...before });
        }
    }
    withoutAccounts();
});

test("direct access to an account folder or sign-in file is still denied, and searches over its parent hide it file by file", () => {
    withAccount();
    try {
        const secret = join(folder, ".credentials.json");
        for (const mode of MODES) {
            expect(decide("Bash", { command: `cat '${secret}'` }, mode).behavior).toBe("deny");
            expect(decide("Bash", { command: `ls '${folder}'` }, mode).behavior).toBe("deny");
            expect(decide("Bash", { command: `rg foo '${folder}'` }, mode).behavior).toBe("deny");
            expect(decide("Read", { file_path: secret }, mode).behavior).toBe("deny");
            expect(decide("Write", { file_path: secret, content: "x" }, mode).behavior).toBe("deny");
            expect(decide("Grep", { pattern: ".", path: folder }, mode).behavior).toBe("deny");
            expect(decide("LS", { path: folder }, mode).behavior).toBe("deny");
        }
        const hidden = (toolName: string, abs: string) => checker.hiddenFromSearch(toolName, abs);
        for (const name of ["Grep", "Glob", "LS"]) {
            const filter = searchFilter({ hidden }, name, parent)!;
            expect(filter(name, secret)).toBe(true);
            expect(filter(name, join(parent, "notes.txt"))).toBe(false);
        }
    } finally {
        withoutAccounts();
    }
});
