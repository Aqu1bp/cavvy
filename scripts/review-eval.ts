// Measure the auto-mode reviewer on a labeled set of actions
// (test/fixtures/review-eval.json): how often it blocks routine work, how
// often it lets through what it should block, and how long it takes. It calls
// the reviewer model (reviewModel in your user settings, or Claude Sonnet 5.5
// with an Anthropic key) once or twice per case, on your key. The cases are
// made up; nothing from your projects is sent.
//
//   bun run review:eval                       every case once
//   bun run review:eval --model anthropic:claude-haiku-5-5
//   bun run review:eval --only push-unasked,rm-dist --repeat 3

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { AutoClassifier, REVIEW_REQUEST, reviewText, type ClassifierInput, type ReviewStage } from "../src/permissions/classifier";
import { reviewTarget } from "../src/providers/models";
import { costOf } from "../src/providers/pricing";
import { modelRef } from "../src/providers/types";
import { loadScope } from "../src/config/settings";
import { redact } from "../src/util/redact";

interface Case {
    id: string;
    want: "allow" | "block";
    toolName: string;
    input: Record<string, unknown>;
    sandboxed?: boolean;
    requests: string[];
    delegatedTask?: string;
    note?: string;
}

const args = process.argv.slice(2);
const arg = (n: string) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
};

const target = await reviewTarget(arg("--model") ?? loadScope("user", homedir()).reviewModel);
if (!target) {
    console.error("No reviewer model: set reviewModel, add an Anthropic key, or pass --model provider:model.");
    process.exit(1);
}
const only = arg("--only")?.split(",");
const repeat = Math.max(1, Number(arg("--repeat") ?? 1));
const cases = (JSON.parse(readFileSync(join(import.meta.dir, "../test/fixtures/review-eval.json"), "utf-8")) as Case[]).filter((c) => !only || only.includes(c.id));

let cost = 0;
const stageMs: Record<ReviewStage, number[]> = { fast: [], full: [] };
interface Row {
    c: Case;
    got: string;
    ms: number;
    stages: ReviewStage[];
    reason: string;
}
const rows: Row[] = [];

for (let r = 0; r < repeat; r++) {
    for (const c of cases) {
        const stages: ReviewStage[] = [];
        // A fresh reviewer each time: no cached verdicts, no blocks counted from other cases.
        const reviewer = new AutoClassifier(async (system, prompt, signal, opts) => {
            const stage = opts?.review ?? "full";
            stages.push(stage);
            const t0 = performance.now();
            const res = await target.client.stream({ model: target.model, system, messages: [{ role: "user", content: [{ type: "text", text: redact(prompt) }] }], tools: [], lightweight: true, signal, ...REVIEW_REQUEST[stage] }, () => {});
            stageMs[stage].push(performance.now() - t0);
            if (res.usage) cost += costOf(res.usage, target.model).usd ?? 0;
            return reviewText(res);
        });
        const input: ClassifierInput = { toolName: c.toolName, input: c.input, cwd: "/Users/dev/acme-platform", sandboxed: c.sandboxed, context: { requests: c.requests, delegatedTask: c.delegatedTask } };
        const v = await reviewer.classify(input);
        rows.push({ c, got: v.decision, ms: v.ms ?? 0, stages, reason: v.reason });
        const ok = v.decision === c.want;
        console.log(`${ok ? "ok  " : v.decision === "ask" ? "??  " : "MISS"} ${c.id.padEnd(28)} want ${c.want.padEnd(5)} got ${v.decision.padEnd(5)} ${String(Math.round(v.ms ?? 0)).padStart(6)}ms ${stages.join("+").padEnd(9)} ${v.reason}`);
    }
}

const pct = (n: number, d: number) => (d ? `${((100 * n) / d).toFixed(1)}%` : "-");
const quantile = (xs: number[], q: number) => {
    if (!xs.length) return 0;
    const s = [...xs].sort((a, b) => a - b);
    return Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))]!);
};
const routine = rows.filter((x) => x.c.want === "allow");
const risky = rows.filter((x) => x.c.want === "block");
const falseBlocks = routine.filter((x) => x.got === "block");
const misses = risky.filter((x) => x.got === "allow");
const undecided = rows.filter((x) => x.got === "ask");
const all = rows.map((x) => x.ms);

console.log(`\nReviewer: ${modelRef(target.model)}, ${rows.length} reviews`);
console.log(`Routine actions blocked: ${falseBlocks.length}/${routine.length} (${pct(falseBlocks.length, routine.length)})${falseBlocks.length ? `: ${[...new Set(falseBlocks.map((x) => x.c.id))].join(", ")}` : ""}`);
console.log(`Risky actions let through: ${misses.length}/${risky.length} (${pct(misses.length, risky.length)})${misses.length ? `: ${[...new Set(misses.map((x) => x.c.id))].join(", ")}` : ""}`);
console.log(`Couldn't decide (sent to you): ${undecided.length}${undecided.length ? `: ${[...new Set(undecided.map((x) => x.c.id))].join(", ")}` : ""}`);
console.log(`Settled by the quick check: ${pct(rows.filter((x) => x.stages.length === 1 && x.got === "allow").length, rows.length)}`);
console.log(`Review time: median ${quantile(all, 0.5)}ms, p95 ${quantile(all, 0.95)}ms, max ${quantile(all, 1)}ms`);
console.log(`  quick check: median ${quantile(stageMs.fast, 0.5)}ms, p95 ${quantile(stageMs.fast, 0.95)}ms; verdict: median ${quantile(stageMs.full, 0.5)}ms, p95 ${quantile(stageMs.full, 0.95)}ms`);
console.log(`Cost: about $${cost.toFixed(3)}`);
