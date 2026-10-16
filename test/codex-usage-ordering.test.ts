import { afterAll, beforeEach, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { AgentEvent } from "../src/agent/types";

const iso = isolate();
const { Session } = await import("../src/agent/session");
const { Agent } = await import("../src/agent/agent");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { saveAgentConfig } = await import("../src/providers/registry");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const { trustForSession } = await import("../src/config/trust");
const cwd = tempDir("codex-usage-ordering-");
const bin = join(cwd, "codex-fake");
writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", "fake-codex.ts")}" "$@"\n`);
chmodSync(bin, 0o755);

beforeEach(() => {
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
    saveAgentConfig("codex", { path: bin });
    forgetClient("codex");
});
afterAll(() => {
    iso.cleanup();
    rmSync(cwd, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

async function agentFor(drainQueued: () => string[] = () => []) {
    trustForSession(cwd);
    const events: AgentEvent[] = [];
    const settings = {};
    let mode: import("../src/permissions/modes").PermissionMode = "bypassPermissions";
    const session = Session.create(cwd);
    const agent = new Agent({
        session,
        model: { provider: "codex", id: "gpt-6-sol" },
        client: await clientFor("codex"),
        settings: () => settings,
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { drainQueued, emit: (e) => events.push(e), ui: {} },
    });
    return { agent, session, events };
}
const run = (agent: InstanceType<typeof Agent>) => agent.run([{ type: "text", text: "hello" }], { signal: new AbortController().signal });

async function until(f: () => boolean) {
    const deadline = Date.now() + 3000;
    while (!f() && Date.now() < deadline) await Bun.sleep(5);
    expect(f()).toBe(true);
}

test("a read from an older session cannot replace a newer read that completed first", async () => {
    const first = await agentFor();
    const second = await agentFor();
    const release = join(cwd, "release-limits");
    const log = join(cwd, "older.log");
    process.env.FAKE_RATE_LIMITS = join(import.meta.dir, "fixtures", "limits", "codex-update-normal.json");
    process.env.FAKE_RATE_LIMITS_RELEASE = release;
    process.env.FAKE_LOG = log;
    const older = run(first.agent);
    try {
        await until(() => existsSync(log) && readFileSync(log, "utf8").includes('"method":"account/rateLimits/read"'));
        delete process.env.FAKE_RATE_LIMITS_RELEASE;
        delete process.env.FAKE_LOG;
        process.env.FAKE_RATE_LIMITS = join(import.meta.dir, "fixtures", "limits", "codex-update-reached.json");
        expect(await run(second.agent)).toBe("done");
        const newer = second.events.filter((e) => e.type === "limits");
        expect(newer).toHaveLength(1);
        expect(newer[0]!.limits.windows[0]).toMatchObject({ usedPercent: 100, reached: true });
        expect(readFileSync(log, "utf8")).not.toContain('"limitsReadReplied":true');
    } finally {
        writeFileSync(release, "release");
        await older;
    }
    // The server receives only the newer account snapshot, despite the reversed completion.
    expect(readFileSync(log, "utf8")).toContain('"limitsReadReplied":true');
    expect(first.events.filter((e) => e.type === "limits")).toHaveLength(0);
});

test("a rerouted queued turn records its model without repricing the next requested turn", async () => {
    process.env.FAKE_CODEX_REROUTED = "gpt-6-astra";
    process.env.FAKE_CODEX_REROUTED_FIRST = "1";
    const log = join(cwd, "queued.log");
    process.env.FAKE_LOG = log;
    let queued = true;
    const { agent, session } = await agentFor(() => {
        if (!queued) return [];
        queued = false;
        return ["second turn"];
    });
    expect(await run(agent)).toBe("done");
    const usage = readFileSync(session.path, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.t === "usage");
    expect(usage.map((row) => row.usage.resolvedModel)).toEqual(["codex:gpt-6-astra", "codex:gpt-6-sol"]);
    const requested = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((row) => row.received?.method === "turn/start");
    expect(requested.map((row) => row.received.params.model)).toEqual(["gpt-6-sol", "gpt-6-sol"]);
});
