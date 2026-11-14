// What ServerKey, ServerAdd and ServerRemove (src/tools/server-tools.ts) do
// on this machine: Cavvy's own connection and Cavvy's own processes, which
// reach the user's SSH setup and their provider's sign-in where an agent's
// shell may not. The same code behind the desktop app's Add server… does the
// adding (ServerLinks), so a server an agent adds shows up like any other.

import { homedir } from "os";
import { signedOutIn, signInRecipes } from "../agent/sign-in-recipes";
import type { Settings } from "../config/settings";
import { teardownCommandError, type ServerSetup } from "../tools/server-tools";
import { childEnv } from "../util/env";
import { redact } from "../util/redact";
import { expectHostKey, forgetScript, forgetServerKey, freshKey, knownHostLines, madeKey, makeServerKey, serverKeysDir, setKnownHostLines } from "./keys";
import type { ServerLinks } from "./manager";
import { hostOf, ssh, SshError } from "./ssh";
import { getServer, listServers, saveServer, ServerError, type ServerEntry } from "./store";

/** How long a machine just created gets to start and run its start-up script, and how often it's tried. */
export const setupTiming = {
    readyMs: 6 * 60_000,
    /** For what the start-up script installs after the sign-in works (git, the CLIs). */
    settledMs: 8 * 60_000,
    everyMs: 5000,
    /** One teardown command. */
    teardownMs: 10 * 60_000,
};

const wait = (ms: number, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
        const t = setTimeout(done, ms);
        function done() {
            clearTimeout(t);
            signal.removeEventListener("abort", done);
            resolve();
        }
        signal.addEventListener("abort", done, { once: true });
    });

/**
 * Waits until the new machine lets Cavvy in with the key made for it, showing the identity made for it. Until its
 * start-up script has run it refuses the key, or shows the identity its image came with: both mean "not yet".
 */
async function ready(e: ServerEntry, signal: AbortSignal, progress: (text: string) => void) {
    const until = Date.now() + setupTiming.readyMs;
    let last = "";
    progress(`Waiting for ${e.name} to start…`);
    for (;;) {
        if (signal.aborted) throw new ServerError("Stopped.");
        try {
            await ssh(e, "true", { timeoutMs: 30_000, signal });
            return;
        } catch (err) {
            if (signal.aborted) throw new ServerError("Stopped.");
            // What waiting can't fix: no ssh here, or a key of ours that can't be used.
            if (err instanceof SshError && ["no-ssh", "identity", "passphrase"].includes(err.kind)) throw err;
            last = err instanceof Error ? err.message : String(err);
        }
        if (Date.now() > until) throw new ServerError(`${e.name} didn't let Cavvy in within ${Math.round(setupTiming.readyMs / 60_000)} minutes (${last}). Check that it's running, that port 22 is open to this machine, that the address and the login user are right, and that the start-up script was passed as its user data.`);
        await wait(setupTiming.everyMs, signal);
    }
}

/** Waits, for a while, for the start-up script to finish installing what agents use. Not finishing isn't a failure: Cavvy says what's missing. */
async function settled(e: ServerEntry, signal: AbortSignal, progress: (text: string) => void) {
    const until = Date.now() + setupTiming.settledMs;
    progress(`Installing git, GitHub's CLI, Claude Code and Codex on ${e.name}…`);
    while (!signal.aborted && Date.now() < until) {
        const done = await ssh(e, "test -e /var/lib/cavvy-setup-done", { timeoutMs: 30_000, signal }).then((r) => r.code === 0, () => false);
        if (done) return;
        await wait(setupTiming.everyMs, signal);
    }
}

