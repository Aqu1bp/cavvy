// The other worktrees of a session's repository that a turn works in: an agent that entered one, sub-agents
// that each made their own. A turn's snapshot covers only the session's own folder (turn-snapshots.ts), so
// as a turn starts every worktree inside the main checkout's folder (.claude/worktrees, say) gets a token: its
// HEAD, branch and index file's stamp, without reading its files or its index. As it ends, a worktree the turn reached
// whose token changed, that appeared, or with a file changed since it began (by ctime) was worked in; it's summed
// up as the diff reader shows another worktree (git-changes.ts, branch scope): its branch against the main
// branch, committed or not. Only reached worktrees have their files read, so many sessions in many worktrees of
// a large repository don't each read all of them every turn.
//
// As in the snapshot, nothing here runs a program the repository names: no `git status` or working-tree diff
// (a clean or process filter would run), only listings and stat; the summary is the diff reader's own pinned,
// filter-safe read. A worktree is read only once its folder is checked to be that worktree (as session-worktrees.ts checks).

import { createHash } from "crypto";
import { lstatSync, readFileSync, realpathSync } from "fs";
import { lstat, readFile } from "fs/promises";
import { dirname, join, relative, resolve } from "path";
import { git, gitChanges } from "../server/git-changes";
import type { GitChangesInfo, TurnPlace } from "../server/protocol";
import { sameFolder } from "../server/session-worktrees";
import { normalPath, worktreeOf } from "../server/worktree-agents";

/** Worktrees marked and summed up per turn, at most: past this many, the rest go unseen. */
export const MAX_PLACES = 16;
/** The files a place lists, the most lines changed first. */
const TOP = 6;
/** A token that couldn't be taken: neither it nor what it's compared with says anything. */
export const UNKNOWN = "?";
/**
 * A worktree marked at a turn's start as there, its token not taken: whether it moved is told at the end, for the
 * few the turn reached, by when its files were written (movedSince).
 */
export const THERE = "+";
/** Files stamped at once. */
const STAT_WIDTH = 32;

/**
 * Git, as the snapshot's own reads run it: privately (nothing inherited, a GIT_TRACE path say, writes trace files
 * or slips warnings into what's read; no replace refs), and, given a checked worktree, pinned to its folder and
 * Git dir so its config can't move the read elsewhere.
 */
function run(cwd: string, args: string[], o: { deadline: number; maxBytes?: number; pin?: Checked }) {
    const pin: Record<string, string> = o.pin ? { GIT_DIR: o.pin.gitDir, GIT_WORK_TREE: o.pin.real } : {};
    return git(cwd, args, { deadline: o.deadline, maxBytes: o.maxBytes, privateEnv: { GIT_NO_REPLACE_OBJECTS: "1", ...pin } });
}

export interface Worktree {
    path: string;
    branch?: string;
    main: boolean;
}

/** A worktree whose folder session-worktrees.ts found to be that worktree: its real folder and its own Git dir. */
export interface Checked extends Worktree {
    real: string;
    gitDir: string;
}

/**
 * The repository's worktrees as `git worktree list` gives them, but bare and prunable ones; the main checkout first.
 * Undefined when git can't list them: not knowing which there are isn't the same as there being none.
 */
