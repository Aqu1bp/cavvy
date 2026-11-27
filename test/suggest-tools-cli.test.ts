// suggest_task from Claude Code and Codex, through Cavvy's MCP server (fake CLIs): the main agent's call lands as a
// card under the CLI's own call id; a Claude Code sub-agent's is refused.

import { expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import { switchKit, until } from "./helpers/switch-app";

const iso = isolate();
const kit = await switchKit(iso);
const args = { title: "Flaky auth test", prompt: "test/auth.test.ts fails one run in five on the token expiry check. Make it deterministic.", why: "It failed twice in this turn's runs." };

for (const [provider, asAgent] of [["claude-code", false], ["claude-code", true], ["codex", false]] as const) {
    test(`${provider}${asAgent ? "'s sub-agent is refused" : ": the main agent's"} suggest_task${asAgent ? "" : " is a card, under the CLI's call id"}`, async () => {
        await kit.withApp(
            provider,
            true,
            async (h) => {
                process.env.FAKE_MCP_CALLS = JSON.stringify([{ server: "cavvy", tool: "suggest_task", args }]);
                if (asAgent) process.env.FAKE_MCP_AS_AGENT = "1";
                try {
                    await h.send("call the tool");
                    await until(() => h.lines().some((l: any) => l.mcpResult), 10_000);
                    const result = h.lines().find((l: any) => l.mcpResult)?.mcpResult;
                    const cards = () => h.rt.snapshot().state.suggestions ?? [];
                    if (asAgent) {
                        expect(result?.isError).toBe(true);
                        expect(result?.text).toContain("sub-agent");
                        expect(cards()).toEqual([]);
                        return;
                    }
                    expect(result?.isError).toBeFalsy();
                    expect(result?.text).toContain("Suggested “Flaky auth test” to the user. Nothing has started");
                    await until(() => cards().length === 1);
                    const tool = h.turns().flatMap((t: any) => t.blocks).find((b: any) => b.t === "tool" && b.name === "SuggestTask");
                    expect(cards()[0]).toMatchObject({ title: "Flaky auth test", state: "pending" });
                    expect(tool?.id).toBe(cards()[0]!.id);
                } finally {
                    delete process.env.FAKE_MCP_CALLS;
                    delete process.env.FAKE_MCP_AS_AGENT;
                }
            },
            { env: { FAKE_SCENARIO: "mcp", FAKE_CODEX_SCENARIO: "mcp" } },
        );
    }, 40_000);
}

{
    test("codex's sub-agent is refused", async () => {
        await kit.withApp(
            "codex",
            true,
            async (h) => {
                await h.send("count the files with a sub-agent");
                await until(() => h.lines().some((l: any) => l.mcpResult), 10_000);
                const result = h.lines().find((l: any) => l.mcpResult)?.mcpResult;
                expect(result?.isError).toBe(true);
                expect(result?.text).toContain("sub-agent");
                expect(h.rt.snapshot().state.suggestions ?? []).toEqual([]);
            },
            { env: { FAKE_SCENARIO: "subagent", FAKE_CODEX_SCENARIO: "subagent", FAKE_CHILD_MCP: JSON.stringify({ tool: "suggest_task", args }) } },
        );
    }, 40_000);
}

test("Claude Code is given the instructions in its system prompt, and its server instructions leave them out", async () => {
    await kit.withApp(
        "claude-code",
        true,
        async (h) => {
            await h.send("hello");
            const all = h.lines().filter((l: any) => Array.isArray(l.argv)).map((l: any) => l.argv as string[]);
            const argv = all.at(-1) ?? [];
            const append = argv[argv.indexOf("--append-system-prompt") + 1] ?? "";
            expect(append).toContain("call suggest_task");
            expect((h.rt as any).agent.serverInstructions).not.toContain("suggest_task");
        },
        { env: { FAKE_SCENARIO: "mcp" } },
    );
}, 40_000);
