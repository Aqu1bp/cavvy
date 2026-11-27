// The desktop app's own updates from main: whether origin/main has moved past
// the installed build (the record scripts/install-desktop.ts leaves), and
// running scripts/update-desktop.ts from the app, detached, so it carries on
// when the app quits to restart. Only the installed app (the .app bundle
// desktop:install put there) can update itself; anywhere else it says why not.
//
// A downloaded app (a release build: Contents/Resources/release.json, and no install record naming it) updates to
// Cavvy's latest release instead, through release-update.ts's checks, in the same states and the same UI.

import { spawn, type ChildProcess } from "child_process";
import { appendFileSync, unlinkSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, realpathSync, rmSync, statSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";
import { appSourceDir, noPromptGit, readInstallRecord, runningUpdate, type InstallRecord } from "../config/desktop-install";
import { cavvyHome, paths } from "../config/paths";
import { REPO_VARS } from "../util/git";
import type { AppUpdateChange, AppUpdateInfo } from "./protocol";
import {
    canReplace,
    checkTree,
    compareVersions,
    downloadZip,
    hardwareArch,
    latestRelease,
    MOVE_TO_APPLICATIONS,
    oldCopy,
    partialDir,
    readMarker,
    Refused,
    refusalText,
    releaseNotes,
    RELEASES,
    RESTART_HELPER,
    runningRequirements,
    scanZip,
    systemVersion,
    testReleaseSource,
    verifyApp,
    type Arch,
    type ReleaseMarker,
    type ReleaseSource,
    type Requirements,
    type Run,
} from "./release-update";

/** main moves several times a day: a fetch of one branch is cheap, so it's looked at often. */
const CHECK_EVERY_MS = 30 * 60_000;
const FIRST_CHECK_MS = 5_000;
/** A release is made every few days at most: a downloaded app looks every few hours. */
const RELEASE_CHECK_EVERY_MS = 6 * 3600_000;
/**
 * How long a downloaded app's restart may take before it's taken as not happening: the helper waits as long for the
 * app to quit (a "Quit without saving?" may be open).
 */
const RELEASE_RESTART_WAIT_MS = 11 * 60_000;
/** How long the new version has to open before the helper puts the old one back. */
const NEW_APP_OPENS_S = 120;
const UNSIGNED_COPY = "This copy of Cavvy isn't signed, so it can't update itself.";

/** Asks the desktop app to quit, for the helper to put the update in place (cli.ts, under the desktop app). */
let quitForUpdate: (() => void) | undefined;
const cancelled = new Set<() => void>();

/** Under the desktop app: how to ask it to quit for an update. */
export function setQuitForUpdate(fn: (() => void) | undefined) {
    quitForUpdate = fn;
}

/** The desktop app's quit for an update was cancelled ("Quit without saving?" → Cancel): nothing is applied. */
export function updateQuitCancelled() {
    for (const fn of cancelled) fn();
}

/** What an update about to be put in place left for the new version's server to settle (release-update.ts's helper). */
interface Pending {
    version: string;
    previous: string;
    app: string;
    old: string;
}
const pendingPath = () => join(cavvyHome(), "app-update-pending.json");
/** What the helper says when it gave up and reopened the old app. */
const notePath = () => join(cavvyHome(), "app-update-note.json");
/** How long a finished update may take to restart the app before it says so. */
const RESTART_WAIT_MS = 90_000;
/**
 * How long an update may print nothing, while the Mac is awake, before it's taken as stuck (a fetch, an install, a
 * build that hangs) and stopped: well past any quiet step that works (a release link, signing).
 */
const STALL_MS = 30 * 60_000;
/** The most one tick of the progress check counts as quiet: a longer gap is the Mac asleep, when nothing can run. */
const TICK_CAP_MS = 5_000;
const SHOWN = 20;

/** bun on PATH, else where its installer or Homebrew puts it: an app opened from the Dock may have only the system's PATH. */
function findBun(): string | undefined {
    return Bun.which("bun", { PATH: process.env.PATH }) ?? [join(homedir(), ".bun", "bin", "bun"), "/opt/homebrew/bin/bun", "/usr/local/bin/bun"].find((p) => existsSync(p));
}

/** The .app bundle a program runs from (…/Cavvy.app/Contents/MacOS/cavvy), if it does. */
export function bundleOf(execPath: string): string | undefined {
    return /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1];
}

