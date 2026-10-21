// OAuth for remote MCP servers (the MCP authorization spec, 2025-06-18 on):
// protected resource metadata (RFC 9728) names the authorization server, its
// metadata (RFC 8414 / OIDC discovery) gives the endpoints, the client
// registers itself (RFC 7591) unless one is configured, and the user signs in
// in their browser: authorization code with PKCE (S256), the `resource`
// parameter (RFC 8707), `iss` checked (RFC 9207), and the code handed to a
// loopback listener (RFC 8252).
//
// Tokens are kept in ~/.harness/mcp-oauth.json (0600; the agent's tools
// can't read it), per server name and URL, with the issuer they came from: a
// client registered with one authorization server is never used with another.

import { createHash, randomBytes } from "crypto";
import { existsSync, readFileSync, statSync } from "fs";
import { APP_TITLE, paths } from "../config/paths";
import type { McpServerConfig } from "../config/settings";
import { writeJson } from "../config/settings";
import { McpError, type McpAuth } from "./client";

const oauthFile = () => paths.mcpOAuth();

/** Seconds of slack before expiry at which a token is refreshed rather than sent. */
const EXPIRY_SKEW_MS = 60_000;
const SIGN_IN_TIMEOUT_MS = 5 * 60_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface McpOAuthConfig {
    /** A client registered for this server by hand (skips dynamic registration). */
    clientId?: string;
    clientSecret?: string;
    /** The loopback port the sign-in listens on (a registered redirect URI needs it fixed). */
    callbackPort?: number;
    /** Scopes to ask for, instead of what the server's challenge or metadata names: a list, or space-separated as Claude Code writes them. */
    scopes?: string | string[];
}

interface Tokens {
    access_token: string;
    token_type?: string;
    refresh_token?: string;
    /** Milliseconds since the epoch. */
    expires_at?: number;
    scope?: string;
}

interface Entry {
    url: string;
    issuer: string;
    tokenEndpoint: string;
    /** What the tokens are for (the `resource` parameter). */
    resource: string;
    client: { client_id: string; client_secret?: string; redirect_uri?: string; auth_method?: string };
    tokens?: Tokens;
}

type Store = { servers?: Record<string, Entry> };

const keyOf = (name: string, url: string) => `${name}|${url}`;

let cache: { mtimeMs: number; store: Store } | undefined;

function readStore(): Store {
    const file = oauthFile();
    if (!existsSync(file)) return {};
    try {
        const mtimeMs = statSync(file).mtimeMs;
        if (cache?.mtimeMs === mtimeMs) return cache.store;
        const store = JSON.parse(readFileSync(file, "utf-8")) as Store;
        cache = { mtimeMs, store: store && typeof store === "object" ? store : {} };
        return cache.store;
    } catch {
        return {};
    }
}

function updateStore(fn: (s: Store) => void) {
    // Read afresh: the terminal and the GUI server both sign in.
    cache = undefined;
    const s = readStore();
    s.servers ??= {};
    fn(s);
    writeJson(oauthFile(), s, 0o600);
    cache = undefined;
}

function entry(name: string, url: string): Entry | undefined {
    return readStore().servers?.[keyOf(name, url)];
}

/** Whether there are stored credentials for this server (a sign-out has something to remove). */
export function hasOAuthTokens(name: string, cfg: McpServerConfig): boolean {
    return Boolean(cfg.url && entry(name, cfg.url)?.tokens);
}

/** Forget this server's tokens (and the client registered for it). */
export function signOut(name: string, cfg: McpServerConfig): boolean {
    if (!cfg.url || !entry(name, cfg.url)) return false;
    updateStore((s) => {
        delete s.servers![keyOf(name, cfg.url!)];
    });
    return true;
}

/** The server URL as the token's audience: no fragment, no trailing slash on a bare path. */
export function canonicalResource(url: string): string {
    const u = new URL(url);
    u.hash = "";
    const s = u.href;
    return u.pathname === "/" && !u.search ? s.replace(/\/$/, "") : s;
}

