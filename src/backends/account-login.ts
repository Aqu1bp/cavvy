// Only selectors cross the RPC boundary; the server chooses the executable and argv.
import { accountEnv, accountProvider, listAccounts } from "../providers/accounts";
import { childEnv } from "../util/env";
import { CLAUDE_CLI, CODEX_CLI, extraArgs, requireCli } from "./cli";

export function loginCommand(provider: string, id = "default"): { argv: string[]; env: Record<string, string> } {
    accountProvider(provider);
    const env = accountEnv(provider, id);
    const cli = provider === "codex" ? CODEX_CLI : CLAUDE_CLI;
    return {
        argv: [requireCli(provider, cli), ...extraArgs(provider), ...(provider === "codex" ? ["login"] : ["auth", "login"])],
        env: { ...childEnv(), ...env },
    };
}

/**
 * How to sign in again. The CLI's own command, run in an ordinary shell, signs in
 * Default's folder, so a named account is pointed to its own login instead.
 */
export function signInAdvice(provider: string, id = "default"): string {
    if (id === "default") return `In a terminal, run \`${(provider === "codex" ? CODEX_CLI : CLAUDE_CLI).signIn}\`, then try again.`;
    let name = id;
    try { name = listAccounts(provider).find((a) => a.id === id)?.name ?? id; } catch {}
    return `Sign in to the ${name} account with \`/login ${provider} ${id}\` in the terminal app, or its Sign in button under Settings → Providers, then try again.`;
}
