// What held a process's thread: a .cpuprofile's runs of samples with no idle between them, of at least <min> ms, and
// for each the functions on its stack most of the time (inclusive and self). For a server profiled by
// scripts/bench-ramp.ts --profile (sampled every 1 ms): Bun records no idle samples, so a gap between two is idle.
//
//   bun scripts/profile-holds.ts <file.cpuprofile> [min ms, 15] [how many, 6]

import { readFileSync } from "node:fs";
const p = JSON.parse(readFileSync(process.argv[2]!, "utf8"));
const MIN = Number(process.argv[3] ?? 15);
const nodes = new Map<number, any>(p.nodes.map((n: any) => [n.id, n]));
const parent = new Map<number, number>();
for (const n of p.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
const name = (n: any) => `${n.callFrame.functionName || "(anon)"} ${String(n.callFrame.url).split("/").slice(-2).join("/")}:${n.callFrame.lineNumber + 1}`;
const idle = (id: number) => /^\((idle|program|garbage collector)\)$/.test(nodes.get(id)?.callFrame.functionName ?? "") && nodes.get(id)?.callFrame.functionName !== "(garbage collector)";
let t = p.startTime;
const times: number[] = [];
for (const d of p.timeDeltas) { t += d; times.push(t); }
const runs: { from: number; to: number; ids: number[] }[] = [];
let cur: { from: number; to: number; ids: number[] } | undefined;
p.samples.forEach((id: number, i: number) => {
    // A gap between samples is time the thread was idle (Bun records no idle samples).
    if (cur && p.timeDeltas[i] > 1500) { runs.push(cur); cur = undefined; }
    if (idle(id)) { if (cur) runs.push(cur); cur = undefined; return; }
    cur ??= { from: times[i]!, to: times[i]!, ids: [] };
    cur.to = times[i]!;
    cur.ids.push(id);
});
if (cur) runs.push(cur);
const long = runs.filter((r) => (r.to - r.from) / 1000 >= MIN).sort((a, b) => b.to - b.from - (a.to - a.from));
console.log(`${runs.length} busy runs; ${long.length} of ${MIN} ms or more`);
for (const r of long.slice(0, Number(process.argv[4] ?? 6))) {
    const incl = new Map<string, number>();
    const self = new Map<string, number>();
    for (const id of r.ids) {
        self.set(name(nodes.get(id)), (self.get(name(nodes.get(id))) ?? 0) + 1);
        const seen = new Set<string>();
        for (let x: number | undefined = id; x !== undefined; x = parent.get(x)) { const k = name(nodes.get(x)); if (!seen.has(k)) { seen.add(k); incl.set(k, (incl.get(k) ?? 0) + 1); } }
    }
    console.log(`\n== ${((r.to - r.from) / 1000).toFixed(1)} ms at ${((r.from - p.startTime) / 1e6).toFixed(2)} s, ${r.ids.length} samples`);
    const top = (m: Map<string, number>, n: number) => [...m].sort((a, b) => b[1] - a[1]).slice(0, n).map(([k, v]) => `  ${Math.round((v / r.ids.length) * 100)}% ${k}`).join("\n");
    console.log(" inclusive:\n" + top(new Map([...incl].filter(([k]) => !/^\(root\)|^\(anon\) $/.test(k))), 14));
    console.log(" self:\n" + top(self, 6));
}
