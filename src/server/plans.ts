// Plans a session presented: their titles, the branch and file names made
// from them, the prompt that carries one to a new worktree, and saving one
// as Markdown, only ever inside the session's folder or the Cavvy home.

import { closeSync, constants, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, unlinkSync, writeSync } from "fs";
import { randomBytes } from "crypto";
import { basename, isAbsolute, join, relative, resolve, sep } from "path";
import { homedir } from "os";
import { isInside } from "../util/files";
import { RpcError } from "./rpc-error";
import { planTitle } from "./plan-title";

export { planTitle };

/** Lowercase ASCII words joined by "-": safe as a branch name, a folder and a file name. */
export function slugify(text: string, max = 48): string {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, max)
        .replace(/-+$/, "");
}

/** The prompt a new session gets: what it is, where it came from, where it works, then the plan. */
export function implementPrompt(o: { plan: string; title?: string; sessionId: string; from: string; fromRoot: string; path: string; branch: string; base: string; commit?: string }): string {
    const named = o.title ? `"${o.title}" (${o.sessionId})` : o.sessionId;
    const start = o.commit && o.commit !== o.base ? `${o.base} (${o.commit.slice(0, 12)})` : o.base;
    return [
        `Implement the plan below. It was made in another Cavvy session, ${named}, working in ${o.from}.`,
        "",
        "You're in a new Git worktree made for it:",
        `- Folder: ${o.path}`,
        `- Branch: ${o.branch} (new, started from ${start})`,
        "",
        `Paths in the plan under ${o.fromRoot} mean the same files under ${o.path}. Uncommitted changes in ${o.fromRoot} aren't here: the worktree starts from that commit.`,
        "",
        "<plan>",
        o.plan.trim(),
        "</plan>",
    ].join("\n");
}

/** At most this much is written. */
export const SAVE_MAX_BYTES = 1024 * 1024;

const NOFOLLOW = constants.O_NOFOLLOW ?? 0;

function exists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

function real(path: string): string {
    try {
        return realpathSync(path);
    } catch {
        return resolve(path);
    }
}

/** <home>/plans/<project>/<date>-<title>.md, numbered when that's taken. */
export function defaultPlanPath(o: { home: string; cwd: string; title: string; date?: Date }): string {
    const dir = join(o.home, "plans", slugify(basename(o.cwd), 64) || "project");
    const day = (o.date ?? new Date()).toISOString().slice(0, 10);
    const name = `${day}-${slugify(o.title) || "plan"}`;
    for (let n = 1; n < 100; n++) {
        const file = join(dir, `${name}${n > 1 ? `-${n}` : ""}.md`);
        if (!exists(file)) return file;
    }
    return join(dir, `${name}-${randomBytes(3).toString("hex")}.md`);
}

interface Root {
    /** As configured (what the user sees). */
    path: string;
    real: string;
    private: boolean;
}

const outside = (why: string) => new RpcError(why, "path_outside");

/**
 * Where `input` (absolute, ~/…, or relative to the session's folder) lands:
 * the root it's in and the path segments below it. The Cavvy home is
 * checked first, as it's the stricter of the two (files there are private).
 */
function place(input: string, roots: Root[], cwd: string): { root: Root; parts: string[] } {
    const expanded = input === "~" ? homedir() : input.startsWith("~/") ? join(homedir(), input.slice(2)) : input;
    // Any "..": nothing to gain from one, and it's how an escape is written.
    if (expanded.split(/[\\/]+/).includes("..")) throw outside("The path can't contain “..”.");
    const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);
    for (const root of roots) {
        for (const base of [root.path, root.real]) {
            if (abs === base || !isInside(abs, base)) continue;
            return { root, parts: relative(base, abs).split(sep).filter(Boolean) };
        }
    }
    throw outside(`Plans can only be saved in ${roots.map((r) => r.path).join(" or ")}.`);
}

/**
 * Write the plan to `input`, inside the session's folder or the Cavvy home
 * (their real paths). No link on the way is followed: each folder below the
 * root is made (or found) one level at a time and must be a real folder, and
 * the file is created exclusively (O_EXCL | O_NOFOLLOW). An existing file is
 * replaced only with `replace`, by renaming a new file over it, so a link put
 * there is replaced rather than written through.
 */
export function writePlanFile(o: { cwd: string; home: string; input: string; text: string; replace?: boolean }): string {
    const roots: Root[] = [
        { path: resolve(o.home), real: real(o.home), private: true },
        { path: resolve(o.cwd), real: real(o.cwd), private: false },
    ];
    const { root, parts } = place(o.input, roots, o.cwd);
    if (join(root.real, ...parts).split(sep).some((p) => p.toLowerCase() === ".git")) throw outside("Plans can't be saved inside a .git folder.");
    const name = parts.at(-1);
    if (!name || !/\.md$/i.test(name) || name.length < 4) throw new RpcError("Plans are saved as Markdown: the file name must end in .md.", "bad_name");
    if (parts.some((p) => p.toLowerCase() === ".git")) throw outside("Plans can't be saved inside a .git folder.");
    if (name.length > 255) throw new RpcError("The file name is too long.", "bad_name");
    const body = Buffer.from(o.text.endsWith("\n") ? o.text : `${o.text}\n`);
    if (body.length > SAVE_MAX_BYTES) throw new RpcError("The plan is too big to save.", "too_big");
    const dirMode = root.private ? 0o700 : 0o777;
    const fileMode = root.private ? 0o600 : 0o666;
    // The real root: a symlink above it (/tmp on macOS) is the user's own setup. Named as the user sees it.
    let dir = root.real;
    const shown = join(root.path, ...parts);
    for (const part of parts.slice(0, -1)) {
        dir = join(dir, part);
        try {
            mkdirSync(dir, { mode: dirMode });
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw new RpcError(`Couldn't create ${dir}.`, "bad_location");
        }
        const st = lstatSync(dir);
        if (st.isSymbolicLink() || !st.isDirectory()) throw outside(`${dir} is a link or a file, so the plan can't be saved there.`);
    }
    // Checked again as a whole: nothing on the way was swapped for a link meanwhile.
    if (!isInside(real(dir), root.real)) throw outside(`${dir} leads outside ${root.path}.`);
    const target = join(dir, name);
    let st;
    try {
        st = lstatSync(target);
    } catch {
        st = undefined;
    }
    if (st) {
        if (st.isSymbolicLink()) throw outside(`${target} is a link, so it isn't written to.`);
        if (!st.isFile()) throw new RpcError(`${target} isn't a file.`, "bad_name");
        if (!o.replace) throw new RpcError(`${target} already exists.`, "file_exists");
    }
    const write = (path: string) => {
        const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NOFOLLOW, fileMode);
        try {
            writeSync(fd, body);
            fsyncSync(fd);
        } finally {
            closeSync(fd);
        }
    };
    if (!st) {
        try {
            write(target);
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new RpcError(`${target} already exists.`, "file_exists");
            throw new RpcError(`Couldn't write ${target}.`, "write_failed");
        }
        return shown;
    }
    const tmp = join(dir, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
    try {
        write(tmp);
        renameSync(tmp, target);
    } catch {
        try {
            unlinkSync(tmp);
        } catch {
            // never made
        }
        throw new RpcError(`Couldn't replace ${target}.`, "write_failed");
    }
    return shown;
}
