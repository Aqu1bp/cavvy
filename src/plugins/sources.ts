// Fetching plugins and marketplaces: git clones, npm tarballs, local copies,
// and marketplace.json over https. Nothing fetched is run: no git hooks, no
// npm install scripts. Git never prompts (it fails instead), and every
// network step has a timeout.

import { createHash } from "crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { join, relative } from "path";
import { gunzipSync } from "zlib";
import { isInside } from "../util/files";
import { childEnv } from "../util/env";

const GIT_TIMEOUT = 180_000;
const FETCH_TIMEOUT = 60_000;
/** Bigger npm tarballs than this aren't plugins. */
const MAX_TARBALL = 100 * 1024 * 1024;
/** Nor bigger once unpacked (a small archive can expand to fill the disk). */
const MAX_UNPACKED = 500 * 1024 * 1024;

/** Registries and tarballs over https; plain http only to this computer (a local registry, tests). */
export function secureUrl(url: string): boolean {
    try {
        const u = new URL(url);
        return u.protocol === "https:" || (u.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname));
    } catch {
        return false;
    }
}

export class SourceError extends Error {}

async function run(cmd: string[], cwd?: string, timeout = GIT_TIMEOUT): Promise<string> {
    let proc;
    try {
        proc = Bun.spawn(cmd, {
            cwd,
            stdin: "ignore",
            stdout: "pipe",
            stderr: "pipe",
            timeout,
            // No prompts for credentials or host keys: a private repo fails with git's own message instead of hanging.
            env: childEnv({ GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "", GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes", GIT_LFS_SKIP_SMUDGE: "1" }),
        });
    } catch (e) {
        throw new SourceError(`${cmd[0]} couldn't start: ${(e as Error).message}${cmd[0] === "git" ? " (is git installed?)" : ""}`);
    }
    const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    if (proc.signalCode) throw new SourceError(`${cmd.slice(0, 2).join(" ")} timed out after ${Math.round(timeout / 1000)}s`);
    if (code !== 0) {
        const msg = err.trim().split("\n").filter((l) => !/^(hint|Cloning into)\b/.test(l)).slice(-4).join("\n");
        throw new SourceError(msg || `${cmd.slice(0, 2).join(" ")} exited with ${code}`);
    }
    return out;
}

/** The URL git clones for a source written as owner/repo. */
export const githubUrl = (repo: string) => `https://github.com/${repo}.git`;

/**
 * Clone `url` into `dest` (which mustn't exist): the tip of `ref` (or the
 * default branch), or exactly `sha`. Returns the commit it checked out.
 */
export async function gitClone(url: string, dest: string, o: { ref?: string; sha?: string } = {}): Promise<string> {
    try {
        return await clone(url, dest, o);
    } catch (e) {
        const msg = (e as Error).message;
        // Git asks for a password when a repository doesn't exist or is private; with prompts off, that's this.
        if (/could not read (Username|Password)|Authentication failed|Repository not found|terminal prompts disabled/i.test(msg)) throw new SourceError(`${url} wasn't found, or it's private and git has no credentials for it (${msg.split("\n").at(-1)})`);
        if (/Remote branch .* not found/i.test(msg)) throw new SourceError(`${url} has no branch or tag ${o.ref}`);
        throw e;
    }
}

async function clone(url: string, dest: string, o: { ref?: string; sha?: string }): Promise<string> {
    // No transport that runs a command (ext::, fd::), whatever the user's gitconfig allows; "--" ends the options.
    const base = ["git", "-c", "core.hooksPath=/dev/null", "-c", "advice.detachedHead=false", "-c", "protocol.ext.allow=never", "-c", "protocol.fd.allow=never", "-c", "core.fsmonitor="];
    if (o.sha) {
        mkdirSync(dest, { recursive: true });
        await run([...base, "init", "-q"], dest);
        await run([...base, "remote", "add", "origin", "--", url], dest);
        try {
            await run([...base, "fetch", "-q", "--depth", "1", "origin", o.sha], dest);
        } catch {
            // Servers that won't serve a bare commit: fetch the branch, then find it.
            await run([...base, "fetch", "-q", "origin", ...(o.ref ? [o.ref] : [])], dest);
        }
        await run([...base, "checkout", "-q", o.sha], dest).catch((e) => {
            throw new SourceError(`commit ${o.sha} isn't in ${url}: ${(e as Error).message}`);
        });
    } else {
        await run([...base, "clone", "-q", "--depth", "1", "--no-tags", ...(o.ref ? ["--branch", o.ref] : []), "--", url, dest]);
    }
    return (await run(["git", "rev-parse", "HEAD"], dest)).trim();
}

/**
 * Remove every symlink under `root` that points outside it (or nowhere), so
 * nothing fetched can make a later read or write land elsewhere. Returns the
 * removed links, relative to `root`.
 */
export function pruneSymlinks(root: string): string[] {
    const real = realpathSync(root);
    const removed: string[] = [];
    const walk = (d: string) => {
        for (const e of readdirSync(d, { withFileTypes: true })) {
            const p = join(d, e.name);
            if (e.isSymbolicLink()) {
                let target: string | undefined;
                try {
                    target = realpathSync(p);
                } catch {
                    // dangling
                }
                if (!target || !isInside(target, real)) {
                    unlinkSync(p);
                    removed.push(relative(root, p));
                }
            } else if (e.isDirectory()) walk(p);
        }
    };
    walk(root);
    return removed;
}

/** Put `src` at `dest`, replacing what's there; if that fails, what was there is put back. */
export function swapIn(src: string, dest: string) {
    const old = existsSync(dest) ? `${dest}.old-${process.pid}-${Date.now()}` : undefined;
    if (old) renameSync(dest, old);
    try {
        renameSync(src, dest);
    } catch (e) {
        if (old) {
            rmSync(dest, { recursive: true, force: true });
            renameSync(old, dest);
        }
        throw e;
    }
    if (old) rmSync(old, { recursive: true, force: true });
}

/** Copy a folder, leaving out .git. Symlinks are copied as links; pruneSymlinks drops the ones that leave it. */
/**
 * A digest of a folder's file names, contents and links: whether an update
 * changed anything, when the version and the server configuration didn't.
 * Undefined for a folder that isn't there.
 */
export function treeHash(root: string): string | undefined {
    if (!existsSync(root)) return undefined;
    const h = createHash("sha256");
    const walk = (dir: string) => {
        for (const name of readdirSync(dir).sort()) {
            const abs = join(dir, name);
            const rel = relative(root, abs);
            const st = lstatSync(abs);
            if (st.isSymbolicLink()) h.update(`l\0${rel}\0${readlinkSync(abs)}\0`);
            else if (st.isDirectory()) {
                h.update(`d\0${rel}\0`);
                walk(abs);
            } else if (st.isFile()) {
                h.update(`f\0${rel}\0${st.size}\0${st.mode & 0o111 ? "x" : ""}\0`);
                h.update(readFileSync(abs));
            }
        }
    };
    walk(root);
    return h.digest("hex");
}

export function copyDir(src: string, dest: string) {
    let st;
    try {
        st = statSync(src);
    } catch {
        throw new SourceError(`${src} doesn't exist`);
    }
    if (!st.isDirectory()) throw new SourceError(`${src} isn't a folder`);
    cpSync(src, dest, { recursive: true, verbatimSymlinks: true, filter: (p) => !/(^|[\\/])\.git$/.test(p) });
}

const MAX_REDIRECTS = 5;

/** Redirects are followed here, so one from https to plain http is refused rather than taken. */
async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
    const secure = secureUrl(url);
    const signal = AbortSignal.timeout(FETCH_TIMEOUT);
    let at = url;
    for (let hop = 0; ; hop++) {
        let r: Response;
        try {
            r = await fetch(at, { ...init, signal, redirect: "manual" });
        } catch (e) {
            throw new SourceError(`couldn't reach ${new URL(at).host}: ${(e as Error).message}`);
        }
        const location = r.status >= 300 && r.status < 400 ? r.headers.get("location") : null;
        if (!location) return r;
        if (hop >= MAX_REDIRECTS) throw new SourceError(`${url} redirected too many times`);
        const next = new URL(location, at).href;
        if (secure && !secureUrl(next)) throw new SourceError(`${new URL(at).host} redirected to ${new URL(next).origin}, which isn't https`);
        at = next;
    }
}

/** A JSON document over http(s). */
export async function fetchJson(url: string): Promise<unknown> {
    const r = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new SourceError(`${url} answered ${r.status} ${r.statusText}`);
    const text = await r.text();
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new SourceError(`${url} isn't JSON (${(e as Error).message})`);
    }
}

