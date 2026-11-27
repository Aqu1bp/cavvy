// Cross-platform child process tree management.
//
// On POSIX, commands started with `detached: true` lead their own process group,
// so signaling `-pid` reaches the command and every descendant it started.
// On Windows, there are no POSIX process groups and `detached: true` creates a
// separate console; we instead run attached and stop trees with `taskkill /T`
// asynchronously (never spawnSync, so the server event loop is never blocked).

/** `detached` option for spawned child commands that should be killed as a tree. */
export const DETACHED = process.platform !== "win32";

/** Whether any process in the tree/group is still alive. */
export function treeAlive(pid: number): boolean {
    try {
        process.kill(process.platform === "win32" ? pid : -pid, 0);
        return true;
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "EPERM";
    }
}

/**
 * Sends a signal to the process group (POSIX) or terminates the process tree (Windows).
 * Returns false when the target is already gone (`ESRCH`); rethrows unexpected errors
 * on POSIX only when `rethrow` is true.
 */
export function signalTree(pid: number, signal: NodeJS.Signals, o: { rethrow?: boolean } = {}): boolean {
    if (process.platform === "win32") {
        if (!treeAlive(pid)) return false;
        const args = ["taskkill", "/PID", String(pid), "/T", ...(signal === "SIGKILL" ? ["/F"] : [])];
        try {
            const p = Bun.spawn(args, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
            p.unref();
        } catch {
            try {
                process.kill(pid, signal);
            } catch {
                return false;
            }
        }
        return true;
    }
    try {
        process.kill(-pid, signal);
        return true;
    } catch (e) {
        if (o.rethrow && (e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
        return false;
    }
}

/** Synchronous best-effort kill for `process.on("exit")` hooks, where async spawns cannot complete. */
export function killTreeOnExit(pid: number) {
    try {
        process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL");
    } catch {
        // already gone
    }
}

/**
 * Ask the process tree to stop, give it `graceMs` to exit, then force-kill
 * whatever is left.
 */
export async function stopTree(pid: number | undefined, graceMs: number): Promise<"gone" | "stopped" | "killed"> {
    if (pid === undefined || !treeAlive(pid)) return "gone";
    if (process.platform === "win32") {
        try {
            const soft = Bun.spawn(["taskkill", "/PID", String(pid), "/T"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
            void soft.exited;
        } catch {
            try {
                process.kill(pid);
            } catch {
                return "gone";
            }
        }
        for (const until = Date.now() + graceMs; Date.now() < until; ) {
            await new Promise((r) => setTimeout(r, 50));
            if (!treeAlive(pid)) return "stopped";
        }
        try {
            const hard = Bun.spawn(["taskkill", "/PID", String(pid), "/T", "/F"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
            await Promise.race([hard.exited, new Promise((r) => setTimeout(r, 3000))]);
        } catch {
            try {
                process.kill(pid);
            } catch {
                return "stopped";
            }
        }
        for (let i = 0; i < 20 && treeAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
        return "killed";
    }
    if (!signalTree(pid, "SIGTERM")) return "gone";
    for (const until = Date.now() + graceMs; Date.now() < until; ) {
        await new Promise((r) => setTimeout(r, 50));
        if (!treeAlive(pid)) return "stopped";
    }
    if (!signalTree(pid, "SIGKILL")) return "stopped";
    for (let i = 0; i < 20 && treeAlive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    return "killed";
}
