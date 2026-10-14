// Starts configured MCP servers and exposes their tools as harness tools
// named mcp__<server>__<tool>.
//
// Sources: "mcpServers" in user/local settings (trusted), and the project's
// .mcp.json, whose servers only start after the user approves them.

import { existsSync } from "fs";
import type { McpServerConfig, Settings } from "../config/settings";
import { readJson } from "../config/settings";
import { paths } from "../config/paths";
import type { Tool, ToolResult } from "../tools/types";
import type { ImagePart } from "../providers/types";
import { McpClient, type McpCallResult, type McpTool } from "./client";
import { redact } from "../util/redact";
import { truncateMiddle } from "../util/files";
import { createHash } from "crypto";

export interface ServerState {
    name: string;
    config: McpServerConfig;
    source: "settings" | "project";
    status: "pending" | "connecting" | "connected" | "failed" | "disabled" | "needs-approval";
    error?: string;
    client?: McpClient;
    tools: McpTool[];
    era?: string;
    /** Another configured server whose names clean to the same segment; this one never starts. */
    collidesWith?: string;
}

const MAX_OUTPUT = 40_000;

const clean = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "_");

/**
 * The server's part of its tool names. It never contains "__", so the first
 * "__" after "mcp__" always ends it: a rule for `mcp__github` can't match a
 * server named "github__x".
 */
export function serverSegment(server: string): string {
    return clean(server).replace(/_+/g, "_").replace(/^_|_$/g, "").slice(0, 30).replace(/_$/, "") || "server";
}

function collisionError(seg: string, first: string): string {
    return `its tool names (mcp__${seg}__…) would collide with server "${first}"; rename one of them`;
}

export function toolNameFor(server: string, tool: string): string {
    return `mcp__${serverSegment(server)}__${clean(tool)}`.slice(0, 64);
}

function sanitizeSchema(schema: Record<string, unknown> | undefined): Record<string, unknown> {
    const s: Record<string, unknown> = { ...(schema ?? {}) };
    delete s.$schema;
    if (s.type !== "object") s.type = "object";
    if (!s.properties) s.properties = {};
    return s;
}

export function formatMcpResult(r: McpCallResult): { content: string; images: ImagePart[] } {
    const texts: string[] = [];
    const images: ImagePart[] = [];
    for (const c of r.content) {
        switch (c.type) {
            case "text":
                texts.push(c.text);
                break;
            case "image":
                if (/^image\/(png|jpeg|gif|webp)$/.test(c.mimeType)) images.push({ type: "image", mediaType: c.mimeType, data: c.data });
                else texts.push(`[image of type ${c.mimeType} omitted]`);
                break;
            case "audio":
                texts.push(`[audio (${c.mimeType}) omitted]`);
                break;
            case "resource_link":
                texts.push(`Resource: ${c.title ?? c.name} <${c.uri}>${c.description ? ` - ${c.description}` : ""}`);
                break;
            case "resource":
                if (typeof c.resource.text === "string") texts.push(`Resource ${c.resource.uri}:\n${c.resource.text}`);
                else texts.push(`[binary resource ${c.resource.uri}${c.resource.mimeType ? ` (${c.resource.mimeType})` : ""} omitted]`);
                break;
        }
    }
    if (!texts.length && r.structuredContent !== undefined) texts.push(JSON.stringify(r.structuredContent, null, 2));
    return { content: truncateMiddle(redact(texts.join("\n\n")), MAX_OUTPUT), images };
}

export class McpManager {
    servers = new Map<string, ServerState>();
    onChange?: () => void;

    constructor(
        private cwd: string,
        private settings: () => Settings,
        private trusted: boolean,
    ) {}

    /** Read configuration; doesn't start anything. */
    load() {
        const s = this.settings();
        const next = new Map<string, ServerState>();
        for (const [name, config] of Object.entries(s.mcpServers ?? {})) {
            next.set(name, { name, config, source: "settings", status: config.disabled ? "disabled" : "pending", tools: [] });
        }
        if (this.trusted && existsSync(paths.projectMcp(this.cwd))) {
            const f = readJson<{ mcpServers?: Record<string, McpServerConfig> }>(paths.projectMcp(this.cwd));
            for (const [name, config] of Object.entries(f?.mcpServers ?? {})) {
                if (next.has(name)) continue;
                const approved = s.enableAllProjectMcpServers || (s.enabledMcpjsonServers ?? []).includes(name);
                const rejected = (s.disabledMcpjsonServers ?? []).includes(name);
                next.set(name, { name, config, source: "project", status: rejected || config.disabled ? "disabled" : approved ? "pending" : "needs-approval", tools: [] });
            }
        }
        // Two servers whose names clean to the same segment would share tool
        // names and permission rules; the later one (project after user) is refused.
        const bySegment = new Map<string, string>();
        for (const st of next.values()) {
            const seg = serverSegment(st.name);
            const first = bySegment.get(seg);
            if (first === undefined) bySegment.set(seg, st.name);
            else {
                st.collidesWith = first;
                if (st.status !== "disabled") {
                    st.status = "failed";
                    st.error = collisionError(seg, first);
                }
            }
        }
        // Keep running clients for unchanged servers.
        for (const [name, st] of this.servers) {
            const n = next.get(name);
            if (n && JSON.stringify(n.config) === JSON.stringify(st.config) && st.status === "connected" && n.status === "pending") next.set(name, st);
            else void st.client?.close();
        }
        this.servers = next;
    }