/** The http(s) address of a server: a ws(s) URL's handshake is an HTTP request to the same place. */
export function webForm(url: string): string {
    const u = new URL(url);
    if (u.protocol === "ws:" || u.protocol === "wss:") u.protocol = u.protocol === "ws:" ? "http:" : "https:";
    return u.href;
}

/** A WWW-Authenticate Bearer challenge's parameters (lower-cased names). */
export function parseChallenge(header: string): Record<string, string> {
    const out: Record<string, string> = {};
    const m = header.match(/bearer\s+(.*)$/is);
    if (!m) return out;
    for (const p of m[1]!.matchAll(/([A-Za-z0-9_-]+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))/g)) out[p[1]!.toLowerCase()] = p[2] !== undefined ? p[2].replace(/\\(.)/g, "$1") : p[3]!;
    return out;
}

const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function getJson(url: string, signal?: AbortSignal): Promise<Record<string, any> | undefined> {
    const s = AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]);
    let res: Response;
    try {
        res = await fetch(url, { headers: { Accept: "application/json", "MCP-Protocol-Version": "2025-06-18" }, signal: s });
    } catch (e) {
        if (signal?.aborted) throw new McpError("aborted");
        throw new McpError(`couldn't reach ${new URL(url).origin}: ${(e as Error).message}`, -1);
    }
    if (!res.ok) {
        await res.body?.cancel();
        return undefined;
    }
    try {
        const j = await res.json();
        return j && typeof j === "object" && !Array.isArray(j) ? (j as Record<string, any>) : undefined;
    } catch {
        return undefined;
    }
}

/** Where the server's authorization server is, and what scopes it names (RFC 9728, with the 2025-03-26 fallback). */
export async function discoverResource(url: string, challenge: string, signal?: AbortSignal): Promise<{ resource: string; authServer: string; scopes?: string[] }> {
    const c = parseChallenge(challenge);
    // A WebSocket server's metadata and resource are at its http(s) address.
    const serverUrl = webForm(url);
    const u = new URL(serverUrl);
    const candidates = c.resource_metadata ? [c.resource_metadata] : [`${u.origin}/.well-known/oauth-protected-resource${u.pathname === "/" ? "" : u.pathname.replace(/\/$/, "")}`, `${u.origin}/.well-known/oauth-protected-resource`];
    for (const url of [...new Set(candidates)]) {
        const meta = await getJson(url, signal);
        if (!meta) continue;
        const servers = Array.isArray(meta.authorization_servers) ? meta.authorization_servers.filter((s: unknown) => typeof s === "string") : [];
        if (!servers.length) continue;
        const resource = typeof meta.resource === "string" ? meta.resource : canonicalResource(serverUrl);
        // The metadata must be about this server (RFC 9728 §3.3): the same resource, or one it sits under.
        const want = canonicalResource(serverUrl);
        if (!(want === canonicalResource(resource) || want.startsWith(canonicalResource(resource).replace(/\/?$/, "/")))) {
            throw new McpError(`the server's resource metadata is for ${resource}, not ${want}`);
        }
        const scopes = c.scope ? c.scope.split(/\s+/).filter(Boolean) : Array.isArray(meta.scopes_supported) ? meta.scopes_supported.filter((x: unknown) => typeof x === "string") : undefined;
        return { resource: canonicalResource(resource), authServer: servers[0]!, scopes };
    }
    // No metadata: the server's own origin is its authorization server (protocol 2025-03-26).
    return { resource: canonicalResource(serverUrl), authServer: u.origin, scopes: c.scope ? c.scope.split(/\s+/).filter(Boolean) : undefined };
}

export interface AuthServerMeta {
    issuer: string;
    authorization_endpoint: string;
    token_endpoint: string;
    registration_endpoint?: string;
    code_challenge_methods_supported?: string[];
    token_endpoint_auth_methods_supported?: string[];
    authorization_response_iss_parameter_supported?: boolean;
    scopes_supported?: string[];
}

