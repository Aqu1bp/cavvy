// The sandbox's way to the network. A sandboxed command can only reach
// localhost; each one gets its own proxy listening there, which opens
// connections to the hosts the command was approved for (allowedHosts, which
// the reviewer saw) and refuses the rest, remembering them so the model can be
// told what to ask for. Tools find it through HTTPS_PROXY and the like; one
// that ignores those (plain ssh, database drivers) can't connect at all.
//
// Like any proxy that doesn't look inside TLS, it decides on the hostname the
// client asks for, so a host that fronts others (a CDN) can reach those too.

import { randomBytes } from "crypto";
import { lookup } from "dns/promises";
import { connect, createServer, isIP, type Server, type Socket } from "net";
import { networkInterfaces } from "os";

export interface HostRule {
    /** Lowercase; `*.example.com` matches its subdomains. */
    host: string;
    /** Any port when unset. */
    port?: number;
}

const LABEL = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** `example.com`, `*.example.com`, `example.com:8443`, `10.0.0.5`, `[::1]:5432`; undefined if it's none of those. */
export function parseHostRule(entry: string): HostRule | undefined {
    const s = entry.trim().toLowerCase();
    let host = s;
    let port: number | undefined;
    const v6 = /^\[([0-9a-f:.]+)\](?::(\d+))?$/.exec(s);
    if (v6) {
        host = v6[1]!;
        if (v6[2]) port = Number(v6[2]);
        if (isIP(host) !== 6) return undefined;
    } else {
        const m = /^([^:]+)(?::(\d+))?$/.exec(s);
        if (!m) return isIP(s) === 6 ? { host: s } : undefined;
        host = m[1]!;
        if (m[2]) port = Number(m[2]);
        if (!isIP(host)) {
            const wild = host.startsWith("*.");
            const labels = (wild ? host.slice(2) : host).split(".");
            if (!labels.every((l) => LABEL.test(l))) return undefined;
            // `*.com` would be every .com site.
            if (wild && labels.length < 2) return undefined;
        }
    }
    if (port !== undefined && !(Number.isInteger(port) && port > 0 && port < 65536)) return undefined;
    return port === undefined ? { host } : { host, port };
}

export function ruleMatches(rule: HostRule, host: string, port: number): boolean {
    if (rule.port !== undefined && rule.port !== port) return false;
    const h = host.toLowerCase();
    if (rule.host.startsWith("*.")) return h.endsWith(rule.host.slice(1)) && h.length > rule.host.length - 1 && !isIP(h);
    // An address can be written many ways (`::1`, `0:0:0:0:0:0:0:1`, `::ffff:7f00:1`); its zone (`%en0`) picks the link, so it must match too.
    const zone = (a: string) => /%.*$/.exec(a)?.[0] ?? "";
    if (isIP(h) && isIP(rule.host)) return canonicalIp(h) === canonicalIp(rule.host) && zone(h) === zone(rule.host);
    return h === rule.host;
}

