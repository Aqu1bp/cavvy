// A file's lines a chunk at a time (src/util/lines.ts): the same lines a whole read and a split give, for a file of
// any size.
import { expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tempDir } from "./helpers/isolate";
import { eachLine } from "../src/util/lines";

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
