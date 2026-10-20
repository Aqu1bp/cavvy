// /doctor and settings comments, --append-system-prompt on resumed sessions
// (interactive and -p), --max-turns in the TUI, and the TUI's keys when the
// terminal reports them with the kitty keyboard protocol.

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { home: HARNESS_HOME, cleanup } = isolate();
const { App } = await import("../src/ui/app");
const { Session, listSessions } = await import("../src/agent/session");
const { runCommand } = await import("../src/commands/index");
const { KeyParser } = await import("../src/ui/keys");
const { stripAnsi } = await import("../src/ui/ansi");
import type { AssistantMessage, ChatRequest } from "../src/providers/types";

beforeAll(() => {
    process.env.HARNESS_HOME = HARNESS_HOME;
});
afterAll(cleanup);

const ROOT = resolve(import.meta.dir, "..");
const MODEL = { provider: "test", id: "m1", name: "Test model" } as any;

function testApp(init: { cwd?: string; appendSystemPrompt?: string; maxTurns?: number } = {}) {
    const app = new App({ cwd: init.cwd ?? tempDir(), trusted: true, mode: "default", allowBypass: false, startupNotes: [], appendSystemPrompt: init.appendSystemPrompt, maxTurns: init.maxTurns });
    const printed: string[] = [];
    const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(100) : Array.isArray(l) ? l : [l])), {});
    (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, flushNow() {}, stop() {}, clearScreen() {} };
    (app as any).renderLive = () => {};
    app.session = Session.create(app.cwd, { persist: false });
    return { app, printed, text: () => printed.map(stripAnsi).join("\n") };
}

const reply = (content: AssistantMessage["content"]): AssistantMessage => ({ role: "assistant", content, provider: "test", model: "m1", stopReason: content.some((p) => p.type === "tool_call") ? "tool_use" : "end_turn" });

/** A provider that records each request; `answer` gets the request number (1-based). */
function useClient(app: InstanceType<typeof App>, answer: (n: number) => AssistantMessage = () => reply([{ type: "text", text: "ok" }])) {
    const requests: ChatRequest[] = [];
    app.model = MODEL;
    app.client = { stream: async (req: ChatRequest) => (requests.push(req), answer(requests.length)), listModels: async () => [] };
    app.makeAgent();
    return requests;
}

// ---------------------------------------------------------------------------

describe("/doctor", () => {
    test("settings files with comments and trailing commas parse, as they do when loaded; real errors are still reported", async () => {
        const proj = tempDir();
        mkdirSync(join(proj, ".harness"));
        writeFileSync(join(proj, ".harness", "settings.json"), `{\n  // the project's model\n  "model": "anthropic:claude-opus-5-5", /* trailing comma next */\n  "permissions": { "allow": ["Bash(npm test:*)",], },\n}\n`);
        writeFileSync(join(proj, ".harness", "settings.local.json"), `{ "effort": }`);
        const { app, text } = testApp({ cwd: proj });
        expect(app.settings.model).toBe("anthropic:claude-opus-5-5"); // what the harness loads
        app.refreshListings = async () => [];
        await runCommand(app, "/doctor");
        const out = text();
        expect(out).toContain("✔ .harness/settings.json parses");
        expect(out).toMatch(/✘ \.harness\/settings\.local\.json: .+/);
        expect(out).not.toContain("settings.local.json parses");
    });
});

// ---------------------------------------------------------------------------

