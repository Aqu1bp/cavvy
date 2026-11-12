// The other machines' sessions, under the sidebar's own: each server this computer's Cavvy knows (and, in a window
// that's on a server, this computer), with the sessions in play there. One click puts the window on that machine
// with that session open. What a session on a machine no window is on has to tell its user comes as a notification
// that names the machine.
//
// This computer's own Cavvy keeps the list (servers.overview: src/servers/watch.ts). Part of the servers code,
// loaded only when there are servers; it puts itself in the sidebar (attach), which has no place of its own for it.

import { For, Show } from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { render } from "solid-js/web";
import type { MachineOverview, ServerEvent, SessionSummary } from "@shared/protocol";
import { inPlay } from "../lib/in-play";
import { home, switchMachine } from "../lib/machines";
import { focused, machine, notify } from "../lib/platform";
import { prefs } from "../state/prefs";
import { reportError, rpc } from "../state/app";

/** A machine as the sidebar lists it. `name` undefined: this computer. */
interface Group {
    key: string;
    name?: string;
    label: string;
    /** Why there's nothing to show of it, when it can't be reached as it is. */
    note?: string;
    sessions: SessionSummary[];
}

/** Rows shown per machine: the rest are a click away, on the machine itself. */
const SHOWN = 5;

const [groups, setGroups] = createStore<{ list: Group[] }>({ list: [] });
const servers = new Map<string, MachineOverview>();
/** This computer's sessions, for a window that's on a server. */
const own = new Map<string, SessionSummary>();
let here = "This computer";

const NOTES: Partial<Record<MachineOverview["state"], string>> = { unreachable: "Can't reach it", stopped: "Stopped", "needs-you": "Needs you", disconnected: "Disconnected" };

function show() {
    const list: Group[] = [];
    if (machine) list.push({ key: "", label: here, sessions: inPlay(own.values()) });
    // The machine this window is on is the sidebar's own list.
    for (const m of servers.values()) if (m.name !== machine && m.state !== "removed") list.push({ key: `s:${m.name}`, name: m.name, label: m.name, note: NOTES[m.state], sessions: m.sessions });
    setGroups("list", reconcile(list, { key: "key" }));
}

function Mark(p: { s: SessionSummary }) {
    return (
        <Show when={p.s.status === "waiting"} fallback={<Show when={p.s.status === "running"}><span class="spin-ring" title="Working" /></Show>}>
            <span class="wait-dot" title="Waiting for you" />
        </Show>
    );
}

function Others() {
    return (
        <For each={groups.list}>
            {(g) => (
                <div class="om" role="group" aria-label={g.label}>
                    <button class="om-h" title={`Go to ${g.label}`} onClick={() => switchMachine(g.name)}>
                        <span class="truncate">{g.label}</span>
                        <Show when={g.note}>
                            <span class="om-n">{g.note}</span>
                        </Show>
                    </button>
                    <For each={g.sessions.slice(0, SHOWN)}>
                        {(s) => (
                            <div class="slim">
                                <button class="slim-hit" title={`${s.title}\n${s.cwd}`} onClick={() => switchMachine(g.name, s.id)}>
                                    <span class="truncate">{s.title}</span>
                                </button>
                                <span class="slim-end">
                                    <span class="t">
                                        <Mark s={s} />
                                    </span>
                                </span>
                            </div>
                        )}
                    </For>
                    <Show when={g.sessions.length > SHOWN}>
                        <button class="om-more" onClick={() => switchMachine(g.name)}>
                            {g.sessions.length - SHOWN} more
                        </button>
                    </Show>
                </div>
            )}
        </For>
    );
}

let host: HTMLElement | undefined;
let seen: MutationObserver | undefined;

/** Puts the list above the sidebar's foot, and back there when the sidebar is built again (hidden and shown). */
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
        render(() => <Others />, host);
    }
    const place = () => {
        const foot = rail.querySelector(".sidebar .side-foot");
        if (foot && host!.nextElementSibling !== foot) foot.before(host!);
    };
    place();
    // Only the rail's own children: told when the sidebar comes and goes, not on what changes inside it.
    seen ??= new MutationObserver(place);
    seen.disconnect();
    seen.observe(rail, { childList: true });
}

/** What a session on another machine has to tell its user: a notification that names the machine. */
function tell(ev: Extract<ServerEvent, { type: "servers.notify" }>) {
    // A window on that machine hears it from there.
    if (ev.name === machine || !prefs.notifications) return;
    if (ev.kind === "done" && focused()) return;
    void notify(`${ev.title} · ${ev.name ?? here}`, ev.body, () => switchMachine(ev.name, ev.sessionId));
}

let started = false;

/**
 * The window's Cavvy is connected (again): the other machines' sessions are asked for, and kept up to date from then
 * on. `hereName`: what this computer is called in the list.
 */
export function watchOthers(hereName: string) {
    here = hereName;
    const from = home ?? rpc;
    const load = () => {
        void from.call("servers.overview", {}).then((r) => {
            servers.clear();
            for (const m of r.machines) servers.set(m.name, m);
            show();
        }, reportError);
        if (!home) return;
        void home.call("sessions.list", { limit: 30 }).then((list) => {
            own.clear();
            for (const s of list) own.set(s.id, s);
            show();
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
            show();
        } else if (e.type === "servers.notify") tell(e);
        else if (home && e.type === "sessions.upsert") {
            own.set(e.session.id, e.session);
            show();
        } else if (home && e.type === "sessions.remove" && own.delete(e.id)) show();
    });
    // A window on a server: this computer's Cavvy is another connection, which comes and goes by itself.
    home?.onState((s) => s === "open" && load());
    if (!home || home.state === "open") load();
    attach();
}