interface NpmVersion {
    version: string;
    dist?: { tarball?: string; integrity?: string; shasum?: string };
}

/** The version `want` picks: a dist-tag, an exact version, or the highest one a range allows. */
export function pickVersion(doc: { "dist-tags"?: Record<string, string>; versions?: Record<string, unknown> }, want = "latest"): string | undefined {
    const versions = Object.keys(doc.versions ?? {});
    const tag = doc["dist-tags"]?.[want];
    if (tag && versions.includes(tag)) return tag;
    if (versions.includes(want)) return want;
    let best: string | undefined;
    for (const v of versions) {
        try {
            if (/-/.test(v) && !/-/.test(want)) continue; // prereleases only when asked for
            if (Bun.semver.satisfies(v, want) && (!best || Bun.semver.order(v, best) > 0)) best = v;
        } catch {
            // not semver
        }
    }
    return best;
}

/** Check a download against npm's integrity string (sha512-…) or legacy sha1 shasum. */
export function checkIntegrity(data: Uint8Array, dist: NpmVersion["dist"]): void {
    if (dist?.integrity) {
        for (const part of dist.integrity.split(/\s+/)) {
            const m = part.match(/^(sha512|sha384|sha256|sha1)-(.+)$/);
            if (!m) continue;
            if (createHash(m[1]!).update(data).digest("base64") === m[2]) return;
            throw new SourceError("the downloaded package doesn't match its published integrity hash");
        }
    }
    if (dist?.shasum) {
        if (createHash("sha1").update(data).digest("hex") === dist.shasum.toLowerCase()) return;
        throw new SourceError("the downloaded package doesn't match its published shasum");
    }
    throw new SourceError("the registry gave no integrity hash for this package");
}

