// Sessions on the user's other machines (src/server/far-peers.ts): how each machine names the others' sessions, what
// a message carries back, and a server asking through the user's computer.

import { expect, test } from "bun:test";
import { isolate } from "./helpers/isolate";

isolate();
const { answerPeers, HOME_NAME, homeFarPeers, serverFarPeers } = await import("../src/server/far-peers");
const { PeerError } = await import("../src/agent/peers");
type Ops = Parameters<typeof answerPeers>[3];

const row = (id: string, updatedAt: number, title = id) => ({ id, title, cwd: `/srv/${id}`, status: "idle" as const, updatedAt });

/** One machine's own sessions: what it was asked, and the sessions it has. */
function machine(rows: ReturnType<typeof row>[]) {
    const sent: { id: string; text: string; from: { id: string; title: string; mode: string } }[] = [];
    const ops: Ops = {
        list: ({ query, limit }) => rows.filter((r) => !query || r.title.includes(query)).slice(0, limit),
        read: (id) => (rows.some((r) => r.id === id) ? { text: `turns of ${id}`, title: id, turns: 1 } : undefined),
        send: async (id, text, from) => {
            if (!rows.some((r) => r.id === id)) throw new PeerError(`No session ${id}.`);
            sent.push({ id, text, from });
            return { text: `Sent to session ${id}.`, delivery: "started", title: id };
        },
    };
    // As a server's Cavvy answers the user's computer over its connection (engine peers.list/read/send).
    const ask = async (method: string, p: any) => {
        if (method === "peers.list") return ops.list(p);
        if (method === "peers.read") return ops.read(p.id, p.turns) ?? null;
        return ops.send(p.id, p.message, p.from);
    };
    return { ops, sent, link: { ask } };
}

test("the user's computer lists each server's sessions by the server's name, and reads and sends to them there", async () => {
    const box = machine([row("b1", 30), row("b2", 10)]);
    const lab = machine([row("l1", 20)]);
    const far = homeFarPeers(() => new Map([["box", box.link], ["lab", lab.link]]));
    const listed = await far.list({ limit: 10 });
    expect(listed.map((s) => [s.id, s.machine])).toEqual([["box/b1", "box"], ["lab/l1", "lab"], ["box/b2", "box"]]);
    expect((await far.read("lab/l1"))?.text).toBe("turns of l1");
    // The message says which session it's from as the server names this computer's: `mac/<id>` there.
    await far.send("box/b2", "Check the migration.", { id: "20261118-000000-aaaaaa", title: "Mine", mode: "auto" });
    expect(box.sent).toEqual([{ id: "b2", text: "Check the migration.", from: { id: `${HOME_NAME}/20261118-000000-aaaaaa`, title: "Mine", mode: "auto" } }]);
    // One that isn't connected, or a name that isn't one: said, not sent.
    await expect(far.send("gone/x", "hi", { id: "a", title: "a", mode: "auto" })).rejects.toThrow("gone isn't connected right now");
    await expect(far.read("nope")).rejects.toThrow("is named <machine>/<id>");
});

test("a server asks through the user's computer: its own sessions and the other servers', named as the server names them", async () => {
    const mac = machine([row("m1", 50, "On the Mac")]);
    const box = machine([row("b1", 40)]);
    const lab = machine([row("l1", 30)]);
    const servers = new Map([["box", box.link], ["lab", lab.link]]);
    // Asked by box: the Mac's and lab's, not box's own.
    const far = serverFarPeers((op, params) => answerPeers("box", op, params, mac.ops, servers));
    expect((await far.list({ limit: 10 })).map((s) => [s.id, s.machine])).toEqual([[`${HOME_NAME}/m1`, HOME_NAME], ["lab/l1", "lab"]]);
    expect((await far.read(`${HOME_NAME}/m1`))?.text).toBe("turns of m1");
    // To the Mac: from `box/<id>`, which the Mac names box's sessions by. To lab: the same, through the Mac.
    await far.send(`${HOME_NAME}/m1`, "Done on the server.", { id: "s9", title: "Server work", mode: "bypassPermissions" });
    await far.send("lab/l1", "Your turn.", { id: "s9", title: "Server work", mode: "bypassPermissions" });
    expect(mac.sent[0]!.from).toEqual({ id: "box/s9", title: "Server work", mode: "bypassPermissions" });
    expect(lab.sent[0]!.from).toEqual({ id: "box/s9", title: "Server work", mode: "bypassPermissions" });
    // A refusal there reads as one here.
    await expect(far.send(`${HOME_NAME}/nope`, "hi", { id: "s9", title: "t", mode: "auto" })).rejects.toThrow("No session nope.");
});

test("a server answers its sessions for the user's computer, and asks it about the others; with none connected, says so", async () => {
    const { Engine } = await import("../src/server/engine");
    const engine = new Engine({ away: true });
    const events: any[] = [];
    const client = { subs: new Set<string>(), send: (e: any) => void events.push(e) };
    engine.clients.add(client as never);
    try {
        const none = engine.farPeers()!;
        await expect(none.list({ limit: 5 })).resolves.toEqual([]);
        await expect(none.read(`${HOME_NAME}/x`)).rejects.toThrow("isn't connected to this server right now");
        await engine.handle(client as never, "peers.hub", {});
        const far = engine.farPeers()!;
        const listing = far.list({ limit: 5 });
        await Bun.sleep(0);
        const call = events.find((e) => e.type === "peers.call");
        expect([call.op, call.params]).toEqual(["list", { limit: 5 }]);
        await engine.handle(client as never, "peers.result", { callId: call.callId, result: [{ id: `${HOME_NAME}/m1`, title: "On the Mac", cwd: "/Users/me/app", status: "working", updatedAt: 5 }] });
        expect((await listing).map((s) => [s.id, s.machine, s.status])).toEqual([[`${HOME_NAME}/m1`, HOME_NAME, "working"]]);
        // The computer going away ends what waits for it.
        const reading = far.read(`${HOME_NAME}/m1`);
        await Bun.sleep(0);
        engine.dropClient(client as never);
        await expect(reading).rejects.toThrow("went away before it answered");
        // Its own sessions, asked by the computer: none here.
        expect(await engine.handle(client as never, "peers.list", { limit: 5 })).toEqual([]);
    } finally {
        await engine.stop();
    }
});
