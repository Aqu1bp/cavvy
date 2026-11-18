// The checks only a Mac can make, in one command, against a baseline: the home screen's memory and CPU; waiting on a
// model with the window in front, behind another app, hidden and minimized (Cavvy's CPU and WindowServer's); memory
// with 1, 5 and 15 sessions open; opening two 100,000-item sessions cold and again; frames reading one up 20 pages.
// Prints a table of each against desktop-electron/bench-mac-baseline.json and flags what's worse than its allowance.
//
//   bun desktop-electron/bench-mac.ts --app <…>/Cavvy.app [--label x] [--only home,persession,cold100k,scroll,waiting]
//   bun desktop-electron/bench-mac.ts --results <label>       # compare a run already in bench-results/, without running
//   … --save-baseline                                         # and make this run the baseline (commit the file)
//
// On a quiet Mac, plugged in, nothing else open: about 20 minutes. It runs bench-heavy.ts (home, persession, cold100k,
// scroll) and bench-stream.ts (waitingOnScreen, waitingUnfocused, waitingHidden, waitingMinimized); their own results
// stay in bench-results/. Exits 1 when anything is flagged.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const args = process.argv.slice(2);
const arg = (n: string) => (args.includes(n) ? args[args.indexOf(n) + 1] : undefined);
const repo = resolve(import.meta.dir, "..");
const results = join(import.meta.dir, "bench-results");
const baselineFile = arg("--baseline") ?? join(import.meta.dir, "bench-mac-baseline.json");
const only = (arg("--only") ?? "home,persession,cold100k,scroll,waiting").split(",");

/** How much worse than the baseline a figure may be before it's flagged: a share of it, and at least an amount. */
type Allow = { share: number; atLeast: number };
const MEMORY: Allow = { share: 0.1, atLeast: 10 };
const CPU: Allow = { share: 0.25, atLeast: 0.3 };
const MS: Allow = { share: 0.2, atLeast: 10 };
const FRAMES: Allow = { share: 0.5, atLeast: 5 };
const NONE: Allow = { share: 0, atLeast: 0 };

/** Each figure: its name, its unit, how to read it from the runs' results, and its allowance. Higher is worse for all. */
const FIGURES: { name: string; unit: string; part: string; read: (heavy: any, stream: any) => number | undefined; allow: Allow }[] = [
    { name: "Home: memory", unit: "MB", part: "home", read: (h) => h?.home?.memory?.total, allow: MEMORY },
    { name: "Home: CPU", unit: "% core", part: "home", read: (h) => h?.home?.cpuPercent, allow: CPU },
    ...(["waitingOnScreen", "waitingUnfocused", "waitingHidden", "waitingMinimized"] as const).flatMap((phase) => {
        const words = { waitingOnScreen: "in front", waitingUnfocused: "behind another app", waitingHidden: "hidden", waitingMinimized: "minimized" }[phase];
        const p = (s: any) => (s?.phases?.[phase]?.invalid ? undefined : s?.phases?.[phase]);
        return [
            { name: `Waiting, ${words}: Cavvy`, unit: "% core", part: "waiting", read: (_h: any, s: any) => p(s)?.appTotal, allow: CPU },
            { name: `Waiting, ${words}: WindowServer`, unit: "% core", part: "waiting", read: (_h: any, s: any) => p(s)?.cpuPercent?.WindowServer, allow: CPU },
        ];
    }),
    ...([1, 5, 15] as const).map((n) => ({ name: `Memory, ${n} session${n > 1 ? "s" : ""} open`, unit: "MB", part: "persession", read: (h: any) => h?.persession?.at?.[n]?.memory?.total, allow: MEMORY })),
    { name: "Memory per session (1 to 15)", unit: "MB", part: "persession", read: (h) => h?.persession?.perSessionMB, allow: { share: 0.25, atLeast: 2 } },
    ...(["native", "cli"] as const).flatMap((kind) => {
        const which = kind === "native" ? "Cavvy's own" : "Claude Code";
        return [
            { name: `100,000 items, ${which}: open cold`, unit: "ms", part: "cold100k", read: (h: any) => positive(h?.cold100k?.cold?.[kind]), allow: MS },
            { name: `100,000 items, ${which}: open again`, unit: "ms", part: "cold100k", read: (h: any) => positive(h?.cold100k?.back?.[kind]), allow: MS },
            { name: `Scroll up 20 pages, ${which}: frames over 25 ms`, unit: "frames", part: "scroll", read: (h: any) => h?.scroll?.[kind]?.over25, allow: FRAMES },
            { name: `Scroll up 20 pages, ${which}: worst frame`, unit: "ms", part: "scroll", read: (h: any) => h?.scroll?.[kind]?.worstMs, allow: MS },
            { name: `Scroll up 20 pages, ${which}: blank frames`, unit: "frames", part: "scroll", read: (h: any) => h?.scroll?.[kind]?.blank, allow: NONE },
        ];
    }),
];
/** An open that never showed (-1) is no figure. */
const positive = (x: unknown) => (typeof x === "number" && x >= 0 ? x : undefined);

