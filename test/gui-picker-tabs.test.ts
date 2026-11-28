// The model picker's row of provider tabs (components/ModelPicker.tsx, styles/composer.css .mp-bar), laid out by a
// real browser at the picker's width: with Claude Code's tab shown, its account control at the row's end took the
// room the tabs needed, and the next provider's was cut to a letter under the row's fade. The account goes under the
// tabs when both don't fit. With more providers than a row holds (another Claude Code's long name, say), the row
// scrolls sideways, and each tab is whole once scrolled to.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const chrome = [process.env.CAVVY_TEST_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"].find((p) => p && existsSync(p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const css = ["base.css", "composer.css"].map((f) => readFileSync(new URL(`../gui/src/styles/${f}`, import.meta.url), "utf8")).join("\n");

const tab = (name: string, on = false) => `<button class="mp-f ${on ? "on" : ""}" role="tab"><svg width="14" height="14"></svg><span class="truncate">${name}</span></button>`;
const THREE = ["Claude Code", "Codex"];
const FOUR = ["Claude Code", "Claude Code · OpenRouter", "Mock (demo)"];
const page = (account: boolean, names = THREE) => `<!doctype html><style>:root{--sp:1px}body{margin:0;font:14px system-ui,sans-serif}${css}</style>
<div class="popover mp" style="width:340px"><div class="mp-bar">
  <div class="mp-filters" role="tablist">${tab("Favorites")}${names.map((n, i) => tab(n, i === 0)).join("")}</div>
  ${account ? `<span class="mp-acct"><button class="mp-acct-btn"><span class="truncate">Default</span><svg class="chev" width="12" height="12"></svg></button></span>` : ""}
</div></div>`;

test.skipIf(!chrome)("with an account shown beside them, every provider's tab is shown whole", async () => {
    const profile = mkdtempSync(join(tmpdir(), "cavvy-picker-tabs-"));
    // Its own home: another test file in the same process may have left HOME at a folder that's gone.
    const browser = Bun.spawn([chrome!, "--headless", "--no-first-run", ...(process.getuid?.() === 0 || process.env.CI ? ["--no-sandbox"] : []), `--user-data-dir=${profile}`, "--remote-debugging-port=0"], { stdout: "ignore", stderr: Bun.file(join(profile, "chrome.log")), env: { ...process.env, HOME: profile } });
    try {
        let port: string | undefined;
        for (let i = 0; i < 300 && !port && browser.exitCode === null; i++) { port = /^(\d+)\n/.exec(await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => ""))?.[1]; await sleep(100); }
        // Not started: what it said, rather than a bad address.
        if (!port) {
            browser.kill();
            throw new Error(`Chrome didn't start (exit ${await browser.exited}): ${(await Bun.file(join(profile, "chrome.log")).text().catch(() => "")).slice(-2000)}`);
        }
        const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let seq = 0;
        const pending = new Map<number, (m: any) => void>();
        ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
        const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((r) => { const id = ++seq; pending.set(id, (m) => r(m.result)); ws.send(JSON.stringify({ id, method, params, sessionId })); });
        const { targetId } = await call("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
        const measure = async (account: boolean, names = THREE) => {
            const expression = `(() => { document.open(); document.write(${JSON.stringify(page(account, names))}); document.close();
                const f = document.querySelector(".mp-filters"), a = document.querySelector(".mp-acct-btn .truncate"), box = f.getBoundingClientRect();
                // A tab whose name is cut short, or that doesn't fit whole in the row once scrolled to.
                const cut = [...f.querySelectorAll(".mp-f")].filter((t) => { t.scrollIntoView({ block: "nearest", inline: "nearest" }); const r = t.getBoundingClientRect(), n = t.querySelector(".truncate"); return r.left < box.left - 0.5 || r.right > box.right + 0.5 || (n && n.scrollWidth > n.clientWidth); }).length;
                f.scrollLeft = 0;
                return { hidden: f.scrollWidth - f.clientWidth, cut, account: a ? a.scrollWidth - a.clientWidth : 0, accountWidth: a ? a.getBoundingClientRect().width : 0 }; })()`;
            return (await call("Runtime.evaluate", { expression, returnByValue: true }, sessionId)).result.value as { hidden: number; cut: number; account: number; accountWidth: number };
        };
        expect((await measure(false)).hidden).toBeLessThanOrEqual(0);
        const shown = await measure(true);
        expect(shown.hidden).toBeLessThanOrEqual(0);
        // And the account's name whole.
        expect(shown.accountWidth).toBeGreaterThan(0);
        expect(shown.account).toBeLessThanOrEqual(0);
        // More than a row holds: the row scrolls, each tab whole once scrolled to, the account's name too.
        for (const account of [false, true]) {
            const more = await measure(account, FOUR);
            expect(more.hidden).toBeGreaterThan(0);
            expect(more.cut).toBe(0);
            expect(more.account).toBeLessThanOrEqual(0);
        }
        ws.close();
    } finally {
        browser.kill();
        await browser.exited;
        rmSync(profile, { recursive: true, force: true });
    }
}, 60_000);
