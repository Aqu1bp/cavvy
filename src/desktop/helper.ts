// The helper that reads and acts in the person's Mac apps (helper.swift), as an app of its own, Cavvy Desktop Control,
// since that's what macOS shows in Privacy & Security and keeps the person's grants for. The desktop app carries it,
// signed with the app; Cavvy runs a copy of it put outside the app, in the account's Application Support, since macOS
// gives Screen Recording to the outermost app a program sits in, which would be Cavvy rather than the helper. Without
// the app (the terminal), it's built on first use with `xcrun swiftc` (Xcode or its command line tools) and kept in
// Cavvy's home; the same source built again comes out the same (measured: the same code hash), so a grant lasts until
// the helper's source changes.

import { createHash, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "fs";
import { lstat, readdir, readFile } from "fs/promises";
import { homedir } from "os";
import { basename, dirname, join } from "path";
import { paths } from "../config/paths";
import { run } from "../simulator/simctl";
import { NEVER_OFFERED, NEVER_OFFERED_NAME_PATTERNS } from "./apps";
import SOURCE from "./helper.swift" with { type: "text" };

export class DesktopError extends Error {
    constructor(
        message: string,
        /** What the helper said went wrong: "accessibility", "screen", "outside", "front", "human", "cancelled", … */
        readonly code?: string,
    ) {
        super(message);
    }
}

/** The name macOS shows for it in System Settings. */
export const HELPER_NAME = "Cavvy Desktop Control";
const BUILD_MS = 180_000;

/** The helper's source: its own code only, so that it's built again only when that changes (not the never-offered list). */
export function helperSource(): string {
    return SOURCE;
}

export const sourceHash = () => createHash("sha256").update(helperSource()).digest("hex").slice(0, 16);

/**
 * What Cavvy sends a helper it started, in order: the secret back, then the apps never offered, which it refuses
 * itself, whatever it's sent later; until it has them, it refuses every app. Sent on the locked channel: only once the
 * secret is taken is the next line read, and only as that list.
 */
export function handshake(secret: string): string[] {
    const never = { op: "never", ids: NEVER_OFFERED.map((a) => a.bundleId.toLowerCase()), patterns: NEVER_OFFERED_NAME_PATTERNS.map((r) => r.source) };
    return [JSON.stringify({ op: "hello", secret }), JSON.stringify(never)];
}

const dir = () => join(paths.home(), "desktop");
const recordFile = () => join(dir(), "build.json");

interface BuildRecord {
    /** The source the helper there was built from. */
    hash?: string;
    /** A build macOS let use Accessibility. */
    trusted?: string;
    /** A build macOS let take screenshots. */
    screen?: string;
}

/** The grants macOS keeps for one build of the helper. */
export type Grant = "accessibility" | "screen";
const field = (g: Grant) => (g === "screen" ? "screen" : "trusted");

function record(): BuildRecord {
    try {
        return JSON.parse(readFileSync(recordFile(), "utf8")) as BuildRecord;
    } catch {
        return {};
    }
}

function writeRecord(r: BuildRecord) {
    mkdirSync(dir(), { recursive: true, mode: 0o700 });
    writeFileSync(recordFile(), JSON.stringify(r), { mode: 0o600 });
}

/** The helper had that grant: noted, so that a later build that hasn't can say why. */
export function noteTrusted(g: Grant = "accessibility") {
    const r = record();
    if (r.hash && r[field(g)] !== r.hash) writeRecord({ ...r, [field(g)]: r.hash });
}

/** Its grants were reset (tccutil): a later lack of them is a first time again, not a build macOS no longer counts. */
export function forgetTrusted(g: Grant) {
    const r = record();
    if (r[field(g)]) writeRecord({ ...r, [field(g)]: undefined });
}

/** An earlier build had that grant and this one hasn't: macOS keeps the switch on but no longer counts it. */
export function trustedBefore(g: Grant = "accessibility"): boolean {
    const r = record();
    const had = r[field(g)];
    return Boolean(had && had !== r.hash);
}

/**
 * Whether this process may build and run the real helper. Not in Cavvy's tests (CAVVY_TEST, set by test/preload.ts and
 * passed to what they start), unless a live run asks with CAVVY_DESKTOP_LIVE=1: running it is what adds it to macOS's
 * privacy lists, an entry for each test home. Tests use a fake one (setDesktopHelperStarter).
 */
export function realHelperAllowed(): boolean {
    return process.env.CAVVY_TEST !== "1" || process.env.CAVVY_DESKTOP_LIVE === "1";
}

/** Symbol.for(...) on globalThis: how many times a test reached for the real helper (test/preload.ts fails that test). */
export const REAL_HELPER_REFUSED = Symbol.for("cavvy.desktop.realHelperRefused");

/** Refuses, in tests, what reaches macOS for real (`what`: build or run the helper, open System Settings): counted, so the test fails. */
export function refuseRealInTests(what = `build or run the real ${HELPER_NAME}`) {
    if (realHelperAllowed()) return;
    const g = globalThis as Record<symbol, number>;
    g[REAL_HELPER_REFUSED] = (g[REAL_HELPER_REFUSED] ?? 0) + 1;
    throw new DesktopError(`Tests don't ${what}: use a fake one (setDesktopHelperStarter, setDesktopAccess), or set CAVVY_DESKTOP_LIVE=1 for a live run.`, "test");
}

let building: Promise<string> | undefined;

/** Its bundle id: what macOS keeps the person's grants under, with its signature. */
export const HELPER_BUNDLE_ID = "dev.cavvy.desktop.control";

/** What macOS knows a helper by: the name it lists, and the bundle id it keeps the grants under. */
export interface HelperIdentity {
    name: string;
    bundleId: string;
}

export const HELPER_IDENTITY: HelperIdentity = { name: HELPER_NAME, bundleId: HELPER_BUNDLE_ID };
/**
 * A test copy's (desktop-electron/pack.ts --test-copy, scripts/test-copy.ts): an entry of its own in System Settings,
 * so trying a build never touches the grants the person gave the helper they use.
 */
export const TEST_HELPER_IDENTITY: HelperIdentity = { name: `${HELPER_NAME} (Test)`, bundleId: `${HELPER_BUNDLE_ID}.test` };
const IDENTITIES = [HELPER_IDENTITY, TEST_HELPER_IDENTITY];

const APP = `${HELPER_NAME}.app`;
const appOf = (id: HelperIdentity) => `${id.name}.app`;
/** The executable has the bundle's name. */
const executableIn = (app: string) => join(app, "Contents", "MacOS", basename(app, ".app"));

/** The source a helper bundle was built from (its Info.plist says), if it's there. */
function builtFrom(app: string): string | undefined {
    try {
        return /<key>CavvySourceHash<\/key>\s*<string>([0-9a-f]+)<\/string>/.exec(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))?.[1];
    } catch {
        return undefined;
    }
}

