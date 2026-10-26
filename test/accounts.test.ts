import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const outside = tempDir("cavvy-account-folders-");
const { addAccount, account, defaultAccount, listAccounts, removeAccount, renameAccount, setDefaultAccount } = await import("../src/providers/accounts");
const { readAgentConfig, saveAgentConfig, removeAgentConfig } = await import("../src/providers/registry");
afterAll(() => { iso.cleanup(); rmSync(outside, { recursive: true, force: true }); });

test("metadata remains compatible, private, and independent of CLI credentials", () => {
    saveAgentConfig("codex", { args: ["--example"] });
    expect(listAccounts("codex")).toHaveLength(1);
    const a = addAccount("codex", { id: "personal", name: "Personal" });
    expect(statSync(a.folder).mode & 0o777).toBe(0o700);
    expect(statSync(join(iso.home, "providers.json")).mode & 0o777).toBe(0o600);
    expect(readAgentConfig("codex")?.args).toEqual(["--example"]);
    expect(a.folder).toBe(join(realpathSync(iso.home), "accounts", "codex", "personal"));
    renameAccount("codex", a.id, "Work");
    expect(account("codex", a.id).name).toBe("Work");
    setDefaultAccount("codex", a.id);
    expect(defaultAccount("codex")).toBe(a.id);
    expect(() => removeAccount("codex", a.id, "wrong")).toThrow(/Confirm/);
    expect(existsSync(a.folder)).toBe(true);
    removeAccount("codex", a.id, a.folder);
    expect(existsSync(a.folder)).toBe(false);
    expect(defaultAccount("codex")).toBe("default");
});

test("pointed folders are forgotten only and may never overlap any account", () => {
    const folder = join(outside, "external");
    const a = addAccount("claude-code", { id: "work", name: "Work", folder });
    expect(a.managed).toBe(false);
    expect(() => removeAgentConfig("claude-code")).toThrow(/remain protected/);
    writeFileSync(join(folder, "sentinel"), "untouched");
    expect(() => addAccount("codex", { id: "duplicate", name: "Duplicate", folder })).toThrow(/separate/);
    expect(() => addAccount("codex", { id: "nested", name: "Nested", folder: join(folder, "nested") })).toThrow(/separate/);
    removeAccount("claude-code", a.id, a.folder);
    expect(existsSync(join(folder, "sentinel"))).toBe(true);
    expect(() => removeAccount("codex", "default", account("codex").folder)).toThrow(/Default/);
});

