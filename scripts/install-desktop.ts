// Builds the desktop app from this checkout (whichever branch or worktree
// it's on) and installs it in place of the copy you have, to try a change
// in the app itself. macOS only.
//
//   bun run desktop:install                 build, quit Cavvy, install, open it
//   bun run desktop:install --no-restart    install only; a running Cavvy carries on
//
// It goes to /Applications, or ~/Applications if that isn't writable. The app
// is Electron's (desktop-electron/pack.ts builds it): the GUI, and the server
// compiled to one executable beside it.
//
// It's signed with your Apple Development (or Developer ID) certificate when
// you have one, so each build is the same app to macOS and keeps the keychain
// access you allowed: Cavvy reads your API keys from there. Unsigned (ad hoc)
// builds are a new app every time, and macOS asks again. With more than one
// certificate it keeps to the one the installed copy has; to pick another,
// set CAVVY_SIGNING_IDENTITY to its name or SHA-1 (security find-identity -v -p codesigning).

import { spawn } from "child_process";
import { accessSync, constants, existsSync } from "fs";
import { homedir, userInfo } from "os";
import { join, resolve } from "path";
import { replaceBundle, writeInstallRecord } from "../src/config/desktop-install";
import { appInfo } from "../desktop-electron/app-info";

if (process.platform !== "darwin") {
    console.error("desktop:install is for macOS. Elsewhere, bun run desktop:build makes the installers.");
    process.exit(1);
}

const restart = !process.argv.includes("--no-restart");
const root = resolve(import.meta.dir, "..");
const { productName, identifier } = appInfo(join(root, "desktop-electron"));
const env = { ...process.env };

function run(cmd: string[], cwd: string) {
    const r = Bun.spawnSync(cmd, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}

/** Its output, or its error and exit if it fails. */
function output(cmd: string[]): string {
    const r = Bun.spawnSync(cmd, { env, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) {
        console.error(r.stderr.toString().trim() || `${cmd[0]} failed`);
        process.exit(r.exitCode ?? 1);
    }
    return r.stdout.toString() + r.stderr.toString();
}

run(["bun", "install"], root);
run(["bun", "install"], join(root, "gui"));
run(["bun", "install"], join(root, "desktop-electron"));
// Imported once its dependencies are installed (above).
const { pack } = await import("../desktop-electron/pack.ts");
let built: string;
try {
    built = await pack();
} catch (e) {
    console.error(`Building the app failed: ${(e as Error).message}`);
    process.exit(1);
}

function writable(dir: string): boolean {
    try {
        accessSync(dir, constants.W_OK);
        return true;
    } catch {
        return false;
    }
}
const dest = join(writable("/Applications") ? "/Applications" : join(homedir(), "Applications"), `${productName}.app`);

interface Identity {
    hash: string;
    name: string;
}

/** Who signed the installed copy's server (the part that reads the keychain). */
function signedBy(app: string): string | undefined {
    const server = join(app, "Contents", "MacOS", "cavvy");
    if (!existsSync(server)) return undefined;
    const r = Bun.spawnSync(["codesign", "-dvv", server], { stdout: "pipe", stderr: "pipe" });
    return r.stderr.toString().match(/^Authority=(.+)$/m)?.[1];
}

/** A certificate Apple issued, so the keychain's trust carries over to the next build; none means ad hoc. */
function signingIdentity(): Identity | undefined {
    const valid = output(["security", "find-identity", "-v", "-p", "codesigning"])
        .split("\n")
        .flatMap((l) => {
            // Revoked and expired ones are listed too, flagged CSSMERR_….
            const m = l.match(/^\s*\d+\)\s+([0-9A-F]{40})\s+"([^"]+)"(.*)$/);
            return m && !m[3]!.includes("CSSMERR") ? [{ hash: m[1]!, name: m[2]! }] : [];
        });
    const want = process.env.CAVVY_SIGNING_IDENTITY?.trim();
    if (want) {
        const id = valid.find((i) => i.hash === want.toUpperCase() || i.name === want);
        if (!id) {
            console.error(`CAVVY_SIGNING_IDENTITY is "${want}", but there's no valid signing certificate by that name or SHA-1. security find-identity -v -p codesigning lists them.`);
            process.exit(1);
        }
        return id;
    }
    const apple = valid.filter((i) => /^(Apple Development|Mac Developer|Developer ID Application): /.test(i.name));
    const before = signedBy(dest);
    return apple.find((i) => i.name === before) ?? apple[0];
}

// By SHA-1, as names can repeat (a revoked copy). Electron's helpers and frameworks first (--deep), then the server
// under an identifier of its own (the keychain knows it by that and the certificate), then the app around both again.
const id = signingIdentity();
if (id) {
    output(["codesign", "--force", "--deep", "--sign", id.hash, "--timestamp=none", built]);
    output(["codesign", "--force", "--sign", id.hash, "--identifier", `${identifier}.server`, "--timestamp=none", join(built, "Contents", "MacOS", "cavvy")]);
    output(["codesign", "--force", "--sign", id.hash, "--timestamp=none", built]);
    output(["codesign", "--verify", "--deep", "--strict", built]);
    console.log(`Signed with ${id.name}`);
} else {
    console.log("No Apple Development certificate, so this build is signed ad hoc: macOS asks again before it reads your keys from the keychain. Xcode → Settings → Accounts makes one.");
}

