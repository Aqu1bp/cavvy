// ACP probes for Grok Build's client hooks: can an ACP client register a PreToolUse gate and decide every tool
// call itself, whatever Grok's own permission mode says? One case per run:
//   bun scripts/probes/acp-grok-hooks.ts <case>
// Each case writes test/fixtures/protocol/grok-1.0.70-hook-<case>.jsonl.
//
// Safety, on top of what acp-lib.ts does (sandbox-exec, perl alarm, reject unknown permission requests):
//   - HOME is an empty temp folder whose .claude/settings.json is the one a case names; GROK_HOME stays ~/.grok
//     so the sign-in works.
//   - The gate allows only these calls, inside the temp workspace: a write of note.txt, the shell commands
//     `echo hi > out.txt` and `ls`, and a read of README.txt. It denies every other call.
//   - Prompts ask only for those. Never always-approve or yolo.
//
// What Grok 1.0.70 did when we ran these (see the fixtures):
//   - It reads the registration from session/new (and session/resume) `_meta["x.ai/hooks"]`:
//     { PreToolUse: [{ matcher, hookCallbackIds: [id], timeout }] }. Not from initialize. Nothing persists it across
//     processes: a resumed session without it ran an auto-mode call unasked.
//   - Before each tool call (after its pending tool_call update) it sends the request `_x.ai/hooks/run` with
//     { hookCallbackId, hookEventName: "pre_tool_use", sessionId, cwd, permissionMode, toolName, toolUseId (= the
//     toolCallId), toolInput, toolInputTruncated, ... }. Agent request ids start at 0.
//   - `{}` lets the call go on through Grok's own permission flow; `{decision:"deny", reason}` fails it and the
//     model sees "Hook denied: <reason>". `{decision:"allow"}` is logged as an unknown decision (and fails open).
//   - The group's `timeout` (seconds) is honoured; `timeoutS` was ignored (30 s default). On timeout it fails open
//     and a late reply is ignored.
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { type Ctx, type Profile, ctx, start, turn, seed, allow, runs, writeTo } from "./acp-cases";
import { Acp, HOME, trackSession } from "./acp-lib";
import { scrub, scrubAlso, sleep, trim } from "./lib";

/** HOME for one process, with its own Grok log file (RUST_LOG at debug for the hooks crate) under it. */
function isolatedHome(claudeSettings?: unknown) {
    const dir = realpathSync(mkdtempSync(join("/tmp", "acp-home-")));
    scrubAlso(dir, "/tmp/acp-home");
    if (claudeSettings) {
        mkdirSync(join(dir, ".claude"));
        writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify(claudeSettings));
    }
    return { HOME: dir, GROK_HOME: join(HOME, ".grok"), GROK_LOG_FILE: join(dir, "grok.log"), RUST_LOG: "warn,xai_grok_hooks=debug" };
}

/** The settings the user's real ~/.claude/settings.json is like: auto mode plus an allow rule for echo. */
const AUTO_SETTINGS = { permissions: { defaultMode: "auto", allow: ["Bash(echo *)"] } };

const profile: Profile = {
    cli: "grok",
    version: "1.0.70",
    args: () => ["agent", "--no-leader", "stdio"],
    // None for `compact`, which runs nothing.
    env: process.argv[2] === "compact" ? {} : isolatedHome(AUTO_SETTINGS),
    prep: async (acp, sessionId) => acp.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: "low" }),
};

/** ctx() plus two log tweaks: subagent session ids (child_session_id) get placeholders like other sessions, and
 *  stderr lines that are only Grok's INFO/DEBUG tracing (RUST_LOG is raised for the hooks crate) are left out. */
