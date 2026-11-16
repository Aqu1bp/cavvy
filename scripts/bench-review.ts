// How long the review takes to answer with 5,000 changed files (B in docs/performance-targets-v2.md).
//
//   bun scripts/bench-review.ts [--files 5000] [--runs 12]
//
// Builds a scratch repository of --files files of 40 lines, commits it, changes each file
// (one line replaced, two added), then asks for its uncommitted changes --runs times. The first
// two runs are dropped (the first hashes every file). Prints the median and the range of the
// rest, and `git status` on the same tree for comparison.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitChanges } from "../src/server/git-changes.ts";

const arg = (name: string, fallback: number) => {
    const i = process.argv.indexOf(`--${name}`);
    return i > 0 ? Number(process.argv[i + 1]) : fallback;
};
const files = arg("files", 5000);
const runs = Math.max(3, arg("runs", 12));

const dir = mkdtempSync(join(tmpdir(), "cavvy-bench-review-"));
const git = (...args: string[]) => execFileSync("git", ["-c", "user.name=bench", "-c", "user.email=bench@example.com", ...args], { cwd: dir, stdio: ["ignore", "pipe", "inherit"], maxBuffer: 1 << 28 });
const path = (i: number) => join(dir, "gen", `m${String(Math.floor(i / 100)).padStart(2, "0")}`, `f${String(i).padStart(4, "0")}.ts`);
const lines = (i: number) => Array.from({ length: 40 }, (_, n) => `export const v${n} = ${n}; // line ${n} of file ${i}`);

try {
    git("init", "-q");
    for (let i = 0; i < files; i++) {
        mkdirSync(join(path(i), ".."), { recursive: true });
        writeFileSync(path(i), lines(i).join("\n") + "\n");
    }
    git("add", "-A");
    git("commit", "-q", "-m", "files");
    for (let i = 0; i < files; i++) {
        const l = lines(i);
        l[20] = `export const v20 = ${i}; // changed`;
        writeFileSync(path(i), [...l, "export const added = 1;", "export const more = 2;"].join("\n") + "\n");
    }

    const time = async (fn: () => unknown) => {
        const t = performance.now();
        await fn();
        return performance.now() - t;
    };
    const summary = (xs: number[]) => {
        const w = xs.slice(2).sort((a, b) => a - b);
        return `median ${Math.round(w[Math.floor(w.length / 2)]!)} ms (${Math.round(w[0]!)}-${Math.round(w.at(-1)!)})`;
    };
    const review: number[] = [];
    let listed = 0;
    let more = 0;
    for (let i = 0; i < runs; i++)
        review.push(
            await time(async () => {
                const r = (await gitChanges(dir, { scope: "uncommitted" })) as { files?: unknown[]; more?: number };
                listed = r.files?.length ?? 0;
                more = r.more ?? 0;
            }),
        );
    const status: number[] = [];
    for (let i = 0; i < runs; i++) status.push(await time(() => git("status", "--porcelain")));
    console.log(`${files} changed files, ${listed} listed with diffs, ${more} more`);
    console.log(`review: ${summary(review)}`);
    console.log(`git status: ${summary(status)}`);
} finally {
    rmSync(dir, { recursive: true, force: true });
}
