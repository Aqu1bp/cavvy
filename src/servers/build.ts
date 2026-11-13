// Which build of Cavvy this is, and that same build made for a server.
//
// A server runs the build the machine that set it up runs, so the two speak
// the same protocol. Until Cavvy publishes builds, the server's is compiled
// here from the checkout this Cavvy runs from (Bun compiles for Linux from
// any machine), and kept in ~/.cavvy/cache/server-builds/.

import { createHash } from "crypto";
import { cpSync, createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { cavvyHome } from "../config/paths";
import { childEnv } from "../util/env";
import { BUILD_ID, type LinuxTarget } from "./remote";
import { ServerError } from "./store";

/**
 * The Bun a server's Cavvy runs on, whichever Bun compiles it: the one the
 * desktop app's server uses (desktop-electron/pack.ts) and CI tests with
 * (.github/workflows/ci.yml). test/servers-unit.test.ts holds the three together.
 */
export const SERVER_BUN = "1.4.4";

/** Set when Cavvy is compiled (`--define`): a compiled program has no checkout to ask. */
declare const CAVVY_BUILD_ID: string | undefined;

/** What decides a build: a change outside these leaves the server's program as it was. */
const BUILD_PATHS = ["src", "gui/src", "gui/index.html", "gui/package.json", "gui/vite.config.ts", "package.json", "bun.lock", "tsconfig.json"];

/** The checkout this Cavvy runs from, when it runs from one. */
export function sourceRoot(): string | undefined {
    const root = resolve(import.meta.dir, "..", "..");
    return existsSync(join(root, "src", "index.ts")) && existsSync(join(root, ".git")) ? root : undefined;
}

/** For git in the checkout's own repository, whatever one the environment names. */
function gitEnv(): Record<string, string> {
    const env = childEnv();
    for (const k of Object.keys(env)) if (k.startsWith("GIT_") && k !== "GIT_PAGER" && k !== "GIT_TERMINAL_PROMPT") delete env[k];
    return env;
}

function git(root: string, args: string[]): string | undefined {
    const r = Bun.spawnSync(["git", ...args], { cwd: root, stdin: "ignore", stdout: "pipe", stderr: "ignore", env: gitEnv() });
    return r.exitCode === 0 ? r.stdout.toString() : undefined;
}

/** Set with CAVVY_BUILD_ID: when the commit this build is from was made, in seconds. */
declare const CAVVY_BUILD_TIME: number | undefined;

let knownTime: number | undefined | null = null;

/**
 * When the commit this build is from was made (seconds): what puts two builds in order where no checkout can
 * (compareBuilds). Undefined for a build that wasn't told and has no checkout to ask.
 */
export function thisBuildTime(): number | undefined {
    if (knownTime !== null) return knownTime;
    if (typeof CAVVY_BUILD_TIME === "number" && Number.isSafeInteger(CAVVY_BUILD_TIME) && CAVVY_BUILD_TIME > 0) return (knownTime = CAVVY_BUILD_TIME);
    const root = sourceRoot();
    const at = root ? Number(git(root, ["show", "-s", "--format=%ct", "HEAD"])?.trim()) : NaN;
    return (knownTime = Number.isSafeInteger(at) && at > 0 ? at : undefined);
}

/** What thisBuild() says when it can't tell: a compiled Cavvy that wasn't told, with no checkout to ask. */
export const UNKNOWN_BUILD = "unknown-build";

let known: string | undefined;

/**
 * This build's name: the commit it's from, and what's changed on top of it
 * (a hash of the changed files that go into a build) when something has.
 */
export function thisBuild(): string {
    // Tests name builds themselves (test/helpers/fake-ssh.ts).
    const named = process.env.CAVVY_BUILD;
    if (named && BUILD_ID.test(named)) return named;
    if (known) return known;
    if (typeof CAVVY_BUILD_ID === "string" && BUILD_ID.test(CAVVY_BUILD_ID)) return (known = CAVVY_BUILD_ID);
    const root = sourceRoot();
    const commit = root ? git(root, ["rev-parse", "--verify", "HEAD"])?.trim() : undefined;
    if (!root || !commit || !/^[0-9a-f]{40}$/.test(commit)) return (known = UNKNOWN_BUILD);
    const changed = (git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", ...BUILD_PATHS]) ?? "").split("\0").filter(Boolean);
    if (!changed.length) return (known = commit.slice(0, 12));
    const h = createHash("sha256");
    for (const entry of changed.sort()) {
        h.update(entry);
        // "XY path": a rename's old name is the next entry, which has no status and reads as a path that's gone.
        const file = join(root, entry.slice(3));
        try {
            if (statSync(file).isFile()) h.update(readFileSync(file));
        } catch {
            h.update("\0gone");
        }
    }
    return (known = `${commit.slice(0, 12)}-${h.digest("hex").slice(0, 8)}`);
}

/** How a server's build stands to this one. `different`: neither is known to come after the other. */
export type BuildRelation = "same" | "older" | "newer" | "different";

/**
 * Whether `theirs` comes before or after this build, by the commits they're
 * from. A checkout says, of commits it has. Where it can't (no checkout: the
 * installed app; a commit it hasn't fetched), the times the two commits were
 * made say, when both are known (`times`): a server tells its own. A build
 * with changes on top of its commit, or one that nothing can place, is
 * `different`.
 */
export function compareBuilds(theirs: string, mine = thisBuild(), root = sourceRoot(), times: { theirs?: number; mine?: number } = {}): BuildRelation {
    if (theirs === mine) return "same";
    const commit = (id: string) => /^([0-9a-f]{12})$/.exec(id)?.[1];
    const a = commit(mine);
    const b = commit(theirs);
    if (!a || !b) return "different";
    if (root) {
        const run = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: root, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: gitEnv() }).exitCode === 0;
        if (run(["merge-base", "--is-ancestor", b, a])) return "older";
        if (run(["merge-base", "--is-ancestor", a, b])) return "newer";
        // It has both and neither comes after the other (two branches): that's known, and the times say nothing more.
        if (run(["cat-file", "-e", `${a}^{commit}`]) && run(["cat-file", "-e", `${b}^{commit}`])) return "different";
    }
    if (times.theirs !== undefined && times.mine !== undefined && times.theirs !== times.mine) return times.theirs < times.mine ? "older" : "newer";
    return "different";
}

