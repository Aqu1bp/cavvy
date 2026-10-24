// What desktop:install last put in Applications (scripts/install-desktop.ts), so desktop:update and the app
// itself (src/server/app-update.ts) can tell whether main has moved past it.

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "fs";
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
    renameSync(staging, dest);
    rmSync(old, { recursive: true, force: true });
}
