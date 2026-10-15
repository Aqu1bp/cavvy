// The GUI server: HTTP for the GUI's files, a WebSocket for everything else.
//
// Whoever can talk to this server can run commands as you, so:
//   - it listens on loopback only (127.0.0.1) unless told otherwise;
//   - every WebSocket needs the server's random token, sent as a subprotocol
//     ("auth.<token>") so it never appears in a URL, a log or a Referer;
//   - the browser link carries a one-time code instead (consumed on first use,
//     expires after two minutes), exchanged for the token by the page;
//   - Host and Origin headers are checked, so a web page that rebinds a DNS
//     name to 127.0.0.1 can't reach it even if it guessed the port;
//   - the GUI's files are served with a strict Content-Security-Policy.

import { randomBytes, timingSafeEqual } from "crypto";
import { existsSync, statSync } from "fs";
import { extname, join, normalize, resolve, sep } from "path";
import type { ServerWebSocket } from "bun";
import { Engine, RpcError, type EngineClient, type EngineOptions } from "./engine";
import type { ClientMessage, Method, ServerEvent, ServerMessage } from "./protocol";
import { redact, registerSecret } from "../util/redact";
import { wireReplacer } from "./timeline";

export interface ServeOptions extends EngineOptions {
    host?: string;
    port?: number;
    /** Fixed token (development); a random one otherwise. */
    token?: string;
    /** The built GUI (gui/dist), served at /. */
    staticDir?: string;
    /** Extra origins allowed to connect (a Vite dev server). */
    origins?: string[];
    log?: (msg: string) => void;
}

export interface RunningServer {
    engine: Engine;
    url: string;
    port: number;
    token: string;
    /** A single-use link for a browser. */
    loginUrl(): string;
    stop(): Promise<void>;
}

/** The desktop app's webview origins (macOS/Linux, Windows). */
const APP_ORIGINS = ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"];
const SUBPROTOCOL = "harness.v1";
const CODE_TTL_MS = 120_000;

const TYPES: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".wasm": "application/wasm",
    ".txt": "text/plain; charset=utf-8",
    ".webmanifest": "application/manifest+json",
};

function sameSecret(a: string, b: string): boolean {
    const x = Buffer.from(a);
    const y = Buffer.from(b);
    return x.length === y.length && timingSafeEqual(x, y);
}

interface Conn {
    client: EngineClient;
}

