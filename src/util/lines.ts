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
 * the file ended with a newline (true for an empty file). Throws as openSync does (no file, no access). `wholeMax`: the
 * size up to which it's read whole (tests use 0 to read any file a chunk at a time).
 */
export function eachLine(file: string, fn: (line: string) => void, wholeMax = WHOLE_MAX): { endsWithNewline: boolean } {
    const fd = openSync(file, "r");
    try {
        if (fstatSync(fd).size <= wholeMax) {
            const text = readFileSync(fd, "utf-8");
            const lines = text.split("\n");
            // A final newline ends the last line; it doesn't start an empty one.
            const ends = text === "" || text.endsWith("\n");
            if (ends) lines.pop();
            for (const line of lines) fn(line);
            return { endsWithNewline: ends };
        }
        const chunk = Buffer.allocUnsafe(CHUNK);
        // A line still being read: the pieces of it so far (chunks are reused, so copied).
        let parts: Buffer[] = [];
        let last = 10;
        for (let pos = 0, n: number; (n = readSync(fd, chunk, 0, CHUNK, pos)) > 0; pos += n) {
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
        return { endsWithNewline: last === 10 };
    } finally {
        closeSync(fd);
    }
}
