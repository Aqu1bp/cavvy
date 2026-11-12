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
