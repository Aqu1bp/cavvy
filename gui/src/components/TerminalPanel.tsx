import { batch, createEffect, createMemo, createSignal, For, lazy, on, onCleanup, Show, untrack } from "solid-js";
import { ChevronDown, KeyRound, Maximize2, Minimize2, Play, Plus, X } from "lucide-solid";
import "../styles/terminal.css";
import { app, connOn, reportError, rpc, toast } from "../state/app";
import { RpcError, type Rpc } from "../lib/rpc";
import { machine } from "../lib/platform";
import { prefs, setPrefs } from "../state/prefs";
import { homeLogin, setHomeLogin, setTerminalLogin, terminalActions, terminalOpen, setTerminalOpen, setSettingsTab, terminalMax, setTerminalMax, setTerminalShown, setTerminalDrag, shellLayout, panelHold, type SetupRun } from "../state/ui";
import { frameDrag } from "../lib/drag";
import { basename, tildify } from "../lib/format";
import { loadTabs, restoreTabs, saveTabs, TerminalClosures } from "../lib/terminal";
import { withShortcut } from "../state/keybindings";
import { terminalAsked, terminalScreenCame } from "../lib/terminal-keys";
import { setupTickets, signInTabs, type Tab } from "../lib/terminal-tabs";

// The screen, with the emulator (xterm, a quarter of what the window loaded before anything showed): loaded once a
// terminal is opened, not with the window.
const TerminalScreen = lazy(() => {
    const since = performance.now();
    return import("./TerminalScreen").then((m) => (terminalScreenCame(since), m));
});
/**
 * Fetched once the window is idle (App): there by the first open. Fetched only then, what was typed in the moment
 * after the click (before it came) went to the composer, and Enter sent it as a message (measured on a Mac).
 */
export const preloadTerminal = () => TerminalScreen.preload();

const MAX_TABS = 12;
/** The terminal is being shown again as the page loads, with the tabs it had: no panel opens a shell for it. */
let reopening = false;
/** Opened by the user while the session in view was still connecting to its machine: its panel starts a shell once it can. */
let openedEarly = false;
/** The terminal was opened, or that's over (navigated away, `false`). A reload putting it back isn't the user opening it. */
export const terminalOpenedEarly = (opened = true) => void (openedEarly = opened && !reopening);

/**
 * Mounted while hidden: each tab keeps its emulator and shell across chat navigation. The tabs are kept
 * in this window's sessionStorage, and come back after a reload to their shells, which the server keeps
 * running for a while when the window goes.
 *
 * One for each machine whose sessions the window has shown (App.tsx): `on` is that machine (awayMachine; none, the
 * window's own) and `link` the connection to its Cavvy, where its shells run. `current`: the session in view is on it.
 */
