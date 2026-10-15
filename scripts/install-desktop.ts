// Builds the desktop app from this checkout (whichever branch or worktree
// it's on) and installs it in place of the copy you have, to try a change
// in the app itself. macOS only.
//
//   bun run desktop:install                 build, quit Harness, install, open it
//   bun run desktop:install --no-restart    install only; a running Harness carries on
//
// It goes to /Applications, or ~/Applications if that isn't writable. Builds
// reuse desktop/src-tauri/target, so after the first only what changed is
// rebuilt.

import { accessSync, constants, existsSync, readdirSync, rmSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

if (process.platform !== "darwin") {
    console.error("desktop:install is for macOS. Elsewhere, bun run desktop:build makes the installers.");
    process.exit(1);
}

const restart = !process.argv.includes("--no-restart");
const root = resolve(import.meta.dir, "..");
const desktop = join(root, "desktop");
const tauri = join(desktop, "src-tauri");
const { productName } = (await Bun.file(join(tauri, "tauri.conf.json")).json()) as { productName: string };

/** Where Rust is when cargo isn't on PATH: rustup's shims, or a toolchain installed without them. */
function rustBin(): string | undefined {
    if (Bun.which("cargo")) return undefined;
    const shims = join(homedir(), ".cargo", "bin");
    if (existsSync(join(shims, "cargo"))) return shims;
    const toolchains = join(homedir(), ".rustup", "toolchains");
    if (!existsSync(toolchains)) return undefined;
    return readdirSync(toolchains)
        .filter((d) => d.startsWith("stable-"))
        .map((d) => join(toolchains, d, "bin"))
        .find((d) => existsSync(join(d, "cargo")));
}

const env = { ...process.env };
const bin = rustBin();
if (bin) env.PATH = `${bin}:${env.PATH ?? ""}`;
if (!Bun.which("cargo", { PATH: env.PATH })) {
    console.error("Building the app needs Rust: https://rustup.rs");
    process.exit(1);
}

function run(cmd: string[], cwd: string) {
    const r = Bun.spawnSync(cmd, { cwd, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
}

run(["bun", "install"], root);
run(["bun", "install"], desktop);
// Just the app (desktop:build also makes a .dmg). Building it builds the GUI and the sidecar first.
run(["bun", "run", "tauri", "build", "--bundles", "app"], desktop);

const target = env.CARGO_TARGET_DIR ? resolve(tauri, env.CARGO_TARGET_DIR) : join(tauri, "target");
const built = join(target, "release", "bundle", "macos", `${productName}.app`);
if (!existsSync(built)) {
    console.error(`The build finished, but there's no ${built}`);
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

/** Running copies, wherever they were opened from: the app, and the server each started. */
function running(): { app: number[]; server: number[] } {
    const find = (pattern: string) =>
        Bun.spawnSync(["pgrep", "-f", pattern])
            .stdout.toString()
            .split("\n")
            .filter(Boolean)
            .map(Number);
    return { app: find(`/${productName}.app/Contents/MacOS/harness-desktop`), server: find(`/${productName}.app/Contents/MacOS/harness serve`) };
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

if (restart) {
    const { app, server } = running();
    if (app.length) {
        console.log(`Quitting ${productName} (anything running in it stops; sessions are saved)…`);
        // Its server closes the sessions when the app goes (SessionEnd hooks run, session locks are released), then exits.
        // It's the app that's stopped: it would start a new server in place of one stopped on its own.
        for (const pid of app) process.kill(pid, "SIGTERM");
        const all = [...app, ...server];
        const until = Date.now() + 15_000;
        while (all.some(alive) && Date.now() < until) await Bun.sleep(100);
        const stuck = all.filter(alive);
        if (stuck.length) {
            console.warn(`${productName} didn't quit within 15 seconds; stopping it.`);
            for (const pid of stuck) process.kill(pid, "SIGKILL");
        }
    }
}

rmSync(dest, { recursive: true, force: true });
run(["ditto", built, dest], root);
console.log(`Installed ${dest}`);
if (restart) run(["open", dest], root);
else if (running().app.length) console.log(`${productName} is still running the build before this one: quit it and open it again to use this one.`);
