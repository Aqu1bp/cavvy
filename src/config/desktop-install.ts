// What desktop:install last put in Applications (scripts/install-desktop.ts), so desktop:update and the app
// itself (src/server/app-update.ts) can tell whether main has moved past it.

import { dlopen, FFIType } from "bun:ffi";
import { spawn } from "child_process";
import { closeSync, existsSync, ftruncateSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { basename, dirname, join } from "path";
import { harnessHome } from "./paths";

export interface InstallRecord {
    /** The commit it was built from. */
    commit: string;
    /** Built with uncommitted changes: not quite that commit. */
    dirty: boolean;
    /** The checkout or worktree it was built in. */
    source: string;
    /** Where it was installed: /Applications or ~/Applications. Missing from records older than it. */
    app?: string;
    installedAt: string;
}

export const installRecordPath = () => join(harnessHome(), "desktop-install.json");
/** The worktree desktop:update builds main in: it only ever has main checked out. */
export const appSourceDir = () => join(harnessHome(), "app-source");

export async function readInstallRecord(): Promise<InstallRecord | undefined> {
    try {
        const r = (await Bun.file(installRecordPath()).json()) as Partial<InstallRecord>;
        return typeof r.commit === "string" ? (r as InstallRecord) : undefined;
    } catch {
        return undefined;
    }
}

/** Records the build `root` just installed at `app`. Best effort: without it, desktop:update just rebuilds. */
export function writeInstallRecord(root: string, app: string) {
    const git = (...args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "ignore" });
    const head = git("rev-parse", "HEAD");
    if (head.exitCode !== 0) return;
    const record: InstallRecord = {
        commit: head.stdout.toString().trim(),
        dirty: git("status", "--porcelain", "--untracked-files=no").stdout.toString().trim() !== "",
        source: root,
        app,
        installedAt: new Date().toISOString(),
    };
    try {
        mkdirSync(harnessHome(), { recursive: true });
        writeFileSync(installRecordPath(), JSON.stringify(record, null, 2) + "\n");
    } catch {}
}

/**
 * Puts the bundle at `built` in place of `dest` without a moment where a stopped install leaves a broken app: it's
 * copied beside it first (under a hidden name, not a .app macOS would register), then swapped in by renames. A copy
 * stopped part way (a stalled update, stopped) leaves the installed app as it was; a swap stopped between its two
 * renames is put back on the next install. `copy` makes the copy (ditto on macOS).
 */
export function replaceBundle(built: string, dest: string, copy: (from: string, to: string) => void) {
    const dir = dirname(dest);
    const staging = join(dir, `.${basename(dest)}.partial`);
    const old = join(dir, `.${basename(dest)}.old`);
    // What an install stopped before left: the old copy back if it never got its replacement, else gone.
    if (!existsSync(dest) && existsSync(old)) renameSync(old, dest);
    rmSync(old, { recursive: true, force: true });
    rmSync(staging, { recursive: true, force: true });
    copy(built, staging);
    if (existsSync(dest)) renameSync(dest, old);
    try {
        renameSync(staging, dest);
    } catch (e) {
        // The installed app back at once, rather than none until the next install.
        if (!existsSync(dest) && existsSync(old)) renameSync(old, dest);
        throw e;
    }
    rmSync(old, { recursive: true, force: true });
}

/**
 * For git where no one is there to answer (the app's checks, and the update it starts): it fails rather than ask, in
 * a terminal, an askpass dialog or Git Credential Manager's. Plain ssh is told the same, and not to wait long to
 * connect. An ssh command of the user's own (GIT_SSH_COMMAND, GIT_SSH, or `sshCommand`, the checkout's
 * core.sshCommand) is left as it is, as it may need its own options; with no terminal and no askpass it can't ask either.
 */
