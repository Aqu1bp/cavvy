// Raw working-tree snapshots, independent of edit tools and backend history.
// Version 2 journal (reads version 1 too): one complete turn record per line, later records replace
// earlier ones with the same checkpoint id. All objects belong to this session;
// no alternates, repository writes, filters, hooks, or network access are used.
// Git's loose object format is zlib(header + bytes); hashing/compressing in
// process avoids a subprocess per file and preserves the bytes on disk.

import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "fs";
import { chmod, lstat, mkdir, readdir, readFile, readlink, rename, rm, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative } from "path";
import { deflateSync } from "zlib";
import { randomBytes } from "crypto";
import { FileHistory, MAX_SNAPSHOT_BYTES, canonical } from "./checkpoints";
import type { Session } from "./session";
import { blobId, blobs, git, gitEnvironment, parseTree, readRegular, render, WorkTree, type Change, type Entry } from "../server/git-changes";
import { gitArgv } from "../util/git";
import { coalesce, type Slot } from "../server/coalesce";
import { MAX_DIFF_INPUT } from "../server/diffs";
import type { GitChangesInfo, GitScope, TurnPlace } from "../server/protocol";
import { eachLimited, fingerprint, insideRoot, listWorktrees, nearby, reachedPlaces, summarize, UNKNOWN, WorktreeChecks, type Checked, type Worktree } from "./turn-places";
import { redact } from "../util/redact";

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
    /** The repository's other worktrees inside its folder, each with its fingerprint (turn-places.ts), or UNKNOWN. */
    places?: Record<string, string>;
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

/**
 * Build the trees before write-tree so their compressed bytes pass through
 * the same quota as blobs. Git then reuses these private objects.
 */
