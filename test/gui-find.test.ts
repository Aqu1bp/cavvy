// Real browser coverage for find's DOM scopes and clipped text. No browser package
// needed; use installed Chrome (or HARNESS_TEST_CHROME), a private profile and dump-dom.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const chrome = [process.env.HARNESS_TEST_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));

test.skipIf(!chrome)("find reveals long live arguments and highlights concurrent calls' arguments", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "harness-live-find-"));
    const profile = join(scratch, "chrome");
    let browser: ReturnType<typeof Bun.spawn> | undefined;
    let server: ReturnType<typeof Bun.serve> | undefined;
    let deadline: ReturnType<typeof setTimeout> | undefined;
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
            "--disable-background-networking", `--user-data-dir=${profile}`, "--dump-dom", "--virtual-time-budget=5000",
            `http://127.0.0.1:${server.port}/test/live-find.html`,
        ], { stdout: "pipe", stderr: "pipe" });
        const [html, errors, code] = await Promise.race([
            Promise.all([new Response(browser.stdout).text(), new Response(browser.stderr).text(), browser.exited]),
            new Promise<never>((_, reject) => { deadline = setTimeout(() => reject(new Error("Chrome find regression timed out")), 30_000); }),
        ]);
        expect(code, errors).toBe(0);
        expect(html).toContain('data-status="passed"');
    } finally {
        clearTimeout(deadline);
        if (browser && browser.exitCode === null) {
            const command = Bun.spawnSync(["ps", "-p", String(browser.pid), "-o", "command="]).stdout.toString();
            if (command.includes(`--user-data-dir=${profile}`)) {
                browser.kill();
                await browser.exited;
            }
        }
        server?.stop(true);
        rmSync(scratch, { recursive: true, force: true });
    }
}, 60_000);