function hctx(name: string) {
    const c = ctx(profile, name, { maxString: 3000, maxArray: 40 });
    const add = c.log.add.bind(c.log);
    c.log.add = (dir, frame) => {
        const s = typeof frame === "string" ? frame : JSON.stringify(frame);
        for (const m of s.matchAll(/"(?:child_session_id|parent_session_id|childSessionId|parentSessionId)"\s*:\s*"([^"]+)"/g)) trackSession(m[1]);
        if (dir === "err" && typeof frame === "string") {
            const kept = frame.split("\n").filter((l) => l.trim() && !/^\S+Z\s+(INFO|DEBUG|TRACE)\b/.test(l.replace(/\x1b\[[0-9;]*m/g, "")));
            if (!kept.length) return;
            frame = kept.join("\n");
        }
        add(dir, frame);
    };
    return c;
}

// ---------- the gate ----------

type HookCall = { at: number; method: string; params: any; reply: any; ms?: number; verdict: string };
type GateMode = { kind: "policy" } | { kind: "deny-all" } | { kind: "silent" } | { kind: "allow-all-safe" };

const SAFE_COMMANDS = ["echo hi > out.txt", "ls"];
const inside = (p: string, ws: string) => {
    if (typeof p !== "string" || /[*?~]|(^|\/)\.\.(\/|$)/.test(p)) return false;
    const n = resolve(ws, p);
    const alt = (x: string) => (x.startsWith("/private/") ? x.slice("/private".length) : `/private${x}`);
    return [n, alt(n)].some((x) => x === ws || x.startsWith(ws + "/"));
};

/** Pulls tool name and input out of whatever shape the hook request has. */
function toolOf(params: any): { name?: string; input: any } {
    const ev = params?.input ?? params?.event ?? params?.payload ?? params;
    const name = ev?.toolName ?? ev?.tool_name ?? params?.toolName;
    const input = ev?.toolInput ?? ev?.tool_input ?? params?.toolInput ?? {};
    return { name, input };
}

/** Exactly the four calls the probes ask for, inside the workspace; everything else is denied. */
function safeCall(name: string | undefined, input: any, ws: string): string | undefined {
    const path = input?.file_path ?? input?.path ?? input?.target_file ?? input?.filePath;
    const cmd = typeof input?.command === "string" ? input.command.trim() : undefined;
    const plainShell = Object.keys(input ?? {}).every((k) => ["command", "description", "cwd", "timeout", "timeout_ms"].includes(k));
    if (name === "run_terminal_command" && cmd && SAFE_COMMANDS.includes(cmd) && plainShell && (input.cwd === undefined || inside(input.cwd, ws))) return `command ${cmd}`;
    if ((name === "write" || name === "search_replace" || name === "write_file" || name === "create_file") && typeof path === "string" && inside(path, ws) && resolve(ws, path).endsWith("/note.txt")) return "write note.txt";
    if (name === "read_file" && typeof path === "string" && inside(path, ws) && resolve(ws, path).endsWith("/README.txt")) return "read README.txt";
    return undefined;
}

/** Answers Grok's hook requests (and keeps acp-lib's handling of everything else). */
type GateOpts = { mode: GateMode; allowReply?: any; denyReply?: (why: string) => any; delayMs?: number; extraSafe?: (name: string | undefined, input: any) => string | undefined };
function installGate(c: Ctx, acp: Acp, ws: string, opts: GateOpts) {
    const calls: HookCall[] = [];
    const answered: Set<any> = (acp as any).answered;
    const orig = (acp as any).serveRequests.bind(acp);
    const state = { opts };
    (acp as any).serveRequests = () => {
        for (const f of acp.p.frames) {
            if (!f.method || f.id === undefined || answered.has(f) || !/hooks/.test(f.method)) continue;
            answered.add(f);
            const o = state.opts;
            const { name, input } = toolOf(f.params);
            const ok = safeCall(name, input, ws) ?? o.extraSafe?.(name, input);
            const allowReply = () => (typeof o.allowReply === "function" ? o.allowReply() : (o.allowReply ?? {}));
            const denyReply = o.denyReply ?? ((why: string) => ({ decision: "deny", reason: why }));
            let reply: any;
            let verdict: string;
            if (o.mode.kind === "silent") ((reply = undefined), (verdict = "no answer"));
            else if (o.mode.kind === "deny-all") ((reply = denyReply(`Cavvy probe: ${name} is denied by the client gate.`)), (verdict = "deny (deny-all)"));
            else if (ok) ((reply = allowReply()), (verdict = `allow (${ok})`));
            else ((reply = denyReply(`Cavvy probe: ${name} is not one of the calls this test allows.`)), (verdict = "deny (not a safe call)"));
            const call: HookCall = { at: Date.now(), method: f.method, params: f.params, reply, verdict };
            calls.push(call);
            c.log.note(`hook request ${f.method} for ${name} -> ${verdict}`);
            if (reply === undefined) continue;
            const idx = acp.p.frames.indexOf(f);
            // Latency: from our reply to the next frame Grok sends for a tool call.
            const send = () => {
                const t0 = Date.now();
                acp.send({ jsonrpc: "2.0", id: f.id, result: reply });
                void acp.p.waitFor((x) => /tool_call/.test(x.params?.update?.sessionUpdate ?? "") || x.method === "session/request_permission", 30_000, idx + 1).then((x) => {
                    call.ms = Date.now() - t0;
                    c.log.note(`first tool frame ${call.ms} ms after the hook reply: ${x?.method === "session/request_permission" ? "request_permission" : `${x?.params?.update?.sessionUpdate}/${x?.params?.update?.status}`}`);
                });
            };
            if (o.delayMs) setTimeout(send, o.delayMs);
            else send();
        }
        orig();
    };
    return { calls, set: (o: GateOpts) => (state.opts = o) };
}

// ---------- helpers ----------

/** Grok's own log lines (GROK_LOG_FILE) that mention hooks; warnings about a registration land here. */
function grokLog(acp: Acp, re = /hook/i) {
    const file = acp.opts.env?.GROK_LOG_FILE;
    if (!file || !existsSync(file)) return [];
    return readFileSync(file, "utf8")
        .split("\n")
        .filter((l) => re.test(l) && !/slash\.advertise|available_commands/.test(l))
        .map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").slice(0, 600))
        .slice(-40);
}

const PRE = (o: { matcher?: string; ids?: string[]; timeoutS?: number } = {}) => ({
    PreToolUse: [{ ...(o.matcher !== undefined ? { matcher: o.matcher } : {}), hookCallbackIds: o.ids ?? ["cavvy-gate"], ...(o.timeoutS ? { timeoutS: o.timeoutS } : {}) }],
});

async function initWith(acp: Acp, initMeta?: Record<string, unknown>, capsMeta?: Record<string, unknown>) {
    return acp.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, ...(capsMeta ? { _meta: capsMeta } : {}) },
        clientInfo: { name: "cavvy-probe", title: "Cavvy probe", version: "0.0.0" },
        ...(initMeta ? { _meta: initMeta } : {}),
    });
}