export function noPromptGit(env: NodeJS.ProcessEnv, sshCommand?: string): Record<string, string> {
    const own = env.GIT_SSH_COMMAND || env.GIT_SSH || sshCommand;
    return {
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "",
        SSH_ASKPASS: "",
        SSH_ASKPASS_REQUIRE: "never",
        GCM_INTERACTIVE: "never",
        ...(own ? {} : { GIT_SSH_COMMAND: "ssh -o BatchMode=yes -o ConnectTimeout=15" }),
    };
}

/** The longest an update started from the app may run: capUpdate stops it then. */
export const UPDATE_CAP_MS = 2 * 3600_000;
/** The update lock's file. The lock is the kernel's (flock), held by the update running; the file names its pid. */
export const updateLockPath = () => join(harnessHome(), "app-update.lock");

const LOCK_EX = 2;
const LOCK_NB = 4;
let flockCall: ((fd: number, op: number) => number) | null | undefined;

/**
 * flock(2), from the C library: a lock the kernel lets go of once every process holding it has ended, however it
 * ended (a crash, a kill), so there's never a stale one to take over. Undefined where it can't be called.
 */
function flock(fd: number, op: number): boolean | undefined {
    if (flockCall === undefined) {
        try {
            const lib = dlopen(process.platform === "darwin" ? "libSystem.B.dylib" : "libc.so.6", { flock: { args: [FFIType.i32, FFIType.i32], returns: FFIType.i32 } });
            flockCall = (f, o) => lib.symbols.flock(f, o) as number;
        } catch {
            flockCall = null;
        }
    }
    return flockCall ? flockCall(fd, op) === 0 : undefined;
}

/**
 * Takes the update lock for as long as this process lives (and whoever it hands `fd` to: its watchdog, capUpdate), or
 * says that an update holds it, with that one's pid: two at once would check out and build in the same worktree, and
 * swap in the same app. Where the lock can't be taken at all, the update goes ahead unguarded, as before there was one.
 */
export function lockUpdate(): { fd: number } | { holder: number | undefined } {
    const path = updateLockPath();
    mkdirSync(dirname(path), { recursive: true });
    const fd = openSync(path, "a+");
    if (flock(fd, LOCK_EX | LOCK_NB) === false) {
        closeSync(fd);
        return { holder: lockHolder() };
    }
    ftruncateSync(fd, 0);
    writeSync(fd, `${process.pid}\n`);
    return { fd };
}

/** The update running now, if one is (it holds the lock), with its pid if it said. */
export function runningUpdate(): { pid: number | undefined } | undefined {
    let fd: number;
    try {
        fd = openSync(updateLockPath(), "r");
    } catch {
        return undefined;
    }
    try {
        // Taken, it was free: closing lets go of it again.
        return flock(fd, LOCK_EX | LOCK_NB) === false ? { pid: lockHolder() } : undefined;
    } finally {
        closeSync(fd);
    }
}

function lockHolder(): number | undefined {
    try {
        const pid = Number(readFileSync(updateLockPath(), "utf8").trim());
        return Number.isInteger(pid) && pid > 0 ? pid : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Watches the update `pid` leads: once it has run `seconds`, it and everything it started (its process group) are
 * stopped, as from the app nothing else would stop a step that hangs once the app has quit; and when it ends, any step
 * it left running (it crashed, or was stopped alone) goes too. The watcher is a shell in that same group, which the app
 * quitting leaves alone as it does the update, and which keeps the group's id from going to another program until
 * it's done. Given the update lock's `lockFd`, it holds the lock until then.
 */
export function capUpdate(pid: number, seconds: number, everySeconds = 5, lockFd?: number) {
    const script = `i=0
        while kill -0 "$1" 2>/dev/null; do
            if [ "$i" -ge "$2" ]; then kill -KILL -"$1" 2>/dev/null || kill -KILL "$1"; exit 0; fi
            sleep "$3"; i=$((i + $3))
        done
        kill -KILL -"$1" 2>/dev/null
        exit 0`;
    spawn("/bin/sh", ["-c", script, "sh", String(pid), String(Math.ceil(seconds)), String(everySeconds)], { stdio: lockFd === undefined ? "ignore" : ["ignore", "ignore", "ignore", lockFd] }).unref();
}
