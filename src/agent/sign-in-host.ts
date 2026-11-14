// Where a sign-in's commands run when it's on this machine: Cavvy's own
// processes, outside any agent's sandbox, started with arguments only (no
// shell reads a recipe).

import { homedir } from "os";
import { accountEnv } from "../providers/accounts";
import { extraArgs, findCli } from "../backends/cli";
import { agentCli } from "../backends/defs";
import { childEnv } from "../util/env";
import type { SignInHost, SignInProcess } from "./sign-in";
import type { SignInRecipe } from "./sign-in-recipes";

const DRAIN_MS = 150;

/** Wide enough that a link is printed on one line. */
export const SIGN_IN_COLS = 400;

/** What a program that checks its terminal before prompting is told: where the cursor is, and what kind of terminal this is. */
export function terminalAnswers(text: string): string {
    return (text.includes("\x1b[6n") ? "\x1b[1;1R" : "") + (/\x1b\[0?c/.test(text) ? "\x1b[?1;2c" : "");
}

/** A program that does nothing, for BROWSER: the card opens the page, not the CLI. */
export function noBrowser(): string {
    return Bun.which("true", { PATH: process.env.PATH ?? "" }) ?? "/usr/bin/true";
}

/** The command as it runs here: an agent CLI by the path and options Cavvy uses for it, anything else from PATH. */
function resolve(recipe: SignInRecipe, words: string[], account: string): { argv: string[]; env: Record<string, string> } | undefined {
    const def = recipe.provider ? agentCli(recipe.provider) : undefined;
    if (def) {
        const bin = findCli(def.id, def.cli);
        if (!bin) return undefined;
        return { argv: [bin, ...extraArgs(def.id), ...words.slice(1)], env: { ...childEnv(recipe.env), ...(def.account ? accountEnv(def.id, account) : {}) } };
    }
    const bin = words[0] && !words[0].includes("/") ? Bun.which(words[0], { PATH: process.env.PATH ?? "" }) : null;
    return bin ? { argv: [bin, ...words.slice(1)], env: childEnv(recipe.env) } : undefined;
}

/** `away`: the person's browser is on another machine (this Cavvy runs on a server). `account`: which of an agent CLI's accounts. */
export function localSignInHost(o: { away: boolean; account?: string; signedIn?: (recipe: SignInRecipe, account: string) => Promise<void> }): SignInHost {
    const account = o.account ?? "default";
    return {
        away: o.away,
        signedIn: o.signedIn ? (recipe) => o.signedIn!(recipe, account) : undefined,
        async run(recipe, words, opts = {}) {
            const cmd = resolve(recipe, words, account);
            if (!cmd) return { code: 127, out: "", missing: true };
            const proc = Bun.spawn(cmd.argv, { cwd: homedir(), env: cmd.env, stdin: opts.stdin === undefined ? "ignore" : Buffer.from(opts.stdin), stdout: "pipe", stderr: "pipe" });
            const timer = setTimeout(() => proc.kill(), opts.timeoutMs ?? 30_000);
            try {
                const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
                return { code, out: out + err };
            } finally {
                clearTimeout(timer);
            }
        },
        start(recipe, words, opts): SignInProcess {
            const cmd = resolve(recipe, words, account);
            if (!cmd) throw new Error(`${recipe.name} isn't installed: \`${words[0]}\` wasn't found.`);
            const decoder = new TextDecoder();
            const proc = Bun.spawn(cmd.argv, {
                cwd: homedir(),
                env: { ...cmd.env, TERM: "xterm-256color", ...(opts.opens ? {} : { BROWSER: noBrowser() }) },
                terminal: {
                    cols: SIGN_IN_COLS,
                    rows: 50,
                    data: (t, bytes) => {
                        const text = decoder.decode(bytes, { stream: true });
                        const answer = terminalAnswers(text);
                        if (answer) t.write(answer);
                        opts.onData(text);
                    },
                },
            });
            const terminal = proc.terminal!;
            return {
                write: (text) => { if (proc.exitCode === null && !proc.killed) terminal.write(text); },
                kill: () => { if (proc.exitCode === null) proc.kill("SIGHUP"); },
                // What it printed last is still on its way from the terminal when it exits.
                exited: proc.exited.then(async (code) => {
                    await Bun.sleep(DRAIN_MS);
                    terminal.close();
                    return code;
                }),
            };
        },
    };
}