function files(ws: string, names: string[]) {
    return Object.fromEntries(names.map((n) => [n, existsSync(join(ws, n))]));
}

/** One prompt with the gate and the permission rules; notes hooks, permission requests, files and latency. */
async function gatedTurn(c: Ctx, acp: Acp, ws: string, sessionId: string, gate: ReturnType<typeof installGate>, text: string, label: string, watch: string[] = []) {
    const hooksBefore = gate.calls.length;
    const permsBefore = acp.permissionLog.length;
    const t = await turn(c, acp, sessionId, text, label, 240_000);
    const hooks = gate.calls.slice(hooksBefore).map((h) => {
        const { name, input } = toolOf(h.params);
        return { tool: name, input, verdict: h.verdict, paramKeys: Object.keys(h.params ?? {}) };
    });
    const perms = acp.permissionLog.slice(permsBefore).map((p) => ({ answer: p.answer, rule: p.rule, note: p.note, command: p.req.command, paths: p.req.paths, title: p.req.params?.toolCall?.title }));
    // Latency: from the hook request to the tool_call frame that follows it.
    c.log.note(`${label}: hook requests ${hooks.length}, permission requests ${perms.length}, files ${JSON.stringify(files(ws, watch))}`, { hooks, perms });
    return { ...t, hooks, perms };
}

