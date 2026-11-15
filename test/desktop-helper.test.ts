// The Mac app helper (src/desktop/helper.swift) as built: it takes commands only from the Cavvy that started it.
// Built with swiftc, so on a Mac only. What it's asked here (the status, finding an app) shows no macOS prompt,
// opens nothing and sends no input.
import { describe, expect, test } from "bun:test";
import { spawn, spawnSync } from "child_process";
import { isolate } from "./helpers/isolate";

isolate();
const { DesktopHelper, helperBinary } = await import("../src/desktop/helper");

const swift = process.platform === "darwin" && spawnSync("xcrun", ["--find", "swiftc"]).status === 0;

/** Runs the helper with what's given; resolves with how it ended and what it wrote. */
function run(bin: string, o: { fd3?: string; lines: string[] }): Promise<{ code: number | null; out: string; err: string }> {
    const child = spawn(bin, [], { stdio: o.fd3 === undefined ? ["pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout!.on("data", (d) => (out += d));
    child.stderr!.on("data", (d) => (err += d));
    if (o.fd3 !== undefined) (child.stdio[3] as NodeJS.WritableStream).end(o.fd3);
    for (const l of o.lines) child.stdin!.write(`${l}\n`);
    child.stdin!.end();
    return new Promise((resolve) => child.on("exit", (code) => resolve({ code, out, err })));
}

describe.skipIf(!swift)("who may drive the helper", () => {
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
