// A watcher for a process group that must not outlive this one. Its stdin is a private pipe that closes even if
// this process is SIGKILLed; the process it guards never inherits it. When the pipe closes without the word "done",
// the watcher stops the group.

/** `pid` leads its own process group (it was started detached); `name` shows in process listings. */
export function parentGuard(pid: number, name = "parent-guard") {
    return Bun.spawn(["/bin/sh", "-c", `
        if IFS= read -r action && [ "$action" = done ]; then exit 0; fi
        kill -HUP -- "-$1" 2>/dev/null
        sleep 1
        kill -KILL -- "-$1" 2>/dev/null
        exit 0
    `, name, String(pid)], { stdin: "pipe", stdout: "ignore", stderr: "ignore", detached: true });
}

/** The guarded group was stopped in order: the watcher leaves it alone and exits. */
export async function disarmGuard(guard: ReturnType<typeof parentGuard>) {
    try { guard.stdin.write("done\n"); guard.stdin.end(); } catch {}
    await guard.exited;
}
