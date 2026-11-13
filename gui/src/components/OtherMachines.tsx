// Every machine's sessions in the window's one list: this computer's and each server's, each row with the machine
// it's on. The window's own machine's sessions are its own (state/app.ts); here the others are added to that list,
// kept as they change, and what a row offers (rename, pin, archive, delete) is sent to the machine the session is
// on. Opening one puts the window on that machine (state/app.ts activate). What a session on a machine no window is
// on has to tell its user comes as a notification that names the machine.
//
// This computer's own Cavvy hears each server (servers.overview: src/servers/watch.ts). Part of the servers code,
// loaded only when there are servers. A server that can't be reached as it is says so above the sidebar's foot.

import { batch, createEffect, createRoot, For, on } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import type { MachineOverview, ServerEvent, SessionSummary } from "@shared/protocol";
import { listable, mayTake, otherRows, relisted, routeOf } from "../lib/machine-rows";
import { home, switchMachine } from "../lib/machines";
import { focused, machine, notify } from "../lib/platform";
import { RpcError } from "../lib/rpc";
import { orderSessions } from "../lib/session-order";
import { prefs } from "../state/prefs";
import { freeRail } from "../state/ui";
import { activate, app, forgetSession, markSeenAll, others, reportError, rpc, setApp, upsertSession } from "../state/app";

/** The servers as this computer's Cavvy last described them, by name. */
const servers = new Map<string, MachineOverview>();
/** This computer's sessions, for a window that's on a server. */
const mac = new Map<string, SessionSummary>();
/** The sessions of other machines that are in the list, by id: the server each is on (undefined: this computer). */
const far = new Map<string, string | undefined>();
/** Those that left the list since (deleted there, mostly), the last couple of hundred: Undo brings one back where it was. */
const gone = new Map<string, string | undefined>();
const left = (id: string, at: string | undefined) => {
    gone.set(id, at);
    if (gone.size > 200) gone.delete(gone.keys().next().value!);
};
/** The machines whose sessions are in the list. */
let joined = new Set<string | undefined>();
let here = "This computer";
const NOTES: Partial<Record<MachineOverview["state"], string>> = { unreachable: "Can't reach it", stopped: "Stopped", "needs-you": "Open to connect", disconnected: "Disconnected" };
/** The servers that can't be reached as they are, and why. */
const [trouble, setTrouble] = createStore<{ list: { name: string; note: string }[] }>({ list: [] });

/** The other machines' sessions, each with its machine. */
const rows = () => otherRows(machine, mac.values(), servers.values());

const listed = (id: string) => app.sessions.find((s) => s.id === id) ?? app.archived.find((s) => s.id === id);

/**
 * New to this window: nothing in it is unread yet, as on the window's first run. `unlisted`: those no longer listed
 * here, of which nothing is kept.
 */
function seen(list: SessionSummary[], unlisted: string[] = []) {
    const fresh = list.filter((s) => app.seen[s.id] === undefined);
    const stale = unlisted.filter((id) => app.seen[id] !== undefined);
    if (fresh.length || stale.length) markSeenAll(fresh, stale);
}

/**
 * The list made again from the window's own sessions and every other machine's as they stand. Not before the
 * window's own are in: the sidebar holds its rows still under the pointer (and the pointer is on it, right after a
 * click that brought the window to this machine), so a first list of only the other machines' would stay all there
 * is. Its own list takes these in when it comes (others.list).
 */
function relist() {
    setTrouble("list", reconcile([...servers.values()].flatMap((m) => (m.name !== machine && NOTES[m.state] ? [{ name: m.name, note: NOTES[m.state]! }] : [])), { key: "name" }));
    if (!app.sessionsLoaded) return;
    const ownOf = (list: SessionSummary[]) => list.filter((s) => s.machine === machine);
    const add = listable([...ownOf(app.sessions), ...ownOf(app.archived)], rows());
    const now = relisted(far, add, joined);
    far.clear();
    for (const [id, at] of now.far) far.set(id, at);
    // One that left without a word of its own (its machine said many things at once, so the whole list came): what's
    // asked of it next (Undo of its delete) still goes to the machine it was on.
    for (const [id, at] of now.out) left(id, at);
    seen(add, now.out.map(([id]) => id));
    // A machine's sessions joining the list show at once, though the pointer rests on the sidebar (it does, right
    // after the click that brought the window here): held back, the list would stay the few rows it began with.
    if (now.joins) freeRail();
    joined = now.machines;
    batch(() => {
        setApp("sessions", reconcile(orderSessions([...ownOf(app.sessions), ...add.filter((s) => !s.archived)]), { key: "id" }));
        setApp("archived", reconcile(orderSessions([...ownOf(app.archived), ...add.filter((s) => s.archived)]), { key: "id" }));
    });
}

/** One session of another machine changed. */
function put(s: SessionSummary) {
    if (!app.sessionsLoaded || !mayTake(listed(s.id), machine, s.machine)) return;
    far.set(s.id, s.machine);
    seen([s]);
    upsertSession(s);
}

/**
 * One session of another machine is no longer among those listed here (its machine has more than are kept): its
 * row goes, and that's all. It isn't deleted: what's kept of it on its own machine stays.
 */
function unlist(id: string, at: string | undefined) {
    if (!far.has(id) || far.get(id) !== at) return;
    far.delete(id);
    const now = listed(id);
    if (!now || now.machine === machine) return;
    batch(() => {
        setApp("sessions", (l) => l.filter((s) => s.id !== id));
        setApp("archived", (l) => l.filter((s) => s.id !== id));
    });
    seen([], [id]);
}

