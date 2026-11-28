// Servers, in the desktop app: which machine the window is on (the sidebar's switcher), adding one, and what the
// window shows while it reaches a server. The work is this computer's own Cavvy's (src/servers/manager.ts); here are
// the questions and the words. Loaded when first needed (state/servers.ts), not with the window.

import { children, createEffect, createResource, createSignal, createUniqueId, For, Match, Show, Switch, type JSX } from "solid-js";
import { render } from "solid-js/web";
import { ArrowLeft, Check, ChevronDown, CircleArrowUp, Laptop, Plus, RefreshCw, Server, Trash2 } from "lucide-solid";
import type { AddResult, ServerCheck, ServerProblem, UnknownHost } from "@shared/protocol";
import { homeRpc, machineIssue, setMachineIssue, switchMachine, trustMachine, userAsked } from "../lib/machines";
import { machine, os } from "../lib/platform";
import { updateServer } from "../lib/server-update";
import { app, homeOn, reportError, rpc, setApp, toast, warmLink } from "../state/app";
import { goHomeOn, goingTo } from "../state/go-home";
import { HERE, refreshServerList, serverList, serverTouched, setServerSync } from "../state/servers";
import { Dialog } from "./ui/Dialog";
import { Menu } from "./ui/Menu";
import { Spinner } from "./ui/bits";
import { machineState, watchOthers } from "./OtherMachines";
import "../lib/lent";
import "../styles/servers.css";

// What the window's connection needs of a server (state/app.ts), from the one place this is all loaded from.
export { machineCredentials, setMachineIssue, switchMachine } from "../lib/machines";

/** Where a session made now runs: Home's machine (another's, in a folder of its), else the window's. Undefined: this computer. */
const runsOn = () => {
    const on = homeOn();
    return on === undefined ? machine : on || undefined;
};
/** To `name` (undefined: this computer): Home on the window's own machine, in its latest project, or the window there. */
const goTo = (name: string | undefined) => {
    if (runsOn() === name && !goingTo()) return;
    // One known not to be reachable as it is (can't be reached, stopped, waiting on the user): the window goes there,
    // where the cover says why and what to do, as at once as before.
    const state = name === undefined ? undefined : machineState(name);
    if (state && state !== "connected" && state !== "connecting") return switchMachine(name);
    void goHomeOn(name);
};

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
    watchOthers(HERE);
}

/**
 * Puts, in `el` (the new session's strip, before its project), where the session will run: this computer or a
 * server, and the way to another.
 */
export function mountWhere(el: HTMLElement): () => void {
    return render(
        () => (
            <button class="select home-select" title="Where it runs" aria-haspopup="menu" aria-busy={goingTo() ? "true" : undefined} onClick={(e) => openMachines(e.currentTarget, "end")}>
                <Show when={runsOn()} fallback={<Laptop size={14} />}>
                    <Server size={14} />
                </Show>
                {/* Where a session sent now runs: Home is still there until it has moved (dimmed meanwhile). */}
                <span class="select-value">{runsOn() ?? HERE}</span>
                <ChevronDown size={13} class="select-caret" />
            </button>
        ),
        el,
    );
}

/** Shows, in `el`, what a window on a server shows until it's connected (MachineCover). */
export function mountCover(el: HTMLElement, reconnect: () => void) {
    render(() => <MachineCover reconnect={reconnect} />, el);
}

/**
 * A window that was on its server and has lost it keeps what it shows, under the window's own "Reconnecting…" (which
 * says why it can't be reached: lib/machines.ts). Only when getting back needs the user (the server's key is new, it
 * runs another version, Cavvy there was stopped) does this take the window over, with the question.
 */
const needsUser = () => {
    const issue = machineIssue()?.kind;
    return app.hello !== undefined && app.conn !== "open" && (issue === "unknown-host" || issue === "other-version" || issue === "stopped");
};
if (machine) {
    const host = document.createElement("div");
    document.body.append(host);
    render(
        () => (
            <Show when={needsUser()}>
                <div class="splash server-over" role="alertdialog" aria-label={`Not connected to ${machine}`}>
                    <MachineCover reconnect={() => rpc.reconnectNow()} />
                </div>
            </Show>
        ),
        host,
    );
}

