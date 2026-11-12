// What a session's commands left running where Cavvy can't see it: a server started with nohup, a process that put
// itself in a session of its own, anything whose parent has gone. The shells and tasks Cavvy started it can stop by
// their process groups; these it finds by a mark every command of the session is started with (SESSION_VAR in its
// environment, which children inherit), and only once they are no longer under Cavvy itself.
//
// Read from the system's process table when the user asks for everything of a session to stop, never while it works.
// Linux only: see leftRunning.

import { readdir, readFile } from "fs/promises";

/** The environment variable a session's commands carry: the session's id. */
export const SESSION_VAR = "CAVVY_SESSION";

export interface Proc {
    pid: number;
    ppid: number;
    marked: boolean;
    /** When it started, as the system counts it: with the pid, which process this is (a pid is used again). */
    start: string;
}

/** One left behind: which process, and what to call it. */
export interface Left {
    pid: number;
    start: string;
    /** Its command line, cut short. */
    name: string;
}

/** A process's parent and start from its `stat`: "pid (comm) state ppid …", where comm may hold spaces and brackets. */
function parseStat(stat: string): { ppid: number; start: string } | undefined {
    const f = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number(f[1]);
    // starttime is the 22nd field; these start at the 3rd.
    return Number.isInteger(ppid) ? { ppid, start: f[19] ?? "" } : undefined;
}

/**
 * Each process's parent, and whether its environment has the mark, from Linux's /proc (readable for this user's own
 * processes). `root` is /proc itself; tests give a stand-in.
 */
export async function readProc(mark: string, root = "/proc"): Promise<Proc[] | undefined> {
    let pids: string[];
    try {
        pids = (await readdir(root)).filter((d) => /^\d+$/.test(d));
    } catch {
        return undefined;
    }
    const out: Proc[] = [];
    for (const d of pids) {
        try {
            const at = parseStat(await readFile(`${root}/${d}/stat`, "utf-8"));
            if (!at) continue;
            let marked = false;
            try {
                marked = `\0${await readFile(`${root}/${d}/environ`, "utf-8")}`.includes(`\0${mark}\0`);
            } catch {
                // another user's, or gone: not this session's
            }
            out.push({ pid: Number(d), ...at, marked });
        } catch {
            // gone meanwhile
        }
    }
    return out;
}

/** Of `procs`, those that carry the mark and aren't `self` or under it. */
export function strays(procs: Proc[], self: number): Proc[] {
    const parent = new Map(procs.map((p) => [p.pid, p.ppid]));
    const mine = (pid: number) => {
        for (let at: number | undefined = pid, hops = 0; at !== undefined && hops < 64; at = parent.get(at), hops++) {
            if (at === self) return true;
            if (at <= 1) return false;
        }
        return false;
    };
    return procs.filter((p) => p.marked && !mine(p.pid));
}

/** What to call a process: its command line, on one line and cut short. */
async function nameOf(pid: number, root: string): Promise<string> {
    const text = await readFile(`${root}/${pid}/cmdline`, "utf-8")
        .then((c) => c.replace(/\0+$/, "").replace(/[\0\s]+/g, " "))
        .catch(() => "");
    const name = text || `process ${pid}`;
    return name.length > 60 ? `${name.slice(0, 59)}…` : name;
}

/**
 * The processes carrying a session's mark that are no longer under this Cavvy: what its commands left behind. Those
 * still under Cavvy (a shell it runs, an agent CLI and what that runs) are Cavvy's to stop the usual way, and are
 * left out. Undefined where it can't be told: only Linux lets a process's environment be read (measured: macOS's
 * ps shows none for the system's own programs, a `sleep` or a shell), so elsewhere nothing is looked for.
 */
export async function leftRunning(session: string, self = process.pid, root = "/proc"): Promise<Left[] | undefined> {
    if (process.platform !== "linux" && root === "/proc") return undefined;
    if (!/^[\w.-]{1,120}$/.test(session)) return [];
    const procs = await readProc(`${SESSION_VAR}=${session}`, root);
    if (!procs) return undefined;
    return Promise.all(strays(procs, self).map(async (p) => ({ pid: p.pid, start: p.start, name: await nameOf(p.pid, root) })));
}

/** Still the process that was found, not another that got its pid since. */
async function stillThere(p: Left, root: string): Promise<boolean> {
    const at = await readFile(`${root}/${p.pid}/stat`, "utf-8").then(parseStat, () => undefined);
    return at?.start === p.start;
}

/**
 * Ends these (leftRunning's): asked to stop, then those still there after `graceMs` killed. One whose pid has since
 * become another process is left alone. What was ended, by name.
 */
export async function endThese(left: Left[], graceMs = 2000, root = "/proc"): Promise<string[]> {
    const there = async () => (await Promise.all(left.map(async (p) => ((await stillThere(p, root)) ? p : undefined)))).filter((p) => p !== undefined);
    const signal = (ps: Left[], sig: NodeJS.Signals) => {
        for (const p of ps) {
            try {
                process.kill(p.pid, sig);
            } catch {
                // gone already
            }
        }
    };
    const asked = await there();
    signal(asked, "SIGTERM");
    for (const until = Date.now() + graceMs; Date.now() < until && (await there()).length; ) await Bun.sleep(50);
    signal(await there(), "SIGKILL");
    return asked.map((p) => p.name);
}

/** Ends what a session's commands left running (leftRunning, endThese). What was ended, by name. */
export async function endLeftRunning(session: string, graceMs = 2000): Promise<string[]> {
    return endThese((await leftRunning(session)) ?? [], graceMs);
}

/** The line that says what stopping everything also ended. */
export function leftNotice(names: string[]): string {
    const shown = names.slice(0, 3).join(", ");
    const more = names.length > 3 ? `, and ${names.length - 3} more` : "";
    return `Stopped ${names.length === 1 ? "a process" : `${names.length} processes`} this session left running: ${shown}${more}`;
}
