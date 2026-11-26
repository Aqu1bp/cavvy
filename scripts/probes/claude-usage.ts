// Claude Code's /usage in print mode: answered without a model call (no turns, no cost), as text for people.
// Writes test/fixtures/limits/claude-usage-<version>[-<name>].json: the result's fields that say it was answered
// locally, and the text up to its window lines. The tips after them (about this machine's sessions) are never kept.
//   bun scripts/probes/claude-usage.ts [name]        (CLAUDE_CONFIG_DIR picks another account)
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scrub } from "./lib";

const name = process.argv[2];
const version = spawnSync("claude", ["--version"], { encoding: "utf8" }).stdout.trim().split(/\s+/)[0];
const started = Date.now();
const r = spawnSync("claude", ["-p", "/usage", "--output-format", "json", "--no-session-persistence", "--strict-mcp-config", "--settings", JSON.stringify({ disableAllHooks: true })], {
    cwd: mkdtempSync(join(tmpdir(), "usage-probe-")),
    encoding: "utf8",
    env: { ...process.env, TZ: "UTC" },
});
const j = JSON.parse(r.stdout);
const text = String(j.result ?? "");
// The plan's own lines only, up to the first section after them (its tips): the first line, and each window's.
const cut = text.search(/\n\s*What's contributing/i);
const kept = (cut < 0 ? text : text.slice(0, cut)).split("\n").filter((l, i) => i === 0 || !l.trim() || /^[^:]{1,60}:\s*\d+(?:\.\d+)?%\s*used\b/i.test(l));
const out = scrub({
    version,
    at: started,
    local_command: j.local_command,
    num_turns: j.num_turns,
    total_cost_usd: j.total_cost_usd,
    result: kept.join("\n").trimEnd(),
});
const file = new URL(`../../test/fixtures/limits/claude-usage-${version}${name ? `-${name}` : ""}.json`, import.meta.url).pathname;
writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
console.log(`${file}\n${out.result}`);
