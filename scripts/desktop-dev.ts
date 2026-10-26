// The desktop app from this checkout, for working on it: the GUI from Vite's dev server (hot reload), the server
// from source (desktop-electron/src/main.ts runs it with bun), in the Electron window. Quitting the app stops both.
//
//   bun run desktop:dev

import { join, resolve } from "path";

const root = resolve(import.meta.dir, "..");
const app = join(root, "desktop-electron");
const URL = "http://localhost:5173";

const run = (cmd: string[], cwd: string) => {
    const r = Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) process.exit(r.exitCode ?? 1);
};
run(["bun", "install"], app);
run(["bun", "run", "build"], app);

const vite = Bun.spawn(["bun", "run", "dev"], { cwd: join(root, "gui"), stdout: "inherit", stderr: "inherit" });
const stopVite = () => vite.kill();
process.on("exit", stopVite);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

// Vite answers once it's ready.
for (let i = 0; ; i++) {
    if (await fetch(URL).then((r) => r.ok, () => false)) break;
    if (vite.exitCode !== null || i > 300) {
        console.error("The GUI's dev server didn't start.");
        process.exit(1);
    }
    await Bun.sleep(100);
}
const electron = Bun.spawn([join(app, "node_modules", ".bin", "electron"), app], { cwd: root, env: { ...process.env, CAVVY_ELECTRON_DEV_URL: URL }, stdout: "inherit", stderr: "inherit" });
process.exit(await electron.exited);
