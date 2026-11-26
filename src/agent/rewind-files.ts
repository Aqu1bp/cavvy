// Putting files back as they were before a prompt (/rewind, the GUI's Rewind), whoever changed them since: Cavvy's
// edit tools, shell commands, Claude Code, Codex and the other agent CLIs, or the user. Each prompt's turn snapshot
// (turn-snapshots.ts) recorded the working tree as it started; a capture of it now says which files differ since, and
// each is put back from the snapshot (deleted, if it didn't exist then; made again, if it was deleted). Files that
// didn't change are left alone, and so is what snapshots don't cover (ignored files, files over 10 MB, other
// repositories inside this one). The capture taken just before restoring is what an Undo puts back.
//
// Without a usable snapshot (not a Git repository, an untrusted folder, an older session, a prompt whose snapshot is
// incomplete or was pruned with the file history after 30 days), or while another session works in the same
// repository, only what Cavvy's own edit tools changed can be put back (checkpoints.ts), and the plan says why. A file
// the snapshots don't cover is put back from those copies too, when there is one.

import { randomBytes } from "crypto";
import { chmod, lstat, mkdir, readFile, readlink, rename, rm, rmdir, symlink, unlink, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { blobId, type Entry } from "../server/git-changes";
import { canonical, type FileHistory, type RestoreItem } from "./checkpoints";
import { heldSessionFolders } from "./session";
import type { TurnCapture, TurnSnapshots } from "./turn-snapshots";

export interface FileRestoreItem {
    /** Absolute. */
    path: string;
    /** write: put back as it was · delete: it didn't exist then · create: it was deleted since · skip: can't be. */
    action: "write" | "delete" | "create";
    /** Changed outside Cavvy since it last wrote it: only said of files put back from Cavvy's own copies, which can't be undone. */
    outside?: boolean;
    /** Undo can put it back as it is now. */
    undoable: boolean;
}

interface PlanState {
    snapshots?: TurnSnapshots;
    history?: FileHistory;
    root?: string;
    /** The files when this was planned. */
    now?: TurnCapture;
    /** By repository-relative path: as it was then (`old`) and as it was when planned (`now`). */
    changes: Map<string, { old?: Entry; now?: Entry }>;
    /** Put back from Cavvy's own copies (checkpoints.ts). */
    copies: RestoreItem[];
}

export interface FileRestorePlan {
    /** Every file that changed since then can be put back, whoever changed it. False: only what Cavvy's own edits changed. */
    whole: boolean;
    /** Why not whole, where it could have been. */
    refused?: string;
    items: FileRestoreItem[];
    skipped: { path: string; reason: string }[];
    /** What restoring takes (restoreFiles). */
    readonly state: PlanState;
}

export interface FileRestoreResult {
    /** Absolute paths. */
    done: string[];
    failed: { path: string; error: string }[];
    /** Passed to undoRestore, while it's the last restore of this session. */
    undo?: string;
}

const SHARED = "Another session is working in this folder.";
const CHANGED = "changed while you were choosing; left as it is";

const inside = (root: string, abs: string) => {
    const rel = relative(root, abs);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : undefined;
};

/**
 * Whether a session other than this one may be changing files in repository `root`: one of `inProcess` (folders of
 * this process's other sessions that are working now: the app's), or any session another process has open there (the
 * terminal's, another app's), since whether that one is working can't be told from here.
 */
export function workingAlongside(root: string | undefined, inProcess: string[] = []): boolean {
    if (!root) return false;
    for (const f of [...inProcess, ...heldSessionFolders()]) {
        const c = canonical(f);
        if (c === root || c.startsWith(`${root}/`) || root.startsWith(`${c}/`)) return true;
    }
    return false;
}

/**
 * What answering the prompt that started `checkpoint` changed in files, as a rewind's list says it, without reading
 * anything: by anything (`whole`, from its turn snapshot), else by Cavvy's own tools.
 */
export function changedBy(snapshots: TurnSnapshots | undefined, history: FileHistory | undefined, checkpoint: number | undefined): { tracked: boolean; whole: boolean; files: number } {
    if (checkpoint === undefined || !history) return { tracked: false, whole: false, files: 0 };
    const turn = snapshots?.turn(checkpoint);
    if (turn?.start.tree && !turn.start.incomplete && turn.changed) return { tracked: true, whole: true, files: turn.changed.length };
    return { tracked: true, whole: false, files: history.filesIn(checkpoint).length };
}

/**
 * What putting the files back as they were before the prompt that started `checkpoint` takes. `snapshots` only for a
 * trusted folder (they read the repository); `alongside` as for workingAlongside. Never throws for a snapshot that
 * can't be used: the plan falls back to Cavvy's own copies and says why (`refused`).
 */
export async function planFileRestore(o: { snapshots?: TurnSnapshots; history?: FileHistory; checkpoint?: number; alongside?: string[] }): Promise<FileRestorePlan> {
    const { snapshots, history, checkpoint: cp } = o;
    const copies = history && cp !== undefined ? history.plan(cp) : [];
    // The files now: what Undo puts back, and what's compared with the snapshot.
    const captured = snapshots && cp !== undefined ? await snapshots.current().catch(() => undefined) : undefined;
    const now = captured?.tree && captured.root && !captured.incomplete ? captured : undefined;

    const fallback = (refused?: string): FileRestorePlan => {
        const coveredNow = (abs: string) => {
            const rel = now?.root && inside(now.root, abs);
            return !!rel && !Object.hasOwn(now!.skipped, rel);
        };
        return {
            whole: false,
            ...(refused ? { refused } : {}),
            items: copies.filter((i) => i.action !== "skip").map((i) => ({ path: i.path, action: i.action === "delete" ? "delete" : i.current === null ? "create" : "write", ...(i.outside ? { outside: true } : {}), undoable: coveredNow(i.path) })),
            skipped: copies.filter((i) => i.action === "skip").map((i) => ({ path: i.path, reason: i.reason ?? "" })),
            state: { snapshots: now ? snapshots : undefined, history, root: now?.root, now, changes: new Map(), copies: copies.filter((i) => i.action !== "skip") },
        };
    };
    if (!snapshots || cp === undefined || !snapshots.list().length) return fallback();
    const turn = snapshots.turn(cp);
    if (!turn) return fallback("No record of the files from then.");
    if (!turn.start.tree || turn.start.incomplete || !turn.start.root) return fallback("The record of the files from then is incomplete.");
    const root = turn.start.root;
    if (!now || now.root !== root) return fallback("Couldn't read the files as they are now.");
    if (workingAlongside(root, o.alongside)) return fallback(SHARED);
    let diff: Map<string, { old?: Entry; now?: Entry }>;
    try {
        diff = await snapshots.between(turn.start, now);
    } catch {
        return fallback("The record of the files from then is gone.");
    }

    // Left out of a capture (too big, unreadable): not in its tree, so a snapshot can't say how it was, or is. One left
    // out of both, unchanged, is no change.
    const left = new Map<string, string>();
    for (const [rel, reason] of Object.entries({ ...turn.start.skipped, ...now.skipped })) {
        const both = Object.hasOwn(turn.start.skipped, rel) && Object.hasOwn(now.skipped, rel);
        if (both && turn.start.skippedStamps?.[rel] !== undefined && turn.start.skippedStamps[rel] === now.skippedStamps?.[rel]) continue;
        left.set(rel, reason);
    }
    const changes = new Map<string, { old?: Entry; now?: Entry }>();
    const items: FileRestoreItem[] = [];
    for (const [rel, d] of diff) {
        // Another repository inside this one (a submodule, a worktree): its files aren't in the snapshot.
        if (left.has(rel) || d.old?.mode === "160000" || d.now?.mode === "160000") continue;
        changes.set(rel, d);
        items.push({ path: join(root, rel), action: !d.old ? "delete" : !d.now ? "create" : "write", undoable: true });
    }
    // What the snapshots don't cover, from Cavvy's own copies where it has them.
    const kept: RestoreItem[] = [];
    const skipped: { path: string; reason: string }[] = [];
    const uncovered = new Set<string>();
    for (const c of copies) {
        const rel = inside(root, c.path);
        if (rel && !left.has(rel)) continue;
        if (rel) uncovered.add(rel);
        if (c.action === "skip") skipped.push({ path: c.path, reason: c.reason ?? "" });
        else {
            kept.push(c);
            items.push({ path: c.path, action: c.action === "delete" ? "delete" : c.current === null ? "create" : "write", ...(c.outside ? { outside: true } : {}), undoable: !!rel && !Object.hasOwn(now.skipped, rel) });
        }
    }
    for (const [rel, reason] of left) if (!uncovered.has(rel)) skipped.push({ path: join(root, rel), reason });
    items.sort((a, b) => a.path.localeCompare(b.path));
    return { whole: true, items, skipped, state: { snapshots, history, root, now, changes, copies: kept } };
}

/** What's on disk at `abs` is what `e` records: its bytes, as a file (executable or not) or a link; no entry, nothing there. */
async function matches(abs: string, e: Entry | undefined): Promise<boolean> {
    let st;
    try {
        st = await lstat(abs);
    } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return !e;
        throw err;
    }
    if (!e) return false;
    const algo = e.oid.length === 64 ? "sha256" : "sha1";
    if (e.mode === "120000") return st.isSymbolicLink() && blobId(await readlink(abs, { encoding: "buffer" }), algo) === e.oid;
    if (!st.isFile() || (e.mode === "100755") !== Boolean(st.mode & 0o100)) return false;
    return blobId(await readFile(abs), algo) === e.oid;
}

