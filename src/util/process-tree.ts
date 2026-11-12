// Finding and ending a command a process started and left running, from the
// system's process table. For a CLI that was told to stop and left the command
// it was running going (src/backends/codex-live.ts).

export interface ProcessRow {
    pid: number;
    ppid: number;
    /** Its process group: its own pid when it leads one. */
    pgid: number;
}

/** The rows of `ps -axo pid=,ppid=,pgid=`: numbers only, so nothing a process calls itself can pass for a row. */
export function processRows(table: string): ProcessRow[] {
    return table.split("\n").flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s*$/.exec(line);
        return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]) }] : [];
    });
}

/** Every process under `root` (not `root` itself), whatever order the table is in. */
export function under(rows: ProcessRow[], root: number): ProcessRow[] {
    const seen = new Set([root]);
    const found: ProcessRow[] = [];
    for (let more = true; more; ) {
        more = false;
        for (const r of rows) {
            if (seen.has(r.pid) || !seen.has(r.ppid)) continue;
            seen.add(r.pid);
            found.push(r);
            more = true;
        }
    }
    return found;
}

const PS_ENV = { LC_ALL: "C", PATH: "/usr/bin:/bin" };

async function ps(args: string[]): Promise<string | undefined> {
    try {
        const proc = Bun.spawn(["/bin/ps", ...args], { stdout: "pipe", stderr: "ignore", env: PS_ENV, timeout: 2000, killSignal: "SIGKILL" });
        const out = await new Response(proc.stdout).text();
        return (await proc.exited) === 0 ? out : undefined;
    } catch {
        return undefined;
    }
}

/** Every process under `root` now: undefined where the process table can't be read (a sandbox may not allow it). */
export async function descendantsOf(root: number): Promise<Set<number> | undefined> {
    const table = await ps(["-axo", "pid=,ppid=,pgid="]);
    return table === undefined ? undefined : new Set(under(processRows(table), root).map((p) => p.pid));
}

/** A command line with its quoting taken off, to compare one as it was written with one as a process shows it. */
const bare = (s: string) => s.replace(/["'\\]/g, "").replace(/\s+/g, " ").trim();

/** Whether anything is left of a process group. */
const groupAlive = (pgid: number) => {
    try {
        process.kill(-pgid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
};

/**
 * Ends the commands `root` started and left running: the process groups under it that weren't in `except` (what it
 * was running at some earlier moment) and whose leader's command line holds one of `commands`. Nothing else under
 * it is touched: not what it was already running, not what those have started since, not a command of another
 * name. Each group is asked to stop, and killed if any of it is still there after `graceMs`. The leaders it ended.
 */
export async function endCommandsUnder(root: number, except: ReadonlySet<number>, commands: string[], graceMs = 2000): Promise<number[]> {
    const wanted = commands.map(bare).filter((c) => c.length > 0);
    const table = await ps(["-axo", "pid=,ppid=,pgid="]);
    if (table === undefined || !wanted.length) return [];
    const leaders: number[] = [];
    for (const p of under(processRows(table), root)) {
        if (except.has(p.pid) || p.pgid !== p.pid) continue;
        // Asked of one process at a time: what a process calls itself is its own to choose, and is only compared.
        const line = await ps(["-ww", "-o", "args=", "-p", String(p.pid)]);
        if (line !== undefined && wanted.some((c) => bare(line).includes(c))) leaders.push(p.pid);
    }
    const signal = (pid: number, sig: NodeJS.Signals) => {
        try {
            process.kill(-pid, sig);
        } catch {
            // gone already
        }
    };
    for (const pid of leaders) signal(pid, "SIGTERM");
    const until = Date.now() + graceMs;
    // The group, not its leader: a shell goes at once and what it was running may not.
    while (Date.now() < until && leaders.some(groupAlive)) await Bun.sleep(50);
    for (const pid of leaders) if (groupAlive(pid)) signal(pid, "SIGKILL");
    return leaders;
}
