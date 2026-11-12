// `cavvy servers …`, `cavvy --server <name>` and `cavvy gui --server <name>`:
// the terminal's side of servers. What they do is in the modules beside this
// one, which the GUI server uses too; here are only the words and the prompts.

import { APP_NAME } from "../config/paths";
import { loadScope } from "../config/settings";
import { childEnv } from "../util/env";
import { thisBuild, UNKNOWN_BUILD } from "./build";
import { ServerLink, type LinkState } from "./connect";
import { countCopied, describeCopy, describeLeft, planCopy, sendCopy } from "./copy";
import type { HostCheck, HostStatus } from "./host";
import { ensureBuildThere, ServerBusy, setUpServer, type SetupProgress, type SetupResult } from "./install";
import { probeServer, remoteBuildDir } from "./remote";
import { NotSetUp, remoteCheck, remoteStatus, revokeOverSsh, serviceReport, stopRemote, type ServiceReport } from "./service";
import { hostOf, offeredHostKey, printable, remoteSh, shQuote, ssh, sshCommandArgv, SshError, trustHostKey } from "./ssh";
import { draftServer, listServers, removeServer, requireServer, saveServer, ServerError, thisDesktop, type ServerEntry } from "./store";

const out = (line = "") => process.stdout.write(line + "\n");
const err = (line: string) => process.stderr.write(line + "\n");
const interactive = () => Boolean(process.stdin.isTTY && process.stdout.isTTY);

export const SERVERS_HELP = `Usage:
  ${APP_NAME} servers                          the servers you've added
  ${APP_NAME} servers add <name> <user@host>   add one, and set Cavvy up on it
      --port <n>                             its SSH port, when it isn't 22
      --identity <file>                      the private key to use
      --copy / --no-copy                     copy your settings there, or don't (asked otherwise)
  ${APP_NAME} servers check [name]             what a server has, and what it's missing
  ${APP_NAME} servers update <name>            bring its Cavvy up to this machine's (--force: whatever it runs)
  ${APP_NAME} servers stop <name>              stop Cavvy there
  ${APP_NAME} servers remove <name>            forget it here, and sign this machine out of it

  ${APP_NAME} --server <name>[:<folder>]       the terminal app, running on the server
  ${APP_NAME} gui --server <name>              the server's GUI, in your browser

A server is any Linux machine you reach with ssh. Your SSH config, keys and agent are used as they are.`;

/** Says why something on a server failed, as the user needs it. False for anything that isn't theirs to read. */
function report(e: unknown): boolean {
    // Some of these words are a server's own: nothing in them may draw on the terminal.
    if (e instanceof SshError) {
        err(printable(e.message, 2000));
        if (e.detail) err(`  ${printable(e.detail)}`);
        if (e.fix) err(`  ${printable(e.fix)}`);
        return true;
    }
    if (e instanceof ServerError) {
        err(printable(e.message, 2000));
        return true;
    }
    return false;
}

async function ask(title: string, header: string[], yes: string, no: string): Promise<boolean> {
    if (!interactive()) return false;
    const { askOnce } = await import("../ui/ask");
    return (
        (await askOnce<"yes" | "no">({
            title,
            header,
            items: [
                { label: yes, value: "yes" },
                { label: no, value: "no" },
            ],
        })) === "yes"
    );
}

/**
 * Runs it, and if the server's key isn't known yet, shows the key and asks; once trusted, runs it again. Hands
 * back the server as it's now reached: trusting can add where its key is kept, which a saved server keeps.
 */
