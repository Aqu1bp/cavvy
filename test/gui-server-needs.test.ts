// The mark on a server's name in Settings → Providers (gui/src/lib/server-needs.ts): from what its last sync said.
import { expect, test } from "bun:test";
import { serverNeeds } from "../gui/src/lib/server-needs";

const server = { name: "vps", destination: "dev@vps.example", connected: true };

test("a server that hasn't said anything, or lacks nothing, gets no mark", () => {
    expect(serverNeeds(server)).toBe(0);
    expect(serverNeeds({ ...server, sync: { state: "synced" } })).toBe(0);
    // A sync that failed for another reason isn't something to set up there.
    expect(serverNeeds({ ...server, sync: { state: "error", error: "Marketplace tools: no such repository" } })).toBe(0);
});

test("each CLI that isn't installed and each account that isn't signed in counts", () => {
    expect(serverNeeds({ ...server, sync: { state: "synced", missingClis: ["codex"], needsSignIn: [{ provider: "claude-code", accountId: "default", name: "Default" }, { provider: "claude-code", accountId: "work", name: "Work" }] } })).toBe(3);
});
