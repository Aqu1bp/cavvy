// Runs: one prompt to several models at once, each in a worktree of its own
// so they can't step on each other, grouped so they're easy to compare.
// Everything that can be checked is checked before anything is created; after
// that each model gets its own result, and one failing never stops the others.

import { randomBytes } from "crypto";
import { lstatSync, realpathSync, statSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { getKey } from "../auth/credentials";
import { projectConfigSummary, trustedByUser } from "../config/trust";
import { committedExternalImports, type TreeFile } from "../agent/memory";
import { PERMISSION_MODES } from "../permissions/modes";
import { clientFor, type ProviderListing } from "../providers/models";
import { formatPrice } from "../providers/pricing";
import { readsPdf } from "../providers/files";
import { getProvider, type ProviderDef } from "../providers/registry";
import { modelRef, parseModelRef, type AttachedPart, type FilePart, type ImagePart, type ModelInfo } from "../providers/types";
import { redact } from "../util/redact";
import { isInside } from "../util/files";
import type { Billing, PermissionModeId, RunOutcome, RunResult } from "./protocol";
import { RpcError } from "./rpc-error";
import { checkFiles, checkMedia } from "./attachments";
import { checkCreate, createWorktreeWithHooks, listWorktrees, runGitAsync, WORKTREES_DIR, type Log } from "./worktrees";

export const MIN_MODELS = 2;
export const MAX_MODELS = 4;
/** More paid-API models than this need the user's say-so. */
export const PAID_WITHOUT_ASKING = 2;
const MAX_TEXT = 200_000;
const MAX_IMAGES = 20;
/** Tries at a free name when Git says a branch or folder appeared meanwhile. */
const NAME_RETRIES = 5;
const GIT_READ_MS = 15_000;

// ---------------------------------------------------------------------------
// Names

const PROMPT_WORDS = 5;
const PROMPT_SLUG_MAX = 40;
const MODEL_SLUG_MAX = 24;

/** A long run of letters and digits mixed reads as a key or a hash, not a word. */
function tokenLike(word: string): boolean {
    return word.length > 20 || (word.length >= 8 && /[a-z]/.test(word) && (word.match(/\d/g)?.length ?? 0) >= 3);
}

/** ASCII letters and digits, lower case: accents dropped, everything else a separator. */
function asciiWords(text: string): string[] {
    return text
        .normalize("NFKD")
        .replace(/[̀-ͯ]/g, "")
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(Boolean);
}

/** A few words of the prompt for branch and folder names: secrets redacted first, token-like words left out; "run" when nothing's left. */
export function promptSlug(text: string): string {
    const words = asciiWords(redact(text).replace(/\[REDACTED [^\]]*\]/g, " ")).filter((w) => !tokenLike(w));
    let out = "";
    for (const w of words.slice(0, PROMPT_WORDS)) {
        const next = out ? `${out}-${w}` : w;
        if (next.length > PROMPT_SLUG_MAX) break;
        out = next;
    }
    return out || "run";
}

function capAtDash(s: string, max: number): string {
    if (s.length <= max) return s;
    const cut = s.slice(0, max);
    const dash = cut.lastIndexOf("-");
    return dash > 0 ? cut.slice(0, dash) : cut;
}

/** The model's id (its last path part), without a leading "claude-": "anthropic:claude-opus-5-5" is "opus-5-5". */
export function modelSlug(ref: string): string {
    const id = parseModelRef(ref)?.id ?? ref;
    const words = asciiWords(id.split("/").pop() ?? id);
    if (words[0] === "claude" && words.length > 1) words.shift();
    return capAtDash(words.join("-"), MODEL_SLUG_MAX) || "model";
}

/** Each picked model's slug; two that come out the same (Claude Code's Opus and the API's) get their provider in front. */
export function modelSlugs(refs: string[]): string[] {
    const plain = refs.map(modelSlug);
    return refs.map((ref, i) => {
        if (plain.filter((s) => s === plain[i]).length < 2) return plain[i]!;
        const provider = asciiWords(parseModelRef(ref)?.provider ?? "").join("-") || "model";
        return capAtDash(`${provider}-${plain[i]}`, MODEL_SLUG_MAX + 12);
    });
}

/** `base`, else `base-2`, `base-3`, ...: the first that isn't taken. */
export function uniqueName(base: string, taken: (name: string) => boolean, max = 99): string | undefined {
    for (let i = 1; i <= max; i++) {
        const name = i === 1 ? base : `${base}-${i}`;
        if (!taken(name)) return name;
    }
    return undefined;
}

