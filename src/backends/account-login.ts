// Only selectors cross the RPC boundary; the server chooses the executable and argv.
import { accountEnv, accountProvider, listAccounts } from "../providers/accounts";
import { childEnv } from "../util/env";
import { extraArgs, requireCli } from "./cli";
import { agentCli } from "./defs";

/** `away`: the person's browser is on another machine than this one (a server), so the CLI can't open it. */
export function loginCommand(provider: string, id = "default", o: { away?: boolean } = {}): { argv: string[]; env: Record<string, string> } {
    const def = agentCli(provider);
    // One without accounts (an ACP agent) signs in its default only.
    if (!def || def.account || id !== "default") accountProvider(provider);
    const env = def?.account ? accountEnv(provider, id) : {};
    const cli = def!.cli;
    return {
        // Its sign-in command's arguments ("claude auth login": auth login).
        argv: [requireCli(provider, cli), ...extraArgs(provider), ...((o.away && cli.signInAway) || cli.signIn).split(" ").slice(1)],
        env: { ...childEnv(), ...env },
    };
}

/** Advice given, by its text, and the sign-in it's for: where there's someone to ask, a card takes the advice's place. */
const advised = new Map<string, { target: string; account: string }>();

/** `advice` (a sentence on how to sign in, for a failure's message) noted as being for that sign-in. Returns it. */
export function adviseSignIn(target: string, account: string, advice: string): string {
    advised.set(advice, { target, account });
    return advice;
}

/** The sign-in a failure's message advises, with the advice itself, or undefined. */
export function signInAdvised(message: string): { target: string; account: string; advice: string } | undefined {
    for (const [advice, what] of advised) if (message.includes(advice)) return { ...what, advice };
    return undefined;
}

/** This Cavvy runs on a server (src/servers/host.ts): whoever reads its advice is at another machine. */
let onServer = false;
export function signInsOnServer(on = true): void {
    onServer = on;
}

/**
 * How to sign in again. The CLI's own command, run in an ordinary shell, signs in
 * Default's folder, so a named account is pointed to its own login instead. On a server it says where: "a
 * terminal" reads as one on the machine in front of the person, which signs nothing in there, and the command is
 * the one that works with their browser elsewhere.
 */
export function signInAdvice(provider: string, id = "default"): string {
    return adviseSignIn(provider, id, adviceText(provider, id));
}

function adviceText(provider: string, id: string): string {
    const cli = agentCli(provider)?.cli;
    if (id === "default" && onServer) return `On this server, run \`${cli?.signInAway ?? cli?.signIn ?? provider}\`, then try again.`;
    if (id === "default") return `In a terminal, run \`${cli?.signIn ?? provider}\`, then try again.`;
    let name = id;
    try { name = listAccounts(provider).find((a) => a.id === id)?.name ?? id; } catch {}
    return `Sign in to the ${name} account with \`/login ${provider} ${id}\` in the terminal app, or its Sign in button under Settings → Providers, then try again.`;
}
