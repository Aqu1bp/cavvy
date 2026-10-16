import { knownSecrets } from "./redact";
import { secretEnvVarNames } from "../auth/credentials";

/**
 * Environment for every process the harness starts (shell, hooks, MCP
 * servers, git, ripgrep, editors): inherited, minus anything that holds an
 * API key the harness knows about. `extra` (settings `env`) may set any
 * variable, but not to one of those keys: the model can read the shell's env.
 */
export function childEnv(extra?: Record<string, string>): Record<string, string> {
    const env: Record<string, string> = {};
    // Account selectors belong only to their CLI, never to tools or hooks.
    const secretNames = new Set([...secretEnvVarNames(), "CLAUDE_CONFIG_DIR", "CODEX_HOME"]);
    const secretValues = new Set(knownSecrets());
    for (const [k, v] of Object.entries(process.env)) {
        if (v === undefined) continue;
        if (secretNames.has(k) || secretValues.has(v)) continue;
        env[k] = v;
    }
    for (const [k, v] of Object.entries(extra ?? {})) if (!secretNames.has(k) && !secretValues.has(v)) env[k] = v;
    env.PAGER = "cat";
    env.GIT_PAGER = "cat";
    env.GIT_TERMINAL_PROMPT = "0";
    env.HARNESS = "1";
    return env;
}
