// File checkpoints for /rewind. Each user prompt starts a checkpoint; before an
// edit tool first changes a file during it, the file's bytes (or the fact that
// it didn't exist) are saved, so files can be put back as they were before any
// earlier prompt. Sub-agents share their parent's checkpoint.
//
// Saved next to the session: ~/.harness/projects/<slug>/file-history/<session-id>/
//   index.jsonl   append-only records (below), read back on resume
//   blobs/<sha256> file contents, stored once per hash
// Copies are exact and not redacted: restoring must be byte for byte, and they
// hold the same data as the user's own files. Folders are 0700, files 0600.
// Files go by their real path, so one reached through a link is still one file.
// Shell commands aren't tracked.

import { createHash, randomBytes } from "crypto";
import { appendFileSync, chmodSync, closeSync, constants, existsSync, fchmodSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "fs";
import { lstat, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { basename, dirname, join, resolve } from "path";
import { paths } from "../config/paths";
import type { Message, TextPart, UserMessage } from "../providers/types";
import type { TodoItem, ToolState } from "../tools/types";
import type { Session } from "./session";

/** Bigger files aren't saved, so they can't be restored. */
export const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
/** File history of sessions untouched this long is deleted at startup. */
export const HISTORY_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

type Rec =
    /** The file as it was when checkpoint `cp` first changed it; hash null: it didn't exist. */
    | { t: "snap"; cp: number; path: string; hash: string | null; mode?: number }
    /** Changed in checkpoint `cp` but not saved (too large, unreadable). */
    | { t: "skip"; cp: number; path: string; reason: string }
    /** What the harness last wrote to the file (an edit tool, or a restore). */
    | { t: "wrote"; path: string; hash: string | null };

type FileRec = Extract<Rec, { cp: number }>;

/** A file's content hash; null when it doesn't exist. */
type Content = string | null;
const UNREADABLE = "unreadable";

export interface RestoreItem {
    path: string;
    /** write: put the saved content back · delete: it didn't exist then · skip: not saved, can't restore. */
    action: "write" | "delete" | "skip";
    hash?: Content;
    mode?: number;
    /** Its content when the plan was made. */
    current?: Content;
    /** Changed outside the harness since the harness last wrote it. */
    outside?: boolean;
    reason?: string;
}

const HEX = /^[0-9a-f]{64}$/;

function sha256(buf: Buffer): string {
    return createHash("sha256").update(buf).digest("hex");
}

function contentSync(path: string): Content {
    try {
        return sha256(readFileSync(path));
    } catch (e) {
        return (e as NodeJS.ErrnoException).code === "ENOENT" ? null : UNREADABLE;
    }
}

/** A file's real path, through any links, even when it (or the link's target) doesn't exist yet. */
export function canonical(p: string, depth = 0): string {
    try {
        return realpathSync(p);
    } catch {
        // missing, or a link to something missing
    }
    try {
        if (depth < 32 && lstatSync(p).isSymbolicLink()) return canonical(resolve(dirname(p), readlinkSync(p)), depth + 1);
    } catch {
        // not there
    }
    const parent = dirname(p);
    return parent === p ? p : join(canonical(parent, depth), basename(p));
}

/** Restores never write through a link at the file itself. */
const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

const open = new Map<string, FileHistory>();

export class FileHistory {
    private recs: FileRec[] = [];
    private lastWrite = new Map<string, Content>();
    /** Snapshots taken (or being taken) in the current checkpoint, by path. */
    private snapped = new Map<string, Promise<void>>();
    /** The last tracked write to each path: writes to one file go one at a time. */
    private writing = new Map<string, Promise<void>>();
    /** Why the index couldn't be saved, if it couldn't. */
    private failed?: string;
    private current?: number;
    private last = 0;
    private loaded = false;
    private ready = false;

    constructor(readonly dir: string) {}

    /** The history of a saved session (one instance per session in this process). */
    static for(session: Session): FileHistory | undefined {
        if (!session.persisted || !/^[A-Za-z0-9_-]+$/.test(session.meta.id)) return undefined;
        const dir = join(dirname(session.path), "file-history", session.meta.id);
        let h = open.get(dir);
        if (!h) open.set(dir, (h = new FileHistory(dir)));
        // Checkpoints without file changes are only on the messages; keep ids increasing past them.
        for (const m of session.messages) if (m.role === "user" && m.meta?.checkpoint) h.last = Math.max(h.last, m.meta.checkpoint);
        return h;
    }

    private get index() {
        return join(this.dir, "index.jsonl");
    }

    private blob(hash: string) {
        return join(this.dir, "blobs", hash);
    }

    private load() {
        if (this.loaded) return;
        this.loaded = true;
        let text: string;
        try {
            text = readFileSync(this.index, "utf-8");
        } catch {
            return;
        }
        for (const raw of text.split("\n")) {
            if (!raw.trim()) continue;
            try {
                this.apply(JSON.parse(raw) as Rec);
            } catch {
                // a torn line from a crash
            }
        }
        if (text && !text.endsWith("\n")) {
            try {
                appendFileSync(this.index, "\n");
            } catch {
                // nothing will be appended either
            }
        }
    }

    private apply(r: Rec) {
        if (r.t === "wrote") this.lastWrite.set(r.path, r.hash);
        else if (r.t === "snap" || r.t === "skip") {
            this.recs.push(r);
            this.last = Math.max(this.last, r.cp);
        }
    }

    private ensureDirs() {
        if (this.ready) return;
        const blobs = join(this.dir, "blobs");
        mkdirSync(blobs, { recursive: true, mode: 0o700 });
        for (const d of [dirname(this.dir), this.dir, blobs]) chmodSync(d, 0o700);
        this.ready = true;
    }

    private append(r: Rec) {
        this.apply(r);
        // After a failure nothing more is saved, so what's on disk stays a true
        // prefix: a snapshot missing in the middle would restore later content.
        if (this.failed) return;
        try {
            this.ensureDirs();
            const created = !existsSync(this.index);
            appendFileSync(this.index, JSON.stringify(r) + "\n", { mode: 0o600 });
            if (created) chmodSync(this.index, 0o600);
        } catch (e) {
            // It still counts for the rest of this run.
            this.failed = (e as Error).message;
        }
    }

    /** Set when the history couldn't be saved, so it's lost when the session ends. */
    get unsaved(): string | undefined {
        return this.failed;
    }

    /** Store content once per hash; temp file and rename, so a crash never leaves half a blob. */
    private store(hash: string, buf: Buffer) {
        this.ensureDirs();
        const file = this.blob(hash);
        if (existsSync(file)) return;
        const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
        writeFileSync(tmp, buf, { mode: 0o600 });
        chmodSync(tmp, 0o600);
        renameSync(tmp, file);
    }

    /** Start the checkpoint for a new user prompt. Ids are increasing timestamps. */
    begin(): number {
        this.load();
        this.current = this.last = Math.max(Date.now(), this.last + 1);
        this.snapped.clear();
        return this.current;
    }

    /** Save the file as it is now, if this checkpoint hasn't already. Call right before changing it. */
    before(abs: string): Promise<void> {
        this.load();
        const cp = this.current;
        if (cp === undefined) return Promise.resolve();
        const path = canonical(abs);
        // Parallel sub-agents can edit the same file: the second waits for the first's snapshot.
        let p = this.snapped.get(path);
        if (!p) this.snapped.set(path, (p = this.snapshot(cp, path)));
        return p;
    }

    private async snapshot(cp: number, path: string) {
        try {
            const st = await stat(path).catch(() => undefined);
            if (!st) return this.append({ t: "snap", cp, path, hash: null });
            if (!st.isFile()) return;
            if (st.size > MAX_SNAPSHOT_BYTES) return this.append({ t: "skip", cp, path, reason: `over ${MAX_SNAPSHOT_BYTES / 1024 / 1024} MB` });
            const buf = await readFile(path);
            const hash = sha256(buf);
            this.store(hash, buf);
            this.append({ t: "snap", cp, path, hash, mode: st.mode & 0o777 });
        } catch {
            this.append({ t: "skip", cp, path, reason: "couldn't be saved" });
        }
    }

    /**
     * Write a file for an edit tool: saved first if this checkpoint hasn't yet,
     * and what was written is noted (from the bytes: reading the file back could
     * pick up someone else's save) so outside changes can be told apart.
     */
    write(abs: string, data: Buffer): Promise<void> {
        this.load();
        const path = canonical(abs);
        const run = async () => {
            await this.before(path);
            await writeFile(abs, data);
            this.append({ t: "wrote", path, hash: sha256(data) });
        };
        const p = (this.writing.get(path) ?? Promise.resolve()).then(run);
        this.writing.set(path, p.catch(() => undefined));
        return p;
    }

    /** Files first changed in checkpoint `cp`. */
    filesIn(cp: number): string[] {
        this.load();
        return [...new Set(this.recs.filter((r) => r.cp === cp).map((r) => r.path))];
    }

    /** Each file changed in checkpoint `cp` or later, with its record from the earliest of those: its state at `cp`. */
    private since(cp: number): Map<string, FileRec> {
        const out = new Map<string, FileRec>();
        for (const r of this.recs) {
            if (r.cp < cp) continue;
            const cur = out.get(r.path);
            if (!cur || r.cp < cur.cp) out.set(r.path, r);
        }
        return out;
    }

    /** What putting the files back as they were at checkpoint `cp` takes. Files already that way are left out. */
    plan(cp: number): RestoreItem[] {
        this.load();
        const items: RestoreItem[] = [];
        for (const [path, r] of this.since(cp)) {
            if (r.t === "skip") {
                items.push({ path, action: "skip", reason: r.reason });
                continue;
            }
            if (canonical(path) !== path) {
                items.push({ path, action: "skip", reason: "replaced by a link" });
                continue;
            }
            if (r.hash !== null && (!HEX.test(r.hash) || !existsSync(this.blob(r.hash)))) {
                items.push({ path, action: "skip", reason: "the saved copy is missing" });
                continue;
            }
            const current = contentSync(path);
            if (current === r.hash) continue;
            // Never written by the harness (its edit failed): it should still be as saved.
            const expected = this.lastWrite.has(path) ? this.lastWrite.get(path) : r.hash;
            items.push({ path, action: r.hash === null ? "delete" : "write", hash: r.hash, mode: r.mode, current, outside: current !== expected });
        }
        return items.sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Carry out a plan. A file that changed again since the plan was made is left alone. */
    restore(items: RestoreItem[]): { done: string[]; failed: { path: string; error: string }[] } {
        this.load();
        const done: string[] = [];
        const failed: { path: string; error: string }[] = [];
        for (const it of items) {
            if (it.action === "skip") continue;
            const now = contentSync(it.path);
            if (now !== it.current) {
                failed.push({ path: it.path, error: "it changed again while you were choosing, so it was left as it is" });
                continue;
            }
            // Paths are real paths: a link here now would send the write somewhere else.
            if (canonical(it.path) !== it.path) {
                failed.push({ path: it.path, error: "it was replaced by a link, so it was left as it is" });
                continue;
            }
            try {
                if (it.action === "delete") unlinkSync(it.path);
                else {
                    const hash = it.hash!;
                    if (!HEX.test(hash)) throw new Error("bad snapshot record");
                    const buf = readFileSync(this.blob(hash));
                    if (sha256(buf) !== hash) throw new Error("the saved copy is damaged");
                    if (now === null) mkdirSync(dirname(it.path), { recursive: true });
                    const { O_WRONLY, O_TRUNC, O_CREAT, O_EXCL } = constants;
                    const flags = now === null ? O_WRONLY | O_CREAT | O_EXCL | NOFOLLOW : O_WRONLY | O_TRUNC | NOFOLLOW;
                    const fd = openSync(it.path, flags, it.mode ?? 0o644);
                    try {
                        writeFileSync(fd, buf);
                        if (now === null && it.mode !== undefined) fchmodSync(fd, it.mode);
                    } finally {
                        closeSync(fd);
                    }
                }
                this.append({ t: "wrote", path: it.path, hash: it.action === "delete" ? null : it.hash! });
                done.push(it.path);
            } catch (e) {
                failed.push({ path: it.path, error: (e as Error).message });
            }
        }
        return { done, failed };
    }
}

/**
 * Edit tools write files through this: the first change to a file in a user
 * turn saves what was there, for /rewind (see FileHistory.write).
 */
export async function writeTracked(state: ToolState, abs: string, text: string): Promise<void> {
    const data = Buffer.from(text, "utf-8");
    if (state.fileHistory) await state.fileHistory.write(abs, data);
    else await writeFile(abs, data);
}

// ---------------------------------------------------------------------------
// Rewinding the conversation

export interface RewindTarget {
    /** Position in the session's messages. */
    index: number;
    /** What the user typed: it goes back in the input box. */
    text: string;
    checkpoint?: number;
}

const REMINDER = /^<system-reminder>\n([\s\S]*)\n<\/system-reminder>$/;

/** Prompts the conversation can be rewound to, oldest first. Ones before a compaction are gone from the history. */
export function rewindTargets(messages: Message[]): RewindTarget[] {
    const out: RewindTarget[] = [];
    messages.forEach((m, index) => {
        if (m.role !== "user") return;
        const kind = m.meta?.kind ?? "prompt";
        if (kind !== "prompt" && kind !== "command") return;
        const first = m.content.find((p): p is TextPart => p.type === "text" && !REMINDER.test(p.text));
        const text = (m.meta?.display ?? first?.text ?? "").replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "").trim();
        out.push({ index, text, checkpoint: m.meta?.checkpoint });
    });
    return out;
}

/**
 * Notes that went out with a prompt: they were pending just before it.
 * A UserPromptSubmit hook's context is left out; the hook runs again.
 */
export function promptNotes(m: UserMessage): string[] {
    const out: string[] = [];
    for (const p of m.content) {
        if (p.type !== "text") continue;
        const note = p.text.match(REMINDER)?.[1];
        if (note && !note.startsWith("Context from a UserPromptSubmit hook:")) out.push(note);
    }
    return out;
}

/**
 * Tool state that came from the conversation, set again from what's left of
 * it: todos and the approved plan from the last calls that succeeded, and no
 * files counted as read (the model must read them again before editing).
 */
export function resetToolState(state: ToolState, messages: Message[]) {
    state.fileState.clear();
    const ok = new Set<string>();
    for (const m of messages) {
        if (m.role === "user") for (const p of m.content) if (p.type === "tool_result" && !p.isError) ok.add(p.toolCallId);
    }
    let todos: TodoItem[] = [];
    let plan: string | undefined;
    for (const m of messages) {
        if (m.role !== "assistant") continue;
        for (const p of m.content) {
            if (p.type !== "tool_call" || !ok.has(p.id)) continue;
            if (p.name === "TodoWrite" && Array.isArray(p.input.todos)) {
                todos = (p.input.todos as TodoItem[]).map((t) => ({ content: t.content, status: t.status, activeForm: t.activeForm }));
            } else if (p.name === "ExitPlanMode" && typeof p.input.plan === "string") plan = p.input.plan;
        }
    }
    state.todos = todos;
    state.approvedPlan = plan;
}

// ---------------------------------------------------------------------------

async function mtime(path: string): Promise<number> {
    try {
        return (await stat(path)).mtimeMs;
    } catch {
        return 0;
    }
}

/**
 * Delete the file history of sessions not touched in 30 days (the session
 * file and the history both count), in every project. Best effort.
 */
export async function pruneFileHistory(opts: { keep?: string; now?: number; maxAgeMs?: number } = {}): Promise<string[]> {
    const now = opts.now ?? Date.now();
    const maxAge = opts.maxAgeMs ?? HISTORY_MAX_AGE_MS;
    const removed: string[] = [];
    const root = paths.projectsDir();
    let projects: string[];
    try {
        projects = await readdir(root);
    } catch {
        return removed;
    }
    for (const project of projects) {
        const base = join(root, project, "file-history");
        let ids: string[];
        try {
            ids = await readdir(base);
        } catch {
            continue;
        }
        for (const id of ids) {
            if (id === opts.keep) continue;
            const dir = join(base, id);
            try {
                const st = await lstat(dir);
                if (!st.isDirectory()) continue;
                const touched = Math.max(st.mtimeMs, await mtime(join(dir, "index.jsonl")), await mtime(join(root, project, `${id}.jsonl`)));
                if (now - touched < maxAge) continue;
                await rm(dir, { recursive: true, force: true });
                open.delete(dir);
                removed.push(dir);
            } catch {
                // next one
            }
        }
    }
    return removed;
}

