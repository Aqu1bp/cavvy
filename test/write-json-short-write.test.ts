import { afterAll, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

// Runs in a child process, so the fs patch can't leak into other test files.
const iso = isolate();
const ROOT = tempDir("harness-writejson-short-");
afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    iso.cleanup();
});

const CHILD = `
const fs = require("fs");
const real = fs.writeSync;
// Every writeSync call writes at most 5 bytes, like an interrupted or pipe-limited write.
fs.writeSync = (fd, data, offset, length, position) => {
    if (typeof data === "string") return real(fd, Buffer.from(data).subarray(0, 5));
    const off = typeof offset === "number" ? offset : 0;
    const len = typeof length === "number" ? length : data.length - off;
    return real(fd, data, off, Math.min(len, 5), typeof position === "number" ? position : null);
};
const { writeJson } = await import(process.argv[2]);
writeJson(process.argv[3], { key: "a value that is much longer than five bytes", list: [1, 2, 3] });
`;

test("a short write never leaves partial JSON in the target", async () => {
    const f = join(ROOT, "settings.json");
    const script = join(ROOT, "child.mjs");
    await Bun.write(script, CHILD);
    const proc = Bun.spawn([process.execPath, script, join(import.meta.dir, "../src/config/settings.ts"), f], {
        env: { ...process.env },
        stdout: "pipe",
        stderr: "pipe",
    });
    await proc.exited;
    expect(existsSync(f)).toBe(true);
    expect(JSON.parse(readFileSync(f, "utf-8"))).toEqual({ key: "a value that is much longer than five bytes", list: [1, 2, 3] });
});
