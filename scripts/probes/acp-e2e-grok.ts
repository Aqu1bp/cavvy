// End to end: Cavvy's own Agent and AcpBackend (src/backends/acp) driving the real `grok`, not raw JSON.
//   bun scripts/probes/acp-e2e-grok.ts
// Checks a text turn, resuming across a process restart (with Manual asking), a deny rule with a model and effort
// switch, Esc, plan mode refusing an edit, Auto through Grok's own reviewer, and switching Auto <-> Manual mid-session
// with the conversation kept, and a steer joining a running turn. Nine prompts; E2E_ONLY=steer runs only the steer
// check (two).
//
// E2E_ONLY=gate checks Cavvy's gate (Grok's client PreToolUse hook) instead, with Grok's HOME settings as many users'
// are: {"permissions": {"defaultMode": "auto", "allow": ["Bash(echo *)"]}}, so Grok would ask about nothing itself.
// Manual: a write and an `echo` both reach the user, a no refuses them and a yes runs them, once each; `ls` goes
// unasked. Plan refuses a write unasked. Auto lets Grok's reviewer decide. Manual again after Auto (a new process
// that resumed the session): asked again. Six prompts, on one session.
//
// Safety: a real model runs on this machine, so
//   - Cavvy's home is a fresh temp folder (nothing of the user's settings or keys), and the workspace another;
//   - `grok` is reached through a wrapper that runs it with an isolated HOME (its .claude/settings.json says
//     defaultMode "default", so none of the user's Claude Code permissions apply) and GROK_HOME=~/.grok, under
//     sandbox-exec (writes only to the workspace, ~/.grok, the temp folders and /dev), with a hard `perl alarm`;
//   - prompts only ask for `echo`-free writes of named files inside the workspace, or for text (the gate check: a
//     write of note.txt, `echo hi > out.txt` and `ls`);
//   - the "user" allows only a write to a file inside the workspace: everything else is refused (the gate check: only
//     a write of note.txt, `echo hi > out.txt` and `ls`, in the workspace, and only once it says yes). Never Grok's
//     always-approve (yoloMode); auto mode only under the sandbox, for such a write;
//   - each turn has a time limit, the whole run too, and every Grok process this run started is stopped (and
//     checked for) at the end.

import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STATE_DIRS, sandboxProfile } from "./acp-lib";

const TURN_MS = 150_000;
const PROCESS_SEC = 600;
const overall = setTimeout(() => {
    console.error("e2e: the whole run timed out");
    process.exit(2);
}, 15 * 60_000);

// Only this run's: its children (the wrapper execs perl, sandbox-exec and grok in turn), never another app's Grok.
const grokPids = () => new Set(Bun.spawnSync(["pgrep", "-P", String(process.pid), "-f", "grok agent --no-leader stdio"]).stdout.toString().trim().split("\n").filter(Boolean));
const before = grokPids();

const home = realpathSync(mkdtempSync(join(tmpdir(), "acp-e2e-home-")));
const ws = realpathSync(mkdtempSync(join(tmpdir(), "acp-e2e-ws-")));
const wrapDir = realpathSync(mkdtempSync(join(tmpdir(), "acp-e2e-bin-")));
const grokHome = realpathSync(mkdtempSync(join(tmpdir(), "acp-e2e-grokuser-")));
mkdirSync(join(grokHome, ".claude"));
const GATE = process.env.E2E_ONLY === "gate";
// The gate check: the settings that made Grok run unasked in Manual before Cavvy had a gate.
writeFileSync(join(grokHome, ".claude/settings.json"), JSON.stringify(GATE ? { permissions: { defaultMode: "auto", allow: ["Bash(echo *)"] } } : { permissions: { defaultMode: "default" } }));
process.env.CAVVY_HOME = home;
// The connection's own log of each gate answer (liveDebug), read by the gate check.
const debugLog = join(home, "live-cli.log");
if (GATE) Object.assign(process.env, { CAVVY_DEBUG: "1", CAVVY_DEBUG_FILE: debugLog });
process.env.CAVVY_NO_KEYCHAIN = "1";
for (const k of Object.keys(process.env)) if (/(_API_KEY|_AUTH_TOKEN)$/.test(k)) delete process.env[k];

