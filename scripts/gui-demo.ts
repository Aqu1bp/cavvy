// Try the GUI without API keys: a throwaway CAVVY_HOME with the mock model
// (scripts/mock-llm.ts) as its only provider, a small demo project, and the
// GUI server on a fixed port.
//
//   bun run gui:demo                 then open the printed link
//   bun run gui:demo --port 4600 --token <16+ characters>    a link that stays the same: http://127.0.0.1:4600/#token=<token>
//   bun run gui:demo --update        the desktop app's Update button, with main 7 changes ahead (scripts/demo-update.ts)
//   bun run gui:demo --update fail   the same, with a build that fails
//
// Prompts with "sso" or "demo" walk through reading, editing (with approvals)
// and running tests; "question", "plan" and "todo" show those flows; the
// demo skills show in the / and $ menus.
//
// The Browser pane (side panel, Globe tab) needs a Chrome, Chromium, Edge or Brave on this machine, and shows:
//   empty             open the tab in a session where nothing has opened a page yet
//   agent driving     send "check the app in the browser" (a small site it serves; the click asks for approval)
//   you in control    click, type or scroll in the page; "Hand back to agent" gives it back
//   errors            no browser: CAVVY_BROWSER=/nope bun run gui:demo; a failed page: enter localhost:1 in the address bar;
//                     a crash: kill the "Chrome" process the demo started; a dialog: the page's "Send test" button

import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join, resolve } from "path";
import { startMockLlm } from "./mock-llm";
import { createDemoProject } from "./demo-project";
import { startDemoSite } from "./demo-site";
import { createDemoUpdate } from "./demo-update";

const args = process.argv.slice(2);
const arg = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
};
const root = arg("--dir") ?? mkdtempSync(join(tmpdir(), "cavvy-gui-demo-"));
const home = join(root, "home");
const project = join(root, "acme-platform");
mkdirSync(home, { recursive: true });
mkdirSync(project, { recursive: true });
createDemoProject(project);

const site = startDemoSite();
const mock = startMockLlm({ port: Number(arg("--mock-port") ?? 0), delayMs: Number(arg("--delay") ?? 14), site: site.url });
writeFileSync(join(home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock (demo)", baseUrl: mock.url, requiresKey: false, modelEffortLevels: { "mock-opus": ["low", "medium", "high", "xhigh", "max"] } }] }, null, 2));
writeFileSync(join(home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }, null, 2));
// A few skills for the / and $ menus ("use the release-notes skill" has the model load one).
const demoSkills: Record<string, string> = {
    "release-notes": "---\ndescription: Write release notes from the commits since the last tag\n---\nRead `git log` since the last tag and group the changes into Added, Changed and Fixed.",
    explain: "---\ndescription: Explain a file or module to a newcomer\nargument-hint: <path>\n---\nExplain $ARGUMENTS: what it's for, how it fits in, and where to start reading.",
    "security-review": "---\ndescription: Check the current changes for security problems\ndisable-model-invocation: true\n---\nReview the diff for injection, auth and secrets issues.",
};
for (const [name, text] of Object.entries(demoSkills)) {
    mkdirSync(join(home, "skills", name), { recursive: true });
    writeFileSync(join(home, "skills", name, "SKILL.md"), text);
}

const repo = resolve(import.meta.dir, "..");
const port = arg("--port") ?? "4600";
const env: Record<string, string> = { ...(process.env as Record<string, string>), CAVVY_HOME: home, CAVVY_NO_KEYCHAIN: "1" };
if (args.includes("--update")) Object.assign(env, createDemoUpdate(root, home, arg("--update") === "fail"));
if (arg("--token")) env.CAVVY_GUI_TOKEN = arg("--token")!;
const extra = arg("--dev-origin") ? ["--dev-origin", arg("--dev-origin")!] : [];
const proc = Bun.spawn(["bun", "--no-env-file", `--config=${join(repo, "bunfig.toml")}`, join(repo, "src/index.ts"), "serve", "--port", port, ...extra], {
    cwd: project,
    env,
    stdout: "inherit",
    stderr: "inherit",
});
process.stderr.write(`\n  demo project: ${project}\n  demo site:    ${site.url}  (for the Browser pane)\n  CAVVY_HOME: ${home}\n${arg("--token") ? `  fixed link:   http://127.0.0.1:${port}/#token=${arg("--token")}\n` : ""}\n`);
const stop = () => {
    proc.kill();
    mock.stop();
    site.stop();
    process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
await proc.exited;
mock.stop();
site.stop();
