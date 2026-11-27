// Two of the user's computers syncing one server (src/servers/sync.ts, src/servers/sync-merge.ts): the server keeps
// what both send, the newest change to each thing wins, one that starts syncing doesn't replace what another sent,
// and a thing goes only once no computer has it.

import { afterAll, expect, test } from "bun:test";
import { createHash } from "crypto";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { applySync, forgetSyncedFiles, syncedFor } = await import("../src/servers/sync");
const { applyStateFrom, forgetSyncedState, mergeSent, syncedStateFor } = await import("../src/servers/sync-merge");
const { paths } = await import("../src/config/paths");
const { forgetCachedKeys } = await import("../src/auth/credentials");

afterAll(() => iso.cleanup());

/** A fresh server: its own Cavvy home, where its records are kept, and its home folder. */
async function onServer<T>(fn: (home: string) => Promise<T> | T): Promise<T> {
    const home = tempDir("cavvy-two-macs-");
    const prev = process.env.CAVVY_HOME;
    process.env.CAVVY_HOME = join(home, ".cavvy");
    forgetCachedKeys();
    try {
        return await fn(home);
    } finally {
        process.env.CAVVY_HOME = prev;
        forgetCachedKeys();
    }
}

const sha = (t: string) => createHash("sha256").update(t).digest("hex");
const file = (path: string, text: string) => ({ path, data: Buffer.from(text).toString("base64"), sha: sha(text) });
const SKILL = ".cavvy/skills/review/SKILL.md";
const read = (home: string, path: string) => readFileSync(join(home, path), "utf-8");

/** One computer's sync of its files, as syncTo does it: it sends what changed since it last sent, and what it no longer has. */
function sync(home: string, from: string, has: Record<string, string>) {
    const sent = syncedFor(from);
    const files = Object.entries(has)
        .filter(([p, t]) => sent[p] !== sha(t))
        .map(([p, t]) => file(p, t));
    const remove = Object.keys(sent).filter((p) => !(p in has));
    return applySync(files, remove, home, from);
}

test("a computer that starts syncing adds what the server lacks and leaves what another sent", () =>
    onServer((home) => {
        sync(home, "a", { [SKILL]: "A's review" });
        sync(home, "b", { [SKILL]: "B's review", ".cavvy/skills/ship/SKILL.md": "B's ship" });
        expect(read(home, SKILL)).toBe("A's review");
        expect(read(home, ".cavvy/skills/ship/SKILL.md")).toBe("B's ship");
        // Neither sends again what it hasn't changed.
        expect(sync(home, "a", { [SKILL]: "A's review" }).written).toBe(0);
        expect(sync(home, "b", { [SKILL]: "B's review", ".cavvy/skills/ship/SKILL.md": "B's ship" }).written).toBe(0);
        expect(read(home, SKILL)).toBe("A's review");
    }));

test("the newest change to a file is the one the server has, and the other computer doesn't put its own back", () =>
    onServer((home) => {
        sync(home, "a", { [SKILL]: "one" });
        sync(home, "b", { [SKILL]: "one" });
        sync(home, "b", { [SKILL]: "two, from B" });
        expect(read(home, SKILL)).toBe("two, from B");
        sync(home, "a", { [SKILL]: "one" });
        expect(read(home, SKILL)).toBe("two, from B");
        sync(home, "a", { [SKILL]: "three, from A" });
        expect(read(home, SKILL)).toBe("three, from A");
    }));

test("a file goes from the server only once no computer has it, and one with its own version sends it then", () =>
    onServer((home) => {
        sync(home, "a", { [SKILL]: "A's", ".cavvy/commands/fix.md": "fix" });
        sync(home, "b", { [SKILL]: "B's", ".cavvy/commands/fix.md": "fix" });
        sync(home, "a", {});
        // B still has both: they stay, and B's own version of the skill takes its place.
        expect(read(home, ".cavvy/commands/fix.md")).toBe("fix");
        sync(home, "b", { [SKILL]: "B's", ".cavvy/commands/fix.md": "fix" });
        expect(read(home, SKILL)).toBe("B's");
        sync(home, "b", {});
        expect(existsSync(join(home, SKILL))).toBe(false);
        expect(existsSync(join(home, ".cavvy/commands/fix.md"))).toBe(false);
    }));

test("a record from before says nobody's: a computer added then takes nothing off, and one that had it all claims it", () =>
    onServer((home) => {
        // As a server synced by one computer kept it: what was given, and no computers.
        applySync([file(SKILL, "old"), file(".cavvy/commands/fix.md", "fix")], [], home);
        const record = JSON.parse(readFileSync(join(home, ".cavvy", "synced-files.json"), "utf-8"));
        writeFileSync(join(home, ".cavvy", "synced-files.json"), JSON.stringify(record.given));
        // A new computer syncs first: it has neither, and neither goes.
        expect(syncedFor("b")).toEqual({});
        expect(sync(home, "b", { ".cavvy/skills/b/SKILL.md": "b" }).removed).toBe(0);
        expect(read(home, SKILL)).toBe("old");
        // The one that had them sends them once: the same, so nothing's written, and they're its own now.
        expect(sync(home, "a", { [SKILL]: "old", ".cavvy/commands/fix.md": "fix" }).written).toBe(0);
        sync(home, "a", { [SKILL]: "old" });
        expect(existsSync(join(home, ".cavvy/commands/fix.md"))).toBe(false);
        // Signed out for good: what only it sent no longer keeps a file.
        sync(home, "b", { ".cavvy/skills/b/SKILL.md": "b", [SKILL]: "old" });
        forgetSyncedFiles("b");
        sync(home, "a", {});
        expect(existsSync(join(home, SKILL))).toBe(false);
    }));

