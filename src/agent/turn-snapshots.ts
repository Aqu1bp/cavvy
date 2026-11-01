// Raw working-tree snapshots, independent of edit tools and backend history.
// Version 2 journal (reads version 1 too): one complete turn record per line, later records replace
// earlier ones with the same checkpoint id. All objects belong to this session;
// no alternates, repository writes, filters, hooks, or network access are used.
// Git's loose object format is zlib(header + bytes); hashing/compressing in
// process avoids a subprocess per file and preserves the bytes on disk.

import { appendFileSync, chmodSync, lstatSync, mkdirSync, readFileSync, type Stats } from "fs";
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { deflateSync } from "zlib";
import { randomBytes } from "crypto";
import { FileHistory, MAX_SNAPSHOT_BYTES, canonical } from "./checkpoints";
import type { Session } from "./session";
import { blobId, blobs, git, gitEnvironment, readRegular, render, WorkTree, type Change, type Entry } from "../server/git-changes";
import { gitArgv } from "../util/git";
import { coalesce, type Slot } from "../server/coalesce";
import { MAX_DIFF_INPUT } from "../server/diffs";
import type { GitChangesInfo, GitScope, TurnPlace } from "../server/protocol";
import { changedSince, eachLimited, insideRoot, nearby, reachedPlaces, summarize, token, UNKNOWN, WorktreeChecks, WorktreeList, type Checked, type Worktree } from "./turn-places";
import { redact } from "../util/redact";
import { cleanBlob, modeOf, parseIndex, type GitIndex } from "./git-index";
import { Pace } from "../util/pace";
import { KIND, statFiles } from "./stat-files";

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
    /** The repository's other worktrees inside its folder, each with its token (turn-places.ts), or UNKNOWN. */
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
    /** The last capture's files in their folders, with each folder's tree id (treeObjects). */
    private folders?: Folder;

    /** Git's own index for this folder, as last read (fromIndex). */
    private index?: { stamp: string; parsed: GitIndex };
    private readonly storage: string;
    private readonly journal: string;

    constructor(readonly dir: string, readonly cwd: string, private options: { budgetMs?: number; maxStoreBytes?: number } = {}) {
        this.storage = join(dir, "turn-snapshots");
        this.journal = join(dir, "turn-snapshots.jsonl");
        let lines: string;
        try { lines = readFileSync(this.journal, "utf-8"); } catch { return; }
        // list()/changedPaths() are synchronous: validate against cwd's actual
        // repository before exposing any saved path, never against a journal-supplied cwd.
        try {
            const top = Bun.spawnSync(gitArgv(["rev-parse", "--show-toplevel"]), { cwd, env: gitEnvironment({ privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } }), timeout: 2000, stdout: "pipe", stderr: "ignore" });
            if (top.exitCode !== 0) return;
            this.root = top.stdout.toString().replace(/\n$/, "");
        } catch { return; }
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

    changedPaths(): string[] {
        return [...new Set(this.list().flatMap((t) => (t.changed ?? []).map((path) => join(t.start.root ?? this.cwd, path))))];
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
            await this.open(id, prompt, await this.marks(await this.capture(), reached));
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
            if (!this.stopped) captured = await this.marks(await this.capture(), reached);
        }).then(() => captured);
    }

    /** As `begin`, from what `prepare` captured. */
    beginWith(id: number, prompt: string, captured: TurnCapture | undefined): Promise<void> {
        this.takeReached();
        return this.record(() => this.open(id, prompt, captured));
    }

    private async open(id: number, prompt: string, captured: TurnCapture | undefined) {
        if (!captured || this.stopped) return; // Not a repository, or this session was let go.
        if (this.active) await this.finish(structuredClone(captured));
        if (this.stopped) return;
        // What the turn before worked in is that turn's, not part of this one's start.
        delete captured.worked;
        this.active = { version: 2, id, prompt: redact(prompt).slice(0, 2000), startedAt: Date.now(), start: captured };
        this.persist(this.active);
    }

    end(): Promise<void> {
        const reached = this.takeReached();
        return this.record(async () => {
            if (!this.active || this.stopped) return;
            // No turn starts here: only the worktrees this one reached are looked at.
            const captured = await this.marks(await this.capture(), reached, false);
            if (this.stopped) return;
            await this.finish(captured ?? { incomplete: true, notes: ["The repository is no longer available."], skipped: pathMap(), durationMs: 0 });
        });
    }

    /** Retire before releasing the session lock: no late end, or index writes alongside a reopened session. */
    async stop(): Promise<void> {
        this.stopped = true;
        this.active = undefined;
        await Promise.allSettled([...this.pending]);
    }

    /** One after another, in the order they're asked for: a start not awaited still lands before the next end. */
    private record(work: () => Promise<void>): Promise<void> {
        const pending = this.last.then(work);
        this.last = pending.catch(() => undefined);
        this.pending.add(pending);
        return pending.finally(() => { this.pending.delete(pending); });
    }

    private async finish(captured: TurnCapture) {
        const turn: SnapshotTurn = { ...this.active!, end: captured, endedAt: Date.now() };
        this.active = undefined;
        let changes: Change[] | undefined;
        try {
            changes = await this.compare(turn, Date.now() + 2000);
            turn.changed = changes.map((c) => c.path);
        } catch {
            captured.incomplete = true;
            captured.notes.push("The snapshot comparison is unavailable; some objects may be missing.");
        }
        if (changes?.length) {
            try {
                await this.keep(changes, turn.start.root ?? this.root ?? this.cwd, Date.now() + 5000);
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
    private async keep(changes: Change[], root: string, deadline: number) {
        const borrowed = new Set<string>();
        for (const c of changes) for (const e of [c.old, c.now]) {
            if (e && e.mode !== "160000" && !this.stored.has(e.oid) && !this.unwritten.has(e.oid) && !this.pack?.oids.has(e.oid)) borrowed.add(e.oid);
        }
        if (!borrowed.size) return;
        // Sizes aren't known (a borrowed blob isn't in this session's objects): read in batches, each bounded, and only
        // what's up to the size a file is read to kept (a bigger one was only ever taken from the index, and isn't
        // shown as a diff).
        const wanted = new Map([...borrowed].map((oid) => [oid, 0]));
        let missing = 0;
        // A batch at a time, each well within what one read takes.
        const batches: string[][] = [[]];
        for (const [oid] of wanted) {
            if (batches.at(-1)!.length >= 16) batches.push([]);
            batches.at(-1)!.push(oid);
        }
        try {
            for (const batch of batches) {
                const found = await blobs(root, batch, deadline, { GIT_NO_REPLACE_OBJECTS: "1" });
                for (const oid of batch) {
                    const buf = found.get(oid);
                    // Its bytes, whatever the repository holds under that name.
                    if (!buf || blobId(buf, this.algo) !== oid) { missing++; continue; }
                    if (buf.length > MAX_SNAPSHOT_BYTES) continue;
                    await this.store(buf, "blob", oid);
                }
            }
        } finally {
            await this.writeOut();
        }
        if (missing) throw new Error(`${missing} of this turn's file versions could not be kept; their diffs may be unavailable.`);
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
        // Only folders that really are those worktrees are read (one swapped for a link isn't); the rest go unmarked.
        const root = captured.root;
        const checked = (await eachLimited(this.worktrees, 4, (w) => this.checks.check(root, w))).filter((w): w is Checked => w !== undefined);
        const start = this.active?.start;
        const candidates = start ? reachedPlaces(checked, [root, ...checked.map((w) => w.path)], reached) : [];
        const marked = whole ? checked : candidates;
        const tokens = await eachLimited(marked, 4, (w) => token(w, deadline));
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
                if (was === undefined || was !== now) return true;
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
            await writeFile(at, "", { mode: 0o600 });
            return (await lstat(at, { bigint: true })).ctimeNs;
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
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await chmod(folder, 0o700);
        const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
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

    private async capture(): Promise<TurnCapture | undefined> {
        const started = Date.now();
        const deadline = started + (this.options.budgetMs ?? 2000);
        const result: TurnCapture = { incomplete: false, notes: [], skipped: pathMap(), durationMs: 0 };
        let plannedTrees = new Set<string>();
        let touched = false, planning = false;
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
            result.root = this.root;
            // The repository's other worktrees in its folder are places of their own (turn-places.ts), not contents left out.
            const listed = await worktreeListOf(this.root).get(this.root, deadline);
            this.worktreesListed = listed !== undefined;
            this.worktrees = listed ? nearby(listed, this.root) : [];
            this.nested = insideRoot(this.worktrees, this.root);
            // Untracked files as git lists them (it knows what's ignored); then the tracked ones, from Git's index read
            // after that, so nothing there before the listing slips between the two.
            const [others, indexAt] = await Promise.all([
                git(this.root, ["ls-files", "-z", "--others", "--exclude-standard"], { maxBytes: 16 * 1024 * 1024, deadline, privateEnv: metadataEnv }),
                where.index ? { code: 0, out: Buffer.from(where.index) } : git(this.root, ["rev-parse", "--git-path", "index"], { deadline, privateEnv: metadataEnv }),
            ]);
            if (others.code || others.cut) throw new Error("The repository file list is unavailable or exceeds the snapshot budget.");
            // ls-files can succeed while warning that an untracked directory
            // could not be opened. That list cannot establish deletions.
            if (others.err.trim()) throw new Error(`The repository file list is incomplete: ${redact(others.err.trim())}`);
            this.algo = where.algo;
            this.ensure();
            await this.measureStore(inTime);
            const indexPath = indexAt.code ? undefined : resolve(this.root, indexAt.out.toString().replace(/\n$/, ""));
            if (indexPath) where.index = indexPath;
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
            const root = this.root;
            const trackedId = index ? `${root}\0${this.index!.stamp}` : `${root}\0${Date.now()}:${Math.random()}`;
            const { kinds, stamps } = await statFiles(root, trackedId, tracked, untracked, deadline, inTime);
            inTime();
            const n = tracked.length + untracked.length;
            const pathAt = (i: number) => (i < tracked.length ? tracked[i]! : untracked[i - tracked.length]!);
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
                if (isTracked) candidates.push({ path, st, at: i });
                else if (st.size > MAX_SNAPSHOT_BYTES) skip(path, st, "Over 10 MB; not captured, change unknown.", i);
                else toRead.push({ path, st, at: i });
            }
            // Files as Git last recorded them have the blob its index names: taken from there, not read and hashed.
            if (candidates.length) {
                const taken = index ? await this.fromIndex(index, candidates, deadline) : new Map<string, KnownFile>();
                for (const c of candidates) {
                    const file = taken.get(c.path);
                    if (file) entries.set(c.path, file.entry);
                    else if (c.st.size > MAX_SNAPSHOT_BYTES) skip(c.path, c.st, "Over 10 MB; not captured, change unknown.", c.at);
                    else toRead.push(c);
                }
            }
            for (let k = 0; k < toRead.length; k += READ_AT_ONCE) {
                const done = await Promise.allSettled(toRead.slice(k, k + READ_AT_ONCE).map(async ({ path, st, at }) => {
                    const buf = st.kind === KIND.link ? await readlink(join(root, path), { encoding: "buffer" }).catch(() => undefined) : (await readRegular(join(root, path), MAX_SNAPSHOT_BYTES))?.buf;
                    if (!buf) { skip(path, st, "Unreadable, changed while being read, or over 10 MB; not captured.", at); return; }
                    inTime();
                    const after = await lstat(join(root, path)).catch(() => undefined);
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
        }
        return result;
    }

    /**
     * The paths whose entries differ between two captured trees, each with both (git diff-tree, raw: no rename
     * detection, no blob read), so a turn's end reads what changed rather than both whole trees.
     */
    private async differ(start: TurnCapture, end: TurnCapture, deadline: number): Promise<Map<string, { old?: Entry; now?: Entry }>> {
        if (!start.tree || !end.tree) throw new Error("This turn has an incomplete snapshot with no tree.");
        const r = await git(start.root ?? this.cwd, ["diff-tree", "-r", "-z", "--no-renames", "--no-ext-diff", "--no-textconv", start.tree, end.tree], { privateEnv: this.env(), deadline });
        if (r.code || r.cut) throw new Error("Snapshot objects are missing or unreadable; this turn is incomplete.");
        const out = new Map<string, { old?: Entry; now?: Entry }>();
        // ":<old mode> <new mode> <old id> <new id> <status>" NUL "<path>" NUL, for each.
        const fields = r.out.toString("utf-8").split("\0");
        for (let i = 0; i + 1 < fields.length; i += 2) {
            const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) [A-Z]/.exec(fields[i]!);
            const path = fields[i + 1]!;
            if (!m || !safePath(path)) throw new Error("Snapshot contains an unsafe repository path.");
            const none = /^0+$/;
            out.set(path, { old: m[1] === "000000" || none.test(m[3]!) ? undefined : { mode: m[1]!, oid: m[3]! }, now: m[2] === "000000" || none.test(m[4]!) ? undefined : { mode: m[2]!, oid: m[4]! } });
        }
        return out;
    }

    private async compare(turn: SnapshotTurn, deadline: number): Promise<Change[]> {
        if (!turn.end) return [];
        if (turn.start.tree && turn.start.tree === turn.end.tree && !Object.keys(turn.start.skipped).length && !Object.keys(turn.end.skipped).length) return [];
        const differs = await this.differ(turn.start, turn.end, deadline);
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
        const r = await git(root, ["cat-file", "--batch-check=%(objectname) %(objectsize)"], { input: [...new Set(entries.map((e) => e.oid))].join("\n") + "\n", privateEnv: this.env(), deadline });
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
