import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir, FAKE } from "./helpers/isolate";
import type { McpServerConfig } from "../src/config/settings";

const iso = isolate();
const { McpManager, mayStart } = await import("../src/mcp/manager");
const { McpClient, MODERN_VERSION } = await import("../src/mcp/client");
const { describeServer, mcpFingerprint, saveApproval } = await import("../src/mcp/approval");
const { loadSettings } = await import("../src/config/settings");
const { trustFolder } = await import("../src/config/trust");
const FIXTURE = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
const dirs: string[] = [];
const managers: InstanceType<typeof McpManager>[] = [];
const ctx = { signal: new AbortController().signal } as never;

afterAll(async () => {
    await Promise.all(managers.map((m) => m.closeAll()));
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
    iso.cleanup();
});

function folder(): string {
    const dir = tempDir("cavvy-mcp-review-");
    dirs.push(dir);
    trustFolder(dir);
    return dir;
}

function writeMcp(dir: string, config?: McpServerConfig) {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: config ? { srv: config } : {} }));
}

function fixture(dir: string): McpServerConfig {
    return { command: process.execPath, args: ["--no-env-file", FIXTURE], env: { MCP_FIXTURE_MARKER: join(dir, "started") } };
}

async function manager(dir: string, cached = true) {
    // Deliberately cached, with no reload callback: the headless path must recheck persistence too.
    const settings = loadSettings(dir, { trusted: true });
    const m = new McpManager(dir, () => cached ? settings : loadSettings(dir, { trusted: true }), true);
    managers.push(m);
    await m.load();
    return m;
}

async function approved(dir: string, config = fixture(dir)) {
    writeMcp(dir, config);
    saveApproval(dir, "srv", mcpFingerprint(config, dir));
    return manager(dir);
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((r) => { resolve = r; });
    return { promise, resolve };
}

const pids = (dir: string) => readFileSync(join(dir, "started"), "utf8").trim().split("\n").map(Number);
function alive(pid: number): boolean {
    try { process.kill(pid, 0); return true; } catch { return false; }
}
async function stopped(pid: number): Promise<boolean> {
    for (let i = 0; i < 100 && alive(pid); i++) await Bun.sleep(20);
    return !alive(pid);
}

test("spawn uses the approved folder even if its symlink is retargeted after the check", async () => {
    const dir = folder();
    for (const sub of ["one", "two"]) mkdirSync(join(dir, sub));
    const link = join(dir, "link");
    symlinkSync(join(dir, "one"), link);
    const config = { ...fixture(dir), cwd: "link", env: { MCP_FIXTURE_MARKER: "started" } };
    const m = await approved(dir, config);
    let retargeted = false;
    m.onChange = () => {
        if (!retargeted && m.servers.get("srv")?.status === "connecting") {
            retargeted = true;
            rmSync(link);
            symlinkSync(join(dir, "two"), link);
        }
    };
    await m.startAll();
    expect(retargeted).toBe(true);
    expect(m.servers.get("srv")!.status).toBe("connected");
    expect(existsSync(join(dir, "one", "started"))).toBe(true);
    expect(existsSync(join(dir, "two", "started"))).toBe(false);
});

describe("persisted approval is checked without a refresh", () => {
    for (const decision of ["revoke", "reject"] as const) {
        test(`${decision} in another manager prevents a pending reconnect from spawning`, async () => {
            const dir = folder();
            const m = await approved(dir);
            await m.startAll();
            const st = m.servers.get("srv")!;
            const old = st.client!;
            const gate = deferred<void>();
            st.client = { close: () => gate.promise.then(() => old.close()) } as never;
            const restarting = m.restart("srv");
            try {
                const other = await manager(dir, false);
                await other[decision]("srv");
            } finally { gate.resolve(); }
            await restarting;
            expect(pids(dir)).toHaveLength(1);
            expect(await stopped(pids(dir)[0]!)).toBe(true);
            expect(m.servers.get("srv")!.approval?.state).toBe(decision === "reject" ? "rejected" : "needs-approval");
        });

        test(`${decision} in another manager refuses a cached tool and stops its client`, async () => {
            const dir = folder();
            const m = await approved(dir);
            await m.startAll();
            const echo = m.tools().find((t) => t.name === "mcp__srv__echo")!;
            const other = await manager(dir, false);
            await other[decision]("srv");
            const result = await echo.run({ text: "must not run" }, ctx);
            expect(result.isError).toBe(true);
            expect(result.content).not.toContain("echo:");
            expect(await stopped(pids(dir)[0]!)).toBe(true);
        });
    }

    for (const change of ["command", "cwd", "disabled", "removed"] as const) {
        test(`a persisted ${change} change refuses both cached tools and startup`, async () => {
            const dir = folder();
            const config = fixture(dir);
            const m = await approved(dir, config);
            await m.startAll();
            const echo = m.tools().find((t) => t.name === "mcp__srv__echo")!;
            const pending = await manager(dir);
            mkdirSync(join(dir, "other"));
            const changed = change === "command" ? { ...config, args: [...config.args!, "changed"] }
                : change === "cwd" ? { ...config, cwd: "other" }
                : change === "disabled" ? { ...config, disabled: true } : undefined;
            writeMcp(dir, changed);
            await pending.startAll();
            expect((await echo.run({ text: "must not run" }, ctx)).isError).toBe(true);
            expect(pids(dir)).toHaveLength(1);
            expect(await stopped(pids(dir)[0]!)).toBe(true);
        });
    }
});

