// The other worktrees of a session's repository that a turn works in: an agent that entered one, sub-agents
// that each made their own. A turn's snapshot covers only the session's own folder (turn-snapshots.ts), so
// at each end of a turn every worktree inside the main checkout's folder (.claude/worktrees, say) gets a
// fingerprint: its HEAD, what `git status` lists, and those files' sizes and times. One whose fingerprint
// changed, or that appeared, was worked in; it's summed up as the diff reader shows another worktree: its
// branch against the main branch, committed or not.

import { createHash } from "crypto";
import { lstat, readFile } from "fs/promises";
import { join, relative } from "path";
import { git } from "../server/git-changes";
import type { TurnPlace } from "../server/protocol";

/** Worktrees fingerprinted and summed up per turn, at most: past this many, the rest go unseen. */
export const MAX_PLACES = 16;
/** The files a place lists, the most lines changed first. */
const TOP = 6;
/** A fingerprint that couldn't be taken: neither it nor what it's compared with says anything. */
export const UNKNOWN = "?";

/**
 * Git, as the snapshot's own reads run it: privately, so nothing inherited (a GIT_TRACE path, say) writes
 * trace files or slips warnings into what's read, and no replace refs change what objects say.
 */
function run(cwd: string, args: string[], o: { deadline: number; maxBytes?: number }) {
    return git(cwd, args, { ...o, privateEnv: { GIT_NO_REPLACE_OBJECTS: "1" } });
}

/**
 * The main branch, as the diff reader takes it (git-changes.ts defaultBase): what origin/HEAD points at,
 * else main or master, local or the remote's.
 */