/** As it's on disk, for an Undo to check nothing changed it since; undefined: nothing there. */
async function entryOf(abs: string, algo: "sha1" | "sha256"): Promise<Entry | undefined> {
    const st = await lstat(abs).catch(() => undefined);
    if (!st) return undefined;
    if (st.isSymbolicLink()) return { mode: "120000", oid: blobId(await readlink(abs, { encoding: "buffer" }), algo) };
    if (!st.isFile()) return { mode: "040000", oid: "" };
    return { mode: st.mode & 0o100 ? "100755" : "100644", oid: blobId(await readFile(abs), algo) };
}

/** The folders on the way to `abs` from `root`, made where they're missing; never through a link. */
async function folderFor(root: string, abs: string) {
    const parts = relative(root, dirname(abs)).split("/").filter(Boolean);
    let dir = root;
    for (const part of parts) {
        dir = join(dir, part);
        const st = await lstat(dir).catch(() => undefined);
        if (!st) await mkdir(dir);
        else if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("a folder on its path isn't one now; left as it is");
    }
}

/** `abs` as `e` records it, its bytes `buf`: written beside it, then renamed over it, so a link there is replaced, never followed. */
async function put(root: string, abs: string, e: Entry, buf: Buffer) {
    await folderFor(root, abs);
    const was = await lstat(abs).catch(() => undefined);
    const tmp = join(dirname(abs), `.${basename(abs)}.${randomBytes(4).toString("hex")}.restore`);
    try {
        if (e.mode === "120000") await symlink(buf.toString("utf-8"), tmp);
        else {
            await writeFile(tmp, buf, { flag: "wx", mode: 0o600 });
            // Its own permissions kept, but for the executable bits, which Git records.
            const base = was?.isFile() ? was.mode & 0o777 : 0o666 & ~process.umask();
            await chmod(tmp, e.mode === "100755" ? base | ((base & 0o444) >> 2) : base & ~0o111);
        }
        await rename(tmp, abs);
    } catch (err) {
        await rm(tmp, { force: true }).catch(() => undefined);
        throw err;
    }
}

