// Cavvy's permission gate for Antigravity's CLI (agy). Run headless, agy can't ask anyone: what needs approval is
// refused (agy-1.4.9-gate.jsonl, before the hook). A PreToolUse hook can approve it, though, and agy runs the hooks of
// every workspace folder, one added with --add-dir too. So each agy process gets a folder of Cavvy's own as an extra
// workspace, whose .agents/hooks.json sends every tool call's input to the Cavvy session that started it (the gate
// server here, on 127.0.0.1), and answers what Cavvy decides: auto_approve or deny. Nothing is installed into agy.
//
// What agy 1.4.9 does with it (test/fixtures/protocol/agy-1.4.9-*.jsonl):
//   - The hook gets {conversationId, stepIdx, toolCall: {name, args}} with all of the call's arguments (a write's
//     content), and the environment agy was started with.
//   - auto_approve runs the call; deny fails it with "tool call denied by pre-tool hook: <reason>", which the model
//     reads. A hook that fails or runs past its timeout fails the call too (-hook-timeout.jsonl): the gate fails closed.
//   - SessionStart runs once, before a new conversation's first model call (not when one is resumed); what its
//     injectSteps say, the model reads.
//   - The workspace folders are sorted by path, and the model takes the first for its own: the gate folder is named
//     to sort after the session's folder, and SessionStart tells the model which is which.

import { chmodSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { isAbsolute, join, resolve } from "path";
import { APP_TITLE } from "../../config/paths";
import { canonical } from "../../util/files";

/** What agy waits for an answer (seconds): an ask can wait on the user that long. Cavvy answers before (GATE_DEADLINE_MS). */
export const HOOK_TIMEOUT_S = 3600;
/** When Cavvy gives up waiting on the user and refuses the call: before agy would fail the hook. */
export const GATE_DEADLINE_MS = (HOOK_TIMEOUT_S - 30) * 1000;

/** The environment variables that tell the hook where Cavvy's gate is, and the session's token. */
export const GATE_URL_ENV = "CAVVY_AGY_GATE";
export const GATE_TOKEN_ENV = "CAVVY_AGY_TOKEN";

/**
 * The hook: each hook's input goes to the gate, and its answer comes back. Without a gate to ask, or with no answer,
 * a tool call is refused.
 */
const SCRIPT = `#!/bin/sh
# ${APP_TITLE}'s permission gate for Antigravity: ${APP_TITLE} decides each tool call. Written by ${APP_TITLE}.
deny() { if [ "$1" = pre ]; then printf '%s\\n' '{"decision":"deny","reason":"${APP_TITLE} did not answer, so this call was refused."}'; else printf '{}\\n'; fi; }
[ -n "$${GATE_URL_ENV}" ] && [ -n "$${GATE_TOKEN_ENV}" ] || { deny "$1"; exit 0; }
# The token goes to curl on fd 3, not on its command line (which other users can list); never through a proxy.
curl -sS --fail --noproxy '*' --max-time ${HOOK_TIMEOUT_S + 60} -K /dev/fd/3 -H "X-Cavvy-Event: $1" -H "Content-Type: application/json" --data-binary @- "$${GATE_URL_ENV}" 3<<EOF || deny "$1"
header = "Authorization: Bearer $${GATE_TOKEN_ENV}"
EOF
`;

const hooks = (script: string) =>
    JSON.stringify(
        {
            "cavvy-gate": {
                SessionStart: [{ type: "command", command: `'${script}' session`, timeout: 30 }],
                // Before each model call: messages queued to steer the turn join it here.
                PreInvocation: [{ type: "command", command: `'${script}' invocation`, timeout: 60 }],
                PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `'${script}' pre`, timeout: HOOK_TIMEOUT_S }] }],
            },
        },
        null,
        2,
    ) + "\n";

/** Overridable for tests: where the gate folder goes. */
export const gateRoot = { dir: () => realpathSync(tmpdir()) };

/**
 * The gate folder, written if it isn't as it should be: in the temporary folder (which sorts after most project
 * folders: /private/var/... after /Users/...), named for the user, and only theirs. Throws when it can't be made safe
 * (someone else's folder by that name).
 */
export function gateDir(): string {
    const uid = process.getuid?.() ?? 0;
    const dir = join(gateRoot.dir(), `zz-cavvy-antigravity-${uid}`);
    mkdirSync(join(dir, ".agents"), { recursive: true, mode: 0o700 });
    for (const d of [dir, join(dir, ".agents")]) ours(d);
    const script = join(dir, "gate.sh");
    keep(script, SCRIPT, 0o700);
    keep(join(dir, ".agents", "hooks.json"), hooks(script), 0o600);
    return dir;
}

