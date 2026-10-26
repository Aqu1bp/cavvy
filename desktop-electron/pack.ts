// A packaged Harness.app (macOS, this machine's architecture): the app's code in an asar archive, the GUI and the
// server (compiled to one binary, as for the Tauri app) as its resources, signed ad hoc so it runs here. Not notarized.
//
//   bun desktop-electron/pack.ts            → desktop-electron/out/Harness-darwin-<arch>/Harness.app
//
// ELECTRON_ZIP_DIR names a folder holding electron-v<version>-darwin-<arch>.zip to build offline.

import { packager } from "@electron/packager";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const here = import.meta.dir;
const repo = resolve(here, "..");
const stage = join(here, "stage");
const arch = process.arch === "arm64" ? "arm64" : "x64";
const run = (cmd: string[], cwd = repo) => {
    const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})`);
};

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
// The app's own code.
run(["bun", "run", "build"], here);
// The GUI.
run(["bun", "run", "gui:build"]);
cpSync(join(repo, "gui/dist"), join(stage, "gui"), { recursive: true });
// The server, as one executable (scripts/build-sidecar.ts's flags).
run(["bun", "build", "--compile", "--minify", "--sourcemap=none", `--target=bun-darwin-${arch}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", join(stage, "harness"), join(repo, "src/index.ts")]);

const [path] = await packager({
    dir: here,
    out: join(here, "out"),
    name: "Harness",
    appBundleId: "dev.harness.electron",
    platform: "darwin",
    arch,
    electronVersion: "45.0.0",
    ...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
    overwrite: true,
    prune: true,
    // Native modules can't be loaded from inside the archive.
    asar: { unpack: "**/*.node" },
    extraResource: [join(stage, "gui"), join(stage, "harness")],
    ignore: [/^\/src($|\/)/, /^\/stage($|\/)/, /^\/out($|\/)/, /^\/bench\.ts$/, /^\/pack\.ts$/, /^\/check-input\.ts$/, /^\/tsconfig\.json$/, /^\/README\.md$/, /^\/bun\.lock$/, /^\/bench-.*\.json$/],
});
const app = join(path!, "Harness.app");
// The bundle changed after Electron signed its binaries: sign it again, ad hoc, so macOS runs it on this machine.
run(["codesign", "--force", "--deep", "--sign", "-", app]);
console.log(`packaged: ${app}`);
