// Run the SDK examples (examples/sdk) end to end without API keys: a
// throwaway CAVVY_HOME with the mock model (scripts/mock-llm.ts) as its only
// provider, and the demo project to work in.
//
//   bun run sdk:example      basic.ts with "demo" (read, edit with approval, run tests), then conversation.ts

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { startMockLlm } from "./mock-llm";
import { createDemoProject } from "./demo-project";

const root = mkdtempSync(join(tmpdir(), "cavvy-sdk-demo-"));
const home = join(root, "home");
const project = join(root, "acme-platform");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
createDemoProject(project);

const mock = startMockLlm({ delayMs: Number(process.env.MOCK_DELAY_MS ?? 2) });
writeFileSync(join(home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

const repo = resolve(import.meta.dir, "..");
const env = { ...(process.env as Record<string, string>), CAVVY_HOME: home, CAVVY_NO_KEYCHAIN: "1" };
const run = async (file: string, args: string[]) => {
    console.error(`\n$ bun ${file} ${args.join(" ")}\n`);
    const p = Bun.spawn(["bun", "--no-env-file", `--config=${join(repo, "bunfig.toml")}`, join(repo, file), ...args], { cwd: project, env, stdout: "inherit", stderr: "inherit" });
    return p.exited;
};

let code = 0;
try {
    code ||= await run("examples/sdk/basic.ts", ["demo: add SSO sign-in", "--yes"]);
    code ||= await run("examples/sdk/conversation.ts", []);
} finally {
    mock.stop();
    rmSync(root, { recursive: true, force: true });
}
process.exit(code);
