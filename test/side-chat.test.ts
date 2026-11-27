// Side chats (src/agent/side-chat.ts): a hidden session that's given its
// parent's conversation, answers about it, and never adds to it; discarded when
// it's closed or its parent is.

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { Engine } = await import("../src/server/engine");
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const { sideChatCut, sideChatDir, withContext } = await import("../src/agent/side-chat");
const { gitArgv, gitEnv } = await import("../src/util/git");
import type { Message } from "../src/providers/types";
import type { ServerEvent, SessionSnapshot } from "../src/server/protocol";

const mock = startMockLlm({ delayMs: 0 });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));

afterAll(() => {
    mock.stop();
    iso.cleanup();
});

async function until(pred: () => boolean, ms = 10_000) {
    const end = Date.now() + ms;
    while (!pred()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(20);
    }
}

async function parentWithTurn(prompt: string | null = "hello there", o: { allowBypass?: boolean } = {}) {
    const engine = new Engine(o);
    const events: ServerEvent[] = [];
    const c = { subs: new Set<string>(), send: (e: ServerEvent) => void events.push(e) };
    engine.clients.add(c as never);
    const cwd = createDemoProject(tempDir("cavvy-side-proj-"), { git: false });
    const snap = (await engine.handle(c as never, "session.create", { cwd })) as SessionSnapshot;
    const id = snap.state.id;
    const rt = engine.runtimes.get(id)!;
    if (prompt !== null) {
        await engine.handle(c as never, "session.send", { id, text: prompt });
        await until(() => rt.idle && rt.session.messageCount >= 2);
    }
    return { engine, c: c as never, events, cwd, id, rt };
}

const lastText = (messages: Message[]) => {
    const m = messages.at(-1);
    return m?.role === "assistant" ? m.content.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("") : "";
};

