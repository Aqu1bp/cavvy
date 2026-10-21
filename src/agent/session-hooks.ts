// SessionStart and InstructionsLoaded hooks, as the terminal, the app's
// server and -p each start a session. What SessionStart hooks send back
// (additionalContext, watchPaths) waits on the session for its agent.

import type { Settings } from "../config/settings";
import type { Session } from "./session";
import { fireHooks, type HookNotice } from "./hooks";
import { loadMemory } from "./memory";

const MEMORY_TYPE = { user: "User", project: "Project", local: "Local" } as const;

export function sessionStartHooks(settings: Settings, session: Session, source: string, cwd: string, warn: HookNotice, extra: Record<string, unknown> = {}): Promise<void> {
    const started = run(settings, session, source, cwd, warn, extra);
    // The session's next turn waits for them, so the first prompt gets their context however soon it's sent.
    session.hooksStarting = started.catch(() => {});
    return started;
}

async function run(settings: Settings, session: Session, source: string, cwd: string, warn: HookNotice, extra: Record<string, unknown>): Promise<void> {
    const common = { session_id: session.meta.id, ...extra };
    const h = await fireHooks(settings, "SessionStart", { ...common, source, ...(session.model ? { model: session.model } : {}) }, cwd, warn);
    if (h?.additionalContext) session.hookContext.push(`Context from a SessionStart hook:\n${h.additionalContext}`);
    if (h?.watchPaths) session.hookWatchPaths = h.watchPaths;
    // The memory files the session's system prompt was built from (it's built once, when the session is made).
    if (settings.hooks?.InstructionsLoaded?.length) {
        const loadReason = source === "compact" ? "compact" : "session_start";
        await Promise.all(loadMemory(cwd).map((f) => fireHooks(settings, "InstructionsLoaded", { ...common, file_path: f.path, memory_type: MEMORY_TYPE[f.scope], load_reason: loadReason }, cwd, warn)));
    }
}
