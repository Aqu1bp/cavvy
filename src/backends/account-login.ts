// Only selectors cross the RPC boundary; the server chooses the executable and argv.
import { accountEnv, accountProvider, listAccounts } from "../providers/accounts";
import { childEnv } from "../util/env";
import { extraArgs, requireCli } from "./cli";
import { agentCli } from "./defs";

export function loginCommand(provider: string, id = "default"): { argv: string[]; env: Record<string, string> } {
    const def = agentCli(provider);
    // One without accounts (an ACP agent) signs in its default only.
    if (!def || def.account || id !== "default") accountProvider(provider);
    const env = def?.account ? accountEnv(provider, id) : {};
    const cli = def!.cli;
    return {
        // Its sign-in command's arguments ("claude auth login": auth login).
        argv: [requireCli(provider, cli), ...extraArgs(provider), ...cli.signIn.split(" ").slice(1)],
        env: { ...childEnv(), ...env },
    };
}

/**
 * How to sign in again. The CLI's own command, run in an ordinary shell, signs in
 * Default's folder, so a named account is pointed to its own login instead.
 */
export function signInAdvice(provider: string, id = "default"): string {
    if (id === "default") return `In a terminal, run \`${agentCli(provider)?.cli.signIn ?? provider}\`, then try again.`;
    let name = id;
    try { name = listAccounts(provider).find((a) => a.id === id)?.name ?? id; } catch {}
    return `Sign in to the ${name} account with \`/login ${provider} ${id}\` in the terminal app, or its Sign in button under Settings → Providers, then try again.`;
}
