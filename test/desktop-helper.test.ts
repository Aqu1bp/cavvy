// The Mac app helper (src/desktop/helper.swift). Tests never run it: running it is what adds it to macOS's privacy
// lists, an entry for each test home. It's built here (on a Mac, with swiftc) as the app bundle Cavvy makes, in a folder
// that's then deleted, and never run. What it does when run (it takes commands only from the Cavvy that started it) is checked by a
// live run, with CAVVY_DESKTOP_LIVE=1.
import { describe, expect, test } from "bun:test";
import { spawnSync } from "child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "fs";
import { homedir, tmpdir } from "os";
import { dirname, join } from "path";
import { isolate } from "./helpers/isolate";

isolate();
const { DesktopHelper, accountHome, buildIn, carried, clearStale, clearStaleCopies, handshake, helperApp, placeFor, placed, sameTree, helperBinary, helperIdentity, helperSource, infoPlist, realHelperAllowed, sourceHash, HELPER_BUNDLE_ID, HELPER_IDENTITY, REAL_HELPER_REFUSED, TEST_HELPER_IDENTITY } = await import("../src/desktop/helper");
const { RESETTABLE_IDS, resetCommand } = await import("../src/desktop/access");
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

test.skipIf(!swift)("a test copy's helper builds with an identity of its own, never run", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cavvy-helper-compile-"));
    try {
        const app = await buildIn(dir, TEST_HELPER_IDENTITY);
        expect(app).toBe(join(dir, "Cavvy Desktop Control (Test).app"));
        expect(existsSync(join(app, "Contents", "MacOS", "Cavvy Desktop Control (Test)"))).toBe(true);
        const plist = readFileSync(join(app, "Contents", "Info.plist"), "utf8");
        expect(plist).toContain("<key>CFBundleIdentifier</key>\n\t<string>dev.cavvy.desktop.control.test</string>");
        expect(plist).toContain("<key>CFBundleName</key>\n\t<string>Cavvy Desktop Control (Test)</string>");
        expect(Bun.spawnSync(["codesign", "-dv", app], { stderr: "pipe" }).stderr.toString()).toContain("Identifier=dev.cavvy.desktop.control.test");
        expect(helperIdentity(app)).toEqual(TEST_HELPER_IDENTITY);
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}, 240_000);

