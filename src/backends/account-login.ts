// Only selectors cross the RPC boundary; the server chooses the executable and argv.
import { accountEnv, accountProvider } from "../providers/accounts";
import { childEnv } from "../util/env";
import { CLAUDE_CLI, CODEX_CLI, extraArgs, requireCli } from "./cli";

export function loginCommand(provider: string, id = "default"): { argv: string[]; env: Record<string, string> } {
    accountProvider(provider);
    const cli = provider === "codex" ? CODEX_CLI : CLAUDE_CLI;
    return {
        argv: [requireCli(provider, cli), ...extraArgs(provider), ...(provider === "codex" ? ["login"] : ["auth", "login"])],
        env: { ...childEnv(), ...accountEnv(provider, id) },
    };
}
