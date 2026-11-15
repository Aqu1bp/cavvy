// Servers, in the desktop app: which machine the window is on (the sidebar's switcher), adding one, and what the
// window shows while it reaches a server. The work is this computer's own Cavvy's (src/servers/manager.ts); here are
// the questions and the words. Loaded when first needed (state/servers.ts), not with the window.

import { createEffect, createResource, createRoot, createSignal, createUniqueId, For, Match, on, Show, Switch } from "solid-js";
import { render } from "solid-js/web";
import { Check, ChevronDown, Plus, Server, Trash2 } from "lucide-solid";
import type { AddResult, ServerCheck, ServerProblem, UnknownHost } from "@shared/protocol";
import { homeRpc, machineIssue, setMachineIssue, switchMachine, trustMachine, userAsked, type MachineIssue } from "../lib/machines";
import { machine, os } from "../lib/platform";
import { activate, app, createSession, reportError, requestTrust, rpc, setApp, toast } from "../state/app";
import { RpcError } from "../lib/rpc";
import { Dialog } from "./ui/Dialog";
import { Menu } from "./ui/Menu";
import { Logo, Spinner } from "./ui/bits";
import { machineNote, watchOthers } from "./OtherMachines";
import "../lib/lent";
import "../styles/servers.css";

// What the window's connection needs of a server (state/app.ts), from the one place this is all loaded from.
export { machineCredentials, setMachineIssue, switchMachine } from "../lib/machines";

/** The sidebar's list of machines is open, under the button that opened it. */
const [serverMenu, setServerMenu] = createSignal(false);
const [menuAnchor, setMenuAnchor] = createSignal<HTMLElement>();
/** Which edge of what opened it the list lines up with. */
const [menuAlign, setMenuAlign] = createSignal<"start" | "end">("end");
/** The dialog that adds a server is open. */
const [addServerOpen, setAddServerOpen] = createSignal(false);

let mounted = false;
/**
 * Opens the list of machines under `anchor` (the new session's strip: mountWhere), or closes it. The list and the dialog it leads
 * to are put on the page the first time: none of this is loaded before the button is pressed.
 */
export function openMachines(anchor: HTMLElement, align: "start" | "end" = "start") {
    setMenuAlign(align);
    if (!mounted) {
        mounted = true;
        const host = document.createElement("div");
        document.body.append(host);
        render(
            () => (
                <>
                    <ServerMenu anchor={menuAnchor} />
                    <AddServerDialog />
                </>
            ),
            host,
        );
        createEffect(() => menuAnchor()?.setAttribute("aria-expanded", String(serverMenu())));
    }
    setMenuAnchor(anchor);
    setServerMenu(!serverMenu());
}

/**
 * The window's Cavvy answered (each time it connects): a window on a server is on it now, and where this computer
 * has servers, the other machines' sessions are shown under the window's own (OtherMachines.tsx).
 */
export function connected() {
    if (machine) setMachineIssue(undefined);
    else takeHandoff();
    watchOthers(HERE);
}

/**
 * Puts, in `el` (the new session's strip, before its project), where the session will run: this computer or a
 * server, and the way to another.
 */
export function mountWhere(el: HTMLElement): () => void {
    return render(
        () => (
            <button class="strip-ctl" title="Where the session runs" aria-haspopup="menu" onClick={(e) => openMachines(e.currentTarget, "start")}>
                <Server size={14} class="ic" />
                <span class="truncate">{machine ?? HERE}</span>
                <ChevronDown size={12} stroke-width={2} class="chv" />
            </button>
        ),
        el,
    );
}

/** Shows, in `el`, what a window on a server shows until it's connected (MachineCover). */
export function mountCover(el: HTMLElement) {
    render(() => <MachineCover />, el);
}

/** What this computer is called in the list of machines. */
export const HERE = os === "macos" ? "This Mac" : "This computer";

const servers = () => homeRpc(rpc);

function Problem(p: { problem: ServerProblem }) {
    return (
        <div class="server-problem">
            <Show when={p.problem.message}>
                <p>{p.problem.message}</p>
            </Show>
            <Show when={p.problem.detail}>{(d) => <p class="muted small">{d()}</p>}</Show>
            <Show when={p.problem.fix}>{(f) => <p class="mono small">{f()}</p>}</Show>
        </div>
    );
}