/** The eight 16-bit words of an IPv6 address, or undefined. */
function ipv6Words(a: string): number[] | undefined {
    if (isIP(a) !== 6) return undefined;
    let s = a.toLowerCase().replace(/%.*$/, "");
    // A dotted IPv4 tail is two words.
    const tail = /(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(s);
    if (tail) {
        const [b0, b1, b2, b3] = tail.slice(1).map(Number) as [number, number, number, number];
        s = s.slice(0, tail.index) + `${((b0 << 8) | b1).toString(16)}:${((b2 << 8) | b3).toString(16)}`;
    }
    const [head = "", rest] = s.split("::");
    const parse = (part: string) => (part ? part.split(":").map((w) => parseInt(w, 16)) : []);
    const front = parse(head);
    const back = rest === undefined ? [] : parse(rest);
    const words = rest === undefined ? front : [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
    return words.length === 8 && words.every((w) => Number.isInteger(w) && w >= 0 && w <= 0xffff) ? words : undefined;
}

/** The IPv4 address an IPv6 one stands for: mapped (::ffff:a.b.c.d), compatible (::a.b.c.d) or NAT64 (64:ff9b::a.b.c.d). */
function embeddedIpv4(w: number[]): string | undefined {
    const zero = (from: number, to: number) => w.slice(from, to).every((x) => x === 0);
    const mapped = zero(0, 5) && w[5] === 0xffff;
    const compatible = zero(0, 6) && (w[6]! !== 0 || w[7]! > 1);
    const nat64 = w[0] === 0x64 && w[1] === 0xff9b && zero(2, 6);
    if (!mapped && !compatible && !nat64) return undefined;
    return [w[6]! >> 8, w[6]! & 0xff, w[7]! >> 8, w[7]! & 0xff].join(".");
}

/** One spelling per address: IPv4 dotted, IPv6 as eight full words (an embedded IPv4 address as itself). */
function canonicalIp(addr: string): string {
    const a = addr.toLowerCase().replace(/%.*$/, "");
    const w = ipv6Words(a);
    if (!w) return a;
    return embeddedIpv4(w) ?? w.map((x) => x.toString(16)).join(":");
}

/** Loopback, unspecified, link-local (the 169.254.169.254 metadata endpoint), or one of this machine's own addresses. */
export function isLocalAddress(addr: string): boolean {
    if (!isIP(addr.replace(/%.*$/, ""))) return false;
    const a = canonicalIp(addr);
    if (isIP(a) === 4) {
        const [x, y] = a.split(".").map(Number);
        if (x === 127 || x === 0 || (x === 169 && y === 254)) return true;
    } else {
        const w = ipv6Words(a)!;
        const loopbackOrUnspecified = w.slice(0, 7).every((x) => x === 0) && w[7]! <= 1;
        if (loopbackOrUnspecified || (w[0]! & 0xffc0) === 0xfe80) return true;
    }
    return ownAddresses().has(a);
}

function ownAddresses(): Set<string> {
    const out = new Set<string>();
    for (const list of Object.values(networkInterfaces())) for (const i of list ?? []) out.add(canonicalIp(i.address));
    return out;
}

/** A host name as DNS has them (letters, digits, dashes, dots), so the name checked is the name looked up. */
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** A connection the proxy turned down. */
export interface Refusal {
    host: string;
    port: number;
    /** It was listed, but its name resolves only to local addresses. */
    local?: boolean;
}

export interface CommandProxy {
    /** With credentials in it: tools send them, and the proxy turns away anything that doesn't. */
    url: string;
    /** In order, without repeats. */
    refused(): Refusal[];
    close(): void;
}

const MAX_HEAD = 64 * 1024;
const CONNECT_TIMEOUT_MS = 30_000;

/** A proxy on localhost that lets through connections to these hosts only. */
export async function startProxy(rules: HostRule[]): Promise<CommandProxy> {
    const refused = new Map<string, Refusal>();
    const refuse = (r: Refusal) => {
        const key = `${hostPort(r.host, r.port)}${r.local ? " local" : ""}`;
        if (!refused.has(key)) refused.set(key, r);
    };
    // Every command's proxy listens on localhost, where any other sandboxed
    // command could reach it too; the password keeps each to its own hosts.
    // (A program running as the user can read it from the command's environment.)
    const password = randomBytes(18).toString("base64url");
    const expected = `Basic ${Buffer.from(`cavvy:${password}`).toString("base64")}`;
    const sockets = new Set<Socket>();
    let closed = false;
    const track = (s: Socket) => {
        s.on("error", () => {});
        // A lookup or connection still under way when the command ended gets nowhere.
        if (closed) return void s.destroy();
        sockets.add(s);
        s.on("close", () => sockets.delete(s));
    };
    const server: Server = createServer((client) => {
        track(client);
        let head = Buffer.alloc(0);
        const onData = (d: Buffer) => {
            head = Buffer.concat([head, d]);
            const end = head.indexOf("\r\n\r\n");
            if (end < 0) {
                if (head.length > MAX_HEAD) reply(client, 431, "Request header too large");
                return;
            }
            client.off("data", onData);
            client.pause();
            void handle(client, head.subarray(0, end + 4).toString("latin1"), head.subarray(end + 4));
        };
        client.on("data", onData);
    });

    async function handle(client: Socket, head: string, rest: Buffer) {
        const [requestLine = "", ...headers] = head.slice(0, -4).split("\r\n");
        const [method = "", target = "", version = "HTTP/1.1"] = requestLine.split(" ");
        const auth = headers.find((h) => /^proxy-authorization:/i.test(h))?.replace(/^[^:]*:\s*/, "");
        // Some clients (git) only send credentials once asked for them.
        if (auth !== expected) return reply(client, 407, "Proxy authentication required", ['Proxy-Authenticate: Basic realm="cavvy"']);
        let host: string;
        let port: number;
        let forward: string | undefined;
        if (method === "CONNECT") {
            const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) ?? /^([^:]+):(\d+)$/.exec(target);
            if (!m) return reply(client, 400, "Bad CONNECT target");
            host = m[1]!.toLowerCase();
            port = Number(m[2]);
        } else {
            let url: URL;
            try {
                url = new URL(target);
            } catch {
                return reply(client, 400, "Only absolute http:// URLs can be proxied");
            }
            if (url.protocol !== "http:") return reply(client, 400, "Only http:// URLs can be proxied without CONNECT");
            host = url.hostname.replace(/^\[|\]$/g, "");
            port = Number(url.port || 80);
            // One request per connection, so every request's host is checked; the Host
            // header names the host that was checked, not another one on the same server.
            const kept = headers.filter((h) => !/^(proxy-connection|proxy-authorization|connection|keep-alive|host):/i.test(h));
            forward = [`${method} ${url.pathname}${url.search} ${version}`, `Host: ${url.host}`, ...kept, "Connection: close", "", ""].join("\r\n");
        }
        if (!isIP(host) && !HOSTNAME.test(host)) return reply(client, 400, `Not a host name: ${JSON.stringify(host).slice(0, 100)}`);
        const label = hostPort(host, port);
        if (!rules.some((r) => ruleMatches(r, host, port))) {
            refuse({ host, port });
            return reply(client, 403, `Cavvy sandbox doesn't allow ${label}. List the host in allowedHosts to ask for it.`);
        }
        let addresses = [host];
        if (!isIP(host)) {
            // Connect to the addresses that were checked, so a second lookup can't change them.
            const found = await lookup(host, { all: true }).catch(() => []);
            const isLocalhost = host === "localhost" || host.endsWith(".localhost");
            addresses = found.map((f) => f.address).filter((a) => isLocalhost || !isLocalAddress(a));
            if (!addresses.length) {
                if (!found.length) return reply(client, 502, `Could not resolve ${host}`);
                refuse({ host, port, local: true });
                return reply(client, 403, `${host} resolves only to local addresses; list the IP address itself to allow it.`);
            }
        }
        const upstream = await connectFirst(addresses, port, track).catch((e: Error) => {
            reply(client, /timed out/.test(e.message) ? 504 : 502, `Could not connect to ${label}: ${e.message}`);
            return undefined;
        });
        if (!upstream) return;
        if (client.destroyed) return upstream.destroy();
        if (forward === undefined) client.write(`${version} 200 Connection Established\r\n\r\n`);
        else upstream.write(forward);
        if (rest.length) upstream.write(rest);
        client.pipe(upstream);
        upstream.pipe(client);
        client.resume();
        client.once("close", () => upstream.destroy());
        upstream.once("close", () => client.destroy());
    }

    await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", () => resolve());
    });
    const { port } = server.address() as { port: number };
    // A failed accept (too many open files, say) mustn't take Cavvy down.
    server.on("error", () => {});
    // The proxy mustn't keep Cavvy alive on its own.
    server.unref();
    return {
        url: `http://cavvy:${password}@127.0.0.1:${port}`,
        refused: () => [...refused.values()],
        close: () => {
            closed = true;
            server.close();
            for (const s of sockets) s.destroy();
        },
    };
}

