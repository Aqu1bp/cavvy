import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isolate } from "./helpers/isolate";
import { chromePath } from "./helpers/browser-fixture";
import { chromeFixture } from "./helpers/chrome";

const iso = isolate();
afterAll(() => iso.cleanup());
const { startServer } = await import("../src/server/server");
const { forgetChromeLookup } = await import("../src/browser/chrome");

test.skipIf(!chromePath)("Retina pane paints real remote clicks, text and scroll; stream reconnect and resize preserve chat", async () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "harness-stream-e2e-")));
    const before = process.env.HARNESS_BROWSER;
    process.env.HARNESS_BROWSER = chromePath!;
    forgetChromeLookup();
    const profile = join(scratch, "viewer");
    let browser: ReturnType<typeof Bun.spawn> | undefined;
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let site: ReturnType<typeof Bun.serve> | undefined;
    try {
        const out = join(scratch, "dist");
        const config = { root: resolve(import.meta.dir, "../gui"), configFile: resolve(import.meta.dir, "../gui/vite.config.ts"), envFile: false, logLevel: "error", build: { outDir: out, rollupOptions: { input: resolve(import.meta.dir, "../gui/test/browser-stream.html") } } };
        const vite = resolve(import.meta.dir, "../gui/node_modules/vite/dist/node/index.js");
        const built = Bun.spawnSync([process.execPath, "--no-env-file", "-e", `import { build } from ${JSON.stringify(vite)}; await build(${JSON.stringify(config)});`], { timeout: 30_000, stdout: "pipe", stderr: "pipe" });
        expect(built.exitCode, built.stderr.toString()).toBe(0);
        site = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(`<!doctype html><html><body style="margin:0;background:white;height:4000px;font:16px sans-serif">
            <div id="marker" style="position:fixed;left:0;top:0;width:32px;height:32px;background:red;z-index:1"></div>
            <button style="position:absolute;left:60px;top:45px;width:180px;height:50px" onclick="window.flip=!window.flip;marker.style.background=window.flip?'blue':'red'">Toggle marker</button>
            <input style="position:absolute;left:60px;top:120px;width:200px;height:40px" oninput="if(this.value==='日本語')marker.style.background='#00ff00'">
            <button style="position:absolute;left:300px;top:45px;width:180px;height:50px" onclick="motion.classList.toggle('running')">Toggle animation</button>
            <style>@keyframes slide { from { transform:translateX(0) rotate(0deg) } to { transform:translateX(100px) rotate(180deg) } } .running { animation:slide .8s linear infinite alternate }</style>
            <div id="motion" style="position:absolute;left:50px;top:260px;width:350px;height:250px;background:repeating-linear-gradient(45deg,#2563eb 0 12px,#fefefe 12px 24px)"></div>
            <p style="position:absolute;top:200px">Sharp text at 2× display scale. Scroll to test remote input.</p>
            <script>onscroll=()=>marker.style.background='yellow';onkeyup=e=>{if(e.key==='Shift')marker.style.background='magenta'}</script>
            </body></html>`, { headers: { "content-type": "text/html; charset=utf-8" } }) });
        // The production static server requires an index entry even for this focused fixture.
        await Bun.write(join(out, "index.html"), "<!doctype html><title>Browser stream fixture</title>");
        server = await startServer({ token: "browser-stream-fixture", staticDir: out });
        const client = { subs: new Set<string>(), send: () => {} };
        server.engine.clients.add(client);
        const project = join(scratch, "project");
        mkdirSync(project);
        const made = await server.engine.handle(client, "session.create", { cwd: project });
        const id = made.state.id;
        await server.engine.handle(client, "browser.command", { id, command: "goto", url: `http://127.0.0.1:${site.port}` });
        browser = Bun.spawn([chromePath!, "--headless=new", "--no-first-run", "--no-default-browser-check", "--disable-background-networking", "--force-device-scale-factor=2", "--window-size=1100,900", `--user-data-dir=${profile}`, "--remote-debugging-port=0", ...(process.getuid?.() === 0 || process.env.CI ? ["--no-sandbox"] : [])], { stdout: "ignore", stderr: Bun.file(join(scratch, "chrome.log")) });
        const result = await chromeFixture(browser, profile, `${server.url}/test/browser-stream.html?session=${encodeURIComponent(id)}#token=browser-stream-fixture`, { startupMs: 90_000, fixtureMs: 60_000 });
        console.log(`browser interaction measurements: ${result.message}`);
        if (result.status !== "passed") {
            const remote = await (server.engine as any).runtimes.get(id).browser.page();
            console.log("remote state", await remote.evaluate("({scrollY,innerWidth,innerHeight,marker:document.querySelector('#marker').style.background,active:document.activeElement.outerHTML})"));
        }
        expect(result.status, result.message).toBe("passed");
    } finally {
        browser?.kill();
        if (browser) await browser.exited;
        await server?.stop();
        site?.stop(true);
        process.env.HARNESS_BROWSER = before;
        forgetChromeLookup();
        rmSync(scratch, { recursive: true, force: true });
    }
}, 190_000);
