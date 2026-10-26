// What git says changed in a session's folder, whoever changed it: the
// agent's edit tools, a CLI backend, a shell command, or you.
//
// Nothing here may run a program from the repository's config, because the
// folder may not be trusted yet. `git status` and `git diff` run a repo's
// clean filters (filter.<driver>.clean / .process, picked by .gitattributes)
// whenever they compare a working file with the index, even with
// --no-ext-diff and --no-textconv. So neither is used. Git only lists things
// here (refs, trees, the index, untracked paths) and hands over old contents
// as raw blobs (`cat-file --batch`, without --filters or --textconv). Working
// files are read from disk and compared in-process, by blob id. Nothing
// writes the index, refs or objects.

import { AsyncLocalStorage } from "async_hooks";
import { constants, type Stats } from "fs";
import type { BigIntStats } from "fs";
import { lstat, open, readlink } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import type { TurnSnapshots } from "../agent/turn-snapshots";
import { canonical } from "../agent/checkpoints";
import { gitArgv, gitEnv, REPO_VARS } from "../util/git";
import { redact } from "../util/redact";
import { coalesce, type Slot } from "./coalesce";
import { fileDiff, MAX_DIFF_INPUT, textOf } from "./diffs";
import type { GitChangesInfo, GitFileDiff, GitScope } from "./protocol";
import { RpcError } from "./rpc-error";

/** Files listed in one reply; the rest are counted. */
const MAX_FILES = 300;
/** Untracked paths read before giving up on counting them (an unignored node_modules). */
const MAX_UNTRACKED = 10_000;
/** A new folder with more untracked files than this is listed as one entry. */
const MAX_FOLDER_FILES = 200;
/** Branches offered as a base. */
const MAX_BASES = 300;
/** Hunk lines in one reply; later files' hunks are fetched when they're opened. */
const MAX_REPLY_LINES = 20_000;
/** File contents read for one reply's diffs. */
const MAX_REPLY_BYTES = 64 * 1024 * 1024;
/** Submodules whose checked-out commit is looked up (each is a git call). */
const MAX_SUBMODULES = 20;
const GIT_TIMEOUT_MS = 10_000;
const DEADLINE_MS = 20_000;

const GITLINK = "160000";
const SYMLINK = "120000";

// ---------------------------------------------------------------------------
// Running git

export interface GitOut {
    code: number;
    out: Buffer;
    /** Output stopped at maxBytes (and git with it). */
    cut: boolean;
    err: string;
}

/**
 * Up to `max` bytes of a stream; `cut` once it had more. A `skim` stream is
 * read to its end with the rest dropped, so the writer never sees a closed pipe.
 */
async function drain(stream: ReadableStream<Uint8Array>, max: number, skim = false): Promise<{ buf: Buffer; cut: boolean }> {
    const chunks: Uint8Array[] = [];
    let size = 0;
    const reader = stream.getReader();
    for (;;) {
        const { done, value } = await reader.read();
        if (done) return { buf: Buffer.concat(chunks), cut: false };
        if (size + value.length > max) {
            chunks.push(value.subarray(0, max - size));
            size = max;
            if (skim) {
                while (!(await reader.read()).done);
                return { buf: Buffer.concat(chunks), cut: true };
            }
            void reader.cancel().catch(() => {});
            return { buf: Buffer.concat(chunks), cut: true };
        }
        chunks.push(value);
        size += value.length;
    }
}

const tooLong = () => new RpcError("Looking for changes took too long in this folder.", "timeout");

/** One git call: argv only, a timeout (no later than the request's deadline), and no more than `maxBytes` of output. */
export function gitEnvironment(o: { env?: Record<string, string>; privateEnv?: Record<string, string> } = {}): Record<string, string> {
    const env: Record<string, string> = { ...gitEnv(), ...o.env };
    // Where the repository is comes from cwd alone, not from a variable the server happened to inherit.
    for (const k of REPO_VARS) delete env[k];
    // Only the snapshot owner supplies these, after inherited repository overrides are removed.
    if (o.privateEnv) {
        // Diagnostics may write arbitrary inherited trace paths or look like
        // incomplete-listing warnings. Private snapshots never inherit them.
        for (const k of Object.keys(env)) if (k.startsWith("GIT_TRACE")) delete env[k];
        Object.assign(env, o.privateEnv);
    }
    // No lazy fetches: in a partial clone, reading a missing object would otherwise reach out
    // to the promisor remote (and run its transport). And no transport at all, so nothing can
    // be fetched (and no ssh command run) even where git predates GIT_NO_LAZY_FETCH: listing
    // protocols allows only those, and this one doesn't exist.
    env.GIT_NO_LAZY_FETCH = "1";
    env.GIT_ALLOW_PROTOCOL = "cavvy-none";
    return env;
}

/**
 * A read pinned to one work tree and Git dir (gitChanges' `pin`): every git call in that folder
 * gets them as GIT_WORK_TREE and GIT_DIR, so its config (core.worktree) can't move the read
 * elsewhere between the check and the read. Calls in other folders (a submodule's) are left alone.
 */
const pinned = new AsyncLocalStorage<{ workTree: string; gitDir: string }>();

/**
 * One folder, however it's spelled: separators (Windows takes / and \ alike, and git writes /),
 * `.`, `..` and a trailing separator don't count. Case does: a folder whose name differs only in
 * case can be another one (a case-sensitive folder), so that's refused rather than taken. `p` is
 * the platform's path module (path.win32 in tests).
 */
export function samePath(a: string, b: string, p: { resolve: typeof resolve } = { resolve }): boolean {
    return p.resolve(a) === p.resolve(b);
}

export async function git(cwd: string, args: string[], o: { input?: string; maxBytes?: number; env?: Record<string, string>; privateEnv?: Record<string, string>; deadline?: number } = {}): Promise<GitOut> {
    const left = Math.min(GIT_TIMEOUT_MS, (o.deadline ?? Infinity) - Date.now());
    if (left <= 0) throw tooLong();
    const pin = pinned.getStore();
    const env = gitEnvironment(pin && samePath(cwd, pin.workTree) ? { ...o, privateEnv: { ...o.privateEnv, GIT_WORK_TREE: pin.workTree, GIT_DIR: pin.gitDir } } : o);
    const proc = Bun.spawn(gitArgv(args), {
        cwd,
        env,
        stdin: o.input === undefined ? "ignore" : new TextEncoder().encode(o.input),
        stdout: "pipe",
        stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), proc.kill()), left);
    try {
        const [out, err] = await Promise.all([
            drain(proc.stdout, o.maxBytes ?? 64 * 1024 * 1024).then((r) => (r.cut && proc.kill(), r)),
            drain(proc.stderr, 4096, true),
        ]);
        const code = await proc.exited;
        if (timedOut) throw new RpcError(`git ${args[0]} took too long in this folder.`, "timeout");
        return { code: out.cut ? 0 : code, out: out.buf, cut: out.cut, err: err.buf.toString("utf-8") };
    } finally {
        clearTimeout(timer);
    }
}

/** NUL-terminated records; one cut off at the end is dropped. */
function records(buf: Buffer): string[] {
    const parts = buf.toString("utf-8").split("\0");
    parts.pop();
    return parts;
}