async function withTrust<T>(e: ServerEntry, run: (e: ServerEntry) => Promise<T>, o: { saved?: boolean; onTrusted?: (entry: ServerEntry) => void } = {}): Promise<{ entry: ServerEntry; value: T }> {
    try {
        return { entry: e, value: await run(e) };
    } catch (first) {
        if (!(first instanceof SshError) || first.kind !== "host-unknown") throw first;
        const key = await offeredHostKey(e);
        const host = hostOf(e);
        if (!interactive()) throw new SshError("host-unknown", `${host} isn't a server this machine has connected to before.`, `Its key: ${key.fingerprints.join(", ")}`, "Run this in a terminal to check it and trust it.");
        if (!(await ask(`Trust ${host}?`, ["This machine hasn't connected to it before. Its key:", ...key.fingerprints.map((f) => `  ${f}`)], "Trust", "Cancel"))) throw new ServerError("Not trusted, so not connected.");
        const entry = trustHostKey(e, key);
        if (o.saved && entry !== e) saveServer(entry);
        // Told before it's used: whatever the run after this does, even fail, the caller has the server as it's now reached.
        o.onTrusted?.(entry);
        return { entry, value: await run(entry) };
    }
}

function progress(): SetupProgress {
    let last = -1;
    const tty = Boolean(process.stderr.isTTY);
    return {
        step(text) {
            if (last >= 0 && tty) process.stderr.write("\n");
            last = -1;
            err(text);
        },
        copied(sent, total) {
            if (!tty || !total) return;
            const pct = Math.min(100, Math.floor((sent / total) * 100));
            if (pct === last) return;
            last = pct;
            process.stderr.write(`\r  ${pct}%`);
            if (pct === 100) {
                process.stderr.write("\n");
                last = -1;
            }
        },
    };
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

function busyLine(b: { working: number; waiting: number }): string {
    return [...(b.working ? [`${plural(b.working, "session")} working`] : []), ...(b.waiting ? [`${plural(b.waiting, "session")} waiting for an answer`] : [])].join(", ");
}

/**
 * `update`: the user asked for this machine's build there, so a version that's merely different is replaced without
 * asking; one that's newer never is, short of `force`. Stopping work is asked about either way.
 */
function setupOptions(e: ServerEntry, o: { force?: boolean; update?: boolean } = {}) {
    return {
        progress: progress(),
        confirmRestart: (busy: { working: number; waiting: number }) => (o.force ? Promise.resolve(true) : ask(`Stop work on ${e.name} to update?`, [busyLine(busy)], "Update", "Not now")),
        confirmReplace: (theirs: "newer" | "different") => (o.force || (o.update && theirs === "different") ? Promise.resolve(true) : theirs === "newer" ? Promise.resolve(false) : ask(`Replace Cavvy on ${e.name}?`, ["It runs a different version from this machine's."], "Replace", "Keep")),
    };
}

/** Said when a server can't keep Cavvy as a service. */
function serviceLines(service: ServiceReport | undefined): string[] {
    if (!service || service.service) return [];
    return [service.lingerFix ? `It won't start Cavvy again after a reboot. To fix that, run on it: ${service.lingerFix}` : "It won't start Cavvy again after a reboot."];
}

/** What a server lacks, as lines: only what the user would act on. */
export function checkLines(c: HostCheck, service?: ServiceReport): string[] {
    const lines = serviceLines(service);
    const have = c.clis.filter((x) => x.installed);
    for (const cli of have) if (cli.signedIn === false) lines.push(`${cli.product} isn't signed in there. On it: ${cli.signIn}`);
    if (!have.length) {
        lines.push("No agent CLI is installed there (Claude Code, Codex). Models with an API key work without one.");
        for (const cli of c.clis.filter((x) => x.id === "claude-code" || x.id === "codex")) lines.push(`  ${cli.install}`);
    }
    if (!c.git) lines.push("git isn't installed there.");
    if (!c.gh.installed) lines.push("The GitHub CLI isn't installed there: pull requests need it.");
    else if (c.gh.signedIn === false) lines.push("The GitHub CLI isn't signed in there. On it: gh auth login");
    if (!c.browser) lines.push("No Chrome there: the Browser tool needs one.");
    return lines;
}

async function check(e: ServerEntry): Promise<HostCheck | undefined> {
    try {
        return await remoteCheck(e);
    } catch (x) {
        if (!(x instanceof ServerError)) throw x;
        return undefined;
    }
}

function statusLine(e: ServerEntry, s: HostStatus | undefined): string {
    if (!s) return `${e.name}: Cavvy isn't running there.`;
    const busy = busyLine(s);
    return `${e.name}: Cavvy is running${busy ? ` (${busy})` : ""}.`;
}

interface AddFlags {
    port?: number;
    identityFile?: string;
    copy?: boolean;
}

function parseAdd(args: string[]): { name?: string; destination?: string; flags: AddFlags } {
    const flags: AddFlags = {};
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i]!;
        const value = () => {
            const v = args[++i];
            if (v === undefined) throw new ServerError(`${a} needs a value.`);
            return v;
        };
        if (a === "--port" || a === "-p") flags.port = Number(value());
        else if (a === "--identity" || a === "-i") flags.identityFile = value();
        else if (a === "--copy") flags.copy = true;
        else if (a === "--no-copy") flags.copy = false;
        else if (a.startsWith("-")) throw new ServerError(`Unknown option ${a}.`);
        else rest.push(a);
    }
    return { name: rest[0], destination: rest[1], flags };
}

