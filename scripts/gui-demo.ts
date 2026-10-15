// Try the GUI without API keys: a throwaway HARNESS_HOME with the mock model
// (scripts/mock-llm.ts) as its only provider, a small demo project, and the
// GUI server on a fixed port.
//
//   bun run gui:demo                 then open the printed link
//   bun run gui:demo --port 4600 --token <16+ characters>    a link that stays the same: http://127.0.0.1:4600/#token=<token>
//
// Prompts with "sso" or "demo" walk through reading, editing (with approvals)
// and running tests; "question", "plan" and "todo" show those flows.

import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { startMockLlm } from "./mock-llm";
import { createDemoProject } from "./demo-project";

const args = process.argv.slice(2);
const arg = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
};
const root = arg("--dir") ?? mkdtempSync(join(tmpdir(), "harness-gui-demo-"));
const home = join(root, "home");
const project = join(root, "acme-platform");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
createDemoProject(project);

const mock = startMockLlm({ port: Number(arg("--mock-port") ?? 0), delayMs: Number(arg("--delay") ?? 14) });
writeFileSync(join(home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock (demo)", baseUrl: mock.url, requiresKey: false }] }, null, 2));
writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }, null, 2));

const repo = resolve(import.meta.dir, "..");
const port = arg("--port") ?? "4600";
const env: Record<string, string> = { ...(process.env as Record<string, string>), HARNESS_HOME: home, HARNESS_NO_KEYCHAIN: "1" };
if (arg("--token")) env.HARNESS_GUI_TOKEN = arg("--token")!;
const extra = arg("--dev-origin") ? ["--dev-origin", arg("--dev-origin")!] : [];
const proc = Bun.spawn(["bun", "--no-env-file", `--config=${join(repo, "bunfig.toml")}`, join(repo, "src/index.ts"), "serve", "--port", port, ...extra], {
    cwd: project,
    env,
    stdout: "inherit",
    stderr: "inherit",
});
process.stderr.write(`\n  demo project: ${project}\n  HARNESS_HOME: ${home}\n${arg("--token") ? `  fixed link:   http://127.0.0.1:${port}/#token=${arg("--token")}\n` : ""}\n`);
const stop = () => {
    proc.kill();
    mock.stop();
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await proc.exited;
mock.stop();
