// Account switch notices in the GUI server's Runtime (#426): what a switch's restart stopped, said after a message
// came, never says that switch again; and a run of switches is one line live as on reopening, whatever was shown
// between them that isn't kept. With the fake Codex (test/helpers/switch-app.ts).

import { expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";
import { until, switchKit } from "./helpers/switch-app";

const iso = isolate();
const { account, withApp } = await switchKit(iso);

const switchLines = (turns: any[]) => turns.flatMap((t) => t.blocks.filter((b: any) => b.t === "notice" && b.account).map((b: any) => b.account.name as string));
const texts = (turns: any[]) => turns.flatMap((t) => t.blocks.filter((b: any) => b.t === "text").map((b: any) => b.text as string));
/** The text shown from the turn of `prompt` on. */
const after = (turns: any[], prompt: string) => texts(turns.slice(turns.findIndex((t) => t.prompt?.text === prompt)));

test("a switch's restart that ends after the next switch and a prompt says what it stopped on a line of its own: no switch back, live or reopened, and the reply once", async () => {
    const a = account("codex", "shared");
    const b = account("codex", "shared");
    await withApp("codex", true, async (h) => {
        expect((await h.send("first")).status).toBe("done");
        const agent = h.rt.agent!;
        const release = agent.releaseAccountProcess.bind(agent);
        let open!: () => void;
        const gate = new Promise<void>((r) => (open = r));
        let calls = 0;
        // The switch to A's release is held, and stops a task; B's finds nothing left to let go of.
        agent.releaseAccountProcess = async (p: string) => {
            const first = ++calls === 1;
            const stopped = await release(p);
            if (!first) return stopped;
            await gate;
            return [{ label: "sleep 30", command: "sleep 30 && echo done" }];
        };
        const toA = h.rt.setAccount("codex", a.id);
        await until(() => calls === 1);
        await h.rt.setAccount("codex", b.id);
        expect((await h.send("go on")).status).toBe("done");
        open();
        await toA;
        const live = h.turns();
        expect(switchLines(live)).toEqual([b.name]);
        const stoppedLine = live.flatMap((t: any) => t.blocks).filter((x: any) => x.t === "notice" && x.stopped);
        expect(stoppedLine).toEqual([{ t: "notice", id: expect.any(String), level: "info", text: "Stopped: sleep 30", stopped: { provider: "codex", cli: "Codex", tasks: [{ label: "sleep 30", command: "sleep 30 && echo done" }] } }]);
        // The reply, once: in the prompt's turn, nothing of it after.
        const reply = after(live, "go on");
        expect(reply).toEqual(["Running it.", "Finished."]);
        await h.reopen();
        const back = h.turns();
        expect(switchLines(back)).toEqual([b.name]);
        // The prompt's turn isn't split by it: its reply shows once.
        expect(after(back, "go on")).toEqual(reply);
        expect(back.filter((t: any) => t.prompt?.text === "go on")).toHaveLength(1);
        // The tasks said once, on their line (live a line after the turn, reopened its end, as any notice after one).
        expect(back.flatMap((t: any) => t.blocks).filter((x: any) => x.t === "notice" && x.stopped).map((x: any) => x.text)).toEqual(["Stopped: sleep 30"]);
    });
}, 30_000);

test("a notice that isn't kept between two switches doesn't split them live: one line, as on reopening", async () => {
    const a = account("codex", "shared");
    const b = account("codex", "shared");
    await withApp("codex", true, async (h) => {
        expect((await h.send("first")).status).toBe("done");
        await h.rt.setAccount("codex", a.id);
        // As /goal's status says it: shown, not kept.
        h.rt.notice("No goal set. /goal <condition> keeps working, turn after turn, until the condition holds.");
        await h.rt.setAccount("codex", b.id);
        const live = switchLines(h.turns());
        await h.reopen();
        expect({ live, back: switchLines(h.turns()) }).toEqual({ live: [b.name], back: [b.name] });
    });
}, 30_000);
