// Deleting a session from the GUI. Its files (the transcript, the UI side log,
// its saved queue and the file copies kept for /rewind) move out of projects/ into
// trash/<id>/ in the Cavvy home, so Undo can put them back; entries older
// than a week are purged. Nothing outside the Cavvy home is touched: paths
// are built from checked ids, each folder they're in must resolve inside the
// home, renames move a link rather than what it points to, and purging never
// goes through a link. The project, ~/.claude and ~/.codex aren't involved.

import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, unlinkSync, writeFileSync } from "fs";
import { basename, dirname, join } from "path";
import { cavvyHome, paths } from "../config/paths";
import { findSessionAnywhere, holdSession, releaseSession, sessionFolder, SessionInUseError } from "../agent/session";
import { forgetFileHistory } from "../agent/checkpoints";
import { isInside } from "../util/files";
import { RpcError } from "./rpc-error";

export const TRASH_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Ids look like 20261016-093441-b7e986. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const SLUG = /^[A-Za-z0-9-]{1,120}$/;
/** Purging removes this many entries per run, no deeper than this. */
const PURGE_MAX_ENTRIES = 100;
const MAX_DEPTH = 8;

/** What the GUI store said about it, put back on restore. */
export interface SessionFlags {
    pinned: boolean;
    archived: boolean;
    settled: boolean;
}

interface TrashEntry extends SessionFlags {
    id: string;
    slug: string;
    deletedAt: number;
}

export const trashDir = () => join(cavvyHome(), "trash");

export function checkId(id: unknown): string {
    if (typeof id !== "string" || !ID.test(id)) throw new RpcError("That isn't a session id.", "invalid");
    return id;
}

/** A session's files in its project's folder, and their names in its trash entry. */
/** A session's files: its transcript, ui log and file history. */
export function pieces(dir: string, id: string): { live: string; trashed: string }[] {
    return [
        { live: join(dir, `${id}.jsonl`), trashed: "transcript.jsonl" },
        { live: join(dir, "ui", `${id}.jsonl`), trashed: "ui.jsonl" },
        { live: join(dir, "file-history", id), trashed: "file-history" },
        { live: join(dir, "queue", `${id}.json`), trashed: "queue.json" },
    ];
}

/**
 * There, as a file, folder or link (a link isn't followed). Only "no such
 * file" means it isn't: a folder that can't be searched stops the delete
 * rather than leave the session's files in it.
 */
function present(p: string): boolean {
    try {
        lstatSync(p);
        return true;
    } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return false;
        throw new RpcError(`Can't check ${p} (${code ?? (e as Error).message}), so nothing was changed.`);
    }
}

/** The folder `p` is in must resolve inside the Cavvy home. `p` itself may be a link: it's moved, never followed. */
function mustBeInHome(p: string) {
    let home: string, parent: string;
    try {
        home = realpathSync(cavvyHome());
        parent = realpathSync(dirname(p));
    } catch {
        throw new RpcError(`Can't check where ${p} is, so it's left alone.`);
    }
    if (!isInside(parent, home)) throw new RpcError(`${dirname(p)} is outside the Cavvy home (a link?), so nothing was deleted.`);
}

/** Rename each, or none: those already moved go back if one fails. */
function moveAll(moves: [from: string, to: string][]) {
    const done: [string, string][] = [];
    try {
        for (const [from, to] of moves) {
            renameSync(from, to);
            done.push([from, to]);
        }
    } catch (e) {
        const stuck = done.reverse().filter(([from, to]) => {
            try {
                renameSync(to, from);
                return false;
            } catch {
                return true;
            }
        });
        const msg = (e as Error).message;
        throw new RpcError(stuck.length ? `Couldn't move the session's files (${msg}); some are left in ${dirname(stuck[0]![1])}.` : `Couldn't move the session's files (${msg}), so nothing changed.`);
    }
}

/** Remove a folder this module made, depth-first. A link is removed itself, never followed. */
function removeTree(p: string, depth = 0) {
    if (!lstatSync(p).isDirectory()) return unlinkSync(p);
    if (depth > MAX_DEPTH) throw new Error(`${p} is nested too deep`);
    for (const name of readdirSync(p)) removeTree(join(p, name), depth + 1);
    rmdirSync(p);
}

/**
 * A session's files and its trash entry, checked to be inside the Cavvy
 * home. Called before its runtime is closed too, so a setup it would refuse
 * doesn't close anything.
 */
export function locateSession(id: string) {
    const file = findSessionAnywhere(checkId(id));
    if (!file) throw new RpcError(`No session ${id}`, "not_found");
    const dir = dirname(file);
    const slug = basename(dir);
    if (dirname(dir) !== paths.projectsDir() || !SLUG.test(slug)) throw new RpcError(`Unexpected session folder ${dir}, so nothing was deleted.`);
    const moves = pieces(dir, id).filter((m) => present(m.live));
    for (const m of moves) mustBeInHome(m.live);
    mkdirSync(trashDir(), { recursive: true, mode: 0o700 });
    // As restore wants it: a folder, not a link (even to somewhere in the home).
    if (!lstatSync(trashDir()).isDirectory()) throw new RpcError(`${trashDir()} isn't a folder, so nothing was deleted.`);
    const entry = join(trashDir(), id);
    mustBeInHome(entry);
    return { file, dir, slug, moves, entry };
}

/** Take a session's lock to delete it (refused while another process has it); returns how to let it go. */
export function claimForDelete(file: string): () => void {
    try {
        holdSession(file);
    } catch (e) {
        if (e instanceof SessionInUseError) throw new RpcError(e.message, "in_use");
        throw new RpcError((e as Error).message);
    }
    return () => releaseSession(file);
}

