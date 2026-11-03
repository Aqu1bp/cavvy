// Builds Cavvy server as a single executable for the desktop app:
// desktop/src-tauri/binaries/cavvy-<target triple>, the name Tauri's
// externalBin expects.
//
//   bun scripts/build-sidecar.ts                 for this machine
//   bun scripts/build-sidecar.ts --target aarch64-apple-darwin

import { mkdirSync } from "fs";
import { join, resolve } from "path";

const BUN_TARGETS: Record<string, string> = {
    "x86_64-unknown-linux-gnu": "bun-linux-x64",
    "aarch64-unknown-linux-gnu": "bun-linux-arm64",
    "x86_64-apple-darwin": "bun-darwin-x64",
    "aarch64-apple-darwin": "bun-darwin-arm64",
    "x86_64-pc-windows-msvc": "bun-windows-x64",
};

function hostTriple(): string {
    const r = Bun.spawnSync(["rustc", "-vV"], { stdout: "pipe", stderr: "pipe" });
    const host = r.stdout.toString().match(/^host:\s*(\S+)/m)?.[1];
    if (!host) throw new Error("couldn't get the target triple from `rustc -vV`; pass --target");
    return host;
}

const args = process.argv.slice(2);
const i = args.indexOf("--target");
const triple = i >= 0 ? args[i + 1]! : hostTriple();
const bunTarget = BUN_TARGETS[triple];
if (!bunTarget) {
    console.error(`No Bun target for ${triple}. Known: ${Object.keys(BUN_TARGETS).join(", ")}`);
    process.exit(1);
}
const root = resolve(import.meta.dir, "..");
const outDir = join(root, "desktop", "src-tauri", "binaries");
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `cavvy-${triple}${triple.includes("windows") ? ".exe" : ""}`);
const build = Bun.spawnSync(
    ["bun", "build", "--compile", "--minify", "--sourcemap=none", `--target=${bunTarget}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", out, join(root, "src", "index.ts"), join(root, "src", "agent", "stat-worker.ts")],
    { cwd: root, stdout: "inherit", stderr: "inherit" },
);
if (build.exitCode !== 0) process.exit(build.exitCode ?? 1);
console.log(`sidecar: ${out}`);