/**
 * The helper Cavvy.app carries (Contents/Helpers, built by desktop-electron/pack.ts and signed with the app at
 * install), when Cavvy runs from the app and it's of this source. Never run from there: copied out first (placed()).
 */
export function carried(execPath = process.execPath): string | undefined {
    const app = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1];
    if (!app) return undefined;
    // The helper's own, or a test copy's.
    return IDENTITIES.map((id) => join(app, "Contents", "Helpers", appOf(id))).find((helper) => builtFrom(helper) === sourceHash());
}

let account: Promise<string> | undefined;

/**
 * The account's own home, from its user record, whatever HOME says (a test launch may set it elsewhere): where the
 * carried helper's copy goes, so that it's one path, and one entry in System Settings, for the account.
 */
export function accountHome(): Promise<string> {
    return (account ??= run(["/usr/bin/id", "-P"], { timeoutMs: 10_000 })
        .then((r) => r.stdout.trim().split(":")[8])
        .catch(() => undefined)
        .then((home) => (home?.startsWith("/") ? home : homedir())));
}

/** Account home, as last found: for what's said about where the helper is before it's first started. */
let knownHome: string | undefined;

/**
 * Where the carried helper's copy goes: the account's Application Support, in Cavvy's folder (a test copy's, "Cavvy
 * Test"), the same whatever HOME and CAVVY_HOME are. Outside the app, macOS takes the helper for the app it's in when
 * it gives Screen Recording, so the grant is its own; signed with the app's certificate, it outlasts a new version.
 */