/** A connection to the first of these addresses that answers (a name's IPv6 address may not, say). */
async function connectFirst(addresses: string[], port: number, track: (s: Socket) => void): Promise<Socket> {
    let last: Error = new Error("no address");
    for (const host of addresses) {
        try {
            return await new Promise<Socket>((resolve, reject) => {
                const s = connect({ host, port, timeout: CONNECT_TIMEOUT_MS });
                // Tracked while connecting too, so closing the proxy ends it.
                track(s);
                const fail = (e: Error) => reject(e);
                s.once("error", fail);
                s.once("close", () => reject(new Error("closed")));
                s.once("timeout", () => {
                    reject(new Error(`timed out after ${CONNECT_TIMEOUT_MS / 1000}s`));
                    s.destroy();
                });
                s.once("connect", () => {
                    s.setTimeout(0);
                    s.off("error", fail);
                    resolve(s);
                });
            });
        } catch (e) {
            last = e as Error;
        }
    }
    throw last;
}

function hostPort(host: string, port: number): string {
    return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

function reply(client: Socket, status: number, message: string, extra: string[] = []) {
    if (client.destroyed) return;
    const reason = { 400: "Bad Request", 403: "Forbidden", 407: "Proxy Authentication Required", 431: "Request Header Fields Too Large", 502: "Bad Gateway", 504: "Gateway Timeout" }[status] ?? "Error";
    const body = `${message}\n`;
    client.end([`HTTP/1.1 ${status} ${reason}`, "Content-Type: text/plain", `Content-Length: ${Buffer.byteLength(body)}`, ...extra, "Connection: close", "", body].join("\r\n"));
}

/** What points a command's tools at the proxy. Local addresses go direct (the sandbox allows them). */
export function proxyEnv(url: string): Record<string, string> {
    const local = "localhost,127.0.0.1,::1,.localhost";
    return {
        HTTP_PROXY: url,
        HTTPS_PROXY: url,
        ALL_PROXY: url,
        http_proxy: url,
        https_proxy: url,
        all_proxy: url,
        NO_PROXY: local,
        no_proxy: local,
        npm_config_proxy: url,
        npm_config_https_proxy: url,
        // Node's own fetch and http only use the variables above when told to.
        NODE_USE_ENV_PROXY: "1",
    };
}

/** For the model, after a sandboxed command failed: what the proxy refused and how to ask for it. */
export function refusedHint(refused: Refusal[]): string | undefined {
    const unlisted = refused.filter((r) => !r.local);
    const local = [...new Set(refused.filter((r) => r.local).map((r) => r.host))];
    const parts: string[] = [];
    if (unlisted.length) {
        // The usual ports need no port in the rule; others are asked for as given.
        const ask = [...new Set(unlisted.map((r) => (r.port === 80 || r.port === 443 ? r.host : hostPort(r.host, r.port))))];
        parts.push(`The sandbox refused connections to ${unlisted.map((r) => hostPort(r.host, r.port)).join(", ")}. If the command needs them, run it again with allowedHosts: ${JSON.stringify(ask)}; the safety reviewer checks the hosts against the task.`);
    }
    if (local.length) parts.push(`${local.join(", ")} resolve${local.length === 1 ? "s" : ""} only to local addresses, which the sandbox doesn't open for a host name.`);
    return parts.length ? `[${parts.join(" ")}]` : undefined;
}
