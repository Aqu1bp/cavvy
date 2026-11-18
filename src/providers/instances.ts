// Named instances of an agent CLI: "Claude Code · OpenRouter" next to Claude Code, the same CLI started with a
// setup of its own (its path, arguments and environment variables) and, optionally, model ids of its own. Each is a
// provider of its own (`claude-code@openrouter`, from registry.ts), in providers.json's `agents` beside its CLI:
//
//   "agents": { "claude-code": {}, "claude-code@openrouter": { "name": "OpenRouter", "env": { … }, "secretEnv": [ … ], "models": [ … ] } }
//
// It runs on the account its session chose for the CLI (accounts.ts takes its CLI's id). Its models are those the
// CLI lists, run with its setup: listed only when asked to (when it's added or changed, or the lists are refreshed),
// and until then its CLI's (models.ts), so it adds no CLI process at startup or in the model picker.

import { agentCli, baseCli } from "../backends/defs";
import { ProviderError } from "./types";
import { getProvider, INSTANCE_ID, readAgentConfig, readProvidersFile, readProvidersFileForUpdate, validModelId, writeProvidersFile, type AgentCliConfig } from "./registry";
import { saveAgentEnv, turnOffAgent, validateAgentEnv, agentEnvInfo, type AgentEnvVar } from "./agent-env";

export interface InstanceInput {
    name: string;
    path?: string;
    args?: string[];
    env?: AgentEnvVar[];
    models?: string[];
}

export interface InstanceInfo {
    id: string;
    name: string;
    path?: string;
    args?: string[];
    env: AgentEnvVar[];
    models?: string[];
}

/** Whether a provider id is a named instance (of a CLI that has them). */
export function isInstance(provider: string): boolean {
    return baseCli(provider) !== provider && Boolean(agentCli(provider));
}

/** A CLI's named instances, as Settings shows them (a secret's value never leaves). */
export function listInstances(base: string): InstanceInfo[] {
    const out: InstanceInfo[] = [];
    for (const p of providersOf(base)) {
        const cfg = readAgentConfig(p)!;
        out.push({ id: p, name: cfg.name ?? p.slice(p.indexOf("@") + 1), ...(cfg.path ? { path: cfg.path } : {}), ...(cfg.args?.length ? { args: cfg.args } : {}), env: agentEnvInfo(p), ...(cfg.models ? { models: cfg.models } : {}) });
    }
    return out;
}

function providersOf(base: string): string[] {
    return Object.keys(readProvidersFile().agents ?? {}).filter((id) => INSTANCE_ID.exec(id)?.[1] === base && readAgentConfig(id));
}

/** The id for a new instance of `base` named `name`: its name in lower case, made unique. */
function newId(base: string, name: string): string {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 32) || "instance";
    const taken = new Set(Object.keys(readProvidersFileForUpdate().agents ?? {}));
    for (let i = 1; ; i++) {
        const id = `${base}@${i === 1 ? slug : `${slug}-${i}`}`;
        if (!taken.has(id)) return id;
    }
}

function checked(base: string, input: InstanceInput, id?: string): Pick<AgentCliConfig, "name" | "path" | "args" | "models"> {
    const def = agentCli(base);
    if (!def || baseCli(base) !== base) throw new ProviderError(`${base} isn't an agent CLI`);
    const name = typeof input.name === "string" ? input.name.trim() : "";
    if (!name || name.length > 64 || /[\x00-\x1f\x7f]/.test(name)) throw new ProviderError("Give it a name of up to 64 characters.");
    const clash = listInstances(base).find((i) => i.id !== id && i.name.toLowerCase() === name.toLowerCase());
    if (clash) throw new ProviderError(`There's a ${def.name} named ${clash.name} already.`);
    const path = typeof input.path === "string" && input.path.trim() ? input.path.trim() : undefined;
    if (path && (path.length > 1024 || path.includes("\0"))) throw new ProviderError("That path isn't usable.");
    if (input.args !== undefined && (!Array.isArray(input.args) || input.args.some((a) => typeof a !== "string" || a.includes("\0")))) throw new ProviderError("The arguments must be text.");
    const args = (input.args ?? []).filter((a) => a.length);
    if (input.models !== undefined && !Array.isArray(input.models)) throw new ProviderError("The models must be a list.");
    const models = [...new Set((input.models ?? []).map((m) => (typeof m === "string" ? m.trim() : "")).filter(Boolean))];
    const bad = models.find((m) => !validModelId(m));
    if (bad) throw new ProviderError(`"${bad}" isn't a model id: no spaces, and not starting with -.`);
    return { name, ...(path ? { path } : {}), ...(args.length ? { args } : {}), ...(models.length ? { models } : {}) };
}

/** Add a named instance of `base` (claude-code, codex, …): its provider id. */
export async function addInstance(base: string, input: InstanceInput): Promise<string> {
    const fields = checked(base, input);
    const id = newId(base, fields.name!);
    // Its variables are checked before anything's written.
    validateAgentEnv(id, input.env ?? []);
    const pf = readProvidersFileForUpdate();
    (pf.agents ??= {})[id] = fields;
    writeProvidersFile(pf);
    try {
        await saveAgentEnv(id, input.env ?? []);
    } catch (e) {
        await turnOffAgent(id).catch(() => false);
        throw e;
    }
    return id;
}

/** Change an instance: its name, path, arguments, variables and models (all as given; a secret left blank stays). */
export async function updateInstance(id: string, input: InstanceInput): Promise<void> {
    if (!isInstance(id) || !readAgentConfig(id)) throw new ProviderError("That instance was removed.");
    const fields = checked(baseCli(id), input, id);
    validateAgentEnv(id, input.env ?? []);
    const pf = readProvidersFileForUpdate();
    const cur = pf.agents?.[id];
    if (!cur) throw new ProviderError("That instance was removed.");
    for (const k of ["name", "path", "args", "models"] as const) delete cur[k];
    Object.assign(cur, fields);
    writeProvidersFile(pf);
    await saveAgentEnv(id, input.env ?? []);
}

/**
 * Remove an instance, and its secret values. A turn running on it goes on to its end; a session on it then can't send
 * until another model is picked (agent-env.ts cliEnv refuses to start a removed instance's CLI, rather than its CLI's
 * own setup in its place).
 */
export async function removeInstance(id: string): Promise<boolean> {
    if (!isInstance(id)) throw new ProviderError(`${id} isn't an instance`);
    return turnOffAgent(id);
}

/** Whether `id` names an instance that's set up now. */
export function instanceExists(id: string): boolean {
    return isInstance(id) && Boolean(getProvider(id));
}
