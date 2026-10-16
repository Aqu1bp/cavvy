// User-operated shells, isolated from agent sessions and owned by one GUI connection.
import { statSync } from "fs";
import { resolve, isAbsolute } from "path";
import { userInfo } from "os";
import { childEnv } from "../util/env";
import { RpcError } from "./rpc-error";
import type { ServerEvent } from "./protocol";

interface Owner { send(event: ServerEvent): void }
interface Shell {
    owner: Owner;
    process: ReturnType<typeof Bun.spawn>;
    terminal: Bun.Terminal;
    timer?: ReturnType<typeof setTimeout>;
    /** Sent, and not yet drawn by the window (it acks what it has drawn). */
    unacked: number;
    /** Output held back while the window catches up: the latest of it only. */
    held: string;
    skipped: number;
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

export class Terminals {
    private shells = new Map<string, Shell>();

    open(owner: Owner, id: string, cwd: string, cols: unknown, rows: unknown) {
        const size = terminalSize(cols, rows);
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || this.shells.has(id)) throw new RpcError("Invalid or duplicate terminal id", "invalid");
        if (this.shells.size >= 48 || [...this.shells.values()].filter((s) => s.owner === owner).length >= 12) throw new RpcError("Close a terminal before opening another (12 per window, across projects)", "limit");
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
        const flush = () => {
            if (!entry) return;
            if (entry.timer) clearTimeout(entry.timer);
            entry.timer = undefined;
            if (!pending) return;
            if (entry.held || entry.unacked >= MAX_UNACKED) this.hold(entry, pending);
            else this.send(id, entry, pending);
            pending = "";
        };
        const terminal = new Bun.Terminal({ ...size, name: "xterm-256color", data: (_t, bytes) => {
            pending += decoder.decode(bytes, { stream: true });
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
        const shellEntry: Shell = { owner, process: proc, terminal, unacked: 0, held: "", skipped: 0 };
        entry = shellEntry;
        this.shells.set(id, shellEntry);
        void proc.exited.then((exitCode) => {
            if (this.shells.get(id) !== shellEntry) return;
            pending += decoder.decode();
            flush();
            // Nothing follows: what was held back goes now.
            this.release(id, shellEntry);
            this.shells.delete(id);
            terminal.close();
            owner.send({ type: "terminal.exit", id, exitCode });
        });
        return { id, cwd };
    }

    private send(id: string, s: Shell, data: string) {
        s.unacked += data.length;
        s.owner.send({ type: "terminal.data", id, data });
    }

    private hold(s: Shell, data: string) {
        s.held += data;
        if (s.held.length <= KEEP) return;
        let cut = s.held.length - KEEP;
        // Not between the halves of a surrogate pair.
        if (/[\uDC00-\uDFFF]/.test(s.held[cut]!)) cut++;
        s.skipped += cut;
        s.held = s.held.slice(cut);
    }

    private release(id: string, s: Shell) {
        if (!s.held) return;
        const note = s.skipped ? `\r\n\x1b[0m[${s.skipped.toLocaleString("en-US")} characters of output skipped while the terminal caught up]\r\n` : "";
        const data = note + s.held;
        s.held = "";
        s.skipped = 0;
        this.send(id, s, data);
    }

    private owned(owner: Owner, id: string) {
        const s = this.shells.get(id);
        if (!s || s.owner !== owner) throw new RpcError("That terminal is not open in this window", "terminal_not_open");
        return s;
    }

    write(owner: Owner, id: string, data: string) {
        const s = this.owned(owner, id);
        if (typeof data !== "string" || data.length > 65_536) throw new RpcError("Terminal input is too large", "invalid");
        s.terminal.write(data);
    }

    /** The window has drawn this much of a terminal's output. */
    ack(owner: Owner, id: string, chars: unknown) {
        if (!Number.isSafeInteger(chars) || Number(chars) < 0) throw new RpcError("Invalid terminal ack", "invalid");
        const s = this.shells.get(id);
        // One that has just exited or closed: nothing more to send.
        if (!s || s.owner !== owner) return;
        s.unacked = Math.max(0, s.unacked - Number(chars));
        if (s.held && s.unacked < RESUME_BELOW) this.release(id, s);
    }

    resize(owner: Owner, id: string, cols: unknown, rows: unknown) {
        const s = this.owned(owner, id);
        const size = terminalSize(cols, rows);
        s.terminal.resize(size.cols, size.rows);
    }

    close(owner: Owner, id: string) {
        const s = this.owned(owner, id);
        this.shells.delete(id);
        if (s.timer) clearTimeout(s.timer);
        // Closing the PTY hangs up the foreground job as well as its interactive shell.
        s.terminal.close();
        s.process.kill("SIGHUP");
        const kill = setTimeout(() => { if (s.process.exitCode === null) s.process.kill("SIGKILL"); }, 1000);
        kill.unref();
        void s.process.exited.then(() => clearTimeout(kill));
    }

    drop(owner: Owner) {
        for (const [id, s] of this.shells) if (s.owner === owner) this.close(owner, id);
    }

    stop() {
        for (const [id, s] of this.shells) this.close(s.owner, id);
    }
}
