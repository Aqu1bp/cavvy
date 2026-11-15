// Codex's own computer use, as the ChatGPT app sets it up in Codex's home (its unified-computer-use plugin): left on
// for a Codex thread when desktop.enabled is on, turned off otherwise (whatever the person's Codex config says); its
// per-app approvals go to the person; its calls show as using the app. Cavvy starts nothing of the app's itself.

import { NEVER_OFFERED, neverOffered, type NeverReason } from "../desktop/apps";

/**
 * The MCP servers Codex's computer use runs as: `cua_repl` (the ChatGPT app's unified-computer-use plugin, Codex 0.167
 * and ChatGPT 26.1106), and the names older builds used (`computer-use`, `node_repl`). Off, each is turned off by name.
 */
export const CODEX_CU_SERVERS = ["cua_repl", "computer-use", "node_repl"] as const;
/** The plugin the ChatGPT app sets up for it. */
export const CODEX_CU_PLUGIN = "unified-computer-use@openai-bundled";
/** The ChatGPT app's plugins that bring it (its bundled marketplace). Off, each is turned off. */
export const CODEX_CU_PLUGINS = [CODEX_CU_PLUGIN, "computer-use@openai-bundled"] as const;

/** A thread's config for Codex: its MCP servers and plugins by name, and other keys. */
export type ThreadConfig = { mcp_servers?: Record<string, unknown>; plugins?: Record<string, unknown>; [key: string]: unknown };

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Whether the ChatGPT app set computer use up in this Codex home: its plugin on in Codex's effective config
 * (config/read), and not among what Cavvy turns off for the thread (a project's, or one of unknown provenance).
 */
export function computerUseSetUp(effective: unknown, turnedOff?: ThreadConfig): boolean {
    const plugins = record(effective) && record(effective.plugins) ? effective.plugins : {};
    const on = record(plugins[CODEX_CU_PLUGIN]) && plugins[CODEX_CU_PLUGIN].enabled !== false;
    const off = record(turnedOff?.plugins) && record(turnedOff.plugins[CODEX_CU_PLUGIN]) && turnedOff.plugins[CODEX_CU_PLUGIN].enabled === false;
    return on && !off;
}

/** What Codex is told about apps by bundle id: every one never offered is denied. */
export function deniedBundleIds(): Record<string, "deny"> {
    return Object.fromEntries(NEVER_OFFERED.map((a) => [a.bundleId, "deny" as const]));
}

/** The thread config with computer use on: the person's own setup as it is, with the apps never offered denied. */
export function computerUseOnConfig(): ThreadConfig {
    return { computer_use: { macos: { bundle_ids: deniedBundleIds() } } };
}

/**
 * The thread config that keeps it off, from Codex's effective config (config/read): its plugins turned off where
 * they're on, and a server of its names turned off where one is configured (Codex refuses an entry for a server that
 * has none). Empty when there's nothing to turn off.
 */
export function computerUseOffConfig(effective: unknown): ThreadConfig {
    const config = record(effective) ? effective : {};
    const plugins = record(config.plugins) ? config.plugins : {};
    const servers = record(config.mcp_servers) ? config.mcp_servers : {};
    const pluginsOff = CODEX_CU_PLUGINS.filter((id) => record(plugins[id]) && plugins[id].enabled !== false);
    const serversOff = CODEX_CU_SERVERS.filter((n) => Object.hasOwn(servers, n));
    const off = (names: readonly string[]) => Object.fromEntries(names.map((n) => [n, { enabled: false as const }]));
    return { ...(pluginsOff.length ? { plugins: off(pluginsOff) } : {}), ...(serversOff.length ? { mcp_servers: off(serversOff) } : {}) };
}

/** Two thread configs as one: their MCP servers and plugins merged (the second's win), anything else the second's. */
export function mergeThreadConfig(a: ThreadConfig | undefined, b: ThreadConfig | undefined): ThreadConfig | undefined {
    if (!b || !Object.keys(b).length) return a;
    if (!a) return b;
    const merged: ThreadConfig = { ...a, ...b };
    for (const key of ["mcp_servers", "plugins"]) {
        const x = a[key];
        const y = b[key];
        if (record(x) || record(y)) merged[key] = { ...(record(x) ? x : {}), ...(record(y) ? y : {}) };
    }
    return merged;
}

/** One of Codex's computer-use servers. */
export function isComputerUseServer(server: unknown): boolean {
    return typeof server === "string" && (CODEX_CU_SERVERS as readonly string[]).includes(server);
}

/** An app approval's question: `Allow Computer Use to use "Safari"?` (ChatGPT 26.11), `Allow ChatGPT to use Safari?` (older). */
const APP_QUESTION = /^Allow (?:ChatGPT|Computer Use|Codex) to use "?(.+?)"?\?$/;

/** What Codex's computer use asks the person through an MCP elicitation. */
export type ComputerUseAsk =
    /** Using one of the Mac's apps. `persist`: what Codex can keep a yes for besides this once. */
    | { kind: "app"; name: string; bundleId?: string; persist: ("session" | "always")[]; callId?: string }
    /** Recording the Mac's audio: never offered (Cavvy doesn't start it with audio). */
    | { kind: "audio" }
    /** A link to open (to set it up): cancelled, as a decline would be kept as a refusal. */
    | { kind: "url" }
    /** Anything else it asks that isn't Codex's own approval of a call (a shape not known yet): the person answers, with its question. */
    | { kind: "unknown"; question: string };

/** Its server's own tools, whose calls Codex itself asks about as it does any MCP tool's. */
const OWN_TOOLS = new Set(["js", "js_reset", "turn_ended"]);

/**
 * What an elicitation Codex passes on (mcpServer/elicitation/request) asks, if it's from its computer use; undefined
 * for anything else, and for Codex's own approval of a call to its server's tools (`js`, `js_reset`, `turn_ended`),
 * which goes the way any MCP call's does. What it doesn't recognise from computer use fails closed: "unknown".
 */
export function computerUseAsk(p: any): ComputerUseAsk | undefined {
    const server = typeof p?.serverName === "string" ? p.serverName : "";
    const meta = record(p?._meta) ? p._meta : {};
    const fromComputerUse = meta.connector_id === "computer-use" || isComputerUseServer(server);
    if (!fromComputerUse) return undefined;
    if (p?.mode === "url") return { kind: "url" };
    const message = typeof p?.message === "string" ? p.message.trim() : "";
    const named = typeof meta.tool_name === "string" ? meta.tool_name : message.match(/run tool "([A-Za-z0-9_.-]+)"\?$/)?.[1];
    if (meta.connector_id !== "computer-use" && meta.codex_approval_kind === "mcp_tool_call" && named !== undefined && OWN_TOOLS.has(named)) return undefined;
    if (meta.tool_name === "start_audio_recording" || /\brecord (?:your |the )?computer audio\b/i.test(message)) return { kind: "audio" };
    const params = record(meta.tool_params) ? meta.tool_params : {};
    const shown = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.find((d: any) => record(d) && d.name === "app" && typeof d.value === "string") : undefined;
    const asked = message.match(APP_QUESTION)?.[1];
    const id = meta.connector_id === "computer-use" && typeof params.app === "string" && params.app.trim() ? params.app.trim() : undefined;
    const name = (shown?.value as string | undefined)?.trim() || asked?.trim() || id;
    if (!name || (!id && !asked)) return { kind: "unknown", question: (message || "Codex's computer use asks for approval").slice(0, 200) };
    const persist = (Array.isArray(meta.persist) ? meta.persist : []).filter((x: unknown): x is "session" | "always" => x === "session" || x === "always");
    const callId = typeof meta.tool_call_id === "string" && meta.tool_call_id ? meta.tool_call_id : undefined;
    return { kind: "app", name, ...(id && looksLikeBundleId(id) ? { bundleId: id } : {}), persist, ...(callId ? { callId } : {}) };
}

const looksLikeBundleId = (s: string) => /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(s);

/** Why an app Codex asks for is never offered, if it is. */
export function neverOfferedApp(ask: { name: string; bundleId?: string }): NeverReason | undefined {
    return neverOffered({ name: ask.name, bundleId: ask.bundleId });
}

/** The app a computer-use call used, by bundle id, as its result says (`codex/toolSurface`, kind computerUse). */
export function toolSurfaceApp(result: unknown): string | undefined {
    const meta = record(result) && record(result._meta) ? result._meta : undefined;
    const surface = meta?.["codex/toolSurface"];
    if (!record(surface) || surface.kind !== "computerUse" || !record(surface.app)) return undefined;
    const app = surface.app.appId;
    return typeof app === "string" && app.trim() ? app.trim() : undefined;
}

/** An app's name from its bundle id, when nothing better is known: com.apple.TextEdit → TextEdit. */
export function appNameFromId(bundleId: string): string {
    return bundleId.split(".").pop() || bundleId;
}

/**
 * How a computer-use call reads in the transcript: what it does (the call's own title) and, once known, in which app.
 * "TextEdit: Type the note", "Mac apps: Type the note", "Use TextEdit".
 */
export function computerUseTitle(tool: string, args: unknown, app?: string): string {
    const title = record(args) && typeof args.title === "string" ? args.title.trim().replace(/\s+/g, " ") : "";
    if (tool === "js_reset") return app ? `${app}: start over` : "Mac apps: start over";
    if (title) return `${app ?? "Mac apps"}: ${title.length > 120 ? `${title.slice(0, 120)}…` : title}`;
    return app ? `Use ${app}` : "Use an app on your Mac";
}
