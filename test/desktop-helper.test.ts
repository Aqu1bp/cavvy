// The Mac app helper (src/desktop/helper.swift). Tests never run it: running it is what adds it to macOS's privacy
// lists, an entry for each test home. It's built here (on a Mac, with swiftc) as the app bundle Cavvy makes, in a folder
// that's then deleted, and never run. What it does when run (it takes commands only from the Cavvy that started it) is checked by a
// live run, with CAVVY_DESKTOP_LIVE=1.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, writeSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isolate } from "./helpers/isolate";

isolate();
const { DesktopHelper, buildIn, clearStale, helperApp, helperBinary, helperSource, infoPlist, realHelperAllowed, sourceHash, HELPER_BUNDLE_ID, REAL_HELPER_REFUSED } = await import("../src/desktop/helper");
const { paths } = await import("../src/config/paths");

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

test.skipIf(!swift)("it builds as an app with its own bundle id and signature, never run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cavvy-helper-compile-"));
    try {
        const app = await buildIn(dir);
        expect(app).toBe(join(dir, "Cavvy Desktop Control.app"));
        expect(existsSync(join(app, "Contents", "MacOS", "Cavvy Desktop Control"))).toBe(true);
        const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
        expect(plist).toContain(`<key>CFBundleIdentifier</key>\n\t<string>${HELPER_BUNDLE_ID}</string>`);
        expect(plist).toContain(`<key>CavvySourceHash</key>\n\t<string>${sourceHash()}</string>`);
        expect(plist).toContain("<key>LSUIElement</key>\n\t<true/>");
        // Read from the signature, not run: macOS keeps the grants under this identifier.
        const sig = Bun.spawnSync(["codesign", "-dv", app], { stderr: "pipe" }).stderr.toString();
        expect(sig).toContain(`Identifier=${HELPER_BUNDLE_ID}`);
        expect(Bun.spawnSync(["codesign", "--verify", "--strict", app]).exitCode).toBe(0);
        // Only the bundle is left: no source, no build folder.
        expect(Bun.spawnSync(["ls", "-A", dir]).stdout.toString().trim()).toBe("Cavvy Desktop Control.app");
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 240_000);

test("the app's own helper is used when it's of this source; else the one in Cavvy's home", () => {
    const root = mkdtempSync(join(tmpdir(), "cavvy-helper-carried-"));
    try {
        const helper = join(root, "Cavvy.app", "Contents", "Helpers", "Cavvy Desktop Control.app");
        mkdirSync(join(helper, "Contents"), { recursive: true });
        const server = join(root, "Cavvy.app", "Contents", "MacOS", "cavvy");
        writeFileSync(join(helper, "Contents", "Info.plist"), infoPlist(sourceHash()));
        expect(helperApp(server)).toBe(helper);
        // Another version's: built in Cavvy's home instead.
        writeFileSync(join(helper, "Contents", "Info.plist"), infoPlist("0000000000000000"));
        expect(helperApp(server)).toBe(join(paths.home(), "desktop", "Cavvy Desktop Control.app"));
        // Not run from an app (bun, a checkout).
        expect(helperApp("/usr/local/bin/bun")).toBe(join(paths.home(), "desktop", "Cavvy Desktop Control.app"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("it registers itself with LaunchServices when it starts, so System Settings can list it; not in tests", () => {
    // Read from its source, not run (it never runs in tests): the call, behind the same gate as the TypeScript side.
    const src = helperSource();
    const fn = src.slice(src.indexOf("func registerWithLaunchServices()"), src.indexOf("registerWithLaunchServices()\n", src.indexOf("func registerWithLaunchServices()") + 40));
    expect(fn).toContain('if env["CAVVY_TEST"] == "1" && env["CAVVY_DESKTOP_LIVE"] != "1" { return }');
    expect(fn).toContain('guard url.pathExtension == "app" else { return }');
    expect(fn).toContain("LSRegisterURL(url as CFURL, true)");
    // Once it's admitted (Cavvy handed it the secret), before it reads a command.
    expect(src.indexOf("\nregisterWithLaunchServices()\n")).toBeGreaterThan(src.indexOf("if !admitted() {"));
    expect(src.indexOf("\nregisterWithLaunchServices()\n")).toBeLessThan(src.indexOf("Thread.detachNewThread {"));
});

test("what no longer runs is cleared from Cavvy's home: the helper from before it was an app, a build stopped halfway", () => {
    const home = join(paths.home(), "desktop");
    mkdirSync(join(home, "Cavvy Desktop Control.app", "Contents"), { recursive: true });
    mkdirSync(join(home, ".build-1a2b3c4d"), { recursive: true });
    mkdirSync(join(home, ".old-1a2b3c4d"), { recursive: true });
    writeFileSync(join(home, "Cavvy Desktop Control"), "old helper");
    writeFileSync(join(home, "build.json"), "{}");
    clearStale();
    expect(Bun.spawnSync(["ls", "-A", home]).stdout.toString().trim().split("\n").sort()).toEqual(["Cavvy Desktop Control.app", "build.json"]);
    rmSync(home, { recursive: true, force: true });
});

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