export interface ServerBuild {
    id: string;
    target: LinuxTarget;
    /** The program and its GUI, as one .tar.gz to unpack on the server. */
    bundle: string;
    bundleBytes: number;
    /** Of the program inside: checked again once it's on the server. */
    sha256: string;
    /** The browser GUI is in it (`cavvy gui --server`). */
    gui: boolean;
}

const cacheDir = () => join(cavvyHome(), "cache", "server-builds");

/** Whether what the GUI is built from, or the built GUI itself, is newer than `since`: outside the build's name, and what fixes a GUI that wouldn't build. */
export function guiChangedSince(since: number, root = sourceRoot()): boolean {
    if (!root) return false;
    return ["node_modules", "bun.lock", "package.json", join("dist", "index.html")].some((f) => {
        try {
            return statSync(join(root, "gui", f)).mtimeMs > since;
        } catch {
            return false;
        }
    });
}

/** The GUI can go in a build made here: it's built, or its dependencies are there to build it with. */
export function guiAvailable(root = sourceRoot()): boolean {
    return Boolean(root) && (existsSync(join(root!, "gui", "node_modules")) || existsSync(join(root!, "gui", "dist", "index.html")));
}

async function sha256File(file: string): Promise<string> {
    const h = createHash("sha256");
    for await (const chunk of createReadStream(file)) h.update(chunk as Buffer);
    return h.digest("hex");
}

