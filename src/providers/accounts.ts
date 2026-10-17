// Account metadata and folder ownership. Never open files inside a CLI home.
import { existsSync, lstatSync, mkdirSync, realpathSync, rmSync, statSync } from "fs";
import { dirname, isAbsolute, join, resolve, sep } from "path";
import { homedir } from "os";
import { paths } from "../config/paths";
import { canonical } from "../util/files";
import { readAgentConfig, readProvidersFileForUpdate, writeProvidersFile, type CliAccount } from "./registry";
import { RpcError } from "../server/rpc-error";

export const ACCOUNT_PROVIDERS = ["claude-code", "codex"] as const;
export function accountProvider(provider: string): asserts provider is typeof ACCOUNT_PROVIDERS[number] {
    if (!ACCOUNT_PROVIDERS.includes(provider as any)) throw new RpcError("Invalid account provider", "invalid");
}
export function validAccountId(id: unknown): id is string {
    return typeof id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(id);
}
export function validAccountName(name: unknown): name is string {
    return typeof name === "string" && /^[a-zA-Z0-9][a-zA-Z0-9 _.-]{0,63}$/.test(name) && name === name.trim() && !name.includes("..");
}
const inside = (path: string, root: string) => path === root || path.startsWith(root + sep);
/** Resolve existing ancestors too, so a not-yet-created path cannot hide behind a symlink. */
export function accountRealPath(path: string): string {
    try { return realpathSync(path); } catch (e: any) {
        if (e.code !== "ENOENT") throw new RpcError("Cannot resolve account folder", "invalid");
        const parent = dirname(path);
        if (parent === path) throw new RpcError("Cannot resolve account folder", "invalid");
        return join(accountRealPath(parent), path.slice(parent.length + (parent === sep ? 0 : 1)));
    }
}
function normalFolder(provider: string): string {
    return join(homedir(), provider === "codex" ? ".codex" : ".claude");
}
function selector(provider: string): string { return provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"; }
function defaultFolder(provider: string): string { return process.env[selector(provider)] || normalFolder(provider); }
export function listAccounts(provider: string): CliAccount[] {
    accountProvider(provider);
    return [{ id: "default", name: "Default", folder: defaultFolder(provider), managed: false }, ...(readAgentConfig(provider)?.accounts ?? [])];
}
export function account(provider: string, id = "default"): CliAccount {
    accountProvider(provider);
    if (!validAccountId(id)) throw new RpcError("Invalid account id", "invalid");
    const found = listAccounts(provider).find((a) => a.id === id);
    if (!found) throw new RpcError("Account no longer exists; choose another account", "not_found");
    return found;
}
export function defaultAccount(provider: string): string {
    const id = readAgentConfig(provider)?.defaultAccount ?? "default";
    return listAccounts(provider).some((a) => a.id === id) ? id : "default";
}
/** Fresh overrides for a CLI child; Default preserves the user's selectors verbatim. */
export function accountEnv(provider: string, id = "default"): Record<string, string> {
    const a = account(provider, id);
    if (id === "default") {
        const env: Record<string, string> = {};
        for (const key of ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME"]) {
            if (process.env[key] !== undefined) env[key] = process.env[key]!;
        }
        return env;
    }
    // Recheck persisted accounts too: the user's default selectors (or symlinks)
    // may have changed since this account was added.
    separateFromDefault(accountRealPath(resolve(a.folder)));
    // Secure storage can independently override Claude's config directory, even
    // with an empty value (which selects the user's default keychain entry).
    return provider === "claude-code"
        ? { CLAUDE_CONFIG_DIR: a.folder, CLAUDE_SECURESTORAGE_CONFIG_DIR: a.folder }
        : { CODEX_HOME: a.folder };
}
export function hasNamedAccounts(): boolean {
    return ACCOUNT_PROVIDERS.some((p) => readAgentConfig(p)?.accounts?.length);
}
/** Read afresh: accounts added during a session must immediately be protected. */
export function accountFolders(): string[] {
    if (!hasNamedAccounts()) return [];
    return [...new Set([join(paths.home(), "accounts"), ...ACCOUNT_PROVIDERS.flatMap((p) => (readAgentConfig(p)?.accounts ?? []).map((a) => a.folder))].flatMap((folder) => [folder, accountRealPath(resolve(folder))]))];
}
/** Default homes stay usable; their sign-in files are protected only alongside named accounts. */
export function accountCredentialFiles(): string[] {
    if (!hasNamedAccounts()) return [];
    const credentials = ACCOUNT_PROVIDERS.map((p) => join(resolve(defaultFolder(p)), p === "codex" ? "auth.json" : ".credentials.json"));
    return [...new Set(credentials.flatMap((file) => [file, canonical(file)]))];
}
export function accountProtectedPaths(): string[] {
    return [...new Set([...accountFolders(), ...accountCredentialFiles()])];
}
function projectFolder(folder: string, roots: string[], managed: boolean): boolean {
    const home = accountRealPath(homedir());
    const harness = accountRealPath(paths.home());
    if (roots.some((root) => {
        const real = accountRealPath(resolve(root));
        // Desktop starts in home, and sessions may also use a broad parent folder.
        if (real === home || (managed && inside(harness, real))) return false;
        // Harness owns this dedicated folder, even when its home is in a project.
        // Still protect projects opened at or below it before recursive removal.
        if (managed && real !== folder && inside(folder, real)) return false;
        return inside(folder, real) || inside(real, folder);
    })) return true;
    for (let d = folder; ; d = dirname(d)) {
        if (d === home) return false;
        if (existsSync(join(d, ".git"))) return true;
        if (managed || dirname(d) === d) return false;
    }
}
function separateFromDefault(folder: string): void {
    for (const p of ACCOUNT_PROVIDERS) {
        // Claude can keep its default keychain identity under a separate selector.
        // Reusing that directory would make a named account share the user's login.
        const secureStorage = p === "claude-code" ? process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR : undefined;
        for (const base of [normalFolder(p), defaultFolder(p), ...(secureStorage ? [secureStorage] : [])]) {
            const reserved = accountRealPath(resolve(base));
            if (inside(folder, reserved) || inside(reserved, folder)) throw new RpcError("The default CLI folder cannot be an account folder", "invalid");
        }
    }
}
function validateFolder(folder: unknown, roots: string[], exclude?: { provider: string; id: string }, managed = false): string {
    if (typeof folder !== "string" || folder.length > 1024 || !isAbsolute(folder) || !/^[a-zA-Z0-9 /_.-]+$/.test(folder) || folder.split(/[\\/]/).includes("..")) throw new RpcError("Use an absolute account folder with plain characters and no '..'", "invalid");
    const real = accountRealPath(resolve(folder));
    if (real === sep || real === accountRealPath(homedir())) throw new RpcError("Choose a dedicated account folder", "invalid");
    separateFromDefault(real);
    for (const p of ACCOUNT_PROVIDERS) {
        for (const a of readAgentConfig(p)?.accounts ?? []) {
            if (p === exclude?.provider && a.id === exclude.id) continue;
            const other = accountRealPath(a.folder);
            if (inside(real, other) || inside(other, real)) throw new RpcError("Accounts must have separate, non-overlapping folders", "invalid");
        }
    }
    if (projectFolder(real, roots, managed)) throw new RpcError("Account folders must be outside projects", "invalid");
    if (existsSync(real) && !statSync(real).isDirectory()) throw new RpcError("Account folder is not a directory", "invalid");
    return real;
}
export function addAccount(provider: string, input: { id: string; name: string; folder?: string }, projectRoots: string[] = []): CliAccount {
    accountProvider(provider);
    if (!input || !validAccountId(input.id) || input.id === "default") throw new RpcError("Invalid account id", "invalid");
    if (!validAccountName(input.name)) throw new RpcError("Use a name of 1–64 plain characters", "invalid");
    const pf = readProvidersFileForUpdate();
    const cfg = (pf.agents ??= {})[provider] ??= {};
    const all = cfg.accounts ??= [];
    if (all.length >= 20) throw new RpcError("At most 20 accounts per CLI", "limit");
    if (all.some((a) => a.id === input.id)) throw new RpcError("Account id already exists", "invalid");
    const managed = input.folder === undefined;
    const expected = join(accountRealPath(paths.home()), "accounts", provider, input.id);
    const requested = input.folder ?? expected;
    const folder = validateFolder(requested, projectRoots, undefined, managed);
    // Ownership is never adopted for a pre-existing directory, even at our expected path.
    if (managed && (existsSync(expected) || folder !== resolve(expected))) throw new RpcError("Managed account folder already exists or crosses a symlink", "invalid");
    try { mkdirSync(folder, { recursive: true, mode: 0o700 }); }
    catch { throw new RpcError("Cannot create account folder", "invalid"); }
    const a = { id: input.id, name: input.name, folder, managed };
    all.push(a);
    writeProvidersFile(pf);
    return a;
}
export function renameAccount(provider: string, id: string, name: string): void {
    account(provider, id);
    if (id === "default" || !validAccountName(name)) throw new RpcError("Invalid account name", "invalid");
    const pf = readProvidersFileForUpdate();
    pf.agents![provider]!.accounts!.find((a) => a.id === id)!.name = name;
    writeProvidersFile(pf);
}
export function setDefaultAccount(provider: string, id: string): void {
    account(provider, id);
    const pf = readProvidersFileForUpdate();
    ((pf.agents ??= {})[provider] ??= {}).defaultAccount = id;
    writeProvidersFile(pf);
}
export function removeAccount(provider: string, id: string, confirmedFolder: string, projectRoots: string[] = []): void {
    const a = account(provider, id);
    if (id === "default") throw new RpcError("The Default account cannot be removed", "invalid");
    if (confirmedFolder !== a.folder) throw new RpcError("Confirm the exact account folder before removing it", "invalid");
    const pf = readProvidersFileForUpdate();
    if (a.managed) {
        const expected = join(accountRealPath(paths.home()), "accounts", provider, id);
        // Every component below our home must remain in place; rm never follows child symlinks.
        const home = accountRealPath(paths.home());
        const canonicalExpected = join(home, "accounts", provider, id);
        if (a.folder !== expected || accountRealPath(expected) !== canonicalExpected) throw new RpcError("Account folder moved or is a symlink; refusing deletion", "invalid");
        for (const d of [join(paths.home(), "accounts"), dirname(expected), expected]) {
            if (existsSync(d) && lstatSync(d).isSymbolicLink()) throw new RpcError("Refusing to delete a symlinked account folder", "invalid");
        }
        validateFolder(expected, projectRoots, { provider, id }, true);
        rmSync(expected, { recursive: true, force: true });
    }
    const cfg = pf.agents![provider]!;
    cfg.accounts = cfg.accounts!.filter((v) => v.id !== id);
    if (cfg.defaultAccount === id) delete cfg.defaultAccount;
    writeProvidersFile(pf);
}