export function placeFor(identity: HelperIdentity, home: string): string {
    return join(home, "Library", "Application Support", identity === TEST_HELPER_IDENTITY ? "Cavvy Test" : "Cavvy", appOf(identity));
}

/** The helper bundle Cavvy runs: the carried one's copy, else the one built in Cavvy's home (`execPath`: the server's, for tests). */
export function helperApp(execPath = process.execPath): string {
    const own = carried(execPath);
    return own ? placeFor(helperIdentity(own), knownHome ?? homedir()) : join(dir(), APP);
}

/** Who the helper Cavvy uses is to macOS, as its Info.plist says: one of the two identities, else the helper's own. */
export function helperIdentity(app = carried() ?? helperApp()): HelperIdentity {
    let id: string | undefined;
    try {
        id = /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/.exec(readFileSync(join(app, "Contents", "Info.plist"), "utf8"))?.[1];
    } catch {
        // Not built yet: it will be the helper's own.
    }
    return IDENTITIES.find((i) => i.bundleId === id) ?? HELPER_IDENTITY;
}

/**
 * The helper's executable, as it's started: the carried one's copy, put in place or put back if it isn't the same as
 * the carried one (so that a copy changed since is never run); else built in Cavvy's home when the source changed.
 */
export async function helperBinary(): Promise<string> {
    refuseRealInTests();
    const own = carried();
    if (own) {
        refuseRealInTests("copy the helper into Application Support");
        knownHome = await accountHome();
        return inUse(await placed(own, placeFor(helperIdentity(own), knownHome)));
    }
    const app = join(dir(), APP);
    if (builtFrom(app) === sourceHash() && existsSync(executableIn(app))) return inUse(app);
    return (building ??= buildIn(dir())
        .then(inUse)
        .finally(() => (building = undefined)));
}

let placing: Promise<string> | undefined;

/**
 * `target`, the same as `from` (each file and folder, byte for byte): copied there again with ditto when it isn't,
 * through a folder beside it and a rename, so that one being started is never half copied. Comparing costs about a
 * millisecond (the helper is some 260 KB; measured 0.4 ms warm, 3 ms cold), against 20 ms for asking codesign.
 */
export function placed(from: string, target: string): Promise<string> {
    return (placing ??= (async () => {
        if (await sameTree(from, target)) return target;
        const parent = dirname(target);
        mkdirSync(parent, { recursive: true, mode: 0o700 });
        const tag = randomBytes(4).toString("hex");
        const tmpDir = join(parent, `${COPYING}${tag}`);
        const copy = join(tmpDir, basename(target));
        try {
            const r = await run(["/usr/bin/ditto", from, copy], { timeoutMs: BUILD_MS }).catch((e: Error) => ({ code: 127, stdout: "", stderr: e.message }));
            if (r.code !== 0 || !(await sameTree(from, copy))) throw new DesktopError(`Couldn't put ${basename(target, ".app")} in ${parent}: ${(r.stderr || r.stdout).trim().split("\n")[0] || "the copy isn't the same"}`);
            const old = join(parent, `${REPLACED}${tag}`);
            try {
                if (existsSync(target)) renameSync(target, old);
                renameSync(copy, target);
            } catch (e) {
                // Another Cavvy put it there in the meantime: fine if it's the same.
                if (!(await sameTree(from, target))) throw new DesktopError(`Couldn't put ${basename(target, ".app")} in ${parent}: ${(e as Error).message}`);
            }
            rmSync(old, { recursive: true, force: true });
            return target;
        } finally {
            rmSync(tmpDir, { recursive: true, force: true });
        }
    })().finally(() => (placing = undefined)));
}