function HostKey(p: { unknown: UnknownHost }) {
    return (
        <div class="server-key">
            <For each={p.unknown.fingerprints}>{(f) => <div class="mono small">{f}</div>}</For>
        </div>
    );
}

/** What a server lacks, a line each: only what the user would act on. */
export function checkLines(name: string, c: ServerCheck): string[] {
    const lines: string[] = [];
    const have = c.clis.filter((x) => x.installed);
    for (const cli of have) {
        if (cli.signedIn === false) lines.push(`${cli.product} isn't signed in. Open ${name}, then Settings → Providers.`);
        else if (cli.signedIn === true && cli.on === false) lines.push(`${cli.product} is off. Open ${name}, then Settings → Providers.`);
    }
    if (!have.length) lines.push("No agent CLI there (Claude Code, Codex). API keys work without one.");
    if (!c.git) lines.push("No git there.");
    if (!c.gh.installed) lines.push("No GitHub CLI there: pull requests need it.");
    else if (c.gh.signedIn === false) lines.push("The GitHub CLI isn't signed in there.");
    if (!c.browser) lines.push("No Chrome there: the Browser tool needs one.");
    if (!c.service) lines.push(c.lingerFix ? `It won't start again after a reboot. On it: ${c.lingerFix}` : "It won't start again after a reboot.");
    return lines;
}

/** The sidebar's list of machines. */
function ServerMenu(p: { anchor: () => HTMLElement | undefined }) {
    const [list] = createResource(
        () => serverMenu(),
        () =>
            servers()
                .call("servers.list", {})
                .then((r) => r.servers)
                .catch(() => []),
    );
    const close = () => setServerMenu(false);
    // It can be put back, so nothing is asked first. (A rented machine stays rented: deleting it is asked of an agent.)
    const remove = async (name: string, rented?: boolean) => {
        close();
        try {
            await servers().call("servers.remove", { name });
            toast(rented ? `Removed ${name}. Its server still runs.` : `Removed ${name}`, "info", { label: "Undo", run: () => servers().call("servers.restore", { name }).then(() => undefined) });
        } catch (e) {
            reportError(e);
        }
    };
    return (
        <Menu label="Machines" open={serverMenu()} anchor={p.anchor} onClose={close} align={menuAlign()} width={240}>
            <button role="menuitemradio" aria-checked={!machine} class="menu-item compact" onClick={() => (close(), machine && switchMachine(undefined))}>
                <span class="grow">{HERE}</span>
                <Show when={!machine}>
                    <Check size={14} />
                </Show>
            </button>
            <For each={list() ?? []}>
                {(s) => (
                    <div class="server-row">
                        <button role="menuitemradio" aria-checked={machine === s.name} class="menu-item compact grow" title={s.destination} onClick={() => (close(), machine !== s.name && goTo(s.name))}>
                            <span class="grow">{s.name}</span>
                            <Show when={machineNote(s.name)} fallback={<Show when={s.cost}><span class="server-cost">{s.cost}</span></Show>}>
                                {(note) => <span class="server-cost tone-warn">{note()}</span>}
                            </Show>
                            <Show when={machine === s.name}>
                                <Check size={14} />
                            </Show>
                        </button>
                        {/* Not the one this window is on: it's removed from another. */}
                        <Show when={machine !== s.name}>
                            <button role="menuitem" class="hb" title={`Remove ${s.name}`} aria-label={`Remove ${s.name}`} onClick={() => void remove(s.name, s.rented)}>
                                <Trash2 size={13} />
                            </button>
                        </Show>
                    </div>
                )}
            </For>
            <div class="menu-sep" />
            <button role="menuitem" class="menu-item compact" onClick={() => (close(), setAddServerOpen(true))}>
                <Plus size={14} /> Add server…
            </button>
        </Menu>
    );
}

type AddStep =
    | { at: "form" }
    | { at: "working"; text: string; percent?: number }
    | { at: "trust"; unknown: UnknownHost }
    | { at: "copy"; name: string; note?: string; what: string; left?: string }
    | { at: "done"; name: string; note?: string; copied?: string; left?: string; lines?: string[] }
    | { at: "failed"; problem: ServerProblem };

