// Raw working-tree snapshots, independent of edit tools and backend history.
// Version 2 journal (reads version 1 too): one complete turn record per line, later records replace
// earlier ones with the same checkpoint id. All objects belong to this session;
// no alternates, repository writes, filters, hooks, or network access are used.
// Git's loose object format is zlib(header + bytes); hashing/compressing in
// process avoids a subprocess per file and preserves the bytes on disk.

import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from "fs";
import { chmod, copyFile, lstat, mkdir, open, readdir, readFile, readlink, rename, rm, writeFile } from "fs/promises";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "path";
import { deflateSync, inflateSync } from "zlib";
import { randomBytes } from "crypto";
import { FileHistory, MAX_SNAPSHOT_BYTES, canonical } from "./checkpoints";
import type { Session } from "./session";
import { blobId, blobs, git, gitEnvironment, readRegular, readRegularSync, render, WorkTree, type Change, type Entry } from "../server/git-changes";
import { gitArgv } from "../util/git";
import { coalesce, type Slot } from "../server/coalesce";
import { MAX_DIFF_INPUT } from "../server/diffs";
import type { GitChangesInfo, GitScope, TurnPlace } from "../server/protocol";
import { changedSince, eachLimited, insideRoot, movedSince, nearby, reachedPlaces, summarize, THERE, token, UNKNOWN, WorktreeChecks, WorktreeList, type Checked, type Worktree } from "./turn-places";
import { redact } from "../util/redact";
import { cleanBlob, cleanBlobMs, modeOf, msTimesExact, parseIndex, type GitIndex } from "./git-index";
import { Pace } from "../util/pace";
import { KIND, scanIndexFiles, scanIndexPaths, statFiles } from "./stat-files";
import type { Differs, IndexScan } from "./index-scan";
import { acquireWatch, releaseWatch, type FolderWatch } from "./folder-watch";
import { editTree, ObjectReader, parseTree, type TreeEdit } from "./tree-edit";

/** Paths a turn reached that are kept (TurnSnapshots.reach): past this many, the rest go unseen. */
const MAX_REACHED = 20_000;
/** Files looked up at once: about as cheap as it gets, and not so many that one wait holds up the deadline. */
const STAT_BATCH = 64;
/** Files read at once for a capture: much faster than one by one, and little to hold in memory. */
const READ_AT_ONCE = 8;
/**
 * A capture with this many new objects, or this many bytes of them, writes one pack rather than a file for each. Creating a
 * small file costs more than reading and compressing one, and on disk it takes a whole block.
 */
const PACK_FROM_OBJECTS = 256;
const PACK_FROM_BYTES = 8 * 1024 * 1024;
/** A pack is finished at this size, and another begun. */
const PACK_MAX_BYTES = 64 * 1024 * 1024;

export interface TurnCapture {
    tree?: string;
    root?: string;
    incomplete: boolean;
    notes: string[];
    skipped: Record<string, string>;
    /** Metadata only: unchanged omissions are not falsely counted as changed files. */
    skippedStamps?: Record<string, string>;
    durationMs: number;
    /** The repository's other worktrees inside its folder, each with its token (turn-places.ts), UNKNOWN, or THERE. */
    places?: Record<string, string>;
    /** When it was taken, on the file system's clock (nanoseconds): what changed after it is newer (changedSince). */
    since?: string;
    /** Not saved: at a turn's end, the worktrees it worked in, summed up then, until finish() records them. */
    worked?: TurnPlace[];
}

export interface SnapshotTurn {
    version: 2;
    id: number;
    prompt: string;
    startedAt: number;
    endedAt?: number;
    start: TurnCapture;
    end?: TurnCapture;
    /** Repository-relative paths, including omitted files. Version 1 stored absolute paths. */
    changed?: string[];
    /** The other worktrees it worked in (changed, or appeared, during it), as they were when it ended. */
    places?: TurnPlace[];
}

export const MAX_SNAPSHOT_STORE_BYTES = 256 * 1024 * 1024;
/** Past this many versions to keep from the repository's objects, they're copied as one pack (keep). */
const PACK_KEEP_FROM = 64;
/** How long a turn's end capture may take (a start has 2 s: the model waits on it). */
const END_BUDGET_MS = 10_000;
/**
 * How long a whole capture may go on after the turn it was taken for stopped waiting (capture). Long: with many
 * sessions on a busy machine, each one's first waits its turn behind the others' on the stat worker, and one that gave
 * up would only be started again by the next turn.
 */
const WHOLE_BUDGET_MS = 10 * 60_000;
/** Git's index has this many entries at least: a capture that can't look only at what changed asks `git status` (captureFromStatus). */
const STATUS_FROM_ENTRIES = 5000;
/** How long a capture waits for such a whole capture still going before it's taken as out of time. */
const WHOLE_WAIT_MS = 100;

/** Whether `work` settles before `deadline` (it goes on either way). */
async function settlesBy(work: Promise<unknown>, deadline: number): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<false>((r) => (timer = setTimeout(() => r(false), Math.max(0, deadline - Date.now()))));
    try {
        return await Promise.race([work.then(() => true, () => true), late]);
    } finally {
        clearTimeout(timer);
    }
}
/**
 * A capture looks only at what the folder's watch saw change (captureNarrowed) where the last whole one took this long
 * (ms): below it, looking at everything costs less than waiting for the watch's events.
 */
const NARROW_FROM_MS = 60;
/**
 * Captures in a row that look only at what changed, and for how long (ms), before one looks at everything again: a
 * watch that missed something (it says so when it can tell, and everything is looked at then) isn't relied on for long.
 */
const NARROW_MAX = 32;
const NARROW_FULL_EVERY_MS = 10 * 60_000;
/** Past this many changed paths (or this many bytes of them, as git's arguments), everything is looked at. */
const NARROW_MAX_PATHS = 2000;
const NARROW_MAX_ARG_BYTES = 128 * 1024;