const COPYING = ".helper-copy-";
const REPLACED = ".helper-old-";

/** Whether two files or folders are the same, each file byte for byte (and executable or not), nothing more or less. */
export async function sameTree(a: string, b: string): Promise<boolean> {
    const [x, y] = await Promise.all([lstat(a), lstat(b)]).catch(() => [undefined, undefined]);
    if (!x || !y) return false;
    if (x.isDirectory()) {
        if (!y.isDirectory()) return false;
        const [na, nb] = await Promise.all([readdir(a), readdir(b)]);
        na.sort();
        nb.sort();
        if (na.join("\0") !== nb.join("\0")) return false;
        for (const n of na) if (!(await sameTree(join(a, n), join(b, n)))) return false;
        return true;
    }
    if (!x.isFile() || !y.isFile() || x.size !== y.size || (x.mode & 0o111) !== (y.mode & 0o111)) return false;
    const [p, q] = await Promise.all([readFile(a), readFile(b)]);
    return p.equals(q);
}

/** The helper's executable, noted as the build in use (for what a missing grant's line says), with stale copies gone. */
function inUse(app: string): string {
    if (record().hash !== sourceHash()) writeRecord({ ...record(), hash: sourceHash() });
    clearStale();
    clearStaleCopies(dirname(app));
    return executableIn(app);
}

/**
 * What's left in Cavvy's home that no longer runs: the helper from before it was an app (a binary on its own), and a
 * build that stopped halfway. (Their entries in System Settings stay: the person takes them out with −.)
 */
export function clearStale() {
    let names: string[];
    try {
        names = readdirSync(dir());
    } catch {
        return;
    }
    for (const n of names) if (n === HELPER_NAME || ((n.startsWith(".build-") || n.startsWith(".old-")) && !building)) rmSync(join(dir(), n), { recursive: true, force: true });
}

/**
 * A copy of the carried helper that stopped halfway, beside where it goes: only these, since the folder is the app's
 * too, and only an hour old, since another Cavvy may be copying now.
 */
export function clearStaleCopies(parent: string, now = Date.now()) {
    let names: string[];
    try {
        names = readdirSync(parent);
    } catch {
        return;
    }
    for (const n of names) {
        if (!n.startsWith(COPYING) && !n.startsWith(REPLACED)) continue;
        const at = (() => {
            try {
                return statSync(join(parent, n)).mtimeMs;
            } catch {
                return now;
            }
        })();
        if (now - at > 3_600_000) rmSync(join(parent, n), { recursive: true, force: true });
    }
}

/**
 * Builds the helper as an app bundle in `parent` (Cavvy Desktop Control.app, bundle id dev.cavvy.desktop.control; or
 * `identity`'s, a test copy's), signed ad hoc; returns the bundle. One bundle id at one path is one entry in System
 * Settings; signed ad hoc, macOS counts a grant for that build only, so it lasts until the source changes (the same
 * source builds the same).
 */
