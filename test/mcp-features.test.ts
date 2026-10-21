// Resources, prompts, elicitation, sampling and roots, against the stdio
// fixture in both protocol eras (legacy server requests; modern multi
// round-trip requests), then through the manager and the @-mention
// expansion both front ends use.

import { afterAll, describe, expect, test } from "bun:test";
import { rmSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { McpClient, McpError } = await import("../src/mcp/client");
const { McpManager, splitArgs, formatResourceContents, formatPromptMessages } = await import("../src/mcp/manager");
const { findMcpMentions, expandMcpMentions, searchResources } = await import("../src/mcp/mentions");
const { askForm, mcpInput, samplingPrompt } = await import("../src/mcp/elicitation");
import type { McpServerConfig } from "../src/config/settings";
import type { McpClient as McpClientT, McpInput } from "../src/mcp/client";
import type { McpManager as McpManagerT } from "../src/mcp/manager";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
const WORK = tempDir("harness-mcp-features-");

function stdio(era: string, env: Record<string, string> = {}): McpServerConfig {
    return { command: process.execPath, args: ["--no-env-file", FIXTURE], env: { MCP_FIXTURE_ERA: era, ...env }, cwd: WORK };
}

const clients: McpClientT[] = [];
const managers: McpManagerT[] = [];
function client(cfg: McpServerConfig, interactive = false): McpClientT {
    const c = new McpClient("fx", cfg, WORK, undefined, { interactive });
    clients.push(c);
    return c;
}

afterAll(async () => {
    await Promise.all(clients.map((c) => c.close()));
    await Promise.all(managers.map((m) => m.closeAll()));
    rmSync(WORK, { recursive: true, force: true });
    iso.cleanup();
});

const textOf = (r: { content: { type: string; text?: string }[] }) => r.content.map((c) => c.text ?? "").join("");

async function waitFor(cond: () => boolean, ms = 3000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return true;
        await Bun.sleep(20);
    }
    return cond();
}

/** An input that records what it was asked and answers as told. */
function recorder(o: { elicit?: (p: any) => any; sample?: (p: any) => any } = {}) {
    const asked: { kind: string; params: any }[] = [];
    const input: McpInput = {
        elicit: async (p) => {
            asked.push({ kind: "elicit", params: p });
            return o.elicit ? o.elicit(p) : { action: "accept", content: { name: "Ada" } };
        },
        sample: async (p) => {
            asked.push({ kind: "sample", params: p });
            if (o.sample) return o.sample(p);
            return { role: "assistant", content: { type: "text", text: "4" }, model: "test:model", stopReason: "endTurn" };
        },
    };
    return { asked, input };
}

