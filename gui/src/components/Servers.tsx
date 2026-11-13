// Servers, in the desktop app: which machine the window is on (the sidebar's switcher), adding one, and what the
// window shows while it reaches a server. The work is this computer's own Cavvy's (src/servers/manager.ts); here are
// the questions and the words. Loaded when first needed (state/servers.ts), not with the window.

import { createEffect, createResource, createSignal, createUniqueId, For, Match, Show, Switch } from "solid-js";
import { render } from "solid-js/web";
import { Check, ChevronDown, Plus, Server, Trash2 } from "lucide-solid";
import type { AddResult, ServerCheck, ServerProblem, UnknownHost } from "@shared/protocol";
import { homeRpc, machineIssue, setMachineIssue, switchMachine, trustMachine, userAsked } from "../lib/machines";
import { machine, os } from "../lib/platform";
import { app, reportError, rpc, setApp, toast } from "../state/app";
import { Dialog } from "./ui/Dialog";
import { Menu } from "./ui/Menu";
import { Logo, Spinner } from "./ui/bits";
import { watchOthers } from "./OtherMachines";
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
 * Opens the list of machines under `anchor` (the sidebar's button), or closes it. The list and the dialog it leads
 * to are put on the page the first time: none of this is loaded before the button is pressed.
 */
export function openMachines(anchor: HTMLElement, align: "start" | "end" = "end") {
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
export const HERE = os === "macos" ? "This Mac" : "This computer";

const servers = () => homeRpc(rpc);

function Problem(p: { problem: ServerProblem }) {
    return (
        <div class="server-problem">
            <p>{p.problem.message}</p>
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
    // It can be put back, so nothing is asked first.
    const remove = async (name: string) => {
        close();
        try {
            await servers().call("servers.remove", { name });
            toast(`Removed ${name}`, "info", { label: "Undo", run: () => servers().call("servers.restore", { name }).then(() => undefined) });
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
                        <button role="menuitemradio" aria-checked={machine === s.name} class="menu-item compact grow" title={s.destination} onClick={() => (close(), machine !== s.name && switchMachine(s.name))}>
                            <span class="grow">{s.name}</span>
                            <Show when={machine === s.name}>
                                <Check size={14} />
                            </Show>
                        </button>
                        {/* Not the one this window is on: it's removed from another. */}
                        <Show when={machine !== s.name}>
                            <button role="menuitem" class="hb" title={`Remove ${s.name}`} aria-label={`Remove ${s.name}`} onClick={() => void remove(s.name)}>
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
                                    <button class="btn primary" onClick={() => switchMachine(s().name)}>
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
        <button class="btn secondary" onClick={() => switchMachine(undefined)}>
            {HERE}
        </button>
    );
    return (
        <div class="server-cover">
            <Switch
                fallback={
                    <>
                        <Logo size={44} />
                        <Spinner size={18} />
                        <div class="muted">{updating() ?? `Connecting to ${machine}…`}</div>
                        <Back />
                    </>
                }
            >
                <Match when={updating()}>
                    <Logo size={44} />
                    <Spinner size={18} />
                    <div class="muted">{updating()}</div>
                </Match>
                <Match when={busy()}>
                    <Server size={36} />
                    <h2>Stop work on {machine} to update?</h2>
                    <p class="muted">{busy()}</p>
                    <div class="server-actions">
                        <button class="btn secondary" onClick={() => setBusy(undefined)}>
                            Cancel
                        </button>
                        <button
                            class="btn danger"
                            onClick={() => {
                                setBusy(undefined);
                                void update(true);
                            }}
                        >
                            Stop and update
                        </button>
                    </div>
                </Match>
                <Match when={machineIssue()?.kind === "connecting" && (machineIssue() as Extract<ReturnType<typeof machineIssue>, { kind: "connecting" }>)}>
                    {(i) => (
                        <>
                            <Logo size={44} />
                            <Spinner size={18} />
                            <div class="muted">
                                {i().text ?? `Connecting to ${machine}…`}
                                <Show when={i().percent !== undefined}> {i().percent}%</Show>
                            </div>
                            <Back />
                        </>
                    )}
                </Match>
                <Match when={machineIssue()?.kind === "unknown-host" && (machineIssue() as Extract<ReturnType<typeof machineIssue>, { kind: "unknown-host" }>)}>
                    {(i) => (
                        <>
                            <Server size={36} />
                            <h2>Trust {i().unknown.host}?</h2>
                            <HostKey unknown={i().unknown} />
                            <div class="server-actions">
                                <Back />
                                <button
                                    class="btn primary"
                                    onClick={() => {
                                        trustMachine(i().unknown.fingerprints);
                                        retry();
                                    }}
                                >
                                    Trust
                                </button>
                            </div>
                        </>
                    )}
                </Match>
                <Match when={machineIssue()?.kind === "other-version" && (machineIssue() as Extract<ReturnType<typeof machineIssue>, { kind: "other-version" }>)}>
                    {(i) => (
                        <>
                            <Server size={36} />
                            <h2>{machine} runs another version of Cavvy</h2>
                            <Show when={i().problem}>{(p) => <Problem problem={p()} />}</Show>
                            <div class="server-actions">
                                <Back />
                                <button class="btn primary" onClick={() => void update()}>
                                    Update {machine}
                                </button>
                            </div>
                        </>
                    )}
                </Match>
                <Match when={machineIssue()?.kind === "stopped"}>
                    <Server size={36} />
                    <h2>Start Cavvy on {machine}?</h2>
                    <p class="muted">It was stopped there.</p>
                    <div class="server-actions">
                        <Back />
                        <button class="btn primary" onClick={retry}>
                            Start
                        </button>
                    </div>
                </Match>
                <Match when={machineIssue()?.kind === "failed" && (machineIssue() as Extract<ReturnType<typeof machineIssue>, { kind: "failed" }>)}>
                    {(i) => (
                        <>
                            <Server size={36} class="tone-warn" />
                            <h2>Can't connect to {machine}</h2>
                            <Problem problem={i().problem} />
                            <div class="server-actions">
                                <Back />
                                <button class="btn primary" onClick={retry}>
                                    Try again
                                </button>
                            </div>
                        </>
                    )}
                </Match>
            </Switch>
        </div>
    );
}
