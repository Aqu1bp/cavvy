// Setting up Vertex AI with the gcloud CLI: which Google accounts are signed
// in, their projects and which of those have billing, turning the Vertex AI
// API on, and checking a setup works. Everything goes through runGcloud
// (arguments only, no shell) and the account is always named explicitly, so
// the account gcloud happens to have active doesn't decide who is billed.

import { getProvider, validGoogleAccount, validVertexProject, type VertexConfig } from "../providers/registry";
import { gcloudMessage, listVertexModels, runGcloud, tokensFor } from "../providers/vertex";
import { ProviderError } from "../providers/types";

export interface GcloudAccount {
    account: string;
    active: boolean;
}

export interface GcloudProject {
    projectId: string;
    name?: string;
    /** Linked to a billing account with billing on; undefined when gcloud couldn't say. */
    billing?: boolean;
}

function parseJson<T>(stdout: string): T | undefined {
    try {
        return JSON.parse(stdout) as T;
    } catch {
        return undefined;
    }
}

/** Accounts gcloud has credentials for. */
export async function gcloudAccounts(signal?: AbortSignal): Promise<GcloudAccount[]> {
    const r = await runGcloud(["auth", "list", "--format=json"], { signal });
    if (r.code !== 0) throw new Error(`gcloud auth list failed: ${gcloudMessage(r.stderr)}`);
    const rows = parseJson<{ account?: string; status?: string }[]>(r.stdout) ?? [];
    return rows.filter((x) => typeof x.account === "string" && validGoogleAccount(x.account)).map((x) => ({ account: x.account!, active: x.status === "ACTIVE" }));
}

/** The account's active projects, with billing status where gcloud can tell. */
export async function gcloudProjects(account: string, signal?: AbortSignal): Promise<GcloudProject[]> {
    const r = await runGcloud(["projects", "list", `--account=${account}`, "--format=json", "--filter=lifecycleState:ACTIVE"], { signal, timeoutMs: 60_000 });
    if (r.code !== 0) throw new Error(`gcloud couldn't list projects for ${account}: ${gcloudMessage(r.stderr)}`);
    const rows = parseJson<{ projectId?: string; name?: string }[]>(r.stdout) ?? [];
    const projects: GcloudProject[] = rows.filter((x) => typeof x.projectId === "string" && validVertexProject(x.projectId)).map((x) => ({ projectId: x.projectId!, name: x.name }));
    const billed = await billedProjects(account, signal).catch(() => undefined);
    if (billed) for (const p of projects) p.billing = billed.has(p.projectId);
    return projects;
}

/** Projects linked to one of the account's open billing accounts; undefined if that can't be listed. */
async function billedProjects(account: string, signal?: AbortSignal): Promise<Set<string> | undefined> {
    const r = await runGcloud(["billing", "accounts", "list", `--account=${account}`, "--format=json", "--filter=open=true"], { signal });
    if (r.code !== 0) return undefined;
    const accounts = (parseJson<{ name?: string }[]>(r.stdout) ?? []).map((a) => String(a.name ?? "").replace(/^billingAccounts\//, "")).filter((id) => /^[A-Z0-9-]+$/.test(id));
    const out = new Set<string>();
    for (const id of accounts) {
        const p = await runGcloud(["billing", "projects", "list", `--billing-account=${id}`, `--account=${account}`, "--format=json"], { signal });
        if (p.code !== 0) return undefined;
        for (const row of parseJson<{ projectId?: string; billingEnabled?: boolean }[]>(p.stdout) ?? []) if (row.projectId && row.billingEnabled) out.add(row.projectId);
    }
    return out;
}

/** Turn the Vertex AI API on in a project (free; usage is what's billed). */
export async function enableVertexApi(account: string, project: string, signal?: AbortSignal): Promise<void> {
    const r = await runGcloud(["services", "enable", "aiplatform.googleapis.com", `--project=${project}`, `--account=${account}`], { signal, timeoutMs: 180_000 });
    if (r.code !== 0) throw new Error(`gcloud couldn't turn on the Vertex AI API: ${gcloudMessage(r.stderr)}`);
}

export type VertexCheck = { ok: true; models: number } | { ok: false; reason: string; apiDisabled?: boolean; definitive: boolean };

/** Check a setup with a freshly issued token (so a revoked sign-in shows up) and the (free) model listing. */
export async function checkVertex(cfg: VertexConfig, signal?: AbortSignal): Promise<VertexCheck> {
    const def = getProvider("vertex")!;
    try {
        const tokens = tokensFor(cfg.account);
        await tokens.get(true);
        const models = await listVertexModels(def, cfg, (fresh) => tokens.get(fresh), signal);
        return { ok: true, models: models.length };
    } catch (e) {
        const err = e as ProviderError;
        const body = err.body ?? "";
        if (/SERVICE_DISABLED/.test(body)) return { ok: false, reason: err.message, apiDisabled: true, definitive: true };
        return { ok: false, reason: err.message, definitive: err.status !== undefined && err.status < 500 && err.status !== 429 };
    }
}
