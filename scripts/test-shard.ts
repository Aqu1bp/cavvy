// Runs one CI shard of the test suite. Test files are split across shards by
// how long each took in CI (test/timings.json), so the shards finish together;
// `bun test --shard` splits by file count, which left one shard four times
// slower than the others.
//
//   bun scripts/test-shard.ts <shard> <total> [bun test options…]
//   bun scripts/test-shard.ts --timings <junit.xml…>   rewrite test/timings.json from CI JUnit reports
//
// A file missing from the timings (a new one) counts as the median file.

import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const root = join(import.meta.dir, "..");
const timingsPath = join(root, "test", "timings.json");

// The files `bun test` finds under test/ (bunfig.toml's root): its four
// name patterns, skipping node_modules and hidden directories.
function testFiles(): string[] {
    const glob = new Bun.Glob("**/*{.test,_test,.spec,_spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}");
    const files: string[] = [];
    for (const path of glob.scanSync({ cwd: join(root, "test"), dot: false })) {
        if (path.split("/").includes("node_modules")) continue;
        files.push(`test/${path}`);
    }
    return files.sort();
}

function readTimings(): Record<string, number> {
    if (!existsSync(timingsPath)) return {};
    return JSON.parse(readFileSync(timingsPath, "utf8"));
}

// Longest file first onto the least loaded shard. Every shard computes the
// same split from the same inputs, so together they run each file once.
export function split(files: string[], timings: Record<string, number>, total: number): string[][] {
    const known = files.map(f => timings[f]).filter((t): t is number => typeof t === "number").sort((a, b) => a - b);
    const median = known.length ? known[Math.floor(known.length / 2)]! : 1;
    const cost = (f: string) => timings[f] ?? median;
    const shards = Array.from({ length: total }, () => ({ files: [] as string[], load: 0 }));
    const ordered = [...files].sort((a, b) => cost(b) - cost(a) || a.localeCompare(b));
    for (const file of ordered) {
        let target = shards[0]!;
        for (const shard of shards) if (shard.load < target.load) target = shard;
        target.files.push(file);
        target.load += cost(file);
    }
    return shards.map(s => s.files.sort());
}

// Each JUnit report has one top-level <testsuite> per file, whose name is the
// file's path; nested ones are named after their describe blocks.
function timingsFromJUnit(paths: string[]): Record<string, number> {
    const timings: Record<string, number> = {};
    for (const path of paths) {
        const xml = readFileSync(path, "utf8");
        for (const m of xml.matchAll(/<testsuite name="([^"]+)" file="([^"]+)"[^>]*? time="([0-9.]+)"/g)) {
            if (m[1] !== m[2]) continue;
            timings[m[1]!] = Math.round(Number(m[3]) * 10) / 10;
        }
    }
    return Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b)));
}

if (import.meta.main) {
    const args = process.argv.slice(2);
    if (args[0] === "--timings") {
        const timings = timingsFromJUnit(args.slice(1));
        writeFileSync(timingsPath, JSON.stringify(timings, null, 4) + "\n");
        console.log(`Wrote ${Object.keys(timings).length} file timings to test/timings.json`);
        process.exit(0);
    }
    const shard = Number(args[0]), total = Number(args[1]);
    if (!Number.isInteger(shard) || !Number.isInteger(total) || shard < 1 || shard > total) {
        console.error("usage: bun scripts/test-shard.ts <shard> <total> [bun test options…]");
        process.exit(2);
    }
    const timings = readTimings();
    const files = split(testFiles(), timings, total)[shard - 1]!;
    if (!files.length) {
        console.log(`Shard ${shard}/${total} has no test files.`);
        process.exit(0);
    }
    const expected = files.reduce((sum, f) => sum + (timings[f] ?? 0), 0);
    console.log(`Shard ${shard}/${total}: ${files.length} files, about ${Math.round(expected)}s by the last timings`);
    // A leading "./" makes bun take each argument as a path rather than a substring filter.
    const proc = Bun.spawn([process.execPath, "--no-env-file", "test", ...args.slice(2), ...files.map(f => `./${f}`)], {
        cwd: root, stdio: ["inherit", "inherit", "inherit"],
    });
    process.exit(await proc.exited);
}