/** What this computer is called in the list of machines. */
// The servers' state, for what else shows them (Settings → Providers, which asks for this module when it opens:
// state/app.ts serversUi): through here, so it comes with this code and nothing that starts with the window carries it.
export { HERE, refreshServerList, serverList, serverTouched, setServerSync };

const servers = () => homeRpc(rpc);

/** Why it didn't work: in words, then what ssh said, then what to run. */
function Problem(p: { problem: ServerProblem }) {
    return (
        <>
            <p class="cover-text">{p.problem.message}</p>
            <Show when={p.problem.detail}>{(d) => <p class="problem-line mono">{d()}</p>}</Show>
            <Show when={p.problem.fix}>{(f) => <p class="cover-text mono">{f()}</p>}</Show>
        </>
    );
}

/** A host's key, a row per kind: "SHA256:… (ED25519)" from src/servers/ssh.ts. */
function HostKey(p: { unknown: UnknownHost }) {
    return (
        <dl class="fp">
            <For each={p.unknown.fingerprints}>
                {(f) => {
                    const m = /^(\S+) \((\S+)\)$/.exec(f);
                    return (
                        <div class="fp-row">
                            <dt>{m?.[2] ?? "Key"}</dt>
                            <dd class="mono">{m?.[1] ?? f}</dd>
                        </div>
                    );
                }}
            </For>
        </dl>
    );
}

/** What a server lacks, a line each: only what the user would act on. */
export function checkLines(name: string, c: ServerCheck): string[] {
    const lines: string[] = [];
    const have = c.clis.filter((x) => x.installed);
    for (const cli of have) {
        if (cli.signedIn === false) lines.push(`${cli.product} isn't signed in there: Settings → Providers.`);
        else if (cli.signedIn === true && cli.on === false) lines.push(`${cli.product} is off there: Settings → Providers.`);
    }
    if (!have.length) lines.push("No agent CLI there. API keys work without one.");
    if (!c.git) lines.push("No git there.");
    if (!c.gh.installed) lines.push("No GitHub CLI there: pull requests need it.");
    else if (c.gh.signedIn === false) lines.push("The GitHub CLI isn't signed in there.");
    if (!c.browser) lines.push("No Chrome there: the Browser tool needs one.");
    if (c.xcode === "missing") lines.push("No Xcode there: iOS and Mac apps need it.");
    else if (c.xcode === "unopened") lines.push("Open Xcode once at that Mac's screen.");
    else if (c.xcode === "no-simulator") lines.push("No iOS simulator there. On it: xcodebuild -downloadPlatform iOS");
    if (!c.service) lines.push(`It won't start again after a reboot.${c.bootFix ? ` On it: ${c.bootFix}` : c.bootHere ? ` In a terminal here: cavvy servers boot ${name}` : ""}`);
    return lines;
}

