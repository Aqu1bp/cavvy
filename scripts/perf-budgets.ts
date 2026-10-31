// test/perf-budgets.json, checked where the tests can't: what the built GUI loads at startup, and that a change doesn't
// raise a budget to make room for itself (AGENTS.md, Performance).
//
//   bun scripts/perf-budgets.ts bundle              gui/dist (after `bun run gui:build`) against its budgets
//   bun scripts/perf-budgets.ts ratchet <base.json> the budgets here against the base branch's

import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const repo = resolve(import.meta.dir, "..");
type Budgets = Record<string, number>;
const read = (file: string) => JSON.parse(readFileSync(file, "utf8")) as Budgets;

/** What index.html has the browser fetch before anything is on screen. */
export function eagerAssets(html: string): { js: string[]; css: string[] } {
    const links = [...html.matchAll(/<(?:script[^>]*\bsrc|link[^>]*\bhref)="([^"]+)"/g)].map((m) => m[1]!.replace(/^\.?\//, ""));
    return { js: links.filter((l) => l.endsWith(".js")), css: links.filter((l) => l.endsWith(".css")) };
}

/** Each budget that went up, or was dropped, from `base` to `head`. A new budget is fine. */
export function raised(base: Budgets, head: Budgets): string[] {
    return Object.entries(base).flatMap(([name, was]) => (!(name in head) ? [`${name}: removed (was ${was})`] : head[name]! > was ? [`${name}: ${was} -> ${head[name]}`] : []));
}

if (import.meta.main) {
    const [command, file] = process.argv.slice(2);
    const budgets = read(join(repo, "test/perf-budgets.json"));
    if (command === "ratchet" && file) {
        const up = raised(read(file), budgets);
        if (up.length) {
            console.error(`Performance budgets went up. Make the code cheaper, or label the PR perf-budget-raise and say why:\n  ${up.join("\n  ")}`);
            process.exit(1);
        }
    } else if (command === "bundle") {
        const dist = join(repo, "gui/dist");
        const assets = eagerAssets(readFileSync(join(dist, "index.html"), "utf8"));
        const size = (files: string[]) => files.reduce((sum, f) => sum + statSync(join(dist, f)).size, 0);
        const failures: string[] = [];
        for (const [name, measured] of [["guiEagerJsBytes", size(assets.js)], ["guiEagerCssBytes", size(assets.css)]] as const) {
            console.log(`${name}: ${measured} (budget ${budgets[name]})`);
            if (measured > budgets[name]!) failures.push(`${name}: ${measured}, over its budget of ${budgets[name]}`);
            else if (measured < budgets[name]! * 0.9) failures.push(`${name}: ${measured}: lower its budget from ${budgets[name]}`);
        }
        if (failures.length) {
            console.error(failures.join("\n"));
            process.exit(1);
        }
    } else {
        console.error("usage: perf-budgets.ts bundle | ratchet <base.json>");
        process.exit(2);
    }
}
