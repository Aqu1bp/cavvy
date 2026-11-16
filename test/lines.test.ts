// A file's lines a chunk at a time (src/util/lines.ts): the same lines a whole read and a split give, for a file of
// any size.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers/isolate";
import { eachLine, linesFromEnd } from "../src/util/lines";

const lines = (file: string, wholeMax?: number) => {
    const out: string[] = [];
    const r = eachLine(file, (l) => out.push(l), wholeMax);
    return { out, ...r };
};
/** What a whole read and a split give, without the empty string after a final newline. */
const split = (text: string) => (text === "" ? [] : (text.endsWith("\n") ? text.slice(0, -1) : text).split("\n"));

test("lines across the chunks it reads in, and characters of several bytes across them, come out whole", () => {
    const dir = tempDir("cavvy-lines-");
    let seed = 5;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const parts: string[] = [];
    // Lines from empty to three chunks long, of one-, two-, three- and four-byte characters.
    const chars = ["a", "é", "€", "𝄞", " ", "{\"t\":1}"];
    for (let i = 0; i < 60; i++) {
        const len = rand() < 0.2 ? 0 : Math.floor(rand() ** 3 * 3 * 1024 * 1024);
        let s = "";
        while (s.length < len) s += chars[Math.floor(rand() * chars.length)]!.repeat(1 + Math.floor(rand() * 2000));
        parts.push(s);
    }
    for (const text of [parts.join("\n") + "\n", parts.join("\n"), "", "\n", "one", "one\n\ntwo\n"]) {
        const file = join(dir, "f.jsonl");
        writeFileSync(file, text);
        // Read whole (as files up to 256 MB are), and a chunk at a time (as bigger ones are).
        for (const wholeMax of [undefined, 0]) {
            const got = lines(file, wholeMax);
            expect(got.out).toEqual(split(readFileSync(file, "utf-8")));
            expect(got.endsWithNewline).toBe(text === "" || text.endsWith("\n"));
        }
    }
});

test("a file that isn't there throws, as reading it would", () => {
    expect(() => eachLine(join(tempDir("cavvy-lines-"), "none"), () => {})).toThrow();
});

test("from the end: the same lines, last first, whatever the chunks; stopping reads no further back", () => {
    const dir = tempDir("cavvy-lines-end-");
    const texts = ["", "\n", "a", "a\n", "\na", "one\ntwo\n", "one\n\nthree", "é😀\nñ\n" + "x😀".repeat(50) + "\nlast"];
    for (const [i, text] of texts.entries()) {
        const file = join(dir, `t${i}`);
        writeFileSync(file, text);
        for (const chunk of [1, 2, 3, 7, 64 * 1024]) {
            const out: string[] = [];
            linesFromEnd(file, (l) => void out.push(l), chunk);
            expect([out, chunk, text]).toEqual([split(text).reverse(), chunk, text]);
        }
    }
    // A line over many chunks (a long prompt) is joined once: as fast per byte as many short lines.
    const long = join(dir, "long");
    writeFileSync(long, "head\n" + "y".repeat(16 << 20) + "\ntail\n");
    const t0 = performance.now();
    const lines: number[] = [];
    linesFromEnd(long, (l) => void lines.push(l.length), 16 * 1024);
    expect(lines).toEqual([4, 16 << 20, 4]);
    // 16 MB joined at each 16 KB chunk took 3.3 s; once, 20 ms.
    expect(performance.now() - t0).toBeLessThan(1000);
    // Stopped after two: the rest isn't read (a chunk at a time from the end).
    const big = join(dir, "big");
    writeFileSync(big, Array.from({ length: 10_000 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const got: string[] = [];
    const readSoFar = () => (existsSync("/proc/self/io") ? Number(/rchar: (\d+)/.exec(readFileSync("/proc/self/io", "utf8"))?.[1]) : undefined);
    const before = readSoFar();
    linesFromEnd(big, (l) => got.push(l) < 2, 64);
    const after = readSoFar();
    expect(got).toEqual(["line 9999", "line 9998"]);
    // Two chunks of its 98,890 bytes (and the counter's own file, read once).
    if (before !== undefined) expect(after! - before).toBeLessThan(4096);
});
