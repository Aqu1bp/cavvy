// Approving a project's .mcp.json servers, bound to what they run.
//
// A server from .mcp.json starts only once the user approves it. The
// approval is saved in the folder's local settings as a keyed hash of what
// the server runs (command, args, the folder it runs in, env names and
// values, url, headers) and of the folder itself: change any of that and it
// asks again. The key is the user's own, in the harness home, so a repo
// that commits a settings.local.json can't approve its own servers with it.
//
// The terminal's /mcp and the GUI both go through here (and McpManager), so
// they show the same facts and write the same file.

import { createHmac, randomBytes } from "crypto";
import { readFileSync, realpathSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { ensureDir, harnessHome, paths } from "../config/paths";
import { updateSettings, type McpServerConfig, type Settings } from "../config/settings";
import { expandPath } from "../util/files";
import { redact } from "../util/redact";
import type { McpApprovalInfo, McpServerInfo, McpServerStatus } from "./info";

/** A request the caller got wrong, or one this folder's state refuses. */
export class McpApprovalError extends Error {
    constructor(
        message: string,
        readonly code: "untrusted" | "needs_trust" | "unknown" | "not_project" | "not_needed" | "changed" | "blocked",
    ) {
        super(message);
    }
}

// ---------------------------------------------------------------------------
// The fingerprint

const keys = new Map<string, Buffer>();

/**
 * The user's approval key (one per harness home). If it can't be saved, a
 * key for this run still works: approvals made now ask again next time.
 */
function approvalKey(): Buffer {
    const home = harnessHome();
    const cached = keys.get(home);
    if (cached) return cached;
    const file = join(home, "mcp-approval.key");
    const read = (): Buffer | undefined => {
        try {
            const text = readFileSync(file, "utf-8").trim();
            return /^[0-9a-f]{64}$/.test(text) ? Buffer.from(text, "hex") : undefined;
        } catch {
            return undefined;
        }
    };
    let key = read();
    if (!key) {
        const fresh = randomBytes(32);
        try {
            ensureDir(home);
            // "wx": never replace a key another process just wrote (or one that's broken: that's for the user to look at).
            writeFileSync(file, fresh.toString("hex") + "\n", { mode: 0o600, flag: "wx" });
            key = fresh;
        } catch {
            key = read() ?? fresh;
        }
    }
    keys.set(home, key);
    return key;
}

function real(p: string): string {
    try {
        return realpathSync(p);
    } catch {
        return p;
    }
}

/** The folder a stdio server runs in: its "cwd" resolved against the project (as McpClient starts it), symlinks resolved. */
export function serverCwd(config: McpServerConfig, projectCwd: string): string {
    return real(typeof config.cwd === "string" && config.cwd.trim() ? expandPath(config.cwd, projectCwd) : resolve(projectCwd));
}

/** Key order doesn't change what runs; anything that isn't an object is kept as it is. */
function entries(o: unknown): unknown {
    if (o === undefined || o === null) return [];
    if (typeof o !== "object" || Array.isArray(o)) return o;
    return Object.keys(o)
        .sort()
        .map((k) => [k, (o as Record<string, unknown>)[k]]);
}

/** What an approval is bound to. "disabled" isn't part of it: turning a server off and on again isn't a change to what it runs. */
export function mcpFingerprint(config: McpServerConfig, projectCwd: string): string {
    const what = {
        // The same folder reached through a symlink (the GUI and the terminal may name it differently) is the same approval.
        folder: real(resolve(projectCwd)),
        command: config.command ?? null,
        args: config.args ?? [],
        cwd: config.url ? null : serverCwd(config, projectCwd),
        env: entries(config.env),
        url: config.url ?? null,
        headers: entries(config.headers),
    };
    return "v1:" + createHmac("sha256", approvalKey()).update(JSON.stringify(what)).digest("hex");
}

// ---------------------------------------------------------------------------
// Approval state, read from settings

export interface Approval extends McpApprovalInfo {
    fingerprint: string;
}

const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const record = (v: unknown): Record<string, string> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, string>) : {});

/**
 * A rejection wins; then enableAllProjectMcpServers in the user's settings
 * (which covers later changes too, being a blanket opt-in), in a folder the
 * user trusted themselves (`userTrusted`: not one trusted only for having had
 * nothing to protect when it was opened); then an approval of exactly this
 * configuration. `s` must be settings as loadSettings merges them, where
 * these keys come from user and local settings only.
 */
export function approvalOf(name: string, config: McpServerConfig, s: Settings, projectCwd: string, userTrusted: boolean): Approval {
    const fingerprint = mcpFingerprint(config, projectCwd);
    if (list(s.disabledMcpjsonServers).includes(name)) return { state: "rejected", fingerprint };
    if (userTrusted && Object.hasOwn(s, "enableAllProjectMcpServers") && s.enableAllProjectMcpServers === true) return { state: "approved", viaAll: true, fingerprint };
    const approved = record(s.approvedMcpjsonServers);
    const saved = Object.hasOwn(approved, name) ? approved[name] : undefined;
    if (saved === fingerprint) return { state: "approved", fingerprint };
    const reason = saved !== undefined ? "changed" : list(s.enabledMcpjsonServers).includes(name) ? "legacy" : "new";
    return { state: "needs-approval", reason, fingerprint };
}