export async function startServer(o: ServeOptions = {}): Promise<RunningServer> {
    const host = o.host ?? "127.0.0.1";
    const token = o.token ?? randomBytes(32).toString("hex");
    // Kept out of transcripts, tool output and the environment of the commands it runs.
    registerSecret(token, "gui-token");
    const codes = new Map<string, number>();
    const log = o.log ?? (() => {});
    const engine = new Engine(o);
    await engine.start();
    const staticDir = o.staticDir && existsSync(join(o.staticDir, "index.html")) ? resolve(o.staticDir) : undefined;

    let port = 0;
    const hostOk = (h: string | null): boolean => {
        if (!h) return false;
        const allowed = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
        if (host !== "127.0.0.1" && host !== "localhost") allowed.push(`${host}:${port}`);
        return allowed.includes(h.toLowerCase());
    };
    const originOk = (origin: string | null): boolean => {
        if (origin === null) return true; // not a browser: the token decides
        const own = [`http://127.0.0.1:${port}`, `http://localhost:${port}`, `http://[::1]:${port}`];
        if (host !== "127.0.0.1" && host !== "localhost") own.push(`http://${host}:${port}`);
        return [...own, ...APP_ORIGINS, ...(o.origins ?? [])].includes(origin);
    };
    const securityHeaders = {
        "X-Content-Type-Options": "nosniff",
        "Referrer-Policy": "no-referrer",
        "X-Frame-Options": "DENY",
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Resource-Policy": "same-origin",
    };
    const csp = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
        "worker-src 'self' blob:",
        "frame-ancestors 'none'",
        "base-uri 'none'",
        "form-action 'none'",
        "object-src 'none'",
    ].join("; ");

    const serveFile = (pathname: string): Response => {
        if (!staticDir) return new Response("The GUI isn't built. Run: bun run gui:build", { status: 404, headers: securityHeaders });
        let rel: string;
        try {
            rel = normalize(decodeURIComponent(pathname)).replace(/^[/\\]+/, "");
        } catch {
            return new Response("Bad path", { status: 400 });
        }
        let file = resolve(staticDir, rel);
        if (file !== staticDir && !file.startsWith(staticDir + sep)) return new Response("Not found", { status: 404 });
        let isFile = false;
        try {
            isFile = statSync(file).isFile();
        } catch {
            isFile = false;
        }
        // The GUI routes in the browser: unknown paths get the app.
        if (!isFile) file = join(staticDir, "index.html");
        const type = TYPES[extname(file)] ?? "application/octet-stream";
        const immutable = /[/\\]assets[/\\]/.test(file);
        const headers: Record<string, string> = { ...securityHeaders, "Content-Type": type, "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache" };
        if (type.startsWith("text/html")) headers["Content-Security-Policy"] = csp;
        return new Response(Bun.file(file), { headers });
    };

    // HARNESS_GUI_DEBUG=1: say why requests are turned away (never logs tokens).
    const debug = process.env.HARNESS_GUI_DEBUG ? log : () => {};
    const server = Bun.serve<Conn>({
        hostname: host,
        port: o.port ?? 0,
        idleTimeout: 60,
        async fetch(req, srv) {
            const url = new URL(req.url);
            if (!hostOk(req.headers.get("host"))) {
                debug(`refused host ${req.headers.get("host")}`);
                return new Response("Forbidden host", { status: 403 });
            }
            if (url.pathname === "/ws") {
                if (!originOk(req.headers.get("origin"))) {
                    debug(`refused WebSocket from origin ${req.headers.get("origin")}`);
                    return new Response("Forbidden origin", { status: 403 });
                }
                const protocols = (req.headers.get("sec-websocket-protocol") ?? "").split(",").map((s) => s.trim());
                const auth = protocols.find((p) => p.startsWith("auth."))?.slice(5) ?? "";
                if (!protocols.includes(SUBPROTOCOL) || !sameSecret(auth, token)) {
                    debug(`refused WebSocket without the token (origin ${req.headers.get("origin")})`);
                    return new Response("Unauthorized", { status: 401 });
                }
                debug(`WebSocket from ${req.headers.get("origin") ?? "no origin"}`);
                const conn: Conn = { client: { subs: new Set(), send: () => {} } };
                if (srv.upgrade(req, { data: conn, headers: { "Sec-WebSocket-Protocol": SUBPROTOCOL } })) return undefined;
                return new Response("Upgrade failed", { status: 400 });
            }
            if (url.pathname === "/auth/exchange") {
                // The page trades the link's one-time code for the token.
                if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
                const origin = req.headers.get("origin");
                if (!origin || !originOk(origin)) return new Response("Forbidden origin", { status: 403 });
                let code = "";
                try {
                    code = String(((await req.json()) as { code?: unknown }).code ?? "");
                } catch {
                    return new Response("Bad request", { status: 400 });
                }
                const now = Date.now();
                for (const [c, exp] of codes) if (exp < now) codes.delete(c);
                const match = [...codes.keys()].find((c) => sameSecret(c, code));
                if (!match) return Response.json({ error: "This link has expired. Run harness gui again, or use the link it printed most recently." }, { status: 401, headers: securityHeaders });
                codes.delete(match);
                return Response.json({ token }, { headers: { ...securityHeaders, "Cache-Control": "no-store" } });
            }
            if (url.pathname === "/healthz") return new Response("ok", { headers: securityHeaders });
            if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
            return serveFile(url.pathname);
        },
        websocket: {
            maxPayloadLength: 48 * 1024 * 1024,
            idleTimeout: 120,
            sendPings: true,
            open(ws: ServerWebSocket<Conn>) {
                const c = ws.data.client;
                c.send = (ev: ServerEvent) => {
                    if (ws.readyState === 1) ws.send(JSON.stringify({ event: ev } satisfies ServerMessage, wireReplacer));
                };
                engine.clients.add(c);
            },
            async message(ws: ServerWebSocket<Conn>, raw) {
                let msg: ClientMessage;
                try {
                    msg = JSON.parse(typeof raw === "string" ? raw : Buffer.from(raw).toString("utf-8"));
                } catch {
                    return;
                }
                if (typeof msg?.id !== "number" || typeof msg.method !== "string") return;
                let reply: ServerMessage;
                try {
                    const result = await engine.handle(ws.data.client, msg.method as Method, msg.params);
                    reply = { id: msg.id, result: result ?? null };
                } catch (e) {
                    const err = e as Error;
                    if (!(e instanceof RpcError)) log(`error in ${msg.method}: ${redact(err?.stack ?? String(e))}`);
                    reply = { id: msg.id, error: { message: redact(err?.message ?? String(e)), code: e instanceof RpcError ? e.code : undefined } };
                }
                if (ws.readyState === 1) ws.send(JSON.stringify(reply, wireReplacer));
            },
            close(ws: ServerWebSocket<Conn>) {
                engine.dropClient(ws.data.client);
            },
        },
    });
    port = server.port ?? 0;
    const shownHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host.includes(":") ? `[${host}]` : host;
    const url = `http://${shownHost}:${port}`;
    log(`listening on ${url}`);

    return {
        engine,
        url,
        port,
        token,
        loginUrl() {
            const code = randomBytes(18).toString("base64url");
            codes.set(code, Date.now() + CODE_TTL_MS);
            return `${url}/#code=${code}`;
        },
        async stop() {
            await engine.stop();
            server.stop(true);
        },
    };
}
