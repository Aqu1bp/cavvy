// Says whether the agent CLIs installed here are newer than the ones Cavvy's protocol fixtures were recorded on
// (test/fixtures): when one is, its probes are due again (docs/cli-protocol-probes.md). Run before a release:
//   bun scripts/probes/check-versions.ts

import { readdirSync, readFileSync, statSync } from "fs";
import { join, resolve } from "path";

const FIXTURES = resolve(import.meta.dir, "..", "..", "test", "fixtures");

/** How each CLI's version shows in a recorded frame, and how it says its own. */
const CLIS = [
    { name: "Claude Code", command: "claude", recorded: /"claude_code_version":\s*"(\d+\.\d+\.\d+)"/g },
    { name: "Codex", command: "codex", recorded: /"userAgent":\s*"[^"/]*\/(\d+\.\d+\.\d+)/g },
];

function files(dir: string): string[] {
    return readdirSync(dir).flatMap((n) => {
        const p = join(dir, n);
        return statSync(p).isDirectory() ? files(p) : /\.jsonl?$/.test(n) ? [p] : [];
    });
}

const newer = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }) > 0;

const texts = files(FIXTURES).map((f) => readFileSync(f, "utf-8"));
let due = false;
for (const cli of CLIS) {
    let recorded: string | undefined;
    for (const t of texts) for (const m of t.matchAll(cli.recorded)) if (!recorded || newer(m[1]!, recorded)) recorded = m[1]!;
    const bin = Bun.which(cli.command);
    const said = bin ? Bun.spawnSync([bin, "--version"], { stdout: "pipe", stderr: "ignore" }).stdout.toString() : "";
    const installed = /\d+\.\d+\.\d+/.exec(said)?.[0];
    const behind = Boolean(installed && recorded && newer(installed, recorded));
    due ||= behind;
    console.log(`${cli.name}: ${installed ? `${installed} here` : "not installed here"}, fixtures recorded up to ${recorded ?? "none"}${behind ? ": run its probes again" : ""}`);
}
if (due) console.log("\nThe probes are in scripts/probes; what they found last time is in docs/cli-protocol-probes.md.");
