// The "hooks" settings block: which events there are, and the one place both
// configuration formats become a flat list of handlers.
//
// Ours (flat):            { "matcher": "Edit", "command": "./fmt.sh", "timeout": 30 }
// Claude Code's (nested): { "matcher": "Edit", "hooks": [{ "type": "command", "command": "./fmt.sh" }] }
//
// Settings files, plugins' hooks.json and sub-agent frontmatter all go
// through normalizeHooks, so every source supports the same handler types.

import type { HookConfig } from "./settings";

/** Every event the harness runs hooks for, in the order /hooks lists them. */
export const HOOK_EVENTS = [
    "SessionStart",
    "InstructionsLoaded",
    "UserPromptSubmit",
    "PreToolUse",
    "PermissionRequest",
    "PermissionDenied",
    "PostToolUse",
    "PostToolUseFailure",
    "PostToolBatch",
    "SubagentStart",
    "SubagentStop",
    "Notification",
    "PreCompact",
    "PostCompact",
    "CwdChanged",
    "FileChanged",
    "DirectoryAdded",
    "WorktreeCreate",
    "WorktreeRemove",
    "Stop",
    "StopFailure",
    "SessionEnd",
] as const;

export type HookEvent = (typeof HOOK_EVENTS)[number];

export const HOOK_TYPES = ["command", "http", "prompt", "mcp_tool"] as const;
export type HookType = (typeof HOOK_TYPES)[number];

const EVENT_SET = new Set<string>(HOOK_EVENTS);

export function isHookEvent(name: string): name is HookEvent {
    return EVENT_SET.has(name);
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : undefined);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : undefined);
const record = (v: unknown): Record<string, unknown> | undefined => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);

/** One handler, as written in either format, or why it was dropped. */
function handler(raw: Record<string, unknown>, matcher: string | undefined, extra: Partial<HookConfig>): HookConfig | string {
    const type = raw.type === undefined ? "command" : raw.type;
    if (typeof type !== "string" || !(HOOK_TYPES as readonly string[]).includes(type)) return `hook type ${JSON.stringify(type)} isn't supported (use ${HOOK_TYPES.join(", ")})`;
    const h: HookConfig = { ...extra, type: type as HookType };
    if (matcher !== undefined) h.matcher = matcher;
    if (typeof raw.timeout === "number" && raw.timeout > 0) h.timeout = raw.timeout;
    if (str(raw.if)) h.if = raw.if as string;
    if (str(raw.statusMessage)) h.statusMessage = raw.statusMessage as string;
    if (str(raw.pluginRoot)) h.pluginRoot = raw.pluginRoot as string;
    switch (type) {
        case "command":
            if (!str(raw.command)) return "a command hook needs a command";
            h.command = raw.command as string;
            if (strings(raw.args)) h.args = raw.args as string[];
            if (raw.async === true) h.async = true;
            break;
        case "http":
            if (!str(raw.url) || !/^https?:\/\//i.test(raw.url as string)) return "an http hook needs an http(s) url";
            h.url = raw.url as string;
            if (record(raw.headers)) h.headers = Object.fromEntries(Object.entries(raw.headers as object).filter(([, v]) => typeof v === "string"));
            if (strings(raw.allowedEnvVars)) h.allowedEnvVars = raw.allowedEnvVars as string[];
            break;
        case "prompt":
            if (!str(raw.prompt)) return "a prompt hook needs a prompt";
            h.prompt = raw.prompt as string;
            if (str(raw.model)) h.model = raw.model as string;
            break;
        case "mcp_tool":
            if (!str(raw.server) || !str(raw.tool)) return "an mcp_tool hook needs a server and a tool";
            h.server = raw.server as string;
            h.tool = raw.tool as string;
            if (record(raw.input)) h.input = raw.input as Record<string, unknown>;
            break;
    }
    return h;
}

/**
 * One event's list, in either format (or both mixed), as flat handlers.
 * Entries that can't run are left out and reported to `warn`; nothing throws.
 * `extra` is copied onto each handler (a plugin's `pluginRoot`).
 */
export function normalizeHookList(list: unknown, warn?: (msg: string) => void, extra: Partial<HookConfig> = {}): HookConfig[] {
    if (!Array.isArray(list)) {
        if (list !== undefined) warn?.("hooks: an event's hooks must be a list");
        return [];
    }
    const out: HookConfig[] = [];
    const add = (raw: unknown, matcher: string | undefined) => {
        const r = record(raw);
        if (!r) return warn?.("hooks: each hook must be an object");
        const h = handler(r, matcher, extra);
        if (typeof h === "string") warn?.(`hooks: ${h}`);
        else out.push(h);
    };
    for (const entry of list) {
        const e = record(entry);
        const matcher = typeof e?.matcher === "string" ? e.matcher : undefined;
        // Claude Code's matcher group: { matcher, hooks: [...] }.
        if (e && Array.isArray(e.hooks)) for (const h of e.hooks) add(h, matcher);
        else add(entry, matcher);
    }
    return out;
}

/** A whole "hooks" block. Unknown event names are reported and left out. */
export function normalizeHooks(raw: unknown, warn?: (msg: string) => void, extra: Partial<HookConfig> = {}): Partial<Record<HookEvent, HookConfig[]>> | undefined {
    const r = record(raw);
    if (!r) return undefined;
    const out: Partial<Record<HookEvent, HookConfig[]>> = {};
    for (const [event, list] of Object.entries(r)) {
        if (!isHookEvent(event)) {
            warn?.(`hooks: ${event} isn't a hook event the harness runs`);
            continue;
        }
        const l = normalizeHookList(list, warn, extra);
        if (l.length) out[event] = l;
    }
    return out;
}
