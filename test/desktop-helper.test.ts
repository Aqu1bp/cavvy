// The Mac app helper (src/desktop/helper.swift). Tests never run it: running it is what adds it to macOS's privacy
// lists, an entry for each test home. Its source is compiled here (on a Mac, with swiftc) into a folder that's then
// deleted, and never run. What it does when run (it takes commands only from the Cavvy that started it) is checked by a
// live run, with CAVVY_DESKTOP_LIVE=1.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isolate } from "./helpers/isolate";

isolate();
const { DesktopHelper, helperBinary, helperSource, realHelperAllowed, REAL_HELPER_REFUSED } = await import("../src/desktop/helper");

const swift = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;
const live = process.env.CAVVY_DESKTOP_LIVE === "1";

test("in tests, the real helper is neither built nor run, and the test that reached for it is told", async () => {
    if (live) return;
    expect(realHelperAllowed()).toBe(false);
    await expect(helperBinary()).rejects.toMatchObject({ code: "test" });
    expect(() => DesktopHelper.start("/nonexistent/Cavvy Desktop Control")).toThrow("Tests don't build or run the real Cavvy Desktop Control");
    const g = globalThis as Record<symbol, number>;
    expect(g[REAL_HELPER_REFUSED]).toBe(2);
    // Reached for on purpose here: test/preload.ts would fail this test otherwise.
    g[REAL_HELPER_REFUSED] = 0;
});

test.skipIf(!swift)("its source compiles, never run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cavvy-helper-compile-"));
    try {
        const src = join(dir, "helper.swift");
        const out = join(dir, "compiled");
        writeFileSync(src, helperSource());
        const p = Bun.spawn(["xcrun", "swiftc", "-swift-version", "5", "-suppress-warnings", "-o", out, src], { stdout: "ignore", stderr: "pipe" });
        const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
        expect(err.split("\n").filter((l) => /error/.test(l))).toEqual([]);
        expect(code).toBe(0);
        expect(existsSync(out)).toBe(true);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 240_000);

/** Runs the helper with what's given (fd 3: a pipe holding that, as Cavvy hands its secret over); resolves with how it ended and what it wrote. */
async function run(bin: string, o: { fd3?: string; lines: string[] }): Promise<{ code: number | null; out: string; err: string }> {
    const proc = Bun.spawn([bin], { stdio: o.fd3 === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"] } as never) as unknown as {
        stdin: { write(s: string): void; end(): void };
        stdout: ReadableStream<Uint8Array>;
        stderr: ReadableStream<Uint8Array>;
        stdio: (number | null)[];
        exited: Promise<number>;
    };
    const fd = proc.stdio[3];
    // As Cavvy does: a line, the pipe left for Bun to close.
    if (o.fd3 !== undefined && typeof fd === "number") writeSync(fd, `${o.fd3}\n`);
    for (const l of o.lines) proc.stdin.write(`${l}\n`);
    proc.stdin.end();
    const [code, out, err] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
    return { code, out, err };
}

// Live runs only (CAVVY_DESKTOP_LIVE=1): these run the helper. What's asked (the status, finding an app) shows no macOS
// prompt, opens nothing and sends no input.
describe.skipIf(!swift || !live)("who may drive the helper (live)", () => {
    const status = JSON.stringify({ id: 1, op: "status" });

    test("run on its own, it refuses and takes nothing", async () => {
        const bin = await helperBinary();
        const r = await run(bin, { lines: [status] });
        expect(r).toEqual({ code: 2, out: "", err: "Cavvy Desktop Control takes commands only from the Cavvy that started it.\n" });
    }, 240_000);

    test("with a secret that isn't the one it was handed, or none, it refuses", async () => {
        const bin = await helperBinary();
        for (const hello of [JSON.stringify({ op: "hello", secret: "b".repeat(64) }), JSON.stringify({ op: "hello" }), status]) {
            const r = await run(bin, { fd3: "a".repeat(64), lines: [hello, status] });
            expect(r.code, hello).toBe(2);
            expect(r.out, hello).toBe("");
        }
        // Too short a secret isn't one.
        expect((await run(bin, { fd3: "abc", lines: [JSON.stringify({ op: "hello", secret: "abc" }), status] })).code).toBe(2);
    }, 240_000);

    test("started by Cavvy, it answers", async () => {
        const h = DesktopHelper.start(await helperBinary());
        try {
            expect((await h.ready).event).toBe("ready");
            const r = await h.call({ op: "find", name: "TextEdit" });
            expect(r).toMatchObject({ found: true, app: { bundleId: "com.apple.TextEdit" } });
        } finally {
            h.stop();
        }
    }, 240_000);
});
