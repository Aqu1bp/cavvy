// ACP probes for Grok Build (`grok agent stdio`). One case per run:
//   bun scripts/probes/acp-grok.ts <case>
// Never runs a model under always-approve. Auto mode runs a model only in the auto-* cases, sandboxed, with an
// isolated HOME, asking only for a write of a named file inside the temp workspace.
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Ctx, type Profile, type SteerOpts, steerCase, closeCase, handshake, badCwd, controls, ctx, start, open, promptSeries, cancelCase, concurrency, resumeCase, turn, allow, reject, cancelled, writeTo, runs, RED_PNG, IMAGE_STEP } from "./acp-cases";
import { Acp, HOME, trackSession } from "./acp-lib";
import { scrubAlso, sleep } from "./lib";

// Grok reads Claude Code's ~/.claude/settings.json (permissions.defaultMode and allow/deny rules). On this
// machine that file says defaultMode "auto" and allows `git push *`, so every probe a model drives runs Grok
// with HOME pointed at an empty folder and GROK_HOME at the real ~/.grok (so the sign-in still works).
function isolatedHome(claudeSettings?: unknown) {
    const dir = realpathSync(mkdtempSync(join("/tmp", "acp-home-")));
    scrubAlso(dir, "/tmp/acp-home");
    if (claudeSettings) {
        mkdirSync(join(dir, ".claude"));
        writeFileSync(join(dir, ".claude/settings.json"), JSON.stringify(claudeSettings));
    }
    return { HOME: dir, GROK_HOME: join(HOME, ".grok") };
}

const profile: Profile = {
    cli: "grok",
    version: "1.0.70",
    args: () => ["agent", "--no-leader", "stdio"],
    env: isolatedHome(),
    // grok-4.7-build-fast is "2x the price"; the default grok-4.7 at low effort is the cheap choice.
    prep: async (acp, sessionId) => acp.request("session/set_config_option", { sessionId, configId: "reasoning_effort", value: process.env.PROBE_GROK_EFFORT ?? "low" }),
};

/** Every key/value in the agent's frames that could tell the effective permission mode (yolo, auto, mode, permission...). */
function modeSignals(frames: any[]) {
    const seen = new Map<string, Set<string>>();
    const walk = (v: any, path: string) => {
        if (Array.isArray(v)) return v.forEach((x) => walk(x, path));
        if (v && typeof v === "object") return Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
        const key = path.split(".").slice(-1)[0];
        if (/yolo|auto|mode|permission|approve|bypass|accept|dontask/i.test(key) && !/^(modelId|model_id|currentModelId)$/.test(key)) {
            const k = path.replace(/^\.params\./, "").replace(/\.\d+/g, "");
            if (!seen.has(k)) seen.set(k, new Set());
            seen.get(k)!.add(JSON.stringify(v));
        }
    };
    for (const f of frames) if (f.method) walk(f.params, `${f.method}`);
    for (const f of frames) if (!f.method && f.result) walk(f.result, `result`);
    return Object.fromEntries([...seen].filter(([k]) => !/availableCommands|announcements|tips|description/.test(k)).map(([k, s]) => [k, [...s].join(" | ")]));
}

// ---------- Auto mode and plan mode across processes (part 2) ----------
// Every process below runs with an isolated HOME whose .claude/settings.json says defaultMode "default", so what's
// seen is the ACP side's doing, not the user's Claude settings. Each prompt asks only for a write of a named file in
// the temp workspace, and only that write is allowed when asked.

const DEFAULT_SETTINGS = { permissions: { defaultMode: "default" } };

/** One process on a workspace: started, initialized, its frames logged to the case's fixture. */
async function proc(c: Ctx, ws: string, timeoutSec = 240) {
    const acp = start(c, { env: isolatedHome(DEFAULT_SETTINGS), timeoutSec }, ws);
    const init = await acp.initialize();
    c.log.note(`initialize -> ${init.error ? JSON.stringify(init.error) : "ok"} in ${init.ms} ms`);
    return acp;
}

/** Asks for a write of `file`: was it asked about, and was it written? */
async function writeStep(c: Ctx, acp: Acp, ws: string, sessionId: string, label: string, file: string) {
    acp.rules = [allow(`write ${file}`, writeTo(file))];
    const before = acp.permissionLog.length;
    const from = acp.p.frames.length;
    await turn(c, acp, sessionId, `Create a file named ${file} in the current directory containing exactly the text: hi. Use your file write tool, not the shell. If it is refused, do not retry; just say so. Do nothing else.`, label);
    const perms = acp.permissionLog.slice(before).map((p) => ({ answer: p.answer, rule: p.rule, note: p.note, paths: p.req.paths, title: p.req.params?.toolCall?.title }));
    const modes = acp.p.frames.slice(from).filter((f) => f.params?.update?.sessionUpdate === "current_mode_update").map((f) => f.params.update.currentModeId);
    const written = existsSync(join(ws, file));
    c.log.note(`${label}: permission requests ${perms.length}; ${file} written ${written}; current_mode_update ${JSON.stringify(modes)}`, { perms });
    return { asked: perms.length, written };
}

