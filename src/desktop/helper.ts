// The helper that reads and acts in the person's Mac apps (helper.swift): built on first use with `xcrun swiftc`
// (Xcode or its command line tools) and kept in Cavvy's home under one name and path, Cavvy Desktop Control, since
// that's what macOS shows in Privacy & Security and keeps the person's grants for. The same source built again comes
// out the same (measured: the same code hash), so a grant lasts until the helper's source changes.

import { createHash, randomBytes } from "crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "fs";
import { join } from "path";
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

/**
 * The helper's source, with the never-offered list compiled in: it refuses those apps itself, whatever it's sent
 * (another process running it can't give it one).
 */
export function helperSource(): string {
    const ids = NEVER_OFFERED.map((a) => JSON.stringify(a.bundleId.toLowerCase())).join(", ");
    const names = NEVER_OFFERED_NAME_PATTERNS.map((r) => JSON.stringify(r.source)).join(", ");
    return `let NEVER_IDS: Set<String> = [${ids}]\nlet NEVER_NAME_PATTERNS: [String] = [${names}]\n\n${SOURCE}`;
}

export const sourceHash = () => createHash("sha256").update(helperSource()).digest("hex").slice(0, 16);

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

function refuseInTests() {
    if (realHelperAllowed()) return;
    const g = globalThis as Record<symbol, number>;
    g[REAL_HELPER_REFUSED] = (g[REAL_HELPER_REFUSED] ?? 0) + 1;
    throw new DesktopError(`Tests don't build or run the real ${HELPER_NAME}: use a fake one (setDesktopHelperStarter), or set CAVVY_DESKTOP_LIVE=1 for a live run.`, "test");
}

let building: Promise<string> | undefined;

/** Its bundle id: what macOS keeps the person's grants under, with its signature. */
export const HELPER_BUNDLE_ID = "dev.cavvy.desktop.control";
const APP = `${HELPER_NAME}.app`;
const executableIn = (app: string) => join(app, "Contents", "MacOS", HELPER_NAME);

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
 * install), when Cavvy runs from the app and it's of this source: signed with the app's certificate, the person's
 * grants outlast a new version.
 */
function carried(execPath = process.execPath): string | undefined {
    const app = /^(.+\.app)\/Contents\/MacOS\/[^/]+$/.exec(execPath)?.[1];
    if (!app) return undefined;
    const helper = join(app, "Contents", "Helpers", APP);
    return builtFrom(helper) === sourceHash() ? helper : undefined;
}

/** The helper bundle Cavvy uses: the app's own, else the one built in Cavvy's home (`execPath`: the server's, for tests). */
export function helperApp(execPath = process.execPath): string {
    return carried(execPath) ?? join(dir(), APP);
}

/** The helper, built in Cavvy's home when the app carries none of this source and it isn't built yet (a few seconds). */
export function helperBinary(): Promise<string> {
    try {
        refuseInTests();
    } catch (e) {
        return Promise.reject(e);
    }
    const own = carried();
    if (own) return Promise.resolve(inUse(own));
    const app = join(dir(), APP);
    if (builtFrom(app) === sourceHash() && existsSync(executableIn(app))) return Promise.resolve(inUse(app));
    return (building ??= buildIn(dir())
        .then(inUse)
        .finally(() => (building = undefined)));
}

/** The helper's executable, noted as the build in use (for what a missing grant's line says), with stale copies gone. */
function inUse(app: string): string {
    if (record().hash !== sourceHash()) writeRecord({ ...record(), hash: sourceHash() });
    clearStale();
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
 * Builds the helper as an app bundle in `parent` (Cavvy Desktop Control.app, bundle id dev.cavvy.desktop.control),
 * signed ad hoc; returns the bundle. One bundle id at one path is one entry in System Settings; signed ad hoc, macOS
 * counts a grant for that build only, so it lasts until the source changes (the same source builds the same).
 */
export async function buildIn(parent: string): Promise<string> {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    const tag = randomBytes(4).toString("hex");
    const tmpDir = join(parent, `.build-${tag}`);
    const app = join(tmpDir, APP);
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
        writeFileSync(join(app, "Contents", "Info.plist"), infoPlist(sourceHash()));
        const signed = await run(["codesign", "--force", "--sign", "-", "--identifier", HELPER_BUNDLE_ID, app], { timeoutMs: BUILD_MS }).catch((e: Error) => ({ code: 127, stdout: "", stderr: e.message }));
        if (signed.code !== 0) throw new DesktopError(`Couldn't sign ${HELPER_NAME}: ${(signed.stderr || signed.stdout).trim().split("\n")[0]}`);
        // In its place. One still running keeps its own copy until it ends.
        const final = join(parent, APP);
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
export function infoPlist(hash: string): string {
    const entries: [string, string][] = [
        ["CFBundleIdentifier", `<string>${HELPER_BUNDLE_ID}</string>`],
        ["CFBundleName", `<string>${HELPER_NAME}</string>`],
        ["CFBundleDisplayName", `<string>${HELPER_NAME}</string>`],
        ["CFBundleExecutable", `<string>${HELPER_NAME}</string>`],
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
        refuseInTests();
        const secret = randomBytes(32).toString("hex");
        const proc = Bun.spawn([bin], { stdio: ["pipe", "pipe", "ignore", "pipe"] }) as unknown as HelperProcess;
        // A line on fd 3, left open: Bun closes its end when the helper ends (closing it here too would close
        // whatever reuses its number by then).
        const handover = proc.stdio[3];
        if (typeof handover === "number") writeSync(handover, `${secret}\n`);
        const helper = new DesktopHelper(proc);
        helper.write(`${JSON.stringify({ op: "hello", secret })}\n`);
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