// ---------------------------------------------------------------------------
// Saving decisions (always the folder's local settings, as the terminal and the GUI both read)

function without(v: unknown, name: string): string[] | undefined {
    const l = list(v).filter((n) => n !== name);
    return l.length ? l : undefined;
}

function withoutKey(v: unknown, name: string): Record<string, string> | undefined {
    const r = { ...record(v) };
    delete r[name];
    return Object.keys(r).length ? r : undefined;
}

export function saveApproval(cwd: string, name: string, fingerprint: string) {
    updateSettings("local", cwd, (s) => {
        s.approvedMcpjsonServers = { ...record(s.approvedMcpjsonServers), [name]: fingerprint };
        // A name-only approval from before has done its job.
        s.enabledMcpjsonServers = without(s.enabledMcpjsonServers, name);
        s.disabledMcpjsonServers = without(s.disabledMcpjsonServers, name);
    });
}

export function saveRejection(cwd: string, name: string) {
    updateSettings("local", cwd, (s) => {
        s.disabledMcpjsonServers = [...(without(s.disabledMcpjsonServers, name) ?? []), name];
        s.approvedMcpjsonServers = withoutKey(s.approvedMcpjsonServers, name);
        s.enabledMcpjsonServers = without(s.enabledMcpjsonServers, name);
    });
}

/** Back to asking: neither approved nor rejected. */
export function removeApproval(cwd: string, name: string) {
    updateSettings("local", cwd, (s) => {
        s.approvedMcpjsonServers = withoutKey(s.approvedMcpjsonServers, name);
        s.enabledMcpjsonServers = without(s.enabledMcpjsonServers, name);
    });
}

// ---------------------------------------------------------------------------
// Showing what will run

export const LIMITS = { label: 100, command: 1000, arg: 400, args: 64, argChars: 8000, url: 1000, names: 64, nameLen: 100, error: 2000 };

/** Control, format (bidi, zero-width) and non-ASCII space characters: shown, never rendered. */
const INVISIBLE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}   -   　]/gu;

/** With `lineBreaks` (for error text), a line break stays one; everything else invisible is still shown. */
export function visible(s: string, o: { lineBreaks?: boolean } = {}): { text: string; hidden: boolean } {
    let hidden = false;
    const text = (o.lineBreaks ? s.replace(/\r\n/g, "\n") : s).replace(INVISIBLE, (c) => {
        if (o.lineBreaks && c === "\n") return c;
        hidden = true;
        return `⟨U+${c.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}⟩`;
    });
    return { text, hidden };
}

/**
 * Values from a server's env and headers, longest first, labelled by name,
 * to mask wherever they turn up (args, errors, tool output). Shorter than
 * four characters isn't masked: "1" or "on" would garble everything shown,
 * and holds nothing secret.
 */
function configSecrets(config: McpServerConfig): [string, string][] {
    const out: [string, string][] = [];
    const add = (v: unknown, label: string) => {
        if (typeof v === "string" && v.length >= 4) out.push([v, label]);
    };
    for (const [k, v] of Object.entries(record(config.env))) add(v, `env ${k}`);
    for (const [k, v] of Object.entries(record(config.headers))) {
        add(v, `header ${k}`);
        // "Bearer <token>": the token on its own, too.
        if (typeof v === "string" && /\s/.test(v.trim())) add(v.trim().split(/\s+/).pop(), `header ${k}`);
    }
    return out.sort((a, b) => b[0].length - a[0].length);
}

/** One pass, longest value first, so a label put in (which may hold another value, such as a variable's name) isn't masked again. Text is masked once, where it's made. */
function maskWith(text: string, secrets: [string, string][]): string {
    if (!secrets.length) return text;
    const labels = new Map(secrets);
    const re = new RegExp(secrets.map(([v]) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    return text.replace(re, (m) => `[REDACTED ${labels.get(m)}]`);
}

/** An env or header value of this server's, wherever it shows up in `text`, masked; then redact(). */
export function maskConfigValues(text: string, config: McpServerConfig): string {
    return redact(maskWith(text, configSecrets(config)));
}

/**
 * Every string in `v` (a tool result, a schema) with this server's config
 * values masked, before anything serializes or cuts it (either could split
 * or escape a value). Nested past 64 levels is dropped.
 */
export function maskConfigDeep<T>(v: T, config: McpServerConfig): T {
    const secrets = configSecrets(config);
    if (!secrets.length) return v;
    const walk = (x: unknown, depth: number): unknown => {
        if (typeof x === "string") return maskWith(x, secrets);
        if (!x || typeof x !== "object") return x;
        if (depth > 64) return null;
        if (Array.isArray(x)) return x.map((y) => walk(y, depth + 1));
        return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, walk(y, depth + 1)]));
    };
    return walk(v, 0) as T;
}

