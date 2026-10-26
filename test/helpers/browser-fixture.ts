// A small site for the browser tests, served from 127.0.0.1, and the Chrome to drive it with.
import { existsSync } from "node:fs";

/** The Chrome the tests use: HARNESS_TEST_CHROME, else one in its usual place. Undefined where there is none (the test skips). */
export const chromePath = [process.env.HARNESS_TEST_CHROME, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"].find((p) => p && existsSync(p));

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Fixture shop</title>
<style>body{font:16px sans-serif;margin:0;padding:16px}#tall{height:3000px;background:linear-gradient(#fff,#ccc)}</style></head>
<body>
<header><nav aria-label="Main"><a href="/other">Other page</a> <a href="#frag">Jump</a></nav></header>
<main>
<h1>Fixture shop</h1>
<p>Welcome to the <strong>shop</strong>. Everything is <em>fake</em>.</p>
<button id="count" onclick="this.textContent='Clicked '+(window.n=(window.n||0)+1)">Click me</button>
<form id="f" onsubmit="event.preventDefault();document.getElementById('out').textContent='Searched: '+document.getElementById('q').value">
  <label for="q">Search</label><input id="q" name="q" type="text" placeholder="Find things">
  <label for="pw">Password</label><input id="pw" type="password" value="hunter2hunter2">
  <label><input id="agree" type="checkbox"> I agree</label>
  <label for="size">Size</label>
  <select id="size" onchange="document.getElementById('out').textContent='Size: '+this.value"><option value="s">Small</option><option value="m">Medium</option><option value="l">Large</option></select>
  <button type="submit">Go</button>
</form>
<p id="out" role="status"></p>
<button id="boom" onclick="console.error('boom happened'); setTimeout(function(){throw new Error('late failure')},0)">Break</button>
<button id="ask" onclick="document.getElementById('out').textContent='confirm:'+confirm('Really?')">Ask</button>
<button id="alert" onclick="alert('heads up');document.getElementById('out').textContent='alerted'">Alert</button>
<button id="fetch" onclick="fetch('/missing.json').catch(function(){});fetch('http://127.0.0.1:1/x').catch(function(){})">Fetch</button>
<button id="popup" onclick="window.open('/other','_blank')">Popup</button>
<button id="later" onclick="setTimeout(function(){document.getElementById('out').textContent='arrived'},300)">Later</button>
<ul><li>One</li><li>Two</li></ul>
<div id="tall"></div>
<button id="bottom" onclick="document.getElementById('out').textContent='bottom clicked'">Bottom button</button>
</main></body></html>`;

const OTHER = `<!doctype html><html><head><title>Other page</title></head><body><h1>The other page</h1><a href="/">Home</a></body></html>`;

/** The fixture site on a free port. */
export function fixtureServer() {
    const requests: string[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(req) {
            const path = new URL(req.url).pathname;
            requests.push(path);
            const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
            if (path === "/") return html(PAGE);
            if (path === "/other") return html(OTHER);
            // To the same server by another name: a deny rule for that host is what stops a page from following it.
            if (path === "/bounce") return Response.redirect(`http://localhost:${server.port}/other`, 302);
            if (path === "/download") return new Response("data", { headers: { "content-type": "application/octet-stream", "content-disposition": 'attachment; filename="x.bin"' } });
            return new Response("not found", { status: 404 });
        },
    });
    return { url: `http://127.0.0.1:${server.port}`, requests, stop: () => server.stop(true) };
}