const real = Bun.which("grok") ?? join(homedir(), ".local/bin/grok");
if (!existsSync(real)) throw new Error("grok isn't installed");
const wrapper = join(wrapDir, "grok");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
writeFileSync(wrapper, `#!/bin/sh\nexport HOME=${q(grokHome)} GROK_HOME=${q(join(homedir(), ".grok"))}\nexec perl -e 'alarm shift; exec @ARGV' ${PROCESS_SEC} sandbox-exec -p ${q(sandboxProfile(ws, STATE_DIRS.grok))} ${q(real)} "$@"\n`);
chmodSync(wrapper, 0o755);

const registry = await import("../../src/providers/registry");
const { clientFor } = await import("../../src/providers/models");
const { Agent } = await import("../../src/agent/agent");
const { Session } = await import("../../src/agent/session");
const { PermissionChecker } = await import("../../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../../src/tools/index");
const trust = await import("../../src/config/trust");
type AgentEvent = import("../../src/agent/agent").AgentEvent;
type PermissionMode = import("../../src/permissions/modes").PermissionMode;

registry.saveAgentConfig("grok", { path: wrapper });
trust.trustForSession(ws);

const inside = (p: string) => {
    const n = resolve(ws, p);
    return !/[*?~]/.test(p) && (n === ws || n.startsWith(ws + "/"));
};
const results: { check: string; ok: boolean; detail: string }[] = [];
const record = (check: string, ok: boolean, detail: string) => {
    results.push({ check, ok, detail });
    console.log(`${ok ? "PASS" : "FAIL"} ${check}: ${detail}`);
};
const asks: string[] = [];
/** The gate check's user: says yes (only to its three calls) once this is true. */
let gateYes = false;
const SAFE = ["echo hi > out.txt", "ls"];

const client = await clientFor("grok");
const session = Session.create(ws, { persist: false });
let mode: PermissionMode = "default";
let settings: any = { effort: "low", permissions: {} };
let model = { provider: "grok", id: "grok-4.7" };
const events: AgentEvent[] = [];
const steerQueue: string[] = [];
const agent = new Agent({
    session,
    model,
    client,
    settings: () => settings,
    checker: new PermissionChecker(() => settings, ws),
    tools: BUILTIN_TOOLS,
    mode: { get: () => mode, set: (m) => (mode = m) },
    toolState: { cwd: ws, projectRoot: ws, fileState: new Map(), todos: [], shells: new Map() },
    host: {
        // Messages the user queued to steer the running turn (the steering check).
        drainQueued: () => steerQueue.splice(0),
        emit: (e) => events.push(e),
        ui: {},
        // The user: yes only to a write of a file inside the workspace. The gate check's: only to a write of note.txt
        // and `echo hi > out.txt` (or `ls`), in the workspace, and only once it says yes.
        askPermission: async (req) => {
            const input = req.input ?? {};
            const ok = GATE
                ? gateYes && (((req.tool.name === "Write" || req.tool.name === "Edit") && input.file_path === join(ws, "note.txt")) || (req.tool.name === "Bash" && SAFE.includes(String(input.command ?? "").trim())))
                : (req.tool.name === "Write" || req.tool.name === "Edit") && typeof input.file_path === "string" && inside(input.file_path);
            asks.push(`${req.title} -> ${ok ? "allow" : "deny"}`);
            return ok ? { allow: true } : { allow: false, feedback: "Not allowed in this test. Do not retry; just say so." };
        },
    },
});

async function run(text: string, o: { abortOnText?: boolean } = {}) {
    const from = events.length;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TURN_MS);
    let watch: ReturnType<typeof setInterval> | undefined;
    if (o.abortOnText) watch = setInterval(() => events.slice(from).some((e) => e.type === "text") && ac.abort(), 20);
    try {
        const end = await agent.run([{ type: "text", text }], { signal: ac.signal });
        const said = events.slice(from).flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
        const notices = events.slice(from).flatMap((e) => (e.type === "notice" ? [`${e.level}: ${e.message}`] : []));
        const tools = events.slice(from).flatMap((e) => (e.type === "tool_end" ? [`${e.call.name}${e.result.isError ? " (error)" : ""}`] : []));
        const used = events.slice(from).flatMap((e) => (e.type === "usage" ? [e.usage.resolvedModel] : [])).at(-1);
        return { end, said, notices, tools, used };
    } finally {
        clearTimeout(timer);
        clearInterval(watch);
    }
}
const file = (name: string) => (existsSync(join(ws, name)) ? readFileSync(join(ws, name), "utf-8").trim() : undefined);
const writeIt = (name: string, what: string) => `Use your file write tool (not the shell) to create a file named ${name} in the current directory containing exactly ${what}. If it is refused, do not retry; just say so. Do nothing else.`;
const processes = () => (client as any).pool.list().length;
const grokConfig = () => (client as any).pool.list()[0]?.adapter?.conn?.config as { id: string; currentValue?: unknown }[] | undefined;