const trimNl = (buf: Buffer) => buf.toString("utf-8").replace(/\n$/, "");

// ---------------------------------------------------------------------------
// Branches

interface Refs {
    /** Short name → full refname. */
    full: Map<string, string>;
    default?: string;
}

/** What the Branch view compares with when no base is picked: Cavvy's main branch, as a short name and its full ref. */
export async function defaultBase(root: string): Promise<{ name: string; ref: string } | undefined> {
    const refs = await listRefs(root, Date.now() + DEADLINE_MS);
    return refs.default ? { name: refs.default, ref: refs.full.get(refs.default)! } : undefined;
}

async function listRefs(root: string, deadline: number): Promise<Refs> {
    const [list, originHead] = await Promise.all([
        git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname) %(symref)", "refs/heads", "refs/remotes"], { maxBytes: 4 * 1024 * 1024, deadline }),
        git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { deadline }),
    ]);
    const full = new Map<string, string>();
    // Refnames can't hold spaces or control characters, so lines split cleanly.
    for (const line of list.out.toString("utf-8").split("\n")) {
        const [ref, symref] = line.split(" ");
        if (!ref || symref) continue; // origin/HEAD and other aliases
        const short = ref.replace(/^refs\/(heads|remotes)\//, "");
        if (!full.has(short)) full.set(short, ref);
    }
    // Cavvy's main branch (as in gitSnapshot): what origin/HEAD points at,
    // else main or master. The remote's copy, when there is one, is what a
    // branch was usually cut from; the local one is often behind.
    const fromOrigin = originHead.code === 0 ? trimNl(originHead.out).replace(/^refs\/remotes\//, "") : undefined;
    const choice = [fromOrigin, "main", "master", "origin/main", "origin/master"].find((b) => b && full.has(b));
    return { full, default: choice };
}

// ---------------------------------------------------------------------------
// The two sides

export interface Entry {
    mode: string;
    oid: string;
    /** Blob size: known for tree entries and files on disk. */
    size?: number;
    /** The blob id with CRLF line endings turned into LF (files that have them). */
    norm?: string;
    /** CRLFs exist even when the file is too large for a normalized id. */
    crlf?: boolean;
    /** Git's auto conversion sees this content as binary, so leaves it alone. */
    autoBinary?: boolean;
}

interface IndexEntry extends Entry {
    /** ls-files -v tag: S skip-worktree, lowercase assume-unchanged, M unmerged. */
    tag: string;
}

export function parseTree(buf: Buffer): Map<string, Entry> {
    const out = new Map<string, Entry>();
    for (const rec of records(buf)) {
        const m = /^(\d{6}) \w+ ([0-9a-f]+) +(\S+)\t/.exec(rec);
        if (!m) continue;
        out.set(rec.slice(m[0].length), { mode: m[1]!, oid: m[2]!, size: /^\d+$/.test(m[3]!) ? Number(m[3]) : undefined });
    }
    return out;
}

function parseIndex(buf: Buffer): Map<string, IndexEntry> {
    const out = new Map<string, IndexEntry>();
    for (const rec of records(buf)) {
        const m = /^(\S) (\d{6}) ([0-9a-f]+) (\d)\t/.exec(rec);
        if (!m) continue;
        const path = rec.slice(m[0].length);
        // A conflicted file has a row per stage; any of them stands for the path.
        if (!out.has(path) || m[4] === "0") out.set(path, { tag: m[1]!, mode: m[2]!, oid: m[3]! });
    }
    return out;
}

/** Blob ids by content, so files on disk can be compared with trees without asking git. */
export function blobId(data: Uint8Array, algo: Algo): string {
    const h = new Bun.CryptoHasher(algo);
    h.update(`blob ${data.length}\0`);
    h.update(data);
    return h.digest("hex");
}

type Algo = "sha1" | "sha256";

/** Ids of files already hashed, while their stat stays the same. */
type ContentId = Pick<Entry, "oid" | "norm" | "crlf" | "autoBinary">;
const idCache = new Map<string, ContentId & { stamp: string }>();

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * A regular file's bytes, opened without following a link and checked to
 * still be a regular file (a FIFO would block). undefined when it can't be read.
 */
export async function readRegular(abs: string, max: number): Promise<{ buf?: Buffer; size: number } | undefined> {
    const fh = await open(abs, OPEN_FLAGS).catch(() => undefined);
    if (!fh) return undefined;
    try {
        const st = await fh.stat();
        if (!st.isFile()) return undefined;
        if (st.size > max) return { size: st.size };
        // Read to a bound, not to EOF: the file may be growing.
        const chunks: Buffer[] = [];
        let total = 0;
        for (;;) {
            const chunk = Buffer.alloc(Math.min(256 * 1024, max + 1 - total));
            const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            chunks.push(chunk.subarray(0, bytesRead));
            total += bytesRead;
            if (total > max) return { size: total };
        }
        return { buf: Buffer.concat(chunks), size: total };
    } catch {
        return undefined;
    } finally {
        await fh.close().catch(() => {});
    }
}

/** A big file's blob id, read in chunks, within the request's time. */
async function streamId(abs: string, algo: Algo, inTime: () => void): Promise<ContentId | undefined> {
    const fh = await open(abs, OPEN_FLAGS).catch(() => undefined);
    if (!fh) return undefined;
    try {
        const st = await fh.stat();
        if (!st.isFile()) return undefined;
        const h = new Bun.CryptoHasher(algo);
        h.update(`blob ${st.size}\0`);
        const chunk = Buffer.alloc(1024 * 1024);
        let total = 0;
        const stats = new GitTextStats();
        for (;;) {
            inTime();
            const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            total += bytesRead;
            if (total > st.size) return { oid: "changing" };
            const bytes = chunk.subarray(0, bytesRead);
            stats.add(bytes);
            h.update(bytes);
        }
        return total === st.size ? { oid: h.digest("hex"), crlf: stats.crlf, autoBinary: stats.binary } : { oid: "changing" };
    } catch (e) {
        if (e instanceof RpcError) throw e;
        return undefined;
    } finally {
        await fh.close().catch(() => {});
    }
}

/**
 * Binary to git's auto line-ending conversion (convert.c gather_stats and
 * convert_is_binary): a lone CR, a NUL, or more than one non-printable byte
 * per 128 printable ones. BS, HT, ESC and FF count as printable, as do bytes
 * from 128 up; CR and LF count as neither; a final \032 isn't counted.
 */
export class GitTextStats {
    crlf = false;
    private printable = 0;
    private nonprintable = 0;
    private nul = false;
    private loneCr = false;
    private last = -1;

    add(buf: Uint8Array): void {
        for (const c of buf) {
            // A CR at the end of a chunk is decided by the next byte, or EOF.
            if (this.last === 13) {
                if (c === 10) this.crlf = true;
                else this.loneCr = true;
            }
            this.last = c;
            if (c === 13 || c === 10) continue;
            if (c === 0) this.nul = true;
            if (c === 127 || (c < 32 && c !== 8 && c !== 9 && c !== 27 && c !== 12)) this.nonprintable++;
            else this.printable++;
        }
    }

    get binary(): boolean {
        // Only the file's final byte gets the DOS EOF exemption, not each chunk's.
        const nonprintable = this.nonprintable - (this.last === 26 ? 1 : 0);
        return this.nul || this.loneCr || this.last === 13 || Math.floor(this.printable / 128) < nonprintable;
    }
}

export function gitSeesBinary(buf: Uint8Array): boolean {
    let printable = 0;
    let nonprintable = 0;
    for (let i = 0; i < buf.length; i++) {
        const c = buf[i]!;
        // Unlike streaming, the next byte and EOF are known: stop as soon as binary is certain.
        if (c === 0) return true;
        if (c === 13) {
            if (buf[i + 1] !== 10) return true;
            i++;
        } else if (c === 10) continue;
        else if (c === 127 || (c < 32 && c !== 8 && c !== 9 && c !== 27 && c !== 12)) nonprintable++;
        else printable++;
    }
    if (buf.length && buf[buf.length - 1] === 26) nonprintable--;
    return Math.floor(printable / 128) < nonprintable;
}

/** Whether an index blob is text with CRLFs, once per oid across collecting and rendering. */
export function indexHasCrlf(oid: string, blobs: Map<string, Buffer>, cache: Map<string, boolean>): boolean | undefined {
    const hit = cache.get(oid);
    if (hit !== undefined) return hit;
    const buf = blobs.get(oid);
    // A missing blob may become available in rendering; don't cache absence.
    if (!buf) return undefined;
    const result = !gitSeesBinary(buf) && buf.includes("\r\n");
    cache.set(oid, result);
    return result;
}

/**
 * Whether git's check-in turns this file's CRLFs into LFs (convert.c
 * crlf_to_git): always under `text`/`eol`; under auto, only for content it
 * doesn't see as binary, and not when the index's copy is text with CRLFs
 * (has_crlf_in_index). `index`: whether that copy is text with CRLF; null when
 * there is none (or it's known to have no CRLF); undefined when it couldn't be read, so no conversion
 * is assumed and a change is never hidden.
 */
export function convertsEol(mode: EolMode, working: { binary: boolean }, index: boolean | null | undefined): boolean {
    if (mode === "always") return true;
    if (mode !== "auto" || working.binary || index === undefined) return false;
    return !index;
}

async function fileId(abs: string, st: Stats, algo: Algo, inTime: () => void): Promise<ContentId> {
    const stamp = `${algo}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const hit = idCache.get(abs);
    if (hit?.stamp === stamp) return hit;
    let id: ContentId;
    if (st.size > MAX_DIFF_INPUT) id = (await streamId(abs, algo, inTime)) ?? { oid: "unreadable" };
    else {
        const r = await readRegular(abs, MAX_DIFF_INPUT);
        if (!r?.buf) id = { oid: "unreadable" };
        else {
            id = { oid: blobId(r.buf, algo) };
            if (r.buf.includes("\r\n")) {
                id.crlf = true;
                id.norm = blobId(Buffer.from(r.buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1"), algo);
                id.autoBinary = gitSeesBinary(r.buf);
            }
        }
    }
    if (idCache.size > 200_000) idCache.clear();
    idCache.set(abs, { stamp, ...id });
    return id;
}

/** What the working tree holds at one path: never through a symlinked folder, never following a link. */
export class WorkTree {
    private dirs = new Map<string, Promise<boolean>>();
    constructor(
        readonly root: string,
        private algo: Algo,
        private filemode: boolean,
        private inTime: () => void,
        private deadline: number,
    ) {}

    /**
     * Every folder on the way is a real folder, not a link that could lead out of the repo.
     * A folder swapped for a link between this check and the read isn't caught; only a
     * process already running as the user could do that, and it could read the file itself.
     */
    private inside(rel: string, strict = false): Promise<boolean> {
        const i = rel.lastIndexOf("/");
        if (i < 0) return Promise.resolve(true);
        const dir = rel.slice(0, i);
        const key = `${strict}:${dir}`;
        let ok = this.dirs.get(key);
        if (!ok) {
            ok = lstat(join(this.root, dir)).then(
                (st) => st.isDirectory() && this.inside(dir, strict),
                (e: NodeJS.ErrnoException) => {
                    if (strict && e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
                    return false;
                },
            );
            this.dirs.set(key, ok);
        }
        return ok;
    }

    /** Full-precision stat of a regular file, for comparing with the index's record. */
    async bigStat(rel: string): Promise<BigIntStats | undefined> {
        if (!(await this.inside(rel))) return undefined;
        const st = await lstat(join(this.root, rel), { bigint: true }).catch(() => undefined);
        return st?.isFile() ? st : undefined;
    }

    async stat(rel: string, strict = false): Promise<Stats | undefined> {
        if (!(await this.inside(rel, strict))) return undefined;
        return lstat(join(this.root, rel)).catch((e: NodeJS.ErrnoException) => {
            // Snapshots must distinguish deletion from a path they cannot read.
            if (strict && e.code !== "ENOENT" && e.code !== "ENOTDIR") throw e;
            return undefined;
        });
    }

    /** The path as an entry (mode and blob id), or null when nothing comparable is there. */
    async entry(rel: string, was?: Entry, hash = true): Promise<Entry | null> {
        const st = await this.stat(rel);
        if (!st) return null;
        const abs = join(this.root, rel);
        if (st.isSymbolicLink()) {
            const target = await readlink(abs, { encoding: "buffer" }).catch(() => undefined);
            return target ? { mode: SYMLINK, oid: blobId(target, this.algo), size: target.length } : { mode: SYMLINK, oid: "unreadable" };
        }
        // A folder where a file was: the file is gone (what's in the folder is untracked).
        if (st.isDirectory()) return null;
        if (!st.isFile()) return { mode: "other", oid: "other" };
        const exec = this.filemode ? (st.mode & 0o100 ? "100755" : "100644") : was && isFileMode(was.mode) ? was.mode : "100644";
        if (!hash) return { mode: exec, oid: "", size: st.size };
        // A big file of another size has changed; no need to read it all to know.
        if (st.size > MAX_DIFF_INPUT && was?.size !== undefined && was.size !== st.size) return { mode: exec, oid: "resized", size: st.size };
        return { mode: exec, size: st.size, ...(await fileId(abs, st, this.algo, this.inTime)) };
    }

    /** A submodule's checked-out commit, or undefined when it isn't checked out. */
    async submodule(rel: string): Promise<string | undefined> {
        const st = await this.stat(rel);
        if (!st?.isDirectory() || !(await lstat(join(this.root, rel, ".git")).catch(() => undefined))) return undefined;
        // The ceiling keeps git from walking up into this repository if the submodule's own .git is broken.
        const r = await git(join(this.root, rel), ["rev-parse", "-q", "--verify", "HEAD"], { env: { GIT_CEILING_DIRECTORIES: this.root }, deadline: this.deadline });
        return r.code === 0 ? trimNl(r.out) : undefined;
    }
}

// ---------------------------------------------------------------------------
// The index's stat data

/** What the index recorded from lstat(2) when git last looked at a file; 32-bit fields, as git keeps them. */
interface IndexStat {
    ctime: [bigint, bigint];
    mtime: [bigint, bigint];
    ino: bigint;
    uid: bigint;
    gid: bigint;
    size: bigint;
}

/**
 * Stat data for every stage-0 index entry, from `ls-files --debug`, and the
 * index file's own mtime (for racy entries). Its format is documented as
 * subject to change; an entry this can't read just isn't trusted as clean.
 */
async function indexStats(root: string, deadline: number): Promise<{ entries: Map<string, IndexStat>; mtime: bigint } | undefined> {
    const [list, where] = await Promise.all([git(root, ["ls-files", "--debug", "-s", "-z"], { deadline }), git(root, ["rev-parse", "--git-path", "index"], { deadline })]);
    if (list.code !== 0 || list.cut || where.code !== 0) return undefined;
    const file = trimNl(where.out);
    const st = await lstat(isAbsolute(file) ? file : join(root, file), { bigint: true }).catch(() => undefined);
    if (!st) return undefined;
    return { entries: parseDebug(list.out), mtime: st.mtimeNs };
}

export function parseDebug(buf: Buffer): Map<string, IndexStat> {
    const out = new Map<string, IndexStat>();
    const s = buf.toString("utf-8");
    let pos = 0;
    while (pos < s.length) {
        // "<mode> <oid> <stage>\t<path>\0", then indented "  key: value" lines.
        const nul = s.indexOf("\0", pos);
        if (nul < 0) break;
        const head = s.slice(pos, nul);
        pos = nul + 1;
        let block = "";
        while (s.startsWith("  ", pos)) {
            const nl = s.indexOf("\n", pos);
            const end = nl < 0 ? s.length : nl + 1;
            block += s.slice(pos, end);
            pos = end;
        }
        const m = /^\d{6} [0-9a-f]+ 0\t/.exec(head);
        if (!m) continue;
        const field = (k: string) => {
            const f = new RegExp(`(?:^|\\s)${k}: (\\d+)(?::(\\d+))?`).exec(block);
            return f ? ([BigInt(f[1]!), BigInt(f[2] ?? 0)] as [bigint, bigint]) : undefined;
        };
        const [ctime, mtime, ino, uid, gid, size] = ["ctime", "mtime", "ino", "uid", "gid", "size"].map(field);
        if (!ctime || !mtime || !ino || !uid || !gid || !size) continue;
        out.set(head.slice(m[0].length), { ctime, mtime, ino: ino[0], uid: uid[0], gid: gid[0], size: size[0] });
    }
    return out;
}

const u32 = (n: bigint) => BigInt.asUintN(32, n);
const NS = 1_000_000_000n;

/**
 * Whether a file's stat still matches its index entry, by git's own rules
 * (racy-git.adoc, core.checkStat, core.trustCtime): then git takes it as
 * unchanged without reading it. Nanoseconds count only where git recorded
 * them; an entry not older than the index itself is racy, so not trusted.
 */
export function statClean(st: BigIntStats, e: IndexStat | undefined, indexMtime: bigint, rules: { trustCtime: boolean; minimal: boolean }): boolean {
    if (!e) return false;
    const same = (ns: bigint, [sec, nsec]: [bigint, bigint]) => u32(ns / NS) === sec && (rules.minimal || nsec === 0n || ns % NS === nsec);
    if (u32(st.size) !== e.size || !same(st.mtimeNs, e.mtime)) return false;
    if (rules.trustCtime && !same(st.ctimeNs, e.ctime)) return false;
    if (!rules.minimal && (u32(st.ino) !== e.ino || u32(st.uid) !== e.uid || u32(st.gid) !== e.gid)) return false;
    const [sec, nsec] = e.mtime;
    const idxSec = indexMtime / NS;
    const racy = sec > idxSec || (sec === idxSec && (nsec === 0n || nsec >= indexMtime % NS));
    return !racy;
}

/** Attributes for paths, as check-attr reports them ("unspecified" when not set). */
async function attributes(root: string, paths: string[], deadline: number): Promise<Map<string, Record<string, string>>> {
    const r = await git(root, ["check-attr", "-z", "--stdin", "filter", "ident", "working-tree-encoding", "text", "eol"], { input: paths.join("\0") + "\0", deadline });
    const recs = records(r.out);
    const out = new Map<string, Record<string, string>>();
    for (let i = 0; i + 2 < recs.length; i += 3) out.set(recs[i]!, { ...out.get(recs[i]!), [recs[i + 1]!]: recs[i + 2]! });
    return out;
}

// ---------------------------------------------------------------------------
// Comparing

export interface Change {
    path: string;
    change: GitFileDiff["change"];
    old?: Entry;
    now?: Entry;
    from?: string;
    kind?: GitFileDiff["kind"];
    /** A folder entry: the untracked files in it. */
    count?: number;
    countAtLeast?: boolean;
    /** `now` is the index's copy (skip-worktree, assume-unchanged): show that, not the disk. */
    indexed?: boolean;
    /** No net change to show, but something git would still point out. */
    note?: string;
    /** The filter driver git runs on this file. */
    filter?: string;
}

const isFileMode = (mode: string) => mode === "100644" || mode === "100755";
const kindOf = (mode: string): GitFileDiff["kind"] => (mode === SYMLINK ? "link" : mode === GITLINK ? "submodule" : undefined);

/** Line-ending conversion on check-in: always, unless git already has CRLFs (auto), or none. */
export type EolMode = "always" | "auto" | undefined;

/** Drops items in place: no spread, which overflows the call stack at a few hundred thousand. */
export function removeWhere<T>(list: T[], gone: (t: T) => boolean): void {
    let kept = 0;
    for (const t of list) if (!gone(t)) list[kept++] = t;
    list.length = kept;
}

async function eachLimit<T>(items: T[], n: number, fn: (t: T) => Promise<void>): Promise<void> {
    let i = 0;
    await Promise.all(
        Array.from({ length: Math.min(n, items.length) }, async () => {
            while (i < items.length) await fn(items[i++]!);
        }),
    );
}

function boolConfig(v: string | undefined, fallback: boolean): boolean {
    if (v === undefined) return fallback;
    return !/^(false|no|off|0)$/i.test(v.trim());
}

/** Walks under way, so a pane and a panel asking at once share one, and one asking mid-walk gets the next. */
const inflight = new Map<string, Slot<GitChangesInfo>>();

/**
 * `pin`: read `cwd` (a work tree's root, links resolved) with this Git dir and as this work tree,
 * whatever its config says (another worktree, checked by session-worktrees.ts).
 */
export function gitChanges(cwd: string, req: { scope: GitScope; base?: string; path?: string; turnId?: number }, snapshots?: TurnSnapshots, pin?: { gitDir: string }): Promise<GitChangesInfo> {
    if (pin) return coalesce(inflight, JSON.stringify([cwd, pin.gitDir, req.scope, req.base, req.path]), () => pinned.run({ workTree: cwd, gitDir: pin.gitDir }, () => collect(cwd, req)));
    return coalesce(inflight, JSON.stringify([cwd, snapshots?.dir, req.scope, req.base, req.path, req.turnId]), async () => {
        if (req.scope === "turn" || req.scope === "last-turn") {
            if (snapshots) return snapshots.changes(req);
            const top = await git(cwd, ["rev-parse", "--show-toplevel"]);
            return { ...notRepo(req.scope, "No snapshot was recorded for this turn."), repo: top.code === 0, incomplete: true, snapshotAvailable: false, notes: ["No snapshot was recorded for this turn."] };
        }
        const result = await collect(cwd, req);
        return { ...result, turns: snapshots?.list().map(({ id, prompt, startedAt, endedAt }) => ({ id, prompt, startedAt, endedAt })) };
    });
}

function notRepo(scope: GitScope, reason: string): GitChangesInfo {
    return { repo: false, reason, scope, files: [], added: 0, removed: 0, tracked: true, bases: [], more: 0 };
}

async function collect(cwd: string, req: { scope: GitScope; base?: string; path?: string }): Promise<GitChangesInfo> {
    const deadline = Date.now() + DEADLINE_MS;
    const inTime = () => {
        if (Date.now() > deadline) throw tooLong();
    };
    let top: GitOut;
    try {
        top = await git(cwd, ["rev-parse", "--show-toplevel"], { deadline });
    } catch (e) {
        if (e instanceof RpcError) throw e;
        return notRepo(req.scope, "Git isn't available, so this shows the edits Cavvy made.");
    }
    if (top.code !== 0 || !top.out.length) {
        const reason = /dubious ownership/.test(top.err) ? "Git won't read this folder because another user owns it, so this shows the edits Cavvy made." : "This folder isn't a Git repository, so this shows the edits Cavvy made.";
        return notRepo(req.scope, reason);
    }
    // A folder's name can end in a newline; only git's own is taken off.
    let root = trimNl(top.out);
    // Pinned, git can only answer the pinned work tree; anything else and the calls below wouldn't be pinned.
    // Git spells it its own way (C:/wt for C:\wt); from here on it's the pin's spelling.
    const pin = pinned.getStore();
    if (pin) {
        if (!samePath(root, pin.workTree)) throw new RpcError("Git doesn't see this worktree where it was checked.", "not_found");
        root = pin.workTree;
    }
    const [head, branch, format, config, refs] = await Promise.all([
        git(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"], { deadline }),
        git(root, ["symbolic-ref", "-q", "HEAD"], { deadline }),
        git(root, ["rev-parse", "--show-object-format"], { deadline }),
        git(root, ["config", "-z", "--get-regexp", "^(core\\.(filemode|autocrlf|trustctime|checkstat)|filter\\..+\\.(clean|process))$"], { deadline }),
        listRefs(root, deadline),
    ]);
    const headSha = head.code === 0 ? trimNl(head.out) : undefined;
    const algo: Algo = format.code === 0 && trimNl(format.out) === "sha256" ? "sha256" : "sha1";
    const settings = new Map<string, string>();
    /** Filter drivers that would run on check-in (a filter attribute naming one without them does nothing). */
    const drivers = new Set<string>();
    for (const r of records(config.out)) {
        const key = r.slice(0, r.indexOf("\n"));
        const m = /^filter\.(.+)\.(clean|process)$/i.exec(key);
        if (m) drivers.add(m[1]!);
        else settings.set(key.toLowerCase(), r.slice(r.indexOf("\n") + 1));
    }
    const filemode = boolConfig(settings.get("core.filemode"), true);
    const autocrlf = settings.has("core.autocrlf") && /^(true|input|yes|on|1)$/i.test(settings.get("core.autocrlf")!.trim());
    const statRules = { trustCtime: boolConfig(settings.get("core.trustctime"), true), minimal: settings.get("core.checkstat")?.trim().toLowerCase() === "minimal" };
    const branchName = branch.code === 0 ? trimNl(branch.out).replace(/^refs\/heads\//, "") : undefined;

    let baseSha = headSha;
    let base: GitChangesInfo["base"];
    if (req.scope === "branch") {
        const name = req.base ?? refs.default;
        if (!name) throw new RpcError("There's no main branch to compare with. Pick a base branch.", "invalid");
        if (name.startsWith("-") || !refs.full.has(name)) throw new RpcError(`“${name.slice(0, 200)}” isn't a branch in this repository.`, "invalid");
        if (!headSha) throw new RpcError("This branch has no commits yet.", "invalid");
        const mb = await git(root, ["merge-base", headSha, refs.full.get(name)!], { deadline });
        if (mb.code !== 0 || !mb.out.length) throw new RpcError(`${branchName ?? "HEAD"} and ${name} share no history.`, "invalid");
        baseSha = trimNl(mb.out);
        base = { ref: name, sha: baseSha };
    }

    const [tree, index, others, folders] = await Promise.all([
        baseSha ? git(root, ["ls-tree", "-r", "-l", "-z", "--full-tree", baseSha], { deadline }) : undefined,
        // Reading the index (here and with --debug) may touch a split index's sharedindex file's
        // mtime: git's own way of keeping it from expiring, as any ls-files or status does.
        git(root, ["ls-files", "-s", "-v", "-z"], { deadline }),
        git(root, ["ls-files", "-z", "--others", "--exclude-standard"], { maxBytes: 4 * 1024 * 1024, deadline }),
        // The same, with wholly untracked folders as one path each ("dir/"), as `git status` shows them.
        git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--directory"], { maxBytes: 4 * 1024 * 1024, deadline }),
    ]);
    if (tree?.cut || index.cut) throw new RpcError("This repository has too many files to compare.", "limit");
    if ((tree && tree.code !== 0) || index.code !== 0) throw new RpcError("Git couldn't list this repository's files.");
    const old = tree ? parseTree(tree.out) : new Map<string, Entry>();
    const staged = parseIndex(index.out);
    const untracked = untrackedEntries(records(others.out), others.cut, records(folders.out));
    inTime();

    const wt = new WorkTree(root, algo, filemode, inTime, deadline);
    const indexEols = new Map<string, boolean>();
    /**
     * Why git would still list a file that's back as it was: a conflict left unresolved, or a
     * staged version (content or mode) that differs, so committing now would commit it.
     */
    const stillListed = (was: Entry, ix: IndexEntry | undefined): string | undefined => {
        if (ix?.tag === "M") return "Unmerged: the conflict isn't marked resolved.";
        if (req.scope !== "uncommitted") return undefined;
        if (!ix) return "Staged for deletion, though the file is still here.";
        if (ix.oid !== was.oid) return "Staged changes the file itself no longer has.";
        if (ix.mode !== was.mode) return `Staged mode change (${was.mode} → ${ix.mode}) the file itself no longer has.`;
        return undefined;
    };
    const changes: Change[] = [];
    /** Differ only in CRLF line endings: unchanged if git converts this path's endings. */
    const crlfOnly: Change[] = [];
    /** Raw equality can still change on check-in when attributes force CRLF conversion. */
    const rawEqual: Change[] = [];
    let submodules = 0;
    const paths = [...new Set([...old.keys(), ...staged.keys()])];
    await eachLimit(paths, 32, async (path) => {
        inTime();
        const was = old.get(path);
        const ix = staged.get(path);
        let now: Entry | null;
        let indexed = false;
        if (ix?.mode === GITLINK) {
            // A submodule is one entry, never recursed into: its checked-out commit, else the one
            // recorded (not checked out, or past the ones looked up). Gone, or a file now: that's a change.
            const st = await wt.stat(path);
            if (!st) now = null;
            else if (!st.isDirectory()) now = await wt.entry(path, was);
            else now = { mode: GITLINK, oid: (submodules++ < MAX_SUBMODULES ? await wt.submodule(path) : undefined) ?? ix.oid };
        } else if (ix && (ix.tag === "S" || /^[a-z]$/.test(ix.tag))) {
            // Skip-worktree and assume-unchanged: git doesn't look at the file, so neither does this.
            now = ix;
            indexed = true;
        } else now = await wt.entry(path, was);
        if (!was && !now) {
            // Staged as a new file, then deleted on disk: git still lists it ("AD").
            if (ix && req.scope === "uncommitted") changes.push({ path, change: "added", now: ix, indexed: true, kind: kindOf(ix.mode), note: "Staged as a new file, then deleted on disk." });
            return;
        }
        if (!was) return void changes.push({ path, change: "added", now: now!, kind: kindOf(now!.mode), indexed });
        if (!now) return void changes.push({ path, change: "deleted", old: was, kind: kindOf(was.mode) });
        const sameMode = was.mode === now.mode || (!filemode && isFileMode(was.mode) && isFileMode(now.mode));
        if (sameMode && was.oid === now.oid) {
            const note = stillListed(was, ix);
            const c: Change = { path, change: "modified", old: was, now, kind: kindOf(was.mode), note };
            if (!indexed && isFileMode(now.mode) && now.crlf) rawEqual.push(c);
            else if (note) changes.push(c);
            return;
        }
        const c: Change = { path, change: kindOf(was.mode) === kindOf(now.mode) && now.mode !== "other" ? "modified" : "typechange", old: was, now, kind: kindOf(now.mode) ?? kindOf(was.mode), indexed };
        if (sameMode && now.norm === was.oid) crlfOnly.push(c);
        else changes.push(c);
    });
    inTime();

    // Files git converts on check-in can differ on disk from their blob while git calls them
    // clean: a filter's smudged form (Git LFS: the real file, where the blob is a pointer),
    // $Id$ expansion, another encoding, CRLF endings. Converting here would mean running the
    // filter, so these are settled the way git settles most files: by the index's stat data.
    const tracked = (c: Change) => !c.indexed && !!c.now && isFileMode(c.now.mode) && staged.get(c.path)?.tag === "H" && isFileMode(staged.get(c.path)!.mode);
    const candidates = changes.filter((c) => (c.change === "added" || c.change === "modified" || c.change === "typechange") && tracked(c));
    // check-attr only reads .gitattributes; it runs nothing.
    const attrs = candidates.length || crlfOnly.length || rawEqual.length ? await attributes(root, [...candidates, ...crlfOnly, ...rawEqual].map((c) => c.path), deadline) : new Map<string, Record<string, string>>();
    const unset = (v?: string) => v === undefined || v === "unspecified" || v === "unset";
    /**
     * What git does with a path's line endings on check-in (gitattributes): `text`, or `eol`
     * with text unspecified, always converts; `text=auto` (and core.autocrlf, which means
     * auto everywhere) converts a text file unless git already has it with CRLFs.
     */
    const eolMode = (a: Record<string, string> = {}): EolMode => {
        if (a.text === "unset") return undefined;
        if (a.text === "set") return "always";
        if (a.text === "auto") return "auto";
        if (!unset(a.eol)) return "always";
        return autocrlf ? "auto" : undefined;
    };
    const eolOf = (path: string): EolMode => (attrs.has(path) ? eolMode(attrs.get(path)) : undefined);
    if (candidates.length || crlfOnly.length || rawEqual.length) {
        // Auto conversion depends on the index's copy. Where that's the base, it's the working
        // text normalized, so (the working text not binary to git) it holds no CR at all; where
        // it isn't (a branch's commits, something staged), it's read.
        const ixFor = (c: Change) => {
            const ix = staged.get(c.path);
            return ix && ix.oid !== c.old!.oid ? ix.oid : undefined;
        };
        const wanted = [...crlfOnly, ...rawEqual].filter((c) => eolOf(c.path) === "auto" && c.now!.autoBinary === false && ixFor(c)).map((c) => ixFor(c)!);
        const ixBlobs = wanted.length ? await blobs(root, [...new Set(wanted)], deadline) : new Map<string, Buffer>();
        for (const c of crlfOnly) {
            inTime();
            // Only paths whose endings git would convert are unchanged; others really did gain CRLFs.
            const ix = ixFor(c);
            if (!convertsEol(eolOf(c.path), { binary: !!c.now!.autoBinary }, ix ? indexHasCrlf(ix, ixBlobs, indexEols) : null)) changes.push(c);
            else {
                const note = stillListed(c.old!, staged.get(c.path));
                if (note) changes.push({ ...c, change: "modified", note });
            }
        }
        const normalize = new Set<Change>();
        for (const c of rawEqual) {
            inTime();
            // Auto preserves a raw-equal CRLF index; a different staged copy needs its
            // own check. Forced text/eol converts either, unless git trusts the stat.
            const ix = staged.get(c.path);
            const indexCrlf = !ix ? null : ix.oid === c.old!.oid ? undefined : indexHasCrlf(ix.oid, ixBlobs, indexEols);
            if (convertsEol(eolOf(c.path), { binary: c.now!.autoBinary !== false }, indexCrlf)) {
                c.note ??= eolOf(c.path) === "auto" && (c.now!.size ?? 0) > MAX_DIFF_INPUT ? "Too large to show" : "Line endings would be normalized on commit.";
                changes.push(c);
                normalize.add(c);
                if (tracked(c)) candidates.push(c);
            } else if (eolOf(c.path) === "auto" && c.now!.autoBinary === false && ix && ix.oid !== c.old!.oid && indexCrlf === undefined) {
                // Known text may normalize against a different index blob that is missing
                // or beyond the read budget. Keep it; known binary bytes never enter here.
                changes.push(c);
                if (tracked(c)) candidates.push(c);
            } else if (c.note) changes.push(c);
        }
        const settle = candidates
            .map((c) => {
                const a = attrs.get(c.path) ?? {};
                const filter = a.filter && drivers.has(a.filter) ? a.filter : undefined;
                // Big files get no CRLF-normalized id, so their endings are settled here too.
                const converted = normalize.has(c) || filter || a.ident === "set" || !unset(a["working-tree-encoding"]) || (eolMode(a) && (c.now!.size ?? 0) > MAX_DIFF_INPUT);
                return converted ? { c, filter } : undefined;
            })
            .filter((x) => x !== undefined);
        if (settle.length) {
            const index = await indexStats(root, deadline);
            const drop = new Set<Change>();
            await eachLimit(settle, 32, async ({ c, filter }) => {
                inTime();
                const ix = staged.get(c.path)!;
                const st = await wt.bigStat(c.path);
                if (index && st && ix.mode === c.now!.mode && statClean(st, index.entries.get(c.path), index.mtime, statRules)) {
                    // Unchanged since git last looked: what it would see is the index's copy.
                    if (c.old && c.old.oid === ix.oid && c.old.mode === ix.mode) return void drop.add(c);
                    c.now = { mode: ix.mode, oid: ix.oid };
                    c.indexed = true;
                    c.filter = filter;
                    if (normalize.has(c)) c.note = undefined;
                } else if (filter) {
                    c.filter = filter;
                    c.note = `Uses the repository's “${filter}” filter and may have changed on disk. Its diff isn't shown, because comparing it would mean running that filter.`;
                }
            });
            if (drop.size) removeWhere(changes, (c) => drop.has(c));
        }
    }

    // A path the base tracks is compared above, even if the index has since dropped it.
    for (const c of untracked.changes) if (!old.has(c.path)) changes.push(c);
    await findRenames(changes, wt, untracked.changes.length <= 2000, inTime);
    // As `git status` lists them: tracked changes, then untracked files.
    const rank = (c: Change) => (c.change === "untracked" ? 1 : 0);
    changes.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    inTime();

    // Relative to the session's folder, with ../ for the rest of the repository.
    const here = canonical(cwd);
    const shown = (rel: string) => relative(here, join(root, rel)) || ".";
    let listed = changes;
    let more = 0;
    // The path as a list gave it (a repository-relative name could be another file), or an
    // absolute one, as a turn card may have it.
    if (req.path !== undefined) {
        // Only the folder is resolved: a link named last is the change asked about, not its target.
        const want = isAbsolute(req.path) ? relative(here, join(canonical(dirname(req.path)), basename(req.path))) || "." : req.path;
        listed = changes.filter((c) => shown(c.path) === want).slice(0, 1);
    }
    else if (changes.length > MAX_FILES) {
        listed = changes.slice(0, MAX_FILES);
        more = changes.length - MAX_FILES;
    }

    // Every diff read from disk needs its line-ending rule, conflicted files and all.
    const unseen = listed.filter((c) => c.change !== "deleted" && !c.indexed && !c.kind && !attrs.has(c.path)).map((c) => c.path);
    if (unseen.length) for (const [path, a] of await attributes(root, unseen, deadline)) attrs.set(path, a);
    const files = await render(listed, { root, wt, shown, single: req.path !== undefined, deadline, eolOf, indexOid: (path) => staged.get(path)?.oid, indexEols });
    let added = 0;
    let removed = 0;
    for (const f of files) {
        added += f.added;
        removed += f.removed;
    }
    return {
        repo: true,
        scope: req.scope,
        files,
        added,
        removed,
        tracked: true,
        head: { branch: branchName, sha: headSha },
        base,
        bases: [...refs.full.keys()].slice(0, MAX_BASES),
        defaultBase: refs.default,
        more,
        ...(untracked.cut ? { moreAtLeast: true } : {}),
    };
}

