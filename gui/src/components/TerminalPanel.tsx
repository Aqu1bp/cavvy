import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ChevronDown, Maximize2, Minimize2, Play, Plus, RotateCw, TerminalIcon, X } from "lucide-solid";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";
import { app, refreshProviders, reportError, rpc, toast, trustRequest } from "../state/app";
import { RpcError } from "../lib/rpc";
import { prefs, setPrefs } from "../state/prefs";
import { terminalActions, terminalOpen, setTerminalOpen, setSettingsTab, setupObscured, terminalMax, setTerminalMax, setTerminalShown, shellLayout, type SetupRun } from "../state/ui";
import { basename, tildify } from "../lib/format";
import { EarlyInput, loadTabs, restoreTabs, saveTabs, TerminalClosures, terminalInputChunks, type SavedTab } from "../lib/terminal";
import { isTerminalReply } from "@shared/terminal-reply";
import { copyText, isMod } from "../lib/platform";
import { terminalKey, withShortcut } from "../state/keybindings";

/**
 * `script`: the project script the tab was opened to run (once: restarting it gives a plain shell), and is named after.
 * `terminal`: its shell's id (a restart gives a new one). `attach`: the shell was running before this page loaded
 * (it was reloaded): the tab attaches to it, and never runs its script.
 */
interface Tab extends SavedTab { attach?: boolean; closing?: boolean }
const MAX_TABS = 12;
/** Setup tickets by tab, taken by the tab's first shell: kept off the tab so nothing that keeps tabs keeps one. */
const setupTickets = new Map<string, string>();

/**
 * Mounted while hidden: each tab keeps its emulator and shell across chat navigation. The tabs are kept
 * in this window's sessionStorage, and come back after a reload to their shells, which the server keeps
 * running for a while when the window goes.
 */