async function run(argv: string[], cwd: string, signal?: AbortSignal, env: Record<string, string> = {}): Promise<{ ok: boolean; out: string }> {
    const proc = Bun.spawn(argv, { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", env: { ...childEnv(), ...env } });
    const kill = () => proc.kill();
    signal?.addEventListener("abort", kill, { once: true });
    try {
        const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
        return { ok: code === 0 && !signal?.aborted, out: (err.trim() || out.trim()).split("\n").slice(-6).join("\n") };
    } finally {
        signal?.removeEventListener("abort", kill);
    }
}

/** Keeps the builds made last: an update leaves the one before it for a while, and nothing older. */
function prune(keep: string) {
    try {
        const all = readdirSync(cacheDir())
            .filter((d) => d !== keep && !d.startsWith("."))
            .map((d) => ({ d, at: statSync(join(cacheDir(), d)).mtimeMs }))
            .sort((a, b) => b.at - a.at);
        for (const { d } of all.slice(1)) rmSync(join(cacheDir(), d), { recursive: true, force: true });
        for (const d of readdirSync(cacheDir())) if (d.startsWith(".tmp-") && Date.now() - statSync(join(cacheDir(), d)).mtimeMs > 3_600_000) rmSync(join(cacheDir(), d), { recursive: true, force: true });
    } catch {
        // nothing kept yet
    }
}

/**
 * This build for a server of that kind: made once, then kept. `onStep` says
 * what's happening, for the line the user watches.
 */
export async function serverBuild(target: LinuxTarget, o: { onStep?: (text: string) => void; signal?: AbortSignal } = {}): Promise<ServerBuild> {
    const id = thisBuild();
    const dir = join(cacheDir(), id, target);
    const meta = join(dir, "bundle.json");
    const bundle = join(dir, "bundle.tar.gz");
    if (existsSync(meta) && existsSync(bundle)) {
        try {
            const m = JSON.parse(readFileSync(meta, "utf-8")) as { sha256?: unknown; gui?: unknown; guiFailed?: unknown };
            // One made before the GUI was built here is made again with it. One whose GUI was tried and didn't build
            // is kept until something that could have put it right has changed since (its dependencies installed
            // again, the GUI built by hand as the user is told to): until then it would only fail the same way.
            const stillFails = m.guiFailed === true && !guiChangedSince(statSync(meta).mtimeMs);
            if (typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) && (m.gui === true || stillFails || !guiAvailable())) return { id, target, bundle, bundleBytes: statSync(bundle).size, sha256: m.sha256, gui: m.gui === true };
        } catch {
            // made again below
        }
    }
    if (o.signal?.aborted) throw new ServerError("Stopped.");
    const root = sourceRoot();
    if (!root || id === UNKNOWN_BUILD) throw new ServerError("This copy of Cavvy can't make a server's build: it isn't running from a checkout.");
    // Bun itself when Cavvy runs on it; `bun` on PATH otherwise.
    const bun = /(^|[/\\])bun(\.exe)?$/.test(process.execPath) ? process.execPath : Bun.which("bun", { PATH: process.env.PATH ?? "" });
    if (!bun) throw new ServerError("Making a server's build needs Bun (https://bun.sh), which isn't on PATH.");

    mkdirSync(cacheDir(), { recursive: true, mode: 0o700 });
    const tmp = mkdtempSync(join(cacheDir(), ".tmp-"));
    try {
        const out = join(tmp, "bundle.tar.gz");
        const { sha256, gui, guiFailed } = await packServerBuild(root, id, target, tmp, out, { ...o, bun });
        mkdirSync(join(cacheDir(), id), { recursive: true, mode: 0o700 });
        rmSync(dir, { recursive: true, force: true });
        mkdirSync(dir, { mode: 0o700 });
        renameSync(out, bundle);
        writeFileSync(meta, JSON.stringify({ sha256, gui, ...(guiFailed ? { guiFailed } : {}) }) + "\n");
        prune(id);
        return { id, target, bundle, bundleBytes: statSync(bundle).size, sha256, gui };
    } finally {
        rmSync(tmp, { recursive: true, force: true });
    }
}

/**
 * Compiles build `id` from the checkout at `root` for a server of that kind and packs it as `out` (a .tar.gz of the
 * program, and its GUI when there is one), working in `tmp`. One set of steps for every build a server gets: made
 * when it's needed (serverBuild), put in the desktop app when that's packed (desktop-electron/pack.ts), or published
 * (scripts/release-server-builds.ts). `guiBuilt`: the GUI in gui/dist was just built, and is taken as it is.
 */
export async function packServerBuild(root: string, id: string, target: LinuxTarget, tmp: string, out: string, o: { onStep?: (text: string) => void; signal?: AbortSignal; bun: string; guiBuilt?: boolean }): Promise<{ sha256: string; gui: boolean; guiFailed: boolean }> {
    const stage = join(tmp, `stage-${target}`);
    mkdirSync(stage);
    o.onStep?.(`Building Cavvy for ${targetName(target)}…`);
    const built = await run(
        [o.bun, "build", "--compile", "--minify", "--sourcemap=none", `--target=bun-${target}-v${SERVER_BUN}`, "--define", `CAVVY_BUILD_ID=${JSON.stringify(id)}`, ...buildTimeDefine(), "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--outfile", join(stage, "cavvy"), join(root, "src", "index.ts"), join(root, "src", "agent", "stat-worker.ts")],
        root,
        o.signal,
    );
    if (!built.ok || !existsSync(join(stage, "cavvy"))) throw new ServerError(o.signal?.aborted ? "Stopped." : `The server's build failed:\n${built.out}`);
    // Bun leaves source maps beside it whatever it's told: only the program goes.
    for (const f of readdirSync(stage)) if (f !== "cavvy") rmSync(join(stage, f), { recursive: true, force: true });

    const guiDist = join(root, "gui", "dist");
    let gui = false;
    let guiFailed = false;
    if (!o.guiBuilt && existsSync(join(root, "gui", "node_modules"))) {
        o.onStep?.("Building its GUI…");
        const g = await run([o.bun, "run", "build"], join(root, "gui"), o.signal);
        if (!g.ok && o.signal?.aborted) throw new ServerError("Stopped.");
        gui = g.ok && existsSync(join(guiDist, "index.html"));
        // Said, not swallowed: the build goes without it, and `gui --server` would be where it's missed.
        guiFailed = !gui;
        if (!gui) o.onStep?.(`The GUI didn't build, so the server gets Cavvy without it:\n${g.out}`);
    } else gui = existsSync(join(guiDist, "index.html"));
    if (gui) cpSync(guiDist, join(stage, "gui"), { recursive: true });

    const sha256 = await sha256File(join(stage, "cavvy"));
    // macOS's tar would add its own metadata files, which a Linux tar unpacks as clutter.
    const tar = await run(["tar", "-czf", out, "-C", stage, "cavvy", ...(gui ? ["gui"] : [])], tmp, o.signal, { COPYFILE_DISABLE: "1" });
    // Packed: the unpacked copy (over a hundred MB) isn't left in the caller's folder.
    rmSync(stage, { recursive: true, force: true });
    if (!tar.ok) throw new ServerError(o.signal?.aborted ? "Stopped." : `Couldn't pack the server's build:\n${tar.out}`);
    return { sha256, gui, guiFailed };
}

/** For the compiler: this build's time, said to the program being made (thisBuildTime). */
export function buildTimeDefine(): string[] {
    const at = thisBuildTime();
    return at === undefined ? [] : ["--define", `CAVVY_BUILD_TIME=${at}`];
}

/** A kind of server, in words. */
export const targetName = (target: LinuxTarget) => (target === "linux-arm64" ? "Linux arm64" : "Linux x64");

/**
 * The kinds a packed desktop app carries a build for: for x64, the one that runs on every x64 processor (a
 * machine that could run the other runs this too), so the app carries two builds and not three.
 */
export const CARRIED_TARGETS = ["linux-x64-baseline", "linux-arm64"] as const satisfies readonly LinuxTarget[];

/** The builds a packed desktop app carries for its servers (desktop-electron/pack.ts), if this program runs from one. */
export function bundledBuildsDir(execPath = process.execPath): string | undefined {
    const app = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1];
    const dir = app && join(app, "Contents", "Resources", "server-builds");
    return dir && existsSync(dir) ? dir : undefined;
}