for (const method of ["server/discover", "tools/list"] as const) {
    test(`close aborts delayed ${method} and sends neither fallback nor another page`, async () => {
        const received = deferred<void>();
        const release = deferred<void>();
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(req) {
                const body = await req.json() as { method: string; id: number };
                requests.push(body.method);
                if (body.method === method) {
                    received.resolve();
                    await release.promise;
                    return Response.json(method === "server/discover"
                        ? { jsonrpc: "2.0", id: body.id, error: { code: -32601, message: "legacy only" } }
                        : { jsonrpc: "2.0", id: body.id, result: { tools: [], nextCursor: "next" } });
                }
                return Response.json({ jsonrpc: "2.0", id: body.id, result: { supportedVersions: [MODERN_VERSION], protocolVersion: "2025-06-18" } });
            },
        });
        const client = new McpClient("delay", { url: server.url.href, headers: { Authorization: "Bearer synthetic-token" } }, folder());
        try {
            if (method === "tools/list") await client.connect();
            const pending = (method === "tools/list" ? client.listTools() : client.connect()).then(() => "succeeded", () => "aborted");
            await received.promise;
            await client.close();
            // Must finish before the server releases its delayed response.
            expect(await Promise.race([pending, Bun.sleep(500).then(() => "still pending")])).toBe("aborted");
            release.resolve();
            await pending;
            await expect(client.connect()).rejects.toThrow(/closed/);
            await expect(client.listTools()).rejects.toThrow(/closed/);
            await expect(client.callTool("echo", {})).rejects.toThrow(/closed/);
            await Bun.sleep(30);
            expect(requests).toEqual(method === "server/discover" ? [method] : ["server/discover", method]);
        } finally {
            release.resolve();
            await client.close();
            server.stop(true);
        }
    });
}

test("credential flag values are hidden, both forms, while ordinary arguments remain exact", () => {
    const info = describeServer({ name: "srv", source: "project", status: "needs-approval", tools: [], config: {
        command: "node", args: ["server.js", "--password", "synthetic-value", "--access-token=synthetic-token", "--api-key", "abc", "--client-secret=xyz", "--token-file", "file name", "--port=1234", "a b", "\"quoted\""],
    } }, folder());
    expect(info.args).toEqual(["server.js", "--password", "[REDACTED]", "--access-token=[REDACTED]", "--api-key", "[REDACTED]", "--client-secret=[REDACTED]", "--token-file", "file name", "--port=1234", "a b", "\"quoted\""]);
    expect(info.masked).toBe(true);
});

/** An HTTP fixture that deliberately echoes credential-bearing data through each server-controlled surface. */
function echoServer() {
    let failing = false;
    let secretTool = false;
    const password = "synthetic-password";
    const token = "synthetic-token";
    const envSecret = "synthetic_env_secret";
    const requests: string[] = [];
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(req) {
            const b = await req.json() as { method: string; id: number; params: { name?: string } };
            requests.push(b.method);
            const echo = `https://u:${password}@example.com/?token=${token}`;
            if (failing || b.params.name === "error") return Response.json({ jsonrpc: "2.0", id: b.id, error: { code: 401, message: echo } });
            const result = b.method === "server/discover" ? { supportedVersions: [MODERN_VERSION] }
                : b.method === "tools/list" ? { tools: ["echo", "error", ...(secretTool ? [`leak_${envSecret}`] : [])].map((name) => ({ name, inputSchema: { type: "object" } })) }
                : { content: [], structuredContent: { [envSecret]: { [token]: echo } } };
            return Response.json({ jsonrpc: "2.0", id: b.id, result });
        },
    });
    return { server, requests, password, token, envSecret, fail: () => { failing = true; }, secretTool: (v: boolean) => { secretTool = v; } };
}

