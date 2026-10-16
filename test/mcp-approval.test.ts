// Approving a project's .mcp.json servers: the fingerprint an approval is
// bound to, the settings file both front ends read and write, what the
// approval card shows, and that a server that isn't approved never starts,
// whichever way it's asked to.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { mcpFingerprint, describeServer, visible, McpApprovalError, saveApproval } = await import("../src/mcp/approval");
const { McpManager } = await import("../src/mcp/manager");
const { loadSettings } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");
const { trustFolder } = await import("../src/config/trust");
import type { McpServerConfig } from "../src/config/settings";
import type { McpManager as McpManagerT } from "../src/mcp/manager";

const FIXTURE = join(import.meta.dir, "fixtures", "mcp-stdio-server.ts");
const dirs: string[] = [];
const managers: McpManagerT[] = [];
afterAll(async () => {
    await Promise.all(managers.map((m) => m.closeAll()));
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
    iso.cleanup();
});

/** A project folder, trusted by the user (approving needs that) unless `userTrusted` is false. */
function folder(userTrusted = true): string {
    const d = tempDir("harness-mcp-approval-");
    dirs.push(d);
    if (userTrusted) trustFolder(d);
    return d;
}

/** The fixture server, leaving its pid in `marker` the moment it starts. */
function fixture(marker: string, env: Record<string, string> = {}): McpServerConfig {
    return { command: process.execPath, args: ["--no-env-file", FIXTURE], env: { MCP_FIXTURE_ERA: "legacy", MCP_FIXTURE_MARKER: marker, ...env } };
}

function writeMcp(dir: string, servers: Record<string, McpServerConfig>) {
    writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
}

/** A manager reading the real settings files, as the terminal app and the GUI server build theirs. */
function manager(dir: string, trusted = true): McpManagerT {
    let s = loadSettings(dir, { trusted });
    const m = new McpManager(dir, () => s, trusted, () => (s = loadSettings(dir, { trusted })));
    managers.push(m);
    return m;
}

const localSettings = (dir: string) => JSON.parse(readFileSync(paths.localSettings(dir), "utf-8"));

async function waitFor(cond: () => boolean, ms = 5000): Promise<boolean> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
        if (cond()) return true;
        await Bun.sleep(25);
    }
    return cond();
}

describe("the fingerprint an approval is bound to", () => {
    const dir = folder();
    mkdirSync(join(dir, "sub"));
    const base: McpServerConfig = { command: "node", args: ["server.js", "--port", "1"], cwd: "sub", env: { A: "1", B: "2" } };
    const fp = (c: McpServerConfig, d = dir) => mcpFingerprint(c, d);

    test("changes with the command, an argument, the folder, an env name or value, the url or a header", () => {
        const f = fp(base);
        expect(fp({ ...base, command: "nodejs" })).not.toBe(f);
        expect(fp({ ...base, args: ["server.js", "--port", "2"] })).not.toBe(f);
        expect(fp({ ...base, args: ["server.js", "--port 1"] })).not.toBe(f);
        expect(fp({ ...base, cwd: "." })).not.toBe(f);
        expect(fp({ ...base, env: { A: "1", B: "3" } })).not.toBe(f);
        expect(fp({ ...base, env: { A: "1", C: "2" } })).not.toBe(f);
        expect(fp({ ...base, env: { A: "1" } })).not.toBe(f);
        const remote: McpServerConfig = { url: "https://example.com/mcp", headers: { Authorization: "Bearer a", X: "1" } };
        expect(fp({ ...remote, url: "https://example.com/mcp2" })).not.toBe(fp(remote));
        expect(fp({ ...remote, headers: { Authorization: "Bearer b", X: "1" } })).not.toBe(fp(remote));
        // The same configuration in another folder is another approval.
        expect(fp(base, folder())).not.toBe(f);
    });

    test("doesn't change with key order or \"disabled\"", () => {
        const f = fp(base);
        expect(fp({ env: { B: "2", A: "1" }, cwd: "sub", args: ["server.js", "--port", "1"], command: "node" })).toBe(f);
        expect(fp({ ...base, disabled: true })).toBe(f);
        expect(fp({ ...base, cwd: "./sub" })).toBe(f);
        const remote: McpServerConfig = { url: "https://example.com/mcp", headers: { Authorization: "Bearer a", X: "1" } };
        expect(fp({ headers: { X: "1", Authorization: "Bearer a" }, url: "https://example.com/mcp" })).toBe(fp(remote));
    });

    test("is a keyed hash: no configuration (or secret) in it", () => {
        const f = fp({ ...base, env: { TOKEN: "sentinel-value-123456" } });
        expect(f).toMatch(/^v1:[0-9a-f]{64}$/);
        expect(existsSync(join(iso.home, "mcp-approval.key"))).toBe(true);
    });
});

