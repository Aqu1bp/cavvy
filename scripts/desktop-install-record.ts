// What desktop:install last put in Applications, so desktop:update can tell whether main has moved past it.

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { harnessHome } from "../src/config/paths";

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
