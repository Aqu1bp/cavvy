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
const until = async (fn: () => boolean, what: string | (() => string)) => {
    const until = Date.now() + 8000;
    while (!fn()) { if (Date.now() > until) throw new Error(`Timed out: ${typeof what === "string" ? what : what()}`); await Bun.sleep(20); }
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
        const sent = (p: unknown) => (p as { fullFrames: number }).fullFrames;
        a.watch(ka, (_, frameId) => { countA++; queueMicrotask(() => a.ack(ka, frameId)); }, { width: 400, height: 300, scale: 1 });
        b.watch(kb, (_, frameId) => { countB++; queueMicrotask(() => b.ack(kb, frameId)); }, { width: 500, height: 400, scale: 2 });
        try {
            await until(() => countA > 0 && countB > 0, "both first frames");
            for (const color of ["red", "blue", "green"]) {
                const beforeA = countA, beforeB = countB, sentA = sent(pa), sentB = sent(pb);
                await Promise.all([pa.evaluate(`document.body.style.background = '${color}'`), pb.evaluate(`document.body.style.background = '${color}'`)]);
                // Which pane got none, and whether Chrome sent its page a frame at all (#126).
                await until(() => countA > beforeA && countB > beforeB, () => `both updated frames after ${color}: a got ${countA - beforeA} (Chrome sent its page ${sent(pa) - sentA}), b got ${countB - beforeB} (Chrome sent its page ${sent(pb) - sentB})`);
            }
            expect((a as any).pool).toBe((b as any).pool);
        } finally { a.unwatch(ka); b.unwatch(kb); }
    }, 30_000);

    test("every streamed frame is labelled with the pane's size, at scales 1, 1.5, 2 and 3, however often the page repaints", async () => {
        // At scales other than its own (2), Chrome now and then labels a frame with the picture's size ÷ 2 (frame-size.ts):
        // the pane mapped clicks with that, and they landed off by scale ÷ 2. It's rare (about one frame in a hundred),
        // so many repaints, at each scale a screen has.
        for (const scale of [1, 1.5, 2, 3]) {
            const b = session();
            const p = await b.page();
            await p.evaluate(`document.body.innerHTML = '<div id=n style="font:40px sans-serif">0</div>'`);
            const key = {}, sizes: string[] = [];
            b.watch(key, (f, frameId) => { sizes.push(`${f.width}x${f.height}`); queueMicrotask(() => b.ack(key, frameId)); }, { width: 360, height: 622, scale });
            try {
                await until(() => sizes.length > 0, "the first frame");
                for (let i = 0; i < 120; i++) {
                    await p.evaluate(`document.getElementById('n').textContent = '${i}'`);
                    await Bun.sleep(25);
                }
                // Chrome merges repaints into fewer frames on a busy machine: enough of them to have seen a few hundred.
                await until(() => sizes.length >= 20, "frames of the repaints");
                expect({ scale, wrong: sizes.filter((s) => s !== "360x622") }).toEqual({ scale, wrong: [] });
            } finally { b.unwatch(key); }
        }
    }, 120_000);

    test("a dropdown clicked in the pane lists its options there, and the one picked is chosen in the page", async () => {
        const html = `<body style="margin:20px"><label>Fruit <select id=s><option>apple</option><optgroup label="Stone"><option>cherry</option><option disabled>plum</option></optgroup><option>date</option></select></label>
            <br><br><textarea id=t rows=6 cols=40></textarea><select id=box size=3><option>one</option><option>two</option></select>
            <script>window.heard=[];addEventListener('mousedown',e=>heard.push('down:'+(e.target.id||e.target.tagName)),true);for(const k of ['input','change'])s.addEventListener(k,()=>heard.push(k+':'+s.value))</script></body>`;
        const site = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });
        const b = session();
        try {
            const p = await b.page();
            await p.goto(`http://localhost:${site.port}/`);
            const at = async (id: string) => JSON.parse(await p.evaluate(`(()=>{const r=document.getElementById('${id}').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`)) as { x: number; y: number };
            const click = async (o: { x: number; y: number }) => {
                await b.input({ kind: "mouse", type: "down", ...o, button: "left", buttons: 1, clickCount: 1 });
                await b.input({ kind: "mouse", type: "up", ...o, button: "left", buttons: 0, clickCount: 1 });
            };
            const heard = async () => JSON.parse(await p.evaluate("window.heard")) as string[];
            // The press isn't the page's: Chrome's own list (which takes no click sent to the page) never opens.
            await click(await at("s"));
            expect(b.state().tabs[0]!.choice).toEqual({ id: 1, label: "Fruit", options: [{ label: "apple" }, { label: "Stone: cherry" }, { label: "Stone: plum", disabled: true }, { label: "date" }], selected: 0 });
            expect(await heard()).toEqual([]);
            // Picked there: the page hears it as from a person. One that's disabled isn't picked, and the list closes.
            await b.choose(3);
            expect([await p.evaluate("document.getElementById('s').value"), await heard(), b.state().tabs[0]!.choice]).toEqual(['"date"', ["input:date", "change:date"], undefined]);
            await click(await at("s"));
            await b.choose(2);
            expect([await p.evaluate("document.getElementById('s').value"), b.state().tabs[0]!.choice]).toEqual(['"date"', undefined]);
            // Closed without a pick, by Cancel or by a press elsewhere, which is the page's as ever.
            await click(await at("s"));
            await b.choose();
            await click(await at("s"));
            expect(b.state().tabs[0]!.choice?.selected).toBe(3);
            // A pick made in a list that's been replaced since (the pane hadn't heard yet) picks nothing: this one stays.
            const open = b.state().tabs[0]!.choice!.id;
            await b.choose(0, undefined, open - 1);
            await b.choose(undefined, undefined, open - 1);
            expect([await p.evaluate("document.getElementById('s').value"), b.state().tabs[0]!.choice?.id]).toEqual(['"date"', open]);
            await click(await at("t"));
            expect([b.state().tabs[0]!.choice, (await heard()).at(-1)]).toEqual([undefined, "down:t"]);
            await expect(b.choose(0)).rejects.toThrow("No list is open in this tab.");
            // A list box is drawn in the page and takes its clicks there.
            await click(await at("box"));
            expect([b.state().tabs[0]!.choice, (await heard()).at(-1)]).toEqual([undefined, "down:OPTION"]);
        } finally { void site.stop(true); }
    }, 30_000);

    test("a dropdown's list is only what was asked of the page, whatever the page redefines; a pick is only of what was listed", async () => {
        const page = (script: string) => `<body style="margin:20px"><select id=s style="width:200px;height:40px"><option>a</option><option>b</option></select><script>${script}</script></body>`;
        const pages: Record<string, string> = {
            // More options than are ever listed.
            "/many": page("const f=document.createDocumentFragment();for(let i=0;i<20000;i++){const o=document.createElement('option');o.text='opt '+i;f.append(o)}s.append(f)"),
            // A page that makes cutting a list or a text short do nothing, and every option's name long.
            "/big": page("Array.prototype.slice=function(){return Array.from({length:200000},()=>this[0])};String.prototype.slice=function(){return String(this)};Object.defineProperty(HTMLOptionElement.prototype,'label',{get(){return 'x'.repeat(2000)}})"),
            // One that answers with things that aren't a list's.
            "/odd": page("Array.prototype.map=function(){return [{label:{evil:1},disabled:'no'}]};Object.defineProperty(HTMLSelectElement.prototype,'selectedIndex',{get(){return 'boo'}})"),
            "/moves": page("window.heard=[];s.addEventListener('change',()=>heard.push(s.value))"),
        };
        const site = Bun.serve({ port: 0, fetch: (req) => new Response(pages[new URL(req.url).pathname] ?? "", { headers: { "content-type": "text/html" } }) });
        const b = session();
        try {
            const p = await b.page();
            const open = async (path: string) => {
                await p.goto(`http://localhost:${site.port}${path}`);
                await b.input({ kind: "mouse", type: "down", x: 100, y: 40, button: "left", buttons: 1, clickCount: 1 });
                await b.input({ kind: "mouse", type: "up", x: 100, y: 40, button: "left", buttons: 0, clickCount: 1 });
                return b.state().tabs[0]!.choice!;
            };
            const many = await open("/many");
            expect([many.options.length, many.options[2]]).toEqual([500, { label: "opt 0" }]);
            for (const path of ["/big", "/odd"]) {
                const c = await open(path);
                expect({ path, options: c.options.length, labels: c.options.every((o) => typeof o.label === "string" && o.label.length <= 200), selected: c.selected, bytes: JSON.stringify(b.state()).length < 200_000 }).toEqual({ path, options: 2, labels: true, selected: 0, bytes: true });
            }
            // After going to another site (another process, where ids start again), the world asked is still the pane's
            // own: a page there with frames that redefine the same things gets no more through.
            await open("/moves");
            const other = `http://127.0.0.1:${site.port}`;
            pages["/frames"] = `<body style="margin:0">${Array.from({ length: 8 }, () => `<iframe src="/big" style="position:absolute;left:0;top:0;width:300px;height:100px;border:0"></iframe>`).join("")}<select id=s style="position:absolute;left:0;top:0;width:200px;height:80px"><option>a</option><option>b</option></select></body>`;
            await p.goto(`${other}/frames`);
            await Bun.sleep(300);
            await b.input({ kind: "mouse", type: "down", x: 100, y: 40, button: "left", buttons: 1, clickCount: 1 });
            await b.input({ kind: "mouse", type: "up", x: 100, y: 40, button: "left", buttons: 0, clickCount: 1 });
            const after = b.state().tabs[0]!.choice;
            expect({ options: after?.options.length, small: JSON.stringify(b.state()).length < 200_000 }).toEqual({ options: 2, small: true });
            // The page puts another option where "b" was listed: picking "b" picks nothing.
            await open("/moves");
            await p.evaluate("s.options[1].text = 'c'");
            await b.choose(1);
            expect([await p.evaluate("s.value"), await p.evaluate("window.heard")]).toEqual(['"a"', "[]"]);
        } finally { void site.stop(true); }
    }, 60_000);

    test("a press reaches a busy page before its release, though it's the press that asks what's under it first", async () => {
        const html = `<body style="margin:20px"><button style="width:200px;height:60px">go</button><script>window.heard=[];for(const k of ['mousedown','mouseup','click'])addEventListener(k,()=>heard.push(k),true);setInterval(()=>{const t=performance.now();while(performance.now()-t<600);},610)</script></body>`;
        const site = Bun.serve({ port: 0, fetch: () => new Response(html, { headers: { "content-type": "text/html" } }) });
        const b = session();
        try {
            const p = await b.page();
            await p.goto(`http://localhost:${site.port}/`);
            for (let i = 0; i < 3; i++) {
                await p.evaluate("window.heard=[]");
                // As the server takes them: each message by itself, the release not waiting for the press.
                const down = b.input({ kind: "mouse", type: "down", x: 120, y: 50, button: "left", buttons: 1, clickCount: 1 });
                await Bun.sleep(80);
                const up = b.input({ kind: "mouse", type: "up", x: 120, y: 50, button: "left", buttons: 0, clickCount: 1 });
                await Promise.all([down, up]);
                for (let t = 0; t < 50 && (await p.evaluate("window.heard.length")) !== "3"; t++) await Bun.sleep(100);
                expect(await p.evaluate("window.heard.join()")).toBe('"mousedown,mouseup,click"');
            }
            // A double click: the second press doesn't pass the first release either.
            await p.evaluate("window.heard=[]");
            const o = { x: 120, y: 50, button: "left" as const };
            const sent = [
                b.input({ kind: "mouse", type: "down", ...o, buttons: 1, clickCount: 1 }),
                b.input({ kind: "mouse", type: "up", ...o, buttons: 0, clickCount: 1 }),
                b.input({ kind: "mouse", type: "down", ...o, buttons: 1, clickCount: 2 }),
                b.input({ kind: "mouse", type: "up", ...o, buttons: 0, clickCount: 2 }),
            ];
            await Promise.all(sent);
            for (let t = 0; t < 50 && (await p.evaluate("window.heard.length")) !== "6"; t++) await Bun.sleep(100);
            expect(await p.evaluate("window.heard.join()")).toBe('"mousedown,mouseup,click,mousedown,mouseup,click"');
            // And what's typed after a click goes where the click put the keyboard.
            await p.evaluate("document.body.insertAdjacentHTML('beforeend','<input id=i style=\"position:absolute;left:300px;top:20px;width:200px;height:40px\">'); 1");
            const click = b.input({ kind: "mouse", type: "down", x: 400, y: 40, button: "left", buttons: 1, clickCount: 1 });
            const release = b.input({ kind: "mouse", type: "up", x: 400, y: 40, button: "left", buttons: 0, clickCount: 1 });
            const typed = b.input({ kind: "text", text: "日本語" });
            await Promise.all([click, release, typed]);
            for (let t = 0; t < 50 && (await p.evaluate("document.getElementById('i').value")) !== '"日本語"'; t++) await Bun.sleep(100);
            expect(await p.evaluate("document.getElementById('i').value")).toBe('"日本語"');
        } finally { void site.stop(true); }
    }, 60_000);

    test("what a person did while a page hung isn't given to the page that comes after it", async () => {
        // The page hangs in its mousedown and goes to another site, which is slow to come: the clicks and the key
        // meant for the hung page aren't that site's.
        const A = `<body style="margin:20px"><button style="width:200px;height:60px" onmousedown="location.href=location.href.replace('localhost','127.0.0.1').replace('/a','/b');while(true);">hang</button></body>`;
        const B = `<body style="margin:20px"><button style="width:200px;height:60px">b</button><script>window.heard=[];for(const k of ['mousedown','mouseup','click','keydown'])addEventListener(k,()=>heard.push(k),true)</script></body>`;
        const site = Bun.serve({ port: 0, fetch: async (r) => (new URL(r.url).pathname === "/b" && (await Bun.sleep(1500)), new Response(new URL(r.url).pathname === "/b" ? B : A, { headers: { "content-type": "text/html" } })) });
        const b = session();
        try {
            const p = await b.page();
            await p.goto(`http://localhost:${site.port}/a`);
            const sent: Promise<unknown>[] = [];
            for (let i = 0; i < 3; i++) {
                sent.push(b.input({ kind: "mouse", type: "down", x: 120, y: 50, button: "left", buttons: 1, clickCount: 1 }));
                sent.push(b.input({ kind: "mouse", type: "up", x: 120, y: 50, button: "left", buttons: 0, clickCount: 1 }));
                await Bun.sleep(150);
            }
            sent.push(b.input({ kind: "key", type: "down", key: "a", code: "KeyA" }));
            await Promise.race([Promise.all(sent), Bun.sleep(20_000)]);
            for (let t = 0; t < 80 && !p.url.includes("/b"); t++) await Bun.sleep(100);
            await Bun.sleep(500);
            // No press, click or key of theirs is the new page's. (The release of the press the first page did get can
            // still land there, as it always could: by itself it presses nothing.)
            const heard = JSON.parse(await p.evaluate("window.heard")) as string[];
            expect([p.url.endsWith("/b"), heard.filter((k) => k !== "mouseup")]).toEqual([true, []]);
            expect(heard.length).toBeLessThanOrEqual(1);
        } finally { void site.stop(true); }
    }, 60_000);

    test("a press on a page that's leaving doesn't open the next page's dropdown", async () => {
        // The page hangs on its way to another site, which has a dropdown where the press lands.
        const A = `<body style="margin:20px"><div style="width:200px;height:60px">plain</div></body>`;
        const B = `<body style="margin:20px"><select style="width:200px;height:60px"><option>b-one</option><option>b-two</option></select><script>window.heard=[];addEventListener('mousedown',()=>heard.push('mousedown'),true)</script></body>`;
        const site = Bun.serve({ port: 0, fetch: async (r) => (new URL(r.url).pathname === "/b" && (await Bun.sleep(200)), new Response(new URL(r.url).pathname === "/b" ? B : A, { headers: { "content-type": "text/html" } })) });
        const b = session();
        try {
            const p = await b.page();
            await p.goto(`http://localhost:${site.port}/a`);
            const at = { x: 120, y: 50, button: "left" as const, clickCount: 1 };
            // A press first, so the pane has asked this page once (what it asks with is there to go stale).
            await b.input({ kind: "mouse", type: "down", ...at, buttons: 1 });
            await b.input({ kind: "mouse", type: "up", ...at, buttons: 0 });
            void p.send("Runtime.evaluate", { expression: `setTimeout(()=>{location.href='http://127.0.0.1:${site.port}/b';while(true);},0)` }).catch(() => undefined);
            await Bun.sleep(100);
            await b.input({ kind: "mouse", type: "down", ...at, buttons: 1 });
            await b.input({ kind: "mouse", type: "up", ...at, buttons: 0 });
            for (let t = 0; t < 80 && !p.url.includes("/b"); t++) await Bun.sleep(100);
            await Bun.sleep(300);
            expect([p.url.endsWith("/b"), b.state().tabs[0]!.choice, await p.evaluate("window.heard.join()")]).toEqual([true, undefined, '""']);
            // And the page that came is used as any other: its dropdown opens on a press of its own.
            await b.input({ kind: "mouse", type: "down", ...at, buttons: 1 });
            await b.input({ kind: "mouse", type: "up", ...at, buttons: 0 });
            expect(b.state().tabs[0]!.choice?.options.map((o) => o.label)).toEqual(["b-one", "b-two"]);
        } finally { void site.stop(true); }
    }, 60_000);

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
