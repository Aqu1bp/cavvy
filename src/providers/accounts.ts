// Account metadata and folder ownership. Never open files inside a CLI home.
import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join, resolve, sep } from "path";
import { homedir } from "os";
import { createHash, randomUUID } from "crypto";
import { paths } from "../config/paths";
import { canonical } from "../util/files";
import { readAgentConfig, readProvidersFileForUpdate, writeProvidersFile, type CliAccount, validAccountFolder } from "./registry";
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
// Capture the launch cwd independently of child cwds: Default uses the directory
// as a CLI invoked from the shell that launched Harness.
const launchCwd = process.cwd();
function defaultFolder(provider: string): string { return resolve(launchCwd, process.env[selector(provider)] || normalFolder(provider)); }
export function listAccounts(provider: string): CliAccount[] {
    accountProvider(provider);
    return [{ id: "default", name: "Default", folder: defaultFolder(provider), managed: false }, ...(readAgentConfig(provider)?.accounts ?? [])];
}
function findAccount(provider: string, id: string): CliAccount {
    accountProvider(provider);
    if (!validAccountId(id)) throw new RpcError("Invalid account id", "invalid");
    const found = listAccounts(provider).find((a) => a.id === id);
    if (!found) throw new RpcError("Account no longer exists; choose another account", "not_found");
    return found;
}
export function account(provider: string, id = "default"): CliAccount {
    const found = findAccount(provider, id);
    if (found.invalid) throw new RpcError("Invalid account folder: use a non-empty absolute path with no '..'", "invalid");
    return found;
}
export function defaultAccount(provider: string): string {
    const id = readAgentConfig(provider)?.defaultAccount ?? "default";
    return listAccounts(provider).some((a) => a.id === id) ? id : "default";
}
/**
 * A CLI's model catalog (its models, and their effort and speed options) is listed
 * by its starting account only. Said when a session uses another, whose own may differ.
 */
export function catalogNote(provider: string, selected: CliAccount, cli: string): string | undefined {
    const from = defaultAccount(provider);
    if (from === selected.id) return undefined;
    const source = listAccounts(provider).find((a) => a.id === from)?.name ?? from;
    return `${cli}'s model list, with each model's effort and speed options, comes from its starting account (${source}); ${selected.name} may not offer all of them.`;
}
const SELECTORS = { "claude-code": ["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR"], codex: ["CODEX_HOME"] } as const;
/**
 * Default preserves the launching shell selectors exactly. A relative one of the
 * launched CLI is refused: each child resolves it against its own cwd, and Claude
 * hashes the raw text into its keychain entry, so rewriting it would change identity.
 * The other CLI's relative selector is left out rather than repointed by a child's cwd.
 */
export function accountEnv(provider: string, id = "default", cwd = homedir()): Record<string, string> {
    const a = account(provider, id);
    if (id === "default") {
        const own: readonly string[] = SELECTORS[provider as keyof typeof SELECTORS];
        const env: Record<string, string> = {};
        for (const key of Object.values(SELECTORS).flat()) {
            const value = process.env[key];
            if (value && !isAbsolute(value)) {
                if (own.includes(key)) throw new RpcError(`Default cannot use relative ${key}; set it to an absolute path`, "invalid");
                continue;
            }
            if (value !== undefined) env[key] = value;
        }
        return env;
    }
    // Recheck persisted accounts too: the user's default selectors (or symlinks)
    // may have changed since this account was added, and a folder replaced by a
    // link to another account's would silently sign in as that account.
    if (!validAccountFolder(a.folder)) throw new RpcError("Invalid account folder: use a non-empty absolute path with no '..'", "invalid");
    const folder = accountRealPath(resolve(a.folder));
    separateFromDefault(folder, [cwd]);
    separateFromAccounts(folder, { provider, id });
    validateIdentityFiles(provider, folder);
    if (provider === "claude-code") separateKeychain(folder, id);
    // Secure storage can independently override Claude's config directory, even
    // with an empty value (which selects the user's default keychain entry).
    return provider === "claude-code"
        ? { CLAUDE_CONFIG_DIR: folder, CLAUDE_SECURESTORAGE_CONFIG_DIR: folder }
        : { CODEX_HOME: folder };
}
export function hasNamedAccounts(): boolean {
    return ACCOUNT_PROVIDERS.some((p) => readAgentConfig(p)?.accounts?.length);
}
/** Read afresh: accounts added during a session must immediately be protected. */
export function accountFolders(): string[] {
    if (!hasNamedAccounts()) return [];
    return [...new Set([join(paths.home(), "accounts"), ...ACCOUNT_PROVIDERS.flatMap((p) => (readAgentConfig(p)?.accounts ?? []).filter((a) => !a.invalid).map((a) => a.folder))].flatMap((folder) => [folder, accountRealPath(resolve(folder))]))];
}
/**
 * Where Default Claude Code keeps a file sign-in: a defined secure-storage selector
 * wins over the config folder, and an empty one means ~/.claude.
 */
