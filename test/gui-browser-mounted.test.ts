import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromeFixture, type ChromeTimings } from "./helpers/chrome";
import { chromePath } from "./helpers/browser-fixture";
const sandboxArgs = (uid: number | undefined, ci = false) => uid === 0 || ci ? ["--no-sandbox"] : [];
const chromeLimits = { startupMs: 90_000, fixtureMs: 30_000 };
const buildLimitMs = 30_000;
// The test's own limit is the sum of the build's, Chrome's startup and the page's, plus 20 s for cleanup.
test.skipIf(!chromePath)("the mounted browser pane draws frames and cleans up decoding, drag, keys and IME", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-browser-pane-"));
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
            build: { outDir: out, rollupOptions: { input: resolve(import.meta.dir, "../gui/test/browser-pane.html") } },
        };
        // Vite's custom Error initialization fails in Bun after the full suite
        // has run, though it works in a fresh process. Keep compilation isolated.
        const vite = resolve(import.meta.dir, "../gui/node_modules/vite/dist/node/index.js");
        const buildStart = performance.now();
        const built = Bun.spawnSync([process.execPath, "--no-env-file", "-e",
            `import { build } from ${JSON.stringify(vite)}; await build(${JSON.stringify(config)});`,
        ], { timeout: buildLimitMs, stdout: "pipe", stderr: "pipe" });
        if (built.exitCode !== 0) throw new Error(`Browser pane fixture build failed (${built.exitCode}): ${built.stderr.toString()}${built.stdout.toString()}`);
        const buildMs = Math.round(performance.now() - buildStart);
        server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(request) {
                const file = Bun.file(join(out, new URL(request.url).pathname));
                return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
            },
        });
        browser = Bun.spawn([
            chromePath!, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            ...sandboxArgs(process.getuid?.(), !!process.env.CI),
            "--disable-background-networking", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
        ], { stdout: "ignore", stderr: Bun.file(join(scratch, "chrome.log")) });
        const timings: ChromeTimings = {};
        try {
            const result = await chromeFixture(browser, profile, `http://127.0.0.1:${server.port}/test/browser-pane.html`, chromeLimits, timings);
            console.log(`browser pane fixture timings (ms): build ${buildMs}, ${JSON.stringify(timings)}`);
            expect(result.status, result.message).toBe("passed");
        } catch (e) {
            // Why Chrome didn't connect is in its own log, which cleanup deletes.
            const log = await Bun.file(join(scratch, "chrome.log")).text().catch(() => "");
            throw new Error(`${(e as Error).message}\nChrome's log:\n${log || "(empty)"}`, { cause: e });
        }
    } finally {
        browser?.kill();
        if (browser) await browser.exited;
        server?.stop(true);
        rmSync(scratch, { recursive: true, force: true });
    }
}, buildLimitMs + chromeLimits.startupMs + chromeLimits.fixtureMs + 20_000);
