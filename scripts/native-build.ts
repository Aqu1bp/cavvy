// Builds cavvy-native (native/) and copies it where a server will look for it: beside the server's own executable.
//
//   bun scripts/native-build.ts                              this machine; the server run from this checkout finds it
//   bun scripts/native-build.ts --into dist --optional       and beside dist/cavvy; without cargo, says so and goes on
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

if (!Bun.which("cargo")) {
    const message = "No cargo: cavvy-native isn't built (install Rust from rustup.rs to include it); Cavvy reads Git objects with git.";
    if (args.includes("--optional")) {
        console.warn(message);
        process.exit(0);
    }
    console.error(message);
    process.exit(1);
}
if (target && Bun.which("rustup")) run(["rustup", "target", "add", target]);
const r = Bun.spawnSync(["cargo", "build", "--release", "--locked", ...(target ? ["--target", target] : [])], { cwd: native, stdout: "inherit", stderr: "inherit" });
if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
const targetDir = (JSON.parse(run(["cargo", "metadata", "--format-version", "1", "--no-deps", "--locked"])) as { target_directory: string }).target_directory;
const built = join(targetDir, ...(target ? [target] : []), "release", exe);
if (into) {
    mkdirSync(into, { recursive: true });
    copyFileSync(built, join(into, exe));
    chmodSync(join(into, exe), 0o755);
    console.log(`cavvy-native: ${join(resolve(into), exe)}`);
} else console.log(`cavvy-native: ${built}`);