function run(script: string, scriptArgs: string[]) {
    console.error(`\n$ bun desktop-electron/${script} ${scriptArgs.join(" ")}`);
    const r = Bun.spawnSync(["bun", "--no-env-file", join("desktop-electron", script), ...scriptArgs], { cwd: repo, stdout: "ignore", stderr: "inherit" });
    if (r.exitCode !== 0) console.error(`${script} exited ${r.exitCode}: its results say how far it got.`);
}

const read = (file: string) => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined);

if (import.meta.main) {
    if (process.platform !== "darwin" && !arg("--results")) {
        console.error("bench-mac.ts measures a packaged Mac app (footprint, WindowServer, instruction counts): run it on a Mac.");
        process.exit(2);
    }
    let label = arg("--results");
    if (!label) {
        const app = arg("--app");
        if (!app || !existsSync(join(app, "Contents/MacOS/cavvy-desktop"))) {
            console.error("usage: bun desktop-electron/bench-mac.ts --app <…>/Cavvy.app [--label x] [--only …] [--save-baseline]");
            process.exit(2);
        }
        label = arg("--label") ?? `mac-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "")}`;
        const heavyParts = ["home", "persession", "cold100k", "scroll"].filter((p) => only.includes(p));
        // The scroll check reads the sessions the cold opens write.
        if (heavyParts.includes("scroll") && !heavyParts.includes("cold100k")) heavyParts.splice(heavyParts.indexOf("scroll"), 0, "cold100k");
        if (heavyParts.length) run("bench-heavy.ts", ["--label", label, "--app", app, "--only", heavyParts.join(",")]);
        if (only.includes("waiting")) run("bench-stream.ts", ["--label", label, "--app", join(app, "Contents/MacOS/cavvy-desktop"), "--seconds", "30", "--only", "waitingOnScreen,waitingUnfocused,waitingHidden,waitingMinimized"]);
    }
    const heavy = read(join(results, `bench-heavy-${label}.json`));
    const stream = read(join(results, `bench-stream-${label}.json`));
    if (heavy?.error) console.error(`bench-heavy: ${String(heavy.error).split("\n")[0]}`);
    if (stream?.error) console.error(`bench-stream: ${String(stream.error).split("\n")[0]}`);
    const focus = stream?.phases?.waitingUnfocused?.focus;
    if (focus?.page) console.error("Behind another app: the page still had the focus, so that row measured the window in front.");

    const baseline = read(baselineFile) ?? { figures: {} };
    const rows: string[][] = [];
    let flagged = 0;
    const now: Record<string, number> = {};
    for (const f of FIGURES) {
        const value = f.read(heavy, stream);
        if (value === undefined) continue;
        now[f.name] = value;
        const was = baseline.figures?.[f.name] as number | null | undefined;
        let change = "", flag = "";
        if (typeof was === "number") {
            const allowed = Math.max(was * f.allow.share, f.allow.atLeast);
            const diff = value - was;
            change = `${diff >= 0 ? "+" : ""}${round(diff)}${was ? ` (${diff >= 0 ? "+" : ""}${Math.round((diff / was) * 100)}%)` : ""}`;
            if (diff > allowed) (flag = `WORSE (allowed +${round(allowed)})`), flagged++;
            else if (-diff > allowed && allowed > 0) flag = "better";
        } else change = "no baseline";
        rows.push([f.name, f.unit, typeof was === "number" ? String(round(was)) : "-", String(round(value)), change, flag]);
    }
    const head = ["Check", "Unit", "Baseline", "Now", "Change", ""];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
    const line = (r: string[]) => r.map((c, i) => c.padEnd(widths[i]!)).join("  ").trimEnd();
    console.log(`\n${line(head)}\n${widths.map((w) => "-".repeat(w)).join("  ")}\n${rows.map(line).join("\n")}`);
    console.log(`\n${rows.length} checks, ${flagged} worse than allowed. Baseline: ${baseline.label ?? "none"}${baseline.note ? ` (${baseline.note})` : ""}.`);
    if (args.includes("--save-baseline")) {
        writeFileSync(baselineFile, JSON.stringify({ label, at: new Date().toISOString(), figures: { ...baseline.figures, ...now } }, null, 1) + "\n");
        console.log(`Saved as the baseline: ${baselineFile}`);
    }
    process.exit(flagged ? 1 : 0);
}

function round(x: number) {
    return Math.abs(x) >= 10 ? Math.round(x) : Math.round(x * 100) / 100;
}
