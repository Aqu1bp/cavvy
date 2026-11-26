// ACP probes for Antigravity's CLI (`agy acp`). One case per run:
//   bun scripts/probes/acp-agy.ts <case>
// Each case writes test/fixtures/protocol/agy-<version>-acp-<case>.jsonl.
//
// Safety, as the other ACP probes (acp-lib.ts): a fresh temp workspace, `sandbox-exec` denying writes outside it, agy's
// own folder (~/.gemini), the temp folders and /dev, a hard timeout, and permission requests allowed only for the exact
// commands and workspace paths a case asks for. The bypass case runs with --dangerously-skip-permissions: its prompts
// ask only for harmless commands, and the sandbox still holds every write.
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Acp } from "./acp-lib";
import { type Profile, allow, cancelCase, controls, ctx, handshake, IMAGE_STEP, open, promptSeries, RED_PNG, reject, resumeCase, runs, steerCase, turn, writeTo } from "./acp-cases";
import { scrubAlso, sleep } from "./lib";

const VERSION = (Bun.spawnSync(["agy", "--version"]).stdout.toString().trim().split(/\s+/).pop() ?? "x").replace(/[^\w.]/g, "");
const MODEL = process.env.AGY_MODEL ?? "gemini-4-neon";
const EFFORT = process.env.AGY_EFFORT ?? "medium";

const profile: Profile = {
    cli: "agy",
    version: `${VERSION}-acp`,
    args: () => ["acp"],
    prep: async (acp, sessionId) => {
        const m = await acp.request("session/set_config_option", { sessionId, configId: "model", value: MODEL });
        if (m.error) return m;
        return acp.request("session/set_config_option", { sessionId, configId: "thought_level", value: EFFORT });
    },
};

/** The same three harmless steps in each mode: a file write, a command that writes, and a read-only command. */
const STEPS = "Do these three steps in order, one tool call each. If a step is refused, note it and go on to the next:\n1. Create the file a.txt in this folder containing exactly: a. Use your file write tool, not the shell.\n2. Run exactly this shell command: echo b > b.txt\n3. Run exactly this shell command: ls\nThen reply with one line per step saying what happened.";
const SAFE = ["echo b > b.txt", "ls"];
const RULES = () => [allow("write a.txt", writeTo("a.txt")), allow("echo b", runs("echo b > b.txt")), allow("ls", runs("ls"))];

/** A session per mode, set with session/set_mode before the steps: which of them it asks about. */
async function modeCase(mode: string, args?: string[], name = `mode-${mode}`) {
    await promptSeries(profile, name, [{ label: `${mode}: three steps`, text: STEPS, rules: RULES(), safeCommands: SAFE, files: ["a.txt", "b.txt"] }], {
        ...(args ? { args } : {}),
        before: async (c, acp, sessionId) => {
            if (mode === "none") return;
            const r = await acp.request("session/set_mode", { sessionId, modeId: mode });
            c.log.note(`set_mode ${mode} -> ${JSON.stringify(r.error ?? r.result)}`);
        },
    });
}

