// ACP probes for OpenCode (`opencode acp`). One case per run:
//   bun scripts/probes/acp-opencode.ts <case>
// OpenCode's default agent allows every tool without asking, so every run a model drives sets the
// process-level permission config below ("ask" for everything but reads inside the folder).
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubAlso } from "./lib";
import { type Profile, type SteerOpts, steerCase, closeCase, handshake, badCwd, controls, promptSeries, cancelCase, concurrency, resumeCase, allow, reject, cancelled, writeTo, runs, RED_PNG, IMAGE_STEP } from "./acp-cases";

/** Every permission asks, except reads, searches and todos; external_directory asks too. */
export const ASK_ALL = JSON.stringify({ permission: { "*": "ask", read: "allow", glob: "allow", grep: "allow", list: "allow", todowrite: "allow" } });

const profile: Profile = {
    cli: "opencode",
    version: "1.19.4",
    args: (ws) => ["acp", "--cwd", ws],
    env: { OPENCODE_CONFIG_CONTENT: ASK_ALL },
    // The default model (opencode/big-pickle) is a free one on OpenCode Zen.
    prep: async (acp, sessionId) => (process.env.PROBE_OPENCODE_MODEL ? acp.request("session/set_model", { sessionId, modelId: process.env.PROBE_OPENCODE_MODEL }) : {}),
};

const firstTool = (f: any) => f.method === "session/update" && /tool_call/.test(f.params?.update?.sessionUpdate ?? "") && f.params.update.status === "in_progress";
const firstWords = (f: any) => f.method === "session/update" && f.params?.update?.sessionUpdate === "agent_message_chunk";
const OPENCODE_STEER: Omit<SteerOpts, "trigger"> = {
    // Three different commands: the same one three times trips its doom_loop ask (refused: an error answers both
    // prompts, opencode-1.19.4-steer-error.jsonl).
    first: "Run these three shell commands one at a time, each as its own tool call, waiting for each to finish before starting the next: `sleep 2`, then `echo one > one.txt`, then `echo two > two.txt`. After all three have finished, reply with one short sentence saying they finished.",
    steer: "Also, end your final reply with the word banana.",
    send: async (acp, sessionId, text) => ({ id: acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text }] }), note: "session/prompt" }),
    safeCommands: ["sleep 2", "echo one > one.txt", "echo two > two.txt"],
};