export function TerminalPanel(p: { cwd?: string; hidden?: boolean }) {
    const saved = loadTabs();
    const [tabs, setTabs] = createSignal<Tab[]>([]);
    const [selected, setSelected] = createSignal<string | undefined>(saved.selected);
    const currentTabs = () => tabs().filter((t) => t.login || t.cwd === p.cwd);
    const active = () => currentTabs().find((t) => t.id === selected()) ?? currentTabs().at(-1);
    const visible = () => terminalOpen() && !p.hidden && (!!p.cwd || currentTabs().some((t) => t.login));
    // The sheet gives the panel its row while it shows.
    createEffect(() => setTerminalShown(visible()));
    let next = saved.next;
    // Not saved until the saved tabs are back, which would lose them to a reload meanwhile.
    const [restored, setRestored] = createSignal(false);
    let restoring = false;
    let disposed = false;
    onCleanup(() => { disposed = true; });
    let reopening = false;
    const save = () => {
        if (restored()) saveTabs({ tabs: tabs().map(({ attach: _, closing: __, ...t }) => t), next, open: terminalOpen(), selected: selected(), closed: closes.ids });
    };
    const closes = new TerminalClosures(saved.closed ?? [], rpc, save);
    createEffect(on([tabs, selected, terminalOpen], save));
    // Main's RPC intentionally rejects offline calls. Reconcile only after a live
    // connection, and retry if that connection disappears before the list arrives.
    const restore = async () => {
        if (restored() || restoring) return;
        restoring = true;
        try {
            await closes.flush();
            const listed = await rpc.call("terminal.list", {});
            if (disposed) return;
            const back = restoreTabs({ ...saved, closed: closes.ids }, listed);
            next = Math.max(next, back.next);
            setTabs(back.tabs.map((t) => ({ ...t, attach: true })));
            if (back.open && back.tabs.length) {
                reopening = true;
                setTerminalOpen(true);
                reopening = false;
            }
            setRestored(true);
            // An explicit panel opening while its list was loading still starts the first shell.
            if (terminalOpen() && !back.open && !p.hidden && !currentTabs().length) add();
            save();
        } catch (e) {
            if (!(e instanceof RpcError && e.code === "disconnected")) reportError(e);
        } finally { restoring = false; }
    };
    createEffect(() => {
        if (app.conn !== "open") return;
        if (!restored()) void restore();
        else void closes.flush();
    });
    const full = () => tabs().length >= MAX_TABS;
    const add = () => {
        if (!restored() || !p.cwd || app.conn !== "open" || full()) return;
        const id = crypto.randomUUID();
        const tab = { id, cwd: p.cwd, number: next++, terminal: id };
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
    };
    // A click on a project script: its own tab, shown, with the command typed into its shell.
    const runScript = (cwd: string, script: { id: string; name: string }, setup?: SetupRun) => {
        // A new worktree's setup run that can't start: the worktree is there, and the script can be run by hand.
        const cant = (why: string, plain: string) => (setup ? toast(`The worktree was created, but its setup script “${script.name}” didn't run: ${why} You can run it from the project scripts menu.`, "warn") : toast(plain, "error"));
        if (!restored()) return cant("terminal tabs are reconnecting.", "Terminal tabs are reconnecting. Try again in a moment.");
        if (app.conn !== "open") return cant("not connected to the harness server.", `Not connected to the harness server, so “${script.name}” can't start.`);
        if (full()) return cant(`${MAX_TABS} terminals are open in this window.`, `${MAX_TABS} terminals are open in this window, some maybe in other projects. Close one to run “${script.name}”.`);
        const id = crypto.randomUUID();
        const tab = { id, terminal: id, cwd, number: next++, script: { id: script.id, name: script.name, ...(setup ? { setup: { label: setup.label, command: setup.command } } : {}) } };
        if (setup) setupTickets.set(tab.id, setup.ticket);
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
        setTerminalOpen(true);
    };
    const loginAccount = (provider: string, accountId: string, name: string) => {
        if (!restored()) return toast("Terminal tabs are reconnecting. Try again in a moment.");
        if (app.conn !== "open" || full()) return toast("Connect and close a terminal before signing in", "warn");
        const id = crypto.randomUUID();
        const tab: Tab = { id, terminal: id, cwd: app.hello?.homeDir ?? "/", number: next++, login: { provider, accountId, name } };
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
        setSettingsTab(undefined);
        setTerminalOpen(true);
    };
    terminalActions.loginAccount = loginAccount;
    onCleanup(() => { if (terminalActions.loginAccount === loginAccount) delete terminalActions.loginAccount; });
    terminalActions.runScript = runScript;
    onCleanup(() => { if (terminalActions.runScript === runScript) delete terminalActions.runScript; });
    // Opening the panel starts a shell where there's none; going to another project with it open doesn't.
    // (Not when it's shown again after a reload, with the tabs it had.)
    createEffect(on(terminalOpen, (open) => { if (open && !reopening && !p.hidden && !currentTabs().length) add(); }, { defer: true }));
    const close = (tab: Tab) => {
        tab.closing = true;
        if (currentTabs().length === 1) setTerminalOpen(false);
        setTabs((all) => all.filter((t) => t !== tab));
    };
    let panel: HTMLElement | undefined;
    // The conversation keeps its room above the terminal (lib/layout.ts); dragging ends a maximized terminal.
    const setHeight = (h: number) => setPrefs("terminalHeight", Math.round(Math.max(120, Math.min(shellLayout().terminal.most, h))));
    const [dragging, setDragging] = createSignal(false);
    const resize = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        const y = e.clientY;
        const height = panel?.offsetHeight ?? 260;
        setTerminalMax(false);
        setDragging(true);
        const move = (event: PointerEvent) => setHeight(height + y - event.clientY);
        const end = () => { setDragging(false); target.removeEventListener("pointermove", move); target.removeEventListener("lostpointercapture", end); };
        target.addEventListener("pointermove", move);
        target.addEventListener("lostpointercapture", end);
    };
    return (
        <section ref={panel} class={`terminal-panel ${terminalMax() ? "max" : ""} ${dragging() ? "dragging" : ""}`} aria-label="Terminal panel" style={{ display: visible() ? "flex" : "none" }}>
            <div class="terminal-resize" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" tabIndex={0} onPointerDown={resize}
                onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setTerminalMax(false); setHeight((panel?.offsetHeight ?? prefs.terminalHeight) + (e.key === "ArrowUp" ? 24 : -24)); } }} />
            <div class="terminal-toolbar">
                <div class="terminal-tabs" role="tablist" aria-label="Terminals">
                    <For each={currentTabs()}>{(tab) => <div class={`terminal-tab ${active()?.id === tab.id ? "on" : ""}`}>
                        <button role="tab" aria-selected={active()?.id === tab.id} onClick={() => setSelected(tab.id)} title={tab.script?.setup ? `Setup script “${tab.script.name}” in ${tab.cwd}: ${tab.script.setup.command}` : tab.script ? `Script “${tab.script.name}” in ${tab.cwd}` : tab.cwd}>{tab.script ? <Play size={11} class="terminal-tab-icon" /> : <TerminalIcon size={13} class="terminal-tab-icon" />}{tab.login ? `Sign in · ${tab.login.name}` : tab.script ? (tab.script.setup?.label ?? tab.script.name) : `${basename(tab.cwd)} ${tab.number}`}</button>
                        <button class="hb sm terminal-tab-x" title="Close terminal and stop its shell" aria-label={tab.script ? `Close terminal ${tab.script.setup?.label ?? tab.script.name}` : `Close terminal ${tab.number}`} onClick={() => close(tab)}><X size={12} /></button>
                    </div>}</For>
                </div>
                <button class="hb sm" title={full() ? `${MAX_TABS} terminals are open in this window` : "New terminal"} aria-label="New terminal" disabled={!restored() || app.conn !== "open" || full()} onClick={add}><Plus size={15} /></button>
                <span class="terminal-cwd truncate" title={p.cwd}>{tildify(p.cwd ?? "", app.hello?.homeDir)}</span>
                <button class="hb sm" title={terminalMax() ? "Restore" : "Maximize"} aria-label={terminalMax() ? "Restore terminal size" : "Maximize terminal"} aria-pressed={terminalMax()} onClick={() => setTerminalMax(!terminalMax())}>{terminalMax() ? <Minimize2 size={14} /> : <Maximize2 size={14} />}</button>
                <button class="hb sm" title={withShortcut("Hide terminal", "app:toggleTerminal")} aria-label="Hide terminal" onClick={() => setTerminalOpen(false)}><ChevronDown size={15} /></button>
            </div>
            <Show when={!currentTabs().length}>
                <div class="terminal-message">
                    <span>{full() ? `${MAX_TABS} terminals are open in this window, some in other projects. Close one to open a terminal here.` : app.conn !== "open" ? "Not connected to the harness server." : "No terminal in this project."}</span>
                    <Show when={!full()}><button class="btn secondary sm" disabled={!restored() || app.conn !== "open"} onClick={add}><Plus size={12} /> New terminal</button></Show>
                </div>
            </Show>
            <For each={tabs()}>{(tab) => <TerminalScreen tab={tab} visible={visible() && active()?.id === tab.id} onClose={(terminal) => { if (tab.closing) closes.close(terminal); }} onRestart={async (terminal, previous) => {
                if (previous) {
                    try { await rpc.call("terminal.close", { id: previous }); }
                    catch (e) {
                        if (e instanceof RpcError && e.code === "disconnected") closes.close(previous);
                        if (!(e instanceof RpcError && e.code === "terminal_not_open")) throw e;
                    }
                }
                tab.terminal = terminal; save();
            }} />}</For>
        </section>
    );
}

