// The text Find counts (gui/src/lib/find-text.ts) is the text the page shows: what the transcript renders, its tags
// taken out and its characters decoded, here and on the server, must be what a browser makes of the same HTML
// (textContent). Checked in a real browser, over every kind of block a reply has and the characters HTML escapes.
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderMarkdown } from "../gui/src/lib/markdown";
import { htmlText } from "../gui/src/lib/find-text";
import { STREAM_DEMO, longMarkdown } from "../scripts/mock-llm";

const chrome = [process.env.CAVVY_TEST_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/chromium", "/usr/bin/google-chrome", "/opt/pw-browsers/chromium-1243/chrome-linux64/chrome"].find((p) => p && existsSync(p));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function corpus(): string[] {
    const pieces = [
        "Plain words.", "**bold** and *em* and `code` and ~~gone~~", "# Heading", "Setext\n===", "---",
        "- a\n- b\n  - nested", "1. one\n2. two", "- [ ] todo\n- [x] done", "> quoted\n> more", "| a | b |\n| --- | ---: |\n| 1 | 2.5 |",
        "    indented code", "```ts\nconst x = a < b && c > d;\n```", "~~~\nraw <div> & \"quotes\" 'single'\n~~~",
        "<div>html shown as text</div>", "<!-- a comment -->", "a <b>tag</b> inline", "&copy; &amp; &lt; &gt; &quot; &#39; &#x27; &#169; &nbsp;x",
        "&copy without semicolon &notanentity; &amp", "5 < 6 > 4 & so on", "line one  \nline two", "a\\*b\\_c", "[a link](https://example.com \"t > i\")",
        "<https://example.com/a?b=1&c=2>", "![an image](https://example.com/x.png)", "![a file](./shot.png)", "see `src/server/find.ts:12`",
        "Ünïcödé — “quotes” ‘and’ … 𝄞 emoji 🎉", "tab\there", "trailing spaces   ", "[ref][r]\n\n[r]: https://example.com", "a\n\n\n\nb",
    ];
    let seed = 11;
    const rand = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296);
    const out = [STREAM_DEMO, longMarkdown(6000), ...pieces];
    for (let n = 0; n < 300; n++) {
        const parts = Array.from({ length: 2 + Math.floor(rand() * 6) }, () => pieces[Math.floor(rand() * pieces.length)]!);
        out.push(parts.join(["\n\n", "\n", " "][Math.floor(rand() * 3)]!));
    }
    return out;
}

test.skipIf(!chrome)("the text Find counts is the text a browser shows for the same reply", async () => {
    const profile = mkdtempSync(join(tmpdir(), "cavvy-find-text-"));
    const browser = Bun.spawn([chrome!, "--headless", "--no-first-run", ...(process.getuid?.() === 0 || process.env.CI ? ["--no-sandbox"] : []), `--user-data-dir=${profile}`, "--remote-debugging-port=0"], { stdout: "ignore", stderr: "ignore" });
    try {
        let port: string | undefined;
        for (let i = 0; i < 300 && !port; i++) { port = /^(\d+)\n/.exec(await Bun.file(join(profile, "DevToolsActivePort")).text().catch(() => ""))?.[1]; await sleep(100); }
        const version = (await fetch(`http://127.0.0.1:${port}/json/version`).then((r) => r.json())) as { webSocketDebuggerUrl: string };
        const ws = new WebSocket(version.webSocketDebuggerUrl);
        await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
        let seq = 0;
        const pending = new Map<number, (m: any) => void>();
        ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); if (m.id) { pending.get(m.id)?.(m); pending.delete(m.id); } };
        const call = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((r) => { const id = ++seq; pending.set(id, (m) => r(m.result)); ws.send(JSON.stringify({ id, method, params, sessionId })); });
        const { targetId } = await call("Target.createTarget", { url: "about:blank" });
        const { sessionId } = await call("Target.attachToTarget", { targetId, flatten: true });
        const html = corpus().map(renderMarkdown);
        const shown = (await call("Runtime.evaluate", { expression: `${JSON.stringify(html)}.map((h) => new DOMParser().parseFromString(h, "text/html").body.textContent)`, returnByValue: true }, sessionId)).result.value as string[];
        expect(shown).toHaveLength(html.length);
        const differ = html.map((h, i) => ({ html: h, ours: htmlText(h), browser: shown[i] })).filter((x) => x.ours !== x.browser);
        expect(differ.slice(0, 3)).toEqual([]);
        ws.close();
    } finally {
        browser.kill();
        await browser.exited;
        rmSync(profile, { recursive: true, force: true });
    }
}, 60_000);
