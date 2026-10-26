// A small web app for trying the GUI's Browser pane (scripts/gui-demo.ts): a status page with a button, a form, a dialog,
// a script error and a page of its own to open, served from 127.0.0.1 (a "localhost" address the agent may open unasked).

const PAGE = (title: string, body: string) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>
  body { font: 15px/1.5 system-ui, sans-serif; margin: 0; color: #1b2330; background: #f5f7fb; }
  header { display: flex; gap: 18px; align-items: center; padding: 14px 28px; background: #1b2330; color: #fff; }
  header b { font-size: 16px; margin-right: auto; } header a { color: #b9c6dd; text-decoration: none; }
  main { max-width: 720px; margin: 28px auto; padding: 0 28px; }
  .card { background: #fff; border-radius: 12px; padding: 18px 22px; margin-bottom: 16px; box-shadow: 0 1px 3px #0001; }
  button { font: inherit; padding: 7px 14px; border-radius: 8px; border: 0; background: #3b6cf6; color: #fff; cursor: pointer; margin-right: 8px; }
  button.quiet { background: #e4e9f3; color: #1b2330; }
  input { font: inherit; padding: 7px 10px; border: 1px solid #c8d1e0; border-radius: 8px; }
  .up { color: #168a4a; font-weight: 600; } .tall { height: 900px; background: linear-gradient(#fff, #dbe4f6); border-radius: 12px; }
</style></head><body>
<header><b>Acme status</b><a href="/">Overview</a><a href="/incidents">Incidents</a></header>
<main>${body}</main></body></html>`;

const HOME = PAGE(
    "Acme status",
    `<h1>All systems operational</h1>
<div class="card"><p>API <span class="up">up</span> &middot; Web <span class="up">up</span> &middot; Billing <span class="up">up</span></p>
<button id="sub" onclick="this.textContent='Subscribed ('+(window.n=(window.n||0)+1)+')'">Subscribe to updates</button>
<button class="quiet" onclick="document.getElementById('out').textContent='confirmed: '+confirm('Send a test notification?')">Send test</button>
<button class="quiet" onclick="console.error('Deploy hook failed');fetch('/missing.json').catch(function(){})">Check deploy hook</button>
<p id="out" role="status"></p></div>
<form class="card" onsubmit="event.preventDefault();document.getElementById('found').textContent='No incidents matching &quot;'+document.getElementById('q').value+'&quot;'">
<label for="q">Search incidents</label><br><input id="q" placeholder="e.g. billing"> <button type="submit">Search</button><p id="found"></p></form>
<div class="tall"></div>`,
);
const INCIDENTS = PAGE("Incidents - Acme status", `<h1>Incidents</h1><div class="card"><p>No incidents in the last 90 days.</p><a href="/">Back to the overview</a></div>`);

export function startDemoSite(port = 0) {
    const server = Bun.serve({
        hostname: "127.0.0.1",
        port,
        fetch(req) {
            const path = new URL(req.url).pathname;
            const html = (body: string) => new Response(body, { headers: { "content-type": "text/html; charset=utf-8" } });
            if (path === "/") return html(HOME);
            if (path === "/incidents") return html(INCIDENTS);
            return new Response("not found", { status: 404 });
        },
    });
    return { url: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}