test("URL credentials are masked in connection errors and tool errors, without env/header copies", async () => {
    const f = echoServer();
    const dir = folder();
    // Fetch refuses userinfo; that error may echo it. Query values also travel in MCP errors.
    const config = { url: `${f.server.url.href}?token=${f.token}&password=${f.password}` };
    const m = await approved(dir, config);
    try {
        await m.startAll();
        expect(m.servers.get("srv")!.status).toBe("connected");
        const error = m.tools().find((t) => t.name === "mcp__srv__error")!;
        const result = await error.run({}, ctx);
        expect(result.isError).toBe(true);
        expect(result.content).not.toContain(f.password);
        expect(result.content).not.toContain(f.token);
        expect(result.content).toContain("REDACTED");
        f.fail();
        await m.restart("srv");
        expect(m.servers.get("srv")!.status).toBe("failed");
        const shown = JSON.stringify(m.list());
        expect(shown).not.toContain(f.password);
        expect(shown).not.toContain(f.token);
        const { maskConfigValues } = await import("../src/mcp/approval");
        const url = `https://u:synthetic%20password@example.com/?token=synthetic%20token`;
        const masked = maskConfigValues(`${url} synthetic password synthetic token`, { url });
        expect(masked).not.toContain("synthetic");
        const encoded = "https://example.com/?to%6ben=synthetic%20token&api_key=synthetic+key&q=visible";
        expect(maskConfigValues(`${encoded} synthetic token synthetic key`, { url: encoded })).not.toContain("synthetic");
        const card = describeServer({ name: "srv", source: "project", status: "needs-approval", tools: [], config: { url: encoded } }, dir);
        expect(card.url).not.toContain("synthetic");
        expect(card.url).toContain("q=visible");
    } finally { await m.closeAll(); f.server.stop(true); }
});

test("case-duplicate headers are refused by the shared start policy without any HTTP request", async () => {
    const f = echoServer();
    try {
        for (const headers of [{ Authorization: "one", authorization: "two" }, { authorization: "two", Authorization: "one" }]) {
            const m = await approved(folder(), { url: f.server.url.href, headers });
            expect(mayStart(m.servers.get("srv")!)).toBe(false);
            await m.startAll();
            expect(m.servers.get("srv")!.status).toBe("failed");
            expect(m.describe("srv")!.error).toContain("same header");
            expect(m.servers.get("srv")!.client).toBeUndefined();
        }
        expect(f.requests).toEqual([]);
    } finally { f.server.stop(true); }
});

test("structured keys are masked and tools with secret-bearing names are hidden, including updates", async () => {
    const f = echoServer();
    f.secretTool(true);
    const m = await approved(folder(), { url: `${f.server.url.href}?token=${f.token}`, env: { TOKEN: f.envSecret } });
    try {
        await m.startAll();
        const st = m.servers.get("srv")!;
        expect(st.status).toBe("connected");
        expect(m.tools().map((t) => t.name)).toEqual(["mcp__srv__echo", "mcp__srv__error"]);
        expect(m.describe("srv")!.error).toContain("1 tool was hidden");
        expect(JSON.stringify(m.list())).not.toContain(f.envSecret);
        const result = await m.tools()[0]!.run({}, ctx);
        expect(result.content).not.toContain(f.envSecret);
        expect(result.content).not.toContain(f.token);
        expect(Object.keys(JSON.parse(result.content))).toContain("[REDACTED env TOKEN]");
        f.secretTool(false);
        const changed = deferred<void>();
        m.onChange = () => changed.resolve();
        st.client!.onToolsChanged!();
        await changed.promise;
        expect(st.error).toBeUndefined();
        f.secretTool(true);
        const changedAgain = deferred<void>();
        m.onChange = () => changedAgain.resolve();
        st.client!.onToolsChanged!();
        await changedAgain.promise;
        expect(m.tools()).toHaveLength(2);
        expect(st.error).toContain("1 tool was hidden");
    } finally { await m.closeAll(); f.server.stop(true); }
});

