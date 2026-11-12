// What a process has started, read from the system's process table, and
// ending it. For a CLI that was told to stop and left the command it was
// running going (src/backends/codex-live.ts).

export interface StartedProcess {
    pid: number;
    /** Its process group: its own pid when it leads one. */
    pgid: number;
    startedAt: number;
}

/**
 * The descendants of `root` that started at `since` or later, from the output of
 * `ps -axo pid=,ppid=,pgid=,lstart=` (in the C locale: "Thu Nov 12 16:29:00 2026", to the second).
 */
export function startedUnder(table: string, root: number, since: number): StartedProcess[] {
    const rows = table.split("\n").flatMap((line) => {
        const m = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S.*\S)\s*$/.exec(line);
        if (!m) return [];
        const startedAt = Date.parse(m[4]!);
        return [{ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), startedAt }];
    });
    const under = new Set([root]);
    const found: StartedProcess[] = [];
    // The table isn't in any order: gone through until nothing more is found under what's known.
    for (let more = true; more; ) {
        more = false;
        for (const r of rows) {
            if (under.has(r.pid) || !under.has(r.ppid)) continue;
            under.add(r.pid);
            more = true;
            // To the second, so one that started in the second before counts.
            if (Number.isFinite(r.startedAt) && r.startedAt >= since - 1000) found.push({ pid: r.pid, pgid: r.pgid, startedAt: r.startedAt });
        }
    }
    return found;
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
};

async function processTable(): Promise<string | undefined> {
    try {
        const ps = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid=,pgid=,lstart="], { stdout: "pipe", stderr: "ignore", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, timeout: 2000, killSignal: "SIGKILL" });
        const table = await new Response(ps.stdout).text();
        return (await ps.exited) === 0 ? table : undefined;
    } catch {
        return undefined;
    }
}

/** Every process under `root` now: undefined where the process table can't be read (a sandbox may not allow it). */
export async function descendantsOf(root: number): Promise<Set<number> | undefined> {
    const table = await processTable();
    return table === undefined ? undefined : new Set(startedUnder(table, root, 0).map((p) => p.pid));
}

/**
 * Ends the process groups `root` has started that aren't in `except` (what it was running at some earlier moment):
 * each new process under it that leads a group, with its group. One that shares its parent's group is left, as is
 * `root`. Asked to stop, and killed if still there after `graceMs`. The pids of the leaders it ended.
 */
export async function endGroupsStartedUnder(root: number, except: ReadonlySet<number>, graceMs = 2000): Promise<number[]> {
    const table = await processTable();
    if (table === undefined) return [];
    const leaders = startedUnder(table, root, 0)
        .filter((p) => !except.has(p.pid) && p.pgid === p.pid)
        .map((p) => p.pid);
    const signal = (pid: number, sig: NodeJS.Signals) => {
        try {
            process.kill(-pid, sig);
        } catch {
            // gone already
        }
    };
    for (const pid of leaders) signal(pid, "SIGTERM");
    const until = Date.now() + graceMs;
    while (Date.now() < until && leaders.some(alive)) await Bun.sleep(50);
    for (const pid of leaders) if (alive(pid)) signal(pid, "SIGKILL");
    return leaders;
}
