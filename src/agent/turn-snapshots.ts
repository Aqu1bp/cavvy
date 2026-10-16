// Raw working-tree snapshots, independent of edit tools and backend history.
// Version 1 journal: one complete turn record per line, later records replace
// earlier ones with the same checkpoint id. All objects belong to this session;
// no alternates, repository writes, filters, hooks, or network access are used.
// Git's loose object format is zlib(header + bytes); hashing/compressing in
// process avoids a subprocess per file and preserves the bytes on disk.

import { appendFileSync, chmodSync, mkdirSync, readFileSync } from "fs";
import { chmod, mkdir, readlink, rename, rm, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative } from "path";
import { deflateSync } from "zlib";
import { randomBytes } from "crypto";
import { FileHistory, MAX_SNAPSHOT_BYTES, canonical } from "./checkpoints";
import type { Session } from "./session";
import { blobId, blobs, git, parseTree, readRegular, render, WorkTree, type Change, type Entry } from "../server/git-changes";
import { coalesce, type Slot } from "../server/coalesce";
import { MAX_DIFF_INPUT } from "../server/diffs";
import type { GitChangesInfo, GitScope } from "../server/protocol";
import { redact } from "../util/redact";

export interface TurnCapture {
    tree?: string;
    root?: string;
    incomplete: boolean;
    notes: string[];
    skipped: Record<string, string>;
    /** Metadata only: unchanged omissions are not falsely counted as changed files. */
    skippedStamps?: Record<string, string>;
    durationMs: number;
}

export interface SnapshotTurn {
    version: 1;
    id: number;
    prompt: string;
    startedAt: number;
    endedAt?: number;
    start: TurnCapture;
    end?: TurnCapture;
    /** Absolute paths, for the cumulative Changes badge, including omitted files. */
    changed?: string[];
}

const instances = new WeakMap<FileHistory, WeakMap<Session, TurnSnapshots>>();
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const POLICY = "Ignored files are not captured. Concurrent sessions in this repository see each other's changes. Submodule and nested repository contents are not captured.";
const safePath = (p: string) => p.length > 0 && !isAbsolute(p) && !p.split("/").some((part) => part === ".." || part.toLowerCase() === ".git");

/**
 * Tree ids write-tree can create, computed before it runs. Git creates loose
 * trees read-only (0400); only these objects need chmod, even if Git times out
 * after writing a subtree. Never scan the session's historical object store.
 */
function treeObjects(entries: Map<string, Entry>, algo: "sha1" | "sha256", inTime: () => void): { root: string; ids: Set<string> } {
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
    const ids = new Set<string>();
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
        ids.add(oid);
        return oid;
    };
    return { root: tree(root), ids };
}

export class TurnSnapshots {
    private turns = new Map<number, SnapshotTurn>();
    private active?: SnapshotTurn;
    private root?: string;
    private algo: "sha1" | "sha256" = "sha1";
    private cache = new Map<string, { stamp: string; entry: Entry }>();
    private indexEntries = new Map<string, Entry>();
    private hardened = new Set<string>();
    private inflight = new Map<string, Slot<GitChangesInfo>>();
    private saved = false;
    private stopped = false;
    private pending = new Set<Promise<void>>();
    private failure?: string;
    private readonly storage: string;
    private readonly journal: string;