function treeObjects(entries: Map<string, Entry>, algo: "sha1" | "sha256", inTime: () => void): { root: string; objects: Map<string, Buffer> } {
    interface Directory { files: Map<string, Entry>; dirs: Map<string, Directory> }
    const directory = (): Directory => ({ files: new Map(), dirs: new Map() });
    const root = directory();
    for (const [path, entry] of entries) {
        inTime();
        const parts = path.split("/");
        let node = root;
        for (const part of parts.slice(0, -1)) {
            let next = node.dirs.get(part);
            if (!next) node.dirs.set(part, (next = directory()));
            node = next;
        }
        node.files.set(parts.at(-1)!, entry);
    }
    const objects = new Map<string, Buffer>();
    const tree = (node: Directory): string => {
        inTime();
        const children = [...node.files].map(([name, e]) => ({ name, mode: e.mode, oid: e.oid, order: Buffer.from(name) }));
        for (const [name, dir] of node.dirs) children.push({ name, mode: "40000", oid: tree(dir), order: Buffer.from(name + "/") });
        children.sort((a, b) => Buffer.compare(a.order, b.order));
        const bytes = Buffer.concat(children.flatMap((e) => [Buffer.from(`${e.mode} ${e.name}\0`), Buffer.from(e.oid, "hex")]));
        const hash = new Bun.CryptoHasher(algo);
        hash.update(`tree ${bytes.length}\0`);
        hash.update(bytes);
        const oid = hash.digest("hex");
        objects.set(oid, bytes);
        return oid;
    };
    return { root: tree(root), objects };
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

export class TurnSnapshots {
    private turns = new Map<number, SnapshotTurn>();
    private active?: SnapshotTurn;
    private root?: string;
    private algo: "sha1" | "sha256" = "sha1";
    private cache = new Map<string, { stamp: string; entry: Entry }>();
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
            const captured = await this.marks(await this.capture(), reached);
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
        try {
            const changes = await this.compare(turn, Date.now() + 2000);
            turn.changed = changes.map((c) => c.path);
        } catch {
            captured.incomplete = true;
            captured.notes.push("The snapshot comparison is unavailable; some objects may be missing.");
        }
        // The other worktrees it worked in, summed up when its end was captured (marks).
        if (captured.worked?.length) turn.places = captured.worked;
        delete captured.worked;
        if (!this.stopped) this.persist(turn);
    }

    /**
     * Each nearby worktree's fingerprint (turn-places.ts); and, at the end of a turn that's open, the ones it worked
     * in (changed, or new, since it began, and `reached`), summed up now: at a steering boundary the next turn may
     * already be under way by the time this one is finished, and what it does isn't this one's. Not when either end
     * went unmarked.
     */
    private async marks(captured: TurnCapture | undefined, reached: ReadonlySet<string> = new Set()): Promise<TurnCapture | undefined> {
        if (!captured?.root || this.stopped || !this.worktreesListed) return captured;
        const deadline = Date.now() + 1500;
        // Only folders that really are those worktrees are read (one swapped for a link isn't); the rest go unmarked.
        const root = captured.root;
        const checked = (await eachLimited(this.worktrees, 4, (w) => this.checks.check(root, w))).filter((w): w is Checked => w !== undefined);
        const prints = await eachLimited(checked, 4, (w) => fingerprint(w, deadline));
        const after = Object.fromEntries(checked.map((w, i) => [w.path, prints[i]!]));
        captured.places = after;
        const before = this.active?.start.places;
        if (before && !this.stopped) {
            const changed = checked.filter((w) => after[w.path] !== UNKNOWN && before[w.path] !== UNKNOWN && after[w.path] !== before[w.path]);
            const worked = reachedPlaces(changed, [root, ...checked.map((w) => w.path)], reached);
            if (worked.length) {
                const until = Date.now() + 3000;
                captured.worked = await eachLimited(worked, 4, (w) => summarize(w, until));
            }
        }
        return captured;
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

    private async capture(): Promise<TurnCapture | undefined> {
        const started = Date.now();
        const deadline = started + (this.options.budgetMs ?? 2000);
        const result: TurnCapture = { incomplete: false, notes: [], skipped: pathMap(), durationMs: 0 };
        let plannedTrees = new Set<string>();
        /** What's been read; known once its objects are on disk. */
        const read: [string, { stamp: string; entry: Entry }][] = [];
        const inTime = () => {
            if (this.stopped) throw new Error("The snapshot session was closed.");
            if (Date.now() >= deadline) throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
        };
        try {
            inTime();
            const metadataEnv = { GIT_NO_REPLACE_OBJECTS: "1" };
            const top = await git(this.cwd, ["rev-parse", "--show-toplevel", "--show-object-format"], { deadline, privateEnv: metadataEnv });
            if (top.code !== 0) return undefined;
            // The format is the last line: a folder's name can hold a newline.
            const asked = top.out.toString().replace(/\n$/, "");
            const cut = asked.lastIndexOf("\n");
            this.root = asked.slice(0, cut);
            result.root = this.root;
            // The repository's other worktrees in its folder are places of their own (turn-places.ts), not contents left out.
            const listed = await listWorktrees(this.root, deadline);
            this.worktreesListed = listed !== undefined;
            this.worktrees = listed ? nearby(listed, this.root) : [];
            this.nested = insideRoot(this.worktrees, this.root);
            const listing = await git(this.root, ["ls-files", "-z", "-t", "--stage", "--cached", "--others", "--exclude-standard"], { maxBytes: 16 * 1024 * 1024, deadline, privateEnv: metadataEnv });
            if (listing.code || listing.cut) throw new Error("The repository file list is unavailable or exceeds the snapshot budget.");
            // ls-files can succeed while warning that an untracked directory
            // could not be opened. That list cannot establish deletions.
            if (listing.err.trim()) throw new Error(`The repository file list is incomplete: ${redact(listing.err.trim())}`);
            this.algo = asked.slice(cut + 1).trim() === "sha256" ? "sha256" : "sha1";
            this.ensure();
            await this.measureStore(inTime);
            const wt = new WorkTree(this.root, this.algo, true, inTime, deadline);
            const entries = new Map<string, Entry>();
            const modes = new Map<string, string>();
            const paths = [...new Set(listing.out.toString("utf-8").split("\0").filter(Boolean).map((record) => {
                if (record.startsWith("? ")) return record.slice(2);
                const staged = /^\S (\d{6}) [0-9a-f]+ \d\t/.exec(record);
                if (!staged) throw new Error("Unrecognized repository file entry.");
                const path = record.slice(staged[0].length);
                modes.set(path, staged[1]!);
                return path;
            }))];
            // Looked up together: one by one, each is a trip to another thread and back, and a large repository runs out of time on that alone.
            for (let at = 0; at < paths.length; at += STAT_BATCH) {
                const batch = paths.slice(at, at + STAT_BATCH);
                const stats = await Promise.all(batch.map((path) => {
                    if (!safePath(path)) throw new Error("A repository path cannot be safely captured.");
                    return wt.stat(path, true).catch(() => {
                        result.skipped[path] = "Unreadable path; not captured, change unknown.";
                        return undefined;
                    });
                }));
                const toRead: { path: string; st: NonNullable<(typeof stats)[number]>; stamp: string; skip: (reason: string) => void }[] = [];
                for (let i = 0; i < batch.length; i++) {
                    inTime();
                    const path = batch[i]!, st = stats[i];
                    if (!st) continue; // A tracked file deleted from disk.
                    const stamp = `${st.dev}:${st.ino}:${st.mode}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
                    const skip = (reason: string) => {
                        result.skipped[path] = reason;
                        (result.skippedStamps ??= pathMap())[path] = stamp;
                    };
                    if (!st.isFile() && !st.isSymbolicLink()) {
                        // A tracked file replaced by a directory is deleted; its new
                        // untracked children are separate entries, not a nested repo.
                        if (st.isDirectory() && modes.has(path) && modes.get(path) !== "160000") continue;
                        if (st.isDirectory() && this.nested.has(path)) continue;
                        skip(st.isDirectory() ? "Submodule or nested repository contents are not captured." : "Not a regular file.");
                        continue;
                    }
                    if (st.size > MAX_SNAPSHOT_BYTES) { skip("Over 10 MB; not captured, change unknown."); continue; }
                    const cached = this.cache.get(path);
                    if (cached?.stamp === stamp) { entries.set(path, cached.entry); continue; }
                    toRead.push({ path, st, stamp, skip });
                }
                for (let k = 0; k < toRead.length; k += READ_AT_ONCE) {
                    const done = await Promise.allSettled(toRead.slice(k, k + READ_AT_ONCE).map(async ({ path, st, stamp, skip }) => {
                        const buf = st.isSymbolicLink() ? await readlink(join(this.root!, path), { encoding: "buffer" }).catch(() => undefined) : (await readRegular(join(this.root!, path), MAX_SNAPSHOT_BYTES))?.buf;
                        if (!buf) { skip("Unreadable, changed while being read, or over 10 MB; not captured."); return; }
                        inTime();
                        const after = await wt.stat(path, true).catch(() => undefined);
                        if (!after || `${after.dev}:${after.ino}:${after.mode}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) { result.skipped[path] = "Changed while being read; not captured."; return; }
                        const entry = { mode: st.isSymbolicLink() ? "120000" : st.mode & 0o100 ? "100755" : "100644", oid: await this.store(buf), size: buf.length };
                        read.push([path, { stamp, entry }]);
                        entries.set(path, entry);
                    }));
                    for (const d of done) if (d.status === "rejected") throw d.reason;
                    if ((this.pack?.bytes ?? 0) >= PACK_MAX_BYTES) await this.finishPack();
                }
            }
            inTime();
            const updates: string[] = [];
            for (const path of this.indexEntries.keys()) if (!entries.has(path)) updates.push(`0 ${"0".repeat(this.algo === "sha1" ? 40 : 64)}\t${path}\0`);
            for (const [path, e] of entries) {
                const was = this.indexEntries.get(path);
                if (was?.oid !== e.oid || was.mode !== e.mode) updates.push(`${e.mode} ${e.oid}\t${path}\0`);
            }
            // Nothing changed since the last one: it's the same tree.
            if (updates.length || !this.lastTree) {
                const planned = treeObjects(entries, this.algo, inTime);
                plannedTrees = new Set(planned.objects.keys());
                for (const [oid, bytes] of planned.objects) {
                    inTime();
                    await this.store(bytes, "tree", oid);
                }
                await this.writeOut();
                // Reset only on first use/reopen or after a failed index update.
                // Afterwards update just changed paths; object/stat caches avoid rehashing.
                if (!this.indexEntries.size) {
                    const reset = await this.run(["read-tree", "--empty"], deadline);
                    if (reset.code) throw new Error("Could not initialize the private snapshot index.");
                }
                if (updates.length) {
                    const update = await this.run(["update-index", "-z", "--index-info"], deadline, updates.join(""));
                    if (update.code || update.cut) throw new Error("Could not update the private snapshot index.");
                }
                const tree = await this.run(["write-tree"], deadline);
                const oid = tree.out.toString().trim();
                if (tree.code || oid !== planned.root) throw new Error("Could not write the private snapshot tree.");
                this.lastTree = oid;
            }
            await this.writeOut();
            this.indexEntries = entries;
            result.tree = this.lastTree;
            result.incomplete = Object.keys(result.skipped).length > 0;
        } catch (e) {
            result.incomplete = true;
            result.notes.push((e as Error).message);
            this.indexEntries.clear();
            this.lastTree = undefined;
            // What it read in the time it had isn't read again next time.
            await this.writeOut().catch(() => {});
        } finally {
            for (const [path, known] of read) if (this.stored.has(known.entry.oid)) this.cache.set(path, known);
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

    private async tree(capture: TurnCapture, deadline: number): Promise<Map<string, Entry>> {
        if (!capture.tree) throw new Error("This turn has an incomplete snapshot with no tree.");
        const r = await git(capture.root ?? this.cwd, ["ls-tree", "-r", "-l", "-z", capture.tree], { privateEnv: this.env(), deadline });
        if (r.code || r.cut) throw new Error("Snapshot objects are missing or unreadable; this turn is incomplete.");
        const entries = parseTree(r.out);
        if ([...entries.keys()].some((path) => !safePath(path))) throw new Error("Snapshot contains an unsafe repository path.");
        return entries;
    }

    private async compare(turn: SnapshotTurn, deadline: number): Promise<Change[]> {
        if (!turn.end) return [];
        if (turn.start.tree && turn.start.tree === turn.end.tree && !Object.keys(turn.start.skipped).length && !Object.keys(turn.end.skipped).length) return [];
        const [before, after] = await Promise.all([this.tree(turn.start, deadline), this.tree(turn.end, deadline)]);
        const skipped = pathMap(turn.start.skipped, turn.end.skipped);
        const changes: Change[] = [];
        for (const path of new Set([...before.keys(), ...after.keys(), ...Object.keys(skipped)])) {
            const old = before.get(path), now = after.get(path);
            if (Object.hasOwn(turn.start.skipped, path) && Object.hasOwn(turn.end.skipped, path) && own(turn.start.skippedStamps, path) && own(turn.start.skippedStamps, path) === own(turn.end.skippedStamps, path)) continue;
            if (!Object.hasOwn(skipped, path) && old?.oid === now?.oid && old?.mode === now?.mode) continue;
            changes.push({ path, old, now, indexed: true, change: Object.hasOwn(skipped, path) ? "modified" : !old ? "added" : !now ? "deleted" : old.mode.slice(0, 3) !== now.mode.slice(0, 3) ? "typechange" : "modified", note: skipped[path], kind: (now ?? old)?.mode === "120000" ? "link" : undefined });
        }
        return changes.sort((a, b) => a.path.localeCompare(b.path));
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
