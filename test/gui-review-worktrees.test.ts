// The diff reader's worktree picker: which worktree each running sub-agent is
// in (src/server/worktree-agents.ts) and each session (gui/src/lib/worktree-work.ts),
// and the reader's choice of worktree, its views, and falling back when the
// worktree goes away.
import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "url";
import type { AgentRun, Block } from "../src/server/protocol";
import { agentsByWorktree, agentWorktree, commandPaths, normalPath, toolPaths, worktreeOf } from "../src/server/worktree-agents";
import { keepWorktree, ownOnScreen, pickScope, pickWorktree, worktreeWork, type ReviewPlace } from "../gui/src/lib/worktree-work";

const HOME = "/Users/me";
const MAIN = "/Users/me/repo";
const NESTED = "/Users/me/repo/.claude/worktrees/fix";
const TMP = "/private/tmp/ui-thing";
const LISTED = [MAIN, NESTED, TMP];
const NORMAL = LISTED.map((w) => normalPath(w)!);

let n = 0;
const tool = (name: string, input: Record<string, unknown>): Block => ({ t: "tool", id: `t${++n}`, name, title: name, input, status: "ok" });
const text = (t: string): Block => ({ t: "text", id: `x${++n}`, text: t });
const agent = (blocks: Block[], o: Partial<AgentRun> = {}): AgentRun => ({ id: `a${++n}`, turnId: "turn", description: "Fix the parser", agentType: "general-purpose", status: "running", startedAt: 0, toolCount: blocks.length, tokens: 0, blocks, ...o });

describe("paths", () => {
    test("absolute paths are normalized, /private/tmp is /tmp, relative ones don't count", () => {
        expect(normalPath("/private/tmp/a/./b/../c//")).toBe("/tmp/a/c");
        expect(normalPath("/private/var/folders/x")).toBe("/var/folders/x");
        expect(normalPath("/private/tmpfoo")).toBe("/private/tmpfoo");
        expect(normalPath("~/repo/src", HOME)).toBe("/Users/me/repo/src");
        expect(normalPath("~/repo", undefined)).toBeUndefined();
        expect(normalPath("src/a.ts")).toBeUndefined();
    });

    test("a path belongs to the deepest worktree holding it, and not to a folder that merely starts the same", () => {
        expect(worktreeOf("/Users/me/repo/.claude/worktrees/fix/src/a.ts", NORMAL)).toBe(NESTED);
        expect(worktreeOf("/Users/me/repo/src/a.ts", NORMAL)).toBe(MAIN);
        expect(worktreeOf("/Users/me/repo-other/a.ts", NORMAL)).toBeUndefined();
        expect(worktreeOf("/tmp/ui-thing", NORMAL)).toBe("/tmp/ui-thing");
    });

    test("a command's cd, git -C and git worktree add, quoted or not, relative to where it went", () => {
        expect(commandPaths("cd /tmp/a && bun test")).toEqual(["/tmp/a"]);
        // Codex's commands run elsewhere come as a quoted cd.
        expect(commandPaths("cd '/private/tmp/it'\\''s' && ls")).toEqual(["/tmp/it's"]);
        expect(commandPaths('cd "/Users/me/my repo" ; git status')).toEqual(["/Users/me/my repo"]);
        expect(commandPaths("git -C /Users/me/repo log --oneline -3")).toEqual(["/Users/me/repo"]);
        expect(commandPaths("cd /Users/me/repo && git worktree add -b ui/x /private/tmp/ui-x origin/main")).toEqual(["/Users/me/repo", "/tmp/ui-x"]);
        expect(commandPaths("git -C ~/repo worktree add --detach ../wt", HOME)).toEqual(["/Users/me/repo", "/Users/me/wt"]);
        expect(commandPaths("cd /Users/me/repo && cd .claude/worktrees/fix && make")).toEqual(["/Users/me/repo", NESTED]);
        expect(commandPaths("FOO=1 git -c core.x=y -C /tmp/a status")).toEqual(["/tmp/a"]);
        expect(commandPaths("(cd /tmp/a; ls) | head")).toEqual(["/tmp/a"]);
        // Where these go isn't in the words.
        expect(commandPaths("cd $WORK && cd - && cd src && ls")).toEqual([]);
        // Only a command's own cd: an argument named cd isn't one.
        expect(commandPaths("echo cd /tmp/a")).toEqual([]);
        expect(commandPaths("cat /tmp/a/file")).toEqual([]);
    });

    test("a tool call's folder, command and file, by its input", () => {
        expect(toolPaths({ name: "Read", input: { file_path: "/tmp/a/x.ts" } })).toEqual(["/tmp/a/x.ts"]);
        expect(toolPaths({ name: "Grep", input: { pattern: "x", path: "/tmp/a/src" } })).toEqual(["/tmp/a/src"]);
        expect(toolPaths({ name: "Bash", input: { command: "cd /tmp/a && ls" } })).toEqual(["/tmp/a"]);
        expect(toolPaths({ name: "exec_command", input: { cmd: "ls", workdir: "/tmp/b" } })).toEqual(["/tmp/b"]);
        // A command field that isn't a shell's isn't parsed.
        expect(toolPaths({ name: "mcp__x__run", input: { command: "cd /tmp/a" } })).toEqual([]);
        expect(toolPaths({ name: "Edit", input: { file_path: "src/a.ts" } })).toEqual([]);
    });
});

