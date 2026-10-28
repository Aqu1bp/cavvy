// Probes for Antigravity's CLI (`agy`) in headless stream-json mode, with a PreToolUse gate Cavvy answers. One case per
// run:
//   bun scripts/probes/agy.ts <case>
// Each case writes test/fixtures/protocol/agy-<version>-<case>.jsonl.
//
// Safety:
//   - The workspace is an empty temp folder, and agy runs under `sandbox-exec` with writes denied outside it, its own
//     state folder (~/.gemini), the temp folders and /dev, and a hard `perl -e alarm` timeout.
//   - HOME stays the real one: agy keeps its sign-in under ~/.gemini, and an empty HOME asks to sign in.
//   - Every tool call goes through the probe's gate (a workspace hooks.json in a folder of the probe's own, added with
//     --add-dir), which allows only reads, the exact commands a case asks for, and writes inside the workspace. It
//     denies everything else. Never --dangerously-skip-permissions.
//
// What agy 1.4.9 did (see the fixtures):
//   - stdin takes {"event":"user","message":{"role":"user","content":...}} lines; stdout is {"event":"init"|"step_update"|
//     "result"} lines. Headless runs can't ask: a call that needs approval is denied, unless a PreToolUse hook says
//     auto_approve.
//   - Workspace hooks (.agents/hooks.json) load from every workspace folder, --add-dir ones too, trusted or not. The
//     workspaces are sorted by path, and the model takes the first as its current folder.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { homedir } from "node:os";
import { join } from "node:path";
import { JsonProc, Log, fixture, scrubAlso, sleep } from "./lib";
import { sandboxProfile } from "./acp-lib";

const CASE = process.argv[2] ?? "basic";
const MODEL = process.env.AGY_MODEL ?? "gemini-3.8-flash-low";
const VERSION = (Bun.spawnSync(["agy", "--version"]).stdout.toString().trim().split(/\s+/).pop() ?? "x").replace(/[^\w.]/g, "");
const log = new Log(fixture(`agy-${VERSION}-${CASE}${process.env.CANCEL_EVENT ? `-${process.env.CANCEL_EVENT}` : ""}`), { maxString: 3000, maxArray: 12 });
// Conversation ids get placeholders the first time any frame names one, before it's written.
const convos = new Set<string>();
const add = log.add.bind(log);
log.add = (dir, frame) => {
    for (const m of JSON.stringify(frame).matchAll(/conversation_?[iI]d\\?"\s*:\s*\\?"([0-9a-f-]{36})/g))
        if (!convos.has(m[1]!)) (convos.add(m[1]!), scrubAlso(m[1]!, `<conversation-${convos.size}>`));
    add(dir, frame);
};

/** A temp folder by its real path, scrubbed to a stable name. Named so the workspace sorts before the gate folder. */
function temp(label: string) {
    const dir = realpathSync(mkdtempSync(join("/tmp", `agy-${label}-`)));
    scrubAlso(dir, `/tmp/agy-${label}`);
    scrubAlso(dir.replace(/^\/private/, ""), `/tmp/agy-${label}`);
    return dir;
}
const ws = temp("ws");
const gateDir = temp(CASE === "order" ? "aa-gate" : "zz-gate");
scrubAlso(join(homedir(), ".gemini"), "~/.gemini");

// --- The gate: an HTTP server the hook script posts each hook's input to ---------------------------------------
type Decide = (event: string, input: any) => Promise<unknown> | unknown;
let decide: Decide = () => ({ decision: "deny", reason: "No case decides this." });
const token = crypto.randomUUID();
const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
        if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("no", { status: 403 });
        const event = req.headers.get("x-event") ?? "?";
        const input = await req.json();
        log.add("note", { hook: event, input });
        const out = await decide(event, input);
        log.add("note", { hookAnswer: event, out });
        return Response.json(out);
    },
});
const script = join(gateDir, "gate.sh");
writeFileSync(
    script,
    `#!/bin/sh
[ -n "$PROBE_GATE" ] || { echo '{"decision":"allow"}'; exit 0; }
curl -sS --fail --max-time 3600 -H "Authorization: Bearer $PROBE_TOKEN" -H "X-Event: $1" -H "Content-Type: application/json" --data-binary @- "$PROBE_GATE" || { [ "$1" = pre ] && echo '{"decision":"deny","reason":"The gate did not answer."}' || echo '{}'; }
`,
    { mode: 0o755 },
);
const hookTimeout = Number(process.env.HOOK_TIMEOUT ?? 600);
mkdirSync(join(gateDir, ".agents"));
writeFileSync(
    join(gateDir, ".agents/hooks.json"),
    JSON.stringify({
        "cavvy-gate": {
            SessionStart: [{ type: "command", command: `${script} session`, timeout: 30 }],
            PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: `${script} pre`, timeout: hookTimeout }] }],
            Stop: [{ type: "command", command: `${script} stop`, timeout: 30 }],
        },
    }),
);

