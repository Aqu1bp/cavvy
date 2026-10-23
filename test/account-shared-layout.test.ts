// Managed named accounts share Default's CLI configuration and history through links (#376).
import { afterAll, beforeEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const outside = tempDir("harness-shared-layout-");
const claudeDefault = process.env.CLAUDE_CONFIG_DIR!;
const codexDefault = process.env.CODEX_HOME!;
const { addAccount, accountEnv, accountSharingWarning, removeAccount } = await import("../src/providers/accounts");
const { saveAgentConfig } = await import("../src/providers/registry");
const { CLAUDE_SHARED, CLAUDE_PER_ENTRY, CODEX_PRIVATE } = await import("../src/providers/account-layout");
afterAll(() => { iso.cleanup(); rmSync(outside, { recursive: true, force: true }); });

const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const write = (p: string, text = "x") => { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, text); };

function seedClaude() {
    rmSync(claudeDefault, { recursive: true, force: true });
    mkdirSync(claudeDefault);
    for (const f of ["settings.json", "CLAUDE.md", "keybindings.json", "history.jsonl", ".claude.json", ".credentials.json", "stats-cache.json", "remote-settings.json", "policy-limits.json"]) write(join(claudeDefault, f), `default ${f}`);
    for (const d of ["rules", "agents", "commands", "output-styles", "workflows", "agent-memory", "themes", "backups", "statsig", "cache", "session-env", "shell-snapshots", "ide", "debug", "sessions", "jobs", "daemon", "uploads", "telemetry", "todos"]) write(join(claudeDefault, d, "entry"), `default ${d}`);
    write(join(claudeDefault, "projects", "-p", "s.jsonl"), "transcript");
    write(join(claudeDefault, "skills", "mine", "SKILL.md"), "my skill");
    write(join(claudeDefault, "skills", "synced", "bucket", "theirs", "SKILL.md"), "synced skill");
    write(join(claudeDefault, "skills", ".trash", "old", "SKILL.md"), "trashed");
    write(join(claudeDefault, "plugins", "installed_plugins.json"), "{}");
    write(join(claudeDefault, "plugins", "known_marketplaces.json"), "{}");
    write(join(claudeDefault, "plugins", "known_marketplaces_claudeai.json"), "{}");
    write(join(claudeDefault, "plugins", "cache", "m", "p", "1", "plugin.json"), "{}");
    write(join(claudeDefault, "plugins", "synced", "bucket", "x"), "synced plugin");
}

function seedCodex() {
    rmSync(codexDefault, { recursive: true, force: true });
    mkdirSync(codexDefault);
    for (const f of ["config.toml", "AGENTS.md", "auth.json", "models_cache.json", ".env", ".DS_Store", "state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm", "logs_2.sqlite", "logs_2.sqlite-wal", "session_index.jsonl", "installation_id", ".sqlite-maintenance.lock"]) write(join(codexDefault, f), `default ${f}`);
    for (const d of ["skills", "plugins", "rules", "sessions", "sqlite", "log", "memories", "tmp", "app-server-control", "app-server-daemon", "ipc", "mcp-oauth-locks", "thread-writer-locks", ".git"]) write(join(codexDefault, d, "entry"), `default ${d}`);
}

beforeEach(() => { saveAgentConfig("claude-code", { accounts: [] }); saveAgentConfig("codex", { accounts: [] }); });