/** A folder of this user's only, or it throws (someone else's folder by that name). */
function ours(d: string) {
    const st = lstatSync(d);
    if (!st.isDirectory() || (process.getuid && st.uid !== process.getuid())) throw new Error(`${d} isn't ${APP_TITLE}'s folder, so the Antigravity permission gate can't go there.`);
    if (st.mode & 0o077) chmodSync(d, 0o700);
}

/** Writes the file unless it already says exactly this. */
function keep(path: string, content: string, mode: number) {
    let now: string | undefined;
    try {
        now = readFileSync(path, "utf8");
    } catch {
        // not there yet
    }
    if (now !== content) writeFileSync(path, content, { mode });
    chmodSync(path, mode);
}

/** Where a session's attachments are written for it to read: beside the gate folder, not a workspace of its own. */
export function filesDir(token: string): string {
    const parent = `${gateDir()}-files`;
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    ours(parent);
    return join(parent, token);
}

/** What the model is told when its conversation starts: which folder is its own. */
export function sessionStartAnswer(cwd: string, gate: string): Record<string, unknown> {
    return {
        injectSteps: [
            {
                ephemeralMessage: `Your working folder is ${cwd}: work there unless the user names another folder. ${gate} only holds ${APP_TITLE}'s permission hook. Leave it alone.`,
            },
        ],
    };
}

// --- The server the hook posts to: one for the whole of Cavvy, each session by its token --------------------------

export type GateHandler = (event: string, input: any) => Promise<Record<string, unknown>>;

let server: ReturnType<typeof Bun.serve> | undefined;
const handlers = new Map<string, GateHandler>();

/** The gate's address, the server started if it isn't yet. */
export function gateUrl(): string {
    server ??= Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        // An ask waits on the user: no idle timeout.
        idleTimeout: 0,
        async fetch(req) {
            const token = /^Bearer (.+)$/.exec(req.headers.get("authorization") ?? "")?.[1];
            const handler = token ? handlers.get(token) : undefined;
            if (!handler || req.method !== "POST") return new Response("Not found", { status: 404 });
            let input: unknown;
            try {
                input = await req.json();
            } catch {
                return Response.json({ decision: "deny", reason: `${APP_TITLE} couldn't read this call, so it was refused.` });
            }
            return Response.json(await handler(req.headers.get("x-cavvy-event") ?? "", input));
        },
    });
    // It doesn't keep a process alive that's otherwise done.
    server.unref();
    return `http://127.0.0.1:${server.port}/`;
}

/** Routes a session's hook calls (by its token) to `handler` until the returned function is called. */
export function onGate(token: string, handler: GateHandler): () => void {
    handlers.set(token, handler);
    return () => {
        if (handlers.get(token) === handler) handlers.delete(token);
    };
}

/** Stops the server (tests). */
export function stopGateServer() {
    server?.stop(true);
    server = undefined;
    handlers.clear();
}

// --- agy's tool calls as Cavvy's tools ----------------------------------------------------------------------------

/** A call the gate holds, as one of Cavvy's tools (in the ACP gate's conventions: acp/agents.ts GateTool). */
export interface AgyTool {
    toolName: string;
    input: Record<string, unknown>;
    title?: string;
    reason?: string;
    /** Refused with this, without asking. */
    refuse?: string;
    /** It runs somewhere else than the session's folder: always asked about. */
    elsewhere?: boolean;
    /** One of agy's own that only reads or keeps its own state: let go (deny rules still apply). */
    free?: boolean;
    /** What its row shows for an edit or a write: before and after. */
    diff?: { before: string; after: string };
}

const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);

/** agy's own bookkeeping: waiting, a look at a command it started, its task list, its permissions, a question for the user. */
const FREE = new Set(["command_status", "wait", "wait_5_seconds", "finish", "manage_task", "list_permissions", "list_resources", "read_resource", "ask_question", "list_browser_pages", "list_plugin_accounts"]);

/**
 * A call as Cavvy checks it (names from agy 1.4.9's hooks: read_file, edit_file, write_file, run_command, search_web;
 * the others are from its init's tool list, which names some differently). Paths are made absolute against the folder
 * it runs in. Its other tools (the browser, image generation, schedules, subagents) are checked as a tool named
 * Antigravity: asked about in Manual, refused in Plan.
 */
