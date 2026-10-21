// Reasoning effort as a row of bars: which levels a model takes, and how the
// keyboard and the pointer move along them. Shared by the composer's effort
// popover and Settings → General.

import type { EffortLevel, ModelSummary } from "@shared/protocol";

export interface Effort {
    id: EffortLevel;
    label: string;
    /** 1 (low) to 5 (max): how many of the glyph's five bars fill. */
    lv: number;
}

export const EFFORTS: Effort[] = [
    { id: "low", label: "Low", lv: 1 },
    { id: "medium", label: "Medium", lv: 2 },
    { id: "high", label: "High", lv: 3 },
    { id: "xhigh", label: "Extra high", lv: 4 },
    { id: "max", label: "Max", lv: 5 },
];

export const effortOf = (id: EffortLevel | undefined): Effort | undefined => EFFORTS.find((e) => e.id === id);

/** Whether the model has a reasoning control at all. */
export function takesEffort(m: Pick<ModelSummary, "supportsReasoning" | "effortLevels"> | undefined): boolean {
    return Boolean(m?.supportsReasoning || m?.effortLevels?.length);
}

/** The levels the model takes (what the server sends as effortLevels); a model that names none takes them all. */
export function effortLevels(m: Pick<ModelSummary, "effortLevels"> | undefined): Effort[] {
    const only = m?.effortLevels;
    return only?.length ? EFFORTS.filter((e) => only.includes(e.id)) : EFFORTS;
}

/**
 * Where a key moves the selection along `n` bars from `at` (-1: none picked yet),
 * or undefined for a key the bars don't take. Arrows step, Home/End jump to
 * the ends, and 1–n pick a bar directly.
 */
export function effortKey(e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "altKey">, at: number, n: number): number | undefined {
    if (!n || e.metaKey || e.ctrlKey || e.altKey) return undefined;
    const step = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[e.key];
    if (step) return Math.max(0, Math.min(n - 1, at < 0 ? (step > 0 ? 0 : n - 1) : at + step));
    if (e.key === "Home") return 0;
    if (e.key === "End") return n - 1;
    if (/^[1-9]$/.test(e.key) && Number(e.key) <= n) return Number(e.key) - 1;
    return undefined;
}

/** The bar under a pointer at `x` on a row of `n` bars spanning `left` to `left + width`. */
export function effortAt(x: number, left: number, width: number, n: number): number {
    if (n <= 0 || width <= 0) return 0;
    return Math.max(0, Math.min(n - 1, Math.floor(((x - left) / width) * n)));
}