describe("a side chat", () => {
    test("is given the conversation, answers about it, and adds nothing to it", async () => {
        const { engine, c, events, id, rt } = await parentWithTurn("hello there");
        const before = rt.session.messages.length;
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id, text: "what was my first message?" })) as { id: string };
        const side = engine.runtimes.get(sideId)!;
        await until(() => side.idle && side.session.messageCount >= 2);
        // The model saw the parent's conversation before the question: it knows the first message.
        expect(lastText(side.session.messages)).toContain('Your first message was "hello there"');
        // The parent is as it was.
        expect(rt.session.messages.length).toBe(before);
        expect(JSON.stringify(rt.session.messages)).not.toContain("what was my first message");
        // The side chat has only its own messages; the parent's are shared, not copied.
        expect(side.session.messages[0]!.role).toBe("user");
        expect(side.side!.context.length).toBe(before);
        expect(side.side!.context[0]).toBe(rt.session.messages[0]!);
        // The parent's mode and model, not listed, shown on the parent.
        expect(side.snapshot().state.mode).toBe(rt.mode);
        expect(side.snapshot().state.model?.ref).toBe(rt.snapshot().state.model?.ref);
        expect(side.snapshot().state.sideOf).toBe(id);
        expect(rt.snapshot().state.sideChat?.id).toBe(sideId);
        expect(engine.listSessions().map((s) => s.id)).not.toContain(sideId);
        expect(events.some((e) => e.type === "sessions.upsert" && e.session.id === sideId)).toBe(false);
        expect(existsSync(sideChatDir(sideId))).toBe(true);
        // The model was told what it is with the first question.
        const sent = mock.bodies.at(-1)!.messages as { role: string; content: unknown }[];
        expect(JSON.stringify(sent)).toContain("This is a side chat");

        // Asked again: the same side chat.
        const again = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
        expect(again.id).toBe(sideId);

        // Closed: the parent's tab goes at once; Undo brings it back as it was.
        await engine.handle(c, "session.closeSideChat", { id });
        expect(rt.snapshot().state.sideChat).toBeUndefined();
        expect(await engine.handle(c, "session.reopenSideChat", { id })).toEqual({ id: sideId });
        expect(rt.snapshot().state.sideChat?.id).toBe(sideId);
        expect(side.session.messages.length).toBeGreaterThanOrEqual(2);

        // Closed again and a new one opened: the old one is gone, files and all, and can't come back.
        await engine.handle(c, "session.closeSideChat", { id });
        const fresh = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
        expect(fresh.id).not.toBe(sideId);
        await until(() => !engine.runtimes.has(sideId) && !existsSync(sideChatDir(sideId)));
        await engine.handle(c, "session.closeSideChat", { id });
        await expect(engine.handle(c, "session.reopenSideChat", { id: "nope" })).rejects.toThrow();
    });

    test("closed, it's discarded once Undo's while has passed, and its status no longer reaches the tab", async () => {
        const { engine, c, id, rt } = await parentWithTurn("hello there");
        (engine as unknown as { o: { sideChatUndoMs?: number } }).o.sideChatUndoMs = 150;
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id, text: "pause" })) as { id: string };
        const side = engine.runtimes.get(sideId)!;
        await until(() => side.busy);
        await engine.handle(c, "session.closeSideChat", { id });
        // Stopped as it closed: what that changes doesn't put it back in the tab.
        await until(() => !side.busy);
        expect(rt.snapshot().state.sideChat).toBeUndefined();
        await until(() => !engine.runtimes.has(sideId) && !existsSync(sideChatDir(sideId)));
        expect(rt.snapshot().state.sideChat).toBeUndefined();
        await expect(engine.handle(c, "session.reopenSideChat", { id })).rejects.toThrow("gone");
    });

    test("/btw opens it with the question, at once, even while the session works", async () => {
        const { engine, c, id, rt } = await parentWithTurn("hello there");
        await engine.handle(c, "session.send", { id, text: "pause" });
        await until(() => rt.busy);
        expect(await engine.handle(c, "session.send", { id, text: "/btw what was my first message?" })).toEqual({ queued: false });
        const sideId = rt.snapshot().state.sideChat!.id;
        const side = engine.runtimes.get(sideId)!;
        await until(() => side.idle && side.session.messageCount >= 2);
        expect(lastText(side.session.messages)).toContain('Your first message was "hello there"');
        await until(() => rt.idle);
        // Nothing of it in the parent, nor queued there.
        expect(JSON.stringify(rt.session.messages)).not.toContain("/btw");
        expect(rt.snapshot().state.queued).toEqual([]);
    });

    test("goes when its parent is closed", async () => {
        const { engine, c, id } = await parentWithTurn("hello there");
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
        await engine.handle(c, "session.close", { id: sideId });
        // Still there while the parent is open: its panel shows it again.
        expect(engine.runtimes.has(sideId)).toBe(true);
        await engine.handle(c, "session.close", { id });
        await until(() => !engine.runtimes.has(sideId));
        await until(() => !existsSync(sideChatDir(sideId)));
    });

    test("deleted with its session, it's back with it on Undo, as it was; gone once Undo's while has passed", async () => {
        const { engine, c, id } = await parentWithTurn("hello there");
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id, text: "what was my first message?" })) as { id: string };
        const side = engine.runtimes.get(sideId)!;
        await until(() => side.idle && side.session.messageCount >= 2);
        await engine.handle(c, "session.delete", { id });
        // The window lets go of both: the side chat is kept.
        await engine.handle(c, "session.close", { id: sideId });
        expect(engine.runtimes.get(sideId)).toBe(side);
        await engine.handle(c, "session.restore", { id });
        const back = (await engine.handle(c, "session.open", { id })) as SessionSnapshot;
        expect(back.state.sideChat?.id).toBe(sideId);
        const again = (await engine.handle(c, "session.open", { id: sideId })) as SessionSnapshot;
        expect(again.turns.map((t) => t.prompt?.text)).toEqual(["what was my first message?"]);

        // Deleted again, and not put back in time: discarded.
        (engine as unknown as { o: { sideChatUndoMs?: number } }).o.sideChatUndoMs = 150;
        await engine.handle(c, "session.delete", { id });
        await until(() => !engine.runtimes.has(sideId) && !existsSync(sideChatDir(sideId)));
        await engine.handle(c, "session.restore", { id });
        expect(((await engine.handle(c, "session.open", { id })) as SessionSnapshot).state.sideChat).toBeUndefined();
    });

    test("streams at the pace of a session on screen while its session is the one shown", async () => {
        const { engine, c, id } = await parentWithTurn("hello there");
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
        const client = c as unknown as { subs: Set<string>; shown?: string };
        client.subs.add(sideId);
        client.shown = id;
        expect(engine.sessionShown(sideId)).toBe(true);
        client.shown = "another";
        expect(engine.sessionShown(sideId)).toBe(false);
        await engine.stop();
    });

    test("goes when its parent is archived", async () => {
        const { engine, c, id, rt } = await parentWithTurn("hello there");
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
        await engine.handle(c, "session.archive", { id, archived: true });
        await until(() => !engine.runtimes.has(sideId) && !existsSync(sideChatDir(sideId)));
        expect(rt.snapshot().state.sideChat).toBeUndefined();
    });

    test("doesn't hold its session's worktree when that's archived with it removed: open, or closed for Undo", async () => {
        const git = (cwd: string, ...args: string[]) => {
            const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe", timeout: 5000 });
            if (r.exitCode) throw new Error(r.stderr.toString());
        };
        for (const closed of [false, true]) {
            const main = realpathSync(tempDir("cavvy-side-wt-"));
            writeFileSync(join(main, "README.md"), "base\n");
            git(main, "init", "-q", "-b", "main");
            git(main, "add", ".");
            git(main, "commit", "-qm", "init");
            git(main, "init", "-q", "--bare", `${main}.git`);
            git(main, "remote", "add", "origin", `${main}.git`);
            git(main, "push", "-q", "origin", "main");
            const engine = new Engine({});
            const c = { subs: new Set<string>(), send: () => {} } as never;
            engine.clients.add(c);
            const made = (await engine.handle(c, "projects.createWorktree", { path: main, branch: `side-${closed}` })) as { path: string };
            const id = ((await engine.handle(c, "session.create", { cwd: made.path })) as SessionSnapshot).state.id;
            engine.runtimes.get(id)!.session.push({ role: "user", content: [{ type: "text", text: "hello" }] });
            await engine.handle(c, "session.sideChat", { id });
            if (closed) await engine.handle(c, "session.closeSideChat", { id });
            const r = (await engine.handle(c, "session.archive", { id, archived: true, removeWorktree: true })) as { removed?: boolean; kept?: string };
            expect(r.kept).toBeUndefined();
            expect(r.removed).toBe(true);
            expect(existsSync(made.path)).toBe(false);
            await engine.stop();
        }
    });

    test("of a session with nothing in it yet: a question in its folder", async () => {
        const { engine, c, id, rt } = await parentWithTurn(null);
        expect(rt.session.messageCount).toBe(0);
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id, text: "what was my first message?" })) as { id: string };
        const side = engine.runtimes.get(sideId)!;
        await until(() => side.idle && side.session.messageCount >= 2);
        expect(side.side!.context).toEqual([]);
        expect(lastText(side.session.messages)).toContain('Your first message was "what was my first message?"');
        // Told there's no conversation above, not that there is.
        const sent = JSON.stringify(mock.bodies.at(-1)!.messages);
        expect(sent).toContain("a session that hasn't started yet");
        expect(sent).not.toContain("the conversation above");
        expect(rt.session.messageCount).toBe(0);
        // /btw there opens it the same way.
        await engine.handle(c, "session.closeSideChat", { id });
        expect(await engine.handle(c, "session.send", { id, text: "/btw why?" })).toEqual({ queued: false });
        expect(rt.snapshot().state.sideChat?.id).toBeString();
        expect(rt.session.messageCount).toBe(0);
        // Without a question: none is opened (the window shows the tab, which asks for one), and nothing is sent.
        await engine.handle(c, "session.closeSideChat", { id });
        expect(await engine.handle(c, "session.send", { id, text: "/btw" })).toEqual({ queued: false });
        expect(rt.snapshot().state.sideChat).toBeUndefined();
        expect(rt.session.messageCount).toBe(0);
    });

    for (const mode of ["default", "acceptEdits", "auto", "bypassPermissions", "plan"] as const) {
        test(`starts in the session's mode: ${mode}`, async () => {
            const { engine, c, id, rt } = await parentWithTurn("hello there", { allowBypass: true });
            await engine.handle(c, "session.setMode", { id, mode });
            const { id: sideId } = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
            expect(engine.runtimes.get(sideId)!.snapshot().state.mode).toBe(mode);
            expect(rt.mode).toBe(mode);
        });
    }

    test("then keeps its own: the session's changes don't reach it, nor its the session", async () => {
        const { engine, c, id, rt } = await parentWithTurn();
        await engine.handle(c, "session.setMode", { id, mode: "acceptEdits" });
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
        const side = engine.runtimes.get(sideId)!;
        await engine.handle(c, "session.setMode", { id, mode: "plan" });
        expect(side.mode).toBe("acceptEdits");
        await engine.handle(c, "session.setMode", { id: sideId, mode: "default" });
        expect(rt.mode).toBe("plan");
        expect(side.mode).toBe("default");
    });

    test("is never Bypass where Bypass isn't allowed", async () => {
        const { engine, c, id, rt } = await parentWithTurn();
        // Left in Bypass when it was allowed; it isn't now.
        rt.mode = "bypassPermissions";
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
        expect(engine.runtimes.get(sideId)!.mode).toBe("default");
        await expect(engine.handle(c, "session.setMode", { id: sideId, mode: "bypassPermissions" })).rejects.toThrow(/Bypass mode is off/);
    });

    test("edits in the session's folder as its mode says: asked in Manual, made in Accept edits", async () => {
        const { engine, c, id, cwd } = await parentWithTurn();
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id, text: "writenote" })) as { id: string };
        const side = engine.runtimes.get(sideId)!;
        await until(() => side.snapshot().state.status === "waiting");
        expect(existsSync(join(cwd, "SIDE-NOTE.md"))).toBe(false);
        side.interrupt();
        await until(() => side.idle);
        await engine.handle(c, "session.closeSideChat", { id });
        await engine.handle(c, "session.setMode", { id, mode: "acceptEdits" });
        const { id: next } = (await engine.handle(c, "session.sideChat", { id, text: "writenote" })) as { id: string };
        const edits = engine.runtimes.get(next)!;
        await until(() => edits.idle && edits.session.messageCount >= 4);
        expect(lastText(edits.session.messages)).toContain("Wrote `SIDE-NOTE.md`");
        expect(existsSync(join(cwd, "SIDE-NOTE.md"))).toBe(true);
    });

    test("a side chat has none of its own", async () => {
        const { engine, c, id } = await parentWithTurn("hello there");
        const { id: sideId } = (await engine.handle(c, "session.sideChat", { id })) as { id: string };
        await expect(engine.handle(c, "session.sideChat", { id: sideId })).rejects.toThrow(/side chat of its own/);
    });
});

describe("what it's given", () => {
    const user = (text: string): Message => ({ role: "user", content: [{ type: "text", text }] });
    const assistant = (calls: number): Message => ({ role: "assistant", content: [{ type: "text", text: "ok" }, ...Array.from({ length: calls }, (_, i) => ({ type: "tool_call" as const, id: `c${i}`, name: "Read", input: {} }))] });
    test("all of a finished conversation; a reply whose tools still run is left out", () => {
        expect(sideChatCut([user("a"), assistant(0)])).toBe(2);
        expect(sideChatCut([user("a"), assistant(1)])).toBe(1);
        expect(sideChatCut([user("a"), assistant(1), { role: "user", content: [{ type: "tool_result", toolCallId: "c0", toolName: "Read", content: "x" }] }])).toBe(3);
        expect(sideChatCut([])).toBe(0);
    });
    test("its own messages after the parent's, the same objects", () => {
        const ctx = [user("a"), assistant(0)];
        const own = [user("b")];
        const all = withContext(ctx, own);
        expect(all.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
        expect(all[0]).toBe(ctx[0]!);
        expect(withContext(undefined, own)).toBe(own);
    });
});