/**
 * Untracked files one by one, except that a new folder holding many (an
 * unignored node_modules) is one entry with a count, and a repository inside
 * this one is one entry, not looked into.
 */
function untrackedEntries(flat: string[], flatCut: boolean, collapsed: string[]): { changes: Change[]; cut: boolean } {
    const cut = flatCut || flat.length > MAX_UNTRACKED;
    if (flat.length > MAX_UNTRACKED) flat = flat.slice(0, MAX_UNTRACKED);
    const last = flat[flat.length - 1] ?? "";
    const dirs = new Set(collapsed.filter((p) => p.endsWith("/")));
    const repos = new Set(flat.filter((p) => p.endsWith("/")));
    const inDir = new Map<string, string[]>();
    const changes: Change[] = [];
    for (const path of flat) {
        // Git lists a nested repository as "dir/", never its files.
        if (path.endsWith("/")) {
            changes.push({ path: path.slice(0, -1), change: "untracked", kind: "repo" });
            continue;
        }
        let dir: string | undefined;
        for (let i = path.indexOf("/"); i >= 0 && !dir; i = path.indexOf("/", i + 1)) if (dirs.has(path.slice(0, i + 1))) dir = path.slice(0, i + 1);
        if (!dir) changes.push({ path, change: "untracked" });
        else {
            const list = inDir.get(dir);
            if (list) list.push(path);
            else inDir.set(dir, [path]);
        }
    }
    for (const dir of dirs) {
        if (repos.has(dir)) continue; // a nested repository, already listed
        const files = inDir.get(dir) ?? [];
        // The flat list stopped inside this folder, or before it: its count is a floor.
        const partial = cut && (dir > last || last.startsWith(dir));
        if (!files.length && !partial) continue; // only ignored files inside
        if (files.length <= MAX_FOLDER_FILES && !partial) {
            for (const path of files) changes.push({ path, change: "untracked" });
            continue;
        }
        changes.push({ path: dir.slice(0, -1), change: "untracked", kind: "folder", count: files.length, countAtLeast: partial });
    }
    return { changes, cut };
}

