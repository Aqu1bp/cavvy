// Codex's own computer use, as the ChatGPT app sets it up in Codex's home (its unified-computer-use plugin): left on
// for a Codex thread when desktop.enabled is on and it's set up there, turned off otherwise (whatever the person's
// Codex config says); its per-app approvals go to the person; its calls show as using the app. Cavvy starts nothing
// of the app's itself. Where it isn't set up, or fails to start, the session falls back to Cavvy's own Mac app tools
// (served over Cavvy's MCP server, as to Claude Code) for good: one way per session, never both.

import { existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";
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

/**
 * The ChatGPT app's computer-use service, which its plugin reaches under the HOME Codex runs with (not CODEX_HOME):
 * measured with ChatGPT 26.1106 and Codex 0.169, it serves a Codex Cavvy starts only with the person's own HOME.
 */
export function computerUseServiceApp(home = process.env.HOME || homedir()): string {
    return join(home, ".codex", "computer-use", "Codex Computer Use.app");
}

/**
 * What can be known of it before Codex starts: on the default account (the app sets it up for the person's own Codex;
 * what it would do under another account's CODEX_HOME is unchecked), with its service there.
 */
function computerUsePossible(accountId: string | undefined): boolean {
    return (accountId ?? "default") === "default" && serviceThere();
}

/** Where tests have the service (none: it isn't there). Tests never look in the person's own HOME. */
let testServiceApp: string | undefined;
export function setComputerUseServiceApp(path: string | undefined): void {
    testServiceApp = path;
}
function serviceThere(): boolean {
    if (process.env.CAVVY_TEST === "1") return testServiceApp !== undefined && existsSync(testServiceApp);
    return existsSync(computerUseServiceApp());
}

/**
 * Whether a Codex thread can use the ChatGPT app's computer use: computerUsePossible, and set up in its Codex home
 * (computerUseSetUp, from Codex's own config/read). Otherwise the session falls back to Cavvy's Mac app tools.
 */
export function computerUseReady(effective: unknown, turnedOff: ThreadConfig | undefined, accountId: string | undefined): boolean {
    return computerUsePossible(accountId) && computerUseSetUp(effective, turnedOff);
}

/** Why a session's Codex uses Cavvy's Mac app tools: its own computer use isn't set up for it, or failed to start. */
export type DesktopFallback = "setup" | "failed";

/** The Cavvy sessions whose Codex fell back to Cavvy's Mac app tools, for the rest of the session (until Cavvy quits). */
const fellBack = new Map<string, { why: DesktopFallback; said?: boolean }>();

/** Whether, and why, a session's Codex uses Cavvy's Mac app tools in place of its own computer use. */
export function codexDesktopFallback(sessionKey: string | undefined): DesktopFallback | undefined {
    return sessionKey === undefined ? undefined : fellBack.get(sessionKey)?.why;
}

/**
 * codexDesktopFallback before a turn, with Mac apps on: a session that can't have its own computer use
 * (computerUsePossible) falls back now, so its first app-server already serves Cavvy's tools. One that isn't set up
 * in Codex's config falls back as its thread opens (Codex's computerUseConfig).
 */
export function codexFallsBack(sessionKey: string, accountId: string | undefined): DesktopFallback | undefined {
    const now = codexDesktopFallback(sessionKey);
    if (now || computerUsePossible(accountId)) return now;
    fellBack.set(sessionKey, { why: "setup" });
    return "setup";
}

/** The session falls back to Cavvy's Mac app tools, for good (the first reason stays). */
export function fallBackToCavvyTools(sessionKey: string, why: DesktopFallback): void {
    if (!fellBack.has(sessionKey)) fellBack.set(sessionKey, { why });
}

/** Whether the session's line saying it fell back is still to be shown: true once. */
export function fallbackToSay(sessionKey: string): boolean {
    const f = fellBack.get(sessionKey);
    if (!f || f.said) return false;
    f.said = true;
    return true;
}

/** For tests: sessions start over. */
export function resetDesktopFallbacks(): void {
    fellBack.clear();
}

/**
 * Whether a computer-use call's error says its service couldn't be started: its first line, "… native pipe startup
 * failed", as a `js` call ends when the service doesn't serve this Codex (measured with ChatGPT 26.1106 and Codex
 * 0.169, a HOME other than the person's). Not an app the person declined ("… was not approved to use …"), nor the
 * model's code failing: those are ordinary errors the model sees.
 */
export function computerUseStartFailed(text: string): boolean {
    const first = text.trimStart().split("\n", 1)[0] ?? "";
    return /\bnative pipe startup failed\b/i.test(first);
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

/** computerUseOffConfig as thread config to add: none when there's nothing to turn off. */
export function computerUseOff(effective: unknown): ThreadConfig | undefined {
    const c = computerUseOffConfig(effective);
    return Object.keys(c).length ? c : undefined;
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
    | {
          kind: "app";
          name: string;
          bundleId?: string;
          /** What it named the app by, when that's not a bundle id (a name, a path). */
          target?: string;
          /** Every name and id it gave the app (shown, asked about, its parameter): each is checked against the apps never offered. */
          aliases: string[];
          persist: ("session" | "always")[];
          callId?: string;
      }
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
    const raw = typeof params.app === "string" && params.app.trim() ? params.app.trim() : undefined;
    const aliases = [...new Set([shown?.value, asked, raw].map((x) => (typeof x === "string" ? x.trim() : "")).filter(Boolean))];
    return { kind: "app", name, ...(id && looksLikeBundleId(id) ? { bundleId: id } : raw ? { target: raw } : {}), aliases, persist, ...(callId ? { callId } : {}) };
}

const looksLikeBundleId = (s: string) => /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+){2,}$/.test(s);

/**
 * Why an app Codex asks for is never offered, if it is. Every name and id it gave is checked, each both as a name (the
 * core's patterns, a path's last part) and as a bundle id (the listed ones, two-part ids such as org.alacritty too):
 * one that matches is enough. One that matches nothing isn't let through by this: the person is asked.
 */
export function neverOfferedApp(ask: { name: string; bundleId?: string; target?: string; aliases?: readonly string[] }): NeverReason | undefined {
    const all = [ask.name, ask.bundleId, ask.target, ...(ask.aliases ?? [])].filter((s): s is string => typeof s === "string" && s.trim() !== "");
    for (const s of all) {
        const why = neverOffered({ name: "", bundleId: s.trim() }) ?? neverOffered({ name: s });
        if (why) return why;
    }
    return undefined;
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
 * "TextEdit: Type the note", "Mac apps: Type the note", "Use TextEdit". A call that runs no code and only reports how
 * the work ended (`completion_summary`) reads as that report.
 */
export function computerUseTitle(tool: string, args: unknown, app?: string): string {
    const text = (k: string) => (record(args) && typeof args[k] === "string" ? args[k].trim().replace(/\s+/g, " ") : "");
    const title = text("title") || (text("code") ? "" : text("completion_summary"));
    if (tool === "js_reset") return app ? `${app}: start over` : "Mac apps: start over";
    if (title) return `${app ?? "Mac apps"}: ${title.length > 120 ? `${title.slice(0, 120)}…` : title}`;
    return app ? `Use ${app}` : "Use an app on your Mac";
}
