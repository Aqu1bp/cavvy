// Brings the installed desktop app up to date with origin/main, without touching
// the checkout you run it from: it fetches, builds main in a worktree of its own
// (~/.harness/app-source) and installs that (desktop:install). macOS only.
//
//   bun run desktop:update                 what's new on main, then build, install and restart Harness
//   bun run desktop:update --check         only say what's new since the installed build
//   bun run desktop:update --force         build and install even if nothing's new
//   bun run desktop:update --no-restart    install only; a running Harness carries on
//   bun run desktop:update --from-app      as the app runs it (src/server/app-update.ts): restarts it from outside
//
// Run from Harness's own terminal or the app's Update button, it builds and installs
// while Harness runs, then restarts it from outside, so quitting Harness doesn't stop the update.
// The worktree keeps its build products, so after the first update only what
// changed is rebuilt.

import { spawn } from "child_process";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { userInfo } from "os";
import { join, resolve } from "path";
import { harnessHome } from "../src/config/paths";
import { appSourceDir, readInstallRecord } from "../src/config/desktop-install";

if (process.platform !== "darwin") {
    console.error("desktop:update is for macOS. Elsewhere, bun run desktop:build makes the installers.");
    process.exit(1);
}

const args = process.argv.slice(2);
const check = args.includes("--check");
const force = args.includes("--force");
const restart = !args.includes("--no-restart");
const fromApp = args.includes("--from-app");
const root = resolve(import.meta.dir, "..");
// Absolute, and handed to the installer as such: it runs in the worktree, where a relative HARNESS_HOME would mean somewhere else.
const home = harnessHome();
const source = appSourceDir();
const REF = "origin/main";

function git(cwd: string, ...a: string[]): { ok: boolean; out: string; err: string } {
    const r = Bun.spawnSync(["git", ...a], { cwd, stdout: "pipe", stderr: "pipe" });
    return { ok: r.exitCode === 0, out: r.stdout.toString().trimEnd(), err: r.stderr.toString().trim() };
}

