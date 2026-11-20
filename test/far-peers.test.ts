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
    const started: { o: Record<string, unknown>; from: { id: string; title: string; mode: string } }[] = [];
    const ops: Ops = {
        start: async (o, from) => {
            if (o.cwd === "/nowhere") throw new PeerError("/nowhere isn't a folder");
            started.push({ o, from });
            return { ...row(`new${started.length}`, 99, o.title), cwd: o.cwd, model: o.model ?? "mock:opus", ...(o.effort ? { effort: o.effort as "high" } : {}) };
        },
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
        if (method === "peers.start") return ops.start({ cwd: p.cwd, prompt: p.prompt, title: p.title, model: p.model, effort: p.effort }, p.from);
        return ops.send(p.id, p.message, p.from);
    };
    return { ops, sent, started, link: { ask } };
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
    // The computer's own deny rules hold for what's asked through it: its sessions, and the other servers'.
    const deny = (tool: string) => (tool === "ListSessions" || tool === "ReadSession" || tool === "SendToSession" ? `denies ${tool}` : undefined);
    await expect(answerPeers("box", "list", { limit: 10 }, mac.ops, servers, deny)).rejects.toThrow("denies ListSessions");
    await expect(answerPeers("box", "read", { id: `${HOME_NAME}/m1` }, mac.ops, servers, deny)).rejects.toThrow("denies ReadSession");
    await expect(answerPeers("box", "read", { id: "lab/l1" }, mac.ops, servers, deny)).rejects.toThrow("denies ReadSession");
    const sentBefore = lab.sent.length;
    await expect(answerPeers("box", "send", { id: "lab/l1", message: "hi", from: { id: "s9", title: "t", mode: "auto" } }, mac.ops, servers, deny)).rejects.toThrow("denies SendToSession");
    expect(lab.sent.length).toBe(sentBefore);
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

test("a send another machine refuses names the session as it was asked for", async () => {
    const refuse = { ask: async () => Promise.reject(new Error("Session s1 runs in Bypass permissions mode, so it can't be sent work from there.")) };
    const from = { id: "a", title: "A", mode: "default" as const };
    expect(await homeFarPeers(() => new Map([["box", refuse]])).send("box/s1", "hi", from).catch((e: Error) => e.message)).toBe("Session box/s1 runs in Bypass permissions mode, so it can't be sent work from there.");
    expect(await serverFarPeers(() => Promise.reject(new Error("Session s1 runs in Bypass permissions mode."))).send("mac/s1", "hi", from).catch((e: Error) => e.message)).toBe("Session mac/s1 runs in Bypass permissions mode.");
});

