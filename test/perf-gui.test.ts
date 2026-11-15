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
    // Layout changed inside a resize observer's callback, for what it observes: the browser lays out again.
    window.__resizeLoops = 0;
    window.addEventListener("error", (e) => { if (String(e.message).includes("ResizeObserver loop")) window.__resizeLoops++; });
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

test.skipIf(!chrome)("a reply streaming on screen glides a few times a screen and never back down, once it's done the page does nothing, and a long session opened cold is drawn at its end from its first frame", async () => {
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
        await until("the composer", 30_000, () => js(`!!document.querySelector("textarea:not([data-parked] *)")`));
        // The app settles (its model and project known) before it takes a prompt.
        await sleep(1500);

        const enter = async () => { for (const type of ["keyDown", "keyUp"]) await page("Input.dispatchKeyEvent", { type, key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, ...(type === "keyDown" ? { text: "\r" } : {}) }); };
        const send = async (prompt: string) => {
            await js(`document.querySelector("textarea:not([data-parked] *)").focus()`);
            await page("Input.insertText", { text: prompt });
            await until("the prompt in the composer", 10_000, () => js(`document.querySelector("textarea:not([data-parked] *)")?.value === ${JSON.stringify(prompt)}`));
            await enter();
            await until("the reply to start", 45_000, async () => {
                if (await js(`!!document.querySelector(".md.streaming")`)) return true;
                // Not taken (the composer wasn't ready for it): the prompt is still there to send.
                if (await js(`document.querySelector("textarea:not([data-parked] *)")?.value === ${JSON.stringify(prompt)}`)) await enter();
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
                const top = [...document.querySelectorAll(".transcript:not([data-parked] *) [data-turn]")].at(-1)?.getBoundingClientRect().top;
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
        expect(await js(`window.__resizeLoops`)).toBe(0);
        const { glides, replyHeight, viewHeight } = await js(`(() => {
            const turn = [...document.querySelectorAll(".transcript:not([data-parked] *) [data-turn]")].at(-1);
            return { glides: window.__glides, replyHeight: turn.getBoundingClientRect().height, viewHeight: document.querySelector(".transcript:not([data-parked] *)").clientHeight };
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

        // A reply that comes a paragraph at a time, between tools: while it comes, the words being written never move
        // down (room under them taken back as the words stop for a tool or a pause, then made again as they go on);
        // only once the turn's over does the room close. And nothing new is shown whole before the ink trail has it:
        // each piece of a reply's text is drawn faint the first time it's on screen (code being highlighted aside).
        await js(`(() => {
            window.__down = [];
            window.__bright = [];
            window.__watch = true;
            const seen = new WeakMap();
            const shown = (n) => { let o = 1; for (let e = n.parentElement; e && !e.classList.contains("md"); e = e.parentElement) o *= Number(getComputedStyle(e).opacity); return o; };
            let el, last;
            const frame = () => {
                if (!window.__watch) return;
                const turn = [...document.querySelectorAll(".transcript:not([data-parked] *) [data-turn]")].at(-1);
                const md = [...(turn?.querySelectorAll(".md") ?? [])].at(-1);
                const top = md?.getBoundingClientRect().top;
                if (turn?.getAttribute("aria-busy") === "true" && md === el && last !== undefined && top !== undefined && top > last + 1) window.__down.push(Math.round(top - last));
                el = md;
                last = top;
                // Only text that's new at the end: a path already shown, drawn again as a link once it's known, isn't.
                for (const live of document.querySelectorAll(".md.streaming")) {
                    const walk = document.createTreeWalker(live, NodeFilter.SHOW_TEXT);
                    let at = 0;
                    const had = seen.get(live) ?? 0;
                    for (let n = walk.nextNode(); n; n = walk.nextNode()) {
                        at += n.data.length;
                        if (at <= had || !n.data.trim()) continue;
                        if (!n.parentElement.closest(".code") && shown(n) > 0.6) window.__bright.push(n.data.slice(0, 40));
                    }
                    seen.set(live, at);
                }
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        })()`);
        await send("fastdemo burst");
        await until("the bursts to finish", 120_000, finished);
        await sleep(1000);
        await js(`window.__watch = false`);
        expect(await js(`window.__down`)).toEqual([]);
        expect(await js(`window.__bright`)).toEqual([]);

        // A long session opened cold (the window loaded again, another session on screen): every frame drawn shows
        // the session that was there, or the long one at its end. None at its top, none blank. Read just before each
        // paint (a resize observer made each frame, so it runs after the page's own): a frame callback reads too early,
        // and the browser's layout shifts count turns put in above, with the scroll moved to match, as a shift.
        await send("perfreply 60000 200 1");
        await until("the long reply to finish", 120_000, finished);
        const long = await js(`document.querySelector("[data-session-id].cur")?.dataset.sessionId`);
        expect(typeof long).toBe("string");
        await js(`document.querySelector(".nav-row[title^='New session']").click()`);
        await until("a new session's composer", 10_000, () => js(`!document.querySelector(".transcript:not([data-parked] *) article.turn")`));
        await send("a short one");
        await until("the short reply to finish", 60_000, finished);
        await page("Page.reload");
        await until("the short session again", 30_000, () => js(`!!document.querySelector(".transcript:not([data-parked] *) .user-bubble") && document.querySelector("[data-session-id='${long}']") !== null`));
        await sleep(1500);
        await js(`(() => {
            window.__frames = [];
            window.__watch = true;
            const probe = document.body.appendChild(document.createElement("div"));
            probe.style.cssText = "position:fixed;left:0;top:0;width:1px;height:1px;pointer-events:none";
            const frame = () => {
                if (!window.__watch) return;
                probe.style.width = probe.style.width === "1px" ? "2px" : "1px";
                const ro = new ResizeObserver(() => {
                    ro.disconnect();
                    const sc = document.querySelector(".transcript:not([data-parked] *)");
                    const said = [...(sc?.querySelectorAll(".user-bubble") ?? [])].at(-1)?.textContent ?? "";
                    const which = said.includes("perfreply 60000") ? "long" : said.includes("a short one") ? "short" : "blank";
                    window.__frames.push(which === "long" ? which + (sc.scrollHeight - sc.clientHeight - sc.scrollTop <= 1 ? "@end" : "@" + Math.round(sc.scrollTop)) : which);
                });
                ro.observe(probe);
                requestAnimationFrame(frame);
            };
            requestAnimationFrame(frame);
        })()`);
        const at = await js(`(() => { const r = document.querySelector("[data-session-id='${long}']").getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
        for (const type of ["mousePressed", "mouseReleased"]) await page("Input.dispatchMouseEvent", { type, x: at.x, y: at.y, button: "left", clickCount: 1 });
        await sleep(2000);
        await js(`window.__watch = false`);
        const frames = (await js(`window.__frames`)) as string[];
        const seen = frames.filter((f, i) => f !== frames[i - 1]);
        expect(seen).toEqual(seen[0] === "short" ? ["short", "long@end"] : ["long@end"]);
    } finally {
        tools?.close();
        browser?.kill();
        demo?.kill();
        await Promise.all([browser?.exited, demo?.exited]);
        rmSync(scratch, { recursive: true, force: true });
    }
}, 300_000);