describe("a sub-agent's worktree", () => {
    test("follows its commands' cd and the files it edits", () => {
        const a = agent([text("Starting"), tool("Read", { file_path: `${MAIN}/AGENTS.md` }), tool("Bash", { command: `cd ${TMP} && bun install` }), tool("Edit", { file_path: "/tmp/ui-thing/src/a.ts" }), tool("Bash", { command: "bun test ./test/a.test.ts" })]);
        expect(agentWorktree(a, NORMAL)).toBe(normalPath(TMP));
    });

    test("a look at another checkout's file doesn't move it; most of its recent calls decide", () => {
        const a = agent([tool("Edit", { file_path: `${NESTED}/a.ts` }), tool("Bash", { command: `cd ${NESTED} && make` }), tool("Read", { file_path: `${MAIN}/README.md` })]);
        expect(agentWorktree(a, NORMAL)).toBe(NESTED);
        // On a tie, the latest.
        const b = agent([tool("Read", { file_path: `${MAIN}/a.ts` }), tool("Read", { file_path: `${TMP}/a.ts` })]);
        expect(agentWorktree(b, NORMAL)).toBe("/tmp/ui-thing");
    });

    test("making a worktree and working in it puts it there", () => {
        const a = agent([tool("Bash", { command: `git -C ${MAIN} worktree add -b agent/x /private/tmp/agent-x` }), tool("Bash", { command: "cd /private/tmp/agent-x && bun install" })]);
        expect(agentWorktree(a, [...NORMAL, "/tmp/agent-x"])).toBe("/tmp/agent-x");
    });

    test("no absolute path in a listed worktree: nowhere", () => {
        expect(agentWorktree(agent([tool("Bash", { command: "ls" }), tool("Read", { file_path: "/etc/hosts" }), text("Done")]), NORMAL)).toBeUndefined();
    });
});

describe("what works in each worktree", () => {
    const sessions = [
        { id: "self", cwd: MAIN, title: "This one", status: "running" as const, settled: false, updatedAt: 9 },
        { id: "s1", cwd: `${MAIN}/src`, title: "Older in main", status: "idle" as const, settled: false, updatedAt: 1 },
        { id: "s2", cwd: MAIN, title: "Running in main", status: "running" as const, settled: false, updatedAt: 2 },
        { id: "s3", cwd: NESTED, title: "Set aside", status: "idle" as const, settled: true, updatedAt: 3 },
        { id: "s4", cwd: "/tmp/ui-thing", title: "", status: "waiting" as const, settled: true, updatedAt: 4 },
        { id: "s5", cwd: "/Users/me/elsewhere", title: "Elsewhere", status: "idle" as const, settled: false, updatedAt: 5 },
    ];

    test("sessions by their folder (not this one, nor set-aside idle ones), running first, with the sub-agents the server found", () => {
        const agents = [{ id: "a1", sessionId: "s9", description: "Port the picker", waiting: false }];
        const work = worktreeWork([{ path: MAIN }, { path: NESTED }, { path: TMP, agents }], sessions, { home: HOME, self: "self" });
        expect(work.get(MAIN)).toEqual({
            sessions: [
                { id: "s2", title: "Running in main", running: true },
                { id: "s1", title: "Older in main", running: false },
            ],
            agents: [],
        });
        expect(work.get(NESTED)).toEqual({ sessions: [], agents: [] });
        // Keyed by the path as listed (/private/tmp), matched as /tmp.
        expect(work.get(TMP)).toEqual({ sessions: [{ id: "s4", title: "New session", running: true }], agents });
    });

    test("running sub-agents by their paths; finished ones and ones from before a reopen aren't working anywhere", () => {
        const working = agent([tool("Bash", { command: `cd ${TMP} && make` })], { description: "Port the picker" });
        const waiting = agent([tool("Edit", { file_path: `${NESTED}/x.ts` })], { status: "waiting", description: "" });
        const done = agent([tool("Bash", { command: `cd ${TMP}` })], { status: "done" });
        const replayed = agent([tool("Bash", { command: `cd ${TMP}` })], { replayed: true });
        const nowhere = agent([tool("Bash", { command: "ls" })]);
        const found = agentsByWorktree(LISTED, [working, waiting, done, replayed, nowhere].map((a) => ({ sessionId: "s1", agent: a })), HOME);
        expect([...found.keys()]).toEqual([TMP, NESTED]);
        expect(found.get(TMP)).toEqual([{ id: working.id, sessionId: "s1", description: "Port the picker", waiting: false }]);
        expect(found.get(NESTED)).toEqual([{ id: waiting.id, sessionId: "s1", description: "Sub-agent", waiting: true }]);
    });
});

