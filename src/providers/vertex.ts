// Google Vertex AI (which Google now calls Gemini Enterprise Agent Platform):
// Gemini models through Vertex's OpenAI-compatible endpoint, billed to a Google
// Cloud project. There's no API key. Each request carries a short-lived OAuth
// token from the gcloud CLI, for the Google account picked in /login vertex;
// Cavvy keeps tokens in memory only and registers them with the redactor.

import { homedir } from "os";
import { OpenAICompatProvider, httpError } from "./openai-compat";
import { validGoogleAccount, vertexBaseUrl, vertexHost, type ProviderDef, type VertexConfig } from "./registry";
import { ProviderError, type ModelInfo } from "./types";
import type { Effort } from "../config/settings";
import { childEnv } from "../util/env";
import { redact, registerSecret } from "../util/redact";

/** A token is replaced once it has less than this left (gcloud is asked for one that lasts twice as long). */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;
/** How long to keep a token if gcloud doesn't say when it expires (Google's default lifetime is an hour). */
const FALLBACK_TTL_MS = 30 * 60 * 1000;
/** What Vertex accepts as reasoning_effort on Gemini 2.5 and later; xhigh is sent as high. */
const EFFORTS: Effort[] = ["low", "medium", "high", "max"];

export const GCLOUD_INSTALL_URL = "https://cloud.google.com/sdk/docs/install";

export class GcloudError extends Error {
    constructor(
        message: string,
        /** gcloud isn't installed. */
        public missing = false,
    ) {
        super(message);
        this.name = "GcloudError";
    }
}

export interface GcloudResult {
    code: number;
    stdout: string;
    stderr: string;
    /** Killed for taking longer than the time it was given. */
    timedOut?: boolean;
}

/**
 * Run gcloud with arguments (never a shell string), from the home directory,
 * with Cavvy's secrets removed from its environment and prompts off.
 * gcloud's file log is turned off for these runs: it records each command's
 * output, which would put tokens in ~/.config/gcloud/logs.
 */