function claudeSecureStorage(): string {
    const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    return secure === undefined ? defaultFolder("claude-code") : resolve(launchCwd, secure || normalFolder("claude-code"));
}
/** Default homes stay usable; their sign-in files are protected only alongside named accounts. */
export function accountCredentialFiles(): string[] {
    if (!hasNamedAccounts()) return [];
    const credentials = [join(defaultFolder("codex"), "auth.json"), join(defaultFolder("claude-code"), ".credentials.json"), join(claudeSecureStorage(), ".credentials.json")];
    // Claude Code uses its selector in NFC, which is another file where names aren't normalized.
    return [...new Set(credentials.flatMap((file) => [file, file.normalize("NFC")]).flatMap((file) => [file, canonical(file)]))];
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
// Engines can open more workspaces/terminals after an account was persisted.
// Keep these live so pre-spawn checks reserve the same roots as add/removal.
const rootSources = new Set<() => string[]>();
export function registerAccountRoots(source: () => string[]): () => void {
    rootSources.add(source);
    return () => { rootSources.delete(source); };
}
function separateFromDefault(folder: string, roots: string[] = []): void {
    roots = [...roots, ...[...rootSources].flatMap((source) => source())];
    for (const p of ACCOUNT_PROVIDERS) {
        // Claude can keep its default keychain identity under a separate selector.
        // Reusing that directory would make a named account share the user's login.
        const secureStorage = p === "claude-code" ? process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR : undefined;
        for (const base of [normalFolder(p), process.env[selector(p)] || normalFolder(p), ...(secureStorage ? [secureStorage] : [])]) {
            // Ordinary user terminals retain raw selectors. Also reserve legacy
            // status/session resolutions when adding or deleting account folders.
            const candidates = isAbsolute(base) ? [base] : [launchCwd, process.cwd(), homedir(), ...roots].map((cwd) => resolve(cwd, base));
            for (const candidate of candidates) {
                const reserved = accountRealPath(candidate);
                if (inside(folder, reserved) || inside(reserved, folder)) throw new RpcError("The default CLI folder cannot be an account folder", "invalid");
            }
        }
    }
}
/** Named accounts of either CLI, by where their folders actually are. */
function separateFromAccounts(real: string, exclude?: { provider: string; id: string }): void {
    for (const p of ACCOUNT_PROVIDERS) {
        for (const a of readAgentConfig(p)?.accounts ?? []) {
            if (a.invalid || (p === exclude?.provider && a.id === exclude.id)) continue;
            const other = accountRealPath(a.folder);
            if (inside(real, other) || inside(other, real)) throw new RpcError("Accounts must have separate, non-overlapping folders", "invalid");
        }
    }
}
function validateFolder(folder: unknown, roots: string[], exclude?: { provider: string; id: string }, managed = false): string {
    if (typeof folder !== "string" || folder.length > 1024 || !isAbsolute(folder) || !/^[a-zA-Z0-9 /_.-]+$/.test(folder) || folder.split(/[\\/]/).includes("..")) throw new RpcError("Use an absolute account folder with plain characters and no '..'", "invalid");
    const real = accountRealPath(resolve(folder));
    if (real === sep || real === accountRealPath(homedir())) throw new RpcError("Choose a dedicated account folder", "invalid");
    separateFromDefault(real, roots);
    separateFromAccounts(real, exclude);
    if (projectFolder(real, roots, managed)) throw new RpcError("Account folders must be outside projects", "invalid");
    if (existsSync(real) && !statSync(real).isDirectory()) throw new RpcError("Account folder is not a directory", "invalid");
    return real;
}
/** Only metadata is inspected; credential and configuration contents belong to the CLI. */
function validateIdentityFiles(provider: string, folder: string): void {
    const names = provider === "claude-code" ? [".claude.json", ".credentials.json"] : ["auth.json", "config.toml"];
    for (const name of names) {
        const file = join(folder, name);
        try {
            let stat = lstatSync(file);
            if (stat.isSymbolicLink()) {
                let target: string;
                try { target = realpathSync(file); }
                catch { throw new RpcError(`Cannot resolve account ${name} symlink; use a private file inside the account folder`, "invalid"); }
                if (!inside(target, folder)) throw new RpcError(`Account ${name} links outside its folder`, "invalid");
                // The CLI opens the target, so its link count is the one that matters.
                stat = statSync(target);
            }
            // A hard link has no target path. Its other names cannot be proven
            // private from lstat, so shared identity files must be copied first.
            if (stat.nlink > 1 && !stat.isDirectory()) throw new RpcError(`Account ${name} has hard links; use a private copy inside the account folder`, "invalid");
        } catch (e: any) {
            if (e.code === "ENOENT") continue;
            if (e instanceof RpcError) throw e;
            throw new RpcError(`Cannot check account ${name}`, "invalid");
        }
    }
}
function keychainService(raw: string): string {
    return "Claude Code-credentials" + (raw ? "-" + createHash("sha256").update(raw.normalize("NFC")).digest("hex").slice(0, 8) : "");
}
function separateKeychain(folder: string, excludeId?: string): void {
    const secure = process.env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
    const config = process.env.CLAUDE_CONFIG_DIR;
    // The config-only helper is unverified: reserve both raw and absolute hashes.
    const defaults = secure !== undefined ? [secure] : config ? [config, resolve(launchCwd, config)] : [""];
    const service = keychainService(folder);
    if (defaults.some((raw) => keychainService(raw) === service)) throw new RpcError("Account keychain service collides with Default", "invalid");
    for (const a of readAgentConfig("claude-code")?.accounts ?? []) {
        if (a.invalid || a.id === excludeId) continue;
        if (keychainService(accountRealPath(resolve(a.folder))) === service) throw new RpcError("Accounts must have separate keychain services", "invalid");
    }
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
    validateIdentityFiles(provider, folder);
    if (provider === "claude-code") separateKeychain(folder);
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
/**
 * Sign-ins and removals of accounts, in any Harness process on this home (the terminal app, a desktop server). Each
 * leaves a file of its own in the accounts folder (which tools can't touch), named for its process and a nonce, before
 * it looks for the other kind: of a login and a removal of one account that overlap, the later to write sees the
 * earlier's file and refuses. A removal's file stays until its change is saved, so a login that no longer sees it finds
 * the account gone. A file whose process is gone doesn't count; what can't be read refuses.
 */
function leasesFolder(): string { return join(paths.home(), "accounts", ".leases"); }
type LeaseKind = "login" | "remove";
const processRuns = (pid: number) => {
    try { process.kill(pid, 0); return true; } catch (e: any) { return e.code !== "ESRCH"; }
};
function lease(kind: LeaseKind, provider: string, id: string): () => void {
    accountProvider(provider);
    if (!validAccountId(id)) throw new RpcError("Invalid account id", "invalid");
    const file = join(leasesFolder(), `${kind}.${provider}.${id}.${process.pid}.${randomUUID()}`);
    try {
        mkdirSync(leasesFolder(), { recursive: true, mode: 0o700 });
        writeFileSync(file, "", { flag: "wx", mode: 0o600 });
    } catch {
        throw new RpcError("Cannot record this account's sign-in or removal in Harness's accounts folder", "invalid");
    }
    return () => rmSync(file, { force: true });
}
function leased(kind: LeaseKind, provider: string, id: string): boolean {
    let names: string[];
    try { names = readdirSync(leasesFolder()); } catch (e: any) {
        if (e.code === "ENOENT") return false;
        throw new RpcError("Cannot check this account's sign-ins and removals in Harness's accounts folder", "busy");
    }
    const prefix = `${kind}.${provider}.${id}.`;
    return names.some((name) => {
        if (!name.startsWith(prefix)) return false;
        const pid = Number(name.slice(prefix.length).split(".")[0]);
        if (!Number.isSafeInteger(pid) || pid <= 0 || processRuns(pid)) return true;
        // Only this file: its name is its holder's alone.
        try { rmSync(join(leasesFolder(), name), { force: true }); } catch {}
        return false;
    });
}
/** A login's, from before its account is looked up until its process has exited. Refused while the account is being removed. */
export function holdLogin(provider: string, id: string): () => void {
    const release = lease("login", provider, id);
    try {
        if (leased("remove", provider, id)) throw new RpcError("This account is being removed", "busy");
    } catch (e) {
        release();
        throw e;
    }
    return release;
}
/** A removal's, until its change is saved. Refused while a sign-in for the account runs. */
export function holdRemoval(provider: string, id: string): () => void {
    const release = lease("remove", provider, id);
    try {
        if (leased("login", provider, id)) throw new RpcError("A sign-in for this account is still running in Harness; finish or close it before removing the account", "busy");
    } catch (e) {
        release();
        throw e;
    }
    return release;
}
export function removeAccount(provider: string, id: string, confirmedFolder: string, projectRoots: string[] = []): void {
    const a = findAccount(provider, id);
    if (id === "default") throw new RpcError("The Default account cannot be removed", "invalid");
    if (confirmedFolder !== a.folder) throw new RpcError("Confirm the exact account folder before removing it", "invalid");
    // A login in any Harness process would sign in to a folder no longer registered.
    const release = holdRemoval(provider, id);
    try {
        forgetAccount(provider, id, a, projectRoots);
    } finally {
        release();
    }
}
function forgetAccount(provider: string, id: string, a: CliAccount, projectRoots: string[]): void {
    const pf = readProvidersFileForUpdate();
    if (a.managed && !a.invalid) {
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
