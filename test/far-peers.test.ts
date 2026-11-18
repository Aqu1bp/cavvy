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
            return { text: `Sent to session ${id} (“${id}”). It was idle.`, delivery: "started", title: id };
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
    // What comes back names the session as this machine does, so the id can be used again as it's read.
    expect((await far.send("box/b2", "Check the migration.", { id: "20261118-000000-aaaaaa", title: "Mine", mode: "auto" })).text).toBe("Sent to session box/b2 (“b2”). It was idle.");
    expect(box.sent).toEqual([{ id: "b2", text: "Check the migration.", from: { id: `${HOME_NAME}/20261118-000000-aaaaaa`, title: "Mine", mode: "auto" } }]);
    // None answering: why, not none.
    const down = { ask: () => Promise.reject(new Error("went away")) };
    await expect(homeFarPeers(() => new Map([["box", down]])).list({ limit: 5 })).rejects.toThrow("box: went away");
    expect((await homeFarPeers(() => new Map([["box", down], ["lab", lab.link]])).list({ limit: 5 })).map((s) => s.id)).toEqual(["lab/l1"]);
    // One that isn't connected, or a name that isn't one: said, not sent.
    await expect(far.send("gone/x", "hi", { id: "a", title: "a", mode: "auto" })).rejects.toThrow("gone isn't one of the user's machines, or isn't connected right now");
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
    // Whatever spelling that machine keeps the id in, and whatever its title says.
    const odd = { ask: async () => ({ text: "Sent to session B2 (“Sent to session b2 now”). It was idle.", delivery: "started", title: "t" }) };
    expect((await homeFarPeers(() => new Map([["box", odd]])).send("box/b2", "hi", { id: "a", title: "a", mode: "auto" })).text).toBe("Sent to session box/b2 (“Sent to session b2 now”). It was idle.");
    expect((await far.send("lab/l1", "Your turn.", { id: "s9", title: "Server work", mode: "bypassPermissions" })).text).toStartWith("Sent to session lab/l1 ");
    // Its own machine's session, named as another machine would: told how it's named here, not that box is away.
    await expect(far.read("box/s1")).rejects.toThrow("box/s1 is on this machine: a session here goes by its id alone (s1).");
    // Into the user's computer a server's session counts as Auto at most (its Bypass sessions take no work from one).
    expect(mac.sent[0]!.from).toEqual({ id: "box/s9", title: "Server work", mode: "auto" });
    expect(lab.sent[0]!.from).toEqual({ id: "box/s9", title: "Server work", mode: "bypassPermissions" });
    // A refusal there reads as one here.
    await expect(far.send(`${HOME_NAME}/nope`, "hi", { id: "s9", title: "t", mode: "auto" })).rejects.toThrow("No session nope.");
    // No mode, or no message: refused, not taken as the freest.
    await expect(answerPeers("box", "send", { id: `${HOME_NAME}/m1`, message: "hi", from: { id: "s9", title: "t" } }, mac.ops, servers)).rejects.toThrow("what mode");
    await expect(far.send(`${HOME_NAME}/m1`, "  ", { id: "s9", title: "t", mode: "auto" })).rejects.toThrow("non-empty");
    // A server named as the user's computer is: its sessions don't pass for the computer's.
    const named = machine([row("x1", 60)]);
    const rows = await answerPeers("box", "list", { limit: 10 }, mac.ops, new Map([...servers, [HOME_NAME, named.link]]));
    expect((rows as { id: string }[]).map((r) => r.id)).toEqual([`${HOME_NAME}/m1`, "lab/l1"]);
    // ...and one named so reaches none: its sessions would be taken for the computer's.
    await expect(answerPeers(HOME_NAME, "list", { limit: 10 }, mac.ops, servers)).rejects.toThrow(`named ${HOME_NAME}`);
    // The computer's own deny rules hold for its sessions, not for the other servers'.
    const deny = (tool: string) => (tool === "ListSessions" || tool === "ReadSession" ? `denies ${tool}` : undefined);
    const denied = await answerPeers("box", "list", { limit: 10 }, mac.ops, servers, deny);
    expect((denied as { id: string }[]).map((r) => r.id)).toEqual(["lab/l1"]);
    await expect(answerPeers("box", "read", { id: `${HOME_NAME}/m1` }, mac.ops, servers, deny)).rejects.toThrow("denies ReadSession");
    // With nothing else to list, the list being kept back is said, not taken for no sessions.
    await expect(answerPeers("box", "list", { limit: 10 }, mac.ops, new Map([["box", box.link]]), deny)).rejects.toThrow("denies ListSessions");
    expect(((await answerPeers("box", "read", { id: "lab/l1" }, mac.ops, servers, deny)) as { text: string }).text).toBe("turns of l1");
    // A refused list is said, not taken for none.
    await expect(serverFarPeers(() => Promise.reject(new Error("busy"))).list({ limit: 5 })).rejects.toThrow("busy");
});