    async startAll(signal?: AbortSignal) {
        await Promise.all([...this.servers.values()].filter((s) => s.status === "pending").map((s) => this.start(s, signal)));
    }

    async start(st: ServerState, signal?: AbortSignal) {
        // Reconnecting doesn't lift the name-collision refusal from load().
        if (st.collidesWith !== undefined) {
            st.status = "failed";
            st.error = collisionError(serverSegment(st.name), st.collidesWith);
            this.onChange?.();
            return;
        }
        st.status = "connecting";
        st.error = undefined;
        this.onChange?.();
        try {
            const client = new McpClient(st.name, st.config, this.cwd);
            st.client = client;
            client.onExit = () => {
                if (st.status === "connected") {
                    st.status = "failed";
                    st.error = `server exited${client.stderrTail() ? `: ${client.stderrTail()}` : ""}`;
                    this.onChange?.();
                }
            };
            await client.connect(signal);
            st.tools = await client.listTools(signal);
            st.era = client.era === "modern" ? client.protocolVersion : `legacy ${client.protocolVersion}`;
            st.status = "connected";
            client.onToolsChanged = () => {
                client
                    .listTools()
                    .then((t) => {
                        st.tools = t;
                        this.onChange?.();
                    })
                    .catch(() => {});
            };
        } catch (e) {
            st.status = "failed";
            const tail = st.client?.stderrTail();
            st.error = redact(`${(e as Error).message}${tail ? `\n${tail}` : ""}`);
            await st.client?.close();
            st.client = undefined;
        }
        this.onChange?.();
    }

    async restart(name: string) {
        const st = this.servers.get(name);
        if (!st) return;
        await st.client?.close();
        st.client = undefined;
        await this.start(st);
    }

    async closeAll() {
        await Promise.all([...this.servers.values()].map((s) => s.client?.close()));
    }

    /** Harness tool wrappers for every connected server's tools. */
    tools(): Tool<any>[] {
        const out: Tool<any>[] = [];
        for (const st of this.servers.values()) {
            if (st.status !== "connected" || !st.client) continue;
            const client = st.client;
            // Tools whose names clean (or truncate) to the same string all get a
            // suffix derived from their real name, so a name (and any rule that
            // approved it) stays with one tool whatever order the server lists them in.
            const base = new Map<string, number>();
            for (const t of st.tools) base.set(toolNameFor(st.name, t.name), (base.get(toolNameFor(st.name, t.name)) ?? 0) + 1);
            for (const t of st.tools) {
                let name = toolNameFor(st.name, t.name);
                if ((base.get(name) ?? 0) > 1) name = `${name.slice(0, 64 - 9)}_${createHash("sha256").update(t.name).digest("hex").slice(0, 8)}`;
                const readOnly = t.annotations?.readOnlyHint === true;
                const label = t.title ?? t.annotations?.title ?? t.name;
                out.push({
                    name,
                    category: "mcp",
                    readOnly,
                    description: `${(t.description ?? label).slice(0, 4000)}\n\n(MCP tool "${t.name}" from server "${st.name}")`,
                    parameters: sanitizeSchema(t.inputSchema),
                    title: (input: Record<string, unknown>) => {
                        const arg = Object.values(input ?? {}).find((v) => typeof v === "string") as string | undefined;
                        return `${st.name} - ${label}${arg ? `(${arg.slice(0, 60)})` : ""}`;
                    },
                    async run(input: Record<string, unknown>, ctx): Promise<ToolResult> {
                        try {
                            const r = await client.callTool(t.name, input ?? {}, ctx.signal);
                            const f = formatMcpResult(r);
                            return {
                                content: f.content || "(no output)",
                                images: f.images.length ? f.images : undefined,
                                isError: r.isError,
                                display: { summary: r.isError ? "Error" : `${f.content.split("\n").length} lines${f.images.length ? `, ${f.images.length} image(s)` : ""}` },
                            };
                        } catch (e) {
                            return { content: `MCP error from ${st.name}: ${redact((e as Error).message)}`, isError: true };
                        }
                    },
                });
            }
        }
        return out;
    }

    instructions(): string {
        const parts: string[] = [];
        for (const st of this.servers.values()) {
            const ins = st.client?.instructions?.trim();
            if (st.status === "connected" && ins) parts.push(`## ${st.name}\n${ins.slice(0, 4000)}`);
        }
        return parts.length ? `# MCP server instructions\nThese come from the connected MCP servers and describe how to use their tools.\n\n${parts.join("\n\n")}` : "";
    }

    needsApproval(): ServerState[] {
        return [...this.servers.values()].filter((s) => s.status === "needs-approval");
    }
}
