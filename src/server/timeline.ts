// Applies SessionOps to a session view. The server keeps its own copy of
// every live session this way, and the GUI applies the very same ops (inside
// a Solid store's produce(), so only what changed re-renders). Pure: no Bun,
// Node or DOM imports.

import type { AgentRun, Block, SessionOp, SessionState, ToolBlock, Turn } from "./protocol";

export interface SessionView {
    state: SessionState;
    turns: Turn[];
    agents: AgentRun[];
}

/** A sub-agent's activity keeps this many blocks (the rest are counted in `dropped`). */
export const AGENT_BLOCKS = 300;

function findAgent(view: SessionView, id: string): AgentRun | undefined {
    return view.agents.find((a) => a.id === id);
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
            if (op.agents) view.agents = op.agents;
            return;
        case "agent": {
            const i = view.agents.findIndex((a) => a.id === op.agent.id);
            if (i >= 0) view.agents[i] = op.agent;
            else view.agents.push(op.agent);
            return;
        }
        case "agent.patch": {
            const a = findAgent(view, op.id);
            if (a) assign(a, op.patch);
            return;
        }
        case "agent.block": {
            const a = findAgent(view, op.id);
            if (!a) return;
            const i = a.blocks.findIndex((b) => b.id === op.block.id);
            if (i >= 0) a.blocks[i] = op.block;
            else {
                a.blocks.push(op.block);
                if (a.blocks.length > AGENT_BLOCKS) {
                    const n = a.blocks.length - AGENT_BLOCKS;
                    a.blocks.splice(0, n);
                    a.dropped = (a.dropped ?? 0) + n;
                }
            }
            return;
        }
        case "agent.block.patch": {
            const b = findAgent(view, op.id)?.blocks.find((x) => x.id === op.blockId);
            if (b) assign(b, op.patch as Partial<Block>);
            return;
        }
        case "agent.append": {
            const b = findAgent(view, op.id)?.blocks.find((x) => x.id === op.blockId);
            if (!b) return;
            const rec = b as unknown as Record<string, unknown>;
            const next = String(rec[op.field] ?? "") + op.text;
            rec[op.field] = op.field === "progress" ? tail(next, PROGRESS_LIMIT) : next;
            return;
        }
    }
}

/** The turn blocks an op changes or reads (by id), or "all" for one that may touch any; none for the rest. */
function blocksTouched(op: SessionOp): string[] | "all" {
    switch (op.op) {
        case "state":
        case "agent":
        case "agent.patch":
        case "agent.block":
        case "agent.block.patch":
        case "agent.append":
            return [];
        case "append":
        case "block.remove":
            return [op.blockId];
        case "block.patch":
            return op.parent ? [op.blockId, op.parent] : [op.blockId];
        case "block":
            return op.parent ? [op.block.id, op.parent] : [op.block.id];
        default:
            return "all";
    }
}

/**
 * Merge what a batch can say in fewer ops: consecutive appends to the same
 * field (a burst of tokens), consecutive agent and state patches, and patches
 * to the same block (a tool's input counter as it streams, a delegate's row
 * as its sub-agent works). A block's patch is merged into its earlier one
 * when nothing between touches that block, so the batch builds the same.
 */
export function coalesce(ops: SessionOp[]): SessionOp[] {
    const out: SessionOp[] = [];
    /** Each block's latest patch in `out` that a later one can still be merged into. */
    const patches = new Map<string, number>();
    const key = (turnId: string, blockId: string, parent?: string) => `${turnId}\u0000${blockId}\u0000${parent ?? ""}`;
    for (const op of ops) {
        if (op.op === "block.patch") {
            const k = key(op.turnId, op.blockId, op.parent);
            const at = patches.get(k);
            const into = at !== undefined ? out[at] : undefined;
            if (into?.op === "block.patch") {
                out[at!] = { ...into, patch: { ...into.patch, ...op.patch } as Partial<Block> };
                continue;
            }
        }
        const touched = blocksTouched(op);
        if (touched === "all") patches.clear();
        else if (touched.length)
            for (const [k, i] of patches) {
                const p = out[i] as Extract<SessionOp, { op: "block.patch" }>;
                if (touched.includes(p.blockId) || (p.parent !== undefined && touched.includes(p.parent))) patches.delete(k);
            }
        const last = out[out.length - 1];
        if (op.op === "block.patch") {
            out.push(op);
            patches.set(key(op.turnId, op.blockId, op.parent), out.length - 1);
        } else if (op.op === "append" && last?.op === "append" && last.turnId === op.turnId && last.blockId === op.blockId && last.field === op.field) {
            out[out.length - 1] = { ...last, text: last.text + op.text };
        } else if (op.op === "agent.append" && last?.op === "agent.append" && last.id === op.id && last.blockId === op.blockId && last.field === op.field) {
            out[out.length - 1] = { ...last, text: last.text + op.text };
        } else if (op.op === "agent.patch" && last?.op === "agent.patch" && last.id === op.id) {
            out[out.length - 1] = { ...last, patch: { ...last.patch, ...op.patch } };
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