for (const era of ["legacy", "modern"] as const) {
    describe(`stdio ${era}: resources and prompts`, () => {
        let c: McpClientT;
        test("connect records what the server offers", async () => {
            c = client(stdio(era), true);
            await c.connect();
            expect(c.offers("tools")).toBe(true);
            expect(c.offers("resources")).toBe(true);
            expect(c.offers("prompts")).toBe(true);
        });

        test("resources/list follows nextCursor; templates listed", async () => {
            const r = await c.listResources();
            expect(r.map((x) => x.uri)).toEqual(["fixture://readme", "fixture://big", "fixture://pixel", "fixture://slow", "fixture://secret"]);
            expect(r[0]).toMatchObject({ name: "readme", title: "Read me", mimeType: "text/markdown" });
            expect((await c.listResourceTemplates()).map((t) => t.uriTemplate)).toEqual(["fixture://items/{id}"]);
        });

        test("resources/read: text, a blob, a template's URI; an unknown URI is an error", async () => {
            expect(await c.readResource("fixture://readme")).toEqual([{ uri: "fixture://readme", mimeType: "text/markdown", text: "# Fixture\nHello from a resource." }]);
            const [pixel] = await c.readResource("fixture://pixel");
            expect(pixel!.blob).toBeString();
            expect((await c.readResource("fixture://items/42"))[0]!.text).toBe("item 42");
            const err = await c.readResource("fixture://nope").catch((e) => e);
            expect(err).toBeInstanceOf(McpError);
            expect(err.code).toBe(-32602);
        });

        test("a slow read times out, and an aborted one stops at once", async () => {
            await expect(c.readResource("fixture://slow", { timeoutMs: 200 })).rejects.toThrow(/timed out/);
            const ac = new AbortController();
            const p = c.readResource("fixture://slow", { signal: ac.signal });
            setTimeout(() => ac.abort(), 50);
            const t0 = Date.now();
            await expect(p).rejects.toThrow("aborted");
            expect(Date.now() - t0).toBeLessThan(1000);
            // The client still works after both.
            expect((await c.readResource("fixture://readme"))[0]!.text).toContain("Hello");
        });

        test("prompts/list and prompts/get with arguments; the server's error for a missing one comes back", async () => {
            const p = await c.listPrompts();
            expect(p.map((x) => x.name)).toEqual(["greet", "rich"]);
            expect(p[0]!.arguments).toEqual([{ name: "name", description: "Who", required: true }, { name: "tone", description: "How" }]);
            const g = await c.getPrompt("greet", { name: "Ada", tone: "warmly" });
            expect(g.messages).toEqual([{ role: "user", content: { type: "text", text: "Say hello to Ada, warmly." } }]);
            await expect(c.getPrompt("greet", {})).rejects.toThrow(/Missing required argument/);
        });

        test("list_changed for resources and prompts reach their callbacks", async () => {
            let res = 0;
            let prompts = 0;
            c.onResourcesChanged = () => res++;
            c.onPromptsChanged = () => prompts++;
            await c.callTool("notify_lists", {});
            expect(await waitFor(() => res === 1 && prompts === 1, 1000)).toBe(true);
        });
    });

    describe(`stdio ${era}: what the server asks of the client`, () => {
        let c: McpClientT;
        test("connect", async () => {
            c = client(stdio(era), true);
            await c.connect();
        });

        test("a form: the input's answer reaches the server", async () => {
            const { asked, input } = recorder();
            const r = await c.callTool("ask_name", {}, undefined, undefined, input);
            expect(JSON.parse(textOf(r))).toEqual({ action: "accept", content: { name: "Ada" } });
            expect(asked).toHaveLength(1);
            expect(asked[0]!.params).toMatchObject({ mode: "form", message: "What's your name?" });
            expect(asked[0]!.params.requestedSchema.required).toEqual(["name"]);
        });

        test("declined and cancelled forms are passed on as such", async () => {
            for (const action of ["decline", "cancel"] as const) {
                const { input } = recorder({ elicit: () => ({ action }) });
                expect(JSON.parse(textOf(await c.callTool("ask_name", {}, undefined, undefined, input)))).toEqual({ action });
            }
        });

        test("a URL elicitation: accept carries no content", async () => {
            const { asked, input } = recorder({ elicit: () => ({ action: "accept", content: { ignored: true } }) });
            expect(JSON.parse(textOf(await c.callTool("ask_name", { url: true }, undefined, undefined, input)))).toEqual({ action: "accept" });
            expect(asked[0]!.params).toMatchObject({ mode: "url", url: "https://example.com/connect" });
        });

        test("with no one to ask, a form is declined", async () => {
            const r = await c.callTool("ask_name", {});
            expect(JSON.parse(textOf(r))).toEqual({ action: "decline" });
        });

        test("sampling: the input's completion goes back", async () => {
            const { asked, input } = recorder();
            const r = JSON.parse(textOf(await c.callTool("sample", { q: "2+2?" }, undefined, undefined, input)));
            expect(r).toEqual({ role: "assistant", content: { type: "text", text: "4" }, model: "test:model", stopReason: "endTurn" });
            expect(asked[0]!.params).toMatchObject({ systemPrompt: "Answer briefly.", maxTokens: 50 });
            expect(asked[0]!.params.messages[0].content.text).toBe("2+2?");
        });

        test("sampling the user declines: an error the server sees (legacy) or the call fails (modern)", async () => {
            const { input } = recorder({
                sample: () => {
                    throw new McpError("The user declined the sampling request", -1);
                },
            });
            if (era === "legacy") {
                const r = await c.callTool("sample", {}, undefined, undefined, input);
                expect(r.isError).toBe(true);
                expect(textOf(r)).toContain("declined the sampling request");
            } else {
                await expect(c.callTool("sample", {}, undefined, undefined, input)).rejects.toThrow(/declined the sampling request/);
            }
        });

        test("roots: the project folder", async () => {
            const r = JSON.parse(textOf(await c.callTool("roots", {})));
            expect(r.roots).toHaveLength(1);
            expect(r.roots[0].uri).toStartWith("file://");
            expect(decodeURIComponent(r.roots[0].uri)).toContain(WORK.split("/").at(-1)!);
        });

        test("a resource read can ask first, too", async () => {
            const yes = recorder({ elicit: () => ({ action: "accept", content: {} }) });
            expect((await c.readResource("fixture://secret", { input: yes.input }))[0]!.text).toBe("the secret");
            const no = recorder({ elicit: () => ({ action: "decline" }) });
            expect((await c.readResource("fixture://secret", { input: no.input }))[0]!.text).toBe("declined");
        });
    });
}

