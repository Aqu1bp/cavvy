// Glob: "newest first" holds on trees bigger than any scan limit.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { GlobTool } = await import("../src/tools/search-tools");
const dirs: string[] = [];

afterAll(() => {
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    iso.cleanup();
});

describe("Glob", () => {
    test("returns exactly the 200 newest files, newest first, past 2000 matches", async () => {
        const dir = tempDir();
        dirs.push(dir);
        const files: { path: string; mtime: number }[] = [];
        // Distinct mtimes in an order unrelated to names or directories, so scan order can't line up with age.
        const n = 2251;
        const base = Date.UTC(2020, 0, 1) / 1000;
        for (let d = 0; d < 5; d++) mkdirSync(join(dir, `d${d}`));
        for (let i = 0; i < n; i++) {
            const f = join(dir, `d${i % 5}`, `f${i}.txt`);
            const t = base + ((i * 7919) % n) * 60;
            writeFileSync(f, "");
            utimesSync(f, t, t);
            files.push({ path: f, mtime: t });
        }
        const newest = join(dir, "d4", "zz-newest.txt");
        writeFileSync(newest, "");
        utimesSync(newest, base + 10 * n * 60, base + 10 * n * 60);
        files.push({ path: newest, mtime: base + 10 * n * 60 });

        const ctx = { state: { cwd: dir, projectRoot: dir }, settings: {}, signal: new AbortController().signal } as any;
        const r = await GlobTool.run({ pattern: "**/*.txt" }, ctx);
        const lines = r.content.split("\n");
        const expected = files.sort((a, b) => b.mtime - a.mtime).slice(0, 200).map((f) => f.path);
        expect(lines.slice(0, 200)).toEqual(expected);
        expect(lines[0]).toBe(newest);
        expect(lines).toHaveLength(201);
        expect(lines[200]).toContain(`showing 200 of ${n + 1}`);
    });
});
