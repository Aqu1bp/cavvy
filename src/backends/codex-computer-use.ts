// Codex's own computer use, the one the ChatGPT app ships: on for a Codex thread when desktop.enabled is on and the
// ChatGPT app is installed, off otherwise (whatever the person's Codex config says); its per-app approvals go to the
// person; its calls show as using the app. What's measured (Codex 0.167, ChatGPT 26.1106) is in docs/mac-apps.md.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { NEVER_OFFERED, neverOffered, type NeverReason } from "../desktop/apps";

/**
 * The MCP servers Codex's computer use runs as: `cua_repl` (the ChatGPT app's unified-computer-use plugin), and the
 * names older builds used (`computer-use`, and `node_repl`, the app's own runtime). Off, each is turned off by name.
 */
export const CODEX_CU_SERVERS = ["cua_repl", "computer-use", "node_repl"] as const;
/** The ChatGPT app's plugins that bring it (its bundled marketplace). Off, each is turned off. */
export const CODEX_CU_PLUGINS = ["unified-computer-use@openai-bundled", "computer-use@openai-bundled"] as const;
/** The server Cavvy starts it as. */
export const CODEX_CU_SERVER = "cua_repl";

/** Where the ChatGPT app keeps its computer-use runtime. */
export interface ChatGptRuntime {
    node: string;
    nodeRepl: string;
    launcher: string;
    /** The plugin's own settings for its server (which tools, timeouts), without how it's started. */
    server: Record<string, unknown>;
}

const record = (v: unknown): v is Record<string, any> => v !== null && typeof v === "object" && !Array.isArray(v);

export const CHATGPT_APPS = ["/Applications/ChatGPT.app", join(homedir(), "Applications", "ChatGPT.app")];

/** The ChatGPT app's computer-use runtime, if one is installed. */
export function chatgptRuntime(apps: readonly string[] = CHATGPT_APPS): ChatGptRuntime | undefined {
    for (const app of apps) {
        const resources = join(app, "Contents", "Resources");
        const cua = join(resources, "cua_node");
        const node = join(cua, "bin", "node");
        const nodeRepl = join(cua, "bin", "node_repl");
        const launcher = join(cua, "lib", "node_modules", "@oai", "cua-repl", "bin", "cua-repl.mjs");
        if (![node, nodeRepl, launcher].every((p) => existsSync(p))) continue;
        let server: Record<string, unknown> = {};
        try {
            const mcp = JSON.parse(readFileSync(join(resources, "plugins", "openai-bundled", "plugins", "unified-computer-use", ".mcp.json"), "utf8"));
            if (record(mcp?.mcpServers?.[CODEX_CU_SERVER])) server = mcp.mcpServers[CODEX_CU_SERVER];
        } catch {
            // The plugin's file is only where its tool settings come from: the defaults below do without it.
        }
        return { node, nodeRepl, launcher, server };
    }
    return undefined;
}

/** What Codex is told about apps by bundle id: every one never offered is denied. */
export function deniedBundleIds(): Record<string, "deny"> {
    return Object.fromEntries(NEVER_OFFERED.map((a) => [a.bundleId, "deny" as const]));
}

/**
 * The thread config that turns Codex's computer use on: the ChatGPT app's runtime as the `cua_repl` server, started
 * the way the app starts it (desktop control only, no browser), and the apps never offered denied. Nothing is written
 * to the person's Codex config.
 */
export function computerUseOnConfig(rt: ChatGptRuntime): ThreadConfig {
    const { command: _c, args: _a, env: _e, enabled: _en, cwd: _cwd, env_vars: _ev, ...tools } = rt.server;
    return {
        mcp_servers: {
            [CODEX_CU_SERVER]: {
                enabled_tools: ["js", "js_reset", "turn_ended"],
                startup_timeout_sec: 120,
                ...tools,
                command: rt.node,
                args: [rt.launcher],
                env: { CUA_REPL_NODE_REPL_PATH: rt.nodeRepl, CUA_REPL_ENABLED_SURFACES: "computer" },
                // An account's own Codex home is where the app's computer-use service is looked for.
                env_vars: ["CODEX_HOME"],
                enabled: true,
            },
        },
        computer_use: { macos: { bundle_ids: deniedBundleIds() } },
    };
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

/** A thread's config for Codex: its MCP servers and plugins by name, and other keys. */
export type ThreadConfig = { mcp_servers?: Record<string, unknown>; plugins?: Record<string, unknown>; [key: string]: unknown };

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
    | { kind: "url" };

/**
 * What an elicitation Codex passes on (mcpServer/elicitation/request) asks, if it's from its computer use; undefined
 * for anything else, Codex's own approval of a `js` call included, which goes the way any MCP call's does.
 */
export function computerUseAsk(p: any): ComputerUseAsk | undefined {
    const server = typeof p?.serverName === "string" ? p.serverName : "";
    const meta = record(p?._meta) ? p._meta : {};
    const fromComputerUse = meta.connector_id === "computer-use" || isComputerUseServer(server);
    if (!fromComputerUse) return undefined;
    if (p?.mode === "url") return { kind: "url" };
    const message = typeof p?.message === "string" ? p.message.trim() : "";
    if (meta.tool_name === "start_audio_recording" || /\brecord (?:your |the )?computer audio\b/i.test(message)) return { kind: "audio" };
    const params = record(meta.tool_params) ? meta.tool_params : {};
    const shown = Array.isArray(meta.tool_params_display) ? meta.tool_params_display.find((d: any) => record(d) && d.name === "app" && typeof d.value === "string") : undefined;
    const asked = message.match(APP_QUESTION)?.[1];
    const id = meta.connector_id === "computer-use" && typeof params.app === "string" && params.app.trim() ? params.app.trim() : undefined;
    const name = (shown?.value as string | undefined)?.trim() || asked?.trim() || id;
    if (!name || (!id && !asked)) return undefined;
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
