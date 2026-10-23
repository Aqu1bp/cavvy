import { expect, test } from "bun:test";
import { backgroundWait, glideFrom, GLIDE_MAX, heldTurns, lastLines, lineTone, liveLine, specialActivity, workedLabel, workSegments, type LiveInput } from "../gui/src/lib/live-line";

// The running turn's live line (gui/src/lib/live-line.ts): what it says, which turns a steer keeps open, what a
// folded turn says, and the glide's arithmetic. LiveLine.tsx, TurnView.tsx and Transcript.tsx draw from these.

const tool = (o: Record<string, unknown>) => ({ t: "tool", id: "t1", name: "Read", title: "Read(src/a.ts)", input: { file_path: "src/a.ts" }, status: "running", startedAt: 5, ...o }) as any;
const line = (o: Partial<LiveInput>) => liveLine({ blocks: [], interactions: [], showThinking: true, ...o });

test("a request waiting on the user comes first, in its own words", () => {
    const blocks = [tool({ status: "running" })];
    expect(line({ blocks, interactions: [{ kind: "question", id: "q" } as any] })).toMatchObject({ kind: "wait", label: "Waiting for your answer", key: "wait:q" });
    expect(line({ blocks, interactions: [{ kind: "plan", id: "p" } as any] })).toMatchObject({ label: "Waiting for plan review" });
    expect(line({ interactions: [{ kind: "permission", id: "a", title: "Bash", command: "rm -rf build\necho done" } as any] })).toMatchObject({ label: "Waiting for approval", detail: "rm -rf build", mono: true });
    expect(line({ interactions: [{ kind: "permission", id: "a", title: "Fetch example.com" } as any] })).toMatchObject({ detail: "Fetch example.com", mono: false });
    expect(line({ interactions: [{ kind: "secret", id: "s", name: "GITHUB_TOKEN" } as any] })).toMatchObject({ label: "Waiting for a secret", detail: "GITHUB_TOKEN" });
});

test("special states (a retry, a compaction, a wait on background work) say themselves over the step under way", () => {
    const blocks = [tool({})];
    expect(line({ blocks, activity: { label: "Retrying in 5s · Stop to cancel", since: 9, detail: "529 overloaded (attempt 2)" } })).toMatchObject({ kind: "special", label: "Retrying in 5s", detail: "529 overloaded (attempt 2)", since: 9 });
    // The countdown changes the label, not the state: it updates in place rather than rolling.
    expect(line({ activity: { label: "Retrying in 4s · Stop to cancel", since: 9 } })?.key).toBe(line({ activity: { label: "Retrying in 5s · Stop to cancel", since: 9 } })?.key);
    expect(line({ activity: { label: "Compacting conversation", since: 1 } })).toMatchObject({ kind: "special", label: "Compacting conversation" });
    expect(line({ activity: { label: "Waiting for background monitor: build log · Esc to stop it", since: 1 } })).toMatchObject({ kind: "bg", label: "Waiting for background", detail: "build log" });
    expect(specialActivity("Connecting MCP servers")).toBe(true);
    expect(specialActivity("Thinking")).toBe(false);
    expect(specialActivity(undefined)).toBe(false);
    expect(backgroundWait("Waiting for background command: a; background task: b · Esc to stop them")).toBe("a, b");
    expect(backgroundWait("Waiting for approval")).toBeUndefined();
});

