// SessionStart and InstructionsLoaded hooks, as the terminal, the app's
// server and -p each start a session. What SessionStart hooks send back
// (additionalContext, watchPaths) waits on the session for its agent.

import type { Settings } from "../config/settings";
import type { Session } from "./session";
import { fireHooks, type HookNotice, type HookServices } from "./hooks";
import { toolNameFor } from "../mcp/manager";
import type { Tool } from "../tools/types";
import { loadMemory } from "./memory";

const MEMORY_TYPE = { user: "User", project: "Project", local: "Local" } as const;

export function sessionStartHooks(settings: Settings, session: Session, source: string, cwd: string, warn: HookNotice, services?: HookServices, extra: Record<string, unknown> = {}): Promise<void> {
    const started = run(settings, session, source, cwd, warn, services, extra);
    // The session's next turn waits for them, so the first prompt gets their context however soon it's sent.
    session.hooksStarting = started.catch(() => {});
    return started;
}

async function run(settings: Settings, session: Session, source: string, cwd: string, warn: HookNotice, services: HookServices | undefined, extra: Record<string, unknown>): Promise<void> {
    const common = { session_id: session.meta.id, ...extra };
    const h = await fireHooks(settings, "SessionStart", { ...common, source, ...(session.model ? { model: session.model } : {}) }, cwd, warn, services);
    if (h?.additionalContext) session.hookContext.push(`Context from a SessionStart hook:\n${h.additionalContext}`);
    if (h?.watchPaths) session.hookWatchPaths = h.watchPaths;
    await instructionsLoadedHooks(settings, session, source, cwd, warn, services, extra);
}

/** InstructionsLoaded for the memory files the session's system prompt was built from (it's built once, when the session is made). */
export async function instructionsLoadedHooks(settings: Settings, session: Session, source: string, cwd: string, warn: HookNotice, services?: HookServices, extra: Record<string, unknown> = {}): Promise<void> {
    if (!settings.hooks?.InstructionsLoaded?.length) return;
    const loadReason = source === "compact" ? "compact" : "session_start";
    await Promise.all(loadMemory(cwd).map((f) => fireHooks(settings, "InstructionsLoaded", { session_id: session.meta.id, ...extra, file_path: f.path, memory_type: MEMORY_TYPE[f.scope], load_reason: loadReason }, cwd, warn, services)));
}

/**
 * What prompt, mcp_tool and async hooks run on before a session has an agent
 * turn: the small model, the session's MCP tools, and the session for what an
 * async hook sends back (it goes with the next prompt).
 */
export function sessionHookServices(o: { session: () => Session; warn: HookNotice; complete?: (system: string, prompt: string, signal?: AbortSignal) => Promise<string>; mcpTools?: () => Tool<any>[]; mcpReady?: () => Promise<unknown> }): HookServices {
    return {
        complete: o.complete ? (system, prompt, signal) => o.complete!(system, prompt, signal) : undefined,
        callTool: o.mcpTools
            ? async (server, name, input, signal) => {
                  const find = () => o.mcpTools!().find((t) => t.category === "mcp" && t.name === toolNameFor(server, name));
                  // At startup the servers may still be connecting: wait for them before calling it missing.
                  let tool = find();
                  if (!tool && o.mcpReady) {
                      await o.mcpReady();
                      tool = find();
                  }
                  if (!tool) throw new Error(`no tool ${name} on a connected MCP server "${server}"`);
                  const r = await tool.run(input, { signal } as any);
                  return { text: r.content, isError: Boolean(r.isError) };
              }
            : undefined,
        onAsync: (h) => {
            for (const m of h.errors) o.warn(m);
            for (const m of h.messages) o.warn(m, "info");
            if (h.additionalContext) o.session().hookContext.push(`Context from a background hook:\n${h.additionalContext}`);
        },
    };
}
