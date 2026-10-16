import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, realpathSync, statSync, symlinkSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
const iso = isolate();
const outside = tempDir("harness-account-folders-");
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


test("managed removal refuses projects on either side of the account, including aliases", () => {
    const a = addAccount("codex", { id: "contains-project", name: "Contains project" });
    const project = join(a.folder, "project");
    mkdirSync(project);
    const sentinel = join(project, "source.ts");
    writeFileSync(sentinel, "keep");
    const alias = join(outside, "nested-project-link");
    symlinkSync(project, alias);
    for (const root of [project, alias, a.folder, iso.home]) {
        expect(() => removeAccount("codex", a.id, a.folder, [root])).toThrow(/projects/);
        expect(existsSync(sentinel)).toBe(true);
        expect(account("codex", a.id).folder).toBe(a.folder);
    }
    removeAccount("codex", a.id, a.folder);
});