/** Adding a server: its address, its key when it's new to this computer, the one-time copy, and what it lacks. */
function AddServerDialog() {
    const titleId = createUniqueId();
    const [name, setName] = createSignal("");
    const [destination, setDestination] = createSignal("");
    const [identity, setIdentity] = createSignal("");
    const [step, setStep] = createSignal<AddStep>({ at: "form" });
    const close = () => {
        // Not while it's being added: what comes next (its key to trust, what it lacks) would be asked of nobody.
        if (step().at === "working") return;
        setAddServerOpen(false);
        setStep({ at: "form" });
        setName("");
        setDestination("");
        setIdentity("");
    };
    const draft = () => ({ name: name().trim(), destination: destination().trim(), ...(identity().trim() ? { identityFile: identity().trim() } : {}) });

    // What it's doing, as this computer's Cavvy says it.
    servers().onEvent((e) => {
        if (e.type === "servers.progress" && e.name === name().trim() && step().at === "working") setStep({ at: "working", text: e.text, percent: e.percent });
    });

    /** What the copy leaves here, said so nobody looks for it there. */
    const notCopied = (left?: string) => (left ? `Not copied, since they could hold a key: ${left}.` : undefined);
    const finish = async (r: Extract<AddResult, { status: "added" }>, copied?: string) => {
        // The first server: its sessions are listed from now on, not from the window's next start, and a new
        // session says where it runs.
        watchOthers(HERE);
        if (app.hello) setApp("hello", "servers", (app.hello.servers ?? 0) + 1);
        let lines: string[] | undefined;
        try {
            lines = checkLines(r.name, await servers().call("servers.check", { name: r.name }));
        } catch {
            lines = undefined;
        }
        setStep({ at: "done", name: r.name, note: r.note, copied, left: notCopied(r.left), lines });
    };
    const add = async (trust?: string[]) => {
        setStep({ at: "working", text: `Connecting…` });
        try {
            const r = await servers().call("servers.add", { ...draft(), ...(trust ? { trust } : {}) });
            if (r.status === "unknown-host") setStep({ at: "trust", unknown: r.unknown });
            else if (r.status === "failed") setStep({ at: "failed", problem: r.problem });
            else if (r.copy) setStep({ at: "copy", name: r.name, note: r.note, what: r.copy.what, left: r.left });
            else await finish(r);
        } catch (e) {
            setStep({ at: "failed", problem: { message: (e as Error).message } });
        }
    };
    const copy = async (yes: boolean) => {
        const s = step();
        if (s.at !== "copy") return;
        const added = { status: "added" as const, name: s.name, note: s.note, left: s.left };
        if (!yes) return finish(added);
        setStep({ at: "working", text: "Copying…" });
        try {
            const r = await servers().call("servers.copy", { name: s.name });
            await finish(added, r.took ? `Copied your ${r.took}.` : `${s.name} already had them.`);
        } catch (e) {
            // The copy is an extra: the server is added either way.
            await finish(added, (e as Error).message);
        }
    };

    return (
        <Dialog open={addServerOpen()} onClose={close} bare labelledBy={titleId} width={460}>
            <div class="server-dialog">
                <Switch>
                    <Match when={step().at === "form"}>
                        <h2 id={titleId}>Add a server</h2>
                        <form
                            onSubmit={(e) => {
                                e.preventDefault();
                                if (name().trim() && destination().trim()) void add();
                            }}
                        >
                            <label>
                                Name
                                <input class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="build-box" autocapitalize="off" spellcheck={false} autofocus />
                            </label>
                            <label>
                                Address
                                <input class="input" value={destination()} onInput={(e) => setDestination(e.currentTarget.value)} placeholder="user@host" autocapitalize="off" spellcheck={false} />
                            </label>
                            <label>
                                SSH key file
                                <input class="input" value={identity()} onInput={(e) => setIdentity(e.currentTarget.value)} placeholder="Optional" autocapitalize="off" spellcheck={false} />
                            </label>
                            <div class="server-actions">
                                <button type="button" class="btn secondary" onClick={close}>
                                    Cancel
                                </button>
                                <button type="submit" class="btn primary" disabled={!name().trim() || !destination().trim()}>
                                    Add
                                </button>
                            </div>
                        </form>
                    </Match>
                    <Match when={step().at === "working" && (step() as Extract<AddStep, { at: "working" }>)}>
                        {(s) => (
                            <>
                                <h2 id={titleId}>Adding {name().trim()}</h2>
                                <div class="server-working">
                                    <Spinner size={16} />
                                    <span>
                                        {s().text}
                                        <Show when={s().percent !== undefined}> {s().percent}%</Show>
                                    </span>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={step().at === "trust" && (step() as Extract<AddStep, { at: "trust" }>)}>
                        {(s) => (
                            <>
                                <h2 id={titleId}>Trust {s().unknown.host}?</h2>
                                <HostKey unknown={s().unknown} />
                                <div class="server-actions">
                                    <button class="btn secondary" onClick={() => setStep({ at: "form" })}>
                                        Cancel
                                    </button>
                                    <button class="btn primary" onClick={() => void add(s().unknown.fingerprints)}>
                                        Trust
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={step().at === "copy" && (step() as Extract<AddStep, { at: "copy" }>)}>
                        {(s) => (
                            <>
                                <h2 id={titleId}>
                                    Copy your {s().what} to {s().name}?
                                </h2>
                                <p class="muted">Keys, and what reads like one, stay here.</p>
                                <div class="server-actions">
                                    <button class="btn secondary" onClick={() => void copy(false)}>
                                        Skip
                                    </button>
                                    <button class="btn primary" onClick={() => void copy(true)}>
                                        Copy
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={step().at === "done" && (step() as Extract<AddStep, { at: "done" }>)}>
                        {(s) => (
                            <>
                                <h2 id={titleId}>{s().name} is ready</h2>
                                <Show when={s().note}>{(n) => <p class="muted">{n()}</p>}</Show>
                                <Show when={s().copied}>{(c) => <p class="muted">{c()}</p>}</Show>
                                <Show when={s().left}>{(l) => <p class="muted">{l()}</p>}</Show>
                                <Show when={s().lines?.length}>
                                    <ul class="server-lacks">
                                        <For each={s().lines}>{(l) => <li>{l}</li>}</For>
                                    </ul>
                                </Show>
                                <div class="server-actions">
                                    <button class="btn secondary" onClick={close}>
                                        Close
                                    </button>
                                    <button
                                        class="btn primary"
                                        onClick={() => {
                                            const to = s().name;
                                            close();
                                            goTo(to);
                                        }}
                                    >
                                        Open {s().name}
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={step().at === "failed" && (step() as Extract<AddStep, { at: "failed" }>)}>
                        {(s) => (
                            <>
                                <h2 id={titleId}>Couldn't add {name().trim() || "the server"}</h2>
                                <Problem problem={s().problem} />
                                <div class="server-actions">
                                    <button class="btn secondary" onClick={close}>
                                        Cancel
                                    </button>
                                    <button class="btn primary" onClick={() => setStep({ at: "form" })}>
                                        Back
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                </Switch>
            </div>
        </Dialog>
    );
}

/**
 * What a window on a server shows until it's first connected there: "Connecting…", and what setting Cavvy up there
 * is at. Anything else (it can't be reached, a question) goes back to this computer, where it's asked over what the
 * user was looking at (handBack).
 */
function MachineCover() {
    const asks = () => machineIssue()?.kind === "connecting" && (machineIssue() as Extract<MachineIssue, { kind: "connecting" }>).percent !== undefined;
    createEffect(() => {
        const i = machineIssue();
        if (machine && app.hello === undefined && i && i.kind !== "connecting") handBack(machine, i);
    });
    return (
        <div class="server-cover" classList={{ "server-asks": asks() }}>
            <Logo size={44} />
            <Spinner size={18} />
            <div class="muted">
                {(machineIssue() as Extract<MachineIssue, { kind: "connecting" }> | undefined)?.text ?? `Connecting to ${machine}…`}
                <Show when={asks()}> {(machineIssue() as Extract<MachineIssue, { kind: "connecting" }>).percent}%</Show>
            </div>
            <button class="btn secondary" onClick={() => switchMachine(undefined)}>
                {HERE}
            </button>
        </div>
    );
}

/** What a window carries to this computer when it goes back there with something to show (sessionStorage). */
const HANDOFF_KEY = "cavvy.handoff";
interface Handoff {
    /** A server that couldn't be reached, or asks something: shown over this computer's view. */
    reach?: { name: string; session?: string; folder?: string; issue: MachineIssue };
    /** What to ask an agent here, in a new session. */
    ask?: string;
}

/** Back to this computer, with what it's to show or do there. */
function handOff(h: Handoff) {
    try {
        sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(h));
    } catch {
        // Nothing carried: the user is on this computer still.
    }
    switchMachine(undefined);
}

/** A window that never got onto its server: back where the user was, asked or told there. Once: the window then reloads. */
let handedBack = false;
function handBack(name: string, issue: MachineIssue) {
    if (handedBack) return;
    handedBack = true;
    let to: { session?: string; folder?: string } = {};
    try {
        const nav = JSON.parse(sessionStorage.getItem("cavvy.navigation") ?? "null") as { activeId?: string; homeCwd?: string } | null;
        to = { session: nav?.activeId, folder: nav?.homeCwd };
    } catch {
        // Opened on the new-session screen there.
    }
    handOff({ reach: { name, ...to, issue } });
}

/** What a window on this computer was handed when it came back (handOff): taken once. */
function takeHandoff() {
    if (machine) return;
    let h: Handoff | undefined;
    try {
        h = JSON.parse(sessionStorage.getItem(HANDOFF_KEY) ?? "null") ?? undefined;
        sessionStorage.removeItem(HANDOFF_KEY);
    } catch {
        return;
    }
    if (h?.reach) openReach(h.reach, h.reach.issue);
    if (h?.ask) {
        const text = h.ask;
        // Sent once this computer's projects are known: the session starts in the one that's open.
        createRoot((done) =>
            createEffect(() => {
                if (!app.sessionsLoaded) return;
                done();
                void askAgent(text);
            }),
        );
    }
}

/** Going to a server, or one of its sessions: the window stays where it is until the server answers. */
interface Reach {
    name: string;
    session?: string;
    folder?: string;
    issue: MachineIssue;
    /** Shown: it's taking a while, or there's something to say. A quick connection shows nothing. */
    shown: boolean;
    /** Being updated there. */
    updating?: boolean;
    /** Updating would stop work there: what's working, while the user is asked. */
    busy?: string;
}
const [reach, setReach] = createSignal<Reach>();
/** Each attempt's number: only the latest one's answer counts (one that was cancelled or replaced says nothing). */
let attempt = 0;
/** How long a connection may take before the dialog says it's connecting. */
const QUIET_MS = 400;

/**
 * Puts the window on another machine, or on one of its sessions (or a new session in `folder` there). A server is
 * connected to first, from here: the window moves only once it's there, and anything else is said over what the user
 * was looking at.
 */
export function goTo(name: string | undefined, session?: string, folder?: string) {
    if (!name) return switchMachine(undefined, session, folder);
    void connectTo({ name, session, folder });
}

async function connectTo(to: Pick<Reach, "name" | "session" | "folder">, trust?: string[]) {
    mountReach();
    const mine = ++attempt;
    // Asked again from the dialog, what it says stays until the answer, or until it's taking a while: a quick
    // answer would otherwise flash "Connecting…" (or close the dialog and open it again).
    const was = reach();
    if (!was?.shown) setReach({ ...to, issue: { kind: "connecting" }, shown: false });
    const slow = setTimeout(() => attempt === mine && setReach((r) => r && { ...r, issue: r.issue.kind === "connecting" ? r.issue : { kind: "connecting" }, shown: true }), QUIET_MS);
    try {
        // The window that's on the server (it lost it) asks again by its own connection, which waits on this answer.
        if (to.name === machine) {
            if (trust) trustMachine(trust);
            userAsked();
            setMachineIssue({ kind: "connecting" });
            rpc.reconnectNow();
            setReach(undefined);
            return;
        }
        const r = await servers().call("servers.connect", { name: to.name, ahead: true, ...(trust ? { trust } : {}) });
        if (attempt !== mine) return;
        if (r.status === "connected") {
            setReach(undefined);
            switchMachine(to.name, to.session, to.folder);
            return;
        }
        setReach({ ...to, shown: true, issue: r.status === "failed" ? { kind: "failed", problem: r.problem } : r.status === "unknown-host" ? { kind: "unknown-host", unknown: r.unknown } : { kind: r.status } });
    } catch (e) {
        if (attempt === mine) setReach({ ...to, shown: true, issue: { kind: "failed", problem: { message: (e as Error).message } } });
    } finally {
        clearTimeout(slow);
    }
}

/** Says what reaching `to` needs, without trying it again. */
function openReach(to: Pick<Reach, "name" | "session" | "folder">, issue: MachineIssue) {
    mountReach();
    attempt++;
    setReach({ name: to.name, session: to.session, folder: to.folder, issue, shown: true });
}

function cancelReach() {
    attempt++;
    setReach(undefined);
}

// Below what it uses: run as the module loads.
/**
 * A window that was on its server and has lost it keeps what it shows, under the window's own "Reconnecting…" (which
 * says why it can't be reached: lib/machines.ts). Only when getting back needs the user (the server's key is new, it
 * runs another version, Cavvy there was stopped) is it asked, in a dialog over what the window shows.
 */
const needsUser = () => {
    const issue = machineIssue()?.kind;
    return app.hello !== undefined && app.conn !== "open" && (issue === "unknown-host" || issue === "other-version" || issue === "stopped");
};
if (machine)
    createRoot(() =>
        createEffect(
            on(needsUser, (needs) => {
                if (needs) openReach({ name: machine! }, machineIssue()!);
                else if (reach()?.name === machine) setReach(undefined);
            }),
        ),
    );

let reachMounted = false;
function mountReach() {
    if (reachMounted) return;
    reachMounted = true;
    const host = document.createElement("div");
    document.body.append(host);
    render(() => <ReachDialog />, host);
}

/** On this computer: "this Mac", for a sentence. */
const here = HERE === "This Mac" ? "this Mac" : "this computer";

/** In a new session on this computer: an agent there has the provider's CLI and the user's ssh setup. */
async function askAgent(text: string): Promise<void> {
    if (machine) return handOff({ ask: text });
    // The folder doesn't matter to the task: the open project, the last one, else the home folder.
    const cwd = app.homeCwd ?? app.projects[0]?.path ?? app.hello?.homeDir;
    if (!cwd) return;
    try {
        const h = await createSession(cwd, app.homeMode);
        await rpc.call("session.send", { id: h.id, text });
        await activate(h.id);
    } catch (e) {
        // Its configuration needs the user's word first: asked, then sent, so the ask is never lost.
        if (e instanceof RpcError && e.code === "needs_trust") return requestTrust(cwd, () => void askAgent(text).catch(reportError));
        throw e;
    }
}

/** What the agent is told: which server, what was seen, and to ask before changing anything. */
async function agentAsk(name: string, problem: ServerProblem): Promise<string> {
    const s = await servers()
        .call("servers.list", {})
        .then((r) => r.servers.find((x) => x.name === name))
        .catch(() => undefined);
    return [
        `I can't connect to my server ${name}${s && s.destination !== name ? ` (${s.destination})` : ""} from ${here}.`,
        `Cavvy says: ${[problem.message, problem.hint].filter(Boolean).join(" ")}`,
        ...(problem.detail ? [`ssh says: ${problem.detail.replace(/^ssh: /, "")}`] : []),
        ...(s?.provider ? [`It's on ${s.provider}.`] : []),
        "",
        `Find out why, with ${here}'s ssh and the provider's command-line tools, and fix it. Ask me before you change anything.`,
    ].join("\n");
}

/** Reaching a server, over whatever the window shows: connecting, what it asks, or why it can't be reached. */
function ReachDialog() {
    const titleId = createUniqueId();
    const r = () => reach();
    const lost = () => r()?.name === machine;
    // What it's doing, as this computer's Cavvy says it.
    servers().onEvent((e) => {
        const now = r();
        if (e.type === "servers.progress" && now && e.name === now.name && now.issue.kind === "connecting") setReach({ ...now, shown: true, issue: { kind: "connecting", text: e.text, percent: e.percent } });
    });
    const again = (trust?: string[]) => {
        const now = r();
        if (now) void connectTo(now, trust);
    };
    const update = async (force = false) => {
        const now = r();
        if (!now) return;
        setReach({ ...now, updating: true, busy: undefined });
        try {
            const u = await servers().call("servers.update", { name: now.name, force });
            if (reach()?.name !== now.name) return;
            if (u.status === "updated") return again();
            if (u.status === "busy") return setReach({ ...now, updating: false, busy: u.working ? `${u.working} ${u.working === 1 ? "session is" : "sessions are"} working there.` : `${u.waiting} ${u.waiting === 1 ? "session is" : "sessions are"} waiting for you there.` });
            setReach({ ...now, updating: false, issue: u.status === "unknown-host" ? { kind: "unknown-host", unknown: u.unknown } : { kind: "other-version", problem: u.problem } });
        } catch (e) {
            if (reach()?.name === now.name) setReach({ ...now, updating: false, issue: { kind: "other-version", problem: { message: (e as Error).message } } });
        }
    };
    const fix = async (problem: ServerProblem) => {
        const now = r();
        if (!now) return;
        const text = await agentAsk(now.name, problem);
        cancelReach();
        await askAgent(text).catch(reportError);
    };
    // A window that lost its server can't put the question away: it goes back to this computer, or answers it.
    const close = () => !lost() && cancelReach();
    const Leave = () => (
        <button class="btn secondary" onClick={() => (lost() ? switchMachine(undefined) : cancelReach())}>
            {lost() ? HERE : "Cancel"}
        </button>
    );
    const issue = <K extends MachineIssue["kind"]>(kind: K) => (r()?.issue.kind === kind ? (r()!.issue as Extract<MachineIssue, { kind: K }>) : undefined);
    const title = (text: string) => text.replace(/\.$/, "");
    return (
        <Dialog open={Boolean(r()?.shown)} onClose={close} bare labelledBy={titleId} width={440}>
            <div class="server-dialog">
                <Switch>
                    <Match when={r()?.updating}>
                        <h2 id={titleId}>Updating {r()!.name}…</h2>
                        <div class="server-working">
                            <Spinner size={16} />
                        </div>
                    </Match>
                    <Match when={r()?.busy}>
                        {(busy) => (
                            <>
                                <h2 id={titleId}>Stop work on {r()!.name} to update?</h2>
                                <p class="muted">{busy()}</p>
                                <div class="server-actions">
                                    <button class="btn secondary" onClick={() => setReach((now) => now && { ...now, busy: undefined })}>
                                        Cancel
                                    </button>
                                    <button class="btn danger" onClick={() => void update(true)}>
                                        Stop and update
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={issue("connecting")}>
                        {(i) => (
                            <>
                                <h2 id={titleId}>Connecting to {r()!.name}…</h2>
                                <div class="server-working">
                                    <Spinner size={16} />
                                    <Show when={i().text}>
                                        <span>
                                            {i().text}
                                            <Show when={i().percent !== undefined}> {i().percent}%</Show>
                                        </span>
                                    </Show>
                                </div>
                                <div class="server-actions">
                                    <Leave />
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={issue("unknown-host")}>
                        {(i) => (
                            <>
                                <h2 id={titleId}>Trust {i().unknown.host}?</h2>
                                <HostKey unknown={i().unknown} />
                                <div class="server-actions">
                                    <Leave />
                                    <button class="btn primary" onClick={() => again(i().unknown.fingerprints)}>
                                        Trust
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={issue("other-version")}>
                        {(i) => (
                            <>
                                <h2 id={titleId}>Update Cavvy on {r()!.name}?</h2>
                                <p class="muted">It runs another version.</p>
                                <Show when={i().problem}>{(p) => <Problem problem={p()} />}</Show>
                                <div class="server-actions">
                                    <Leave />
                                    <button class="btn primary" onClick={() => void update()}>
                                        Update
                                    </button>
                                </div>
                            </>
                        )}
                    </Match>
                    <Match when={issue("stopped")}>
                        <h2 id={titleId}>Start Cavvy on {r()!.name}?</h2>
                        <p class="muted">It was stopped there.</p>
                        <div class="server-actions">
                            <Leave />
                            <button class="btn primary" onClick={() => again()}>
                                Start
                            </button>
                        </div>
                    </Match>
                    <Match when={issue("failed")}>
                        {(i) => (
                            <>
                                <h2 id={titleId}>{title(i().problem.message)}</h2>
                                <Show when={i().problem.hint} fallback={<Problem problem={{ ...i().problem, message: "" }} />}>
                                    {(hint) => <p class="muted">{hint()}</p>}
                                </Show>
                                <div class="server-actions">
                                    <Leave />
                                    <button class="btn" classList={{ secondary: !i().problem.offline, primary: i().problem.offline }} onClick={() => again()}>
                                        Try again
                                    </button>
                                    <Show when={!i().problem.offline}>
                                        <button class="btn primary" onClick={() => void fix(i().problem)}>
                                            Fix with an agent
                                        </button>
                                    </Show>
                                </div>
                            </>
                        )}
                    </Match>
                </Switch>
            </div>
        </Dialog>
    );
}
