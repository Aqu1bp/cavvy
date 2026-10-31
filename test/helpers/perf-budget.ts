// test/perf-budgets.json: what a thing may cost (AGENTS.md, Performance).
import { expect } from "bun:test";
import { readFileSync } from "node:fs";

const budgets = JSON.parse(readFileSync(new URL("../perf-budgets.json", import.meta.url), "utf8")) as Record<string, number>;
/** Over budget fails. So does more than 10% under: the budget comes down with the work, or the room gets spent. */
export function withinBudget(name: string, measured: number) {
    const budget = budgets[name]!;
    expect({ [name]: measured <= budget ? "within budget" : `${measured}, over its budget of ${budget}` }).toEqual({ [name]: "within budget" });
    if (budget > 0) expect({ [name]: measured >= budget * 0.9 ? "budget is tight" : `${measured}: lower its budget from ${budget}` }).toEqual({ [name]: "budget is tight" });
}