describe("approve, reject and revoke write the folder's local settings, which both front ends read", () => {
    test("approve, revoke, reject and approve again", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker) });
        const gui = manager(dir);
        await gui.load();
        expect(gui.servers.get("srv")!.status).toBe("needs-approval");

        const st = await gui.approve("srv", gui.describe("srv")!.fingerprint!);
        expect(localSettings(dir).approvedMcpjsonServers).toEqual({ srv: mcpFingerprint(fixture(marker), dir) });
        // Another manager on the same folder (the terminal) sees it approved.
        const tui = manager(dir);
        await tui.load();
        expect(tui.servers.get("srv")!.status).toBe("pending");
        expect(tui.servers.get("srv")!.approval?.state).toBe("approved");

        await gui.start(st);
        expect(st.status).toBe("connected");
        const pid = Number(readFileSync(marker, "utf-8").trim());
        await gui.revoke("srv");
        expect(localSettings(dir).approvedMcpjsonServers).toBeUndefined();
        expect(gui.servers.get("srv")!.status).toBe("needs-approval");
        expect(await waitFor(() => !alive(pid))).toBe(true);

        await tui.reject("srv");
        expect(localSettings(dir).disabledMcpjsonServers).toEqual(["srv"]);
        await gui.refresh();
        expect(gui.servers.get("srv")!.approval?.state).toBe("rejected");
        expect(gui.servers.get("srv")!.status).toBe("disabled");

        // A rejected server can be approved later, through the same description.
        await gui.approve("srv", gui.describe("srv")!.fingerprint!);
        expect(localSettings(dir).disabledMcpjsonServers).toBeUndefined();
        expect(gui.servers.get("srv")!.status).toBe("pending");
    });

    test("a name-only approval from before asks once more, and says why", async () => {
        const dir = folder();
        writeMcp(dir, { old: { command: "echo" } });
        mkdirSync(join(dir, ".harness"));
        writeFileSync(paths.localSettings(dir), JSON.stringify({ enabledMcpjsonServers: ["old"] }));
        const m = manager(dir);
        await m.load();
        expect(m.servers.get("old")!.status).toBe("needs-approval");
        expect(m.describe("old")!.approval).toEqual({ state: "needs-approval", reason: "legacy" });
        expect(m.describe("old")!.why).toContain("by name only");
        await m.approve("old", m.describe("old")!.fingerprint!);
        expect(localSettings(dir).enabledMcpjsonServers).toBeUndefined();
    });

    test("enableAllProjectMcpServers in the user's settings approves every server, changes included; it can't be revoked one by one", async () => {
        const dir = folder();
        writeMcp(dir, { a: { command: "echo" } });
        writeFileSync(paths.userSettings(), JSON.stringify({ enableAllProjectMcpServers: true }));
        try {
            const m = manager(dir);
            await m.load();
            expect(m.servers.get("a")!.approval).toMatchObject({ state: "approved", viaAll: true });
            writeMcp(dir, { a: { command: "echo", args: ["changed"] } });
            await m.refresh();
            expect(m.servers.get("a")!.status).toBe("pending");
            await expect(m.revoke("a")).rejects.toThrow(/enableAllProjectMcpServers/);
        } finally {
            rmSync(paths.userSettings());
        }
    });

    test("refusals: unknown names, settings servers, and an untrusted folder", async () => {
        const dir = folder();
        writeMcp(dir, { p: { command: "echo" } });
        writeFileSync(paths.userSettings(), JSON.stringify({ mcpServers: { mine: { command: "echo" } } }));
        try {
            const m = manager(dir);
            await m.load();
            const code = (p: Promise<unknown>) => p.then(() => "none", (e) => (e instanceof McpApprovalError ? e.code : String(e)));
            expect(await code(m.approve("nope", "v1:x"))).toBe("unknown");
            expect(await code(m.approve("mine", "v1:x"))).toBe("not_project");
            expect(await code(m.revoke("p"))).toBe("not_needed");
            const u = manager(dir, false);
            await u.load();
            expect(await code(u.approve("p", m.describe("p")!.fingerprint!))).toBe("untrusted");
            expect(await code(u.reject("p"))).toBe("untrusted");
            expect(existsSync(paths.localSettings(dir))).toBe(false);
        } finally {
            rmSync(paths.userSettings());
        }
    });
});