async function setMode(c: Ctx, acp: Acp, sessionId: string, modeId: string) {
    const from = acp.p.frames.length;
    const r = await acp.request("session/set_mode", { sessionId, modeId });
    await sleep(500);
    const modes = acp.p.frames.slice(from).filter((f) => f.params?.update?.sessionUpdate === "current_mode_update").map((f) => f.params.update.currentModeId);
    c.log.note(`set_mode ${modeId} -> ${JSON.stringify(r.error ?? r.result)}; current_mode_update ${JSON.stringify(modes)}`);
}

/** session/resume (or load) of a saved session in a new process, with `_meta` if given. */
async function reopen(c: Ctx, acp: Acp, how: "session/resume" | "session/load", saved: { sessionId: string; ws: string }, meta?: Record<string, unknown>) {
    const from = acp.p.frames.length;
    const r = await acp.request(how, { sessionId: saved.sessionId, cwd: saved.ws, mcpServers: [], ...(meta ? { _meta: meta } : {}) });
    await sleep(1000);
    const modes = acp.p.frames.slice(from).filter((f) => f.params?.update?.sessionUpdate === "current_mode_update").map((f) => f.params.update.currentModeId);
    c.log.note(`${how}${meta ? ` with _meta ${JSON.stringify(meta)}` : ""} -> ${r.error ? JSON.stringify(r.error) : "ok"}; result keys ${JSON.stringify(Object.keys(r.result ?? {}))}; modes ${JSON.stringify(r.result?.modes ?? null)}; current_mode_update ${JSON.stringify(modes)}`);
    await profile.prep(acp, saved.sessionId);
    return r;
}

/** A saved session from an earlier case, in its own workspace (scrubbed as the first run's was). */
function savedCase(c: Ctx, key: string) {
    const saved = c.st.get(key) as { sessionId: string; ws: string } | undefined;
    if (!saved) throw new Error(`run the case that saves ${key} first`);
    scrubAlso(saved.ws, "/tmp/acp-grok");
    scrubAlso(saved.ws.replace(/^\/private/, ""), "/tmp/acp-grok");
    scrubAlso(encodeURIComponent(saved.ws), encodeURIComponent("/tmp/acp-grok"));
    trackSession(saved.sessionId);
    return saved;
}

