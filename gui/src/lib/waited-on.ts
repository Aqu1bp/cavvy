import type { SessionOp } from "@shared/protocol";

/**
 * What the user waits on, not what streams: the session stopping or starting, a question or approval for them, a turn
 * ending. Shown at the next frame rather than the stream clock's next step (up to 50 ms later; state/app.ts): Esc showed
 * the turn stopped 55-72 ms after the key, the server's part of it 3-17 ms (measured).
 */
export function waitedOn(ops: readonly SessionOp[]): boolean {
    for (const op of ops) {
        if (op.op === "state" && ("busy" in op.patch || "interactions" in op.patch)) return true;
        if (op.op === "turn.patch" && "status" in op.patch) return true;
    }
    return false;
}