/** `abs` removed, and the folders it leaves empty up to `root`. */
async function remove(root: string, abs: string) {
    await unlink(abs).catch((err: NodeJS.ErrnoException) => {
        if (err.code !== "ENOENT") throw err;
    });
    for (let dir = dirname(abs); inside(root, dir); dir = dirname(dir)) {
        if (!(await rmdir(dir).then(() => true, () => false))) break;
    }
}

interface UndoRecord {
    id: string;
    root: string;
    /** By repository-relative path: what Undo puts back (`to`, none: delete it), if it's still as the restore left it (`left`). */
    files: Map<string, { to?: Entry; left?: Entry }>;
}
const undos = new WeakMap<TurnSnapshots, UndoRecord>();

/** Snapshot changes in an order that never meets its own work in the way: removals deepest first, then writes. */
function ordered(changes: Map<string, { old?: Entry; now?: Entry }>): [string, { old?: Entry; now?: Entry }][] {
    const all = [...changes];
    const gone = all.filter(([, d]) => !d.old).sort(([a], [b]) => b.split("/").length - a.split("/").length || b.localeCompare(a));
    return [...gone, ...all.filter(([, d]) => d.old).sort(([a], [b]) => a.localeCompare(b))];
}

/**
 * Carry out a plan. The files are captured again first, which is what Undo puts back; a file that changed since the
 * plan was made is left alone and said so. Throws, having changed nothing, when another session now works in the
 * repository or the files can't be read.
 */