/**
 * Exact renames only: a deleted file whose content turned up under a new name.
 * Cheap, since both ids are known; linear, even for 50k deleted empty files.
 */
export async function findRenames(changes: Change[], wt: WorkTree, hashUntracked: boolean, inTime: () => void): Promise<void> {
    /** Deleted files by blob id, each taken once (from the end). */
    const gone = new Map<string, Change[]>();
    const sizes = new Set<number | undefined>();
    for (const c of changes) {
        if (c.change !== "deleted" || !c.old || !isFileMode(c.old.mode)) continue;
        const bucket = gone.get(c.old.oid);
        if (bucket) bucket.push(c);
        else gone.set(c.old.oid, [c]);
        sizes.add(c.old.size);
    }
    if (!gone.size) return;
    const taken = new Set<Change>();
    for (const c of changes) {
        if (c.note || (c.change !== "added" && !(c.change === "untracked" && hashUntracked && !c.kind))) continue;
        inTime();
        // Same content means the same size: only those untracked files are worth hashing.
        if (!c.now) {
            const st = await wt.stat(c.path);
            if (!st?.isFile() || !sizes.has(st.size)) continue;
        }
        const now = c.now ?? (await wt.entry(c.path));
        if (!now || !isFileMode(now.mode)) continue;
        c.now = now;
        const from = gone.get(now.oid)?.pop();
        if (!from) continue;
        taken.add(from);
        c.change = "renamed";
        c.from = from.path;
        c.old = from.old;
    }
    if (taken.size) removeWhere(changes, (c) => taken.has(c));
}

