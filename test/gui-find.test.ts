// Real browser coverage for find's DOM scopes and clipped text. No browser package
// needed; use installed Chrome (or CAVVY_TEST_CHROME) and a private profile.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromeFixture, type ChromeTimings } from "./helpers/chrome";

const chrome = [process.env.CAVVY_TEST_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));

// As root Chrome refuses its sandbox. On GitHub's runners it can't make one either: Ubuntu's AppArmor blocks the
// user namespaces it needs ("No usable sandbox!"), and the runner is a throwaway machine.
const sandboxArgs = (uid: number | undefined, ci = false) => uid === 0 || ci ? ["--no-sandbox"] : [];

// Chrome's startup and the page get separate limits (see test/helpers/chrome.ts). Measured on GitHub's 2-core Linux runners
// (#150): Chrome's install is 667 MB, and the first launch on a fresh runner reads it from a cold disk, taking 6-20 s to open
// DevTools (reading the install beforehand takes 12-19 s; it is not D-Bus). Later launches take 0.25 s. The page takes 7-9 s
// from load to result, about 6 s of which are the fixture's own waits, and the same cold or warm. Each limit is several times the
// slowest measurement, so a slow runner passes and a stuck Chrome or page still fails.
const chromeLimits = { startupMs: 90_000, fixtureMs: 30_000 };
const buildLimitMs = 30_000;
type Browser = Pick<ReturnType<typeof Bun.spawn>, "exitCode" | "exited" | "kill">;

async function waitForExit(browser: Browser, ms: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            browser.exited.then(() => true),
            new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), ms); }),
        ]);
    } finally {
        clearTimeout(timer);
    }
}

async function cleanup(browser: Browser | undefined, server: { stop(force: boolean): unknown } | undefined, scratch: string, graceMs = 1000) {
    try {
        if (browser && browser.exitCode === null) {
            browser.kill();
            if (!await waitForExit(browser, graceMs)) {
                browser.kill("SIGKILL");
                if (!await waitForExit(browser, graceMs)) throw new Error("Chrome did not exit after SIGKILL");
            }
        }
    } finally {
        try {
            await server?.stop(true);
        } finally {
            rmSync(scratch, { recursive: true, force: true });
        }
    }
}