/** The sidebar's list of machines. */
function ServerMenu(p: { anchor: () => HTMLElement | undefined }) {
    const [list, { refetch }] = createResource(
        () => serverMenu(),
        () =>
            servers()
                .call("servers.list", {})
                .then((r) => r.servers)
                .catch(() => []),
    );
    const close = () => setServerMenu(false);
    const toggleSync = (name: string, next: boolean) => setServerSync(name, next, () => void refetch());
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
        <Menu label="Machines" open={serverMenu()} anchor={p.anchor} onClose={close} align={menuAlign()} width={272} class="menu machine-menu">
            <button role="menuitemradio" aria-checked={!runsOn()} class="menu-item" onClick={() => (close(), goTo(undefined))}>
                <span class="menu-check">
                    <Show when={!runsOn()}>
                        <Check size={14} />
                    </Show>
                </span>
                <span class="menu-item-name">{HERE}</span>
            </button>
            <For each={list() ?? []}>
                {(s) => (
                    <div class="machine-row">
                        <button role="menuitemradio" aria-checked={runsOn() === s.name} class="menu-item" title={s.destination} onPointerEnter={() => runsOn() !== s.name && warmLink(s.name)} onClick={() => (close(), goTo(s.name))}>
                            <span class="menu-check">
                                <Show when={runsOn() === s.name}>
                                    <Check size={14} />
                                </Show>
                            </span>
                            <span class="machine-name">
                                <span class="truncate">{s.name}</span>
                            </span>
                            <Show when={s.cost}>
                                <span class="menu-item-note num">{s.cost}</span>
                            </Show>
                        </button>
                        <span class="machine-acts">
                            <button
                                role="menuitem"
                                class={`icon-btn icon-btn-sm machine-act${s.sync?.state === "error" ? " tone-warn" : ""}`}
                                title={s.sync?.state === "error" ? `Sync failed: ${s.sync.error}` : s.syncOn ? `Stop syncing ${s.name}` : `Sync ${s.name} with ${HERE === "This Mac" ? "this Mac" : "this computer"}`}
                                aria-label={s.syncOn ? `Stop syncing ${s.name}` : `Sync ${s.name}`}
                                aria-pressed={s.syncOn ? "true" : "false"}
                                onClick={() => void toggleSync(s.name, !s.syncOn)}
                            >
                                <RefreshCw size={14} />
                            </button>
                            <Show when={s.behind}>
                                <button role="menuitem" class="icon-btn icon-btn-sm machine-act" title={`Update Cavvy on ${s.name}`} aria-label={`Update Cavvy on ${s.name}`} onClick={() => (close(), void updateServer(s.name))}>
                                    <CircleArrowUp size={14} />
                                </button>
                            </Show>
                            {/* Not the one this window is on: it's removed from another. */}
                            <Show when={machine !== s.name}>
                                <button role="menuitem" class="icon-btn icon-btn-sm machine-act" title={`Remove ${s.name}`} aria-label={`Remove ${s.name}`} onClick={() => void remove(s.name, s.rented)}>
                                    <Trash2 size={14} />
                                </button>
                            </Show>
                        </span>
                    </div>
                )}
            </For>
            <div class="menu-sep" />
            <button role="menuitem" class="menu-item" onClick={() => (close(), setAddServerOpen(true))}>
                <Plus size={14} />
                <span class="menu-item-name">Add server…</span>
            </button>
        </Menu>
    );
}

type AddStep =
    | { at: "form" }
    | { at: "working"; text: string; percent?: number }
    | { at: "trust"; unknown: UnknownHost }
    | { at: "sync"; added: Extract<AddResult, { status: "added" }> }
    | { at: "done"; name: string; note?: string; copied?: string; left?: string; lines?: string[] }
    | { at: "failed"; problem: ServerProblem };

