// Sessions are append-only JSONL files under ~/.harness/projects/<slug>/.
// Each line is one record; a "compact" record starts a fresh history.
// Everything is passed through the redactor before it touches disk.

import { appendFileSync, existsSync, openSync, readSync, closeSync, readdirSync, readFileSync, statSync, chmodSync } from "fs";
import { join } from "path";
import { randomBytes } from "crypto";
import { ensureDir, paths, projectStateDir, APP_VERSION } from "../config/paths";
import type { Message, Usage } from "../providers/types";
import { textOf } from "../providers/types";
import { redact, redactedJson } from "../util/redact";

export { redactedJson };

export interface SessionMeta {
    id: string;
    cwd: string;
    createdAt: number;
    version: string;
    /** Frozen system prompt; reused on resume so the prompt prefix stays identical. */
    system?: string;
}


/**
 * Content as the providers will see it: text and tool results redacted, so a
 * key pasted into a prompt or printed by a tool reaches neither the
 * transcript nor any model. Assistant turns keep their signed or encrypted
 * reasoning byte for byte (replay verifies it); their text, tool inputs and
 * raw wire copies are redacted like everything else.
 */
export function redactMessage(m: Message): Message {
    if (m.role === "assistant") {
        const plain = JSON.stringify(m);
        const red = redactedJson(m);
        return red === plain ? m : (JSON.parse(red) as Message);
    }
    let changed = false;
    const content = m.content.map((p) => {
        if (p.type === "text") {
            const text = redact(p.text);
            if (text === p.text) return p;
            changed = true;
            return { ...p, text };
        }
        if (p.type === "tool_result") {
            const c = redact(p.content);
            if (c === p.content) return p;
            changed = true;
            return { ...p, content: c };
        }
        return p;
    });
    return changed ? { ...m, content } : m;
}

type Line =
    | ({ t: "meta" } & SessionMeta)
    | { t: "msg"; m: Message }
    | { t: "model"; model: string }
    | { t: "title"; title: string }
    | { t: "compact"; summary: string }
    | { t: "usage"; usage: Usage; cost: number; model: string };

export interface SessionSummary {
    id: string;
    file: string;
    cwd: string;
    createdAt: number;
    updatedAt: number;
    title: string;
    messages: number;
}

export class Session {
    readonly meta: SessionMeta;
    messages: Message[] = [];
    model?: string;
    title?: string;
    /** USD spent in this session (estimates included). */
    cost = 0;
    usageByModel = new Map<string, { usage: Usage; cost: number }>();
    private file: string;
    private persist: boolean;

    constructor(meta: SessionMeta, opts: { persist?: boolean; file?: string } = {}) {
        this.meta = meta;
        this.persist = opts.persist ?? true;
        this.file = opts.file ?? join(projectStateDir(meta.cwd), `${meta.id}.jsonl`);
    }

    static create(cwd: string, opts: { persist?: boolean; system?: string } = {}): Session {
        const id = `${new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "").replace("T", "-")}-${randomBytes(3).toString("hex")}`;
        const s = new Session({ id, cwd, createdAt: Date.now(), version: APP_VERSION, system: opts.system }, opts);
        return s;
    }

    get path(): string {
        return this.file;
    }

    get persisted(): boolean {
        return this.persist;
    }

    private started = false;
    /** Lines held back until the first message, so idle launches leave no file. */
    private pending: Line[] = [];

    private write(line: Line) {
        if (!this.persist) return;
        if (!this.started && line.t !== "msg" && !existsSync(this.file)) {
            this.pending.push(line);
            return;
        }
        try {
            if (!this.started) {
                this.started = true;
                ensureDir(projectStateDir(this.meta.cwd));
                if (!existsSync(this.file)) {
                    appendFileSync(this.file, redactedJson({ t: "meta", ...this.meta }) + "\n", { mode: 0o600 });
                    chmodSync(this.file, 0o600);
                }
            }
            const lines = [...this.pending.splice(0), line];
            appendFileSync(this.file, lines.map((l) => redactedJson(l) + "\n").join(""));
        } catch {
            // Persistence is best effort; the session keeps working in memory.
        }
    }

    setSystem(system: string) {
        this.meta.system = system;
    }

    /** Store a message (redacted); returns the stored copy. */
    push<M extends Message>(m: M): M {
        m = redactMessage(m) as M;
        this.messages.push(m);
        this.write({ t: "msg", m });
        return m;
    }

    setModel(ref: string) {
        this.model = ref;
        this.write({ t: "model", model: ref });
    }

    setTitle(title: string) {
        this.title = title;
        this.write({ t: "title", title });
    }

    recordUsage(model: string, usage: Usage, cost: number) {
        this.accumulate(model, usage, cost);
        this.write({ t: "usage", usage, cost, model });
    }