/** Your running copies, wherever they were opened from: the app, and the server each started. (Not another account's.) */
function running(): { app: number[]; server: number[] } {
    const find = (pattern: string) =>
        Bun.spawnSync(["pgrep", "-U", String(userInfo().uid), "-f", pattern])
            .stdout.toString()
            .split("\n")
            .filter(Boolean)
            .map(Number);
    // Harness.app too: the app before the rename (src/config/legacy.ts) uses the same home folder.
    return {
        app: [...find(`/${productName}.app/Contents/MacOS/cavvy-desktop`), ...find("/Harness.app/Contents/MacOS/harness-desktop")],
        server: [...find(`/${productName}.app/Contents/MacOS/cavvy serve`), ...find("/Harness.app/Contents/MacOS/harness serve")],
    };
}

/** Sends sig to pid; false if it's gone (or isn't yours). */
function signal(pid: number, sig: NodeJS.Signals | 0): boolean {
    try {
        process.kill(pid, sig);
        return true;
    } catch {
        return false;
    }
}
const alive = (pid: number) => signal(pid, 0);

if (restart) {
    const { app, server } = running();
    if (app.length) {
        console.log(`Quitting ${productName} (anything running in it stops; sessions are saved)…`);
        // Its server closes the sessions when the app goes (SessionEnd hooks run, session locks are released), then exits.
        // It's the app that's stopped: it would start a new server in place of one stopped on its own.
        for (const pid of app) signal(pid, "SIGTERM");
        const all = [...app, ...server];
        const until = Date.now() + 15_000;
        while (all.some(alive) && Date.now() < until) await Bun.sleep(100);
        const stuck = all.filter(alive);
        if (stuck.length) {
            console.warn(`${productName} didn't quit within 15 seconds; stopping it.`);
            for (const pid of stuck) signal(pid, "SIGKILL");
        }
    }
}

// Copied beside the installed app, then swapped in: an install stopped part way leaves the app as it was.
replaceBundle(built, dest, (from, to) => run(["ditto", from, to], root));
console.log(`Installed ${dest}`);
writeInstallRecord(root, dest);
// Harness.app's updater (from before the rename; it sets HARNESS_HOME, this one's sets CAVVY_HOME) installs with
// --no-restart, then quits the app by the new name, which Harness.app doesn't have, and opens the new one: Harness.app
// would keep running beside it. So it's quit here: from a process of its own (this one may be in Harness's terminal,
// which goes with it), which opens the new app once Harness is gone. This returns to the updater only then, so the
// new app its updater opens doesn't start beside Harness either. -a: Harness.app may be what started this (its
// Update button), and pgrep and pkill leave out their ancestors otherwise. The script builds the pattern from "Harness"
// rather than being given it, so it doesn't match itself.
const harnessPids = () =>
    Bun.spawnSync(["pgrep", "-a", "-U", String(userInfo().uid), "-f", "/Harness.app/Contents/MacOS/harness"])
        .stdout.toString()
        .split("\n")
        .filter(Boolean)
        .map(Number);
// Only when that updater means to restart: given --no-restart itself (it passes it on either way), Harness carries on.
const updaterArgs = () => Bun.spawnSync(["ps", "-o", "args=", "-p", String(process.ppid)]).stdout.toString();
const harness = !restart && process.env.HARNESS_HOME !== undefined && process.env.CAVVY_HOME === undefined && !/\s--no-restart(\s|$)/.test(updaterArgs()) ? harnessPids() : [];
if (harness.length) {
    const script = `
        pkill -a -TERM -U "$1" -f "/$2.app/Contents/MacOS/harness-desktop"
        i=0
        while pgrep -a -U "$1" -f "/$2.app/Contents/MacOS/harness" >/dev/null && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done
        pkill -a -KILL -U "$1" -f "/$2.app/Contents/MacOS/harness"
        open "$3"`;
    spawn("/bin/sh", ["-c", script, "sh", String(userInfo().uid), "Harness", dest], { detached: true, stdio: "ignore" }).unref();
    console.log(`Quitting Harness (sessions are saved): ${productName} replaces it, and opens once it has quit.`);
    const until = Date.now() + 17_000;
    while (harness.some(alive) && Date.now() < until) await Bun.sleep(100);
} else if (restart) run(["open", dest], root);
else if (running().app.length) console.log(`${productName} is still running the build before this one: quit it and open it again to use this one.`);
for (const old of ["/Applications/Harness.app", join(homedir(), "Applications", "Harness.app")]) {
    if (existsSync(old)) console.log(`${old} is the app from before the rename to ${productName}. Once ${productName} works, delete it.`);
}
