// Work on the GUI with hot reload: Cavvy server (from source) and the
// Vite dev server, wired together with a token made for this run.
//
//   bun run gui:dev                  then open http://localhost:5173
//   bun run gui:dev --demo           with the mock model and a demo project (no API keys)

import { randomBytes } from "crypto";
import { join, resolve } from "path";

const root = resolve(import.meta.dir, "..");
const demo = process.argv.includes("--demo");
const PORT = "4600";
// Not a fixed one: the port is known, and whoever has the token can run commands as you.
const TOKEN = randomBytes(24).toString("hex");

const server = demo
    ? Bun.spawn(["bun", "--no-env-file", `--config=${join(root, "bunfig.toml")}`, join(root, "scripts/gui-demo.ts"), "--port", PORT, "--token", TOKEN, "--dev-origin", "http://localhost:5173"], { cwd: root, stdout: "inherit", stderr: "inherit" })
    : Bun.spawn(["bun", "--no-env-file", `--config=${join(root, "bunfig.toml")}`, join(root, "src/index.ts"), "serve", "--port", PORT, "--dev-origin", "http://localhost:5173"], {
          cwd: process.cwd(),
          env: { ...(process.env as Record<string, string>), CAVVY_GUI_TOKEN: TOKEN },
          stdout: "inherit",
          stderr: "inherit",
      });
const vite = Bun.spawn(["bun", "run", "dev"], {
    cwd: join(root, "gui"),
    env: { ...(process.env as Record<string, string>), VITE_CAVVY_URL: `ws://127.0.0.1:${PORT}/ws`, VITE_CAVVY_TOKEN: TOKEN },
    stdout: "inherit",
    stderr: "inherit",
});
process.stderr.write(`\n  GUI with hot reload: http://localhost:5173  (server on ${PORT}${demo ? ", demo mode" : ""})\n\n`);
const stop = () => {
    server.kill();
    vite.kill();
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await Promise.race([server.exited, vite.exited]);
stop();
