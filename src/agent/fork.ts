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

import { chmodSync, existsSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { chmod, open, rename, unlink } from "fs/promises";
import { dirname, join } from "path";
import { randomBytes } from "crypto";
import { APP_VERSION } from "../config/paths";
import { textOf, type Message, type UserMessage } from "../providers/types";
import { eachLine } from "../util/lines";
import { redact } from "../util/redact";
import { nextSlice } from "../util/slices";
import { hold, letGo, newSessionId, placeFields, redactedJson, Session, type ForkOrigin, type Line, type SessionMeta } from "./session";

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
    withdraw: true,
    model: false,
    fastMode: false,
    account: false,
    title: false,
    usage: false,
    backend: false,
    parked: false,
    notice: true,
    import: true,
    subagent: false,
    // Plans shown before the cut can still be saved or implemented from the fork; links say where the original's went.
    plan: true,
    planLink: false,
    // Its cards stay the original's: started from a fork too, the same task would start twice.
    suggestion: false,
    // The original's background work stays its own: the fork doesn't inherit it.
    bgtask: false,
    // A fork doesn't take the original's schedules: they'd run twice.
    schedules: false,
    // A goal belongs to the run that set it: the fork starts without one.
    goal: false,
    // Written afresh from the original's messages as they are now (refusals()): one can come after the cut.
    imagesRefused: false,
    // When the original worked: the fork works from when it's made.
    worked: false,
    // The worktree the conversation had moved to by the cut: the fork goes on there (an agent CLI's next turn says where it is).
    workdir: true,
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
        if (!isForkTarget(m)) return [];
        const first = m.content.find((p) => p.type === "text" && !/^<system-reminder>/.test(p.text));
        const text = (m.meta?.display ?? (first?.type === "text" ? first.text : "")).replace(REMINDERS, "").trim();
        return [{ index, text, checkpoint: m.meta?.checkpoint }];
    });
}

/** Where a fork from the turn of the prompt at `index` ends: before the next prompt (or at the end of the history). */
export function forkCut(messages: Message[], index: number): number {
    for (let i = index + 1; i < messages.length; i++) if (isForkTarget(messages[i])) return i;
    return messages.length;
}

/** A prompt a fork can be made at (forkTargets). */
export function isForkTarget(m: Message | undefined): m is UserMessage {
    if (m?.role !== "user") return false;
    const kind = m.meta?.kind ?? "prompt";
    return kind === "prompt" || kind === "command";
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
    // A line at a time: a session of any size, never all of it as one string.
    eachLine(file, (raw) => {
        if (!raw.trim()) return;
        try {
            lines.push(JSON.parse(raw) as Line);
        } catch {
            // a torn line, which load() skips too
        }
    });
    return lines;
}

/**
 * The original's records (forkSessionSoon), read a slice at a time so that nothing else waits on it: a 100,000-item
 * session's file is 132 MB, 0.25 s to parse. What's written to it meanwhile is read with the rest.
 */