/** Runs one teardown command: Cavvy's own process, with arguments only. `missing`: its CLI isn't installed here. */
async function runTeardown(argv: string[], signal: AbortSignal): Promise<{ code: number; out: string; missing?: boolean }> {
    const bin = Bun.which(argv[0]!, { PATH: process.env.PATH ?? "" });
    if (!bin) return { code: 127, out: "", missing: true };
    const proc = Bun.spawn([bin, ...argv.slice(1)], { cwd: homedir(), env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    const timer = setTimeout(kill, setupTiming.teardownMs);
    signal.addEventListener("abort", kill, { once: true });
    try {
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { code, out: out + err };
    } finally {
        clearTimeout(timer);
        signal.removeEventListener("abort", kill);
    }
}

const tail = (text: string) => redact(text).trim().split("\n").slice(-6).join("\n").slice(-600);

export function serverSetup(o: { links(): Promise<ServerLinks>; settings(): Settings }): ServerSetup {
    return {
        async get(name) {
            const s = getServer(name);
            return s && { destination: s.destination, ...(s.cloud ? { cloud: s.cloud } : {}) };
        },
        names: async () => listServers().map((s) => s.name),
        async makeKey(name) {
            if (getServer(name)) throw new ServerError(`There's already a server named ${name}.`);
            return { userDataFile: (await makeServerKey(name)).userDataFile };
        },
        hasKey: async (name) => freshKey(name) && !getServer(name),
        async add(spec, { signal, progress, trust }) {
            const links = await o.links();
            const key = getServer(spec.name) ? undefined : madeKey(spec.name);
            // Just created: it's still starting. (A key from before, for one forgotten and now put back, signs in at once.)
            const fresh = Boolean(key) && freshKey(spec.name);
            let draft: { name: string; destination: string; port?: number; identityFile?: string; knownHostsFile?: string; cloud?: ServerEntry["cloud"] } = { name: spec.name, destination: spec.address, port: spec.port, cloud: spec.cloud };
            const host = spec.address.slice(spec.address.lastIndexOf("@") + 1);
            // What Cavvy's list said that address shows, to put back if this doesn't work out.
            const had = key ? knownHostLines(host, spec.port) : [];
            let r: Awaited<ReturnType<ServerLinks["add"]>>;
            try {
                if (key) {
                    // The address is the agent's word: one that's another server's would have that server refused as changed.
                    const taken = listServers().find((s) => s.name !== spec.name && hostOf(s) === host && (s.port ?? 22) === (spec.port ?? 22));
                    if (taken) throw new ServerError(`${host} is the address of ${taken.name}, one of the user's servers already.`);
                    // The identity made for it is the only one this address may show: no question to ask.
                    draft = { ...draft, identityFile: key.identityFile, knownHostsFile: expectHostKey(spec.name, host, spec.port) };
                    if (fresh) await ready({ ...draft, addedAt: "" } as ServerEntry, signal, progress);
                }
                r = await links.add(draft, undefined, progress);
                if (r.status === "unknown-host") {
                    if (!(await trust(r.unknown.host, r.unknown.fingerprints))) throw new ServerError(`The user didn't trust ${r.unknown.host}'s key.`);
                    r = await links.add(draft, links.trust(spec.name, r.unknown.fingerprints), progress);
                }
                if (r.status === "unknown-host") throw new ServerError(`${r.unknown.host} showed another key than the one the user trusted.`);
                if (r.status === "failed") throw new ServerError([r.problem.message, r.problem.detail, r.problem.fix].filter(Boolean).join(" "));
            } catch (e) {
                if (draft.knownHostsFile) setKnownHostLines(host, spec.port, had);
                throw e;
            }
            // The start-up script did its part: it holds a private key, so it goes.
            forgetScript(spec.name);
            const entry = getServer(spec.name)!;
            if (fresh) await settled(entry, signal, progress);
            const lacks: string[] = [];
            try {
                const c = await links.check(spec.name);
                for (const cli of c.clis) if (!cli.installed && ["claude-code", "codex"].includes(cli.id)) lacks.push(`${cli.product} (${cli.install})`);
                if (!c.git) lacks.push("git");
                if (!c.gh.installed) lacks.push("the GitHub CLI (gh), for pull requests");
                if (c.lingerFix) lacks.push(`Cavvy there won't come back after a reboot until an administrator runs \`${c.lingerFix}\``);
            } catch {
                // It's added; what it lacks is found out when it's next looked at.
            }
            return { ...(r.note ? { note: r.note } : {}), lacks };
        },
        async copy(name) {
            return (await (await o.links()).copy(name)).took;
        },
        async remove(name, { signal, progress, signIn }) {
            const entry = getServer(name);
            if (!entry) throw new ServerError(`No server is called ${name}.`);
            const recipes = signInRecipes(o.settings().signIns);
            const left = [...(entry.cloud?.teardown ?? [])];
            // As when they were recorded: what's run is still only what may be.
            for (const argv of left) {
                const no = teardownCommandError(argv, o.settings().signIns);
                if (no) throw new ServerError(`${no} Nothing was deleted.`);
            }
            while (left.length) {
                const argv = left[0]!;
                progress(argv.join(" "));
                let r = await runTeardown(argv, signal);
                if (r.missing) throw new ServerError(`\`${argv[0]}\` isn't installed on this machine, so \`${argv.join(" ")}\` didn't run. Nothing was deleted by it.`);
                // Its CLI is signed out: the user is asked, and the same command goes again.
                const out = r.code !== 0 && !signal.aborted ? signedOutIn(r.out, recipes, argv[0]!) : undefined;
                if (out) {
                    if (!(await signIn(out.id))) throw new ServerError(`${out.name} isn't signed in on this machine, so \`${argv.join(" ")}\` didn't run. Call ServerRemove again once it is.`);
                    r = await runTeardown(argv, signal);
                }
                if (r.code === 0) {
                    // Done for good, whatever happens next (an interruption too): a later try starts after it, not at a resource that's no longer there.
                    left.shift();
                    const { teardown: _, ...rest } = entry.cloud!;
                    saveServer({ ...entry, cloud: left.length ? { ...rest, teardown: left } : rest });
                }
                if (signal.aborted) throw new ServerError("Stopped part way: check what's left with the provider's CLI.");
                if (r.code !== 0) throw new ServerError(`\`${argv.join(" ")}\` failed:\n${tail(r.out) || `exit ${r.code}`}\nIf what it deletes is already gone, tell the user: they can forget ${name} in Servers, which deletes nothing.`);
            }
            await (await o.links()).remove(name);
            // The machine is gone, so its keys are of no use. (One that's only forgotten keeps them: it can be put back.)
            if (entry.cloud?.teardown?.length && entry.identityFile?.startsWith(serverKeysDir())) forgetServerKey(name, hostOf(entry), entry.port);
        },
    };
}
