// Builds Cavvy.app (macOS, this machine's architecture) from this checkout: the app's code in an asar archive, the GUI
// as a resource, and the server compiled to one executable beside the app's own, Contents/MacOS/cavvy, where the
// Tauri app kept it (so the installer, the updater and the app's Update button find both as they did). Signed ad hoc;
// desktop:install signs it again with your certificate when you have one (scripts/install-desktop.ts).
//
//   bun desktop-electron/pack.ts            → desktop-electron/out/Cavvy-darwin-<arch>/Cavvy.app
//
// ELECTRON_ZIP_DIR names a folder holding electron-v<version>-darwin-<arch>.zip to build offline. The server's Bun is
// downloaded once, unless it's the Bun doing the building.

import { packager } from "@electron/packager";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { appInfo } from "./app-info";

const here = import.meta.dir;
const repo = resolve(here, "..");
/**
 * The Bun the server runs on, whichever Bun builds it: on 1.3 a reply costs the server over ten times the work, nearly
 * all of it collecting garbage. The same as BUN_VERSION in .github/workflows/ci.yml, so what ships is what was tested.
 */
const SERVER_BUN = "1.4.4";

/** The Electron this folder has installed: the one packaged. */
function electronVersion(): string {
    return (JSON.parse(readFileSync(join(here, "node_modules", "electron", "package.json"), "utf8")) as { version: string }).version;
}

function run(cmd: string[], cwd = repo) {
    const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed (${r.exitCode})`);
}

/** Builds the app; returns where it is. `install`: run `bun install` here first (the installer does). */
export async function pack(o: { install?: boolean } = {}): Promise<string> {
    if (process.platform !== "darwin") throw new Error("The desktop app is built for macOS only for now.");
    const info = appInfo();
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const stage = join(here, "stage");
    if (o.install) run(["bun", "install"], here);
    rmSync(stage, { recursive: true, force: true });
    mkdirSync(stage, { recursive: true });
    // The app's own code, the GUI, and the server as one executable (as scripts/build-sidecar.ts made it for Tauri).
    run(["bun", "run", "build"], here);
    run(["bun", "run", "gui:build"]);
    cpSync(join(repo, "gui", "dist"), join(stage, "gui"), { recursive: true });
    const server = join(stage, "cavvy");
    run(["bun", "build", "--compile", "--minify", "--sourcemap=none", `--target=bun-darwin-${arch}-v${SERVER_BUN}`, "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", server, join(repo, "src", "index.ts")]);

    const [out] = await packager({
        dir: here,
        out: join(here, "out"),
        name: info.productName,
        // Not the product's name: Contents/MacOS/cavvy, the server, would be the same file on a case-insensitive disk.
        executableName: "cavvy-desktop",
        appBundleId: info.identifier,
        appVersion: info.version,
        appCategoryType: info.category,
        appCopyright: "MIT License",
        icon: join(repo, "desktop", "src-tauri", "icons", "icon.icns"),
        darwinDarkModeSupport: true,
        extendInfo: { LSMinimumSystemVersion: info.minimumSystemVersion },
        platform: "darwin",
        arch,
        electronVersion: electronVersion(),
        ...(process.env.ELECTRON_ZIP_DIR ? { electronZipDir: process.env.ELECTRON_ZIP_DIR } : {}),
        overwrite: true,
        prune: true,
        // Native modules can't be loaded from inside the archive.
        asar: { unpack: "**/*.node" },
        extraResource: [join(stage, "gui")],
        ignore: [/^\/\./, /^\/src($|\/)/, /^\/stage($|\/)/, /^\/out($|\/)/, /^\/bench[^/]*\.ts$/, /^\/pack\.ts$/, /^\/check-input\.ts$/, /^\/app-info\.ts$/, /^\/tsconfig\.json$/, /^\/[A-Z]+\.md$/, /^\/bun\.lock$/],
    });
    const app = join(out!, `${info.productName}.app`);
    const bundled = join(app, "Contents", "MacOS", "cavvy");
    copyFileSync(server, bundled);
    chmodSync(bundled, 0o755);
    if (!existsSync(join(app, "Contents", "MacOS", "cavvy-desktop"))) throw new Error(`${app} has no Contents/MacOS/cavvy-desktop`);
    // The bundle changed after Electron signed its binaries: signed again, ad hoc, so macOS runs it on this machine.
    run(["codesign", "--force", "--deep", "--sign", "-", app]);
    return app;
}

if (import.meta.main) console.log(`packaged: ${await pack()}`);