const cases: Record<string, () => Promise<void>> = {
    handshake: () => handshake(profile),
    controls: () =>
        controls(profile, [
            { label: "set_mode accept-edits", method: "session/set_mode", params: { modeId: "accept-edits" } },
            { label: "set_mode auto", method: "session/set_mode", params: { modeId: "auto" } },
            { label: "set_mode plan", method: "session/set_mode", params: { modeId: "plan" } },
            { label: "set_mode default", method: "session/set_mode", params: { modeId: "default" } },
            { label: "set_mode bogus", method: "session/set_mode", params: { modeId: "yolo" } },
            { label: "set_config_option mode=auto", method: "session/set_config_option", params: { configId: "mode", value: "auto" } },
            { label: "set_config_option model (base id)", method: "session/set_config_option", params: { configId: "model", value: "gemini-4-neon" } },
            { label: "set_config_option model (agy models id, with effort)", method: "session/set_config_option", params: { configId: "model", value: "gemini-4-neon-medium" } },
            { label: "set_config_option thought_level=low", method: "session/set_config_option", params: { configId: "thought_level", value: "low" } },
            { label: "set_config_option model=gpt-oss-120b-medium", method: "session/set_config_option", params: { configId: "model", value: "gpt-oss-120b-medium" } },
            { label: "set_model", method: "session/set_model", params: { modelId: "gemini-4-argon" } },
        ]),
    "mode-default": () => modeCase("default"),
    "mode-accept-edits": () => modeCase("accept-edits"),
    "mode-auto": () => modeCase("auto"),
    "mode-plan": () => modeCase("plan"),
    // Started with --dangerously-skip-permissions, no set_mode.
    "mode-bypass": () => modeCase("none", ["acp", "--dangerously-skip-permissions"], "mode-bypass"),
    // The options it offers, and what allow_always and reject do for a call like it later.
    always: async () => {
        await promptSeries(profile, "always", [
            { label: "write c.txt, allow_always", text: "Create the file c.txt in this folder containing exactly: c. Use your file write tool. Do nothing else.", rules: [{ label: "always c.txt", match: writeTo("c.txt"), answer: "allow_always", once: true }], files: ["c.txt"] },
            { label: "write d.txt after an always", text: "Create the file d.txt in this folder containing exactly: d. Use your file write tool. Do nothing else.", rules: [allow("write d.txt", writeTo("d.txt"))], files: ["d.txt"] },
            { label: "echo e, allow_always", text: "Run exactly this shell command and nothing else: echo e > e.txt", rules: [{ label: "always echo e", match: runs("echo e > e.txt"), answer: "allow_always", once: true }], safeCommands: ["echo e > e.txt"], files: ["e.txt"] },
            { label: "echo e again", text: "Run exactly this shell command again and nothing else: echo e > e.txt", rules: [allow("echo e", runs("echo e > e.txt"))], safeCommands: ["echo e > e.txt"], files: ["e.txt"] },
            { label: "write f.txt, reject_once", text: "Create the file f.txt in this folder containing exactly: f. Use your file write tool. If it is refused, do not retry; just say so.", rules: [reject("write f.txt", writeTo("f.txt"))], files: ["f.txt"] },
        ]);
    },
    // Plan mode with a change to make, then default mode and "go ahead".
    plan: async () => {
        await promptSeries(
            profile,
            "plan",
            [
                { label: "plan: a change", text: "Add a file hello.txt in this folder containing exactly: hello. The folder is empty; don't run any commands to look.", rules: [allow("write hello.txt", writeTo("hello.txt"))], files: ["hello.txt"] },
                { label: "default: go ahead", text: "Go ahead and make the change now.", rules: [allow("write hello.txt", writeTo("hello.txt"))], files: ["hello.txt"] },
            ],
            {
                before: async (c, acp, sessionId) => {
                    const r = await acp.request("session/set_mode", { sessionId, modeId: "plan" });
                    c.log.note(`set_mode plan -> ${JSON.stringify(r.error ?? r.result)}`);
                    // Switch to default after the first prompt.
                    const id = setInterval(async () => {
                        if (acp.permissionLog.length || acp.p.frames.some((f) => f.result?.stopReason)) {
                            clearInterval(id);
                            const d = await acp.request("session/set_mode", { sessionId, modeId: "default" });
                            c.log.note(`set_mode default -> ${JSON.stringify(d.error ?? d.result)}`);
                        }
                    }, 200);
                },
            },
        );
    },
    // session/set_mode while a prompt runs: auto, then default once its first command runs. Does the next command ask?
    "mode-midturn": async () => {
        await promptSeries(
            profile,
            "mode-midturn",
            [{ label: "auto, then default mid-turn", text: "Run these two shell commands one at a time, each as its own tool call: `sleep 4`, then `echo x > x.txt`. Then say done.", rules: [allow("sleep 4", runs("sleep 4")), allow("echo x", runs("echo x > x.txt"))], safeCommands: ["sleep 4", "echo x > x.txt"], files: ["x.txt"] }],
            {
                before: async (c, acp, sessionId) => {
                    const r = await acp.request("session/set_mode", { sessionId, modeId: "auto" });
                    c.log.note(`set_mode auto -> ${JSON.stringify(r.error ?? r.result)}`);
                    const from = acp.p.frames.length;
                    void acp.p.waitFor((f) => f.method === "session/update" && /tool_call/.test(f.params?.update?.sessionUpdate ?? "") && f.params.update.status === "in_progress", 120_000, from).then(async (hit) => {
                        if (!hit) return;
                        const d = await acp.request("session/set_mode", { sessionId, modeId: "default" });
                        c.log.note(`set_mode default mid-turn -> ${JSON.stringify(d.error ?? d.result)}`);
                    });
                },
            },
        );
    },
    pong: async () => {
        await promptSeries(profile, "pong", [{ label: "pong", text: "Reply with the single word: pong" }], { saveAs: "pong" });
    },
    // Its own /compact (listed in available_commands_update) sent as a prompt, with and without instructions: what it
    // says and sends, and whether it still knows what came before.
    compact: async () => {
        await promptSeries(profile, "compact", [
            { label: "remember", text: "Remember the secret word walnut. Reply with only: ok" },
            { label: "/compact", text: "/compact" },
            { label: "/compact with instructions", text: "/compact Keep the secret word." },
            { label: "recall", text: "What was the secret word? Reply with only the word." },
        ]);
    },
    resume: () => resumeCase(profile),
    cancel: () => cancelCase(profile),
    image: async () => {
        await promptSeries(profile, "image", [{ ...IMAGE_STEP, blocks: [{ type: "image", mimeType: "image/png", data: RED_PNG }] }]);
    },
    // A PDF as an embedded resource (its initialize says embeddedContext), and a text file as one.
    pdf: async () => {
        await promptSeries(profile, "pdf", [
            { label: "pdf resource", text: "What is the secret word in the attached PDF? Reply with just the word.", blocks: [{ type: "resource", resource: { uri: "file:///attachments/secret.pdf", mimeType: "application/pdf", blob: Buffer.from(tinyPdf("The secret word is marmalade.")).toString("base64") } }] },
            { label: "text resource", text: "What is the secret word in the attached notes.txt? Reply with just the word.", blocks: [{ type: "resource", resource: { uri: "file:///attachments/notes.txt", mimeType: "text/plain", text: "The secret word is quince.\n" } }] },
            // A file outside the workspace, linked: does it read it, and does it ask first?
            { label: "pdf resource_link", text: "What is the secret word in the attached PDF? Reply with just the word.", rules: [allow("read the pdf", (q) => q.command === undefined && q.paths.some((p) => p.endsWith("/linked.pdf")))], blocks: [{ type: "resource_link", uri: `file://${PDF_FILE}`, name: "linked.pdf", mimeType: "application/pdf" }] },
        ]);
    },
    // A second session/prompt while the first runs a command.
    steer: () =>
        steerCase(profile, "steer", {
            first: "Run these three shell commands one at a time, each as its own tool call, waiting for each to finish before starting the next: `sleep 2`, then `echo one > one.txt`, then `echo two > two.txt`. After all three have finished, reply with one short sentence saying they finished.",
            trigger: (f) => f.method === "session/update" && /tool_call/.test(f.params?.update?.sessionUpdate ?? "") && f.params.update.status === "in_progress",
            steer: "Also, end your final reply with the word banana.",
            send: async (acp, sessionId, text) => ({ id: acp.fire("session/prompt", { sessionId, prompt: [{ type: "text", text }] }), note: "session/prompt" }),
            safeCommands: ["sleep 2", "echo one > one.txt", "echo two > two.txt"],
        }),
    // A conversation headless `agy -p` started, loaded over ACP (sessions Cavvy started headless before).
    "headless-load": async () => {
        const c = ctx(profile, "headless-load");
        const run = Bun.spawnSync(["perl", "-e", "alarm shift; exec @ARGV", "120", "agy", "-p", "Reply with the single word: kiwi", "--model", `${MODEL}-${EFFORT}`, "--output-format", "json"], { cwd: c.ws });
        const out = run.stdout.toString();
        const id = /"conversation_id"\s*:\s*"([0-9a-f-]{36})"/.exec(out)?.[1];
        c.log.note(`headless agy -p -> exit ${run.exitCode}; conversation ${id ? "found" : "not found"}`);
        if (!id) return;
        const acp = new Acp(c.log, { cli: "agy", args: profile.args(c.ws), workspace: c.ws, sandbox: true, timeoutSec: 240 });
        acp.track(id);
        await acp.initialize();
        const from = acp.p.frames.length;
        const r = await acp.request("session/load", { sessionId: id, cwd: c.ws, mcpServers: [] });
        await sleep(1500);
        c.log.note(`session/load of the headless conversation -> ${r.error ? JSON.stringify(r.error) : "ok"}`, { kinds: acp.summarize(from).kinds });
        if (!r.error) {
            await profile.prep(acp, id);
            await turn(c, acp, id, "What single word did you reply with in your previous answer? Reply with just that word.", "prompt after load");
        }
        await acp.stop();
    },
    // Cavvy's MCP server goes over HTTP, which its initialize doesn't list: does it connect to one given in session/new,
    // with the header, and how does a call of its tool look (its ask, its tool_call)?
    "mcp-http": async () => {
        const c = ctx(profile, "mcp-http");
        const seen: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1",
            port: 0,
            async fetch(req) {
                const auth = req.headers.get("authorization") === "Bearer probe-token" ? "auth ok" : "auth missing";
                if (req.method !== "POST") return new Response(null, { status: 405 });
                const m = (await req.json()) as any;
                seen.push(`${m.method ?? "response"} (${auth})${m.method === "tools/call" ? ` ${JSON.stringify(m.params)}` : ""}`);
                if (m.id === undefined) return new Response(null, { status: 202 });
                const result =
                    m.method === "initialize"
                        ? { protocolVersion: m.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "probe", version: "0.0.0" } }
                        : m.method === "tools/list"
                          ? { tools: [{ name: "probe_echo", description: "Answers with the word it's given. Call it when asked to echo a word.", inputSchema: { type: "object", properties: { word: { type: "string" } }, required: ["word"] } }] }
                          : m.method === "tools/call"
                            ? { content: [{ type: "text", text: `echo-${m.params?.arguments?.word ?? ""}` }] }
                            : {};
                return Response.json({ jsonrpc: "2.0", id: m.id, result });
            },
        });
        const acp = new Acp(c.log, { cli: "agy", args: profile.args(c.ws), workspace: c.ws, sandbox: true, timeoutSec: 240 });
        await acp.initialize();
        const r = await acp.newSession({ mcpServers: [{ type: "http", name: "probe", url: `http://127.0.0.1:${server.port}/mcp`, headers: [{ name: "Authorization", value: "Bearer probe-token" }] }] });
        const sessionId = r.result?.sessionId;
        await sleep(3000);
        c.log.note(`session/new with an http MCP server -> ${r.error ? JSON.stringify(r.error) : "ok"}; server saw: ${JSON.stringify(seen)}`);
        if (sessionId) {
            await profile.prep(acp, sessionId);
            acp.rules = [{ label: "mcp tool", match: (q) => q.command === undefined && !q.paths.length, answer: "allow_once", once: false }];
            await turn(c, acp, sessionId, "Call the probe_echo tool from the probe MCP server with the word kiwi, then reply with exactly what it returned.", "call the MCP tool");
            c.log.note(`server saw: ${JSON.stringify(seen)}`, { perms: acp.permissionLog.map((p) => ({ answer: p.answer, title: p.req.params?.toolCall?.title, kind: p.req.params?.toolCall?.kind, raw: p.req.params?.toolCall?.rawInput, options: p.req.params?.options })) });
        }
        await acp.stop();
        server.stop(true);
    },
};

/** A PDF outside the workspace (in the temp folder the sandbox lets it write), for the resource_link step. */
const PDF_FILE = (() => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "acp-agy-attach-")));
    scrubAlso(dir, "/tmp/acp-agy-attach");
    const file = join(dir, "linked.pdf");
    writeFileSync(file, tinyPdf("The secret word is persimmon."));
    return file;
})();

/** A one-page PDF with a line of text. */
function tinyPdf(text: string): string {
    const stream = `BT /F1 18 Tf 50 750 Td (${text}) Tj ET`;
    const objs = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    objs.forEach((o, i) => {
        offsets.push(out.length);
        out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = out.length;
    out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    return `${out}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
}

const name = process.argv[2];
const run = name ? cases[name] : undefined;
if (!run) {
    console.error(`cases: ${Object.keys(cases).join(", ")}`);
    process.exit(2);
}
mkdirSync(join(import.meta.dir, "../../test/fixtures/protocol"), { recursive: true });
await run();
console.log(`wrote agy-${profile.version}-${name}`);