export async function listWorktrees(root: string, deadline: number): Promise<Worktree[] | undefined> {
    const r = await run(root, ["worktree", "list", "--porcelain", "-z"], { deadline, maxBytes: 1024 * 1024 }).catch(() => undefined);
    if (!r || r.code || r.cut) return undefined;
    const out: Worktree[] = [];
    let cur: { path?: string; branch?: string; skip?: boolean; first: boolean } = { first: true };
    // Fields end in NUL; an empty one ends a worktree's record.
    for (const field of r.out.toString("utf-8").split("\0")) {
        if (!field) {
            if (cur.path && !cur.skip) out.push({ path: cur.path, branch: cur.branch, main: cur.first });
            if (cur.path) cur = { first: false };
            continue;
        }
        if (field.startsWith("worktree ")) cur.path = field.slice(9);
        else if (field.startsWith("branch ")) cur.branch = field.slice(7).replace(/^refs\/heads\//, "");
        else if (field === "bare" || field.startsWith("prunable")) cur.skip = true;
    }
    return out;
}

/**
 * The repository's worktrees (listWorktrees), listed again only once something that decides them has changed: the
 * common Git dir's worktrees folder (one added or removed), a worktree's HEAD (its branch), or a worktree's folder
 * (gone: prunable). Without a common Git dir to watch (a bare or unusual layout), listed every time.
 */
export class WorktreeList {
    private last?: { list: Worktree[]; paths: string[]; stamps: string[] };

    async get(root: string, deadline: number): Promise<Worktree[] | undefined> {
        const last = this.last;
        if (last && last.paths.every((p, i) => listStamp(p) === last.stamps[i])) return last.list;
        const started = Date.now();
        const list = await listWorktrees(root, deadline);
        this.last = undefined;
        if (!list) return list;
        const paths = decidedBy(list);
        const stamps = paths?.map(listStamp);
        // Something that changed once the listing had begun may not be in it, so it isn't taken as what it says (a
        // file's time is a little behind the clock: kernels stamp files with a coarse one).
        if (paths && stamps && !stamps.some((s) => s === "?" || Number(s.split(":")[3] ?? 0) >= started - 50)) this.last = { list, paths, stamps };
        return list;
    }
}

/** A path's kind, inode, size and time (its folder's own time, for a folder): "-" for nothing there. */
function listStamp(path: string): string {
    try {
        const st = lstatSync(path, { throwIfNoEntry: false });
        return st ? `${st.mode}:${st.ino}:${st.isFile() ? st.size : 0}:${st.mtimeMs}` : "-";
    } catch {
        return "?";
    }
}

/** What a listing of `list` depends on, as paths; undefined when its common Git dir isn't a folder in the main worktree. */
function decidedBy(list: readonly Worktree[]): string[] | undefined {
    const main = list.find((w) => w.main);
    if (!main) return undefined;
    const common = join(main.path, ".git");
    try {
        if (!lstatSync(common).isDirectory()) return undefined;
    } catch {
        return undefined;
    }
    const paths = [join(common, "worktrees"), join(common, "HEAD")];
    for (const w of list) {
        if (w.main) continue;
        paths.push(w.path, join(w.path, ".git"));
        try {
            const named = /^gitdir: (.+)\n?$/.exec(readFileSync(join(w.path, ".git"), "utf-8"))?.[1];
            if (named) paths.push(join(resolve(w.path, named), "HEAD"));
        } catch {
            // Gone: its folder's stamp says so.
        }
    }
    return paths;
}

const within = (path: string, dir: string) => path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * The worktrees beside the session's own folder: the main checkout and the others inside its folder first, then those
 * elsewhere (one an agent made beside the checkout). A turn gets one only if it reached it (reachedPlaces).
 */
export function nearby(all: readonly Worktree[], own: string): Worktree[] {
    const main = all.find((w) => w.main);
    if (!main) return [];
    const others = all.filter((w) => w.path !== own);
    const inside = (w: Worktree) => w.main || within(w.path, main.path);
    return [...others.filter(inside), ...others.filter((w) => !inside(w))].slice(0, MAX_PLACES);
}

/** The repository-relative folders of `places` inside `root`, as the snapshot's file list names them (with and without the slash). */
export function insideRoot(places: readonly Worktree[], root: string): Set<string> {
    const out = new Set<string>();
    for (const w of places) {
        if (!within(w.path, root)) continue;
        const rel = relative(root, w.path);
        out.add(rel);
        out.add(`${rel}/`);
    }
    return out;
}

/**
 * Of the worktrees that `changed`, the ones a turn reached: each path in `reached` (where its agent worked, the files and
 * folders its tool calls named) counts for the deepest of `folders` (the session's own and each nearby worktree) holding
 * it, so a file of a worktree inside the main checkout's folder is that worktree's, not the checkout's. A path is matched
 * as given, then with its links resolved.
 */
export function reachedPlaces<T extends { path: string }>(changed: readonly T[], folders: readonly string[], reached: Iterable<string>): T[] {
    if (!changed.length) return [];
    // Each folder by both its forms (as listed, links resolved), /private/tmp and /tmp alike (normalPath).
    const byForm = new Map<string, string>();
    for (const f of folders) for (const form of [f, canonical(f)]) {
        const n = normalPath(form);
        if (n && !byForm.has(n)) byForm.set(n, f);
    }
    const forms = [...byForm.keys()];
    const folderOf = (p: string) => {
        const n = normalPath(p);
        const w = n ? worktreeOf(n, forms) : undefined;
        return w ? byForm.get(w) : undefined;
    };
    const hit = new Set<string>();
    for (const p of reached) {
        const f = folderOf(p) ?? folderOf(canonical(p));
        if (f) hit.add(f);
    }
    return changed.filter((w) => hit.has(w.path));
}

/**
 * Worktrees whose folders really are them (session-worktrees.ts: the same repository, its entry naming that folder,
 * not a link or a folder put in its place), checked once while the folder stays the same one (its device and inode).
 */
export class WorktreeChecks {
    private known = new Map<string, { at: string; checked: Checked }>();

    async check(root: string, w: Worktree): Promise<Checked | undefined> {
        const st = await lstat(w.path).catch(() => undefined);
        if (!st?.isDirectory()) return undefined;
        const at = `${st.dev}:${st.ino}`;
        const had = this.known.get(w.path);
        if (had?.at === at) return { ...had.checked, branch: w.branch };
        const found = await identify(root, w.path, w.main).catch(() => undefined);
        if (!found) {
            this.known.delete(w.path);
            return undefined;
        }
        const checked: Checked = { ...w, ...found };
        this.known.set(w.path, { at, checked });
        return checked;
    }
}

/**
 * The checks session-worktrees.ts sessionWorktree makes, with this file's private runs (nothing inherited is traced):
 * the folder's repository is `root`'s, it is its own top level (not a link into another), its Git dir is an entry
 * of the repository's worktrees, and that entry's gitdir file names this folder.
 */
async function identify(root: string, path: string, main: boolean): Promise<{ real: string; gitDir: string } | undefined> {
    const deadline = Date.now() + 2000;
    const real = canonical(path);
    const ask = async (cwd: string, flags: string[]) => {
        const r = await run(cwd, ["rev-parse", ...flags], { deadline });
        const out = r.out.toString("utf-8").replace(/\n$/, "");
        return r.code === 0 && out ? canonical(out) : undefined;
    };
    const [expected, common, own, top] = await Promise.all([
        ask(root, ["--path-format=absolute", "--git-common-dir"]),
        ask(real, ["--path-format=absolute", "--git-common-dir"]),
        ask(real, ["--absolute-git-dir"]),
        ask(real, ["--show-toplevel"]),
    ]);
    if (!expected || common !== expected || !own || top !== real) return undefined;
    if (main) return own === expected ? { real, gitDir: own } : undefined;
    if (dirname(own) !== join(expected, "worktrees")) return undefined;
    const named = await readFile(join(own, "gitdir"), "utf-8").then((f) => f.replace(/\r?\n$/, "")).catch(() => "");
    return named && sameFolder(dirname(resolve(own, named)), path) ? { real, gitDir: own } : undefined;
}

function canonical(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

/**
 * A worktree's HEAD, branch and index (its file's stamp), in a hash: what a turn's start needs to know of a worktree
 * it may yet work in, without reading its files or its index (with a session in each of many worktrees, their indexes
 * change all the time). At the end, a reached worktree whose token changed counts as worked in: a `git status` alone
 * rewrites the index too, but it's read-only, so it doesn't reach one. UNKNOWN when it can't all be read in time.
 */
export async function token(w: Checked, deadline: number): Promise<string> {
    try {
        const index = join(w.gitDir, "index");
        // HEAD and its branch as the files say (no git started for each worktree, each turn); as git says otherwise.
        const read = await headOf(w.gitDir);
        const [head, ref, st] = await Promise.all([
            read ? { out: Buffer.from(read.oid) } : run(w.real, ["rev-parse", "--verify", "-q", "HEAD"], { deadline, pin: w }),
            read ? { out: Buffer.from(read.ref) } : run(w.real, ["symbolic-ref", "-q", "HEAD"], { deadline, pin: w }),
            lstat(index, { bigint: true }).catch(() => undefined),
        ]);
        if (Date.now() >= deadline) return UNKNOWN;
        const stamp = st ? `${st.dev}:${st.ino}:${st.size}:${st.mtimeNs}:${st.ctimeNs}` : "-";
        return createHash("sha256").update(`${head.out.toString().trim()}\0${ref.out.toString().trim()}\0${stamp}`).digest("hex");
    } catch {
        return UNKNOWN;
    }
}

/**
 * Whether a worktree's HEAD, branch or index was written since `since` (the file system's clock, in nanoseconds): what
 * its token, taken then, would show changed now, told by its files' times rather than by reading them. A branch that
 * moves is written to a file of its own (packed before or not); packed-refs written with no such file counts too.
 * Undefined when it can't be told (a reftable repository, HEAD unreadable).
 */
export async function movedSince(w: Checked, since: bigint): Promise<boolean | undefined> {
    const written = async (p: string) => {
        const st = await lstat(p, { bigint: true }).catch(() => undefined);
        return st === undefined ? undefined : st.ctimeNs >= since;
    };
    try {
        let common = w.gitDir;
        const named = await readFile(join(w.gitDir, "commondir"), "utf-8").catch(() => undefined);
        if (named !== undefined) common = resolve(w.gitDir, named.trim());
        if (await lstat(join(common, "reftable")).then(() => true, () => false)) return undefined;
        const head = await written(join(w.gitDir, "HEAD"));
        if (head !== false) return head;
        if ((await written(join(w.gitDir, "index"))) === true) return true;
        const text = (await readFile(join(w.gitDir, "HEAD"), "utf-8")).trim();
        // Detached: HEAD's own file says it all.
        if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(text)) return false;
        const ref = /^ref: (refs\/\S+)$/.exec(text)?.[1];
        if (!ref || ref.split("/").includes("..")) return undefined;
        const loose = await written(join(common, ref));
        if (loose !== undefined) return loose;
        // Packed, or a branch with no commits yet (no packed-refs either).
        return (await written(join(common, "packed-refs"))) ?? false;
    } catch {
        return undefined;
    }
}

/**
 * A worktree's HEAD from its files: the commit (or "" for a branch with none yet) and the branch it's on ("" when
 * detached), as `rev-parse --verify HEAD` and `symbolic-ref HEAD` would say. Undefined when the files don't simply say
 * (a reftable repository, a ref to a ref): git's asked then.
 */
export async function headOf(gitDir: string): Promise<{ oid: string; ref: string } | undefined> {
    try {
        let common = gitDir;
        const named = await readFile(join(gitDir, "commondir"), "utf-8").catch(() => undefined);
        if (named !== undefined) common = resolve(gitDir, named.trim());
        if (await lstat(join(common, "reftable")).then(() => true, () => false)) return undefined;
        const head = (await readFile(join(gitDir, "HEAD"), "utf-8")).trim();
        if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(head)) return { oid: head, ref: "" };
        const ref = /^ref: (refs\/\S+)$/.exec(head)?.[1];
        if (!ref || ref.split("/").includes("..")) return undefined;
        const loose = await readFile(join(common, ref), "utf-8").then((t) => t.trim(), () => undefined);
        if (loose !== undefined) return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(loose) ? { oid: loose, ref } : undefined;
        const packed = await readFile(join(common, "packed-refs"), "utf-8").catch(() => "");
        for (const line of packed.split("\n")) {
            const m = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\S+)$/.exec(line);
            if (m?.[2] === ref) return { oid: m[1]!, ref };
        }
        // A branch with no commits yet.
        return { oid: "", ref };
    } catch {
        return undefined;
    }
}