async function mainBranch(cwd: string, deadline: number): Promise<{ name: string; ref: string } | undefined> {
    const [list, originHead] = await Promise.all([
        run(cwd, ["for-each-ref", "--format=%(refname) %(symref)", "refs/heads", "refs/remotes"], { deadline, maxBytes: 4 * 1024 * 1024 }),
        run(cwd, ["symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { deadline }),
    ]);
    if (list.code || list.cut) return undefined;
    const full = new Map<string, string>();
    for (const line of list.out.toString("utf-8").split("\n")) {
        const [ref, symref] = line.split(" ");
        if (!ref || symref) continue;
        const short = ref.replace(/^refs\/(heads|remotes)\//, "");
        if (!full.has(short)) full.set(short, ref);
    }
    const fromOrigin = originHead.code === 0 ? originHead.out.toString().trim().replace(/^refs\/remotes\//, "") : undefined;
    const name = [fromOrigin, "main", "master", "origin/main", "origin/master"].find((b) => b && full.has(b));
    return name ? { name, ref: full.get(name)! } : undefined;
}

export interface Worktree {
    path: string;
    branch?: string;
    main: boolean;
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

const within = (path: string, dir: string) => path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** The worktrees a turn may work in beside the session's own folder (`own`): the others inside the main checkout's folder. */
export function nearby(all: readonly Worktree[], own: string): Worktree[] {
    const main = all.find((w) => w.main);
    if (!main) return [];
    return all.filter((w) => !w.main && w.path !== own && within(w.path, main.path)).slice(0, MAX_PLACES);
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

/** The paths a `git status --porcelain=v2 -z` record names (ordinary, unmerged, untracked). */
function statusPaths(out: Buffer): string[] {
    const paths: string[] = [];
    for (const rec of out.toString("utf-8").split("\0")) {
        if (rec.startsWith("1 ")) paths.push(rec.split(" ").slice(8).join(" "));
        else if (rec.startsWith("u ")) paths.push(rec.split(" ").slice(10).join(" "));
        else if (rec.startsWith("? ")) paths.push(rec.slice(2));
    }
    return paths;
}

/**
 * What a worktree is like now, in a hash: its HEAD and branch, what git status lists, and each of those files'
 * stat stamp (a file edited again lists the same; an editor that saves by renaming changes its inode, a write its
 * size or times). Not how far the branch is from its upstream: a fetch elsewhere moves that, not work here.
 * UNKNOWN when git can't say, or the files can't all be stamped, in time.
 */
export async function fingerprint(w: Worktree, deadline: number): Promise<string> {
    try {
        const st = await run(w.path, ["status", "--porcelain=v2", "-z", "--branch", "--untracked-files=all", "--no-renames"], { deadline, maxBytes: 8 * 1024 * 1024 });
        if (st.code || st.cut) return UNKNOWN;
        const h = createHash("sha256");
        for (const rec of st.out.toString("utf-8").split("\0")) if (!rec.startsWith("# branch.ab ")) h.update(`${rec}\0`);
        for (const p of statusPaths(st.out)) {
            if (Date.now() >= deadline) return UNKNOWN;
            const s = await lstat(join(w.path, p)).catch(() => undefined);
            h.update(`${p}\0${s ? `${s.ino}:${s.mode}:${s.size}:${s.mtimeMs}:${s.ctimeMs}` : "-"}\0`);
        }
        return h.digest("hex");
    } catch {
        return UNKNOWN;
    }
}

/** The lines in a new file, as a diff counts them (none for one that looks binary or is big). */
async function lineCount(file: string): Promise<number> {
    const s = await lstat(file).catch(() => undefined);
    if (!s?.isFile() || s.size > 512 * 1024) return 0;
    const buf = await readFile(file).catch(() => undefined);
    if (!buf?.length || buf.includes(0)) return 0;
    let n = 0;
    for (const b of buf) if (b === 10) n++;
    return buf[buf.length - 1] === 10 ? n : n + 1;
}

/**
 * A worktree as the diff reader shows another one: its branch against the main branch, committed or not
 * (what's tracked, and new files). Without a main branch, or out of time, only where it is and its branch.
 */
export async function summarize(w: Worktree, deadline: number): Promise<TurnPlace> {
    const place: TurnPlace = { path: w.path, ...(w.branch ? { branch: w.branch } : {}) };
    try {
        const base = await mainBranch(w.path, deadline);
        if (!base) return place;
        const mb = await run(w.path, ["merge-base", base.ref, "HEAD"], { deadline });
        const from = mb.code === 0 ? mb.out.toString().trim() : "";
        if (!/^[0-9a-f]{40,64}$/.test(from)) return place;
        place.base = base.name;
        const [numstat, names, commits, untracked] = await Promise.all([
            run(w.path, ["diff", "--numstat", "-z", "--no-renames", from, "--"], { deadline, maxBytes: 8 * 1024 * 1024 }),
            run(w.path, ["diff", "--name-status", "-z", "--no-renames", from, "--"], { deadline, maxBytes: 8 * 1024 * 1024 }),
            run(w.path, ["rev-list", "--count", `${from}..HEAD`, "--"], { deadline }),
            run(w.path, ["ls-files", "--others", "--exclude-standard", "-z"], { deadline, maxBytes: 8 * 1024 * 1024 }),
        ]);
        if (numstat.code || names.code || numstat.cut || names.cut) return place;
        const change = new Map<string, "added" | "modified" | "deleted">();
        const ns = names.out.toString("utf-8").split("\0");
        for (let i = 0; i + 1 < ns.length; i += 2) change.set(ns[i + 1]!, ns[i] === "A" ? "added" : ns[i] === "D" ? "deleted" : "modified");
        const files: NonNullable<TurnPlace["top"]> = [];
        for (const rec of numstat.out.toString("utf-8").split("\0")) {
            const m = /^(-|\d+)\t(-|\d+)\t(.+)$/s.exec(rec);
            if (m) files.push({ path: m[3]!, change: change.get(m[3]!) ?? "modified", added: m[1] === "-" ? 0 : Number(m[1]), removed: m[2] === "-" ? 0 : Number(m[2]) });
        }
        if (!untracked.code && !untracked.cut) {
            const fresh = untracked.out.toString("utf-8").split("\0").filter(Boolean);
            // Their lines are counted while there's time (and for the first 200); past that they count as files.
            for (const [i, p] of fresh.entries()) files.push({ path: p, change: "added", added: i < 200 && Date.now() < deadline ? await lineCount(join(w.path, p)) : 0, removed: 0 });
        }
        place.files = files.length;
        place.added = files.reduce((n, f) => n + f.added, 0);
        place.removed = files.reduce((n, f) => n + f.removed, 0);
        const count = Number(commits.out.toString().trim());
        if (!commits.code && Number.isSafeInteger(count)) place.commits = count;
        // As git names them, like the snapshot's own paths: shown redacted, with a handle (git-handles.ts).
        place.top = files.sort((a, b) => b.added + b.removed - (a.added + a.removed)).slice(0, TOP);
        return place;
    } catch {
        return place;
    }
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