/** Starts Grok with the case's settings, registers the gate the way `how` says, opens a session. */
async function openGated(c: Ctx, ws: string, o: { settings?: unknown; hooks?: any; place?: "session-meta" | "init-meta" | "caps-meta"; newMeta?: Record<string, unknown>; gate: GateOpts; timeoutSec?: number }) {
    const acp = start(c, { env: isolatedHome(o.settings ?? AUTO_SETTINGS), timeoutSec: o.timeoutSec ?? 400, safeCommands: SAFE_COMMANDS }, ws);
    const gate = installGate(c, acp, ws, o.gate);
    const hooks = o.hooks ?? PRE();
    const place = o.place ?? "session-meta";
    const init = await initWith(acp, place === "init-meta" ? { "x.ai/hooks": hooks } : undefined, place === "caps-meta" ? { "x.ai/hooks": hooks } : undefined);
    c.log.note(`initialize -> ${init.error ? JSON.stringify(init.error) : "ok"}`);
    const ns = await acp.newSession({ _meta: { ...(place === "session-meta" ? { "x.ai/hooks": hooks } : {}), ...o.newMeta } });
    const sessionId: string = ns.result?.sessionId;
    c.log.note(`session/new -> ${ns.error ? JSON.stringify(ns.error) : "ok"}; modes ${JSON.stringify(ns.result?.modes?.currentModeId)}`);
    await profile.prep(acp, sessionId);
    acp.rules = [allow("write note.txt", writeTo("note.txt"), false), allow("echo hi > out.txt", runs("echo hi > out.txt"), false), allow("ls", runs("ls"), false)];
    return { acp, gate, sessionId };
}

const BOTH = "Do these two things, in order, and nothing else: 1) create a file named note.txt in the current directory containing exactly: hi, using your file write tool (not the shell); 2) run exactly this shell command: echo hi > out.txt . If either is refused, do not retry it; say so and quote the reason you were given.";
const WRITE = "Create a file named note.txt in the current directory containing exactly: hi. Use your file write tool, not the shell. If it is refused, do not retry; just say so and quote the reason. Do nothing else.";
const ECHO = "Run exactly this shell command and nothing else: `echo hi > out.txt`. If it is refused, do not retry; just say so and quote the reason. Do nothing else.";
const LS = "Run exactly this shell command and nothing else: `ls`. Then read the file README.txt with your file read tool. Reply with the README's text. If anything is refused, do not retry; just say so.";

// ---------- cases ----------

const cases: Record<string, () => Promise<void>> = {
    // No prompt. Where does Grok read a client's hook registration? Each placement gets a bogus event name next
    // to PreToolUse; Grok's log says "unknown event" only where it parsed the object. Also asks hooks/list.
    register: async () => {
        const c = ctx(profile, "hook-register", { maxString: 3000, maxArray: 20 });
        const hooks = { ...PRE({ matcher: "*" }), BogusEvent: [{ hookCallbackIds: ["x"] }], Stop: "not-an-array" };
        for (const place of ["caps-meta", "init-meta", "session-meta"] as const) {
            const acp = start(c, { env: isolatedHome(AUTO_SETTINGS), timeoutSec: 60 }, c.ws);
            const init = await initWith(acp, place === "init-meta" ? { "x.ai/hooks": hooks } : undefined, place === "caps-meta" ? { "x.ai/hooks": hooks } : undefined);
            const ns = await acp.newSession(place === "session-meta" ? { _meta: { "x.ai/hooks": hooks } } : {});
            const sessionId = ns.result?.sessionId;
            c.log.note(`${place}: initialize ${init.error ? "error" : "ok"}, session/new ${ns.error ? JSON.stringify(ns.error) : "ok"}`);
            for (const m of ["_x.ai/hooks/list", "x.ai/hooks/list"]) {
                const r = await acp.request(m, { sessionId }, 10_000);
                c.log.note(`${place}: ${m} -> ${r.timeout ? "timeout" : JSON.stringify(r.error ?? r.result).slice(0, 2500)}`);
            }
            await sleep(1500);
            c.log.note(`${place}: grok log lines about hooks`, { lines: grokLog(acp) });
            await acp.stop();
        }
    },
};

