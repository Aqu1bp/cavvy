// What a long-running Cavvy looks at again by itself: model lists when they're due or their CLI is another
// program, an account's sign-in when a turn finds it signed out, a plan's figures when the window comes back,
// and a server's agent CLIs when its Cavvy is updated.
import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, readFileSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import type { PlanLimits } from "../src/server/protocol";

const iso = isolate();
const dir = tempDir("keep-fresh-");
const { Engine, relistTiming } = await import("../src/server/engine");
const { cliProgram, listAllModels, MODEL_LIST_TTL_MS } = await import("../src/providers/models");
const { getProvider, saveAgentConfig } = await import("../src/providers/registry");
const { listAccounts } = await import("../src/providers/accounts");
const { readJson, writeJson } = await import("../src/config/settings");
const { paths } = await import("../src/config/paths");
const { hostUpdateClis, notUpdatedNote } = await import("../src/servers/cli-update");
const { planCheckDue } = await import("../gui/src/lib/limits");
const { STALE_MS } = await import("../src/server/plan-meter");
afterAll(() => iso.cleanup());

const client = { subs: new Set<string>(), send() {} };

/** A stand-in CLI: it notes what it was asked and exits with `code`. */
function program(name: string, code = 1): { bin: string; asked: () => string[] } {
    const bin = join(dir, name);
    const log = `${bin}.log`;
    writeFileSync(bin, `#!/bin/sh\necho "$*" >> '${log}'\nexit ${code}\n`);
    chmodSync(bin, 0o755);
    return { bin, asked: () => (existsSync(log) ? readFileSync(log, "utf-8").split("\n").filter(Boolean) : []) };
}

/** As if the CLI had updated itself: the same path, written at another time. */
const updated = (bin: string) => utimesSync(bin, new Date(), new Date(Date.now() + 60_000));

const listing = (provider: string, fetchedAt: number) => ({ provider: getProvider(provider)!, status: "ok" as const, fetchedAt, models: [{ provider, id: "default", contextWindow: 10_000 }] });

test("a CLI's cached models are used while it's the same program, and listed again once it isn't", async () => {
    const codex = program("codex");
    saveAgentConfig("codex", { path: codex.bin });
    const fp = `cli|${codex.bin}||default|${listAccounts("codex").find((a) => a.id === "default")!.folder}`;
    writeJson(paths.modelCache(), { version: 3, providers: { codex: { fp, fetchedAt: Date.now(), cli: cliProgram("codex"), models: [{ provider: "codex", id: "cached-fixture" }] } } });

    const same = (await listAllModels()).find((l) => l.provider.id === "codex");
    expect(same).toMatchObject({ status: "cached", models: [{ id: "cached-fixture" }] });
    expect(same?.error).toBeUndefined();
    expect(codex.asked()).toEqual([]);

    updated(codex.bin);
    // The stand-in lists nothing: it was asked, and what was cached is shown with why.
    const other = (await listAllModels()).find((l) => l.provider.id === "codex");
    expect(codex.asked().length).toBeGreaterThan(0);
    expect(other).toMatchObject({ status: "cached", models: [{ id: "cached-fixture" }] });
    expect(other?.error).toBeTruthy();
    // A cache from before programs were noted counts as another program too.
    const was = readJson<{ providers: Record<string, { cli?: string }> }>(paths.modelCache())!;
    delete was.providers.codex!.cli;
    writeJson(paths.modelCache(), was);
    const asked = codex.asked().length;
    await listAllModels();
    expect(codex.asked().length).toBeGreaterThan(asked);
});

test("lists are asked for again when the oldest is due, and not while they're fresh", async () => {
    const retry = relistTiming.retryMs;
    relistTiming.retryMs = 30;
    let calls = 0;
    let fetchedAt = Date.now() - MODEL_LIST_TTL_MS - 1000;
    const at: number[] = [];
    const engine = new Engine({ listModels: async () => (calls++, at.push(performance.now()), [listing("codex", fetchedAt)]) });
    try {
        await engine.refreshListings();
        expect(calls).toBe(1);
        // Still old (it couldn't be listed again): tried again after the short wait, then after twice that.
        const until = Date.now() + 2000;
        while (calls < 3 && Date.now() < until) await Bun.sleep(5);
        expect(calls).toBeGreaterThanOrEqual(3);
        expect(at[2]! - at[1]!).toBeGreaterThanOrEqual(55);
        // Listed now: nothing more until it's due, half a day on.
        fetchedAt = Date.now();
        await engine.refreshListings(true);
        const now = calls;
        await Bun.sleep(150);
        expect(calls).toBe(now);
    } finally {
        relistTiming.retryMs = retry;
        await engine.stop();
    }
});

