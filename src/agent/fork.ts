// Forking a session: a new session with the conversation up to the end of one
// of its turns, while the original stays as it is (/fork, "Fork from here").
//
// The fork is a session file of its own, next to the original, written in one
// go (a temporary file, then a rename), so a crash never leaves a half-copied
// fork that lists as a session. It starts with no spend, no file history and
// its own title. Agent backends' sessions (Claude Code's, Codex's threads) are
// never continued by two sessions: one the fork can use is marked in both as
// shared, and whichever goes on with it first forks it natively (--fork-session,
// thread/fork) and goes on with the copy; the shared one itself is never
// continued again, so neither sees what the other says after the fork.

import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { APP_VERSION } from "../config/paths";
import { textOf, type Message } from "../providers/types";
import { redact } from "../util/redact";
import { hold, letGo, newSessionId, redactedJson, Session, type ForkOrigin, type Line, type SessionMeta } from "./session";

/**
 * Which of the original's records the fork copies, up to where it's cut. The
 * conversation and its shape (compactions and rewinds, so the timeline's
 * segments line up) are copied; what belongs to the original's own run isn't:
 * its titles, spend and backend sessions. The fork's model, speed and accounts are
 * written afresh from what the original has now. A new record type is listed
 * here (the type checker asks for it).
 */
const COPIED: Record<Line["t"], boolean> = {
    meta: false,
    msg: true,
    compact: true,
    rewind: true,
    model: false,
    fastMode: false,
    account: false,
    title: false,
    usage: false,
    backend: false,
    notice: true,
    import: true,
    subagent: false,
};

const REMINDERS = /<system-reminder>[\s\S]*?<\/system-reminder>/g;

// Match secrets while they're whole, before whitespace changes or clipping.
const oneLine = (s: string) => redact(s).replace(/\s+/g, " ").trim().slice(0, 120);

/** "Fork of …", once: a fork of a fork is named after the same conversation. */
export function forkTitle(title: string): string {
    return oneLine(`Fork of ${oneLine(title).replace(/^(Fork of\s+)+/i, "") || "(untitled)"}`);
}

/** Unlike a rewind, a fork can branch from imported prompts without changing the imported original. */
export function forkTargets(messages: Message[]): { index: number; text: string; checkpoint?: number }[] {
    return messages.flatMap((m, index) => {
        if (m.role !== "user") return [];
        const kind = m.meta?.kind ?? "prompt";
        if (kind !== "prompt" && kind !== "command") return [];
        const first = m.content.find((p) => p.type === "text" && !/^<system-reminder>/.test(p.text));
        const text = (m.meta?.display ?? (first?.type === "text" ? first.text : "")).replace(REMINDERS, "").trim();
        return [{ index, text, checkpoint: m.meta?.checkpoint }];
    });
}

/** Where a fork from the turn of the prompt at `index` ends: before the next prompt (or at the end of the history). */
export function forkCut(messages: Message[], index: number): number {
    return forkTargets(messages).find((t) => t.index > index)?.index ?? messages.length;
}

/**
 * A prompt the fork copied from the original: its file history (if any) is
 * the original's, so rewinding to it can't restore those files here. Told by
 * its checkpoint, which is a time; one without (from before checkpoints) by
 * its position.
 */
export function beforeFork(meta: SessionMeta, m: Message | undefined, index: number): boolean {
    const f = meta.forkOf;
    if (!f || m?.role !== "user") return false;
    const cp = m.meta?.checkpoint;
    return cp !== undefined ? cp < f.at : index < f.messages;
}

export interface ForkOptions {
    /** How many messages to copy: up to the next prompt after the chosen turn (forkCut). */
    cut: number;
    /** The model the original has selected now ("provider:id"), even if nothing has run on it yet. */
    model?: string;
    /** The original's title as shown (its first prompt when it has none). */
    title?: string;
    /**
     * Share the original's backend sessions (false while it's working: one may
     * be moving on right now, under whichever model it started with).
     */
    shareBackends?: boolean;
}

function parse(file: string): Line[] {
    const lines: Line[] = [];
    for (const raw of readFileSync(file, "utf-8").split("\n")) {
        if (!raw.trim()) continue;
        try {
            lines.push(JSON.parse(raw) as Line);
        } catch {
            // a torn line, which load() skips too
        }
    }
    return lines;
}

/**
 * The original's records up to where its current history has its first
 * `cut` messages: after the last record that took any of them away (a
 * compaction, or a rewind to before the cut), they were added one by one.
 */
function recordsUpTo(lines: Line[], cut: number): Line[] {
    let from = 0;
    const counts: number[] = [];
    let count = 0;
    lines.forEach((l, i) => {
        if (l.t === "msg") count++;
        else if (l.t === "compact") count = 0;
        else if (l.t === "rewind") count = Math.min(count, l.count);
        counts.push(count);
        if (l.t === "compact" || (l.t === "rewind" && l.count < cut)) from = i + 1;
    });
    for (let i = from; i < lines.length; i++) {
        if (lines[i]!.t !== "msg" || counts[i] !== cut) continue;
        // A turn's ending notice follows its last message. Keep that metadata,
        // stopping before anything changes the conversation again.
        let end = i + 1;
        while (end < lines.length && !["msg", "compact", "rewind"].includes(lines[end]!.t)) end++;
        return lines.slice(0, end);
    }
    throw new Error("The session's file doesn't have that part of the conversation.");
}