/** The other checks. */
async function rest() {
    // 1. A text turn.
    const t1 = await run("Remember the secret word: periwinkle. Reply with just the word OK.");
    record("text turn", t1.end === "done" && /ok/i.test(t1.said), `${t1.end}; said ${JSON.stringify(t1.said.slice(0, 80))}; model ${t1.used}`);
    const sid = session.backends.get("grok")?.id;

    // 2. Resume across a process restart; Manual asks, and the user's yes writes it.
    await (client as any).shutdown();
    const b2 = asks.length;
    const t2 = await run(writeIt("resumed.txt", "the secret word I asked you to remember, and nothing else"));
    record("resume after restart, Manual asks", t2.end === "done" && session.backends.get("grok")?.id === sid && /periwinkle/i.test(file("resumed.txt") ?? "") && asks.length === b2 + 1, `${t2.end}; same session ${session.backends.get("grok")?.id === sid}; resumed.txt ${JSON.stringify(file("resumed.txt"))}; asks ${JSON.stringify(asks.slice(b2))}; notices ${JSON.stringify(t2.notices)}`);

    // 3. A deny rule refuses without asking; on another model and effort.
    settings = { effort: "medium", permissions: { deny: ["Write(denied.txt)", "Edit(denied.txt)"] } };
    model = { provider: "grok", id: "grok-4.6" };
    agent.setModel({ ...model }, client);
    const b3 = asks.length;
    const t3 = await run(writeIt("denied.txt", "the text: no"));
    const effort = grokConfig()?.find((c) => c.id === "reasoning_effort")?.currentValue;
    record("deny rule refuses", file("denied.txt") === undefined && asks.length === b3, `${t3.end}; tools ${JSON.stringify(t3.tools)}; asks ${asks.length - b3}; notices ${JSON.stringify(t3.notices)}`);
    record("model and effort switch", t3.used === "grok:grok-4.6" && effort === "medium", `${t3.used}; reasoning_effort ${String(effort)}`);
    settings = { effort: "low", permissions: {} };
    model = { provider: "grok", id: "grok-4.7" };
    agent.setModel({ ...model }, client);

    // 4. Esc mid-turn: the turn ends aborted.
    const t4 = await run("Count from 1 to 400, one number per line. Do not use any tools.", { abortOnText: true });
    record("Esc", t4.end === "aborted", `${t4.end}`);

    // 5. Plan mode refuses an edit (and the process that was stopped runs it).
    mode = "plan";
    const b5 = asks.length;
    const t5 = await run(writeIt("plan.txt", "the text: x"));
    record("plan refuses an edit (after Esc)", t5.end === "done" && file("plan.txt") === undefined && asks.length === b5, `${t5.end}; tools ${JSON.stringify(t5.tools)}; said ${JSON.stringify(t5.said.slice(0, 120))}`);

    // 6. Auto: Grok's own reviewer, on the same session (a new process resumes it with _meta.autoMode).
    mode = "auto";
    const b6 = asks.length;
    const t6 = await run(writeIt("auto.txt", "the secret word I asked you to remember, and nothing else"));
    record("auto via Grok's reviewer, context kept", t6.end === "done" && /periwinkle/i.test(file("auto.txt") ?? "") && session.backends.get("grok")?.id === sid, `${t6.end}; auto.txt ${JSON.stringify(file("auto.txt"))}; asks ${JSON.stringify(asks.slice(b6))}; notices ${JSON.stringify(t6.notices)}; processes ${processes()}`);

    // 7. Back to Manual: asks again, and still knows the conversation.
    mode = "default";
    const b7 = asks.length;
    const t7 = await run(writeIt("manual.txt", "the secret word I asked you to remember, and nothing else"));
    record("back to Manual asks, context kept", t7.end === "done" && /periwinkle/i.test(file("manual.txt") ?? "") && asks.length === b7 + 1 && session.backends.get("grok")?.id === sid, `${t7.end}; manual.txt ${JSON.stringify(file("manual.txt"))}; asks ${JSON.stringify(asks.slice(b7))}`);
}