    private accumulate(model: string, usage: Usage, cost: number) {
        this.cost += cost;
        const cur = this.usageByModel.get(model) ?? { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, cost: 0 };
        cur.usage.inputTokens += usage.inputTokens;
        cur.usage.outputTokens += usage.outputTokens;
        cur.usage.cacheReadTokens = (cur.usage.cacheReadTokens ?? 0) + (usage.cacheReadTokens ?? 0);
        cur.usage.cacheWriteTokens = (cur.usage.cacheWriteTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
        cur.cost += cost;
        this.usageByModel.set(model, cur);
    }

    /** Replace history with a compacted version. */
    compact(summary: string, messages: Message[]) {
        this.messages = [];
        this.write({ t: "compact", summary });
        for (const m of messages) this.push(m);
    }

    static load(file: string): Session {
        const text = readFileSync(file, "utf-8");
        let meta: SessionMeta | undefined;
        const lines: Line[] = [];
        for (const raw of text.split("\n")) {
            if (!raw.trim()) continue;
            try {
                const l = JSON.parse(raw) as Line;
                if (l.t === "meta") meta = { id: l.id, cwd: l.cwd, createdAt: l.createdAt, version: l.version, system: l.system };
                else lines.push(l);
            } catch {
                // a torn final line from a crash; ignore it
            }
        }
        if (!meta) throw new Error(`Not a session file: ${file}`);
        // End a torn last line, or the next record appended would join it and
        // both would be unreadable on the following load.
        if (text && !text.endsWith("\n")) {
            try {
                appendFileSync(file, "\n");
            } catch {
                // read-only file: nothing will be appended either
            }
        }
        const s = new Session(meta, { file });
        s.started = true;
        for (const l of lines) {
            if (l.t === "msg") s.messages.push(l.m);
            else if (l.t === "compact") s.messages = [];
            else if (l.t === "model") s.model = l.model;
            else if (l.t === "title") s.title = l.title;
            else if (l.t === "usage") s.accumulate(l.model, l.usage, l.cost);
        }
        repairTail(s);
        return s;
    }
}

/**
 * A crash can leave an assistant tool call without results. Providers reject
 * that, so answer dangling calls with an "interrupted" result on load.
 */
function repairTail(s: Session) {
    const last = s.messages[s.messages.length - 1];
    if (!last || last.role !== "assistant") return;
    const calls = last.content.filter((p) => p.type === "tool_call");
    if (!calls.length) return;
    s.push({
        role: "user",
        content: calls.map((c) => ({ type: "tool_result" as const, toolCallId: (c as { id: string }).id, toolName: (c as { name: string }).name, content: "Interrupted: the session ended before this tool ran.", isError: true })),
        meta: { kind: "tool_results" },
    });
}

function firstPrompt(file: string): { title?: string; first?: string; count: number } {
    // Only read the head of the file; sessions can be large.
    const fd = openSync(file, "r");
    const buf = Buffer.alloc(256 * 1024);
    const n = readSync(fd, buf, 0, buf.length, 0);
    closeSync(fd);
    const text = buf.subarray(0, n).toString("utf-8");
    let title: string | undefined;
    let first: string | undefined;
    let count = 0;
    for (const raw of text.split("\n")) {
        if (!raw.trim()) continue;
        try {
            const l = JSON.parse(raw) as Line;
            if (l.t === "title") title = l.title;
            if (l.t === "msg") {
                count++;
                if (!first && l.m.role === "user" && (l.m.meta?.kind ?? "prompt") === "prompt") first = l.m.meta?.display ?? textOf(l.m);
            }
        } catch {
            break;
        }
    }
    return { title, first, count };
}

export function listSessions(cwd: string, limit = 50): SessionSummary[] {
    const dir = projectStateDir(cwd);
    if (!existsSync(dir)) return [];
    const out: SessionSummary[] = [];
    for (const f of readdirSync(dir)) {
        if (!f.endsWith(".jsonl")) continue;
        const file = join(dir, f);
        try {
            const st = statSync(file);
            const head = firstPrompt(file);
            if (!head.count) continue;
            out.push({
                id: f.replace(/\.jsonl$/, ""),
                file,
                cwd,
                createdAt: st.birthtimeMs || st.ctimeMs,
                updatedAt: st.mtimeMs,
                title: (head.title ?? head.first ?? "(untitled)").replace(/\s+/g, " ").trim().slice(0, 120),
                messages: head.count,
            });
        } catch {
            // skip unreadable files
        }
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt);
    return out.slice(0, limit);
}

export function findSession(cwd: string, idOrPrefix: string): string | undefined {
    const all = listSessions(cwd, 1000);
    return all.find((s) => s.id === idOrPrefix)?.file ?? all.find((s) => s.id.startsWith(idOrPrefix))?.file;
}

// ---------------------------------------------------------------------------
// Prompt history (up-arrow), shared across sessions per project.

export function loadPromptHistory(cwd: string, limit = 500): string[] {
    const file = paths.history();
    if (!existsSync(file)) return [];
    try {
        const lines = readFileSync(file, "utf-8").split("\n");
        const out: string[] = [];
        for (let i = lines.length - 1; i >= 0 && out.length < limit; i--) {
            const raw = lines[i];
            if (!raw) continue;
            try {
                const e = JSON.parse(raw) as { cwd: string; text: string };
                if (e.cwd === cwd && e.text && out[out.length - 1] !== e.text) out.push(e.text);
            } catch {
                // ignore
            }
        }
        return out.reverse();
    } catch {
        return [];
    }
}

export function appendPromptHistory(cwd: string, text: string) {
    try {
        ensureDir(paths.home());
        const file = paths.history();
        const existed = existsSync(file);
        appendFileSync(file, redactedJson({ cwd, text, ts: Date.now() }) + "\n", { mode: 0o600 });
        if (!existed) chmodSync(file, 0o600);
    } catch {
        // ignore
    }
}