for (const stage of ["server/discover", "tools/list"] as const) {
    test(`a disk revoke during ${stage} stops the in-flight client before it becomes connected`, async () => {
        const dir = folder();
        const received = deferred<void>();
        const release = deferred<void>();
        const requests: string[] = [];
        const server = Bun.serve({
            hostname: "127.0.0.1", port: 0,
            async fetch(req) {
                const body = await req.json() as { method: string; id: number };
                requests.push(body.method);
                if (body.method === stage) {
                    received.resolve();
                    await release.promise;
                }
                return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "server/discover"
                    ? { supportedVersions: [MODERN_VERSION] }
                    : { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
            },
        });
        const m = await approved(dir, { url: server.url.href });
        let connecting: Promise<void> | undefined;
        try {
            connecting = m.startAll();
            await received.promise;
            const client = m.servers.get("srv")!.client!;
            expect(client.closed).toBe(false);
            // Write exactly what the other app persists, without calling refresh/revoke on this manager.
            const { removeApproval } = await import("../src/mcp/approval");
            removeApproval(dir, "srv");
            release.resolve();
            await connecting;
            expect(client.closed).toBe(true);
            expect(m.servers.get("srv")!.status).toBe("needs-approval");
            expect(m.tools()).toEqual([]);
            expect(requests).toEqual(stage === "server/discover" ? [stage] : ["server/discover", stage]);
        } finally {
            release.resolve();
            await connecting;
            await m.closeAll();
            server.stop(true);
        }
    });
}

test("ordinary env values preserve text, images and schemas; credential values are still masked", async () => {
    const env = { MODE: "text", SECTION: "content", FIELD: "properties", LOG_LEVEL: "info", FORMAT: "json", TOKEN: "s3cr3t" };
    const schema = { type: "object", properties: { text: { type: "string", description: "text content properties info json" } }, required: ["text"] };
    const image = { type: "image" as const, mimeType: "image/png", data: "cGl4ZWw=" };
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(req) {
            const body = await req.json() as { method: string; id: number };
            return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "server/discover"
                ? { supportedVersions: [MODERN_VERSION] }
                : body.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: schema }] }
                : { content: [{ type: "text", text: "text content properties info json s3cr3t" }, image] } });
        },
    });
    const m = await approved(folder(), { url: server.url.href, env });
    try {
        await m.startAll();
        const tool = m.tools()[0]!;
        expect(tool.parameters).toEqual(schema);
        const result = await tool.run({}, ctx);
        expect(result.isError).toBe(false);
        expect(result.content).toBe("text content properties info json [REDACTED env TOKEN]");
        expect(result.images).toEqual([{ type: "image", mediaType: image.mimeType, data: image.data }]);
    } finally {
        await m.closeAll();
        server.stop(true);
    }
});

test("a tool with a secret in a nested schema property is hidden without renaming its contract", async () => {
    const secret = "property-secret";
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(req) {
            const body = await req.json() as { method: string; id: number };
            return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "server/discover"
                ? { supportedVersions: [MODERN_VERSION] }
                : { tools: [
                    { name: "unsafe", inputSchema: { type: "object", properties: { values: { type: "array", items: { anyOf: [{ type: "object", properties: { [secret]: { type: "string" } } }] } } } } },
                    { name: "safe", inputSchema: { type: "object", description: secret, properties: { value: { type: "string", title: secret } } } },
                ] } });
        },
    });
    const m = await approved(folder(), { url: server.url.href, env: { SECRET: secret } });
    try {
        await m.startAll();
        expect(m.tools().map((t) => t.name)).toEqual(["mcp__srv__safe"]);
        expect(m.tools()[0]!.parameters).toEqual({ type: "object", description: "[REDACTED env SECRET]", properties: { value: { type: "string", title: "[REDACTED env SECRET]" } } });
        expect(m.describe("srv")!.error).toContain("input schema");
        expect(JSON.stringify(m.tools())).not.toContain(secret);
    } finally {
        await m.closeAll();
        server.stop(true);
    }
});


test("only credential-named or long env/header values count as secrets", async () => {
    const { maskConfigValues } = await import("../src/mcp/approval");
    const long = "v".repeat(20);
    const ordinary = "n".repeat(19);
    const config = { env: { MODE: "text", LOG_LEVEL: "info", FORMAT: "json", FIELD: "properties", SETTING: ordinary, OTHER: long, TOKEN: "abc" }, headers: { "X-Mode": "content", Authorization: "Bearer xy", Cookie: "id=zw" } };
    const masked = maskConfigValues(`text info json properties content ${ordinary} ${long} abc xy zw`, config);
    expect(masked).toBe(`text info json properties content ${ordinary} [REDACTED env OTHER] [REDACTED env TOKEN] [REDACTED header Authorization] [REDACTED header Cookie]`);
});

