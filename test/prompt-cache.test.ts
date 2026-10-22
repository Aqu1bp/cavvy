// The prompt-cache prefix on Anthropic (the tools, then the system prompt up to
// its breakpoint) is the same bytes in every new session in a project and in
// every sub-agent of a type, so a new one reads it instead of writing it (#255).
// What differs between sessions (the date, the git status) comes after it.

import { afterAll, expect, setSystemTime, test } from "bun:test";
import { spawnSync } from "bun";
import { writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { startMockAnthropic, type MockAnthropicRequest } from "./helpers/mock-anthropic";
import type { SessionSnapshot } from "../src/server/protocol";

const iso = isolate();
const mock = startMockAnthropic();
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mockant", name: "Mock Anthropic", kind: "anthropic", baseUrl: mock.url }] }));
// Anthropic's client won't send without one.
process.env.MOCKANT_API_KEY = "mock-key";
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mockant:claude-opus-5-5", smallModel: "mockant:claude-opus-5-5" }));
const { Engine } = await import("../src/server/engine");
const { createDemoProject } = await import("../scripts/demo-project");

afterAll(() => {
    setSystemTime();
    mock.stop();
    iso.cleanup();
});

type Block = { type: string; text: string; cache_control?: unknown };

/** What the request caches at its system breakpoint, as sent: the model, the tools and the system blocks up to the marked one. */
function cachedPrefix(r: MockAnthropicRequest): string {
    const system = r.body.system as Block[];
    const at = system.findIndex((b) => b.cache_control);
    expect(at).toBeGreaterThanOrEqual(0);
    return JSON.stringify({ model: r.body.model, tools: r.body.tools, system: system.slice(0, at + 1) });
}

/** The agent's request whose conversation starts with `text` (not the title's, which has no tools). */
function requestFor(text: string): MockAnthropicRequest | undefined {
    return mock.requests.find((r) => r.body.tools && JSON.stringify(r.messages[0]?.content ?? "").includes(text));
}

async function until(pred: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(10);
    }
}

function git(cwd: string, ...args: string[]) {
    spawnSync(["git", ...args], { cwd, env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.com" } });
}

test("two new sessions in a project, and two sub-agents of a type, send the same cached prefix; their own context follows it", async () => {
    const engine = new Engine();
    const c = { subs: new Set<string>(), send: () => {} };
    engine.clients.add(c as never);
    const cwd = createDemoProject(tempDir("prompt-cache-"));
    const session = async (text: string) => {
        const snap = (await engine.handle(c as never, "session.create", { cwd })) as SessionSnapshot;
        const rt = engine.runtimes.get(snap.state.id)! as any;
        await engine.handle(c as never, "session.send", { id: snap.state.id, text });
        await until(() => rt.idle && requestFor(text) !== undefined);
        return { rt, req: requestFor(text)! };
    };
    try {
        setSystemTime(new Date("2026-10-21T12:00:00Z"));
        const one = await session("Reply with just: one");
        // The next day, after a commit and with a file changed: the date and git status differ.
        setSystemTime(new Date("2026-10-22T12:00:00Z"));
        writeFileSync(join(cwd, "NOTES.md"), "notes\n");
        git(cwd, "add", "-A");
        git(cwd, "commit", "-q", "-m", "Add notes");
        writeFileSync(join(cwd, "scratch.txt"), "x\n");
        const two = await session("Reply with just: two");

        const [a, b] = [one.req, two.req];
        expect((a.body.tools as unknown[]).length).toBeGreaterThan(0);
        expect(cachedPrefix(b)).toBe(cachedPrefix(a));
        // The system prompts as a whole differ, in the part after the breakpoint.
        const [sa, sb] = [a.body.system as Block[], b.body.system as Block[]];
        expect(sa).toHaveLength(2);
        expect(sa[1]!.cache_control).toBeUndefined();
        expect(sa[1]!.text).toStartWith("# Session context\nToday's date: 2026-10-21");
        expect(sb[1]!.text).toStartWith("# Session context\nToday's date: 2026-10-22");
        expect(sa[1]!.text).not.toContain("Add notes");
        expect(sb[1]!.text).toContain("Add notes");
        expect(sb[1]!.text).toContain("scratch.txt");
        expect(sa[0]!.text).not.toContain("2026-10-2");
        expect(sa[0]!.text).not.toContain("Initial commit");
        // The conversation keeps its own breakpoint: two in all, of the four allowed.
        for (const r of [a, b]) {
            expect(r.body.cache_control).toEqual({ type: "ephemeral" });
            expect(JSON.stringify(r.body).match(/"cache_control"/g)).toHaveLength(2);
        }

        // Sub-agents: each type has a prefix of its own, the same for each one of the type.
        const signal = new AbortController().signal;
        const sub = async (agentType: string, prompt: string) => {
            await two.rt.agent.runSubagent(`call-${prompt}`, { description: "Look", prompt, agentType }, signal);
            return requestFor(prompt)!;
        };
        const explore = [await sub("explore", "Find the login handler"), await sub("explore", "Find the session store")];
        const general = [await sub("general-purpose", "Rename the config loader"), await sub("general-purpose", "Fix the failing test")];
        for (const pair of [explore, general]) {
            expect(pair[0]!.body.system).toBeDefined();
            expect(cachedPrefix(pair[1]!)).toBe(cachedPrefix(pair[0]!));
            expect(pair[0]!.body.cache_control).toEqual({ type: "ephemeral" });
        }
        expect(cachedPrefix(explore[0]!)).not.toBe(cachedPrefix(general[0]!));
        expect(cachedPrefix(explore[0]!)).not.toBe(cachedPrefix(a));
    } finally {
        await engine.stop();
    }
});