export interface AppUpdatesOptions {
    emit: (info: AppUpdateInfo) => void;
    /** The running app's bundle: by default CAVVY_APP_BUNDLE (gui:demo --update), else the one this program runs from. */
    bundle?: string;
    platform?: NodeJS.Platform;
    /** bun, to run the update with: by default from PATH, or ~/.bun/bin. */
    bun?: string;
    everyMs?: number;
    firstCheckMs?: number;
    restartWaitMs?: number;
    stallMs?: number;
    /** Tests only: their stand-in for Cavvy's releases (else CAVVY_UPDATE_TEST_*, else the real ones), how programs run. */
    releases?: ReleaseSource;
    run?: Run;
    /** Tests only: what the helper is told the app's pid is. */
    appPid?: number;
}

/** A downloaded app, as it's running: where, which release, what it's signed with. */
interface ReleaseApp {
    bundle: string;
    marker: ReleaseMarker;
    /** Undefined when it's signed ad hoc or not at all: then it doesn't update. */
    req?: Requirements;
    arch: Arch;
    system?: string;
}

const real = (p: string) => {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
};

const isDir = (p: string) => {
    try {
        return statSync(p).isDirectory();
    } catch {
        return false;
    }
};

const lastLine = (s: string) => s.trim().split("\n").at(-1)?.trim() ?? "";

/**
 * Runs it and collects its output. Past `timeoutMs`, or on `signal`, its whole process group is killed (ssh, a remote
 * helper, whatever git started) and it answers at once, even if something still holds its output open.
 */
export function capture(cmd: string[], cwd: string, timeoutMs: number, env: NodeJS.ProcessEnv = process.env, signal?: AbortSignal): Promise<{ ok: boolean; out: string; err: string; timedOut?: boolean }> {
    return new Promise((resolve) => {
        let out = "";
        let err = "";
        let timer: ReturnType<typeof setTimeout> | undefined;
        let settled = false;
        const finish = (r: { ok: boolean; out: string; err: string; timedOut?: boolean }) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener("abort", stopped);
            resolve(r);
        };
        const stopped = () => {
            kill();
            finish({ ok: false, out: out.trimEnd(), err: `${cmd.slice(0, 2).join(" ")} was stopped` });
        };
        if (signal?.aborted) return finish({ ok: false, out: "", err: `${cmd.slice(0, 2).join(" ")} was stopped` });
        let p: ChildProcess;
        try {
            // Its own process group, so the timeout can end everything it started.
            p = spawn(cmd[0]!, cmd.slice(1), { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
        } catch (e) {
            return finish({ ok: false, out: "", err: (e as Error).message });
        }
        const kill = () => {
            try {
                process.kill(-p.pid!, "SIGKILL");
            } catch {
                p.kill("SIGKILL");
            }
        };
        timer = setTimeout(() => {
            kill();
            finish({ ok: false, out: out.trimEnd(), err: `${cmd.slice(0, 2).join(" ")} took longer than ${Math.round(timeoutMs / 1000)}s`, timedOut: true });
        }, timeoutMs);
        signal?.addEventListener("abort", stopped, { once: true });
        // The handlers first: a spawn that fails (out of file descriptors) can leave the streams missing.
        p.once("error", (e) => finish({ ok: false, out: "", err: e.message }));
        p.once("close", (code) => finish({ ok: code === 0, out: out.trimEnd(), err: err.trim() || (code === 0 ? "" : `exit code ${code}`) }));
        p.stdout?.on("data", (d) => (out += d));
        p.stderr?.on("data", (d) => (err += d));
    });
}

/**
 * This environment, for git and the update in `cwd`'s repository: not one an inherited GIT_DIR (and the like) names,
 * nor a GIT_CONFIG that would hide its settings from `git config` (core.sshCommand) but not from the fetch.
 */
function repoEnv(extra: Record<string, string>): NodeJS.ProcessEnv {
    const env = { ...process.env, ...extra };
    for (const key of [...REPO_VARS, "GIT_CONFIG"]) delete env[key];
    return env;
}

/** Never asks for a password or passphrase: there's no one at a terminal to answer. `sshCommand`: the repository's own. */
function git(cwd: string, args: string[], o: { timeoutMs?: number; sshCommand?: string; signal?: AbortSignal } = {}) {
    return capture(["git", ...args], cwd, o.timeoutMs ?? 30_000, repoEnv(noPromptGit(process.env, o.sshCommand)), o.signal);
}

/** The repository a checkout or worktree belongs to: its common git directory. */
async function repositoryOf(dir: string, signal?: AbortSignal): Promise<string | undefined> {
    const r = await git(dir, ["rev-parse", "--git-common-dir"], { signal });
    return r.ok ? real(resolve(dir, r.out)) : undefined;
}

/** The last line a log has, of its last few KB: cargo's "Compiling …", bun's, the script's own. Escapes and \r redraws dropped. */
export function lastLogLine(file: string): string {
    let fd: number | undefined;
    try {
        fd = openSync(file, "r");
        const size = statSync(file).size;
        const len = Math.min(size, 4096);
        const buf = Buffer.alloc(len);
        readSync(fd, buf, 0, len, size - len);
        const text = buf.toString("utf8").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "");
        const lines = text.split("\n").map((l) => (l.split("\r").filter((x) => x.trim()).at(-1) ?? "").trim()).filter(Boolean);
        return lines.at(-1) ?? "";
    } catch {
        return "";
    } finally {
        if (fd !== undefined) closeSync(fd);
    }
}