/** Old contents for the listed files, as raw blobs: `cat-file --batch` without --filters runs no filter. */
export async function blobs(root: string, oids: string[], deadline: number, privateEnv?: Record<string, string>): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    if (!oids.length) return out;
    const r = await git(root, ["cat-file", "--batch"], { input: oids.join("\n") + "\n", maxBytes: MAX_REPLY_BYTES + oids.length * 100, deadline, privateEnv });
    const buf = r.out;
    let pos = 0;
    while (pos < buf.length) {
        const nl = buf.indexOf(10, pos);
        if (nl < 0) break;
        const m = /^([0-9a-f]+) (\w+) (\d+)$/.exec(buf.toString("utf-8", pos, nl));
        if (!m) {
            pos = nl + 1; // "<oid> missing"
            continue;
        }
        const size = Number(m[3]);
        if (nl + 1 + size > buf.length) break;
        if (m[2] === "blob") out.set(m[1]!, buf.subarray(nl + 1, nl + 1 + size));
        pos = nl + 1 + size + 1;
    }
    return out;
}

const short = (sha?: string) => (sha ? sha.slice(0, 7) : "none");
const statusOf = (c: Change): GitFileDiff["status"] => (c.change === "deleted" ? "deleted" : c.change === "added" || c.change === "untracked" ? "added" : "modified");

