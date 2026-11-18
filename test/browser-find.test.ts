// The Browser pane's find bar on a headless Chrome (src/browser/find.ts): counted and marked in the pane's own world,
// where the page's scripts neither see nor change it, and cleared when the bar closes.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { isolate, tempDir } from "./helpers/isolate";
import { chromePath } from "./helpers/browser-fixture";
const iso = isolate();
if (chromePath) process.env.CAVVY_BROWSER = chromePath;
const { BrowserSession } = await import("../src/browser/session");
const { MAX_QUERY } = await import("../src/browser/find");

const PAGE = `<!doctype html><html><body>
<h1>Apple pie</h1>
<p>An apple a day. <b>App</b>le across elements.</p>
<p hidden>apple hidden</p>
<script>/* apple in a script */ window.String.prototype.toLowerCase = () => "nothing"; document.title = "apple";</script>
<div style="height:3000px"></div>
<p id="far">The last apple.</p>
</body></html>`;

describe.skipIf(!chromePath)("find in page", () => {
    const root = tempDir("cavvy-browser-find-");
    let session: InstanceType<typeof BrowserSession>;
    let server: ReturnType<typeof Bun.serve>;
    beforeAll(async () => {
        server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(PAGE, { headers: { "content-type": "text/html" } }) });
        session = new BrowserSession({ root, settings: () => ({}), pool: { startupMs: 90_000 } });
        const page = await session.page();
        await page.goto(`http://127.0.0.1:${server.port}/`);
    }, 100_000);
    afterAll(async () => {
        await session?.dispose();
        server?.stop(true);
        iso.cleanup();
    });

    test("counts what shows, across elements and in any case, in a world the page's scripts can't change", async () => {
        // The page broke its own toLowerCase: the search doesn't use the page's.
        expect(await session.find("apple", 0)).toEqual({ matches: 4, active: 1 });
        const page = await session.page();
        expect(await page.evaluate("CSS.highlights.get('cavvy-find').size")).toBe("4");
    });

    test("moves along and round, and scrolls the current match into view", async () => {
        expect(await session.find("apple", 1)).toEqual({ matches: 4, active: 2 });
        expect(await session.find("apple", 1)).toEqual({ matches: 4, active: 3 });
        expect(await session.find("apple", 1)).toEqual({ matches: 4, active: 4 });
        const page = await session.page();
        expect(Number(await page.evaluate("scrollY"))).toBeGreaterThan(1000);
        expect(await session.find("apple", 1)).toEqual({ matches: 4, active: 1 });
        expect(await session.find("apple", -1)).toEqual({ matches: 4, active: 4 });
        // Searched again (the page may have changed), it stays on its match.
        expect(await session.find("apple", 0)).toEqual({ matches: 4, active: 4 });
    });

    test("nothing found, and cleared", async () => {
        expect(await session.find("pear", 0)).toEqual({ matches: 0, active: 0 });
        expect(await session.find("apple", 0)).toMatchObject({ matches: 4 });
        expect(await session.find("", 0)).toEqual({ matches: 0, active: 0 });
        const page = await session.page();
        expect(await page.evaluate("CSS.highlights.has('cavvy-find')")).toBe("false");
    });

    test("a search too long is refused", async () => {
        await expect(session.find("x".repeat(MAX_QUERY + 1), 0)).rejects.toThrow(/at most/);
    });

    test("after the page goes elsewhere, a next match searches anew", async () => {
        const page = await session.page();
        await page.reload();
        expect(await session.find("apple", 1)).toMatchObject({ matches: 4 });
    });
});
