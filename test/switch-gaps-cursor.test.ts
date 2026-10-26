// #409's switch matrix, the catch-up cursor (BackendSession.synced; the rules by refusedBackendTurn in
// src/agent/agent.ts): back on a CLI after other models (or the other CLI) answered, its next prompt carries what it
// missed, once. Through a cut-off turn, CLI-to-CLI chains, Harness's /compact, a rewind, a lost native session and a
// Stop hook's continuation. In the GUI server's Runtime with the fake CLIs and the mock API (test/helpers/switch-app.ts).

import { describe, expect, test } from "bun:test";
import { rmSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";
import { API, CLIS, TOKEN, count, mode, switchKit, type Cli, type SwitchApp } from "./helpers/switch-app";

const iso = isolate();
const { withApp, bin } = await switchKit(iso);

// Gap 2: CLI → API → CLI, the real fixtures: the missed turns go once, and the same native session goes on.
for (const provider of CLIS)
    for (const live of [true, false])
        describe(`gap 2: ${provider}, ${mode(live)}: CLI → API → CLI`, () => {
            test("the same session is resumed; the prompt says what the other model did, once, then the new prompt", async () => {
                await withApp(provider, live, async (h) => {
                    expect((await h.send("first")).status).toBe("done");
                    const id = h.rt.session.backends.get(provider)!.id;
                    const pid = h.lastProc().pid;
                    expect(await h.rt.switchModel(API)).toBe(true);
                    expect((await h.send(`hello ${TOKEN}`)).status).toBe("done");
                    const answer = h.lastAnswer().trim().slice(0, 40);
                    expect(answer.length).toBeGreaterThan(5);
                    expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                    expect((await h.send("go on now")).status).toBe("done");
                    // Live, its process was kept: the prompt goes to it. Per run, a new one resumes the session.
                    if (live) expect([h.opened(), h.lastProc().pid]).toEqual([["new"], pid]);
                    else expect(h.opened()).toEqual(["new", id]);
                    expect(h.rt.session.backends.get(provider)?.id).toBe(id);
                    const p = h.prompts().at(-1)!;
                    expect(p.startsWith("<conversation-so-far>\nWhile another model or account answered in this session")).toBe(true);
                    expect(count(p, TOKEN)).toBe(1);
                    expect(count(p, answer)).toBe(1);
                    expect(count(p, "go on now")).toBe(1);
                    expect(p.indexOf("</conversation-so-far>")).toBeLessThan(p.indexOf("go on now"));
                    // Then only Harness's notes (that the model was switched), after the user's words.
                    expect(p.slice(p.indexOf("go on now") + "go on now".length)).toMatch(/^(\s*<system-reminder>[\s\S]*?<\/system-reminder>)*\s*$/);
                    expect((await h.send("and again")).status).toBe("done");
                    expect(h.prompts().at(-1)).toBe("and again");
                });
            }, 30_000);
        });

// Gap 2, the interrupt-only case: all the CLI missed is that its last turn was cut off (Harness stopped part way: the
// session's Runtime notes it as it opens, runtime.ts). Said plainly, not as another model's turn.
for (const provider of CLIS)
    for (const live of [true, false])
        test(`gap 2: ${provider}, ${mode(live)}: only a cut-off turn missed: the next prompt says so once, with no conversation`, async () => {
            await withApp(provider, live, async (h) => {
                expect((await h.send("first")).status).toBe("done");
                // As the Runtime records a turn cut off when it opens the session again.
                h.rt.session.push({ role: "user", content: [{ type: "text", text: "[Request interrupted by user]" }], meta: { kind: "interrupt" } });
                expect((await h.send("go on now")).status).toBe("done");
                const p = h.prompts().at(-1)!;
                expect(count(p, "Your last turn in this session was cut off")).toBe(1);
                expect(p).not.toContain("conversation-so-far");
                expect(p.indexOf("Your last turn in this session was cut off")).toBeLessThan(p.indexOf("go on now"));
                expect((await h.send("and again")).status).toBe("done");
                expect(h.prompts().at(-1)).toBe("and again");
            });
        }, 30_000);

// Gap 3: CLI → other CLI → CLI → other CLI in one session. Each prompt carries only what the other CLI's turns added
// since its own place, each once.
for (const live of [true, false])
    test(`gap 3: ${mode(live)}: Claude Code "a", Codex "b", Claude Code "c", Codex "d": each gets only the other's turns since its own, once`, async () => {
        await withApp("claude-code", live, async (h) => {
            expect((await h.send("alpha-word")).status).toBe("done");
            const cc = h.rt.session.backends.get("claude-code")!.id;
            const ccAnswer = h.lastAnswer().trim().split("\n")[0]!;
            expect(await h.rt.switchModel("codex:default")).toBe(true);
            expect((await h.send("bravo-word")).status).toBe("done");
            const cxAnswer = h.lastAnswer().trim().split("\n")[0]!;
            expect(ccAnswer).not.toBe(cxAnswer);
            expect(await h.rt.switchModel("claude-code:default")).toBe(true);
            expect((await h.send("charlie-word")).status).toBe("done");
            expect(await h.rt.switchModel("codex:default")).toBe(true);
            expect((await h.send("delta-word")).status).toBe("done");

            const [a, c] = h.prompts("claude-code");
            const [b, d] = h.prompts("codex");
            expect(h.prompts("claude-code")).toHaveLength(2);
            expect(h.prompts("codex")).toHaveLength(2);
            expect(a).toBe("alpha-word");
            // Codex's first: a new thread, handed the conversation so far.
            expect(b!.startsWith("<conversation-so-far>\nThis conversation started before you joined it")).toBe(true);
            expect([count(b!, "alpha-word"), count(b!, ccAnswer), count(b!, "bravo-word")]).toEqual([1, 1, 1]);
            // Claude Code again: only Codex's turn.
            expect(c!.startsWith("<conversation-so-far>\nWhile another model or account answered in this session")).toBe(true);
            expect([count(c!, "alpha-word"), count(c!, "bravo-word"), count(c!, cxAnswer), count(c!, "charlie-word")]).toEqual([0, 1, 1, 1]);
            // Codex again: only Claude Code's last turn.
            expect(d!.startsWith("<conversation-so-far>\nWhile another model or account answered in this session")).toBe(true);
            expect([count(d!, "alpha-word"), count(d!, "bravo-word"), count(d!, "charlie-word"), count(d!, "delta-word")]).toEqual([0, 0, 1, 1]);
            // Each went on with its own native session.
            expect(h.rt.session.backends.get("claude-code")?.id).toBe(cc);
            expect(h.opened("claude-code")).toEqual(live ? ["new"] : ["new", cc]);
            expect(h.opened("codex")).toEqual(live ? ["new"] : ["new", "thr-new"]);
        });
    }, 30_000);

// Gap 4: Harness's own /compact on an API model, then back on the CLI: a new native session from the summary.
for (const provider of CLIS)
    for (const live of [true, false])
        test(`gap 4: ${provider}, ${mode(live)}: /compact on an API model, then the CLI: a new session, handed the summary; the old one is never used`, async () => {
            await withApp(provider, live, async (h) => {
                expect((await h.send("first")).status).toBe("done");
                expect(await h.rt.switchModel(API)).toBe(true);
                expect((await h.send(`hello ${TOKEN}`)).status).toBe("done");
                await h.rt.compact();
                const summary = h.rt.session.summary;
                expect(summary?.trim().length).toBeGreaterThan(10);
                expect(h.rt.session.backends.has(provider)).toBe(false);
                expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                expect((await h.send("go on now")).status).toBe("done");
                // Nothing resumed: the old session (or thread) isn't continued, here or by a process kept for it.
                expect(h.opened()).toEqual(["new", "new"]);
                const p = h.prompts().at(-1)!;
                expect(p.startsWith("<conversation-so-far>\nThis conversation started before you joined it")).toBe(true);
                expect(count(p, summary!.trim().slice(0, 60))).toBe(1);
                expect(count(p, "go on now")).toBe(1);
                expect((await h.send("and again")).status).toBe("done");
                expect(h.prompts().at(-1)).toBe("and again");
            });
        }, 30_000);

/** Rewind the conversation (not files) to the prompt at `index`, as the GUI does. */
function rewind(h: SwitchApp, index: number) {
    const plan = h.rt.rewindPlan(index);
    h.rt.rewind(index, plan.planId, false, true);
}
const promptIndex = (h: SwitchApp, word: string) => h.rt.session.messages.findIndex((m) => m.role === "user" && m.meta?.kind === "prompt" && JSON.stringify(m.content).includes(word));

// Gap 5: a rewind across the CLI's place in the conversation.
for (const provider of CLIS)
    for (const live of [true, false])
        describe(`gap 5: ${provider}, ${mode(live)}: a rewind`, () => {
            test("to between the CLI's place and the end: it goes on with its session, sent only the missed messages that were kept", async () => {
                const DROPPED = "walrus-anvil-409";
                await withApp(provider, live, async (h) => {
                    expect((await h.send("first")).status).toBe("done");
                    const id = h.rt.session.backends.get(provider)!.id;
                    const pid = h.lastProc().pid;
                    expect(await h.rt.switchModel(API)).toBe(true);
                    expect((await h.send(`kept ${TOKEN}`)).status).toBe("done");
                    expect((await h.send(`dropped ${DROPPED}`)).status).toBe("done");
                    rewind(h, promptIndex(h, DROPPED));
                    expect(h.rt.session.backends.get(provider)?.id).toBe(id);
                    expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                    expect((await h.send("go on now")).status).toBe("done");
                    if (live) expect([h.opened(), h.lastProc().pid]).toEqual([["new"], pid]);
                    else expect(h.opened()).toEqual(["new", id]);
                    const p = h.prompts().at(-1)!;
                    expect(p.startsWith("<conversation-so-far>\nWhile another model or account answered in this session")).toBe(true);
                    expect([count(p, TOKEN), count(p, DROPPED)]).toEqual([1, 0]);
                    expect((await h.send("and again")).status).toBe("done");
                    expect(h.prompts().at(-1)).toBe("and again");
                });
            }, 30_000);

            test("to before the CLI's place: a new session with no resume, handed the conversation as kept", async () => {
                await withApp(provider, live, async (h) => {
                    expect((await h.send("first")).status).toBe("done");
                    expect((await h.send("second-word")).status).toBe("done");
                    rewind(h, promptIndex(h, "second-word"));
                    expect(h.rt.session.backends.has(provider)).toBe(false);
                    const before = h.opened().length;
                    expect((await h.send("go on now")).status).toBe("done");
                    expect(h.opened().slice(before)).toEqual(["new"]);
                    const p = h.prompts().at(-1)!;
                    expect(p.startsWith("<conversation-so-far>\nThis conversation started before you joined it")).toBe(true);
                    expect([count(p, "User: first"), count(p, "second-word"), count(p, "go on now")]).toEqual([1, 0, 1]);
                    expect((await h.send("and again")).status).toBe("done");
                    expect(h.prompts().at(-1)).toBe("and again");
                });
            }, 30_000);
        });

// Gap 9 (lower priority).
for (const provider of CLIS)
    describe(`gap 9: ${provider}`, () => {
        test("per run: its native session is gone (resumeFailed) after another model answered: the new one is handed the whole conversation, once", async () => {
            await withApp(provider, false, async (h) => {
                expect((await h.send("first")).status).toBe("done");
                const id = h.rt.session.backends.get(provider)!.id;
                expect(await h.rt.switchModel(API)).toBe(true);
                expect((await h.send(`hello ${TOKEN}`)).status).toBe("done");
                expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                // Gone from Default's history: the CLI can't resume it.
                rmSync(transcript(provider, h.cwd, id));
                const before = h.prompts().length;
                expect((await h.send("go on now")).status).toBe("done");
                expect(h.opened().slice(-2)).toEqual([id, "new"]);
                expect(h.notices().join("\n")).toMatch(/Starting a new one with this conversation as context/);
                const since = h.prompts().slice(before);
                expect(since).toHaveLength(1);
                const p = since[0]!;
                expect(p.startsWith("<conversation-so-far>\nThis conversation started before you joined it")).toBe(true);
                expect([count(p, "<conversation-so-far>"), count(p, "User: first"), count(p, TOKEN), count(p, "go on now")]).toEqual([1, 1, 1, 1]);
                expect((await h.send("and again")).status).toBe("done");
                expect(h.prompts().at(-1)).toBe("and again");
            });
        }, 30_000);

        test("live: a Stop hook's continuation: the missed turn goes with the first round only, and the hook's words aren't sent again", async () => {
            const arm = join(bin, `arm-${provider}`);
            const hooks = { Stop: [{ command: `[ -e '${arm}' ] && { rm -f '${arm}'; echo 'run the linter too' >&2; exit 2; }; exit 0` }] };
            await withApp(
                provider,
                true,
                async (h) => {
                    expect((await h.send("first")).status).toBe("done");
                    expect(await h.rt.switchModel(API)).toBe(true);
                    expect((await h.send(`hello ${TOKEN}`)).status).toBe("done");
                    expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                    writeFileSync(arm, "");
                    const before = h.prompts().length;
                    expect((await h.send("go on now")).status).toBe("done");
                    const [round1, round2, ...rest] = h.prompts().slice(before);
                    expect(rest).toEqual([]);
                    expect([count(round1!, TOKEN), count(round1!, "go on now")]).toEqual([1, 1]);
                    expect(round2).toContain("A Stop hook asked you to keep going");
                    expect(round2).toContain("run the linter too");
                    expect([count(round2!, TOKEN), count(round2!, "conversation-so-far")]).toEqual([0, 0]);
                    expect((await h.send("and again")).status).toBe("done");
                    expect(h.prompts().at(-1)).toBe("and again");
                    // Another model's turn after it: only that goes back, not the hook's words again.
                    const NEXT = "heron-ladle-409";
                    expect(await h.rt.switchModel(API)).toBe(true);
                    expect((await h.send(`hello ${NEXT}`)).status).toBe("done");
                    expect(await h.rt.switchModel(`${provider}:default`)).toBe(true);
                    expect((await h.send("last one")).status).toBe("done");
                    const p = h.prompts().at(-1)!;
                    expect([count(p, NEXT), count(p, TOKEN), count(p, "run the linter too")]).toEqual([1, 0, 0]);
                },
                { settings: { hooks } },
            );
        }, 30_000);
    });

/** A native session's transcript in Default's history (FAKE_TRANSCRIPTS): Claude Code's projects/, Codex's sessions/. */
function transcript(provider: Cli, cwd: string, id: string): string {
    if (provider === "codex") return join(process.env.CODEX_HOME!, "sessions", `${id}.jsonl`);
    return join(process.env.CLAUDE_CONFIG_DIR!, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`);
}