test("a server answers its sessions for the user's computer, and asks it about the others; with none connected, says so", async () => {
    const { Engine } = await import("../src/server/engine");
    const engine = new Engine({ away: true });
    const events: any[] = [];
    const client = { subs: new Set<string>(), send: (e: any) => void events.push(e) };
    engine.clients.add(client as never);
    try {
        const none = engine.farPeers()!;
        await expect(none.list({ limit: 5 })).rejects.toThrow("isn't connected to this server right now");
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

test("a deny rule that names a session tool at all keeps it from another machine's sessions", async () => {
    const { peersDenied } = await import("../src/server/far-peers");
    for (const rule of ["SendToSession", "SendToSession(*)", "SendToSession(box/*)", "mcp__cavvy__send_to_session", "mcp__cavvy__*"]) expect([rule, peersDenied([rule], "SendToSession")]).toEqual([rule, true]);
    for (const rule of ["ReadSession", "Bash(send*)", "SendToSessions", "mcp__other__send_to_session"]) expect([rule, peersDenied([rule], "SendToSession")]).toEqual([rule, false]);
    expect(peersDenied(["mcp__cavvy__list_sessions"], "ListSessions")).toBe(true);
    expect(peersDenied([], "ReadSession")).toBe(false);
});

test("a Bypass default that isn't turned on here holds another machine's calls as Manual does", async () => {
    const { lendingMode } = await import("../src/permissions/modes");
    const bypass = { permissions: { defaultMode: "bypassPermissions" } } as never;
    expect(lendingMode(bypass, "/tmp", false)).toBe("default");
    expect(lendingMode({ permissions: { defaultMode: "auto" } } as never, "/tmp", false)).toBe("auto");
});

test("what's read of another machine's session names it as it's asked for; a CLI's early limit warning says the share used", async () => {
    const { homeFarPeers } = await import("../src/server/far-peers");
    const box = { ask: async () => ({ text: "Session b2 “Fix it”: idle, last active 2m ago. Folder: /srv/app.\n…", title: "Fix it", turns: 1 }) };
    expect((await homeFarPeers(() => new Map([["box", box]])).read("box/b2"))!.text).toStartWith("Session box/b2 “Fix it”: idle");
    const { nearLimitWords } = await import("../src/backends/limits");
    expect(nearLimitWords(53, "weekly ")).toBe("53% of the weekly usage limit used.");
    expect(nearLimitWords(91, "weekly ")).toBe("close to the weekly usage limit.");
    expect(nearLimitWords(undefined, "")).toBe("close to the usage limit.");
});

test("the worktree a removal leaves Home in is read before the dialog closes", async () => {
    const src = await Bun.file(new URL("../gui/src/components/WorktreeDialogs.tsx", import.meta.url)).text();
    const remove = src.slice(src.indexOf("export function RemoveWorktreeDialog"));
    // Its request is the picker's, gone once the dialog is closed: nothing reads it after that.
    expect(remove).toContain("const { worktree: w, cwd, main } = p.request;");
    expect(remove.split("p.request").length).toBe(2);
    expect(remove).toContain("homeOn() === on && app.homeCwd === here) await openProject(main, true);");
});