test("the step under way: its verb and target, a command by its description, an approval first", () => {
    expect(line({ blocks: [tool({})] })).toMatchObject({ kind: "tool", label: "Reading", detail: "src/a.ts", mono: true, since: 5, toolId: "t1" });
    const cmd = tool({ id: "c", name: "Bash", title: "Bash", input: { command: "bun test ./test/a.test.ts\necho done", description: "Run the transcript tests" }, progress: "a\nb\n" });
    expect(line({ blocks: [cmd] })).toMatchObject({ label: "Run the transcript tests", detail: "bun test ./test/a.test.ts", output: "a\nb\n", title: "bun test ./test/a.test.ts\necho done" });
    // Codex sends no description: "Running" and the command.
    expect(line({ blocks: [{ ...cmd, input: { command: "rg -n x" } }] })).toMatchObject({ label: "Running", detail: "rg -n x" });
    // Only a running command has an output window; one still arriving says how much of it has.
    expect(line({ blocks: [{ ...cmd, status: "streaming", receiving: 1200 }] })).toMatchObject({ label: "Preparing run", meta: "1.2k chars" });
    expect(line({ blocks: [{ ...cmd, status: "streaming", receiving: 1200 }] })?.output).toBeUndefined();
    expect(line({ blocks: [{ ...cmd, input: { command: "sleep 240" } }] })).toMatchObject({ label: "Waiting", meta: "of 4m 0s" });
    // An approval among several calls under way wins; otherwise the latest running one.
    const a = tool({ id: "a" }), b = tool({ id: "b", name: "Grep", title: "Grep(x)" }), c = tool({ id: "c", status: "queued" });
    expect(line({ blocks: [a, b, c] })).toMatchObject({ toolId: "b", label: "Searching" });
    expect(line({ blocks: [a, { ...b, status: "awaiting" }, c] })).toMatchObject({ kind: "wait", toolId: "b", label: "Waiting for approval" });
    // A new call is a new state (the line rolls); the same call, still running, isn't.
    expect(line({ blocks: [a] })?.key).not.toBe(line({ blocks: [b] })?.key);
    expect(line({ blocks: [a] })?.key).toBe(line({ blocks: [{ ...a, progress: "more" }] })?.key);
    // A background command's check says when that command started.
    expect(line({ blocks: [tool({ name: "BashOutput", title: "BashOutput", job: { label: "npm run dev", startedAt: 3 } })] })).toMatchObject({ label: "Checking output", detail: "npm run dev", jobSince: 3 });
});

test("thinking shows the thought's latest line unless Show thinking is off; the answer streaming hides the line", () => {
    const thought = { t: "thinking", id: "th", text: "Checking what's merged.\n\n**Main** is at d55ddfac.\n", startedAt: 7 } as any;
    expect(line({ blocks: [thought], activity: { label: "Thinking", since: 1 } })).toMatchObject({ kind: "think", label: "Thinking", detail: "Main is at d55ddfac.", since: 7 });
    expect(line({ blocks: [thought], activity: { label: "Thinking", since: 1 }, showThinking: false })?.detail).toBeUndefined();
    // Updating the thought doesn't roll the line.
    expect(line({ blocks: [{ ...thought, text: "more" }], activity: { label: "Thinking", since: 1 } })?.key).toBe("think");
    // A finished thought, then the model working on: "Thinking" from the activity, no stale thought.
    expect(line({ blocks: [{ ...thought, durationMs: 900 }], activity: { label: "Thinking", since: 1 } })).toMatchObject({ kind: "think", since: 1 });
    expect(line({ blocks: [{ ...thought, durationMs: 900 }], activity: { label: "Thinking", since: 1 } })?.detail).toBeUndefined();
    expect(line({ blocks: [{ t: "text", id: "x", text: "Hello" } as any], activity: { label: "Writing", since: 1 } })).toBeUndefined();
    expect(line({ blocks: [{ t: "shell", id: "s", command: "ls", output: "", running: true } as any] })).toBeUndefined();
    expect(line({})).toMatchObject({ kind: "work", label: "Working" });
    expect(line({ activity: { label: "Getting /review", since: 2 } })).toMatchObject({ kind: "work", label: "Getting /review", since: 2 });
});

test("a steer keeps the turns it ended open until the chain's last turn ends", () => {
    const t = (id: string, status: string, steered = false) => ({ id, status, prompt: { text: id, ...(steered ? { steered: true } : {}) } }) as any;
    // A steer drained: the first turn ended, the steered one runs.
    expect([...heldTurns([t("a", "done"), t("b", "running", true)])]).toEqual(["a"]);
    // Steered twice: both earlier turns wait for the last.
    expect([...heldTurns([t("a", "done"), t("b", "done", true), t("c", "running", true)])].sort()).toEqual(["a", "b"]);
    // The chain over (stopped, or done): nothing held, all of them fold.
    expect([...heldTurns([t("a", "done"), t("b", "done", true), t("c", "aborted", true)])]).toEqual([]);
    // A queued message's turn, or a new prompt, isn't a steer: the turn before folds when it ends.
    expect([...heldTurns([t("a", "done"), t("b", "running")])]).toEqual([]);
    // Only the chain into the running turn is held, not an older one.
    expect([...heldTurns([t("a", "done"), t("b", "done", true), t("c", "done"), t("d", "running", true)])]).toEqual(["c"]);
});

