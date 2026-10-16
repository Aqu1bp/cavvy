// Starts configured MCP servers and exposes their tools as harness tools
// named mcp__<server>__<tool>.
//
// Sources: "mcpServers" in user/local settings (trusted), and the project's
// .mcp.json, whose servers only start after the user approves what they run
// (approval.ts). start() is the only place a server is started, and it
// refuses a project server that isn't approved.

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
import type { McpServerInfo } from "./info";
import { approvalOf, describeServer, maskConfigDeep, maskConfigValues, McpApprovalError, removeApproval, saveApproval, saveRejection, type Approval } from "./approval";

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
    /** A project server's standing with the user, for the configuration in `config`. */
    approval?: Approval;
    /** Bumped by each start (and when load() drops this state): an earlier start that's still connecting gives up. */
    gen?: number;
}

/** A project server may start: approved for exactly what `config` runs, and not turned off in .mcp.json. */
export function mayStart(st: ServerState): boolean {
    return st.source !== "project" || (st.approval?.state === "approved" && st.config.disabled !== true);
}

const MAX_OUTPUT = 40_000;
/** Bounds for list(): how many servers, and roughly how many characters of description. */
const MAX_LISTED = 100;
const LIST_BUDGET = 64_000;
/** A server named longer than this isn't loaded (its name travels in every status update). */
const MAX_NAME = 200;

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
    /** Servers left out by load() for their name's length. */
    skipped = 0;

    /**
     * `reloadSettings` re-reads the settings `settings` returns, after an
     * approval is saved (and before a refresh), so they're current.
     */
    constructor(
        private cwd: string,
        private settings: () => Settings,
        readonly trusted: boolean,
        private reloadSettings?: () => void,
    ) {}

    /**
     * Read configuration; doesn't start anything. A server whose configuration
     * and approval didn't change keeps its state (running, failed, or turned
     * off for this session); any other running one is stopped, and the
     * returned promise settles once it has.
     */
    load(): Promise<void> {
        const s = this.settings();
        const next = new Map<string, ServerState>();
        this.skipped = 0;
        for (const [name, config] of Object.entries(s.mcpServers ?? {})) {
            if (name.length > MAX_NAME) this.skipped++;
            else next.set(name, { name, config, source: "settings", status: config.disabled ? "disabled" : "pending", tools: [] });
        }
        if (this.trusted && existsSync(paths.projectMcp(this.cwd))) {
            const f = readJson<{ mcpServers?: Record<string, McpServerConfig> }>(paths.projectMcp(this.cwd));
            const servers = f?.mcpServers && typeof f.mcpServers === "object" ? f.mcpServers : {};
            for (const [name, raw] of Object.entries(servers)) {
                if (next.has(name)) continue;
                if (name.length > MAX_NAME) {
                    this.skipped++;
                    continue;
                }
                const config: McpServerConfig = raw && typeof raw === "object" ? raw : {};
                const approval = approvalOf(name, config, s, this.cwd);
                const status = approval.state === "rejected" || config.disabled ? "disabled" : approval.state === "approved" ? "pending" : "needs-approval";
                next.set(name, { name, config, source: "project", status, tools: [], approval });
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
        // Keep unchanged servers as they are.
        const closing: Promise<void>[] = [];
        for (const [name, st] of this.servers) {
            const n = next.get(name);
            const same = n && n.source === st.source && n.collidesWith === st.collidesWith && JSON.stringify(n.config) === JSON.stringify(st.config) && n.approval?.fingerprint === st.approval?.fingerprint && n.approval?.state === st.approval?.state;
            const kept = same && n.status === "pending" && (["connected", "connecting", "failed"].includes(st.status) || (st.status === "disabled" && !st.config.disabled));
            if (kept) {
                st.approval = n.approval;
                next.set(name, st);
            } else {
                // A start of this state still under way gives up, and starts nothing more.
                st.gen = (st.gen ?? 0) + 1;
                const c = st.client;
                st.client = undefined;
                if (c) closing.push(c.close().catch(() => undefined));
            }
        }
        this.servers = next;
        return Promise.all(closing).then(() => undefined);
    }

    /** Settings and .mcp.json read again (what the other front end saved, or an edit), clients told if anything changed. */
    async refresh(): Promise<void> {
        const before = this.summary();
        this.reloadSettings?.();
        const closed = this.load();
        if (this.summary() !== before) this.onChange?.();
        await closed;
    }

    /** refresh(), then start what's newly approved. It doesn't retry a server that failed. */
    async sync(): Promise<void> {
        await this.refresh();
        void this.startAll();
    }

    private summary(): string {
        return JSON.stringify([...this.servers.values()].map((s) => [s.name, s.source, s.status, s.tools.length, s.error, s.approval?.state, s.approval?.reason]));
    }

    async startAll(signal?: AbortSignal) {
        await Promise.all([...this.servers.values()].filter((s) => s.status === "pending").map((s) => this.start(s, signal)));
    }

    async start(st: ServerState, signal?: AbortSignal) {
        // Nothing starts a project server that isn't approved for what it runs, whoever asks; nor a
        // state load() has replaced since (a revoke while a reconnect waited for the old process to stop).
        if (!mayStart(st) || this.servers.get(st.name) !== st) {
            this.onChange?.();
            return;
        }
        // Reconnecting doesn't lift the name-collision refusal from load().
        if (st.collidesWith !== undefined) {
            st.status = "failed";
            st.error = collisionError(serverSegment(st.name), st.collidesWith);
            this.onChange?.();
            return;
        }
        const gen = (st.gen ?? 0) + 1;
        st.gen = gen;
        const superseded = () => st.gen !== gen;
        // One client per server: a start already under way is replaced, not doubled.
        void st.client?.close();
        st.client = undefined;
        st.status = "connecting";
        st.error = undefined;
        this.onChange?.();
        let client: McpClient | undefined;
        try {
            client = new McpClient(st.name, st.config, this.cwd);
            st.client = client;
            const c = client;
            client.onExit = () => {
                if (!superseded() && st.status === "connected") {
                    st.status = "failed";
                    st.error = maskConfigValues(`server exited${c.stderrTail() ? `: ${c.stderrTail()}` : ""}`, st.config);
                    this.onChange?.();
                }
            };
            await client.connect(signal);
            // Revoked (or restarted) while connecting: no more requests with its configuration.
            if (superseded()) {
                await client.close();
                return;
            }
            const tools = await client.listTools(signal);
            if (superseded()) {
                await client.close();
                return;
            }
            st.tools = tools;
            st.era = client.era === "modern" ? client.protocolVersion : `legacy ${client.protocolVersion}`;
            st.status = "connected";
            const current = () => !superseded() && st.client === c;
            client.onToolsChanged = () => {
                if (!current()) return;
                c.listTools()
                    .then((t) => {
                        if (!current()) return;
                        st.tools = t;
                        this.onChange?.();
                    })
                    .catch(() => {});
            };
        } catch (e) {
            await client?.close();
            // Whoever superseded this start closed its client (and owns the status now).
            if (superseded()) return;
            st.status = "failed";
            const tail = client?.stderrTail();
            st.error = maskConfigValues(`${(e as Error).message}${tail ? `\n${tail}` : ""}`, st.config);
            st.client = undefined;
        }
        this.onChange?.();
    }

    async restart(name: string) {
        const st = this.servers.get(name);
        if (!st) return;
        const old = st.client;
        await old?.close();
        // Another restart may have started a newer client meanwhile: start() replaces it, closing it.
        if (st.client === old) st.client = undefined;
        await this.start(st);
    }

    /** Turned back on after "disable for this session", once settings and .mcp.json are read again (the other front end may have rejected it since). */
    async enable(name: string): Promise<void> {
        await this.refresh();
        const st = this.servers.get(name);
        if (!st || st.status !== "disabled" || !mayStart(st)) return;
        st.status = "pending";
        await this.start(st);
    }

    /**
     * Read the configuration again, then start the server afresh if it may
     * run. One whose .mcp.json entry changed since it was approved asks again
     * instead (and stays off).
     */
    async reconnect(name: string): Promise<ServerState> {
        await this.refresh();
        const st = this.servers.get(name);
        if (!st) throw new McpApprovalError(`There's no MCP server named "${name}" here.`, "unknown");
        if (mayStart(st) && st.status !== "disabled") await this.restart(name);
        return st;
    }

    private projectServer(name: string): ServerState {
        if (!this.trusted) throw new McpApprovalError("This folder isn't trusted, so its .mcp.json isn't read and its servers can't be approved. Trust the folder first.", "untrusted");
        const st = this.servers.get(name);
        if (!st) throw new McpApprovalError(`There's no MCP server named "${name}" here.`, "unknown");
        if (st.source !== "project" || !st.approval) throw new McpApprovalError(`"${name}" comes from your settings, not from .mcp.json: it doesn't need approving.`, "not_project");
        return st;
    }

    /**
     * Approve exactly the configuration with this fingerprint (what the user
     * was shown), after reading .mcp.json again: if it changed in between,
     * nothing is saved ("changed"). Saved to the folder's local settings.
     * Returns the server, ready for start().
     */
    async approve(name: string, fingerprint: string): Promise<ServerState> {
        await this.refresh();
        const st = this.projectServer(name);
        const a = st.approval!;
        if (a.state === "approved") throw new McpApprovalError(`"${name}" is already approved.`, "not_needed");
        if (st.config.disabled === true) throw new McpApprovalError(`"${name}" is turned off in .mcp.json ("disabled": true).`, "blocked");
        if (a.fingerprint !== fingerprint) throw new McpApprovalError(`What "${name}" runs changed since it was shown to you. Look at it again before approving.`, "changed");
        saveApproval(this.cwd, name, a.fingerprint);
        await this.refresh();
        const now = this.servers.get(name);
        if (now?.approval?.state !== "approved") throw new McpApprovalError(`"${name}" is still rejected in your user settings (disabledMcpjsonServers).`, "blocked");
        return now;
    }

    /** Rejected by name: it stays off (and stops) until approved again. */
    async reject(name: string): Promise<void> {
        await this.refresh();
        const st = this.projectServer(name);
        if (st.approval!.state === "rejected") return;
        saveRejection(this.cwd, name);
        await this.refresh();
    }

    /** The approval taken back: the server stops and asks again. */
    async revoke(name: string): Promise<void> {
        await this.refresh();
        const st = this.projectServer(name);
        const a = st.approval!;
        if (a.state !== "approved") throw new McpApprovalError(`"${name}" isn't approved.`, "not_needed");
        if (a.viaAll) throw new McpApprovalError(`"${name}" is approved by enableAllProjectMcpServers in your settings. Turn that off to approve servers one by one, or reject this one.`, "blocked");
        removeApproval(this.cwd, name);
        await this.refresh();
        if (this.servers.get(name)?.approval?.state === "approved") throw new McpApprovalError(`"${name}" is still approved in your user settings (approvedMcpjsonServers). Remove it there.`, "blocked");
    }

    async closeAll() {
        await Promise.all([...this.servers.values()].map((s) => s.client?.close()));
    }

    /** Harness tool wrappers for every connected server's tools. */
    tools(): Tool<any>[] {
        const out: Tool<any>[] = [];
        const self = this;
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
                // Everything the server says about its tools is masked for its own env and headers, as its results are.
                const label = maskConfigValues(t.title ?? t.annotations?.title ?? t.name, st.config);
                out.push({
                    name,
                    category: "mcp",
                    readOnly,
                    description: `${(t.description === undefined ? label : maskConfigValues(t.description, st.config)).slice(0, 4000)}\n\n(MCP tool "${maskConfigValues(t.name, st.config)}" from server "${st.name}")`,
                    parameters: sanitizeSchema(maskConfigDeep(t.inputSchema, st.config)),
                    title: (input: Record<string, unknown>) => {
                        const arg = Object.values(input ?? {}).find((v) => typeof v === "string") as string | undefined;
                        return `${st.name} - ${label}${arg ? `(${arg.slice(0, 60)})` : ""}`;
                    },
                    async run(input: Record<string, unknown>, ctx): Promise<ToolResult> {
                        // Revoked, rejected or restarted since this tool was listed (say, while its call waited for permission).
                        if (st.client !== client || self.servers.get(st.name) !== st || !mayStart(st)) return { content: `MCP server ${st.name} isn't running any more.`, isError: true };
                        try {
                            // The server knows its own env and headers: it doesn't get to echo them into the transcript.
                            const r = maskConfigDeep(await client.callTool(t.name, input ?? {}, ctx.signal), st.config);
                            const f = formatMcpResult(r);
                            return {
                                content: f.content || "(no output)",
                                images: f.images.length ? f.images : undefined,
                                isError: r.isError,
                                display: { summary: r.isError ? "Error" : `${f.content.split("\n").length} lines${f.images.length ? `, ${f.images.length} image(s)` : ""}` },
                            };
                        } catch (e) {
                            return { content: `MCP error from ${st.name}: ${maskConfigValues((e as Error).message, st.config)}`, isError: true };
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
            if (st.status === "connected" && ins) parts.push(`## ${st.name}\n${maskConfigValues(ins, st.config).slice(0, 4000)}`);
        }
        return parts.length ? `# MCP server instructions\nThese come from the connected MCP servers and describe how to use their tools.\n\n${parts.join("\n\n")}` : "";
    }

    /** What `name` runs and where it stands, as both front ends show it (secrets masked, bounded). */
    describe(name: string): McpServerInfo | undefined {
        const st = this.servers.get(name);
        return st && describeServer(st, this.cwd);
    }

    /**
     * Every server, described, within a size budget: past it, servers come as
     * summaries (`partial`; ask for one with describe()), and past MAX_LISTED
     * they're left out and counted.
     */
    list(): { servers: McpServerInfo[]; omitted: number } {
        const all = [...this.servers.values()];
        const servers: McpServerInfo[] = [];
        let size = 0;
        for (const st of all.slice(0, MAX_LISTED)) {
            const full = describeServer(st, this.cwd);
            const n = JSON.stringify(full).length;
            if (size + n <= LIST_BUDGET) {
                servers.push(full);
                size += n;
                continue;
            }
            const { name, label, source, status, tools, transport, approval, disabledInFile } = full;
            const summary: McpServerInfo = { name, label, source, status, tools, transport, approval, disabledInFile, partial: true };
            const m = JSON.stringify(summary).length;
            // Summaries count too; past twice the budget, the rest are only counted.
            if (size + m > 2 * LIST_BUDGET) break;
            servers.push(summary);
            size += m;
        }
        return { servers, omitted: all.length - servers.length + this.skipped };
    }

    needsApproval(): ServerState[] {
        return [...this.servers.values()].filter((s) => s.status === "needs-approval");
    }
}
