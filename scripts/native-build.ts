// Builds cavvy-native (native/) and copies it where a server will look for it: beside the server's own executable.
//
//   bun scripts/native-build.ts                              this machine, into native/target/release, where the server
//                                                            run from this checkout looks
//   bun scripts/native-build.ts --into dist --optional       and beside dist/cavvy; if it can't be built, says so and goes on
//   bun scripts/native-build.ts --target aarch64-apple-darwin --into <App>/Contents/MacOS
//
// The target's standard library is added with rustup where there is one; where cargo puts what it builds is asked of
// cargo (CARGO_TARGET_DIR and .cargo/config move it). Cavvy works without the helper, reading Git objects with git.

import { chmodSync, copyFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const target = arg("--target");
const into = arg("--into");
const native = resolve(import.meta.dir, "..", "native");
const exe = process.platform === "win32" ? "cavvy-native.exe" : "cavvy-native";

function run(cmd: string[]): string {
    const r = Bun.spawnSync(cmd, { cwd: native, stdout: "pipe", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})`);
    return r.stdout.toString();
}

/** Puts the built helper at `dir`. */
function place(built: string, dir: string): string {
    mkdirSync(dir, { recursive: true });
    copyFileSync(built, join(dir, exe));
    chmodSync(join(dir, exe), 0o755);
    return join(resolve(dir), exe);
}

function build(): string {
    if (!Bun.which("cargo")) throw new Error("no cargo: install Rust from rustup.rs to include it");
    if (target && Bun.which("rustup")) run(["rustup", "target", "add", target]);
    const r = Bun.spawnSync(["cargo", "build", "--release", "--locked", ...(target ? ["--target", target] : [])], { cwd: native, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`cargo build failed (${r.exitCode})`);
    const targetDir = (JSON.parse(run(["cargo", "metadata", "--format-version", "1", "--no-deps", "--locked"])) as { target_directory: string }).target_directory;
    const built = join(targetDir, ...(target ? [target] : []), "release", exe);
    if (into) return place(built, into);
    // Where the server run from this checkout looks, wherever CARGO_TARGET_DIR or .cargo/config put the build.
    const home = join(native, "target", "release");
    return resolve(built) === resolve(home, exe) ? built : place(built, home);
}

try {
    console.log(`cavvy-native: ${build()}`);
} catch (e) {
    const message = `cavvy-native isn't built (${(e as Error).message.replace(/\.$/, "")}); Cavvy reads Git objects with git.`;
    // Optional (bun run build, the desktop app): the rest builds without it, as before there was one.
    if (args.includes("--optional")) console.warn(message);
    else {
        console.error(message);
        process.exit(1);
    }
}
