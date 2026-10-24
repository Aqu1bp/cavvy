// The desktop app's own updates from main: whether origin/main has moved past
// the installed build (the record scripts/install-desktop.ts leaves), and
// running scripts/update-desktop.ts from the app, detached, so it carries on
// when the app quits to restart. Only the installed app (the .app bundle
// desktop:install put there) can update itself; anywhere else it says why not.

import { spawn, type ChildProcess } from "child_process";
import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { appSourceDir, readInstallRecord, type InstallRecord } from "../config/desktop-install";
import { harnessHome, paths } from "../config/paths";
import type { AppUpdateChange, AppUpdateInfo } from "./protocol";

const CHECK_EVERY_MS = 6 * 3600_000;
const FIRST_CHECK_MS = 5_000;
/** How long a finished update may take to restart the app before it says so. */
const RESTART_WAIT_MS = 90_000;
const SHOWN = 20;

/** The .app bundle a program runs from (…/Harness.app/Contents/MacOS/harness), if it does. */
export function bundleOf(execPath: string): string | undefined {
    return /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1];
}

export interface AppUpdatesOptions {
    emit: (info: AppUpdateInfo) => void;
    /** The running app's bundle: by default HARNESS_APP_BUNDLE (gui:demo --update), else the one this program runs from. */
    bundle?: string;
    platform?: NodeJS.Platform;
    /** bun, to run the update with: by default from PATH, or ~/.bun/bin. */
    bun?: string;
    everyMs?: number;
    firstCheckMs?: number;
    restartWaitMs?: number;
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

/** Never asks for a password or passphrase: there's no one at a terminal to answer. */
async function git(cwd: string, args: string[], timeoutMs = 30_000): Promise<{ ok: boolean; out: string; err: string }> {
    const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND ?? "ssh -o BatchMode=yes" };
    try {
        const p = Bun.spawn(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
        const timer = setTimeout(() => p.kill(), timeoutMs);
        const [out, err, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
        clearTimeout(timer);
        return { ok: code === 0, out: out.trimEnd(), err: err.trim() || (code === 0 ? "" : `git ${args[0]} timed out or failed`) };
    } catch (e) {
        return { ok: false, out: "", err: (e as Error).message };
    }
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
    private child?: ChildProcess;
    private stopped = false;

    constructor(private o: AppUpdatesOptions) {}

    get(): AppUpdateInfo {
        return structuredClone(this.info);
    }

    /** Checks a little after the server starts, then every few hours: only for the installed app. */
    start() {
        void this.where().then((w) => {
            if (this.stopped) return;
            // Said when asked (app.update.get), not sent: most servers are never the installed app.
            if ("unavailable" in w) return void (this.info = { ...this.info, unavailable: w.unavailable });
            this.every(setTimeout(() => void this.check(), this.o.firstCheckMs ?? FIRST_CHECK_MS));
            this.every(setInterval(() => void this.check(), this.o.everyMs ?? CHECK_EVERY_MS));
        });
    }

    /** An update running carries on: it was asked for, and it reopens the app when it's done. */
    stop() {
        this.stopped = true;
        for (const t of this.timers) clearTimeout(t);
        this.timers = [];
    }

    /** Fetches main and compares it with the installed build. One at a time; none while an update runs. */
    check(): Promise<AppUpdateInfo> {
        if (this.info.updating) return Promise.resolve(this.get());
        this.checking ??= this.runCheck().finally(() => (this.checking = undefined));
        return this.checking;
    }

    /** Starts the update, detached, its output in logs/app-update.log; how it goes comes as events. */
    async update(): Promise<AppUpdateInfo> {
        if (this.info.updating) return this.get();
        await this.checking;
        const w = await this.where();
        if ("unavailable" in w) return this.replace({ unavailable: w.unavailable });
        const home = join(homedir(), ".bun", "bin", "bun");
        const bun = this.o.bun ?? Bun.which("bun") ?? (existsSync(home) ? home : undefined);
        if (!bun) return this.patch({ failed: "Updating needs bun, and it isn't on your PATH (https://bun.sh)." });
        // The worktree desktop:update keeps has the script once it has run; before that, the checkout the app came from.
        const dir = [appSourceDir(), w.record.source].find((d) => existsSync(join(d, "scripts", "update-desktop.ts")));
        if (!dir) return this.patch({ failed: `${w.record.source} has no scripts/update-desktop.ts yet: pull main there, then update.` });

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
                    env: { ...process.env, HARNESS_HOME: harnessHome(), GIT_TERMINAL_PROMPT: "0" },
                });
            } finally {
                closeSync(fd);
            }
        } catch (e) {
            return this.patch({ failed: `Couldn't start the update: ${(e as Error).message}` });
        }
        child.unref();
        this.child = child;
        const progress = setInterval(() => {
            const line = lastLogLine(log);
            if (line && this.info.updating && !this.info.updating.restarting && line !== this.info.updating.line) this.patch({ updating: { ...this.info.updating, line } });
        }, 1000);
        progress.unref?.();
        const done = (code: number, failure?: string) => {
            if (this.child !== child) return;
            this.child = undefined;
            clearInterval(progress);
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
                this.patch({ updating: { startedAt, line: "Installed. Restarting Harness…", restarting: true } });
                // This process ends with the restart; if it's still here a while later, the restart didn't happen.
                const t = setTimeout(() => this.patch({ updating: undefined, failed: "The new build is installed, but Harness didn't restart: quit it and open it again." }), this.o.restartWaitMs ?? RESTART_WAIT_MS);
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
    private async where(): Promise<{ record: InstallRecord } | { unavailable: string }> {
        if ((this.o.platform ?? process.platform) !== "darwin") return { unavailable: "Updating from main is for the macOS desktop app." };
        const bundle = this.o.bundle ?? (process.env.HARNESS_APP_BUNDLE || bundleOf(process.execPath));
        if (!bundle) return { unavailable: "Only the installed desktop app updates itself." };
        const record = await readInstallRecord();
        if (!record) return { unavailable: "There's no record of the checkout this app was built from. Install it once with bun run desktop:install or desktop:update, and it can update itself after that." };
        if (record.app && real(record.app) !== real(bundle)) return { unavailable: `This copy isn't the one last installed from a checkout (${record.app}).` };
        if (!isDir(record.source)) return { unavailable: `The checkout this app was built from is gone (${record.source}).` };
        return { record };
    }

    private async runCheck(): Promise<AppUpdateInfo> {
        const w = await this.where();
        if ("unavailable" in w) return this.replace({ unavailable: w.unavailable });
        const { record } = w;
        const repo = record.source;
        this.patch({ checking: true, unavailable: undefined });
        // Into origin/main by name: a remote whose fetch refspec leaves main out would only fill FETCH_HEAD.
        const fetched = await git(repo, ["fetch", "--quiet", "origin", "+refs/heads/main:refs/remotes/origin/main"], 60_000);
        const head = await git(repo, ["rev-parse", "--verify", "origin/main^{commit}"]);
        if (!head.ok) return this.patch({ checking: false, checkedAt: Date.now(), error: fetched.ok ? "origin/main isn't a commit in that checkout." : `Couldn't fetch main: ${lastLine(fetched.err)}` });
        const target = head.out;
        // desktop:update's worktree only ever has main checked out, so a change there (bun install touching the lockfile) doesn't count.
        const current = record.commit === target && (!record.dirty || real(record.source) === real(appSourceDir()));
        let changes: AppUpdateChange[] = [];
        let behind = 0;
        let note: string | undefined;
        if (!current) {
            if (record.commit === target) note = "This build has uncommitted changes on top of main.";
            else if ((await git(repo, ["merge-base", "--is-ancestor", record.commit, target])).ok) {
                const range = `${record.commit}..${target}`;
                behind = Number((await git(repo, ["rev-list", "--count", "--no-merges", range])).out) || 0;
                changes = (await git(repo, ["log", "--no-merges", `-n${SHOWN}`, "--format=%h%x09%s", range])).out
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