export async function runGcloud(args: string[], opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<GcloudResult> {
    const bin = Bun.which("gcloud", { PATH: process.env.PATH ?? "" });
    if (!bin) throw new GcloudError(`The Google Cloud CLI (gcloud) isn't installed. Install it from ${GCLOUD_INSTALL_URL}, then run: gcloud auth login`, true);
    const proc = Bun.spawn([bin, ...args, "--quiet"], { cwd: homedir(), env: { ...childEnv(), CLOUDSDK_CORE_DISABLE_FILE_LOGGING: "true" }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    let timedOut = false;
    const timer = setTimeout(() => {
        timedOut = true;
        kill();
    }, opts.timeoutMs ?? 30_000);
    opts.signal?.addEventListener("abort", kill, { once: true });
    try {
        const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        if (opts.signal?.aborted) throw new ProviderError("aborted");
        return timedOut ? { code, stdout, stderr, timedOut } : { code, stdout, stderr };
    } finally {
        clearTimeout(timer);
        opts.signal?.removeEventListener("abort", kill);
    }
}

/** gcloud's own error text, shortened to its first meaningful line. */
export function gcloudMessage(stderr: string): string {
    const lines = redact(stderr)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l && !/^(WARNING|To take a quick anonymous survey|Updates are available)/i.test(l));
    return (lines.find((l) => /^ERROR/.test(l)) ?? lines[0] ?? "no output").replace(/^ERROR:\s*(\(gcloud[^)]*\)\s*)?/, "");
}

/** The token and its expiry from `gcloud config config-helper --format=json`. */
function parseCredential(stdout: string): { token: string; expiresAt?: number } | undefined {
    let c: { access_token?: unknown; token_expiry?: unknown } | undefined;
    try {
        c = JSON.parse(stdout)?.credential;
    } catch {
        return undefined;
    }
    const token = typeof c?.access_token === "string" ? c.access_token.trim() : "";
    if (!token || /\s/.test(token)) return undefined;
    const expiresAt = typeof c?.token_expiry === "string" ? Date.parse(c.token_expiry) : NaN;
    return { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : undefined };
}

/** Tokens for one Google account, fetched from gcloud and reused until shortly before they expire. */
export class GcloudTokens {
    private token?: string;
    private expiresAt = 0;
    private pending?: Promise<string>;

    constructor(readonly account: string) {
        if (!validGoogleAccount(account)) throw new Error(`not a Google account: ${account}`);
    }

    /** A token; `fresh` skips the cached one (after the API rejected it). */
    async get(fresh = false): Promise<string> {
        if (!fresh && this.token && Date.now() < this.expiresAt - REFRESH_MARGIN_MS) return this.token;
        if (fresh) this.token = undefined;
        this.pending ??= this.fetch(fresh).finally(() => (this.pending = undefined));
        return this.pending;
    }

    /**
     * gcloud hands out its own cached token until that nearly expires, so a
     * rejected one is only replaced with --force-auth-refresh. config-helper
     * (unlike print-access-token) also says when the token expires.
     */
    private async fetch(force: boolean): Promise<string> {
        let r: GcloudResult;
        try {
            r = await runGcloud(["config", "config-helper", `--account=${this.account}`, force ? "--force-auth-refresh" : "--min-expiry=10m", "--format=json"]);
        } catch (e) {
            throw new ProviderError((e as Error).message, 401);
        }
        const cred = r.code === 0 ? parseCredential(r.stdout) : undefined;
        if (!cred) {
            const why = r.timedOut ? "it didn't answer in 30s" : gcloudMessage(r.stderr);
            throw new ProviderError(`gcloud couldn't get a token for ${this.account}: ${why}. Sign in again with: gcloud auth login ${this.account}`, 401);
        }
        registerSecret(cred.token, "vertex");
        this.token = cred.token;
        this.expiresAt = cred.expiresAt ?? Date.now() + FALLBACK_TTL_MS;
        return cred.token;
    }
}

const tokenSources = new Map<string, GcloudTokens>();

/** One token source per account, shared by every client. */
export function tokensFor(account: string): GcloudTokens {
    let t = tokenSources.get(account);
    if (!t) tokenSources.set(account, (t = new GcloudTokens(account)));
    return t;
}

/** Drop cached tokens (the setup changed or was removed). They stay registered with the redactor. */
export function forgetTokens() {
    tokenSources.clear();
}

export class VertexProvider extends OpenAICompatProvider {
    private tokens: GcloudTokens;

    constructor(
        def: ProviderDef,
        readonly cfg: VertexConfig,
    ) {
        super(def, undefined, vertexBaseUrl(cfg));
        this.tokens = tokensFor(cfg.account);
    }

    protected override async authorization(fresh: boolean): Promise<string> {
        return `Bearer ${await this.tokens.get(fresh)}`;
    }

    protected override canRefresh(): boolean {
        return true;
    }

    protected override apiError(status: number, statusText: string, body: string, retryAfter: string | null): ProviderError {
        return vertexError(status, statusText, body, this.def.name, this.cfg, retryAfter);
    }

    override async listModels(signal?: AbortSignal): Promise<ModelInfo[]> {
        return listVertexModels(this.def, this.cfg, (fresh) => this.tokens.get(fresh), signal);
    }
}

/** Gemini version from a model id, for ordering: google/gemini-3.5-flash → 3.5. */
function version(id: string): number {
    return Number(id.match(/gemini-(\d+(?:\.\d+)?)/)?.[1] ?? 0);
}

/**
 * Google's models from Vertex's model catalog, newest first. The catalog
 * request is billed to nothing but needs the project for quota, so it also
 * checks that the Vertex API is on there. It goes to the setup's own host, so
 * a region without Vertex AI (or a misspelled one) fails here too.
 */
export async function listVertexModels(def: ProviderDef, cfg: VertexConfig, token: (fresh: boolean) => Promise<string>, signal?: AbortSignal): Promise<ModelInfo[]> {
    const found: { info: ModelInfo; preview: boolean }[] = [];
    let pageToken: string | undefined;
    for (let page = 0; page < 10; page++) {
        const url = new URL(`https://${vertexHost(cfg.location)}/v1beta1/publishers/google/models`);
        url.searchParams.set("pageSize", "300");
        if (pageToken) url.searchParams.set("pageToken", pageToken);
        const get = async (fresh: boolean) =>
            fetch(url, { headers: { Authorization: `Bearer ${await token(fresh)}`, "x-goog-user-project": cfg.project }, signal: signal ?? AbortSignal.timeout(20_000) });
        let res = await get(false);
        if (res.status === 401) {
            await res.body?.cancel().catch(() => {});
            res = await get(true);
        }
        if (!res.ok) {
            const body = await res.text().catch(() => "");
            if (res.status === 404 && cfg.location !== "global") {
                throw new ProviderError(`${def.name}: Vertex AI isn't available in "${cfg.location}" (${vertexHost(cfg.location)} answered 404). Check the region's name, or pick another with /login vertex.`, 404, false, undefined, body);
            }
            throw vertexError(res.status, res.statusText, body, def.name, cfg);
        }
        const json = (await res.json()) as { publisherModels?: { name?: string; launchStage?: string }[]; nextPageToken?: string };
        for (const m of json.publisherModels ?? []) {
            const name = String(m.name ?? "").replace(/^publishers\/google\/models\//, "");
            if (!/^gemini-/.test(name) || m.launchStage === "EXPERIMENTAL" || m.launchStage === "DEPRECATED") continue;
            const id = `google/${name}`;
            if (def.hideModels?.test(id)) continue;
            const preview = m.launchStage === "PUBLIC_PREVIEW" || m.launchStage === "PRIVATE_PREVIEW";
            found.push({ preview, info: { provider: def.id, id, name: preview && !/preview/.test(name) ? `${name} (preview)` : undefined, supportsTools: true, supportsImages: true, supportsReasoning: true, effortLevels: EFFORTS } });
        }
        pageToken = json.nextPageToken;
        if (!pageToken) break;
    }
    const served = cfg.location === "global" ? found : await servedIn(cfg, found, token, signal);
    // Newest first; within a version, released before preview.
    served.sort((a, b) => version(b.info.id) - version(a.info.id) || Number(a.preview) - Number(b.preview) || a.info.id.localeCompare(b.info.id));
    return served.map((f) => f.info);
}

/**
 * The models a region actually serves. Its catalog also lists ones it
 * answers 404 for (us-central1 lists Gemini 3 models it doesn't run), so each
 * is asked with countTokens, which Google doesn't charge for. A model is
 * dropped only on a 404; any other answer keeps it.
 */
async function servedIn<T extends { info: ModelInfo }>(cfg: VertexConfig, models: T[], token: (fresh: boolean) => Promise<string>, signal?: AbortSignal): Promise<T[]> {
    const headers = { Authorization: `Bearer ${await token(false)}`, "Content-Type": "application/json", "x-goog-user-project": cfg.project };
    const base = `https://${vertexHost(cfg.location)}/v1/projects/${cfg.project}/locations/${cfg.location}/publishers/google/models`;
    const body = JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] });
    const keep = await Promise.all(
        models.map(async (m) => {
            try {
                const res = await fetch(`${base}/${m.info.id.replace(/^google\//, "")}:countTokens`, { method: "POST", headers, body, signal: signal ?? AbortSignal.timeout(20_000) });
                await res.body?.cancel().catch(() => {});
                return res.status !== 404;
            } catch {
                return true;
            }
        }),
    );
    return models.filter((_, i) => keep[i]);
}

/** An API error, with what to do about the usual Google Cloud causes. */
export function vertexError(status: number, statusText: string, body: string, providerName: string, cfg: VertexConfig, retryAfter: string | null = null): ProviderError {
    const err = httpError(status, statusText, body, retryAfter, providerName, `Check the setup with /login vertex (project ${cfg.project}, account ${cfg.account}).`);
    if (/SERVICE_DISABLED/.test(body)) err.message = `${providerName}: the Vertex AI API is turned off in project ${cfg.project}. Turn it on with /login vertex, or run: gcloud services enable aiplatform.googleapis.com --project ${cfg.project}`;
    else if (/BILLING_DISABLED|requires billing to be enabled/i.test(body)) err.message = `${providerName}: project ${cfg.project} has no billing account linked, so Vertex AI can't be used there. Link one in the Cloud console (Billing), or pick another project with /login vertex.`;
    return err;
}
