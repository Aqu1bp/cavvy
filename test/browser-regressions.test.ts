import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isolate, tempDir } from "./helpers/isolate";
import { chromePath } from "./helpers/browser-fixture";
const iso = isolate();
if (chromePath) process.env.CAVVY_BROWSER = chromePath;
const { BrowserSession } = await import("../src/browser/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BrowserNavigateTool, BrowserActTool, BrowserEvalTool } = await import("../src/tools/browser-tools");
const { registerSecret, unregisterSecret } = await import("../src/util/redact");
const { startDemoSite } = await import("../scripts/demo-site");
const { checkUrl } = await import("../src/browser/url-policy");
const root = tempDir("cavvy-browser-regressions-");
const sessions: InstanceType<typeof BrowserSession>[] = [];
const session = (opts: object = {}) => {
    const b = new BrowserSession({ root, settings: () => ({}), pool: { startupMs: 90_000 }, ...opts });
    sessions.push(b); return b;
};
const until = async (fn: () => boolean, what: string) => {
    const until = Date.now() + 8000;
    while (!fn()) { if (Date.now() > until) throw new Error(`Timed out: ${what}`); await Bun.sleep(20); }
};
afterAll(async () => { await Promise.all(sessions.map(s => s.dispose())); iso.cleanup(); });

test("browser previews and malformed URL errors redact a secret crossing their cuts", async () => {
    const secret = "private-preview-value-987654321";
    registerSecret(secret);
    try {
        for (const [tool, input] of [
            [BrowserActTool, { action: "type", text: "x".repeat(190) + secret }],
            [BrowserEvalTool, { expression: "x".repeat(1990) + secret }],
        ] as const) {
            const preview = JSON.stringify(await tool.preview!(input as never, {} as never));
            expect(preview).not.toContain("private-pr");
        }
        expect(JSON.stringify(checkUrl("x".repeat(190) + secret, root))).not.toContain("private-pr");
    } finally { unregisterSecret(secret); }
});

describe.skipIf(!chromePath)("browser regressions with Chrome", () => {
    let warm: InstanceType<typeof BrowserSession>;
    beforeAll(async () => { warm = session(); await warm.page(); }, 100_000);

    test("page loads cannot bypass Read asks; an authorized file opens, siblings and later loads still require approval", async () => {
        mkdirSync(join(root, "private"), { recursive: true });
        writeFileSync(join(root, "private/payload.js"), "window.privateLoaded = true");
        writeFileSync(join(root, "private/report.html"), '<h1>Approved report</h1><script src="payload.js"></script>');
        writeFileSync(join(root, "index.html"), '<h1>Public page</h1><script src="private/payload.js"></script>');
        writeFileSync(join(root, ".env"), "APP_FIXTURE=approved-file-contents");
        let settings = { permissions: { ask: ["Read(private/**)"], deny: [] as string[] } };
        const checker = new PermissionChecker(() => settings, root);
        const b = session({ refuse: (url: string, approved?: { file?: string }) => checker.urlRefusal(url, approved) });
        const page = await b.page();
        const url = (p: string) => pathToFileURL(join(root, p)).href;
        await page.goto(url("index.html"));
        expect(await page.evaluate("window.privateLoaded")).toBe("undefined");
        expect(page.console.entries.some(e => e.text.includes("Requires approval"))).toBe(true);
        expect(checker.check(BrowserNavigateTool, { url: url("private/report.html") }, "default", root).behavior).toBe("ask");
        await page.gotoApproved(url("private/report.html"), new AbortController().signal);
        expect((await page.outline()).text).toContain("Approved report");
        expect(await page.evaluate("window.privateLoaded")).toBe("undefined");
        await expect(page.goto(url("private/report.html") + "?again")).rejects.toThrow();
        expect(checker.check(BrowserNavigateTool, { url: url(".env") }, "default", root).behavior).toBe("ask");
        await page.gotoApproved(url(".env"), new AbortController().signal);
        expect((await page.outline()).text).toContain("approved-file-contents");
        settings.permissions.deny = ["Read(private/**)"];
        expect(checker.urlRefusal(url("private/report.html"), { file: realpathSync(join(root, "private/report.html")) })).toContain("Denied");
        await expect(page.gotoApproved(url("private/report.html"), new AbortController().signal)).rejects.toThrow();
    }, 30_000);

    test("a page can't take the agent to a host an ask rule names; on the host it was let open, it moves freely", async () => {
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(req) {
                const u = new URL(req.url);
                if (u.pathname === "/hop") return Response.redirect(`http://127.0.0.1:${server.port}/inside`, 302);
                if (u.pathname === "/empty") return new Response(null, { status: 204 });
                return new Response(`<h1>${u.hostname}${u.pathname}</h1>`, { headers: { "content-type": "text/html" } });
            },
        });
        try {
            const checker = new PermissionChecker(() => ({ permissions: { ask: ["WebFetch(domain:127.0.0.1)"] } }), root);
            const b = session({ refuse: (url: string, approved?: { file?: string; host?: string }) => checker.urlRefusal(url, approved) });
            const page = await b.page();
            const plain = `http://localhost:${server.port}`, asked = `http://127.0.0.1:${server.port}`;
            const blocked = () => page.console.entries.filter((e) => e.text.includes("Requires approval by permission rule WebFetch(domain:127.0.0.1)")).length;
            // A redirect from a host that isn't asked about doesn't answer for one that is.
            await page.goto(`${plain}/hop`).catch(() => undefined);
            expect(page.url).not.toContain("127.0.0.1");
            expect(blocked()).toBe(1);
            // Let open there, the page goes about on its host by itself.
            await page.gotoApproved(`${asked}/start`, new AbortController().signal);
            await page.evaluate("location.href = '/next'");
            await until(() => page.url === `${asked}/next`, "the page to move on its host");
            // A yes for somewhere that never becomes a page (a 204) leaves the tab where it was, with the yes it had there.
            await page.gotoApproved(`${plain}/empty`, new AbortController().signal).catch(() => undefined);
            expect(page.url).toBe(`${asked}/next`);
            await page.evaluate("location.href = '/again'");
            await until(() => page.url === `${asked}/again`, "the page to move on its host still");
            expect(blocked()).toBe(1);
            // Once it has left, coming back is a visit of its own.
            await page.evaluate(`location.href = '${plain}/away'`);
            await until(() => page.url === `${plain}/away`, "the page to leave");
            await page.evaluate(`location.href = '${asked}/back'`);
            await until(() => blocked() === 2, "the way back to be refused");
            expect(page.url).not.toBe(`${asked}/back`);
        } finally {
            server.stop(true);
        }
    }, 30_000);

    test("a frame from another site can't go where its page may not", async () => {
        const seen: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(req) {
                const u = new URL(req.url);
                seen.push(`${req.headers.get("host")?.split(":")[0]}${u.pathname}`);
                if (u.pathname === "/frame") return new Response(`<img src="/pixel"><script>setTimeout(() => (location.href = "http://localhost:${server.port}/x"), 100)</script>`, { headers: { "content-type": "text/html" } });
                return new Response("ok");
            },
        });
        try {
            // The page is a file in the project; its frame, from 127.0.0.1, runs in a process of its own.
            writeFileSync(join(root, "framed.html"), `<iframe src="http://127.0.0.1:${server.port}/frame"></iframe>`);
            const checker = new PermissionChecker(() => ({ permissions: { deny: ["WebFetch(domain:localhost)"] } }), root);
            const b = session({ refuse: (url: string, approved?: { file?: string; host?: string }) => checker.urlRefusal(url, approved) });
            const page = await b.page();
            await page.goto(pathToFileURL(join(root, "framed.html")).href);
            // It ran (it was let go once checked), and where it then tried to go was refused before anything was asked of it.
            await until(() => seen.includes("127.0.0.1/pixel"), "the frame to run");
            await until(() => page.console.entries.some((e) => e.text.startsWith(`Blocked a load of http://localhost:${server.port}/x`)), "the frame's navigation to be refused");
            expect(seen.filter((r) => r.startsWith("localhost"))).toEqual([]);
        } finally {
            server.stop(true);
        }
    }, 30_000);

    test("what a service worker keeps for a host an ask rule names is checked like the network's", async () => {
        const seen: string[] = [];
        // It answers for /secret itself, from no request a check could stop; the page it gives says it ran.
        const worker = `self.addEventListener("install", () => self.skipWaiting());
            self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
            self.addEventListener("fetch", (e) => { if (new URL(e.request.url).pathname === "/secret") e.respondWith(new Response('<script>fetch("/ran")</script>', { headers: { "content-type": "text/html" } })); });`;
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            fetch(req) {
                const u = new URL(req.url);
                seen.push(`${req.headers.get("host")?.split(":")[0]}${u.pathname}`);
                const as = (type: string) => ({ headers: { "content-type": type } });
                if (u.pathname === "/sw.js") return new Response(worker, as("text/javascript"));
                if (u.pathname === "/keep") return new Response(`<script>addEventListener("message", () => (location.href = "/secret")); navigator.serviceWorker.register("/sw.js").then(() => navigator.serviceWorker.ready).then(() => fetch("/kept"))</script>`, as("text/html"));
                if (u.pathname === "/outer") return new Response(`<iframe src="http://127.0.0.1:${server.port}${u.searchParams.get("frame")}"></iframe>`, as("text/html"));
                return new Response("ok", as("text/plain"));
            },
        });
        try {
            let ask: string[] = [];
            const checker = new PermissionChecker(() => ({ permissions: { ask } }), root);
            const b = session({ refuse: (url: string, approved?: { file?: string; host?: string }) => checker.urlRefusal(url, approved) });
            const page = await b.page();
            const plain = `http://localhost:${server.port}`;
            const refused = () => page.console.entries.filter((e) => e.text.startsWith(`Blocked a load of http://127.0.0.1:${server.port}/secret`)).length;
            // Before there was a rule, a frame from 127.0.0.1 (in a process of its own) had a worker keep its pages.
            await page.goto(`${plain}/outer?frame=/keep`);
            await until(() => seen.includes("127.0.0.1/kept"), "the worker to be ready");
            ask = ["WebFetch(domain:127.0.0.1)"];
            // That frame going there itself, and a new frame starting there: each refused, though the worker would answer.
            await page.evaluate(`document.querySelector("iframe").contentWindow.postMessage("go", "*")`);
            await until(() => refused() === 1, "the frame's own navigation to be refused");
            await page.goto(`${plain}/outer?frame=/secret`);
            await until(() => refused() === 2, "the new frame's load to be refused");
            await Bun.sleep(300);
            expect(seen.filter((r) => r.startsWith("127.0.0.1/secret") || r.startsWith("127.0.0.1/ran"))).toEqual([]);
        } finally {
            server.stop(true);
        }
    }, 30_000);

    test("two sessions in one project continue streaming as both pages change", async () => {
        const a = session(), b = session();
        const pa = await a.page(), pb = await b.page();
        const ka = {}, kb = {};
        let countA = 0, countB = 0;
        a.watch(ka, (_, frameId) => { countA++; queueMicrotask(() => a.ack(ka, frameId)); }, { width: 400, height: 300, scale: 1 });
        b.watch(kb, (_, frameId) => { countB++; queueMicrotask(() => b.ack(kb, frameId)); }, { width: 500, height: 400, scale: 2 });
        try {
            await until(() => countA > 0 && countB > 0, "both first frames");
            for (const color of ["red", "blue", "green"]) {
                const beforeA = countA, beforeB = countB;
                await Promise.all([pa.evaluate(`document.body.style.background = '${color}'`), pb.evaluate(`document.body.style.background = '${color}'`)]);
                await until(() => countA > beforeA && countB > beforeB, "both updated frames");
            }
            expect((a as any).pool).toBe((b as any).pool);
        } finally { a.unwatch(ka); b.unwatch(kb); }
    }, 30_000);

    test("the demo form submits in Chrome and renders the search text", async () => {
        const demo = startDemoSite();
        const b = session();
        try {
            const p = await b.page();
            await p.goto(demo.url);
            await p.evaluate(`document.getElementById('q').value = 'billing'; document.querySelector('form').requestSubmit()`);
            expect(await p.evaluate("document.getElementById('found').textContent")).toBe(JSON.stringify('No incidents matching "billing"'));
            expect(p.console.entries.filter(e => e.level === "exception")).toEqual([]);
        } finally { demo.stop(); }
    }, 15_000);
});
