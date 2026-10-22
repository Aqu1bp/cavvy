// The TUI's messages sent while a turn runs: each steers the turn (joins at
// its next step) or waits for its end, by the followUpBehavior setting or, with
// Tab, the other way; /queue sends one now, reorders and removes; the queue is
// saved beside the transcript and comes back into the prompt on resume.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "fs";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup } = isolate();
const { App } = await import("../src/ui/app");
const { Session } = await import("../src/agent/session");
const { runCommand } = await import("../src/commands/index");
const { queueFile, loadQueue, saveQueue } = await import("../src/agent/queue-store");

afterAll(() => cleanup());

function testApp(o: { persist?: boolean; settings?: Record<string, unknown> } = {}) {
    const cwd = tempDir();
    const app = new App({ cwd, trusted: true, mode: "default", allowBypass: false, startupNotes: [] });
    const printed: string[] = [];
    const print = (l: string | string[] | ((cols: number) => string[])) => (printed.push(...(typeof l === "function" ? l(100) : Array.isArray(l) ? l : [l])), {});
    (app as any).screen = { print, replace() {}, redraw() {}, setLive() {}, settle() {}, flushNow() {}, stop() {}, clearScreen() {} };
    (app as any).renderLive = () => {};
    app.session = Session.create(cwd, { persist: o.persist ?? false });
    app.session.setSystem("test system prompt");
    Object.assign(app.settings, o.settings ?? {});
    return { app, printed };
}

/** An agent whose turn runs until `end()`; `nudges` counts the times it was told of a message to steer with. */
function workingAgent(app: InstanceType<typeof App>) {
    const runs: string[] = [];
    let end = () => {};
    const agent = {
        nudges: 0,
        queueChanged() {
            agent.nudges++;
        },
        run: async (parts: any[], o: any) => {
            runs.push(parts[0].text);
            await new Promise<void>((r) => {
                end = r;
                o.signal.addEventListener("abort", () => r());
            });
        },
    };
    app.agent = agent as any;
    return { agent, runs, end: () => end() };
}

const queued = (app: InstanceType<typeof App>) => (app as any).queued.map((d: { text: string; mode: string }) => [d.text, d.mode]);
const drain = (app: InstanceType<typeof App>): string[] => (app as any).drainQueued();
const image = (name: string) => ({ name, bytes: 1, part: { type: "image" as const, mediaType: "image/png", data: "AA==" } });