export async function buildIn(parent: string, identity: HelperIdentity = HELPER_IDENTITY): Promise<string> {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tag = randomBytes(4).toString("hex");
    const tmpDir = join(parent, `.build-${tag}`);
    const app = join(tmpDir, appOf(identity));
    const src = join(tmpDir, "helper.swift");
    mkdirSync(join(app, "Contents", "MacOS"), { recursive: true, mode: 0o700 });
    writeFileSync(src, helperSource(), { mode: 0o600 });
    try {
        const r = await run(["xcrun", "swiftc", "-O", "-swift-version", "5", "-suppress-warnings", "-o", executableIn(app), src], { timeoutMs: BUILD_MS }).catch((e: Error) => ({ code: 127, stdout: "", stderr: e.message }));
        if (r.code !== 0) {
            if (r.code === 127 || /xcrun: error|not found|no developer tools/i.test(r.stderr)) throw new DesktopError("Desktop control needs Apple's command line tools: run xcode-select --install, then try again.");
            throw new DesktopError(`Couldn't build ${HELPER_NAME}: ${(r.stderr || r.stdout).split("\n").find((l) => /error/.test(l))?.trim() ?? "swiftc failed"}`);
        }
        rmSync(src, { force: true });
        chmodSync(executableIn(app), 0o755);
        writeFileSync(join(app, "Contents", "Info.plist"), infoPlist(sourceHash(), identity));
        const signed = await run(["codesign", "--force", "--sign", "-", "--identifier", identity.bundleId, app], { timeoutMs: BUILD_MS }).catch((e: Error) => ({ code: 127, stdout: "", stderr: e.message }));
        if (signed.code !== 0) throw new DesktopError(`Couldn't sign ${HELPER_NAME}: ${(signed.stderr || signed.stdout).trim().split("\n")[0]}`);
        // In its place. One still running keeps its own copy until it ends.
        const final = join(parent, appOf(identity));
        const old = join(parent, `.old-${tag}`);
        if (existsSync(final)) renameSync(final, old);
        renameSync(app, final);
        rmSync(old, { recursive: true, force: true });
        return final;
    } finally {
        rmSync(tmpDir, { recursive: true, force: true });
    }
}

