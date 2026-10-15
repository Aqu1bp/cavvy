// The sandbox's per-command proxy: which hosts it lets through, what it
// refuses (and remembers for the model), and that only its own command can use it.

import { afterAll, describe, expect, mock, test } from "bun:test";
import { connect, createServer, type Server } from "net";

// Names that resolve to local addresses, without depending on real DNS.
const FAKE_DNS: Record<string, string[]> = { "metadata.test": ["169.254.169.254"], "rebind.test": ["127.0.0.1", "::1"], "mixed.test": ["127.0.0.1", "127.0.0.2"] };
const realDns = await import("dns/promises");
// The mock replaces the module in place, so keep the real function first.
const realLookup = realDns.lookup.bind(realDns);
mock.module("dns/promises", () => ({
    ...realDns,
    lookup: async (host: string, opts?: unknown) => (FAKE_DNS[host] ? FAKE_DNS[host]!.map((address) => ({ address, family: address.includes(":") ? 6 : 4 })) : realLookup(host, opts as never)),
}));
const { parseHostRule, ruleMatches, isLocalAddress, startProxy, proxyEnv, refusedHint } = await import("../src/permissions/proxy");

describe("host rules", () => {
    test.each([
        ["registry.npmjs.org", { host: "registry.npmjs.org" }],
        ["Registry.NPMJS.org ", { host: "registry.npmjs.org" }],
        ["*.example.com", { host: "*.example.com" }],
        ["example.com:8443", { host: "example.com", port: 8443 }],
        ["10.0.0.5", { host: "10.0.0.5" }],
        ["[::1]:5432", { host: "::1", port: 5432 }],
        ["::1", { host: "::1" }],
        ["localhost", { host: "localhost" }],
    ])("%p parses", (entry, rule) => {
        expect(parseHostRule(entry)).toEqual(rule);
    });

    test.each(["*", "*.com", "https://example.com", "example.com/path", "user@example.com", "example.com:0", "example.com:70000", "exa mple.com", "-bad.com", "", "*.*.com", "[example.com]:80", "example..com"])(
        "%p is refused",
        (entry) => {
            expect(parseHostRule(entry)).toBeUndefined();
        },
    );

    test("a wildcard covers subdomains, not the domain itself or IPs; a port pins the port", () => {
        const wild = parseHostRule("*.example.com")!;
        expect(ruleMatches(wild, "a.example.com", 443)).toBe(true);
        expect(ruleMatches(wild, "a.b.EXAMPLE.com", 80)).toBe(true);
        expect(ruleMatches(wild, "example.com", 443)).toBe(false);
        expect(ruleMatches(wild, "badexample.com", 443)).toBe(false);
        const pinned = parseHostRule("example.com:8443")!;
        expect(ruleMatches(pinned, "example.com", 8443)).toBe(true);
        expect(ruleMatches(pinned, "example.com", 443)).toBe(false);
        expect(ruleMatches(parseHostRule("example.com")!, "example.com", 22)).toBe(true);
    });

    test("an address matches however it's spelled", () => {
        expect(ruleMatches(parseHostRule("::1")!, "0:0:0:0:0:0:0:1", 80)).toBe(true);
        expect(ruleMatches(parseHostRule("127.0.0.1")!, "::ffff:7f00:1", 80)).toBe(true);
        expect(ruleMatches(parseHostRule("10.0.0.5")!, "10.0.0.6", 80)).toBe(false);
        expect(ruleMatches(parseHostRule("::1")!, "::2", 80)).toBe(false);
        // The same link-local address on another link is another machine.
        expect(ruleMatches(parseHostRule("fe80::1%en0")!, "FE80:0::1%en0", 80)).toBe(true);
        expect(ruleMatches(parseHostRule("fe80::1%en0")!, "fe80::1%en1", 80)).toBe(false);
        expect(ruleMatches(parseHostRule("fe80::1%en0")!, "fe80::1", 80)).toBe(false);
    });

    test("local addresses: loopback, unspecified, link-local, mapped, and this machine's own", () => {
        for (const a of ["127.0.0.1", "127.1.2.3", "0.0.0.0", "169.254.169.254", "::1", "::", "fe80::1", "::ffff:127.0.0.1", "::ffff:169.254.169.254"]) expect(isLocalAddress(a)).toBe(true);
        // However the address is spelled.
        for (const a of ["0:0:0:0:0:0:0:1", "::ffff:7f00:1", "0:0:0:0:0:ffff:7f00:1", "::ffff:a9fe:a9fe", "::a9fe:a9fe", "64:ff9b::a9fe:a9fe", "64:ff9b::127.0.0.1", "FE80::1%lo0", "febf::1"]) expect(isLocalAddress(a)).toBe(true);
        // Private ranges aren't local (a LAN database is reachable when listed), unless they're this machine's.
        for (const a of ["8.8.8.8", "2606:4700::1111", "::ffff:8.8.8.8", "fec0::1", "not-an-ip", "localhost"]) expect(isLocalAddress(a)).toBe(false);
        const own = Object.values(require("os").networkInterfaces() as Record<string, { address: string; internal: boolean }[]>).flat().find((i) => !i.internal && !i.address.includes(":"));
        if (own) expect(isLocalAddress(own.address)).toBe(true);
    });
});

