// User-operated shells, isolated from agent sessions and owned by one GUI connection.
import { statSync } from "fs";
import { resolve, isAbsolute } from "path";
import { userInfo } from "os";
import { childEnv } from "../util/env";
import type { ServerEvent } from "./protocol";

interface Owner { send(event: ServerEvent): void }
interface Shell {
    owner: Owner;
    process: ReturnType<typeof Bun.spawn>;
    terminal: Bun.Terminal;
    flush(): void;
    timer?: ReturnType<typeof setTimeout>;
}

export function terminalSize(cols: unknown, rows: unknown): { cols: number; rows: number } {
    if (!Number.isInteger(cols) || !Number.isInteger(rows) || Number(cols) < 2 || Number(cols) > 500 || Number(rows) < 1 || Number(rows) > 300) throw new Error("Invalid terminal size");
    return { cols: Number(cols), rows: Number(rows) };
}

export class Terminals {
    private shells = new Map<string, Shell>();

    open(owner: Owner, id: string, cwd: string, cols: unknown, rows: unknown) {
        const size = terminalSize(cols, rows);
        if (!/^[a-zA-Z0-9-]{1,80}$/.test(id) || this.shells.has(id)) throw new Error("Invalid or duplicate terminal id");
        if (this.shells.size >= 48 || [...this.shells.values()].filter((s) => s.owner === owner).length >= 12) throw new Error("Close a terminal before opening another (12 per window)");
        cwd = resolve(cwd);
        if (!statSync(cwd).isDirectory()) throw new Error("Terminal folder does not exist");
        if (process.platform === "win32") throw new Error("The embedded terminal requires macOS or Linux with this Bun version");
        let shell = process.env.SHELL;
        if (!shell || !isAbsolute(shell)) shell = userInfo().shell || "/bin/sh";
        const env = childEnv({ TERM: "xterm-256color", COLORTERM: "truecolor" });
        // These defaults are for agent tools; a user's interactive shell needs normal pagers/prompts.
        for (const k of ["PAGER", "GIT_PAGER", "GIT_TERMINAL_PROMPT"]) delete env[k];
        const decoder = new TextDecoder();
        let pending = "";
        let entry: Shell;
        const flush = () => {
            if (entry?.timer) clearTimeout(entry.timer);
            if (entry) entry.timer = undefined;
            if (!pending) return;
            owner.send({ type: "terminal.data", id, data: pending });
            pending = "";
        };
        const terminal = new Bun.Terminal({ ...size, name: "xterm-256color", data: (_t, bytes) => {
            pending += decoder.decode(bytes, { stream: true });
            if (pending.length >= 32_768) flush();
            else if (entry && !entry.timer) entry.timer = setTimeout(flush, 16);
        } });
        let proc: ReturnType<typeof Bun.spawn>;
        try {
            proc = Bun.spawn([shell, "-il"], { cwd, env, terminal, detached: true });
        } catch (e) {
            terminal.close();
            throw e;
        }
        entry = { owner, process: proc, terminal, flush };
        this.shells.set(id, entry);
        void proc.exited.then((exitCode) => {
            if (this.shells.get(id) !== entry) return;
            pending += decoder.decode();
            flush();
            this.shells.delete(id);
            terminal.close();
            owner.send({ type: "terminal.exit", id, exitCode });
        });
        return { id, cwd };
    }

    private owned(owner: Owner, id: string) {
        const s = this.shells.get(id);
        if (!s || s.owner !== owner) throw new Error("That terminal is not open in this window");
        return s;
    }

    write(owner: Owner, id: string, data: string) {
        const s = this.owned(owner, id);
        if (typeof data !== "string" || data.length > 65_536) throw new Error("Terminal input is too large");
        s.terminal.write(data);
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