/** Its Info.plist: a background app (no Dock icon, no menu bar) under its bundle id, and the source it was built from. */
export function infoPlist(hash: string, identity: HelperIdentity = HELPER_IDENTITY): string {
    const entries: [string, string][] = [
        ["CFBundleIdentifier", `<string>${identity.bundleId}</string>`],
        ["CFBundleName", `<string>${identity.name}</string>`],
        ["CFBundleDisplayName", `<string>${identity.name}</string>`],
        ["CFBundleExecutable", `<string>${identity.name}</string>`],
        ["CFBundlePackageType", "<string>APPL</string>"],
        ["CFBundleInfoDictionaryVersion", "<string>6.0</string>"],
        ["CFBundleVersion", "<string>1</string>"],
        ["LSUIElement", "<true/>"],
        ["CavvySourceHash", `<string>${hash}</string>`],
    ];
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${entries.map(([k, v]) => `\t<key>${k}</key>\n\t${v}`).join("\n")}
</dict>
</plist>
`;
}

/** Tests: forget a build in progress. */
export function resetHelperBuild() {
    building = undefined;
}

// ---------------------------------------------------------------------------

/** The helper's process as Bun.spawn gives it: stdin to write, stdout to read, and fd 3, a pipe this process holds. */
interface HelperProcess {
    readonly pid: number;
    readonly stdin: { write(s: string): unknown; flush(): unknown; end(): unknown };
    readonly stdout: ReadableStream<Uint8Array>;
    readonly stdio: (number | null | undefined)[];
    readonly exited: Promise<number>;
    kill(signal?: string): void;
}

export type Reply = Record<string, unknown> & { error?: string; code?: string; human?: number };

/** What a helper (or a fake one, in tests) does. */
export interface DesktopHelperLike {
    readonly running: boolean;
    /** The helper's own process: the person's input is counted per process. */
    readonly pid: number;
    /** How many times the person has used the mouse or keyboard since it started (as last heard). */
    readonly human: number;
    readonly ready: Promise<Reply>;
    call(command: Record<string, unknown>, timeoutMs?: number): Promise<Reply>;
    /** Stops the actions sent with this token, under way or still to come. */
    cancel(token: string): void;
    stop(): void;
    onExit(fn: () => void): void;
}

const COMMAND_MS = 20_000;

interface Pending {
    resolve: (r: Reply) => void;
    reject: (e: Error) => void;
    timer: ReturnType<typeof setTimeout>;
}

/** One running helper: commands as JSON lines on its stdin, answers on its stdout. */
export class DesktopHelper implements DesktopHelperLike {
    private seq = 0;
    private pending = new Map<number, Pending>();
    private buffered = "";
    private exited = false;
    private exits: (() => void)[] = [];
    human = 0;
    readonly ready: Promise<Reply>;

    private constructor(private proc: HelperProcess) {
        let readyResolve!: (r: Reply) => void;
        let readyReject!: (e: Error) => void;
        this.ready = new Promise((res, rej) => ((readyResolve = res), (readyReject = rej)));
        this.ready.catch(() => undefined);
        const read = async () => {
            const decoder = new TextDecoder();
            for await (const chunk of proc.stdout) {
                this.buffered += decoder.decode(chunk, { stream: true });
                let nl: number;
                while ((nl = this.buffered.indexOf("\n")) >= 0) {
                    const line = this.buffered.slice(0, nl);
                    this.buffered = this.buffered.slice(nl + 1);
                    let msg: Reply & { id?: number; event?: string };
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    if (typeof msg.human === "number") this.human = Math.max(this.human, msg.human);
                    if (msg.event === "ready") readyResolve(msg);
                    else if (typeof msg.id === "number") this.settle(msg.id, msg);
                }
            }
        };
        void read().catch(() => undefined);
        const ended = () => {
            if (this.exited) return;
            this.exited = true;
            readyReject(new DesktopError(`${HELPER_NAME} stopped.`));
            for (const p of this.pending.values()) {
                clearTimeout(p.timer);
                p.reject(new DesktopError(`${HELPER_NAME} stopped.`));
            }
            this.pending.clear();
            for (const fn of this.exits) fn();
        };
        void proc.exited.then(ended, ended);
    }

    /**
     * Starts the helper with a secret made for this start: written once to an extra pipe (fd 3) only this process
     * holds, then sent back as the first line on stdin. The helper takes commands only when the two agree.
     */
    static start(bin: string): DesktopHelper {
        refuseRealInTests();
        const secret = randomBytes(32).toString("hex");
        const proc = Bun.spawn([bin], { stdio: ["pipe", "pipe", "ignore", "pipe"] }) as unknown as HelperProcess;
        // A line on fd 3, left open: Bun closes its end when the helper ends (closing it here too would close
        // whatever reuses its number by then).
        const handover = proc.stdio[3];
        if (typeof handover === "number") writeSync(handover, `${secret}\n`);
        const helper = new DesktopHelper(proc);
        helper.write(handshake(secret).map((l) => `${l}\n`).join(""));
        return helper;
    }

    private write(line: string) {
        try {
            this.proc.stdin.write(line);
            void this.proc.stdin.flush();
        } catch {
            // Gone: its exit settles what waits.
        }
    }

    get running(): boolean {
        return !this.exited;
    }

    get pid(): number {
        return this.proc.pid;
    }

    onExit(fn: () => void) {
        this.exits.push(fn);
    }

    private settle(id: number, reply: Reply) {
        const p = this.pending.get(id);
        if (!p) return;
        this.pending.delete(id);
        clearTimeout(p.timer);
        if (typeof reply.error === "string") p.reject(new DesktopError(reply.error, typeof reply.code === "string" ? reply.code : undefined));
        else p.resolve(reply);
    }

    call(command: Record<string, unknown>, timeoutMs = COMMAND_MS): Promise<Reply> {
        if (this.exited) return Promise.reject(new DesktopError(`${HELPER_NAME} stopped.`));
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(id);
                reject(new DesktopError("The Mac didn't answer in time.", "timeout"));
            }, timeoutMs);
            this.pending.set(id, { resolve, reject, timer });
            this.write(`${JSON.stringify({ ...command, id })}\n`);
        });
    }

    cancel(token: string) {
        if (!this.exited) this.write(`${JSON.stringify({ op: "cancel", token })}\n`);
    }

    stop() {
        if (this.exited) return;
        try {
            void this.proc.stdin.end();
        } catch {
            // already closed
        }
        const proc = this.proc;
        setTimeout(() => {
            if (!this.exited) proc.kill("SIGKILL");
        }, 2000).unref?.();
    }
}