/** Runs it with its output in this terminal; exits if it fails. */
function run(cmd: string[], cwd: string) {
    const r = Bun.spawnSync(cmd, { cwd, env: { ...process.env, HARNESS_HOME: home }, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}

// Into origin/main by name: a remote whose fetch refspec leaves main out would only fill FETCH_HEAD.
run(["git", "fetch", "--quiet", "origin", `+refs/heads/main:refs/remotes/${REF}`], root);
const resolved = git(root, "rev-parse", "--verify", `${REF}^{commit}`);
if (!resolved.ok) {
    console.error(`Fetched, but ${REF} isn't a commit here: ${resolved.err}`);
    process.exit(1);
}
const target = resolved.out;
const short = target.slice(0, 7);
const installed = await readInstallRecord();

// Our own worktree only ever has main checked out, so a change there (bun install touching the lockfile) doesn't count.
const current = installed?.commit === target && (!installed.dirty || installed.source === source);
if (current && !force) {
    console.log(`Harness is up to date with main (${short}).`);
    process.exit(0);
}

const known = installed && git(root, "merge-base", "--is-ancestor", installed.commit, target).ok;
if (current) console.log(`Nothing new on main (${short}); rebuilding anyway.`);
else if (installed?.commit === target) console.log(`The installed build is main (${short}) with uncommitted changes; this puts plain main back.`);
else if (known) {
    const log = git(root, "log", "--no-merges", "--format=  %h %s", `${installed!.commit}..${target}`).out.split("\n").filter(Boolean);
    console.log(`${log.length} new change${log.length === 1 ? "" : "s"} on main since the installed build:`);
    console.log(log.slice(0, 15).join("\n") + (log.length > 15 ? `\n  …and ${log.length - 15} more` : ""));
} else if (installed) console.log(`The installed build (${installed.commit.slice(0, 7)}${installed.dirty ? ", with uncommitted changes" : ""}) isn't on main; main is at ${short}.`);
else console.log(`No record of which build is installed; main is at ${short}.`);
if (check) process.exit(0);

// The worktree: made on the first update, moved to main's latest on each one after. The forced checkout throws away
// changes, so it's only ever done in the worktree made here, which carries a marker in its own git directory: never
// in a plain folder (git would find whatever checkout encloses it), a link to your checkout, or another worktree.
const MARKER = "harness-app-source";

/** The worktree's own git directory (.git/worktrees/<name>), if source is the root of a linked worktree of this repository. */
function linkedGitDir(): string | undefined {
    const real = (p: string) => (existsSync(p) ? realpathSync(p) : p);
    const top = git(source, "rev-parse", "--show-toplevel");
    const dir = git(source, "rev-parse", "--absolute-git-dir");
    // Relative to where it ran, for some git versions (--path-format=absolute needs 2.31).
    const common = git(source, "rev-parse", "--git-common-dir");
    const mine = git(root, "rev-parse", "--git-common-dir");
    if (!top.ok || !dir.ok || !common.ok || !mine.ok) return undefined;
    // Its root, of this repository, and not the main checkout (whose git directory is the common one).
    if (real(top.out) !== real(source) || real(resolve(source, common.out)) !== real(resolve(root, mine.out)) || real(dir.out) === real(resolve(source, common.out))) return undefined;
    return dir.out;
}

if (existsSync(source)) {
    const dir = linkedGitDir();
    if (!dir || !existsSync(join(dir, MARKER))) {
        console.error(`${source} isn't the worktree desktop:update made, so it's left alone. Move it out of the way and run desktop:update again.`);
        process.exit(1);
    }
    run(["git", "checkout", "--quiet", "--detach", "--force", target], source);
} else {
    run(["git", "worktree", "prune"], root);
    run(["git", "worktree", "add", "--quiet", "--detach", source, target], root);
    const dir = linkedGitDir();
    if (!dir) {
        console.error(`git made ${source}, but it doesn't look like a worktree of this repository.`);
        process.exit(1);
    }
    writeFileSync(join(dir, MARKER), "Made by desktop:update (scripts/update-desktop.ts), which checks out main here with --force.\n");
}
console.log(`Building ${short} in ${source}…`);

// Inside Harness (its terminal, or its Update button), quitting Harness could end this process with it: install first, then restart from outside.
const inHarness = fromApp || process.env.TERM_PROGRAM === "Harness";
run([process.execPath, "--no-env-file", `--config=${join(source, "bunfig.toml")}`, join(source, "scripts", "install-desktop.ts"), ...(restart && !inHarness ? [] : ["--no-restart"])], source);
if (restart && inHarness) {
    const { productName, identifier } = (await Bun.file(join(source, "desktop", "src-tauri", "tauri.conf.json")).json()) as { productName: string; identifier: string };
    // The copy just installed, by path: by bundle id, macOS may open another (an older one left in /Applications
    // when this went to ~/Applications). An installer from before the record had the path has only the id to go on.
    const record = await readInstallRecord();
    const app = record?.commit === target ? record.app ?? "" : "";
    // Asks the app to quit (its server closes the sessions), gives it 15 seconds as desktop:install does, then opens the new build.
    // Values go in as arguments, not into the script's text.
    const script = `
        sleep 1
        pkill -TERM -U "$1" -f "/$2.app/Contents/MacOS/harness-desktop"
        i=0
        while pgrep -U "$1" -f "/$2.app/Contents/MacOS/harness" >/dev/null && [ $i -lt 150 ]; do sleep 0.1; i=$((i+1)); done
        pkill -KILL -U "$1" -f "/$2.app/Contents/MacOS/harness"
        if [ -n "$3" ]; then open "$3"; else open -b "$4"; fi`;
    spawn("/bin/sh", ["-c", script, "sh", String(userInfo().uid), productName, app, identifier], { detached: true, stdio: "ignore" }).unref();
    console.log(`${productName} restarts in a moment with the new build.`);
}
