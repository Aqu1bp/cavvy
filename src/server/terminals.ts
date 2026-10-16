// User-operated shells, isolated from agent sessions. Each belongs to the
// window that opened it, and outlives that window's connection for a while
// (GRACE): a reload, or a connection that drops and comes back, finds it
// still running and attaches to it again, with its recent output.
import { statSync } from "fs";
import { basename, resolve, isAbsolute } from "path";
import { userInfo } from "os";
import { childEnv } from "../util/env";
import { RpcError } from "./rpc-error";
import type { ServerEvent, TerminalInfo, TerminalScript } from "./protocol";

/** A window's connection: where output goes while it's attached. */
export interface Owner {
    send(event: ServerEvent): void;
    /**
     * The window's secret key (it keeps it across reloads). Its terminals belong
     * to the key, not to this connection: they wait for a later connection with
     * the key when this one goes. Without one, the connection is the window, and
     * its terminals stop with it.
     */
    window?: string;
}
interface Shell {
    /** The window it belongs to: its key, or the connection that opened it when that has none. */
    window: string | Owner;
    /** Where its output goes: the window's connection, while attached. */
    sink?: Owner;
    cwd: string;
    /** The project script it was opened to run: the tab is named after it. */
    script?: TerminalScript;
    process: ReturnType<typeof Bun.spawn>;
    terminal: Bun.Terminal;
    size: { cols: number; rows: number };
    timer?: ReturnType<typeof setTimeout>;
    /** Recent output (SCROLLBACK), from a clean cut, for a window that attaches. */
    out: string;
    /** Characters of output so far: `out` ends there. */
    total: number;
    /** Where the output sent to the window ends. */
    sent: number;
    /** Sent, and not yet drawn by the window (it acks what it has drawn). */
    unacked: number;
    /** Output is held back until the window catches up. */
    holding: boolean;
    /** A full-screen program is showing (the alternate screen), and `tail` is where an escape for it may have begun. */
    alt: boolean;
    tail: string;
    /** It exited; kept, with its output, until the window closes it (or, gone, doesn't come back in time). */
    exitCode?: number;
    /** While no window is attached: when it's stopped. */
    expires?: ReturnType<typeof setTimeout>;
    /** Input given at open, until it's typed or cancelled. */
    typist?: Typist;
}

/**
 * Flow control. A shell can't be paused (XOFF would leave its output stopped
 * for good if the program turned flow control off meanwhile), so output the
 * window hasn't caught up with is held back, keeping only its latest part,
 * as a terminal's scrollback would.
 */
const MAX_UNACKED = 1_000_000;
const RESUME_BELOW = 250_000;
const KEEP = 250_000;

/**
 * Output kept for a window that attaches (after a reload, say): about 12,000
 * full 80-column lines. Trimmed a quarter at a time, so a terminal keeps at
 * most 1.25 times this (plus one read), and there are 48 terminals at most.
 */
