// Edit-to-diagnostics latency and server memory, against a real language
// server on a real project. Nothing is written to disk: the edits are sent
// to the server only.
//
//   bun scripts/lsp-bench.ts [project] [file]     defaults: this repo, src/lsp/diagnostics.ts

import { readFileSync } from "fs";
import { resolve } from "path";
import { LspManager } from "../src/lsp/manager";

const root = resolve(process.argv[2] ?? resolve(import.meta.dir, ".."));
const file = resolve(root, process.argv[3] ?? "src/lsp/diagnostics.ts");
const original = readFileSync(file, "utf-8");
const broken = `${original}\nexport const lspBenchBroken: number = "not a number";\n`;
const m = new LspManager({ root, settings: () => ({}) });

async function time(label: string, text: string) {
    const t = performance.now();
    const r = await m.afterEdit(file, text);
    const ms = Math.round(performance.now() - t);
    const what = r ? r.files.map((f) => `${f.path}: ${f.newErrors} new errors, ${f.fixed} fixed`).join("; ") : "no news";
    console.log(`${label.padEnd(34)} ${String(ms).padStart(6)} ms   ${what}`);
    return ms;
}

/** Resident memory of a process and everything under it, in MB. */
function treeRss(pid: number): number {
    const ps = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,rss="]).stdout.toString().trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
    const kids = new Map<number, number[]>();
    for (const [p, pp] of ps) kids.set(pp!, [...(kids.get(pp!) ?? []), p!]);
    const rss = new Map(ps.map(([p, , r]) => [p!, r!]));
    let total = 0;
    const walk = (p: number) => {
        total += rss.get(p) ?? 0;
        for (const k of kids.get(p) ?? []) walk(k);
    };
    walk(pid);
    return Math.round(total / 1024);
}

console.log(`project ${root}\nfile    ${file}\n`);
await time("cold start, first edit (clean)", original);
const warm: number[] = [];
for (let i = 0; i < 5; i++) {
    warm.push(await time(`warm: add a type error (${i + 1})`, broken));
    warm.push(await time(`warm: fix it (${i + 1})`, original));
}
const quiet: number[] = [];
for (let i = 0; i < 3; i++) quiet.push(await time(`warm: clean edit stays clean (${i + 1})`, `${original}\n// ${i}\n`));
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\nmedian warm error/fix: ${median(warm)} ms · median clean edit: ${median(quiet)} ms`);
for (const s of m.status()) console.log(`${s.name} (pid ${s.pid}): ${treeRss(s.pid!)} MB resident, server and its children`);
await m.dispose();
