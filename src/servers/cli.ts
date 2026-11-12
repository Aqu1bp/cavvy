// `cavvy servers …`, `cavvy --server <name>` and `cavvy gui --server <name>`:
// the terminal's side of servers. What they do is in the modules beside this
// one, which the GUI server uses too; here are only the words and the prompts.

import { randomBytes } from "crypto";
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { APP_NAME, cavvyHome } from "../config/paths";
import { loadScope } from "../config/settings";
import { childEnv } from "../util/env";
import { thisBuild, UNKNOWN_BUILD } from "./build";
import { ServerLink, type LinkState } from "./connect";
import { countCopied, describeCopy, describeLeft, planCopy, sendCopy } from "./copy";
import type { HostCheck, HostStatus } from "./host";
import { ensureBuildThere, ServerBusy, setUpServer, type SetupProgress, type SetupResult } from "./install";
import { LOGIN_EXIT, probeServer, REMOTE_CURRENT, REMOTE_DIR, remoteBuildDir } from "./remote";
import { NotSetUp, remoteCheck, remoteStatus, revokeOverSsh, serviceReport, stopRemote, type ServiceReport } from "./service";
import { hostOf, offeredHostKey, printable, remoteSh, shQuote, ssh, sshCommandArgv, SshError, trustHostKey } from "./ssh";
import { draftServer, listServers, removeServer, requireServer, saveServer, ServerError, thisDesktop, type ServerEntry } from "./store";
import type { PermissionMode } from "../permissions/modes";

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
  ${APP_NAME} servers login <name> [cli]       sign Claude Code or Codex in there, and turn it on
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

type CheckedCli = HostCheck["clis"][number];

/** Installed on a server and not usable there yet: not signed in, or signed in and not turned on in its Cavvy. */
const needsSignIn = (cli: CheckedCli) => cli.installed && cli.signedIn === false;
const needsTurningOn = (cli: CheckedCli) => cli.installed && cli.signedIn === true && cli.on === false;

/** Said of a server with no agent CLI on it, with how to install the two most used. */
function noCliLines(c: HostCheck): string[] {
    if (c.clis.some((x) => x.installed)) return [];
    return ["No agent CLI is installed there (Claude Code, Codex). Models with an API key work without one.", ...c.clis.filter((x) => x.id === "claude-code" || x.id === "codex").map((cli) => `  ${cli.install}`)];
}

/** What server `name` lacks, as lines: only what the user would act on. */
export function checkLines(name: string, c: HostCheck, service?: ServiceReport): string[] {
    const lines = serviceLines(service);
    const have = c.clis.filter((x) => x.installed);
    for (const cli of have) {
        if (needsSignIn(cli)) lines.push(`${cli.product} isn't signed in there: ${APP_NAME} servers login ${name}`);
        else if (needsTurningOn(cli)) lines.push(`${cli.product} isn't turned on there: ${APP_NAME} servers login ${name}`);
    }
    lines.push(...noCliLines(c));
    if (!c.git) lines.push("git isn't installed there.");
    if (!c.gh.installed) lines.push("The GitHub CLI isn't installed there: pull requests need it.");
    else if (c.gh.signedIn === false) lines.push("The GitHub CLI isn't signed in there. On it: gh auth login");
    if (!c.browser) lines.push("No Chrome there: the Browser tool needs one.");
    return lines;
}

const MODE_NAMES: Record<PermissionMode, string> = { default: "Manual", acceptEdits: "Accept edits", plan: "Plan", auto: "Auto", bypassPermissions: "Bypass" };

/** How sessions on a server stand with permissions: the mode they start in, and the sandbox Auto mode would use. Nothing for a server that doesn't say. */
export function permissionLines(c: HostCheck): string[] {
    if (!c.mode) return [];
    const sandbox = !c.sandbox
        ? "Auto mode has no sandbox there."
        : c.sandboxOn
          ? `Auto mode's sandbox is on (${c.sandbox === "bwrap" ? "bubblewrap" : "Seatbelt"}).`
          : `Auto mode's sandbox is off: "sandbox": true in its settings turns it on (bubblewrap, experimental).`;
    return [`Sessions start in ${MODE_NAMES[c.mode]}. ${sandbox}`];
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
    let plan: ReturnType<typeof planCopy> | undefined;
    // The copies made ready to send don't outlive this, however it ends.
    const interrupted = () => {
        plan?.cleanup();
        process.exit(130);
    };
    process.on("SIGINT", interrupted);
    process.on("SIGTERM", interrupted);
    try {
        let settings;
        try {
            settings = loadScope("user", process.cwd());
        } catch {
            settings = undefined;
        }
        plan = planCopy(settings);
        const what = describeCopy(plan.counts);
        // Not in silence: they're in the settings here, and the user would look for them there.
        const left = describeLeft(plan.left);
        const sayLeft = () => left && err(`Not copied, since they could hold a key or need this machine: ${left}.`);
        if (!what) return void sayLeft();
        if (wanted === undefined && !(await ask(`Copy your ${what} to ${e.name}?`, ["Keys, and what reads like one, stay here."], "Copy", "Skip"))) return;
        // What the server took, which isn't always what was offered: it keeps what it has.
        const took = describeCopy(countCopied(await sendCopy(e, plan)));
        err(took ? `Copied your ${took}.` : `${e.name} already had them.`);
        sayLeft();
    } catch (x) {
        if (x instanceof ServerError) report(x);
        // Settings this can't read as it expects (an MCP server written some other way): nothing was copied.
        else err(`Couldn't copy your settings: ${printable((x as Error)?.message ?? String(x))}`);
    } finally {
        process.off("SIGINT", interrupted);
        process.off("SIGTERM", interrupted);
        plan?.cleanup();
    }
}

