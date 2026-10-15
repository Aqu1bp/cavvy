// Applies SessionOps to a session view. The server keeps its own copy of
// every live session this way, and the GUI applies the very same ops (inside
// a Solid store's produce(), so only what changed re-renders). Pure: no Bun,
// Node or DOM imports.

import type { Block, SessionOp, SessionState, ToolBlock, Turn } from "./protocol";

export interface SessionView {
    state: SessionState;
    turns: Turn[];
}

/** Live output kept per running tool (the tail). */
export const PROGRESS_LIMIT = 12_000;
/** Tool output kept for display. */
export const OUTPUT_LIMIT = 24_000;

export function findTurn(view: SessionView, id: string): Turn | undefined {
    for (let i = view.turns.length - 1; i >= 0; i--) if (view.turns[i]!.id === id) return view.turns[i];
    return undefined;
}

function findIn(blocks: Block[], id: string): Block | undefined {
    for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i]!.id === id) return blocks[i];
    return undefined;
}

export function findBlock(turn: Turn, id: string, parent?: string): Block | undefined {
    if (parent) {
        const p = findIn(turn.blocks, parent);
        return p?.t === "tool" && p.sub ? findIn(p.sub.tools, id) : undefined;
    }
    return findIn(turn.blocks, id);
}

/** Keep the end of `s` (live output is read from the bottom). */
export function tail(s: string, max: number): string {
    if (s.length <= max) return s;
    const cut = s.slice(s.length - max);
    const nl = cut.indexOf("\n");
    return nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut;
}

/**
 * Object.assign for patches. On the wire an unset field is null (JSON has no
 * undefined), so null means "clear it".
 */
export function assign<T extends object>(target: T, patch: Partial<T>): void {
    const t = target as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) t[k] = v === null ? undefined : v;
}

/** JSON.stringify replacer: an explicitly cleared field travels as null. */
export function wireReplacer(_key: string, value: unknown): unknown {
    return value === undefined ? null : value;
}

export function applyOp(view: SessionView, op: SessionOp): void {
    switch (op.op) {
        case "state":
            assign(view.state, op.patch);
            return;
        case "turn":
            view.turns.push(op.turn);
            return;
        case "turn.patch": {
            const t = findTurn(view, op.turnId);
            if (t) assign(t, op.patch);
            return;
        }
        case "block": {
            const t = findTurn(view, op.turnId);
            if (!t) return;
            if (op.parent) {
                const p = findIn(t.blocks, op.parent);
                if (p?.t === "tool" && p.sub && op.block.t === "tool") {
                    p.sub.tools.push(op.block);
                    // Only the last few are drawn; the count says how many there were.
                    if (p.sub.tools.length > 8) p.sub.tools.splice(0, p.sub.tools.length - 8);
                }
                return;
            }
            t.blocks.push(op.block);
            return;
        }
        case "block.patch": {
            const t = findTurn(view, op.turnId);
            const b = t && findBlock(t, op.blockId, op.parent);
            if (b) assign(b, op.patch as Partial<Block>);
            return;
        }
        case "block.remove": {
            const t = findTurn(view, op.turnId);
            if (!t) return;
            const i = t.blocks.findIndex((b) => b.id === op.blockId);
            if (i >= 0) t.blocks.splice(i, 1);
            return;
        }
        case "append": {
            const t = findTurn(view, op.turnId);
            const b = t && findBlock(t, op.blockId);
            if (!b) return;
            const rec = b as unknown as Record<string, unknown>;
            const next = String(rec[op.field] ?? "") + op.text;
            rec[op.field] = op.field === "progress" ? tail(next, PROGRESS_LIMIT) : op.field === "output" ? tail(next, OUTPUT_LIMIT) : next;
            return;
        }
        case "reset":
            view.turns = op.turns;
            return;
    }
}

/** Merge consecutive appends to the same field, so a burst of tokens goes out as one op. */
export function coalesce(ops: SessionOp[]): SessionOp[] {
    const out: SessionOp[] = [];
    for (const op of ops) {
        const last = out[out.length - 1];
        if (op.op === "append" && last?.op === "append" && last.turnId === op.turnId && last.blockId === op.blockId && last.field === op.field) {
            out[out.length - 1] = { ...last, text: last.text + op.text };
        } else if (op.op === "state" && last?.op === "state") {
            out[out.length - 1] = { op: "state", patch: { ...last.patch, ...op.patch } };
        } else out.push(op);
    }
    return out;
}

/** Tool blocks in a turn, including a sub-agent's (for lookups by call id). */
export function isTool(b: Block | undefined): b is ToolBlock {
    return b?.t === "tool";
}