/**
 * Steering: a message queued while the turn runs (once its first tool has started) is taken at once and joins the
 * running turn (_x.ai/interject), which ends with what it asked for, as one turn: recorded in the conversation, its tokens once.
 * Two prompts: the turn's and the steer. Its commands only read (Cavvy allows them without asking).
 */
async function steerCheck() {
    const was = settings;
    settings = { ...settings, permissions: {} };
    const from = events.length;
    const steer = "Also, end your final reply with the word banana.";
    let queuedAt = -1;
    const watch = setInterval(() => {
        if (queuedAt >= 0 || !events.slice(from).some((e) => e.type === "tool_start")) return;
        queuedAt = events.length;
        steerQueue.push(steer);
        agent.queueChanged();
    }, 20);
    try {
        const t = await run("Run these three shell commands one at a time, each as its own tool call, waiting for each to finish before starting the next: `sleep 2`, then `echo one`, then `echo two`. After all three have finished, reply with one short sentence saying they finished.");
        const usages = events.slice(from).filter((e) => e.type === "usage").length;
        const recorded = session.messages.some((m) => m.role === "user" && JSON.stringify(m.content).includes(steer));
        const after = events.slice(queuedAt < 0 ? events.length : queuedAt).flatMap((e) => (e.type === "text" ? [e.text] : [])).join("");
        record("steer joins the running turn", t.end === "done" && queuedAt >= 0 && steerQueue.length === 0 && recorded && /banana\W*$/i.test(t.said.trim()) && /banana/i.test(after) && usages === 1, `${t.end}; queued ${queuedAt >= 0}; taken ${steerQueue.length === 0}; in the conversation ${recorded}; usage events ${usages}; tools ${JSON.stringify(t.tools)}; said ${JSON.stringify(t.said.slice(-160))}`);
    } finally {
        clearInterval(watch);
        settings = was;
    }
}

/** The gate's answers the connection logged since `from` (liveDebug "gate"): tool and yes or no. */
function gateLines(from: number): string[] {
    if (!existsSync(debugLog)) return [];
    return readFileSync(debugLog, "utf-8")
        .split("\n")
        .slice(from)
        .flatMap((l) => {
            try {
                const o = JSON.parse(l);
                return o.what === "gate" ? [`${o.tool} ${o.allow ? "allow" : "deny"}`] : [];
            } catch {
                return [];
            }
        });
}
const logLength = () => (existsSync(debugLog) ? readFileSync(debugLog, "utf-8").split("\n").length - 1 : 0);
const clean = () => {
    for (const f of ["note.txt", "out.txt"]) rmSync(join(ws, f), { force: true });
};