export async function readForkSource(file: string): Promise<Line[]> {
    const lines: Line[] = [];
    const fh = await open(file, "r");
    try {
        const chunk = Buffer.allocUnsafe(1024 * 1024);
        // What follows a slice's last newline, kept as bytes (a slice can end inside a character), in pieces: one line
        // longer than many slices isn't copied again for each.
        let rest: Buffer[] = [];
        let pos = 0;
        let since = performance.now();
        for (;;) {
            const { bytesRead } = await fh.read(chunk, 0, chunk.length, pos);
            if (bytesRead <= 0) break;
            pos += bytesRead;
            // Split at a newline (a byte that's never inside a multi-byte character).
            const buf = chunk.subarray(0, bytesRead);
            const nl = buf.lastIndexOf(10);
            if (nl < 0) {
                rest.push(Buffer.from(buf));
                continue;
            }
            const text = Buffer.concat([...rest, buf.subarray(0, nl)]).toString("utf-8");
            rest = [Buffer.from(buf.subarray(nl + 1))];
            for (const raw of text.split("\n")) {
                if (!raw.trim()) continue;
                try {
                    lines.push(JSON.parse(raw) as Line);
                } catch {
                    // a torn line, which load() skips too
                }
            }
            if (performance.now() - since > 8) {
                await nextSlice();
                since = performance.now();
            }
        }
        const last = Buffer.concat(rest).toString("utf-8");
        if (last.trim()) {
            try {
                lines.push(JSON.parse(last) as Line);
            } catch {
                // a torn last line
            }
        }
    } finally {
        await fh.close();
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
        else if (l.t === "withdraw" && l.index < count) count--;
        counts.push(count);
        if (l.t === "compact" || (l.t === "rewind" && l.count < cut)) from = i + 1;
        // One of the first `cut` taken out: the history has them all again only from here (this line on).
        else if (l.t === "withdraw" && l.index < cut) from = i;
    });
    for (let i = from; i < lines.length; i++) {
        if ((lines[i]!.t !== "msg" && lines[i]!.t !== "withdraw") || counts[i] !== cut) continue;
        // A turn's ending notice follows its last message. Keep that metadata,
        // stopping before anything changes the conversation again.
        let end = i + 1;
        while (end < lines.length && !["msg", "compact", "rewind", "withdraw"].includes(lines[end]!.t)) end++;
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
        else if (l.t === "withdraw") messages.splice(l.index, 1);
        else if (l.t === "imagesRefused") for (const i of l.indexes) {
            const m = messages[i];
            // A copy: the message is also a record written to the fork.
            if (m?.role === "user" && !m.meta?.imagesRefused?.includes(l.model)) messages[i] = { ...m, meta: { ...m.meta, imagesRefused: [...(m.meta?.imagesRefused ?? []), l.model] } };
        }
    }
    return messages;
}

