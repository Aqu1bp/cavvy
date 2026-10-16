// Secrets the agent asks the user for (RequestSecret): the store, the tool,
// Bash's environment, redaction, sub-agents and the terminal app's prompt.
// Only obviously fake values here.

import { afterAll, describe, expect, test } from "bun:test";
import { realpathSync } from "fs";
import { isolate, tempDir as rawTempDir } from "./helpers/isolate";

const iso = isolate();
const { SecretStore, secretNameError, secretValueError, cleanPurpose, MAX_PURPOSE } = await import("../src/agent/secrets");
const { BashTool, BashOutputTool, killAllShells } = await import("../src/tools/bash");
const { RequestSecretTool } = await import("../src/tools/meta-tools");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { childEnv } = await import("../src/util/env");
const { redact } = await import("../src/util/redact");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { App } = await import("../src/ui/app");
const { KeyParser } = await import("../src/ui/keys");
const { stripAnsi } = await import("../src/ui/ansi");
const { runCommand } = await import("../src/commands/index");
const { FileHistory } = await import("../src/agent/checkpoints");
const { readdirSync, readFileSync, writeFileSync, existsSync } = await import("fs");
const { join } = await import("path");
import type { AssistantMessage, Message, ToolSchema } from "../src/providers/types";
import type { ToolState, UiBridge } from "../src/tools/types";

const VALUE = "test-secret-123-abc";
const OTHER = "test-secret-456-def";
// The first name a value is stored under labels it for good, so each test that checks a label has a value of its own.
let fakes = 0;
const fake = () => `test-secret-${++fakes}00-xyz`;
const noFragments = (text: string, value: string) => {
    for (let i = 0; i <= value.length - 6; i++) expect(text).not.toContain(value.slice(i, i + 6));
};
const tempDir = (prefix?: string) => realpathSync(rawTempDir(prefix));
/** `printf %s VALUE | cksum`, so a command can show it got the value without printing it. */
const cksum = (v: string) => Bun.spawnSync(["sh", "-c", 'printf %s "$1" | cksum | awk \'{print $1, $2}\'', "sh", v]).stdout.toString().trim();
const matches = (name: string, v: string) => `[ "$(printf %s "$${name}" | cksum | awk '{print $1, $2}')" = "${cksum(v)}" ] && echo MATCH || echo NO-MATCH`;

const states: ToolState[] = [];
afterAll(async () => {
    for (const state of states) await killAllShells({ state });
    iso.cleanup();
});

function toolCtx(ui: UiBridge = {}, secrets = new SecretStore()) {
    const dir = tempDir("harness-secret-");
    const state: ToolState = { cwd: dir, projectRoot: dir, fileState: new Map(), todos: [], shells: new Map(), secrets };
    states.push(state);
    return { state, secrets, ctx: { state, settings: {}, signal: new AbortController().signal, mode: () => "default", setMode() {}, ui } as any };
}
const bash = (ctx: any, command: string, more: Record<string, unknown> = {}) => BashTool.run({ command, ...more }, ctx);