test("a folded turn says how long it worked, never 0s", () => {
    expect(workedLabel(1000, 1341)).toBe("Worked briefly");
    expect(workedLabel(1000, 2000)).toBe("Worked for 1s");
    expect(workedLabel(0, 125_000)).toBe("Worked for 2m 5s");
    expect(workedLabel(undefined, 5)).toBeUndefined();
});

test("a done turn folds its steps and what was said between them; the reply, the last thing said, and notices stay (#347)", () => {
    const steps = { kind: "activity" as const };
    const said = (text: string) => ({ kind: "block" as const, block: { t: "text", text } });
    const block = (t: string) => ({ kind: "block" as const, block: { t, text: t } });
    /** What stays in sight once the turn folds: the reply and notices (work and interim text go into "Worked for"). */
    const shown = (items: any[]) =>
        workSegments(items)
            .filter((s) => s.kind === "item" && !s.interim)
            .map((s) => (s as { item: { block: { text: string } } }).item.block.text);
    // A Claude Code turn: narration between its steps, then the conclusion.
    expect(shown([said("Now the edits."), steps, said("Both pass."), steps, said("Confirmed."), steps, said("All merged.")])).toEqual(["All merged."]);
    // No steps: nothing folds, all of it is the reply.
    expect(shown([said("Hello."), said("More.")])).toEqual(["Hello.", "More."]);
    expect(workSegments([said("Hello.")]).some((s) => s.kind === "work")).toBe(false);
    // Ended on a step (a background wait, a stop): the last thing it said stays, a question too.
    expect(shown([said("Looking."), steps, said("Should I merge it?"), steps])).toEqual(["Should I merge it?"]);
    expect(shown([steps])).toEqual([]);
    // A notice (an error) between steps never folds away.
    expect(shown([steps, block("notice"), steps, said("Done.")])).toEqual(["notice", "Done."]);
    // Thinking is work: what was said before a last thought is on the way.
    expect(shown([steps, said("Checking once more."), block("thinking"), said("Done.")])).toEqual(["Done."]);
    // Consecutive steps are one run of work.
    expect(workSegments([steps, block("thinking"), steps, said("Done.")]).map((s) => s.kind)).toEqual(["work", "item"]);
});

test("a glide starts where the content was drawn, continues a running one, and never covers more than 240px", () => {
    expect(glideFrom(30)).toBe(30);
    expect(glideFrom(30, 50)).toBe(80);
    expect(glideFrom(-20)).toBe(-20);
    expect(glideFrom(1000)).toBe(GLIDE_MAX);
    expect(glideFrom(-1000)).toBe(-GLIDE_MAX);
    expect(glideFrom(0.4)).toBeUndefined();
    expect(glideFrom(10, -10)).toBeUndefined();
});

test("a command's output window: its last lines, cleaned; failures red, passes green", () => {
    expect(lastLines("a\nb\nc\nd\n\n", 3)).toEqual(["b", "c", "d"]);
    expect(lastLines("\x1b[32mok\x1b[0m\r\nnext", 3)).toEqual(["ok", "next"]);
    expect(lastLines(undefined, 3)).toEqual([]);
    expect(lineTone("error TS2322: Type 'string'")).toBe("er");
    expect(lineTone("✓ user bubble hugs short text [3ms]")).toBe("ok");
    expect(lineTone(" 14 pass   0 fail")).toBe("ok");
    expect(lineTone(" 13 pass   1 fail")).toBe("er");
    expect(lineTone("FAIL test/a.test.ts")).toBe("er");
    expect(lineTone("failover configured")).toBeUndefined();
    expect(lineTone("no errors found")).toBeUndefined();
    expect(lineTone("bun test v1.3.2")).toBeUndefined();
});
