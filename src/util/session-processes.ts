// What a session's commands left running where Cavvy can't see it: a server started with nohup, a process that put
// itself in a session of its own, anything whose parent has gone. The shells and tasks Cavvy started it can stop by
// their process groups; these it finds by a mark every command of the session is started with (SESSION_VAR in its
// environment, which children inherit), and only once they are no longer under Cavvy itself.
//
// Read from the system's process table when the user asks for everything of a session to stop, never while it works.

import { readdirSync, readFileSync } from "fs";

/** The environment variable a session's commands carry: the session's id. */
export const SESSION_VAR = "CAVVY_SESSION";

interface Proc {
    pid: number;
    ppid: number;
    marked: boolean;
}

/** Linux: each process's parent, and whether its environment has the mark (readable for this user's own). */
function fromProc(mark: string): Proc[] | undefined {
    let pids: string[];
    try {
        pids = readdirSync("/proc").filter((d) => /^\d+$/.test(d));
    } catch {
        return undefined;
    }
    const out: Proc[] = [];
    for (const d of pids) {
        try {
            // "pid (comm) state ppid …": comm may hold spaces and brackets, so the fields after its last ")".
            const stat = readFileSync(`/proc/${d}/stat`, "utf-8");
            const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
            let marked = false;
            try {
                marked = `\0${readFileSync(`/proc/${d}/environ`, "utf-8")}`.includes(`\0${mark}\0`);
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

/** Elsewhere (macOS): ps, which shows this user's processes' environments after their commands. */
async function fromPs(mark: string): Promise<Proc[] | undefined> {
    try {
        const proc = Bun.spawn(["/bin/ps", "-axEww", "-o", "pid=,ppid=,command="], { stdout: "pipe", stderr: "ignore", env: { LC_ALL: "C", PATH: "/usr/bin:/bin" }, timeout: 5000, killSignal: "SIGKILL" });
        const text = await new Response(proc.stdout).text();
        if ((await proc.exited) !== 0) return undefined;
        return text.split("\n").flatMap((line) => {
            const m = /^\s*(\d+)\s+(\d+)\s(.*)$/.exec(line);
            return m ? [{ pid: Number(m[1]), ppid: Number(m[2]), marked: ` ${m[3]} `.includes(` ${mark} `) }] : [];
        });
    } catch {
        return undefined;
    }
}

/**
 * The processes carrying a session's mark that are no longer under this Cavvy: what its commands left behind. Those
 * still under Cavvy (a shell it runs, an agent CLI and what that runs) are Cavvy's to stop the usual way, and are
 * left out. Undefined where the process table can't be read.
 */
export async function leftRunning(session: string, self = process.pid): Promise<number[] | undefined> {
    if (!/^[\w.-]{1,120}$/.test(session)) return [];
    const mark = `${SESSION_VAR}=${session}`;
    const procs = process.platform === "linux" ? fromProc(mark) : await fromPs(mark);
    if (!procs) return undefined;
    const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
    const mine = (pid: number) => {
        for (let at: number | undefined = pid, hops = 0; at !== undefined && at > 1 && hops < 64; at = parent.get(at), hops++) if (at === self) return true;
        return false;
    };
    return procs.filter((p) => p.marked && p.pid !== self && !mine(p.pid)).map((p) => p.pid);
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