/** Not set up there (exit ${NOT_SET_UP}), or `cavvy host login` for CLI $1 with this terminal. */
const NOT_SET_UP = 46;
const LOGIN = `
b="${REMOTE_CURRENT}"
[ -x "$b" ] || exit ${NOT_SET_UP}
exec "$b" host login "$1"
`;

/**
 * Signs a CLI in on the server and turns it on in the Cavvy there. The CLI's own sign-in has this terminal for as
 * long as it runs: its link is opened here, and what's typed goes to it alone. True once it's usable there.
 */
async function signInThere(e: ServerEntry, cli: CheckedCli): Promise<boolean> {
    // The CLI talks of a browser that didn't open: it's on the server, and the browser is here.
    if (needsSignIn(cli)) err(`Open the link ${cli.product} shows in a browser on this machine.`);
    const tty = interactive();
    const proc = Bun.spawn(sshCommandArgv(e, remoteSh(LOGIN, [cli.id]), { tty }), { stdin: "inherit", stdout: "inherit", stderr: "inherit", env: childEnv() });
    // With a terminal, Ctrl+C is typed to the other end. Without one it reaches this and ssh both, and ssh ends.
    let interrupted = false;
    const onInterrupt = () => {
        interrupted = true;
    };
    process.on("SIGINT", onInterrupt);
    const code = await proc.exited;
    process.off("SIGINT", onInterrupt);
    if (code === 0) {
        out(`${cli.product} is ready on ${e.name}.`);
        return true;
    }
    // Stopped with Ctrl+C: nothing was lost, and there's nothing to add.
    if (code === LOGIN_EXIT.stopped || (interrupted && !tty)) return false;
    const again = `${APP_NAME} servers login ${e.name} ${cli.id}`;
    if (code === LOGIN_EXIT.notSignedIn) err(`${cli.product} isn't signed in on ${e.name}. To try again: ${again}`);
    else if (code === LOGIN_EXIT.notInstalled) err(`${cli.product} isn't installed on ${e.name}.`);
    else if (code === NOT_SET_UP) err(`Cavvy isn't set up on ${e.name}. Set it up: ${APP_NAME} servers update ${e.name}`);
    // What was wrong is on the lines above: the server's Cavvy said it.
    else if (code === LOGIN_EXIT.problem) err(`${cli.product} wasn't turned on on ${e.name}.`);
    else if (code === 255 || proc.signalCode) {
        // The CLI there couldn't put the terminal back as it found it.
        if (tty) process.stdout.write((await import("../ui/screen")).TERMINAL_OFF + "\n");
        err(`Connection to ${e.name} lost. To try again: ${again}`);
    }
    // A Cavvy there from before it could do this answers with its usage.
    else err(`Couldn't sign ${cli.product} in on ${e.name}. If Cavvy there is older than this one: ${APP_NAME} servers update ${e.name}`);
    return false;
}

/**
 * After a server is added or checked in a terminal: each CLI that's installed there and can't be used yet is offered,
 * one question each. True when anything was tried, so the caller looks at the server again.
 */
async function offerSignIns(e: ServerEntry, c: HostCheck): Promise<boolean> {
    if (!interactive()) return false;
    let tried = false;
    for (const cli of c.clis) {
        const wanted = needsSignIn(cli)
            ? await ask(`Sign in to ${cli.product} on ${e.name}?`, [], "Sign in", "Not now")
            : needsTurningOn(cli) && (await ask(`Use ${cli.product} on ${e.name}?`, ["It's signed in there."], "Use", "Not now"));
        if (!wanted) continue;
        tried = true;
        await signInThere(e, cli);
    }
    return tried;
}