// ---------------------------------------------------------------------------

/** A TCP server that answers every connection with what it received, once. */
async function echoServer(): Promise<{ port: number; server: Server; seen: string[] }> {
    const seen: string[] = [];
    const server = createServer((s) => {
        let buf = "";
        s.on("data", (d) => {
            buf += d.toString("latin1");
            if (buf.includes("\r\n\r\n") || buf.includes("PING")) {
                seen.push(buf);
                s.end(buf.startsWith("PING") ? "PONG" : `HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok`);
            }
        });
        s.on("error", () => {});
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { port: (server.address() as { port: number }).port, server, seen };
}

/** Sends raw bytes to the proxy and collects the reply until it closes. */
function talk(proxyUrl: string, raw: string, opts: { auth?: string | null; after?: string } = {}): Promise<string> {
    const u = new URL(proxyUrl);
    const auth = opts.auth === undefined ? `Basic ${Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString("base64")}` : opts.auth;
    const head = raw.replace("\r\n\r\n", `${auth ? `\r\nProxy-Authorization: ${auth}` : ""}\r\n\r\n`);
    return new Promise((resolve) => {
        const s = connect(Number(u.port), u.hostname);
        let out = "";
        s.on("data", (d) => {
            out += d.toString("latin1");
            if (opts.after && out.includes("200 Connection Established") && !out.includes("PONG")) s.write(opts.after);
        });
        s.on("close", () => resolve(out));
        s.on("error", () => resolve(out));
        s.write(head);
    });
}

describe("the proxy", async () => {
    const echo = await echoServer();
    afterAll(() => echo.server.close());

    test("its URL carries credentials; without them (or with wrong ones) it asks for them", async () => {
        const p = await startProxy([{ host: "127.0.0.1" }]);
        try {
            expect(p.url).toMatch(/^http:\/\/harness:[\w-]{20,}@127\.0\.0\.1:\d+$/);
            for (const auth of [null, "Basic " + Buffer.from("harness:wrong").toString("base64")]) {
                const r = await talk(p.url, `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`, { auth });
                expect(r).toStartWith("HTTP/1.1 407 Proxy Authentication Required");
                expect(r).toContain('Proxy-Authenticate: Basic realm="harness"');
            }
            expect(p.refused()).toEqual([]);
            // Each command's proxy has its own.
            const other = await startProxy([]);
            expect(new URL(other.url).password).not.toBe(new URL(p.url).password);
            other.close();
        } finally {
            p.close();
        }
    });

    test("CONNECT to a listed host opens a tunnel", async () => {
        const p = await startProxy([{ host: "127.0.0.1", port: echo.port }]);
        try {
            const r = await talk(p.url, `CONNECT 127.0.0.1:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`, { after: "PING" });
            expect(r).toStartWith("HTTP/1.1 200 Connection Established\r\n\r\n");
            expect(r).toEndWith("PONG");
        } finally {
            p.close();
        }
    });

    test("a plain http request is forwarded in origin form, without the proxy's headers, one per connection", async () => {
        const p = await startProxy([{ host: "127.0.0.1" }]);
        try {
            echo.seen.length = 0;
            const r = await talk(p.url, `GET http://127.0.0.1:${echo.port}/a/b?c=1 HTTP/1.1\r\nHost: other.example\r\nProxy-Connection: keep-alive\r\nX-Kept: yes\r\n\r\n`);
            expect(r).toContain("200 OK");
            expect(echo.seen[0]).toStartWith(`GET /a/b?c=1 HTTP/1.1\r\nHost: 127.0.0.1:${echo.port}\r\n`);
            // The Host header names the host that was checked.
            expect(echo.seen[0]).not.toContain("other.example");
            expect(echo.seen[0]).toContain("X-Kept: yes");
            expect(echo.seen[0]).toContain("Connection: close");
            expect(echo.seen[0]!.toLowerCase()).not.toContain("proxy-");
        } finally {
            p.close();
        }
    });

    test("anything else is refused, and remembered once each", async () => {
        const p = await startProxy([{ host: "*.example.com" }, { host: "127.0.0.1", port: 1 }]);
        try {
            for (const target of ["evil.test:443", "evil.test:443", "example.com:443", `127.0.0.1:${echo.port}`, "[::1]:8080"]) {
                const r = await talk(p.url, `CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`);
                expect(r).toStartWith("HTTP/1.1 403 Forbidden");
                expect(r).toContain("allowedHosts");
            }
            const r = await talk(p.url, `GET http://Other.TEST/x HTTP/1.1\r\nHost: other.test\r\n\r\n`);
            expect(r).toStartWith("HTTP/1.1 403");
            expect(p.refused()).toEqual([
                { host: "evil.test", port: 443 },
                { host: "example.com", port: 443 },
                { host: "127.0.0.1", port: echo.port },
                { host: "::1", port: 8080 },
                { host: "other.test", port: 80 },
            ]);
        } finally {
            p.close();
        }
    });

    test("a listed name that resolves only to local addresses is refused; its IP, listed, isn't", async () => {
        const p = await startProxy([{ host: "metadata.test" }, { host: "rebind.test" }, { host: "mixed.test" }]);
        try {
            for (const name of ["metadata.test", "rebind.test", "mixed.test"]) {
                const r = await talk(p.url, `CONNECT ${name}:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`);
                expect(r).toStartWith("HTTP/1.1 403");
                expect(r).toContain("resolves only to local addresses");
            }
            expect(p.refused().map((x) => x.local)).toEqual([true, true, true]);
        } finally {
            p.close();
        }
    });

    test("localhost names may resolve to loopback", async () => {
        const p = await startProxy([{ host: "localhost" }]);
        try {
            const r = await talk(p.url, `CONNECT localhost:${echo.port} HTTP/1.1\r\nHost: x\r\n\r\n`, { after: "PING" });
            expect(r).toEndWith("PONG");
        } finally {
            p.close();
        }
    });

    test("bad requests and oversized headers get an error, not a hang", async () => {
        const p = await startProxy([{ host: "127.0.0.1" }]);
        try {
            expect(await talk(p.url, "CONNECT nonsense HTTP/1.1\r\nHost: x\r\n\r\n")).toStartWith("HTTP/1.1 400");
            expect(await talk(p.url, "GET /relative HTTP/1.1\r\nHost: x\r\n\r\n")).toStartWith("HTTP/1.1 400");
            expect(await talk(p.url, "GET ftp://127.0.0.1/x HTTP/1.1\r\nHost: x\r\n\r\n")).toStartWith("HTTP/1.1 400");
            // Names that aren't DNS names, which a wildcard's suffix match could otherwise let through.
            const wild = await startProxy([{ host: "*.example.com" }]);
            for (const target of ["evil.test#.example.com:443", "evil.test%00.example.com:443", "evil.test\t.example.com:443", "a..example.com:443", "a.example.com.:443"]) {
                expect(await talk(wild.url, `CONNECT ${target} HTTP/1.1\r\nHost: x\r\n\r\n`)).toStartWith("HTTP/1.1 400");
            }
            wild.close();
            expect(await talk(p.url, `GET http://127.0.0.1/ HTTP/1.1\r\nX: ${"a".repeat(70_000)}`, { auth: null })).toStartWith("HTTP/1.1 431");
        } finally {
            p.close();
        }
    });

    test("close() ends open tunnels and stops listening", async () => {
        const silent = createServer((s) => s.on("error", () => {}));
        await new Promise<void>((r) => silent.listen(0, "127.0.0.1", () => r()));
        const port = (silent.address() as { port: number }).port;
        const p = await startProxy([{ host: "127.0.0.1" }]);
        const pending = talk(p.url, `CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: x\r\n\r\n`);
        await Bun.sleep(100);
        p.close();
        expect(await pending).toStartWith("HTTP/1.1 200");
        const after = await new Promise<boolean>((resolve) => {
            const s = connect(Number(new URL(p.url).port), "127.0.0.1");
            s.once("connect", () => (s.destroy(), resolve(true)));
            s.once("error", () => resolve(false));
        });
        expect(after).toBe(false);
        silent.close();
    });
});

test("proxyEnv points the usual variables at it and leaves localhost direct", () => {
    const env = proxyEnv("http://harness:pw@127.0.0.1:9");
    for (const k of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "npm_config_proxy", "npm_config_https_proxy"]) expect(env[k]).toBe("http://harness:pw@127.0.0.1:9");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,.localhost");
    expect(env.NODE_USE_ENV_PROXY).toBe("1");
});

test("refusedHint names the hosts to list, with ports only when unusual", () => {
    expect(refusedHint([])).toBeUndefined();
    expect(refusedHint([{ host: "registry.npmjs.org", port: 443 }, { host: "example.com", port: 80 }, { host: "db.example.com", port: 5432 }, { host: "::1", port: 8080 }])).toBe(
        '[The sandbox refused connections to registry.npmjs.org:443, example.com:80, db.example.com:5432, [::1]:8080. If the command needs them, run it again with allowedHosts: ["registry.npmjs.org","example.com","db.example.com:5432","[::1]:8080"]; the safety reviewer checks the hosts against the task.]',
    );
    expect(refusedHint([{ host: "metadata.test", port: 80, local: true }])).toBe("[metadata.test resolves only to local addresses, which the sandbox doesn't open for a host name.]");
});
