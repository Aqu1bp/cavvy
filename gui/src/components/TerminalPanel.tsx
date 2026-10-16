import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { Plus, RotateCw, SquareTerminal, X } from "lucide-solid";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import "../styles/terminal.css";
import { app, reportError, rpc } from "../state/app";
import { RpcError } from "../lib/rpc";
import { prefs, setPrefs } from "../state/prefs";
import { terminalOpen, setTerminalOpen } from "../state/ui";
import { basename, tildify } from "../lib/format";
import { terminalInputChunks } from "../lib/terminal";
import { copyText, isMod, isTerminalToggle, terminalShortcut } from "../lib/platform";

interface Tab { id: string; cwd: string; number: number }
const MAX_TABS = 12;

/** Mounted while hidden: each tab keeps its emulator and shell across chat navigation. */
export function TerminalPanel(p: { cwd?: string; hidden?: boolean }) {
    const [tabs, setTabs] = createSignal<Tab[]>([]);
    const [selected, setSelected] = createSignal<string>();
    const currentTabs = () => tabs().filter((t) => t.cwd === p.cwd);
    const active = () => currentTabs().find((t) => t.id === selected()) ?? currentTabs().at(-1);
    const visible = () => terminalOpen() && !p.hidden && !!p.cwd;
    let next = 1;
    const full = () => tabs().length >= MAX_TABS;
    const add = () => {
        if (!p.cwd || app.conn !== "open" || full()) return;
        const tab = { id: crypto.randomUUID(), cwd: p.cwd, number: next++ };
        setTabs((all) => [...all, tab]);
        setSelected(tab.id);
    };
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
                        <button role="tab" aria-selected={active()?.id === tab.id} onClick={() => setSelected(tab.id)} title={tab.cwd}>{basename(tab.cwd)} {tab.number}</button>
                        <button class="hb sm" title="Close terminal and stop its shell" aria-label={`Close terminal ${tab.number}`} onClick={() => close(tab)}><X size={12} /></button>
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
        if (app.conn !== "open") return;
        setEnded(undefined);
        fitNow();
        try {
            await rpc.call("terminal.open", { id, cwd: p.tab.cwd, cols: Math.max(2, Math.min(500, term.cols)), rows: Math.max(1, Math.min(300, term.rows)) });
            opened = true;
            if (disposed) { if (app.conn === "open") void rpc.call("terminal.close", { id }).catch(() => {}); return; }
            fitNow();
            if (p.visible) term.focus();
        } catch (e) { if (!disposed) setEnded((e as Error).message); }
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
            if (!opened || ended() || app.conn !== "open") return;
            // A pasted command may exceed one RPC's input limit. Preserve order.
            // Typed as the shell exits: it's gone, which the exit message says.
            for (const chunk of terminalInputChunks(data)) void rpc.call("terminal.write", { id, data: chunk }).catch((e) => { if (!(e instanceof RpcError && e.code === "terminal_not_open")) reportError(e); });
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
            if (e.type === "terminal.exit" && e.id === id) { opened = false; setEnded(`Shell exited (${e.exitCode})`); }
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