/** Ends a case: Grok's hook log lines, then the process; the recording compacted (compactLines). */
async function finish(c: Ctx, acp: Acp) {
    await sleep(500);
    c.log.note("grok log lines about hooks", { lines: grokLog(acp, /xai_grok_hooks::client|hooks\/run|client hook|pre_tool_use|PreToolUse/i) });
    await acp.stop();
    compactFile(c.log.file);
}

Object.assign(cases, {
    // Q1 + Q2 (deny): auto settings with an echo allow rule; the gate denies every call. 1 prompt.
    deny: async () => {
        const c = hctx("hook-deny");
        const { acp, gate, sessionId } = await openGated(c, c.ws, { gate: { mode: { kind: "deny-all" } } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, BOTH, "deny-all: write note.txt + echo hi > out.txt", ["note.txt", "out.txt"]);
        c.st.set("hook-deny", { sessionId, ws: c.ws });
        await finish(c, acp);
    },
});

const DEFAULT_SETTINGS = { permissions: { defaultMode: "default" } };
/** First allowed call gets `{decision:"allow"}`, the next `{}`, and so on: Grok's log says if either is not understood. */
function alternatingAllow() {
    let n = 0;
    return { allowReply: () => (n++ % 2 === 0 ? { decision: "allow" } : {}) };
}

Object.assign(cases, {
    // Q1 + Q2 (allow, auto settings): the gate allows exactly the two asked calls. Is there also a permission request? 1 prompt.
    "allow-auto": async () => {
        const c = hctx("hook-allow-auto");
        const { acp, gate, sessionId } = await openGated(c, c.ws, { hooks: PRE({ matcher: "*" }), gate: { mode: { kind: "policy" }, ...alternatingAllow() } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, BOTH, "auto settings, gate allows: write note.txt + echo hi > out.txt", ["note.txt", "out.txt"]);
        await finish(c, acp);
    },
    // Q2 (double ask): default-mode settings, the gate allows. Does Grok then also send session/request_permission? 1 prompt.
    "allow-default": async () => {
        const c = hctx("hook-allow-default");
        const { acp, gate, sessionId } = await openGated(c, c.ws, { settings: DEFAULT_SETTINGS, hooks: PRE({ matcher: "*" }), gate: { mode: { kind: "policy" } } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, BOTH, "default settings, gate allows: write note.txt + echo hi > out.txt", ["note.txt", "out.txt"]);
        await finish(c, acp);
    },
    // Q3: read-only calls (ls, read_file), matcher ".*". 1 prompt.
    readonly: async () => {
        const c = hctx("hook-readonly");
        seed(c.ws, "README.txt", "hello from the readme");
        const { acp, gate, sessionId } = await openGated(c, c.ws, { hooks: PRE({ matcher: ".*" }), gate: { mode: { kind: "policy" } } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, LS, "auto settings, matcher .*: ls + read README.txt");
        await finish(c, acp);
    },
    // Q4: the gate never answers; timeoutS 3. Does the echo run (fail open) or not (fail closed)? 1 prompt.
    // Run 1 showed `timeoutS` ignored (Grok waited its 30 s default, then failed open).
    timeout: async () => {
        const c = hctx("hook-timeout");
        const { acp, gate, sessionId } = await openGated(c, c.ws, { hooks: PRE({ matcher: "*", timeoutS: 3 }), gate: { mode: { kind: "silent" } } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, ECHO, "auto settings, gate silent, timeoutS 3: echo hi > out.txt", ["out.txt"]);
        await finish(c, acp);
    },
    // Q4, second try: the group says `timeout: 3` and the gate denies after 8 s. The echo runs only if Grok gave up
    // at 3 s (and failed open); with the field ignored, the late deny lands inside the 30 s default. 1 prompt.
    "timeout-field": async () => {
        const c = hctx("hook-timeout-field");
        const hooks = { PreToolUse: [{ matcher: "*", hookCallbackIds: ["cavvy-gate"], timeout: 3 }] };
        const { acp, gate, sessionId } = await openGated(c, c.ws, { hooks, gate: { mode: { kind: "deny-all" }, delayMs: 8000 } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, ECHO, "auto settings, timeout 3, gate denies after 8 s: echo hi > out.txt", ["out.txt"]);
        await finish(c, acp);
    },
    // Q5: a subagent's tool calls. The gate allows spawn_subagent only when its input names note.txt. 1 prompt.
    subagent: async () => {
        const c = hctx("hook-subagent");
        const extraSafe = (name: string | undefined, input: any) => (/subagent|^task$/i.test(name ?? "") && JSON.stringify(input).includes("note.txt") && JSON.stringify(input).length < 3000 ? "spawn a subagent for note.txt" : undefined);
        const { acp, gate, sessionId } = await openGated(c, c.ws, { hooks: PRE({ matcher: "*" }), gate: { mode: { kind: "policy" }, extraSafe } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, "Use your spawn_subagent tool to start one subagent whose only task is: create a file named note.txt in the current directory containing exactly: hi, using the file write tool. Do nothing else yourself. If anything is refused, do not retry; just say so.", "subagent writes note.txt", ["note.txt"]);
        await finish(c, acp);
    },
    // Q5: a background shell command. The gate denies any shell call with more than command/description/cwd/timeout. 1 prompt.
    background: async () => {
        const c = hctx("hook-background");
        const { acp, gate, sessionId } = await openGated(c, c.ws, { hooks: PRE({ matcher: "*" }), gate: { mode: { kind: "policy" } } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, "Run exactly this shell command as a background task (use your tool's background option), and nothing else: echo hi > out.txt . If it is refused, do not retry; just say so and quote the reason.", "background echo", ["out.txt"]);
        await finish(c, acp);
    },
    // Q6 + Q7 (mode switch): registered at session/new in auto settings, then set_mode plan. Does the gate fire for a write? 1 prompt.
    plan: async () => {
        const c = hctx("hook-plan");
        const { acp, gate, sessionId } = await openGated(c, c.ws, { hooks: PRE({ matcher: "*" }), gate: { mode: { kind: "policy" } } });
        const r = await acp.request("session/set_mode", { sessionId, modeId: "plan" });
        c.log.note(`set_mode plan -> ${JSON.stringify(r.error ?? r.result)}`);
        await gatedTurn(c, acp, c.ws, sessionId, gate, WRITE, "plan mode, gate allows note.txt: write note.txt", ["note.txt"]);
        await finish(c, acp);
    },
    // Q6: _meta.autoMode true on session/new and a deny-all gate. Does the gate fire, and does its deny win? 1 prompt.
    automode: async () => {
        const c = hctx("hook-automode");
        const { acp, gate, sessionId } = await openGated(c, c.ws, { hooks: PRE({ matcher: "*" }), newMeta: { autoMode: true }, gate: { mode: { kind: "deny-all" } } });
        await gatedTurn(c, acp, c.ws, sessionId, gate, ECHO, "_meta.autoMode, deny-all: echo hi > out.txt", ["out.txt"]);
        await finish(c, acp);
    },
    // Q7: the "deny" case's session in a new process via session/resume. argv[3] "meta" re-registers on resume. 1 prompt.
    resume: async () => {
        const withMeta = process.argv[3] === "meta";
        const c0 = hctx(withMeta ? "hook-resume-meta" : "hook-resume");
        const saved = c0.st.get("hook-deny") as { sessionId: string; ws: string };
        if (!saved) throw new Error("run the deny case first");
        scrubAlso(saved.ws, "/tmp/acp-grok");
        scrubAlso(saved.ws.replace(/^\/private/, ""), "/tmp/acp-grok");
        scrubAlso(encodeURIComponent(saved.ws), encodeURIComponent("/tmp/acp-grok"));
        trackSession(saved.sessionId);
        const c = { ...c0, ws: saved.ws };
        const acp = start(c, { env: isolatedHome(AUTO_SETTINGS), timeoutSec: 300, safeCommands: SAFE_COMMANDS }, saved.ws);
        const gate = installGate(c, acp, saved.ws, { mode: { kind: "deny-all" } });
        await initWith(acp);
        const r = await acp.request("session/resume", { sessionId: saved.sessionId, cwd: saved.ws, mcpServers: [], ...(withMeta ? { _meta: { "x.ai/hooks": PRE({ matcher: "*" }) } } : {}) });
        c.log.note(`session/resume${withMeta ? " with _meta x.ai/hooks" : " (no hooks)"} -> ${r.error ? JSON.stringify(r.error) : "ok"}`);
        await profile.prep(acp, saved.sessionId);
        await gatedTurn(c, acp, saved.ws, saved.sessionId, gate, ECHO, `resumed${withMeta ? " with hooks" : " without hooks"}, deny-all: echo hi > out.txt`, ["out.txt"]);
        await finish(c, acp);
    },
});

// ---------- compact ----------

/** Grok's notifications a client reads (agents.ts), or these probes are about: kept. */
const KEEP_XAI = new Set(["_x.ai/queue/changed", "_x.ai/session/prompt_complete", "_x.ai/session_notification:subagent_spawned", "_x.ai/session_notification:subagent_finished", "_x.ai/session_notification:hook_annotation", "_x.ai/session_notification:turn_completed", "_x.ai/session_notification:image_dropped", "_x.ai/session_notification:response_completed", "_x.ai/session/interjection"]);
/** Session updates' `_meta`: only what a client reads (the prompt it belongs to). */
const KEEP_META = ["promptId"];
type Line = { t: number; dir: string; frame: any };

/**
 * Keeps a recording small without dropping what the replays use (test/helpers/acp-replay.ts takes "in" and "out"
 * frames in order): Grok's command list, model and settings blobs and update _meta trimmed, runs of message and
 * thought chunks merged into one, notes and stderr cut short.
 */
/** Config options without their descriptions (ids, names and values stay). */
const bareOptions = (opts: any[]) => opts.map((o) => ({ ...o, options: Array.isArray(o?.options) ? o.options.map((x: any) => (x && typeof x === "object" ? { value: x.value, name: x.name } : x)) : o?.options }));
/** A usage blob without its per-model copy. */
const noModelUsage = (u: any) => (u && typeof u === "object" ? Object.fromEntries(Object.entries(u).filter(([k]) => k !== "modelUsage")) : u);

export function compactLines(lines: Line[]): Line[] {
    const out: Line[] = [];
    let toolsListed = false;
    for (const l of lines) {
        const f = l.frame;
        if (l.dir !== "in" && l.dir !== "out") {
            out.push({ ...l, frame: trim(f, 0, { maxString: 200, maxArray: 4 }) });
            continue;
        }
        if (!f || typeof f !== "object") {
            out.push(l);
            continue;
        }
        const p = f.params;
        if (f.method === "session/update" && p?.update) {
            const u = { ...p.update };
            if (Array.isArray(u.configOptions)) u.configOptions = bareOptions(u.configOptions);
            // A tool's output as it says it: what the client reads stays (its text, a diff, an error), cut short.
            if (u.rawOutput !== undefined) u.rawOutput = trim(u.rawOutput, 0, { maxString: 100, maxArray: 2 });
            if (Array.isArray(u.content)) u.content = u.content.map((c: any) => (c && typeof c === "object" ? Object.fromEntries(Object.entries(c).filter(([k]) => k !== "_meta")) : c));
            if (Array.isArray(u.availableCommands)) {
                u.availableCommands = trim(u.availableCommands, 0, { maxArray: 1, maxString: 60 });
                // Its tool names, once.
                if (toolsListed) delete u._meta;
                toolsListed ||= Boolean(u._meta?.tools);
            }
            const meta = p._meta && typeof p._meta === "object" ? Object.fromEntries(KEEP_META.filter((k) => k in p._meta).map((k) => [k, p._meta[k]])) : undefined;
            const frame = { ...f, params: { sessionId: p.sessionId, update: u, ...(meta && Object.keys(meta).length ? { _meta: meta } : {}) } };
            // A chunk right after one of the same kind, message and prompt: one chunk.
            const prev = out[out.length - 1]?.frame;
            const kind = u.sessionUpdate;
            if ((kind === "agent_message_chunk" || kind === "agent_thought_chunk") && u.content?.type === "text" && prev?.method === "session/update" && prev.params.update.sessionUpdate === kind && prev.params.sessionId === p.sessionId && prev.params.update.messageId === u.messageId && prev.params._meta?.promptId === frame.params._meta?.promptId && out[out.length - 1]!.dir === l.dir) {
                prev.params.update = { ...prev.params.update, content: { ...prev.params.update.content, text: prev.params.update.content.text + u.content.text } };
                continue;
            }
            out.push({ ...l, frame });
            continue;
        }
        // Its own notifications for its UI, which no client needs: a run of them becomes a note that counts them.
        if (typeof f.method === "string" && f.method.startsWith("_x.ai/") && f.id === undefined && !KEEP_XAI.has(f.method) && !KEEP_XAI.has(`${f.method}:${p?.update?.sessionUpdate}`)) {
            const what = p?.update?.sessionUpdate ? `${f.method}:${p.update.sessionUpdate}` : f.method;
            const last = out[out.length - 1];
            if (last?.dir === "note" && last.frame?.dropped) last.frame.dropped[what] = (last.frame.dropped[what] ?? 0) + 1;
            else out.push({ t: l.t, dir: "note", frame: { text: "Grok's own UI notifications, left out of this recording (compactLines)", dropped: { [what]: 1 } } });
            continue;
        }
        if (p?.update?.sessionUpdate === "turn_completed") {
            out.push({ ...l, frame: { ...f, params: { ...p, update: { ...p.update, usage: noModelUsage(p.update.usage) } } } });
            continue;
        }
        if (f.result && typeof f.result === "object") {
            const r = { ...f.result };
            if (Array.isArray(r.configOptions)) r.configOptions = bareOptions(r.configOptions);
            if (r._meta?.usage) r._meta = { ...r._meta, usage: noModelUsage(r._meta.usage) };
            if (r.models?.availableModels) r.models = { ...r.models, availableModels: r.models.availableModels.map((m: any) => ({ modelId: m.modelId, name: m.name, ...(m._meta?.totalContextTokens ? { _meta: { totalContextTokens: m._meta.totalContextTokens } } : {}) })) };
            if (r._meta) r._meta = trim(Object.fromEntries(Object.entries(r._meta).filter(([k]) => k !== "modelState" && k !== "availableCommands")), 0, { maxString: 120, maxArray: 3 });
            if (r.agentCapabilities?._meta) r.agentCapabilities = { ...r.agentCapabilities, _meta: trim(r.agentCapabilities._meta, 0, { maxString: 120, maxArray: 4 }) };
            out.push({ ...l, frame: { ...f, result: r } });
            continue;
        }
        out.push(l);
    }
    return out;
}

/** A recording rewritten with compactLines, scrubbed again. */
function compactFile(file: string) {
    const lines: Line[] = readFileSync(file, "utf8").trim().split("\n").map((x) => JSON.parse(x));
    const kept = compactLines(lines).map((l) => JSON.stringify(scrub(l)));
    writeFileSync(file, kept.join("\n") + "\n");
    console.error(`${file}: ${lines.length} -> ${kept.length} lines, ${kept.join("\n").length} bytes`);
}

/** `compact FILE...`: recordings made before compactLines, compacted. */
cases.compact = async () => {
    const files = process.argv.slice(3);
    if (!files.length) throw new Error("usage: compact <fixture.jsonl>...");
    for (const file of files) compactFile(file);
};

const name = process.argv[2];
if (!name || !cases[name]) {
    console.error(`usage: bun scripts/probes/acp-grok-hooks.ts <${Object.keys(cases).join("|")}>`);
    process.exit(2);
}
await cases[name]!();
process.exit(0);