export interface RenderContext {
    root: string;
    wt: WorkTree;
    shown: (rel: string) => string;
    /** One file asked for by path: no reply budget. */
    single: boolean;
    deadline: number;
    eolOf: (path: string) => EolMode;
    /** The index's blob for a path: auto conversion leaves a file git has with CRLFs alone. */
    indexOid: (path: string) => string | undefined;
    indexEols?: Map<string, boolean>;
    readBlobs?: (oids: string[], deadline: number) => Promise<Map<string, Buffer>>;
}

export async function render(listed: Change[], { root, wt, shown, single, deadline, eolOf, indexOid, indexEols = new Map<string, boolean>(), readBlobs }: RenderContext): Promise<GitFileDiff[]> {
    const wanted = new Map<string, number>();
    const readable = (e?: Entry): e is Entry => !!e && (isFileMode(e.mode) || e.mode === SYMLINK) && (e.size ?? 0) <= MAX_DIFF_INPUT;
    for (const c of listed) {
        if (readable(c.old)) wanted.set(c.old.oid, c.old.size ?? 0);
        if (c.indexed && readable(c.now)) wanted.set(c.now.oid, c.now.size ?? wanted.get(c.now.oid) ?? 0);
        const ix = indexOid(c.path);
        if (ix && eolOf(c.path) === "auto" && !wanted.has(ix)) wanted.set(ix, 0);
    }
    // Old contents within the reply's budget; past it, files are fetched when opened.
    let budget = single ? Infinity : MAX_REPLY_BYTES;
    const take: string[] = [];
    for (const [oid, size] of wanted) {
        if (size > budget) continue;
        budget -= size;
        take.push(oid);
    }
    // Out of time, the old sides are left for each file's own request.
    const olds = await (readBlobs ? readBlobs(take, deadline) : blobs(root, take, deadline)).catch((e) => {
        if (e instanceof RpcError && e.code === "timeout") return new Map<string, Buffer>();
        throw e;
    });
    let lines = 0;
    const files: GitFileDiff[] = [];
    for (const c of listed) {
        const path = shown(c.path);
        const base: GitFileDiff = { path, status: statusOf(c), change: c.change, added: 0, removed: 0, hunks: [] };
        if (c.from) base.from = shown(c.from);
        if (c.filter) base.filter = c.filter;
        if (c.kind) base.kind = c.kind;
        const note = (n: string): GitFileDiff => ({ ...base, note: n });
        if (c.note) {
            files.push(note(c.note));
            continue;
        }
        if (c.kind === "folder") {
            const n = c.count ? `${c.count.toLocaleString("en-US")}${c.countAtLeast ? "+" : ""} untracked files` : "Untracked files (not counted)";
            files.push(note(`${n} in a new folder, not listed one by one.`));
            continue;
        }
        if (c.kind === "repo") {
            files.push(note("A Git repository inside this one. Its files aren't listed."));
            continue;
        }
        if (c.kind === "submodule" && (c.old?.mode ?? GITLINK) === GITLINK && (c.now?.mode ?? GITLINK) === GITLINK) {
            files.push(note(c.old && c.now ? `Submodule ${short(c.old.oid)} → ${short(c.now.oid)}` : c.old ? `Submodule removed (was at ${short(c.old.oid)})` : `Submodule added at ${short(c.now?.oid)}`));
            continue;
        }
        // Past the deadline, the rest are left for their own requests, which get a fresh one.
        if (Date.now() > deadline) {
            files.push({ ...base, deferred: true });
            continue;
        }
        const before = c.old ? oldSide(c.old, olds) : null;
        const after = c.change === "deleted" ? null : c.indexed ? oldSide(c.now!, olds) : await current(c, wt, budget);
        if (after && "bytes" in after) budget -= after.bytes;
        if (after && "link" in after) base.kind = "link";
        if ((before && "note" in before) || (after && "note" in after)) {
            files.push(note((before && "note" in before && before.note) || (after && "note" in after && after.note) || ""));
            continue;
        }
        if ((before && "later" in before) || (after && "later" in after)) {
            files.push({ ...base, deferred: true });
            continue;
        }
        const b = before ? redact(before.text) : null;
        // Git compares this path's working text with its line endings converted, so a one-line
        // edit in a CRLF checkout is one line, not every line, by the same rule as above.
        const ix = indexOid(c.path);
        const raw = after && "raw" in after ? after.raw : undefined;
        const mode = eolOf(c.path);
        const converted = raw && !c.indexed && convertsEol(mode, { binary: mode === "auto" && gitSeesBinary(raw) }, ix === undefined ? null : mode === "auto" ? indexHasCrlf(ix, olds, indexEols) : undefined);
        const a = after ? redact(converted ? after.text.replace(/\r\n/g, "\n") : after.text) : null;
        const d = fileDiff(path, b, a);
        const out: GitFileDiff = { ...base, ...d, status: base.status };
        if (c.old && c.now && c.old.mode !== c.now.mode && isFileMode(c.old.mode) && isFileMode(c.now.mode) && !d.hunks.length) out.note = `Mode changed ${c.old.mode} → ${c.now.mode}`;
        else if (c.change === "renamed" && !d.hunks.length) out.note = `Renamed from ${base.from}`;
        const n = d.hunks.reduce((s, h) => s + h.lines.length, 0);
        if (!single && lines + n > MAX_REPLY_LINES) {
            out.hunks = [];
            out.deferred = true;
            delete out.truncated;
        } else lines += n;
        files.push(out);
    }
    return files;
}

