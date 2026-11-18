// What Cavvy answers when an agent CLI (Claude Code, Codex, an ACP agent, Antigravity) or one of its sub-agents
// asks about a call, by the session's mode: Agent.backendPermission, where every backend's request ends up.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import type { Tool } from "../src/tools/types";

const { cleanup } = isolate();
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { childMode } = await import("../src/agent/subagent-setup");
type PermissionMode = import("../src/permissions/modes").PermissionMode;
type BackendPermission = import("../src/backends/types").BackendPermission;

afterAll(cleanup);

const Bash = BUILTIN_TOOLS.find((t) => t.name === "Bash") as Tool<any>;
const Write = BUILTIN_TOOLS.find((t) => t.name === "Write") as Tool<any>;

function setup(mode: PermissionMode, settings: any = {}) {
    const ws = realpathSync(mkdtempSync(join(tmpdir(), "cavvy-test-ws-")));
    const asked: any[] = [];
    const agent = new Agent({
        session: Session.create(ws, { persist: false, system: "S" }),
        model: { provider: "test", id: "test" } as any,
        client: { stream: async () => ({ role: "assistant", provider: "test", model: "test", stopReason: "end_turn", content: [] }) } as any,
        settings: () => ({ autoCompact: false, ...settings }),
        checker: new PermissionChecker(() => ({ autoCompact: false, ...settings }), ws, () => undefined),
        tools: [Bash, Write],
        mode: { get: () => mode, set() {} },
        toolState: { cwd: ws, projectRoot: ws, fileState: new Map(), todos: [], shells: new Map() } as any,
        host: { emit() {}, ui: {}, askPermission: async (req: any) => (asked.push(req), { allow: true }), drainQueued: () => [] } as any,
    });
    const ask = (req: BackendPermission) => (agent as any).backendPermission(req, new AbortController().signal);
    return { ask, asked, ws };
}

const python = { toolName: "Bash", input: { command: "cd /tmp && python3 - <<'EOF'\nprint(1)\nEOF" } };

describe("bypass: what an agent CLI still asks about runs, with no card", () => {
    // Each backend's way of asking: Claude Code (its own mode), Codex/Grok told to ask for hooks, an ACP agent asking
    // about everything, a sub-agent, a background one, one Cavvy can't see whole.
    const kinds: [string, Partial<BackendPermission>][] = [
        ["Claude Code", { ownMode: true }],
        ["Claude Code's background sub-agent", { ownMode: true, background: true, agentLabel: "general-purpose" }],
        ["Codex", {}],
        ["an ACP agent", { asksAlways: true, hooksOnly: true }],
        ["Antigravity", { asksAlways: true, hooksOnly: true }],
        ["a delegated task's", { agentLabel: "sub-agent" }],
        ["a call Cavvy has only part of", { asksAlways: true, incomplete: true }],
    ];
    for (const [who, extra] of kinds) {
        test(who, async () => {
            const { ask, asked } = setup("bypassPermissions");
            expect(await ask({ ...python, ...extra } as BackendPermission)).toEqual({ allow: true });
            expect(asked).toHaveLength(0);
        });
    }

    test("a dangerous command too: the CLI's own bypass would run it without asking", async () => {
        const { ask, asked } = setup("bypassPermissions");
        expect(await ask({ toolName: "Bash", input: { command: "rm -rf ~" }, ownMode: true })).toEqual({ allow: true });
        expect(await ask({ toolName: "Bash", input: { command: "git reset --hard" }, hooksOnly: true, asksAlways: true })).toEqual({ allow: true });
        expect(asked).toHaveLength(0);
    });

    test("extra sandbox access is granted, but not past a deny rule", async () => {
        const { ask, asked, ws } = setup("bypassPermissions", { permissions: { deny: ["Edit(secret/**)"] } });
        expect(await ask({ toolName: "Codex permissions", input: {}, widens: { read: [], write: ["/tmp/x"] } })).toEqual({ allow: true });
        expect(await ask({ toolName: "Codex permissions", input: {}, widens: { read: [], write: [join(ws, "secret")] } })).toMatchObject({ allow: false });
        expect(asked).toHaveLength(0);
    });

    test("a deny rule still refuses, without asking", async () => {
        const { ask, asked } = setup("bypassPermissions", { permissions: { deny: ["Bash(python3:*)"] } });
        expect(await ask({ toolName: "Bash", input: { command: "python3 x.py" }, ownMode: true })).toMatchObject({ allow: false });
        expect(asked).toHaveLength(0);
    });

    test("a PreToolUse hook that asks still gets the user", async () => {
        const { ask, asked } = setup("bypassPermissions");
        expect(await ask({ ...python, ownMode: true, hookDecision: "ask" })).toEqual({ allow: true });
        expect(asked).toHaveLength(1);
    });

    test("a plan agent under a bypass session stays in plan: its write is refused", async () => {
        expect(childMode("bypassPermissions", "plan")).toBe("plan");
    });
});

describe("the CLI's own mode decided it needs the user: a card, nothing of Cavvy's mode added", () => {
    test("accept edits: an edit Claude Code asks about in the workspace shows a card", async () => {
        const { ask, asked, ws } = setup("acceptEdits");
        await ask({ toolName: "Write", input: { file_path: join(ws, "a.txt"), content: "x" }, ownMode: true });
        expect(asked).toHaveLength(1);
        // One Cavvy decides by its own accept edits (Codex, OpenCode): approved without a card, as before.
        await ask({ toolName: "Write", input: { file_path: join(ws, "a.txt"), content: "x" } });
        expect(asked).toHaveLength(1);
    });

    test("auto: what the CLI's reviewer sends to the user is shown; Cavvy approves nothing by its own auto rules", async () => {
        const { ask, asked, ws } = setup("auto");
        await ask({ toolName: "Write", input: { file_path: join(ws, "a.txt"), content: "x" }, ownMode: true, asksAlways: true });
        await ask({ toolName: "Bash", input: { command: "ls" }, ownMode: true, asksAlways: true });
        expect(asked).toHaveLength(2);
    });

    test("the user's allow rules and deny rules still decide", async () => {
        const { ask, asked } = setup("auto", { permissions: { allow: ["Bash(make:*)"], deny: ["Bash(curl:*)"] } });
        expect(await ask({ toolName: "Bash", input: { command: "make build" }, ownMode: true })).toEqual({ allow: true });
        expect(await ask({ toolName: "Bash", input: { command: "curl https://example.com" }, ownMode: true })).toMatchObject({ allow: false });
        expect(asked).toHaveLength(0);
    });
});

describe("a sub-agent's definition can make it stricter than the session, never looser", () => {
    test("childMode", () => {
        expect(childMode("default", "acceptEdits")).toBe("default");
        expect(childMode("default", "bypassPermissions")).toBe("default");
        expect(childMode("acceptEdits", "default")).toBe("default");
        expect(childMode("auto", "acceptEdits")).toBe("acceptEdits");
        expect(childMode("auto", "default")).toBe("default");
        expect(childMode("bypassPermissions", "default")).toBe("default");
        expect(childMode("plan", "bypassPermissions")).toBe("plan");
        expect(childMode("bypassPermissions", undefined)).toBe("bypassPermissions");
    });
});
