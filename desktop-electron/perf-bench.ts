// How one packaged build compares with another, on a quiet Mac: streaming, waiting on a model, idle, startup and each
// interaction, the builds taking turns so whatever else the machine does falls on both. Instructions retired are the
// gauge for work: CPU% moves with which cores macOS picks, and WindowServer's share includes every other app.
//
//   bun run perf:bench --app <new>/Cavvy.app --compare <old>/Cavvy.app [--runs 2] [--only stream,startup,ux] [--throttle 4]
//
// Writes the benches' own results to desktop-electron/bench-results/, and prints the table. Real models: bench-real.ts.

import { join } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const app = arg("--app");
const compare = arg("--compare");
if (!app) throw new Error("usage: perf-bench.ts --app <Cavvy.app> [--compare <Cavvy.app>] [--runs 2] [--only stream,startup,ux] [--throttle 4]");
const runs = Number(arg("--runs") ?? 2);
const only = (arg("--only") ?? "stream,startup,ux").split(",");
const here = import.meta.dir;
const results = join(here, "bench-results");
const exe = (a: string) => join(a, "Contents/MacOS/cavvy-desktop");
const builds = [...(compare ? [["old", compare]] : []), ["new", app]] as [string, string][];
const PHASES = "idleLongOnScreen,waitingOnScreen,textShortOnScreen,textLongOnScreen,cmdLongOnScreen,textLongOffScreen,idleShortOnScreen";

function bench(script: string, label: string, target: string, extra: string[] = []) {
    console.error(`${script} ${label}`);
    const run = Bun.spawnSync(["caffeinate", "-dim", "bun", join(here, script), "--label", label, "--app", exe(target), ...extra], { stdout: "ignore", stderr: "ignore" });
    if (run.exitCode) console.error(`  exited ${run.exitCode}`);
}

const json = async (file: string) => Bun.file(file).json().catch(() => undefined) as Promise<any>;
const median = (xs: number[]) => { const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)]! : NaN; };
function row(name: string, values: Record<string, number>) {
    const was = values.old, now = values.new!;
    const change = was !== undefined && was > 0 ? `${now >= was ? "+" : ""}${Math.round(((now - was) / was) * 100)}%` : "";
    console.log(`${name.padEnd(38)} ${compare ? String(Math.round(was ?? NaN)).padStart(8) : ""} ${String(Math.round(now)).padStart(8)} ${change.padStart(7)}`);
}
const table = (title: string) => console.log(`\n${title.padEnd(38)} ${compare ? "old".padStart(8) : ""} ${"new".padStart(8)}`);

for (let r = 1; r <= runs; r++) for (const [name, target] of builds) {
    if (only.includes("stream")) bench("bench-stream.ts", `pb-${name}-${r}`, target, ["--only", PHASES, ...(arg("--seconds") ? ["--seconds", arg("--seconds")!] : [])]);
    if (only.includes("startup")) bench("bench-startup.ts", `pb-${name}-${r}`, target);
    if (only.includes("ux")) bench("bench-ux.ts", `pb-${name}-${r}`, target, arg("--throttle") ? ["--throttle", arg("--throttle")!] : []);
}

/** The runs of a bench that finished; a run that failed or is missing is said out loud, and left out. */
async function load(kind: string, name: string) {
    const all = await Promise.all(Array.from({ length: runs }, (_, i) => json(join(results, `bench-${kind}-pb-${name}-${i + 1}.json`))));
    all.forEach((r, i) => { if (!r || r.error) console.error(`WARNING: ${kind} run ${i + 1} of ${name} ${r ? `failed: ${r.error}` : "is missing"}`); });
    return all.filter((r) => r && !r.error);
}
if (only.includes("stream")) {
    const by = Object.fromEntries(await Promise.all(builds.map(async ([name]) => [name, await load("stream", name)])));
    table("Work: million instructions/s");
    for (const phase of PHASES.split(",")) {
        for (const [name] of builds) for (const r of by[name] ?? []) if (r.phases[phase]?.invalid) console.error(`WARNING: ${phase} of ${name} left out: ${r.phases[phase].invalid}`);
        const of = (name: string, f: (p: any) => number) => median((by[name] ?? []).map((r: any) => (r.phases[phase] && !r.phases[phase].invalid ? f(r.phases[phase]) : NaN)));
        const pick = (f: (p: any) => number) => Object.fromEntries(builds.map(([n]) => [n, of(n, f)]));
        row(phase, pick((p) => ["ui", "gpu", "main", "server"].reduce((sum, k) => sum + (p.mips?.[k] ?? 0), 0)));
        row("  of which GPU", pick((p) => p.mips?.gpu ?? 0));
    }
}
if (only.includes("startup")) {
    const by = await Promise.all(builds.map(async ([name]) => [name, median((await load("startup", name)).flatMap((r: any) => r.launches.slice(1).map((l: any) => l.interactive)))] as const));
    table("Startup: ms to the composer (cached)");
    row("median", Object.fromEntries(by));
}
if (only.includes("ux")) {
    const by = Object.fromEntries(await Promise.all(builds.map(async ([name]) => [name, await load("ux", name)])));
    const names = [...new Set(Object.values(by).flat().flatMap((r: any) => Object.keys(r.interactions ?? {})))] as string[];
    table("Interactions: ms, click to frame");
    for (const n of names) {
        const pick = Object.fromEntries(builds.map(([b]) => [b, median((by[b] ?? []).map((r: any) => r.interactions[n]?.ms))]));
        if (Object.values(pick).every((v) => Number.isFinite(v))) row(n, pick);
    }
}