/** A password in the URL, and query values whose names look like credentials. */
function maskUrl(url: string): string {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#@]*)@/i, "$1[REDACTED password]@").replace(/([?&#][^=&#]*(?:token|key|secret|passw|auth|sig|credential)[^=&#]*=)([^&#]*)/gi, "$1[REDACTED]");
}

export interface DescribeInput {
    name: string;
    config: McpServerConfig;
    source: "settings" | "project";
    status: McpServerStatus;
    tools: unknown[];
    error?: string;
    approval?: Approval;
}

/** What will run, as both front ends show it. Never an env or header value; secrets in what is shown are masked, and it's bounded. */
export function describeServer(st: DescribeInput, projectCwd: string): McpServerInfo {
    const c = st.config;
    const secrets = configSecrets(c);
    let masked = false;
    let hidden = false;
    const cut: string[] = [];
    const show = (raw: unknown, max: number, what: string, maskValues = true, lineBreaks = false): string => {
        const text = String(raw ?? "");
        const m = maskValues ? maskWith(redact(text), secrets) : redact(text);
        if (m !== text) masked = true;
        const v = visible(m, { lineBreaks });
        hidden ||= v.hidden;
        if (v.text.length <= max) return v.text;
        cut.push(what);
        return v.text.slice(0, max) + "…";
    };
    const names = (o: unknown, what: string): string[] => {
        const all = Object.keys(record(o));
        if (all.length > LIMITS.names) cut.push(`${all.length - LIMITS.names} more ${what} not shown`);
        // Names are shown as they are (only ever redact()ed): they're what the card is about.
        return all.slice(0, LIMITS.names).map((k) => show(k, LIMITS.nameLen, `a long ${what.replace(/s$/, "")}`, false));
    };
    const remote = Boolean(c.url);
    const info: McpServerInfo = {
        name: st.name,
        label: show(st.name, LIMITS.label, "the name"),
        source: st.source,
        status: st.status,
        tools: st.tools.length,
        transport: remote ? "http" : "stdio",
    };
    // Masked where it was made (McpManager.start), so not twice.
    if (st.error) info.error = show(st.error, LIMITS.error, "the error", false, true);
    if (remote) {
        const url = String(c.url);
        const shown = maskUrl(url);
        if (shown !== url) masked = true;
        info.url = show(shown, LIMITS.url, "the URL");
        info.headerNames = names(c.headers, "header names");
    } else {
        info.command = show(c.command ?? "", LIMITS.command, "the command");
        const raw = Array.isArray(c.args) ? c.args : c.args === undefined ? [] : [c.args];
        const args: string[] = [];
        let chars = 0;
        for (const a of raw) {
            if (args.length >= LIMITS.args || chars >= LIMITS.argChars) break;
            const s = show(a, LIMITS.arg, `argument ${args.length + 1}`);
            args.push(s);
            chars += s.length;
        }
        if (args.length < raw.length) cut.push(`${raw.length - args.length} more argument${raw.length - args.length === 1 ? "" : "s"} not shown`);
        info.args = args;
        info.cwd = show(serverCwd(c, projectCwd), LIMITS.command, "the folder");
        info.envNames = names(c.env, "env names");
    }
    if (st.source === "project") {
        info.declaredIn = paths.projectMcp(projectCwd);
        if (st.approval) {
            const { fingerprint, ...a } = st.approval;
            info.approval = a;
            info.fingerprint = fingerprint;
            const why = approvalReason(a);
            if (why) info.why = why;
        }
        if (c.disabled === true) info.disabledInFile = true;
    }
    if (masked) info.masked = true;
    if (hidden) info.hidden = true;
    if (cut.length) info.cut = cut;
    return info;
}

/** The facts behind the approve button, for both front ends. */
export function approvalMeaning(provider: string | undefined, userTrusted: boolean): string {
    const here = "Approving starts the server in Harness for this folder, and its tools go to sessions here that run on Harness's own models.";
    if (provider === "claude-code") {
        return userTrusted
            ? `${here} This session runs on Claude Code, which doesn't get them. Claude Code reads .mcp.json itself, and Harness runs it as "claude -p", which starts the servers in .mcp.json without asking, whatever you decide here. Only Claude Code's own disabledMcpjsonServers keeps one out of it. (Read-only sub-agents get no MCP servers.)`
            : `${here} This session runs on Claude Code, which doesn't get them. It gets no servers from .mcp.json in this folder either, because you haven't trusted the folder yourself.`;
    }
    if (provider === "codex") return `${here} This session runs on Codex, which doesn't get them and takes its MCP servers from its own config, not from .mcp.json.`;
    return here;
}

/** Why a server asks (again), in words. */
export function approvalReason(a: McpApprovalInfo | undefined): string | undefined {
    if (a?.state !== "needs-approval") return undefined;
    if (a.reason === "changed") return "What it runs changed since you approved it.";
    if (a.reason === "legacy") return "You approved it by name only, before approvals were bound to what a server runs. Approve it once more.";
    return undefined;
}