test("final tool results mask secrets in resource URIs and omitted media MIME strings", async () => {
    const secret = "resource-secret-value";
    const uri = `https://example.com/resource?token=${secret}`;
    const escaped = 'payload"secret\\value';
    let content: unknown[] = [];
    let structuredContent: unknown;
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(req) {
            const body = await req.json() as { method: string; id: number };
            return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "server/discover"
                ? { supportedVersions: [MODERN_VERSION] }
                : body.method === "tools/list" ? { tools: [{ name: "echo", inputSchema: { type: "object" } }] }
                : { content, structuredContent } });
        },
    });
    const m = await approved(folder(), { url: server.url.href, env: { TOKEN: secret, SECRET: escaped } });
    try {
        await m.startAll();
        const tool = m.tools()[0]!;
        const samples = [
            { type: "resource_link", uri, name: "link" },
            { type: "resource", resource: { uri, text: "body" } },
            { type: "resource", resource: { uri, blob: "AAAA", mimeType: `application/${secret}` } },
            { type: "audio", data: "AAAA", mimeType: `audio/${secret}` },
            { type: "image", data: "AAAA", mimeType: `image/${secret}` },
        ];
        for (const sample of samples) {
            content = [sample];
            const result = await tool.run({}, ctx);
            expect(result.isError).toBe(false);
            expect(JSON.stringify(result)).not.toContain(secret);
            expect(result.content).toContain("[REDACTED env TOKEN]");
        }
        content = [];
        structuredContent = { [escaped]: escaped };
        const structured = await tool.run({}, ctx);
        expect(JSON.parse(structured.content)).toEqual({ "[REDACTED env SECRET]": "[REDACTED env SECRET]" });
        structuredContent = undefined;
        // Generic credentials are redacted at the same final boundary, with the output still bounded.
        content = [{ type: "text", text: `key=${FAKE.anthropic}` }];
        const key = await tool.run({}, ctx);
        expect(key.content).not.toContain(FAKE.anthropic);
        expect(key.content).toContain("[REDACTED anthropic-key]");
        // Put a secret across the formatter's former truncation boundary (40% of 40,000).
        content = [{ type: "text", text: "x".repeat(15_995) + secret + "x".repeat(100_000) }];
        const big = await tool.run({}, ctx);
        expect(big.content.length).toBeLessThan(41_000);
        expect(big.content).toContain("characters");
        expect(big.content).not.toContain(secret.slice(0, 5));
    } finally {
        await m.closeAll();
        server.stop(true);
    }
});

test("serialized schema screening hides dependency arrays and extension keys without changing ordinary schemas", async () => {
    const secret = "schema-secret-value";
    const escaped = 'schema"secret\\value';
    const ordinary = { type: "object", properties: { trigger: { type: "string" } }, additionalProperties: false };
    const server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        async fetch(req) {
            const body = await req.json() as { method: string; id: number };
            return Response.json({ jsonrpc: "2.0", id: body.id, result: body.method === "server/discover"
                ? { supportedVersions: [MODERN_VERSION] }
                : { tools: [
                    { name: "dependency", inputSchema: { ...ordinary, dependencies: { trigger: [secret] } } },
                    { name: "extension", inputSchema: { ...ordinary, [secret]: true } },
                    { name: "escaped_key", inputSchema: { ...ordinary, [escaped]: true } },
                    { name: "escaped_value", inputSchema: { ...ordinary, dependencies: { trigger: [escaped] } } },
                    { name: "literal_const", inputSchema: { ...ordinary, properties: { value: { const: { description: secret } } } } },
                    { name: "literal_enum", inputSchema: { ...ordinary, properties: { value: { enum: [{ title: secret }] } } } },
                    { name: "ordinary", inputSchema: ordinary },
                ] } });
        },
    });
    const m = await approved(folder(), { url: server.url.href, env: { TOKEN: secret, SECRET: escaped } });
    try {
        await m.startAll();
        expect(m.tools().map((tool) => tool.name)).toEqual(["mcp__srv__ordinary"]);
        expect(m.tools()[0]!.parameters).toEqual(ordinary);
        expect(m.describe("srv")!.error).toContain("6 tools were hidden");
    } finally {
        await m.closeAll();
        server.stop(true);
    }
});