/** RFC 8414 / OIDC discovery in the order the MCP spec gives; the issuer in the document must be the one asked about. */
/** An http(s) URL, the only kind a sign-in may send the browser or a request to. */
export function isWebUrl(v: unknown): v is string {
    if (typeof v !== "string") return false;
    try {
        return /^https?:$/.test(new URL(v).protocol);
    } catch {
        return false;
    }
}

export async function discoverAuthServer(issuer: string, signal?: AbortSignal): Promise<AuthServerMeta> {
    if (!isWebUrl(issuer)) throw new McpError(`the authorization server "${issuer}" isn't an http(s) URL`);
    const u = new URL(issuer);
    const path = u.pathname.replace(/\/$/, "");
    const urls = path
        ? [`${u.origin}/.well-known/oauth-authorization-server${path}`, `${u.origin}/.well-known/openid-configuration${path}`, `${u.origin}${path}/.well-known/openid-configuration`]
        : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
    for (const url of urls) {
        const meta = await getJson(url, signal);
        if (!meta) continue;
        if (meta.issuer !== issuer && meta.issuer !== issuer.replace(/\/$/, "")) throw new McpError(`the authorization server's metadata names issuer "${String(meta.issuer)}", not "${issuer}"`);
        if (typeof meta.authorization_endpoint !== "string" || typeof meta.token_endpoint !== "string") throw new McpError("the authorization server's metadata has no authorization or token endpoint");
        // The sign-in page opens in a browser (and the GUI's window): only a web page, never javascript: or file:.
        for (const k of ["authorization_endpoint", "token_endpoint", "registration_endpoint"] as const) {
            if (meta[k] !== undefined && !isWebUrl(meta[k])) throw new McpError(`the authorization server's ${k.replace(/_/g, " ")} isn't an http(s) URL`);
        }
        return meta as AuthServerMeta;
    }
    // A server without metadata (2025-03-26 fallback): the default endpoints at its origin.
    return { issuer, authorization_endpoint: `${u.origin}/authorize`, token_endpoint: `${u.origin}/token`, registration_endpoint: `${u.origin}/register` };
}

async function postForm(url: string, form: Record<string, string>, client: Entry["client"], signal?: AbortSignal): Promise<Record<string, any>> {
    const headers: Record<string, string> = { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" };
    const body = new URLSearchParams(form);
    if (client.client_secret && client.auth_method === "client_secret_basic") {
        headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString("base64")}`;
    } else {
        body.set("client_id", client.client_id);
        if (client.client_secret) body.set("client_secret", client.client_secret);
    }
    let res: Response;
    try {
        res = await fetch(url, { method: "POST", headers, body, signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
    } catch (e) {
        if (signal?.aborted) throw new McpError("aborted");
        throw new McpError(`couldn't reach the token endpoint: ${(e as Error).message}`, -1);
    }
    const text = await res.text();
    let j: Record<string, any> = {};
    try {
        j = JSON.parse(text);
    } catch {
        // not JSON
    }
    if (!res.ok || typeof j.access_token !== "string") {
        const why = typeof j.error === "string" ? `${j.error}${typeof j.error_description === "string" ? `: ${j.error_description}` : ""}` : `HTTP ${res.status}`;
        throw new McpError(`the authorization server refused the token request (${why.slice(0, 300)})`, res.status === 400 || res.status === 401 ? 400 : -1);
    }
    return j;
}

function tokensFrom(j: Record<string, any>, previous?: Tokens): Tokens {
    return {
        access_token: j.access_token,
        token_type: typeof j.token_type === "string" ? j.token_type : "Bearer",
        // A refresh answer without a new refresh token keeps the old one.
        refresh_token: typeof j.refresh_token === "string" ? j.refresh_token : previous?.refresh_token,
        expires_at: typeof j.expires_in === "number" ? Date.now() + j.expires_in * 1000 : undefined,
        scope: typeof j.scope === "string" ? j.scope : previous?.scope,
    };
}

/** One sign-in at a time per server, and one refresh: callers share them. */
const refreshing = new Map<string, Promise<Tokens | undefined>>();