describe("names, values and purposes", () => {
    test("a name is an environment variable name of its own", () => {
        for (const ok of ["GITHUB_TOKEN", "NPM_TOKEN", "MY_SERVICE_TOKEN", "TOKEN", "RUBYGEMS_API_KEY", `${"A".repeat(58)}_TOKEN`]) expect(secretNameError(ok)).toBeUndefined();
        for (const bad of ["", "github_token", "1TOKEN", "_TOKEN", "MY-TOKEN", "MY TOKEN", "TOKEN=1", `${"A".repeat(59)}_TOKEN`, 42, undefined, null]) expect(secretNameError(bad)).toMatch(/environment variable name/);
    });

    test("names that change how processes run, or that Harness owns, are refused", () => {
        const reserved = ["PATH", "HOME", "SHELL", "IFS", "ENV", "BASH_ENV", "ZDOTDIR", "PS4", "NODE_OPTIONS", "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "GIT_SSH_COMMAND", "GIT_ASKPASS", "HARNESS", "HARNESS_HOME", "HTTPS_PROXY", "PYTHONSTARTUP", "PERL5OPT", "NPM_CONFIG_REGISTRY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GEMINI_API_KEY", "API_KEY", "PAGER", "TMPDIR"];
        for (const name of reserved) expect(secretNameError(name)).toMatch(/can't hold a secret/);
    });

    test("values: 8 characters to 8 KiB, one line, no NUL; the message never quotes the value", () => {
        expect(secretValueError(VALUE)).toBeUndefined();
        for (const bad of ["abc", "abc1234", "x".repeat(8 * 1024 + 1), `${VALUE}\n`, `${VALUE}\0`, `a\r${VALUE}`, 12345678, undefined]) {
            const err = secretValueError(bad);
            expect(err).toBeString();
            if (typeof bad === "string") expect(err).not.toContain(bad);
        }
        expect(secretValueError("é".repeat(4096))).toBeUndefined(); // 8 KiB exactly
        expect(secretValueError("é".repeat(4097))).toMatch(/KiB/);
    });

    test("a purpose is one bounded line of plain text", () => {
        expect(cleanPurpose("  To call the\nAPI \x1b[31mwith curl‮.  ")).toEqual({ text: "To call the API [31mwith curl ." });
        expect(cleanPurpose("x".repeat(MAX_PURPOSE))).toEqual({ text: "x".repeat(MAX_PURPOSE) });
        expect(cleanPurpose("x".repeat(MAX_PURPOSE + 1))).toHaveProperty("error");
        expect(cleanPurpose(" \n ")).toHaveProperty("error");
        expect(cleanPurpose(undefined)).toHaveProperty("error");
    });
});

describe("the store and redaction", () => {
    test("a stored value, and its URL-encoded and base64 forms, are redacted everywhere", () => {
        const s = new SecretStore();
        s.set("REDACT_ME_TOKEN", "p@ss word/1234");
        expect(redact("token=p@ss word/1234")).toBe("token=[REDACTED REDACT_ME_TOKEN]");
        expect(redact(`?t=${encodeURIComponent("p@ss word/1234")}`)).toBe("?t=[REDACTED REDACT_ME_TOKEN]");
        expect(redact(Buffer.from("p@ss word/1234").toString("base64"))).toStartWith("[REDACTED REDACT_ME_TOKEN]");
        expect(redact(Buffer.from("p@ss word/1234\n").toString("base64"))).toStartWith("[REDACTED REDACT_ME_TOKEN]");
        // Python's quote leaves "/" alone; a form uses "+" for spaces; base64url swaps two characters.
        expect(redact("p%40ss%20word/1234")).toBe("[REDACTED REDACT_ME_TOKEN]");
        expect(redact("p%40ss+word%2F1234")).toBe("[REDACTED REDACT_ME_TOKEN]");
        const tricky = "test-secret-~>?>~-1";
        s.set("URL_SAFE_TOKEN", tricky);
        expect(redact(Buffer.from(tricky).toString("base64url"))).toBe("[REDACTED URL_SAFE_TOKEN]");
        expect(Buffer.from(tricky).toString("base64url")).not.toBe(Buffer.from(tricky).toString("base64").replace(/=+$/, ""));
    });

    test("forgetting stops handing it out but keeps redacting; another session with the same value can't undo that", () => {
        const a = new SecretStore();
        const b = new SecretStore();
        a.set("SHARED_TOKEN", "test-shared-value-789");
        b.set("OTHER_NAME_TOKEN", "test-shared-value-789");
        expect(a.forget("SHARED_TOKEN")).toBe(true);
        expect(a.forget("SHARED_TOKEN")).toBe(false);
        b.clear();
        expect(a.env()).toEqual({});
        // Still redacted, under the first session's label (the second one's name doesn't leak into it).
        expect(redact("x test-shared-value-789 y")).toBe("x [REDACTED SHARED_TOKEN] y");
    });

    test("set refuses bad names and values without quoting the value", () => {
        const s = new SecretStore();
        expect(() => s.set("PATH", VALUE)).toThrow(/can't hold a secret/);
        expect(() => s.set("SHORT_ONE_TOKEN", "abc")).toThrow(/too short/);
        try {
            s.set("SHORT_ONE_TOKEN", "abcdef1");
        } catch (e) {
            expect((e as Error).message).not.toContain("abcdef1");
        }
        expect(s.names()).toEqual([]);
    });

    test("no other process gets it: childEnv leaves out a variable holding it", () => {
        new SecretStore().set("CHILD_ENV_TOKEN", "test-child-env-value-1");
        process.env.SOME_INHERITED = "test-child-env-value-1";
        try {
            expect(childEnv().SOME_INHERITED).toBeUndefined();
            expect(childEnv({ FROM_SETTINGS: "test-child-env-value-1" }).FROM_SETTINGS).toBeUndefined();
            expect(childEnv().CHILD_ENV_TOKEN).toBeUndefined();
        } finally {
            delete process.env.SOME_INHERITED;
        }
    });
});

describe("RequestSecret and Bash", () => {
    test("provided: the agent gets a handle, Bash sees the variable, its output is redacted", async () => {
        const asked: [string, string][] = [];
        const { ctx, secrets } = toolCtx({ requestSecret: async (name, purpose) => (asked.push([name, purpose]), VALUE) });
        const r = await RequestSecretTool.run({ name: "DEMO_TOKEN", purpose: "To call the demo API." }, ctx);
        expect(asked).toEqual([["DEMO_TOKEN", "To call the demo API."]]);
        expect(r.isError).toBeFalsy();
        expect(r.content).toStartWith("The user provided DEMO_TOKEN. Shell commands (Bash) in this session see it as $DEMO_TOKEN");
        expect(r.content).not.toContain(VALUE);
        expect(r.display?.summary).toBe("Provided");
        expect(secrets.names()).toEqual(["DEMO_TOKEN"]);

        const out = await bash(ctx, `echo "echo: $DEMO_TOKEN"; printenv | grep '^DEMO_TOKEN='; ${matches("DEMO_TOKEN", VALUE)}`);
        expect(out.content).toBe("echo: [REDACTED DEMO_TOKEN]\nDEMO_TOKEN=[REDACTED DEMO_TOKEN]\nMATCH");
        expect(out.display?.body).not.toContain(VALUE);
    });

    test("cheap encodings are caught too; deliberate transformations aren't (documented)", async () => {
        const { ctx, secrets } = toolCtx();
        secrets.set("ENC_TOKEN", "test-enc-value-0001");
        const out = await bash(ctx, `printf %s "$ENC_TOKEN" | base64; echo "$ENC_TOKEN" | base64; python3 -c 'import os,urllib.parse;print(urllib.parse.quote(os.environ["ENC_TOKEN"]+"/x"))' 2>/dev/null || true`);
        expect(out.content).not.toContain(Buffer.from("test-enc-value-0001").toString("base64").replace(/=+$/, ""));
        expect(out.content).not.toContain("test-enc-value-0001");
        const rev = await bash(ctx, `printf %s "$ENC_TOKEN" | rev`);
        expect(rev.content).toBe("1000-eulav-cne-tset");
    });

    test("background shells see it too, and BashOutput is redacted", async () => {
        const { ctx, secrets } = toolCtx();
        const v = fake();
        secrets.set("BG_TOKEN", v);
        const started = await bash(ctx, `echo "bg: $BG_TOKEN"; ${matches("BG_TOKEN", v)}`, { run_in_background: true });
        const id = /\b(bash_\d+)\b/.exec(started.content)![1]!;
        const sh = ctx.state.shells.get(id)!;
        for (let i = 0; i < 100 && sh.exitCode === null; i++) await Bun.sleep(20);
        const out = await BashOutputTool.run({ bash_id: id }, ctx);
        expect(out.content).toContain("bg: [REDACTED BG_TOKEN]");
        expect(out.content).toContain("MATCH");
        expect(out.content).not.toContain("NO-MATCH");
        expect(out.content).not.toContain(v);
    });

    test("output past the size cap can't end partway through the value", async () => {
        const { ctx, secrets } = toolCtx();
        const v = "dY4hS8uA9kW2nC7Q";
        secrets.set("CAP_TOKEN", v);
        // The cap is 600,000 characters: filler up to just under it, then the value's start in the chunk that crosses it,
        // and its rest a moment later (in a chunk that isn't kept).
        const straddle = (filler: string) => `${filler}; printf %s "$(printf %s "$CAP_TOKEN" | cut -c1-6)"; sleep 0.3; printf '%s\n' "$(printf %s "$CAP_TOKEN" | cut -c7-)"`;
        for (const filler of ["yes aaaaaaaaa | head -c 599997", "head -c 599997 /dev/zero | tr '\\0' a"]) {
            const r = await bash(ctx, straddle(filler));
            expect(r.content).toContain(filler.startsWith("yes ") ? "aaaaaaaaa" : "[Output line omitted");
            noFragments(r.content, v);
            noFragments(r.display?.body ?? "", v);
        }
    });

    test("a background line still being written waits, so a read can't split the value", async () => {
        const { ctx, secrets } = toolCtx();
        const v = "cW7vP2jN9rT4mK8F";
        secrets.set("HALF_TOKEN", v);
        const started = await bash(ctx, `printf 'half: %s' "$(printf %s "$HALF_TOKEN" | cut -c1-6)"; sleep 0.6; printf '%s\n' "$(printf %s "$HALF_TOKEN" | cut -c7-)"`, { run_in_background: true });
        const id = /\b(bash_\d+)\b/.exec(started.content)![1]!;
        await Bun.sleep(250);
        const early = await BashOutputTool.run({ bash_id: id }, ctx);
        expect(early.content).toContain("<status>running</status>");
        noFragments(JSON.stringify(early), v);
        const sh = ctx.state.shells.get(id)!;
        for (let i = 0; i < 100 && sh.exitCode === null; i++) await Bun.sleep(20);
        const late = await BashOutputTool.run({ bash_id: id }, ctx);
        expect(late.content).toContain("half: [REDACTED HALF_TOKEN]");
        noFragments(JSON.stringify(late), v);
    });

    test("a file holding a secret isn't copied into the rewind history", async () => {
        const { ctx, secrets } = toolCtx();
        const v = fake();
        secrets.set("FILE_TOKEN", v);
        const history = FileHistory.for(Session.create(ctx.state.cwd))!;
        const dir = history.dir;
        history.begin();
        const plain = join(ctx.state.cwd, "plain.txt");
        const holding = join(ctx.state.cwd, ".env.local");
        writeFileSync(plain, "nothing to see\n");
        writeFileSync(holding, `FILE_TOKEN=${v}\n`);
        await history.write(plain, Buffer.from("changed\n"));
        await history.write(holding, Buffer.from("FILE_TOKEN=\n"));
        const originals = history.originals();
        expect(originals.find((o) => o.path.endsWith("plain.txt"))!.hash).toBeString();
        expect(originals.find((o) => o.path.endsWith(".env.local"))).toMatchObject({ hash: null, skipped: "holds a secret you gave the agent" });
        const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [readFileSync(join(d, e.name), "latin1")]));
        expect(walk(dir).some((t) => t.includes("nothing to see"))).toBe(true);
        expect(walk(dir).some((t) => t.includes(v))).toBe(false);
        expect(existsSync(holding)).toBe(true);
    });

    test("asking again for the same name replaces it; forgetting keeps it from new processes", async () => {
        const answers = [VALUE, OTHER];
        const { ctx, secrets } = toolCtx({ requestSecret: async () => answers.shift() });
        await RequestSecretTool.run({ name: "SWAP_TOKEN", purpose: "Testing." }, ctx);
        await RequestSecretTool.run({ name: "SWAP_TOKEN", purpose: "Testing again." }, ctx);
        expect(secrets.names()).toEqual(["SWAP_TOKEN"]);
        expect((await bash(ctx, matches("SWAP_TOKEN", OTHER))).content).toBe("MATCH");
        secrets.forget("SWAP_TOKEN");
        expect((await bash(ctx, `[ -n "$SWAP_TOKEN" ] && echo SET || echo UNSET`)).content).toBe("UNSET");
    });

    test("declined, interrupted, or no one to ask: a clear result and nothing stored", async () => {
        const declined = toolCtx({ requestSecret: async () => undefined });
        const r = await RequestSecretTool.run({ name: "NOPE_TOKEN", purpose: "Testing." }, declined.ctx);
        expect(r.content).toStartWith("The user didn't provide NOPE_TOKEN. Nothing was stored. Don't ask for it again unless the user brings it up.");
        expect(r.isError).toBeFalsy();
        expect(r.display?.summary).toBe("Not provided");
        expect(declined.secrets.names()).toEqual([]);

        const ac = new AbortController();
        const interrupted = toolCtx({ requestSecret: async () => (ac.abort(), VALUE) });
        interrupted.ctx.signal = ac.signal;
        const i = await RequestSecretTool.run({ name: "NOPE_TOKEN", purpose: "Testing." }, interrupted.ctx);
        expect(i.content).toStartWith("The request for NOPE_TOKEN was interrupted. Nothing was provided.");
        expect(interrupted.secrets.names()).toEqual([]);

        const headless = toolCtx({});
        const h = await RequestSecretTool.run({ name: "NOPE_TOKEN", purpose: "Testing." }, headless.ctx);
        expect(h.isError).toBe(true);
        expect(h.content).toStartWith("Can't ask for NOPE_TOKEN: no one is here to type it in (non-interactive session). Nothing was provided.");
    });

    test("bad input is a tool error, not a prompt", async () => {
        const v = (input: Record<string, unknown>) => RequestSecretTool.validate!(input as any, {} as any);
        expect(v({ name: "PATH", purpose: "x" })).toMatch(/can't hold a secret/);
        expect(v({ name: "lower", purpose: "x" })).toMatch(/environment variable name/);
        expect(v({ name: "OK_TOKEN", purpose: "x".repeat(MAX_PURPOSE + 1) })).toMatch(/at most/);
        expect(v({ name: "OK_TOKEN", purpose: "" })).toMatch(/what the secret is for/);
        expect(v({ name: "OK_TOKEN", purpose: "Fine." })).toBeUndefined();
    });
});

describe("in the agent loop", () => {
    const reply = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "end_turn"): AssistantMessage => ({ role: "assistant", provider: "test", model: "test", stopReason, content });
    const lastToolResult = (msgs: Message[]) => {
        const m = msgs.at(-1)!;
        return m.role === "user" && m.content[0]?.type === "tool_result" ? m.content[0].content : undefined;
    };

    /** A model that runs `steps` in order (one tool call each, keyed by who's asking), and records what it was sent. */
    function setup(steps: { parent: { name: string; input: Record<string, unknown> }[]; child?: { name: string; input: Record<string, unknown> }[] }, ui: UiBridge) {
        const proj = tempDir("harness-secret-agent-");
        const sent: { child: boolean; tools: string[]; body: string }[] = [];
        let n = 0;
        const queues = { parent: [...steps.parent], child: [...(steps.child ?? [])] };
        const client = {
            async stream(req: { system?: string; messages: Message[]; tools?: ToolSchema[] }) {
                const child = !String(req.system ?? "").includes("PARENT");
                sent.push({ child, tools: (req.tools ?? []).map((t) => t.name), body: JSON.stringify(req) });
                const last = req.messages.at(-1)!;
                const q = child ? queues.child : queues.parent;
                if (last.role === "user" && (last.meta?.kind === "tool_results" || q === queues.parent || q.length)) {
                    const next = q.shift();
                    if (next) return reply([{ type: "tool_call", id: `c${++n}`, name: next.name, input: next.input }], "tool_use");
                }
                return reply([{ type: "text", text: `done: ${lastToolResult(req.messages) ?? ""}` }]);
            },
            async listModels() {
                return [];
            },
        };
        const session = Session.create(proj, { system: "PARENT" });
        const settings = { autoCompact: false } as any;
        const secrets = new SecretStore();
        const state: ToolState = { cwd: proj, projectRoot: proj, fileState: new Map(), todos: [], shells: new Map(), secrets };
        states.push(state);
        let mode = "bypassPermissions" as any;
        const events: any[] = [];
        const agent = new Agent({
            session,
            model: { provider: "test", id: "test", pricing: { input: 3, output: 15 } } as any,
            client: client as any,
            settings: () => settings,
            checker: new PermissionChecker(() => settings, proj),
            tools: BUILTIN_TOOLS,
            mode: { get: () => mode, set: (m) => (mode = m) },
            toolState: state,
            host: { emit: (e) => events.push(e), ui },
        });
        const run = (text: string) => agent.run([{ type: "text", text }], { signal: new AbortController().signal, display: text });
        return { run, sent, events, session, secrets };
    }

    test("the model, the transcript and every event see the name, never the value", async () => {
        const v = fake();
        const t = setup(
            {
                parent: [
                    { name: "RequestSecret", input: { name: "LOOP_TOKEN", purpose: "To deploy." } },
                    { name: "Bash", input: { command: `echo "$LOOP_TOKEN"; ${matches("LOOP_TOKEN", v)}` } },
                ],
            },
            { requestSecret: async () => v },
        );
        await t.run("deploy it");
        const results = t.events.filter((e) => e.type === "tool_end").map((e) => e.result.content);
        expect(results[0]).toStartWith("The user provided LOOP_TOKEN.");
        expect(results[1]).toBe("[REDACTED LOOP_TOKEN]\nMATCH");
        expect(t.sent.map((s) => s.body).join("\n")).not.toContain(v);
        expect(JSON.stringify(t.events)).not.toContain(v);
        expect(await Bun.file(t.session.path!).text()).not.toContain(v);
    });

    test("a bad name never reaches the user", async () => {
        let asked = 0;
        const t = setup({ parent: [{ name: "RequestSecret", input: { name: "LD_PRELOAD", purpose: "To speed things up." } }] }, { requestSecret: async () => (asked++, VALUE) });
        await t.run("go");
        const end = t.events.find((e) => e.type === "tool_end");
        expect(end.result.isError).toBe(true);
        expect(end.result.content).toMatch(/LD_PRELOAD changes how programs run/);
        expect(asked).toBe(0);
    });

    test("a Task sub-agent's Bash sees the session's secrets, but it can't ask for one", async () => {
        const v = fake();
        const t = setup(
            {
                parent: [{ name: "Task", input: { description: "Check the token", prompt: "check it" } }],
                child: [{ name: "Bash", input: { command: `echo "$SUB_TOKEN"; ${matches("SUB_TOKEN", v)}` } }],
            },
            {},
        );
        t.secrets.set("SUB_TOKEN", v);
        await t.run("delegate the check");
        const childReq = t.sent.find((s) => s.child)!;
        expect(childReq.tools).toContain("Bash");
        expect(childReq.tools).not.toContain("RequestSecret");
        expect(t.sent.find((s) => !s.child)!.tools).toContain("RequestSecret");
        const childEnd = t.events.find((e) => e.type === "subagent" && e.event.type === "tool_end")?.event;
        expect(childEnd.result.content).toBe("[REDACTED SUB_TOKEN]\nMATCH");
        expect(t.sent.map((s) => s.body).join("\n")).not.toContain(v);
    });
});

describe("the terminal app", () => {
    function testApp() {
        const app = new App({ cwd: tempDir(), trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
        const printed: string[] = [];
        const screen = { print: (f: any) => (printed.push(...(typeof f === "function" ? f(100) : [f]).map(String)), {}), replace() {}, redraw() {}, setLive() {}, flushNow() {}, stop() {}, clearScreen() {}, focus: true as boolean | undefined };
        (app as any).screen = screen;
        (app as any).renderLive = () => {};
        app.session = Session.create(app.cwd, { persist: false });
        app.session.setSystem("test system prompt");
        (app as any).notifier.notify = async () => {};
        return { app, printed, top: () => (app as any).dialogs.at(-1) };
    }
    function type(d: { onKey(k: any): void }, raw: string) {
        const p = new KeyParser();
        for (const k of p.feed(raw)) d.onKey(k);
        for (const k of p.flushEscape()) d.onKey(k);
    }

    test("a masked prompt with the name and purpose; typed or pasted, the value never renders", async () => {
        const { app, top } = testApp();
        const asking = (app as any).requestSecret("TUI_TOKEN", "To log in to the registry.", new AbortController().signal);
        await Bun.sleep(10);
        const d = top();
        type(d, "test-secret-");
        type(d, "\x1b[200~123-abc\x1b[201~");
        for (const cols of [40, 80, 120]) {
            const out = stripAnsi(d.render(cols).join("\n"));
            expect(out).toContain("TUI_TOKEN");
            expect(out).toContain("To log in to the registry.");
            expect(out).not.toContain("test-secret");
            expect(out).not.toContain("123-abc");
            expect(out).toContain("•".repeat(19));
        }
        type(d, "\r");
        expect(await asking).toBe(VALUE);
    });

    test("a password keeps its spaces, typed or pasted; a pasted line break goes", async () => {
        const { app, top } = testApp();
        const asking = (app as any).requestSecret("PASS_PHRASE", "To unlock the key.", new AbortController().signal);
        await Bun.sleep(10);
        type(top(), " correct ");
        type(top(), "\x1b[200~horse battery\n\x1b[201~");
        type(top(), "\r");
        expect(await asking).toBe(" correct horse battery");
    });

    test("a command run with secrets says which ones in its permission prompt", async () => {
        const { app, top } = testApp();
        const asking = (app as any).permissionDialog({ tool: BashTool, input: { command: "./deploy.sh" }, title: "RunWithSecrets(DEPLOY_TOKEN)", decision: { behavior: "ask", suggestions: [] }, secrets: ["DEPLOY_TOKEN", "NPM_TOKEN"] });
        await Bun.sleep(50);
        const out = stripAnsi(top().render(100).join("\n"));
        expect(out).toContain("Bash command with secrets");
        expect(out).toContain("./deploy.sh");
        expect(out).toContain("It gets $DEPLOY_TOKEN, $NPM_TOKEN in its environment.");
        expect(out).not.toContain("don't ask again");
        top().cancel();
        expect(await asking).toEqual({ allow: false });
    });

    test("too short stays open with a reason; Esc declines; an interrupt withdraws it", async () => {
        const { app, top } = testApp();
        const asking = (app as any).requestSecret("TUI_TOKEN", "Testing.", new AbortController().signal);
        await Bun.sleep(10);
        type(top(), "abc\r");
        expect(stripAnsi(top().render(80).join("\n"))).toContain("too short");
        type(top(), "\x1b");
        expect(await asking).toBeUndefined();

        const ac = new AbortController();
        const withdrawn = (app as any).requestSecret("TUI_TOKEN", "Testing.", ac.signal);
        await Bun.sleep(10);
        type(top(), "test-secret-123");
        ac.abort();
        expect(await withdrawn).toBeUndefined();
        expect((app as any).dialogs).toHaveLength(0);
    });

    test("/secrets lists names only, and forgets one", async () => {
        const { app, printed } = testApp();
        app.toolState.secrets!.set("LISTED_TOKEN", VALUE);
        await runCommand(app, "/secrets");
        const out = stripAnsi(printed.join("\n"));
        expect(out).toContain("$LISTED_TOKEN");
        expect(out).not.toContain(VALUE);
        await runCommand(app, "/secrets forget LISTED_TOKEN");
        expect(app.toolState.secrets!.names()).toEqual([]);
    });

    test("a new conversation starts without the old one's secrets", () => {
        const { app } = testApp();
        app.toolState.secrets!.set("OLD_TOKEN", VALUE);
        (app as any).makeAgent = () => {};
        (app as any).sessionSwitched = () => {};
        app.newSession();
        expect(app.toolState.secrets!.names()).toEqual([]);
    });
});