test("a separate default Claude secure-storage directory cannot become a named account", () => {
    const previous = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const secure = join(outside, "secure-storage");
    const alias = join(outside, "secure-alias");
    mkdirSync(secure); symlinkSync(secure, alias);
    process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure;
    try {
        for (const provider of ["claude-code", "codex"]) {
            for (const folder of [secure, alias, join(alias, "nested"), outside]) {
                expect(() => addAccount(provider, { id: "collision", name: "Collision", folder })).toThrow(/default CLI folder/);
            }
        }
    } finally {
        if (previous === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = previous;
    }
});

test("ids, names, paths, defaults, projects and aliases are validated", () => {
    for (const id of ["..", "a/b", "a;echo", "default", "x".repeat(49)]) expect(() => addAccount("codex", { id, name: "Name" })).toThrow();
    for (const name of ["", "A\nB", "A; echo", "x".repeat(65), "A..B"]) expect(() => addAccount("codex", { id: "badname", name })).toThrow();
    for (const folder of ["relative", join(outside, "a;echo")]) expect(() => addAccount("codex", { id: "badpath", name: "Name", folder })).toThrow();
    // join normalizes '..'; test the unnormalized client input as well.
    expect(() => addAccount("codex", { id: "dots", name: "Name", folder: outside + "/../escape" })).toThrow();
    expect(() => addAccount("codex", { id: "normal", name: "Name", folder: account("codex").folder })).toThrow(/default/);
    const project = join(outside, "project"); mkdirSync(project); mkdirSync(join(project, ".git"));
    expect(() => addAccount("codex", { id: "inproject", name: "Name", folder: join(project, "account") })).toThrow(/projects/);
    const alias = join(outside, "project-link"); symlinkSync(project, alias);
    expect(() => addAccount("codex", { id: "alias", name: "Name", folder: join(alias, "account") })).toThrow(/projects/);
    expect(() => setDefaultAccount("codex", "unknown")).toThrow();
});

test("deletion refuses replaced roots and never follows child symlinks", () => {
    const a = addAccount("codex", { id: "replaced", name: "Replaced" });
    rmSync(a.folder, { recursive: true });
    symlinkSync(outside, a.folder);
    expect(() => removeAccount("codex", a.id, a.folder)).toThrow(/symlink/);
    expect(existsSync(outside)).toBe(true);
    rmSync(a.folder); mkdirSync(a.folder);
    symlinkSync(outside, join(a.folder, "link-out"));
    removeAccount("codex", a.id, a.folder);
    expect(existsSync(outside)).toBe(true);
});


test("managed removal refuses projects at or below the account, including aliases", () => {
    const a = addAccount("codex", { id: "contains-project", name: "Contains project" });
    const project = join(a.folder, "project");
    mkdirSync(project);
    const sentinel = join(project, "source.ts");
    writeFileSync(sentinel, "keep");
    const alias = join(outside, "nested-project-link");
    symlinkSync(project, alias);
    for (const root of [project, alias, a.folder]) {
        expect(() => removeAccount("codex", a.id, a.folder, [root])).toThrow(/projects/);
        expect(existsSync(sentinel)).toBe(true);
        expect(account("codex", a.id).folder).toBe(a.folder);
    }
    mkdirSync(join(a.folder, ".git"));
    expect(() => removeAccount("codex", a.id, a.folder, [iso.home])).toThrow(/projects/);
    expect(existsSync(sentinel)).toBe(true);
    rmSync(join(a.folder, ".git"), { recursive: true });
    removeAccount("codex", a.id, a.folder);
});

test("invalid saved folders stay listed and preferred, fail selection, and remove metadata only", async () => {
    const { accountEnv, accountFolders } = await import("../src/providers/accounts");
    const { Engine } = await import("../src/server/engine");
    const { Session } = await import("../src/agent/session");
    const engine = new Engine({ startCwd: outside, listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} };
    const sentinel = join(outside, "metadata-only-sentinel");
    writeFileSync(sentinel, "keep");
    try {
        for (const provider of ["claude-code", "codex"]) {
            for (const folder of ["", "relative", `${outside}/../${outside.split("/").at(-1)}`, null, 42]) {
                saveAgentConfig(provider, { path: "/nonexistent-cavvy-test-cli", accounts: [{ id: "broken", name: "Broken", folder: folder as any, managed: true }], defaultAccount: "broken" });
                expect(readAgentConfig(provider)?.accounts).toMatchObject([{ id: "broken", invalid: true }]);
                expect(defaultAccount(provider)).toBe("broken");
                expect(() => account(provider, "broken")).toThrow(/Invalid account folder/);
                expect(() => setDefaultAccount(provider, "broken")).toThrow(/Invalid account folder/);
                expect(() => accountEnv(provider, "broken")).toThrow(/Invalid account folder/);
                expect(() => accountFolders()).not.toThrow();
                expect(await engine.handle(client, "providers.list", {})).toBeArray();
                const listed = await engine.handle(client, "accounts.list", { provider, refresh: true });
                expect(listed.find((a: any) => a.id === "broken")).toMatchObject({ invalid: true, description: expect.stringContaining("Invalid account folder") });
                const saved = Session.create(outside);
                expect(saved.accountId(provider)).toBe("broken");
                const confirmedFolder = listAccounts(provider).find((a) => a.id === "broken")!.folder;
                await engine.handle(client, "accounts.remove", { provider, id: "broken", confirmedFolder });
                expect(defaultAccount(provider)).toBe("default");
                expect(saved.accountId(provider)).toBe("broken");
                expect(() => account(provider, saved.accountId(provider))).toThrow(/no longer exists/);
                expect(existsSync(sentinel)).toBe(true);
            }
        }
    } finally { await engine.stop(); }
});

test("Claude keychain collisions are rejected at add and every launch", async () => {
    const { createHash } = await import("crypto");
    const { accountEnv } = await import("../src/providers/accounts");
    const one = "/private/tmp/cavvy-account-collision/26293";
    const two = "/private/tmp/cavvy-account-collision/88046";
    for (const raw of [one, two]) expect(createHash("sha256").update(raw).digest("hex").slice(0, 8)).toBe("b6f8ac42");
    const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const config = process.env.CLAUDE_CONFIG_DIR;
    const accounts = readAgentConfig("claude-code")?.accounts ?? [];
    const named = { id: "collision", name: "Collision", folder: two, managed: false };
    try {
        for (const source of ["secure", "config"]) {
            if (source === "secure") process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = one;
            else { delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = one; }
            saveAgentConfig("claude-code", { accounts: [] });
            expect(() => addAccount("claude-code", { id: named.id, name: named.name, folder: two })).toThrow(/keychain.*Default/);
            saveAgentConfig("claude-code", { accounts: [named] });
            expect(() => accountEnv("claude-code", named.id)).toThrow(/keychain.*Default/);
        }
        // A relative config-only selector also reserves its absolute hash.
        delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
        const { relative } = await import("path");
        process.env.CLAUDE_CONFIG_DIR = relative(process.cwd(), one);
        expect(() => accountEnv("claude-code", named.id)).toThrow(/keychain.*Default/);
        // Defined empty secure storage overrides config, reserving the unsuffixed service.
        process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = "";
        expect(accountEnv("claude-code", named.id).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(two);
        process.env.CLAUDE_CONFIG_DIR = config;
        // Raw secure selectors are not resolved before hashing (one/. has another hash).
        process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = one + "/.";
        expect(accountEnv("claude-code", named.id).CLAUDE_SECURESTORAGE_CONFIG_DIR).toBe(two);
        process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure;
        const other = { id: "other", name: "Other", folder: one, managed: false };
        saveAgentConfig("claude-code", { accounts: [other] });
        expect(() => addAccount("claude-code", { id: named.id, name: named.name, folder: two })).toThrow(/separate keychain/);
        saveAgentConfig("claude-code", { accounts: [other, named] });
        for (const id of [other.id, named.id]) expect(() => accountEnv("claude-code", id)).toThrow(/separate keychain/);
    } finally {
        if (secure === undefined) delete process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR; else process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR = secure;
        if (config === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = config;
        saveAgentConfig("claude-code", { accounts });
    }
});
