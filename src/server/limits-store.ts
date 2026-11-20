// The last plan limits the server saw, kept across restarts (~/.cavvy/limits.json),
// so the sidebar has the plan's usage, with its age, before the first turn.
// Only what the meter needs: windows, whether a limit is reached (and turns go on
// past it using credits: a flag, never a balance), when it was said.

import { renameSync, rmSync, writeFileSync } from "fs";
import { dirname } from "path";
import { ensureDir, paths } from "../config/paths";
import { readJson } from "../config/settings";
import type { LimitWindow, PlanLimits } from "./protocol";
import { CLAUDE_SCOPES } from "./plan-meter";

interface LimitsFile {
    version: 1;
    limits: PlanLimits[];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
/** Whether turns go on using credits: kept only as a boolean, so nothing else of credits is. */
const credits = (v: unknown): { credits?: boolean } => (typeof v === "boolean" ? { credits: v } : {});
const str = (v: unknown, max: number): string | undefined => (typeof v === "string" && v && v.length <= max ? v : undefined);

/** The model families Claude Code's windows count (CLAUDE_SCOPES): the only scopes kept. */
const SCOPES = new Set(Object.values(CLAUDE_SCOPES));

function windowOf(v: unknown, provider: string): LimitWindow | undefined {
    if (!v || typeof v !== "object") return undefined;
    const w = v as Record<string, unknown>;
    const id = str(w.id, 100), label = str(w.label, 60);
    if (!id || !label) return undefined;
    const used = num(w.usedPercent);
    // `at`: when this window was reported, if before its plan's report; a file without it has the plan's.
    const at = num(w.at);
    // `scope`: the model family a window of Claude Code's counts, by its id (a file from before scopes were saved
    // has them too); none for another CLI's.
    const scope = provider === "claude-code" ? CLAUDE_SCOPES[id] : undefined;
    return { id, label, usedPercent: used === undefined ? undefined : Math.max(0, Math.min(100, used)), resetsAt: num(w.resetsAt), reached: typeof w.reached === "boolean" ? w.reached : undefined, ...credits(w.credits), ...(at === undefined ? {} : { at }), ...(scope ? { scope } : {}) };
}

/** One saved report, or undefined when it isn't one (a hand-edited or older file). */
export function planLimitsOf(v: unknown): PlanLimits | undefined {
    if (!v || typeof v !== "object") return undefined;
    const l = v as Record<string, unknown>;
    const provider = str(l.provider, 60), at = num(l.at);
    if (!provider || at === undefined || !Array.isArray(l.windows)) return undefined;
    const windows = l.windows.slice(0, 12).map((w) => windowOf(w, provider)).filter((w): w is LimitWindow => Boolean(w));
    // Which models a stop is, as the CLI said: one of the scopes its windows have.
    const stopScope = l.reached === true && typeof l.stopScope === "string" && SCOPES.has(l.stopScope) && provider === "claude-code" ? l.stopScope : undefined;
    return { provider, accountId: str(l.accountId, 100) ?? "default", windows, reached: typeof l.reached === "boolean" ? l.reached : undefined, resetsAt: num(l.resetsAt), ...(stopScope ? { stopScope } : {}), ...credits(l.credits), at };
}

/** What was saved; nothing when there's no file or it can't be read. */
export function loadPlanLimits(): PlanLimits[] {
    const f = readJson<Partial<LimitsFile>>(paths.planLimits());
    if (!f || f.version !== 1 || !Array.isArray(f.limits)) return [];
    return f.limits.map(planLimitsOf).filter((l): l is PlanLimits => Boolean(l));
}

/** Replaces the file in one step, so a crash mid-write leaves the last good one. */
export function savePlanLimits(limits: PlanLimits[]) {
    const file = paths.planLimits();
    ensureDir(dirname(file));
    const tmp = `${file}.${process.pid}.tmp`;
    try {
        writeFileSync(tmp, JSON.stringify({ version: 1, limits } satisfies LimitsFile) + "\n", { encoding: "utf-8", mode: 0o600 });
        renameSync(tmp, file);
    } catch (e) {
        rmSync(tmp, { force: true });
        throw e;
    }
}