/**
 * Whether a file the worktree tracks or lists as new has changed since `since` (a time on the file system's own
 * clock, in nanoseconds): its ctime, which every write, rename and mode change moves and no tool can set back (an
 * mtime can be), so an edit, a rename-save or a new file each count. A tracked file that's gone counts when the
 * folder it was in changed since. Undefined when it can't all be read in time.
 */
export async function changedSince(w: Checked, since: bigint, deadline: number): Promise<boolean | undefined> {
    try {
        const listed = await run(w.real, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { deadline, maxBytes: 48 * 1024 * 1024, pin: w });
        if (listed.code || listed.cut) return undefined;
        // Without --directory, a trailing slash names a nested repository, not one of this checkout's files.
        const paths = [...new Set(listed.out.toString("utf-8").split("\0").filter((p) => p && !p.endsWith("/")))];
        const gone = new Set<string>();
        let next = 0, found = false, late = false;
        await Promise.all(Array.from({ length: Math.min(STAT_WIDTH, paths.length) }, async () => {
            while (next < paths.length && !found && !late) {
                if (Date.now() >= deadline) { late = true; return; }
                const p = paths[next++]!;
                const st = await lstat(join(w.real, p), { bigint: true }).catch(() => undefined);
                if (!st) gone.add(dirname(p));
                else if (st.ctimeNs >= since) found = true;
            }
        }));
        if (found) return true;
        if (late) return undefined;
        // Its nearest folder still there changed since: something in it was deleted or moved.
        for (let d of gone) for (;;) {
            const st = await lstat(join(w.real, d), { bigint: true }).catch(() => undefined);
            if (st?.isDirectory()) { if (st.ctimeNs >= since) return true; break; }
            if (d === "." || d === "") break;
            d = dirname(d);
        }
        return false;
    } catch {
        return undefined;
    }
}