/**
 * Move a session's files to the trash, holding its lock meanwhile so a
 * terminal can't open it halfway. The transcript goes first: from then on the
 * session isn't listed, and if anything else can't move, it all goes back.
 */
export function trashSession(id: string, flags: SessionFlags) {
    const { file, dir, slug, moves, entry } = locateSession(id);
    const release = claimForDelete(file);
    try {
        // An older copy of this id (deleted, then made again): the newer one wins.
        if (present(entry)) removeTree(entry);
        mkdirSync(entry, { mode: 0o700 });
        const meta: TrashEntry = { id, slug, deletedAt: Date.now(), ...flags };
        writeFileSync(join(entry, "entry.json"), JSON.stringify(meta), { mode: 0o600, flag: "wx" });
        try {
            moveAll(moves.map((m) => [m.live, join(entry, m.trashed)]));
        } catch (e) {
            if (readdirSync(entry).length === 1) removeTree(entry);
            throw e;
        }
    } finally {
        // The last one to let go removes the lock (it names this process).
        release();
    }
    forgetFileHistory(join(dir, "file-history", id));
}

/** A trash entry's record, read only from a regular file (not through a link). */
function readEntry(entry: string): Partial<TrashEntry> {
    if (!lstatSync(join(entry, "entry.json")).isFile()) throw new Error("not an entry");
    return JSON.parse(readFileSync(join(entry, "entry.json"), "utf-8"));
}

function entryOf(id: string): TrashEntry {
    const entry = join(trashDir(), id);
    let meta: Partial<TrashEntry>;
    try {
        if (!lstatSync(entry).isDirectory()) throw new Error("not an entry");
        meta = readEntry(entry);
    } catch {
        throw new RpcError("That session is no longer in the trash.", "not_found");
    }
    if (meta.id !== id || typeof meta.slug !== "string" || !SLUG.test(meta.slug)) throw new RpcError("That session's trash entry is damaged.", "invalid");
    return meta as TrashEntry;
}

/**
 * Put a trashed session back where it was, with what the GUI store said
 * about it. Renames keep the files' modes (0600, folders 0700). The
 * transcript goes last, so the session lists only once it's all back. The optional
 * preflight can refuse restoring a session whose worktree is being removed.
 */
export function restoreSession(id: string, beforeRestore?: (cwd: string | undefined) => void): SessionFlags {
    const entry = join(trashDir(), checkId(id));
    // Only from a trash folder that's in the Cavvy home (not a link out of it).
    try {
        if (!lstatSync(trashDir()).isDirectory()) throw new Error("not a folder");
    } catch {
        throw new RpcError("That session is no longer in the trash.", "not_found");
    }
    mustBeInHome(entry);
    const exists = () => new RpcError("A session with that id exists again, so this one can't be put back.", "exists");
    const first = entryOf(id);
    if (findSessionAnywhere(id)) throw exists();
    const dir = join(paths.projectsDir(), first.slug);
    const file = join(dir, `${id}.jsonl`);
    // Each folder is checked before anything is made in it.
    mkdirSync(paths.projectsDir(), { recursive: true, mode: 0o700 });
    for (const d of [dir, join(dir, "ui"), join(dir, "file-history"), join(dir, "queue")]) {
        mustBeInHome(d);
        if (!present(d)) mkdirSync(d, { mode: 0o700 });
    }
    // Held from the checks through the cleanup: another server deleting it
    // again meanwhile (into a new trash/<id>) waits for it, or is refused.
    const release = claimForDelete(file);
    try {
        const meta = entryOf(id);
        if (meta.slug !== first.slug || findSessionAnywhere(id)) throw exists();
        const moves = pieces(dir, id)
            .map((m) => [join(entry, m.trashed), m.live] as [string, string])
            .filter(([from]) => present(from))
            .reverse();
        if (moves.at(-1)?.[1] !== file) throw new RpcError("That session's transcript isn't in the trash.", "not_found");
        for (const [, to] of moves) {
            if (present(to)) throw new RpcError(`${to} exists again, so the session can't be put back.`, "exists");
            mustBeInHome(to);
        }
        if (beforeRestore) {
            const transcript = join(entry, "transcript.jsonl");
            // A linked transcript can be moved safely, but must never be followed for this check.
            beforeRestore(lstatSync(transcript).isFile() ? sessionFolder(transcript) : undefined);
        }
        moveAll(moves);
        // Only what this emptied: anything else in it keeps the folder for the purge.
        try {
            unlinkSync(join(entry, "entry.json"));
            rmdirSync(entry);
        } catch {
            // purged later
        }
        return { pinned: Boolean(meta.pinned), archived: Boolean(meta.archived), settled: Boolean(meta.settled) };
    } finally {
        release();
    }
}

/** Remove trash entries deleted more than a week ago. Best effort, a bounded number per run. */
export function purgeTrash(opts: { now?: number; maxAgeMs?: number } = {}): string[] {
    const now = opts.now ?? Date.now();
    const maxAge = opts.maxAgeMs ?? TRASH_MAX_AGE_MS;
    const removed: string[] = [];
    let names: string[];
    try {
        if (!lstatSync(trashDir()).isDirectory()) return removed;
        names = readdirSync(trashDir());
    } catch {
        return removed;
    }
    for (const name of names) {
        if (removed.length >= PURGE_MAX_ENTRIES) break;
        const entry = join(trashDir(), name);
        try {
            const st = lstatSync(entry);
            if (!st.isDirectory()) continue;
            let at = st.mtimeMs;
            try {
                const meta = readEntry(entry);
                if (typeof meta.deletedAt === "number") at = meta.deletedAt;
            } catch {
                // the folder's time, then
            }
            if (now - at < maxAge) continue;
            removeTree(entry);
            removed.push(name);
        } catch {
            // next one
        }
    }
    return removed;
}