export async function restoreFiles(plan: FileRestorePlan, o: { alongside?: string[] } = {}): Promise<FileRestoreResult> {
    const { snapshots, history, root, now, changes, copies } = plan.state;
    const done: string[] = [];
    const failed: { path: string; error: string }[] = [];
    if (changes.size && workingAlongside(root, o.alongside)) throw new Error(`${SHARED} Nothing was restored.`);
    let fresh: TurnCapture | undefined;
    if (snapshots && now && root) {
        const c = await snapshots.current().catch(() => undefined);
        if (c?.tree && c.root === root && !c.incomplete) fresh = c;
    }
    if (changes.size && !fresh) throw new Error("Couldn't read the files as they are now. Nothing was restored.");
    let meanwhile: Map<string, unknown> = new Map();
    try {
        if (fresh && now) meanwhile = await snapshots!.between(now, fresh);
    } catch {
        if (changes.size) throw new Error("Couldn't read the files as they are now. Nothing was restored.");
        // Cavvy's own copies check each file themselves; only Undo goes without.
        fresh = undefined;
    }
    const undo: UndoRecord | undefined = fresh && root ? { id: randomBytes(8).toString("hex"), root, files: new Map() } : undefined;

    for (const [rel, d] of ordered(changes)) {
        const abs = join(root!, rel);
        try {
            if (meanwhile.has(rel) || !(await matches(abs, d.now))) {
                failed.push({ path: abs, error: CHANGED });
                continue;
            }
            if (d.old) {
                const buf = await snapshots!.blob(d.old.oid);
                await put(root!, abs, d.old, buf);
                history?.noteWrote(abs, d.old.mode === "120000" ? null : buf);
            } else {
                await remove(root!, abs);
                history?.noteWrote(abs, null);
            }
            undo?.files.set(rel, { to: d.now, left: d.old });
            done.push(abs);
        } catch (e) {
            failed.push({ path: abs, error: (e as Error).message });
        }
    }

    if (copies.length && history) {
        // Those an Undo can put back, as they are now.
        const rels = new Map<string, string>();
        for (const c of copies) {
            const rel = root && inside(root, c.path);
            if (rel && fresh && !Object.hasOwn(fresh.skipped, rel) && !meanwhile.has(rel)) rels.set(c.path, rel);
        }
        const before = fresh && rels.size ? await snapshots!.entriesIn(fresh, [...rels.values()]).catch(() => undefined) : undefined;
        const r = history.restore(copies);
        failed.push(...r.failed);
        for (const path of r.done) {
            done.push(path);
            const rel = rels.get(path);
            if (undo && before && rel && before.has(rel)) undo.files.set(rel, { to: before.get(rel), left: await entryOf(path, fresh!.tree!.length === 64 ? "sha256" : "sha1") });
        }
    }

    if (undo?.files.size) {
        try {
            // The versions Undo needs, kept apart from the repository's (its garbage collection can't lose them).
            await snapshots!.keepVersions([...undo.files.values()].flatMap((f) => (f.to && f.to.mode !== "160000" ? [f.to] : [])));
            undos.set(snapshots!, undo);
        } catch {
            // Without them, an Undo might put back nothing: none is offered.
        }
    }
    return { done, failed, ...(undo?.files.size && undos.get(snapshots!) === undo ? { undo: undo.id } : {}) };
}

/** Whether `id` is the restore an Undo can still put back. */
export function canUndoRestore(snapshots: TurnSnapshots | undefined, id: string): boolean {
    return !!snapshots && undos.get(snapshots)?.id === id;
}

/**
 * Put the files back as they were before restore `id` (the session's last one). A file changed since the restore is
 * left alone and said so.
 */
export async function undoRestore(snapshots: TurnSnapshots | undefined, id: string, history?: FileHistory): Promise<{ done: string[]; failed: { path: string; error: string }[] }> {
    const rec = snapshots && undos.get(snapshots);
    if (!rec || rec.id !== id) throw new Error("That restore can't be undone any more.");
    undos.delete(snapshots!);
    const done: string[] = [];
    const failed: { path: string; error: string }[] = [];
    const all = new Map([...rec.files].map(([rel, f]) => [rel, { old: f.to, now: f.left }]));
    for (const [rel, f] of ordered(all)) {
        const abs = join(rec.root, rel);
        try {
            if (!(await matches(abs, f.now))) {
                failed.push({ path: abs, error: "changed since; left as it is" });
                continue;
            }
            if (f.old) {
                const buf = await snapshots!.blob(f.old.oid);
                await put(rec.root, abs, f.old, buf);
                history?.noteWrote(abs, f.old.mode === "120000" ? null : buf);
            } else {
                await remove(rec.root, abs);
                history?.noteWrote(abs, null);
            }
            done.push(abs);
        } catch (e) {
            failed.push({ path: abs, error: (e as Error).message });
        }
    }
    return { done, failed };
}
