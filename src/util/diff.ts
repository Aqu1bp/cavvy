// Line diff (Myers O(ND)) and unified hunk construction.

export type DiffOp = { type: "equal" | "add" | "del"; line: string; oldNo?: number; newNo?: number };

export function diffLines(a: string, b: string): DiffOp[] {
    const A = splitLines(a);
    const B = splitLines(b);
    // Trim common prefix/suffix: cheap and makes the O(ND) part small.
    let start = 0;
    while (start < A.length && start < B.length && A[start] === B[start]) start++;
    let endA = A.length;
    let endB = B.length;
    while (endA > start && endB > start && A[endA - 1] === B[endB - 1]) {
        endA--;
        endB--;
    }
    const ops: DiffOp[] = [];
    for (let i = 0; i < start; i++) ops.push({ type: "equal", line: A[i]!, oldNo: i + 1, newNo: i + 1 });
    const mid = myers(A.slice(start, endA), B.slice(start, endB));
    let oi = start;
    let ni = start;
    for (const op of mid) {
        if (op === "=") ops.push({ type: "equal", line: A[oi]!, oldNo: ++oi, newNo: ++ni });
        else if (op === "-") ops.push({ type: "del", line: A[oi]!, oldNo: ++oi });
        else ops.push({ type: "add", line: B[ni]!, newNo: ++ni });
    }
    for (let i = endA, j = endB; i < A.length; i++, j++) ops.push({ type: "equal", line: A[i]!, oldNo: i + 1, newNo: j + 1 });
    return ops;
}

function splitLines(s: string): string[] {
    if (s === "") return [];
    const lines = s.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    return lines;
}

function myers(a: string[], b: string[]): ("=" | "-" | "+")[] {
    const n = a.length;
    const m = b.length;
    if (n === 0) return Array(m).fill("+");
    if (m === 0) return Array(n).fill("-");
    const max = n + m;
    // Edit distance cap: beyond this a line diff isn't useful to read anyway,
    // and the trace would get large. Fall back to delete-all/add-all.
    const D_CAP = 3000;
    const offset = max;
    const v = new Int32Array(2 * max + 2);
    // trace[d] holds v[-d..d] as it was before step d (only that window is read back).
    const trace: Int32Array[] = [];
    let found = false;
    for (let d = 0; d <= max && !found; d++) {
        if (d > D_CAP) return [...Array(n).fill("-"), ...Array(m).fill("+")];
        trace.push(v.slice(offset - d, offset + d + 1));
        for (let k = -d; k <= d; k += 2) {
            let x: number;
            if (k === -d || (k !== d && v[offset + k - 1]! < v[offset + k + 1]!)) x = v[offset + k + 1]!;
            else x = v[offset + k - 1]! + 1;
            let y = x - k;
            while (x < n && y < m && a[x] === b[y]) {
                x++;
                y++;
            }
            v[offset + k] = x;
            if (x >= n && y >= m) {
                found = true;
                break;
            }
        }
    }
    // Backtrack.
    const ops: ("=" | "-" | "+")[] = [];
    let x = n;
    let y = m;
    for (let d = trace.length - 1; d >= 0; d--) {
        const vd = trace[d]!;
        const at = (kk: number) => vd[kk + d] ?? 0;
        const k = x - y;
        let prevK: number;
        if (k === -d || (k !== d && at(k - 1) < at(k + 1))) prevK = k + 1;
        else prevK = k - 1;
        const prevX = at(prevK);
        const prevY = prevX - prevK;
        while (x > prevX && y > prevY) {
            ops.push("=");
            x--;
            y--;
        }
        if (d > 0) {
            if (x === prevX) ops.push("+");
            else ops.push("-");
        }
        x = prevX;
        y = prevY;
    }
    return ops.reverse();
}

export interface Hunk {
    oldStart: number;
    oldLines: number;
    newStart: number;
    newLines: number;
    ops: DiffOp[];
}

export function hunks(ops: DiffOp[], context = 3): Hunk[] {
    const out: Hunk[] = [];
    const changed = ops.map((o) => o.type !== "equal");
    let i = 0;
    while (i < ops.length) {
        if (!changed[i]) {
            i++;
            continue;
        }
        let start = Math.max(0, i - context);
        let end = i;
        // Extend while changes are within 2*context of each other.
        while (end < ops.length) {
            if (changed[end]) {
                end++;
                continue;
            }
            let next = end;
            while (next < ops.length && !changed[next]) next++;
            if (next < ops.length && next - end <= context * 2) end = next;
            else break;
        }
        const stop = Math.min(ops.length, end + context);
        const slice = ops.slice(start, stop);
        const oldLines = slice.filter((o) => o.type !== "add").length;
        const newLines = slice.filter((o) => o.type !== "del").length;
        // An empty range is numbered by the line before it (0 at the top), as in `diff -u`.
        const before = (key: "oldNo" | "newNo") => {
            for (let k = start - 1; k >= 0; k--) if (ops[k]![key] !== undefined) return ops[k]![key]!;
            return 0;
        };
        out.push({
            oldStart: oldLines ? slice.find((o) => o.oldNo !== undefined)!.oldNo! : before("oldNo"),
            oldLines,
            newStart: newLines ? slice.find((o) => o.newNo !== undefined)!.newNo! : before("newNo"),
            newLines,
            ops: slice,
        });
        i = stop;
        start = stop;
    }
    return out;
}

export function diffStats(ops: DiffOp[]): { added: number; removed: number } {
    let added = 0;
    let removed = 0;
    for (const o of ops) {
        if (o.type === "add") added++;
        else if (o.type === "del") removed++;
    }
    return { added, removed };
}

export function unifiedDiff(path: string, a: string, b: string, context = 3): string {
    const hs = hunks(diffLines(a, b), context);
    if (!hs.length) return "";
    const lines = [`--- a/${path}`, `+++ b/${path}`];
    for (const h of hs) {
        lines.push(`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`);
        for (const o of h.ops) lines.push((o.type === "add" ? "+" : o.type === "del" ? "-" : " ") + o.line);
    }
    return lines.join("\n");
}
