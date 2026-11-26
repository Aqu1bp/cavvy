// Environment variable names an agent CLI is started with (Settings → Providers, src/providers/agent-env.ts): which can
// be set, and which look like credentials. On its own, without Node's modules, so the GUI's editor says the same as
// the server as a name is typed.

/** An environment variable's name, as a shell writes one. */
export const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

/** Account folders are chosen with accounts; Cavvy's own markers are Cavvy's. */
const RESERVED = new Set(["CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME", "CAVVY"]);

/**
 * Why a name can't be set for a CLI, if it can't. Said under the name's own field in the GUI; `named`: said elsewhere
 * (the server's answer), so a bad name is quoted.
 */
export function envNameProblem(name: string, o?: { named?: boolean }): string | undefined {
    if (!ENV_NAME.test(name)) return `${o?.named ? `"${name}" isn't a variable name. ` : ""}Letters, digits and _ only, not starting with a digit.`;
    if (RESERVED.has(name) || name.startsWith("CAVVY_")) return name.startsWith("CAVVY") ? (o?.named ? `${name} is reserved by Cavvy.` : "Reserved by Cavvy.") : (o?.named ? `${name} is set by the account: add an account instead.` : "Set by the account: add an account instead.");
    return undefined;
}

/** A credential's name, as request_secret takes one (docs/secrets.md): it ends in TOKEN, KEY, SECRET, PASSWORD, …. */
export const CREDENTIAL_NAME = /_?(TOKEN|KEY|SECRET|PASSWORD|PASSWD|PASS|PWD|PAT|CREDENTIAL|CREDENTIALS|AUTH)$/;

/** A name that's most likely a credential's, whatever its case: its value starts hidden. */
export const looksSecret = (name: string): boolean => CREDENTIAL_NAME.test(name.trim().toUpperCase());
