// Real browser coverage for find's DOM scopes and clipped text. No browser package
// needed; use installed Chrome (or HARNESS_TEST_CHROME) and a private profile.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromeFixture } from "./helpers/chrome";

const chrome = [process.env.HARNESS_TEST_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));

const sandboxArgs = (uid: number | undefined) => uid === 0 ? ["--no-sandbox"] : [];
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
        mock.module("./src/components/blocks/Activity", () => ({ toolLabel: () => { throw new Error("unexpected tool"); } }));
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

test("Chrome disables its sandbox only when running as root", () => {
    expect(sandboxArgs(0)).toEqual(["--no-sandbox"]);
    expect(sandboxArgs(1000)).toEqual([]);
    expect(sandboxArgs(undefined)).toEqual([]);
});

test("Chrome cleanup escalates through its child handle and releases the fixture", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-live-find-cleanup-"));
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
        const scratch = mkdtempSync(join(tmpdir(), "harness-live-find-cleanup-"));
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

test.skipIf(!chrome)("find reveals live arguments and linked paths without counting editor controls", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-live-find-"));
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
        const built = Bun.spawnSync([process.execPath, "--no-env-file", "-e",
            `import { build } from ${JSON.stringify(vite)}; await build(${JSON.stringify(config)});`,
        ], { timeout: 30_000, stdout: "pipe", stderr: "pipe" });
        if (built.exitCode !== 0) throw new Error(`Find fixture build failed (${built.exitCode}): ${built.stderr.toString()}${built.stdout.toString()}`);
        server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(request) {
                const file = Bun.file(join(out, new URL(request.url).pathname));
                return (await file.exists()) ? new Response(file) : new Response(null, { status: 404 });
            },
        });
        browser = Bun.spawn([
            chrome!, "--headless", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
            ...sandboxArgs(process.getuid?.()),
            "--disable-background-networking", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
        ], { stdout: "ignore", stderr: Bun.file(join(scratch, "chrome.log")) });
        try {
            const result = await chromeFixture(browser, profile, `http://127.0.0.1:${server.port}/test/live-find.html`, AbortSignal.timeout(30_000));
            expect(result.status, result.message).toBe("passed");
        } catch (e) {
            // Why Chrome didn't connect is in its own log, which cleanup deletes.
            const log = await Bun.file(join(scratch, "chrome.log")).text().catch(() => "");
            throw new Error(`${(e as Error).message}\nChrome's log:\n${log || "(empty)"}`, { cause: e });
        }
    } finally {
        await cleanup(browser, server, scratch);
    }
}, 60_000);
