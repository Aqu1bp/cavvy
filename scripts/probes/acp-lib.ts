// Shared client for the ACP (Agent Client Protocol) probes: JSON-RPC 2.0, one JSON object per line on
// stdin/stdout. Speaks to `opencode acp` and `grok agent stdio` the way a bare ACP client would.
//
// Safety: the agents are driven by real models on this machine, so every probe process
//   - runs in a fresh temp folder (its cwd and the session cwd),
//   - is wrapped in `sandbox-exec` with a profile that denies file writes outside that folder, the CLI's
//     own state folders, the system temp folders and /dev,
//   - gets a hard `perl -e alarm` timeout,
//   - and answers session/request_permission with reject unless the request is exactly the harmless
//     action the probe asked for (an exact command, or a path inside the temp folder).
import { mkdtempSync, realpathSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { JsonProc, Log, scrubAlso, sleep } from "./lib";

const sessionCounter = { n: 1 };
const seenSessions = new Set<string>();
/** Gives a session id a stable placeholder (<session-N>) the first time any frame mentions it. */
export function trackSession(id: string | undefined | null) {
    if (!id || id.startsWith("<") || seenSessions.has(id)) return;
    seenSessions.add(id);
    scrubAlso(id, `<session-${sessionCounter.n++}>`);
}
/** Stderr that quotes a CLI's bundled (minified) code: keep only the message lines, not the code. */
export function redactCode(text: string) {
    if (!/\/\/ @bun|\$bunfs|import\{[\w,]+\}from/.test(text)) return text;
    const keep = text.split("\n").filter((l) => l.length < 200 && !/\/\/ @bun|\$bunfs|^\s*\d+ \|/.test(l) && l.trim());
    return `[${text.length} chars of stderr quoting the CLI's bundled code, redacted; message lines:]\n${keep.join("\n")}`;
}
/** A Log that spots session ids in every frame before it is scrubbed and written. */
export class AcpLog extends Log {
    override add(dir: "in" | "out" | "err" | "note", frame: unknown) {
        if (dir === "err" && typeof frame === "string") frame = redactCode(frame);
        const s = typeof frame === "string" ? frame : JSON.stringify(frame);
        for (const m of s.matchAll(/"(?:[A-Za-z]*[sS]essionId|session_id)"\s*:\s*"([^"]+)"/g)) trackSession(m[1]);
        for (const m of s.matchAll(/\bses_[A-Za-z0-9]{12,}\b/g)) trackSession(m[0]);
        super.add(dir, frame);
    }
}

/** A fresh temp folder (real path, so /tmp and /private/tmp agree), scrubbed to a stable placeholder in fixtures. */
export function tempWorkspace(label: string) {
    const dir = realpathSync(mkdtempSync(join("/tmp", `acp-${label}-`)));
    scrubAlso(dir, `/tmp/acp-${label}`);
    scrubAlso(dir.replace(/^\/private/, ""), `/tmp/acp-${label}`);
    scrubAlso(encodeURIComponent(dir), encodeURIComponent(`/tmp/acp-${label}`));
    return dir;
}

/** sandbox-exec profile: writes only to the workspace, the CLI's state folders, temp folders and /dev. */
export function sandboxProfile(workspace: string, stateDirs: string[]) {
    const allow = [workspace, "/private/var/folders", "/private/tmp", "/dev", ...stateDirs].map((p) => `(subpath ${JSON.stringify(p)})`).join(" ");
    return `(version 1)(allow default)(deny file-write*)(allow file-write* ${allow})`;
}

export const HOME = homedir();
export const STATE_DIRS = {
    grok: [join(HOME, ".grok")],
    opencode: [".local/share/opencode", ".local/state/opencode", ".cache/opencode", ".config/opencode"].map((p) => join(HOME, p)),
};

export type Answer = "allow_once" | "allow_always" | "reject_once" | "reject_always" | "cancelled" | "none";

/** What the probe expects a permission request to be. `answer` is used only when `match` holds and, for allows, the safety check passes. */
export type PermissionRule = { label: string; match: (req: PermissionRequest) => boolean; answer: Answer; once?: boolean; delayMs?: number };
export type PermissionRequest = { id: any; params: any; command?: string; paths: string[] };

/** The shell command a tool call carries, if any (each CLI names the field differently). */
function commandOf(toolCall: any): string | undefined {
    const ri = toolCall?.rawInput ?? {};
    const c = ri.command ?? ri.cmd ?? ri.commands;
    return typeof c === "string" ? c : Array.isArray(c) ? c.join(" ") : undefined;
}
function pathsOf(toolCall: any, cwd: string): string[] {
    const ri = toolCall?.rawInput ?? {};
    const out: string[] = [];
    for (const k of ["filePath", "file_path", "path", "target_file", "filepath", "file"]) if (typeof ri[k] === "string") out.push(ri[k]);
    for (const l of toolCall?.locations ?? []) if (typeof l?.path === "string") out.push(l.path);
    return out.map((p) => (p.startsWith("/") ? p : resolve(cwd, p)));
}
const inside = (p: string, dir: string) => {
    if (/[*?~]|(^|\/)\.\.(\/|$)/.test(p)) return false;
    const n = resolve(p);
    const alt = (x: string) => (x.startsWith("/private/") ? x.slice("/private".length) : `/private${x}`);
    return [n, alt(n)].some((x) => x === dir || x.startsWith(dir + "/"));
};

export type AcpOpts = {
    cli: "grok" | "opencode";
    args: string[];
    workspace: string;
    env?: Record<string, string>;
    timeoutSec?: number;
    sandbox?: boolean;
    /** Exact commands allowed to be approved (with allow_once) in this run. */
    safeCommands?: string[];
};

export class Acp {
    readonly p: JsonProc;
    private seq = 0;
    readonly permissionLog: { req: PermissionRequest; answer: Answer; rule?: string; note?: string }[] = [];
    rules: PermissionRule[] = [];
    private answered = new Set<any>();
    private timer;
    constructor(
        readonly log: Log,
        readonly opts: AcpOpts,
    ) {
        const bin = opts.cli === "grok" ? join(HOME, ".local/bin/grok") : "/opt/homebrew/bin/opencode";
        const inner = [bin, ...opts.args];
        const sandboxed = opts.sandbox !== false ? ["sandbox-exec", "-p", sandboxProfile(opts.workspace, STATE_DIRS[opts.cli])] : [];
        const cmd = ["perl", "-e", "alarm shift; exec @ARGV", String(opts.timeoutSec ?? 240), ...sandboxed, ...inner];
        log.note(`spawn ${opts.cli} ${opts.args.join(" ")}`, { sandboxed: opts.sandbox !== false, env: opts.env ?? {}, cwd: opts.workspace, hardTimeoutSec: opts.timeoutSec ?? 240 });
        this.p = new JsonProc(log, cmd, { cwd: opts.workspace, env: opts.env });
        // Answer what the agent asks of us; we offer no fs or terminal, so anything but a permission is an error.
        this.timer = setInterval(() => this.serveRequests(), 25);
    }
    private serveRequests() {
        for (const f of this.p.frames) {
            if (!f.method || f.id === undefined || this.answered.has(f)) continue;
            this.answered.add(f);
            if (f.method === "session/request_permission") void this.answerPermission(f);
            else {
                this.log.note(`agent request ${f.method} answered with method-not-found`);
                this.send({ jsonrpc: "2.0", id: f.id, error: { code: -32601, message: `Method not found: ${f.method}` } });
            }
        }
    }
    private async answerPermission(f: any) {
        const tc = f.params?.toolCall;
        const req: PermissionRequest = { id: f.id, params: f.params, command: commandOf(tc), paths: pathsOf(tc, this.opts.workspace) };
        const rule = this.rules.find((r) => r.match(req));
        let answer: Answer = rule?.answer ?? "reject_once";
        let note: string | undefined;
        if (rule?.once) this.rules = this.rules.filter((r) => r !== rule);
        if (answer.startsWith("allow")) {
            const cmdOk = req.command === undefined || (this.opts.safeCommands ?? []).includes(req.command.trim());
            const pathsOk = req.paths.every((p) => inside(p, this.opts.workspace));
            if (!cmdOk || !pathsOk) ((note = `safety check refused allow (command ${JSON.stringify(req.command)}, paths ${JSON.stringify(req.paths)})`), (answer = "reject_once"));
        }
        if (!rule) note = "no rule matched: default reject";
        this.permissionLog.push({ req, answer, rule: rule?.label, note });
        this.log.note(`permission request -> ${answer}${rule ? ` (rule: ${rule.label})` : ""}${note ? `; ${note}` : ""}`);
        if (rule?.delayMs) await sleep(rule.delayMs);
        if (answer === "none") return;
        if (answer === "cancelled") return this.send({ jsonrpc: "2.0", id: f.id, result: { outcome: { outcome: "cancelled" } } });
        const options: any[] = f.params?.options ?? [];
        const opt = options.find((o) => o.kind === answer) ?? (answer.startsWith("reject") ? options.find((o) => String(o.kind).startsWith("reject")) : undefined);
        if (!opt) {
            this.log.note(`no option of kind ${answer}; answering cancelled`);
            return this.send({ jsonrpc: "2.0", id: f.id, result: { outcome: { outcome: "cancelled" } } });
        }
        this.send({ jsonrpc: "2.0", id: f.id, result: { outcome: { outcome: "selected", optionId: opt.optionId } } });
    }
    send(obj: any) {
        this.p.send(obj);
    }
    /** Remembers a session id so the fixture shows a placeholder. */
    track(sessionId: string | undefined) {
        trackSession(sessionId);
    }
    async request(method: string, params: unknown, timeoutMs = 60_000): Promise<{ id: number; result?: any; error?: any; timeout?: boolean; from: number; ms: number }> {
        const id = ++this.seq;
        const from = this.p.frames.length;
        const t0 = Date.now();
        if (params && typeof params === "object" && "sessionId" in (params as any)) this.track((params as any).sessionId);
        this.send({ jsonrpc: "2.0", id, method, params });
        const f = await this.p.waitFor((x) => x.id === id && !x.method && ("result" in x || "error" in x), timeoutMs, from);
        const ms = Date.now() - t0;
        if (!f) return { id, timeout: true, from, ms };
        return f.error ? { id, error: f.error, from, ms } : { id, result: f.result, from, ms };
    }
    /** Sends a request without waiting; returns its id. */
    fire(method: string, params: unknown) {
        const id = ++this.seq;
        this.send({ jsonrpc: "2.0", id, method, params });
        return id;
    }
    response(id: number, timeoutMs: number, from = 0) {
        return this.p.waitFor((x) => x.id === id && !x.method && ("result" in x || "error" in x), timeoutMs, from);
    }
    notify(method: string, params: unknown) {
        this.send({ jsonrpc: "2.0", method, params });
    }
    initialize() {
        return this.request("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "cavvy-probe", title: "Cavvy probe", version: "0.0.0" } });
    }
    async newSession(extra: Record<string, unknown> = {}) {
        const r = await this.request("session/new", { cwd: this.opts.workspace, mcpServers: [], ...extra });
        this.track(r.result?.sessionId);
        return r;
    }
    prompt(sessionId: string, text: string, timeoutMs = 180_000, extraBlocks: any[] = []) {
        return this.request("session/prompt", { sessionId, prompt: [{ type: "text", text }, ...extraBlocks] }, timeoutMs);
    }
    /** Frames after `from`, summarised: kinds in order with consecutive repeats collapsed, plus the agent text. */
    summarize(from: number, to = this.p.frames.length) {
        const kinds: string[] = [];
        let text = "";
        let thought = "";
        for (const f of this.p.frames.slice(from, to)) {
            let k: string;
            if (f.method === "session/update") {
                const u = f.params?.update ?? {};
                k = `update:${u.sessionUpdate}`;
                if (u.sessionUpdate === "agent_message_chunk") text += u.content?.text ?? "";
                if (u.sessionUpdate === "agent_thought_chunk") thought += u.content?.text ?? "";
                if (u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") k += `(${u.kind ?? ""}/${u.status ?? ""})`;
            } else if (f.method) k = f.id !== undefined ? `request:${f.method}` : `notify:${f.method}`;
            else k = f.error ? `response#${f.id}:error` : `response#${f.id}`;
            const last = kinds[kinds.length - 1];
            const m = last?.match(/^(.*) x(\d+)$/);
            if (last === k) kinds[kinds.length - 1] = `${k} x2`;
            else if (m && m[1] === k) kinds[kinds.length - 1] = `${k} x${Number(m[2]) + 1}`;
            else kinds.push(k);
        }
        return { kinds, text, thoughtChars: thought.length };
    }
    alive() {
        return this.p.alive();
    }
    async closeStdin() {
        this.p.proc.stdin.end();
    }
    async stop() {
        clearInterval(this.timer);
        await this.p.kill();
    }
}
/** Persisted between probe runs (outside the repo): session ids and workspaces needed by later cases. */
export function state(file: string) {
    const read = () => (existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {});
    return {
        get: (k: string) => read()[k],
        set: (k: string, v: unknown) => writeFileSync(file, JSON.stringify({ ...read(), [k]: v }, null, 2)),
    };
}

export const STATE_FILE = (cli: string) => join(tmpdir(), `acp-probe-${cli}-state.json`);
