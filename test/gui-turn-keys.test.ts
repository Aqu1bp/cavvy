// The place read in a session, found again after the server let the session go and read it in anew: the real server
// and replay, on the mock model (scripts/mock-llm.ts), with a permission prompt answered and a /goal's notices in it.
// Turn ids are numbered anew then; the GUI finds its turns by their keys (gui/src/lib/transcript-scroll.ts).

import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";
import { keyed, keyedTurn, placedAgain, placeBefore, turnKey } from "../gui/src/lib/transcript-scroll";

const iso = isolate();
const { startMockLlm } = await import("../scripts/mock-llm");
const { createDemoProject } = await import("../scripts/demo-project");
const mock = startMockLlm({ delayMs: 0 });
mkdirSync(iso.home, { recursive: true });
writeFileSync(join(iso.home, "providers.json"), JSON.stringify({ custom: [{ id: "mock", name: "Mock", baseUrl: mock.url, requiresKey: false }] }));
writeFileSync(join(iso.home, "settings.json"), JSON.stringify({ model: "mock:mock-opus", smallModel: "mock:mock-haiku" }));
const { Engine } = await import("../src/server/engine");
type Turn = import("../src/server/protocol").Turn;

afterAll(() => {
    mock.stop();
    iso.cleanup();
});

async function until(what: () => boolean, ms = 20_000) {
    const end = Date.now() + ms;
    while (!what()) {
        if (Date.now() > end) throw new Error("timed out");
        await Bun.sleep(10);
    }
}

test("the turn read is found again after the session is read in anew, its id another turn's now", async () => {
    const engine = new Engine({ listModels: async () => [] });
    const client = { subs: new Set<string>(), send() {} };
    engine.clients.add(client as any);
    try {
        const cwd = realpathSync(createDemoProject(tempDir("turn-keys-"), { git: false }));
        const snap = (await engine.handle(client as any, "session.create", { cwd })) as { state: { id: string } };
        const id = snap.state.id;
        const rt = engine.runtimes.get(id)!;
        // Each permission prompt answered Yes as it comes.
        let asked = 0;
        const answer = setInterval(() => {
            for (const it of rt.view.state.interactions ?? []) {
                asked++;
                rt.respond(it.id, { kind: "permission", choice: "yes" } as any);
            }
        }, 10);
        try {
            for (const text of ["hello there", "demo the sso fix", "/goal goaldemo: the auth tests pass", "hello again", "what was my first message"]) {
                await engine.handle(client as any, "session.send", { id, text });
                await Bun.sleep(20);
                await until(() => rt.idle && !rt.busy && !rt.goal.active);
            }
        } finally {
            clearInterval(answer);
        }
        expect(asked).toBeGreaterThan(0);
        const live = rt.snapshot().turns;
        // A turn of notices only, between the goal's turns (read in anew, they go with the turn before).
        const notices = live.findIndex((t) => !t.prompt && t.blocks.every((b) => b.t === "notice"));
        expect(notices).toBeGreaterThan(0);

        // The window lets it go, the server unloads it, and it's opened again with only the last turn.
        await engine.handle(client as any, "session.close", { id });
        await (engine as any).closing.get(id);
        expect(engine.runtimes.has(id)).toBe(false);
        const again = (await engine.handle(client as any, "session.open", { id, last: 1 })) as { turns: Turn[]; earlier?: number };
        expect(again.earlier).toBeGreaterThan(0);
        const all = (await engine.handle(client as any, "session.turns", { id, before: again.turns[0]!.id, all: true })) as { turns: Turn[] };
        const reread = [...all.turns, ...again.turns];

        // Numbered anew: an id the window had names another turn now (the bug), or none.
        const moved = live.filter((t) => t.prompt).find((t) => {
            const now = reread.find((r) => r.id === t.id);
            return now?.prompt?.text !== t.prompt!.text;
        });
        expect(moved).toBeDefined();

        // Each turn with a prompt is found again by its key: the same prompt, started at the same time.
        for (let i = 0; i < live.length; i++) {
            const t = live[i]!;
            const found = keyedTurn(reread, turnKey(live, i));
            if (i === notices) expect(found).toBeUndefined();
            else if (t.prompt) {
                expect(found?.prompt?.text).toBe(t.prompt.text);
                expect(found?.startedAt).toBe(t.startedAt!);
            }
        }
        // The notices' turn is gone: the session opens at its end, not on whichever turn has its id now.
        const atNotices = placedAgain(reread, keyed(live, { bottom: false, top: 400, anchor: { turnId: live[notices]!.id, offset: -10 }, openWork: [] }));
        expect(atNotices.bottom).toBe(true);
        expect(atNotices.anchor).toBeUndefined();

        // Read at the goal's first turn, which the reopened session didn't come with: one request brings the turns back
        // to it (session.turns `through` its place), and it's there, under its new id.
        const goal = live.findIndex((t) => t.prompt?.text.startsWith("/goal goaldemo"));
        const key = turnKey(live, goal);
        expect(placeBefore(key.near!, again.turns.find((t) => t.pos)!.pos!)).toBe(true);
        const page = (await engine.handle(client as any, "session.turns", { id, before: again.turns[0]!.id, through: key.near, count: 1 })) as { turns: Turn[] };
        const back = [...page.turns, ...again.turns];
        const goalAgain = keyedTurn(back, key);
        expect(goalAgain?.prompt?.text).toBe(live[goal]!.prompt!.text);
        // No more than the turns down from it.
        expect(back[0]).toBe(goalAgain!);
        const placed = placedAgain(back, keyed(live, { bottom: false, top: 400, anchor: { turnId: live[goal]!.id, offset: -10 }, openWork: [live[goal]!.id] }));
        expect(placed).toMatchObject({ bottom: false, anchor: { turnId: goalAgain!.id, offset: -10 }, openWork: [goalAgain!.id] });
    } finally {
        await engine.stop();
    }
}, 60_000);