export class AppUpdates {
    private info: AppUpdateInfo = { available: false, changes: [], behind: 0, checking: false };
    private timers: ReturnType<typeof setTimeout>[] = [];
    private checking?: Promise<AppUpdateInfo>;
    /** An update being started: reserved before anything is awaited, so two requests at once start one. */
    private starting?: Promise<AppUpdateInfo>;
    private child?: ChildProcess;
    private stopped = false;
    /** Ends a check's git when the server stops: its timeout goes with the server, and the git is in a group of its own. */
    private readonly ending = new AbortController();
    /** A downloaded app: what's known of it, worked out once. */
    private rel?: Promise<ReleaseApp>;
    /** The release downloaded and checked, unpacked beside the app: restarting puts it in place. */
    private ready?: { version: string; commit: string; app: string };
    /** The release the last failure was about: a check finding a newer one clears it. */
    private failedFor?: string;
    private helper?: ChildProcess;
    private restartTimer?: ReturnType<typeof setTimeout>;
    private readonly onCancelled = () => this.quitCancelled();

    constructor(private o: AppUpdatesOptions) {}

    private get releases(): ReleaseSource {
        return this.o.releases ?? testReleaseSource() ?? RELEASES;
    }

    private run: Run = (cmd, timeoutMs = 60_000) => (this.o.run ? this.o.run(cmd, timeoutMs) : capture(cmd, "/", timeoutMs, process.env, this.ending.signal));

    get(): AppUpdateInfo {
        return structuredClone(this.info);
    }

    /** Checks a little after the server starts, then every few hours: only for the installed app. */
    start() {
        void this.where().then(async (w) => {
            if (this.stopped) return;
            if ("release" in w) {
                const r = await this.releaseApp(w);
                if (this.stopped) return;
                cancelled.add(this.onCancelled);
                this.settle(r);
                const why = this.releaseUnavailable(r);
                this.info = { ...this.info, release: true, installed: r.marker.version, ...(why ? { unavailable: why } : {}) };
                // Nothing to look for: it couldn't be put in place (moved, it starts again and looks then).
                if (why) return;
                this.every(setTimeout(() => void this.check({ quiet: true }), this.o.firstCheckMs ?? FIRST_CHECK_MS));
                this.every(setInterval(() => void this.check({ quiet: true }), this.o.everyMs ?? RELEASE_CHECK_EVERY_MS));
                return;
            }
            // Said when asked (app.update.get), not sent: most servers are never the installed app.
            if ("unavailable" in w) return void (this.info = { ...this.info, unavailable: w.unavailable });
            this.every(setTimeout(() => void this.check(), this.o.firstCheckMs ?? FIRST_CHECK_MS));
            this.every(setInterval(() => void this.check(), this.o.everyMs ?? CHECK_EVERY_MS));
        });
    }

    /** An update running carries on: it was asked for, and it reopens the app when it's done. */
    stop() {
        this.stopped = true;
        cancelled.delete(this.onCancelled);
        clearTimeout(this.restartTimer);
        for (const t of this.timers) clearTimeout(t);
        this.timers = [];
        this.ending.abort();
    }

