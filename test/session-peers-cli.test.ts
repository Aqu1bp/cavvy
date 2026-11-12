// A message from another session to a Claude Code session (src/agent/peers.ts): it joins the running turn when the CLI
// takes it, shown there from whom; when the CLI's turn ends before it reads it, it's taken back and gets a turn of its own.

import { expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import { mode, switchKit, until } from "./helpers/switch-app";

const iso = isolate();
const kit = await switchKit(iso);
const { sendToSession } = await import("../src/tools/session-tools");

const peerBlocks = (turns: any[]) => turns.flatMap((t, i) => t.blocks.filter((b: any) => b.t === "peer").map((b: any) => ({ turn: i, text: b.text as string })));

for (const live of [true, false]) {
    test(`Claude Code (${mode(live)}): a message sent while it works is shown once, where the CLI read it`, async () => {
        await kit.withApp(
            "claude-code",
            live,
            async (h) => {
                const a = await h.engine.createSession(h.cwd, { mode: "bypassPermissions" });
                await a.ready;
                const b = h.rt;
                // The fake reads what's steered in while its turn runs (steer-live: a live process; steering: one per turn).
                await b.send("work on it");
                await until(() => b.busy);
                const r = await sendToSession(a.toolState.peers, { id: b.id, message: "Also check the migration." });
                expect(r.text).toContain("It's working");
                await until(() => b.idle && !b.busy && (peerBlocks(h.turns()).length > 0 || h.turns().some((t: any) => t.prompt?.from)), 20_000);
                // The CLI was sent it once, and it's shown once: where the CLI read it (in the turn it joined), or as a turn
                // of its own when that turn ended before it read it (taken back from the first, never shown in both).
                expect(h.prompts().filter((p) => p.includes("Also check the migration.")).length).toBe(1);
                const joined = peerBlocks(h.turns());
                const own = h.turns().flatMap((t: any, i: number) => (t.prompt?.from?.id === a.id ? [{ turn: i, text: t.prompt.text as string }] : []));
                expect([...joined, ...own].map((p) => p.text)).toEqual(["Also check the migration."]);
                if (joined.length) expect(joined[0]!.turn).toBe(0);
                console.log(`${mode(live)}: ${joined.length ? "joined the running turn" : "a turn of its own"}`);
            },
            { env: { FAKE_SCENARIO: live ? "steer-live" : "steering" } },
        );
    }, 40_000);
}

test("Codex: a message steered while it works, even refused, reaches it once and is shown once", async () => {
    await kit.withApp(
        "codex",
        true,
        async (h) => {
            const a = await h.engine.createSession(h.cwd, { mode: "bypassPermissions" });
            await a.ready;
            const b = h.rt;
            // FAKE_STEER_FAIL: Codex refuses what's steered in (its turn ended); Cavvy sends it on in a turn of Codex's own.
            await b.send("work on it");
            await until(() => b.busy);
            await sendToSession(a.toolState.peers, { id: b.id, message: "Also check the migration." });
            const shown = () => [...peerBlocks(h.turns()), ...h.turns().flatMap((t: any) => (t.prompt?.from?.id === a.id ? [{ text: t.prompt.text }] : []))];
            await until(() => b.idle && !b.busy && shown().length > 0, 20_000);
            await Bun.sleep(300);
            expect(shown().map((p) => p.text)).toEqual(["Also check the migration."]);
            expect(h.prompts().filter((p) => p.includes("Also check the migration.")).length).toBe(1);
        },
        { env: { FAKE_STEER_FAIL: "1" } },
    );
}, 40_000);

for (const asAgent of [false, true]) {
    test(`Claude Code's ${asAgent ? "sub-agent is refused" : "main agent can"} send_to_session, though it sends no call id`, async () => {
        await kit.withApp(
            "claude-code",
            true,
            async (h) => {
                const b = await h.engine.createSession(h.cwd, { mode: "bypassPermissions" });
                await b.ready;
                await b.setModel("mock:mock-opus");
                await b.send("hello");
                await until(() => b.idle && !b.busy && b.session.messages.length > 0);
                process.env.FAKE_MCP_CALLS = JSON.stringify([{ server: "cavvy", tool: "send_to_session", args: { id: b.id, message: "Ping from Claude Code." } }]);
                if (asAgent) process.env.FAKE_MCP_AS_AGENT = "1";
                await h.send("call the tool");
                const result = h.lines().find((l: any) => l.mcpResult)?.mcpResult;
                const got = () => b.session.messages.some((m) => JSON.stringify(m).includes("Ping from Claude Code."));
                if (asAgent) {
                    expect(result?.isError).toBe(true);
                    expect(result?.text).toContain("sub-agent");
                    await Bun.sleep(500);
                    expect(got()).toBe(false);
                } else {
                    expect(result?.isError).toBeFalsy();
                    expect(result?.text).toContain("Sent to session");
                    await until(() => got());
                }
            },
            { env: { FAKE_SCENARIO: "mcp" } },
        );
    }, 40_000);
}

for (const live of [true, false])
    for (const steered of [false, true])
        test(`Claude Code (${mode(live)}): a message its turn never read is taken back on Esc${steered ? ", with the user's steer after it" : ""}, and stays taken back after a reopen`, async () => {
            await kit.withApp(
                "claude-code",
                live,
                async (h) => {
                    const a = await h.engine.createSession(h.cwd, { mode: "bypassPermissions" });
                    await a.ready;
                    const b = h.rt;
                    // "hang": the CLI's turn runs until it's stopped, and never reads what's steered in.
                    await b.send("work on it");
                    await until(() => b.busy);
                    await sendToSession(a.toolState.peers, { id: b.id, message: "Also check the migration." });
                    await until(() => peerBlocks(h.turns()).length === 1);
                    if (steered) await b.send("and the tests too", undefined, false, "steer");
                    await Bun.sleep(200);
                    b.interrupt();
                    await until(() => b.idle && !b.busy);
                    await Bun.sleep(200);
                    // Shown as joined no longer; not in the history the model is given; waiting for the user's next message.
                    expect(peerBlocks(h.turns())).toEqual([]);
                    expect(b.session.messages.filter((m) => m.role === "user" && (m.meta?.peers?.length || JSON.stringify(m.content).includes("Also check the migration.")))).toHaveLength(0);
                    expect(b.toolState.wakes!.pending().map((w) => w.message)).toEqual(["Also check the migration."]);
                    const read = await import("../src/tools/session-tools").then((t) => t.readSession(a.toolState.peers, { id: b.id }));
                    expect(read.text).not.toContain("Also check the migration.");
                    // Reopened: not back in the turn it never reached.
                    const again = await h.reopen();
                    expect(peerBlocks(h.turns(again))).toEqual([]);
                },
                { env: { FAKE_SCENARIO: "hang" } },
            );
        }, 40_000);