describe("--append-system-prompt", () => {
    test("a new session: the append goes with every request but isn't frozen into the session", async () => {
        const { app } = testApp({ appendSystemPrompt: "Always answer in French." });
        const requests = useClient(app);
        await app.startTurn("hello");
        await app.startTurn("again");
        const stored = app.session.meta.system!;
        expect(stored).toBeTruthy();
        expect(stored).not.toContain("Always answer in French.");
        expect(requests.map((r) => r.system)).toEqual([`${stored}\n\nAlways answer in French.`, `${stored}\n\nAlways answer in French.`]);
    });

    test("a resumed session gets this run's append on top of its frozen prompt, and a later run without the flag doesn't keep it", async () => {
        const proj = tempDir();
        const first = testApp({ cwd: proj });
        first.app.session = Session.create(proj, { persist: false, system: "FROZEN BASE" });
        first.app.session.push({ role: "user", content: [{ type: "text", text: "earlier" }], meta: { kind: "prompt" } });
        const session = first.app.session;

        const withFlag = testApp({ cwd: proj, appendSystemPrompt: "Be terse." });
        withFlag.app.session = session;
        const r1 = useClient(withFlag.app);
        await withFlag.app.startTurn("continue");
        expect(r1[0]!.system).toBe("FROZEN BASE\n\nBe terse.");
        expect(session.meta.system).toBe("FROZEN BASE");

        const without = testApp({ cwd: proj });
        without.app.session = session;
        const r2 = useClient(without.app);
        await without.app.startTurn("and again");
        expect(r2[0]!.system).toBe("FROZEN BASE");
    });

    test("a session frozen with the append by an older version doesn't get it twice", async () => {
        const { app } = testApp({ appendSystemPrompt: "Be terse." });
        app.session = Session.create(app.cwd, { persist: false, system: "BASE\n\nBe terse." });
        const requests = useClient(app);
        await app.startTurn("hi");
        expect(requests[0]!.system).toBe("BASE\n\nBe terse.");
    });

    test("an append that only matches the end of the last paragraph is still added", async () => {
        const { app } = testApp({ appendSystemPrompt: "delete files." });
        app.session = Session.create(app.cwd, { persist: false, system: "BASE\n\nNever delete files." });
        const requests = useClient(app);
        await app.startTurn("hi");
        expect(requests[0]!.system).toBe("BASE\n\nNever delete files.\n\ndelete files.");
    });
});

// ---------------------------------------------------------------------------

describe("--max-turns in the TUI", () => {
    const toolCall = (n: number) => reply([{ type: "tool_call", id: `call${n}`, name: "NoSuchTool", input: {} }]);

    test("each prompt stops after n model turns, with a notice", async () => {
        const { app, text } = testApp({ maxTurns: 2 });
        // Keeps calling tools for 5 turns, then answers.
        const requests = useClient(app, (n) => (n <= 5 ? toolCall(n) : reply([{ type: "text", text: "done" }])));
        await app.startTurn("go");
        expect(requests.length).toBe(2);
        expect(text()).toContain("Stopped after 2 model turns (max turns).");
        expect(text()).toContain("--max-turns 2 limits each prompt; send a message to let it continue.");
        expect(app.busy).toBe(false);
        // The limit is per prompt, not per session.
        await app.startTurn("keep going");
        expect(requests.length).toBe(4);
    });

    test("without the flag there is no limit", async () => {
        const { app, text } = testApp();
        const requests = useClient(app, (n) => (n <= 5 ? toolCall(n) : reply([{ type: "text", text: "done" }])));
        await app.startTurn("go");
        expect(requests.length).toBe(6);
        expect(text()).not.toContain("max turns");
    });
});

// ---------------------------------------------------------------------------