    constructor(readonly dir: string, readonly cwd: string, private options: { budgetMs?: number } = {}) {
        this.storage = join(dir, "turn-snapshots");
        this.journal = join(dir, "turn-snapshots.jsonl");
        let lines: string;
        try { lines = readFileSync(this.journal, "utf-8"); } catch { return; }
        for (const line of lines.split("\n")) {
            try {
                const r = JSON.parse(line) as SnapshotTurn;
                if (r.version !== 1 || !Number.isSafeInteger(r.id) || typeof r.prompt !== "string" || !this.validCapture(r.start) || (r.end && !this.validCapture(r.end))) continue;
                this.turns.set(r.id, r);
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

    private validCapture(c: TurnCapture): boolean {
        return !!c && (!c.tree || OID.test(c.tree)) && Array.isArray(c.notes) && !!c.skipped && typeof c.skipped === "object" && (!c.root || isAbsolute(c.root));
    }

    list(): SnapshotTurn[] {
        return [...this.turns.values()].sort((a, b) => a.id - b.id);
    }

    changedPaths(): string[] {
        return [...new Set(this.list().flatMap((t) => t.changed ?? []))];
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

    /** A steering boundary is both the preceding turn's end and the next one's start. */
    begin(id: number, prompt: string): Promise<void> {
        return this.record(async () => {
            if (this.stopped) return;
            const captured = await this.capture();
            if (!captured || this.stopped) return; // Not a repository, or this session was let go.
            if (this.active) await this.finish(structuredClone(captured));
            if (this.stopped) return;
            this.active = { version: 1, id, prompt: redact(prompt).slice(0, 2000), startedAt: Date.now(), start: captured };
            this.persist(this.active);
        });
    }

    end(): Promise<void> {
        return this.record(async () => {
            if (!this.active || this.stopped) return;
            const captured = await this.capture();
            if (this.stopped) return;
            await this.finish(captured ?? { incomplete: true, notes: ["The repository is no longer available."], skipped: {}, durationMs: 0 });
        });
    }

    /** Retire before releasing the session lock: no late end, or index writes alongside a reopened session. */
    async stop(): Promise<void> {
        this.stopped = true;
        this.active = undefined;
        await Promise.allSettled([...this.pending]);
    }

    private record(work: () => Promise<void>): Promise<void> {
        const pending = work();
        this.pending.add(pending);
        return pending.finally(() => { this.pending.delete(pending); });
    }

    private async finish(captured: TurnCapture) {
        const turn: SnapshotTurn = { ...this.active!, end: captured, endedAt: Date.now() };
        this.active = undefined;
        try {
            const changes = await this.compare(turn, Date.now() + 2000);
            turn.changed = changes.map((c) => join(turn.start.root ?? this.cwd, c.path));
        } catch {
            captured.incomplete = true;
            captured.notes.push("The snapshot comparison is unavailable; some objects may be missing.");
        }
        if (!this.stopped) this.persist(turn);
    }

    private async store(buf: Buffer): Promise<string> {
        const oid = blobId(buf, this.algo);
        const folder = join(this.storage, "objects", oid.slice(0, 2));
        const path = join(folder, oid.slice(2));
        if (this.hardened.has(path)) return oid;
        await mkdir(folder, { recursive: true, mode: 0o700 });
        await chmod(folder, 0o700);
        const tmp = `${path}.${randomBytes(4).toString("hex")}.tmp`;
        // No Git filters or EOL conversion: precisely the object format used
        // by hash-object --no-filters, with a bounded read of the source file.
        await writeFile(tmp, deflateSync(Buffer.concat([Buffer.from(`blob ${buf.length}\0`), buf]), { level: 1 }), { mode: 0o600 });
        await rename(tmp, path);
        this.hardened.add(path);
        return oid;
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
        const result: TurnCapture = { incomplete: false, notes: [], skipped: {}, durationMs: 0 };
        let plannedTrees = new Set<string>();
        const inTime = () => {
            if (this.stopped) throw new Error("The snapshot session was closed.");
            if (Date.now() >= deadline) throw new Error("Snapshot exceeded its time budget (2 seconds by default).");
        };
        try {
            inTime();
            const metadataEnv = { GIT_NO_REPLACE_OBJECTS: "1" };
            const top = await git(this.cwd, ["rev-parse", "--show-toplevel"], { deadline, privateEnv: metadataEnv });
            if (top.code !== 0) return undefined;
            this.root = top.out.toString().replace(/\n$/, "");
            result.root = this.root;
            const [format, listing] = await Promise.all([
                git(this.root, ["rev-parse", "--show-object-format"], { deadline, privateEnv: metadataEnv }),
                git(this.root, ["ls-files", "-z", "-t", "--stage", "--cached", "--others", "--exclude-standard"], { maxBytes: 16 * 1024 * 1024, deadline, privateEnv: metadataEnv }),
            ]);
            if (format.code || listing.code || listing.cut) throw new Error("The repository file list is unavailable or exceeds the snapshot budget.");
            // ls-files can succeed while warning that an untracked directory
            // could not be opened. That list cannot establish deletions.
            if (listing.err.trim()) throw new Error(`The repository file list is incomplete: ${redact(listing.err.trim())}`);
            this.algo = format.out.toString().trim() === "sha256" ? "sha256" : "sha1";
            this.ensure();
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
            for (const path of paths) {
                inTime();
                if (!safePath(path)) throw new Error("A repository path cannot be safely captured.");
                const st = await wt.stat(path, true).catch(() => {
                    result.skipped[path] = "Unreadable path; not captured, change unknown.";
                    return undefined;
                });
                if (!st) continue; // A tracked file deleted from disk.
                const stamp = `${st.dev}:${st.ino}:${st.mode}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
                const skip = (reason: string) => {
                    result.skipped[path] = reason;
                    (result.skippedStamps ??= {})[path] = stamp;
                };
                if (!st.isFile() && !st.isSymbolicLink()) {
                    // A tracked file replaced by a directory is deleted; its new
                    // untracked children are separate entries, not a nested repo.
                    if (st.isDirectory() && modes.has(path) && modes.get(path) !== "160000") continue;
                    skip(st.isDirectory() ? "Submodule or nested repository contents are not captured." : "Not a regular file.");
                    continue;
                }
                if (st.size > MAX_SNAPSHOT_BYTES) { skip("Over 10 MB; not captured, change unknown."); continue; }
                const cached = this.cache.get(path);
                if (cached?.stamp === stamp) { entries.set(path, cached.entry); continue; }
                const buf = st.isSymbolicLink() ? await readlink(join(this.root, path), { encoding: "buffer" }).catch(() => undefined) : (await readRegular(join(this.root, path), MAX_SNAPSHOT_BYTES))?.buf;
                if (!buf) { skip("Unreadable, changed while being read, or over 10 MB; not captured."); continue; }
                inTime();
                const after = await wt.stat(path, true).catch(() => undefined);
                if (!after || `${after.dev}:${after.ino}:${after.mode}:${after.size}:${after.mtimeMs}:${after.ctimeMs}` !== stamp) { result.skipped[path] = "Changed while being read; not captured."; continue; }
                const entry = { mode: st.isSymbolicLink() ? "120000" : st.mode & 0o100 ? "100755" : "100644", oid: await this.store(buf), size: buf.length };
                this.cache.set(path, { stamp, entry });
                entries.set(path, entry);
            }
            inTime();
            const planned = treeObjects(entries, this.algo, inTime);
            plannedTrees = planned.ids;
            // Reset only on first use/reopen or after a failed index update.
            // Afterwards update just changed paths; object/stat caches avoid rehashing.
            if (!this.indexEntries.size) {
                const reset = await this.run(["read-tree", "--empty"], deadline);
                if (reset.code) throw new Error("Could not initialize the private snapshot index.");
            }
            const updates: string[] = [];
            for (const path of this.indexEntries.keys()) if (!entries.has(path)) updates.push(`0 ${"0".repeat(this.algo === "sha1" ? 40 : 64)}\t${path}\0`);
            for (const [path, e] of entries) {
                const was = this.indexEntries.get(path);
                if (was?.oid !== e.oid || was.mode !== e.mode) updates.push(`${e.mode} ${e.oid}\t${path}\0`);
            }
            if (updates.length) {
                const update = await this.run(["update-index", "-z", "--index-info"], deadline, updates.join(""));
                if (update.code || update.cut) throw new Error("Could not update the private snapshot index.");
            }
            const tree = await this.run(["write-tree"], deadline);
            const oid = tree.out.toString().trim();
            if (tree.code || oid !== planned.root) throw new Error("Could not write the private snapshot tree.");
            this.indexEntries = entries;
            result.tree = oid;
            result.incomplete = Object.keys(result.skipped).length > 0;
        } catch (e) {
            result.incomplete = true;
            result.notes.push((e as Error).message);
            this.indexEntries.clear();
        } finally {
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
        return parseTree(r.out);
    }

    private async compare(turn: SnapshotTurn, deadline: number): Promise<Change[]> {
        if (!turn.end) return [];
        const [before, after] = await Promise.all([this.tree(turn.start, deadline), this.tree(turn.end, deadline)]);
        const skipped = { ...turn.start.skipped, ...turn.end.skipped };
        const changes: Change[] = [];
        for (const path of new Set([...before.keys(), ...after.keys(), ...Object.keys(skipped)])) {
            const old = before.get(path), now = after.get(path);
            if (turn.start.skipped[path] && turn.end.skipped[path] && turn.start.skippedStamps?.[path] && turn.start.skippedStamps[path] === turn.end.skippedStamps?.[path]) continue;
            if (!skipped[path] && old?.oid === now?.oid && old?.mode === now?.mode) continue;
            changes.push({ path, old, now, indexed: true, change: skipped[path] ? "modified" : !old ? "added" : !now ? "deleted" : old.mode.slice(0, 3) !== now.mode.slice(0, 3) ? "typechange" : "modified", note: skipped[path], kind: (now ?? old)?.mode === "120000" ? "link" : undefined });
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