describe("what the card shows", () => {
    test("each argument, the real folder, env and header names; never a value", () => {
        const dir = folder();
        mkdirSync(join(dir, "real"));
        symlinkSync(join(dir, "real"), join(dir, "link"));
        const secret = "sentinel-env-value-0123456789";
        const st = { name: "s", source: "project" as const, status: "needs-approval" as const, tools: [], config: { command: "node", args: ["a b", `--token=${secret}`, ""], cwd: "link", env: { API_TOKEN: secret, MODE: "x" } } };
        const info = describeServer(st, dir);
        expect(info.args).toEqual(["a b", "--token=[REDACTED env API_TOKEN]", ""]);
        expect(info.cwd).toBe(join(realDir(dir), "real"));
        expect(info.envNames).toEqual(["API_TOKEN", "MODE"]);
        expect(info.masked).toBe(true);
        expect(JSON.stringify(info)).not.toContain(secret);

        const remote = describeServer({ ...st, config: { url: `https://u:${secret}@example.com/mcp?api_key=${secret}&q=1`, headers: { Authorization: `Bearer ${secret}` } } }, dir);
        expect(remote.transport).toBe("http");
        expect(remote.headerNames).toEqual(["Authorization"]);
        expect(JSON.stringify(remote)).not.toContain(secret);
        expect(remote.url).toContain("q=1");
    });

    test("control and bidi characters show instead of rendering; long arguments and long lists are cut, and say so", () => {
        expect(visible("ls ‮txt.exe‬​\n").text).toBe("ls ⟨U+202E⟩txt.exe⟨U+202C⟩⟨U+200B⟩⟨U+000A⟩");
        const st = { name: "x‮", source: "project" as const, status: "needs-approval" as const, tools: [], config: { command: "rm\u0007", args: ["y".repeat(1000), ...Array.from({ length: 100 }, (_, i) => String(i))] } };
        const info = describeServer(st, folder());
        expect(info.hidden).toBe(true);
        expect(info.label).toBe("x⟨U+202E⟩");
        expect(info.command).toBe("rm⟨U+0007⟩");
        expect(info.args![0]!.length).toBeLessThanOrEqual(401);
        expect(info.args!.length).toBe(64);
        expect(info.cut).toContain("argument 1");
        expect(info.cut).toContain("37 more arguments not shown");
    });
});

function realDir(d: string): string {
    return realpathSync(d);
}

function alive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