test("a turn's end lists a CLI's models again only when the CLI is another program", async () => {
    const codex = program("codex-used");
    saveAgentConfig("codex", { path: codex.bin });
    let calls = 0;
    const engine = new Engine({ listModels: async () => (calls++, [listing("codex", Date.now())]) });
    try {
        await engine.refreshListings();
        engine.cliUsed("codex");
        engine.cliUsed("anthropic");
        await Bun.sleep(20);
        expect(calls).toBe(1);
        updated(codex.bin);
        engine.cliUsed("codex");
        // Once: the next turn finds the program it was listed with.
        engine.cliUsed("codex");
        await Bun.sleep(20);
        expect(calls).toBe(2);
    } finally {
        await engine.stop();
    }
});

test("a turn that stopped signed out marks its account so, until it's checked again", async () => {
    saveAgentConfig("claude-code", { path: process.execPath });
    const sent: { type?: string }[] = [];
    const engine = new Engine({ listModels: async () => [] });
    const window = { subs: new Set<string>(), send: (m: { type?: string }) => void sent.push(m) };
    (engine as unknown as { clients: Set<unknown> }).clients.add(window);
    try {
        const before = await engine.handle(client, "accounts.list", { provider: "claude-code" });
        expect(before.find((a: { id: string }) => a.id === "default")?.signedIn).toBeUndefined();
        engine.cliSignedOut("claude-code", "default");
        const after = await engine.handle(client, "accounts.list", { provider: "claude-code" });
        expect(after.find((a: { id: string }) => a.id === "default")).toMatchObject({ signedIn: false, description: "not signed in" });
        expect(sent.filter((m) => m.type === "models.changed")).toHaveLength(1);
        // Said once; something that isn't a CLI, or an account that isn't there, is nothing to mark.
        engine.cliSignedOut("claude-code", "default");
        engine.cliSignedOut("gcloud", "default");
        engine.cliSignedOut("claude-code", "nobody");
        expect(sent.filter((m) => m.type === "models.changed")).toHaveLength(1);
    } finally {
        await engine.stop();
    }
});

test("a plan is asked about as the window comes back only when its figures are old, and not twice in that time", () => {
    const now = 1_800_000_000_000;
    const at = (ago: number): PlanLimits => ({ provider: "claude-code", at: now - ago, windows: [{ id: "five_hour", label: "5-hour", pct: 40, resetsAt: now + 3_600_000 }] });
    expect(planCheckDue(undefined, now, undefined)).toBe(false);
    expect(planCheckDue(at(60_000), now, undefined)).toBe(false);
    expect(planCheckDue(at(STALE_MS + 1000), now, undefined)).toBe(true);
    expect(planCheckDue(at(STALE_MS + 1000), now, now - 60_000)).toBe(false);
    expect(planCheckDue(at(3 * STALE_MS), now, now - STALE_MS - 1000)).toBe(true);
});

test("a server's Cavvy updates the Claude Code it runs with its own updater, and says when that failed", async () => {
    const works = program("claude-works", 0);
    saveAgentConfig("claude-code", { path: works.bin });
    // Codex here isn't one npm installed for everyone: left alone, and nothing to say.
    saveAgentConfig("codex", { path: program("codex-own", 0).bin });
    expect(await hostUpdateClis()).toEqual({ failed: [] });
    expect(works.asked()).toEqual(["update"]);

    saveAgentConfig("claude-code", { path: program("claude-fails", 1).bin });
    expect(await hostUpdateClis()).toEqual({ failed: ["Claude Code"] });

    expect(notUpdatedNote("box", [])).toBeUndefined();
    expect(notUpdatedNote("box", undefined)).toBe("Agent CLIs on box weren't updated.");
    expect(notUpdatedNote("box", ["Codex"])).toBe("Codex on box wasn't updated.");
    expect(notUpdatedNote("box", ["Claude Code", "Codex"])).toBe("Claude Code and Codex on box weren't updated.");
});