function TerminalScreen(p: { tab: Tab; visible: boolean; onClose: (terminal: string) => void; onRestart: (terminal: string, previous?: string) => Promise<void> }) {
    let container!: HTMLDivElement;
    let term: Terminal;
    let fit: FitAddon;
    let disposed = false;
    /** Its shell is running and attached here: input, resizes and acks go to it. */
    let opened = false;
    let id = p.tab.terminal;
    // Typed by the first shell only: a restart, a reconnect or a reload never runs it again.
    let script = p.tab.attach ? undefined : p.tab.script;
    /** The server keeps a shell for this tab that it attaches to (again) rather than opening one. */
    let attach = !!p.tab.attach;
    /** Shown in another window now (a copy of this one): not this tab's to close. */
    let moved = false;
    /** Where in its shell's output this screen is (the last terminal.data's `pos`), so a reconnect gets only the rest. */
    let pos: number | undefined;
    /** Output from before a restart or a disconnect isn't acked: the server no longer counts it. */
    let epoch = 0;
    let attaching = false;
    let attachment = 0;
    let replayWrites = 0;
    onCleanup(() => setupTickets.delete(p.tab.id));
    const early = new EarlyInput();
    const send = (data: string) => {
        // A pasted command may exceed one RPC's input limit. Preserve order.
        // Typed as the shell exits: it's gone, which the exit message says.
        for (const chunk of terminalInputChunks(data)) void rpc.call("terminal.write", { id, data: chunk }).catch((e) => { if (!(e instanceof RpcError && e.code === "terminal_not_open")) reportError(e); });
    };
    let fitting = 0;
    // Flow control: the server holds output back until what it sent has been drawn.
    let drawn = 0;
    let acking: ReturnType<typeof setTimeout> | undefined;
    const ack = () => {
        clearTimeout(acking);
        acking = undefined;
        const chars = drawn;
        drawn = 0;
        // The server knows the shell before it sends any output, and ignores acks for one that has gone.
        if (chars && app.conn === "open") void rpc.call("terminal.ack", { id, chars }).catch(() => {});
    };
    const forgetDrawn = () => {
        clearTimeout(acking);
        acking = undefined;
        drawn = 0;
        epoch++;
    };
    const [ended, setEnded] = createSignal<string>();
    const exited = (code: number) => {
        opened = false;
        attach = true;
        setEnded(`${p.tab.login ? "Login" : "Shell"} exited (${code})`);
        if (p.tab.login) void rpc.call("accounts.list", { provider: p.tab.login.provider, refresh: true }).then(refreshProviders).catch(reportError);
    };
    /** Disconnected from a shell that's still running: it comes back with the connection. */
    const [away, setAway] = createSignal(false);
    const [restarting, setRestarting] = createSignal(false);
    const [loginOutputLost, setLoginOutputLost] = createSignal(!!p.tab.login && !!p.tab.attach);
    const restart = async () => {
        if (restarting()) return;
        forgetDrawn();
        // The old shell has exited or gone (its output was kept until now); one shown in another window is that window's.
        const previous = moved ? undefined : id;
        moved = false;
        attach = false;
        pos = undefined;
        // Nothing more from the old shell is written; what xterm still has queued from it is drawn
        // first, so the reset goes in after it (RIS, as term.reset() does) and the new shell after that.
        const next = crypto.randomUUID();
        setRestarting(true);
        // Free the old slot before opening its replacement, including at the 12-shell limit.
        try { await p.onRestart(next, previous); }
        catch (e) { setRestarting(false); setEnded((e as Error).message); return; }
        if (disposed) { p.onClose(next); return; }
        id = next;
        setLoginOutputLost(false);
        moved = false;
        attach = false;
        opened = false;
        term.write("\x18\x1bc", () => {
            setRestarting(false);
            if (!disposed) void start();
        });
    };
    const fitNow = () => {
        if (disposed || !p.visible || !container?.clientHeight || !term) return;
        fit.fit();
        if (opened && !ended() && app.conn === "open") void rpc.call("terminal.resize", { id, cols: Math.min(500, term.cols), rows: Math.min(300, term.rows) }).catch(() => {});
    };
    const lost = (e: unknown) => e instanceof RpcError && e.code === "disconnected";
    /** Back to the shell the server kept: what it printed meanwhile comes first (as terminal.data, ahead of the reply). */
    const reattach = async () => {
        if (app.conn !== "open") return void setAway(true);
        setAway(false);
        setEnded(undefined);
        if (p.tab.login) setLoginOutputLost(true);
        // Typed while attaching: sent once it's attached. (Nothing else is: the replay is output only, and the script isn't armed.)
        early.begin();
        attaching = true;
        const attempt = ++attachment;
        const at = epoch;
        try {
            const info = await rpc.call("terminal.attach", { id, ...(pos === undefined ? {} : { have: pos }) });
            if (disposed || at !== epoch || attempt !== attachment) return;
            const typed = early.take();
            if (info.exitCode !== undefined) {
                return exited(info.exitCode);
            }
            opened = true;
            if (typed) send(typed);
            // A new size makes a full-screen program draw itself again (the server nudges it when the size is the same).
            fitNow();
            if (p.visible) term.focus();
        } catch (e) {
            if (disposed || at !== epoch || attempt !== attachment) return;
            early.take();
            if (lost(e)) {
                setAway(true);
                if (app.conn === "open") void reattach();
                return;
            }
            attach = false;
            setEnded(e instanceof RpcError && e.code === "terminal_not_open" ? "This shell is no longer running: it was stopped while the window was away, or the harness server restarted." : (e as Error).message);
        } finally { if (attempt === attachment) attaching = false; }
    };
    const start = async () => {
        if (attach) return reattach();
        const run = script;
        script = undefined;
        const ticket = setupTickets.get(p.tab.id);
        setupTickets.delete(p.tab.id);
        const failed = (why: string) => (run?.setup ? `The setup script “${run!.name}” didn't run. ${why.charAt(0).toUpperCase()}${why.slice(1).replace(/\.?$/, ".")} The worktree was created; you can run the script from the project scripts menu.` : `Couldn't run “${run!.name}”: ${why}`);
        // A restored/remounted setup tab must never fall back to an ordinary script click.
        if (run?.setup && !ticket) {
            setEnded(failed("this setup run is no longer available."));
            return;
        }
        if (app.conn !== "open") {
            if (run) setEnded(failed("not connected to the harness server."));
            return;
        }
        setEnded(undefined);
        fitNow();
        early.begin();
        try {
            const shell = { id, cwd: p.tab.cwd, cols: Math.max(2, Math.min(500, term.cols)), rows: Math.max(1, Math.min(300, term.rows)) };
            if (run) await rpc.call("scripts.run", { ...shell, script: run.id, ...(ticket ? { setup: ticket } : {}) });
            else await rpc.call("terminal.open", { ...shell, login: p.tab.login });
            opened = true;
            attach = true;
            const typed = early.take();
            // Closed meanwhile: the close may have reached the server first (scripts.run looks the script up before opening).
            if (disposed) return p.onClose(id);
            // Opening the shell also yields: Settings/navigation may have hidden the tab since checkout.
            if (run?.setup && (!p.visible || setupObscured() || trustRequest())) {
                opened = false;
                attach = false;
                const message = failed("the setup terminal is no longer visible");
                setEnded(message);
                toast(message, "warn");
                if (app.conn === "open") void rpc.call("terminal.close", { id }).catch(() => {});
                return;
            }
            if (typed && app.conn === "open") send(typed);
            // Only after what was typed meanwhile (the socket keeps the order): a Ctrl+C there cancels the script first.
            if (run && app.conn === "open") void rpc.call("terminal.arm", { id }).catch(() => {});
            fitNow();
            if (p.visible) term.focus();
        } catch (e) {
            early.take();
            if (disposed) return p.onClose(id);
            if (run?.setup) toast(failed((e as Error).message), "warn");
            // It may have opened (and be waiting for this window): find out once the connection is back.
            if (lost(e)) {
                attach = true;
                setAway(true);
                if (app.conn === "open") void reattach();
                return;
            }
            setEnded(run ? failed((e as Error).message) : (e as Error).message);
        }
    };
    onMount(() => {
        term = new Terminal({ fontFamily: '"JetBrains Mono Variable", monospace', fontSize: 12, cursorBlink: true, scrollback: 5000, allowProposedApi: false });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container);
        const theme = () => {
            const style = getComputedStyle(container);
            term.options.theme = { background: style.getPropertyValue("--term-bg").trim(), foreground: style.getPropertyValue("--fg").trim(), cursor: style.getPropertyValue("--fg").trim(), selectionBackground: "#80808060" };
        };
        theme();
        const themeObserver = new MutationObserver(theme);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        term.attachCustomKeyEventHandler((e) => {
            // Leave the app's toggle (and its chords) and clipboard shortcuts to their owners.
            if (terminalKey(e) === "app") return false;
            if (isMod(e) && e.key.toLowerCase() === "c" && term.hasSelection()) {
                if (e.type === "keydown") void copyText(term.getSelection());
                return false;
            }
            return true;
        });
        const input = term.onData((data) => {
            // Replaying a recorded query must not send a fresh reply into the shell.
            if (replayWrites && isTerminalReply(data)) return;
            if (early.hold(data)) return;
            if (!opened || ended() || app.conn !== "open") return;
            send(data);
        });
        const off = rpc.onEvent((e) => {
            if (e.type === "terminal.data" && e.id === id) {
                const at = epoch;
                const replay = attaching || !!e.reset;
                if (replay) replayWrites++;
                pos = e.pos;
                // All the output kept, again: what this screen showed is replaced (RIS, in order with what's queued).
                term.write(e.reset ? `\x18\x1bc${e.data}` : e.data, () => {
                    if (replay) replayWrites--;
                    if (disposed || at !== epoch) return;
                    drawn += e.data.length;
                    if (drawn >= 65_536) ack();
                    else acking ??= setTimeout(ack, 30);
                });
            }
            if (e.type === "terminal.exit" && e.id === id) {
                exited(e.exitCode);
            }
            if (e.type === "terminal.moved" && e.id === id) {
                opened = false;
                attach = false;
                moved = true;
                setAway(false);
                early.take();
                forgetDrawn();
                setEnded("This terminal is now shown in another window (a copy of this one). Use the restart button to start a new process here.");
            }
        });
        const stateOff = rpc.onState((state) => {
            if (state !== "open") {
                forgetDrawn();
                // The server keeps the shell for this window; output meanwhile comes back with the connection.
                if (attach && !away()) {
                    opened = false;
                    setAway(true);
                }
            } else if (away()) void reattach();
        });
        const observer = new ResizeObserver(() => { cancelAnimationFrame(fitting); fitting = requestAnimationFrame(fitNow); });
        observer.observe(container);
        void start();
        onCleanup(() => {
            disposed = true;
            clearTimeout(acking);
            cancelAnimationFrame(fitting);
            observer.disconnect();
            themeObserver.disconnect();
            input.dispose(); off(); stateOff();
            // Only an explicit tab close stops its shell; unmounting the panel does not.
            if (!moved) p.onClose(id);
            term.dispose();
        });
    });
    createEffect(() => { if (p.visible) requestAnimationFrame(() => { if (!disposed && term) { fitNow(); term.focus(); } }); });
    return <div class="terminal-screen" style={{ display: p.visible ? "flex" : "none" }}>
        <div class="terminal-emulator" ref={container} />
        <Show when={loginOutputLost()}><div class="terminal-message">
            <span>Login output is not saved or replayed. Restart login if you need a new sign-in prompt.</span>
            <Show when={!away() && !ended()}><button class="btn secondary sm" disabled={app.conn !== "open" || restarting()} onClick={restart}><RotateCw size={12} /> Restart login</button></Show>
        </div></Show>
        <Show when={away() || ended()}><div class="terminal-message">
            <span>{away() ? "Disconnected. The process stays on the server and reconnects here." : ended()}</span>
            <Show when={!away()}><button class="btn secondary sm" disabled={app.conn !== "open" || restarting()} onClick={restart}><RotateCw size={12} /> {p.tab.login ? "Restart login" : "Restart shell"}</button></Show>
        </div></Show>
    </div>;
}