describe("keys in the kitty keyboard protocol's encoding", () => {
    function keyboard(app: InstanceType<typeof App>) {
        const parser = new KeyParser();
        return (...chunks: string[]) => {
            for (const c of chunks) for (const k of parser.feed(c)) (app as any).onKey(k);
        };
    }

    test("shift+enter and ctrl+j add newlines, \\ then enter too, and enter sends", async () => {
        const { app } = testApp();
        const sent: string[] = [];
        app.agent = { run: async (parts: any[]) => void sent.push(parts[0].text) } as any;
        app.session.setSystem("test system prompt");
        const press = keyboard(app);
        press("one", "\x1b[13;2u", "two", "\x1b[106;5u", "three\\", "\r");
        expect(app.editor.text).toBe("one\ntwo\nthree\n");
        press("four", "\r");
        await Bun.sleep(20);
        expect(sent).toEqual(["one\ntwo\nthree\nfour"]);
    });

    test("ctrl+c, esc esc, alt+b, tab completion and shift+tab", () => {
        const { app } = testApp();
        const press = keyboard(app);
        press("draft", "\x1b[99;5u");
        expect(app.editor.text).toBe("");
        press("draft", "\x1b[27u", "\x1b[27u");
        expect(app.editor.text).toBe("");
        press("one two", "\x1b[98;3u", "X");
        expect(app.editor.text).toBe("one Xtwo");
        press("\x1b[99;5u", "/hel", "\t");
        expect(app.editor.text).toBe("/help");
        press("\x1b[9;2u");
        expect(app.mode).toBe("acceptEdits");
    });

    describe("esc while a turn runs", () => {
        function busyApp() {
            const { app } = testApp();
            const a = app as any;
            let interrupts = 0;
            a.interrupt = () => void interrupts++;
            a.busy = true;
            return { app, a, press: keyboard(app), interrupts: () => interrupts };
        }

        test("with messages queued, each esc takes back the latest one; once none are left, esc interrupts", () => {
            const { a, press, interrupts } = busyApp();
            a.queued = ["first", "second"];
            press("\x1b[27u");
            expect(a.queued).toEqual(["first"]);
            expect(a.editor.text).toBe("second");
            expect(a.flash.text).toContain("for the next (1 more)");
            press("\x1b[27u");
            expect(a.queued).toEqual([]);
            expect(a.editor.text).toBe("first\nsecond");
            expect(a.flash.text).toContain("Esc again to interrupt");
            expect(interrupts()).toBe(0);
            press("\x1b[27u");
            expect(interrupts()).toBe(1);
        });

        test("a taken-back message goes ahead of the draft, and the cursor stays where it was in the draft", () => {
            const { a, press } = busyApp();
            a.queued = ["first"];
            press("draft");
            a.editor.cursor = 2;
            press("\x1b[27u");
            expect(a.editor.text).toBe("first\ndraft");
            expect(a.editor.cursor).toBe("first\n".length + 2);
        });

        test("a queued slash command doesn't merge with a draft (it would take it as arguments): it stays queued and the next esc interrupts", () => {
            const { a, press, interrupts } = busyApp();
            a.queued = ["/review"];
            press("draft", "\x1b[27u");
            expect(a.queued).toEqual(["/review"]);
            expect(a.editor.text).toBe("draft");
            expect(a.flash.text).toContain("Clear the prompt");
            expect(interrupts()).toBe(0);
            press("\x1b[27u");
            expect(interrupts()).toBe(1);
        });

        test("with an empty prompt, a queued slash command comes back on its own", () => {
            const { a, press, interrupts } = busyApp();
            a.queued = ["/review"];
            press("\x1b[27u");
            expect(a.queued).toEqual([]);
            expect(a.editor.text).toBe("/review");
            expect(interrupts()).toBe(0);
        });

        test("an esc from before the turn (esc again to clear) doesn't make the next one interrupt", () => {
            const { a, press, interrupts } = busyApp();
            a.busy = false;
            press("x", "\x1b[27u");
            a.busy = true;
            a.queued = ["first"];
            press("\x1b[27u");
            expect(interrupts()).toBe(0);
            expect(a.queued).toEqual([]);
        });

        test("with nothing queued, esc interrupts at once", () => {
            const { a, press, interrupts } = busyApp();
            press("draft", "\x1b[27u");
            expect(interrupts()).toBe(1);
            expect(a.editor.text).toBe("draft");
        });

        test("when idle, esc esc still clears the draft and never interrupts", () => {
            const { a, press, interrupts } = busyApp();
            a.busy = false;
            press("draft", "\x1b[27u");
            expect(a.editor.text).toBe("draft");
            press("\x1b[27u");
            expect(a.editor.text).toBe("");
            expect(interrupts()).toBe(0);
        });

        test("after an interrupt, a queued slash command goes to the history, not into the draft as its arguments", () => {
            const { a, press } = busyApp();
            a.queued = ["/review", "also this"];
            press("draft");
            a.returnQueued();
            expect(a.queued).toEqual([]);
            expect(a.editor.text).toBe("also this\ndraft");
            a.editor.set("");
            a.editor.historyPrev();
            expect(a.editor.text).toBe("/review");
        });

        test("// is plain text, as when it's submitted: it comes back with the rest", () => {
            const { a, press } = busyApp();
            a.queued = ["// explain this", "also this"];
            a.returnQueued();
            expect(a.editor.text).toBe("// explain this\nalso this");
            a.editor.set("");
            a.queued = ["// note"];
            press("draft", "\x1b[27u");
            expect(a.queued).toEqual([]);
            expect(a.editor.text).toBe("// note\ndraft");
        });

        test("after an interrupt, a lone queued slash command comes back to the prompt", () => {
            const { a } = busyApp();
            a.queued = ["/review"];
            a.returnQueued();
            expect(a.editor.text).toBe("/review");
        });

        test("a blocked take-back doesn't carry into the next turn", async () => {
            const { a, press, interrupts } = busyApp();
            a.queued = ["/review"];
            press("draft", "\x1b[27u");
            expect(a.takeBackBlockedAt).toBeGreaterThan(0);
            a.busy = false;
            a.queued = [];
            await a.runTask("working", async () => 1);
            expect(a.takeBackBlockedAt).toBe(0);
            a.busy = true;
            a.queued = ["follow-up"];
            a.editor.set("");
            press("\x1b[27u");
            expect(interrupts()).toBe(0);
            expect(a.editor.text).toBe("follow-up");
        });
    });
});