test("a new managed Claude Code account links Default's configuration and history, and nothing private", () => {
    seedClaude();
    const a = addAccount("claude-code", { id: "work", name: "Work" });
    for (const name of CLAUDE_SHARED.filter((n) => existsSync(join(claudeDefault, n)))) {
        expect({ name, link: isLink(join(a.folder, name)) }).toEqual({ name, link: true });
        expect(readlinkSync(join(a.folder, name))).toBe(join(claudeDefault, name));
    }
    expect(readFileSync(join(a.folder, "CLAUDE.md"), "utf8")).toBe("default CLAUDE.md");
    expect(readFileSync(join(a.folder, "projects", "-p", "s.jsonl"), "utf8")).toBe("transcript");
    // Identity, account and per-process state stay the account's own.
    for (const name of [".claude.json", ".credentials.json", "stats-cache.json", "remote-settings.json", "policy-limits.json", "backups", "statsig", "cache", "session-env", "shell-snapshots", "ide", "debug", "sessions", "jobs", "daemon", "uploads", "telemetry", "todos"]) {
        expect({ name, exists: existsSync(join(a.folder, name)) || isLink(join(a.folder, name)) }).toEqual({ name, exists: false });
    }
    // skills/ and plugins/ are the account's own folders, with Default's entries linked one by one,
    // except what the claude.ai sync keeps for the signed-in account.
    for (const [dir, privates] of Object.entries(CLAUDE_PER_ENTRY)) {
        const local = join(a.folder, dir);
        expect(lstatSync(local).isDirectory()).toBe(true);
        for (const name of privates) expect(existsSync(join(local, name)) || isLink(join(local, name))).toBe(false);
    }
    expect(readlinkSync(join(a.folder, "skills", "mine"))).toBe(join(claudeDefault, "skills", "mine"));
    expect(readlinkSync(join(a.folder, "plugins", "cache"))).toBe(join(claudeDefault, "plugins", "cache"));
    expect(isLink(join(a.folder, "plugins", "installed_plugins.json"))).toBe(true);
    const env = accountEnv("claude-code", a.id);
    expect(env.CLAUDE_CONFIG_DIR).toBe(a.folder);
    expect(env.CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(a.folder);
    expect(accountSharingWarning("claude-code", a.id)).toBeUndefined();
    removeAccount("claude-code", a.id, a.folder);
});

test("history folders missing in Default are made there so they are shared from the first run", () => {
    rmSync(claudeDefault, { recursive: true, force: true });
    mkdirSync(claudeDefault);
    const a = addAccount("claude-code", { id: "fresh", name: "Fresh" });
    for (const d of ["projects", "file-history", "plans", "tasks", "paste-cache"]) {
        expect(lstatSync(join(claudeDefault, d)).isDirectory()).toBe(true);
        expect(readlinkSync(join(a.folder, d))).toBe(join(claudeDefault, d));
    }
    // Configuration Default doesn't have isn't linked or made.
    for (const f of ["settings.json", "CLAUDE.md", "skills", "plugins"]) {
        expect(existsSync(join(claudeDefault, f))).toBe(false);
        expect(existsSync(join(a.folder, f)) || isLink(join(a.folder, f))).toBe(false);
    }
    removeAccount("claude-code", a.id, a.folder);
});

test("a new managed Codex account links everything in Default's home except sign-in and local state", () => {
    seedCodex();
    const a = addAccount("codex", { id: "work", name: "Work" });
    for (const name of readdirSync(codexDefault)) {
        const linked = isLink(join(a.folder, name));
        expect({ name, linked }).toEqual({ name, linked: !CODEX_PRIVATE.has(name) });
    }
    for (const name of ["auth.json", "models_cache.json", ".env", "app-server-control", "app-server-daemon", "ipc", "log", "memories", "tmp", ".git"]) expect(CODEX_PRIVATE.has(name)).toBe(true);
    expect(readlinkSync(join(a.folder, "state_5.sqlite-wal"))).toBe(join(codexDefault, "state_5.sqlite-wal"));
    expect(readlinkSync(join(a.folder, "config.toml"))).toBe(join(codexDefault, "config.toml"));
    for (const d of ["sessions", "archived_sessions"]) expect(lstatSync(join(codexDefault, d)).isDirectory()).toBe(true);
    // The linked config.toml is Harness's own link to Default and is accepted.
    expect(accountEnv("codex", a.id).CODEX_HOME).toBe(a.folder);
    removeAccount("codex", a.id, a.folder);
});

test("existing managed accounts get the layout before login and launches, and pick up new Default entries", () => {
    seedClaude();
    seedCodex();
    const home = realpathSync(iso.home);
    for (const provider of ["claude-code", "codex"] as const) {
        const folder = join(home, "accounts", provider, "old");
        mkdirSync(folder, { recursive: true, mode: 0o700 });
        saveAgentConfig(provider, { accounts: [{ id: "old", name: "Old", folder, managed: true }] });
        const config = provider === "codex" ? "config.toml" : "settings.json";
        expect(existsSync(join(folder, config))).toBe(false);
        accountEnv(provider, "old");
        expect(readlinkSync(join(folder, config))).toBe(join(provider === "codex" ? codexDefault : claudeDefault, config));
        const later = provider === "codex" ? join(codexDefault, "later.md") : join(claudeDefault, "skills", "later");
        mkdirSync(later);
        accountEnv(provider, "old");
        expect(isLink(provider === "codex" ? join(folder, "later.md") : join(folder, "skills", "later"))).toBe(true);
        // A skill removed from Default drops its link in the account.
        if (provider === "claude-code") {
            rmSync(later, { recursive: true });
            accountEnv(provider, "old");
            expect(isLink(join(folder, "skills", "later"))).toBe(false);
        } else rmSync(later, { recursive: true });
        removeAccount(provider, "old", folder);
    }
});

test("an account's own files and foreign links are left alone and reported, never failing the launch", () => {
    seedClaude();
    seedCodex();
    const home = realpathSync(iso.home);
    const folder = join(home, "accounts", "claude-code", "own");
    write(join(folder, "settings.json"), "account settings");
    write(join(folder, "projects", "mine.jsonl"), "account transcript");
    symlinkSync(join(outside), join(folder, "CLAUDE.md"));
    write(join(folder, "skills", "mine", "SKILL.md"), "account skill");
    saveAgentConfig("claude-code", { accounts: [{ id: "own", name: "Own", folder, managed: true }] });
    expect(() => accountEnv("claude-code", "own")).not.toThrow();
    expect(readFileSync(join(folder, "settings.json"), "utf8")).toBe("account settings");
    expect(readFileSync(join(folder, "projects", "mine.jsonl"), "utf8")).toBe("account transcript");
    expect(readlinkSync(join(folder, "CLAUDE.md"))).toBe(outside);
    expect(readFileSync(join(folder, "skills", "mine", "SKILL.md"), "utf8")).toBe("account skill");
    expect(readFileSync(join(claudeDefault, "settings.json"), "utf8")).toBe("default settings.json");
    const warning = accountSharingWarning("claude-code", "own")!;
    for (const name of ["settings.json", "projects", "CLAUDE.md", "skills/mine"]) expect(warning).toContain(name);
    // Other entries are still linked.
    expect(isLink(join(folder, "rules"))).toBe(true);

    // Codex: a local runtime lock is replaced by the shared one; other real entries stay.
    const cfolder = join(home, "accounts", "codex", "own");
    write(join(cfolder, "sessions", "rollout.jsonl"), "account rollout");
    write(join(cfolder, "mcp-oauth-locks", "x.lock"), "");
    write(join(cfolder, ".sqlite-maintenance.lock"), "");
    write(join(cfolder, "state_5.sqlite"), "account database");
    saveAgentConfig("codex", { accounts: [{ id: "own", name: "Own", folder: cfolder, managed: true }] });
    accountEnv("codex", "own");
    // Default's write-ahead log and shared memory never sit beside the account's own database.
    for (const f of ["state_5.sqlite-wal", "state_5.sqlite-shm"]) expect(existsSync(join(cfolder, f)) || isLink(join(cfolder, f))).toBe(false);
    expect(readlinkSync(join(cfolder, "logs_2.sqlite-wal"))).toBe(join(codexDefault, "logs_2.sqlite-wal"));
    expect(readFileSync(join(cfolder, "state_5.sqlite"), "utf8")).toBe("account database");
    expect(readFileSync(join(cfolder, "sessions", "rollout.jsonl"), "utf8")).toBe("account rollout");
    expect(readlinkSync(join(cfolder, "mcp-oauth-locks"))).toBe(join(codexDefault, "mcp-oauth-locks"));
    expect(readlinkSync(join(cfolder, ".sqlite-maintenance.lock"))).toBe(join(codexDefault, ".sqlite-maintenance.lock"));
    expect(accountSharingWarning("codex", "own")).toContain("sessions");
    removeAccount("claude-code", "own", folder);
    removeAccount("codex", "own", cfolder);
    expect(existsSync(outside)).toBe(true);
});

test("a linked skills or plugins folder is never written through", () => {
    seedClaude();
    const home = realpathSync(iso.home);
    const folder = join(home, "accounts", "claude-code", "linked");
    mkdirSync(folder, { recursive: true });
    const elsewhere = join(outside, "other-skills");
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(folder, "skills"));
    symlinkSync(join(claudeDefault, "plugins"), join(folder, "plugins"));
    saveAgentConfig("claude-code", { accounts: [{ id: "linked", name: "Linked", folder, managed: true }] });
    accountEnv("claude-code", "linked");
    expect(readdirSync(elsewhere)).toEqual([]);
    expect(readdirSync(join(claudeDefault, "plugins")).filter((n) => isLink(join(claudeDefault, "plugins", n)))).toEqual([]);
    expect(accountSharingWarning("claude-code", "linked")).toContain("skills");
    removeAccount("claude-code", "linked", folder);
    expect(existsSync(join(claudeDefault, "plugins", "installed_plugins.json"))).toBe(true);
});