/**
 * Existing branches in lower case (refs can clash by case on macOS), each with
 * its parent paths too: a branch a/b means no branch a can be made.
 */
async function branchNames(main: string): Promise<Set<string>> {
    const r = await runGitAsync(main, ["for-each-ref", "--format=%(refname)", "refs/heads/"], GIT_READ_MS);
    if (r.code !== 0 || r.timedOut) throw new RpcError("Git couldn't list this repository's branches, so nothing was created.", "git_failed");
    const out = new Set<string>();
    for (const line of r.stdout.split("\n")) {
        const parts = line.replace(/^refs\/heads\//, "").toLowerCase().split("/");
        for (let i = 1; i <= parts.length; i++) if (parts[0]) out.add(parts.slice(0, i).join("/"));
    }
    return out;
}

function lexists(path: string): boolean {
    try {
        lstatSync(path);
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Checks before anything is created

/** Claude Code and Codex run on the user's plan, Ollama and LM Studio on this machine; anything else is billed per token (when in doubt, too). */
export async function billingOf(def: ProviderDef | undefined): Promise<Billing> {
    if (def?.auth === "cli") return "plan";
    // A keyed loopback proxy can forward to paid APIs. Only unkeyed custom
    // providers qualify as local, even when their key is optional.
    if (def?.local && !(def.custom && await getKey(def.id))) return "local";
    return "api";
}

export interface RunRequest {
    path: string;
    models: string[];
    text: string;
    images: ImagePart[];
    files?: FilePart[];
    mode?: PermissionModeId;
    confirmPaid: boolean;
}

/** Malformed requests refuse the whole run. `validImage` is session.send's own check. */
export function parseRunRequest(p: Record<string, unknown>, o: { validImage: (i: { mediaType: unknown; data: unknown }) => boolean; resolvePath: (path: string) => string }): RunRequest {
    const bad = (message: string) => new RpcError(message, "invalid");
    if (typeof p.path !== "string" || !p.path || p.path.length > 4096 || p.path.includes("\0")) throw bad("path must be a folder's path");
    if (!Array.isArray(p.models)) throw bad("models must be a list of models");
    if (p.models.length < MIN_MODELS || p.models.length > MAX_MODELS) throw bad(`Pick ${MIN_MODELS} to ${MAX_MODELS} models.`);
    for (const m of p.models) if (typeof m !== "string" || !m || m.length > 300 || /[\x00-\x1f\x7f]/.test(m)) throw bad("Each model must be a model reference such as anthropic:claude-opus-5-5.");
    const models = p.models as string[];
    if (new Set(models).size !== models.length) throw bad("Each model can be picked only once.");
    if (typeof p.text !== "string") throw bad("text must be a string");
    if (p.text.length > MAX_TEXT) throw bad("The prompt is too long to send to several models.");
    if (p.text.trim().startsWith("!")) throw bad("Shell commands can't be sent to several models.");
    let images: ImagePart[] = [];
    if (p.images !== undefined && p.images !== null) {
        if (!Array.isArray(p.images) || p.images.length > MAX_IMAGES) throw bad(`Attach at most ${MAX_IMAGES} images.`);
        const whole = (i: any) => typeof i?.mediaType === "string" && typeof i?.data === "string" && /^[A-Za-z0-9+/]*={0,2}$/.test(i.data);
        if (!p.images.every((i) => o.validImage(i) && whole(i))) throw bad("An attached image isn't one Harness can send (PNG, JPEG, GIF or WebP, under 15 MB).");
        images = (p.images as { mediaType: string; data: string }[]).map((i) => ({ type: "image", mediaType: i.mediaType as ImagePart["mediaType"], data: i.data }));
    }
    const files = checkFiles(p.files);
    checkMedia([...images, ...files]);
    if (!p.text.trim() && !images.length && !files.length) throw bad("Write the task first: every model gets the same prompt.");
    if (p.mode !== undefined && p.mode !== null && !PERMISSION_MODES.includes(p.mode as PermissionModeId)) throw bad("Unknown mode");
    if (p.confirmPaid !== undefined && typeof p.confirmPaid !== "boolean") throw bad("confirmPaid must be a boolean");
    return { path: o.resolvePath(p.path), models, text: p.text, images, files, mode: (p.mode ?? undefined) as PermissionModeId | undefined, confirmPaid: p.confirmPaid === true };
}

type Checked = { ref: string; name: string; ok: true; billing: Billing; info: ModelInfo } | { ref: string; name: string; ok: false; error: string };

/** A listed model of a provider that's set up here, which takes images if there are any. The message says what to do. */
async function checkModel(ref: string, listings: ProviderListing[], withImages: boolean, withPdf: boolean): Promise<Checked> {
    const parsed = parseModelRef(ref);
    const def = parsed && getProvider(parsed.provider);
    const name = parsed?.id ?? ref;
    if (!parsed || !def) return { ref, name, ok: false, error: `${redact(ref).slice(0, 120)} isn't a model Harness knows. Pick another one.` };
    try {
        await clientFor(def.id);
    } catch {
        const error =
            def.auth === "cli"
                ? `${def.name} isn't turned on here. Connect it in Settings → Providers, or pick another model.`
                : def.auth === "gcloud"
                  ? `${def.name} isn't set up. Set it up in Settings → Providers, or pick another model.`
                  : `No API key for ${def.name}. Add one in Settings → Providers, or pick another model.`;
        return { ref, name, ok: false, error };
    }
    const info = listings.find((l) => l.provider.id === def.id)?.models.find((m) => m.id === parsed.id);
    if (!info) return { ref, name, ok: false, error: `${def.name} doesn't list ${redact(parsed.id).slice(0, 120)}. Refresh the model list, or pick another model.` };
    const shown = info.name ?? info.id;
    if (withImages && info.supportsImages === false) return { ref, name: shown, ok: false, error: `${shown} doesn't take images. Remove the images, or pick another model.` };
    if (withPdf && !readsPdf(info)) return { ref, name: shown, ok: false, error: `${shown} can't read PDFs. Remove the PDFs, or pick another model.` };
    return { ref, name: shown, ok: true, billing: await billingOf(def), info };
}

/** The commit every worktree starts from, read once so they all start from the same one. */
async function headCommit(path: string): Promise<string> {
    const r = await runGitAsync(path, ["rev-parse", "--verify", "--quiet", "HEAD^{commit}"], GIT_READ_MS);
    const commit = r.stdout.trim();
    if (r.code !== 0 || !/^[0-9a-f]{40,64}$/.test(commit)) throw new RpcError("This folder's HEAD has no commit yet: make a first commit, then start the run.", "bad_base");
    return commit;
}

/** Git's output for `args`, at most `maxBytes` of it when given (`cut`: there was more). */
async function readGit(main: string, args: string[], maxBytes?: number): Promise<{ out: string; cut: boolean }> {
    const r = await runGitAsync(main, args, GIT_READ_MS, maxBytes === undefined ? {} : { maxBytes });
    if (r.timedOut || (r.code !== 0 && !r.cut)) throw new RpcError("Git couldn't read this repository's HEAD, so nothing was created.", "git_failed");
    return { out: r.stdout, cut: !!r.cut };
}

/**
 * The project configuration a checkout of `commit` will have, read from its
 * tree: which configuration files there are, and what its memory files, as
 * committed, import from outside it (the working copy's may say otherwise).
 */
async function committedConfig(main: string, commit: string): Promise<string[]> {
    const records = (await readGit(main, ["ls-tree", "-r", "-t", "-z", commit, "--", ".harness", ".mcp.json", ".claude", ".codex"])).out.split("\0").filter(Boolean);
    const entries = new Set(records.map((r) => r.slice(r.indexOf("\t") + 1)));
    // A committed config directory can be a symlink. Its targets aren't
    // beneath that name in the tree, but checkout will expose them there.
    const linked = records.filter((r) => r.startsWith("120000 ")).map((r) => r.slice(r.indexOf("\t") + 1)).filter((p) => [".harness", ".claude", ".codex"].includes(p));
    // Where the worktrees go; their names aren't known yet.
    const top = join(main, WORKTREES_DIR, "new-worktree");
    const imports = await committedExternalImports(top, treeReader(main, commit, top));
    return [...projectConfigSummary(main, (path) => entries.has(relative(main, path))), ...linked, ...imports];
}

/** Links followed in a path before it's given up on, as the system does (ELOOP). */
const MAX_LINK_HOPS = 40;
/** A link's target longer than a path can be isn't one the system would follow. */
const MAX_LINK_BYTES = 4096;
/** A folder's listing, read whole: a folder with more than this in it isn't checked (the run asks instead of guessing). */
const MAX_LISTING_BYTES = 4 * 1024 * 1024;

interface TreeEntry {
    mode: string;
    oid: string;
    /** A blob's size in bytes. */
    size: number;
}

/**
 * Opens paths in `commit`'s tree as a checkout of it at `top` would have
 * them: links followed, through the tree or out of it (then `real` is where
 * the link leads, outside `top`). Nothing is fetched but folder listings and
 * links' targets (by size, before reading them) until a file's `head` is
 * asked for, and then only that much of it. Undefined: not there, or not a
 * file (a folder, a submodule).
 */
export function treeReader(main: string, commit: string, top: string): (path: string) => Promise<TreeFile | undefined> {
    const listings = new Map<string, Promise<Map<string, TreeEntry>>>();
    const list = (tree: string) => {
        let l = listings.get(tree);
        if (!l) {
            l = readGit(main, ["ls-tree", "-l", "-z", tree], MAX_LISTING_BYTES).then(({ out, cut }) => {
                if (cut) throw new RpcError("A folder in this repository's HEAD is too large to check what its memory files import, so nothing was created. Trust the folder to start the run.", "git_failed");
                const m = new Map<string, TreeEntry>();
                for (const rec of out.split("\0").filter(Boolean)) {
                    const tab = rec.indexOf("\t");
                    const [mode, , oid, size] = rec.slice(0, tab).trim().split(/\s+/);
                    m.set(rec.slice(tab + 1), { mode: mode!, oid: oid!, size: Number(size) || 0 });
                }
                return m;
            });
            listings.set(tree, l);
        }
        return l;
    };
    const head = async (e: TreeEntry, max: number) => (await readGit(main, ["cat-file", "blob", e.oid], Math.min(e.size, Math.max(0, max)))).out;
    // A link's target read once, however many spellings of a path go through it.
    const targets = new Map<string, Promise<string>>();
    const target = (e: TreeEntry) => {
        let t = targets.get(e.oid);
        if (!t) targets.set(e.oid, (t = head(e, MAX_LINK_BYTES)));
        return t;
    };
    const root = `${commit}^{tree}`;
    return async (path) => {
        if (!isInside(path, top)) return undefined;
        let pending = relative(top, path).split(sep).filter(Boolean);
        // The folders the path is in so far, by name and tree.
        let names: string[] = [];
        let trees = [root];
        for (let hops = 0; pending.length; ) {
            const c = pending.shift()!;
            if (c === ".") continue;
            if (c === "..") {
                if (!names.length) return { real: resolve(top, "..", ...pending) };
                names.pop();
                trees.pop();
                continue;
            }
            const entry = (await list(trees.at(-1)!)).get(c);
            if (!entry) return undefined;
            if (entry.mode === "120000") {
                if (++hops > MAX_LINK_HOPS || entry.size > MAX_LINK_BYTES) return undefined;
                const to = await target(entry);
                if (isAbsolute(to)) {
                    const out = resolve(to, ...pending);
                    if (!isInside(out, top)) return { real: out };
                    pending = relative(top, out).split(sep).filter(Boolean);
                    names = [];
                    trees = [root];
                } else pending = [...to.split("/").filter(Boolean), ...pending];
                continue;
            }
            if (entry.mode === "040000") {
                names.push(c);
                trees.push(entry.oid);
                continue;
            }
            if (pending.length || !entry.mode.startsWith("100")) return undefined;
            return { real: join(top, ...names, c), head: (max) => head(entry, max) };
        }
        return undefined;
    };
}

/**
 * How the new worktrees open, decided once for the whole run. Trusted when a
 * folder the user trusted contains them (their main worktree, say). Without
 * their configuration when the user chose that for the Home folder or the main
 * worktree. Otherwise they may have nothing to protect; if they would have
 * configuration, the user decides first (one question, nothing created yet).
 */
function configTrust(host: RunHost, home: string, main: string, committed: string[]): "trusted" | "declined" | "none" {
    // The folder they all go in (or one above it): trusting one sibling worktree says nothing about new ones.
    if (trustedByUser(join(main, WORKTREES_DIR))) return "trusted";
    if (host.declined(home) || host.declined(main)) return "declined";
    const found = [...new Set([...committed, ...projectConfigSummary(home)])];
    if (found.length) {
        throw new RpcError(`The new worktrees will have this project's configuration (${found.join(", ")}), which can run commands on your machine. Trust ${main}, or open them without it.`, "needs_project_trust", main);
    }
    return "none";
}

// ---------------------------------------------------------------------------
// Starting

/** What a run needs of a session (a Runtime). */
export interface RunSession {
    readonly id: string;
    readonly model?: { provider: string; id: string };
    setModel(ref: string, opts: { quiet?: boolean }): Promise<boolean>;
    send(text: string, attachments?: AttachedPart[], literal?: boolean): Promise<unknown>;
}

export interface RunRecord {
    id: string;
    label: string;
    cwd: string;
    at: number;
    sessions: { id: string; model: string; modelName: string; outcome?: RunOutcome }[];
}

/** What a run needs of the engine. */
export interface RunHost {
    listings(): Promise<ProviderListing[]>;
    /** The user chose to open this folder without its configuration. */
    declined(path: string): boolean;
    decline(path: string): void;
    bypassAllowed(cwd: string): boolean;
    stopping(): boolean;
    /** A new session in `cwd` on the default model, which no window shows yet. */
    openSession(cwd: string, mode?: PermissionModeId): Promise<RunSession>;
    /** A session that was never sent anything: closed. */
    discard(id: string): void;
    /** Sent its prompt: closed like any session no window shows, once it has nothing left to do. */
    release(id: string): void;
    /** Saves the run (again, with each session it gets). */
    record(run: RunRecord): void;
    log?: Log;
}

/** Repositories (main worktrees) with a run being started: a second click doesn't start another. */
const starting = new Set<string>();

const messageOf = (e: unknown, fallback: string) => (e instanceof RpcError ? e.message : redact(String((e as Error)?.message ?? "")).slice(0, 300) || fallback);

export async function startRun(host: RunHost, req: RunRequest): Promise<{ runId: string; results: RunResult[] }> {
    const home = req.path;
    if (!isDir(home)) throw new RpcError(`${home} isn't a folder.`, "not_git");
    if (req.mode === "bypassPermissions" && !host.bypassAllowed(home)) {
        throw new RpcError("Bypass mode is off. Start the GUI with --dangerously-skip-permissions or set permissions.allowBypass in your user settings.", "invalid");
    }
    // A repository with a main worktree, its own Git metadata, and Git config that's trusted (or can't run anything).
    let main: string;
    try {
        main = checkCreate(home);
    } catch (e) {
        if (!(e instanceof RpcError) || e.code !== "needs_trust") throw e;
        // One decision must cover both Git and the new checkouts' project
        // configuration. Trusting a nested Home alone would ask again later.
        const root = listWorktrees(home).find((w) => w.main)?.path;
        if (!root) throw e;
        if (!isInside(realpathSync(home), realpathSync(root))) {
            throw new RpcError(`This run needs trusted Git configuration in both ${home} and ${root}. Open each folder from Home and trust it, then retry the run. Nothing was created.`, "run_trust_required");
        }
        throw new RpcError(`This repository's Git configuration can run commands while files are checked out. Trust ${root} and its project configuration to start this run.`, "needs_trust", root);
    }
    if (starting.has(main)) throw new RpcError("A run is already starting in this repository.", "busy");
    starting.add(main);
    try {
        return await run(host, req, main);
    } finally {
        starting.delete(main);
    }
}

async function run(host: RunHost, req: RunRequest, main: string): Promise<{ runId: string; results: RunResult[] }> {
    const listings = await host.listings();
    const checked = await Promise.all(req.models.map((ref) => checkModel(ref, listings, req.images.length > 0, Boolean(req.files?.some((f) => f.kind === "pdf")))));
    const paid = checked.filter((c) => c.ok && c.billing === "api") as Extract<Checked, { ok: true }>[];
    if (paid.length > PAID_WITHOUT_ASKING && !req.confirmPaid) {
        const list = paid.map((c) => `${c.name} (${formatPrice(c.info) ? `${formatPrice(c.info)} per million tokens` : "price unknown"})`).join(", ");
        throw new RpcError(`This starts ${paid.length} models billed per token through an API key: ${list}. Confirm to go ahead.`, "confirm_paid");
    }
    const ready = checked.filter((c) => c.ok);
    const commit = ready.length ? await headCommit(req.path) : "";
    const trust = ready.length ? configTrust(host, req.path, main, await committedConfig(main, commit)) : "none";
    const branches = ready.length ? await branchNames(main) : new Set<string>();

    const runId = `run-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
    const record: RunRecord = { id: runId, label: redact(req.text).replace(/\s+/g, " ").trim().slice(0, 80) || "Attached files", cwd: req.path, at: Date.now(), sessions: [] };
    const slug = promptSlug(req.text);
    const slugs = modelSlugs(req.models);
    /** Names this run tried or used, lower case. */
    const claimed = new Set<string>();
    const taken = (name: string) => {
        const n = name.toLowerCase();
        return claimed.has(n) || branches.has(n) || lexists(join(main, WORKTREES_DIR, name));
    };

    const results: RunResult[] = [];
    // One worktree at a time (Git takes locks); each session starts as soon as its worktree is there.
    for (const [i, c] of checked.entries()) {
        if (!c.ok) {
            results.push({ model: c.ref, modelName: c.name, ok: false, error: c.error });
            continue;
        }
        if (host.stopping()) {
            results.push({ model: c.ref, modelName: c.name, ok: false, error: "The harness server stopped before this model's worktree was made. Start the run again." });
            continue;
        }
        let made: { path: string; branch: string } | undefined;
        let error: string | undefined;
        for (let attempt = 0; attempt < NAME_RETRIES && !made && !error; attempt++) {
            const name = uniqueName(`${slug}-${slugs[i]}`, taken);
            if (!name) break;
            claimed.add(name.toLowerCase());
            try {
                made = await createWorktreeWithHooks({ path: req.path, branch: name, folder: name, base: commit }, host.log);
            } catch (e) {
                // Made meanwhile (by Git outside Harness, say): the next name.
                if (e instanceof RpcError && (e.code === "branch_exists" || e.code === "path_exists")) continue;
                // A timeout's own message says the folder may be half made.
                error = messageOf(e, "Git couldn't create the worktree.") + (e instanceof RpcError && e.code === "timeout" ? "" : " No worktree was made for this model.");
            }
        }
        if (!made) {
            results.push({ model: c.ref, modelName: c.name, ok: false, error: error ?? "No free branch name was found for this model. Rename or delete old branches, then start the run again." });
            continue;
        }
        results.push(await startSession(host, req, record, c, made, trust));
    }
    return { runId, results };
}

async function startSession(host: RunHost, req: RunRequest, record: RunRecord, c: { ref: string; name: string }, made: { path: string; branch: string }, trust: "trusted" | "declined" | "none"): Promise<RunResult> {
    const kept = { model: c.ref, modelName: c.name, branch: made.branch, path: made.path };
    const where = `The worktree is at ${made.path} on ${made.branch}, but`;
    // The safe direction only: what the user chose for the Home folder.
    if (trust === "declined") host.decline(made.path);
    let rt: RunSession;
    try {
        if (host.stopping()) throw new RpcError("the harness server is stopping.");
        rt = await host.openSession(made.path, req.mode);
    } catch (e) {
        return { ...kept, ok: false, error: `${where} its session couldn't start: ${messageOf(e, "unknown error")} Open the folder from Home to try again.` };
    }
    // Never the default model in its place: a session that isn't on its model isn't sent anything.
    const on = (await rt.setModel(c.ref, { quiet: true }).catch(() => false)) && rt.model !== undefined && modelRef(rt.model) === c.ref;
    if (!on) {
        host.discard(rt.id);
        return { ...kept, ok: false, error: `${where} its session couldn't be set to ${c.name}, so it wasn't sent the prompt. Check the provider in Settings → Providers, then open the folder from Home.` };
    }
    record.sessions.push({ id: rt.id, model: c.ref, modelName: c.name, outcome: "working" });
    try {
        host.record(record);
    } catch (e) {
        record.sessions = record.sessions.filter((s) => s.id !== rt.id);
        host.discard(rt.id);
        return { ...kept, ok: false, error: `${where} its run couldn't be saved, so it wasn't sent the prompt: ${messageOf(e, "unknown error")} Check that Harness's data folder is writable, then retry.` };
    }
    try {
        const attachments: AttachedPart[] = [...req.images, ...(req.files ?? [])];
        // A run compares the same task on every model, even when it starts with a slash.
        await rt.send(req.text, attachments.length ? attachments : undefined, true);
    } catch (e) {
        host.release(rt.id);
        return { ...kept, ok: false, error: `${where} the prompt couldn't be sent: ${messageOf(e, "unknown error")}` };
    }
    host.release(rt.id);
    return { ...kept, ok: true, sessionId: rt.id };
}

function isDir(path: string): boolean {
    try {
        return statSync(path).isDirectory();
    } catch {
        return false;
    }
}