// ---------------------------------------------------------------------------
// -p, through the real entry point and a local mock provider.

describe("--append-system-prompt with -p", () => {
    const systems: string[] = [];
    let server: ReturnType<typeof Bun.serve>;
    beforeAll(() => {
        server = Bun.serve({
            port: 0,
            hostname: "127.0.0.1",
            fetch: async (req) => {
                if (new URL(req.url).pathname.endsWith("/models")) return Response.json({ data: [{ id: "m1" }] });
                const body = (await req.json()) as { messages: { role: string; content: string }[] };
                systems.push(body.messages.find((m) => m.role === "system")?.content ?? "");
                const chunks = [{ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }];
                return new Response(chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
            },
        });
        writeFileSync(join(HARNESS_HOME, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: `http://127.0.0.1:${server.port}/v1`, kind: "openai", requiresKey: false, models: ["m1"] }] }));
    });
    afterAll(() => server.stop(true));

    async function harness(args: string[], cwd: string): Promise<{ code: number; stderr: string }> {
        const env: Record<string, string> = { PATH: process.env.PATH ?? "", HOME: HARNESS_HOME, HARNESS_HOME, HARNESS_NO_KEYCHAIN: "1" };
        const child = spawn(process.execPath, ["--no-env-file", `--config=${join(ROOT, "bunfig.toml")}`, join(ROOT, "src/index.ts"), "-p", ...args, "--model", "mock:m1"], { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (b) => (stderr += b));
        const killer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        const code = await new Promise<number>((r) => child.on("close", (c) => r(c ?? -1)));
        clearTimeout(killer);
        return { code, stderr };
    }

    test("a resumed session gets this run's append, and the next run without the flag doesn't", async () => {
        const proj = realpathSync(tempDir());
        expect(await harness(["first", "--append-system-prompt", "Rule one."], proj)).toMatchObject({ code: 0 });
        const base = systems[0]!.replace(/\n\nRule one\.$/, "");
        expect(systems[0]).toBe(`${base}\n\nRule one.`);
        // What the session file keeps is the prompt without the append.
        const file = listSessions(proj, 1)[0]!.file;
        expect(JSON.parse(readFileSync(file, "utf-8").split("\n")[0]!).system).toBe(base);

        expect(await harness(["second", "-c", "--append-system-prompt", "Rule two."], proj)).toMatchObject({ code: 0 });
        expect(systems[1]).toBe(`${base}\n\nRule two.`);

        expect(await harness(["third", "-c"], proj)).toMatchObject({ code: 0 });
        expect(systems[2]).toBe(base);
        expect(listSessions(proj, 5).length).toBe(1);
    }, 60_000);
});