export function agyTool(name: string, args: Record<string, any>, cwd: string, gate?: string): AgyTool | undefined {
    // It names files by their real path (/private/tmp/... for /tmp/...): inside the folder, as the session spells it.
    const real = canonical(cwd);
    const at = (p: string) => {
        const abs = isAbsolute(p) ? p : resolve(cwd, p);
        return real !== cwd && (abs === real || abs.startsWith(real + "/")) ? cwd + abs.slice(real.length) : abs;
    };
    const path = (...keys: string[]) => keys.map((k) => str(args[k])).find(Boolean);
    const inGate = (p: string) => Boolean(gate) && (canonical(p) === gate || canonical(p).startsWith(gate + "/"));
    const gateRefusal: AgyTool = { toolName: "", input: {}, refuse: `That folder only holds ${APP_TITLE}'s permission hook. Work in ${cwd}.` };
    if (str(args.CommandLine) || name === "run_command") {
        const command = str(args.CommandLine) ?? str(args.Command);
        if (!command) return undefined;
        const dir = str(args.Cwd);
        const elsewhere = Boolean(dir && canonical(at(dir)) !== canonical(cwd));
        return { toolName: "Bash", input: { command, ...(str(args.toolSummary) ? { description: args.toolSummary } : {}) }, ...(elsewhere ? { elsewhere, reason: `It runs in ${dir}.` } : {}) };
    }
    if (name === "send_command_input") return { toolName: "Antigravity", input: args, title: "Antigravity asks to type into a command it started" };
    if (/^(write_file|write_to_file)$/.test(name)) {
        const file = path("Path", "TargetFile", "AbsolutePath", "FilePath");
        if (!file) return undefined;
        if (inGate(at(file))) return gateRefusal;
        const content = typeof args.Content === "string" ? args.Content : typeof args.CodeContent === "string" ? args.CodeContent : undefined;
        return { toolName: "Write", input: { file_path: at(file), ...(content !== undefined ? { content } : {}) }, ...(content !== undefined ? { diff: { before: "", after: content } } : {}) };
    }
    if (/^(edit_file|replace_file_content|multi_replace_file_content|sed_file|notebook_edit)$/.test(name)) {
        const file = path("Path", "TargetFile", "AbsolutePath", "FilePath", "NotebookPath");
        if (!file) return undefined;
        if (inGate(at(file))) return gateRefusal;
        const before = str(args.Target) ?? str(args.TargetContent);
        const after = typeof args.Replacement === "string" ? args.Replacement : typeof args.ReplacementContent === "string" ? args.ReplacementContent : undefined;
        return {
            toolName: "Edit",
            input: { file_path: at(file), ...(before !== undefined && after !== undefined ? { old_string: before, new_string: after } : {}) },
            ...(before !== undefined && after !== undefined ? { diff: { before, after } } : {}),
        };
    }
    if (/^(read_file|view_file|view_file_outline|view_code_item)$/.test(name)) {
        const file = path("Path", "AbsolutePath", "File", "FilePath");
        return file ? { toolName: "Read", input: { file_path: at(file) } } : undefined;
    }
    if (name === "list_dir") {
        const dir = path("DirectoryPath", "Path", "Directory") ?? cwd;
        return { toolName: "LS", input: { path: at(dir) } };
    }
    if (name === "grep_search" || name === "codebase_search") {
        const pattern = path("Query", "Pattern", "query", "pattern");
        if (!pattern) return undefined;
        const dir = path("SearchPath", "SearchDirectory", "Path", "DirectoryPath");
        return { toolName: "Grep", input: { pattern, ...(dir ? { path: at(dir) } : {}) } };
    }
    if (name === "find_by_name") {
        const pattern = path("Pattern", "Query", "pattern");
        if (!pattern) return undefined;
        const dir = path("SearchDirectory", "SearchPath", "Path", "DirectoryPath");
        return { toolName: "Glob", input: { pattern, ...(dir ? { path: at(dir) } : {}) } };
    }
    if (name === "search_web") {
        const query = path("query", "Query");
        return query ? { toolName: "WebSearch", input: { query } } : undefined;
    }
    if (name === "read_url_content") {
        const url = path("Url", "url", "URL");
        return url ? { toolName: "WebFetch", input: { url } } : undefined;
    }
    if (name === "call_mcp_tool") {
        const server = path("ServerName", "server", "Server");
        const tool = path("ToolName", "tool", "Tool");
        if (!server || !tool) return undefined;
        const input = args.Arguments && typeof args.Arguments === "object" ? args.Arguments : typeof args.Arguments === "string" ? safeJson(args.Arguments) : {};
        return { toolName: `mcp__${server}__${tool}`, input };
    }
    if (FREE.has(name)) return { toolName: "Antigravity", input: { tool: name, ...args }, title: `Antigravity: ${name}`, free: true };
    if (/subagent/.test(name)) return { toolName: "Task", input: { description: str(args.TaskDescription) ?? str(args.Task) ?? str(args.Description) ?? name, ...args } };
    return undefined;
}

function safeJson(s: string): Record<string, unknown> {
    try {
        const v = JSON.parse(s);
        return v && typeof v === "object" && !Array.isArray(v) ? v : { value: v };
    } catch {
        return { value: s };
    }
}