/** Adding a server: its address, its key when it's new to this computer, the one-time copy, and what it lacks. */
function AddServerDialog() {
    const formId = createUniqueId();
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
    const notCopied = (left?: string) => (left ? `Left here, as they could hold a key: ${left}.` : undefined);
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
            else setStep({ at: "sync", added: r });
        } catch (e) {
            setStep({ at: "failed", problem: { message: (e as Error).message } });
        }
    };
    // Kept in sync, or not: either way it's added, and the switch is in the Machines menu after.
    const sync = async (yes: boolean) => {
        const s = step();
        if (s.at !== "sync") return;
        const added = { ...s.added, left: undefined };
        setStep({ at: "working", text: yes ? "Syncing…" : "Finishing…" });
        try {
            await servers().call("servers.setSync", { name: added.name, on: yes });
            if (!yes) return await finish(added);
            const r = (await servers().call("servers.sync", { name: added.name })).results[0];
            await finish(added, r && !r.ok ? r.error : undefined);
        } catch (e) {
            await finish(added, (e as Error).message);
        }
    };

    const here = HERE === "This Mac" ? "this Mac" : "this computer";
    const at = <K extends AddStep["at"]>(k: K) => (step().at === k ? (step() as Extract<AddStep, { at: K }>) : undefined);
    // A title, at most a line under it, the step's own body, and its buttons in the foot. It hangs from the
    // window's top, so a step of another height doesn't move it.
    const title = () => {
        const s = step();
        if (s.at === "form") return "Add a server";
        if (s.at === "working") return `Adding ${name().trim()}`;
        if (s.at === "trust") return `Trust ${s.unknown.host}?`;
        if (s.at === "sync") return `Sync ${s.added.name} with ${here}?`;
        if (s.at === "done") return `${s.name} is ready`;
        return `Couldn't add ${name().trim() || "the server"}`;
    };
    const sub = () => {
        const s = step();
        if (s.at === "trust") return `${HERE} hasn't seen its key before.`;
        if (s.at === "sync") return "Settings, skills, plugins and API keys. Not sign-ins.";
        if (s.at === "failed") return s.problem.message;
        // Ready: what it says about the copy, under the title as the design has it.
        if (s.at === "done") return [s.note, s.copied, s.left].filter(Boolean).join(" ") || undefined;
        return undefined;
    };
    const foot = () => {
        const s = step();
        if (s.at === "working") return undefined;
        return (
            <Switch>
                <Match when={s.at === "form"}>
                    <button type="button" class="btn" onClick={close}>
                        Cancel
                    </button>
                    <button type="submit" form={formId} class="btn btn-primary" disabled={!name().trim() || !destination().trim()}>
                        Add
                    </button>
                </Match>
                <Match when={at("trust")}>
                    {(t) => (
                        <>
                            <button type="button" class="btn" onClick={() => setStep({ at: "form" })}>
                                Cancel
                            </button>
                            <button type="button" class="btn btn-primary" autofocus onClick={() => void add(t().unknown.fingerprints)}>
                                Trust
                            </button>
                        </>
                    )}
                </Match>
                <Match when={s.at === "sync"}>
                    <button type="button" class="btn" onClick={() => void sync(false)}>
                        Not now
                    </button>
                    <button type="button" class="btn btn-primary" autofocus onClick={() => void sync(true)}>
                        Sync
                    </button>
                </Match>
                <Match when={at("done")}>
                    {(d) => (
                        <>
                            <button type="button" class="btn" onClick={close}>
                                Close
                            </button>
                            <button type="button" class="btn btn-primary" autofocus onClick={() => switchMachine(d().name)}>
                                Open {d().name}
                            </button>
                        </>
                    )}
                </Match>
                <Match when={s.at === "failed"}>
                    <button type="button" class="btn" onClick={close}>
                        Cancel
                    </button>
                    <button type="button" class="btn btn-primary" autofocus onClick={() => setStep({ at: "form" })}>
                        Back
                    </button>
                </Match>
            </Switch>
        );
    };

    // Made once per step: the dialog reads it twice (whether there's one, then to show it).
    const footer = children(foot);
    return (
        <Dialog open={addServerOpen()} onClose={close} title={title()} subtitle={sub()} footer={footer()} width={480} class="dlg-top">
            <Switch>
                <Match when={step().at === "form"}>
                    <form
                        id={formId}
                        class="form-stack"
                        onSubmit={(e) => {
                            e.preventDefault();
                            if (name().trim() && destination().trim()) void add();
                        }}
                    >
                        <label class="field">
                            <span class="field-label">Name</span>
                            <input class="input" value={name()} onInput={(e) => setName(e.currentTarget.value)} placeholder="build-box" autocapitalize="off" spellcheck={false} autofocus />
                        </label>
                        <label class="field">
                            <span class="field-label">Address</span>
                            <input class="input mono" value={destination()} onInput={(e) => setDestination(e.currentTarget.value)} placeholder="user@host" autocapitalize="off" spellcheck={false} />
                        </label>
                        <label class="field">
                            <span class="field-label">SSH key file</span>
                            <input class="input mono" value={identity()} onInput={(e) => setIdentity(e.currentTarget.value)} placeholder="Optional" autocapitalize="off" spellcheck={false} />
                        </label>
                    </form>
                </Match>
                <Match when={at("working")}>
                    {(w) => (
                        <div class="progress" role="status">
                            <div class="progress-top">
                                <Spinner size={14} />
                                <span class="progress-text">{w().text}</span>
                                <Show when={w().percent !== undefined}>
                                    <span class="progress-pct num">{w().percent}%</span>
                                </Show>
                            </div>
                            <Show when={w().percent !== undefined}>
                                <span class="bar" data-tone="accent">
                                    <i style={{ width: `${w().percent}%` }} />
                                </span>
                            </Show>
                        </div>
                    )}
                </Match>
                <Match when={at("trust")}>{(t) => <HostKey unknown={t().unknown} />}</Match>
                <Match when={at("done")}>
                    {(d) => (
                        <>
                            <Show when={d().lines?.length}>
                                <ul class="lacks">
                                    <For each={d().lines}>{(l) => <li>{l}</li>}</For>
                                </ul>
                            </Show>
                        </>
                    )}
                </Match>
                <Match when={at("failed")}>
                    {(f) => (
                        <>
                            <Show when={f().problem.detail}>{(d) => <p class="problem-line mono">{d()}</p>}</Show>
                            <Show when={f().problem.fix}>{(x) => <p class="dlg-text mono">{x()}</p>}</Show>
                        </>
                    )}
                </Match>
            </Switch>
        </Dialog>
    );
}

