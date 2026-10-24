import { expect, test } from "bun:test";
import type { AgentRun, Block, TurnPlace } from "../src/server/protocol";
import { cardShape, incompleteLine, placeRows, placesTotal, workers } from "../gui/src/lib/turn-places";

const place = (name: string, files: number, o: Partial<TurnPlace> = {}): TurnPlace => ({ path: `/work/repo/.claude/worktrees/${name}`, branch: `agent/${name}`, files, added: files * 10, removed: files, ...o });
const tool = (id: string, name: string, input: Record<string, unknown>): Block => ({ t: "tool", id, name, title: name, status: "ok", input }) as Block;
const agent = (id: string, description: string, turnId: string, blocks: Block[], model?: string): AgentRun => ({ id, turnId, description, agentType: "general-purpose", status: "done", startedAt: 0, toolCount: blocks.length, tokens: 0, blocks, ...(model ? { model } : {}) }) as AgentRun;

test("the card shows the folder's files, one worktree's files, or a row per place", () => {
    const own = { files: 2, added: 12, removed: 2 };
    expect(cardShape(own, [])).toBe("files");
    expect(cardShape(undefined, [place("home", 35)])).toBe("worktree");
    expect(cardShape(own, [place("home", 35)])).toBe("places");
    expect(cardShape(undefined, [place("home", 35), place("errors", 7)])).toBe("places");
});

test("rows: the session's own folder first, then the other places by files, then lines", () => {
    const own = { files: 2, added: 12, removed: 2 };
    const rows = placeRows(own, [place("skill", 3), place("home", 35), place("errors", 7), place("tie", 7, { added: 900 })]);
    expect(rows.map((r) => (r.own ? "own" : r.place.branch))).toEqual(["own", "agent/home", "agent/tie", "agent/errors", "agent/skill"]);
    expect(placesTotal(rows)).toEqual({ files: 54, added: 12 + 350 + 900 + 70 + 30, removed: 2 + 35 + 7 + 7 + 3 });
    // A place whose counts couldn't be read sorts last and counts nothing.
    expect(placeRows(undefined, [{ path: "/work/repo/.claude/worktrees/slow" }, place("home", 1)]).map((r) => r.place.files)).toEqual([1, undefined]);
});

test("who worked where: the turn's sub-agents by the paths their calls name, and the session itself as You", () => {
    const places = [place("home", 35), place("errors", 7), place("idle", 1)];
    const map = workers(places, {
        turnId: "t1",
        own: "claude-code",
        provider: (a) => a.model?.split(":")[0],
        blocks: [tool("b1", "Edit", { file_path: "/work/repo/.claude/worktrees/home/a.ts" })],
        agents: [
            agent("a1", "Port Home", "t1", [tool("x1", "Bash", { command: "cd /work/repo/.claude/worktrees/home && bun test" })]),
            agent("a2", "Error cards", "t1", [tool("x2", "Write", { file_path: "/work/repo/.claude/worktrees/errors/E.tsx" })], "codex:gpt"),
            // Another turn's agent, even in the same place, isn't this turn's.
            agent("a3", "Earlier", "t0", [tool("x3", "Write", { file_path: "/work/repo/.claude/worktrees/errors/old.ts" })]),
        ],
    });
    expect(map.get(places[0]!.path)?.map((w) => [w.label, w.provider, !!w.you])).toEqual([["You", "claude-code", true], ["Port Home", "claude-code", false]]);
    expect(map.get(places[1]!.path)?.map((w) => [w.label, w.provider])).toEqual([["Error cards", "codex"]]);
    expect(map.has(places[2]!.path)).toBe(false);
});

test("a card's Review opens that worktree on its branch against main, even when it's the one already looked at in another view", async () => {
    const { requestWorktree } = await import("../gui/src/lib/worktree-work");
    const wt = "/work/repo/.claude/worktrees/home";
    // From the session's own folder: that worktree on its branch, the folder's view kept for coming back.
    expect(requestWorktree({ scope: "turn" }, wt)).toEqual({ worktree: wt, scope: "branch", base: undefined, own: { scope: "turn", base: undefined } });
    // Already on it, in its Uncommitted view against another base: back to its branch against main.
    expect(requestWorktree({ worktree: wt, scope: "uncommitted", base: "release", own: { scope: "turn" } }, wt)).toEqual({ worktree: wt, scope: "branch", base: undefined, own: { scope: "turn" } });
});

test("an incomplete snapshot is one line: how many paths it left out, the reasons in the tooltip, not the standing policy", () => {
    const policy = "Ignored files are not captured. Concurrent sessions in this repository see each other's changes. Submodule and nested repository contents are not captured.";
    expect(incompleteLine([policy, "Not captured: vendor/sdk/: Submodule or nested repository contents are not captured."])).toEqual({ text: "1 path not captured", detail: "Not captured: vendor/sdk/: Submodule or nested repository contents are not captured." });
    const many = [policy, ...Array.from({ length: 20 }, (_, i) => `Not captured: f${i}: Over 10 MB; not captured, change unknown.`), "5 other paths were not captured."];
    expect(incompleteLine(many).text).toBe("25 paths not captured");
    expect(incompleteLine([policy, "Snapshot exceeded its time budget (2 seconds by default)."])).toEqual({ text: "Snapshot incomplete", detail: "Snapshot exceeded its time budget (2 seconds by default)." });
});