test("a session is started on another machine: from the user's computer on a server, from a server on the computer or another server", async () => {
    const mac = machine([row("m1", 50)]);
    const box = machine([row("b1", 40)]);
    const lab = machine([row("l1", 30)]);
    const servers = new Map([["box", box.link], ["lab", lab.link]]);
    const from = { id: "s1", title: "Starter", mode: "bypassPermissions" as const };
    // From the computer: on the server named, as this computer's session.
    const home = homeFarPeers(() => servers);
    const onBox = await home.start({ machine: "box", cwd: "/srv/app", prompt: "Run the tests.", title: "Tests", effort: "high" }, from);
    expect([onBox.id, onBox.machine, onBox.cwd, onBox.effort]).toEqual(["box/new1", "box", "/srv/app", "high"]);
    expect(box.started[0]).toEqual({ o: { cwd: "/srv/app", prompt: "Run the tests.", title: "Tests", model: undefined, effort: "high" }, from: { ...from, id: `${HOME_NAME}/s1` } });
    await expect(home.start({ machine: "nope", cwd: "/x", prompt: "p", title: "t" }, from)).rejects.toThrow('No machine "nope" to start a session on. The user\'s other machines connected now: box, lab');
    // What the server refuses is said as it says it.
    await expect(home.start({ machine: "box", cwd: "/nowhere", prompt: "p", title: "t" }, from)).rejects.toThrow("/nowhere isn't a folder");
    // From a server, through the computer. On the computer itself: named as box's session, and held to Auto at most.
    const far = serverFarPeers((op, params) => answerPeers("box", op, params, mac.ops, servers));
    const onMac = await far.start({ machine: HOME_NAME, cwd: "/Users/me/app", prompt: "Build the app.", title: "Build" }, from);
    expect([onMac.id, onMac.machine]).toEqual([`${HOME_NAME}/new1`, HOME_NAME]);
    expect(mac.started[0]!.from).toEqual({ id: "box/s1", title: "Starter", mode: "auto" });
    expect(mac.started[0]!.o).toMatchObject({ cwd: "/Users/me/app", prompt: "Build the app.", title: "Build" });
    // On another server: passed on, from box's session, in the mode it runs in.
    const onLab = await far.start({ machine: "lab", cwd: "/srv/lab", prompt: "Check it.", title: "Check" }, from);
    expect([onLab.id, lab.started[0]!.from]).toEqual(["lab/new1", { id: "box/s1", title: "Starter", mode: "bypassPermissions" }]);
    // Its own machine by name, a machine there isn't, no folder: each said.
    await expect(far.start({ machine: "box", cwd: "/x", prompt: "p", title: "t" }, from)).rejects.toThrow("box is this machine: leave machine out");
    await expect(far.start({ machine: "gone", cwd: "/x", prompt: "p", title: "t" }, from)).rejects.toThrow(`The user's other machines connected now: ${HOME_NAME}, lab`);
    await expect(far.start({ machine: HOME_NAME, cwd: " ", prompt: "p", title: "t" }, from)).rejects.toThrow("Say which folder");
    // The computer's deny rule for StartSession holds for what's started through it, wherever.
    const deny = (tool: string) => (tool === "StartSession" ? "denies StartSession" : undefined);
    const denied = serverFarPeers((op, params) => answerPeers("box", op, params, mac.ops, servers, deny));
    const before = [mac.started.length, lab.started.length];
    await expect(denied.start({ machine: HOME_NAME, cwd: "/Users/me/app", prompt: "p", title: "t" }, from)).rejects.toThrow("denies StartSession");
    await expect(denied.start({ machine: "lab", cwd: "/srv/lab", prompt: "p", title: "t" }, from)).rejects.toThrow("denies StartSession");
    expect([mac.started.length, lab.started.length]).toEqual(before);
    // A machine that answers something that isn't a session: said, not taken for one.
    await expect(homeFarPeers(() => new Map([["odd", { ask: async () => ({ id: "../x" }) }]])).start({ machine: "odd", cwd: "/x", prompt: "p", title: "t" }, from)).rejects.toThrow("odd didn't say which session it started");
    // One that names a session but no folder, or doesn't answer at all: it may have started, which is said, and told apart from a refusal.
    const { PeerUnsure } = await import("../src/agent/peers");
    const unsure = async (ask: () => Promise<unknown>) => homeFarPeers(() => new Map([["slow", { ask }]])).start({ machine: "slow", cwd: "/x", prompt: "p", title: "t" }, from).catch((e) => e);
    for (const e of [await unsure(async () => ({ id: "n1" })), await unsure(() => Promise.reject(new Error("slow didn't answer."))), await unsure(() => Promise.reject(new Error("slow went away before it answered.")))]) {
        expect(e).toBeInstanceOf(PeerUnsure);
        expect((e as Error).message).toContain("look with ListSessions (all: true) before starting it again");
    }
    const refusal = await unsure(() => Promise.reject(new Error("slow isn't connected.")));
    expect([refusal instanceof PeerUnsure, refusal instanceof PeerError]).toEqual([false, true]);
    // A refusal that only mentions those words (a folder's name) is a refusal.
    const named = await unsure(() => Promise.reject(new Error("/srv/slow didn't answer. isn't a folder")));
    expect(named instanceof PeerUnsure).toBe(false);
    // Through the computer to another server that doesn't answer: still known for unanswered where it was asked from,
    // as the computer's connection to a server tells it (its error's words, nothing else).
    const silent = { ask: () => Promise.reject(new Error("lab didn't answer.")) };
    const relayed = serverFarPeers((op, params) => answerPeers("box", op, params, mac.ops, new Map([["box", box.link], ["lab", silent]])).catch((e: Error) => Promise.reject(new Error(e.message))));
    const lost = await relayed.start({ machine: "lab", cwd: "/srv/lab", prompt: "p", title: "t" }, from).catch((e) => e);
    expect([lost instanceof PeerUnsure, (lost as Error).message]).toEqual([true, "lab didn't answer. The session may have started all the same: look with ListSessions (all: true) before starting it again."]);
});