/** `work`, or undefined once `ms` have passed (it's left to finish, and be thrown away). */
async function inTime<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, ms)); });
    try {
        return await Promise.race([work.catch(() => undefined), late]);
    } finally {
        clearTimeout(timer);
    }
}

const changeOf = (c: GitChangesInfo["files"][number]["change"]): NonNullable<TurnPlace["top"]>[number]["change"] => (c === "added" || c === "untracked" ? "added" : c === "deleted" ? "deleted" : "modified");

/**
 * A worktree as the diff reader shows another one: its branch against the main branch, committed or not, read the
 * way the diff reader reads it (pinned, filter-safe). Out of time, or without a main branch, only where it is and its branch.
 */
export async function summarize(w: Checked, deadline: number): Promise<TurnPlace> {
    const place: TurnPlace = { path: w.path, ...(w.branch ? { branch: w.branch } : {}) };
    const info = await inTime(gitChanges(w.real, { scope: "branch" }, undefined, { gitDir: w.gitDir }), deadline - Date.now());
    if (!info?.repo || !info.base) return place;
    place.base = info.base.ref;
    place.files = info.files.length + info.more;
    place.added = info.added;
    place.removed = info.removed;
    place.top = [...info.files].sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, TOP).map((f) => ({ path: f.path, change: changeOf(f.change), added: f.added, removed: f.removed }));
    const commits = await run(w.real, ["rev-list", "--count", `${info.base.sha}..HEAD`, "--"], { deadline, pin: w }).catch(() => undefined);
    const count = Number(commits?.out.toString().trim());
    if (commits && !commits.code && Number.isSafeInteger(count)) place.commits = count;
    return place;
}

/** Runs `work` on each of `items`, `width` at a time. */
export async function eachLimited<T, R>(items: readonly T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(width, items.length) }, async () => {
        while (next < items.length) {
            const i = next++;
            out[i] = await work(items[i]!);
        }
    }));
    return out;
}