type Side = { text: string; bytes: number; link?: true; raw?: Buffer } | { note: string } | { later: true };

/** The old side, from its blob. */
function oldSide(e: Entry, olds: Map<string, Buffer>): Side {
    if (e.mode === GITLINK) return { note: `Was a submodule at ${short(e.oid)}` };
    if (!isFileMode(e.mode) && e.mode !== SYMLINK) return { note: "Not a regular file" };
    if ((e.size ?? 0) > MAX_DIFF_INPUT) return { note: "Too large to show" };
    const buf = olds.get(e.oid);
    if (!buf) return { later: true };
    if (buf.length > MAX_DIFF_INPUT) return { note: "Too large to show" };
    const text = textOf(buf);
    if (text === undefined) return { note: "Binary file" };
    return { text, bytes: buf.length };
}

/** The new side, read from disk. */
async function current(c: Change, wt: WorkTree, budget: number): Promise<Side | null> {
    const st = await wt.stat(c.path);
    if (!st) return null;
    if (st.isSymbolicLink()) {
        const target = await readlink(join(wt.root, c.path), { encoding: "buffer" }).catch(() => undefined);
        return target ? { text: target.toString("utf-8"), bytes: target.length, link: true } : { note: "Couldn't read the link" };
    }
    if (st.isDirectory()) return { note: c.now?.mode === GITLINK ? `Now a submodule at ${short(c.now.oid)}` : "Now a folder" };
    if (!st.isFile()) return { note: "Not a regular file" };
    if (st.size > MAX_DIFF_INPUT) return { note: "Too large to show" };
    if (st.size > budget) return { later: true };
    const r = await readRegular(join(wt.root, c.path), MAX_DIFF_INPUT);
    if (!r?.buf) return { note: r ? "Too large to show" : "Couldn't read the file" };
    const text = textOf(r.buf);
    if (text === undefined) return { note: "Binary file" };
    return { text, bytes: r.buf.length, raw: r.buf };
}