describe("what each era is told the client can do", () => {
    test("legacy: initialize declares elicitation and sampling only for an interactive client", async () => {
        const quiet = client(stdio("legacy"));
        await quiet.connect();
        const loud = client(stdio("legacy"), true);
        await loud.connect();
        const initOf = async (c: McpClientT) => JSON.parse(textOf(await c.callTool("get_log", {}))).log.find((l: any) => l.method === "initialize").params.capabilities;
        expect(await initOf(quiet)).toEqual({ roots: {} });
        expect(await initOf(loud)).toEqual({ roots: {}, elicitation: { form: {}, url: {} }, sampling: {} });
    });

    test("modern: each request declares what its own input can answer", async () => {
        const c = client(stdio("modern"), true);
        await c.connect();
        await c.callTool("echo", { text: "a" });
        await c.callTool("echo", { text: "b" }, undefined, undefined, { elicit: async () => ({ action: "decline" }) });
        const log = JSON.parse(textOf(await c.callTool("get_log", {}))).log.filter((l: any) => l.method === "tools/call");
        const caps = log.map((l: any) => l.params._meta["io.modelcontextprotocol/clientCapabilities"]);
        expect(caps[0]).toEqual({ roots: {} });
        expect(caps[1]).toEqual({ roots: {}, elicitation: { form: {}, url: {} } });
    });

    test("modern MRTR: the retry is a new request carrying the answers and the exact requestState", async () => {
        const c = client(stdio("modern"), true);
        await c.connect();
        const { input } = recorder();
        await c.callTool("ask_name", {}, undefined, undefined, input);
        const calls = JSON.parse(textOf(await c.callTool("get_log", {}))).log.filter((l: any) => l.method === "tools/call" && l.params.name === "ask_name");
        expect(calls).toHaveLength(2);
        expect(calls[0].id).not.toBe(calls[1].id);
        expect(calls[0].params.inputResponses).toBeUndefined();
        expect(calls[1].params.requestState).toBe("state-name");
        expect(calls[1].params.inputResponses).toEqual({ name: { action: "accept", content: { name: "Ada" } } });
    });
});

