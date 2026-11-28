// One terminal tab's screen: the emulator (xterm) and its shell. Its own chunk, loaded once a terminal is opened
// (TerminalPanel): the emulator was a quarter of what the window loaded before anything showed.

import { createEffect, createSignal, For, on, onCleanup, onMount, Show } from "solid-js";
import { ClipboardPaste, Copy, Eraser, MessageSquarePlus, RotateCw, TextSelect } from "lucide-solid";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { app, awayMachine, handleFor, refreshProviders, reportError, rpc, toast, trustRequest } from "../state/app";
import { openInEditor } from "../state/actions";
import { adoptBrowserState, browserState, loadBrowserState, showBrowser } from "../state/browser";
import { RpcError, type ConnectionState, type Rpc } from "../lib/rpc";
import { prefs } from "../state/prefs";
import { terminalFontSize } from "../lib/text-size";
import { setComposerAdd, setupObscured, terminalActions } from "../state/ui";
import { EarlyInput, terminalInputChunks } from "../lib/terminal";
import { isTerminalReply } from "@shared/terminal-reply";
import { copyText, isMod, mod, openExternal } from "../lib/platform";
import { isLongPaste, pastedText, type Attachment } from "../lib/attachments";
import { linkProvider } from "../lib/terminal-link-provider";
import { isLocalUrl } from "../lib/terminal-links";
import { Menu } from "./ui/Menu";
import { terminalKey } from "../state/keybindings";
import { quitsApp } from "../lib/quit-key";
import { terminalTakesKeys, terminalUsed } from "../lib/terminal-keys";
import { setupTickets, signInTabs, type Tab } from "../lib/terminal-tabs";