/** The default gate: reads go; writes inside the workspace go; the listed commands go; anything else is denied. */
function safe(input: any, commands: string[]): boolean {
    const { name, args = {} } = input?.toolCall ?? {};
    const inWs = (p: unknown) => typeof p === "string" && (p.startsWith(ws + "/") || p.startsWith(ws.replace(/^\/private/, "") + "/")) && !p.includes("..");
    // Reads, listings and searches (its hook names differ from init's tool list: read_file, not view_file).
    if (/^(read_file|view_file|list_dir|find_by_name|grep_search|codebase_search)$/.test(name)) return true;
    if (name === "read_url_content") return String(args.Url ?? args.url ?? "") === "https://example.com" || String(args.Url ?? args.url ?? "") === "https://example.com/";
    if (/^(write_file|edit_file|write_to_file|replace_file_content|multi_replace_file_content)$/.test(name)) return inWs(args.Path ?? args.TargetFile ?? args.AbsolutePath);
    if (name === "run_command") return commands.includes(String(args.CommandLine ?? args.Command ?? "").trim()) && (args.Cwd === undefined || args.Cwd === ws || inWs(args.Cwd + "/"));
    return false;
}
const gate = (commands: string[] = [], hold = 0) =>
    (async (event, input) => {
        if (event !== "pre") return {};
        if (hold) await sleep(hold);
        return safe(input, commands) ? { decision: "auto_approve" } : { decision: "deny", reason: "The probe refuses this call." };
    }) satisfies Decide;

