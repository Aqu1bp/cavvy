// A CLI's variables and its named copies (Settings → Providers) reach a server that syncs: never a sign-in, secret
// ones only while keys sync, and what the server set or changed itself stays (src/servers/sync-state.ts).

import { afterAll, expect, test } from "bun:test";
import { writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { getKey, forgetCachedKeys } = await import("../src/auth/credentials");
const { readProvidersFile, writeProvidersFile } = await import("../src/providers/registry");
const { saveAgentEnv, secretEnvId } = await import("../src/providers/agent-env");
const { addInstance, removeInstance, updateInstance } = await import("../src/providers/instances");
const { applyStateSync, localSyncState } = await import("../src/servers/sync-state");

const binDir = tempDir("cavvy-fake-bin-");
writeFileSync(join(binDir, "claude"), "#!/bin/sh\nprintf '{\"loggedIn\":false}\\n'\n", { mode: 0o755 });
const prevPath = process.env.PATH;
process.env.PATH = `${binDir}:${prevPath ?? ""}`;
afterAll(() => {
    process.env.PATH = prevPath;
    iso.cleanup();
});

async function inHome<T>(home: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = process.env.CAVVY_HOME;
    process.env.CAVVY_HOME = home;
    forgetCachedKeys();
    try {
        return await fn();
    } finally {
        process.env.CAVVY_HOME = prev;
        forgetCachedKeys();
    }
}

/** This computer's state, applied on the server as sync does. */
async function sync(server: string, includeSecrets: boolean) {
    const payload = await localSyncState({ includeSecrets });
    return inHome(server, () => applyStateSync(undefined, payload));
}

const agents = (home: string) => inHome(home, () => readProvidersFile().agents ?? {});
const stored = (home: string, provider: string, name: string) => inHome(home, async () => (await getKey(secretEnvId(provider, name)).catch(() => undefined))?.value);

test("with key sync on, a CLI's variables and its copies reach the server; sign-ins and machine paths don't", async () => {
    writeProvidersFile({ agents: { "claude-code": {} } });
    await saveAgentEnv("claude-code", [
        { name: "PLAIN", value: "one" },
        { name: "TOKEN_KEY", value: "s3cret-value", secret: true },
        { name: "CLAUDE_CODE_OAUTH_TOKEN", value: "x" },
        { name: "LOOKS_SIGNED_IN", value: "sk-ant-oat01-abcdefghijklmnop" },
    ]);
    const copy = await addInstance("claude-code", { name: "Router", path: "/Users/me/bin/claude", args: ["--x"], models: ["m-1"], env: [{ name: "ROUTER_URL", value: "https://r.example.com" }] });

    const payload = await localSyncState({ includeSecrets: true });
    // A copy goes beside the CLIs: a server from before copies would take one inside `agents` for Claude Code itself.
    expect(payload.agents?.map((a) => a.id)).not.toContain(copy);
    expect(payload.agentInstances?.map((i) => i.id)).toEqual([copy]);
    expect(JSON.stringify(payload)).not.toContain("/Users/me/bin/claude");
    expect(JSON.stringify(payload)).not.toContain("sk-ant-oat01");
    expect(JSON.stringify(payload)).not.toContain("CLAUDE_CODE_OAUTH_TOKEN");

    const server = tempDir("cavvy-sync-env-server-");
    await inHome(server, () => writeProvidersFile({ agents: {} }));
    const r = await sync(server, true);
    expect(r.changedProviders).toEqual(expect.arrayContaining(["claude-code", copy]));
    const a = await agents(server);
    expect(a["claude-code"]?.env).toEqual({ PLAIN: "one" });
    expect(a["claude-code"]?.secretEnv).toEqual(["TOKEN_KEY"]);
    expect(await stored(server, "claude-code", "TOKEN_KEY")).toBe("s3cret-value");
    expect(a[copy]).toEqual({ name: "Router", models: ["m-1"], env: { ROUTER_URL: "https://r.example.com" } });

    // Nothing changed here: nothing changes there.
    expect((await sync(server, true)).changedProviders).toEqual([]);

    // Turning key sync off takes the secret one back, and leaves the rest.
    await sync(server, false);
    const off = await agents(server);
    expect(off["claude-code"]?.env).toEqual({ PLAIN: "one" });
    expect(off["claude-code"]?.secretEnv).toBeUndefined();
    expect(await stored(server, "claude-code", "TOKEN_KEY")).toBeUndefined();
    expect(off[copy]?.name).toBe("Router");
    await removeInstance(copy);
});

test("what the server set or changed itself stays; what sync wrote follows this computer, removals too", async () => {
    writeProvidersFile({ agents: { "claude-code": {} } });
    await saveAgentEnv("claude-code", [
        { name: "A", value: "mac" },
        { name: "B", value: "mac" },
        { name: "C", value: "mac" },
    ]);
    const copy = await addInstance("claude-code", { name: "Kept", env: [] });
    const gone = await addInstance("claude-code", { name: "Gone", env: [] });

    const server = tempDir("cavvy-sync-env-server-");
    // The server's own value for C, set before sync.
    await inHome(server, async () => {
        writeProvidersFile({ agents: { "claude-code": {} } });
        await saveAgentEnv("claude-code", [{ name: "C", value: "server" }]);
    });
    await sync(server, true);
    expect((await agents(server))["claude-code"]?.env).toEqual({ A: "mac", B: "mac", C: "server" });

    // Changed on the server: A's value and the copy's name.
    await inHome(server, async () => {
        await saveAgentEnv("claude-code", [{ name: "A", value: "edited" }, { name: "B", value: "mac" }, { name: "C", value: "server" }]);
        await updateInstance(copy, { name: "Kept here", env: [] });
    });
    // Here: A and B change, C goes, the copies are removed.
    await saveAgentEnv("claude-code", [{ name: "A", value: "mac2" }, { name: "B", value: "mac2" }]);
    await removeInstance(copy);
    await removeInstance(gone);
    await sync(server, true);
    const a = await agents(server);
    expect(a["claude-code"]?.env).toEqual({ A: "edited", B: "mac2", C: "server" });
    expect(a[copy]?.name).toBe("Kept here");
    expect(a[gone]).toBeUndefined();

    // Removed here: B (sync's) goes; A (changed there) and C (the server's own) stay.
    await saveAgentEnv("claude-code", []);
    await sync(server, true);
    expect((await agents(server))["claude-code"]?.env).toEqual({ A: "edited", C: "server" });
});

test("a secret that can't be read here leaves the server's variables as they are", async () => {
    writeProvidersFile({ agents: { "claude-code": {} } });
    await saveAgentEnv("claude-code", [{ name: "P", value: "1" }, { name: "S", value: "v", secret: true }]);
    const server = tempDir("cavvy-sync-env-server-");
    await inHome(server, () => writeProvidersFile({ agents: {} }));
    await sync(server, true);
    // Its stored value lost here (a keychain that won't answer): nothing is taken off the server for it.
    const pf = readProvidersFile();
    writeProvidersFile({ ...pf, agents: { "claude-code": { ...pf.agents!["claude-code"], secretEnv: ["S", "MISSING"] } } });
    await sync(server, true);
    expect((await agents(server))["claude-code"]?.secretEnv).toEqual(["S"]);
    expect(await stored(server, "claude-code", "S")).toBe("v");
});

test("turning key sync off takes the secret variables back though the payload carries no providers", async () => {
    writeProvidersFile({ agents: { "claude-code": {} } });
    await saveAgentEnv("claude-code", [{ name: "S", value: "v", secret: true }]);
    const copy = await addInstance("claude-code", { name: "Renamed there", env: [{ name: "CS", value: "cv", secret: true }] });
    const server = tempDir("cavvy-sync-env-server-");
    await inHome(server, () => writeProvidersFile({ agents: {} }));
    await sync(server, true);
    // The copy renamed on the server: its name is the server's now, but the secret sync put in it is still sync's.
    await inHome(server, () => updateInstance(copy, { name: "Mine now", env: [{ name: "CS", secret: true }] }));
    await sync(server, true);
    expect((await agents(server))[copy]?.name).toBe("Mine now");
    // An opt-out whose providers couldn't be read here: the secrets go all the same, as keys do.
    const r = await inHome(server, () => applyStateSync(undefined, {}));
    expect(r.keysLeft).toBeUndefined();
    expect(await stored(server, "claude-code", "S")).toBeUndefined();
    expect(await stored(server, copy, "CS")).toBeUndefined();
    expect((await agents(server))["claude-code"]?.secretEnv).toBeUndefined();
    await removeInstance(copy);
});

test("what the server added to a synced CLI or copy keeps it when this computer drops it", async () => {
    writeProvidersFile({ agents: { "claude-code": {} } });
    const copy = await addInstance("claude-code", { name: "Shared", env: [] });
    const server = tempDir("cavvy-sync-env-server-");
    await inHome(server, () => writeProvidersFile({ agents: {} }));
    await sync(server, true);
    // On the server: a variable of its own for the CLI sync turned on, a path for the copy.
    await inHome(server, async () => {
        await saveAgentEnv("claude-code", [{ name: "OWN", value: "server" }]);
        const pf = readProvidersFile();
        writeProvidersFile({ ...pf, agents: { ...pf.agents, [copy]: { ...pf.agents![copy], path: "/opt/claude" } } });
    });
    await removeInstance(copy);
    writeProvidersFile({ agents: {} });
    await sync(server, true);
    const a = await agents(server);
    expect(a["claude-code"]?.env).toEqual({ OWN: "server" });
    expect(a[copy]?.path).toBe("/opt/claude");
});

test("a copy whose CLI the server lacks asks for that CLI", async () => {
    writeProvidersFile({ agents: {} });
    const copy = await addInstance("opencode", { name: "Alone", env: [] });
    const server = tempDir("cavvy-sync-env-server-");
    // OpenCode counts as missing there whatever this machine has installed.
    await inHome(server, () => writeProvidersFile({ agents: { opencode: { path: join(server, "no-opencode") } } }));
    const r = await sync(server, false);
    expect(r.missingClis).toContain("opencode");
    expect((await agents(server))[copy]).toBeUndefined();
    await removeInstance(copy);
});