describe("the reader's choice of worktree", () => {
    const own: ReviewPlace = { scope: "last-turn", base: "origin/main" };

    test("another worktree opens on its branch against the default base; back home brings back the session's view", () => {
        const there = pickWorktree(own, TMP);
        expect(there).toEqual({ worktree: TMP, scope: "branch", own: { scope: "last-turn", base: "origin/main" } });
        // Uncommitted stays selectable there; turns and Harness edits don't.
        const uncommitted = pickScope(there, "uncommitted");
        expect(uncommitted.scope).toBe("uncommitted");
        expect(pickScope(there, "harness")).toBe(there);
        expect(pickScope(there, "last-turn")).toBe(there);
        // Moving on to a third worktree starts on its branch again, and still remembers home.
        const third = pickWorktree({ ...uncommitted, base: "ui/stack" }, NESTED);
        expect(third).toEqual({ worktree: NESTED, scope: "branch", own: { scope: "last-turn", base: "origin/main" } });
        expect(pickWorktree(third, undefined)).toEqual({ scope: "last-turn", base: "origin/main" });
        // Picking the one already shown changes nothing.
        expect(pickWorktree(third, NESTED)).toBe(third);
        expect(pickScope(own, "harness")).toEqual({ scope: "harness", base: "origin/main" });
    });

    test("falls back to the session's folder when the worktree is removed, its folder is gone, or it's become the session's own", () => {
        const there = pickWorktree(own, TMP);
        const row = (o: Partial<{ path: string; exists: boolean; prunable: string; current: boolean }> = {}) => ({ path: TMP, exists: true, current: false, ...o });
        expect(keepWorktree(there, [row({ path: MAIN, current: true }), row()])).toBe(there);
        expect(keepWorktree(there, undefined)).toBe(there);
        for (const listed of [[row({ path: MAIN, current: true })], [row({ exists: false })], [row({ prunable: "gitdir file points to non-existent location" })], [row({ current: true })]]) {
            expect(keepWorktree(there, listed)).toEqual({ scope: "last-turn", base: "origin/main" });
        }
        // At home, nothing to fall back from.
        expect(keepWorktree(own, [])).toBe(own);
    });

    test("the session's own actions wait for the session's own answer: back from another worktree, its diff stays on screen until the session's comes", () => {
        // Just switched back: the other worktree's answer is still the one shown.
        expect(ownOnScreen(undefined, "uncommitted", { worktree: TMP })).toBe(false);
        expect(ownOnScreen(undefined, "branch", { worktree: TMP })).toBe(false);
        // The session's answer arrived (or none has yet, so there's nothing on screen to act on).
        expect(ownOnScreen(undefined, "uncommitted", {})).toBe(true);
        expect(ownOnScreen(undefined, "uncommitted", undefined)).toBe(true);
        // Another worktree chosen: never, even while the session's last answer is still shown.
        expect(ownOnScreen(TMP, "branch", {})).toBe(false);
        // Harness edits come from the session's own record, not git's answer.
        expect(ownOnScreen(undefined, "harness", { worktree: TMP })).toBe(true);
    });
});

test("switching back from another worktree, its diff isn't taken for the session's while the session's loads", async () => {
    // Solid's server build doesn't run effects: browser conditions, in a child (as gui-changes-reconnect does).
    const child = Bun.spawn([process.execPath, "--no-env-file", "--conditions=browser", fileURLToPath(new URL("./fixtures/gui-review-worktree-answer.ts", import.meta.url))], { stdout: "pipe", stderr: "pipe" });
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
    expect({ code, stdout, stderr }).toEqual({ code: 0, stdout: "", stderr: "" });
});