test("removal deletes the links, never what they point to in Default", () => {
    seedClaude();
    seedCodex();
    const before = (root: string) => readdirSync(root, { recursive: true }).map(String).sort();
    const claude = before(claudeDefault);
    const codex = before(codexDefault);
    const c = addAccount("claude-code", { id: "gone", name: "Gone" });
    const x = addAccount("codex", { id: "gone", name: "Gone" });
    // Default also got its history folders.
    const claudeAfterAdd = before(claudeDefault);
    const codexAfterAdd = before(codexDefault);
    expect(claudeAfterAdd).toEqual(expect.arrayContaining(claude));
    expect(codexAfterAdd).toEqual(expect.arrayContaining(codex));
    removeAccount("claude-code", c.id, c.folder);
    removeAccount("codex", x.id, x.folder);
    expect(existsSync(c.folder) || existsSync(x.folder)).toBe(false);
    expect(before(claudeDefault)).toEqual(claudeAfterAdd);
    expect(before(codexDefault)).toEqual(codexAfterAdd);
    expect(readFileSync(join(claudeDefault, "skills", "mine", "SKILL.md"), "utf8")).toBe("my skill");
    expect(readFileSync(join(claudeDefault, "projects", "-p", "s.jsonl"), "utf8")).toBe("transcript");
    expect(readFileSync(join(codexDefault, "config.toml"), "utf8")).toBe("default config.toml");
    expect(readFileSync(join(codexDefault, "sessions", "entry"), "utf8")).toBe("default sessions");
});

