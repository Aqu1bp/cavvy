// What the real GUI costs in a real browser, counted rather than timed (test/perf-budgets.json): how often the
// conversation glides while a reply streams on screen, and that once it's done the page does nothing. The built GUI,
// the demo's mock model (scripts/gui-demo.ts), and Chrome driven over DevTools. No browser package needed: installed
// Chrome, or CAVVY_TEST_CHROME.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { withinBudget } from "./helpers/perf-budget";

const chrome = [process.env.CAVVY_TEST_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome"].find((p) => p && existsSync(p));
const repo = resolve(import.meta.dir, "..");
const TOKEN = "perf-gui-token-0123456789";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Counted in the page from its first script: each glide of the conversation moves its end's room, once, as a new
 * animation or as one already running taken up again from where it is (Transcript.tsx's pin).
 */
const COUNT_GLIDES = `(() => {
    window.__glides = 0;
    const isEnd = (el) => !!(el && el.classList && el.classList.contains("transcript-end"));
    const animate = Element.prototype.animate;
    Element.prototype.animate = function (...args) {
        if (isEnd(this)) window.__glides++;
        return animate.apply(this, args);
    };
    const setKeyframes = KeyframeEffect.prototype.setKeyframes;
    KeyframeEffect.prototype.setKeyframes = function (...args) {
        if (isEnd(this.target)) window.__glides++;
        return setKeyframes.apply(this, args);
    };
})();`;

async function until<T>(what: string, ms: number, check: () => Promise<T | undefined> | T | undefined): Promise<T> {
    const end = performance.now() + ms;
    for (;;) {
        const got = await check();
        if (got) return got;
        if (performance.now() > end) throw new Error(`timed out waiting for ${what}`);
        await sleep(100);
    }
}

/** A DevTools session on a page of the given Chrome. */
async function devtools(profile: string, browser: { exitCode: number | null }) {
    const port = await until("Chrome's DevTools", 90_000, async () => {
        if (browser.exitCode !== null) throw new Error(`Chrome exited (${browser.exitCode})`);
        return /^(\d+)\n/.exec(await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => ""))?.[1];
    });
    const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
    const ws = new WebSocket(version.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error("DevTools connection failed")); });
    let seq = 0;
    const pending = new Map<number, (m: any) => void>();
    ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
    const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((r, j) => {
        const id = ++seq;
        pending.set(id, (m) => (m.error ? j(new Error(`${method}: ${m.error.message}`)) : r(m.result)));
        ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
    const { targetId } = await call("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
    const page = (method: string, params: object = {}) => call(method, params, sessionId);
    const js = async (expression: string) => {
        const r = await page("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
        if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
        return r.result.value;
    };
    return { page, js, close: () => ws.close() };
}

test.skipIf(!chrome)("a reply streaming on screen glides a few times a screen and never back down, and once it's done the page does nothing", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "cavvy-perf-gui-"));
    const profile = join(scratch, "chrome");
    let demo: ReturnType<typeof Bun.spawn> | undefined;
    let browser: ReturnType<typeof Bun.spawn> | undefined;
    let tools: Awaited<ReturnType<typeof devtools>> | undefined;
    try {
        // The GUI as it ships. Built in its own process: Vite's build doesn't always work inside a long test run.
        const dist = join(scratch, "dist");
        const built = Bun.spawnSync([process.execPath, "x", "vite", "build", "--outDir", dist, "--emptyOutDir", "--logLevel", "error"], { cwd: join(repo, "gui"), timeout: 120_000, stdout: "pipe", stderr: "pipe" });
        if (built.exitCode !== 0) throw new Error(`GUI build failed (${built.exitCode}): ${built.stderr.toString()}`);
        const free = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        const port = free.port;
        free.stop(true);
        demo = Bun.spawn([process.execPath, "--no-env-file", `--config=${join(repo, "bunfig.toml")}`, join(repo, "scripts/gui-demo.ts"), "--dir", join(scratch, "demo"), "--port", String(port), "--token", TOKEN], {
            cwd: repo, env: { ...process.env, CAVVY_GUI_DIST: dist } as Record<string, string>, stdout: "ignore", stderr: "ignore",
        });
        await until("the demo server", 60_000, () => fetch(`http://127.0.0.1:${port}/healthz`).then((r) => r.ok, () => false));
        browser = Bun.spawn([
            chrome!, "--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
            ...(process.getuid?.() === 0 || process.env.CI ? ["--no-sandbox"] : []),
            "--window-size=1200,800", `--user-data-dir=${profile}`, "--remote-debugging-port=0",
        ], { stdout: "ignore", stderr: "ignore" });
        tools = await devtools(profile, browser);
        const { page, js } = tools;
        await page("Page.enable");
        await page("Performance.enable");
        await page("Emulation.setDeviceMetricsOverride", { width: 1200, height: 800, deviceScaleFactor: 1, mobile: false });
        await page("Page.addScriptToEvaluateOnNewDocument", { source: COUNT_GLIDES });
        await page("Page.navigate", { url: `http://127.0.0.1:${port}/#token=${TOKEN}` });
        await until("the composer", 30_000, () => js(`!!document.querySelector("textarea")`));
        // The app settles (its model and project known) before it takes a prompt.
        await sleep(1500);

        const enter = async () => { for (const type of ["keyDown", "keyUp"]) await page("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }); };
        const send = async (prompt: string) => {
            await js(`document.querySelector("textarea").focus()`);
            await page("Input.insertText", { text: prompt });
            await until("the prompt in the composer", 10_000, () => js(`document.querySelector("textarea")?.value === ${JSON.stringify(prompt)}`));
            await enter();
            await until("the reply to start", 45_000, async () => {
                if (await js(`!!document.querySelector(".md.streaming")`)) return true;
                // Not taken (the composer wasn't ready for it): the prompt is still there to send.
                if (await js(`document.querySelector("textarea")?.value === ${JSON.stringify(prompt)}`)) await enter();
                return false;
            });
        };
        // Where the reply is on screen each frame while it streams: following it, the conversation only ever moves up
        // (a downward move is room under it taken back, or growth above it taken for the reply's).
        const watchDown = () => js(`(() => {
            window.__down = [];
            let last;
            const frame = () => {
                if (!document.querySelector(".md.streaming")) return;
                const top = [...document.querySelectorAll(".transcript [data-turn]")].at(-1)?.getBoundingClientRect().top;
                if (last !== undefined && top !== undefined && top > last + 1) window.__down.push(Math.round(top - last));
                last = top;
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        })()`);
        const finished = () => js(`!document.querySelector(".md.streaming") && !document.querySelector('[aria-busy="true"]')`);

        // A long reply (the demo's: headings, lists, code, a table) at a model's pace, on screen.
        await send("perfstream text 3 80");
        await js(`window.__glides = 0`);
        await watchDown();
        await until("the reply to finish", 120_000, finished);
        expect(await js(`window.__down`)).toEqual([]);
        const { glides, replyHeight, viewHeight } = await js(`(() => {
            const turn = [...document.querySelectorAll(".transcript [data-turn]")].at(-1);
            return { glides: window.__glides, replyHeight: turn.getBoundingClientRect().height, viewHeight: document.querySelector(".transcript").clientHeight };
        })()`);
        const screens = replyHeight / viewHeight;
        expect(screens).toBeGreaterThan(2.5);
        // Following in room kept under the reply (lib/follow.ts): a glide every few lines, not one a line.
        withinBudget("glidesPerScreenOfReply", Math.round((glides / screens) * 10) / 10, { room: true });

        // Done, and left alone: nothing left running, nothing laid out or restyled.
        await sleep(2000);
        const metric = async () => Object.fromEntries(((await page("Performance.getMetrics")).metrics as { name: string; value: number }[]).map((m) => [m.name, m.value]));
        const before = await metric();
        await sleep(4000);
        const after = await metric();
        withinBudget("idleLayoutsAfterReply", after.LayoutCount! - before.LayoutCount!, { room: true });
        withinBudget("idleStyleUpdatesAfterReply", after.RecalcStyleCount! - before.RecalcStyleCount!, { room: true });
        const running = await js(`document.getAnimations().filter((a) => a.playState === "running" && a.effect?.getComputedTiming().iterations !== Infinity).length`);
        withinBudget("idleEntrancesRunningAfterReply", running);
    } finally {
        tools?.close();
        browser?.kill();
        demo?.kill();
        await Promise.all([browser?.exited, demo?.exited]);
        rmSync(scratch, { recursive: true, force: true });
    }
}, 300_000);