describe("a server that isn't approved never starts", () => {
    /** Every way a server can be asked to start: at startup, on refresh, by reconnecting, restarting, or start() itself. */
    async function tryEverything(m: McpManagerT, name: string) {
        await m.load();
        await m.startAll();
        await m.sync();
        await m.reconnect(name).catch(() => undefined);
        await m.restart(name);
        const st = m.servers.get(name);
        if (st) await m.start(st);
        // Long enough for the fixture to have written its marker, had it started.
        await Bun.sleep(400);
    }

    test("the fixture does leave its marker when it may start (so the checks below mean something)", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { ok: fixture(marker) });
        saveApproval(dir, "ok", mcpFingerprint(fixture(marker), dir));
        const m = manager(dir);
        await m.load();
        await m.startAll();
        expect(m.servers.get("ok")!.status).toBe("connected");
        expect(await waitFor(() => existsSync(marker))).toBe(true);
    });

    test("unapproved", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker) });
        const m = manager(dir);
        await tryEverything(m, "srv");
        expect(m.servers.get("srv")!.status).toBe("needs-approval");
        expect(existsSync(marker)).toBe(false);
    });

    test("rejected", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker) });
        const m = manager(dir);
        await m.load();
        await m.reject("srv");
        await tryEverything(m, "srv");
        expect(m.servers.get("srv")!.status).toBe("disabled");
        expect(existsSync(marker)).toBe(false);
    });

    test("its command changed after it was approved", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        const first = fixture(marker);
        writeMcp(dir, { srv: first });
        saveApproval(dir, "srv", mcpFingerprint(first, dir));
        writeMcp(dir, { srv: { ...first, args: [...first.args!, "--extra"] } });
        const m = manager(dir);
        await tryEverything(m, "srv");
        expect(m.servers.get("srv")!.approval).toMatchObject({ state: "needs-approval", reason: "changed" });
        expect(existsSync(marker)).toBe(false);
    });

    test("approved only in the committed project settings", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker) });
        mkdirSync(join(dir, ".harness"));
        writeFileSync(paths.projectSettings(dir), JSON.stringify({ approvedMcpjsonServers: { srv: mcpFingerprint(fixture(marker), dir) }, enableAllProjectMcpServers: true }));
        const m = manager(dir);
        await tryEverything(m, "srv");
        expect(m.servers.get("srv")!.status).toBe("needs-approval");
        expect(existsSync(marker)).toBe(false);
    });

    test("any server in an untrusted folder, even approved in its local settings", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker) });
        saveApproval(dir, "srv", mcpFingerprint(fixture(marker), dir));
        const m = manager(dir, false);
        await tryEverything(m, "srv");
        expect(m.servers.has("srv")).toBe(false);
        await expect(m.reconnect("srv")).rejects.toThrow(/no MCP server/);
        expect(existsSync(marker)).toBe(false);
    });

    test("approving with a stale fingerprint", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: { command: "echo" } });
        const m = manager(dir);
        await m.load();
        const shown = m.describe("srv")!.fingerprint!;
        writeMcp(dir, { srv: fixture(marker) });
        await expect(m.approve("srv", shown)).rejects.toMatchObject({ code: "changed" });
        expect(existsSync(paths.localSettings(dir))).toBe(false);
        await tryEverything(m, "srv");
        expect(existsSync(marker)).toBe(false);
    });
});

test("the folder reached through a symlink is the same approval", () => {
    const dir = folder();
    const link = join(folder(), "link");
    symlinkSync(dir, link);
    const c: McpServerConfig = { command: "echo" };
    expect(mcpFingerprint(c, link)).toBe(mcpFingerprint(c, dir));
});