/** A solid red square, as a PNG. */
function redPng(size: number): Buffer {
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const body = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(Bun.hash.crc32(body) >>> 0);
        return Buffer.concat([len, body, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(size, 0);
    ihdr.writeUInt32BE(size, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(size * 3, Buffer.from([255, 0, 0]))]);
    const raw = Buffer.concat(Array.from({ length: size }, () => row));
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

// --- The CLI ---------------------------------------------------------------------------------------------------
function start(extra: string[] = [], timeoutSec = 180) {
    const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--model", MODEL, "--add-dir", gateDir, ...extra, "-p="];
    const cmd = ["perl", "-e", "alarm shift; exec @ARGV", String(timeoutSec), "sandbox-exec", "-p", sandboxProfile(ws, [join(homedir(), ".gemini")]), "agy", ...args];
    log.note(`spawn agy ${args.join(" ")}`, { cwd: ws });
    return new JsonProc(log, cmd, { cwd: ws, env: { PROBE_GATE: `http://127.0.0.1:${server.port}/`, PROBE_TOKEN: token } });
}
const user = (content: unknown) => ({ event: "user", message: { role: "user", content } });
const result = (p: JsonProc, from: number, ms = 120_000) => p.waitFor((f) => f.event === "result", ms, from);
let convo: string | undefined;
const track = (p: JsonProc) => p.waitFor((f) => f.event === "init", 30_000).then((f) => (convo = f?.conversation_id));

async function main() {
    switch (CASE) {
        // Two turns on one process: does the second remember the first, and does each end with a result?
        case "basic": {
            decide = gate();
            const p = start();
            await track(p);
            p.send(user("Reply with just the word apple. Use no tools."));
            await result(p, 0);
            const n = p.frames.length;
            p.send(user("What word did you just reply with? Answer with that word only. Use no tools."));
            await result(p, n);
            p.proc.stdin.end();
            await Promise.race([p.exited, sleep(15_000)]);
            log.note("stdin closed", { alive: p.alive() });
            await p.kill();
            break;
        }
        // The gate's input and its timing against the stream; a write, an allowed command, a denied command.
        case "gate": {
            decide = gate(["echo hi > out.txt"]);
            const p = start();
            await track(p);
            p.send(user("Do these three things in order, one tool call each: 1) create note.txt in the current folder containing the word hi; 2) run the shell command `echo hi > out.txt`; 3) run the shell command `echo DENYME`. Then say what happened to each."));
            await result(p, 0, 150_000);
            await p.kill();
            break;
        }
        // The gate holds a call longer than the hook's timeout (HOOK_TIMEOUT=5): fail open, or closed?
        case "hook-timeout": {
            decide = gate(["echo hi > out.txt"], 12_000);
            const p = start();
            await track(p);
            p.send(user("Run the shell command `echo hi > out.txt`, then say done."));
            await result(p, 0, 150_000);
            log.note("out.txt exists after a gate past its timeout", { exists: Bun.file(join(ws, "out.txt")).size > 0 });
            await p.kill();
            break;
        }
        // Stopping a running turn: control lines it might take, then SIGINT. Does it end the turn, and live on?
        case "interrupt": {
            decide = gate(["sleep 30"]);
            const p = start();
            await track(p);
            p.send(user("Run the shell command `sleep 30` and wait for it to finish, then say done."));
            await p.waitFor((f) => f.step_update?.tool_name === "run_command" && f.step_update?.state === "ACTIVE", 60_000);
            await sleep(2000);
            for (const ev of ["interrupt", "cancel", "control_request"]) p.send({ event: ev });
            await sleep(2000);
            log.note("SIGINT");
            p.proc.kill("SIGINT");
            const r = await result(p, 0, 20_000);
            log.note("after SIGINT", { result: Boolean(r), alive: p.alive() });
            if (p.alive()) {
                const n = p.frames.length;
                p.send(user("Reply with just the word pear. Use no tools."));
                await result(p, n, 60_000);
            }
            await p.kill();
            break;
        }
        // One stdin event (CANCEL_EVENT) mid-command: does it stop the turn, and does the process take the next one?
        case "cancel": {
            decide = gate(["sleep 30"]);
            const ev = process.env.CANCEL_EVENT ?? "interrupt";
            const p = start();
            await track(p);
            p.send(user("Run the shell command `sleep 30` and wait for it to finish, then say done."));
            await p.waitFor((f) => f.step_update?.tool_name === "run_command" && f.step_update?.state === "ACTIVE", 60_000);
            await sleep(2000);
            p.send({ event: ev });
            const r = await result(p, 0, 15_000);
            log.note(`after ${ev}`, { result: Boolean(r), alive: p.alive() });
            if (p.alive()) {
                const n = p.frames.length;
                p.send(user("Reply with just the word pear. Use no tools."));
                await result(p, n, 60_000);
            }
            p.proc.stdin.end();
            await Promise.race([p.exited, sleep(10_000)]);
            await p.kill();
            break;
        }
        // The args of its main tools, as the gate gets them: a read, a listing, a search, a find, an edit, a fetch.
        case "tools": {
            decide = gate();
            writeFileSync(join(ws, "README.txt"), "hello world\nsecond line\n");
            const p = start();
            await track(p);
            p.send(user("Do these one tool call each, in order, using your dedicated tools and not run_command: 1) list_dir on the current folder; 2) read README.txt; 3) grep_search the folder for the text 'second'; 4) find_by_name for files matching *.txt; 5) edit README.txt to replace 'hello world' with 'hello there'; 6) read_url_content of https://example.com. Then say what each returned, briefly."));
            await result(p, 0, 170_000);
            await p.kill();
            break;
        }
        // A conversation resumed in a new process: does it remember, and does SessionStart fire again?
        case "resume": {
            decide = gate();
            const a = start();
            await track(a);
            a.send(user("Remember the word banana. Reply with just ok. Use no tools."));
            await result(a, 0);
            a.proc.stdin.end();
            await Promise.race([a.exited, sleep(15_000)]);
            await a.kill();
            const b = start(["--conversation", convo!]);
            await b.waitFor((f) => f.event === "init", 30_000);
            b.send(user("What word did I ask you to remember? Answer with that word only. Use no tools."));
            await result(b, 0);
            await b.kill();
            // A conversation that doesn't exist.
            const c = start(["--conversation", "00000000-0000-4000-8000-000000000000"]);
            c.send(user("Reply with just ok."));
            await Promise.race([result(c, 0, 30_000), c.exited]);
            await c.kill();
            break;
        }
        // An image in the message content (Claude's block shape).
        case "image": {
            decide = gate();
            const png = redPng(64).toString("base64");
            const p = start();
            await track(p);
            p.send(user([{ type: "text", text: "What color is this image? One word. Use no tools." }, { type: "image", source: { type: "base64", media_type: "image/png", data: png } }]));
            await result(p, 0);
            await p.kill();
            break;
        }
        // The gate folder sorting first: does a SessionStart message keep the model in the session's folder?
        case "order": {
            decide = async (event, input) =>
                event === "session" ? { injectSteps: [{ ephemeralMessage: `Your working folder is ${ws}. Work only there unless the user names another folder. ${gateDir} is not part of the task.` }] } : gate()(event, input);
            const p = start();
            await track(p);
            p.send(user("Create a file named note.txt in the current folder containing the word hi. Then stop."));
            await result(p, 0, 120_000);
            await p.kill();
            break;
        }
        // A second message while a turn runs: queued after it, or folded in?
        case "midturn": {
            decide = gate(["sleep 8"]);
            const p = start();
            await track(p);
            p.send(user("Run the shell command `sleep 8`, then reply with just the word first."));
            await p.waitFor((f) => f.step_update?.tool_name === "run_command" && f.step_update?.state === "ACTIVE", 60_000);
            p.send(user("Also reply with the word second."));
            await result(p, 0, 90_000);
            const n = p.frames.length;
            await result(p, n, 30_000);
            await p.kill();
            break;
        }
        default:
            throw new Error(`no case ${CASE}`);
    }
}

try {
    await main();
} finally {
    server.stop(true);
    console.error(`wrote ${log.file}`);
    process.exit(0);
}
