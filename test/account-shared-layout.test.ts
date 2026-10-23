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
    for (const f of ["CLAUDE.md", "keybindings.json", "history.jsonl", ".claude.json", ".credentials.json", "stats-cache.json", "remote-settings.json", "policy-limits.json"]) write(join(claudeDefault, f), `default ${f}`);
    write(join(claudeDefault, "settings.json"), JSON.stringify({ model: "default settings.json", env: { ANTHROPIC_BASE_URL: "https://proxy.example" } }));
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
    expect(readFileSync(join(claudeDefault, "settings.json"), "utf8")).toContain("default settings.json");
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

test("Default's settings.json isn't shared while it carries a sign-in, and its values are never reported", () => {
    seedClaude();
    const settings = join(claudeDefault, "settings.json");
    const a = addAccount("claude-code", { id: "signin", name: "Sign-in" });
    expect(isLink(join(a.folder, "settings.json"))).toBe(true);
    const cases: [Record<string, unknown>, string][] = [
        [{ apiKeyHelper: "/bin/echo helper-value-1" }, "apiKeyHelper"],
        [{ env: { ANTHROPIC_API_KEY: "sk-ant-value-2" } }, "env.ANTHROPIC_API_KEY"],
        [{ env: { ANTHROPIC_AUTH_TOKEN: "token-value-3" } }, "env.ANTHROPIC_AUTH_TOKEN"],
        [{ env: { CLAUDE_CODE_OAUTH_TOKEN: "token-value-4" } }, "env.CLAUDE_CODE_OAUTH_TOKEN"],
        [{ env: { CLAUDE_CODE_USE_BEDROCK: "1", AWS_PROFILE: "value-5" } }, "env.CLAUDE_CODE_USE_BEDROCK"],
        [{ env: { ANTHROPIC_PROFILE: "value-6" } }, "env.ANTHROPIC_PROFILE"],
        [{ awsCredentialExport: "value-7" }, "awsCredentialExport"],
    ];
    for (const [value, key] of cases) {
        writeFileSync(settings, JSON.stringify(value));
        accountEnv("claude-code", a.id);
        expect({ key, linked: existsSync(join(a.folder, "settings.json")) || isLink(join(a.folder, "settings.json")) }).toEqual({ key, linked: false });
        const warning = accountSharingWarning("claude-code", a.id)!;
        expect(warning).toContain(key);
        expect(warning).not.toMatch(/value-\d|helper-value/);
        // Default's own file is untouched.
        expect(JSON.parse(readFileSync(settings, "utf8"))).toEqual(value);
    }
    // Unreadable as settings: not shared either.
    writeFileSync(settings, "{ not json");
    accountEnv("claude-code", a.id);
    expect(isLink(join(a.folder, "settings.json"))).toBe(false);
    expect(accountSharingWarning("claude-code", a.id)).toContain("couldn't be read");
    // Without a sign-in it is shared again.
    writeFileSync(settings, JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://proxy.example" }, model: "opus" }));
    accountEnv("claude-code", a.id);
    expect(readlinkSync(join(a.folder, "settings.json"))).toBe(settings);
    expect(accountSharingWarning("claude-code", a.id)).toBeUndefined();
    // The account's own settings.json is never touched, sign-in or not.
    rmSync(join(a.folder, "settings.json"));
    writeFileSync(join(a.folder, "settings.json"), "account's own");
    writeFileSync(settings, JSON.stringify({ apiKeyHelper: "x" }));
    accountEnv("claude-code", a.id);
    expect(readFileSync(join(a.folder, "settings.json"), "utf8")).toBe("account's own");
    removeAccount("claude-code", a.id, a.folder);
});

test("Codex secrets stay the account's: Harness's old link is removed, nothing else is", () => {
    seedCodex();
    write(join(codexDefault, "secrets", "local.age"), "default secrets");
    const a = addAccount("codex", { id: "secrets", name: "Secrets" });
    expect(existsSync(join(a.folder, "secrets")) || isLink(join(a.folder, "secrets"))).toBe(false);
    // An account laid out when secrets/ was still shared.
    symlinkSync(join(codexDefault, "secrets"), join(a.folder, "secrets"));
    accountEnv("codex", a.id);
    expect(isLink(join(a.folder, "secrets"))).toBe(false);
    expect(readFileSync(join(codexDefault, "secrets", "local.age"), "utf8")).toBe("default secrets");
    // A link the user made elsewhere, and the account's own folder, stay.
    const elsewhere = join(outside, "my-secrets");
    mkdirSync(elsewhere, { recursive: true });
    symlinkSync(elsewhere, join(a.folder, "secrets"));
    accountEnv("codex", a.id);
    expect(readlinkSync(join(a.folder, "secrets"))).toBe(elsewhere);
    rmSync(join(a.folder, "secrets"));
    write(join(a.folder, "secrets", "local.age"), "account secrets");
    accountEnv("codex", a.id);
    expect(readFileSync(join(a.folder, "secrets", "local.age"), "utf8")).toBe("account secrets");
    removeAccount("codex", a.id, a.folder);
    expect(readFileSync(join(codexDefault, "secrets", "local.age"), "utf8")).toBe("default secrets");
});

test("Codex rollout writer locks are always shared, and the account's own are replaced only while none is held", () => {
    seedCodex();
    rmSync(join(codexDefault, "thread-writer-locks"), { recursive: true });
    const a = addAccount("codex", { id: "locks", name: "Locks" });
    // Made in Default when missing, so both homes lock the same rollouts.
    expect(lstatSync(join(codexDefault, "thread-writer-locks")).isDirectory()).toBe(true);
    expect(readlinkSync(join(a.folder, "thread-writer-locks"))).toBe(join(codexDefault, "thread-writer-locks"));
    // An account whose Codex made its own: replaced when no lock is held...
    rmSync(join(a.folder, "thread-writer-locks"));
    write(join(a.folder, "thread-writer-locks", "thread.lock"), "");
    accountEnv("codex", a.id);
    expect(readlinkSync(join(a.folder, "thread-writer-locks"))).toBe(join(codexDefault, "thread-writer-locks"));
    // ...and kept and reported while a writer holds one.
    rmSync(join(a.folder, "thread-writer-locks"));
    write(join(a.folder, "thread-writer-locks", "thread.lock"), "");
    const { openSync, closeSync } = require("fs") as typeof import("fs");
    const held = openSync(join(a.folder, "thread-writer-locks", "thread.lock"), "r+");
    try {
        accountEnv("codex", a.id);
        expect(lstatSync(join(a.folder, "thread-writer-locks")).isDirectory()).toBe(true);
        expect(existsSync(join(a.folder, "thread-writer-locks", "thread.lock"))).toBe(true);
        expect(accountSharingWarning("codex", a.id)).toContain("thread-writer-locks");
    } finally { closeSync(held); }
    accountEnv("codex", a.id);
    expect(isLink(join(a.folder, "thread-writer-locks"))).toBe(true);
    removeAccount("codex", a.id, a.folder);
});

test("when Default moves, Harness's links follow it and foreign links are still refused", () => {
    seedClaude();
    seedCodex();
    const a = addAccount("codex", { id: "moved", name: "Moved" });
    const c = addAccount("claude-code", { id: "moved", name: "Moved" });
    expect(readlinkSync(join(a.folder, "config.toml"))).toBe(join(codexDefault, "config.toml"));
    const previous = { codex: process.env.CODEX_HOME, claude: process.env.CLAUDE_CONFIG_DIR };
    const codexNew = join(outside, "codex-new");
    const claudeNew = join(outside, "claude-new");
    write(join(codexNew, "config.toml"), "new config");
    write(join(claudeNew, "CLAUDE.md"), "new memory");
    write(join(claudeNew, "skills", "fresh", "SKILL.md"), "fresh");
    process.env.CODEX_HOME = codexNew;
    process.env.CLAUDE_CONFIG_DIR = claudeNew;
    try {
        expect(accountEnv("codex", a.id).CODEX_HOME).toBe(a.folder);
        expect(readlinkSync(join(a.folder, "config.toml"))).toBe(join(codexNew, "config.toml"));
        // What only the old Default had is no longer linked.
        expect(isLink(join(a.folder, "AGENTS.md"))).toBe(false);
        expect(readFileSync(join(codexDefault, "AGENTS.md"), "utf8")).toBe("default AGENTS.md");
        accountEnv("claude-code", c.id);
        expect(readlinkSync(join(c.folder, "CLAUDE.md"))).toBe(join(claudeNew, "CLAUDE.md"));
        expect(isLink(join(c.folder, "rules"))).toBe(false);
        expect(readlinkSync(join(c.folder, "skills", "fresh"))).toBe(join(claudeNew, "skills", "fresh"));
        expect(isLink(join(c.folder, "skills", "mine"))).toBe(false);
        // A config.toml link that isn't Harness's is refused, whichever Default it names.
        rmSync(join(a.folder, "config.toml"));
        symlinkSync(join(outside, "elsewhere.toml"), join(a.folder, "config.toml"));
        writeFileSync(join(outside, "elsewhere.toml"), "");
        expect(() => accountEnv("codex", a.id)).toThrow(/config.toml links outside/);
        rmSync(join(a.folder, "config.toml"));
    } finally {
        process.env.CODEX_HOME = previous.codex;
        process.env.CLAUDE_CONFIG_DIR = previous.claude;
    }
    // And back again.
    accountEnv("codex", a.id);
    expect(readlinkSync(join(a.folder, "config.toml"))).toBe(join(codexDefault, "config.toml"));
    removeAccount("codex", a.id, a.folder);
    removeAccount("claude-code", c.id, c.folder);
    expect(readFileSync(join(codexNew, "config.toml"), "utf8")).toBe("new config");
});
