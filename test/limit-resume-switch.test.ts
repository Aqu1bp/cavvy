// A usage limit's automatic resume and a switched account or model (#411): the GUI server's Runtime with a fake
// agent CLI that stops on the plan's limit. No real CLI or credential.

import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { addAccount } = await import("../src/providers/accounts");
import { backendModel, type BackendTurn } from "../src/backends/types";
import { planLimitKey } from "../src/server/protocol";

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
afterAll(() => {
    mock.stop();
    iso.cleanup();
});

async function until(pred: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

/** A Claude Code stand-in whose turns stop on the plan's limit, resetting in an hour. */
function limitedBackend(turns: BackendTurn[]) {
    return {
        agentBackend: true as const,
        setMode() {},
        listModels: async () => [],
        stream: async () => {
            throw new Error("not used");
        },
        compact: async () => ({ reason: "done" as const, text: "", actions: [] }),
        runTurn: async (t: BackendTurn) => {
            turns.push(t);
            return { reason: "error" as const, text: "", error: "You've hit your usage limit.", actions: [], limit: { resetsAt: Date.now() + 3_600_000 } };
        },
    };
}

/** A session that has just hit the limit, with the automatic resume waiting. */
async function limited() {
    const engine = new Engine({ listModels: async () => [] });
    const cwd = createDemoProject(tempDir("harness-limit-proj-"), { git: false });
    const rt = await engine.createSession(cwd, { mode: "bypassPermissions" });
    await rt.ready;
    const turns: BackendTurn[] = [];
    rt.agent!.setModel(backendModel("claude-code", "x"), limitedBackend(turns) as never);
    rt.model = backendModel("claude-code", "x");
    await rt.send("work on it");
    await until(() => rt.idle && rt.schedules.scheduler.size === 1);
    expect(rt.schedules.scheduler.list().map((j) => j.kind)).toEqual(["resume"]);
    // If the job ever fired, it would start a turn: count them.
    const ran: string[] = [];
    const runScheduled = (rt as any).runScheduled.bind(rt);
    (rt as any).runScheduled = (prompt: string, ...rest: unknown[]) => (ran.push(prompt), runScheduled(prompt, ...rest));
    return { engine, rt, turns, ran };
}

const shown = (rt: { snapshot(): { turns: { blocks: { t: string }[] }[] } }) =>
    rt.snapshot().turns.flatMap((t) => t.blocks.filter((b) => b.t === "notice").map((b) => (b as unknown as { text: string }).text));
const cancelledNotices = (rt: Parameters<typeof shown>[0]) => shown(rt).filter((n) => n.startsWith("The automatic resume is cancelled"));

test("switching the account, then the model: the resume is gone, the user is told once, and it never fires", async () => {
    const { engine, rt, ran } = await limited();
    const other = addAccount("claude-code", { id: "limit-other", name: "Other" });
    try {
        await rt.setAccount("claude-code", other.id);
        expect(rt.schedules.scheduler.size).toBe(0);
        expect(cancelledNotices(rt)).toEqual(["The automatic resume is cancelled: you switched the account."]);
        // The model: nothing waiting any more, so nothing more is said.
        expect(await rt.setModel("mock:mock-opus")).toBe(true);
        expect(rt.schedules.scheduler.size).toBe(0);
        expect(cancelledNotices(rt)).toHaveLength(1);
        // Past the reset time: the (cancelled) job doesn't start anything.
        rt.schedules.poke();
        await Bun.sleep(100);
        expect(ran).toEqual([]);
    } finally {
        await engine.stop();
    }
});

test("switching the model cancels the waiting resume and says so", async () => {
    const { engine, rt, ran } = await limited();
    try {
        expect(await rt.setModel("mock:mock-opus")).toBe(true);
        expect(rt.schedules.scheduler.size).toBe(0);
        expect(cancelledNotices(rt)).toEqual(["The automatic resume is cancelled: you switched the model."]);
        rt.schedules.poke();
        await Bun.sleep(100);
        expect(ran).toEqual([]);
    } finally {
        await engine.stop();
    }
});

test("past the limit on credits (#434): the turn goes on, no resume waits, and nothing says it stopped", async () => {
    const engine = new Engine({ listModels: async () => [] });
    try {
        const cwd = createDemoProject(tempDir("harness-limit-proj-"), { git: false });
        const rt = await engine.createSession(cwd, { mode: "bypassPermissions" });
        await rt.ready;
        const turns: BackendTurn[] = [];
        const backend = {
            ...limitedBackend(turns),
            runTurn: async (t: BackendTurn) => {
                turns.push(t);
                t.session.limits?.({ provider: "claude-code", accountId: "default", windows: [{ id: "five_hour", label: "5-hour", usedPercent: 100, resetsAt: Date.now() + 3_600_000, reached: true }], reached: true, resetsAt: Date.now() + 3_600_000, credits: true, at: Date.now() }, false);
                return { reason: "done" as const, text: "Done.", actions: [] };
            },
        };
        rt.agent!.setModel(backendModel("claude-code", "x"), backend as never);
        rt.model = backendModel("claude-code", "x");
        await rt.send("work on it");
        await until(() => rt.idle && turns.length === 1);
        expect(rt.schedules.scheduler.size).toBe(0);
        expect(shown(rt).filter((n) => /continue by itself|resume|Choose another account/.test(n))).toEqual([]);
        expect((engine as any).limits.get(planLimitKey("claude-code", "default"))).toMatchObject({ reached: true, credits: true });
    } finally {
        await engine.stop();
    }
});

test("picking the account it is already on leaves the resume waiting", async () => {
    const { engine, rt } = await limited();
    try {
        await rt.setAccount("claude-code", "default");
        expect(rt.schedules.scheduler.size).toBe(1);
        expect(cancelledNotices(rt)).toEqual([]);
    } finally {
        await engine.stop();
    }
});
