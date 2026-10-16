import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { ApprovedMcpServers } from "../src/mcp/manager";
import type { McpServerConfig } from "../src/config/settings";

const { cleanup } = isolate();
const { claudeMcpPolicy } = await import("../src/backends/claude-mcp-policy");
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
    servers: Object.fromEntries(Object.entries(servers).map(([name, config]) => [name, { source: "project", config }])),
});
const expectStrict = (result: ReturnType<typeof claudeMcpPolicy>) => {
    expect(result.strict).toBe(true);
    expect(result.settings).toBeUndefined();
    expect(result.warning).toMatch(/strict MCP isolation/);
    expect(result.warning).not.toContain("private-sentinel");
};

describe("Claude native project MCP policy", () => {
    test("an empty workspace preserves native user servers and reserves delegation", () => {
        expect(claudeMcpPolicy(cwd, snapshot({}))).toEqual({ strict: false, settings: { enabledMcpjsonServers: [], disabledMcpjsonServers: ["harness"] } });
    });

    test("only exact project definitions are enabled; settings-source names cannot approve project copies", () => {
        const cfg = config();
        write({ approved: cfg, pending: cfg, harness: cfg, settings: cfg });
        const approved = snapshot({ approved: cfg, harness: cfg });
        approved.servers.settings = { source: "settings", config: cfg };
        expect(claudeMcpPolicy(cwd, approved)).toEqual({ strict: false, settings: {
            enabledMcpjsonServers: ["approved"], disabledMcpjsonServers: ["harness", "pending", "settings"],
        } });
    });

    test("deep equality ignores object key order but preserves all definition fields", () => {
        const cfg = config();
        write({ approved: { env: { B: "second", A: "private-sentinel" }, args: ["./server.js"], command: "node" } });
        expect(claudeMcpPolicy(cwd, snapshot({ approved: cfg })).settings?.enabledMcpjsonServers).toEqual(["approved"]);
    });

    for (const [change, update] of Object.entries({
        command: { command: "other" },
        args: { args: ["./other.js"] },
        env: { env: { A: "other", B: "second" } },
        unknownField: { headersHelper: "run-other-program" },
    })) test(`a stale approval does not authorize changed ${change}`, () => {
        const cfg = config();
        write({ approved: { ...cfg, ...update } });
        expect(claudeMcpPolicy(cwd, snapshot({ approved: cfg }))).toEqual({ strict: false, settings: {
            enabledMcpjsonServers: [], disabledMcpjsonServers: ["approved", "harness"],
        } });
    });

    test("a removed project file leaves no stale enabled names", () => {
        expect(claudeMcpPolicy(cwd, snapshot({ removed: config() })).settings).toEqual({ enabledMcpjsonServers: [], disabledMcpjsonServers: ["harness"] });
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
