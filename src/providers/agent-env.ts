// Environment variables an agent CLI is started with: set in Settings → Providers, or as `env` in
// providers.json. A secret one's value is kept like an API key (OS keychain, or the owner-only credentials
// file) and only its name is in providers.json; it's registered with the redactor, and given to that CLI's
// processes only.
//
// What a CLI's process gets, last wins:
//   1. Cavvy's child environment (childEnv): inherited, minus every provider key and token Cavvy knows of
//      (ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, CLAUDE_CODE_OAUTH_TOKEN, ...), so a CLI uses its own sign-in
//      rather than a key you gave Cavvy.
//   2. These variables, for this CLI only: one set here is the user's choice for it, so it's passed even when
//      it's one of those names (ANTHROPIC_AUTH_TOKEN for a router, say).
//   3. The account's folder selectors (CLAUDE_CONFIG_DIR, CODEX_HOME), which can't be set here.
//   4. What Cavvy sets for a launch (CAVVY_SESSION, a one-off's settings).

import { createHash } from "crypto";
import { getKey, removeKey, setKey } from "../auth/credentials";
import { agentCli, baseCli } from "../backends/defs";
import { registerSecret } from "../util/redact";
import { ProviderError } from "./types";
import { providerLabel, readAgentConfig, readProvidersFile, readProvidersFileForUpdate, removeAgentConfig, writeProvidersFile } from "./registry";
import { envNameProblem } from "../server/env-names";
import { accountEnv } from "./accounts";

/** A variable as Settings shows and saves it. A secret's value is never sent out: left out, the saved one stays. */
export interface AgentEnvVar {
    name: string;
    value?: string;
    secret?: boolean;
}

const MAX_VALUE = 32 * 1024;
const MAX_VARS = 64;

// Which names can be set: shared with the GUI's editor, which says so as a name is typed.
export { envNameProblem };

/** Where a secret variable's value is stored (the credential store's name for it). */
export function secretEnvId(provider: string, name: string): string {
    return `agent-env:${provider}:${name}`;
}

/** Secret values read so far, by secretEnvId: a process is started synchronously. */
const secrets = new Map<string, string>();

function remember(id: string, name: string, value: string) {
    secrets.set(id, value);
    // Masked under its name in tool output, transcripts and logs.
    registerSecret(value, name);
}

/** Read the secret values of every CLI's variables (or one CLI's) not read yet, registering them with the redactor. */
export async function loadAgentSecrets(provider?: string): Promise<void> {
    const agents = readProvidersFile().agents ?? {};
    const ids = provider ? [provider] : Object.keys(agents);
    await Promise.all(ids.flatMap((p) => (readAgentConfig(p)?.secretEnv ?? []).map(async (name) => {
        const id = secretEnvId(p, name);
        if (secrets.has(id)) return;
        const k = await getKey(id).catch(() => undefined);
        if (k) remember(id, name, k.value);
    })));
}

/** The variables a CLI is set to be started with, secret values included. Throws when a secret's value can't be read. */
export function agentEnv(provider: string): Record<string, string> {
    const cfg = readAgentConfig(provider);
    if (!cfg) return {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(cfg.env ?? {})) if (!envNameProblem(k)) out[k] = v;
    for (const name of cfg.secretEnv ?? []) {
        if (envNameProblem(name)) continue;
        const v = secrets.get(secretEnvId(provider, name));
        if (v === undefined) throw new ProviderError(`${agentCli(provider)?.name ?? provider}'s secret ${name} couldn't be read. Set it again in Settings → Providers.`, 401);
        out[name] = v;
    }
    return out;
}

/**
 * What a CLI's process is started with, over childEnv: its variables, then its account's folder (for a CLI with
 * accounts). Cavvy's per-launch variables go over this.
 */
export function cliEnv(provider: string, accountId?: string, cwd?: string): Record<string, string> {
    // A removed instance isn't started as its CLI's own setup in its place (a plan instead of a router, say).
    if (baseCli(provider) !== provider && !readAgentConfig(provider)) {
        throw new ProviderError(`${providerLabel(provider)} was removed. Pick another model.`, 404);
    }
    const own = agentEnv(provider);
    return agentCli(provider)?.account ? { ...own, ...accountEnv(provider, accountId, cwd) } : own;
}

