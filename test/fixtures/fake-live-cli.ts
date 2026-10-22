// A stand-in agent CLI for the live layer's tests (test/live-pool.test.ts): it
// stays up across prompts, answering each with an echo that names its pid, and
// runs "background tasks" that outlive the turn that started them. JSON lines,
// one object each way:
//
// in   open {resume?}               → opened {session} (the resumed id, else s-<pid>)
//      prompt {id, text}            → started {id}, text {id, text: "echo <text> (pid N)"}, then ended {id, reason: "done"}
//                                     text "bg <task>": also starts a background task (task {id, status: "running"})
//                                     text "hang": no end until interrupted; "deaf": not even then
//                                     text "crash": writes "fatal: boom" to stderr and exits 3
//      interrupt {id}               → ended {id, reason: "aborted"} for a hanging turn; background tasks carry on
//      stop_task {id}               → task {id, status: "stopped"}, unless the task's name starts with "stubborn"
//      finish {task, hold?, later?}  → task {id, status: "done", report: true}, then a turn of its own: started {id: wake-<task>, origin: "wake"},
//                                     text, ended (with hold, not until interrupted); with later, that turn waits for wake {task}
//      wake {task, hold?}           → the turn a finish with later held back
// stdin's end: exits 0.

const out = (o: Record<string, unknown>) => process.stdout.write(JSON.stringify(o) + "\n");
const tasks = new Set<string>();
const hanging = new Map<string, boolean>();

function handle(m: Record<string, any>) {
    switch (m.type) {
        case "open":
            return out({ type: "opened", session: m.resume ?? `s-${process.pid}` });
        case "prompt": {
            const text = String(m.text);
            if (text === "crash") {
                process.stderr.write("fatal: boom\n");
                process.exit(3);
            }
            out({ type: "started", id: m.id });
            out({ type: "text", id: m.id, text: `echo ${text} (pid ${process.pid})` });
            if (text.startsWith("bg ")) {
                const task = text.slice(3);
                tasks.add(task);
                out({ type: "task", id: task, status: "running" });
            }
            if (text === "hang" || text === "deaf") return void hanging.set(m.id, text === "deaf");
            return out({ type: "ended", id: m.id, reason: "done" });
        }
        case "interrupt":
            if (hanging.get(m.id) === false) {
                hanging.delete(m.id);
                out({ type: "ended", id: m.id, reason: "aborted" });
            }
            return;
        case "stop_task":
            if (tasks.has(m.id) && !String(m.id).startsWith("stubborn")) {
                tasks.delete(m.id);
                out({ type: "task", id: m.id, status: "stopped" });
            }
            return;
        case "finish": {
            if (!tasks.delete(m.task)) return;
            out({ type: "task", id: m.task, status: "done", report: true });
            if (m.later) return;
            return wake(m.task, m.hold);
        }
        case "wake":
            return wake(m.task, m.hold);
    }
}

function wake(task: string, hold: boolean) {
    const id = `wake-${task}`;
    out({ type: "started", id, origin: "wake" });
    out({ type: "text", id, text: `${task} finished` });
    if (hold) return void hanging.set(id, false);
    out({ type: "ended", id, reason: "done" });
}

let buf = "";
process.stdin.on("data", (chunk) => {
    buf += chunk.toString();
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) handle(JSON.parse(line));
    }
});
process.stdin.on("end", () => process.exit(0));
