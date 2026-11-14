// A named account's Claude Code memory: its own path is in a denied account folder, so Cavvy points
// Claude Code at the same files by their real path (claude-memory.ts).
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const root = realpathSync(tempDir("claude-memory-"));
const { saveAgentConfig } = await import("../src/providers/registry");
const { claudeMemoryDirectory, claudeMemoryRoot } = await import("../src/backends/claude-memory");
const { claudeArgs } = await import("../src/backends/claude-code");
const { claudePathSlug } = await import("../src/backends/claude-live");

// Default's history, and a Cavvy-made account whose projects/ links to it (account-layout.ts).
const defaultHome = join(root, "default-claude");
const history = join(defaultHome, "projects");
mkdirSync(history, { recursive: true });
const managed = join(iso.home, "accounts", "claude-code", "work");
mkdirSync(managed, { recursive: true });
symlinkSync(history, join(managed, "projects"));
// A repository, a subfolder, a worktree of it, and a folder outside git.
const repo = join(root, "repo");
mkdirSync(join(repo, ".git", "worktrees", "wt"), { recursive: true });
mkdirSync(join(repo, "src"));
writeFileSync(join(repo, ".git", "worktrees", "wt", "commondir"), "../..\n");
const worktree = join(root, "wt");
mkdirSync(worktree);
writeFileSync(join(worktree, ".git"), `gitdir: ${join(repo, ".git", "worktrees", "wt")}\n`);
const plain = join(root, "plain");
mkdirSync(plain);
const memoryOf = (folder: string) => join(realpathSync(history), claudePathSlug(folder), "memory");

const withAccount = () => saveAgentConfig("claude-code", { accounts: [{ id: "work", name: "Work", folder: managed, managed: true }] });
beforeEach(() => saveAgentConfig("claude-code", { accounts: [] }));
afterAll(() => {
    saveAgentConfig("claude-code", { accounts: [] });
    iso.cleanup();
    rmSync(root, { recursive: true, force: true });
});

describe("a named account's memory folder", () => {
    test("is Default's by real path, named after the repository's main folder", () => {
        withAccount();
        expect(claudeMemoryDirectory(managed, repo, true)).toBe(memoryOf(repo));
        expect(claudeMemoryDirectory(managed, join(repo, "src"), true)).toBe(memoryOf(repo));
        expect(claudeMemoryDirectory(managed, worktree, true)).toBe(memoryOf(repo));
        expect(claudeMemoryDirectory(managed, plain, true)).toBe(memoryOf(plain));
    });

    test("is left to Claude Code when its own path isn't denied", () => {
        expect(claudeMemoryDirectory(managed, repo, true)).toBeUndefined();
        withAccount();
        expect(claudeMemoryDirectory(defaultHome, repo, true)).toBeUndefined();
        expect(claudeMemoryDirectory(undefined, repo, true)).toBeUndefined();
    });

    test("is left alone when the real one is denied too, or the user chose one", () => {
        const own = join(iso.home, "accounts", "claude-code", "own");
        mkdirSync(join(own, "projects"), { recursive: true });
        saveAgentConfig("claude-code", { accounts: [{ id: "own", name: "Own", folder: own, managed: true }] });
        expect(claudeMemoryDirectory(own, repo, true)).toBeUndefined();

        withAccount();
        const settings = join(managed, "settings.json");
        writeFileSync(settings, JSON.stringify({ autoMemoryDirectory: "~/notes" }));
        try {
            expect(claudeMemoryDirectory(managed, repo, true)).toBeUndefined();
        } finally {
            rmSync(settings);
        }
        const project = join(repo, ".claude");
        mkdirSync(project, { recursive: true });
        writeFileSync(join(project, "settings.local.json"), JSON.stringify({ autoMemoryDirectory: "~/notes" }));
        try {
            expect(claudeMemoryDirectory(managed, repo, true)).toBeUndefined();
            // An untrusted folder's settings are off (--setting-sources user): they don't count.
            expect(claudeMemoryDirectory(managed, repo, false)).toBe(memoryOf(repo));
        } finally {
            rmSync(project, { recursive: true });
        }
    });

    test("follows CLAUDE_CODE_PROJECT_DIR_NAME, and gives up on a layout it can't name", () => {
        withAccount();
        process.env.CLAUDE_CODE_PROJECT_DIR_NAME = "pinned";
        try {
            expect(claudeMemoryDirectory(managed, repo, true)).toBe(join(realpathSync(history), "pinned", "memory"));
        } finally {
            delete process.env.CLAUDE_CODE_PROJECT_DIR_NAME;
        }
        // A submodule's .git names a folder with no commondir.
        const sub = join(repo, "sub");
        mkdirSync(join(repo, ".git", "modules", "sub"), { recursive: true });
        mkdirSync(sub);
        writeFileSync(join(sub, ".git"), "gitdir: ../.git/modules/sub\n");
        expect(claudeMemoryRoot(sub)).toBeUndefined();
        expect(claudeMemoryDirectory(managed, sub, true)).toBeUndefined();
    });

    test("reaches Claude Code in its --settings, read-only sub-agents too", () => {
        for (const readOnly of [false, true]) {
            const t = { mode: "auto", model: { provider: "claude-code", id: "default" }, additionalDirectories: [], readOnly, trusted: true, cwd: repo, rules: { deny: [], ask: [], root: repo } } as unknown as Parameters<typeof claudeArgs>[1];
            const settingsOf = (memoryDir?: string) => {
                const { args } = claudeArgs("claude-code", t, { append: [], memoryDir });
                return JSON.parse(args[args.indexOf("--settings") + 1]!);
            };
            expect(settingsOf("/x/memory").autoMemoryDirectory).toBe("/x/memory");
            expect(settingsOf()).not.toHaveProperty("autoMemoryDirectory");
        }
    });
});
