import { expect, test } from "bun:test";
import { lastAnswer } from "../gui/src/lib/side-chat";
import { clientAction } from "../gui/src/lib/commands";

// What the side chat's Bring back attaches to the session's message (gui/src/lib/side-chat.ts; the chip itself is in
// attachments.test.ts), and /btw as the GUI reads it.

test("the last answer is the latest turn's last words, not a step's", () => {
    const turn = (blocks: unknown[]) => ({ id: "t", status: "done", blocks }) as any;
    expect(lastAnswer([turn([{ t: "text", id: "a", text: "first" }]), turn([{ t: "text", id: "b", text: "looking" }, { t: "tool", id: "c", name: "Read" }, { t: "text", id: "d", text: "found it" }])])).toBe("found it");
    // A turn that said nothing yet (still working): the one before's.
    expect(lastAnswer([turn([{ t: "text", id: "a", text: "earlier" }]), turn([{ t: "tool", id: "c", name: "Read" }])])).toBe("earlier");
    expect(lastAnswer([])).toBeUndefined();
});

test("/btw opens the side chat with its question", () => {
    expect(clientAction("/btw why that name?")).toEqual({ action: "sidechat", args: "why that name?" });
    expect(clientAction("/btw")).toEqual({ action: "sidechat", args: "" });
});