    /**
     * Fetches main and compares it with the installed build. One at a time; none while an update runs. `maxAgeMs`: not
     * if the last check is newer than that (a window coming to the front asks, and so does every other window).
     */
    check(o: { maxAgeMs?: number; quiet?: boolean } = {}): Promise<AppUpdateInfo> {
        if (this.info.updating || this.starting) return Promise.resolve(this.get());
        const at = this.info.checkedAt;
        if (!this.checking && o.maxAgeMs !== undefined && at !== undefined && Date.now() - at < o.maxAgeMs) return Promise.resolve(this.get());
        // Asked for (Check now) unless it's the timer's or a window coming to the front: a downloaded app says only
        // then that it couldn't check.
        const quiet = o.quiet ?? (o.maxAgeMs ?? 0) > 0;
        this.checking ??= this.runCheck(quiet).finally(() => (this.checking = undefined));
        return this.checking;
    }

    /** Starts the update, detached, its output in logs/app-update.log; how it goes comes as events. One at a time. */
    update(): Promise<AppUpdateInfo> {
        if (this.info.updating) return Promise.resolve(this.get());
        this.starting ??= this.startUpdate().finally(() => (this.starting = undefined));
        return this.starting;
    }

    private async startUpdate(): Promise<AppUpdateInfo> {
        await this.checking;
        const w = await this.where();
        if ("release" in w) return this.startRelease(await this.releaseApp(w));
        if ("unavailable" in w) return this.replace({ unavailable: w.unavailable });
        const bun = this.o.bun ?? findBun();
        if (!bun) return this.patch({ failed: "Updating needs bun, and it isn't on your PATH (https://bun.sh)." });
        // The worktree desktop:update keeps has the script once it has run; before that, the checkout the app came from.
        // Only a worktree of that checkout's repository, though: another's would update to its own main.
        const signal = this.ending.signal;
        const kept = isDir(appSourceDir()) ? await repositoryOf(appSourceDir(), signal) : undefined;
        const ours = kept !== undefined && kept === (await repositoryOf(w.record.source, signal));
        const dir = [...(ours ? [appSourceDir()] : []), w.record.source].find((d) => existsSync(join(d, "scripts", "update-desktop.ts")));
        if (!dir) return this.patch({ failed: `${w.record.source} has no scripts/update-desktop.ts yet: pull main there, then update.` });
        // One started before Cavvy last opened (quit while it built) still runs: a second would build over it.
        const running = runningUpdate();
        if (running) return this.patch({ failed: `An update started earlier is still running${running.pid ? ` (process ${running.pid})` : ""}: Cavvy restarts when it's done.` });

        const log = join(paths.logs(), "app-update.log");
        const startedAt = Date.now();
        let child: ChildProcess;
        try {
            mkdirSync(dirname(log), { recursive: true });
            const fd = openSync(log, "w");
            try {
                child = spawn(bun, ["--no-env-file", `--config=${join(dir, "bunfig.toml")}`, join(dir, "scripts", "update-desktop.ts"), "--from-app"], {
                    cwd: dir,
                    // Its own session: the app quitting to restart doesn't take it along.
                    detached: true,
                    stdio: ["ignore", fd, fd],
                    // The scripts run `bun` by name: this one, even if the login shell's PATH couldn't be had.
                    env: repoEnv({ CAVVY_HOME: cavvyHome(), GIT_TERMINAL_PROMPT: "0", PATH: [dirname(bun), process.env.PATH].filter(Boolean).join(":") }),
                });
            } finally {
                closeSync(fd);
            }
        } catch (e) {
            return this.patch({ failed: `Couldn't start the update: ${(e as Error).message}` });
        }
        child.unref();
        this.child = child;
        // Its output moving on is progress; none for STALL_MS of awake time and it's stopped, all of it (its own
        // process group). The installer swaps the new app in only once it's fully copied (replaceBundle), so stopping
        // it never leaves a broken app.
        let size = 0;
        let quiet = 0;
        let tick = Date.now();
        let stalled: string | undefined;
        const stallMs = this.o.stallMs ?? STALL_MS;
        const progress = setInterval(() => {
            const at = Date.now();
            const gap = Math.min(at - tick, TICK_CAP_MS);
            tick = at;
            const now = statSync(log, { throwIfNoEntry: false })?.size ?? 0;
            if (now !== size) (size = now), (quiet = 0);
            else quiet += gap;
            if (!stalled && quiet > stallMs) {
                stalled = `The update stopped: it printed nothing for ${Math.round(stallMs / 60_000) || "under a"} minute${stallMs >= 120_000 ? "s" : ""}, after: ${lastLogLine(log) || "(nothing)"}`;
                try {
                    process.kill(-child.pid!, "SIGKILL");
                } catch {
                    child.kill("SIGKILL");
                }
            }
            const line = lastLogLine(log);
            if (line && this.info.updating && !this.info.updating.restarting && line !== this.info.updating.line) this.patch({ updating: { ...this.info.updating, line } });
        }, 1000);
        progress.unref?.();
        const done = (code: number, failure?: string) => {
            clearInterval(progress);
            failure ??= stalled;
            if (this.child !== child) return;
            this.child = undefined;
            void this.finished(code, startedAt, log, failure);
        };
        child.once("error", (e) => done(-1, `Couldn't start the update: ${e.message}`));
        child.once("exit", (code) => done(code ?? -1));
        return this.patch({ updating: { startedAt, line: "Starting…", restarting: false }, failed: undefined, log });
    }

