import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isolate, tempDir } from "./helpers/isolate";
import { chromePath } from "./helpers/browser-fixture";
const iso = isolate();
if (chromePath) process.env.HARNESS_BROWSER = chromePath;
const { BrowserSession } = await import("../src/browser/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BrowserNavigateTool, BrowserActTool, BrowserEvalTool } = await import("../src/tools/browser-tools");
const { registerSecret, unregisterSecret } = await import("../src/util/redact");
const { startDemoSite } = await import("../scripts/demo-site");
const { checkUrl } = await import("../src/browser/url-policy");
const root = tempDir("harness-browser-regressions-");
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
        const b = session({ refuse: (url: string, file?: string) => checker.urlRefusal(url, file) });
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
        expect(checker.urlRefusal(url("private/report.html"), realpathSync(join(root, "private/report.html")))).toContain("Denied");
        await expect(page.gotoApproved(url("private/report.html"), new AbortController().signal)).rejects.toThrow();
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