/** Records of which models refused these messages' images, a message and model at a time (so each message's list replays in its order). */
function refusals(messages: Message[]): Line[] {
    return messages.flatMap((m, i) => (m.role === "user" ? (m.meta?.imagesRefused ?? []).map((model): Line => ({ t: "imagesRefused", model, indexes: [i] })) : []));
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
        } else if (l.t === "withdraw" && l.index < count) {
            count--;
            if (first?.at === l.index) first = undefined;
            else if (first && first.at > l.index) first.at--;
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
    const { file, lines } = forkLines(original, o);
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

/**
 * forkSession, written a slice at a time: what the fork is (its records, the backend sessions it shares) is settled
 * at once, from `o.source` (readForkSource) and the original as it is now; then it's written while the server gets
 * on (a 100,000-item session's copy, redacted again, took 0.35 s). `keep` puts back the lines the fork was just
 * loaded from, for the task it's called in (Session.keepLoadedLines): its runtime doesn't read the file again.
 */
export async function forkSessionSoon(original: Session, o: ForkOptions & { source: Line[]; id?: string; createdAt?: number }): Promise<{ session: Session; keep: () => void }> {
    const { file, lines } = forkLines(original, o);
    hold(file);
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    let fh: Awaited<ReturnType<typeof open>> | undefined;
    try {
        fh = await open(tmp, "wx", 0o600);
        let since = performance.now();
        let chunk: string[] = [];
        for (const l of lines) {
            chunk.push(redactedJson(l) + "\n");
            if (performance.now() - since < 8) continue;
            await fh.write(chunk.join(""));
            chunk = [];
            await nextSlice();
            since = performance.now();
        }
        if (chunk.length) await fh.write(chunk.join(""));
        await fh.close();
        fh = undefined;
        await chmod(tmp, 0o600);
        await rename(tmp, file);
    } catch (e) {
        await fh?.close().catch(() => undefined);
        await unlink(tmp).catch(() => undefined);
        letGo(file);
        throw e;
    }
    try {
        const session = Session.load(file);
        return { session, keep: session.keepLoadedLines() };
    } finally {
        letGo(file);
    }
}

/** What the fork of `original` is: its file's name and its records, checked against the original's history; the backend sessions it shares marked as such in the original. */
function forkLines(original: Session, o: ForkOptions & { source?: Line[]; id?: string; createdAt?: number }): { file: string; lines: Line[] } {
    if (!original.persisted || !existsSync(original.path)) throw new Error("This session hasn't been saved yet, so there's nothing to fork.");
    if (!Number.isInteger(o.cut) || o.cut < 1 || o.cut > original.messages.length) throw new Error("That point isn't in this conversation.");
    const source = o.source ?? parse(original.path);
    const copied = recordsUpTo(source, o.cut).filter((l) => COPIED[l.t]);
    copied.push(...refusals(original.messages.slice(0, o.cut)));
    // Import provenance is written after the imported messages. An earlier
    // cut still needs its timeline banner, without claiming the CLI session.
    if (!copied.some((l) => l.t === "import") && copied.some((l) => l.t === "msg" && l.m.role === "user" && l.m.meta?.imported)) {
        const imported = source.find((l) => l.t === "import");
        if (imported) copied.push(imported);
    }
    // What's saved must be what the original has (a write it couldn't make, say), as written: redacted.
    if (redactedJson(historyOf(copied)) !== redactedJson(original.messages.slice(0, o.cut))) throw new Error("The saved conversation doesn't match this session's, so it can't be forked.");

    const id = o.id ?? newSessionId();
    const file = join(dirname(original.path), `${id}.jsonl`);
    const shown = oneLine(o.title ?? original.title ?? firstPrompt(copied) ?? "") || "(untitled)";
    let at = Date.now();
    for (const m of original.messages.slice(0, o.cut)) if (m.role === "user" && m.meta?.checkpoint !== undefined) at = Math.max(at, m.meta.checkpoint + 1);
    const forkOf: ForkOrigin = { id: original.meta.id, title: shown, messages: o.cut, at };
    // A backend session that saw past the cut has things the fork mustn't know. One is shared
    // only once the original has saved that it won't continue it in place (a crash right after
    // the fork is written mustn't let it), so marked before the fork exists.
    const shared = o.shareBackends === false ? [] : [...original.backends].filter(([p, b]) => b.synced <= o.cut && original.markBackendForked(p));
    // The threads parked for other accounts' places (#413) as well, so the fork goes back to them as the original would.
    const parked = o.shareBackends === false ? [] : original.parkedBackends().filter((p) => p.session.synced <= o.cut && original.markParkedForked(p));
    const model = o.model ?? original.model;
    const lines: Line[] = [
        { t: "meta", id, cwd: original.meta.cwd, createdAt: o.createdAt ?? Date.now(), version: APP_VERSION, system: original.meta.system, forkOf },
        ...copied.map((l) => l.t === "import" ? { ...l, inherited: true as const } : l),
        { t: "title", title: forkTitle(shown) },
        ...(model ? [{ t: "model" as const, model }] : []),
        ...(original.fastMode !== undefined ? [{ t: "fastMode" as const, enabled: original.fastMode }] : []),
        ...Object.entries(original.accounts).map(([provider, id]) => ({ t: "account" as const, provider, id })),
        ...shared.map(([provider, b]) => ({ t: "backend" as const, provider, id: b.id, synced: b.synced, fork: true, ...(b.unsent ? { unsent: b.unsent } : {}), ...placeFields(original.backendPlace(provider)) })),
        ...parked.map((p) => ({ t: "parked" as const, provider: p.provider, id: p.session.id, synced: p.session.synced, fork: true, ...(p.session.unsent ? { unsent: p.session.unsent } : {}), folder: p.place.folder, ...(p.place.history ? { history: p.place.history } : {}) })),
    ];

    return { file, lines };
}
