// A command of Cavvy's own, run with arguments only and a limit it can't
// outlast: at the limit, or when it's stopped, it ends together with
// whatever it started.

/** How long what it printed is waited for once it has exited: something it left running may hold its output open. */
const DRAIN_MS = 300;
/** Asked to end, then made to. */
const KILL_AFTER_MS = 2000;

/** The groups under way: ended with Cavvy, which they'd otherwise outlive (a group of its own isn't its parent's). */
const live = new Set<number>();
let onExit = false;
function track(pid: number) {
    live.add(pid);
    if (onExit) return;
    onExit = true;
    process.once("exit", () => {
        for (const g of live) {
            try {
                process.kill(-g, "SIGKILL");
            } catch {
                // already gone
            }
        }
    });
}

export interface BoundedRun {
    code: number;
    /** What it printed, its errors after its output. */
    out: string;
}

/**
 * Runs `argv` and answers when it exits, when `timeoutMs` passes or when `signal` aborts, whichever is first.
 * It runs in a process group of its own, and the whole group is ended at the limit, and when its first process
 * exits: a wrapper script's child (the real CLI) doesn't run on, and doesn't keep this waiting by holding the
 * output open.
 */
export async function runBounded(argv: string[], o: { cwd: string; env: Record<string, string>; stdin?: string; timeoutMs: number; signal?: AbortSignal }): Promise<BoundedRun> {
    const proc = Bun.spawn(argv, { cwd: o.cwd, env: o.env, stdin: o.stdin === undefined ? "ignore" : Buffer.from(o.stdin), stdout: "pipe", stderr: "pipe", detached: true });
    /** Signals the group; false when nothing of it is left. */
    const group = (sig: NodeJS.Signals) => {
        try {
            process.kill(-proc.pid, sig);
            return true;
        } catch {
            return false;
        }
    };
    track(proc.pid);
    let force: ReturnType<typeof setTimeout> | undefined;
    const end = () => {
        // Nothing left (it exited and left nothing running, the usual case): no signal is owed later, when its
        // number could be another program's.
        if (!group("SIGTERM")) return void live.delete(proc.pid);
        // Tracked until then: if Cavvy exits first, the exit hook ends the group.
        force ??= setTimeout(() => {
            group("SIGKILL");
            live.delete(proc.pid);
        }, KILL_AFTER_MS);
        force.unref?.();
    };
    const timer = setTimeout(end, o.timeoutMs);
    o.signal?.addEventListener("abort", end, { once: true });
    if (o.signal?.aborted) end();
    const readers: { cancel(): Promise<void> }[] = [];
    const read = async (stream: ReadableStream<Uint8Array>) => {
        const reader = stream.getReader();
        readers.push(reader);
        const text = new TextDecoder();
        let all = "";
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                all += text.decode(value, { stream: true });
            }
        } catch {
            // Stopped reading: what came so far stands.
        }
        return all;
    };
    const out = read(proc.stdout);
    const err = read(proc.stderr);
    try {
        const code = await proc.exited;
        // Its own output is there by now, or a moment later; something still holding it open isn't waited for.
        let drain: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([Promise.all([out, err]), new Promise((r) => { drain = setTimeout(r, DRAIN_MS); })]);
        clearTimeout(drain);
        for (const r of readers) void r.cancel().catch(() => {});
        // What it left running goes too (asked, then made to): one such per status check would add up.
        end();
        return { code, out: (await out) + (await err) };
    } finally {
        clearTimeout(timer);
        o.signal?.removeEventListener("abort", end);
        // Not left tracked for good, whatever happened above: only a group still to be made to go stays.
        if (!force) live.delete(proc.pid);
    }
}