async function login(args: string[]): Promise<number> {
    const [name, id] = args.filter((a) => !a.startsWith("-"));
    if (!name) {
        err(`Usage: ${APP_NAME} servers login <name> [cli]`);
        return 1;
    }
    let e = requireServer(name);
    const { value: c } = await withTrust(e, (entry) => remoteCheck(entry), { saved: true, onTrusted: (entry) => (e = entry) });
    const named = id === undefined ? undefined : c.clis.find((x) => x.id === id);
    if (id !== undefined && !named) {
        err(`No CLI called ${printable(id, 40)}. There are: ${c.clis.map((x) => x.id).join(", ")}`);
        return 1;
    }
    if (named && !named.installed) {
        err(`${named.product} isn't installed on ${e.name}. ${named.install}`);
        return 1;
    }
    // Named: that one, whatever its state (the server's Cavvy looks again). Otherwise every one that isn't usable yet.
    const todo = named ? [named] : c.clis.filter((x) => needsSignIn(x) || needsTurningOn(x));
    if (!todo.length) {
        const none = noCliLines(c);
        for (const line of none.length ? none : [`Nothing to sign in on ${e.name}.`]) out(line);
        return 0;
    }
    // One that's signed in there only needs turning on, which is done with a terminal or without. A sign-in shows a
    // link and may take a code: without a terminal those are said, and left.
    const now = interactive() ? todo : todo.filter((x) => x.signedIn === true);
    let failed = 0;
    for (const cli of now) if (!(await signInThere(e, cli))) failed++;
    if (now.length < todo.length) {
        err("Signing in needs a terminal.");
        failed++;
    }
    return failed ? 1 : 0;
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
    let c = await check(e);
    if (c?.mode === "bypassPermissions") out("Sessions there run without asking (Bypass).");
    // Asked about one at a time; what's said afterwards is the server as that left it.
    if (c && (await offerSignIns(e, c))) c = await check(e);
    for (const line of c ? checkLines(e.name, c, setup.service) : serviceLines(setup.service)) out(line);
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
            const lines = c ? checkLines(e.name, c, serviceReport(facts)) : [];
            for (const line of lines) out(`  ${line}`);
            if (c && !lines.length) out("  Nothing missing.");
            for (const line of c ? permissionLines(c) : []) out(`  ${line}`);
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
        if (sub === "login") return await login(args.slice(1));
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

/** When process $1 started, in whatever form the system has (Linux: from /proc; elsewhere: ps): only ever compared with itself. */
const STARTED = `started() { awk '{print $22}' "/proc/$1/stat" 2>/dev/null || ps -o lstart= -p "$1" 2>/dev/null | awk '{$1=$1; print}'; }`;

/**
 * Runs this machine's build of Cavvy in a folder there ($2), under the user's
 * login shell so the tools it puts on PATH are found. $1: the build. $3 and
 * $4: this machine and this run of `--server`, under which the process leaves
 * its pid (see LEFTOVERS). The rest go to Cavvy as they were typed.
 */
const RUN = `
b="${remoteBuildDir("$1")}/cavvy"
[ -x "$b" ] || exit ${NO_BUILD}
dir="$2"
runs="${REMOTE_DIR}/runs/$3"
${STARTED}
mkdir -p "$runs" && echo "$$ $(started $$)" > "$runs/$4"
shift 4
case "$dir" in "~") dir="$HOME" ;; "~/"*) dir="$HOME/\${dir#\\~/}" ;; esac
cd -- "$dir" 2>/dev/null || { echo "No folder $dir there." >&2; exit ${NO_FOLDER}; }
sh=\${SHELL:-/bin/sh}
case "\${sh##*/}" in
    bash|zsh|sh|dash|ksh) exec "$sh" -lc 'exec "$0" "$@"' "$b" "$@" ;;
    *) exec "$b" "$@" ;;
esac
`;

/**
 * Before a run: the Cavvys this machine ($2) left running there are ended, and is build $1 there (exit ${NO_BUILD}
 * if not). A connection that's lost without a word (a laptop closing, a network going) isn't noticed by the server
 * for a long while, so the Cavvy it carried runs on, holding its session: "continue with -c" would be refused.
 *
 * Each run is known by an id. The script says which runs of this machine it has ("run <id>" lines, then "listed"),
 * and only then reads which of them to end: the ones whose terminal isn't open here any more. Asked in that order,
 * a run that started while this one was connecting is never taken for one that was left: it's written down here
 * before anything of it is there (runOnServer), so by the time it's listed it's known as open.
 *
 * A run to end is asked to stop (TERM, which lets it close its session and its commands), all at once, and killed
 * if it's still there after longer than a Cavvy takes to close. Only ever the process that wrote the file: its
 * start time says so, looked at again before each signal.
 */
const LEFTOVERS = `
runs="${REMOTE_DIR}/runs/$2"
${STARTED}
if [ -d "$runs" ]; then
    for f in "$runs"/*; do [ -f "$f" ] && echo "run $(basename "$f")"; done
fi
echo listed
read -r gone || gone=""
same() {
    pid=""; start=""
    [ -f "$runs/$1" ] || return 1
    read -r pid start < "$runs/$1" || true
    case "$pid" in ""|*[!0-9]*) return 1 ;; esac
    [ -n "$start" ] && [ "$(started "$pid")" = "$start" ]
}
ending=""
for id in $gone; do
    case "$id" in ""|*[!0-9a-f]*) continue ;; esac
    [ -f "$runs/$id" ] || continue
    if same "$id" && kill -TERM "$pid" 2>/dev/null; then ending="$ending $id"; else rm -f "$runs/$id"; fi
done
if [ -n "$ending" ]; then
    echo ending
    n=0
    while [ "$n" -lt 70 ]; do
        left=""
        for id in $ending; do if same "$id"; then left="$left $id"; else rm -f "$runs/$id"; fi; done
        ending=$left
        [ -n "$ending" ] || break
        sleep 0.1
        n=$((n + 1))
    done
    for id in $ending; do same "$id" && kill -KILL "$pid" 2>/dev/null; rm -f "$runs/$id"; done
fi
[ -x "${remoteBuildDir("$1")}/cavvy" ] || exit ${NO_BUILD}
`;

/** The `--server` runs of this machine whose terminals are open: each leaves its pid here while it runs. */
const localRuns = () => join(cavvyHome(), "run", "server-runs");

/** The ids of the runs still going here. Files left by ones that died are cleared away. */
function openRuns(): string[] {
    const open: string[] = [];
    let names: string[] = [];
    try {
        names = readdirSync(localRuns());
    } catch {
        return open;
    }
    for (const id of names) {
        const file = join(localRuns(), id);
        let alive = false;
        try {
            process.kill(Number(readFileSync(file, "utf-8")), 0);
            alive = true;
        } catch (x) {
            alive = (x as NodeJS.ErrnoException).code === "EPERM";
        }
        if (alive && /^[0-9a-f]{16}$/.test(id)) open.push(id);
        else rmSync(file, { force: true });
    }
    return open;
}

/** Runs LEFTOVERS: answers its list of this machine's runs with the ones that aren't open here, read only then. */
function endLeftovers(e: ServerEntry, build: string, machine: string) {
    let heard = "";
    let said = false;
    let listed!: (ids: string[]) => void;
    const there = new Promise<string[]>((resolve) => (listed = resolve));
    async function* answer() {
        const ids = await there;
        const open = new Set(openRuns());
        yield new TextEncoder().encode(`${ids.filter((id) => !open.has(id)).join(" ")}\n`);
    }
    return ssh(e, remoteSh(LEFTOVERS, [build, machine]), {
        timeoutMs: 45_000,
        stdin: answer(),
        onStdout(text, done) {
            heard += text;
            const lines = heard.split("\n");
            const at = lines.indexOf("listed");
            // With no more to come (it never connected, or ended early) it's answered with nothing to end.
            if (at >= 0 || done) listed(lines.slice(0, Math.max(at, 0)).flatMap((l) => /^run ([0-9a-f]{16})$/.exec(l)?.[1] ?? []));
            if (!said && lines.includes("ending")) {
                said = true;
                err(`Closing a session left open on ${e.name}…`);
            }
        },
    });
}

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
        const machine = thisDesktop().id;
        const run = randomBytes(8).toString("hex");
        const command = `env ${["CAVVY_NO_KEYCHAIN=1", ...env].join(" ")} ${remoteSh(RUN, [build, folder, machine, run, ...forwarded])}`;
        // Asked first without the terminal, so a server that can't be reached, or has no build yet, is said in plain
        // words; and what earlier runs from here left running there is ended, so their sessions can be continued.
        const asked = await withTrust(e, (entry) => endLeftovers(entry, build, machine), { saved: true, onTrusted: (entry) => (e = entry) });
        if (asked.value.code === NO_BUILD) {
            err(`Setting up Cavvy on ${e.name}…`);
            await ensureBuildThere(e, { progress: progress() });
        }
        const tty = interactive();
        // Off a terminal, the Cavvy there reads what's piped in. A terminal that's only standing by (output is piped, input
        // isn't) is nothing to read: handed over, it would be a pipe that never ends, and the Cavvy there would wait on it.
        const stdin = !tty && process.stdin.isTTY ? "ignore" : "inherit";
        // Known as open here for as long as it runs: the next run from this machine leaves it alone.
        mkdirSync(localRuns(), { recursive: true, mode: 0o700 });
        writeFileSync(join(localRuns(), run), String(process.pid), { mode: 0o600 });
        const closed = () => rmSync(join(localRuns(), run), { force: true });
        process.on("exit", closed);
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