/**
 * The builds that came with this program, for a Cavvy that has no checkout to make one from. They're this build's
 * own or they aren't used: a server runs what the machine that set it up runs.
 */
export function bundledSource(dir: string, id = thisBuild()): BuildSource {
    const one = (carried: LinuxTarget) => {
        try {
            const m = JSON.parse(readFileSync(join(dir, carried, "bundle.json"), "utf-8")) as { id?: unknown; sha256?: unknown; gui?: unknown };
            const bundle = join(dir, carried, "bundle.tar.gz");
            return m.id === id && typeof m.sha256 === "string" && /^[0-9a-f]{64}$/.test(m.sha256) && existsSync(bundle) ? { sha256: m.sha256, gui: m.gui === true, bundle } : undefined;
        } catch {
            return undefined;
        }
    };
    // The very kind asked for, or for an x64 machine the build every x64 machine runs.
    const read = (target: LinuxTarget) => one(target) ?? (target === "linux-x64" ? one("linux-x64-baseline") : undefined);
    return {
        id,
        gui: (read("linux-x64") ?? read("linux-arm64"))?.gui ?? false,
        build: async (target) => {
            const m = read(target);
            // The app was replaced under this program (an update that hasn't restarted it): what it carries now is the new one's.
            if (!m && existsSync(join(dir, target === "linux-x64" ? "linux-x64-baseline" : target, "bundle.json"))) throw new ServerError("Cavvy was updated since it started. Quit and reopen it, then try again.");
            if (!m) throw new ServerError(`This copy of Cavvy came without a build for ${targetName(target)} servers.`);
            return { id, target, bundle: m.bundle, bundleBytes: statSync(m.bundle).size, sha256: m.sha256, gui: m.gui };
        },
        compare: (theirs, theirsAt) => compareBuilds(theirs, id, sourceRoot(), { theirs: theirsAt, mine: thisBuildTime() }),
    };
}

/** Where a server's builds come from. Today: made here from the checkout. */
export interface BuildSource {
    /** The build this machine runs, which a server it sets up should run too. */
    id: string;
    /** Its builds carry the GUI. */
    gui: boolean;
    build(target: LinuxTarget, o?: { onStep?: (text: string) => void; signal?: AbortSignal }): Promise<ServerBuild>;
    /** How a build found on a server stands to `id`. `theirsAt`: when its commit was made, if the server says. */
    compare(theirs: string, theirsAt?: number): BuildRelation;
}

export function localSource(): BuildSource {
    return { id: thisBuild(), gui: guiAvailable(), build: serverBuild, compare: (theirs, theirsAt) => compareBuilds(theirs, thisBuild(), sourceRoot(), { theirs: theirsAt, mine: thisBuildTime() }) };
}
