// What a session's commands left running where Cavvy can't see it: a server started with nohup, a process that put
// itself in a session of its own, anything whose parent has gone. The shells and tasks Cavvy started it can stop by
// their process groups; these it finds by a mark every command of the session is started with (SESSION_VAR in its
// environment, which children inherit), and only once they are no longer under Cavvy itself.
//
// Read from the system's process table when the user asks for everything of a session to stop, never while it works.
// Linux only: see leftRunning.

import { readdirSync, readFileSync } from "fs";

/** The environment variable a session's commands carry: the session's id. */
export const SESSION_VAR = "CAVVY_SESSION";

export interface Proc {
    pid: number;
    ppid: number;
    marked: boolean;
}

/**
 * Each process's parent, and whether its environment has the mark, from Linux's /proc (readable for this user's own
 * processes). `root` is /proc itself; tests give a stand-in.
 */
export function readProc(mark: string, root = "/proc"): Proc[] | undefined {
    let pids: string[];
    try {
        pids = readdirSync(root).filter((d) => /^\d+$/.test(d));
    } catch {
        return undefined;
    }
    const out: Proc[] = [];
    for (const d of pids) {
        try {
            // "pid (comm) state ppid …": comm may hold spaces and brackets, so the fields after its last ")".
            const stat = readFileSync(`${root}/${d}/stat`, "utf-8");
            const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
            if (!Number.isInteger(ppid)) continue;
            let marked = false;
            try {
                marked = `\0${readFileSync(`${root}/${d}/environ`, "utf-8")}`.includes(`\0${mark}\0`);
            } catch {
                // another user's, or gone: not this session's
            }
            out.push({ pid: Number(d), ppid, marked });
        } catch {
            // gone meanwhile
        }
    }
    return out;
}

/** Of `procs`, those that carry the mark and aren't `self` or under it. */
export function strays(procs: Proc[], self: number): number[] {
    const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
    const mine = (pid: number) => {
        for (let at: number | undefined = pid, hops = 0; at !== undefined && at > 1 && hops < 64; at = parent.get(at), hops++) if (at === self) return true;
        return false;
    };
    return procs.filter((p) => p.marked && p.pid !== self && !mine(p.pid)).map((p) => p.pid);
}

/**
 * The processes carrying a session's mark that are no longer under this Cavvy: what its commands left behind. Those
 * still under Cavvy (a shell it runs, an agent CLI and what that runs) are Cavvy's to stop the usual way, and are
 * left out. Undefined where it can't be told: only Linux lets a process's environment be read (measured: macOS's
 * ps shows none for the system's own programs, a `sleep` or a shell), so elsewhere nothing is looked for.
 */
export async function leftRunning(session: string, self = process.pid): Promise<number[] | undefined> {
    if (process.platform !== "linux") return undefined;
    if (!/^[\w.-]{1,120}$/.test(session)) return [];
    const procs = readProc(`${SESSION_VAR}=${session}`);
    return procs && strays(procs, self);
}

const alive = (pid: number) => {
    try {
        process.kill(pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
};

/** Ends what a session's commands left running (leftRunning): asked to stop, then killed after `graceMs`. How many. */
export async function endLeftRunning(session: string, graceMs = 2000): Promise<number> {
    const pids = (await leftRunning(session)) ?? [];
    const signal = (sig: NodeJS.Signals) => {
        for (const pid of pids) {
            try {
                process.kill(pid, sig);
            } catch {
                // gone already
            }
        }
    };
    signal("SIGTERM");
    for (const until = Date.now() + graceMs; Date.now() < until && pids.some(alive); ) await Bun.sleep(50);
    if (pids.some(alive)) signal("SIGKILL");
    return pids.length;
}