/** A file's stat, to see it's the one it was: inode, size and times. */
const stampKey = (st: Stats) => `${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;

/** `path` is inside one of `dirs` (each without a trailing slash). */
function underAny(path: string, dirs: ReadonlySet<string>): boolean {
    if (!dirs.size) return false;
    for (let i = path.lastIndexOf("/"); i > 0; i = path.lastIndexOf("/", i - 1)) if (dirs.has(path.slice(0, i))) return true;
    return false;
}

/**
 * Trees read or written by editTrees, by id: a tree's id names its bytes, whichever repository it's in. A turn's
 * capture edits the last one's trees along a few paths, so most it reads are here, and no git is started for them.
 */
const treeBodies = new Map<string, Buffer>();
let treeBytes = 0;
const TREE_CACHE_BYTES = 32 * 1024 * 1024;
/** A session's object reader goes after this long unused, and is started again after this long at most. */
const READER_IDLE_MS = 60_000;
/** A turn's trees are read ahead (warmTrees) along this many changed paths at most. */
const WARM_MAX_PATHS = 200;
const READER_MAX_MS = 60 * 60_000;
function rememberTree(oid: string, body: Buffer) {
    if (treeBodies.has(oid) || body.length > TREE_CACHE_BYTES / 8) return;
    treeBodies.set(oid, body);
    treeBytes += body.length;
    for (const [old, b] of treeBodies) {
        if (treeBytes <= TREE_CACHE_BYTES) break;
        treeBodies.delete(old);
        treeBytes -= b.length;
    }
}

/**
 * How long a capture waits for the events of a change just made, before it takes the watch's count: inotify (Linux)
 * delivers them within milliseconds; FSEvents (a Mac) later, so a turn's end, which no model waits on, waits longer.
 */
function eventWait(ending: boolean): number {
    return ending && process.platform === "darwin" ? 100 : 30;
}

/** How many entries Git's index file says it has (0 when it can't be read). */
async function indexEntries(path: string): Promise<number> {
    try {
        const f = await open(path, "r");
        try {
            const head = Buffer.alloc(12);
            const { bytesRead } = await f.read(head, 0, 12, 0);
            return bytesRead === 12 ? head.readUInt32BE(8) : 0;
        } finally {
            await f.close();
        }
    } catch {
        return 0;
    }
}

const instances = new WeakMap<FileHistory, WeakMap<Session, TurnSnapshots>>();
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const POLICY = "Ignored files are not captured. Concurrent sessions in this repository see each other's changes. Submodule and nested repository contents are not captured.";
/** A saved turn's places: each a worktree's folder, with counts that are counts. */
function validPlaces(value: unknown): value is TurnPlace[] {
    const count = (n: unknown) => n === undefined || (typeof n === "number" && Number.isSafeInteger(n) && n >= 0);
    return Array.isArray(value) && value.every((p) => !!p && typeof p === "object" && typeof p.path === "string" && isAbsolute(p.path)
        && (p.branch === undefined || typeof p.branch === "string") && (p.base === undefined || typeof p.base === "string")
        && count(p.files) && count(p.added) && count(p.removed) && count(p.commits)
        && (p.top === undefined || (Array.isArray(p.top) && p.top.every((f: any) => !!f && typeof f.path === "string" && ["added", "modified", "deleted"].includes(f.change) && count(f.added) && count(f.removed)))));
}
const safePath = (p: string) => p.length > 0 && !p.includes("\0") && !isAbsolute(p) && !p.split("/").some((part) => part === ".." || part.toLowerCase() === ".git");
const pathMap = (...sources: Record<string, string>[]): Record<string, string> => Object.assign(Object.create(null), ...sources);
const own = (map: Record<string, string> | undefined, path: string) => map && Object.hasOwn(map, path) ? map[path] : undefined;

/** A folder of the tree a capture plans: its files and folders, and its tree's id while nothing under it has changed. */
interface Folder { files: Map<string, Entry>; dirs: Map<string, Folder>; oid?: string }
const folder = (): Folder => ({ files: new Map(), dirs: new Map() });

/**
 * The capture's files into `root`'s folders: each path's entry set, or (gone from `entries`) removed with any folder
 * it leaves empty; the folders above each one lose their tree id, to be worked out again (treeObjects).
 */
async function placeFiles(root: Folder, paths: Iterable<string>, entries: Map<string, Entry>, inTime: () => void, pace: Pace) {
    let n = 0;
    for (const path of paths) {
        if ((++n & 255) === 0) {
            inTime();
            if (pace.due) await pace.rest();
        }
        const parts = path.split("/");
        const name = parts.pop()!;
        const entry = entries.get(path);
        const chain = [root];
        let node: Folder | undefined = root;
        for (const part of parts) {
            let next: Folder | undefined = node.dirs.get(part);
            if (!next) {
                if (!entry) { node = undefined; break; }
                node.dirs.set(part, (next = folder()));
            }
            chain.push(next);
            node = next;
        }
        if (!node) continue;
        for (const f of chain) f.oid = undefined;
        if (entry) { node.files.set(name, entry); continue; }
        node.files.delete(name);
        // Git keeps no empty folders.
        for (let i = chain.length - 1; i > 0 && !chain[i]!.files.size && !chain[i]!.dirs.size; i--) chain[i - 1]!.dirs.delete(parts[i - 1]!);
    }
}

/**
 * The tree ids of `root`'s folders, worked out again only where something under them changed (placeFiles), and the
 * new tree objects, before write-tree, so their compressed bytes pass through the same quota as blobs. Git then
 * reuses these private objects.
 */
async function treeObjects(root: Folder, algo: "sha1" | "sha256", inTime: () => void, pace: Pace): Promise<{ root: string; objects: Map<string, Buffer> }> {
    const objects = new Map<string, Buffer>();
    // The folders to work out, each before the ones in it; then taken from the end, each after the ones in it.
    const order: Folder[] = [];
    const stack = [root];
    while (stack.length) {
        const node = stack.pop()!;
        if (node.oid) continue;
        order.push(node);
        for (const dir of node.dirs.values()) if (!dir.oid) stack.push(dir);
    }
    for (let i = order.length - 1; i >= 0; i--) {
        if ((i & 63) === 0) {
            inTime();
            if (pace.due) await pace.rest();
        }
        const node = order[i]!;
        const children = [...node.files].map(([name, e]) => ({ name, mode: e.mode, oid: e.oid, order: Buffer.from(name) }));
        for (const [name, dir] of node.dirs) children.push({ name, mode: "40000", oid: dir.oid!, order: Buffer.from(name + "/") });
        children.sort((a, b) => Buffer.compare(a.order, b.order));
        const bytes = Buffer.concat(children.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, "hex")]));
        const hash = new Bun.CryptoHasher(algo);
        hash.update(`tree ${bytes.length}\0`);
        hash.update(bytes);
        node.oid = hash.digest("hex");
        objects.set(node.oid, bytes);
    }
    return { root: root.oid!, objects };
}

/** An object as a pack holds it: its type and size, then its bytes compressed, with no header. */
function packEntry(type: "blob" | "tree", raw: Buffer): Buffer[] {
    let size = raw.length;
    let byte = ((type === "tree" ? 2 : 3) << 4) | (size % 16);
    size = Math.floor(size / 16);
    const head: number[] = [];
    while (size > 0) {
        head.push(byte | 0x80);
        byte = size % 128;
        size = Math.floor(size / 128);
    }
    head.push(byte);
    return [Buffer.from(head), deflateSync(raw, { level: 1 })];
}

/** The object ids a pack's index lists (version 2), or none if it isn't a whole one. */
function packIndexOids(index: Buffer, hashBytes: number): string[] {
    const names = 8 + 256 * 4;
    if (index.length < names || index.readUInt32BE(0) !== 0xff744f63 || index.readUInt32BE(4) !== 2) return [];
    const count = index.readUInt32BE(8 + 255 * 4);
    // Each object's id, checksum and place, then what the pack and the index themselves hash to.
    if (index.length < names + count * (hashBytes + 8) + 2 * hashBytes) return [];
    return Array.from({ length: count }, (_, i) => index.toString("hex", names + i * hashBytes, names + (i + 1) * hashBytes));
}

/**
 * A file as last seen: its stamp and what it held. `borrowed`: its blob was taken from Git's index (the file was
 * as Git last recorded it), so it's in the repository's objects and not, until a turn changes the file, this
 * session's own.
 */
type KnownFile = { path: string; stamp: Stamp; entry: Entry; borrowed?: boolean };

/** A file's stat as compared from one capture to the next: device, inode, mode, size, mtime, ctime. */
type Stamp = readonly [number, number, number, number, number, number];
/** The fields of a stat a stamp is made of (fs.Stats has them). */
type StampFields = Pick<Stats, "dev" | "ino" | "mode" | "size" | "mtimeMs" | "ctimeMs">;
/** A path's stat as stat-files.ts gave it. */
type FileStat = StampFields & { kind: number };
const stampOf = (st: StampFields): Stamp => [st.dev, st.ino, st.mode, st.size, st.mtimeMs, st.ctimeMs];
const sameStamp = (a: Stamp, st: StampFields) => a[0] === st.dev && a[1] === st.ino && a[2] === st.mode && a[3] === st.size && a[4] === st.mtimeMs && a[5] === st.ctimeMs;
/** Whether a stamp is the one at `o` in stat-files.ts' stamps. */
const sameAt = (a: Stamp, s: Float64Array, o: number) => a[0] === s[o] && a[1] === s[o + 1] && a[2] === s[o + 2] && a[3] === s[o + 3] && a[4] === s[o + 4] && a[5] === s[o + 5];
const statAt = (kinds: Uint8Array, s: Float64Array, i: number): FileStat => ({ kind: kinds[i]!, dev: s[i * 6]!, ino: s[i * 6 + 1]!, mode: s[i * 6 + 2]!, size: s[i * 6 + 3]!, mtimeMs: s[i * 6 + 4]!, ctimeMs: s[i * 6 + 5]! });
/** A file found by its stat, to be read or taken from the index. */
type Seen = { path: string; st: FileStat; at: number };
/**
 * What's at a path, to see it's still the same thing: nothing, or its kind and inode (a folder's times move whenever
 * something in it does), and a file's size and time too (a .git file naming another folder).
 */
const stampAt = (path: string) => {
    try {
        const st = lstatSync(path, { throwIfNoEntry: false });
        return !st ? "-" : st.isFile() ? `${st.mode}:${st.ino}:${st.size}:${st.mtimeMs}` : `${st.mode}:${st.ino}`;
    } catch {
        return "?";
    }
};
/**
 * Each repository's files known to be stored as they are (no attribute or core.autocrlf converts them), so a file
 * Git's index has as it is can be taken from it without asking again; let go of when its attributes files change.
 */
const asIsByRoot = new Map<string, { attrs?: string; paths: Set<string> }>();
function storedAsIsIn(root: string) {
    let known = asIsByRoot.get(root);
    if (!known) {
        if (asIsByRoot.size >= 256) asIsByRoot.delete(asIsByRoot.keys().next().value!);
        asIsByRoot.set(root, (known = { paths: new Set() }));
    }
    return known;
}

/**
 * The repository a folder is in, as git said: its top folder, object format and index, with the stamps of what
 * decides that (each folder from there up to it, and its .git), to know it's still so without asking again. Kept
 * for every session in the folder.
 */
interface Located { root: string; algo: "sha1" | "sha256"; index?: string; stamps: string[]; paths: string[] }
const locations = new Map<string, Located>();

/** Each repository's worktrees, listed again only once something that decides them changes (for every session in it). */
const worktreeLists = new Map<string, WorktreeList>();
function worktreeListOf(root: string): WorktreeList {
    let list = worktreeLists.get(root);
    if (!list) {
        if (worktreeLists.size >= 256) worktreeLists.delete(worktreeLists.keys().next().value!);
        worktreeLists.set(root, (list = new WorktreeList()));
    }
    return list;
}

/**
 * The repository `cwd` is in (`git rev-parse --show-toplevel`), asked of git once for each folder while it stays the
 * same: its `.git` as it was, and no other on the way up to it. Opening a session waits for it (list() is synchronous):
 * 30 sessions in one repository start one git, not 30.
 */
const tops = new Map<string, { root: string; stamp: string }>();
export function topOf(cwd: string): string | undefined {
    const stamp = (root: string) => {
        try {
            const st = lstatSync(join(root, ".git"), { throwIfNoEntry: false });
            return st ? `${st.dev}:${st.ino}:${st.mode}:${st.ctimeMs}` : undefined;
        } catch { return undefined; }
    };
    let real: string;
    try { real = realpathSync(cwd); } catch { return undefined; }
    const had = tops.get(cwd);
    if (had && stamp(had.root) === had.stamp) {
        let nearer = false;
        for (let dir = real; dir !== had.root && !nearer; dir = dirname(dir)) {
            if (dirname(dir) === dir) { nearer = true; break; }
            try { nearer = !!lstatSync(join(dir, ".git"), { throwIfNoEntry: false }); } catch { nearer = true; }
        }
        if (!nearer) return had.root;
    }
    tops.delete(cwd);
    try {
        const top = Bun.spawnSync(gitArgv(["rev-parse", "--show-toplevel"]), { cwd, env: gitEnvironment({ privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } }), timeout: 2000, stdout: "pipe", stderr: "ignore" });
        if (top.exitCode !== 0) return undefined;
        const root = top.stdout.toString().replace(/\n$/, "");
        const st = stamp(root);
        // Under the repository only (not a worktree's folder taken from elsewhere): what the check above walks.
        if (st && (real === root || real.startsWith(`${root}/`))) {
            if (tops.size >= 256) tops.delete(tops.keys().next().value!);
            tops.set(cwd, { root, stamp: st });
        }
        return root;
    } catch { return undefined; }
}

/**
 * Up to this size a file is read, and an object written, without waiting on each step: a few syscalls on what's
 * in memory anyway, where each step's wait for its turn on a busy machine (tens of ms each, at 30 sessions on 4
 * cores) costs far more. Bigger ones go a step at a time, so the server's thread isn't held for long.
 */
const AT_ONCE_BYTES = 256 * 1024;

/** A changed file's bytes (a link's target), and how it stats after: undefined when it can't be read. */
async function readChanged(abs: string, st: { kind: number; size: number }): Promise<{ buf?: Buffer; after?: Stats }> {
    if (st.size <= AT_ONCE_BYTES) {
        let buf: Buffer | undefined;
        try { buf = st.kind === KIND.link ? readlinkSync(abs, { encoding: "buffer" }) : readRegularSync(abs, MAX_SNAPSHOT_BYTES)?.buf; } catch { return {}; }
        if (!buf) return {};
        try { return { buf, after: lstatSync(abs, { throwIfNoEntry: false }) }; } catch { return { buf }; }
    }
    const buf = st.kind === KIND.link ? await readlink(abs, { encoding: "buffer" }).catch(() => undefined) : (await readRegular(abs, MAX_SNAPSHOT_BYTES))?.buf;
    if (!buf) return {};
    return { buf, after: await lstat(abs).catch(() => undefined) };
}

function sameSet<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): boolean {
    if (a.size !== b.size) return false;
    for (const x of a) if (!b.has(x)) return false;
    return true;
}

/** An object's id from its type and bytes. */
function objectId(type: string, buf: Buffer, algo: "sha1" | "sha256"): string {
    const h = new Bun.CryptoHasher(algo);
    h.update(`${type} ${buf.length}\0`);
    h.update(buf);
    return h.digest("hex");
}

/** Whether each repository may store files as other bytes than they hold (TurnSnapshots.converts), and what that rests on. */
const convertsByRoot = new Map<string, { key: string; converts: boolean; excludes?: string }>();
/** Cache-tree roots whose every tree git was found to have (fromCacheTree): they aren't looked for again. */
const treesFound = new Set<string>();

/**
 * What says, outside the folder, which files are ignored (its info/exclude, core.excludesFile, and the config files
 * that may name one), stamped: changed, a capture looks at everything again.
 */
function ignoreKeyOf(root: string, indexPath: string): string {
    const home = process.env.HOME ?? "";
    const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
    const common = commonDirOf(indexPath);
    const files = [join(common, "info", "exclude"), join(xdg, "git", "ignore"), join(common, "config"), join(dirname(indexPath), "config.worktree"), join(home, ".gitconfig"), join(xdg, "git", "config"), "/etc/gitconfig"];
    const excludes = convertsByRoot.get(root)?.excludes;
    if (excludes) files.push(excludes);
    return files.map((f) => `${f}:${stampAt(f)}`).join("\0");
}

/** The common Git dir of the repository whose index is at `index` (its own Git dir, or the one a worktree's names). */
function commonDirOf(index: string): string {
    const dir = dirname(index);
    try {
        return resolve(dir, readFileSync(join(dir, "commondir"), "utf-8").trim());
    } catch {
        return dir;
    }
}

/** The repository's objects, as git reads them (its common dir's). */
const objectsOf = (index: string) => join(commonDirOf(index), "objects");

/** The repository's own attributes file (info/attributes in its common Git dir, found from where its index is), stamped. */
function infoAttributes(index: string | undefined): string {
    if (!index) return "-";
    let common = dirname(index);
    try {
        common = resolve(common, readFileSync(join(common, "commondir"), "utf-8").trim());
    } catch {
        // The main worktree's: its Git dir is the common one.
    }
    return `info/attributes:${stampAt(join(common, "info", "attributes"))}`;
}

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
/** A path that isn't there (or a file where a folder was): not one that can't be read. */
const gone = (e: unknown) => ["ENOENT", "ENOTDIR"].includes((e as NodeJS.ErrnoException)?.code ?? "");

/** Attributes that make Git store something other than a file's bytes, and the values that leave them alone. */
/** Tracked files looked up in Git's index (and its attributes asked for) at a time. */
const INDEX_CHUNK = 16384;

const CONVERTING = new Set(["text", "eol", "crlf", "filter", "ident", "working-tree-encoding"]);

/**
 * What a repository's files hold, by their stamps. The same for every session working in it, so it's held once: at
 * 100,000 files it's tens of MB. Let go with the last of them. Each session's objects are still its own (`stored`).
 */
const knownFiles = new Map<string, WeakRef<Map<string, KnownFile>>>();
function knownIn(root: string): Map<string, KnownFile> {
    let known = knownFiles.get(root)?.deref();
    if (!known) knownFiles.set(root, new WeakRef((known = new Map())));
    return known;
}

export class TurnSnapshots {
    private turns = new Map<number, SnapshotTurn>();
    private active?: SnapshotTurn;
    private root?: string;
    private algo: "sha1" | "sha256" = "sha1";
    private known = new Map<string, KnownFile>();
    private indexEntries = new Map<string, Entry>();
    private hardened = new Set<string>();
    /** The objects on disk, and which kind each is. */
    private stored = new Map<string, "loose" | "pack">();
    /** New objects of the capture under way, until it's known how many there are. */
    private unwritten = new Map<string, { type: "blob" | "tree"; raw: Buffer }>();
    private unwrittenBytes = 0;
    /** Many new objects: the pack they're going into, in memory until it's finished. */
    private pack?: { chunks: Buffer[]; bytes: number; oids: Set<string> };
    private objectBytes?: number;
    private inflight = new Map<string, Slot<GitChangesInfo>>();
    private saved = false;
    private stopped = false;
    private pending = new Set<Promise<void>>();
    private last: Promise<unknown> = Promise.resolve();
    private failure?: string;
    /** The repository's other worktrees inside its folder, as last listed, and their folders relative to it. */
    private worktrees: Worktree[] = [];
    private nested = new Set<string>();
    /** The last listing worked: a failed one isn't "no worktrees", so nothing is marked from it. */
    private worktreesListed = false;
    /** Which listed worktree folders really are them (turn-places.ts), kept while each folder stays the same one. */
    private checks = new WorktreeChecks();
    /** Where the open turn worked (reach): only a worktree it reached can be one it worked in. */
    private reached = new Set<string>();
    /** The tree of what's in the private index, while nothing has gone wrong with it. */
    private lastTree: string | undefined;
    /** The last capture's lists and what it found at each path (stat-files.ts), with what it left out. */
    private scan?: { trackedId: string; untracked: string[]; kinds: Uint8Array; stamps: Float64Array; recheck: number[]; skipped: Record<string, string>; skippedStamps?: Record<string, string> };
    /** The folder's watch, and when one was last asked for. */
    private watch?: FolderWatch;
    private watchTried = 0;
    /** The last whole capture and the watch's count when it began (unchanged). */
    private lastFast?: { gen: number; at: number; result: TurnCapture };
    /** While a turn is open: undoes its listening to the watch for the trees to read ahead (warmTrees). */
    private stopWarming?: () => void;
    private warmTimer?: ReturnType<typeof setTimeout>;
    private warming = false;
    /** This session's reader of objects (readTree): kept between captures, while it's used. */
    /** changedPaths(), until a turn's added. */
    private changed?: string[];
    private reader?: { key: string; reader: ObjectReader; queue: Promise<unknown>; idle?: ReturnType<typeof setTimeout> };
    /** Captures taken from what `git status` said differs (captureFromStatus): for tests. */
    statusCount = 0;
    /**
     * The last capture from Git's index, whole or from what changed (captureNarrowed): the watch's count when it began,
     * the index it rested on, what differed from it, and this session's copy of the index as it left it.
     */
    /**
     * What the last capture from Git's index found (captureIndexed), for the next to look only at what the folder's
     * watch saw change since (captureNarrowed): what differed, what was gone, the tree, and what it rested on.
     */
    private indexedBase?: {
        watch: FolderWatch;
        gen: number;
        indexStamp: string;
        /** What Git's index recorded (index-scan.ts contentKey): rewritten without a change to it (git status refreshing its stat times, a commit), it's the same. */
        contentKey: string;
        /** The tree Git worked out for its index then (its cache-tree), when it had: a commit since is told apart by it. */
        cacheRoot?: string;
        ignoreKey: string;
        attributes: string[];
        differs: Map<string, Differs>;
        gone: Set<string>;
        tree: string;
        skipped: Record<string, string>;
        skippedStamps?: Record<string, string>;
        narrowed: number;
        fullAt: number;
        fullMs: number;
    };
    /** The last capture from Git's index (captureIndexed): what it rested on, and what it found. */
    /** Captures that looked only at what the folder's watch saw change (captureNarrowed): for tests. */
    narrowedCount = 0;
    /** A whole capture that went on past the turn it was taken for (capture): the next waits for it. */
    private whole?: Promise<void>;
    /** When unchanged last waited for the watch's events. */
    private settledAt = 0;
    private lastIndexed?: { key: string; tree?: string; skipped: Record<string, string>; skippedStamps?: Record<string, string> };
    /** The last capture's files in their folders, with each folder's tree id (treeObjects). */
    private folders?: Folder;

    /** Git's own index for this folder, as last read (fromIndex). */
    private index?: { stamp: string; parsed: GitIndex };
    private readonly storage: string;
    private readonly journal: string;

    constructor(readonly dir: string, readonly cwd: string, private options: { budgetMs?: number; maxStoreBytes?: number; /** NARROW_FROM_MS, for tests. */ narrowFromMs?: number; /** How long a turn waits for a capture, which goes on past it (capture): for tests. */ turnBudgetMs?: number; /** STATUS_FROM_ENTRIES, for tests. */ statusFromEntries?: number } = {}) {
        this.storage = join(dir, "turn-snapshots");
        this.journal = join(dir, "turn-snapshots.jsonl");
        let lines: string;
        try { lines = readFileSync(this.journal, "utf-8"); } catch { return; }
        // list()/changedPaths() are synchronous: validate against cwd's actual
        // repository before exposing any saved path, never against a journal-supplied cwd.
        this.root = topOf(cwd);
        if (!this.root) return;
        for (const line of lines.split("\n")) {
            try {
                const r = JSON.parse(line);
                if (!r || (r.version !== 1 && r.version !== 2) || !Number.isSafeInteger(r.id) || r.id <= 0 || typeof r.prompt !== "string" || !this.validTime(r.startedAt) || (r.endedAt !== undefined && !this.validTime(r.endedAt)) || !this.validCapture(r.start) || (r.end !== undefined && !this.validCapture(r.end))) continue;
                if ((r.end === undefined) !== (r.endedAt === undefined)) continue;
                if (r.changed !== undefined) {
                    if (!r.start.tree || !r.end?.tree || !Array.isArray(r.changed) || !r.changed.every((p: unknown) => typeof p === "string")) continue;
                    if (r.version === 1) {
                        // Read old absolute paths only when they are contained in this repository.
                        if (!r.start.root || !r.changed.every((p: string) => isAbsolute(p) && !p.split("/").includes(".."))) continue;
                        r.changed = r.changed.map((p: string) => relative(this.root!, p));
                    }
                    if (!r.changed.every(safePath)) continue;
                }
                // A record's places are shown as they are; ones that aren't well formed are let go, not the turn.
                if (r.places !== undefined && !validPlaces(r.places)) delete r.places;
                this.turns.set(r.id, { ...r, version: 2 });
            } catch { /* A crash may leave the last line torn. */ }
        }
        // Do not append onto a torn record after reopening.
        if (lines && !lines.endsWith("\n")) {
            try { appendFileSync(this.journal, "\n", { mode: 0o600 }); } catch { /* begin will report a write failure */ }
        }
    }

    static for(session: Session, cwd: string): TurnSnapshots | undefined {
        const history = FileHistory.for(session);
        if (!history) return undefined;
        // A reopened Session is a new owner. A late read from the released
        // owner must neither revive its recorder nor populate the new owner's cache.
        let sessions = instances.get(history);
        if (!sessions) instances.set(history, (sessions = new WeakMap()));
        let snapshots = sessions.get(session);
        if (!snapshots) sessions.set(session, (snapshots = new TurnSnapshots(history.dir, cwd)));
        return snapshots;
    }

    private validTime(value: unknown): boolean {
        return typeof value === "number" && Number.isFinite(value) && value >= 0;
    }

    private validCapture(c: TurnCapture): boolean {
        const paths = (value: unknown) => !!value && typeof value === "object" && !Array.isArray(value) && Object.entries(value).every(([path, text]) => safePath(path) && typeof text === "string");
        return !!c && typeof c.incomplete === "boolean" && this.validTime(c.durationMs) && (c.root === undefined || c.root === this.root) && (c.tree === undefined ? c.incomplete : (typeof c.tree === "string" && OID.test(c.tree) && c.root === this.root)) && Array.isArray(c.notes) && c.notes.every((note) => typeof note === "string") && paths(c.skipped) && (c.skippedStamps === undefined || paths(c.skippedStamps)) && (c.places === undefined || (!!c.places && typeof c.places === "object" && !Array.isArray(c.places) && Object.entries(c.places).every(([p, print]) => isAbsolute(p) && typeof print === "string")));
    }

    list(): SnapshotTurn[] {
        return [...this.turns.values()].sort((a, b) => a.id - b.id);
    }

    /** Every path a turn changed (worked out again only when a turn's been added: it's asked after every edit). */
    changedPaths(): string[] {
        this.changed ??= [...new Set(this.list().flatMap((t) => (t.changed ?? []).map((path) => join(t.start.root ?? this.cwd, path))))];
        return [...this.changed];
    }

    private ensure() {
        if (this.saved) return;
        for (const path of [dirname(this.dir), this.dir, this.storage, join(this.storage, "objects")]) {
            mkdirSync(path, { recursive: true, mode: 0o700 });
            chmodSync(path, 0o700);
        }
        this.saved = true;
    }

    private persist(turn: SnapshotTurn) {
        this.turns.set(turn.id, turn);
        this.changed = undefined;
        try {
            this.ensure();
            appendFileSync(this.journal, JSON.stringify(turn) + "\n", { mode: 0o600 });
            chmodSync(this.journal, 0o600);
        } catch {
            this.failure = "Snapshot history could not be saved and may be lost when the session closes.";
        }
    }

    private env(): Record<string, string> {
        return { GIT_NO_REPLACE_OBJECTS: "1", GIT_INDEX_FILE: join(this.storage, "index"), GIT_OBJECT_DIRECTORY: join(this.storage, "objects") };
    }

    /** The ordinary runner clears inherited repository variables before applying these. */
    private run(args: string[], deadline: number, input?: string) {
        return git(this.root ?? this.cwd, ["-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", "-c", "core.sharedRepository=0600", ...args], { privateEnv: this.env(), input, deadline });
    }

    /**
     * The open turn worked at `paths` (absolute): the folder its agent works in, the files and folders its tool calls
     * name. A nearby worktree that changed while it ran is one it worked in only if it reached it: another session, or
     * the user, can be working there meanwhile. Taken as the turn ends, when it's asked to (end, begin), whatever
     * capture is still queued then.
     */
    reach(paths: Iterable<string>) {
        for (const p of paths) if (isAbsolute(p) && this.reached.size < MAX_REACHED) this.reached.add(p);
    }

    /** What the open turn reached, from now on the next one's. */
    private takeReached(): Set<string> {
        const was = this.reached;
        this.reached = new Set();
        return was;
    }

    /** A steering boundary is both the preceding turn's end and the next one's start. */
    begin(id: number, prompt: string): Promise<void> {
        const reached = this.takeReached();
        return this.record(async () => {
            if (this.stopped) return;
            await this.open(id, prompt, await this.marks(await this.capture(false, reached.size === 0), reached));
        });
    }

    /**
     * The capture `begin` would take, without starting anything: the turn that's open stays open. For a
     * prompt that may yet not go (its CLI could stop first); `beginWith` starts its turn from it once it goes.
     */
    prepare(): Promise<TurnCapture | undefined> {
        let captured: TurnCapture | undefined;
        // The open turn goes on if the prompt doesn't: what it reached stays its own.
        const reached = new Set(this.reached);
        return this.record(async () => {
            if (!this.stopped) captured = await this.marks(await this.capture(false, reached.size === 0), reached);
        }).then(() => captured);
    }

    /** As `begin`, from what `prepare` captured. */
    beginWith(id: number, prompt: string, captured: TurnCapture | undefined): Promise<void> {
        this.takeReached();
        return this.record(() => this.open(id, prompt, captured));
    }

    private async open(id: number, prompt: string, captured: TurnCapture | undefined) {
        if (!captured || this.stopped) return; // Not a repository, or this session was let go.
        if (this.active) await this.finish(this.close(structuredClone(captured)));
        if (this.stopped) return;
        // What the turn before worked in is that turn's, not part of this one's start.
        delete captured.worked;
        this.active = { version: 2, id, prompt: redact(prompt).slice(0, 2000), startedAt: Date.now(), start: captured };
        this.persist(this.active);
        this.listenForWarming();
    }

    /** Once the captures asked for so far are in (a turn's end goes on after the turn). */
    async settled(): Promise<void> {
        // A turn's end queues its comparing as its capture ends: waited for too.
        for (let last = this.last; ; last = this.last) {
            await last;
            if (last === this.last) return;
        }
    }

    /**
     * The turn's end, captured; then compared with its start and kept. A next turn's start asked for meanwhile goes
     * before the comparing: that reads nothing of the worktree, and the next turn waits for what it's queued behind.
     */
    end(): Promise<void> {
        const reached = this.takeReached();
        let finished: Promise<void> | undefined;
        return this.record(async () => {
            if (!this.active || this.stopped) return;
            // No turn starts here: only the worktrees this one reached are looked at.
            const captured = await this.marks(await this.capture(true, reached.size === 0), reached, false);
            if (this.stopped) return;
            const ended = this.close(captured ?? { incomplete: true, notes: ["The repository is no longer available."], skipped: pathMap(), durationMs: 0 });
            // Queued now, before this resolves: settled() finds it.
            finished = this.record(() => this.finish(ended));
        }).then(() => finished);
    }

    /** Retire before releasing the session lock: no late end, or index writes alongside a reopened session. */
    async stop(): Promise<void> {
        this.stopped = true;
        this.active = undefined;
        this.stopWarming?.();
        this.stopWarming = undefined;
        clearTimeout(this.warmTimer);
        await Promise.allSettled([...this.pending]);
        if (this.reader) {
            clearTimeout(this.reader.idle);
            this.reader.reader.close();
            this.reader = undefined;
        }
        if (this.watch) releaseWatch(this.watch);
        this.watch = undefined;
    }

    /**
     * The last capture again, when nothing can have changed since: the turn wrote nothing (`quiet`: none of its tool
     * calls but read-only ones, nor a sub-agent's), and the folder's watch saw no change since that capture began. Events
     * arrive a moment after a change: a capture within a quarter of a second of the last isn't taken for one.
     */
    private async unchanged(quiet: boolean, ending: boolean): Promise<TurnCapture | undefined> {
        const w = this.watch, last = this.lastFast;
        if (!quiet || !w?.healthy || !last || this.stopped) return undefined;
        // A turn's end waits a little longer (FSEvents, on a Mac, delivers later than inotify): no model waits on it.
        await new Promise((r) => setTimeout(r, eventWait(ending)));
        this.settledAt = Date.now();
        if (!w.healthy || w.gen !== last.gen || Date.now() - last.at < 250) return undefined;
        const out = structuredClone(last.result);
        out.durationMs = 0;
        delete out.places;
        delete out.since;
        delete out.worked;
        return out;
    }

    /** One after another, in the order they're asked for: a start not awaited still lands before the next end. */
    private record(work: () => Promise<void>): Promise<void> {
        const pending = this.last.then(work);
        this.last = pending.catch(() => undefined);
        this.pending.add(pending);
        return pending.finally(() => { this.pending.delete(pending); });
    }

    /** The open turn, ended at `captured`: no longer the one that's open, compared and kept by `finish`. */
    private close(captured: TurnCapture): SnapshotTurn {
        this.stopWarming?.();
        this.stopWarming = undefined;
        clearTimeout(this.warmTimer);
        const turn: SnapshotTurn = { ...this.active!, end: captured, endedAt: Date.now() };
        this.active = undefined;
        return turn;
    }

    private async finish(turn: SnapshotTurn) {
        const captured = turn.end!;
        if (this.stopped) return;
        let changes: Change[] | undefined;
        /** The trees on the way to what changed, both sides: needed to show it, so kept too. */
        const trees = new Set<string>();
        try {
            changes = await this.compare(turn, Date.now() + 2000, trees);
            turn.changed = changes.map((c) => c.path);
        } catch {
            captured.incomplete = true;
            captured.notes.push("The snapshot comparison is unavailable; some objects may be missing.");
        }
        if (changes?.length) {
            try {
                await this.keep(changes, turn.start.root ?? this.root ?? this.cwd, Date.now() + END_BUDGET_MS, [...trees, turn.start.tree, turn.end?.tree].filter((t): t is string => !!t));
            } catch (e) {
                captured.incomplete = true;
                captured.notes.push((e as Error).message);
            }
        }
        // The other worktrees it worked in, summed up when its end was captured (marks).
        if (captured.worked?.length) turn.places = captured.worked;
        delete captured.worked;
        if (!this.stopped) this.persist(turn);
    }

    /**
     * What a turn changed, before and after, as this session's own objects. Files Git's index had as they were were
     * taken from the repository's objects (fromIndex): the ones the turn changed are copied in now, while the
     * repository still has them, so its diff doesn't depend on them later.
     */
    private async keep(changes: Change[], root: string, deadline: number, trees: string[] = []) {
        const borrowed = new Set<string>();
        const mine = (oid: string) => this.stored.has(oid) || this.unwritten.has(oid) || !!this.pack?.oids.has(oid);
        for (const c of changes) for (const e of [c.old, c.now]) if (e && e.mode !== "160000" && !mine(e.oid)) borrowed.add(e.oid);
        for (const t of trees) if (!mine(t)) borrowed.add(t);
        if (!borrowed.size) return;
        let missing = 0;
        let take = [...borrowed];
        // Many: one pack made by git from the repository's own objects, checked as it's indexed (a turn that changed
        // 12,000 files: three processes, not one read for every few files). Up to the size a file is read to (a bigger
        // one was only ever taken from the index, and isn't shown as a diff).
        if (borrowed.size > PACK_KEEP_FROM) {
            const sized = await git(root, ["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], { input: take.join("\n") + "\n", deadline, privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } });
            const found = new Set<string>();
            take = [];
            for (const line of sized.out.toString().split("\n")) {
                const [oid, type, size] = line.split(" ");
                if (!oid || (type !== "blob" && type !== "tree") || !borrowed.has(oid)) continue;
                found.add(oid);
                if (type === "tree" || Number(size) <= MAX_SNAPSHOT_BYTES) take.push(oid);
            }
            missing = borrowed.size - found.size;
            if (!take.length || (await this.packFrom(root, take, deadline).then(() => true, () => false))) {
                if (missing) throw new Error(`${missing} of this turn's file versions could not be kept; their diffs may be unavailable.`);
                return;
            }
        }
        // Else read and stored here, a batch at a time.
        const wanted = new Map(take.map((oid) => [oid, 0]));
        // A batch at a time, each well within what one read takes.
        const batches: string[][] = [[]];
        for (const [oid] of wanted) {
            if (batches.at(-1)!.length >= 64) batches.push([]);
            batches.at(-1)!.push(oid);
        }
        try {
            for (const batch of batches) {
                // Trees read on the way to what changed are known already; the rest from this session's reader.
                const found = new Map<string, { type: string; buf: Buffer }>();
                const ask: string[] = [];
                for (const oid of batch) {
                    const tree = treeBodies.get(oid);
                    if (tree) found.set(oid, { type: "tree", buf: tree });
                    else ask.push(oid);
                }
                if (ask.length) for (const [oid, o] of await this.withReader(root, deadline, (r) => r.readAll(ask))) found.set(oid, o);
                for (const oid of batch) {
                    const o = found.get(oid), type = o?.type;
                    // Its bytes, whatever the repository holds under that name.
                    if (!o || (type !== "blob" && type !== "tree") || objectId(type, o.buf, this.algo) !== oid) { missing++; continue; }
                    if (type === "blob" && o.buf.length > MAX_SNAPSHOT_BYTES) continue;
                    await this.store(o.buf, type, oid);
                }
            }
        } finally {
            await this.writeOut();
        }
        if (missing) throw new Error(`${missing} of this turn's file versions could not be kept; their diffs may be unavailable.`);
    }

    /**
     * `oids` from the repository's objects into this session's own, as one pack: `git pack-objects` writes it (no delta
     * search: it's done once), `index-pack` checks every object against its id as it indexes it, and its bytes count
     * toward the quota. Throws, leaving nothing behind, when any of that fails.
     */
    private async packFrom(root: string, oids: string[], deadline: number) {
        const folder = join(this.storage, "objects", "pack");
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await chmod(folder, 0o700);
        const tmp = join(folder, `keep-${randomBytes(6).toString("hex")}`);
        const tmpPack = `${tmp}.pack.tmp`, tmpIndex = `${tmp}.idx.tmp`;
        let reserved = 0;
        try {
            const proc = Bun.spawn(gitArgv(["-c", "pack.writeReverseIndex=false", "pack-objects", "-q", "--stdout", "--window=0", "--depth=0"]), {
                cwd: root, env: gitEnvironment({ privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } }), stdin: new TextEncoder().encode(oids.join("\n") + "\n"), stdout: Bun.file(tmpPack), stderr: "ignore",
            });
            const timer = setTimeout(() => proc.kill(), Math.max(0, deadline - Date.now()));
            const code = await proc.exited.finally(() => clearTimeout(timer));
            if (code !== 0) throw new Error("git pack-objects failed");
            await chmod(tmpPack, 0o600);
            const { size } = await lstat(tmpPack);
            const hashBytes = this.algo === "sha1" ? 20 : 32;
            const bytes = size + oids.length * (hashBytes + 8) + 8 + 256 * 4 + 2 * hashBytes;
            this.reserve(bytes);
            reserved = bytes;
            const made = await this.run(["-c", "pack.writeReverseIndex=false", "index-pack", "--index-version=2", "-o", tmpIndex, tmpPack], deadline);
            if (made.code) throw new Error("Could not index the kept versions' pack.");
            const name = join(folder, `pack-${made.out.toString().trim().split(/\s+/).pop()}`);
            await chmod(tmpIndex, 0o600);
            await rename(tmpPack, `${name}.pack`);
            await rename(tmpIndex, `${name}.idx`);
        } catch (e) {
            await rm(tmpPack, { force: true }).catch(() => {});
            await rm(tmpIndex, { force: true }).catch(() => {});
            this.objectBytes! -= reserved;
            throw e;
        }
        for (const oid of oids) this.stored.set(oid, "pack");
    }

    /**
     * Each nearby worktree's token (turn-places.ts: HEAD, branch, what's staged), and the time on the file system's
     * clock; and, at the end of a turn that's open, the ones it worked in (reached, and new, or changed since it
     * began), summed up now: at a steering boundary the next turn may already be under way by the time this one is
     * finished, and what it does isn't this one's. Only reached worktrees can be worked in, so only they have their
     * files looked at, and an end no turn starts from (`whole` false) takes tokens of only those. Not when either end
     * went unmarked.
     */
    private async marks(captured: TurnCapture | undefined, reached: ReadonlySet<string> = new Set(), whole = true): Promise<TurnCapture | undefined> {
        if (!captured?.root || this.stopped || !this.worktreesListed) return captured;
        const deadline = Date.now() + 1500;
        // First: whatever changes after this counts as after it.
        const since = await this.clock();
        const root = captured.root;
        // At a turn's start, only that they're there: whether one moved is told at the end, for those it reached, by
        // when their files were written (movedSince). Many sessions in many worktrees of one repository would otherwise
        // each check and read every worktree at every turn's start. Checked and read now: the ones the turn that ends
        // here reached, and all of them when the clock couldn't be read.
        const lazy = whole && since !== undefined;
        const start = this.active?.start;
        const listed = this.worktrees;
        const reachedOnes = start && reached.size ? reachedPlaces(listed, [root, ...listed.map((w) => w.path)], reached) : [];
        // Only folders that really are those worktrees are read (one swapped for a link isn't); the rest go unmarked.
        const verify = (ws: readonly Worktree[]) => eachLimited(ws, 4, (w) => this.checks.check(root, w)).then((all) => all.filter((w): w is Checked => w !== undefined));
        const candidates = await verify(reachedOnes);
        const marked: Worktree[] = whole ? (lazy ? listed : await verify(listed)) : candidates;
        const byPath = new Map(candidates.map((w) => [w.path, w]));
        const tokens = await eachLimited(marked, 4, (w) => {
            const c = byPath.get(w.path) ?? (lazy ? undefined : (w as Checked));
            return c ? token(c, deadline) : Promise.resolve(THERE);
        });
        const after = Object.fromEntries(marked.map((w, i) => [w.path, tokens[i]!]));
        captured.places = after;
        if (since !== undefined) captured.since = String(since);
        const before = start?.places;
        if (before && !this.stopped) {
            const from = start.since !== undefined && /^\d+$/.test(start.since) ? BigInt(start.since) : undefined;
            // New since it began, or its HEAD, branch or staging moved; else any of its files changed since.
            const changed = await eachLimited(candidates, 4, async (w) => {
                const was = before[w.path], now = after[w.path];
                if (was === UNKNOWN || now === UNKNOWN) return false;
                if (was === undefined) return true;
                if (was === THERE || now === THERE) {
                    if (from === undefined) return false;
                    if ((await movedSince(w, from)) === true) return true;
                } else if (was !== now) return true;
                return from !== undefined && (await changedSince(w, from, deadline)) === true;
            });
            const worked = candidates.filter((_, i) => changed[i]);
            if (worked.length) {
                const until = Date.now() + 3000;
                captured.worked = await eachLimited(worked, 4, (w) => summarize(w, until));
            }
        }
        return captured;
    }

    /** Now, on the file system's clock (a file's ctime just written), in nanoseconds: what changes after it is newer. */
    private async clock(): Promise<bigint | undefined> {
        try {
            this.ensure();
            const at = join(this.storage, "clock");
            // At once: on a busy machine each wait for the event loop's turn is what a turn's start costs.
            writeFileSync(at, "", { mode: 0o600 });
            return lstatSync(at, { bigint: true }).ctimeNs;
        } catch {
            return undefined;
        }
    }

    /** Scan once on reopen; failed captures' objects and temporary files count too. */
    private async measureStore(inTime: () => void) {
        if (this.objectBytes !== undefined) return;
        let bytes = 0;
        const stored = new Map<string, "loose" | "pack">();
        const objects = join(this.storage, "objects");
        const walk = async (dir: string) => {
            const names = await readdir(dir);
            inTime();
            const stats = await Promise.all(names.map((name) => lstat(join(dir, name))));
            for (let i = 0; i < names.length; i++) {
                const name = names[i]!, path = join(dir, name), st = stats[i]!;
                if (st.isDirectory()) { await walk(path); continue; }
                bytes += st.size;
                if (!st.isFile()) continue;
                if (dir !== objects && /^[0-9a-f]{2}$/.test(basename(dir)) && /^[0-9a-f]+$/.test(name)) stored.set(basename(dir) + name, "loose");
                // A pack counts once both of its files are there.
                if (basename(dir) === "pack" && name.endsWith(".idx") && names.includes(`${name.slice(0, -4)}.pack`)) {
                    for (const oid of packIndexOids(await readFile(path), this.algo === "sha1" ? 20 : 32)) stored.set(oid, "pack");
                }
            }
        };
        await walk(objects);
        inTime();
        this.objectBytes = bytes;
        this.stored = stored;
    }

    private async store(buf: Buffer, type: "blob" | "tree" = "blob", oid = blobId(buf, this.algo)): Promise<string> {
        const kept = this.stored.get(oid);
        if (kept) {
            const folder = join(this.storage, "objects", oid.slice(0, 2));
            const path = join(folder, oid.slice(2));
            if (kept === "loose" && !this.hardened.has(path)) {
                await chmod(folder, 0o700);
                await chmod(path, 0o600);
                this.hardened.add(path);
            }
            return oid;
        }
        if (this.unwritten.has(oid) || this.pack?.oids.has(oid)) return oid;
        // No Git filters or EOL conversion: precisely the object format used
        // by hash-object --no-filters, with a bounded read of the source file.
        this.unwritten.set(oid, { type, raw: buf });
        this.unwrittenBytes += buf.length;
        if (this.pack || this.unwritten.size >= PACK_FROM_OBJECTS || this.unwrittenBytes >= PACK_FROM_BYTES) this.intoPack();
        return oid;
    }

    private reserve(bytes: number) {
        const limit = this.options.maxStoreBytes ?? MAX_SNAPSHOT_STORE_BYTES;
        if (this.objectBytes! + bytes > limit) throw new Error("Snapshot storage limit reached (256 MiB per session by default).");
        this.objectBytes! += bytes;
    }

    /** What's waiting goes into the pack being made. */
    private intoPack() {
        // On disk it's this and its index: a line there for each object, and what each of the two has anyway.
        const hashBytes = this.algo === "sha1" ? 20 : 32;
        const whole = 12 + hashBytes + 8 + 256 * 4 + 2 * hashBytes;
        if (!this.pack) {
            this.reserve(whole);
            this.pack = { chunks: [], bytes: whole, oids: new Set() };
        }
        const pack = this.pack;
        for (const [oid, { type, raw }] of this.unwritten) {
            const entry = packEntry(type, raw);
            const size = entry[0]!.length + entry[1]!.length;
            this.reserve(size + hashBytes + 8);
            pack.chunks.push(...entry);
            pack.bytes += size + hashBytes + 8;
            pack.oids.add(oid);
            this.unwritten.delete(oid);
        }
        this.unwrittenBytes = 0;
    }

    /** Puts the pack in the object folder with its index, for git to find. */
    private async finishPack() {
        const pack = this.pack;
        this.pack = undefined;
        if (!pack) return;
        if (!pack.oids.size) { this.objectBytes! -= pack.bytes; return; }
        const header = Buffer.alloc(12);
        header.write("PACK");
        header.writeUInt32BE(2, 4);
        header.writeUInt32BE(pack.oids.size, 8);
        const hash = new Bun.CryptoHasher(this.algo);
        hash.update(header);
        for (const chunk of pack.chunks) hash.update(chunk);
        const digest = hash.digest() as Buffer;
        const folder = join(this.storage, "objects", "pack");
        const name = join(folder, `pack-${digest.toString("hex")}`);
        const tmp = `${name}.${randomBytes(4).toString("hex")}`;
        const tmpPack = `${tmp}.pack.tmp`, tmpIndex = `${tmp}.idx.tmp`;
        try {
            await mkdir(folder, { recursive: true, mode: 0o700 });
            await chmod(folder, 0o700);
            await writeFile(tmpPack, Buffer.concat([header, ...pack.chunks, digest]), { mode: 0o600 });
            // Its own deadline: what's read so far is worth keeping when the capture has run out of time.
            const made = await this.run(["-c", "pack.writeReverseIndex=false", "index-pack", "--index-version=2", "-o", tmpIndex, tmpPack], Date.now() + 10_000);
            if (made.code) throw new Error("Could not index the private snapshot pack.");
            // Git writes an index in place and leaves it readable by all: it gets its name whole and private, and last, since it's what says there's a pack.
            await chmod(tmpIndex, 0o600);
            await rename(tmpPack, `${name}.pack`);
            await rename(tmpIndex, `${name}.idx`);
        } catch (e) {
            await rm(tmpPack, { force: true }).catch(() => {});
            await rm(tmpIndex, { force: true }).catch(() => {});
            await rm(`${name}.pack`, { force: true }).catch(() => {});
            this.objectBytes! -= pack.bytes;
            throw e;
        }
        for (const oid of pack.oids) this.stored.set(oid, "pack");
    }

    private async writeLoose(oid: string, type: string, raw: Buffer) {
        const folder = join(this.storage, "objects", oid.slice(0, 2));
        const path = join(folder, oid.slice(2));
        const compressed = deflateSync(Buffer.concat([Buffer.from(`${type} ${raw.length}\0`), raw]), { level: 1 });
        this.reserve(compressed.length);
        const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
        if (compressed.length <= AT_ONCE_BYTES) {
            try {
                mkdirSync(folder, { recursive: true, mode: 0o700 });
                chmodSync(folder, 0o700);
                writeFileSync(tmp, compressed, { mode: 0o600 });
                renameSync(tmp, path);
            } catch (e) {
                try { rmSync(tmp, { force: true }); this.objectBytes! -= compressed.length; } catch {}
                throw e;
            }
            this.stored.set(oid, "loose");
            this.hardened.add(path);
            return;
        }
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await chmod(folder, 0o700);
        try {
            await writeFile(tmp, compressed, { mode: 0o600 });
            await rename(tmp, path);
        } catch (e) {
            // Only this unpublished temporary file is safe to remove without
            // tracing every retained tree. Keep its reservation if removal fails.
            await rm(tmp, { force: true }).then(() => { this.objectBytes! -= compressed.length; }).catch(() => {});
            throw e;
        }
        this.stored.set(oid, "loose");
        this.hardened.add(path);
    }

    /** Everything new, on disk: as a pack if it came to one, each in its own file if it's only a few. What's left over is let go. */
    private async writeOut() {
        try {
            if (this.pack) {
                // Over the limit partway: what fitted is kept, as it would be in files of their own.
                let over: unknown;
                try { this.intoPack(); } catch (e) { over = e; }
                await this.finishPack();
                if (over) throw over;
            }
            for (const [oid, { type, raw }] of this.unwritten) {
                await this.writeLoose(oid, type, raw);
                this.unwritten.delete(oid);
            }
        } finally {
            this.unwritten.clear();
            this.unwrittenBytes = 0;
        }
    }

    private async harden(trees: Set<string>) {
        await chmod(join(this.storage, "index"), 0o600).catch(() => {});
        for (const oid of trees) {
            // In a pack: private already (finishPack), and there's no file of its own to look for.
            if (this.stored.get(oid) === "pack") continue;
            const folder = join(this.storage, "objects", oid.slice(0, 2));
            const abs = join(folder, oid.slice(2));
            if (this.hardened.has(abs)) continue;
            try {
                await chmod(folder, 0o700);
                await chmod(abs, 0o600);
                this.hardened.add(abs);
            } catch (e) {
                // Git may have timed out before creating this planned tree.
                if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
            }
        }
    }

    /** `where`, while what decides it is as it was: no folder on the way has gained or lost a .git, and none was replaced. */
    private located(): Located | undefined {
        const w = locations.get(this.cwd);
        if (!w) return undefined;
        for (let i = 0; i < w.paths.length; i++) if (stampAt(w.paths[i]!) !== w.stamps[i]) return void locations.delete(this.cwd);
        return w;
    }

    /**
     * Notes where git found the repository, with the stamps that would show it's moved: the folders from this one up
     * to its top (one becoming a repository of its own, or replaced) and what's at each one's .git. The index is where
     * the top's .git says (a folder: in it; a file: in the folder it names), as git finds it; asked of git otherwise.
     */
    private locate(root: string, algo: "sha1" | "sha256") {
        const paths: string[] = [];
        for (let dir = resolve(this.cwd); ; dir = dirname(dir)) {
            paths.push(dir, join(dir, ".git"));
            if (dir === root || dirname(dir) === dir || !dir.startsWith(root)) break;
        }
        let index: string | undefined;
        try {
            const dotGit = lstatSync(join(root, ".git"));
            if (dotGit.isDirectory()) index = join(root, ".git", "index");
            else if (dotGit.isFile()) {
                const named = /^gitdir: (.+)\n?$/.exec(readFileSync(join(root, ".git"), "utf-8"))?.[1];
                if (named) index = join(resolve(root, named), "index");
            }
        } catch {
            index = undefined;
        }
        const where: Located = { root, algo, index, paths, stamps: paths.map(stampAt) };
        if (locations.size >= 256) locations.delete(locations.keys().next().value!);
        locations.set(this.cwd, where);
        return where;
    }

    /**
     * Of `paths` (files as Git's index has them), the ones Git stores as they are: no attribute converts them
     * (check-attr) and core.autocrlf doesn't; in a partial clone, only ones whose objects are there (asked of the
     * index's entries in the capture, `blobs`). A chunk at a time, each kept as it's known (storedAsIsIn), so a
     * first capture of a large repository that runs out of time leaves the next one less to do.
     */
    private async storedAsIs(paths: string[], deadline: number, oids?: Map<string, string>): Promise<Set<string>> {
        const out = new Set<string>();
        const env = { GIT_NO_REPLACE_OBJECTS: "1" };
        const config = await git(this.root!, ["config", "-z", "--get-regexp", "^(core\\.autocrlf|extensions\\.partialclone)$"], { deadline, privateEnv: env });
        // Exit 1: neither is set.
        if (config.code > 1 || config.cut) return out;
        const set = new Map(config.out.toString("utf-8").split("\0").filter(Boolean).map((rec) => {
            const nl = rec.indexOf("\n");
            return [rec.slice(0, nl < 0 ? rec.length : nl).toLowerCase(), nl < 0 ? "" : rec.slice(nl + 1).trim().toLowerCase()] as const;
        }));
        // Any autocrlf but false converts some text files (true, input), and which can't be told from the index.
        const crlf = set.get("core.autocrlf");
        if (crlf !== undefined && !["false", "no", "off", "0", ""].includes(crlf)) return out;
        const partial = set.has("extensions.partialclone");
        for (let at = 0; at < paths.length; at += INDEX_CHUNK) {
            if (Date.now() >= deadline) throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
            const chunk = paths.slice(at, at + INDEX_CHUNK);
            const [attrs, present] = await Promise.all([
                git(this.root!, ["check-attr", "-z", "--stdin", "--all"], { input: chunk.join("\0") + "\0", deadline, privateEnv: env }),
                partial && oids ? git(this.root!, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: [...new Set(chunk.map((p) => oids.get(p)!))].join("\n") + "\n", deadline, privateEnv: env }) : undefined,
            ]);
            if (attrs.code || attrs.cut || present?.code || present?.cut) return out;
            const converted = new Set<string>();
            const fields = attrs.out.toString("utf-8").split("\0");
            for (let i = 0; i + 2 < fields.length; i += 3) if (CONVERTING.has(fields[i + 1]!) && fields[i + 2] !== "unset" && fields[i + 2] !== "unspecified") converted.add(fields[i]!);
            const there = present && new Set(present.out.toString().split("\n").filter((l) => l.endsWith(" blob")).map((l) => l.slice(0, l.indexOf(" "))));
            const known = storedAsIsIn(this.root!).paths;
            for (const p of chunk) {
                if (converted.has(p) || (there && oids && !there.has(oids.get(p)!))) continue;
                out.add(p);
                // True of the repository whatever becomes of this capture.
                known.add(p);
            }
        }
        return out;
    }

    /**
     * Of `files` (tracked, stat taken), those Git's index has as they are on disk, each with the blob it names: the
     * stat it recorded still matches (git-index.ts, to the nanosecond), no attribute or core.autocrlf makes Git store
     * anything but the file's bytes, and, in a partial clone, the object is there. The rest are read as any other file.
     */
    private async fromIndex(index: GitIndex, files: Seen[], deadline: number): Promise<Map<string, KnownFile>> {
        const out = new Map<string, KnownFile>();
        const env = { GIT_NO_REPLACE_OBJECTS: "1" };
        /** What the repository's config says about storing files as they are, once a file could be taken. */
        let config: Promise<{ converts: boolean; partial: boolean } | undefined> | undefined;
        const read = () => (config ??= git(this.root!, ["config", "-z", "--get-regexp", "^(core\\.autocrlf|extensions\\.partialclone)$"], { deadline, privateEnv: env }).then((r) => {
            // Exit 1: neither is set.
            if (r.code > 1 || r.cut) return undefined;
            const set = new Map(r.out.toString("utf-8").split("\0").filter(Boolean).map((rec) => {
                const nl = rec.indexOf("\n");
                return [rec.slice(0, nl < 0 ? rec.length : nl).toLowerCase(), nl < 0 ? "" : rec.slice(nl + 1).trim().toLowerCase()] as const;
            }));
            // Any autocrlf but false converts some text files (true, input), and which can't be told from the index.
            const crlf = set.get("core.autocrlf");
            return { converts: crlf !== undefined && !["false", "no", "off", "0", ""].includes(crlf), partial: set.has("extensions.partialclone") };
        }));
        // A chunk at a time, each kept as soon as it's known: a first capture of a large repository that runs out of
        // time leaves the next one less to do, rather than all of it again.
        const pace = new Pace();
        for (let at = 0; at < files.length && Date.now() < deadline; at += INDEX_CHUNK) {
            const clean: (Seen & { oid: string })[] = [];
            for (const f of files.slice(at, at + INDEX_CHUNK)) {
                if (pace.due) await pace.rest();
                let big;
                try { big = lstatSync(`${this.root}/${f.path}`, { bigint: true, throwIfNoEntry: false }); } catch { continue; }
                // The same file the scan saw (else it changed meanwhile, and is read), as the index recorded it.
                if (!big || Number(big.ino) !== f.st.ino || Number(big.size) !== f.st.size) continue;
                const oid = cleanBlob(index, f.path, big);
                if (oid) clean.push({ ...f, oid });
            }
            if (!clean.length) continue;
            const cfg = await read();
            if (!cfg || cfg.converts) return out;
            const [attrs, present] = await Promise.all([
                git(this.root!, ["check-attr", "-z", "--stdin", "--all"], { input: clean.map((f) => f.path).join("\0") + "\0", deadline, privateEnv: env }),
                cfg.partial ? git(this.root!, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], { input: [...new Set(clean.map((f) => f.oid))].join("\n") + "\n", deadline, privateEnv: env }) : undefined,
            ]);
            if (attrs.code || attrs.cut || present?.code || present?.cut) return out;
            const converted = new Set<string>();
            const fields = attrs.out.toString("utf-8").split("\0");
            for (let i = 0; i + 2 < fields.length; i += 3) if (CONVERTING.has(fields[i + 1]!) && fields[i + 2] !== "unset" && fields[i + 2] !== "unspecified") converted.add(fields[i]!);
            const there = present && new Set(present.out.toString().split("\n").filter((l) => l.endsWith(" blob")).map((l) => l.slice(0, l.indexOf(" "))));
            for (const f of clean) {
                if (converted.has(f.path) || (there && !there.has(f.oid))) continue;
                const mode = f.st.kind === KIND.link ? "120000" : f.st.mode & 0o100 ? "100755" : "100644";
                const file: KnownFile = { path: f.path, stamp: stampOf(f.st), entry: { mode, oid: f.oid, size: f.st.size }, borrowed: true };
                // True of the repository whatever becomes of this capture.
                this.known.set(f.path, file);
                out.set(f.path, file);
            }
        }
        return out;
    }

    /** The index at `path`, parsed again only when it's been rewritten. */
    private async readIndex(path: string): Promise<GitIndex | undefined> {
        const st = await lstat(path, { bigint: true }).catch(() => undefined);
        if (!st?.isFile()) return undefined;
        const stamp = `${path}\0${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}`;
        if (this.index?.stamp === stamp) return this.index.parsed;
        const buf = await readFile(path).catch(() => undefined);
        const parsed = buf && await parseIndex(buf, this.algo === "sha1" ? 20 : 32, st.mtimeNs);
        this.index = parsed ? { stamp, parsed } : undefined;
        return parsed;
    }

    /**
     * `ending`: a turn's end, which no model waits on, has longer (END_BUDGET_MS) than a start (2 s): a turn that
     * changed thousands of files is still read whole, rather than marked incomplete and its diff lost.
     */
    /**
     * A capture from the last one from Git's index (captureIndexed), looking only at the paths the folder's watch saw
     * change since (and what Git's index or that capture had under them): each stat'ed, the untracked ones asked of git
     * (ls-files, for what's ignored), what differs read, and the last tree edited along those paths (editTrees). False,
     * having changed nothing, wherever that can't be told for sure: Git's index records something else, an ignore or
     * attributes file or Git's config changed, the watch missed something or saw too much, or it's been a while
     * (NARROW_MAX, NARROW_FULL_EVERY_MS). The whole folder is looked at then.
     */
    private async captureNarrowed(result: TurnCapture, read: KnownFile[], indexPath: string, deadline: number, inTime: () => void, ending: boolean, given?: { paths: string[]; gen: number; dirty: ReadonlySet<string> }): Promise<boolean> {
        const base = this.indexedBase, w = this.watch, root = this.root!;
        if (!base || !w?.healthy || base.watch !== w || (!given && base.fullMs < (this.options.narrowFromMs ?? NARROW_FROM_MS))) return false;
        if (base.narrowed >= NARROW_MAX || Date.now() - base.fullAt > NARROW_FULL_EVERY_MS) return false;
        if (this.lastTree !== base.tree || !msTimesExact(indexPath)) return false;
        const stamped = lstatSync(indexPath, { throwIfNoEntry: false });
        if (!stamped) return false;
        // Git's index written since: still the base, if what it records is the same (scanIndexPaths says).
        const indexStamp = stampKey(stamped), rewritten = indexStamp !== base.indexStamp;
        if (ignoreKeyOf(root, indexPath) !== base.ignoreKey || (await this.converts(root, indexPath, base.attributes, deadline))) return false;
        // Events arrive a moment after a change (unchanged waits the same).
        if (Date.now() - this.settledAt > 10) await new Promise((r) => setTimeout(r, eventWait(ending)));
        inTime();
        if (!w.healthy) return false;
        // Given (a first capture from what `git status` said): as of when it began, so what changed since is looked at next.
        const gen = given ? given.gen : w.gen, genAt = Date.now();
        const seen = given ? given.paths : w.changedSince(base.gen);
        if (!seen || seen.length > NARROW_MAX_PATHS) return false;
        // What changes inside another worktree or a nested repository isn't captured here.
        const nested = new Set([...this.nested].map((p) => p.replace(/\/$/, "")));
        for (const d of base.differs.values()) if (d.kind === KIND.dir) nested.add(d.path.replace(/\/$/, ""));
        // A change inside a repository's Git dir is one of the folder holding it (a repository made, or changed, there).
        const changing = new Set<string>();
        for (const p of seen) {
            const at = p.endsWith("/.git") ? p.length - 5 : p.indexOf("/.git/");
            changing.add(at > 0 ? p.slice(0, at) : p);
        }
        const hashBytes = this.algo === "sha1" ? 20 : 32;
        // Git's index written since: what it records now. Something else (staged, committed), the paths whose entries
        // differ are looked at too, as the trees Git worked out for both say (their cache-trees); without both, everything.
        let contentKey = base.contentKey, cacheRoot = base.cacheRoot;
        /** Paths whose entries in Git's index changed: as the last tree has them, they're the old entries. */
        const moved = new Set<string>();
        /** What to look up in Git's index for `changed` (and what the last capture had under them). */
        const wantedFor = (changed: string[]) => {
            const changedSet = new Set(changed), wanted = new Set(changed);
            for (const p of [...base.differs.keys(), ...base.gone, ...Object.keys(base.skipped)]) if (underAny(p.replace(/\/$/, ""), changedSet)) wanted.add(p);
            return wanted;
        };
        /** Read with the index's new version: the lookup too, when what it records is the same (it was only refreshed). */
        let early: { wanted: Set<string>; scan: Awaited<ReturnType<typeof scanIndexPaths>> } | undefined;
        if (rewritten) {
            const guess = [...changing].filter((p) => !underAny(p, nested));
            const wanted = guess.reduce((n, p) => n + p.length + 1, 0) > NARROW_MAX_ARG_BYTES ? new Set<string>() : wantedFor(guess);
            const now = await scanIndexPaths(root, indexPath, hashBytes, [...wanted], true, deadline);
            early = { wanted, scan: now };
            if (now.unusable || !now.contentKey) return false;
            if (now.contentKey !== base.contentKey) {
                if (!base.cacheRoot || !now.cacheRoot) return false;
                const entries = await git(root, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", base.cacheRoot, now.cacheRoot], { maxBytes: 1024 * 1024, deadline, privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } });
                if (entries.code || entries.cut) return false;
                for (const p of entries.out.toString("utf-8").split("\0")) if (p) { changing.add(p); moved.add(p); }
                if (changing.size > NARROW_MAX_PATHS) return false;
            }
            contentKey = now.contentKey;
            cacheRoot = now.cacheRoot;
        }
        const changed = [...changing].filter((p) => !underAny(p, nested));
        // What's ignored or how files are stored may have changed for paths that didn't.
        if (changed.some((p) => /(^|\/)\.git(ignore|attributes)$/.test(p))) return false;
        if (!changed.length) {
            Object.assign(result.skipped, base.skipped);
            if (base.skippedStamps) result.skippedStamps = pathMap(base.skippedStamps);
            result.tree = base.tree;
            result.incomplete = Object.keys(result.skipped).length > 0;
            Object.assign(base, { gen, indexStamp, contentKey, cacheRoot });
            this.narrowedCount++;
            this.rememberFast(gen, genAt, result);
            return true;
        }
        if (changed.reduce((n, p) => n + p.length + 1, 0) > NARROW_MAX_ARG_BYTES) return false;
        // What the last capture had under a changed path (a folder moved away names only itself) is looked at again.
        const wanted = wantedFor(changed);
        // As Git's index has them, first: most turns only change files it tracks, and those need no listing.
        const first = early && !moved.size && sameSet(early.wanted, wanted) ? early.scan : await scanIndexPaths(root, indexPath, hashBytes, [...wanted], true, deadline);
        // Written again meanwhile: everything.
        if (first.unusable || first.contentKey !== contentKey) return false;
        let states = first.states;
        // Untracked, as git lists them (not ignored, and what's in a folder that appeared): asked only of paths the index
        // hasn't, or that are folders now. Only the outermost: git lists a nested repository as one (its folder) only when
        // not asked about what's in it.
        const ask = first.states.filter((st) => (st.unknown && st.kind !== KIND.missing) || st.kind === KIND.dir).map((st) => st.path.replace(/\/$/, ""));
        let listed = new Set<string>();
        if (ask.length) {
            const askSet = new Set(ask);
            const outermost = [...askSet].filter((p) => !underAny(p, askSet));
            if (outermost.reduce((n, p) => n + p.length + 1, 0) > NARROW_MAX_ARG_BYTES) return false;
            const others = await git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--", ...outermost], { maxBytes: 16 * 1024 * 1024, deadline, privateEnv: { GIT_NO_REPLACE_OBJECTS: "1", GIT_LITERAL_PATHSPECS: "1" } });
            if (others.code || others.cut || others.err.trim()) return false;
            listed = new Set(others.out.toString("utf-8").split("\0").filter(Boolean));
            if (listed.size > NARROW_MAX_PATHS) return false;
            const more = [...listed].filter((p) => !wanted.has(p));
            if (more.length) {
                const second = await scanIndexPaths(root, indexPath, hashBytes, more, true, deadline);
                if (second.unusable || second.contentKey !== contentKey) return false;
                states = [...states, ...second.states];
            }
        }
        inTime();
        const differs = new Map(base.differs), gone = new Set(base.gone);
        const skipped = pathMap(base.skipped), skippedStamps = base.skippedStamps && pathMap(base.skippedStamps);
        const now: Differs[] = [], out: string[] = [], restore: { path: string; mode: string; oid: string }[] = [];
        for (const st of states) {
            const path = st.path;
            // What the last tree has here is something else than Git's index has now: put in, or taken out, whatever it is.
            const was = differs.get(path) ?? moved.has(path), wasGone = gone.has(path), wasSkipped = path in skipped;
            differs.delete(path);
            gone.delete(path);
            delete skipped[path];
            if (skippedStamps) delete skippedStamps[path];
            const d: Differs = { path, tracked: st.tracked, kind: st.kind, stamp: st.stamp, ...(st.special ? { special: st.special } : {}) };
            if (st.tracked) {
                // As Git's index has it: its entry back, where the last capture had changed it. Not one `git status` says
                // differs, whatever its stat says (written within the index's own second, say).
                if (st.clean && !given?.dirty.has(path)) { if (was || wasGone || wasSkipped) restore.push({ path, ...st.clean }); continue; }
                if (st.kind === KIND.missing && !st.special) { gone.add(path); out.push(path); continue; }
                differs.set(path, d);
                now.push(d);
            } else if (st.kind !== KIND.missing && listed.has(path)) {
                differs.set(path, d);
                now.push(d);
            } else if (was && !path.endsWith("/")) {
                // Untracked and gone (or ignored now): out of this session's copy of the index.
                out.push(path);
            }
        }
        Object.assign(result.skipped, skipped);
        if (skippedStamps) result.skippedStamps = skippedStamps;
        const lines = await this.applyDiffers(now, out, result, read, inTime, restore);
        try {
            result.tree = lines.length ? await this.editTrees(root, base.tree, lines, deadline) : base.tree;
        } catch (e) {
            // The edits didn't fit the last tree: the whole capture instead, from nothing this one found.
            if (Date.now() >= deadline) throw e;
            for (const p of Object.keys(result.skipped)) delete result.skipped[p];
            delete result.skippedStamps;
            this.indexedBase = undefined;
            return false;
        }
        this.lastTree = result.tree;
        result.incomplete = Object.keys(result.skipped).length > 0;
        Object.assign(base, {
            gen,
            indexStamp,
            contentKey,
            cacheRoot,
            differs,
            gone,
            tree: result.tree!,
            skipped: pathMap(result.skipped),
            skippedStamps: result.skippedStamps && pathMap(result.skippedStamps),
            narrowed: base.narrowed + 1,
        });
        this.narrowedCount++;
        this.rememberFast(gen, genAt, result);
        return true;
    }

    /**
     * A capture from what `git status` says differs from Git's index, on the tree Git last worked out for the index (its
     * cache-tree): what a later capture does with the watch's paths (captureNarrowed), with git's list instead. `git status`
     * is a process of its own, as the agents' are (on a busy machine it isn't queued behind every session's work here),
     * and it compares a hundred thousand files in less CPU than a scan here does. False, having kept nothing, where it
     * can't say plainly what's on disk: an entry it reports otherwise (a conflict, a submodule, assume-unchanged,
     * skip-worktree, intent-to-add), no tree worked out for the index, the index written meanwhile, more than
     * NARROW_MAX_PATHS paths, or attributes that store other bytes than a file's. The whole capture is taken then.
     */
    private async captureFromStatus(result: TurnCapture, read: KnownFile[], indexPath: string, deadline: number, inTime: () => void, ending: boolean): Promise<boolean> {
        const w = this.watch, root = this.root!;
        if (!w?.healthy || !msTimesExact(indexPath)) return false;
        // A small repository's whole capture is quicker here than starting git for it.
        if ((await indexEntries(indexPath)) < (this.options.statusFromEntries ?? STATUS_FROM_ENTRIES)) return false;
        const before = lstatSync(indexPath, { throwIfNoEntry: false });
        if (!before) return false;
        const started = Date.now();
        // What changes from here on is looked at by the next capture.
        const gen = w.gen;
        const hashBytes = this.algo === "sha1" ? 20 : 32;
        const [status, scan] = await Promise.all([
            // Not writing the index (a refresh it would otherwise save), nor looking into submodules (none, below).
            git(root, ["--no-optional-locks", "status", "--porcelain=v2", "-z", "--untracked-files=all", "--no-renames", "--ignore-submodules=all"], { maxBytes: 16 * 1024 * 1024, deadline, privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } }),
            scanIndexPaths(root, indexPath, hashBytes, [], true, deadline).catch(() => undefined),
        ]);
        inTime();
        if (status.code || status.cut || status.err.trim() || !scan || scan.unusable || !scan.contentKey || !scan.cacheRoot || scan.specials !== 0) return false;
        const after = lstatSync(indexPath, { throwIfNoEntry: false });
        if (!after || stampKey(after) !== stampKey(before)) return false;
        const paths: string[] = [];
        const dirty = new Set<string>();
        for (const record of status.out.toString("utf-8").split("\0")) {
            if (!record) continue;
            // Untracked (a nested repository's folder ends in a slash).
            if (record.startsWith("? ")) paths.push(record.slice(2).replace(/\/$/, ""));
            else if (record.startsWith("1 ")) {
                // "1 XY sub mH mI mW hH hI path": only what differs on disk from the index (Y); staged alone, the index's tree has it.
                const fields = record.split(" ");
                if (fields.length < 9 || fields[1]!.length !== 2) return false;
                if (fields[1]![1] === ".") continue;
                const path = fields.slice(8).join(" ");
                paths.push(path);
                dirty.add(path);
            } else return false;
        }
        if (paths.length > NARROW_MAX_PATHS) return false;
        if (!treesFound.has(scan.cacheRoot)) {
            const check = await git(root, ["cat-file", "--batch-check=%(objecttype)"], { input: `${scan.cacheRoot}\n`, privateEnv: this.readEnv(), deadline });
            if (check.code || check.cut || check.out.toString().trim() !== "tree") return false;
            if (treesFound.size >= 64) treesFound.delete(treesFound.values().next().value!);
            treesFound.add(scan.cacheRoot);
        }
        const base: NonNullable<typeof this.indexedBase> = {
            watch: w,
            gen,
            indexStamp: stampKey(before),
            contentKey: scan.contentKey,
            cacheRoot: scan.cacheRoot,
            ignoreKey: ignoreKeyOf(root, indexPath),
            attributes: scan.attributes ?? [],
            differs: new Map(),
            gone: new Set(),
            tree: scan.cacheRoot,
            skipped: pathMap(),
            narrowed: 0,
            fullAt: Date.now(),
            fullMs: 0,
        };
        // Whatever this session's own index held is no base for the whole capture's next one (fromCacheTree).
        this.indexedBase = base;
        this.indexEntries = new Map();
        this.folders = undefined;
        this.scan = undefined;
        this.index = undefined;
        this.lastTree = scan.cacheRoot;
        if (await this.captureNarrowed(result, read, indexPath, deadline, inTime, ending, { paths, gen, dirty })) {
            Object.assign(base, { narrowed: 0, fullMs: Date.now() - started });
            this.statusCount++;
            return true;
        }
        this.indexedBase = undefined;
        this.lastTree = undefined;
        return false;
    }

    /**
     * What a capture that finds nothing changed takes again (unchanged): this one, as of `gen`, the watch's count when
     * it looked (`at`). A turn's start right after the last one's end, with nothing changed between, is that end.
     */
    private rememberFast(gen: number, at: number, result: TurnCapture) {
        this.lastFast = result.tree && !result.notes.length && this.watch?.healthy ? { gen, at, result: structuredClone(result) } : undefined;
    }

    /**
     * A capture from Git's index (index-scan.ts): the index's own file, copied, with what differs from it (read, as any
     * capture reads a file) put in; git works out the trees, reusing the repository's for what didn't change, and the new
     * ones are moved into this session's objects through the quota. Nothing changed since the last one: its tree again.
     * False, having changed nothing, where it can't be used (a split or sparse index; attributes or core.autocrlf that
     * store other bytes than a file's; stat times that can't be compared): the whole capture is taken instead.
     */
    private async captureIndexed(result: TurnCapture, read: KnownFile[], listed: Buffer, indexPath: string, deadline: number, inTime: () => void, gen: number, early?: { stamp: string; scan: Promise<IndexScan> }): Promise<boolean> {
        const root = this.root!;
        if (!msTimesExact(indexPath)) return false;
        const untracked = listed.toString("utf-8").split("\0").filter(Boolean);
        const hashBytes = this.algo === "sha1" ? 20 : 32;
        const stamped = await lstat(indexPath).catch(() => undefined);
        if (!stamped) return false;
        const indexStamp = stampKey(stamped);
        // Whatever the last one found, this looks at everything.
        this.indexedBase = undefined;
        let scan: IndexScan;
        if (early && early.stamp === indexStamp) {
            // Read alongside the listing, and not written since: the untracked files' stats to add.
            scan = await early.scan;
            if (!scan.unusable && untracked.length) {
                const { kinds, stamps } = await statFiles(root, "untracked", [], untracked, deadline, inTime);
                untracked.forEach((path, i) => {
                    if (kinds[i] === KIND.missing) return;
                    scan.differs.push({ path, tracked: false, kind: kinds[i]!, stamp: kinds[i] === KIND.unreadable ? [] : Array.from(stamps.subarray(i * 6, i * 6 + 6)) });
                });
            }
        } else scan = await scanIndexFiles(root, indexPath, hashBytes, untracked, true, deadline);
        if (scan.unusable) return false;
        inTime();
        if (await this.converts(root, indexPath, [...scan.attributes, ...untracked.filter((p) => p === ".gitattributes" || p.endsWith("/.gitattributes"))], deadline)) return false;
        // What differs is as it was at the last capture: so is the tree.
        const key = `${indexStamp}\0${scan.gone.join("\0")}\0${JSON.stringify(scan.differs)}`;
        const last = this.lastIndexed;
        if (last && last.key === key && this.lastTree === last.tree) {
            Object.assign(result.skipped, last.skipped);
            if (last.skippedStamps) result.skippedStamps = pathMap(last.skippedStamps);
            result.tree = last.tree;
            result.incomplete = Object.keys(result.skipped).length > 0;
            await this.rememberIndexed(root, indexPath, gen, indexStamp, scan, result);
            return true;
        }
        const lines = await this.applyDiffers(scan.differs, scan.gone, result, read, inTime);
        if (!(await this.fromCacheTree(root, scan, lines, result, deadline))) await this.writeTrees(indexPath, lines, true, result, deadline, inTime);
        this.lastIndexed = { key, tree: result.tree, skipped: pathMap(result.skipped), skippedStamps: result.skippedStamps && pathMap(result.skippedStamps) };
        await this.rememberIndexed(root, indexPath, gen, indexStamp, scan, result);
        return true;
    }

    /**
     * The tree from the one Git last worked out for its index (its cache-tree, valid after a checkout or a commit),
     * edited along what differs (editTrees): no copy of the index to write, and no trees but those to make. False when
     * there's none, or git doesn't have every tree it names: the trees are worked out from a copy of the index then.
     */
    private async fromCacheTree(root: string, scan: IndexScan, lines: string[], result: TurnCapture, deadline: number): Promise<boolean> {
        const cached = scan.cacheTree;
        if (!cached) return false;
        if (!treesFound.has(cached.root)) {
            const check = await git(root, ["cat-file", "--batch-check=%(objecttype)"], { input: cached.trees.map((t) => `${t}\n`).join(""), privateEnv: this.readEnv(), deadline });
            if (check.code || check.cut || check.out.toString().split("\n").filter(Boolean).some((t) => t !== "tree")) return false;
            if (treesFound.size >= 64) treesFound.delete(treesFound.values().next().value!);
            treesFound.add(cached.root);
        }
        let tree: string;
        try {
            tree = lines.length ? await this.editTrees(root, cached.root, lines, deadline) : cached.root;
        } catch (e) {
            if (Date.now() >= deadline) throw e;
            return false;
        }
        // Whatever this session's own index held is no base for the whole capture's next one.
        this.indexEntries = new Map();
        this.folders = undefined;
        this.scan = undefined;
        this.index = undefined;
        this.lastTree = result.tree = tree;
        result.incomplete = Object.keys(result.skipped).length > 0;
        return true;
    }

    /** What a capture from Git's index found, for the next to look only at what changed since (captureNarrowed). */
    private async rememberIndexed(root: string, indexPath: string, gen: number, indexStamp: string, scan: IndexScan, result: TurnCapture) {
        this.indexedBase = this.watch?.healthy && gen >= 0 && !result.notes.length && scan.contentKey
            ? {
                watch: this.watch,
                gen,
                indexStamp,
                contentKey: scan.contentKey,
                cacheRoot: scan.cacheTree?.root,
                ignoreKey: ignoreKeyOf(root, indexPath),
                attributes: scan.attributes,
                differs: new Map(scan.differs.map((d) => [d.path, d])),
                gone: new Set(scan.gone),
                tree: result.tree!,
                skipped: pathMap(result.skipped),
                skippedStamps: result.skippedStamps && pathMap(result.skippedStamps),
                narrowed: 0,
                fullAt: Date.now(),
                fullMs: 0,
            }
            : undefined;
    }

    /**
     * What differs from Git's index (index-scan.ts), as lines for `update-index --index-info` on a copy of it: each
     * file read and stored (or known by its stamp), each left out with its reason in `result.skipped`, each gone taken
     * out. `restore`: entries to put back as the index records them (a file that differed and no longer does).
     */
    private async applyDiffers(differs: readonly Differs[], gone: readonly string[], result: TurnCapture, read: KnownFile[], inTime: () => void, restore: { path: string; mode: string; oid: string }[] = []): Promise<string[]> {
        const root = this.root!;
        const zero = "0".repeat(this.algo === "sha1" ? 40 : 64);
        const lines: string[] = [];
        /** Out of the copy: with any stages a conflict left, and whatever Git kept aside for it. */
        const remove = (path: string, special?: string) => {
            if (special === "entry") for (const stage of [1, 2, 3]) lines.push(`0 ${zero} ${stage}\t${path}\0`);
            lines.push(`0 ${zero}\t${path}\0`);
        };
        const put = (path: string, e: { mode: string; oid: string }, special?: string) => {
            if (special === "entry") for (const stage of [1, 2, 3]) lines.push(`0 ${zero} ${stage}\t${path}\0`);
            lines.push(`${e.mode} ${e.oid}\t${path}\0`);
        };
        const skip = (path: string, st: FileStat | undefined, reason: string) => {
            result.skipped[path] = reason;
            if (st) (result.skippedStamps ??= pathMap())[path] = stampOf(st).join(":");
        };
        for (const r of restore) put(r.path, r);
        for (const g of gone) {
            if (!safePath(g)) throw new Error("A repository path cannot be safely captured.");
            remove(g);
        }
        const toRead: (Seen & { special?: string; tracked: boolean })[] = [];
        for (const [i, d] of differs.entries()) {
            const path = d.path;
            if (!safePath(path.replace(/\/$/, ""))) throw new Error("A repository path cannot be safely captured.");
            const st: FileStat | undefined = d.stamp.length ? { kind: d.kind, dev: d.stamp[0]!, ino: d.stamp[1]!, mode: d.stamp[2]!, size: d.stamp[3]!, mtimeMs: d.stamp[4]!, ctimeMs: d.stamp[5]! } : undefined;
            if (d.kind === KIND.unreadable) {
                result.skipped[path] = "Unreadable path; not captured, change unknown.";
                if (d.tracked) remove(path, d.special);
                continue;
            }
            if (d.kind === KIND.missing) { if (d.tracked) remove(path, d.special); continue; }
            if (d.special === "gitlink") {
                if (d.kind === KIND.dir) skip(path, st, "Submodule or nested repository contents are not captured.");
                remove(path);
                continue;
            }
            if (d.kind === KIND.dir) {
                // A tracked file replaced by a directory is deleted; its new untracked children are entries of their own.
                if (d.tracked) { remove(path, d.special); continue; }
                if (this.nested.has(path)) continue;
                skip(path, st, "Submodule or nested repository contents are not captured.");
                continue;
            }
            if (d.kind !== KIND.file && d.kind !== KIND.link) {
                skip(path, st, "Not a regular file.");
                if (d.tracked) remove(path, d.special);
                continue;
            }
            if (st!.size > MAX_SNAPSHOT_BYTES) {
                skip(path, st, "Over 10 MB; not captured, change unknown.");
                if (d.tracked) remove(path, d.special);
                continue;
            }
            const known = this.known.get(path);
            if (known && sameStamp(known.stamp, st!) && this.stored.has(known.entry.oid)) { put(path, known.entry, d.special); continue; }
            toRead.push({ path, st: st!, at: i, special: d.special, tracked: d.tracked });
        }
        for (let k = 0; k < toRead.length; k += READ_AT_ONCE) {
            const done = await Promise.allSettled(toRead.slice(k, k + READ_AT_ONCE).map(async ({ path, st, special, tracked }) => {
                const { buf, after } = await readChanged(join(root, path), st);
                if (!buf) { skip(path, st, "Unreadable, changed while being read, or over 10 MB; not captured."); if (tracked) remove(path, special); return; }
                inTime();
                if (!after || !sameStamp(stampOf(st), after)) { result.skipped[path] = "Changed while being read; not captured."; if (tracked) remove(path, special); return; }
                const mode = st.kind === KIND.link ? "120000" : st.mode & 0o100 ? "100755" : "100644", oid = blobId(buf, this.algo);
                const had = this.known.get(path);
                const same = had?.entry.oid === oid && had.entry.mode === mode && had.entry.size === buf.length;
                const file: KnownFile = same ? (sameStamp(had.stamp, st) ? had : { path: had.path, stamp: stampOf(st), entry: had.entry }) : { path, stamp: stampOf(st), entry: { mode, oid, size: buf.length } };
                await this.store(buf, "blob", file.entry.oid);
                read.push(file);
                put(path, file.entry, special);
            }));
            for (const d of done) if (d.status === "rejected") throw d.reason;
            if ((this.pack?.bytes ?? 0) >= PACK_MAX_BYTES) await this.finishPack();
        }
        return lines;
    }

    /**
     * `lines` into this session's copy of Git's index (made afresh from it first, with `fresh`), and the tree git works
     * out from it into `result`: what was read goes to disk with the trees git makes (adopt), in one pack when there are
     * many (git needs neither to work the trees out: --missing-ok).
     */
    private async writeTrees(indexPath: string, lines: string[], fresh: boolean, result: TurnCapture, deadline: number, inTime: () => void) {
        const root = this.root!;
        inTime();
        const index = join(this.storage, "index");
        if (fresh) {
            await copyFile(indexPath, index);
            await chmod(index, 0o600);
            // Whatever this session's own index held is gone: the whole capture starts afresh if it's taken next.
            this.indexEntries = new Map();
            this.folders = undefined;
            this.scan = undefined;
            this.index = undefined;
        }
        const made = join(this.storage, `trees-${randomBytes(6).toString("hex")}`);
        await mkdir(made, { mode: 0o700 });
        try {
            const env = { GIT_NO_REPLACE_OBJECTS: "1", GIT_INDEX_FILE: index, GIT_OBJECT_DIRECTORY: made, GIT_ALTERNATE_OBJECT_DIRECTORIES: [join(this.storage, "objects"), objectsOf(indexPath)].join(delimiter) };
            const config = ["-c", "core.hooksPath=/dev/null", "-c", "core.splitIndex=false", "-c", "core.sharedRepository=0600", "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false"];
            if (lines.length) {
                const update = await git(root, [...config, "update-index", "-z", "--index-info"], { input: lines.join(""), privateEnv: env, deadline });
                if (update.code || update.cut) throw new Error("Could not update the private snapshot index.");
            }
            const tree = await git(root, [...config, "write-tree", "--missing-ok"], { privateEnv: env, deadline });
            const oid = tree.out.toString().trim();
            if (tree.code || !OID.test(oid)) throw new Error("Could not write the private snapshot tree.");
            // The trees git made: this session's own objects, through the quota.
            await this.adopt(made);
            this.lastTree = oid;
            result.tree = oid;
        } finally {
            await rm(made, { recursive: true, force: true }).catch(() => {});
        }
        result.incomplete = Object.keys(result.skipped).length > 0;
    }

    /**
     * `base` with what `lines` (as for update-index --index-info) put in or take out: only the trees on the way to
     * those paths read (this session's objects or the repository's) and made again (tree-edit.ts), into this
     * session's objects through the quota.
     */
    private async editTrees(root: string, base: string, lines: string[], deadline: number): Promise<string> {
        const edits = new Map<string, TreeEdit>();
        for (const line of lines) {
            const tab = line.indexOf("\t");
            const meta = line.slice(0, tab).split(" "), path = line.slice(tab + 1, -1);
            // A conflict's other stages are the index's only.
            if (meta.length !== 2) continue;
            edits.set(path, meta[0] === "0" ? null : { mode: meta[0]!, oid: meta[1]! });
        }
        const tree = await editTree(base, edits, this.algo === "sha1" ? 20 : 32, (oid) => this.readTree(root, oid, deadline), async (body) => {
            const oid = objectId("tree", body, this.algo);
            await this.store(body, "tree", oid);
            rememberTree(oid, body);
            return oid;
        });
        await this.writeOut();
        return tree;
    }

    /**
     * The trees git wrote into `fresh`, into this session's objects the way any capture stores them (store: through
     * the quota, as one pack when there are many), each checked against its id.
     */
    private async adopt(fresh: string) {
        for (const dir of await readdir(fresh).catch(() => [] as string[])) {
            if (!/^[0-9a-f]{2}$/.test(dir)) continue;
            for (const name of await readdir(join(fresh, dir))) {
                const oid = dir + name;
                if (this.stored.has(oid)) continue;
                const raw = inflateSync(await readFile(join(fresh, dir, name)));
                const nul = raw.indexOf(0);
                const [type] = raw.toString("latin1", 0, nul).split(" ");
                const bytes = raw.subarray(nul + 1);
                if ((type !== "tree" && type !== "blob") || objectId(type, bytes, this.algo) !== oid) throw new Error("Could not write the private snapshot tree.");
                await this.store(Buffer.from(bytes), type, oid);
            }
        }
        await this.writeOut();
    }

    /**
     * Whether Git may store some file as other bytes than it holds (an attribute that converts, or core.autocrlf), so
     * that what its index records can't be taken for it: the attributes files (the repository's, its info/attributes, the
     * user's) are read for one; asked again only when one of them, or a config file, changes.
     */
    private async converts(root: string, indexPath: string, attributes: string[], deadline: number): Promise<boolean> {
        const home = process.env.HOME ?? "";
        const xdg = process.env.XDG_CONFIG_HOME || join(home, ".config");
        const common = commonDirOf(indexPath);
        const configs = [join(common, "config"), join(dirname(indexPath), "config.worktree"), join(home, ".gitconfig"), join(xdg, "git", "config"), "/etc/gitconfig"];
        const files = [...attributes.map((p) => join(root, p)), join(common, "info", "attributes"), join(xdg, "git", "attributes"), "/etc/gitattributes", "/usr/local/etc/gitattributes", "/opt/homebrew/etc/gitattributes"];
        const key = [...configs, ...files].map((f) => `${f}:${stampAt(f)}`).join("\0");
        const had = convertsByRoot.get(root);
        if (had?.key === key) return had.converts;
        let converts = false;
        let excludes: string | undefined;
        const config = await git(root, ["config", "-z", "--get-regexp", "^(core\\.autocrlf|core\\.attributesfile|core\\.excludesfile)$"], { deadline, privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } });
        if (config.code > 1 || config.cut) converts = true;
        for (const rec of config.out.toString("utf-8").split("\0").filter(Boolean)) {
            const nl = rec.indexOf("\n");
            const name = rec.slice(0, nl < 0 ? rec.length : nl).toLowerCase(), value = nl < 0 ? "" : rec.slice(nl + 1).trim();
            if (name === "core.autocrlf" && !["false", "no", "off", "0", ""].includes(value.toLowerCase())) converts = true;
            if (name === "core.attributesfile" && value) files.push(value.startsWith("~/") ? join(home, value.slice(2)) : value);
            if (name === "core.excludesfile" && value) excludes = value.startsWith("~/") ? join(home, value.slice(2)) : value;
        }
        for (const f of files) {
            if (converts) break;
            const text = await readFile(f, "utf-8").catch(() => "");
            for (const line of text.split("\n")) {
                const t = line.trim();
                if (!t || t.startsWith("#")) continue;
                // An attribute that converts, set (not unset with -, or ! for unspecified); or a macro defined with one.
                if (t.split(/\s+/).slice(1).some((tok) => !/^[-!]/.test(tok) && CONVERTING.has(tok.split("=")[0]!)) || (t.startsWith("[attr]") && /\b(text|eol|crlf|filter|ident|working-tree-encoding)\b/.test(t))) { converts = true; break; }
            }
        }
        if (convertsByRoot.size >= 256 && !convertsByRoot.has(root)) convertsByRoot.delete(convertsByRoot.keys().next().value!);
        convertsByRoot.set(root, { key, converts, excludes });
        return converts;
    }

    /**
     * The folder as it is now. A whole capture (no earlier one to look only at what changed since, captureNarrowed)
     * can take longer than a turn waits for one: a turn's own budget gone, it's given up for that turn (incomplete,
     * as one out of time is), but it goes on (up to WHOLE_BUDGET_MS) and the next one starts from it, rather than
     * looking at everything again and running out of time again. Captures wait for it; nothing else runs meanwhile.
     */
    private async capture(ending = false, quiet = false): Promise<TurnCapture | undefined> {
        const started = Date.now();
        const deadline = started + (this.options.budgetMs ?? this.options.turnBudgetMs ?? (ending ? END_BUDGET_MS : 2000));
        const late = (): TurnCapture => ({ incomplete: true, notes: ["Snapshot exceeded its time budget (2 seconds by default)."], skipped: pathMap(), durationMs: Date.now() - started, ...(this.root ? { root: this.root } : {}) });
        // One still going (a big repository on a busy machine): not waited for. A turn waiting the whole of its budget
        // for it, and the next turn for that, got no more than this.
        if (this.whole && !(await settlesBy(this.whole, Math.min(deadline, started + WHOLE_WAIT_MS)))) return late();
        if (this.indexedBase || this.options.budgetMs !== undefined) return this.captureBy(ending, quiet, deadline);
        const work = this.captureBy(ending, quiet, Math.max(deadline, started + WHOLE_BUDGET_MS));
        if (await settlesBy(work, deadline)) return work;
        const whole = (this.whole = work.then(() => undefined, () => undefined).finally(() => {
            if (this.whole === whole) this.whole = undefined;
        }));
        this.pending.add(whole);
        void whole.finally(() => this.pending.delete(whole));
        return late();
    }

    private async captureBy(ending: boolean, quiet: boolean, deadline: number): Promise<TurnCapture | undefined> {
        const same = await this.unchanged(quiet, ending);
        if (same) return same;
        let genAtStart: number | undefined;
        const started = Date.now();
        const result: TurnCapture = { incomplete: false, notes: [], skipped: pathMap(), durationMs: 0 };
        let plannedTrees = new Set<string>();
        let touched = false, planning = false, narrowed = false;
        /** What's been read; known once its objects are on disk. */
        const read: KnownFile[] = [];
        const inTime = () => {
            if (this.stopped) throw new Error("The snapshot session was closed.");
            if (Date.now() >= deadline) throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
        };
        try {
            inTime();
            const metadataEnv = { GIT_NO_REPLACE_OBJECTS: "1" };
            // The repository and its object format, as git last said, while nothing on the way to it has changed;
            // else asked again.
            let where = this.located();
            if (!where) {
                const top = await git(this.cwd, ["rev-parse", "--show-toplevel", "--show-object-format"], { deadline, privateEnv: metadataEnv });
                if (top.code !== 0) return undefined;
                // The format is the last line: a folder's name can hold a newline.
                const asked = top.out.toString().replace(/\n$/, "");
                const cut = asked.lastIndexOf("\n");
                where = this.locate(asked.slice(0, cut), asked.slice(cut + 1).trim() === "sha256" ? "sha256" : "sha1");
            }
            this.root = where.root;
            this.known = knownIn(this.root);
            // The folder's watch (folder-watch.ts): taken once, again a while after one fails.
            if (this.watch && (!this.watch.healthy || this.watch.root !== this.root)) { releaseWatch(this.watch); this.watch = undefined; }
            if (!this.watch && Date.now() - this.watchTried > 5 * 60_000) {
                this.watchTried = Date.now();
                this.watch = acquireWatch(this.root, where.index ? dirname(where.index) : undefined);
            }
            genAtStart = this.watch?.healthy ? this.watch.gen : undefined;
            result.root = this.root;
            // The repository's other worktrees in its folder are places of their own (turn-places.ts), not contents left out.
            const listed = await worktreeListOf(this.root).get(this.root, deadline);
            this.worktreesListed = listed !== undefined;
            this.worktrees = listed ? nearby(listed, this.root) : [];
            this.nested = insideRoot(this.worktrees, this.root);
            this.algo = where.algo;
            this.ensure();
            await this.measureStore(inTime);
            // Only what the folder's watch saw change since the last capture from Git's index, where that's enough.
            if (where.index && (await this.captureNarrowed(result, read, where.index, deadline, inTime, ending))) {
                narrowed = true;
                return result;
            }
            // Else from what `git status` says differs, where it can say: the first capture, and a refresh.
            if (where.index && (await this.captureFromStatus(result, read, where.index, deadline, inTime, ending))) {
                narrowed = true;
                return result;
            }
            // Untracked files as git lists them (it knows what's ignored); then the tracked ones, from Git's index read
            // after that, so nothing there before the listing slips between the two. Where the index is known, it's
            // read and its files stat'ed alongside the listing, and that's kept if it wasn't written in the meantime.
            let early: { stamp: string; scan: Promise<IndexScan> } | undefined;
            const knownIndex = where.index;
            if (knownIndex && msTimesExact(knownIndex)) {
                const st = await lstat(knownIndex).catch(() => undefined);
                if (st) {
                    early = { stamp: stampKey(st), scan: scanIndexFiles(this.root, knownIndex, where.algo === "sha1" ? 20 : 32, [], true, deadline) };
                    early.scan.catch(() => {});
                }
            }
            const [others, indexAt] = await Promise.all([
                git(this.root, ["ls-files", "-z", "--others", "--exclude-standard"], { maxBytes: 16 * 1024 * 1024, deadline, privateEnv: metadataEnv }),
                where.index ? { code: 0, out: Buffer.from(where.index) } : git(this.root, ["rev-parse", "--git-path", "index"], { deadline, privateEnv: metadataEnv }),
            ]);
            if (others.code || others.cut) throw new Error("The repository file list is unavailable or exceeds the snapshot budget.");
            // ls-files can succeed while warning that an untracked directory
            // could not be opened. That list cannot establish deletions.
            if (others.err.trim()) throw new Error(`The repository file list is incomplete: ${redact(others.err.trim())}`);
            const indexPath = indexAt.code ? undefined : resolve(this.root, indexAt.out.toString().replace(/\n$/, ""));
            if (indexPath) where.index = indexPath;
            // Git's index as the base: what differs from it is read, and the rest is what it records, so nothing of the
            // files that haven't changed is held here (index-scan.ts). The whole capture below where that can't be.
            if (indexPath && (await this.captureIndexed(result, read, others.out, indexPath, deadline, inTime, genAtStart ?? -1, indexPath === knownIndex ? early : undefined))) {
                if (this.indexedBase) this.indexedBase.fullMs = Date.now() - started;
                return result;
            }
            this.indexedBase = undefined;
            const index = indexPath ? await this.readIndex(indexPath) : undefined;
            let tracked: string[], modeAt: (path: string) => string | undefined;
            if (index) {
                tracked = index.paths;
                modeAt = (path) => modeOf(index, path);
            } else {
                // A split or sparse index: as git lists it.
                const listing = await git(this.root, ["ls-files", "-z", "--stage", "--cached"], { maxBytes: 16 * 1024 * 1024, deadline, privateEnv: metadataEnv });
                if (listing.code || listing.cut) throw new Error("The repository file list is unavailable or exceeds the snapshot budget.");
                const modes = new Map<string, string>();
                for (const record of listing.out.toString("utf-8").split("\0")) {
                    if (!record) continue;
                    const staged = /^(\d{6}) [0-9a-f]+ \d\t/.exec(record);
                    if (!staged) throw new Error("Unrecognized repository file entry.");
                    modes.set(record.slice(staged[0].length), staged[1]!);
                }
                tracked = [...modes.keys()];
                modeAt = (path) => modes.get(path);
            }
            const untracked = others.out.toString("utf-8").split("\0").filter((p) => p && modeAt(p) === undefined);
            let entries = new Map<string, Entry>();
            /** Where in the lists something was left out, or couldn't be read: looked at again next time, whatever its stat. */
            const recheck: number[] = [];
            const skip = (path: string, st: FileStat, reason: string, at: number) => {
                recheck.push(at);
                result.skipped[path] = reason;
                (result.skippedStamps ??= pathMap())[path] = stampOf(st).join(":");
            };
            /** Tracked files not known by this stamp: Git's index may already have them. */
            const candidates: Seen[] = [];
            const toRead: Seen[] = [];
            /** Files as Git's index has them, whose attributes are yet to be asked about. */
            const unverified: (Seen & { entry: Entry })[] = [];
            const root = this.root;
            const msExact = index ? msTimesExact(indexPath!) : false;
            const asIs = storedAsIsIn(root);
            const trackedId = index ? `${root}\0${this.index!.stamp}` : `${root}\0${Date.now()}:${Math.random()}`;
            const { kinds, stamps } = await statFiles(root, trackedId, tracked, untracked, deadline, inTime);
            inTime();
            const n = tracked.length + untracked.length;
            const pathAt = (i: number) => (i < tracked.length ? tracked[i]! : untracked[i - tracked.length]!);
            // What's known to be stored as it is holds while the attributes files are as they were.
            const attrs: string[] = [infoAttributes(indexPath)];
            for (let i = 0; i < n; i++) {
                const p = pathAt(i);
                if (p === ".gitattributes" || p.endsWith("/.gitattributes")) attrs.push(`${p}:${kinds[i]}:${stamps.subarray(i * 6, i * 6 + 6).join(":")}`);
            }
            const attrsKey = attrs.join("\0");
            if (asIs.attrs !== attrsKey) {
                asIs.paths.clear();
                asIs.attrs = attrsKey;
            }
            // The same lists as the last capture's: only paths whose stat moved since, or that it left out, are looked
            // at; the rest are as it found them (its entries and omissions). Unchanged, that's no more than comparing
            // two arrays.
            const last = this.scan;
            let only: number[] | undefined;
            if (last && this.lastTree && last.trackedId === trackedId && last.kinds.length === n && sameList(last.untracked, untracked)) {
                only = [...last.recheck];
                const was = last.stamps;
                for (let i = 0; i < n; i++) {
                    const o = i * 6;
                    if (kinds[i] !== last.kinds[i] || stamps[o] !== was[o] || stamps[o + 1] !== was[o + 1] || stamps[o + 2] !== was[o + 2] || stamps[o + 3] !== was[o + 3] || stamps[o + 4] !== was[o + 4] || stamps[o + 5] !== was[o + 5]) only.push(i);
                }
                only = [...new Set(only)];
                entries = only.length ? new Map(this.indexEntries) : this.indexEntries;
                Object.assign(result.skipped, last.skipped);
                if (last.skippedStamps) result.skippedStamps = pathMap(last.skippedStamps);
            }
            const pace = new Pace();
            for (let k = 0, count = only ? only.length : n; k < count; k++) {
                if ((k & 1023) === 1023) {
                    inTime();
                    if (pace.due) await pace.rest();
                }
                const i = only ? only[k]! : k;
                const isTracked = i < tracked.length;
                const path = pathAt(i);
                if (only) {
                    entries.delete(path);
                    delete result.skipped[path];
                    if (result.skippedStamps) delete result.skippedStamps[path];
                }
                const known = this.known.get(path);
                if (!known && !safePath(path)) throw new Error("A repository path cannot be safely captured.");
                const kind = kinds[i]!, o = i * 6;
                // Snapshots must distinguish deletion from a path they cannot read.
                if (kind === KIND.unreadable) { result.skipped[path] = "Unreadable path; not captured, change unknown."; recheck.push(i); continue; }
                if (kind === KIND.missing) continue; // A tracked file deleted from disk.
                if (known && sameAt(known.stamp, stamps, o) && (known.borrowed || this.stored.has(known.entry.oid))) { entries.set(known.path, known.entry); continue; }
                const st = statAt(kinds, stamps, i);
                if (kind !== KIND.file && kind !== KIND.link) {
                    // A tracked file replaced by a directory is deleted; its new
                    // untracked children are separate entries, not a nested repo.
                    const mode = isTracked ? modeAt(path) : undefined;
                    if (kind === KIND.dir && mode !== undefined && mode !== "160000") continue;
                    if (kind === KIND.dir && this.nested.has(path)) continue;
                    skip(path, st, kind === KIND.dir ? "Submodule or nested repository contents are not captured." : "Not a regular file.", i);
                    continue;
                }
                // A file of any size can be taken from Git's index; one to read, only up to the limit.
                if (isTracked && index && msExact) {
                    // As Git last recorded it: its blob is the one the index names, once its attributes are known to
                    // store it as it is.
                    const oid = cleanBlobMs(index, path, { kind: kind === KIND.link ? "link" : "file", mode: st.mode, ino: st.ino, size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs });
                    if (oid) {
                        const entry: Entry = { mode: kind === KIND.link ? "120000" : st.mode & 0o100 ? "100755" : "100644", oid, size: st.size };
                        if (asIs.paths.has(path)) entries.set(path, entry);
                        else unverified.push({ path, st, at: i, entry });
                        continue;
                    }
                } else if (isTracked && index) {
                    candidates.push({ path, st, at: i });
                    continue;
                }
                if (st.size > MAX_SNAPSHOT_BYTES) skip(path, st, "Over 10 MB; not captured, change unknown.", i);
                else toRead.push({ path, st, at: i });
            }
            // Ones whose attributes haven't been asked about yet: asked now, and known for this repository from then.
            if (unverified.length) {
                const stored = await this.storedAsIs(unverified.map((u) => u.path), deadline, new Map(unverified.map((u) => [u.path, u.entry.oid])));
                for (const u of unverified) {
                    if (stored.has(u.path)) {
                        asIs.paths.add(u.path);
                        entries.set(u.path, u.entry);
                    } else if (u.st.size > MAX_SNAPSHOT_BYTES) skip(u.path, u.st, "Over 10 MB; not captured, change unknown.", u.at);
                    else toRead.push(u);
                }
            }
            // Files as Git last recorded them have the blob its index names: taken from there, not read and hashed.
            if (candidates.length) {
                const taken = await this.fromIndex(index!, candidates, deadline);
                for (const c of candidates) {
                    const file = taken.get(c.path);
                    if (file) entries.set(c.path, file.entry);
                    else if (c.st.size > MAX_SNAPSHOT_BYTES) skip(c.path, c.st, "Over 10 MB; not captured, change unknown.", c.at);
                    else toRead.push(c);
                }
            }
            for (let k = 0; k < toRead.length; k += READ_AT_ONCE) {
                const done = await Promise.allSettled(toRead.slice(k, k + READ_AT_ONCE).map(async ({ path, st, at }) => {
                    const { buf, after } = await readChanged(join(root, path), st);
                    if (!buf) { skip(path, st, "Unreadable, changed while being read, or over 10 MB; not captured.", at); return; }
                    inTime();
                    if (!after || !sameStamp(stampOf(st), after)) { result.skipped[path] = "Changed while being read; not captured."; recheck.push(at); return; }
                    const mode = st.kind === KIND.link ? "120000" : st.mode & 0o100 ? "100755" : "100644", oid = blobId(buf, this.algo);
                    // The same as another session knows it: its strings are kept, not a copy of them.
                    const had = this.known.get(path);
                    const same = had?.entry.oid === oid && had.entry.mode === mode && had.entry.size === buf.length;
                    const stamp = stampOf(st);
                    const file: KnownFile = same ? (sameStamp(had.stamp, st) && !had.borrowed ? had : { path: had.path, stamp, entry: had.entry }) : { path, stamp, entry: { mode, oid, size: buf.length } };
                    await this.store(buf, "blob", file.entry.oid);
                    read.push(file);
                    entries.set(file.path, file.entry);
                }));
                for (const d of done) if (d.status === "rejected") throw d.reason;
                if ((this.pack?.bytes ?? 0) >= PACK_MAX_BYTES) await this.finishPack();
            }
            inTime();
            const updates: string[] = [];
            const changed: string[] = [];
            const compare = (path: string) => {
                const e = entries.get(path), was = this.indexEntries.get(path);
                if (!e) {
                    if (!was) return;
                    updates.push(`0 ${"0".repeat(this.algo === "sha1" ? 40 : 64)}\t${path}\0`);
                } else if (was?.oid !== e.oid || was.mode !== e.mode) updates.push(`${e.mode} ${e.oid}\t${path}\0`);
                else return;
                changed.push(path);
            };
            // Only what was looked at can differ from the last capture.
            if (only) for (const i of only) compare(pathAt(i));
            else {
                for (const path of this.indexEntries.keys()) if (!entries.has(path)) compare(path);
                for (const path of entries.keys()) compare(path);
            }
            // Nothing changed since the last one: it's the same tree.
            if (updates.length || !this.lastTree) {
                // The folders as the last capture left them, and what's changed since; or, the first time or after a
                // failure, all of them afresh.
                planning = true;
                const fresh = !this.folders || !this.lastTree;
                if (fresh) this.folders = folder();
                await placeFiles(this.folders!, fresh ? entries.keys() : changed, entries, inTime, pace);
                const planned = await treeObjects(this.folders!, this.algo, inTime, pace);
                plannedTrees = new Set(planned.objects.keys());
                for (const [oid, bytes] of planned.objects) {
                    inTime();
                    await this.store(bytes, "tree", oid);
                }
                await this.writeOut();
                // Reset only on first use/reopen or after a failed index update.
                // Afterwards update just changed paths; object/stat caches avoid rehashing.
                // From here the private index may not be what indexEntries says: a failure has it written afresh.
                touched = true;
                if (!this.indexEntries.size) {
                    const reset = await this.run(["read-tree", "--empty"], deadline);
                    if (reset.code) throw new Error("Could not initialize the private snapshot index.");
                }
                if (updates.length) {
                    const update = await this.run(["update-index", "-z", "--index-info"], deadline, updates.join(""));
                    if (update.code || update.cut) throw new Error("Could not update the private snapshot index.");
                }
                // Blobs taken from Git's index are in the repository's objects, not these.
                const tree = await this.run(["write-tree", "--missing-ok"], deadline);
                const oid = tree.out.toString().trim();
                if (tree.code || oid !== planned.root) throw new Error("Could not write the private snapshot tree.");
                this.lastTree = oid;
            }
            await this.writeOut();
            this.indexEntries = entries;
            this.scan = { trackedId, untracked, kinds, stamps, recheck, skipped: pathMap(result.skipped), skippedStamps: result.skippedStamps && pathMap(result.skippedStamps) };
            result.tree = this.lastTree;
            result.incomplete = Object.keys(result.skipped).length > 0;
        } catch (e) {
            result.incomplete = true;
            result.notes.push((e as Error).message);
            // Out of time before the private index was touched, it's still as the last capture left it: the next one
            // updates what changed, rather than writing all of it again (and running out of time again).
            if (touched) {
                this.indexEntries = new Map();
                this.lastTree = undefined;
                this.scan = undefined;
            }
            // Its folders may be partway between two captures: worked out afresh next time.
            if (planning) this.folders = undefined;
            // What it read in the time it had isn't read again next time.
            await this.writeOut().catch(() => {});
        } finally {
            for (const file of read) if (this.stored.has(file.entry.oid)) this.known.set(file.path, file);
            if (this.saved) {
                await this.harden(plannedTrees).catch(() => { result.incomplete = true; result.notes.push("Could not set snapshot storage permissions."); });
                await rm(join(this.storage, "index.lock"), { force: true }).catch(() => {});
            }
            if (result.tree && Date.now() > deadline) {
                delete result.tree;
                result.incomplete = true;
                result.notes.push("Snapshot exceeded its time budget while finalizing storage.");
            }
            result.durationMs = Date.now() - started;
            // What a capture that finds nothing changed takes again (unchanged). A narrowed one says as of when it looked.
            if (!narrowed) {
                if (genAtStart !== undefined) this.rememberFast(genAtStart, Date.now(), result);
                else this.lastFast = undefined;
            }
        }
        return result;
    }

    /**
     * The paths whose entries differ between two captured trees, each with both (git diff-tree, raw: no rename
     * detection, no blob read), so a turn's end reads what changed rather than both whole trees.
     */
    /**
     * While a turn runs, the trees on the way to what it changes are read ahead, a second after a change: at its end
     * they're known, and the capture the next prompt waits for edits them without asking git (on a busy machine, a
     * second or more for each). Only along the paths the watch saw change, at most WARM_MAX_PATHS of them.
     */
    private listenForWarming() {
        this.stopWarming?.();
        const w = this.watch;
        if (!w?.healthy) return;
        this.stopWarming = w.onChange(() => {
            if (this.warmTimer) return;
            this.warmTimer = setTimeout(() => {
                this.warmTimer = undefined;
                void this.warmTrees();
            }, 1000);
            this.warmTimer.unref?.();
        });
    }

    private async warmTrees() {
        const base = this.indexedBase, w = this.watch, root = this.root;
        if (this.warming || this.stopped || !this.active || !base || !w?.healthy || !root || base.watch !== w) return;
        const paths = w.changedSince(base.gen);
        if (!paths || paths.length > WARM_MAX_PATHS) return;
        this.warming = true;
        const hashBytes = this.algo === "sha1" ? 20 : 32;
        const deadline = Date.now() + 30_000;
        try {
            for (const path of paths) {
                let tree = base.tree;
                const parts = path.split("/");
                for (let i = 0; i < parts.length - 1 && !this.stopped; i++) {
                    const e = parseTree(await this.readTree(root, tree, deadline), hashBytes).get(Buffer.from(parts[i]!, "utf-8").toString("latin1"));
                    if (e?.mode !== "40000") break;
                    tree = e.oid.toString("hex");
                }
            }
        } catch {
            // Read again at the turn's end, as without this.
        } finally {
            this.warming = false;
        }
    }

    /**
     * A tree's bytes: known (treeBodies), or read by this session's `git cat-file --batch`, kept between captures (a
     * turn's end reads the trees of the folders it changed, most of them new to it) and let go of after a minute idle.
     */
    private async readTree(root: string, oid: string, deadline: number): Promise<Buffer> {
        const known = treeBodies.get(oid);
        if (known) return known;
        const body = await this.withReader(root, deadline, (r) => r.read(oid, "tree"));
        rememberTree(oid, body);
        return body;
    }

    /** `f` with this session's reader (started if there's none for `root`), after whatever it's reading already. */
    private async withReader<T>(root: string, deadline: number, f: (r: ObjectReader) => Promise<T>): Promise<T> {
        const env = this.readEnv();
        const key = `${root}\0${JSON.stringify(env)}`;
        let r = this.reader;
        if (!r || r.key !== key) {
            r?.reader.close();
            r = this.reader = { key, reader: new ObjectReader(root, env, Date.now() + READER_MAX_MS), queue: Promise.resolve() };
        }
        const mine = r;
        clearTimeout(mine.idle);
        mine.reader.busy();
        const job = mine.queue.then(() => {
            if (Date.now() >= deadline) throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
            let timer: ReturnType<typeof setTimeout> | undefined;
            return Promise.race([
                f(mine.reader),
                new Promise<never>((_, fail) => (timer = setTimeout(() => fail(new Error("Snapshot exceeded its time budget (2 seconds by default).")), deadline - Date.now()))),
            ]).finally(() => clearTimeout(timer));
        });
        mine.queue = job.catch(() => undefined);
        const letGo = () => {
            mine.reader.close();
            if (this.reader === mine) this.reader = undefined;
        };
        try {
            return await job;
        } catch (e) {
            // Out of time or broken: what it was reading is unknown; the next read starts another.
            letGo();
            throw e;
        } finally {
            if (this.reader === mine) {
                mine.reader.idle();
                mine.idle = setTimeout(letGo, READER_IDLE_MS);
                mine.idle.unref?.();
            }
        }
    }

    private async differ(start: TurnCapture, end: TurnCapture, deadline: number, trees?: Set<string>): Promise<Map<string, { old?: Entry; now?: Entry }>> {
        if (!start.tree || !end.tree) throw new Error("This turn has an incomplete snapshot with no tree.");
        // As `git diff-tree -r -t` says it, worked out here: only the folders whose trees differ are read, most of them
        // already known (the captures that made them: treeBodies). The trees of what didn't change may be the
        // repository's (captureIndexed): read, never written, from there too.
        const hashBytes = this.algo === "sha1" ? 20 : 32;
        const read = (oid: string) => this.readTree(start.root ?? this.cwd, oid, deadline);
        const out = new Map<string, { old?: Entry; now?: Entry }>();
        const entry = (e: { mode: string; oid: Buffer }): Entry => ({ mode: e.mode.padStart(6, "0"), oid: e.oid.toString("hex") });
        const walk = async (a: string | undefined, b: string | undefined, prefix: string): Promise<void> => {
            const was = a ? parseTree(await read(a), hashBytes) : new Map<string, { mode: string; oid: Buffer }>();
            const now = b ? parseTree(await read(b), hashBytes) : new Map<string, { mode: string; oid: Buffer }>();
            for (const name of new Set([...was.keys(), ...now.keys()])) {
                const x = was.get(name), y = now.get(name);
                if (x && y && x.mode === y.mode && x.oid.equals(y.oid)) continue;
                const path = prefix + Buffer.from(name, "latin1").toString("utf-8");
                if (!safePath(path)) throw new Error("Snapshot contains an unsafe repository path.");
                const xTree = x?.mode === "40000" ? x.oid.toString("hex") : undefined, yTree = y?.mode === "40000" ? y.oid.toString("hex") : undefined;
                // A folder on either side: its trees are on the way to what changed in it (a file that became one, or
                // the reverse, is that folder's files and the file, each on its own side).
                if (xTree || yTree) {
                    if (xTree) trees?.add(xTree);
                    if (yTree) trees?.add(yTree);
                    await walk(xTree, yTree, `${path}/`);
                }
                const xFile = x && !xTree ? x : undefined, yFile = y && !yTree ? y : undefined;
                if (xFile || yFile) out.set(path, { old: xFile && entry(xFile), now: yFile && entry(yFile) });
            }
        };
        try {
            await walk(start.tree, end.tree, "");
        } catch (e) {
            if ((e as Error).message === "Snapshot contains an unsafe repository path.") throw e;
            throw new Error("Snapshot objects are missing or unreadable; this turn is incomplete.");
        }
        return out;
    }

    /** This session's objects, with the repository's (when its index is known) to read what a capture took from it. */
    private readEnv(): Record<string, string> {
        const index = locations.get(this.cwd)?.index;
        return index ? { ...this.env(), GIT_ALTERNATE_OBJECT_DIRECTORIES: objectsOf(index) } : this.env();
    }

    private async compare(turn: SnapshotTurn, deadline: number, trees?: Set<string>): Promise<Change[]> {
        if (!turn.end) return [];
        if (turn.start.tree && turn.start.tree === turn.end.tree && !Object.keys(turn.start.skipped).length && !Object.keys(turn.end.skipped).length) return [];
        const differs = await this.differ(turn.start, turn.end, deadline, trees);
        const skipped = pathMap(turn.start.skipped, turn.end.skipped);
        const changes: Change[] = [];
        // A path left out on one side isn't in that side's tree, so it differs; one left out of both is in neither.
        for (const path of new Set([...differs.keys(), ...Object.keys(skipped)])) {
            const { old, now } = differs.get(path) ?? {};
            if (Object.hasOwn(turn.start.skipped, path) && Object.hasOwn(turn.end.skipped, path) && own(turn.start.skippedStamps, path) && own(turn.start.skippedStamps, path) === own(turn.end.skippedStamps, path)) continue;
            if (!Object.hasOwn(skipped, path) && old?.oid === now?.oid && old?.mode === now?.mode) continue;
            changes.push({ path, old, now, indexed: true, change: Object.hasOwn(skipped, path) ? "modified" : !old ? "added" : !now ? "deleted" : old.mode.slice(0, 3) !== now.mode.slice(0, 3) ? "typechange" : "modified", note: skipped[path], kind: (now ?? old)?.mode === "120000" ? "link" : undefined });
        }
        return changes.sort((a, b) => a.path.localeCompare(b.path));
    }

    /** Each listed change's blob sizes, from this session's objects, for what a reply can carry (render). */
    private async sizes(changes: Change[], root: string, deadline: number) {
        const entries = changes.flatMap((c) => [c.old, c.now]).filter((e): e is Entry => !!e && e.mode !== "160000" && e.size === undefined);
        if (!entries.length) return;
        const r = await git(root, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: [...new Set(entries.map((e) => e.oid))].join("\n") + "\n", privateEnv: this.readEnv(), deadline });
        const size = new Map<string, number>();
        for (const line of r.out.toString().split("\n")) {
            const [oid, n] = line.split(" ");
            if (oid && n && /^\d+$/.test(n)) size.set(oid, Number(n));
        }
        for (const e of entries) e.size = size.get(e.oid);
    }

    changes(req: { scope: GitScope; turnId?: number; path?: string }): Promise<GitChangesInfo> {
        return coalesce(this.inflight, JSON.stringify(req), () => this.collect(req));
    }

    private async collect(req: { scope: GitScope; turnId?: number; path?: string }): Promise<GitChangesInfo> {
        // A turn's closing capture may still be under way.
        await this.settled();
        const turns = this.list();
        const turn = req.scope === "last-turn" ? turns.at(-1) : turns.find((t) => t.id === req.turnId);
        const out: GitChangesInfo = { repo: true, scope: req.scope, files: [], added: 0, removed: 0, tracked: true, bases: [], more: 0, turns: turns.map(({ id, prompt, startedAt, endedAt }) => ({ id, prompt, startedAt, endedAt })), turnId: turn?.id, snapshotAvailable: false, notes: [POLICY] };
        if (!turn) {
            const repo = await git(this.cwd, ["rev-parse", "--show-toplevel"], { privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } });
            out.repo = repo.code === 0;
            out.notes!.push("No snapshot was recorded for this turn.");
            out.incomplete = true;
            return out;
        }
        out.incomplete = turn.start.incomplete || !turn.end || turn.end.incomplete || !!this.failure;
        if (turn.places?.length) out.places = turn.places;
        out.notes!.push(...turn.start.notes, ...(turn.end?.notes ?? []), ...(this.failure ? [this.failure] : []));
        const omissions = Object.entries({ ...turn.start.skipped, ...turn.end?.skipped });
        for (const [path, reason] of omissions.slice(0, 20)) out.notes!.push(`Not captured: ${path}: ${reason}`);
        if (omissions.length > 20) out.notes!.push(`${omissions.length - 20} other paths were not captured.`);
        if (!turn.end) { out.notes!.push("The turn is still running, or ended without a closing snapshot."); return out; }
        const deadline = Date.now() + 20_000;
        try {
            const all = await this.compare(turn, deadline);
            await this.sizes(all, turn.start.root ?? this.cwd, deadline);
            out.snapshotAvailable = true;
            const root = turn.start.root ?? this.cwd;
            const here = canonical(this.cwd);
            const shown = (path: string) => relative(here, join(root, path)) || ".";
            const wanted = req.path && isAbsolute(req.path) ? relative(here, req.path) : req.path;
            const listed = wanted !== undefined ? all.filter((c) => shown(c.path) === wanted).slice(0, 1) : all.slice(0, 300);
            out.more = wanted === undefined ? Math.max(0, all.length - listed.length) : 0;
            out.files = await render(listed, {
                root, wt: new WorkTree(root, this.algo, true, () => {}, deadline), shown, single: wanted !== undefined, deadline,
                eolOf: () => undefined, indexOid: () => undefined,
                readBlobs: async (oids, until) => {
                    const found = await blobs(root, oids, until, this.env());
                    for (const [oid, buf] of found) if (blobId(buf, oid.length === 64 ? "sha256" : "sha1") !== oid) found.delete(oid);
                    for (const c of listed) {
                        if ([c.old, c.now].some((e) => e && (e.size ?? 0) <= MAX_DIFF_INPUT && oids.includes(e.oid) && !found.has(e.oid))) {
                            c.note = "Snapshot object is missing; this turn is incomplete.";
                            out.incomplete = true;
                        }
                    }
                    return found;
                },
            });
            out.added = out.files.reduce((n, f) => n + f.added, 0);
            out.removed = out.files.reduce((n, f) => n + f.removed, 0);
        } catch (e) {
            out.incomplete = true;
            out.notes!.push((e as Error).message);
        }
        out.notes = [...new Set(out.notes)];
        return out;
    }
}
