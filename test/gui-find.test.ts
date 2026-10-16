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
        const { build } = await import("../gui/node_modules/vite/dist/node/index.js");
        const out = join(scratch, "dist");
        await build({
            root: resolve(import.meta.dir, "../gui"),
            configFile: resolve(import.meta.dir, "../gui/vite.config.ts"),
            envFile: false,
            logLevel: "error",
            build: { outDir: out, rollupOptions: { input: resolve(import.meta.dir, "../gui/test/live-find.html") } },
        });
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
        const result = await chromeFixture(browser, profile, `http://127.0.0.1:${server.port}/test/live-find.html`, AbortSignal.timeout(30_000));
        expect(result.status, result.message).toBe("passed");
    } finally {
        await cleanup(browser, server, scratch);
    }
}, 60_000);