describe("review fixes", () => {
    test("a committed __proto__ key or a shipped settings.local.json can't turn on the blanket approval", async () => {
        for (const file of ["settings.json", "settings.local.json"]) {
            const dir = folder();
            const marker = join(dir, "started");
            writeMcp(dir, { srv: fixture(marker) });
            mkdirSync(join(dir, ".harness"));
            writeFileSync(join(dir, ".harness", file), file === "settings.json" ? '{"__proto__": {"enableAllProjectMcpServers": true}}' : '{"enableAllProjectMcpServers": true}');
            const m = manager(dir);
            await m.load();
            await m.startAll();
            await m.reconnect("srv");
            await Bun.sleep(400);
            expect(m.servers.get("srv")!.status).toBe("needs-approval");
            expect(existsSync(marker)).toBe(false);
        }
    });

    test("a revoke while a reconnect waits for the old process leaves nothing running", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker) });
        saveApproval(dir, "srv", mcpFingerprint(fixture(marker), dir));
        const m = manager(dir);
        await m.load();
        await m.startAll();
        expect(m.servers.get("srv")!.status).toBe("connected");
        const restarting = m.restart("srv");
        await m.revoke("srv");
        await restarting;
        await Bun.sleep(400);
        const pids = readFileSync(marker, "utf-8").trim().split("\n").map(Number);
        expect(pids).toHaveLength(1);
        expect(await waitFor(() => pids.every((p) => !alive(p)))).toBe(true);
        expect(m.servers.get("srv")!.status).toBe("needs-approval");
    });

    test("Enable after another front end rejected it starts nothing", async () => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker) });
        saveApproval(dir, "srv", mcpFingerprint(fixture(marker), dir));
        const tui = manager(dir);
        await tui.load();
        await tui.startAll();
        // "Disable for this session", as /mcp does it.
        const st = tui.servers.get("srv")!;
        await st.client?.close();
        st.client = undefined;
        st.status = "disabled";
        const gui = manager(dir);
        await gui.load();
        await gui.reject("srv");
        await tui.enable("srv");
        await Bun.sleep(400);
        expect(readFileSync(marker, "utf-8").trim().split("\n")).toHaveLength(1);
        expect(tui.servers.get("srv")!.approval?.state).toBe("rejected");
    });

    test("a name collision that's gone doesn't keep the server failed", async () => {
        const dir = folder();
        writeMcp(dir, {});
        let s: any = { mcpServers: { "a.b": { command: "echo", disabled: true }, a_b: fixture(join(dir, "started")) } };
        const m = new McpManager(dir, () => s, true);
        managers.push(m);
        await m.load();
        expect(m.servers.get("a_b")!.collidesWith).toBe("a.b");
        s = { mcpServers: { a_b: fixture(join(dir, "started")) } };
        await m.load();
        await m.reconnect("a_b");
        expect(m.servers.get("a_b")!.status).toBe("connected");
    });

    test("config values are masked in short form, against forged markers, and in tool output", async () => {
        const st = { name: "s", source: "project" as const, status: "needs-approval" as const, tools: [], config: { command: "x", args: ["--pin=12345", "[REDACTED sentinel-forged-value]"], env: { PIN: "12345", T: "sentinel-forged-value" } } };
        const info = describeServer(st, folder());
        expect(JSON.stringify(info)).not.toContain("12345");
        expect(JSON.stringify(info)).not.toContain("sentinel-forged-value");

        const dir = folder();
        const secret = "sentinel-tool-output-value";
        const m = new McpManager(dir, () => ({ mcpServers: { echo: fixture(join(dir, "started"), { TOKEN: secret }) } }), false);
        managers.push(m);
        await m.load();
        await m.startAll();
        const echo = m.tools().find((t) => t.name === "mcp__echo__echo")!;
        const r = await echo.run({ text: `the token is ${secret}` }, { signal: new AbortController().signal } as never);
        expect(r.content).toBe("echo: the token is [REDACTED env TOKEN]");
    });

    test("the list stays bounded: a server with a huge name isn't loaded, and is counted", async () => {
        const dir = folder();
        writeMcp(dir, { ["n".repeat(5000)]: { command: "echo" }, ok: { command: "echo" } });
        const m = manager(dir);
        await m.load();
        expect([...m.servers.keys()]).toEqual(["ok"]);
        expect(m.list().omitted).toBe(1);
    });
});

