// Cavvy's own MCP server tools (the browser, the simulator, delegation, secrets, worktrees…), as an agent CLI names
// its calls of them. Cavvy checks each of these calls itself as it runs (Agent.runServed and the tools' own checks), so
// a backend answers the CLI's own ask about one with a yes, and shows it as Cavvy's.

import { APP_NAME } from "../config/paths";
import type { OrchestratorServer } from "./types";

/** How the CLIs name a server tool: mcp__cavvy__x (Claude Code, Codex), cavvy__x (Grok's use_tool), cavvy_x (OpenCode). */
const PREFIXES = [`mcp__${APP_NAME}__`, `${APP_NAME}__`, `${APP_NAME}_`];

/** The tool of Cavvy's server a call is of, by the name its CLI gives it: only one the server offers this turn. */
export function servedToolName(name: unknown, o: Pick<OrchestratorServer, "tools"> | undefined): string | undefined {
    if (!o || typeof name !== "string") return undefined;
    for (const prefix of PREFIXES) {
        if (!name.startsWith(prefix)) continue;
        const tool = name.slice(prefix.length);
        if (o.tools.includes(tool)) return tool;
    }
    return undefined;
}

/**
 * Whether a call's arguments are all the tool's own: a command or a file an agent names like the tool (OpenCode titles
 * a call by what it runs or reads) carries others, so it isn't taken for one.
 */
export function servedToolArgs(o: Pick<OrchestratorServer, "inputKeys"> | undefined, tool: string, input: Record<string, unknown>): boolean {
    const own = o?.inputKeys?.[tool];
    return Boolean(own) && Object.keys(input).every((k) => own!.includes(k));
}

/** A tool's argument names, from its input schema. */
export function inputKeysOf(schema: Record<string, unknown>): string[] {
    const props = schema.properties;
    return props && typeof props === "object" && !Array.isArray(props) ? Object.keys(props) : [];
}