test("settings, rules, plugins and keys from two computers merge item by item", () => {
    const store = {};
    const a = { settings: { theme: "dark", notifyAfterSeconds: 30 }, permissions: { allow: ["Bash(ls)"], ask: [], deny: [] }, mcpServers: {}, includeSecrets: true, apiKeys: { openai: { value: "sk-a", endpoint: "https://api.openai.com/v1" } } };
    mergeSent(store, "a", a, 100);
    // B starts syncing: its own setting, rule and key go up; A's theme and key stay, though B has others.
    const b = { settings: { theme: "light", model: "x" }, permissions: { allow: ["Bash(pwd)"], ask: [], deny: [] }, mcpServers: {}, includeSecrets: true, apiKeys: { openai: { value: "sk-b", endpoint: "https://api.openai.com/v1" }, groq: { value: "gsk-b", endpoint: "https://api.groq.com/openai/v1" } } };
    let m = mergeSent(store, "b", b, 200);
    expect(m.settings).toEqual({ theme: "dark", notifyAfterSeconds: 30, model: "x" });
    expect(m.permissions?.allow).toEqual(["Bash(ls)", "Bash(pwd)"]);
    expect(m.apiKeys?.openai?.value).toBe("sk-a");
    expect(m.apiKeys?.groq?.value).toBe("gsk-b");
    // B changes its theme: the newest change wins, and A sending what it had doesn't put its own back.
    m = mergeSent(store, "b", { ...b, settings: { theme: "solarized", model: "x" } }, 300);
    expect(m.settings?.theme).toBe("solarized");
    m = mergeSent(store, "a", a, 400);
    expect(m.settings?.theme).toBe("solarized");
    // A drops its rule and turns its key sync off: B's rule and keys stay; A's rule goes, with nobody to keep it.
    m = mergeSent(store, "a", { ...a, permissions: { allow: [], ask: [], deny: [] }, includeSecrets: undefined, apiKeys: undefined }, 500);
    expect(m.permissions?.allow).toEqual(["Bash(pwd)"]);
    expect(m.includeSecrets).toBe(true);
    expect(m.apiKeys?.openai?.value).toBe("sk-b");
    // B turns its keys off too: none are left to keep, and the server takes them back.
    m = mergeSent(store, "b", { ...b, settings: { theme: "solarized", model: "x" }, includeSecrets: undefined, apiKeys: undefined }, 600);
    expect(m.includeSecrets).toBeUndefined();
    expect(m.apiKeys).toBeUndefined();
});

test("a part one computer couldn't read keeps what it last sent; one computer alone gets what it sends", () => {
    const store = {};
    const a = { settings: { theme: "dark" }, permissions: { allow: [], ask: [], deny: [] }, mcpServers: { docs: { url: "https://mcp.example.com/mcp" } }, marketplaces: [{ name: "m", source: { source: "github", repo: "o/r" } }], plugins: [{ id: "p@m", enabled: true, version: "1" }], customProviders: [], agents: [{ id: "claude-code", accounts: [] }] };
    expect(mergeSent(store, "a", a, 1)).toEqual(a as never);
    // Its settings file unreadable this time: what it sent before still stands.
    const { settings: _, permissions: __, mcpServers: ___, ...rest } = a;
    const m = mergeSent(store, "a", rest, 2);
    expect(m.settings).toEqual({ theme: "dark" });
    expect(m.mcpServers).toEqual({ docs: { url: "https://mcp.example.com/mcp" } });
});

test("the server applies both computers' settings, and tells each what it took from it", () =>
    onServer(async () => {
        const a = { settings: { notifyAfterSeconds: 30 }, permissions: { allow: [], ask: [], deny: [] }, mcpServers: {} };
        const b = { settings: { autoCompact: false }, permissions: { allow: [], ask: [], deny: [] }, mcpServers: {} };
        await applyStateFrom("a", "digest-a", a);
        await applyStateFrom("b", "digest-b", b);
        const settings = JSON.parse(readFileSync(paths.userSettings(), "utf-8"));
        expect(settings.notifyAfterSeconds).toBe(30);
        expect(settings.autoCompact).toBe(false);
        expect((await syncedStateFor("a")).digest).toBe("digest-a");
        expect((await syncedStateFor("b")).digest).toBe("digest-b");
        expect((await syncedStateFor("c")).digest).toBeUndefined();
        // A signed out for good: its setting goes with the next sync, B's stays.
        forgetSyncedState("a");
        // B hasn't changed anything, but what the server should have has: B's next sync applies again.
        expect((await syncedStateFor("b")).digest).toBeUndefined();
        await applyStateFrom("b", "digest-b", b);
        const after = JSON.parse(readFileSync(paths.userSettings(), "utf-8"));
        expect(after.notifyAfterSeconds).toBeUndefined();
        expect(after.autoCompact).toBe(false);
    }));