async function refresh(name: string, url: string, secret: string | undefined, signal?: AbortSignal): Promise<Tokens | undefined> {
    const key = keyOf(name, url);
    const running = refreshing.get(key);
    if (running) return running;
    const p = (async () => {
        const e = entry(name, url);
        if (!e?.tokens?.refresh_token) return undefined;
        try {
            // A configured client's secret stays in the settings, not in this file.
            const j = await postForm(e.tokenEndpoint, { grant_type: "refresh_token", refresh_token: e.tokens.refresh_token, resource: e.resource }, { ...e.client, client_secret: e.client.client_secret ?? secret }, signal);
            const tokens = tokensFrom(j, e.tokens);
            updateStore((s) => {
                const now = s.servers![key];
                if (now) now.tokens = tokens;
            });
            return tokens;
        } catch (err) {
            // Refused (expired, revoked): the tokens are no good, sign in again. Unreachable: keep them for later.
            if ((err as McpError).code === 400) {
                updateStore((s) => {
                    const now = s.servers![key];
                    if (now) delete now.tokens;
                });
            }
            return undefined;
        }
    })().finally(() => refreshing.delete(key));
    refreshing.set(key, p);
    return p;
}

/** The McpAuth for one server: stored tokens, refreshed when they expire or the server says no. */
export function oauthFor(name: string, cfg: McpServerConfig): McpAuth | undefined {
    if (!cfg.url) return undefined;
    const url = cfg.url;
    const secret = (cfg.oauth as McpOAuthConfig | undefined)?.clientSecret;
    /** The last refresh a 401 started: requests refused alongside it wait for it and try its token. */
    let last: { at: number; done: Promise<boolean> } | undefined;
    return {
        async header(signal) {
            let t = entry(name, url)?.tokens;
            if (t?.expires_at !== undefined && t.expires_at - EXPIRY_SKEW_MS < Date.now()) t = t.refresh_token ? await refresh(name, url, secret, signal) : undefined;
            return t ? `Bearer ${t.access_token}` : undefined;
        },
        async unauthorized(challenge, signal) {
            const c = parseChallenge(challenge);
            // More scope needed: only a new sign-in gets it.
            if (c.error === "insufficient_scope") return false;
            // Several requests sent with the old token: one refresh, and each tries the new token once.
            if (last && Date.now() - last.at < 10_000) return last.done;
            if (!entry(name, url)?.tokens?.refresh_token) return false;
            const done = refresh(name, url, secret, signal).then(Boolean, () => false);
            last = { at: Date.now(), done };
            return done;
        },
    };
}

export interface SignInOptions {
    /** The server's last 401 challenge, when there was one. */
    challenge?: string;
    /** Show or open the link: the browser is the user's to sign in with. */
    open: (url: string) => void | Promise<void>;
    signal?: AbortSignal;
    /** How long to wait for the browser (default five minutes). */
    timeoutMs?: number;
}

const PAGE = (title: string, body: string) =>
    `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:15px system-ui,sans-serif;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222"><h2>${title}</h2><p>${body}</p></body>`;

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/**
 * Sign in to `name` in the browser and store the tokens. Resolves once
 * they're stored; rejects if the user doesn't finish in time, the server
 * refuses, or `signal` aborts.
 */
