import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Play, Plus, RotateCw, SquareTerminal, X } from "lucide-solid";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";
import { app, refreshProviders, reportError, rpc, toast } from "../state/app";
import { RpcError } from "../lib/rpc";
import { prefs, setPrefs } from "../state/prefs";
import { terminalActions, terminalOpen, setTerminalOpen, setSettingsTab } from "../state/ui";
import { basename, tildify } from "../lib/format";
import { EarlyInput, terminalInputChunks } from "../lib/terminal";
import { copyText, isMod, isTerminalToggle, terminalShortcut } from "../lib/platform";

/** `script`: the project script the tab was opened to run (once: restarting it gives a plain shell). */
interface Tab { id: string; cwd: string; number: number; login?: { provider: string; accountId: string; name: string }; script?: { id: string; name: string } }
const MAX_TABS = 12;

/** Mounted while hidden: each tab keeps its emulator and shell across chat navigation. */
export function TerminalPanel(p: { cwd?: string; hidden?: boolean }) {
    const [tabs, setTabs] = createSignal<Tab[]>([]);
    const [selected, setSelected] = createSignal<string>();
    const currentTabs = () => tabs().filter((t) => t.login || t.cwd === p.cwd);
    const active = () => currentTabs().find((t) => t.id === selected()) ?? currentTabs().at(-1);
    const visible = () => terminalOpen() && !p.hidden && (!!p.cwd || currentTabs().some((t) => t.login));
    let next = 1;
    const full = () => tabs().length >= MAX_TABS;
    const add = () => {
        if (!p.cwd || app.conn !== "open" || full()) return;
        const tab = { id: crypto.randomUUID(), cwd: p.cwd, number: next++ };
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
    };
    // A click on a project script: its own tab, shown, with the command typed into its shell.
    const runScript = (cwd: string, script: { id: string; name: string }) => {
        if (app.conn !== "open") return toast(`Not connected to the harness server, so “${script.name}” can't start.`, "error");
        if (full()) return toast(`${MAX_TABS} terminals are open in this window, some maybe in other projects. Close one to run “${script.name}”.`, "error");
        const tab = { id: crypto.randomUUID(), cwd, number: next++, script: { id: script.id, name: script.name } };
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
        setTerminalOpen(true);
    };
    const loginAccount = (provider: string, accountId: string, name: string) => {
        if (app.conn !== "open" || full()) return toast("Connect and close a terminal before signing in", "warn");
        const tab: Tab = { id: crypto.randomUUID(), cwd: app.hello?.homeDir ?? "/", number: next++, login: { provider, accountId, name } };
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
    createEffect(on(terminalOpen, (open) => { if (open && !p.hidden && !currentTabs().length) add(); }, { defer: true }));
    const close = (tab: Tab) => {
        if (currentTabs().length === 1) setTerminalOpen(false);
        setTabs((all) => all.filter((t) => t !== tab));
    };
    let panel: HTMLElement | undefined;
    const resize = (e: PointerEvent) => {
        if (e.button !== 0) return;
        e.preventDefault();
        const target = e.currentTarget as HTMLElement;
        target.setPointerCapture(e.pointerId);
        const y = e.clientY;
        const height = panel?.offsetHeight ?? 260;
        const move = (event: PointerEvent) => setPrefs("terminalHeight", Math.min(window.innerHeight * 0.7, Math.max(120, height + y - event.clientY)));
        const end = () => { target.removeEventListener("pointermove", move); target.removeEventListener("lostpointercapture", end); };
        target.addEventListener("pointermove", move);
        target.addEventListener("lostpointercapture", end);
    };
    return (
        <section ref={panel} class="terminal-panel" aria-label="Terminal panel" style={{ display: visible() ? "flex" : "none", height: `${prefs.terminalHeight}px` }}>
            <div class="terminal-resize" role="separator" aria-label="Resize terminal" aria-orientation="horizontal" tabIndex={0} onPointerDown={resize}
                onKeyDown={(e) => { if (e.key === "ArrowUp" || e.key === "ArrowDown") { e.preventDefault(); setPrefs("terminalHeight", Math.min(window.innerHeight * .7, Math.max(120, prefs.terminalHeight + (e.key === "ArrowUp" ? 24 : -24)))); } }} />
            <div class="terminal-toolbar">
                <SquareTerminal size={14} /><span class="terminal-label">Terminal</span>
                <div class="terminal-tabs" role="tablist" aria-label="Terminals">
                    <For each={currentTabs()}>{(tab) => <div class={`terminal-tab ${active()?.id === tab.id ? "on" : ""}`}>
                        <button role="tab" aria-selected={active()?.id === tab.id} onClick={() => setSelected(tab.id)} title={tab.script ? `Script “${tab.script.name}” in ${tab.cwd}` : tab.cwd}>{tab.login ? `Sign in · ${tab.login.name}` : tab.script ? <><Play size={10} class="terminal-tab-icon" /> {tab.script.name}</> : `${basename(tab.cwd)} ${tab.number}`}</button>
                        <button class="hb sm" title="Close terminal and stop its shell" aria-label={tab.script ? `Close terminal ${tab.script.name}` : `Close terminal ${tab.number}`} onClick={() => close(tab)}><X size={12} /></button>
                    </div>}</For>
                </div>
                <button class="hb sm" title={full() ? `${MAX_TABS} terminals are open in this window` : "New terminal"} aria-label="New terminal" disabled={app.conn !== "open" || full()} onClick={add}><Plus size={15} /></button>
                <span class="terminal-cwd truncate" title={p.cwd}>{tildify(p.cwd ?? "", app.hello?.homeDir)}</span>
                <button class="hb sm" title={`Hide terminal (${terminalShortcut})`} aria-label="Hide terminal" onClick={() => setTerminalOpen(false)}><X size={15} /></button>
            </div>
            <Show when={!currentTabs().length}>
                <div class="terminal-message">
                    <span>{full() ? `${MAX_TABS} terminals are open in this window, some in other projects. Close one to open a terminal here.` : app.conn !== "open" ? "Not connected to the harness server." : "No terminal in this project."}</span>
                    <Show when={!full()}><button class="btn secondary sm" disabled={app.conn !== "open"} onClick={add}><Plus size={12} /> New terminal</button></Show>
                </div>
            </Show>
            <For each={tabs()}>{(tab) => <TerminalScreen tab={tab} visible={visible() && active()?.id === tab.id} />}</For>
        </section>
    );
}

function TerminalScreen(p: { tab: Tab; visible: boolean }) {
    let container!: HTMLDivElement;
    let term: Terminal;
    let fit: FitAddon;
    let disposed = false;
    let opened = false;
    let id = p.tab.id;
    // Typed by the first shell only: a restart, or a reconnect, never runs it again by itself.
    let script = p.tab.script;
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
    const [ended, setEnded] = createSignal<string>();
    const [restarting, setRestarting] = createSignal(false);
    const restart = () => {
        if (restarting()) return;
        clearTimeout(acking);
        acking = undefined;
        drawn = 0;
        // Nothing more from the old shell is written; what xterm still has queued from it is drawn
        // first, so the reset goes in after it (RIS, as term.reset() does) and the new shell after that.
        id = crypto.randomUUID();
        setRestarting(true);
        term.write("\x1bc", () => {
            setRestarting(false);
            if (!disposed) void start();
        });
    };
    const fitNow = () => {
        if (disposed || !p.visible || !container?.clientHeight || !term) return;
        fit.fit();
        if (opened && !ended() && app.conn === "open") void rpc.call("terminal.resize", { id, cols: Math.min(500, term.cols), rows: Math.min(300, term.rows) }).catch(() => {});
    };
    const start = async () => {
        const run = script;
        script = undefined;
        if (app.conn !== "open") {
            if (run) setEnded(`Couldn't run “${run.name}”: not connected to the harness server.`);
            return;
        }
        setEnded(undefined);
        fitNow();
        early.begin();
        try {
            const shell = { id, cwd: p.tab.cwd, cols: Math.max(2, Math.min(500, term.cols)), rows: Math.max(1, Math.min(300, term.rows)) };
            if (run) await rpc.call("scripts.run", { ...shell, script: run.id });
            else await rpc.call("terminal.open", { ...shell, login: p.tab.login });
            opened = true;
            const typed = early.take();
            if (disposed) { if (app.conn === "open") void rpc.call("terminal.close", { id }).catch(() => {}); return; }
            if (typed && app.conn === "open") send(typed);
            // Only after what was typed meanwhile (the socket keeps the order): a Ctrl+C there cancels the script first.
            if (run && app.conn === "open") void rpc.call("terminal.arm", { id }).catch(() => {});
            fitNow();
            if (p.visible) term.focus();
        } catch (e) {
            early.take();
            if (!disposed) setEnded(run ? `Couldn't run “${run.name}”: ${(e as Error).message}` : (e as Error).message);
        }
    };
    onMount(() => {
        term = new Terminal({ fontFamily: '"JetBrains Mono Variable", monospace', fontSize: 12, cursorBlink: true, scrollback: 5000, allowProposedApi: false });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container);
        const theme = () => {
            const style = getComputedStyle(container);
            term.options.theme = { background: style.getPropertyValue("--bg").trim(), foreground: style.getPropertyValue("--fg").trim(), cursor: style.getPropertyValue("--fg").trim(), selectionBackground: "#80808060" };
        };
        theme();
        const themeObserver = new MutationObserver(theme);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        term.attachCustomKeyEventHandler((e) => {
            // Leave the app's toggle and clipboard shortcuts to their owners.
            if (isTerminalToggle(e)) return false;
            if (isMod(e) && e.key.toLowerCase() === "c" && term.hasSelection()) {
                if (e.type === "keydown") void copyText(term.getSelection());
                return false;
            }
            return true;
        });
        const input = term.onData((data) => {
            if (early.hold(data)) return;
            if (!opened || ended() || app.conn !== "open") return;
            send(data);
        });
        const off = rpc.onEvent((e) => {
            if (e.type === "terminal.data" && e.id === id) {
                const shell = id;
                term.write(e.data, () => {
                    if (disposed || shell !== id) return;
                    drawn += e.data.length;
                    if (drawn >= 65_536) ack();
                    else acking ??= setTimeout(ack, 30);
                });
            }
            if (e.type === "terminal.exit" && e.id === id) { opened = false; setEnded(`${p.tab.login ? "Login" : "Shell"} exited (${e.exitCode})`); if (p.tab.login) void rpc.call("accounts.list", { provider: p.tab.login.provider, refresh: true }).then(refreshProviders).catch(reportError); }
        });
        const stateOff = rpc.onState((state) => {
            if (state !== "open") { opened = false; setEnded("Disconnected. Start a new shell when the connection returns."); }
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
            if (opened && app.conn === "open") void rpc.call("terminal.close", { id }).catch(() => {});
            term.dispose();
        });
    });
    createEffect(() => { if (p.visible) requestAnimationFrame(() => { if (!disposed && term) { fitNow(); term.focus(); } }); });
    return <div class="terminal-screen" style={{ display: p.visible ? "flex" : "none" }}>
        <div class="terminal-emulator" ref={container} />
        <Show when={ended()}><div class="terminal-message"><span>{ended()}</span><button class="btn secondary sm" disabled={app.conn !== "open" || restarting()} onClick={restart}><RotateCw size={12} /> Restart shell</button></div></Show>
    </div>;
}
