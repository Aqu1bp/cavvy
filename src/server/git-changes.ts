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

import { constants, type Stats } from "fs";
import { lstat, open, readlink } from "fs/promises";
import { join } from "path";
import { canonical } from "../agent/checkpoints";
import { displayPath } from "../util/files";
import { gitArgv, gitEnv } from "../util/git";
import { redact } from "../util/redact";
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

const REPO_VARS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE"];

interface GitOut {
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

/** One git call: argv only, a timeout, and no more than `maxBytes` of output. */
async function git(cwd: string, args: string[], o: { input?: string; maxBytes?: number; env?: Record<string, string> } = {}): Promise<GitOut> {
    const env: Record<string, string> = { ...gitEnv(), ...o.env };
    // Where the repository is comes from cwd alone, not from a variable the server happened to inherit.
    for (const k of REPO_VARS) delete env[k];
    // No transport at all, so nothing can be fetched (and no ssh command run) even where git
    // predates GIT_NO_LAZY_FETCH: listing protocols allows only those, and this one doesn't exist.
    env.GIT_ALLOW_PROTOCOL = "harness-none";
    const proc = Bun.spawn(gitArgv(args), {
        cwd,
        env,
        stdin: o.input === undefined ? "ignore" : new TextEncoder().encode(o.input),
        stdout: "pipe",
        stderr: "pipe",
    });
    let timedOut = false;
    const timer = setTimeout(() => ((timedOut = true), proc.kill()), GIT_TIMEOUT_MS);
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

async function listRefs(root: string): Promise<Refs> {
    const [list, originHead] = await Promise.all([
        git(root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname) %(symref)", "refs/heads", "refs/remotes"], { maxBytes: 4 * 1024 * 1024 }),
        git(root, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"]),
    ]);
    const full = new Map<string, string>();
    // Refnames can't hold spaces or control characters, so lines split cleanly.
    for (const line of list.out.toString("utf-8").split("\n")) {
        const [ref, symref] = line.split(" ");
        if (!ref || symref) continue; // origin/HEAD and other aliases
        const short = ref.replace(/^refs\/(heads|remotes)\//, "");
        if (!full.has(short)) full.set(short, ref);
    }
    // Harness's main branch (as in gitSnapshot): what origin/HEAD points at,
    // else main or master. The remote's copy, when there is one, is what a
    // branch was usually cut from; the local one is often behind.
    const fromOrigin = originHead.code === 0 ? trimNl(originHead.out).replace(/^refs\/remotes\//, "") : undefined;
    const choice = [fromOrigin, "main", "master", "origin/main", "origin/master"].find((b) => b && full.has(b));
    return { full, default: choice };
}

// ---------------------------------------------------------------------------
// The two sides

interface Entry {
    mode: string;
    oid: string;
    /** Blob size: known for tree entries and files on disk. */
    size?: number;
    /** The blob id with CRLF line endings turned into LF (text files that have them). */
    norm?: string;
}

interface IndexEntry extends Entry {
    /** ls-files -v tag: S skip-worktree, lowercase assume-unchanged, M unmerged. */
    tag: string;
}

function parseTree(buf: Buffer): Map<string, Entry> {
    const out = new Map<string, Entry>();
    for (const rec of records(buf)) {
        const m = /^(\d{6}) \w+ ([0-9a-f]+) +(\S+)\t/.exec(rec);
        if (!m) continue;
        out.set(rec.slice(m[0].length), { mode: m[1]!, oid: m[2]!, size: m[3] === "-" ? undefined : Number(m[3]) });
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
function blobId(data: Uint8Array, algo: Algo): string {
    const h = new Bun.CryptoHasher(algo);
    h.update(`blob ${data.length}\0`);
    h.update(data);
    return h.digest("hex");
}

type Algo = "sha1" | "sha256";

/** Ids of files already hashed, while their stat stays the same. */
const idCache = new Map<string, { stamp: string; oid: string; norm?: string }>();

const OPEN_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

/**
 * A regular file's bytes, opened without following a link and checked to
 * still be a regular file (a FIFO would block). undefined when it can't be read.
 */
async function readRegular(abs: string, max: number): Promise<{ buf?: Buffer; size: number } | undefined> {
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
async function streamId(abs: string, algo: Algo, inTime: () => void): Promise<string | undefined> {
    const fh = await open(abs, OPEN_FLAGS).catch(() => undefined);
    if (!fh) return undefined;
    try {
        const st = await fh.stat();
        if (!st.isFile()) return undefined;
        const h = new Bun.CryptoHasher(algo);
        h.update(`blob ${st.size}\0`);
        const chunk = Buffer.alloc(1024 * 1024);
        let total = 0;
        for (;;) {
            inTime();
            const { bytesRead } = await fh.read(chunk, 0, chunk.length, null);
            if (!bytesRead) break;
            total += bytesRead;
            if (total > st.size) return "changing";
            h.update(chunk.subarray(0, bytesRead));
        }
        return total === st.size ? h.digest("hex") : "changing";
    } catch (e) {
        if (e instanceof RpcError) throw e;
        return undefined;
    } finally {
        await fh.close().catch(() => {});
    }
}

async function fileId(abs: string, st: Stats, algo: Algo, inTime: () => void): Promise<{ oid: string; norm?: string }> {
    const stamp = `${algo}:${st.ino}:${st.size}:${st.mtimeMs}:${st.ctimeMs}`;
    const hit = idCache.get(abs);
    if (hit?.stamp === stamp) return hit;
    let id: { oid: string; norm?: string };
    if (st.size > MAX_DIFF_INPUT) id = { oid: (await streamId(abs, algo, inTime)) ?? "unreadable" };
    else {
        const r = await readRegular(abs, MAX_DIFF_INPUT);
        if (!r?.buf) id = { oid: "unreadable" };
        else {
            id = { oid: blobId(r.buf, algo) };
            if (r.buf.includes("\r\n") && textOf(r.buf) !== undefined) id.norm = blobId(Buffer.from(r.buf.toString("latin1").replace(/\r\n/g, "\n"), "latin1"), algo);
        }
    }
    if (idCache.size > 200_000) idCache.clear();
    idCache.set(abs, { stamp, ...id });
    return id;
}

/** What the working tree holds at one path: never through a symlinked folder, never following a link. */
class WorkTree {
    private dirs = new Map<string, Promise<boolean>>();
    constructor(
        readonly root: string,
        private algo: Algo,
        private filemode: boolean,
        private inTime: () => void,
    ) {}

    /** Every folder on the way is a real folder, not a link that could lead out of the repo. */
    private inside(rel: string): Promise<boolean> {
        const i = rel.lastIndexOf("/");
        if (i < 0) return Promise.resolve(true);
        const dir = rel.slice(0, i);
        let ok = this.dirs.get(dir);
        if (!ok) {
            ok = lstat(join(this.root, dir)).then(
                (st) => st.isDirectory() && this.inside(dir),
                () => false,
            );
            this.dirs.set(dir, ok);
        }
        return ok;
    }

    async stat(rel: string): Promise<Stats | undefined> {
        if (!(await this.inside(rel))) return undefined;
        return lstat(join(this.root, rel)).catch(() => undefined);
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
        const r = await git(join(this.root, rel), ["rev-parse", "-q", "--verify", "HEAD"], { env: { GIT_CEILING_DIRECTORIES: this.root } });
        return r.code === 0 ? trimNl(r.out) : undefined;
    }
}

// ---------------------------------------------------------------------------
// Comparing

interface Change {
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
}

const isFileMode = (mode: string) => mode === "100644" || mode === "100755";
const kindOf = (mode: string): GitFileDiff["kind"] => (mode === SYMLINK ? "link" : mode === GITLINK ? "submodule" : undefined);

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

/** In-flight requests, so a pane and a panel asking at once share one walk. */
const inflight = new Map<string, Promise<GitChangesInfo>>();

export function gitChanges(cwd: string, req: { scope: GitScope; base?: string; path?: string }): Promise<GitChangesInfo> {
    const key = JSON.stringify([cwd, req.scope, req.base, req.path]);
    let p = inflight.get(key);
    if (!p) {
        p = collect(cwd, req).finally(() => inflight.delete(key));
        inflight.set(key, p);
    }
    return p;
}

function notRepo(scope: GitScope, reason: string): GitChangesInfo {
    return { repo: false, reason, scope, files: [], added: 0, removed: 0, tracked: true, bases: [], more: 0 };
}

async function collect(cwd: string, req: { scope: GitScope; base?: string; path?: string }): Promise<GitChangesInfo> {
    const deadline = Date.now() + DEADLINE_MS;
    const inTime = () => {
        if (Date.now() > deadline) throw new RpcError("Looking for changes took too long in this folder.", "timeout");
    };
    let top: GitOut;
    try {
        top = await git(cwd, ["rev-parse", "--show-toplevel"]);
    } catch (e) {
        if (e instanceof RpcError) throw e;
        return notRepo(req.scope, "Git isn't available, so this shows the edits Harness made.");
    }
    if (top.code !== 0 || !top.out.length) {
        const reason = /dubious ownership/.test(top.err) ? "Git won't read this folder because another user owns it, so this shows the edits Harness made." : "This folder isn't a Git repository, so this shows the edits Harness made.";
        return notRepo(req.scope, reason);
    }
    // A folder's name can end in a newline; only git's own is taken off.
    const root = trimNl(top.out);
    const [head, branch, format, config, refs] = await Promise.all([
        git(root, ["rev-parse", "-q", "--verify", "HEAD^{commit}"]),
        git(root, ["symbolic-ref", "-q", "--short", "HEAD"]),
        git(root, ["rev-parse", "--show-object-format"]),
        git(root, ["config", "-z", "--get-regexp", "^core\\.(filemode|autocrlf)$"]),
        listRefs(root),
    ]);
    const headSha = head.code === 0 ? trimNl(head.out) : undefined;
    const algo: Algo = format.code === 0 && trimNl(format.out) === "sha256" ? "sha256" : "sha1";
    const settings = new Map(records(config.out).map((r) => [r.slice(0, r.indexOf("\n")).toLowerCase(), r.slice(r.indexOf("\n") + 1)] as const));
    const filemode = boolConfig(settings.get("core.filemode"), true);
    const autocrlf = settings.has("core.autocrlf") && /^(true|input|yes|on|1)$/i.test(settings.get("core.autocrlf")!.trim());
    const branchName = branch.code === 0 ? trimNl(branch.out) : undefined;

    let baseSha = headSha;
    let base: GitChangesInfo["base"];
    if (req.scope === "branch") {
        const name = req.base ?? refs.default;
        if (!name) throw new RpcError("There's no main branch to compare with. Pick a base branch.", "invalid");
        if (name.startsWith("-") || !refs.full.has(name)) throw new RpcError(`“${name.slice(0, 200)}” isn't a branch in this repository.`, "invalid");
        if (!headSha) throw new RpcError("This branch has no commits yet.", "invalid");
        const mb = await git(root, ["merge-base", headSha, refs.full.get(name)!]);
        if (mb.code !== 0 || !mb.out.length) throw new RpcError(`${branchName ?? "HEAD"} and ${name} share no history.`, "invalid");
        baseSha = trimNl(mb.out);
        base = { ref: name, sha: baseSha };
    }

    const [tree, index, others, folders] = await Promise.all([
        baseSha ? git(root, ["ls-tree", "-r", "-l", "-z", "--full-tree", baseSha]) : undefined,
        git(root, ["ls-files", "-s", "-v", "-z"]),
        git(root, ["ls-files", "-z", "--others", "--exclude-standard"], { maxBytes: 4 * 1024 * 1024 }),
        // The same, with wholly untracked folders as one path each ("dir/"), as `git status` shows them.
        git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--directory"], { maxBytes: 4 * 1024 * 1024 }),
    ]);
    if (tree?.cut || index.cut) throw new RpcError("This repository has too many files to compare.", "limit");
    if ((tree && tree.code !== 0) || index.code !== 0) throw new RpcError("Git couldn't list this repository's files.");
    const old = tree ? parseTree(tree.out) : new Map<string, Entry>();
    const staged = parseIndex(index.out);
    const untracked = untrackedEntries(records(others.out), others.cut, records(folders.out));
    inTime();

    const wt = new WorkTree(root, algo, filemode, inTime);
    const changes: Change[] = [];
    /** Differ only in CRLF line endings: unchanged if git converts this path's endings. */
    const crlfOnly: Change[] = [];
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
        if (!was && !now) return;
        if (!was) return void changes.push({ path, change: "added", now: now!, kind: kindOf(now!.mode), indexed });
        if (!now) return void changes.push({ path, change: "deleted", old: was, kind: kindOf(was.mode) });
        const sameMode = was.mode === now.mode || (!filemode && isFileMode(was.mode) && isFileMode(now.mode));
        if (sameMode && was.oid === now.oid) {
            // The file is back as it was, but git would still say so: a conflict left unresolved, or
            // a staged version that differs (committing now would commit it).
            const staged = req.scope === "uncommitted" && (!ix ? "Staged for deletion, though the file is still here." : ix.oid !== was.oid ? "Staged changes the file itself no longer has." : undefined);
            const note = ix?.tag === "M" ? "Unmerged: the conflict isn't marked resolved." : staged;
            if (note) changes.push({ path, change: "modified", old: was, now, kind: kindOf(was.mode), note });
            return;
        }
        const c: Change = { path, change: kindOf(was.mode) === kindOf(now.mode) && now.mode !== "other" ? "modified" : "typechange", old: was, now, kind: kindOf(now.mode) ?? kindOf(was.mode), indexed };
        if (sameMode && now.norm === was.oid) crlfOnly.push(c);
        else changes.push(c);
    });
    inTime();
    if (crlfOnly.length) {
        // Only paths whose endings git converts are unchanged; others really did gain CRLFs.
        // check-attr only reads .gitattributes; it runs nothing.
        const attrs = await git(root, ["check-attr", "-z", "--stdin", "text", "eol"], { input: crlfOnly.map((c) => c.path).join("\0") + "\0" });
        const recs = records(attrs.out);
        const seen = new Map<string, Record<string, string>>();
        for (let i = 0; i + 2 < recs.length; i += 3) seen.set(recs[i]!, { ...seen.get(recs[i]!), [recs[i + 1]!]: recs[i + 2]! });
        const converts = (a: Record<string, string> = {}) => a.text !== "unset" && (a.text === "set" || a.text === "auto" || (a.eol ?? "unspecified") !== "unspecified" || autocrlf);
        for (const c of crlfOnly) if (!converts(seen.get(c.path))) changes.push(c);
    }

    // A path the base tracks is compared above, even if the index has since dropped it.
    changes.push(...untracked.changes.filter((c) => !old.has(c.path)));
    await findRenames(changes, wt, untracked.changes.length <= 2000);
    // As `git status` lists them: tracked changes, then untracked files.
    const rank = (c: Change) => (c.change === "untracked" ? 1 : 0);
    changes.sort((a, b) => rank(a) - rank(b) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    inTime();

    const here = canonical(cwd);
    const shown = (rel: string) => displayPath(join(root, rel), here);
    let listed = changes;
    let more = 0;
    // The path exactly as a list gave it: a repository-relative name could be another file.
    if (req.path !== undefined) listed = changes.filter((c) => shown(c.path) === req.path).slice(0, 1);
    else if (changes.length > MAX_FILES) {
        listed = changes.slice(0, MAX_FILES);
        more = changes.length - MAX_FILES;
    }

    const files = await render(listed, root, wt, shown, req.path !== undefined);
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
        else inDir.set(dir, [...(inDir.get(dir) ?? []), path]);
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

/** Exact renames only: a deleted file whose content turned up under a new name. Cheap, since both ids are known. */
async function findRenames(changes: Change[], wt: WorkTree, hashUntracked: boolean): Promise<void> {
    const gone = new Map<string, Change[]>();
    for (const c of changes) if (c.change === "deleted" && c.old && isFileMode(c.old.mode)) gone.set(c.old.oid, [...(gone.get(c.old.oid) ?? []), c]);
    if (!gone.size) return;
    // Same content means the same size: only those untracked files are worth hashing.
    const sizes = new Set([...gone.values()].flat().map((c) => c.old!.size));
    const taken = new Set<Change>();
    for (const c of changes) {
        if (c.change !== "added" && !(c.change === "untracked" && hashUntracked && !c.kind)) continue;
        if (!c.now) {
            const st = await wt.stat(c.path);
            if (!st?.isFile() || !sizes.has(st.size)) continue;
        }
        const now = c.now ?? (await wt.entry(c.path));
        if (!now || !isFileMode(now.mode)) continue;
        c.now = now;
        const from = gone.get(now.oid)?.find((d) => !taken.has(d));
        if (!from) continue;
        taken.add(from);
        c.change = "renamed";
        c.from = from.path;
        c.old = from.old;
    }
    for (let i = changes.length - 1; i >= 0; i--) if (taken.has(changes[i]!)) changes.splice(i, 1);
}

/** Old contents for the listed files, as raw blobs: `cat-file --batch` without --filters runs no filter. */
async function blobs(root: string, oids: string[]): Promise<Map<string, Buffer>> {
    const out = new Map<string, Buffer>();
    if (!oids.length) return out;
    const r = await git(root, ["cat-file", "--batch"], { input: oids.join("\n") + "\n", maxBytes: MAX_REPLY_BYTES + oids.length * 100 });
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

async function render(listed: Change[], root: string, wt: WorkTree, shown: (rel: string) => string, single: boolean): Promise<GitFileDiff[]> {
    const wanted = new Map<string, number>();
    const readable = (e?: Entry): e is Entry => !!e && (isFileMode(e.mode) || e.mode === SYMLINK) && (e.size ?? 0) <= MAX_DIFF_INPUT;
    for (const c of listed) {
        if (readable(c.old)) wanted.set(c.old.oid, c.old.size ?? 0);
        if (c.indexed && readable(c.now)) wanted.set(c.now.oid, 0);
    }
    // Old contents within the reply's budget; past it, files are fetched when opened.
    let budget = single ? Infinity : MAX_REPLY_BYTES;
    const take: string[] = [];
    for (const [oid, size] of wanted) {
        if (size > budget) continue;
        budget -= size;
        take.push(oid);
    }
    const olds = await blobs(root, take);
    let lines = 0;
    const files: GitFileDiff[] = [];
    for (const c of listed) {
        const path = shown(c.path);
        const base: GitFileDiff = { path, status: statusOf(c), change: c.change, added: 0, removed: 0, hunks: [] };
        if (c.from) base.from = shown(c.from);
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
        const a = after ? redact(after.text) : null;
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

type Side = { text: string; bytes: number; link?: true } | { note: string } | { later: true };

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
    return { text, bytes: r.buf.length };
}
