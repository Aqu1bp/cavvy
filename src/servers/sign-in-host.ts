// A sign-in on one of the user's servers, run from this machine: each of the
// recipe's commands goes over SSH (Cavvy's own connection, with the user's
// keys), the interactive one in a terminal there. The person's browser is
// here, so the recipe's "away" command is the one used.

import { childEnv } from "../util/env";
import { SIGN_IN_COLS, terminalAnswers } from "../agent/sign-in-host";
import { localSignInHost } from "../agent/sign-in-host";
import type { SignInHost, SignInProcess } from "../agent/sign-in";
import type { SignInMachine } from "../agent/sign-ins";
import type { SignInRecipe } from "../agent/sign-in-recipes";
import { agentCli } from "../backends/defs";
import { REMOTE_CURRENT } from "./remote";
import { remoteSh, shQuote, ssh, sshCommandArgv, sshTunnelArgv } from "./ssh";
import { getServer, listServers, type ServerEntry } from "./store";

/** Exit code of the wrapper when the program isn't on the server. */
const MISSING = 127;

/**
 * Runs "$@" on the server with the PATH its login shell has, as Cavvy there remembers it (the CLIs agents use are
 * installed under the user's home), and the recipe's variables. Says 127 by itself when the program isn't there,
 * before anything runs.
 */
const RUN = `
p="$(cat "$HOME/.cavvy/login-path" 2>/dev/null)"
[ -n "$p" ] && PATH="$p:$PATH"
export PATH
command -v "$1" >/dev/null 2>&1 || exit ${MISSING}
exec env "$@"
`;

function command(recipe: SignInRecipe, words: string[], extra: Record<string, string> = {}): string {
    // An agent CLI is the one on the server's PATH: this machine's path and options for it mean nothing there.
    const program = recipe.provider ? (agentCli(recipe.provider)?.cli.command ?? words[0]!) : words[0]!;
    const env = Object.entries({ ...recipe.env, ...extra }).map(([k, v]) => `${k}=${v}`);
    // `env` takes the assignments first, then the program: the check above is on the program's name.
    return remoteSh(RUN.replace('command -v "$1"', `command -v ${shQuote(program)}`), [...env, program, ...words.slice(1)]);
}

export function serverSignInHost(e: ServerEntry): SignInHost {
    return {
        away: true,
        async run(recipe, words, o = {}) {
            const r = await ssh(e, command(recipe, words), { stdin: o.stdin === undefined ? undefined : new TextEncoder().encode(o.stdin), timeoutMs: o.timeoutMs ?? 30_000 });
            return { code: r.code, out: r.stdout + r.stderr, missing: r.code === MISSING && !r.stdout && !r.stderr };
        },
        start(recipe, words, o): SignInProcess {
            const decoder = new TextDecoder();
            // Nothing there can open the person's browser: a CLI that tries is given a program that does nothing.
            const argv = sshCommandArgv(e, command(recipe, words, { BROWSER: "true", TERM: "xterm-256color" }), { tty: true });
            const proc = Bun.spawn(argv, {
                env: childEnv(),
                terminal: {
                    cols: SIGN_IN_COLS,
                    rows: 50,
                    data: (t, bytes) => {
                        const text = decoder.decode(bytes, { stream: true });
                        const answer = terminalAnswers(text);
                        if (answer) t.write(answer);
                        o.onData(text);
                    },
                },
            });
            const terminal = proc.terminal!;
            return {
                write: (text) => { if (proc.exitCode === null && !proc.killed) terminal.write(text); },
                kill: () => { if (proc.exitCode === null) proc.kill("SIGHUP"); },
                exited: proc.exited.then(async (code) => {
                    await Bun.sleep(150);
                    terminal.close();
                    return code;
                }),
            };
        },
        typed(recipe, words) {
            const stub: SignInRecipe = recipe ?? { id: words[0]!, name: words[0]!, status: { run: "" }, here: { flow: "typed", run: words.join(" ") } };
            return sshCommandArgv(e, command(stub, words), { tty: true }).map(shQuote).join(" ");
        },
        async signedIn(recipe) {
            // An agent CLI signed in there is turned on in the Cavvy there, so its models are offered (as `cavvy servers login` does).
            if (recipe.provider) await ssh(e, remoteSh(`exec "${REMOTE_CURRENT}" host login "$1" </dev/null`, [recipe.provider]), { timeoutMs: 60_000 }).catch(() => undefined);
        },
        async forward(port) {
            // The page calls this port on the machine with the browser: the same number here, taken to the server's.
            const proc = Bun.spawn(sshTunnelArgv(e, port, port), { stdin: "ignore", stdout: "ignore", stderr: "pipe", env: childEnv() });
            const up = await Promise.race([proc.exited.then(() => false), listening(port)]);
            if (!up) throw new Error((await new Response(proc.stderr).text().catch(() => "")).trim().split("\n").pop() || `Port ${port} couldn't be forwarded.`);
            return { close: () => proc.kill() };
        },
    };
}

/** Resolves true once something answers on the local port, or false after a few seconds. */
async function listening(port: number): Promise<boolean> {
    for (let i = 0; i < 60; i++) {
        const ok = await new Promise<boolean>((resolve) => {
            void Bun.connect({ hostname: "127.0.0.1", port, socket: { open: (s) => { s.end(); resolve(true); }, error: () => resolve(false), connectError: () => resolve(false), data() {} } }).catch(() => resolve(false));
        });
        if (ok) return true;
        await Bun.sleep(100);
    }
    return false;
}

const HERE = /^(this|here|local|localhost|this (mac|machine|computer|server))$/i;

/**
 * Where a sign-in an agent asked for happens: this machine, or one of the user's servers by its name here. Throws
 * what the agent is told when it can't be that one. `away`: this Cavvy runs on a server (the person's browser is
 * elsewhere, and it reaches no other machine of theirs). `signedIn`: what this machine does with a new sign-in.
 */
export function signInMachine(name: string | undefined, o: { away: boolean; account?: string; signedIn?: (recipe: SignInRecipe, account: string) => Promise<void> }): SignInMachine {
    if (!name || HERE.test(name)) return { host: localSignInHost({ away: o.away, account: o.account, signedIn: o.signedIn }), where: o.away ? "this server" : undefined };
    if (o.away) throw new Error("From a server, only this server can be signed in: leave machine out.");
    const entry = getServer(name.toLowerCase());
    if (!entry) {
        const known = listServers().map((s) => s.name);
        throw new Error(known.length ? `No server is called "${name}". The user's servers: ${known.join(", ")}. Leave machine out for this machine.` : `No server is called "${name}": the user has added none. Leave machine out for this machine.`);
    }
    return { host: serverSignInHost(entry), name: entry.name, where: entry.name };
}