/** The history the records make, as Session.load reads it. */
function historyOf(lines: Line[]): Message[] {
    let messages: Message[] = [];
    for (const l of lines) {
        if (l.t === "msg") messages.push(l.m);
        else if (l.t === "compact") messages = [];
        else if (l.t === "rewind") messages = messages.slice(0, l.count);
    }
    return messages;
}

/** The conversation's first prompt, as the session list names it: one rewound away doesn't count, one compacted away still does. */
function firstPrompt(lines: Line[]): string | undefined {
    let first: { text: string; at: number } | undefined;
    let count = 0;
    for (const l of lines) {
        if (l.t === "msg") {
            const m = l.m;
            const kind = m.role === "user" ? (m.meta?.kind ?? "prompt") : undefined;
            const text = m.role === "user" && (kind === "prompt" || kind === "command") ? oneLine(redact(m.meta?.display ?? textOf(m)).replace(REMINDERS, "")) : "";
            if (!first && text) first = { text, at: count };
            count++;
        } else if (l.t === "rewind") {
            count = Math.min(count, l.count);
            if (first && first.at >= l.count) first = undefined;
        } else if (l.t === "compact") {
            count = 0;
            if (first) first.at = -1;
        }
    }
    return first?.text;
}

/**
 * Write the fork of `original` and open it: the returned session has claimed
 * its file, as a new session would. Throws, leaving nothing behind, when it
 * can't be made.
 */
export function forkSession(original: Session, o: ForkOptions): Session {
    if (!original.persisted || !existsSync(original.path)) throw new Error("This session hasn't been saved yet, so there's nothing to fork.");
    if (!Number.isInteger(o.cut) || o.cut < 1 || o.cut > original.messages.length) throw new Error("That point isn't in this conversation.");
    const source = parse(original.path);
    const copied = recordsUpTo(source, o.cut).filter((l) => COPIED[l.t]);
    // Import provenance is written after the imported messages. An earlier
    // cut still needs its timeline banner, without claiming the CLI session.
    if (!copied.some((l) => l.t === "import") && copied.some((l) => l.t === "msg" && l.m.role === "user" && l.m.meta?.imported)) {
        const imported = source.find((l) => l.t === "import");
        if (imported) copied.push(imported);
    }
    // What's saved must be what the original has (a write it couldn't make, say), as written: redacted.
    if (redactedJson(historyOf(copied)) !== redactedJson(original.messages.slice(0, o.cut))) throw new Error("The saved conversation doesn't match this session's, so it can't be forked.");

    const id = newSessionId();
    const file = join(dirname(original.path), `${id}.jsonl`);
    const shown = oneLine(o.title ?? original.title ?? firstPrompt(copied) ?? "") || "(untitled)";
    let at = Date.now();
    for (const m of original.messages.slice(0, o.cut)) if (m.role === "user" && m.meta?.checkpoint !== undefined) at = Math.max(at, m.meta.checkpoint + 1);
    const forkOf: ForkOrigin = { id: original.meta.id, title: shown, messages: o.cut, at };
    // A backend session that saw past the cut has things the fork mustn't know. One is shared
    // only once the original has saved that it won't continue it in place (a crash right after
    // the fork is written mustn't let it), so marked before the fork exists.
    const shared = o.shareBackends === false ? [] : [...original.backends].filter(([p, b]) => b.synced <= o.cut && original.markBackendForked(p));
    const model = o.model ?? original.model;
    const lines: Line[] = [
        { t: "meta", id, cwd: original.meta.cwd, createdAt: Date.now(), version: APP_VERSION, system: original.meta.system, forkOf },
        ...copied.map((l) => l.t === "import" ? { ...l, inherited: true as const } : l),
        { t: "title", title: forkTitle(shown) },
        ...(model ? [{ t: "model" as const, model }] : []),
        ...(original.fastMode !== undefined ? [{ t: "fastMode" as const, enabled: original.fastMode }] : []),
        ...Object.entries(original.accounts).map(([provider, id]) => ({ t: "account" as const, provider, id })),
        ...shared.map(([provider, b]) => ({ t: "backend" as const, provider, id: b.id, synced: b.synced, fork: true, folder: original.backendFolder(provider) })),
    ];

    // Claimed before it exists, so no other process opens it half way.
    hold(file);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    try {
        writeFileSync(tmp, lines.map((l) => redactedJson(l) + "\n").join(""), { mode: 0o600, flag: "wx" });
        chmodSync(tmp, 0o600);
        renameSync(tmp, file);
    } catch (e) {
        try {
            unlinkSync(tmp);
        } catch {
            // never made
        }
        letGo(file);
        throw e;
    }
    try {
        return Session.load(file);
    } finally {
        letGo(file);
    }
}
