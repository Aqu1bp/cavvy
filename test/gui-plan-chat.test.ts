// The plan in the conversation (lib/plan-chat.ts): the Steps strip over the
// composer (what its line says, when it goes away) and the plan's card in its
// turn (its title and preview, the state it's in, which card a link belongs to).

import { describe, expect, test } from "bun:test";

const { linkOwner, planBody, planCalls, planState, planTitle, stepsKey, stepsLine, stepsStale } = await import("../gui/src/lib/plan-chat");

type Status = "pending" | "in_progress" | "completed";
const todo = (content: string, status: Status, activeForm?: string) => ({ content, status, activeForm });

describe("the Steps line", () => {
    test("counts what's done and names the step under way, in its -ing form", () => {
        const l = stepsLine([todo("Read the auth module", "completed"), todo("Add the SSO strategy", "in_progress", "Adding the SSO strategy"), todo("Run the tests", "pending")]);
        expect(l).toEqual({ done: 1, total: 3, now: "Adding the SSO strategy", all: false });
    });

    test("without an -ing form, the step's own words", () => {
        expect(stepsLine([todo("Add the SSO strategy", "in_progress")]).now).toBe("Add the SSO strategy");
    });

    test("nothing under way: the next step to do", () => {
        expect(stepsLine([todo("Read", "completed"), todo("Write", "pending"), todo("Test", "pending")]).now).toBe("Write");
    });

    test("every step done: it says so", () => {
        expect(stepsLine([todo("Read", "completed"), todo("Write", "completed")])).toEqual({ done: 2, total: 2, now: "All steps done", all: true });
    });

    test("the key changes with any step's words or status, so a hidden strip comes back", () => {
        const a = stepsKey([todo("Read", "completed"), todo("Write", "in_progress")]);
        expect(stepsKey([todo("Read", "completed"), todo("Write", "in_progress", "Writing")])).toBe(a);
        expect(stepsKey([todo("Read", "completed"), todo("Write", "completed")])).not.toBe(a);
        expect(stepsKey([todo("Read", "completed"), todo("Write more", "in_progress")])).not.toBe(a);
        expect(stepsKey([todo("Read", "completed")])).not.toBe(a);
    });
});

describe("a finished list stays until the next turn", () => {
    const tool = (name: string) => ({ t: "tool", name });
    const text = { t: "text" };
    const done = [todo("Read", "completed"), todo("Write", "completed")];

    test("finished in the last turn: still shown", () => {
        expect(stepsStale(done, [{ blocks: [text] }, { blocks: [tool("TodoWrite"), tool("Read"), text] }])).toBe(false);
    });

    test("a turn has started since: gone", () => {
        expect(stepsStale(done, [{ blocks: [tool("TodoWrite")] }, { blocks: [] }])).toBe(true);
        expect(stepsStale(done, [{ blocks: [tool("TodoWrite")] }, { blocks: [text] }, { blocks: [tool("Read")] }])).toBe(true);
    });

    test("a list still under way never goes, however old", () => {
        expect(stepsStale([todo("Read", "completed"), todo("Write", "pending")], [{ blocks: [tool("TodoWrite")] }, { blocks: [text] }])).toBe(false);
    });

    test("no call to say when it was written (compacted away): kept", () => {
        expect(stepsStale(done, [{ blocks: [text] }, { blocks: [text] }])).toBe(false);
    });
});

describe("the plan card's title and preview", () => {
    test("the title is the plan's first heading, without \"Plan:\"", () => {
        expect(planTitle("## Plan: add SSO\n\n1. Add `SamlProvider`")).toBe("add SSO");
        expect(planTitle("Introduction\n# Plan: Add **SSO**\nSteps")).toBe("Add SSO");
    });

    test("without a heading, its first line", () => {
        expect(planTitle("\nRefactor the parser\n\n- step")).toBe("Refactor the parser");
    });

    test("the preview is the rest of the plan: the title's line isn't repeated", () => {
        expect(planBody("## Plan: add SSO\n\n1. Add it\n2. Test it")).toBe("1. Add it\n2. Test it");
        expect(planBody("Introduction\n# Plan: Add SSO\nSteps")).toBe("Introduction\nSteps");
        expect(planBody("Refactor the parser\n\n- step")).toBe("- step");
        expect(planBody("# Only a title")).toBe("");
    });
});