/** The one-time copy. It's an extra: failing, it's said and the server is still added. */
async function offerCopy(e: ServerEntry, wanted: boolean | undefined) {
    if (wanted === false) return;
    let settings;
    try {
        settings = loadScope("user", process.cwd());
    } catch {
        settings = undefined;
    }
    const plan = planCopy(settings);
    try {
        const what = describeCopy(plan.counts);
        if (!what) return;
        if (wanted === undefined && !(await ask(`Copy your ${what} to ${e.name}?`, ["Keys aren't copied."], "Copy", "Skip"))) return;
        // What the server took, which isn't always what was offered: it keeps what it has.
        const took = describeCopy(countCopied(await sendCopy(e, plan)));
        err(took ? `Copied your ${took}.` : `${e.name} already had them.`);
        // Not in silence: they're in the settings here, and the user would look for them there.
        const left = describeLeft(plan.left);
        if (left) err(`Not copied, since they could hold a key or need this machine: ${left}.`);
    } catch (x) {
        if (!report(x)) throw x;
    } finally {
        plan.cleanup();
    }
}

async function add(args: string[]): Promise<number> {
    const { name, destination, flags } = parseAdd(args);
    if (!name || !destination) {
        err(`Usage: ${APP_NAME} servers add <name> <user@host> [--port n] [--identity file]`);
        return 1;
    }
    let e = draftServer({ name, destination, port: flags.port, identityFile: flags.identityFile });
    err(`Connecting to ${hostOf(e)}…`);
    let setup: SetupResult | undefined;
    try {
        ({ value: setup } = await withTrust(e, (entry) => setUpServer(entry, setupOptions(entry)), { onTrusted: (entry) => (e = entry) }));
    } catch (x) {
        // It's there and working, on its own version: added, and updated another time.
        if (!(x instanceof ServerBusy)) throw x;
        saveServer(e);
        out(`${e.name} is added. It's working, so Cavvy there wasn't updated: ${APP_NAME} servers update ${e.name}`);
        return 0;
    }
    saveServer(e);
    await offerCopy(e, flags.copy);
    out(setup.kept === "newer" ? `${e.name} is ready. It runs a newer Cavvy than this machine.` : `${e.name} is ready.`);
    out("Only put credentials on it that you'd accept an agent using.");
    const c = await check(e);
    for (const line of c ? checkLines(c, setup.service) : serviceLines(setup.service)) out(line);
    out(`Work there: ${APP_NAME} --server ${e.name}   or   ${APP_NAME} gui --server ${e.name}`);
    return 0;
}