export function TerminalPanel(p: { cwd?: string; hidden?: boolean; on?: string; link?: Rpc; current?: boolean; showing?: boolean }) {
    const link = p.link ?? rpc;
    const conn = () => connOn(p.on);
    const current = () => p.current !== false;
    // What shows: the current one's, except while an account's sign-in on the window's own machine shows (App.tsx).
    const showing = () => p.showing ?? current();
    // Where its tabs are kept: under the machine the shells are on (lib/terminal.ts tabsKey; "" this computer).
    const at = p.on ?? machine;
    const saved = loadTabs(at);
    const [tabs, setTabs] = createSignal<Tab[]>([]);
    const [selected, setSelected] = createSignal<string | undefined>(saved.selected);
    const currentTabs = () => tabs().filter((t) => t.login || t.cwd === p.cwd);
    const active = () => currentTabs().find((t) => t.id === selected()) ?? currentTabs().at(-1);
    const visible = () => showing() && terminalOpen() && !p.hidden && (!!p.cwd || currentTabs().some((t) => t.login));
    // The sheet gives the panel its row while it shows: the one that's showing says.
    createEffect(() => { if (showing()) setTerminalShown(visible()); });
    let next = saved.next;
    // Not saved until the saved tabs are back, which would lose them to a reload meanwhile.
    const [restored, setRestored] = createSignal(false);
    let restoring = false;
    let disposed = false;
    /** Opened by the user before its tabs were back: a shell starts once they are, if there's none. */
    let asked = false;
    onCleanup(() => { disposed = true; });
    const save = () => {
        if (restored()) saveTabs({ tabs: tabs().map(({ attach: _, closing: __, ...t }) => t), next, open: terminalOpen(), selected: selected(), closed: closes.ids }, at);
    };
    const closes = new TerminalClosures(saved.closed ?? [], link, save);
    createEffect(on([tabs, selected, terminalOpen], save));
    // Main's RPC intentionally rejects offline calls. Reconcile only after a live
    // connection, and retry if that connection disappears before the list arrives.
    const restore = async () => {
        if (restored() || restoring) return;
        restoring = true;
        try {
            await closes.flush();
            const listed = await link.call("terminal.list", {});
            if (disposed) return;
            const back = restoreTabs({ ...saved, closed: closes.ids }, listed);
            next = Math.max(next, back.next);
            setTabs(back.tabs.map((t) => ({ ...t, attach: true })));
            // Whether the panel shows is the window's: only its own machine's tabs, restored as the page loads, say.
            if (back.open && back.tabs.length && p.on === undefined) {
                reopening = true;
                setTerminalOpen(true);
                reopening = false;
            }
            setRestored(true);
            // An explicit panel opening while its list was loading still starts the first shell.
            if (asked && current() && showing() && terminalOpen() && !p.hidden && !currentTabs().length) add();
            asked = false;
            save();
        } catch (e) {
            if (!(e instanceof RpcError && e.code === "disconnected")) reportError(e);
        } finally { restoring = false; }
    };
    createEffect(() => {
        if (conn() !== "open") return;
        if (!restored()) void restore();
        else void closes.flush();
    });
    const full = () => tabs().length >= MAX_TABS;
    const add = () => {
        if (!restored() || !p.cwd || conn() !== "open" || full()) return;
        const id = crypto.randomUUID();
        const tab = { id, cwd: p.cwd, number: next++, terminal: id };
        terminalAsked();
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
    };
    // A click on a project script: its own tab, shown, with the command typed into its shell.
    const runScript = (cwd: string, script: { id: string; name: string }, setup?: SetupRun): void => {
        // A new worktree's setup run that can't start: the worktree is there, and the script can be run by hand.
        // Run tries it again as a plain script run: then a failure says why.
        const cant = (plain: string): void => (setup ? toast("Setup script didn't run", "warn", { label: "Run", run: () => runScript(cwd, script) }) : toast(plain, "error"));
        if (!restored()) return cant("Terminal tabs are reconnecting. Try again in a moment.");
        if (conn() !== "open") return cant(`Not connected to Cavvy server, so “${script.name}” can't start.`);
        if (full()) return cant(`${MAX_TABS} terminals are open, counting other projects. Close one to run “${script.name}”.`);
        const id = crypto.randomUUID();
        // The session's: a sign-in tab of the window's own machine no longer holds the view.
        setTerminalLogin(false);
        const tab = { id, terminal: id, cwd, number: next++, script: { id: script.id, name: script.name, ...(setup ? { setup: { label: setup.label, command: setup.command } } : {}) } };
        if (setup) setupTickets.set(tab.id, setup.ticket);
        terminalAsked();
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
        setTerminalOpen(true);
    };
    const loginAccount = (provider: string, accountId: string, name: string, server?: string, install?: boolean) => {
        if (!restored()) return toast("Terminal tabs are reconnecting. Try again in a moment.");
        if (conn() !== "open" || full()) return toast(install ? "Close a terminal, then try again" : "Connect and close a terminal before signing in", "warn");
        const id = crypto.randomUUID();
        const tab: Tab = { id, terminal: id, cwd: app.hello?.homeDir ?? "/", number: next++, login: { provider, accountId, name, server, ...(install ? { install } : {}) } };
        terminalAsked();
        // Shown though a session of another machine is in view: the sign-in is this one's (App.tsx).
        setTerminalLogin({ on: p.on });
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
        setSettingsTab(undefined);
        setTerminalOpen(true);
    };
    // A sign-in card's "Open in terminal": a tab in the session's folder with the command typed in, not run.
    const signIn = (session: string, interaction: string) => {
        if (!restored() || !p.cwd || conn() !== "open" || full()) return toast("Close a terminal, then try again", "warn"), false;
        const id = crypto.randomUUID();
        setTerminalLogin(false);
        signInTabs.set(id, { session, interaction });
        terminalAsked();
        setTabs((all) => [...all, { id, cwd: p.cwd!, number: next++, terminal: id }]);
        setSelected(id);
        setTerminalOpen(true);
        return true;
    };
    // What opens a tab from elsewhere opens it on the machine of the session in view: this panel's, while it's that one.
    // Signing an account in is the window's own machine's (Settings).
    createEffect(() => {
        if (!current()) return;
        terminalActions.signIn = signIn;
        terminalActions.runScript = runScript;
        onCleanup(() => {
            if (terminalActions.signIn === signIn) delete terminalActions.signIn;
            if (terminalActions.runScript === runScript) delete terminalActions.runScript;
        });
    });
    if (p.on === undefined) {
        terminalActions.loginAccount = loginAccount;
        const installCli = (provider: string, name: string, server?: string) => loginAccount(provider, "default", name, server, true);
        terminalActions.installCli = installCli;
        onCleanup(() => {
            if (terminalActions.loginAccount === loginAccount) delete terminalActions.loginAccount;
            if (terminalActions.installCli === installCli) delete terminalActions.installCli;
        });
    }
    // The user's own computer's, in a window on a server: a sign-in or install asked for there from Settings
    // (SubscriptionGrid.tsx) opens here once this panel can take it.
    if (p.on === "") {
        createEffect(() => {
            const ask = homeLogin();
            if (!ask || !restored() || conn() !== "open") return;
            setHomeLogin(undefined);
            untrack(() => loginAccount(ask.provider, ask.accountId, ask.name, ask.server, ask.install));
        });
    }
    // Opening the panel starts a shell where there's none; going to another project with it open doesn't.
    // (Not when it's shown again after a reload, with the tabs it had.)
    createEffect(on(terminalOpen, (open) => {
        if (!open) asked = openedEarly = false;
        if (!open || reopening || !current() || !showing()) return;
        if (!restored()) asked = true;
        // Opened by the user: its terminal takes the keyboard, even from a card that waits (lib/terminal-keys.ts).
        terminalAsked();
        if (!p.hidden && !currentTabs().length) add();
    }, { defer: true }));
    // Opened before the session in view could say whose panel it was: this one's, once it's that one and ready.
    createEffect(() => {
        if (!restored() || !current() || !showing() || p.hidden || !openedEarly) return;
        openedEarly = false;
        if (terminalOpen() && !p.hidden && !currentTabs().length) add();
    });
    const close = (tab: Tab) => {
        tab.closing = true;
        // Not shown yet (its screen still coming): what it would have taken goes with it.
        setupTickets.delete(tab.id);
        signInTabs.delete(tab.id);
        if (currentTabs().length === 1) setTerminalOpen(false);
        // The sign-in was what held the window's own terminal in view: the session's machine's shows again.
        if (tab.login) setTerminalLogin(false);
        setTabs((all) => all.filter((t) => t !== tab));
    };
    let panel: HTMLElement | undefined;
    // The conversation keeps its room above the terminal (lib/layout.ts); dragging ends a maximized terminal.
    const clampHeight = (h: number) => Math.round(Math.max(120, Math.min(shellLayout().terminal.most, h)));
    const setHeight = (h: number) => setPrefs("terminalHeight", clampHeight(h));
    const [dragging, setDragging] = createSignal(false);
    /** Ends the drag under way, if any: on release, and when the panel goes away in the middle of one. */
    let stopDrag: (() => void) | undefined;
    onCleanup(() => stopDrag?.());
    const resize = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        stopDrag?.();
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        const y = e.clientY;
        const height = panel?.offsetHeight ?? 260;
        setTerminalMax(false);
        setDragging(true);
        // Shown once a frame, saved to the preferences on release.
        const drag = frameDrag({
            show: setTerminalDrag,
            commit: (h) => batch(() => {
                if (h !== undefined) setPrefs("terminalHeight", h);
                setTerminalDrag(undefined);
            }),
        });
        const move = (event: PointerEvent) => drag.move(clampHeight(height + y - event.clientY));
        const end = () => { stopDrag = undefined; drag.end(); setDragging(false); target.removeEventListener("pointermove", move); target.removeEventListener("lostpointercapture", end); };
        stopDrag = end;
        target.addEventListener("pointermove", move);
        target.addEventListener("lostpointercapture", end);
    };
    // A tab whose shell has ended (or is away): its name is dimmed, as the design has it.
    const [endedTabs, setEndedTabs] = createSignal<Record<string, boolean>>({});
    const tabLabel = (tab: Tab) => (tab.login ? (tab.login.install ? tab.login.name : `Sign in · ${tab.login.name}`) : tab.script ? (tab.script.setup?.label ?? tab.script.name) : undefined);
    const canAdd = () => restored() && conn() === "open" && !full();
    return (
        <section ref={panel} class={`terminal terminal-panel ${terminalMax() ? "max" : ""} ${dragging() ? "dragging" : ""}`} classList={{ held: !!panelHold() }} aria-label="Terminal panel"
            style={{ display: visible() ? "flex" : "none", width: panelHold() && `${panelHold()!.sheetWidth}px`, height: panelHold() && `${panelHold()!.terminal}px` }}>
            <div class="terminal-resizer" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" tabIndex={0} data-dragging={dragging() || undefined} onPointerDown={resize}
                onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setTerminalMax(false); setHeight((panel?.offsetHeight ?? prefs.terminalHeight) + (e.key === "ArrowUp" ? 24 : -24)); } }} />
            <header class="terminal-bar">
                <div class="terminal-tabs" role="tablist" aria-label="Terminals">
                    <For each={currentTabs()}>{(tab) => <div class="terminal-tab" role="presentation" data-active={active()?.id === tab.id || undefined} data-ended={endedTabs()[tab.id] || undefined}>
                        <button role="tab" class="terminal-tab-main" aria-selected={active()?.id === tab.id} onClick={() => { terminalAsked(); setSelected(tab.id); }} title={tab.script?.setup ? `Setup script “${tab.script.name}” in ${tab.cwd}: ${tab.script.setup.command}` : tab.script ? `Script “${tab.script.name}” in ${tab.cwd}` : tab.cwd}>
                            {tab.script ? <Play size={11} fill="currentColor" stroke-width={0} /> : tab.login && !tab.login.install ? <KeyRound size={12} /> : undefined}
                            <span class="truncate">{tabLabel(tab) ?? basename(tab.cwd)}</span>
                            {tabLabel(tab) ? undefined : <span class="terminal-tab-n">{tab.number}</span>}
                        </button>
                        <button class="terminal-tab-close" title="Close terminal and stop its shell" aria-label={tab.script ? `Close terminal ${tab.script.setup?.label ?? tab.script.name}` : `Close terminal ${tab.number}`} onClick={() => close(tab)}><X size={12} /></button>
                    </div>}</For>
                    <button class="icon-btn icon-btn-sm terminal-new" title={full() ? `${MAX_TABS} terminals are open in this window` : "New terminal"} aria-label="New terminal" aria-disabled={!canAdd() || undefined} data-disabled={!canAdd() || undefined} onClick={() => canAdd() && add()}><Plus size={14} /></button>
                </div>
                <span class="terminal-cwd mono" title={p.cwd}>{tildify(p.cwd ?? "", app.hello?.homeDir)}</span>
                <button class="icon-btn icon-btn-sm" title={terminalMax() ? "Restore" : "Maximize"} aria-label={terminalMax() ? "Restore terminal size" : "Maximize terminal"} aria-pressed={terminalMax()} onClick={() => setTerminalMax(!terminalMax())}>{terminalMax() ? <Minimize2 size={13} /> : <Maximize2 size={13} />}</button>
                <button class="icon-btn icon-btn-sm" title={withShortcut("Hide terminal", "app:toggleTerminal")} aria-label="Hide terminal" onClick={() => setTerminalOpen(false)}><ChevronDown size={14} /></button>
            </header>
            <div class="terminal-body">
                <Show when={!currentTabs().length}>
                    <div class="blank">
                        <p class="blank-title">{full() ? `${MAX_TABS} terminals are open in other projects. Close one to open one here.` : conn() !== "open" ? "Not connected to Cavvy server." : "No terminal in this project."}</p>
                        <Show when={!full() && conn() === "open"}><button class="btn btn-sm" disabled={!restored()} onClick={add}><Plus size={13} /> New terminal</button></Show>
                    </div>
                </Show>
                {/* `shown` worked out once, owned by the tab: `visible={a() && b()}` makes a memo each time it's read, and the
                    screen reads it from resize frames and after awaits, where nothing owns it: each was kept for good. */}
                <For each={tabs()}>{(tab) => { const shown = createMemo(() => visible() && active()?.id === tab.id); return <TerminalScreen tab={tab} visible={shown()} link={link} conn={conn} onEnded={(e) => setEndedTabs((all) => ({ ...all, [tab.id]: e }))} onClose={(terminal) => { if (tab.closing) closes.close(terminal); }} onRestart={async (terminal, previous) => {
                    if (previous) {
                        try { await link.call("terminal.close", { id: previous }); }
                        catch (e) {
                            if (e instanceof RpcError && e.code === "disconnected") closes.close(previous);
                            if (!(e instanceof RpcError && e.code === "terminal_not_open")) throw e;
                        }
                    }
                    tab.terminal = terminal; save();
                }} />; }}</For>
            </div>
        </section>
    );
}