describe("steer or queue", () => {
    test("by default a message steers: the running turn is told, and takes it at its next step", async () => {
        const { app } = testApp();
        const { agent, end } = workingAgent(app);
        const turn = app.submitText("first");
        await Bun.sleep(10);
        await app.submitText("also this");
        expect(queued(app)).toEqual([["also this", "steer"]]);
        expect(agent.nudges).toBe(1);
        expect(drain(app)).toEqual(["also this"]);
        expect(queued(app)).toEqual([]);
        end();
        await turn;
    });

    // #222: their UserPromptSubmit hooks (the agent's admit) run while they're still queued.
    test("one its hooks block comes back to the prompt, unprinted; the rest join the turn", async () => {
        const { app, printed } = testApp();
        const { end } = workingAgent(app);
        const turn = app.submitText("first");
        await Bun.sleep(10);
        await app.submitText("say forbidden things");
        await app.submitText("a fine one");
        const queuedMeanwhile: string[][] = [];
        const admit = async (text: string) => (queuedMeanwhile.push(queued(app).map(([t]: string[]) => t)), text.includes("forbidden") ? "blocked" : "go");
        expect(await (app as any).drainQueued(admit)).toEqual(["a fine one"]);
        expect(queuedMeanwhile).toEqual([["say forbidden things", "a fine one"], ["say forbidden things", "a fine one"]]);
        expect(queued(app)).toEqual([]);
        expect(app.editor.text).toBe("say forbidden things");
        expect(printed.join("\n")).toContain("a fine one");
        expect(printed.join("\n")).not.toContain("say forbidden things");
        end();
        await turn;
    });

    test("one its hooks block with something typed since goes to history instead, and the user is told; stopped meanwhile, they stay queued", async () => {
        const { app, printed } = testApp();
        const { end } = workingAgent(app);
        const turn = app.submitText("first");
        await Bun.sleep(10);
        await app.submitText("say forbidden things");
        expect(await (app as any).drainQueued(async () => "stopped")).toEqual([]);
        expect(queued(app)).toEqual([["say forbidden things", "steer"]]);
        app.editor.set("half typed");
        expect(await (app as any).drainQueued(async () => "blocked")).toEqual([]);
        expect(queued(app)).toEqual([]);
        expect(app.editor.text).toBe("half typed");
        expect(printed.join("\n")).toContain("the blocked message is in history (↑)");
        app.editor.clear();
        (app as any).handleEditorKey({ name: "up" });
        expect(app.editor.text).toBe("say forbidden things");
        end();
        await turn;
    });

    test("with followUpBehavior queue it waits for the turn's end, then runs as a turn of its own", async () => {
        const { app } = testApp({ settings: { followUpBehavior: "queue" } });
        const { agent, runs, end } = workingAgent(app);
        const turn = app.submitText("first");
        await Bun.sleep(10);
        await app.submitText("after it");
        expect(queued(app)).toEqual([["after it", "queue"]]);
        expect(agent.nudges).toBe(0);
        expect(drain(app)).toEqual([]);
        end();
        await Bun.sleep(20);
        expect(runs).toEqual(["first", "after it"]);
        end();
        await turn;
    });

    test("tab sends it the other way; enter as the setting says; idle, tab does nothing", async () => {
        const { app } = testApp();
        const { end } = workingAgent(app);
        app.editor.set("idle text");
        (app as any).handleEditorKey({ name: "tab" });
        expect(app.editor.text).toBe("idle text");
        app.editor.set("");
        const turn = app.submitText("first");
        await Bun.sleep(10);
        app.editor.set("wait for it");
        (app as any).handleEditorKey({ name: "tab" });
        await Bun.sleep(10);
        app.editor.set("steer now");
        (app as any).handleEditorKey({ name: "enter" });
        await Bun.sleep(10);
        expect(queued(app)).toEqual([["wait for it", "queue"], ["steer now", "steer"]]);
        // The steering one jumps the one waiting for the end.
        expect(drain(app)).toEqual(["steer now"]);
        expect(queued(app)).toEqual([["wait for it", "queue"]]);
        end();
        await Bun.sleep(20);
        end();
        await turn;
    });

    test("commands and messages with images can't steer: they wait, and the status says so", async () => {
        const { app } = testApp();
        const { agent, end } = workingAgent(app);
        const turn = app.submitText("first");
        await Bun.sleep(10);
        await app.submitText("/review");
        app.editor.attachImage(image("a.png"));
        await app.submitText(app.editor.capture());
        app.editor.clear();
        expect(agent.nudges).toBe(0);
        expect(drain(app)).toEqual([]);
        const status = (app as any).renderActivity(100, 40).status.map((l: string) => l.replace(/\x1b\[[0-9;]*m/g, "")).join("\n");
        expect(status).toContain("⏵ queued: /review");
        expect(status).toContain("⏵ queued: [Image #1]");
        expect(status).toContain("/queue to send now");
        (app as any).interrupt();
        end();
        await turn;
    });
});

describe("a message with an image waiting for the turn's end", () => {
    test("doesn't hold back a steer sent after it", async () => {
        const { app } = testApp();
        const { agent, end } = workingAgent(app);
        const turn = app.submitText("first");
        await Bun.sleep(10);
        app.editor.attachImage(image("a.png"));
        await app.submitText(app.editor.capture());
        app.editor.clear();
        await app.submitText("steer past it");
        expect(agent.nudges).toBe(1);
        expect(drain(app)).toEqual(["steer past it"]);
        expect(queued(app).map((q: string[]) => q[0].replace(/[\u{100000}-\u{10fffd}]/gu, ""))).toEqual(["[Image #1]"]);
        (app as any).interrupt();
        end();
        await turn;
    });
});

describe("/queue", () => {
    test("send now steers a waiting message; one with an image can't; shift+↑↓ reorders; x removes; e takes it back", async () => {
        const { app } = testApp({ settings: { followUpBehavior: "queue" } });
        const { agent, end } = workingAgent(app);
        const turn = app.submitText("first");
        await Bun.sleep(10);
        for (const t of ["one", "two", "three"]) await app.submitText(t);
        const shown = runCommand(app, "/queue");
        await Bun.sleep(10);
        const d = (app as any).dialogs[0];
        const key = (k: Record<string, unknown>) => d.onKey({ ctrl: false, meta: false, shift: false, ...k });
        expect(d.list.items.map((i: { label: string }) => i.label)).toEqual(["one", "two", "three"]);
        // "one" down a place, then sent now.
        key({ name: "down", shift: true });
        expect(queued(app).map((q: string[]) => q[0])).toEqual(["two", "one", "three"]);
        expect(d.list.current().label).toBe("one");
        key({ name: "enter" });
        expect(queued(app)).toEqual([["two", "queue"], ["one", "steer"], ["three", "queue"]]);
        expect(agent.nudges).toBe(1);
        expect(drain(app)).toEqual(["one"]);
        // Its row is gone the next time the list is touched: say so rather than act on another.
        key({ name: "text", text: "x" });
        expect(d.header[0]).toContain("already been sent");
        expect(d.list.items.map((i: { label: string }) => i.label)).toEqual(["two", "three"]);
        d.list.index = 1;
        key({ name: "text", text: "x" });
        expect(queued(app)).toEqual([["two", "queue"]]);
        key({ name: "text", text: "e" });
        await shown;
        expect(queued(app)).toEqual([]);
        expect(app.editor.text).toBe("two");
        (app as any).interrupt();
        end();
        await turn;
    });

    test("nothing queued: it says where messages go", async () => {
        const { app, printed } = testApp();
        await runCommand(app, "/queue");
        expect(printed.join("\n")).toContain("Nothing is queued");
    });
});

describe("a queue that outlives the TUI", () => {
    test("saved as it changes, with images; an interrupt hands it back and removes the file", async () => {
        const { app } = testApp({ persist: true, settings: { followUpBehavior: "queue" } });
        const { end } = workingAgent(app);
        const turn = app.submitText("first");
        await Bun.sleep(10);
        await app.submitText("later");
        app.editor.insert("see ");
        app.editor.attachImage(image("a.png"));
        await app.submitText(app.editor.capture());
        app.editor.clear();
        const file = queueFile(app.session.path, app.session.meta.id);
        const saved = JSON.parse(readFileSync(file, "utf-8"));
        expect(saved.items).toEqual([
            { text: "later", mode: "queue" },
            { text: "see [Image #1]", mode: "queue", attachments: [{ type: "image", mediaType: "image/png", data: "AA==" }] },
        ]);
        (app as any).interrupt();
        end();
        await turn;
        expect(existsSync(file)).toBe(false);
    });

    test("resumed, what was waiting comes back into the prompt (images too, ahead of nothing lost) and the file goes", async () => {
        const { app: before } = testApp({ persist: true });
        before.session.push({ role: "user", content: [{ type: "text", text: "hello" }], meta: { kind: "prompt" } });
        const path = before.session.path;
        saveQueue(path, before.session.meta.id, [
            { text: "steer this", mode: "steer" },
            { text: "look at [Image #3]", mode: "queue", attachments: [{ type: "image", mediaType: "image/png", data: "AA==" }] },
        ]);
        before.session.release();
        const { app, printed } = testApp();
        app.editor.set("typed");
        app.resume(path);
        const draft = app.editor.capture();
        // The image is attached again under a fresh number.
        expect(app.editor.text.replace(/[\u{100000}-\u{10fffd}]/gu, "")).toBe("typed\nsteer this\nlook at [Image #1]");
        expect([...draft.attachments.values()].map((a) => a.image?.part.data)).toEqual(["AA=="]);
        expect(printed.join("\n")).toContain("2 messages that were waiting when Harness closed are back in the prompt.");
        expect(loadQueue(path, app.session.meta.id)).toEqual([]);
        expect(existsSync(queueFile(path, app.session.meta.id))).toBe(false);
    });

    test("resumed in the terminal, a message with a file (which it can't attach) stays saved for the app, through later saves too", async () => {
        const { app: before } = testApp({ persist: true });
        before.session.push({ role: "user", content: [{ type: "text", text: "hello" }], meta: { kind: "prompt" } });
        const path = before.session.path;
        const pdf = { type: "file" as const, kind: "pdf", name: "report.pdf", mediaType: "application/pdf", data: "JVBE" } as any;
        saveQueue(path, before.session.meta.id, [
            { text: "plain one", mode: "queue" },
            { text: "read this", mode: "queue", attachments: [pdf] },
        ]);
        before.session.release();
        const { app, printed } = testApp({ settings: { followUpBehavior: "queue" } });
        app.resume(path);
        expect(app.editor.text).toBe("plain one");
        expect(printed.join(" ").replace(/\s+/g, " ")).toContain("One with a file is still saved: open this session in the app to send it.");
        expect(loadQueue(path, app.session.meta.id)).toEqual([{ text: "read this", mode: "queue", attachments: [pdf] }]);
        // Something queued in the terminal is saved beside it, not over it.
        app.editor.set("");
        const { end } = workingAgent(app);
        const turn = app.submitText("go");
        await Bun.sleep(10);
        await app.submitText("later");
        expect(loadQueue(path, app.session.meta.id).map((q) => q.text)).toEqual(["later", "read this"]);
        (app as any).interrupt();
        end();
        await turn;
        expect(loadQueue(path, app.session.meta.id).map((q) => q.text)).toEqual(["read this"]);
    });

    test("resumed in the terminal, an image the app queued (no [Image #k] in its text) comes back attached", () => {
        const { app: before } = testApp({ persist: true });
        before.session.push({ role: "user", content: [{ type: "text", text: "hello" }], meta: { kind: "prompt" } });
        const path = before.session.path;
        saveQueue(path, before.session.meta.id, [{ text: "with a picture", mode: "queue", attachments: [{ type: "image", mediaType: "image/png", data: "AA==" }] }]);
        before.session.release();
        const { app } = testApp();
        app.resume(path);
        const draft = app.editor.capture();
        expect(app.editor.text.replace(/[\u{100000}-\u{10fffd}]/gu, "")).toBe("with a picture [Image #1]");
        expect([...draft.attachments.values()].map((a) => a.image?.part.data)).toEqual(["AA=="]);
        expect(existsSync(queueFile(path, app.session.meta.id))).toBe(false);
    });

    test("a torn or foreign queue file is ignored", () => {
        const { app } = testApp({ persist: true });
        const path = app.session.path;
        const file = queueFile(path, app.session.meta.id);
        saveQueue(path, app.session.meta.id, [{ text: "ok", mode: "steer" }]);
        Bun.write(file, "{not json");
        expect(loadQueue(path, app.session.meta.id)).toEqual([]);
    });
});