async function checkCommand(names: string[]): Promise<number> {
    const targets = names.length ? names.map(requireServer) : listServers();
    if (!targets.length) {
        out(`No servers yet. Add one: ${APP_NAME} servers add <name> <user@host>`);
        return 0;
    }
    let failed = 0;
    for (const e of targets) {
        try {
            const [status, facts] = await Promise.all([remoteStatus(e), probeServer(e)]);
            out(statusLine(e, status));
            // Only a Cavvy that knows which build it is can say another one differs, or bring it level.
            if (status && thisBuild() !== UNKNOWN_BUILD && status.build !== thisBuild()) out(`  It runs a different version from this machine's: ${APP_NAME} servers update ${e.name}`);
            const c = await check(e);
            const lines = c ? checkLines(c, serviceReport(facts)) : [];
            for (const line of lines) out(`  ${line}`);
            if (c && !lines.length) out("  Nothing missing.");
        } catch (x) {
            if (x instanceof NotSetUp) out(`${e.name}: Cavvy isn't set up there. Set it up: ${APP_NAME} servers update ${e.name}`);
            else if (!report(x)) throw x;
            failed++;
        }
    }
    return failed ? 1 : 0;
}

async function update(args: string[]): Promise<number> {
    const force = args.includes("--force");
    const name = args.find((a) => !a.startsWith("-"));
    if (!name) {
        err(`Usage: ${APP_NAME} servers update <name> [--force]`);
        return 1;
    }
    const e = requireServer(name);
    const { value: r } = await withTrust(e, (entry) => setUpServer(entry, setupOptions(entry, { force, update: true })), { saved: true });
    if (r.kept === "newer") out(`${e.name} runs a newer Cavvy than this machine, so it was left as it is. Update Cavvy here, or use --force.`);
    else if (r.kept) out(`${e.name} was left on its own version.`);
    else out(r.replaced ? `${e.name} is updated.` : `${e.name} is up to date.`);
    for (const line of serviceLines(r.service)) out(line);
    return 0;
}

async function stop(args: string[]): Promise<number> {
    const name = args.find((a) => !a.startsWith("-"));
    if (!name) {
        err(`Usage: ${APP_NAME} servers stop <name>`);
        return 1;
    }
    const e = requireServer(name);
    let status: HostStatus | undefined;
    try {
        status = await remoteStatus(e);
    } catch (x) {
        if (!(x instanceof NotSetUp)) throw x;
    }
    if (status && (status.working || status.waiting) && !args.includes("--force") && !(await ask(`Stop Cavvy on ${e.name}?`, [busyLine(status)], "Stop", "Cancel"))) {
        err(`${e.name} is working (${busyLine(status)}). To stop it anyway: ${APP_NAME} servers stop ${e.name} --force`);
        return 1;
    }
    // Also when it isn't answering: one that's only starting, or about to be started again, is stopped for good too.
    await stopRemote(e);
    out(`Cavvy on ${e.name} is stopped.`);
    return 0;
}