describe("the plan card's state", () => {
    const tool = (status: string, summary?: string, output?: string) => ({ status, summary, output }) as any;

    test("waiting on the card: needs you", () => {
        expect(planState(tool("awaiting"), false)).toEqual({ label: "Needs you", tone: "wait" });
        // Answered, the call runs on for a moment; while its card is up it still waits.
        expect(planState(tool("running"), true)).toEqual({ label: "Needs you", tone: "wait" });
    });

    test("approved, with the mode it went on in when the result says", () => {
        const out = (label: string) => `The user approved your plan. Plan mode is off (permission mode: ${label}). Start implementing it now.`;
        expect(planState(tool("ok", "Plan approved", out("Accept edits")), false)).toEqual({ label: "Approved · auto-accept edits", tone: "ok" });
        expect(planState(tool("ok", "Plan approved", out("Manual")), false)).toEqual({ label: "Approved · ask for edits", tone: "ok" });
        expect(planState(tool("ok", "Plan approved", out("Auto")), false)).toEqual({ label: "Approved · auto mode", tone: "ok" });
        // Claude Code's result doesn't name the mode.
        expect(planState(tool("ok", undefined, "User has approved your plan. You can now start coding."), false)).toEqual({ label: "Approved", tone: "ok" });
    });

    test("turned down: kept planning", () => {
        expect(planState(tool("error", "Plan rejected", "The user rejected the plan and wants you to keep planning."), false)).toEqual({ label: "Kept planning", tone: "quiet" });
        expect(planState(tool("denied"), false)).toEqual({ label: "Kept planning", tone: "quiet" });
        expect(planState(tool("error", undefined, "The user wants changes to the plan:\nsplit step 2"), false)).toEqual({ label: "Kept planning", tone: "quiet" });
    });

    test("taken to a new worktree", () => {
        expect(planState(tool("error", "Plan handed off to a new session"), false)).toEqual({ label: "Moved to a worktree", tone: "quiet" });
        expect(planState(tool("error", undefined, "The user is carrying out this plan in another session instead. Don't continue it here."), false)).toEqual({ label: "Moved to a worktree", tone: "quiet" });
    });

    test("stopped before it was answered", () => {
        expect(planState(tool("error", "Interrupted"), false)).toEqual({ label: "Stopped", tone: "quiet" });
        expect(planState(tool("error", "Not run"), false)).toEqual({ label: "Stopped", tone: "quiet" });
    });

    test("refused before it reached you: no state", () => {
        expect(planState(tool("error", undefined, "You are not in plan mode; proceed with the task directly."), false)).toBeUndefined();
    });

    test("still on its way to the card: nothing yet", () => {
        expect(planState(tool("running"), false)).toBeUndefined();
        expect(planState(tool("streaming"), false)).toBeUndefined();
    });
});

describe("which plan card a worktree link belongs to", () => {
    const plans = [{ id: "a", at: 100 }, { id: "b", at: 200 }, { id: "c", at: 300 }];

    test("the newest plan presented before the link was made", () => {
        expect(linkOwner(plans, 250)).toBe("b");
        expect(linkOwner(plans, 300)).toBe("c");
        expect(linkOwner(plans, 1000)).toBe("c");
    });

    test("a plan without a time counts as before (older transcripts)", () => {
        expect(linkOwner([{ id: "a" }, { id: "b", at: 500 }], 250)).toBe("a");
        expect(linkOwner([{ id: "a" }, { id: "b" }], 250)).toBe("b");
    });

    test("older than every plan: the first; no plans: none", () => {
        expect(linkOwner(plans, 50)).toBe("a");
        expect(linkOwner([], 50)).toBeUndefined();
    });
});

test("a session's plans are its ExitPlanMode calls, in order", () => {
    const turns = [
        { blocks: [{ t: "text", id: "x" }, { t: "tool", id: "p1", name: "ExitPlanMode", startedAt: 10 }] },
        { blocks: [{ t: "tool", id: "r", name: "Read", startedAt: 20 }] },
        { blocks: [{ t: "tool", id: "p2", name: "ExitPlanMode" }] },
    ];
    expect(planCalls(turns)).toEqual([{ id: "p1", at: 10 }, { id: "p2", at: undefined }]);
});