/** Cavvy's gate, with Grok's settings saying auto mode and allowing `echo` (E2E_ONLY=gate). Six prompts. */
async function gateCheck() {
    const BOTH = "Do these two things, in order, and nothing else: 1) create a file named note.txt in the current directory containing exactly: hi, using your file write tool (not the shell); 2) run exactly this shell command: echo hi > out.txt . If either is refused, do not retry it; say so and quote the reason you were given.";
    const WRITE = "Create a file named note.txt in the current directory containing exactly: hi. Use your file write tool, not the shell. If it is refused, do not retry; just say so and quote the reason. Do nothing else.";
    const LS = "Run exactly this shell command and nothing else: `ls`. Then reply with what it printed.";
    writeFileSync(join(ws, "README.txt"), "hello");
    const step = async (label: string, text: string) => {
        clean();
        const a = asks.length;
        const g = logLength();
        const t = await run(text);
        return { ...t, asks: asks.slice(a), gate: gateLines(g), note: file("note.txt"), out: file("out.txt") };
    };
    const show = (t: Awaited<ReturnType<typeof step>>) => `${t.end}; asks ${JSON.stringify(t.asks)}; gate ${JSON.stringify(t.gate)}; note.txt ${JSON.stringify(t.note)}; out.txt ${JSON.stringify(t.out)}; tools ${JSON.stringify(t.tools)}; notices ${JSON.stringify(t.notices)}; said ${JSON.stringify(t.said.slice(0, 160))}`;
    const wrote = (t: Awaited<ReturnType<typeof step>>) => t.asks.some((x) => /^Write.*note\.txt.* -> /.test(x));
    // E2E_GATE_STEPS=5,6: only those (a rerun within the prompt budget). The session is the first step's.
    const only = process.env.E2E_GATE_STEPS?.split(",").map(Number);
    const want = (n: number) => !only || only.includes(n);
    let sid: string | undefined;
    const same = () => {
        sid ??= session.backends.get("grok")?.id;
        return session.backends.get("grok")?.id === sid;
    };
    const echoed = (t: Awaited<ReturnType<typeof step>>) => t.asks.some((x) => /echo hi > out\.txt.* -> /.test(x));

    // 1. Manual, the user says no: both reach the user (Grok's settings would have run them unasked), neither runs.
    if (want(1)) {
        mode = "default";
        gateYes = false;
        const t1 = await step("manual no", BOTH);
        record("gate: Manual asks about a write and an allowed-by-Grok echo; a no refuses both", t1.end !== "error" && wrote(t1) && echoed(t1) && t1.asks.length === 2 && t1.note === undefined && t1.out === undefined && same(), show(t1));
    }
    gateYes = true;

    // 2. Manual, the user says yes: asked once each (Grok's own ask after the gate's yes isn't), both run. Cavvy
    // remembers each yes for the session (the same tool and input), as for its own models.
    if (want(2)) {
        mode = "default";
        const t2 = await step("manual yes", BOTH);
        record("gate: Manual, a yes runs both, asked once each", t2.end === "done" && wrote(t2) && echoed(t2) && t2.asks.length === 2 && t2.note === "hi" && t2.out === "hi" && same(), show(t2));
    }

    // 3. Manual: `ls` (read-only) goes unasked, through the gate.
    if (want(3)) {
        mode = "default";
        const t3 = await step("manual ls", LS);
        record("gate: Manual lets a read-only command go unasked", t3.end === "done" && t3.asks.length === 0 && t3.gate.some((x) => x.startsWith("run_terminal_command allow")) && same(), show(t3));
    }

    // 4. Plan: the write is refused at the gate, unasked.
    if (want(4)) {
        mode = "plan";
        const t4 = await step("plan", WRITE);
        record("gate: Plan refuses a write unasked", t4.end === "done" && t4.asks.length === 0 && t4.note === undefined && t4.gate.some((x) => x.startsWith("write deny")) && same(), show(t4));
    }

    // 5. Auto: let go at the gate; Grok's reviewer decides (a new process resumed the session with autoMode).
    if (want(5)) {
        mode = "auto";
        const t5 = await step("auto", WRITE);
        record("gate: Auto leaves it to Grok's reviewer", t5.end === "done" && t5.gate.length > 0 && t5.gate.every((x) => x.endsWith("allow")) && same(), `${show(t5)}; same session ${same()}`);
    }

    // 6. Manual again (another new process resumed the session): the gate holds again. A write of other content
    // than any yes so far is asked about; the echo may be a yes Cavvy remembers.
    if (want(6)) {
        mode = "default";
        const t6 = await step("manual again", BOTH.replace("containing exactly: hi", "containing exactly: bye"));
        record("gate: back to Manual after Auto, re-registered: held at the gate, a new write asked about", t6.end === "done" && wrote(t6) && t6.gate.length >= 2 && t6.note === "bye" && t6.out === "hi" && same(), `${show(t6)}; same session ${same()}`);
    }
}

try {
    // 0. Steering (E2E_ONLY=steer: only this, two prompts). E2E_ONLY=gate: the gate check only.
    if (GATE) await gateCheck();
    else await steerCheck();
    if (!process.env.E2E_ONLY) await rest();
} catch (e) {
    record("run", false, (e as Error).stack ?? String(e));
} finally {
    await (client as any).shutdown?.();
    clearTimeout(overall);
    await Bun.sleep(500);
    const left = [...grokPids()].filter((p) => !before.has(p));
    for (const p of left) Bun.spawnSync(["kill", "-9", p]);
    record("no processes left", left.length === 0, left.length ? `killed ${left.length}` : "none");
    console.log(`asks: ${JSON.stringify(asks)}`);
    for (const d of [home, wrapDir, grokHome, ws]) rmSync(d, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `${failed} failed` : "all passed");
    process.exit(failed ? 1 : 0);
}