test("a test copy carries its own helper, and Reset access may name only the two helpers' ids", () => {
    const root = mkdtempSync(join(tmpdir(), "cavvy-helper-carried-"));
    try {
        const helper = join(root, "Cavvy Test.app", "Contents", "Helpers", "Cavvy Desktop Control (Test).app");
        mkdirSync(join(helper, "Contents"), { recursive: true });
        writeFileSync(join(helper, "Contents", "Info.plist"), infoPlist(sourceHash(), TEST_HELPER_IDENTITY));
        const server = join(root, "Cavvy Test.app", "Contents", "MacOS", "cavvy");
        expect(carried(server)).toBe(helper);
        expect(helperIdentity(helper)).toEqual({ name: "Cavvy Desktop Control (Test)", bundleId: "dev.cavvy.desktop.control.test" });
        // Run from a copy of its own, apart from the helper's.
        expect(helperApp(server)).toBe(join(homedir(), "Library", "Application Support", "Cavvy Test", "Cavvy Desktop Control (Test).app"));
        // Release builds keep the helper's own.
        expect(HELPER_IDENTITY).toEqual({ name: "Cavvy Desktop Control", bundleId: HELPER_BUNDLE_ID });
        expect(helperIdentity(join(root, "nothing.app"))).toEqual(HELPER_IDENTITY);
        expect(RESETTABLE_IDS).toEqual(["dev.cavvy.desktop.control", "dev.cavvy.desktop.control.test"]);
        expect(resetCommand("screen", "dev.cavvy.desktop.control.test")).toEqual(["/usr/bin/tccutil", "reset", "ScreenCapture", "dev.cavvy.desktop.control.test"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("the app's own helper is used, from its copy in Application Support, when it's of this source; else the one in Cavvy's home", () => {
    const root = mkdtempSync(join(tmpdir(), "cavvy-helper-carried-"));
    try {
        const helper = join(root, "Cavvy.app", "Contents", "Helpers", "Cavvy Desktop Control.app");
        mkdirSync(join(helper, "Contents"), { recursive: true });
        const server = join(root, "Cavvy.app", "Contents", "MacOS", "cavvy");
        writeFileSync(join(helper, "Contents", "Info.plist"), infoPlist(sourceHash()));
        expect(carried(server)).toBe(helper);
        // Never run inside the app: macOS would give Screen Recording to Cavvy, the app around it.
        expect(helperApp(server)).toBe(join(homedir(), "Library", "Application Support", "Cavvy", "Cavvy Desktop Control.app"));
        expect(placeFor(HELPER_IDENTITY, "/Users/me")).toBe("/Users/me/Library/Application Support/Cavvy/Cavvy Desktop Control.app");
        expect(placeFor(TEST_HELPER_IDENTITY, "/Users/me")).toBe("/Users/me/Library/Application Support/Cavvy Test/Cavvy Desktop Control (Test).app");
        // Another version's: built in Cavvy's home instead.
        writeFileSync(join(helper, "Contents", "Info.plist"), infoPlist("0000000000000000"));
        expect(carried(server)).toBeUndefined();
        expect(helperApp(server)).toBe(join(paths.home(), "desktop", "Cavvy Desktop Control.app"));
        // Not run from an app (bun, a checkout).
        expect(helperApp("/usr/local/bin/bun")).toBe(join(paths.home(), "desktop", "Cavvy Desktop Control.app"));
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

/** A stand-in for the carried helper, never run: a bundle's files, the executable a script that does nothing. */
function fakeBundle(app: string) {
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true });
    mkdirSync(join(app, "Contents", "_CodeSignature"), { recursive: true });
    writeFileSync(join(app, "Contents", "Info.plist"), infoPlist(sourceHash()));
    writeFileSync(join(app, "Contents", "_CodeSignature", "CodeResources"), "<plist/>");
    writeFileSync(join(app, "Contents", "MacOS", "Cavvy Desktop Control"), "#!/bin/sh\nexit 0\n");
    chmodSync(join(app, "Contents", "MacOS", "Cavvy Desktop Control"), 0o755);
}

test.skipIf(process.platform !== "darwin")("the carried helper is copied out, and copied again before a start whenever its copy differs", async () => {
    const root = mkdtempSync(join(tmpdir(), "cavvy-helper-place-"));
    try {
        const from = join(root, "Cavvy.app", "Contents", "Helpers", "Cavvy Desktop Control.app");
        fakeBundle(from);
        const target = join(root, "Application Support", "Cavvy", "Cavvy Desktop Control.app");
        const exe = join(target, "Contents", "MacOS", "Cavvy Desktop Control");
        expect(await placed(from, target)).toBe(target);
        expect(await sameTree(from, target)).toBe(true);
        expect(statSync(exe).mode & 0o111).toBe(0o111);
        // The same: left as it is, not copied again.
        const before = statSync(exe).ino;
        await placed(from, target);
        expect(statSync(exe).ino).toBe(before);
        // Changed since (a byte, a file added, one taken away, no longer executable): put back as the app carries it.
        for (const change of [
            () => writeFileSync(exe, "#!/bin/sh\nexit 1\n"),
            () => writeFileSync(join(target, "Contents", "MacOS", "extra"), "x"),
            () => rmSync(join(target, "Contents", "_CodeSignature"), { recursive: true }),
            () => chmodSync(exe, 0o644),
        ]) {
            change();
            expect(await sameTree(from, target)).toBe(false);
            await placed(from, target);
            expect(await sameTree(from, target)).toBe(true);
        }
        // Nothing left beside it: no half copy, no old one.
        expect(readdirSync(dirname(target))).toEqual(["Cavvy Desktop Control.app"]);
        // Nothing to copy from: said, and nothing put there.
        await expect(placed(join(root, "nothing.app"), join(root, "elsewhere", "Cavvy Desktop Control.app"))).rejects.toThrow("Couldn't put Cavvy Desktop Control in");
        expect(existsSync(join(root, "elsewhere", "Cavvy Desktop Control.app"))).toBe(false);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("a copy that stopped halfway is cleared after an hour; nothing else in the app's folder is", () => {
    const root = mkdtempSync(join(tmpdir(), "cavvy-helper-place-"));
    try {
        for (const n of [".helper-copy-1a2b3c4d", ".helper-old-1a2b3c4d", ".helper-copy-5e6f7a8b", "Cavvy Desktop Control.app", "Local Storage", "Preferences"]) mkdirSync(join(root, n));
        const hourAgo = new Date(Date.now() - 3_700_000);
        for (const n of [".helper-copy-1a2b3c4d", ".helper-old-1a2b3c4d", "Local Storage"]) utimesSync(join(root, n), hourAgo, hourAgo);
        clearStaleCopies(root);
        expect(readdirSync(root).sort()).toEqual([".helper-copy-5e6f7a8b", "Cavvy Desktop Control.app", "Local Storage", "Preferences"]);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});

test("auto mode's sandbox can't reach the helper's copies either", () => {
    const { DESKTOP_HELPER_COPIES, sandboxPolicy } = require("../src/permissions/sandbox");
    expect(DESKTOP_HELPER_COPIES.map((p: string) => join("/Users/me", p))).toEqual([placeFor(HELPER_IDENTITY, "/Users/me"), placeFor(TEST_HELPER_IDENTITY, "/Users/me")]);
    const home = mkdtempSync(join(tmpdir(), "cavvy-helper-place-"));
    try {
        const p = sandboxPolicy([home], { home, cavvyHome: paths.home() });
        for (const id of [HELPER_IDENTITY, TEST_HELPER_IDENTITY]) expect(p.unreadable).toContain(placeFor(id, require("fs").realpathSync(home)));
    } finally {
        rmSync(home, { recursive: true, force: true });
    }
});

test.skipIf(process.platform !== "darwin")("the copy goes in the account's own home, whatever HOME says", async () => {
    const home = spawnSync("/usr/bin/id", ["-P"]).stdout.toString().trim().split(":")[8];
    expect(await accountHome()).toBe(home!);
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

test("it takes the never-offered list only on the line after the secret, and without it refuses every app", () => {
    // Read from its source, not run: what it does with the list is checked by a live run (below).
    const src = helperSource();
    const admitted = src.indexOf("if !admitted() {");
    const received = src.indexOf("\nlet NEVER = receiveNeverOffered()\n");
    expect(received).toBeGreaterThan(admitted);
    expect(received).toBeLessThan(src.indexOf("Thread.detachNewThread {"));
    const fn = src.slice(src.indexOf("func neverOffered(name: String, bundleId: String?) -> Bool {"));
    expect(fn.split("\n")[1]!.trim()).toBe("guard let never = NEVER else { return true }");
    // A pattern that doesn't compile fails it closed too.
    expect(src).toContain("guard patterns.count == sources.count else { return nil }");
    expect(src).not.toContain("NEVER_IDS");
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

    test("an app on the never-offered list is refused; with no list, every app is", async () => {
        const bin = await helperBinary();
        const [hello, never] = handshake("c".repeat(64));
        const ask = (name: string, bundleId: string) => JSON.stringify({ id: 1, op: "offered", name, bundleId });
        const answer = (out: string) => JSON.parse(out.trim().split("\n").find((l) => l.includes('"id"'))!).offered;
        expect(answer((await run(bin, { fd3: "c".repeat(64), lines: [hello!, never!, ask("Terminal", "com.apple.Terminal")] })).out)).toBe(false);
        expect(answer((await run(bin, { fd3: "c".repeat(64), lines: [hello!, never!, ask("TextEdit", "com.apple.TextEdit")] })).out)).toBe(true);
        // No list: the line after the secret isn't one, so nothing is offered.
        expect(answer((await run(bin, { fd3: "c".repeat(64), lines: [hello!, ask("TextEdit", "com.apple.TextEdit"), ask("TextEdit", "com.apple.TextEdit")] })).out)).toBe(false);
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