/**
 * Download an npm package's tarball into `dest`/ and unpack it. Returns the
 * folder holding the package (npm's "package/") and its version. Install
 * scripts never run: this only unpacks.
 */
export async function fetchNpm(pkg: string, want: string | undefined, dest: string, registry = "https://registry.npmjs.org"): Promise<{ dir: string; version: string }> {
    if (!secureUrl(registry)) throw new SourceError(`the registry ${registry} isn't https`);
    const docUrl = `${registry}/${pkg.replace("/", "%2f")}`;
    const r = await fetchWithTimeout(docUrl, { headers: { Accept: "application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8" } });
    if (r.status === 404) throw new SourceError(`npm package ${pkg} wasn't found${registry.includes("registry.npmjs.org") ? "" : ` on ${registry}`}`);
    if (!r.ok) throw new SourceError(`${docUrl} answered ${r.status}`);
    const doc = (await r.json()) as { "dist-tags"?: Record<string, string>; versions?: Record<string, NpmVersion> };
    const version = pickVersion(doc, want);
    if (!version) throw new SourceError(`npm package ${pkg} has no version matching ${want ?? "latest"}`);
    const meta = doc.versions![version]!;
    const tarball = meta.dist?.tarball;
    if (!tarball || !secureUrl(tarball)) throw new SourceError(`npm package ${pkg}@${version} has no https tarball`);
    const tr = await fetchWithTimeout(tarball);
    if (!tr.ok) throw new SourceError(`downloading ${pkg}@${version} failed: ${tr.status}`);
    const len = Number(tr.headers.get("content-length") ?? 0);
    if (len > MAX_TARBALL) throw new SourceError(`${pkg}@${version} is ${Math.round(len / 1e6)} MB, too big for a plugin`);
    const data = new Uint8Array(await tr.arrayBuffer());
    if (data.length > MAX_TARBALL) throw new SourceError(`${pkg}@${version} is too big for a plugin`);
    checkIntegrity(data, meta.dist);
    mkdirSync(dest, { recursive: true });
    let tar: Buffer;
    try {
        tar = gunzipSync(data, { maxOutputLength: MAX_UNPACKED });
    } catch (e) {
        throw new SourceError(/maxOutputLength|buffer/i.test(String((e as Error).message)) ? `${pkg}@${version} unpacks to more than ${MAX_UNPACKED / 1024 / 1024} MB, too big for a plugin` : `${pkg}@${version} isn't a gzip archive`);
    }
    const file = join(dest, "package.tar");
    writeFileSync(file, tar);
    const out = join(dest, "unpacked");
    mkdirSync(out);
    // tar refuses absolute paths and ".." in member names by default.
    await run(["tar", "-xf", file, "-C", out, "--no-same-owner", "--no-same-permissions"], undefined, 60_000);
    rmSync(file, { force: true });
    const top = readdirSync(out, { withFileTypes: true }).filter((e) => e.isDirectory());
    if (top.length !== 1) throw new SourceError(`${pkg}@${version}'s tarball doesn't have one top folder`);
    return { dir: join(out, top[0]!.name), version };
}
