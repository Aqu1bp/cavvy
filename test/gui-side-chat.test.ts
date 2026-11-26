import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { lastAnswer, sideChatMoved } from "../gui/src/lib/side-chat";
import { clientAction } from "../gui/src/lib/commands";
import { app, rpc, setApp, setToasts, toasts } from "../gui/src/state/app";
import { send } from "../gui/src/state/actions";
import { inspectorPane, setInspectorPane } from "../gui/src/state/ui";

// What the side chat's Bring back attaches to the session's message (gui/src/lib/side-chat.ts; the chip itself is in
// attachments.test.ts), and /btw as the GUI reads it.

test("the last answer is the latest turn's last words, not a step's", () => {
    const turn = (blocks: unknown[]) => ({ id: "t", status: "done", blocks }) as any;
    expect(lastAnswer([turn([{ t: "text", id: "a", text: "first" }]), turn([{ t: "text", id: "b", text: "looking" }, { t: "tool", id: "c", name: "Read" }, { t: "text", id: "d", text: "found it" }])])).toBe("found it");
    // A turn that said nothing yet (still working): the one before's.
    expect(lastAnswer([turn([{ t: "text", id: "a", text: "earlier" }]), turn([{ t: "tool", id: "c", name: "Read" }])])).toBe("earlier");
    expect(lastAnswer([])).toBeUndefined();
    // A turn still running (its words so far, or waiting on a card): the finished one before's.
    expect(lastAnswer([turn([{ t: "text", id: "a", text: "earlier" }]), { id: "t2", status: "running", blocks: [{ t: "text", id: "b", text: "Writing it." }] } as any])).toBe("earlier");
    expect(lastAnswer([{ id: "t", status: "running", blocks: [{ t: "text", id: "b", text: "Writing it." }] } as any])).toBeUndefined();
});

test("/btw opens the side chat with its question", () => {
    expect(clientAction("/btw why that name?")).toEqual({ action: "sidechat", args: "why that name?" });
    expect(clientAction("/btw")).toEqual({ action: "sidechat", args: "" });
});

describe("/btw on Home, with no session yet", () => {
    const original = { activeId: app.activeId, homeCwd: app.homeCwd };
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    // Toasts look at whether the page is hidden.
    beforeEach(() => Object.defineProperty(globalThis, "document", { configurable: true, value: { hidden: false } }));
    afterEach(() => {
        if (originalDocument) Object.defineProperty(globalThis, "document", originalDocument);
        else delete (globalThis as { document?: unknown }).document;
        setApp({ activeId: original.activeId, homeCwd: original.homeCwd });
        setInspectorPane(undefined);
        // The store is the app's, shared with the other test files run in the same process (test/gui-toast-store.test.ts).
        setToasts([]);
    });
    const snapshot = (id: string) => ({ state: { id, cwd: "/work/app", projectName: "app", busy: false, status: "idle" }, turns: [], agents: [], seq: 0, epoch: 1 });

    test("a question opens a new session, asked in its side chat, which is shown", async () => {
        setApp({ activeId: undefined, homeCwd: "/work/app" });
        const call = spyOn(rpc, "call").mockImplementation((async (method: string) => (method === "session.create" ? snapshot("fresh") : method === "commands.list" ? [] : { queued: false })) as never);
        try {
            expect(await send("/btw what's in here?")).toBe(true);
            expect(call.mock.calls.map((c) => c[0])).toEqual(["commands.list", "session.create", "session.send"]);
            // The server opens the side chat with it (test/side-chat.test.ts): nothing of it is added to the session.
            expect(call).toHaveBeenLastCalledWith("session.send", expect.objectContaining({ id: "fresh", text: "/btw what's in here?" }));
            expect(app.activeId).toBe("fresh");
            expect(inspectorPane()).toBe("sidechat");
        } finally {
            call.mockRestore();
        }
    });

    test("without a question, the same: the new session's Side chat tab is shown, asking for one", async () => {
        setApp({ activeId: undefined, homeCwd: "/work/app" });
        const call = spyOn(rpc, "call").mockImplementation((async (method: string) => (method === "session.create" ? snapshot("fresh3") : method === "commands.list" ? [] : { queued: false })) as never);
        try {
            expect(await send("/btw")).toBe(true);
            expect(call).toHaveBeenLastCalledWith("session.send", expect.objectContaining({ id: "fresh3", text: "/btw" }));
            expect(app.activeId).toBe("fresh3");
            expect(inspectorPane()).toBe("sidechat");
        } finally {
            call.mockRestore();
        }
    });

    test("if it can't be asked, Home stays and the box keeps the question", async () => {
        setApp({ activeId: undefined, homeCwd: "/work/app" });
        const call = spyOn(rpc, "call").mockImplementation((async (method: string) => {
            if (method === "session.create") return snapshot("fresh2");
            if (method === "commands.list") return [];
            throw new Error("Disconnected");
        }) as never);
        try {
            expect(await send("/btw why?")).toBe(false);
            expect(app.activeId).toBeUndefined();
            expect(toasts.map((t) => t.message)).toEqual(["Disconnected"]);
        } finally {
            call.mockRestore();
        }
    });
});

test("the session's views of its changes are read again as the side chat's edits land and its turns end", () => {
    expect(sideChatMoved(undefined, [0, false])).toBe(false);
    expect(sideChatMoved([undefined, false], [0, false])).toBe(false);
    expect(sideChatMoved([0, true], [1, true])).toBe(true);
    expect(sideChatMoved([1, true], [1, false])).toBe(true);
    expect(sideChatMoved([1, false], [1, true])).toBe(false);
    expect(sideChatMoved([1, false], [1, false])).toBe(false);
});