test("existing-folder accounts are used as they are", () => {
    seedClaude();
    seedCodex();
    for (const provider of ["claude-code", "codex"] as const) {
        const folder = join(outside, `custom-${provider}`);
        const a = addAccount(provider, { id: "custom", name: "Custom", folder });
        accountEnv(provider, a.id);
        expect(readdirSync(folder)).toEqual([]);
        // Nor does editing the saved metadata to claim it is Harness's make it so.
        saveAgentConfig(provider, { accounts: [{ ...a, managed: true }] });
        accountEnv(provider, a.id);
        expect(readdirSync(folder)).toEqual([]);
        saveAgentConfig(provider, { accounts: [] });
    }
});

test("identity files are never shared: foreign links to them are still refused", () => {
    seedCodex();
    seedClaude();
    const home = realpathSync(iso.home);
    const folder = join(home, "accounts", "codex", "foreign");
    mkdirSync(folder, { recursive: true });
    const other = join(outside, "config.toml");
    writeFileSync(other, "");
    symlinkSync(other, join(folder, "config.toml"));
    saveAgentConfig("codex", { accounts: [{ id: "foreign", name: "Foreign", folder, managed: true }] });
    expect(() => accountEnv("codex", "foreign")).toThrow(/config.toml links outside/);
    rmSync(join(folder, "config.toml"));
    symlinkSync(join(codexDefault, "auth.json"), join(folder, "auth.json"));
    expect(() => accountEnv("codex", "foreign")).toThrow(/auth.json links outside/);
    saveAgentConfig("codex", { accounts: [] });
    rmSync(folder, { recursive: true });
    for (const name of [".claude.json", ".credentials.json"]) expect(CLAUDE_SHARED).not.toContain(name);
    for (const name of ["auth.json"]) expect(CODEX_PRIVATE.has(name)).toBe(true);
});

test("Claude Code's skills linked from Default are its own, not plugged in again", async () => {
    seedClaude();
    const { forClaudeCode, claudeNames } = await import("../src/backends/native-skills");
    const a = addAccount("claude-code", { id: "skills", name: "Skills" });
    const skill = { name: "mine", dir: join(claudeDefault, "skills", "mine"), file: join(claudeDefault, "skills", "mine", "SKILL.md"), source: "user" } as any;
    expect(forClaudeCode([skill], outside, false, a.folder)).toEqual([]);
    expect(claudeNames([skill], [], outside, false, a.folder).get("mine")).toBe("mine");
    // An account without the link still gets it plugged in.
    rmSync(join(a.folder, "skills", "mine"));
    expect(forClaudeCode([skill], outside, false, a.folder)).toEqual([skill]);
    removeAccount("claude-code", a.id, a.folder);
});
