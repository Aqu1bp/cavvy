// A file's lines, read a chunk at a time. Read whole into one string, a log can't be more than about 2 GiB (the
// longest string the engine makes): past that, the read fails, and a session or its GUI log opened as if empty.

import { closeSync, fstatSync, openSync, readFileSync, readSync } from "fs";

const CHUNK = 1024 * 1024;
/**
 * Up to this size, read whole and split: the strings that makes parse about a fifth faster (a 213 MB GUI log read
 * whole and parsed, 515-564 ms; a chunk at a time, 632-652). Past it, a chunk at a time.
 */
const WHOLE_MAX = 256 * 1024 * 1024;

/**
 * Calls `fn` with each line of `file` (without its newline), in order; a last line without a newline too. Says whether
 * the file ended with a newline (true for an empty file), and where it ended (`end`: how far it was read). Throws as
 * openSync does (no file, no access). `wholeMax`: the size up to which it's read whole (tests use 0 to read any file a
 * chunk at a time). `from`: where to start (the start of a line). `to`: where to stop, not the file's end.
 */
export function eachLine(file: string, fn: (line: string) => void, wholeMax = WHOLE_MAX, from = 0, to?: number): { endsWithNewline: boolean; end: number } {
    const fd = openSync(file, "r");
    try {
        const size = Math.min(fstatSync(fd).size, to ?? Infinity);
        if (size - from <= wholeMax) {
            let text: string;
            let end: number;
            if (from === 0 && to === undefined) {
                const b = readFileSync(fd);
                text = b.toString("utf-8");
                end = b.length;
            } else {
                const b = Buffer.allocUnsafe(Math.max(0, size - from));
                let got = 0;
                for (let n: number; got < b.length && (n = readSync(fd, b, got, b.length - got, from + got)) > 0; ) got += n;
                text = b.subarray(0, got).toString("utf-8");
                end = from + got;
            }
            const lines = text.split("\n");
            // A final newline ends the last line; it doesn't start an empty one.
            const ends = text === "" || text.endsWith("\n");
            if (ends) lines.pop();
            for (const line of lines) fn(line);
            return { endsWithNewline: ends, end };
        }
        const chunk = Buffer.allocUnsafe(CHUNK);
        // A line still being read: the pieces of it so far (chunks are reused, so copied).
        let parts: Buffer[] = [];
        let last = 10;
        let pos = from;
        for (let n: number; pos < size && (n = readSync(fd, chunk, 0, Math.min(CHUNK, size - pos), pos)) > 0; pos += n) {
            last = chunk[n - 1]!;
            const nl = chunk.lastIndexOf(10, n - 1);
            if (nl < 0) {
                parts.push(Buffer.from(chunk.subarray(0, n)));
                continue;
            }
            // Up to its last newline, decoded at once (a newline never falls inside a character's bytes), then split.
            const head = chunk.subarray(0, nl);
            const text = parts.length ? Buffer.concat([...parts, head]).toString("utf-8") : head.toString("utf-8");
            for (const line of text.split("\n")) fn(line);
            parts = nl + 1 < n ? [Buffer.from(chunk.subarray(nl + 1, n))] : [];
        }
        if (parts.length) fn(Buffer.concat(parts).toString("utf-8"));
        return { endsWithNewline: last === 10, end: pos };
    } finally {
        closeSync(fd);
    }
}

/** How much is read at a time from a file's end (linesFromEnd). */
const TAIL_CHUNK = 64 * 1024;

/**
 * Calls `fn` with each line of `file`, last first (an empty last line after a final newline isn't one), and where it
 * starts in the file, until `fn` returns false: what's before is never read. For the end of a file that only grows (a
 * history kept for good). `file` may be a descriptor open for reading: it's left open. `before`: from there back, not
 * from the file's end (where a line starts: what's after is never read).
 */
export function linesFromEnd(file: string | number, fn: (line: string, at: number) => boolean | void, chunkSize = TAIL_CHUNK, before?: number) {
    const fd = typeof file === "number" ? file : openSync(file, "r");
    try {
        let pos = before ?? fstatSync(fd).size;
        // What's been read of a line whose beginning is in a chunk not read yet, last read first: joined once its
        // beginning is found (joined at each chunk, a long line cost the square of its length).
        let tail: Buffer[] = [];
        let first = true;
        while (pos > 0) {
            const n = Math.min(chunkSize, pos);
            pos -= n;
            let b = Buffer.allocUnsafe(n);
            readSync(fd, b, 0, n, pos);
            // A final newline ends the last line.
            if (first && b[b.length - 1] === 10) b = b.subarray(0, b.length - 1);
            first = false;
            let end = b.length;
            // Each line that ends in it (a newline never falls inside a character's bytes), last first.
            for (let nl = end > 0 ? b.lastIndexOf(10, end - 1) : -1; nl >= 0; nl = end > 0 ? b.lastIndexOf(10, end - 1) : -1) {
                const piece = b.subarray(nl + 1, end);
                const line = tail.length ? Buffer.concat([piece, ...tail.reverse()]) : piece;
                tail = [];
                // The chunk starts at `pos`.
                if (fn(line.toString("utf-8"), pos + nl + 1) === false) return;
                end = nl;
            }
            if (end > 0) tail.push(b.subarray(0, end));
        }
        if (tail.length || !first) fn(Buffer.concat(tail.reverse()).toString("utf-8"), 0);
    } finally {
        if (typeof file !== "number") closeSync(fd);
    }
}
