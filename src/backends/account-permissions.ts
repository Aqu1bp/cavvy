// CLI-native tool sandboxes need the same account boundaries as Harness tools.
import { accountFolders, accountRealPath } from "../providers/accounts";
import { readAgentConfig } from "../providers/registry";
import type { PermissionMode } from "../permissions/modes";

const PREFIX = "harness_accounts_";
const configuredAccounts = () => ["claude-code", "codex"].some((provider) => readAgentConfig(provider)?.accounts?.length);

/** Both spellings matter on systems where /tmp or the user's home is a symlink. */
export function accountProtectionFolders(): string[] {
    return [...new Set(accountFolders().flatMap((folder) => [folder, accountRealPath(folder)]))];
}

export function claudeAccountSandbox() {
    if (!configuredAccounts()) return undefined;
    const folders = accountProtectionFolders();
    return {
        enabled: true,
        failIfUnavailable: true,
        allowUnsandboxedCommands: false,
        autoAllowBashIfSandboxed: false,
        filesystem: { disabled: false, denyRead: folders, denyWrite: folders },
    };
}

export function accountPermissionProfile(mode: PermissionMode, readOnly = false): string {
    return PREFIX + (readOnly || mode === "default" || mode === "plan" ? "read" : mode === "bypassPermissions" ? "full" : "write");
}

/** No profiles for existing users without accounts. Never fall back by dropping these denies. */
export function accountPermissionConfig(additionalDirectories: string[]): Record<string, unknown> | undefined {
    if (!configuredAccounts()) return undefined;
    const filesystem = Object.fromEntries(accountProtectionFolders().map((folder) => [folder, "deny"]));
    const workspace_roots = Object.fromEntries(additionalDirectories.map((folder) => [folder, true]));
    return {
        [`permissions.${PREFIX}read`]: { extends: ":read-only", filesystem, network: { enabled: false } },
        [`permissions.${PREFIX}write`]: { extends: ":workspace", filesystem, workspace_roots, network: { enabled: false } },
        [`permissions.${PREFIX}full`]: { filesystem: { ":root": "write", ...filesystem }, network: { enabled: true } },
    };
}

/** CLI-native auto-approved tools keep a policy snapshot; stop if an external edit invalidates it. */
export function watchAccountFolders(stop: () => void): () => void {
    const snapshot = () => {
        try { return JSON.stringify(accountProtectionFolders().sort()); }
        catch { return undefined; }
    };
    const initial = snapshot();
    if (initial === undefined) {
        stop();
        return () => {};
    }
    const timer = setInterval(() => {
        if (snapshot() !== initial) {
            clearInterval(timer);
            stop();
        }
    }, 250);
    return () => clearInterval(timer);
}