async function remove(args: string[]): Promise<number> {
    const name = args.find((a) => !a.startsWith("-"));
    if (!name) {
        err(`Usage: ${APP_NAME} servers remove <name>`);
        return 1;
    }
    const e = removeServer(name);
    let signedOut = true;
    try {
        await revokeOverSsh(e, thisDesktop().id);
    } catch (x) {
        if (!(x instanceof ServerError)) throw x;
        signedOut = false;
    }
    out(`Removed ${e.name}.${signedOut ? "" : ` It couldn't be reached to sign this machine out.`}`);
    out(`To put it back: ${APP_NAME} servers add ${e.name} ${e.destination}${e.port ? ` --port ${e.port}` : ""}${e.identityFile ? ` --identity ${shQuote(e.identityFile)}` : ""}`);
    return 0;
}

export async function serversCommand(args: string[]): Promise<number> {
    const sub = args[0];
    try {
        if (sub === undefined || sub === "list" || sub === "ls") {
            const all = listServers();
            if (!all.length) out(`No servers yet. Add one: ${APP_NAME} servers add <name> <user@host>`);
            for (const s of all) out(`${s.name}\t${s.destination}${s.port ? `:${s.port}` : ""}`);
            return 0;
        }
        if (sub === "add") return await add(args.slice(1));
        if (sub === "check") return await checkCommand(args.slice(1).filter((a) => !a.startsWith("-")));
        if (sub === "update") return await update(args.slice(1));
        if (sub === "stop") return await stop(args.slice(1));
        if (sub === "remove" || sub === "rm") return await remove(args.slice(1));
        (sub === "-h" || sub === "--help" || sub === "help" ? out : err)(SERVERS_HELP);
        return sub === "-h" || sub === "--help" || sub === "help" ? 0 : 1;
    } catch (x) {
        if (report(x)) return 1;
        throw x;
    }
}

// ---------------------------------------------------------------------------
// `cavvy --server <name>[:<folder>]`: the terminal app, on the server.

/** Exit codes the script below keeps for itself. */
const NO_BUILD = 97;
const NO_FOLDER = 96;

/**
 * Runs this machine's build of Cavvy in a folder there ($2), under the user's
 * login shell so the tools it puts on PATH are found. $1: the build. The rest
 * go to Cavvy as they were typed.
 */
const RUN = `
b="${remoteBuildDir("$1")}/cavvy"
[ -x "$b" ] || exit ${NO_BUILD}
dir="$2"
shift 2
case "$dir" in "~") dir="$HOME" ;; "~/"*) dir="$HOME/\${dir#\\~/}" ;; esac
cd -- "$dir" 2>/dev/null || { echo "No folder $dir there." >&2; exit ${NO_FOLDER}; }
sh=\${SHELL:-/bin/sh}
case "\${sh##*/}" in
    bash|zsh|sh|dash|ksh) exec "$sh" -lc 'exec "$0" "$@"' "$b" "$@" ;;
    *) exec "$b" "$@" ;;
esac
`;

/** What the terminal says about itself, which a remote Cavvy needs to draw as it would here. */
const TERMINAL_ENV = ["COLORTERM", "TERM_PROGRAM", "TERM_PROGRAM_VERSION", "LC_TERMINAL", "LC_TERMINAL_VERSION"];

export function parseServerSpec(spec: string): { name: string; folder: string } {
    const i = spec.indexOf(":");
    return i < 0 ? { name: spec, folder: "~" } : { name: spec.slice(0, i), folder: spec.slice(i + 1) || "~" };
}

/** The command line that continues there, for the line printed when the connection is lost. */
function continueCommand(spec: string): string {
    return `${APP_NAME} --server ${shQuote(spec)} -c`;
}

export async function runOnServer(spec: string, forwarded: string[]): Promise<number> {
    try {
        const { name, folder } = parseServerSpec(spec);
        let e = requireServer(name);
        const build = thisBuild();
        if (build === UNKNOWN_BUILD) throw new ServerError("This copy of Cavvy can't tell which build it is, so it can't run on a server. Run it from a checkout.");
        const env = TERMINAL_ENV.filter((k) => process.env[k]).map((k) => `${k}=${shQuote(process.env[k]!)}`);
        const command = `env ${["CAVVY_NO_KEYCHAIN=1", ...env].join(" ")} ${remoteSh(RUN, [build, folder, ...forwarded])}`;
        // Asked first without the terminal, so a server that can't be reached, or has no build yet, is said in plain words.
        const asked = await withTrust(e, (entry) => ssh(entry, remoteSh(`[ -x "${remoteBuildDir("$1")}/cavvy" ] || exit ${NO_BUILD}`, [build]), { timeoutMs: 45_000 }), { saved: true, onTrusted: (entry) => (e = entry) });
        if (asked.value.code === NO_BUILD) {
            err(`Setting up Cavvy on ${e.name}…`);
            await ensureBuildThere(e, { progress: progress() });
        }
        const tty = interactive();
        // Off a terminal, the Cavvy there reads what's piped in. A terminal that's only standing by (output is piped, input
        // isn't) is nothing to read: handed over, it would be a pipe that never ends, and the Cavvy there would wait on it.
        const stdin = !tty && process.stdin.isTTY ? "ignore" : "inherit";
        const proc = Bun.spawn(sshCommandArgv(e, command, { tty }), { stdin, stdout: "inherit", stderr: "inherit", env: childEnv() });
        // Ctrl+C belongs to the Cavvy over there: with a terminal it's passed on as a key; without one, ssh takes it and ends.
        let interrupted = false;
        const onInterrupt = () => {
            interrupted = true;
        };
        process.on("SIGINT", onInterrupt);
        const code = await proc.exited;
        process.off("SIGINT", onInterrupt);
        if (interrupted && !tty) return 130;
        // 255 is ssh's own failure; killed, it's gone the same way.
        if (code === 255 || proc.signalCode) {
            // The Cavvy there couldn't put the terminal back as it found it.
            if (tty) process.stdout.write((await import("../ui/screen")).TERMINAL_OFF + "\n");
            err(`Connection to ${e.name} lost.`);
            if (tty) err(`Continue with: ${continueCommand(spec)}`);
            return 1;
        }
        // Checked a moment ago, and gone since: another machine brought the server to its own build in between.
        if (code === NO_BUILD) err(`Cavvy on ${e.name} changed just now. Run that again.`);
        return code === NO_FOLDER || code === NO_BUILD ? 1 : code;
    } catch (x) {
        if (report(x)) return 1;
        throw x;
    }
}

// ---------------------------------------------------------------------------
// `cavvy gui --server <name>`: the server's GUI in a browser here, through a tunnel.

function openBrowser(url: string) {
    const argv = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
    try {
        Bun.spawn(argv, { stdout: "ignore", stderr: "ignore", stdin: "ignore", env: childEnv() });
    } catch {
        // the link is printed too
    }
}

export async function guiOnServer(name: string, o: { open: boolean }): Promise<number> {
    try {
        let e = requireServer(name);
        let lastRun: string | undefined;
        /** Connects and keeps connected; `over` settles when it's stopped, with why if it wasn't stopped here. */
        const connect = async (entry: ServerEntry) => {
            const over = Promise.withResolvers<ServerError | undefined>();
            const link = new ServerLink(entry, {
                onState(s: LinkState) {
                    if (s.state === "connected") {
                        if (!s.pairing.gui) return over.resolve(new ServerError(`Cavvy on ${entry.name} was set up without its GUI. Build the GUI here (bun install --cwd gui && bun run gui:build), then: ${APP_NAME} servers update ${entry.name}`));
                        const url = `http://127.0.0.1:${s.localPort}`;
                        const link = `${url}/#code=${s.pairing.code}`;
                        if (lastRun === undefined) {
                            err(`\n  ${entry.name} is at ${url}\n  Open (one-time link): ${link}\n  Ctrl+C disconnects. Work there keeps running.\n`);
                            if (o.open) openBrowser(link);
                        } else if (lastRun !== s.pairing.run) {
                            // A server that restarted has forgotten every sign-in: the page needs a new one.
                            err(`Cavvy on ${entry.name} restarted. Open: ${link}`);
                            if (o.open) openBrowser(link);
                        }
                        // The page may have given up, or its sign-in run out, while this was away: a link for that, not opened.
                        else err(`Reconnected to ${entry.name}. If the page asks you to sign in: ${link}`);
                        lastRun = s.pairing.run;
                    } else if (s.state === "reconnecting" && s.attempt === 1) err(`Connection to ${entry.name} lost. Reconnecting…`);
                    else if (s.state === "stopped") over.resolve(s.error);
                },
            });
            await link.start();
            return { link, over: over.promise };
        };
        let up: Awaited<ReturnType<typeof connect>>;
        try {
            ({ value: up } = await withTrust(e, connect, { saved: true, onTrusted: (entry) => (e = entry) }));
        } catch (x) {
            if (!(x instanceof NotSetUp)) throw x;
            err(`Setting up Cavvy on ${e.name}…`);
            await setUpServer(e, setupOptions(e));
            up = await connect(e);
        }
        const quit = () => void up.link.stop({ signOut: true });
        process.on("SIGINT", quit);
        process.on("SIGTERM", quit);
        // The terminal window closing ends it too, and signs out the same.
        process.on("SIGHUP", quit);
        const failed = await up.over;
        // What this connection signed in stops working with it: a page left open has nothing good for whatever
        // listens on its port next.
        await up.link.stop({ signOut: true });
        if (failed) {
            report(failed);
            return 1;
        }
        return 0;
    } catch (x) {
        if (report(x)) return 1;
        throw x;
    }
}
