// Requests the server hasn't answered after a while, one JSON line each in ~/.cavvy/logs/requests.log: when one
// passes `afterMs`, then how it ended (answered, failed, or its window went away first), and any reply that never
// left the server. Method and session id only,
// never parameters or results. For finding what a window's "taking a while" notice is waiting on.

import { appendFileSync, mkdirSync, renameSync, statSync } from "fs";
import { dirname, join } from "path";
import { paths } from "../config/paths";

/** Past this the file starts again, the previous one kept as requests.log.1. */
const MAX_BYTES = 1024 * 1024;

export interface RequestWatchOptions {
    /** How long before a request is logged as waiting: the window's notice comes at 15s. */
    afterMs?: number;
    /** Where the lines go; ~/.cavvy/logs/requests.log by default. */
    write?: (line: Record<string, unknown>) => void;
    now?: () => number;
}

/** "unsent": the server finished but the reply never left (it could not be encoded, or the socket dropped it). */
type Ending = "answered" | "failed" | "unsent";

interface Watched {
    method: string;
    session?: string;
    started: number;
    timer: ReturnType<typeof setTimeout>;
    logged: boolean;
}

export class RequestWatch {
    private open = new Map<object, Map<number, Watched>>();
    private afterMs: number;
    private write: (line: Record<string, unknown>) => void;
    private now: () => number;

    constructor(o: RequestWatchOptions = {}) {
        this.afterMs = o.afterMs ?? 15_000;
        this.write = o.write ?? writeLine;
        this.now = o.now ?? Date.now;
    }

    /** A request came in on `conn`: returns what to call with how it ended. */
    start(conn: object, id: number, method: string, params: unknown): (ending: Ending) => void {
        const session = sessionOf(params);
        let byId = this.open.get(conn);
        if (!byId) this.open.set(conn, (byId = new Map()));
        const w: Watched = { method, session, started: this.now(), logged: false, timer: undefined as never };
        w.timer = setTimeout(() => {
            w.logged = true;
            this.write({ what: "waiting", method, session, ms: this.now() - w.started });
        }, this.afterMs);
        w.timer.unref?.();
        // Ids are the window's own: a repeated one replaces the earlier (its reply can't be told apart anyway).
        const earlier = byId.get(id);
        if (earlier) clearTimeout(earlier.timer);
        byId.set(id, w);
        return (ending) => {
            if (this.open.get(conn)?.get(id) !== w) return;
            clearTimeout(w.timer);
            byId.delete(id);
            if (!byId.size) this.open.delete(conn);
            if (w.logged || ending === "unsent") this.write({ what: ending, method, session, ms: this.now() - w.started });
        };
    }

    /** `conn` closed: what it was still waiting on long enough to be logged is noted as never answered there. */
    drop(conn: object) {
        const byId = this.open.get(conn);
        if (!byId) return;
        this.open.delete(conn);
        for (const w of byId.values()) {
            clearTimeout(w.timer);
            if (w.logged) this.write({ what: "dropped", method: w.method, session: w.session, ms: this.now() - w.started });
        }
    }

    /** Server stopping: no more lines. */
    close() {
        for (const byId of this.open.values()) for (const w of byId.values()) clearTimeout(w.timer);
        this.open.clear();
    }
}

/** The session a request is about, when its parameters name one. */
function sessionOf(params: unknown): string | undefined {
    const id = params && typeof params === "object" ? (params as { id?: unknown }).id : undefined;
    return typeof id === "string" && id.length <= 200 ? id : undefined;
}

function writeLine(line: Record<string, unknown>) {
    const file = join(paths.logs(), "requests.log");
    try {
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        try {
            if (statSync(file).size > MAX_BYTES) renameSync(file, `${file}.1`);
        } catch {
            // Not there yet.
        }
        appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...line }) + "\n", { mode: 0o600 });
    } catch {
        // A log that can't be written mustn't break a request.
    }
}
