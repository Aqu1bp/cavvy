// End to end: Cavvy's own Agent and AcpBackend (src/backends/acp) driving the real `opencode`, not raw JSON.
//   bun scripts/probes/acp-e2e.ts
// Checks a text turn, resuming across a process restart, an ask in the default mode (answered as a user would), an
// allowed write, a deny rule, plan mode refusing an edit, Esc, a model switch, and a steer joining a running turn.
// E2E_ONLY=steer runs only the steer check (two prompts).
//
// Safety: a real model runs on this machine, so
//   - Cavvy's home is a fresh temp folder (nothing of the user's settings or keys), and the workspace another;
//   - `opencode` is reached through a wrapper that runs it under sandbox-exec (writes only to the workspace, its own
//     state folders, the temp folders and /dev) with a hard `perl alarm` timeout;
//   - only free models run (OpenCode's default, opencode/big-pickle, and a "-free" one for the switch);
//   - every command asks the user here (an ask rule for Bash), and the "user" allows only `echo hi > out.txt` and a
//     write to a file inside the workspace: everything else is refused. Bypass is never used. OpenCode is started
//     by Cavvy's spawn, which makes it ask; the tripwire would stop it if it didn't;
//   - each turn has a time limit, the whole run too, and every process is stopped (and checked for) at the end.

import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { STATE_DIRS, sandboxProfile } from "./acp-lib";

const TURN_MS = 150_000;
const PROCESS_SEC = 600;
const overall = setTimeout(() => {
    console.error("e2e: the whole run timed out");
    process.exit(2);
}, 15 * 60_000);

const home = realpathSync(mkdtempSync(join(tmpdir(), "acp-e2e-home-")));
const ws = realpathSync(mkdtempSync(join(tmpdir(), "acp-e2e-ws-")));
const wrapDir = realpathSync(mkdtempSync(join(tmpdir(), "acp-e2e-bin-")));
process.env.CAVVY_HOME = home;
process.env.CAVVY_NO_KEYCHAIN = "1";
for (const k of Object.keys(process.env)) if (/(_API_KEY|_AUTH_TOKEN)$/.test(k)) delete process.env[k];

const real = Bun.which("opencode");
if (!real) throw new Error("opencode isn't installed");
const wrapper = join(wrapDir, "opencode");
const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
writeFileSync(wrapper, `#!/bin/sh\nexec perl -e 'alarm shift; exec @ARGV' ${PROCESS_SEC} sandbox-exec -p ${q(sandboxProfile(ws, STATE_DIRS.opencode))} ${q(real)} "$@"\n`);
chmodSync(wrapper, 0o755);

const registry = await import("../../src/providers/registry");
const { clientFor } = await import("../../src/providers/models");
const { Agent } = await import("../../src/agent/agent");
const { Session } = await import("../../src/agent/session");
const { PermissionChecker } = await import("../../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../../src/tools/index");
const trust = await import("../../src/config/trust");
const { acpModels } = await import("../../src/backends/acp/backend");
type AgentEvent = import("../../src/agent/agent").AgentEvent;
type PermissionMode = import("../../src/permissions/modes").PermissionMode;

registry.saveAgentConfig("opencode", { path: wrapper });
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

const client = await clientFor("opencode");
const session = Session.create(ws, { persist: false });
let mode: PermissionMode = "default";
let settings: any = { permissions: { ask: ["Bash"] } };
let model = { provider: "opencode", id: "opencode/big-pickle" };
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
        // The user: yes only to the two harmless actions.
        askPermission: async (req) => {
            const input = req.input ?? {};
            const ok = (req.tool.name === "Bash" && String(input.command ?? "").trim() === "echo hi > out.txt") || ((req.tool.name === "Write" || req.tool.name === "Edit") && typeof input.file_path === "string" && inside(input.file_path));
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
        return { end, said, notices, tools };
    } finally {
        clearTimeout(timer);
        clearInterval(watch);
    }
}