    private async finished(code: number, startedAt: number, log: string, failure?: string) {
        if (code === 0) {
            const record = await readInstallRecord();
            if (record && Date.parse(record.installedAt) >= startedAt) {
                this.patch({ updating: { startedAt, line: "Installed. Restarting Cavvy…", restarting: true } });
                // This process ends with the restart; if it's still here a while later, the restart didn't happen.
                const t = setTimeout(() => this.patch({ updating: undefined, failed: "The new build is installed, but Cavvy didn't restart: quit it and open it again." }), this.o.restartWaitMs ?? RESTART_WAIT_MS);
                t.unref?.();
                return;
            }
            // Nothing was installed: main hadn't moved after all.
            this.patch({ updating: undefined });
            void this.check();
            return;
        }
        this.patch({ updating: undefined, failed: failure ?? `The update failed: ${lastLogLine(log) || `exit code ${code}`}` });
    }

    /** This install's record, and the checkout to ask about main; or why this copy can't update itself. */
    private async where(): Promise<{ record: InstallRecord } | { unavailable: string } | { release: ReleaseMarker; bundle: string }> {
        if ((this.o.platform ?? process.platform) !== "darwin") return { unavailable: "Updating from main is for the macOS desktop app." };
        const bundle = this.o.bundle ?? (process.env.CAVVY_APP_BUNDLE || bundleOf(process.execPath));
        if (!bundle) return { unavailable: "Only the installed desktop app updates itself." };
        const record = await readInstallRecord();
        // A release build, unless desktop:install put it here (then it's a checkout's, and updates from main).
        const marker = readMarker(bundle);
        if (marker && !(record?.app && real(record.app) === real(bundle))) return { release: marker, bundle };
        if (!record) return { unavailable: "Install it once with bun run desktop:install to get updates." };
        if (record.app && real(record.app) !== real(bundle)) return { unavailable: `This copy isn't the one last installed from a checkout (${record.app}).` };
        if (!isDir(record.source)) return { unavailable: `The checkout this app was built from is gone (${record.source}).` };
        return { record };
    }

