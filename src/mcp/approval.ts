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

/**
 * What an approval is bound to. "disabled" isn't part of it: turning a server off and on doesn't change what runs.
 * `runCwd`: the folder it will be started in, resolved once by the caller
 * (McpManager.start), so what's checked is where it runs, whatever a
 * symlink points at a moment later.
 */
export function mcpFingerprint(config: McpServerConfig, projectCwd: string, runCwd?: string): string {
    const what = {
        // The same folder reached through a symlink (the GUI and the terminal may name it differently) is the same approval.
        folder: real(resolve(projectCwd)),
        command: config.command ?? null,
        args: config.args ?? [],
        cwd: config.url ? null : (runCwd ?? serverCwd(config, projectCwd)),
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
export function approvalOf(name: string, config: McpServerConfig, s: Settings, projectCwd: string, userTrusted: boolean, runCwd?: string): Approval {
    const fingerprint = mcpFingerprint(config, projectCwd, runCwd);
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
 * Configured secrets, longest first, labelled by source. Ordinary env/header values
 * shorter than four characters aren't masked: "1" or "on" would garble the text.
 * Explicit credential flags and URL fields are masked regardless of length.
 */
function configSecrets(config: McpServerConfig): [string, string][] {
    const out: [string, string][] = [];
    const add = (v: unknown, label: string, minLength = 4) => {
        if (typeof v === "string" && v.length >= minLength) out.push([v, label]);
    };
    // As written, and decoded (an error may echo either).
    const addUrlPart = (v: string | undefined, label: string) => {
        if (v === undefined) return;
        add(v, label, 1);
        try {
            const d = decodeURIComponent(v);
            if (d !== v) add(d, label, 1);
        } catch {
            // not percent-encoded
        }
    };
    if (typeof config.url === "string") {
        addUrlPart(URL_PASSWORD.exec(config.url)?.[1], "URL password");
        for (const m of config.url.matchAll(URL_QUERY)) {
            if (!secretQueryName(m[2]!)) continue;
            addUrlPart(m[3], `URL ${m[2]}`);
            // Query decoding treats '+' as a space too; errors may echo either representation.
            addUrlPart(m[3]!.replace(/\+/g, " "), `URL ${m[2]}`);
        }
    }
    for (const [flag, v] of secretFlags(config.args)) add(v, `argument ${flag}`, 1);
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

/** Config secrets, wherever they show up in `text`, masked; then redact(). */
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
        // Keys too: a server can put a value it knows in a key of its structured output.
        return Object.fromEntries(Object.entries(x).map(([k, y]) => [maskWith(k, secrets), walk(y, depth + 1)]));
    };
    return walk(v, 0) as T;
}

const URL_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:([^/?#@]*)@/i;
const SECRET_QUERY_KEY = /token|key|secret|passw|auth|sig|credential/i;
const URL_QUERY = /([?&#])([^=&#]*)=([^&#]*)/g;

function secretQueryName(name: string): boolean {
    try {
        name = decodeURIComponent(name);
    } catch {
        // A malformed name can still contain a recognizable credential label.
    }
    return SECRET_QUERY_KEY.test(name);
}

/** A password in the URL, and query values whose names look like credentials. */
function maskUrl(url: string): string {
    return url.replace(/^([a-z][a-z0-9+.-]*:\/\/[^/?#@:]*:)([^/?#@]*)@/i, "$1[REDACTED password]@").replace(URL_QUERY, (part, sep: string, name: string) => secretQueryName(name) ? `${sep}${name}=[REDACTED]` : part);
}

/** A flag named like a password, token, secret or API key (--password, --access-token, --api-key), not --token-file. */
const SECRET_FLAG = /^--?[A-Za-z0-9_-]*(?:password|passwd|token|secret|api[-_]?key|apikey)$/i;

/** [flag, value, index of the value's arg, "=" form] for each secret-looking flag's value in `args`. */
function secretFlags(args: unknown): [string, string, number, boolean][] {
    if (!Array.isArray(args)) return [];
    const out: [string, string, number, boolean][] = [];
    args.forEach((a, i) => {
        if (typeof a !== "string") return;
        const eq = a.indexOf("=");
        if (eq > 0 && SECRET_FLAG.test(a.slice(0, eq))) out.push([a.slice(0, eq), a.slice(eq + 1), i, true]);
        else if (SECRET_FLAG.test(a) && typeof args[i + 1] === "string" && !(args[i + 1] as string).startsWith("--")) out.push([a, args[i + 1] as string, i + 1, false]);
    });
    return out;
}

/** Does `text` hold one of the server's env, header, URL or argument secrets? */
export function hasConfigValue(text: string, config: McpServerConfig): boolean {
    return configSecrets(config).some(([value]) => text.includes(value));
}

/** HTTP header names aren't case-sensitive: two that differ only in case would be sent combined, in whatever order they were written. */
export function headerClash(config: McpServerConfig): string | undefined {
    const seen = new Map<string, string>();
    for (const k of Object.keys(record(config.headers))) {
        const first = seen.get(k.toLowerCase());
        if (first !== undefined) return `its headers "${first}" and "${k}" are the same header (names aren't case-sensitive); keep one of them`;
        seen.set(k.toLowerCase(), k);
    }
    return undefined;
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
        const raw: unknown[] = Array.isArray(c.args) ? [...c.args] : c.args === undefined ? [] : [c.args];
        // The value of a --password, --token, --secret or --api-key flag, either form.
        for (const [flag, , i, eq] of secretFlags(raw)) {
            raw[i] = eq ? `${flag}=[REDACTED]` : "[REDACTED]";
            masked = true;
        }
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
