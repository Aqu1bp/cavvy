// CLI account folders in the wrapped CLIs' own rules. An account only selects a CLI's config folder (#375):
// nothing here may change how a CLI asks or sandboxes, only add static deny rules, which never prompt.
import { accountProtectedPaths, accountRealPath } from "../providers/accounts";

/** Both spellings matter on systems where /tmp or the user's home is a symlink. */
export function accountProtectionFolders(): string[] {
    return [...new Set(accountProtectedPaths().flatMap((folder) => [folder, accountRealPath(folder)]))];
}