export async function signIn(name: string, cfg: McpServerConfig, o: SignInOptions): Promise<void> {
    if (!cfg.url) throw new McpError(`"${name}" isn't a remote server: there's nothing to sign in to.`);
    const url = cfg.url;
    const oauth = (cfg.oauth ?? {}) as McpOAuthConfig;
    const signal = o.signal;
    // Without a challenge (signing in before any 401), ask the server for one.
    let challenge = o.challenge ?? "";
    if (!challenge) {
        try {
            const r = await fetch(webForm(url), { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(cfg.headers ?? {}) }, body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "server/discover", params: {} }), signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]) });
            challenge = r.headers.get("www-authenticate") ?? "";
            await r.body?.cancel();
        } catch {
            // the well-known locations are tried anyway
        }
    }
    const { resource, authServer, scopes } = await discoverResource(url, challenge, signal);
    const meta = await discoverAuthServer(authServer, signal);
    const methods = meta.code_challenge_methods_supported;
    if (methods && !methods.includes("S256")) throw new McpError("the authorization server doesn't support PKCE with S256, which signing in requires");

    // The loopback listener, on the port the client is registered with when there is one.
    const prior = entry(name, url);
    const reuse = prior && prior.issuer === meta.issuer ? prior.client : undefined;
    const reusePort = reuse?.redirect_uri ? Number(new URL(reuse.redirect_uri).port) || undefined : undefined;
    const fixedPort = oauth.callbackPort;
    const state = b64url(randomBytes(24));
    const verifier = b64url(randomBytes(48));
    let settle!: { resolve: (v: { code: string }) => void; reject: (e: Error) => void };
    const got = new Promise<{ code: string }>((resolve, reject) => (settle = { resolve, reject }));
    got.catch(() => undefined);
    const answer = (req: Request): Response => {
        const q = new URL(req.url);
        if (q.pathname !== "/callback") return new Response("Not found", { status: 404 });
        // A response for another attempt (an old tab) isn't this one's.
        if (q.searchParams.get("state") !== state) return new Response(PAGE("Sign-in link expired", `This sign-in isn't the one ${APP_TITLE} is waiting for. Start it again from ${APP_TITLE}.`), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        const iss = q.searchParams.get("iss");
        if ((iss !== null && iss !== meta.issuer) || (iss === null && meta.authorization_response_iss_parameter_supported === true)) {
            settle.reject(new McpError("the sign-in response came from the wrong authorization server (its iss didn't match)"));
            return new Response(PAGE("Sign-in rejected", "The response didn't come from the expected authorization server."), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const err = q.searchParams.get("error");
        if (err) {
            const desc = q.searchParams.get("error_description");
            settle.reject(new McpError(err === "access_denied" ? "you declined the sign-in" : `the authorization server said: ${err}${desc ? ` (${desc.slice(0, 200)})` : ""}`));
            return new Response(PAGE("Sign-in didn't finish", escapeHtml(err === "access_denied" ? "You declined it." : `${err}${desc ? `: ${desc.slice(0, 200)}` : ""}`)), { headers: { "Content-Type": "text/html; charset=utf-8" } });
        }
        const code = q.searchParams.get("code");
        if (!code) return new Response(PAGE("Sign-in didn't finish", "No authorization code came back."), { status: 400, headers: { "Content-Type": "text/html; charset=utf-8" } });
        settle.resolve({ code });
        return new Response(PAGE(`Signed in to ${escapeHtml(name)}`, `You can close this tab and go back to ${APP_TITLE}.`), { headers: { "Content-Type": "text/html; charset=utf-8" } });
    };
    // Connection: close, so no kept-alive connection reaches this listener once it's stopped
    // (a later sign-in on the same port would otherwise never see its callback).
    const handler = (req: Request): Response => {
        const res = answer(req);
        res.headers.set("Connection", "close");
        return res;
    };
    let server: ReturnType<typeof Bun.serve> | undefined;
    // The port a registered client's redirect URI names, if it's free; else any (and the client registers again).
    if (!fixedPort && reusePort) {
        try {
            server = Bun.serve({ hostname: "127.0.0.1", port: reusePort, fetch: handler });
        } catch {
            server = undefined;
        }
    }
    try {
        server ??= Bun.serve({ hostname: "127.0.0.1", port: fixedPort ?? 0, fetch: handler });
    } catch (e) {
        throw new McpError(`couldn't listen on 127.0.0.1:${fixedPort ?? 0} for the sign-in (${(e as Error).message})${fixedPort ? "; free that port or change oauth.callbackPort" : ""}`);
    }
    try {
        const redirect = `http://127.0.0.1:${server.port}/callback`;
        let client: Entry["client"];
        if (oauth.clientId) {
            // Unlisted, the token endpoint takes client_secret_basic (RFC 8414 §2); post only where it says so and basic isn't offered.
            const authMethods = meta.token_endpoint_auth_methods_supported ?? ["client_secret_basic"];
            client = { client_id: oauth.clientId, client_secret: oauth.clientSecret, redirect_uri: redirect, auth_method: oauth.clientSecret && (authMethods.includes("client_secret_basic") || !authMethods.includes("client_secret_post")) ? "client_secret_basic" : "client_secret_post" };
        } else if (reuse && reuse.redirect_uri === redirect) {
            client = reuse;
        } else {
            if (!meta.registration_endpoint) throw new McpError(`the authorization server doesn't let ${APP_TITLE} register itself. Register a client there and add "oauth": { "clientId": "…" } to this server's settings.`);
            client = await register(meta.registration_endpoint, redirect, signal);
        }
        const own = typeof oauth.scopes === "string" ? oauth.scopes.split(/\s+/).filter(Boolean) : Array.isArray(oauth.scopes) ? oauth.scopes.filter((x) => typeof x === "string") : undefined;
        const scope = (own?.length ? own : scopes)?.join(" ");
        const auth = new URL(meta.authorization_endpoint);
        auth.searchParams.set("response_type", "code");
        auth.searchParams.set("client_id", client.client_id);
        auth.searchParams.set("redirect_uri", redirect);
        auth.searchParams.set("code_challenge", b64url(createHash("sha256").update(verifier).digest()));
        auth.searchParams.set("code_challenge_method", "S256");
        auth.searchParams.set("state", state);
        auth.searchParams.set("resource", resource);
        if (scope) auth.searchParams.set("scope", scope);
        const timeoutMs = o.timeoutMs ?? SIGN_IN_TIMEOUT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => settle.reject(new McpError("sign-in cancelled"));
        // Listening before the link is shown: a cancel can come while it's being shown.
        if (signal?.aborted) onAbort();
        signal?.addEventListener("abort", onAbort, { once: true });
        let code: string;
        try {
            await o.open(auth.href);
            ({ code } = await Promise.race([got, new Promise<never>((_, rej) => (timer = setTimeout(() => rej(new McpError(`the sign-in wasn't finished within ${Math.round(timeoutMs / 60_000) || 1} minutes`)), timeoutMs)))]));
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener("abort", onAbort);
        }
        const j = await postForm(meta.token_endpoint, { grant_type: "authorization_code", code, redirect_uri: redirect, code_verifier: verifier, resource }, client, signal);
        const tokens = tokensFrom(j);
        updateStore((s) => {
            s.servers![keyOf(name, url)] = { url, issuer: meta.issuer, tokenEndpoint: meta.token_endpoint, resource, client: oauth.clientId ? { client_id: client.client_id, redirect_uri: redirect, auth_method: client.auth_method } : client, tokens };
        });
    } finally {
        // Not forced: the browser still gets its page.
        void server.stop();
    }
}

async function register(endpoint: string, redirect: string, signal?: AbortSignal): Promise<Entry["client"]> {
    let res: Response;
    try {
        res = await fetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", Accept: "application/json" },
            body: JSON.stringify({ client_name: APP_TITLE, redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none", application_type: "native" }),
            signal: AbortSignal.any([AbortSignal.timeout(FETCH_TIMEOUT_MS), ...(signal ? [signal] : [])]),
        });
    } catch (e) {
        if (signal?.aborted) throw new McpError("aborted");
        throw new McpError(`couldn't register with the authorization server: ${(e as Error).message}`, -1);
    }
    const j = (await res.json().catch(() => ({}))) as Record<string, any>;
    if (!res.ok || typeof j.client_id !== "string") throw new McpError(`the authorization server refused to register ${APP_TITLE} (HTTP ${res.status}${typeof j.error === "string" ? `: ${j.error}` : ""}). Register a client there and set "oauth": { "clientId": "…" }.`);
    return { client_id: j.client_id, client_secret: typeof j.client_secret === "string" ? j.client_secret : undefined, redirect_uri: redirect, auth_method: typeof j.client_secret === "string" ? (j.token_endpoint_auth_method === "client_secret_basic" ? "client_secret_basic" : "client_secret_post") : "none" };
}