/** One session of another machine is gone from it. */
function drop(id: string, at: string | undefined) {
    if (!far.has(id) || far.get(id) !== at) return;
    far.delete(id);
    left(id, at);
    const now = listed(id);
    if (now && now.machine !== machine) forgetSession(id);
}

// What the list holds of the other machines when the window's own are asked for again (state/app.ts), and once
// they're in for the first time: which of the rows are another machine's is worked out then.
others.list = rows;
createRoot(() => createEffect(on(() => app.sessionsLoaded, (loaded) => loaded && relist())));

/**
 * What a session's row offers, for one on another machine: sent there. Through this computer's Cavvy, which is
 * connected to every server; straight to it when the session is this computer's.
 */
rpc.route = (method, params) => {
    const to = routeOf(method, params, far, listed, machine, gone);
    if (to === "here") return undefined;
    if (to === "refused") return Promise.reject(new RpcError("Open the session to do that.", "unsupported"));
    const call = (home ?? rpc).call.bind(home ?? rpc) as (m: string, p: unknown) => Promise<unknown>;
    return to === "mac" ? call(method, params) : call("servers.relay", { name: to.relay, method, params });
};


function Trouble() {
    return (
        <For each={trouble.list}>
            {(m) => (
                <button class="om-h" title={`Go to ${m.name}`} onClick={() => switchMachine(m.name)}>
                    <span class="truncate">{m.name}</span>
                    <span class="om-n">{m.note}</span>
                </button>
            )}
        </For>
    );
}

let host: HTMLElement | undefined;
let seenRail: MutationObserver | undefined;

/** Puts the servers in trouble above the sidebar's foot, and back there when the sidebar is built again (hidden and shown). */
function attach(tries = 0) {
    const rail = document.querySelector(".win-rail");
    if (!rail) {
        // The window isn't drawn yet (it's still connecting): looked for again, a few times.
        if (tries < 40) setTimeout(() => attach(tries + 1), 250);
        return;
    }
    if (!host) {
        host = document.createElement("div");
        host.className = "others";
        render(() => <Trouble />, host);
    }
    const place = () => {
        const foot = rail.querySelector(".sidebar .side-foot");
        if (foot && host!.nextElementSibling !== foot) foot.before(host!);
    };
    place();
    // Only the rail's own children: told when the sidebar comes and goes, not on what changes inside it.
    seenRail ??= new MutationObserver(place);
    seenRail.disconnect();
    seenRail.observe(rail, { childList: true });
}

/** What a session on another machine has to tell its user: a notification that names the machine. */
function tell(ev: Extract<ServerEvent, { type: "servers.notify" }>) {
    // A window on that machine hears it from there, unless it's this computer that asks for a session there.
    const onIt = ev.name === machine;
    if ((onIt && !ev.lent) || !prefs.notifications) return;
    // On screen already, in the session that's open (lib/lent.ts).
    if (focused() && (ev.kind === "done" || (onIt && app.activeId === ev.sessionId))) return;
    const open = () => (onIt ? void activate(ev.sessionId || undefined) : switchMachine(ev.name, ev.sessionId || undefined));
    // The machine first: the rest is the session's own words, and a long title is cut at its end.
    void notify(`${ev.name ?? here}: ${ev.title}`, ev.body, open, { tag: `machine:${ev.name ?? ""}:${ev.sessionId}` });
}

let started = false;

/**
 * The window's Cavvy is connected (again): the other machines' sessions are asked for, and kept up to date from then
 * on. `hereName`: what this computer is called in a notification.
 */
export function watchOthers(hereName: string) {
    here = hereName;
    const from = home ?? rpc;
    const load = () => {
        void from.call("servers.overview", {}).then((r) => {
            servers.clear();
            for (const m of r.machines) servers.set(m.name, m);
            relist();
        }, reportError);
        if (!home) return;
        void Promise.all([home.call("sessions.list", { limit: 300 }), home.call("sessions.list", { limit: 300, archived: true })]).then((lists) => {
            mac.clear();
            for (const s of lists.flat()) mac.set(s.id, s);
            relist();
        }, reportError);
    };
    if (started) {
        // The window's own Cavvy came back, or a server was added: for a window on this computer, that's who keeps the list.
        if (!home || home.state === "open") load();
        return;
    }
    started = true;
    from.onEvent((e) => {
        if (e.type === "servers.overview") {
            servers.set(e.machine.name, e.machine);
            relist();
        } else if (e.type === "servers.session") {
            const m = servers.get(e.name);
            if (!m || e.name === machine) return;
            if (e.session) {
                const s = e.session;
                m.sessions = [s, ...m.sessions.filter((x) => x.id !== s.id)];
                put({ ...s, machine: e.name });
            } else if (e.remove) {
                m.sessions = m.sessions.filter((x) => x.id !== e.remove);
                drop(e.remove, e.name);
            } else if (e.unlisted) {
                m.sessions = m.sessions.filter((x) => x.id !== e.unlisted);
                unlist(e.unlisted, e.name);
            }
        } else if (e.type === "servers.notify") tell(e);
        else if (home && e.type === "sessions.upsert") {
            mac.set(e.session.id, e.session);
            put({ ...e.session, machine: undefined });
        } else if (home && e.type === "sessions.remove" && mac.delete(e.id)) drop(e.id, undefined);
    });
    // A window on a server: this computer's Cavvy is another connection, which comes and goes by itself.
    home?.onState((s) => s === "open" && load());
    if (!home || home.state === "open") load();
    attach();
}