const SCROLLBACK = 1_000_000;
/** How long a window that went away has to come back before its terminals are stopped. */
const GRACE_MS = 10 * 60_000;
/** Entering or leaving the alternate screen (vim, htop, less). */
const ALT_SCREEN = /\x1b\[\?(?:1049|1047|47)([hl])/g;

/**
 * Input given at open is typed once the shell is reading a command. Typed
 * while its rc files still run, it's echoed twice, or read by something in
 * them. zsh's line editor says when it starts reading: it turns bracketed
 * paste on (READING), so for zsh nothing else counts. Other shells (bash 3.2
 * never sends it) are taken as reading when either that arrives or their
 * output has paused for TYPE_QUIET.
 */
const READING = "\x1b[?2004h";
const SAYS_WHEN_READING = new Set(["zsh"]);
const TYPE_QUIET_MS = 150;
const TYPE_BY_MS = 3000;

type After = (ms: number, fn: () => void) => () => void;
const after: After = (ms, fn) => {
    const t = setTimeout(fn, ms);
    return () => clearTimeout(t);
};

/**
 * When input given at open is typed: only once the window has armed it (after
 * sending what the user typed while the shell was opening, so a Ctrl+C there
 * cancels it first) and the shell is reading; or, once armed, after TYPE_BY at
 * the latest. Never if cancelled (the user typed first) or never armed.
 * Reading, once seen, stays seen: later output doesn't undo it.
 */
export class Typist {
    private ready = false;
    private armed = false;
    private done = false;
    /** The end of the output so far: READING can arrive split across two reads. */
    private tail = "";
    private quiet?: () => void;
    private by?: () => void;

    constructor(private input: string, private waitsForReading: boolean, private write: (text: string) => void, private timers: After = after) {}

    /** The shell's output. */
    output(text: string) {
        if (this.done || this.ready) return;
        const seen = this.tail + text;
        this.tail = seen.slice(-(READING.length - 1));
        this.quiet?.();
        this.quiet = undefined;
        if (seen.includes(READING)) this.reading();
        else if (!this.waitsForReading) this.quiet = this.timers(TYPE_QUIET_MS, () => this.reading());
    }

    arm() {
        if (this.done || this.armed) return;
        this.armed = true;
        this.by = this.timers(TYPE_BY_MS, () => this.type());
        if (this.ready) this.type();
    }

    cancel() {
        this.done = true;
        this.quiet?.();
        this.by?.();
    }

    get pending() {
        return !this.done;
    }

    private reading() {
        this.ready = true;
        if (this.armed) this.type();
    }

    private type() {
        if (this.done) return;
        this.cancel();
        this.write(this.input);
    }
}

/**
 * What xterm.js sends by itself, answering the shell or reporting focus:
 * device attributes (CSI ? … c, CSI > … c), status (CSI 0 n), cursor position
 * (CSI y;x R, CSI ? y;x R), mode reports (CSI … $ y), focus (CSI I, CSI O),
 * window reports (CSI 4|6|8 ; … t), OSC colour replies and DCS replies. Anything
 * else (keys, Escape, Alt+key, arrows, paste, mouse) is the user.
 */
const REPLY = /\x1b(?:\[[?>][\d;]*c|\[0n|\[\??\d+;\d+R|\[\??\d+;\d+\$y|\[[IO]|\[[468];\d+;\d+t|\][^\x07\x1b]*(?:\x07|\x1b\\)|P[^\x1b]*\x1b\\)/y;

/** All of `data` is the terminal's own replies (one or several). */
export function isTerminalReply(data: string): boolean {
    let at = 0;
    while (at < data.length) {
        REPLY.lastIndex = at;
        if (!REPLY.test(data)) return false;
        at = REPLY.lastIndex;
    }
    return data.length > 0;
}

/** The terminal the shell was started from (an outer tmux, an editor's or another app's) isn't this one. */
const OUTER_TERMINAL = /^(TMUX|TMUX_PANE|STY|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|COLUMNS|LINES|WINDOWID|ITERM_.*|LC_TERMINAL|LC_TERMINAL_VERSION|VSCODE_.*|KITTY_.*|WEZTERM_.*|ALACRITTY_.*|GHOSTTY_.*|WT_SESSION|WT_PROFILE_ID|KONSOLE_.*|INSIDE_EMACS|ZED_TERM)$/;

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 2 || Number(cols) > 500 || Number(rows) < 1 || Number(rows) > 300) throw new RpcError("Invalid terminal size", "invalid");
    return { cols: Number(cols), rows: Number(rows) };
}

/** The environment of a shell the user runs: theirs, not the one the harness gives agent tools. */
export function terminalEnv(): Record<string, string> {
    const env = childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" });
    for (const k of Object.keys(env)) if (OUTER_TERMINAL.test(k)) delete env[k];
    // Agent tools get these; a user's interactive shell keeps its own pagers and prompts.
    for (const k of ["PAGER", "GIT_PAGER", "GIT_TERMINAL_PROMPT"]) {
        const own = process.env[k];
        if (own === undefined) delete env[k];
        else env[k] = own;
    }
    delete env.HARNESS;
    env.TERM_PROGRAM = "Harness";
    return env;
}

/**
 * Where output may be cut, at or after `from`: the start of the next line, so
 * what follows doesn't begin inside an escape sequence; failing that (a very
 * long line), not between the halves of a surrogate pair.
 */
function cleanCut(text: string, from: number): number {
    const line = text.indexOf("\n", from);
    if (line !== -1 && line - from < 4096) return line + 1;
    return /[\uDC00-\uDFFF]/.test(text[from] ?? "") ? from + 1 : from;
}

const notOpen = () => new RpcError("That terminal is not open in this window", "terminal_not_open");
const windowOf = (owner: Owner): string | Owner => owner.window ?? owner;

export class Terminals {
    private shells = new Map<string, Shell>();

    /** `graceMs`: how long a window's terminals wait for it to come back (tests shorten it). */
    constructor(private o: { graceMs?: number } = {}) {}

    /**
     * `owner` is the window's live connection (callers check), which drop()s it when it goes.
     * `input` is typed into the new shell, as if by hand, once it's armed and reading a command (see Typist).
     * `script` names the tab, for a window that comes back to it.
     */
    open(owner: Owner, id: string, cwd: string, cols: unknown, rows: unknown, opts: { input?: string; script?: TerminalScript } = {}) {
        const size = terminalSize(cols, rows);
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || this.shells.has(id)) throw new RpcError("Invalid or duplicate terminal id", "invalid");
        // Detached ones, and ones that exited, count until they're closed or expire.
        const window = windowOf(owner);
        if (this.shells.size >= 48 || [...this.shells.values()].filter((s) => s.window === window).length >= 12) throw new RpcError("Close a terminal before opening another (12 per window, across projects)", "limit");
        cwd = resolve(cwd);
        let isDir = false;
        try { isDir = statSync(cwd).isDirectory(); } catch {}
        if (!isDir) throw new RpcError("Terminal folder does not exist", "invalid");
        if (process.platform === "win32") throw new RpcError("The embedded terminal requires macOS or Linux with this Bun version", "unsupported");
        let shell = process.env.SHELL;
        if (!shell || !isAbsolute(shell)) shell = userInfo().shell || "/bin/sh";
        const decoder = new TextDecoder();
        let pending = "";
        let entry: Shell | undefined;
        // Not into a shell that has since closed or exited.
        const typist = opts.input === undefined ? undefined : new Typist(opts.input, SAYS_WHEN_READING.has(basename(shell)), (text) => {
            if (entry && this.shells.get(id) === entry && entry.exitCode === undefined) entry.terminal.write(text);
        });
        const flush = () => {
            if (!entry) return;
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = undefined;
            if (!pending) return;
            this.record(entry, pending);
            pending = "";
            if (entry.unacked >= MAX_UNACKED) entry.holding = true;
            if (!entry.holding) this.sendRest(id, entry);
        };
        const terminal = new Bun.Terminal({ ...size, name: "xterm-256color", data: (_t, bytes) => {
            const text = decoder.decode(bytes, { stream: true });
            pending += text;
            typist?.output(text);
            if (pending.length >= 32_768) flush();
            else if (entry && !entry.timer) entry.timer = setTimeout(flush, 16);
        } });
        let proc: ReturnType<typeof Bun.spawn>;
        try {
            proc = Bun.spawn([shell, "-il"], { cwd, env: terminalEnv(), terminal, detached: true });
        } catch (e) {
            terminal.close();
            throw e;
        }
        const shellEntry: Shell = { window, sink: owner, cwd, script: opts.script, process: proc, terminal, size, out: "", total: 0, sent: 0, unacked: 0, holding: false, alt: false, tail: "", typist };
        entry = shellEntry;
        this.shells.set(id, shellEntry);
        void proc.exited.then((exitCode) => {
            if (this.shells.get(id) !== shellEntry) return;
            pending += decoder.decode();
            flush();
            typist?.cancel();
            terminal.close();
            shellEntry.exitCode = exitCode;
            // Nothing follows: what was held back goes now. With no window attached, it waits for one.
            this.sendRest(id, shellEntry);
            shellEntry.sink?.send({ type: "terminal.exit", id, exitCode });
        });
        return { id, cwd };
    }

    private record(s: Shell, text: string) {
        const seen = s.tail + text;
        let last: RegExpMatchArray | undefined;
        for (last of seen.matchAll(ALT_SCREEN));
        if (last) s.alt = last[1] === "h";
        s.tail = seen.slice(-7);
        s.out += text;
        s.total += text.length;
        if (s.out.length > SCROLLBACK * 1.25) s.out = s.out.slice(cleanCut(s.out, s.out.length - SCROLLBACK));
    }

    /** What the window hasn't been sent yet: its latest part only (KEEP), if it's fallen far behind. */
    private sendRest(id: string, s: Shell) {
        if (!s.sink || s.sent === s.total) return;
        const start = s.total - s.out.length;
        let from = s.sent;
        let note = "";
        if (s.total - from > KEEP) {
            from = start + cleanCut(s.out, s.out.length - KEEP);
            note = `\r\n\x1b[0m[${(from - s.sent).toLocaleString("en-US")} characters of output skipped while the terminal caught up]\r\n`;
        }
        this.send(id, s, note + s.out.slice(from - start));
    }

    /** `pos`: where in the output the window now is, which it gives back when it attaches again. */
    private send(id: string, s: Shell, data: string, reset = false) {
        s.sent = s.total;
        s.unacked += data.length;
        s.sink!.send({ type: "terminal.data", id, data, pos: s.total, ...(reset ? { reset: true } : {}) });
    }

    /** Attached to this connection, and running. */
    private attached(owner: Owner, id: string) {
        const s = this.shells.get(id);
        if (!s || s.sink !== owner || s.window !== windowOf(owner) || s.exitCode !== undefined) throw notOpen();
        return s;
    }

    write(owner: Owner, id: string, data: string) {
        const s = this.attached(owner, id);
        if (typeof data !== "string" || data.length > 65_536) throw new RpcError("Terminal input is too large", "invalid");
        // Ctrl+C, a key, a paste, before the shell is ready: the user has taken over, so the command isn't typed.
        // (Not on the terminal's own replies to the shell's queries.)
        if (s.typist?.pending && !isTerminalReply(data)) s.typist.cancel();
        s.terminal.write(data);
    }

    /** The window has sent what was typed while the shell opened: input given at open may now be typed. */
    arm(owner: Owner, id: string) {
        this.attached(owner, id).typist?.arm();
    }

    /** The window has drawn this much of a terminal's output. */
    ack(owner: Owner, id: string, chars: unknown) {
        if (!Number.isSafeInteger(chars) || Number(chars) < 0) throw new RpcError("Invalid terminal ack", "invalid");
        const s = this.shells.get(id);
        // One that has just closed, or is now another connection's: nothing more to send here.
        if (!s || s.sink !== owner) return;
        s.unacked = Math.max(0, s.unacked - Number(chars));
        if (s.holding && s.unacked < RESUME_BELOW) {
            s.holding = false;
            this.sendRest(id, s);
        }
    }

    resize(owner: Owner, id: string, cols: unknown, rows: unknown) {
        const s = this.attached(owner, id);
        s.size = terminalSize(cols, rows);
        s.terminal.resize(s.size.cols, s.size.rows);
    }

    /** The window's terminals, attached or not, running or exited (and nobody else's). */
    list(owner: Owner): TerminalInfo[] {
        const window = windowOf(owner);
        return [...this.shells].filter(([, s]) => s.window === window).map(([id, s]) => this.info(id, s));
    }

    /**
     * The window takes one of its terminals (again), on this connection: after a
     * reload, a reconnect, or from a copy of the window (which then loses it).
     * It's sent the output it lacks first: what follows `have` (how much it has
     * drawn), or, without that or if it's no longer kept, all that's kept, after
     * a reset. Input given at open is never typed now: the window that would have
     * armed it, holding back what was typed meanwhile, isn't this one.
     */
    attach(owner: Owner, id: string, have?: unknown): TerminalInfo {
        if (have != null && (!Number.isSafeInteger(have) || Number(have) < 0)) throw new RpcError("Invalid terminal position", "invalid");
        const s = this.shells.get(id);
        if (!s || s.window !== windowOf(owner)) throw notOpen();
        if (s.expires) clearTimeout(s.expires);
        s.expires = undefined;
        s.typist?.cancel();
        if (s.sink && s.sink !== owner) s.sink.send({ type: "terminal.moved", id });
        s.sink = owner;
        s.unacked = 0;
        s.holding = false;
        const start = s.total - s.out.length;
        const fits = have != null && Number(have) >= start && Number(have) <= s.total;
        s.sent = fits ? Number(have) : start;
        if (s.sent < s.total || !fits) this.send(id, s, s.out.slice(s.sent - start), !fits);
        // A full-screen program draws itself again only when the size changes: the same size again doesn't tell it.
        if (s.exitCode === undefined && s.alt) {
            s.terminal.resize(s.size.cols, s.size.rows > 1 ? s.size.rows - 1 : 2);
            s.terminal.resize(s.size.cols, s.size.rows);
        }
        return this.info(id, s);
    }

    private info(id: string, s: Shell): TerminalInfo {
        return { id, cwd: s.cwd, ...(s.script ? { script: { ...s.script } } : {}), ...(s.exitCode !== undefined ? { exitCode: s.exitCode } : {}) };
    }

    /** Stops it; the connection attached to it, or its window's when none is (its tab closed while away). */
    close(owner: Owner, id: string) {
        const s = this.shells.get(id);
        if (!s || s.window !== windowOf(owner) || (s.sink && s.sink !== owner)) throw notOpen();
        this.kill(id, s);
    }

    private kill(id: string, s: Shell) {
        this.shells.delete(id);
        if (s.timer) clearTimeout(s.timer);
        if (s.expires) clearTimeout(s.expires);
        s.typist?.cancel();
        if (s.exitCode !== undefined) return;
        // Closing the PTY hangs up the foreground job as well as its interactive shell.
        s.terminal.close();
        s.process.kill("SIGHUP");
        const kill = setTimeout(() => { if (s.process.exitCode === null) s.process.kill("SIGKILL"); }, 1000);
        kill.unref();
        void s.process.exited.then(() => clearTimeout(kill));
    }

    /**
     * A connection went away. Its window's terminals keep running (and keep
     * their output) for GRACE, for the window to attach to again, and are
     * stopped then. A connection without a window key was the window: nothing
     * can come back for them, so they stop now.
     */
    drop(owner: Owner) {
        for (const [id, s] of this.shells) {
            // Since attached to another connection (a reloaded window's, say): not this one's to let go of.
            if (s.sink !== owner) continue;
            if (!owner.window) {
                this.kill(id, s);
                continue;
            }
            s.sink = undefined;
            s.unacked = 0;
            s.holding = false;
            s.typist?.cancel();
            s.expires = setTimeout(() => { if (this.shells.get(id) === s) this.kill(id, s); }, this.o.graceMs ?? GRACE_MS);
            s.expires.unref?.();
        }
    }

    stop() {
        for (const [id, s] of this.shells) this.kill(id, s);
    }
}