const autoCases: Record<string, () => Promise<void>> = {
    // Q1: _meta.autoMode on session/new turns Grok's auto reviewer on (a write needs no ask), and a plan round trip
    // (set_mode plan, then default) keeps it. Saves the session as "auto". 2 prompts.
    "auto-new": async () => {
        const c = ctx(profile, "auto-new");
        const acp = await proc(c, c.ws);
        const ns = await acp.newSession({ _meta: { autoMode: true } });
        const sessionId = ns.result.sessionId;
        c.log.note(`session/new with _meta.autoMode -> ok; result _meta ${JSON.stringify(ns.result?._meta ?? null)}`);
        await profile.prep(acp, sessionId);
        c.st.set("auto", { sessionId, ws: c.ws });
        await writeStep(c, acp, c.ws, sessionId, "auto on session/new: write note.txt", "note.txt");
        await setMode(c, acp, sessionId, "plan");
        await setMode(c, acp, sessionId, "default");
        await writeStep(c, acp, c.ws, sessionId, "after set_mode plan then default: write note2.txt", "note2.txt");
        c.log.note("mode/permission signals seen", modeSignals(acp.p.frames));
        await acp.stop();
    },
    // Q3 (first half): a session without auto put in plan mode, and prompted. Saves it as "plan". 1 prompt.
    "plan-start": async () => {
        const c = ctx(profile, "plan-start");
        const acp = await proc(c, c.ws);
        const ns = await acp.newSession();
        const sessionId = ns.result.sessionId;
        await profile.prep(acp, sessionId);
        c.st.set("plan", { sessionId, ws: c.ws });
        await setMode(c, acp, sessionId, "plan");
        await writeStep(c, acp, c.ws, sessionId, "plan: write plan-test.txt", "plan-test.txt");
        await acp.stop();
    },
    // Q3: does plan survive session/resume in a new process? Q2: does set_mode "auto" turn auto on? 2 prompts.
    "plan-resume": async () => {
        const c0 = ctx(profile, "plan-resume");
        const saved = savedCase(c0, "plan");
        const c = { ...c0, ws: saved.ws };
        const acp = await proc(c, saved.ws);
        await reopen(c, acp, "session/resume", saved);
        await writeStep(c, acp, saved.ws, saved.sessionId, "resumed, no set_mode: write plan2.txt", "plan2.txt");
        await setMode(c, acp, saved.sessionId, "default");
        await setMode(c, acp, saved.sessionId, "auto");
        await writeStep(c, acp, saved.ws, saved.sessionId, "set_mode default, then set_mode auto: write auto-by-mode.txt", "auto-by-mode.txt");
        c.log.note("mode/permission signals seen", modeSignals(acp.p.frames));
        await acp.stop();
    },
    // Q2: _meta.autoMode on session/resume (or load) of a session that wasn't auto, in a new process. 1 prompt.
    "auto-on-resume": async () => {
        const how = process.argv[3] === "load" ? "session/load" : "session/resume";
        const c0 = ctx(profile, `auto-on-${how === "session/load" ? "load" : "resume"}`);
        const saved = savedCase(c0, "plan");
        const c = { ...c0, ws: saved.ws };
        const acp = await proc(c, saved.ws);
        await reopen(c, acp, how, saved, { autoMode: true });
        await setMode(c, acp, saved.sessionId, "default");
        await writeStep(c, acp, saved.ws, saved.sessionId, `${how} with autoMode: write note-resumed.txt`, "note-resumed.txt");
        c.log.note("mode/permission signals seen", modeSignals(acp.p.frames));
        await acp.stop();
    },
    // Q2: the auto session resumed in a new process without the flag (or with autoMode false): asks again? 1 prompt.
    "auto-off-resume": async () => {
        const off = process.argv[3] === "false";
        const c0 = ctx(profile, off ? "auto-off-resume-false" : "auto-off-resume");
        const saved = savedCase(c0, "auto");
        const c = { ...c0, ws: saved.ws };
        const acp = await proc(c, saved.ws);
        await reopen(c, acp, "session/resume", saved, off ? { autoMode: false } : undefined);
        await writeStep(c, acp, saved.ws, saved.sessionId, `resumed ${off ? "with autoMode false" : "without the flag"}: write note3.txt`, "note3.txt");
        c.log.note("mode/permission signals seen", modeSignals(acp.p.frames));
        await acp.stop();
    },
    // Signed out (an empty GROK_HOME): what initialize, session/new and a prompt say. No model can run. 1 prompt.
    "signed-out": async () => {
        const c = ctx(profile, "signed-out");
        const grokHome = realpathSync(mkdtempSync(join("/tmp", "acp-grokhome-")));
        scrubAlso(grokHome, "/tmp/acp-grokhome");
        // The sandbox allows writes to /private/tmp, so this run's own GROK_HOME there too.
        const acp = new Acp(c.log, { cli: "grok", args: profile.args(c.ws), workspace: c.ws, env: { ...isolatedHome(DEFAULT_SETTINGS), GROK_HOME: grokHome }, timeoutSec: 90 });
        const init = await acp.initialize();
        c.log.note(`initialize -> ${JSON.stringify(init.error ?? { authMethods: init.result?.authMethods })}`);
        const ns = await acp.newSession();
        c.log.note(`session/new -> ${JSON.stringify(ns.error ?? { sessionId: ns.result?.sessionId ? "<present>" : null })}`);
        if (ns.result?.sessionId) {
            const r = await acp.prompt(ns.result.sessionId, "Reply with the single word: pong", 60_000);
            c.log.note(`session/prompt -> ${JSON.stringify(r.timeout ? "timeout" : (r.error ?? r.result))}`);
        }
        await acp.stop();
    },
};

const firstTool = (f: any) => f.method === "session/update" && /tool_call/.test(f.params?.update?.sessionUpdate ?? "");
const firstWords = (f: any) => f.method === "session/update" && f.params?.update?.sessionUpdate === "agent_message_chunk";
const GROK_STEER: Omit<SteerOpts, "trigger"> = {
    first: "Run the shell command `sleep 2` three times, one at a time, as three separate commands. After all three have finished, reply with one short sentence saying they finished.",
    steer: "Also, end your final reply with the word banana.",
    send: async (acp, sessionId, text) => {
        const r = await acp.request("_x.ai/interject", { sessionId, text }, 15_000);
        return { note: `_x.ai/interject -> ${JSON.stringify(r.error ?? r.result ?? "timeout")} in ${r.ms} ms` };
    },
    safeCommands: ["sleep 2"],
};