describe("the manager: resources, prompts and the model's resource tools", () => {
    let m: McpManagerT;
    const secret = "s3cr3t-value-123456";
    test("starts with resources, templates and prompts listed alongside tools", async () => {
        m = new McpManager(WORK, () => ({ mcpServers: { leg: stdio("legacy", { API_TOKEN: secret }), mod: stdio("modern") } }), false, undefined, true);
        managers.push(m);
        m.load();
        await m.startAll();
        for (const name of ["leg", "mod"]) {
            const st = m.servers.get(name)!;
            expect(st.status).toBe("connected");
            expect(st.resources).toHaveLength(5);
            expect(st.templates).toHaveLength(1);
            expect(st.prompts).toHaveLength(2);
        }
        expect(m.describe("leg")).toMatchObject({ resources: 6, prompts: 2 });
    });

    test("a server that offers resources but no tools still connects", async () => {
        const m2 = new McpManager(WORK, () => ({ mcpServers: { docs: stdio("legacy", { MCP_FIXTURE_NO_TOOLS: "1" }) } }), false);
        managers.push(m2);
        m2.load();
        await m2.startAll();
        const st = m2.servers.get("docs")!;
        expect(st.status).toBe("connected");
        expect(st.tools).toEqual([]);
        expect(st.resources).toHaveLength(5);
    });

    test("a server that offers only tools has no resources or prompts, and no resource tools are added", async () => {
        const m2 = new McpManager(WORK, () => ({ mcpServers: { t: stdio("legacy", { MCP_FIXTURE_TOOLS_ONLY: "1" }) } }), false);
        managers.push(m2);
        m2.load();
        await m2.startAll();
        const st = m2.servers.get("t")!;
        expect(st.resources).toEqual([]);
        expect(st.prompts).toEqual([]);
        const names = m2.tools().map((t) => t.name);
        expect(names).not.toContain("ListMcpResources");
        expect(m2.promptCommands()).toEqual([]);
    });

    test("resourceList: every connected server's, with what to type after @", () => {
        const list = m.resourceList();
        expect(list).toHaveLength(10);
        expect(list.find((r) => r.server === "mod" && r.uri === "fixture://readme")).toMatchObject({ mention: "mod:fixture://readme", title: "Read me" });
        // Cached per list the server sent: the same objects on the next call.
        expect(m.resourceList()[0]).toBe(list[0]!);
    });

    test("resourceList leaves out a resource whose URI carries a configured secret: picking it would put the secret in the prompt", () => {
        const st = m.servers.get("leg")!;
        const before = st.resources!;
        st.resources = [...before, { uri: `db://user:${secret}@host/table`, name: "table" }];
        try {
            const list = m.resourceList();
            expect(list.filter((r) => r.server === "leg")).toHaveLength(5);
            expect(JSON.stringify(list)).not.toContain(secret);
        } finally {
            st.resources = before;
        }
    });

    test("readResource formats text, attaches images, caps size, and masks configured secrets", async () => {
        const r = await m.readResource("leg", "fixture://readme", {});
        expect(r.text).toBe("# Fixture\nHello from a resource.");
        const px = await m.readResource("mod", "fixture://pixel", {});
        expect(px.images).toHaveLength(1);
        expect(px.images[0]!.mediaType).toBe("image/png");
        const big = await m.readResource("mod", "fixture://big", {});
        expect(big.text.length).toBeLessThan(41_000);
        const leak = await m.readResource("leg", `fixture://items/${secret}`, {});
        expect(leak.text).not.toContain(secret);
        expect(leak.uri).not.toContain(secret);
    });

    test("readResource of a server that isn't connected, or doesn't exist, says so", async () => {
        await expect(m.readResource("nope", "x://y", {})).rejects.toThrow(/no MCP server named "nope"/);
        const m2 = new McpManager(WORK, () => ({ mcpServers: { off: { ...stdio("legacy"), disabled: true } } }), false);
        m2.load();
        await expect(m2.readResource("off", "fixture://readme", {})).rejects.toThrow(/isn't connected/);
    });

    test("prompt commands: mcp__<server>__<prompt>, with argument hints", () => {
        const cmds = m.promptCommands();
        expect(cmds.map((c) => c.command).sort()).toEqual(["mcp__leg__greet", "mcp__leg__rich", "mcp__mod__greet", "mcp__mod__rich"]);
        expect(cmds.find((c) => c.command === "mcp__leg__greet")).toMatchObject({ args: "<name> [tone]", description: "Says hello (MCP prompt from leg)" });
    });

    test("runPrompt: positional arguments, the last taking the rest; quotes group words", async () => {
        expect((await m.runPrompt("mcp__leg__greet", "Ada with a smile", {})).text).toBe("Say hello to Ada, with a smile.");
        expect((await m.runPrompt("MCP__MOD__GREET", '"Ada Lovelace" kindly', {})).text).toBe("Say hello to Ada Lovelace, kindly.");
    });

    test("runPrompt without a required argument gives the usage, without asking the server", async () => {
        await expect(m.runPrompt("mcp__leg__greet", "", {})).rejects.toThrow("/mcp__leg__greet needs name. Usage: /mcp__leg__greet <name> [tone]");
    });

    test("runPrompt: embedded resources inlined, images attached; an unknown prompt is an error", async () => {
        const r = await m.runPrompt("mcp__mod__rich", "", {});
        expect(r.text).toBe("Look at these.\n\nResource fixture://readme:\n# Fixture");
        expect(r.images).toHaveLength(1);
        await expect(m.runPrompt("mcp__mod__nope", "", {})).rejects.toThrow(/no MCP prompt/);
    });

    test("ListMcpResources lists every server's resources and templates; ReadMcpResource reads one", async () => {
        const tools = m.tools();
        const list = tools.find((t) => t.name === "ListMcpResources")!;
        const read = tools.find((t) => t.name === "ReadMcpResource")!;
        expect(list.category).toBe("meta");
        expect(read.category).toBe("mcp");
        expect(read.readOnly).toBe(true);
        const ctx = { ui: {}, signal: new AbortController().signal } as any;
        const all = await list.run({}, ctx);
        expect(all.content).toContain("## leg");
        expect(all.content).toContain("- fixture://readme (Read me) [text/markdown]: A short text");
        expect(all.content).toContain("- template fixture://items/{id} (item): An item by id");
        expect((await list.run({ server: "nope" }, ctx)).isError).toBe(true);
        const one = await read.run({ server: "mod", uri: "fixture://readme" }, ctx);
        expect(one.content).toBe("# Fixture\nHello from a resource.");
        const bad = await read.run({ server: "mod", uri: "fixture://nope" }, ctx);
        expect(bad.isError).toBe(true);
        expect(bad.content).toContain("Resource not found");
    });

    test("a tool call's form goes to the session's question dialog (ctx.ui.askQuestion)", async () => {
        const asked: string[] = [];
        const ctx = { ui: { askQuestion: async (q: string) => (asked.push(q), ["Grace"]) }, signal: new AbortController().signal } as any;
        const tool = m.tools().find((t) => t.name === "mcp__mod__ask_name")!;
        const r = await tool.run({}, ctx);
        expect(JSON.parse(r.content)).toEqual({ action: "accept", content: { name: "Grace" } });
        expect(asked[0]).toBe("The mod MCP server asks: What's your name?\n\nName");
    });

    test("sampling asks first; allowed, it runs on the session's model; denied, the server hears no", async () => {
        const questions: string[] = [];
        let answer = "Allow";
        const ctx = {
            ui: { askQuestion: async (q: string) => (questions.push(q), [answer]) },
            sample: async (system: string, prompt: string) => ({ text: `${system}|${prompt}`, model: "anthropic:test" }),
            signal: new AbortController().signal,
        } as any;
        const tool = m.tools().find((t) => t.name === "mcp__leg__sample")!;
        const r = JSON.parse((await tool.run({ q: "capital of France?" }, ctx)).content);
        expect(r).toEqual({ role: "assistant", content: { type: "text", text: "Answer briefly.|capital of France?" }, model: "anthropic:test", stopReason: "endTurn" });
        expect(questions[0]).toContain("The leg MCP server wants to use your model (up to 50 tokens).");
        expect(questions[0]).toContain("capital of France?");
        answer = "Deny";
        const denied = await tool.run({ q: "x" }, ctx);
        expect(denied.content).toContain("declined the sampling request");
    });

    test("a headless manager (not interactive) declines forms without asking", async () => {
        const m2 = new McpManager(WORK, () => ({ mcpServers: { h: stdio("modern") } }), false);
        managers.push(m2);
        m2.load();
        await m2.startAll();
        let asked = 0;
        const ctx = { ui: { askQuestion: async () => (asked++, ["x"]) }, signal: new AbortController().signal } as any;
        const r = await m2.tools().find((t) => t.name === "mcp__h__ask_name")!.run({}, ctx);
        expect(JSON.parse(r.content)).toEqual({ action: "decline" });
        expect(asked).toBe(0);
    });

    test("resources/prompts list_changed refreshes the lists and tells the front ends", async () => {
        let changed = 0;
        m.onChange = () => changed++;
        const st = m.servers.get("mod")!;
        const before = st.resources;
        await m.tools().find((t) => t.name === "mcp__mod__notify_lists")!.run({}, { ui: {}, signal: new AbortController().signal } as any);
        expect(await waitFor(() => changed >= 2 && st.resources !== before, 2000)).toBe(true);
        m.onChange = undefined;
    });
});

describe("@server:uri mentions", () => {
    test("findMcpMentions: known servers only, longest name first, sentence punctuation dropped, each once", () => {
        const text = "Compare @plugin:a:b:file:///x.md with @plugin:a:file:///y, and @nope:z://q. Again @plugin:a:file:///y.";
        expect(findMcpMentions(text, ["plugin:a", "plugin:a:b"])).toEqual([
            { server: "plugin:a:b", uri: "file:///x.md", raw: "plugin:a:b:file:///x.md" },
            { server: "plugin:a", uri: "file:///y", raw: "plugin:a:file:///y" },
        ]);
        expect(findMcpMentions("email@srv:x", ["srv"])).toEqual([]);
        expect(findMcpMentions("@srv:", ["srv"])).toEqual([]);
        expect(findMcpMentions("no mentions", [])).toEqual([]);
    });

    test("expandMcpMentions attaches text and images, and notes what it couldn't read", async () => {
        const m = new McpManager(WORK, () => ({ mcpServers: { docs: stdio("legacy") } }), false, undefined, true);
        managers.push(m);
        m.load();
        await m.startAll();
        const r = await expandMcpMentions("see @docs:fixture://readme and @docs:fixture://pixel, not @docs:fixture://gone.", m, {});
        expect(r.attached).toEqual(["docs:fixture://readme", "docs:fixture://pixel"]);
        expect(r.parts[0]).toEqual({ type: "text", text: "Contents of MCP resource docs:fixture://readme (attached by the user with @docs:fixture://readme):\n# Fixture\nHello from a resource." });
        expect(r.parts.some((p) => p.type === "image")).toBe(true);
        expect(r.notices).toHaveLength(1);
        expect(r.notices[0]).toStartWith("Couldn't attach @docs:fixture://gone: ");
        // No manager, or no mention: nothing to do.
        expect(await expandMcpMentions("@docs:fixture://readme", undefined, {})).toEqual({ parts: [], attached: [], notices: [] });
    });

    test("searchResources: prefix of server:uri first, then name/title matches; empty query lists none", () => {
        const all = [
            { mention: "gh:repo://a", name: "alpha", title: "Alpha doc", uri: "repo://a" },
            { mention: "docs:file:///guide", name: "guide", uri: "file:///guide" },
            { mention: "docs:file:///gh-notes", name: "notes", uri: "file:///gh-notes" },
        ];
        expect(searchResources(all, "gh", 5).map((r) => r.mention)).toEqual(["gh:repo://a", "docs:file:///gh-notes"]);
        expect(searchResources(all, "guide", 5).map((r) => r.name)).toEqual(["guide"]);
        expect(searchResources(all, "alpha d", 5).map((r) => r.name)).toEqual(["alpha"]);
        expect(searchResources(all, "", 5)).toEqual([]);
    });
});

describe("helpers", () => {
    test("splitArgs", () => {
        expect(splitArgs("a b c", 2)).toEqual(["a", "b c"]);
        expect(splitArgs('"a b" c', 2)).toEqual(["a b", "c"]);
        expect(splitArgs("'x y'", 1)).toEqual(["x y"]);
        expect(splitArgs("", 3)).toEqual([]);
        expect(splitArgs("one", 0)).toEqual(["one"]);
        expect(splitArgs('a "b \\" c"', 3)).toEqual(["a", 'b " c']);
    });

    test("formatResourceContents: several parts named by URI; unknown binaries described, not attached", () => {
        const f = formatResourceContents([
            { uri: "a://1", text: "one" },
            { uri: "a://2", blob: "AAAA", mimeType: "application/pdf" },
        ]);
        expect(f.text).toBe("a://1:\none\n\n[binary resource a://2 (application/pdf), 0 KB, not attached]");
        expect(f.images).toEqual([]);
    });

    test("formatPromptMessages marks roles only in a conversation", () => {
        expect(formatPromptMessages([{ role: "user", content: { type: "text", text: "hi" } }]).text).toBe("hi");
        expect(
            formatPromptMessages([
                { role: "user", content: { type: "text", text: "q" } },
                { role: "assistant", content: { type: "text", text: "a" } },
            ]).text,
        ).toBe("User: q\n\nAssistant: a");
    });

    test("samplingPrompt: a lone message as is, a conversation as a transcript, non-text named", () => {
        expect(samplingPrompt({ messages: [{ role: "user", content: { type: "text", text: "x" } }] })).toBe("x");
        expect(
            samplingPrompt({
                messages: [
                    { role: "user", content: [{ type: "text", text: "a" }, { type: "image" }] },
                    { role: "assistant", content: { type: "text", text: "b" } },
                ],
            }),
        ).toBe("User: a\n[image omitted]\n\nAssistant: b");
    });

    test("askForm: dismissed or a required field left empty declines; a form it can't show warns", async () => {
        const warnings: string[] = [];
        const schema = { type: "object", properties: { n: { type: "integer", minimum: 1 }, why: { type: "string" } }, required: ["n"] };
        expect(await askForm("q", schema, async () => undefined, (m) => warnings.push(m))).toEqual({ action: "decline" });
        expect(await askForm("q", schema, async () => [["3"], ["Leave empty"]], (m) => warnings.push(m))).toEqual({ action: "accept", content: { n: 3 } });
        expect(await askForm("q", schema, async () => [["0"], []], (m) => warnings.push(m))).toEqual({ action: "decline" });
        expect(warnings.at(-1)).toContain('the answer for "n" isn\'t one it allows');
        expect(await askForm("q", { type: "object", properties: { o: { type: "object" } } }, async () => [], (m) => warnings.push(m), "srv")).toEqual({ action: "decline" });
        expect(warnings.at(-1)).toContain("Declined a request from srv for input");
    });

    test("mcpInput: none without a way to ask; a dismissed link is a cancel; no sampling without a model", async () => {
        expect(mcpInput("s", {})).toBeUndefined();
        const input = mcpInput("s", { askQuestion: async () => undefined })!;
        expect(await input.elicit!({ mode: "url", message: "go", url: "https://x" }, new AbortController().signal)).toEqual({ action: "cancel" });
        expect(input.sample).toBeUndefined();
    });
});