/** What the window shows instead of its sessions while it isn't on its server yet, or has lost it. */
function MachineCover(p: { reconnect: () => void }) {
    const [updating, setUpdating] = createSignal<string>();
    /** Updating would stop work there: what's working, while the user is asked. */
    const [busy, setBusy] = createSignal<string>();
    const retry = () => {
        userAsked();
        setMachineIssue({ kind: "connecting" });
        p.reconnect();
    };
    const update = async (force = false) => {
        if (!machine) return;
        setUpdating(`Updating ${machine}…`);
        try {
            const r = await servers().call("servers.update", { name: machine, force });
            setUpdating(undefined);
            if (r.status === "updated") retry();
            else if (r.status === "busy") setBusy(r.working ? `${r.working} ${r.working === 1 ? "session is" : "sessions are"} working there.` : `${r.waiting} ${r.waiting === 1 ? "session is" : "sessions are"} waiting for you there.`);
            else if (r.status === "unknown-host") setMachineIssue({ kind: "unknown-host", unknown: r.unknown });
            // Still the same question, with why it didn't work: the window's connection waits on the answer to it.
            else setMachineIssue({ kind: "other-version", problem: r.problem });
        } catch (e) {
            setUpdating(undefined);
            setMachineIssue({ kind: "other-version", problem: { message: (e as Error).message } });
        }
    };
    // Made anew wherever it's shown: one element can't be in two of the states below.
    const Back = () => (
        <button type="button" class="btn btn-ghost cover-back" onClick={() => switchMachine(undefined)}>
            <ArrowLeft size={14} />
            {HERE}
        </button>
    );
    // More than "Connecting…": something to read or answer. (The desktop app keeps the last machine's view up until
    // then: desktop-electron/src/preload.ts ASKS.)
    const asks = () => {
        const i = machineIssue();
        return Boolean(updating() || busy()) || (i !== undefined && (i.kind !== "connecting" || i.percent !== undefined));
    };
    type Issue<K extends string> = Extract<NonNullable<ReturnType<typeof machineIssue>>, { kind: K }>;
    const issue = <K extends NonNullable<ReturnType<typeof machineIssue>>["kind"]>(k: K) => (machineIssue()?.kind === k ? (machineIssue() as Issue<K>) : undefined);
    /** The design's cover card: what's happening or asked and where, its details, then the way back and the answer. */
    const Card = (c: { title: string; spin?: boolean; failed?: boolean; back?: boolean; body?: JSX.Element; actions?: JSX.Element }) => {
        // Made once: read twice (whether there's one, then to show it), a prop would make it twice.
        const actions = children(() => c.actions);
        return (
            <section class="cover-card" aria-live="polite">
                <header class="cover-head">
                    <span class="cover-icon" data-tone={c.failed ? "red" : "plain"}>
                        <Show when={c.spin} fallback={<Server size={16} />}>
                            <Spinner size={16} />
                        </Show>
                    </span>
                    <div class="cover-heading">
                        <h1 class="cover-title">{c.title}</h1>
                        <p class="cover-sub mono">{machine}</p>
                    </div>
                </header>
                <div class="cover-body">{c.body}</div>
                <Show when={c.back || actions()}>
                    <footer class="cover-foot">
                        <Show when={c.back}>
                            <Back />
                        </Show>
                        <span class="grow" />
                        {actions()}
                    </footer>
                </Show>
            </section>
        );
    };
    return (
        <div class="server-cover" classList={{ "server-asks": asks() }}>
            <div class="cover">
            <Switch fallback={<Card spin title={updating() ?? `Connecting to ${machine}…`} back />}>
                <Match when={updating()}>{(u) => <Card spin title={u()} />}</Match>
                <Match when={busy()}>
                    {(b) => (
                        <Card
                            title={`Stop work on ${machine} to update?`}
                            body={<p class="cover-text">{b()}</p>}
                            actions={
                                <>
                                    <button type="button" class="btn" onClick={() => setBusy(undefined)}>
                                        Cancel
                                    </button>
                                    <button
                                        type="button"
                                        class="btn btn-danger-solid"
                                        onClick={() => {
                                            setBusy(undefined);
                                            void update(true);
                                        }}
                                    >
                                        Stop and update
                                    </button>
                                </>
                            }
                        />
                    )}
                </Match>
                <Match when={issue("connecting")}>
                    {(i) => (
                        <Card
                            spin
                            title={i().text ?? `Connecting to ${machine}…`}
                            back
                            body={
                                i().percent !== undefined ? (
                                    <div class="progress-inline" role="status">
                                        <span class="bar" data-tone="accent">
                                            <i style={{ width: `${i().percent}%` }} />
                                        </span>
                                        <span class="progress-pct num">{i().percent}%</span>
                                    </div>
                                ) : undefined
                            }
                        />
                    )}
                </Match>
                <Match when={issue("unknown-host")}>
                    {(i) => (
                        <Card
                            title={`Trust ${i().unknown.host}?`}
                            back
                            body={<HostKey unknown={i().unknown} />}
                            actions={
                                <button
                                    type="button"
                                    class="btn btn-primary"
                                    onClick={() => {
                                        trustMachine(i().unknown.fingerprints);
                                        retry();
                                    }}
                                >
                                    Trust
                                </button>
                            }
                        />
                    )}
                </Match>
                <Match when={issue("other-version")}>
                    {(i) => (
                        <Card
                            title={`${machine} runs another version of Cavvy`}
                            back
                            body={i().problem ? <Problem problem={i().problem!} /> : undefined}
                            actions={
                                <button type="button" class="btn btn-primary" onClick={() => void update()}>
                                    Update {machine}
                                </button>
                            }
                        />
                    )}
                </Match>
                <Match when={issue("stopped")}>
                    <Card
                        title={`Start Cavvy on ${machine}?`}
                        back
                        body={<p class="cover-text">It was stopped there.</p>}
                        actions={
                            <button type="button" class="btn btn-primary" onClick={retry}>
                                Start
                            </button>
                        }
                    />
                </Match>
                <Match when={issue("failed")}>
                    {(i) => (
                        <Card
                            title={`Can't connect to ${machine}`}
                            failed
                            back
                            body={<Problem problem={i().problem} />}
                            actions={
                                <button type="button" class="btn btn-primary" onClick={retry}>
                                    Try again
                                </button>
                            }
                        />
                    )}
                </Match>
            </Switch>
            </div>
        </div>
    );
}