test("shell find searches displayed text without ANSI escapes", () => {
    // Isolate the unused tool renderer so shell matching can run without a browser.
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", String.raw`
        import { expect, mock } from "bun:test";
        mock.module("./src/components/blocks/Activity", () => ({ toolLabel: () => { throw new Error("unexpected tool"); }, cardOf: () => { throw new Error("unexpected tool"); } }));
        const { findParts, findMatches } = await import("./src/lib/find");
        const turn = { id: "turn", status: "done", blocks: [
            { t: "shell", id: "shell", command: "printf colors", output: "foo\x1b[31mbar\x1b[0m foobar", running: false, exitCode: 0 },
        ] };
        expect(findParts(turn)).toEqual([{ part: "shell", text: "printf colors\nfoobar foobar" }]);
        expect(findMatches([turn], "foobar")).toEqual([
            { turnId: "turn", part: "shell", n: 0 }, { turnId: "turn", part: "shell", n: 1 },
        ]);
        expect(findMatches([turn], "31")).toEqual([]);
    `], { cwd: resolve(import.meta.dir, "../gui"), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("find counts a plan's card by its title, not the faded glimpse under it", () => {
    const result = Bun.spawnSync([process.execPath, "--no-env-file", "-e", String.raw`
        import { expect, mock } from "bun:test";
        mock.module("./src/components/blocks/Activity", () => ({ cardOf: (b) => b.name === "ExitPlanMode" ? "plan" : undefined }));
        const { findParts } = await import("./src/lib/find");
        const plan = (status) => ({ id: "turn", status: "done", blocks: [
            { t: "tool", id: "p", name: "ExitPlanMode", title: "ExitPlanMode", status, input: { plan: "## Plan: add SSO\n\n1. Add the provider" } },
        ] });
        expect(findParts(plan("ok"))).toEqual([{ part: "p", text: "add SSO" }]);
        expect(findParts(plan("awaiting"))).toEqual([{ part: "p", text: "add SSO" }]);
        // Still being written: the live line has it, not a card.
        expect(findParts(plan("streaming"))).toEqual([]);
    `], { cwd: resolve(import.meta.dir, "../gui"), stdout: "pipe", stderr: "pipe" });
    expect(result.exitCode, result.stderr.toString()).toBe(0);
});

test("Chrome disables its sandbox only when running as root or in CI", () => {
    expect(sandboxArgs(0)).toEqual(["--no-sandbox"]);
    expect(sandboxArgs(1000, true)).toEqual(["--no-sandbox"]);
    expect(sandboxArgs(1000)).toEqual([]);
    expect(sandboxArgs(undefined)).toEqual([]);
});

test("Chrome cleanup escalates through its child handle and releases the fixture", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "cavvy-live-find-cleanup-"));
    const signals: unknown[] = [];
    let exit!: (code: number) => void;
    const browser: Browser = {
        exitCode: null,
        exited: new Promise<number>((resolve) => { exit = resolve; }),
        kill(signal) {
            signals.push(signal);
            if (signal === "SIGKILL") exit(137);
        },
    };
    let stopped = false;
    await cleanup(browser, { stop(force) { stopped = force; } }, scratch, 10);
    expect(signals).toEqual([undefined, "SIGKILL"]);
    expect(stopped).toBe(true);
    expect(existsSync(scratch)).toBe(false);
});

test("Chrome cleanup releases resources even when termination or server stop fails", async () => {
    for (const failure of ["kill", "exit", "server"]) {
        const scratch = mkdtempSync(join(tmpdir(), "cavvy-live-find-cleanup-"));
        let stopped = false;
        const browser: Browser = {
            exitCode: null,
            exited: failure === "exit" ? new Promise<number>(() => {}) : Promise.resolve(0),
            kill() { if (failure === "kill") throw new Error("kill failed"); },
        };
        const done = cleanup(browser, { stop() { stopped = true; if (failure === "server") throw new Error("stop failed"); } }, scratch, 10);
        await expect(done).rejects.toThrow();
        expect(stopped).toBe(true);
        expect(existsSync(scratch)).toBe(false);
    }
});

// The test's own limit is the sum of the build's, Chrome's startup and the page's, plus 20 s for cleanup.
test.skipIf(!chrome)("find reveals live arguments and linked paths without counting editor controls", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "cavvy-live-find-"));
    const profile = join(scratch, "chrome");
    let browser: ReturnType<typeof Bun.spawn> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    try {
        const out = join(scratch, "dist");
        const config = {
            root: resolve(import.meta.dir, "../gui"),
            configFile: resolve(import.meta.dir, "../gui/vite.config.ts"),
            envFile: false,
            logLevel: "error",
            build: { outDir: out, rollupOptions: { input: resolve(import.meta.dir, "../gui/test/live-find.html") } },
        };
        // Vite's custom Error initialization fails in Bun after the full suite
        // has run, though it works in a fresh process. Keep compilation isolated.
        const vite = resolve(import.meta.dir, "../gui/node_modules/vite/dist/node/index.js");
        const buildStart = performance.now();
        const built = Bun.spawnSync([process.execPath, "--no-env-file", "-e",
            `import { build } from ${JSON.stringify(vite)}; await build(${JSON.stringify(config)});`,
        ], { timeout: buildLimitMs, stdout: "pipe", stderr: "pipe" });
        if (built.exitCode !== 0) throw new Error(`Find fixture build failed (${built.exitCode}): ${built.stderr.toString()}${built.stdout.toString()}`);
        const buildMs = Math.round(performance.now() - buildStart);
        server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(request) {
                const file = Bun.file(join(out, new URL(request.url).pathname));
                return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
            },
        });
        browser = Bun.spawn([
            chrome!, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            ...sandboxArgs(process.getuid?.(), !!process.env.CI),
            "--disable-background-networking", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
        ], { stdout: "ignore", stderr: Bun.file(join(scratch, "chrome.log")) });
        const timings: ChromeTimings = {};
        try {
            const result = await chromeFixture(browser, profile, `http://127.0.0.1:${server.port}/test/live-find.html`, chromeLimits, timings);
            console.log(`find fixture timings (ms): build ${buildMs}, ${JSON.stringify(timings)}`);
            expect(result.status, result.message).toBe("passed");
        } catch (e) {
            // Why Chrome didn't connect is in its own log, which cleanup deletes.
            const log = await Bun.file(join(scratch, "chrome.log")).text().catch(() => "");
            throw new Error(`${(e as Error).message}\nChrome's log:\n${log || "(empty)"}`, { cause: e });
        }
    } finally {
        await cleanup(browser, server, scratch);
    }
}, buildLimitMs + chromeLimits.startupMs + chromeLimits.fixtureMs + 20_000);