/** `link`: the connection to the machine its shell runs on, and `conn` its state (the window's own, unless given). */
export default function TerminalScreen(p: { tab: Tab; visible: boolean; onClose: (terminal: string) => void; onRestart: (terminal: string, previous?: string) => Promise<void>; link?: Rpc; conn?: () => ConnectionState }) {
    const link = p.link ?? rpc;
    const conn = () => (p.conn ? p.conn() : app.conn);
    let container!: HTMLDivElement;
    let term: Terminal;
    let fit: FitAddon;
    let disposed = false;
    /** Its shell is running and attached here: input, resizes and acks go to it. */
    let opened = false;
    /** The keyboard, when this terminal comes into view: not from a card that waits unless the user asked for the terminal. */
    const takeKeys = () => { if (p.visible && terminalTakesKeys(container)) term.focus(); };
    /** Typed, clicked or scrolled in, or left (seen before the emulator, which keeps some keys to itself). */
    const used = { handleEvent: () => terminalUsed(container), capture: true, passive: true };
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
        for (const chunk of terminalInputChunks(data)) void link.call("terminal.write", { id, data: chunk }).catch((e) => { if (!(e instanceof RpcError && e.code === "terminal_not_open")) reportError(e); });
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
        if (chars && conn() === "open") void link.call("terminal.ack", { id, chars }).catch(() => {});
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
        setEnded(`${p.tab.login?.install ? "Install" : p.tab.login ? "Login" : "Shell"} exited (${code})`);
        // A server's sign-in: the server is asked how it stands now. This machine's own: its account is. Another
        // machine's (the user's computer, in a window on a server): what shows it reads it again.
        if (p.tab.login?.server) terminalActions.serverSignedIn?.(p.tab.login.server);
        else if (p.tab.login && link !== rpc) void link.call("accounts.list", { provider: p.tab.login.provider, refresh: true }).then(() => terminalActions.accountsChanged?.()).catch(reportError);
        else if (p.tab.login) void link.call("accounts.list", { provider: p.tab.login.provider, refresh: true }).then(refreshProviders).catch(reportError);
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
    /** The size last sent to the shell: a resize that leaves it the same isn't sent again. */
    let sent = "";
    /** `changed`: send the size only if it changed (a resize); otherwise always (a full-screen program draws itself again). */
    const fitNow = (changed = false) => {
        if (disposed || !p.visible || !container?.clientHeight || !term) return;
        fit.fit();
        const size = `${term.cols}x${term.rows}`;
        if (changed && size === sent) return;
        if (opened && !ended() && conn() === "open") {
            sent = size;
            void link.call("terminal.resize", { id, cols: Math.min(500, term.cols), rows: Math.min(300, term.rows) }).catch(() => {});
        }
    };
    const lost = (e: unknown) => e instanceof RpcError && e.code === "disconnected";
    /** Back to the shell the server kept: what it printed meanwhile comes first (as terminal.data, ahead of the reply). */
    const reattach = async () => {
        if (conn() !== "open") return void setAway(true);
        setAway(false);
        setEnded(undefined);
        if (p.tab.login) setLoginOutputLost(true);
        // Typed while attaching: sent once it's attached. (Nothing else is: the replay is output only, and the script isn't armed.)
        early.begin();
        attaching = true;
        const attempt = ++attachment;
        const at = epoch;
        try {
            const info = await link.call("terminal.attach", { id, ...(pos === undefined ? {} : { have: pos }) });
            if (disposed || at !== epoch || attempt !== attachment) return;
            const typed = early.take();
            if (info.exitCode !== undefined) {
                return exited(info.exitCode);
            }
            opened = true;
            if (typed) send(typed);
            // A new size makes a full-screen program draw itself again (the server nudges it when the size is the same).
            fitNow();
            takeKeys();
        } catch (e) {
            if (disposed || at !== epoch || attempt !== attachment) return;
            early.take();
            if (lost(e)) {
                setAway(true);
                if (conn() === "open") void reattach();
                return;
            }
            attach = false;
            setEnded(e instanceof RpcError && e.code === "terminal_not_open" ? "This shell has stopped." : (e as Error).message);
        } finally { if (attempt === attachment) attaching = false; }
    };
    const start = async () => {
        if (attach) return reattach();
        const run = script;
        script = undefined;
        const ticket = setupTickets.get(p.tab.id);
        setupTickets.delete(p.tab.id);
        const failed = (why: string) => (run?.setup ? `Setup script “${run!.name}” didn't run. ${why.charAt(0).toUpperCase()}${why.slice(1).replace(/\.?$/, ".")} Run it from the project scripts menu.` : `Couldn't run “${run!.name}”: ${why}`);
        // A restored/remounted setup tab must never fall back to an ordinary script click.
        if (run?.setup && !ticket) {
            setEnded(failed("this setup run is no longer available."));
            return;
        }
        if (conn() !== "open") {
            if (run) setEnded(failed("not connected to Cavvy server."));
            return;
        }
        setEnded(undefined);
        fitNow();
        early.begin();
        try {
            const shell = { id, cwd: p.tab.cwd, cols: Math.max(2, Math.min(500, term.cols)), rows: Math.max(1, Math.min(300, term.rows)) };
            if (run) await link.call("scripts.run", { ...shell, script: run.id, ...(ticket ? { setup: ticket } : {}) });
            // A sign-in card's command, for this tab's first shell only.
            const signIn = run ? undefined : signInTabs.get(p.tab.id);
            signInTabs.delete(p.tab.id);
            if (!run) await link.call("terminal.open", { ...shell, login: p.tab.login, ...(signIn ? { signIn } : {}) });
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
                if (conn() === "open") void link.call("terminal.close", { id }).catch(() => {});
                return;
            }
            if (typed && conn() === "open") send(typed);
            // Only after what was typed meanwhile (the socket keeps the order): a Ctrl+C there cancels the script first.
            if ((run || signIn) && conn() === "open") void link.call("terminal.arm", { id }).catch(() => {});
            fitNow();
            takeKeys();
        } catch (e) {
            early.take();
            if (disposed) return p.onClose(id);
            if (run?.setup) toast(failed((e as Error).message), "warn");
            // It may have opened (and be waiting for this window): find out once the connection is back.
            if (lost(e)) {
                attach = true;
                setAway(true);
                if (conn() === "open") void reattach();
                return;
            }
            setEnded(run ? failed((e as Error).message) : (e as Error).message);
        }
    };
    // -----------------------------------------------------------------------
    // Links and the context menu

    /** Its shell runs on another machine (that machine's terminal panel): its paths aren't files here, so they aren't links. */
    const elsewhere = link !== rpc;
    /** The session this terminal's folder is, when it's the one in view here (paths are then its: its other folders too). */
    const session = () => {
        const id = app.activeId;
        return !elsewhere && id && awayMachine(id) === undefined && handleFor(id)?.view.state.cwd === p.tab.cwd ? id : undefined;
    };
    const scope = () => (session() ? { sessionId: session() } : { cwd: p.tab.cwd });
    /** A server on this machine (localhost) in the session's Browser pane, where there is one; anything else in the system's browser. */
    const openUrl = async (url: string) => {
        const id = session();
        if (id && isLocalUrl(url)) {
            if (!browserState(id)) await loadBrowserState(id).catch(() => undefined);
            const status = browserState(id)?.status;
            if (status && status !== "unavailable") {
                try {
                    adoptBrowserState(id, await rpc.call("browser.command", { id, command: "new_tab", url }));
                    showBrowser();
                } catch (e) {
                    reportError(e);
                }
                return;
            }
        }
        void openExternal(url);
    };
    const [menuAt, setMenuAt] = createSignal<{ x: number; y: number }>();
    const [selected, setSelected] = createSignal(false);
    const closeMenu = () => setMenuAt(undefined);
    /** The selection, into the session's message: inline as a code block, or past the composer's paste limits as an attachment. */
    const addToChat = () => {
        const text = term.getSelection().replace(/[ \t]+$/gm, "").replace(/^\n+|\s+$/g, "");
        if (!text) return;
        const fence = "`".repeat(Math.max(3, ...[...text.matchAll(/`{3,}/g)].map((m) => m[0].length + 1)));
        setComposerAdd({ sessionId: app.activeId, ...(isLongPaste(text) ? { attach: (list: readonly Attachment[]) => pastedText(text, list, "Terminal output") } : { text: `${fence}\n${text}\n${fence}\n` }) });
    };
    const paste = async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) term.paste(text);
        } catch {
            toast(`Press ${mod}+V to paste here`);
        }
        term.focus();
    };
    const contextMenu = (e: MouseEvent) => {
        e.preventDefault();
        setSelected(term.hasSelection());
        setMenuAt({ x: e.clientX, y: e.clientY });
    };
    const menuItems = () => [
        { icon: MessageSquarePlus, label: "Add to chat", off: !selected(), run: addToChat },
        { icon: Copy, label: "Copy", off: !selected(), run: () => void copyText(term.getSelection()) },
        { icon: ClipboardPaste, label: "Paste", off: !opened || !!ended(), run: () => void paste() },
        { icon: TextSelect, label: "Select all", run: () => term.selectAll() },
        { icon: Eraser, label: "Clear", run: () => (term.clear(), term.clearSelection()) },
    ];

    onMount(() => {
        term = new Terminal({ fontFamily: '"JetBrains Mono Variable", monospace', fontSize: terminalFontSize(prefs.fontSize), cursorBlink: true, scrollback: 5000, allowProposedApi: false, allowTransparency: true });
        fit = new FitAddon();
        term.loadAddon(fit);
        term.open(container);
        // Asked for by xterm only for the line under the pointer, as it moves there: nothing per chunk of output.
        term.registerLinkProvider(linkProvider(term, {
            exists: (paths) => (elsewhere ? Promise.resolve(paths.map(() => null)) : rpc.call("fs.exists", { ...scope(), paths })),
            openUrl: (url) => void openUrl(url),
            openFile: (path, line, col) => void openInEditor(path, line, { col, ...scope() }),
            hint: (l, on) => {
                container.title = !on ? "" : l.kind === "path" ? "Open in editor" : session() && isLocalUrl(l.url) && browserState(session()!)?.status !== "unavailable" ? "Open in the Browser pane" : "Open in your browser";
            },
        }));
        const theme = () => {
            const style = getComputedStyle(container);
            // No ground of its own: the panel's tint over the window's glass shows through (terminal.css).
            term.options.theme = { background: "rgba(0, 0, 0, 0)", foreground: style.getPropertyValue("--fg").trim(), cursor: style.getPropertyValue("--fg").trim(), selectionBackground: "#80808060" };
        };
        theme();
        const themeObserver = new MutationObserver(theme);
        themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
        term.attachCustomKeyEventHandler((e) => {
            // Leave the app's toggle (and its chords), Quit and clipboard shortcuts to their owners.
            if (quitsApp(e) || terminalKey(e) === "app") return false;
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
            if (!opened || ended() || conn() !== "open") return;
            send(data);
        });
        const off = link.onEvent((e) => {
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
                setEnded("This terminal moved to another window. Restart to start a new one here.");
            }
        });
        const stateOff = link.onState((state) => {
            if (state !== "open") {
                forgetDrawn();
                // The server keeps the shell for this window; output meanwhile comes back with the connection.
                if (attach && !away()) {
                    opened = false;
                    setAway(true);
                }
            } else if (away()) void reattach();
        });
        // While the panels slide, the panel keeps one size (lib/layout.ts heldSizes): this fits once as it opens.
        const observer = new ResizeObserver(() => { cancelAnimationFrame(fitting); fitting = requestAnimationFrame(() => fitNow(true)); });
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
    createEffect(() => { if (p.visible) requestAnimationFrame(() => { if (!disposed && term) { fitNow(); takeKeys(); } }); });
    // Settings → Appearance → Text size: the cells follow it, and the shell gets the new size.
    createEffect(on(() => prefs.fontSize, (size) => { if (term && !disposed) { term.options.fontSize = terminalFontSize(size); fitNow(true); } }, { defer: true }));
    return <div class="terminal-screen" style={{ display: p.visible ? "flex" : "none" }}>
        <div class="terminal-emulator" ref={container} on:keydown={used} on:pointerdown={used} on:wheel={used} on:focusout={used} onContextMenu={contextMenu} />
        <Menu label="Terminal actions" open={!!menuAt()} point={menuAt()} anchor={() => container} returnFocus={() => term.textarea} onClose={closeMenu} width={200}>
            <For each={menuItems()}>{(it) => (
                <button role="menuitem" class="menu-item compact" disabled={it.off} onClick={() => (closeMenu(), it.run())}>
                    <it.icon size={14} /> <span class="menu-label">{it.label}</span>
                </button>
            )}</For>
        </Menu>
        <Show when={loginOutputLost()}><div class="terminal-message">
            <span>Login output isn't kept. Restart login for a new sign-in prompt.</span>
            <Show when={!away() && !ended()}><button class="btn secondary sm" disabled={conn() !== "open" || restarting()} onClick={restart}><RotateCw size={12} /> Restart login</button></Show>
        </div></Show>
        <Show when={away() || ended()}><div class="terminal-message">
            <span>{away() ? "Disconnected. The process stays on the server and reconnects here." : ended()}</span>
            <Show when={!away()}><button class="btn secondary sm" disabled={conn() !== "open" || restarting()} onClick={restart}><RotateCw size={12} /> {p.tab.login?.install ? "Run again" : p.tab.login ? "Restart login" : "Restart shell"}</button></Show>
        </div></Show>
    </div>;
}