/** A CLI's variables as Settings shows them: names and plain values; a secret's value never leaves. */
export function agentEnvInfo(provider: string): AgentEnvVar[] {
    const cfg = readAgentConfig(provider);
    return [
        ...Object.entries(cfg?.env ?? {}).map(([name, value]) => ({ name, value })),
        ...(cfg?.secretEnv ?? []).map((name) => ({ name, secret: true })),
    ];
}

/** Changes when a CLI's variables do, without holding a value (models cache fingerprints are stored). */
export function agentEnvFingerprint(provider: string): string {
    const cfg = readAgentConfig(provider);
    if (!cfg?.env && !cfg?.secretEnv) return "";
    return createHash("sha256").update(JSON.stringify([cfg.env ?? {}, cfg.secretEnv ?? []])).digest("hex").slice(0, 12);
}

/** Check a CLI's variables as they'd be saved: what's wrong, or the list to save. */
export function validateAgentEnv(provider: string, vars: unknown): AgentEnvVar[] {
    if (!Array.isArray(vars)) throw new ProviderError("The variables must be a list");
    if (vars.length > MAX_VARS) throw new ProviderError(`At most ${MAX_VARS} variables`);
    const had = new Set(readAgentConfig(provider)?.secretEnv ?? []);
    const seen = new Set<string>();
    return vars.map((v): AgentEnvVar => {
        const name = typeof v?.name === "string" ? v.name.trim() : "";
        if (!name) throw new ProviderError("A variable has no name.");
        const problem = envNameProblem(name, { named: true });
        if (problem) throw new ProviderError(problem);
        if (seen.has(name)) throw new ProviderError(`${name} is there twice.`);
        seen.add(name);
        const secret = v.secret === true;
        if (v.value !== undefined && typeof v.value !== "string") throw new ProviderError(`${name}'s value must be text.`);
        const value: string | undefined = v.value;
        if (value !== undefined && (value.length > MAX_VALUE || value.includes("\0"))) throw new ProviderError(`${name}'s value is too long or has a NUL.`);
        if (secret) {
            // Left blank: the saved one stays.
            if (!value && !had.has(name)) throw new ProviderError(`Enter a value for ${name}.`);
            return { name, secret, ...(value ? { value } : {}) };
        }
        return { name, value: value ?? "" };
    });
}

/**
 * Save a CLI's variables (all of them: those left out are removed). Secret values go to the credential store
 * first, so providers.json never names a secret that isn't stored; ones no longer listed are deleted after.
 */
export async function saveAgentEnv(provider: string, vars: unknown): Promise<void> {
    const list = validateAgentEnv(provider, vars);
    if (!readAgentConfig(provider)) throw new ProviderError(`Turn on ${agentCli(provider)?.name ?? provider} first.`);
    for (const v of list) {
        if (!v.secret || !v.value) continue;
        const id = secretEnvId(provider, v.name);
        await setKey(id, v.value);
        remember(id, v.name, v.value);
    }
    const was = readAgentConfig(provider)?.secretEnv ?? [];
    const pf = readProvidersFileForUpdate();
    const cur = pf.agents?.[provider];
    if (!cur) throw new ProviderError(`Turn on ${agentCli(provider)?.name ?? provider} first.`);
    const env = Object.fromEntries(list.filter((v) => !v.secret).map((v) => [v.name, v.value ?? ""]));
    const secretEnv = list.filter((v) => v.secret).map((v) => v.name);
    if (Object.keys(env).length) cur.env = env;
    else delete cur.env;
    if (secretEnv.length) cur.secretEnv = secretEnv;
    else delete cur.secretEnv;
    writeProvidersFile(pf);
    await forgetSecrets(provider, was.filter((n) => !secretEnv.includes(n)));
}

/** Turn a CLI off (removeAgentConfig), and delete its secret values with its setup. */
export async function turnOffAgent(provider: string): Promise<boolean> {
    const names = readAgentConfig(provider)?.secretEnv ?? [];
    const removed = removeAgentConfig(provider);
    if (removed) await forgetSecrets(provider, names);
    return removed;
}

/** Delete secret values from the credential store (a CLI turned off, or variables removed). */
export async function forgetSecrets(provider: string, names: readonly string[]): Promise<void> {
    for (const name of names) {
        const id = secretEnvId(provider, name);
        secrets.delete(id);
        await removeKey(id).catch(() => false);
    }
}
