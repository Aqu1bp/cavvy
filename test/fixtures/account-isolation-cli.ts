// Safety gate and disk canary around the existing vendor-protocol fakes.
import { appendFileSync, mkdirSync, realpathSync, writeFileSync } from "fs";
import { homedir, tmpdir } from "os";
import { join, resolve, sep } from "path";

const provider = process.argv[2]!;
const home = realpathSync(homedir());
const root = process.env.HARNESS_TEST_ISOLATION_ROOT!;
if (!root || !home.startsWith(realpathSync(tmpdir()) + sep) || home !== join(root, "home") || process.env.HARNESS_NO_KEYCHAIN !== "1") throw new Error("Canary must run in a temporary HOME");
const env = Object.fromEntries(["HOME", "CLAUDE_CONFIG_DIR", "CLAUDE_SECURESTORAGE_CONFIG_DIR", "CODEX_HOME"].map((key) => [key, process.env[key] ?? null]));
const argv = process.argv.slice(3);
const folder = resolve(provider === "claude-code" ? process.env.CLAUDE_CONFIG_DIR || join(home, ".claude") : process.env.CODEX_HOME || join(home, ".codex"));
if (!folder.startsWith(root + sep)) throw new Error("Fake CLI refused a config folder outside the canary");
mkdirSync(folder, { recursive: true });
// Default markers are preseeded with these bytes so normal Default use remains
// byte-for-byte unchanged. Explicit named operations also leave a distinct marker.
writeFileSync(join(folder, "cli-canary"), `${provider}\n`);
const phase = process.env.HARNESS_TEST_ISOLATION_PHASE ?? "";
if (/^turn-.*-work$/.test(phase) || (/^login-.*-work$/.test(phase) && argv.includes("login"))) writeFileSync(join(folder, "named-account-canary"), `${provider}\n`);
appendFileSync(process.env.HARNESS_TEST_ISOLATION_LOG!, JSON.stringify({ provider, argv, env, folder, phase: process.env.HARNESS_TEST_ISOLATION_PHASE }) + "\n");
process.argv = [process.execPath, import.meta.path, ...argv];
await import(provider === "claude-code" ? "./fake-claude" : "./fake-codex");
