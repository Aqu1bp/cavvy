import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { ApprovedMcpServers } from "../src/mcp/manager";
import type { McpServerConfig } from "../src/config/settings";

const { cleanup } = isolate();
const { claudeMcpPolicy } = await import("../src/backends/claude-mcp-policy");
const { McpManager } = await import("../src/mcp/manager");
const { mcpFingerprint, removeApproval, saveApproval, saveRejection } = await import("../src/mcp/approval");
const { loadSettings } = await import("../src/config/settings");
const dirs: string[] = [];
afterAll(() => {
    cleanup();
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

let root: string;
let cwd: string;
beforeEach(() => {
    root = realpathSync(tempDir("claude-mcp-policy-"));
    dirs.push(root);
    cwd = join(root, "workspace");
    mkdirSync(cwd);
});

const config = (): McpServerConfig => ({ command: "node", args: ["./server.js"], env: { A: "private-sentinel", B: "second" } });
const write = (servers: Record<string, unknown>, dir = cwd) => writeFileSync(join(dir, ".mcp.json"), JSON.stringify({ mcpServers: servers }));
const snapshot = (servers: Record<string, McpServerConfig>): ApprovedMcpServers => ({
    cwd,
    servers: Object.fromEntries(Object.entries(servers).map(([name, config]) => [name, { source: "project", config, fingerprint: mcpFingerprint(config, cwd) }])),
});
const expectStrict = (result: ReturnType<typeof claudeMcpPolicy>) => {
    expect(result.strict).toBe(true);
    expect(result.settings).toBeUndefined();
    expect(result.warning).toMatch(/strict MCP isolation/);
    expect(result.warning).not.toContain("private-sentinel");
};

describe("Claude native project MCP policy", () => {
    test("an empty workspace preserves native user servers and reserves delegation", () => {
        expect(claudeMcpPolicy(cwd, snapshot({}))).toEqual({ strict: false, settings: { enabledMcpjsonServers: [], disabledMcpjsonServers: ["cavvy"] } });
    });

    test("only exact project definitions are enabled; settings-source names cannot approve project copies", () => {
        const cfg = config();
        write({ approved: cfg, pending: cfg, cavvy: cfg, settings: cfg });
        const approved = snapshot({ approved: cfg, cavvy: cfg });
        approved.servers.settings = { source: "settings", config: cfg };
        expect(claudeMcpPolicy(cwd, approved)).toEqual({ strict: false, settings: {
            enabledMcpjsonServers: ["approved"], disabledMcpjsonServers: ["cavvy", "pending", "settings"],
        } });
    });

    test("manager approvals preserve raw project definitions and cannot be replaced by legacy names or connection status", () => {
        const cfg = { ...config(), type: "stdio" };
        const clash = { url: "https://example.invalid/mcp", headers: { Authorization: "one", authorization: "two" } };
        const servers = { approved: cfg, legacy: cfg, pending: cfg, rejected: cfg, clash, disabled: { ...cfg, disabled: true }, same__name: cfg };
        write(servers);
        for (const name of ["approved", "clash", "disabled", "same__name"] as const) saveApproval(cwd, name, mcpFingerprint(servers[name], cwd));
        const manager = new McpManager(cwd, () => ({
            ...loadSettings(cwd, { trusted: true }),
            mcpServers: { same_name: cfg },
            enabledMcpjsonServers: ["legacy"],
            disabledMcpjsonServers: ["rejected"],
        }), true);
        manager.load();
        for (const st of manager.servers.values()) st.status = "failed";
        expect(manager.servers.get("legacy")!.approval?.reason).toBe("legacy");
        const approved = manager.approvedServers();
        expect(approved.servers.approved).toEqual({ source: "project", config: cfg, fingerprint: mcpFingerprint(cfg, cwd) });
        expect(approved.servers.approved!.config).not.toHaveProperty("cwd");
        expect(claudeMcpPolicy(cwd, approved).settings).toEqual({
            enabledMcpjsonServers: ["approved"],
            disabledMcpjsonServers: ["cavvy", "clash", "disabled", "legacy", "pending", "rejected", "same__name"],
        });
        approved.servers.approved!.config.env!.A = "changed outside the manager";
        expect(manager.approvedServers().servers.approved!.config).toEqual(cfg);
    });

    test("an approved definition with a field the approval doesn't cover stays disabled after reload", () => {
        const http = { type: "http", url: "https://example.invalid/mcp", headers: { "X-Team": "one" } };
        write({ helper: http });
        saveApproval(cwd, "helper", mcpFingerprint(http, cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        expect(claudeMcpPolicy(cwd, manager.approvedServers()).settings?.enabledMcpjsonServers).toEqual(["helper"]);
        // headersHelper runs a program in Claude Code; the fingerprint doesn't include it, so the approval still holds.
        write({ helper: { ...http, headersHelper: "./helper.sh" } });
        manager.load();
        expect(manager.approvedServers().servers.helper).toBeDefined();
        const policy = claudeMcpPolicy(cwd, manager.approvedServers());
        expect(policy.settings).toEqual({ enabledMcpjsonServers: [], disabledMcpjsonServers: ["cavvy", "helper"] });
        expect(policy.warning).toContain("fields an approval doesn't cover");
    });

    test("an approved server with an oauth block is passed on (Claude Code signs in itself); a changed oauth block needs approving again", () => {
        const secure = { type: "http", url: "https://example.invalid/mcp", oauth: { clientId: "cavvy-client", callbackPort: 8765, scopes: "read write" } };
        write({ secure });
        saveApproval(cwd, "secure", mcpFingerprint(secure, cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        const policy = claudeMcpPolicy(cwd, manager.approvedServers());
        expect(policy.settings?.enabledMcpjsonServers).toEqual(["secure"]);
        expect(policy.warning).toBeUndefined();
        write({ secure: { ...secure, oauth: { clientId: "someone-else" } } });
        manager.load();
        expect(claudeMcpPolicy(cwd, manager.approvedServers()).settings?.enabledMcpjsonServers).toEqual([]);
    });

    test.each([
        ["an inline clientSecret", { clientId: "c", clientSecret: "s" }],
        ["scopes as a list", { clientId: "c", scopes: ["read", "write"] }],
    ])("an approved oauth block Claude Code reads differently (%s) isn't passed on", (_label, oauth) => {
        const secure = { type: "http", url: "https://example.invalid/mcp", oauth };
        write({ secure });
        saveApproval(cwd, "secure", mcpFingerprint(secure, cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        const policy = claudeMcpPolicy(cwd, manager.approvedServers());
        expect(policy.settings?.enabledMcpjsonServers).toEqual([]);
        expect(policy.warning).toContain("oauth block it reads differently");
    });

    test("a type change that switches an approved URL server to its command stays disabled after reload", () => {
        const mixed = { type: "http", url: "https://example.invalid/mcp", command: "/bin/sh", args: ["./payload.sh"] };
        write({ mixed });
        saveApproval(cwd, "mixed", mcpFingerprint(mixed as McpServerConfig, cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        write({ mixed: { ...mixed, type: "stdio" } });
        manager.load();
        // The type is part of the fingerprint: the approval no longer holds (Claude Code would run the command).
        expect(manager.approvedServers().servers.mixed).toBeUndefined();
        expect(claudeMcpPolicy(cwd, manager.approvedServers()).settings?.disabledMcpjsonServers).toContain("mixed");
    });

    for (const [label, cfg] of [
        ["command", { command: "${MCP_PROGRAM}" }],
        ["args", { command: "node", args: ["${MCP_SCRIPT:-./server.js}"] }],
        ["env", { command: "node", env: { TOKEN: "${HOME}" } }],
        ["url", { type: "http", url: "https://${MCP_HOST}/mcp" }],
        ["headers", { type: "http", url: "https://example.invalid/mcp", headers: { Authorization: "Bearer ${TOKEN}" } }],
    ] as const) test(`a definition Claude Code would expand (\${VAR} in ${label}) isn't passed on`, () => {
        write({ expanding: cfg });
        const policy = claudeMcpPolicy(cwd, snapshot({ expanding: cfg as McpServerConfig }));
        expect(policy.settings).toEqual({ enabledMcpjsonServers: [], disabledMcpjsonServers: ["cavvy", "expanding"] });
        expect(policy.warning).toContain("${VAR} expansion");
    });

    test("a symlinked cwd retargeted after approval stays disabled until it's approved again", () => {
        mkdirSync(join(root, "safe"));
        symlinkSync(join(root, "safe"), join(cwd, "run"));
        const cfg = { ...config(), cwd: "./run" };
        write({ linked: cfg });
        saveApproval(cwd, "linked", mcpFingerprint(cfg, cwd));
        const manager = new McpManager(cwd, () => loadSettings(cwd, { trusted: true }), true);
        manager.load();
        // Point it at the project folder itself, where Claude Code (which ignores cwd) would run it.
        rmSync(join(cwd, "run"));
        symlinkSync(cwd, join(cwd, "run"));
        // The manager no longer offers it, and the policy rechecks a snapshot taken before the change too.
        expect(manager.approvedServers().servers.linked).toBeUndefined();
        expect(claudeMcpPolicy(cwd, manager.approvedServers()).settings?.enabledMcpjsonServers).toEqual([]);
        const before = snapshot({ linked: cfg });
        before.servers.linked!.fingerprint = "v1:approved-before-the-change";
        const policy = claudeMcpPolicy(cwd, before);
        expect(policy.settings?.enabledMcpjsonServers).toEqual([]);
        expect(policy.warning).toContain("no longer resolve to what was approved");
    });

    for (const [label, revoke] of [
        ["rejected", (name: string) => saveRejection(cwd, name)],
        ["withdrawn", (name: string) => removeApproval(cwd, name)],
    ] as const) test(`an approval ${label} by another process since load() isn't passed on`, () => {
        const cfg = config();
        write({ approved: cfg });
        saveApproval(cwd, "approved", mcpFingerprint(cfg, cwd));
        // The engine's getter returns settings cached at load; reloadSettings marks a real runtime.
        const cached = loadSettings(cwd, { trusted: true });
        const manager = new McpManager(cwd, () => cached, true, () => {});
        manager.load();
        expect(claudeMcpPolicy(cwd, manager.approvedServers()).settings?.enabledMcpjsonServers).toEqual(["approved"]);
        revoke("approved");
        expect(manager.approvedServers().servers.approved).toBeUndefined();
        expect(claudeMcpPolicy(cwd, manager.approvedServers()).settings?.enabledMcpjsonServers).toEqual([]);
    });

    test("a URL-only definition without a type isn't passed on: Claude Code reads it as stdio", () => {
        const urlOnly = { url: "https://example.invalid/mcp" };
        write({ urlOnly });
        expect(claudeMcpPolicy(cwd, snapshot({ urlOnly })).settings).toEqual({ enabledMcpjsonServers: [], disabledMcpjsonServers: ["cavvy", "urlOnly"] });
    });

    test("a relative server cwd is the project's, not the process's", () => {
        mkdirSync(join(cwd, "sub"));
        const inSub = { ...config(), cwd: "sub" }, here = { ...config(), cwd: "." };
        write({ inSub, here });
        const policy = claudeMcpPolicy(cwd, snapshot({ inSub, here }));
        // Claude Code ignores cwd, so only the one that runs in the project folder itself is passed on.
        expect(policy.settings).toEqual({ enabledMcpjsonServers: ["here"], disabledMcpjsonServers: ["cavvy", "inSub"] });
    });

    test("deep equality ignores object key order but preserves all definition fields", () => {
        const cfg = config();
        write({ approved: { env: { B: "second", A: "private-sentinel" }, args: ["./server.js"], command: "node" } });
        expect(claudeMcpPolicy(cwd, snapshot({ approved: cfg })).settings?.enabledMcpjsonServers).toEqual(["approved"]);
    });

    test("approved server cwd must match Claude's project root and skipped servers get a notice", () => {
        const tools = join(root, "private-sentinel");
        mkdirSync(tools);
        const alias = join(root, "workspace-alias");
        symlinkSync(cwd, alias);
        const servers = {
            elsewhere: { ...config(), cwd: tools },
            same: { ...config(), cwd },
            alias: { ...config(), cwd: alias },
            default: config(),
        };
        write(servers);
        const policy = claudeMcpPolicy(cwd, snapshot(servers));
        expect(policy.settings?.disabledMcpjsonServers).toEqual(["cavvy", "elsewhere"]);
        expect(policy.settings?.enabledMcpjsonServers).toEqual(["alias", "default", "same"]);
        expect(policy.strict).toBe(false);
        expect(policy.warning).toMatch(/skipped.*working directory.*ignores server cwd/);
        expect(policy.warning).not.toContain("private-sentinel");
    });

    for (const [change, update] of Object.entries({
        command: { command: "other" },
        args: { args: ["./other.js"] },
        env: { env: { A: "other", B: "second" } },
        unknownField: { headersHelper: "run-other-program" },
    })) test(`a stale approval does not authorize changed ${change}`, () => {
        const cfg = config();
        write({ approved: { ...cfg, ...update } });
        expect(claudeMcpPolicy(cwd, snapshot({ approved: cfg }))).toMatchObject({ strict: false, settings: {
            enabledMcpjsonServers: [], disabledMcpjsonServers: ["approved", "cavvy"],
        } });
    });

    test("a removed project file leaves no stale enabled names", () => {
        expect(claudeMcpPolicy(cwd, snapshot({ removed: config() })).settings).toEqual({ enabledMcpjsonServers: [], disabledMcpjsonServers: ["cavvy"] });
    });

    for (const name of ["with space", "with.dot", "", "__proto__", "constructor", "prototype", "bad\nprivate-sentinel"]) {
        test(`a name that cannot be expressed safely falls back: ${JSON.stringify(name)}`, () => {
            write(Object.fromEntries([[name, config()]]));
            expectStrict(claudeMcpPolicy(cwd, snapshot({})));
        });
    }

    for (const contents of ["not json private-sentinel", "null", "[]", "{}", '{"mcpServers":[]}', '{"mcpServers":{"broken":null}}']) {
        test(`malformed project configuration fails closed: ${contents}`, () => {
            writeFileSync(join(cwd, ".mcp.json"), contents);
            expectStrict(claudeMcpPolicy(cwd, snapshot({})));
        });
    }

    test("an existing but unreadable project file fails closed", () => {
        mkdirSync(join(cwd, ".mcp.json"));
        expectStrict(claudeMcpPolicy(cwd, snapshot({})));
    });

    test("a dangling project configuration symlink fails closed", () => {
        symlinkSync(join(root, "missing"), join(cwd, ".mcp.json"));
        expectStrict(claudeMcpPolicy(cwd, snapshot({})));
    });

    test("a missing manager or a different turn directory fails closed", () => {
        expectStrict(claudeMcpPolicy(cwd, undefined));
        expectStrict(claudeMcpPolicy(root, snapshot({})));
    });

    test("equivalent directory paths do not needlessly restrict native servers", () => {
        const alias = join(root, "alias");
        symlinkSync(cwd, alias);
        expect(claudeMcpPolicy(alias, snapshot({})).strict).toBe(false);
    });

    test("only physical ancestors of a symlinked turn directory affect native MCP loading", () => {
        const logical = join(root, "logical");
        mkdirSync(logical);
        const alias = join(logical, "workspace");
        symlinkSync(cwd, alias);
        write({ unseen: config() }, logical);
        expect(claudeMcpPolicy(alias, snapshot({})).strict).toBe(false);
        write({ unseen: config() }, root);
        expectStrict(claudeMcpPolicy(alias, snapshot({})));
    });

    test("an ancestor configuration outside the manager snapshot forces strict isolation", () => {
        write({ unseen: config() }, root);
        expectStrict(claudeMcpPolicy(cwd, snapshot({})));
    });

    test("a descendant configuration does not restrict the current turn", () => {
        const subdir = join(cwd, "subdir");
        mkdirSync(subdir);
        write({ unseen: config() }, subdir);
        expect(claudeMcpPolicy(cwd, snapshot({})).strict).toBe(false);
    });
});