const cases: Record<string, () => Promise<void>> = {
    ...autoCases,
    controls: () =>
        controls(profile, [
            ...["plan", "default", "acceptEdits", "auto", "dontAsk", "bypassPermissions", "ask", "bogus-mode", "default"].map((modeId) => ({ label: `set_mode ${modeId}`, method: "session/set_mode", params: { modeId } })),
            { label: "set_config_option mode", method: "session/set_config_option", params: { configId: "mode", value: "plan" } },
            { label: "set_config_option reasoning_effort {value} (documented shape)", method: "session/set_config_option", params: { configId: "reasoning_effort", value: { value: "low" } } },
            { label: "set_config_option reasoning_effort bare string", method: "session/set_config_option", params: { configId: "reasoning_effort", value: "low" } },
            { label: "set_config_option model bare string", method: "session/set_config_option", params: { configId: "model", value: "grok-4.6" } },
            { label: "set_config_option model unknown", method: "session/set_config_option", params: { configId: "model", value: "nope-1" } },
            { label: "set_model (unstable ACP)", method: "session/set_model", params: { modelId: "grok-4.7" } },
            { label: "set_model unknown", method: "session/set_model", params: { modelId: "nope-1" } },
        ]),
    handshake: () =>
        handshake(profile, [
            { label: "_meta.yoloMode (not prompted)", params: { _meta: { yoloMode: true } } },
            { label: "_meta.autoMode (not prompted)", params: { _meta: { autoMode: true } } },
        ]),
    "bad-cwd": () => badCwd(profile),
    pong: async () => {
        await promptSeries(profile, "prompt-text", [{ label: "pong", text: "Reply with the single word: pong" }], { saveAs: "pong" });
    },
    "read-file": async () => {
        await promptSeries(profile, "read-file", [{ label: "read README.txt", text: "Read the file README.txt in the current directory and tell me the secret word it contains. Reply with just the word." }], { seedFiles: { "README.txt": "The secret word is: marmalade.\n" } });
    },
    // Default (ask) mode.
    permissions: async () => {
        await promptSeries(profile, "permissions-default", [
            { label: "(a) write allow_once", text: "Create a file named a.txt in the current directory containing exactly the text: a. Use your file write tool, not the shell. Do nothing else.", rules: [allow("write a.txt", writeTo("a.txt"))], files: ["a.txt"] },
            { label: "(b) shell allow_once", text: "Run exactly this shell command and nothing else: echo hi > out.txt", rules: [allow("echo", runs("echo hi > out.txt"))], safeCommands: ["echo hi > out.txt"], files: ["out.txt"] },
            { label: "(c) write reject_once", text: "Create a file named b.txt in the current directory containing exactly the text: b. Use your file write tool. If it is refused, do not retry; just say so.", rules: [reject("write b.txt", writeTo("b.txt"))], files: ["b.txt"] },
            { label: "(d) shell cancelled outcome", text: "Run exactly this shell command and nothing else: echo hi > out2.txt. If it is refused, do not retry; just say so.", rules: [cancelled("echo2", runs("echo hi > out2.txt"))], files: ["out2.txt"] },
        ]);
    },
    plan: async () => {
        await promptSeries(profile, "plan-mode", [{ label: "write in plan mode", text: "Create a file named plan-test.txt in the current directory containing exactly the text: x. Use your file write tool. If it is refused, do not retry; just say so.", files: ["plan-test.txt"] }], {
            before: async (c, acp, sessionId) => {
                const r = await acp.request("session/set_mode", { sessionId, modeId: "plan" });
                c.log.note(`set_mode plan -> ${JSON.stringify(r.error ?? r.result)}`);
            },
        });
    },
    // A deny rule given as a top-level flag before `agent`: the command must be refused without a permission request.
    "deny-rule": async () => {
        await promptSeries(profile, "deny-rule", [{ label: "denied shell command", text: "Run exactly this shell command and nothing else: echo hi > out.txt. If it is refused, do not retry; just say so.", files: ["out.txt"] }], { args: ["--deny", "Bash(echo *)", "agent", "--no-leader", "stdio"] });
    },
    // Rules through the (isolated) user-level ~/.claude/settings.json, which Grok imports without a folder-trust gate:
    // an ask rule on a read-only command (normally auto-approved) and a deny rule.
    "rules-file": async () => {
        const rules = { permissions: { defaultMode: "default", ask: ["Bash(ls*)"], deny: ["Bash(echo *)"] } };
        await promptSeries(
            profile,
            "rules-file",
            [{ label: "ask rule on ls, deny rule on echo", text: "Run the shell command `ls` on its own. After it finishes, run the shell command `echo hi > out.txt` on its own, as a separate command. If a command is refused, do not retry it; just say so.", rules: [allow("ls", runs("ls"))], safeCommands: ["ls"], files: ["out.txt"] }],
            { env: isolatedHome(rules), before: async (c) => c.log.note("isolated HOME has .claude/settings.json", rules) },
        );
    },
    close: () => closeCase(profile, (id) => ({ method: "session/set_config_option", params: { sessionId: id, configId: "reasoning_effort", value: "low" } })),
    // Follow-up: does an ACP-side setting force "ask" when the user's Claude settings say auto / bypassPermissions?
    "mode-override": async () => {
        const v = process.argv[3];
        const variants: Record<string, { settings: unknown; extraEnv?: Record<string, string>; newExtra?: Record<string, unknown>; setModeDefault?: boolean; topFlags?: string[]; action: "echo" | "note" }> = {
            "auto-allow-a": { settings: { permissions: { defaultMode: "auto", allow: ["Bash(echo *)"] } }, action: "echo" },
            "auto-a": { settings: { permissions: { defaultMode: "auto" } }, action: "note" },
            "auto-b": { settings: { permissions: { defaultMode: "auto" } }, setModeDefault: true, action: "note" },
            "auto-c": { settings: { permissions: { defaultMode: "auto" } }, newExtra: { _meta: { autoMode: false, yoloMode: false } }, action: "note" },
            "auto-f": { settings: { permissions: { defaultMode: "auto" } }, topFlags: ["--permission-mode", "default"], action: "note" },
            "bypass-a": { settings: { permissions: { defaultMode: "bypassPermissions" } }, action: "echo" },
            "bypass-b": { settings: { permissions: { defaultMode: "bypassPermissions" } }, setModeDefault: true, action: "echo" },
            "bypass-c": { settings: { permissions: { defaultMode: "bypassPermissions" } }, newExtra: { _meta: { autoMode: false, yoloMode: false } }, action: "echo" },
            "bypass-f": { settings: { permissions: { defaultMode: "bypassPermissions" } }, topFlags: ["--permission-mode", "default"], action: "echo" },
            "default-a": { settings: { permissions: { defaultMode: "default" } }, action: "note" },
            "auto-g": { settings: { permissions: { defaultMode: "auto" } }, extraEnv: { GROK_CONFIG: JSON.stringify({ ui: { permission_mode: "ask" } }) }, action: "note" },
        };
        const x = variants[v];
        if (!x) throw new Error(`variant? ${Object.keys(variants).join(", ")}`);
        const step =
            x.action === "echo"
                ? { label: `${v}: echo`, text: "Run exactly this shell command and nothing else: echo hi > out.txt", rules: [allow("echo", runs("echo hi > out.txt"))], safeCommands: ["echo hi > out.txt"], files: ["out.txt"] }
                : { label: `${v}: write note.txt`, text: "Create a file named note.txt in the current directory containing exactly the text: hi. Use your file write tool, not the shell. Do nothing else.", rules: [allow("write note.txt", writeTo("note.txt"))], files: ["note.txt"] };
        await promptSeries(profile, `mode-override-${v}`, [step], {
            env: { ...isolatedHome(x.settings), ...x.extraEnv },
            newExtra: x.newExtra,
            args: [...(x.topFlags ?? []), "agent", "--no-leader", "stdio"],
            before: async (c, acp, sessionId) => {
                c.log.note(`variant ${v}`, { claudeSettings: x.settings, extraEnv: x.extraEnv ?? null, newExtra: x.newExtra ?? null, setModeDefault: Boolean(x.setModeDefault), topFlags: x.topFlags ?? [] });
                if (x.setModeDefault) {
                    const r = await acp.request("session/set_mode", { sessionId, modeId: "default" });
                    await sleep(500);
                    c.log.note(`set_mode default -> ${JSON.stringify(r.error ?? r.result)}`);
                }
            },
            after: (c, acp) => c.log.note("mode/permission signals seen", modeSignals(acp.p.frames)),
        });
    },
    cancel: () => cancelCase(profile),
    resume: () => resumeCase(profile),
    concurrency: () => concurrency(profile),
    model: async () => {
        await promptSeries(profile, "set-model", [{ label: "prompt on the switched model", text: "Reply with the single word: model" }], {
            before: async (c, acp, sessionId) => {
                const r = await acp.request("session/set_config_option", { sessionId, configId: "model", value: process.env.PROBE_SWITCH_MODEL ?? "grok-4.6" });
                c.log.note(`model -> ${JSON.stringify(r.error ?? r.result?.configOptions?.map((o: any) => `${o.id}=${o.currentValue}`))}`);
            },
        });
    },
    image: async () => {
        await promptSeries(profile, "image", [{ ...IMAGE_STEP, blocks: [{ type: "image", mimeType: "image/png", data: RED_PNG }] }]);
    },
    // Steering (2 prompts each): _x.ai/interject mid-turn. Its only commands are `sleep 2`, allowed if asked.
    steer: () => steerCase(profile, "steer", { ...GROK_STEER, trigger: firstTool }),
    // The interjection as the answer is being written (no tool step left): joins it, or runs after?
    "steer-late": () => steerCase(profile, "steer-late", { ...GROK_STEER, first: "Reply with the single word: alpha. Do not use any tools.", trigger: firstWords, watchMs: 20_000 }),
    // Esc right after an interjection: does it still run?
    "steer-cancel": () => steerCase(profile, "steer-cancel", { ...GROK_STEER, trigger: firstTool, cancelAfterMs: 300, watchMs: 15_000 }),
    // Does the live stream say when an interjection is taken (its persisted updates.jsonl has a user_message_chunk
    // with _meta.interjection)? (a) one taken mid-turn; (b) one sent during a model call, then Esc; then a prompt
    // asking what it was sent, and the persisted record. 3 prompts, `sleep 2` only.
    "steer-taken": async () => {
        const c = ctx(profile, "steer-taken");
        const acp = new Acp(c.log, { cli: "grok", args: profile.args(c.ws), workspace: c.ws, env: profile.env, sandbox: true, timeoutSec: 300, safeCommands: ["sleep 2"] });
        acp.rules = [allow("sleep 2", runs("sleep 2"), false)];
        const { sessionId } = await open(c, acp);
        // Inbound frames since `from` that could say an interjection was taken: anything naming it but its echo, a
        // user_message_chunk, or an `interjection` in _meta.
        const signals = (from: number, text: string) =>
            acp.p.frames
                .slice(from)
                .filter((f) => f.method && f.method !== "_x.ai/session/interjection" && (JSON.stringify(f).includes(text) || f.params?.update?.sessionUpdate === "user_message_chunk" || /"interjection"/.test(JSON.stringify(f))))
                .map((f) => ({ method: f.method, update: f.params?.update?.sessionUpdate, meta: f.params?.update?._meta ?? f.params?._meta }));
        const done = (f: any) => f.method === "session/update" && f.params?.update?.sessionUpdate === "tool_call_update" && f.params.update.status === "completed";
        const run = async (label: string, first: string, trigger: (f: any) => boolean, steer: string, cancelAfterMs?: number) => {
            const from = acp.p.frames.length;
            const t0 = Date.now();
            const a = acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text: first }] });
            c.log.note(`${label}: trigger seen ${Boolean(await acp.p.waitFor(trigger, 120_000, from))} after ${Date.now() - t0} ms`);
            const at = acp.p.frames.length;
            const r = await acp.request("_x.ai/interject", { sessionId, text: steer }, 15_000);
            c.log.note(`${label}: _x.ai/interject -> ${JSON.stringify(r.error ?? r.result ?? "timeout")} after ${Date.now() - t0} ms`);
            if (cancelAfterMs !== undefined) {
                await sleep(cancelAfterMs);
                acp.notify("session/cancel", { sessionId });
                c.log.note(`${label}: session/cancel after ${Date.now() - t0} ms`);
            }
            const ra = await acp.response(a, 180_000, from);
            await sleep(3000);
            const s = acp.summarize(at);
            c.log.note(`${label}: answered ${JSON.stringify(ra?.result?.stopReason ?? ra?.error ?? "timeout")} after ${Date.now() - t0} ms`, { takenSignals: signals(at, steer), kindsAfterInterject: s.kinds, text: s.text });
        };
        await run("(a) interject while a tool runs, let it be taken", GROK_STEER.first, firstTool, "Also, end your final reply with the code word KIWI7731.");
        await run("(b) interject during a model call, Esc 400 ms later", "Run the shell command `sleep 2` three times, one at a time, as three separate commands. Then reply with one short sentence.", done, "Also, end your final reply with the code word MANGO4419.", 400);
        await turn(c, acp, sessionId, "Without using any tools, list every message I have sent you in this conversation, verbatim, one per line, oldest first. Include any sent while you were working.", "(c) what it was sent");
        // Its persisted record of the session (GROK_HOME is the real ~/.grok): what it says it took.
        const file = join(HOME, ".grok/sessions", encodeURIComponent(c.ws), sessionId, "updates.jsonl");
        const persisted = existsSync(file)
            ? readFileSync(file, "utf8")
                  .split("\n")
                  .filter((l) => l.includes("user_message_chunk"))
                  .map((l) => JSON.parse(l).params?.update)
                  .map((u: any) => ({ meta: u?._meta, contentMeta: u?.content?._meta, text: String(u?.content?.text ?? "").slice(0, 160) }))
            : `no ${file}`;
        c.log.note("persisted updates.jsonl user_message_chunks", { persisted });
        await acp.stop();
    },
    // When is an interjection's line in its updates.jsonl: by the next model call's first chunk, by a cancelled
    // prompt's answer (Cavvy's hand-back on Esc), and is that what's there 3 s later? And which folder holds a
    // session opened on a cwd spelled through /tmp, or with odd characters (no prompt)? 3 prompts, `sleep 2` only.
    "steer-file": async () => {
        const c = ctx(profile, "steer-file");
        const acp = new Acp(c.log, { cli: "grok", args: profile.args(c.ws), workspace: c.ws, env: profile.env, sandbox: true, timeoutSec: 300, safeCommands: ["sleep 2"] });
        acp.rules = [allow("sleep 2", runs("sleep 2"), false)];
        const { sessionId } = await open(c, acp);
        const root = join(HOME, ".grok/sessions");
        const folderOf = (id: string) => readdirSync(root).find((d) => existsSync(join(root, d, id)));
        c.log.note("folder after session/new (no prompt yet)", { folder: folderOf(sessionId) ?? null, encoded: encodeURIComponent(c.ws) });
        const odd = join(c.ws, "a b+c%d(e)~é'!*");
        mkdirSync(odd);
        for (const cwd of [c.ws.replace(/^\/private/, ""), odd]) {
            const r = await acp.request("session/new", { cwd, mcpServers: [] });
            await sleep(500);
            const id = r.result?.sessionId;
            c.log.note("session/new on another spelling", { cwd, folder: id ? (folderOf(id) ?? null) : r.error, encoded: encodeURIComponent(cwd), encodedReal: encodeURIComponent(realpathSync(cwd)) });
        }
        const count = (file: string, text: string) => {
            try {
                return readFileSync(file, "utf8").split("\n").filter((l) => l.includes('"interjection":true') && l.includes(text)).length;
            } catch {
                return -1;
            }
        };
        const done = (f: any) => f.method === "session/update" && f.params?.update?.sessionUpdate === "tool_call_update" && f.params.update.status === "completed";
        const chunk = (f: any) => f.method === "session/update" && /^agent_(thought|message)_chunk$/.test(f.params?.update?.sessionUpdate ?? "");
        const run = async (label: string, first: string, trigger: (f: any) => boolean, steer: string, esc: { afterMs?: number; when?: (f: any) => boolean }) => {
            const from = acp.p.frames.length;
            const a = acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text: first }] });
            c.log.note(`${label}: trigger seen ${Boolean(await acp.p.waitFor(trigger, 120_000, from))}`);
            const folder = folderOf(sessionId);
            const file = folder ? join(root, folder, sessionId, "updates.jsonl") : "";
            let seen = false;
            const poll = setInterval(() => !seen && count(file, steer) > 0 && ((seen = true), c.log.note(`${label}: interjection line on disk`)), 20);
            const ack = acp.p.frames.length;
            const r = await acp.request("_x.ai/interject", { sessionId, text: steer }, 15_000);
            c.log.note(`${label}: _x.ai/interject -> ${JSON.stringify(r.error ?? r.result ?? "timeout")}; line on disk: ${count(file, steer)}`);
            const cancel = (why: string) => (c.log.note(`${label}: session/cancel (${why}); line on disk: ${count(file, steer)}`), acp.notify("session/cancel", { sessionId }));
            if (esc.when) await acp.p.waitFor((f) => Boolean(esc.when!(f) && (cancel(f.params?.update?.sessionUpdate ?? f.method), true)), 120_000, ack);
            else if (esc.afterMs !== undefined) (await sleep(esc.afterMs), cancel(`${esc.afterMs} ms after the ack`));
            let atAnswer = -2;
            const ra = await acp.p.waitFor((f) => f.id === a && !f.method && ("result" in f || "error" in f) && ((atAnswer = count(file, steer)), true), 180_000, from);
            c.log.note(`${label}: answered ${JSON.stringify(ra?.result?.stopReason ?? ra?.error ?? "timeout")}; line on disk at its arrival: ${atAnswer}`);
            await sleep(3000);
            clearInterval(poll);
            c.log.note(`${label}: 3 s later, line on disk: ${count(file, steer)}`, { kindsAfterInterject: acp.summarize(ack).kinds });
        };
        // (a) Taken after the answer, with no tool between: Esc at the next model call's first chunk.
        let ended = false;
        await run("(a) interject as the answer is written, Esc at the next call's first chunk", "Reply with the single word: alpha. Do not use any tools.", firstWords, "Also, end your final reply with the word PLUM8830.", {
            when: (f) => (f.method === "_x.ai/session_notification" && f.params?.update?.sessionUpdate === "response_completed" ? ((ended = true), false) : ended && chunk(f)),
        });
        // (b) Sent during a model call, Esc 400 ms later: dropped.
        await run("(b) interject during a model call, Esc 400 ms later", "Run the shell command `sleep 2` three times, one at a time, as three separate commands. Then reply with one short sentence.", done, "Also, end your final reply with the word FIG2207.", { afterMs: 400 });
        // (c) Sent while a tool runs, Esc the moment that tool's completion arrives: taken or not, by a hair.
        await run("(c) interject while a tool runs, Esc as it completes", GROK_STEER.first, firstTool, "Also, end your final reply with the word PEAR5521.", { when: done });
        await acp.stop();
    },
    // Is a cancelled prompt's turn_completed line (prompt_id: the answer's _meta.promptId) in updates.jsonl always
    // after that turn's interjection lines, and how long after the answer does it reach disk? Esc in two races: as a
    // tool completes, and as the answer's model call completes. 2 prompts, `sleep 2` only.
    "steer-marker": async () => {
        const c = ctx(profile, "steer-marker");
        const acp = new Acp(c.log, { cli: "grok", args: profile.args(c.ws), workspace: c.ws, env: profile.env, sandbox: true, timeoutSec: 240, safeCommands: ["sleep 2"] });
        acp.rules = [allow("sleep 2", runs("sleep 2"), false)];
        const { sessionId } = await open(c, acp);
        const root = join(HOME, ".grok/sessions");
        const folder = readdirSync(root).find((d) => existsSync(join(root, d, sessionId)));
        const file = join(root, folder ?? "none", sessionId, "updates.jsonl");
        const lines = () => (existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []);
        const run = async (label: string, first: string, trigger: (f: any) => boolean, steer: string, escWhen: (f: any) => boolean) => {
            const from = acp.p.frames.length;
            const a = acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text: first }] });
            c.log.note(`${label}: trigger seen ${Boolean(await acp.p.waitFor(trigger, 120_000, from))}`);
            const ack = acp.p.frames.length;
            await acp.request("_x.ai/interject", { sessionId, text: steer }, 15_000);
            await acp.p.waitFor((f) => escWhen(f) && (acp.notify("session/cancel", { sessionId }), true), 120_000, ack);
            const ra = await acp.response(a, 180_000, from);
            const t0 = Date.now();
            const promptId = ra?.result?._meta?.promptId;
            const at = (ls: string[], test: (l: string) => boolean) => ls.findIndex(test);
            const isMarker = (l: string) => l.includes('"turn_completed"') && l.includes(`"prompt_id":"${promptId}"`);
            const isLine = (l: string) => l.includes('"interjection":true') && l.includes(steer);
            const atAnswer = lines();
            let markerMs: number | undefined;
            while (Date.now() - t0 < 3000) {
                if (markerMs === undefined && lines().some(isMarker)) markerMs = Date.now() - t0;
                await sleep(5);
            }
            const ls = lines();
            c.log.note(`${label}: answered ${JSON.stringify(ra?.result?.stopReason)}`, {
                atAnswer: { marker: atAnswer.some(isMarker), interjection: atAnswer.some(isLine) },
                markerOnDiskMsAfterAnswer: markerMs ?? null,
                after3s: { markerIndex: at(ls, isMarker), interjectionIndex: at(ls, isLine), lines: ls.length },
            });
        };
        const done = (f: any) => f.method === "session/update" && f.params?.update?.sessionUpdate === "tool_call_update" && f.params.update.status === "completed";
        const responded = (f: any) => f.method === "_x.ai/session_notification" && f.params?.update?.sessionUpdate === "response_completed";
        await run("(1) interject while a tool runs, Esc as it completes", GROK_STEER.first, firstTool, "Also, end your final reply with the word LIME3104.", done);
        await run("(2) interject as the answer is written, Esc as its model call completes", "Reply with the single word: alpha. Do not use any tools.", firstWords, "Also, end your final reply with the word DATE6612.", responded);
        await acp.stop();
    },
    // No prompt: what Grok's queue methods (its TUI's steer: a queued prompt promoted to a mid-turn interjection) take,
    // from its answers to calls with nothing queued.
    "steer-params": async () => {
        const c = ctx(profile, "steer-params", { maxArray: 8, maxString: 600 });
        const acp = start(c, { timeoutSec: 90 });
        const { sessionId } = await open(c, acp, { model: false });
        await sleep(1500);
        const id = "00000000-0000-4000-8000-0000000000aa";
        const calls: [string, Record<string, unknown>][] = [
            ["_x.ai/queue/interject", {}],
            ["_x.ai/queue/interject", { id }],
            ["_x.ai/queue/interject", { entryId: id }],
            ["_x.ai/queue/interject", { id, expectedVersion: 0 }],
            ["_x.ai/interject", {}],
            ["_x.ai/queue/remove", {}],
            ["_x.ai/queue/remove", { id }],
            ["_x.ai/queue/clear", {}],
            ["_x.ai/queue/edit", {}],
            ["x.ai/queue/interject", { id }],
            // The one it has: text, mid-turn. With nothing running, and an unknown field (to see what it takes).
            ["_x.ai/interject", { text: "Reply with the single word: idle", zz: 1 }],
            ["_x.ai/interject", { text: "Reply with the single word: idle" }],
        ];
        for (const [method, params] of calls) {
            const from = acp.p.frames.length;
            const r = await acp.request(method, { sessionId, ...params }, 15_000);
            await sleep(500);
            c.log.note(`${method} ${JSON.stringify(params)} -> ${r.timeout ? "timeout" : JSON.stringify(r.error ?? r.result)}`, { after: acp.summarize(from).kinds });
        }
        await acp.stop();
    },
    // No prompt: does the ACP session start in Claude's defaultMode ("auto") when ~/.claude is visible?
    "mode-source": async () => {
        const c = ctx(profile, "mode-source");
        for (const [label, env] of [["real HOME (reads ~/.claude/settings.json)", {}], ["isolated HOME", profile.env!]] as const) {
            const acp = start(c, { env: env as Record<string, string>, timeoutSec: 60 });
            const { sessionId } = await open(c, acp, { model: false });
            await sleep(1500);
            const modeUpdates = acp.p.frames.filter((f) => f.params?.update?.sessionUpdate === "current_mode_update").map((f) => f.params.update.currentModeId);
            c.log.note(`${label}: current_mode_update before any set_mode: ${JSON.stringify(modeUpdates)}`);
            for (const modeId of ["default", "plan", "default"]) {
                const from = acp.p.frames.length;
                await acp.request("session/set_mode", { sessionId, modeId });
                await sleep(700);
                const u = acp.p.frames.slice(from).filter((f) => f.params?.update?.sessionUpdate === "current_mode_update").map((f) => f.params.update.currentModeId);
                c.log.note(`${label}: set_mode ${modeId} -> current_mode_update ${JSON.stringify(u)}`);
            }
            await acp.stop();
        }
    },
};

const name = process.argv[2];
if (!name || !cases[name]) throw new Error(`case? ${Object.keys(cases).join(", ")}`);
await cases[name]();