/** The other checks. */
async function rest() {
    // 1. A text turn.
    const t1 = await run("Remember the secret word: periwinkle. Reply with just the word OK.");
    record("text turn", t1.end === "done" && /ok/i.test(t1.said), `${t1.end}; said ${JSON.stringify(t1.said.slice(0, 80))}`);
    const sid = session.backends.get("opencode")?.id;

    // 2. Resume across a process restart.
    await (client as any).shutdown();
    const t2 = await run("What was the secret word I asked you to remember? Reply with just the word.");
    record("resume after restart", t2.end === "done" && /periwinkle/i.test(t2.said) && session.backends.get("opencode")?.id === sid, `${t2.end}; said ${JSON.stringify(t2.said.slice(0, 80))}; same session ${session.backends.get("opencode")?.id === sid}`);

    // 3. The default mode asks; the user's yes runs it.
    const before = asks.length;
    const t3 = await run("Run exactly this shell command and nothing else: echo hi > out.txt");
    const out = join(ws, "out.txt");
    record("default mode asks", t3.end === "done" && asks.slice(before).some((a) => a.includes("echo hi > out.txt") && a.endsWith("allow")) && existsSync(out) && readFileSync(out, "utf-8").trim() === "hi", `${t3.end}; asks ${JSON.stringify(asks.slice(before))}; out.txt ${existsSync(out)}`);

    // 3b. A write inside the workspace, allowed: OpenCode's fs/write_text_file afterwards keeps it, and says nothing.
    const b3 = asks.length;
    const t3b = await run("Use your file write tool to create a file named note.txt in the current directory containing exactly: hi. Do nothing else.");
    const note = join(ws, "note.txt");
    record("allowed write", t3b.end === "done" && asks.slice(b3).some((a) => a.endsWith("allow")) && existsSync(note) && readFileSync(note, "utf-8").trim() === "hi" && !t3b.notices.some((n) => n.startsWith("error")), `${t3b.end}; asks ${JSON.stringify(asks.slice(b3))}; tools ${JSON.stringify(t3b.tools)}; notices ${JSON.stringify(t3b.notices)}`);

    // 4. A deny rule refuses, without asking.
    settings = { permissions: { ask: ["Bash"], deny: ["Write(denied.txt)", "Edit(denied.txt)"] } };
    const b4 = asks.length;
    const t4 = await run("Use your file write tool to create a file named denied.txt in the current directory containing exactly: no. If it is refused, do not retry; just say so.");
    record("deny rule refuses", !existsSync(join(ws, "denied.txt")) && asks.length === b4, `${t4.end}; tools ${JSON.stringify(t4.tools)}; asks ${asks.length - b4}; file ${existsSync(join(ws, "denied.txt"))}`);
    settings = { permissions: { ask: ["Bash"] } };

    // 5. Plan mode refuses an edit.
    mode = "plan";
    const b5 = asks.length;
    const t5 = await run("Use your file write tool to create a file named plan.txt in the current directory containing exactly: x. If it is refused, do not retry; just say so.");
    record("plan refuses an edit", !existsSync(join(ws, "plan.txt")) && asks.length === b5, `${t5.end}; tools ${JSON.stringify(t5.tools)}; said ${JSON.stringify(t5.said.slice(0, 100))}`);
    mode = "default";

    // 6. Esc mid-turn: the turn ends aborted, and the next one runs on the same process.
    const t6 = await run("Count from 1 to 400, one number per line. Do not use any tools.", { abortOnText: true });
    const t6b = await run("Reply with just the word: after");
    record("Esc", t6.end === "aborted" && t6b.end === "done" && /after/i.test(t6b.said), `${t6.end}, then ${t6b.end} ${JSON.stringify(t6b.said.slice(0, 40))}`);

    // 7. A model switch, to another free model.
    const free = (await acpModels("opencode")).map((m) => m.id).find((id) => id.startsWith("opencode/") && id.endsWith("-free"));
    if (!free) record("model switch", false, "no free model listed");
    else {
        model = { provider: "opencode", id: free };
        agent.setModel({ ...model }, client);
        const t7 = await run("Reply with just the word: switched");
        const used = events.flatMap((e) => (e.type === "usage" ? [e.usage.resolvedModel] : [])).at(-1);
        record("model switch", t7.end === "done" && used === `opencode:${free}`, `${t7.end} on ${used}; said ${JSON.stringify(t7.said.slice(0, 40))}`);
    }
}

/**
 * Steering: a message queued while the turn runs (once its first tool has started) is taken at once and joins the
 * running turn (a second session/prompt OpenCode folds in), which ends with what it asked for, as one turn: recorded in the conversation, its tokens once.
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

try {
    // 0. Steering (E2E_ONLY=steer: only this, two prompts).
    await steerCheck();
    if (process.env.E2E_ONLY !== "steer") await rest();
} catch (e) {
    record("run", false, (e as Error).stack ?? String(e));
} finally {
    await (client as any).shutdown?.();
    clearTimeout(overall);
    const left = Bun.spawnSync(["pgrep", "-f", ws]).stdout.toString().trim();
    if (left) Bun.spawnSync(["pkill", "-9", "-f", ws]);
    record("no processes left", !left, left ? `killed ${left.split("\n").length}` : "none");
    console.log(`asks: ${JSON.stringify(asks)}`);
    for (const d of [home, wrapDir]) rmSync(d, { recursive: true, force: true });
    rmSync(ws, { recursive: true, force: true });
    const failed = results.filter((r) => !r.ok).length;
    console.log(failed ? `${failed} failed` : "all passed");
    process.exit(failed ? 1 : 0);
}