const cases: Record<string, () => Promise<void>> = {
    controls: () =>
        controls(profile, [
            { label: "set_mode plan", method: "session/set_mode", params: { modeId: "plan" } },
            { label: "set_config_option model (shows mode after set_mode)", method: "session/set_config_option", params: { configId: "model", value: "opencode/gpt-5-nano" } },
            { label: "set_config_option effort=low", method: "session/set_config_option", params: { configId: "effort", value: "low" } },
            { label: "set_config_option mode=build", method: "session/set_config_option", params: { configId: "mode", value: "build" } },
            { label: "set_config_option mode=plan (object value)", method: "session/set_config_option", params: { configId: "mode", value: { value: "plan" } } },
            { label: "set_mode bogus", method: "session/set_mode", params: { modeId: "bogus-mode" } },
            { label: "set_model", method: "session/set_model", params: { modelId: "opencode/big-pickle" } },
            { label: "set_model unknown", method: "session/set_model", params: { modelId: "opencode/nope-1" } },
            { label: "set_config_option unknown id", method: "session/set_config_option", params: { configId: "reasoning_effort", value: "low" } },
        ]),
    handshake: () => handshake(profile),
    // Safety gate: with the ask config, a write must produce session/request_permission before any other prompt runs.
    "ask-check": async () => {
        await promptSeries(profile, "ask-check", [{ label: "write with edit=ask", text: "Create a file named hello.txt in the current directory containing exactly the text: hi. Use your file write tool, not the shell. Do nothing else.", rules: [allow("write hello.txt", writeTo("hello.txt"))], files: ["hello.txt"] }]);
    },
    pong: async () => {
        await promptSeries(profile, "prompt-text", [{ label: "pong", text: "Reply with the single word: pong" }], { saveAs: "pong" });
    },
    "read-file": async () => {
        await promptSeries(profile, "read-file", [{ label: "read README.txt", text: "Read the file README.txt in the current directory and tell me the secret word it contains. Reply with just the word." }], { seedFiles: { "README.txt": "The secret word is: marmalade.\n" } });
    },
    permissions: async () => {
        await promptSeries(profile, "permissions-ask", [
            { label: "(a) shell allow_once", text: "Run exactly this shell command and nothing else: echo hi > out.txt", rules: [allow("echo", runs("echo hi > out.txt"))], safeCommands: ["echo hi > out.txt"], files: ["out.txt"] },
            { label: "(b) write reject_once", text: "Create a file named b.txt in the current directory containing exactly the text: b. Use your file write tool. If it is refused, do not retry; just say so.", rules: [reject("write b.txt", writeTo("b.txt"))], files: ["b.txt"] },
            { label: "(c) shell cancelled outcome", text: "Run exactly this shell command and nothing else: echo hi > out2.txt. If it is refused, do not retry; just say so.", rules: [cancelled("echo2", runs("echo hi > out2.txt"))], files: ["out2.txt"] },
        ]);
    },
    // Default config (no ask): only a file creation inside the temp folder, per the safety rules.
    "default-noask": async () => {
        await promptSeries(profile, "default-noask", [{ label: "write with the default permissions", text: "Create a file named hello.txt in the current directory containing exactly the text: hi. Use your file write tool, not the shell. Do nothing else.", files: ["hello.txt"] }], { env: {} });
    },
    plan: async () => {
        await promptSeries(profile, "plan-mode", [{ label: "write in plan mode", text: "Create a file named plan-test.txt in the current directory containing exactly the text: x. Use your file write tool. If it is refused, do not retry; just say so.", files: ["plan-test.txt"] }], {
            before: async (c, acp, sessionId) => {
                const r = await acp.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" });
                c.log.note(`mode -> plan: ${JSON.stringify(r.error ?? r.result?.configOptions?.map((o: any) => `${o.id}=${o.currentValue}`))}`);
            },
        });
    },
    close: () => closeCase(profile, (id) => ({ method: "session/set_config_option", params: { sessionId: id, configId: "mode", value: "plan" } })),
    // Follow-up: does the inline ask config win over allow-all user / project configs; does agent.plan.permission keep plan from asking?
    precedence: async () => {
        const v = process.argv[3];
        const ALLOW_ALL = { permission: { bash: "allow", edit: "allow", "*": "allow" } };
        const ASK = { "*": "ask", edit: "ask", bash: "ask", webfetch: "ask", websearch: "ask", external_directory: "ask", task: "ask", read: "allow", glob: "allow", grep: "allow", list: "allow", todowrite: "allow", todoread: "allow" };
        const userAllowHome = () => {
            const dir = realpathSync(mkdtempSync(join("/tmp", "acp-xdg-")));
            scrubAlso(dir, "/tmp/acp-xdg");
            mkdirSync(join(dir, "opencode"));
            writeFileSync(join(dir, "opencode/opencode.json"), JSON.stringify(ALLOW_ALL));
            return dir;
        };
        const echo = { text: "Run exactly this shell command and nothing else: echo hi > out.txt", rules: [allow("echo", runs("echo hi > out.txt"))], safeCommands: ["echo hi > out.txt"], files: ["out.txt"] };
        const note = { text: "Create a file named note.txt in the current directory containing exactly the text: hi. Use your file write tool, not the shell. Do nothing else.", rules: [allow("write note.txt", writeTo("note.txt"))], files: ["note.txt"] };
        const planNote = { text: "Use your file write tool to create a file named note.txt in the current directory containing exactly the text: hi. Make the write tool call even if you expect it to be blocked, and do not use the shell. If it is refused, do not retry; just say so.", rules: [reject("write note.txt (plan: always reject)", writeTo("note.txt"))], files: ["note.txt"] };
        const toPlan = async (c: any, acp: any, sessionId: string) => {
            const r = await acp.request("session/set_config_option", { sessionId, configId: "mode", value: "plan" });
            c.log.note(`mode -> plan: ${JSON.stringify(r.error ?? r.result?.configOptions?.map((o: any) => `${o.id}=${o.currentValue}`))}`);
        };
        const variants: Record<string, () => { env: Record<string, string>; seed?: Record<string, string>; steps: any[]; before?: any }> = {
            // user config (XDG_CONFIG_HOME) allows everything; inline config asks
            "user-allow": () => ({ env: { XDG_CONFIG_HOME: userAllowHome(), OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: ASK }) }, steps: [{ label: "echo", ...echo }, { label: "write note.txt", ...note }] }),
            // project opencode.json allows everything; inline config asks
            "project-allow": () => ({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: ASK }) }, seed: { "opencode.json": JSON.stringify(ALLOW_ALL) }, steps: [{ label: "echo", ...echo }] }),
            "project-allow-disabled": () => ({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: ASK }), OPENCODE_DISABLE_PROJECT_CONFIG: "1" }, seed: { "opencode.json": JSON.stringify(ALLOW_ALL) }, steps: [{ label: "echo", ...echo }] }),
            // plan mode under the global ask config, with and without agent.plan.permission edit deny
            "plan-global-ask": () => ({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: ASK }) }, steps: [{ label: "plan write", ...planNote }], before: toPlan }),
            "plan-agent-deny": () => ({ env: { OPENCODE_CONFIG_CONTENT: JSON.stringify({ permission: ASK, agent: { plan: { permission: { edit: { "*": "deny", ".opencode/plans/*.md": "allow" } } } } }) }, steps: [{ label: "plan write", ...planNote }], before: toPlan }),
        };
        const mk = variants[v];
        if (!mk) throw new Error(`variant? ${Object.keys(variants).join(", ")}`);
        const x = mk();
        await promptSeries(profile, `precedence-${v}`, x.steps, {
            env: x.env,
            seedFiles: x.seed,
            before: async (c, acp, sessionId) => {
                c.log.note(`variant ${v}`, { env: x.env, projectFiles: x.seed ?? null });
                if (x.before) await x.before(c, acp, sessionId);
            },
        });
    },
    cancel: () => cancelCase(profile),
    resume: () => resumeCase(profile),
    concurrency: () => concurrency(profile),
    model: async () => {
        await promptSeries(profile, "set-model", [{ label: "prompt on the switched model", text: "Reply with the single word: model" }], {
            before: async (c, acp, sessionId) => {
                // A paid model (opencode/gpt-5-nano) failed with "Model access is disabled" on this account; a free one is used.
                const model = process.env.PROBE_SWITCH_MODEL ?? "opencode/deepseek-v4.1-flash-free";
                const r = await acp.request("session/set_config_option", { sessionId, configId: "model", value: model });
                const opts = r.result?.configOptions ?? [];
                const effort = opts.find((o: any) => o.id === "effort");
                c.log.note(`model -> ${model}: ${JSON.stringify(r.error ?? opts.map((o: any) => `${o.id}=${o.currentValue} [${o.id === "model" ? "..." : o.options?.map((x: any) => x.value).join("|")}]`))}`);
                if (effort) {
                    const e = await acp.request("session/set_config_option", { sessionId, configId: "effort", value: effort.options.some((x: any) => x.value === "low") ? "low" : effort.options[0].value });
                    c.log.note(`effort -> ${JSON.stringify(e.error ?? e.result?.configOptions?.map((o: any) => `${o.id}=${o.currentValue}`))}`);
                }
            },
        });
    },
    image: async () => {
        // The default (opencode/big-pickle) answers that it can't see images; a free vision model is used.
        await promptSeries(profile, "image", [{ ...IMAGE_STEP, blocks: [{ type: "image", mimeType: "image/png", data: RED_PNG }] }], {
            before: async (c, acp, sessionId) => {
                const r = await acp.request("session/set_model", { sessionId, modelId: process.env.PROBE_IMAGE_MODEL ?? "opencode/nemotron-3.5-super-vl-free" });
                c.log.note(`set_model (vision) -> ${JSON.stringify(r.error ?? r.result)}`);
            },
        });
    },
    // Steering (2 prompts each): a second session/prompt mid-turn. Its only commands are `sleep 2`, allowed when asked.
    steer: () => steerCase(profile, "steer", { ...OPENCODE_STEER, trigger: firstTool }),
    // As the answer is being written, with an image (run with PROBE_OPENCODE_MODEL=opencode/nemotron-3.5-super-vl-free).
    "steer-late": () =>
        steerCase(profile, "steer-late", {
            ...OPENCODE_STEER,
            first: "Reply with the single word: alpha. Do not use any tools.",
            steer: "Also, end your final reply with the colour of the attached image, as one word.",
            send: async (acp, sessionId, text) => ({ id: acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text }, { type: "image", mimeType: "image/png", data: RED_PNG }] }), note: "session/prompt with an image" }),
            trigger: firstWords,
            watchMs: 10_000,
        }),
    "steer-cancel": () => steerCase(profile, "steer-cancel", { ...OPENCODE_STEER, trigger: firstTool, cancelAfterMs: 300, watchMs: 10_000 }),
    "bad-cwd": () => badCwd(profile, ["acp", "--cwd", "<missing>"]),
};

const name = process.argv[2];
if (!name || !cases[name]) throw new Error(`case? ${Object.keys(cases).join(", ")}`);
await cases[name]();