describe("second review", () => {
    const approved = async (env: Record<string, string> = {}) => {
        const dir = folder();
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker, env) });
        saveApproval(dir, "srv", mcpFingerprint(fixture(marker, env), dir));
        const m = manager(dir);
        await m.load();
        await m.startAll();
        expect(m.servers.get("srv")!.status).toBe("connected");
        return { m, marker };
    };
    const pidsIn = (marker: string) => readFileSync(marker, "utf-8").trim().split("\n").map(Number);
    const ctx = { signal: new AbortController().signal } as never;

    test("a reconnect that waited on the old process doesn't orphan the one started meanwhile", async () => {
        const { m, marker } = await approved();
        const st = m.servers.get("srv")!;
        const first = st.client!;
        let release!: () => void;
        const gate = new Promise<void>((r) => (release = r));
        // The old process takes its time to stop: one reconnect waits for it while another connects a new one.
        st.client = { close: () => gate.then(() => first.close()) } as never;
        const waiting = m.restart("srv");
        await m.start(st);
        expect(st.status).toBe("connected");
        release();
        await waiting;
        expect(m.servers.get("srv")!.status).toBe("connected");
        expect(await waitFor(() => pidsIn(marker).filter(alive).length === 1)).toBe(true);
        await m.closeAll();
        expect(await waitFor(() => pidsIn(marker).every((p) => !alive(p)))).toBe(true);
    });

    test("a tool listed before a revoke doesn't run after it", async () => {
        const { m } = await approved();
        const echo = m.tools().find((t) => t.name === "mcp__srv__echo")!;
        await m.revoke("srv");
        const r = await echo.run({ text: "hi" }, ctx);
        expect(r.isError).toBe(true);
        expect(r.content).toContain("isn't running any more");
    });

    test("a value that JSON would escape is masked before the result is serialized", async () => {
        const secret = 'alpha"beta\\gamma';
        const { m } = await approved({ TOKEN: secret });
        const echo = m.tools().find((t) => t.name === "mcp__srv__echo")!;
        const r = await echo.run({ text: secret }, ctx);
        expect(r.content).toBe("echo: [REDACTED env TOKEN]");
    });
});

describe("a folder trusted only for having had nothing to protect", () => {
    test("its servers can't be approved, and the blanket opt-in doesn't cover them, until the user trusts it", async () => {
        const dir = folder(false);
        const marker = join(dir, "started");
        writeMcp(dir, { srv: fixture(marker) });
        writeFileSync(paths.userSettings(), JSON.stringify({ enableAllProjectMcpServers: true }));
        try {
            // trusted: true, as the terminal and the GUI open such a folder (trustForSession).
            const m = manager(dir, true);
            await m.load();
            await m.startAll();
            expect(m.servers.get("srv")!.status).toBe("needs-approval");
            await expect(m.approve("srv", m.describe("srv")!.fingerprint!)).rejects.toMatchObject({ code: "needs_trust" });
            expect(existsSync(paths.localSettings(dir))).toBe(false);
            await m.reconnect("srv");
            await Bun.sleep(400);
            expect(existsSync(marker)).toBe(false);

            trustFolder(dir);
            await m.sync();
            // Now the user's blanket approval covers it.
            expect(m.servers.get("srv")!.approval).toMatchObject({ state: "approved", viaAll: true });
            expect(await waitFor(() => m.servers.get("srv")!.status === "connected")).toBe(true);
        } finally {
            rmSync(paths.userSettings());
        }
    });
});

describe("line breaks in errors", () => {
    test("an error keeps its line breaks and still shows other invisible characters; commands and args don't", () => {
        expect(visible("a\r\nb\n\u202Ec", { lineBreaks: true }).text).toBe("a\nb\n⟨U+202E⟩c");
        const st = { name: "s", source: "settings" as const, status: "failed" as const, tools: [], error: "server is not running\nfixture told to fail\u0007", config: { command: "a\nb", args: ["c\nd"] } };
        const info = describeServer(st, folder());
        expect(info.error).toBe("server is not running\nfixture told to fail⟨U+0007⟩");
        expect(info.command).toBe("a⟨U+000A⟩b");
        expect(info.args).toEqual(["c⟨U+000A⟩d"]);
    });
});