    private async runCheck(quiet: boolean): Promise<AppUpdateInfo> {
        const w = await this.where();
        if ("release" in w) return this.runReleaseCheck(await this.releaseApp(w), quiet);
        if ("unavailable" in w) return this.replace({ unavailable: w.unavailable });
        const { record } = w;
        const repo = record.source;
        this.patch({ checking: true, unavailable: undefined });
        const signal = this.ending.signal;
        const ssh = await git(repo, ["config", "--get", "core.sshCommand"], { signal });
        // Into origin/main by name: a remote whose fetch refspec leaves main out would only fill FETCH_HEAD.
        const fetched = await git(repo, ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"], { timeoutMs: 60_000, sshCommand: (ssh.ok && ssh.out) || undefined, signal });
        const head = await git(repo, ["rev-parse", "--verify", "origin/main^{commit}"], { signal });
        if (!head.ok) return this.patch({ checking: false, checkedAt: Date.now(), error: fetched.ok ? "origin/main isn't a commit in that checkout." : `Couldn't fetch main: ${lastLine(fetched.err)}` });
        const target = head.out;
        // desktop:update's worktree only ever has main checked out, so a change there (bun install touching the lockfile) doesn't count.
        const current = record.commit === target && (!record.dirty || real(record.source) === real(appSourceDir()));
        let changes: AppUpdateChange[] = [];
        let behind = 0;
        let note: string | undefined;
        if (!current) {
            if (record.commit === target) note = "This build has uncommitted changes on top of main.";
            else if ((await git(repo, ["merge-base", "--is-ancestor", record.commit, target], { signal })).ok) {
                const range = `${record.commit}..${target}`;
                behind = Number((await git(repo, ["rev-list", "--count", "--no-merges", range], { signal })).out) || 0;
                changes = (await git(repo, ["log", "--no-merges", `-n${SHOWN}`, "--format=%h%x09%s", range], { signal })).out
                    .split("\n")
                    .filter(Boolean)
                    .map((l) => {
                        const [hash = "", ...subject] = l.split("\t");
                        return { hash, subject: subject.join("\t") };
                    });
            } else note = "This build is from a branch that isn't on main.";
        }
        return this.patch({
            checking: false,
            checkedAt: Date.now(),
            installed: record.commit.slice(0, 7),
            latest: target.slice(0, 7),
            available: !current,
            changes,
            behind,
            note,
            error: fetched.ok ? undefined : `Couldn't fetch main, so this is as of the last fetch: ${lastLine(fetched.err)}`,
        });
    }

    // -----------------------------------------------------------------------
    // A downloaded app: Cavvy's releases

    private releaseApp(w: { release: ReleaseMarker; bundle: string }): Promise<ReleaseApp> {
        this.rel ??= (async () => {
            const [req, arch, system] = await Promise.all([runningRequirements(w.bundle, this.run), hardwareArch(this.run), systemVersion(this.run)]);
            return { bundle: w.bundle, marker: w.release, req, arch, system };
        })();
        return this.rel;
    }

    private releaseUnavailable(r: ReleaseApp): string | undefined {
        if (!r.req) return UNSIGNED_COPY;
        if (!canReplace(r.bundle)) return MOVE_TO_APPLICATIONS;
        return undefined;
    }

    /**
     * At start: an update the helper just put in place is done (the old copy goes), or it gave up and says why; an
     * update unpacked but never put in place (Cavvy quit some other way) is cleared, as it's checked again anyway.
     */
    private settle(r: ReleaseApp) {
        const pending = readJson<Pending>(pendingPath());
        if (pending && real(pending.app) === real(r.bundle) && pending.version === r.marker.version) {
            // Removing the record says this version started; if the helper took it first (its time ran out), it's
            // putting the old one back, and the old copy stays. Only ever the copy beside this app: never a path a file names.
            let acked = false;
            try {
                unlinkSync(pendingPath());
                acked = true;
            } catch {}
            if (acked) rmSync(oldCopy(r.bundle), { recursive: true, force: true });
        }
        const note = readJson<{ reason?: string; version?: string }>(notePath());
        if (note) {
            rmSync(notePath(), { force: true });
            const reason = note.reason;
            if (reason === "didnt-open") this.info.failed = `Cavvy ${note.version} didn't open, so ${r.marker.version} was put back.`;
            else if (reason === "unsigned" || reason === "management" || reason === "install") this.info.failed = refusalText(reason);
            if (this.info.failed) this.failedFor = note.version;
        }
        if (!existsSync(pendingPath())) rmSync(partialDir(r.bundle), { recursive: true, force: true });
    }

    private async runReleaseCheck(r: ReleaseApp, quiet: boolean): Promise<AppUpdateInfo> {
        const why = this.releaseUnavailable(r);
        if (why) return this.replace({ release: true, installed: r.marker.version, unavailable: why });
        const base = { release: true, installed: r.marker.version, unavailable: undefined };
        const src = this.releases;
        // No key to check a release with (none published yet): nothing is believed, so nothing is fetched.
        if (!src.keys.length) return this.patch({ ...base, checking: false, error: quiet ? undefined : "Couldn't check for updates." });
        this.patch({ ...base, checking: true });
        let m;
        try {
            m = await latestRelease(src, r.arch, this.ending.signal);
        } catch (e) {
            process.stderr.write(`cavvy: couldn't check for updates: ${(e as Error).message}\n`);
            // In the background, nothing is said: it looks again later.
            return this.patch({ checking: false, error: quiet ? undefined : "Couldn't check for updates." });
        }
        const newer = m && compareVersions(m.version, r.marker.version) > 0 ? m : undefined;
        if (this.ready && this.ready.version !== newer?.version) this.dropReady(r);
        if (this.failedFor && this.failedFor !== newer?.version) this.failedFor = undefined;
        return this.patch({
            checking: false,
            checkedAt: Date.now(),
            error: undefined,
            available: Boolean(newer),
            latest: m?.version,
            notes: newer ? releaseNotes(src.base, newer.version) : undefined,
            needsSystem: newer && r.system && compareVersions(r.system, newer.minimumSystemVersion) < 0 ? newer.minimumSystemVersion : undefined,
            ready: this.ready ? true : undefined,
            failed: this.failedFor ? this.info.failed : undefined,
        });
    }

    private dropReady(r: ReleaseApp) {
        this.ready = undefined;
        rmSync(partialDir(r.bundle), { recursive: true, force: true });
    }

    /** Downloads, checks and unpacks the latest release beside the app, then restarts into it; or restarts at once if that's done. */
    private async startRelease(r: ReleaseApp): Promise<AppUpdateInfo> {
        if (this.ready) return this.restartInto(r);
        const why = this.releaseUnavailable(r);
        if (why) return this.patch({ failed: why });
        const log = join(paths.logs(), "app-update.log");
        try {
            mkdirSync(dirname(log), { recursive: true });
            writeFileSync(log, "");
        } catch {
            // the log is a nicety
        }
        const startedAt = Date.now();
        void this.runRelease(r, log, startedAt);
        return this.patch({ updating: { startedAt, line: "Downloading…", restarting: false, progress: 0 }, failed: undefined, log });
    }

    private async runRelease(r: ReleaseApp, log: string, startedAt: number) {
        const say = (line: string) => {
            try {
                appendFileSync(log, `${new Date().toISOString()} ${line}\n`);
            } catch {}
        };
        const step = (line: string, progress?: number) => this.patch({ updating: { startedAt, line, restarting: false, ...(progress === undefined ? {} : { progress }) } });
        const src = this.releases;
        const signal = this.ending.signal;
        const cache = join(cavvyHome(), "cache", "app-update");
        let tmp: string | undefined;
        let version: string | undefined;
        let system: string | undefined;
        try {
            const m = await latestRelease(src, r.arch, signal);
            if (!m) throw new Refused("download", "no release is published for this Mac");
            version = m.version;
            say(`Cavvy ${m.version} (${m.commit}) for ${m.arch}, ${m.zip.size} bytes; this is ${r.marker.version}`);
            if (compareVersions(m.version, r.marker.version) <= 0) {
                say("not newer than this one: nothing to do");
                this.patch({ updating: undefined });
                void this.check({ quiet: true });
                return;
            }
            // Not known: not taken, rather than taken on a guess.
            if (!r.system || compareVersions(r.system, m.minimumSystemVersion) < 0) {
                system = m.minimumSystemVersion;
                throw new Refused("system", `it needs macOS ${m.minimumSystemVersion}, this is ${r.system ?? "a version sw_vers didn't say"}`);
            }
            if (!canReplace(r.bundle)) throw new Refused("location", `${r.bundle} can't be replaced from here`);
            mkdirSync(cache, { recursive: true, mode: 0o700 });
            tmp = mkdtempSync(join(cache, ".tmp-"));
            const zip = join(tmp, m.zip.name);
            let shown = 0;
            await downloadZip(src, m, zip, (share) => {
                const percent = Math.floor(share * 100);
                if (percent >= shown + 2) step(`Downloading… ${(shown = percent)}%`, percent / 100);
            }, signal);
            say(`downloaded, ${m.zip.sha256}`);
            step("Checking the download…");
            const top = scanZip(zip);
            // Unpacked beside the app, under a hidden name, so putting it in place is a rename.
            const part = partialDir(r.bundle);
            rmSync(part, { recursive: true, force: true });
            mkdirSync(part, { mode: 0o700 });
            const unzip = await this.run(["/usr/bin/ditto", "-x", "-k", "--noqtn", zip, part], 600_000);
            if (!unzip.ok) throw new Refused("install", `couldn't unpack it: ${unzip.err}`);
            const app = checkTree(part, top);
            await verifyApp(app, r.req!, m, this.run);
            say(`checked: signed by Cavvy, meets this app's signature, ${top} is ${m.version}`);
            this.ready = { version: m.version, commit: m.commit, app };
            this.failedFor = undefined;
            rmSync(tmp, { recursive: true, force: true });
            tmp = undefined;
            this.restartInto(r);
        } catch (e) {
            const refused = e instanceof Refused ? e : new Refused("install", (e as Error).message);
            say(`not updated: ${refused.message}`);
            if (tmp) rmSync(tmp, { recursive: true, force: true });
            if (!this.ready) rmSync(partialDir(r.bundle), { recursive: true, force: true });
            this.failedFor = version;
            this.patch({ updating: undefined, failed: refusalText(refused.reason, { system }), log });
        }
    }

    /**
     * Leaves the helper waiting for the app to quit, then asks it to. Under no desktop app (gui:demo), nothing quits
     * it: it's left ready, for the restart there is.
     */
    private restartInto(r: ReleaseApp): AppUpdateInfo {
        const ready = this.ready!;
        const startedAt = this.info.updating?.startedAt ?? Date.now();
        const pending: Pending = { version: ready.version, previous: r.marker.version, app: r.bundle, old: oldCopy(r.bundle) };
        const quit = quitForUpdate;
        if (!quit) return this.patch({ updating: undefined, ready: true });
        try {
            writeFileSync(pendingPath(), JSON.stringify(pending) + "\n");
            const how = this.releases === RELEASES ? "open" : "exec";
            const args = [String(this.o.appPid ?? process.ppid), ready.app, r.bundle, pending.old, r.req!.bundle, r.req!.server, pendingPath(), notePath(), how, ready.version, String(NEW_APP_OPENS_S), ready.commit];
            // Its own session: the app quitting doesn't take it along.
            const helper = spawn("/bin/sh", ["-c", RESTART_HELPER, "sh", ...args], { detached: true, stdio: "ignore" });
            helper.unref();
            this.helper = helper;
        } catch (e) {
            rmSync(pendingPath(), { force: true });
            return this.patch({ updating: undefined, ready: true, failed: refusalText("install") });
        }
        clearTimeout(this.restartTimer);
        // The quit never came, or a dialog sat open past the helper's wait: it's left ready, to restart again.
        this.restartTimer = setTimeout(() => this.quitCancelled(), this.o.restartWaitMs ?? RELEASE_RESTART_WAIT_MS);
        this.restartTimer.unref?.();
        const info = this.patch({ updating: { startedAt, line: "Restarting Cavvy…", restarting: true }, ready: true, failed: undefined });
        quit();
        return info;
    }

    /** The quit for the update didn't happen: the helper stops before applying anything, and the update stays ready. */
    private quitCancelled() {
        clearTimeout(this.restartTimer);
        const helper = this.helper;
        this.helper = undefined;
        if (helper?.pid) {
            try {
                process.kill(-helper.pid, "SIGKILL");
            } catch {
                helper.kill("SIGKILL");
            }
        }
        rmSync(pendingPath(), { force: true });
        if (this.info.updating?.restarting) this.patch({ updating: undefined, ready: this.ready ? true : undefined });
    }

    private patch(p: Partial<AppUpdateInfo>): AppUpdateInfo {
        this.info = { ...this.info, ...p };
        for (const k of Object.keys(this.info) as (keyof AppUpdateInfo)[]) if (this.info[k] === undefined) delete this.info[k];
        const info = this.get();
        this.o.emit(info);
        return info;
    }

    private replace(p: Partial<AppUpdateInfo>): AppUpdateInfo {
        this.info = { available: false, changes: [], behind: 0, checking: false };
        return this.patch(p);
    }

    private every(t: ReturnType<typeof setTimeout>) {
        (t as { unref?: () => void }).unref?.();
        this.timers.push(t);
    }
}

function readJson<T>(file: string): T | undefined {
    try {
        const v = JSON.parse(readFileSync(file, "utf8")) as unknown;
        return v && typeof v === "object" ? (v as T) : undefined;
    } catch {
        return undefined;
    }
}
