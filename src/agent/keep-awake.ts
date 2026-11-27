// Keeps the computer from going to sleep on its own while sessions work (the "keepAwake" setting, on by default), so
// a long run isn't cut off by a laptop left alone. Only idle sleep is held off: the display still sleeps, and closing
// the lid or choosing Sleep still does. It's one process held while anything works, started and stopped as the first
// session starts working and the last one stops: on macOS `caffeinate -i -w <pid>`, on Linux `systemd-inhibit` around
// a `cat` reading a pipe from Cavvy. Neither outlives Cavvy: caffeinate watches its pid, and the cat ends when the
// pipe closes, as it does when Cavvy ends however it ends; it's also stopped as Cavvy exits. Elsewhere there's nothing
// to start, and the setting says it isn't available.

import { accessSync, constants } from "fs";
import { homedir } from "os";
import { join } from "path";
import { loadScope } from "../config/settings";

/** A running inhibitor. */
export interface Inhibitor {
    /** Settles when it ends, whoever ended it. */
    exited: Promise<unknown>;
    /** Ends it (it's let go of first, so its end isn't taken for a failure). */
    stop(): void;
}

/** Starts an inhibitor: throws when it can't (not installed). */
export type InhibitorSpawn = (argv: string[]) => Inhibitor;

/** What holds the computer awake on `platform` while `pid` (Cavvy) runs; undefined where nothing does. */
export function inhibitorCommand(platform: NodeJS.Platform, pid: number): string[] | undefined {
    if (platform === "darwin") return ["/usr/bin/caffeinate", "-i", "-w", String(pid)];
    if (platform === "linux") return ["systemd-inhibit", "--what=idle:sleep", "--who=Cavvy", "--why=Agents are working", "--mode=block", "cat"];
    return undefined;
}

/** Where the system's own commands are, looked in first: what's installed there is what's meant, whatever PATH says. */
const SYSTEM_DIRS = ["/usr/bin", "/bin"];

const executable = (path: string) => {
    try {
        accessSync(path, constants.X_OK);
        return true;
    } catch {
        return false;
    }
};

/**
 * The path `bin` runs from: itself when it's a path; else the system's own copy (/usr/bin, /bin) when there's one, else
 * the first on PATH as it is now (the login shell's, once the server has adopted it: src/server/login-env.ts).
 * Undefined when there's none. A spawn given this path runs what was found, not what the PATH the process started
 * with would find.
 */
export function findBin(bin: string, o: { dirs?: string[]; PATH?: string } = {}): string | undefined {
    if (bin.includes("/")) return executable(bin) ? bin : undefined;
    for (const dir of o.dirs ?? SYSTEM_DIRS) {
        const path = join(dir, bin);
        if (executable(path)) return path;
    }
    return Bun.which(bin, { PATH: o.PATH ?? process.env.PATH ?? "" }) ?? undefined;
}

const spawnInhibitor: InhibitorSpawn = (argv) => {
    // stdin a pipe that only Cavvy holds: the cat under systemd-inhibit reads it until Cavvy ends.
    const p = Bun.spawn(argv, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
    return {
        exited: p.exited,
        stop() {
            try {
                void p.stdin.end();
            } catch {
                // already closed
            }
            p.kill();
        },
    };
};

export interface KeepAwakeOptions {
    platform?: NodeJS.Platform;
    pid?: number;
    spawn?: InhibitorSpawn;
    /** Whether the setting is on: read when something starts working with nothing held, and on refresh(). */
    enabled?: () => boolean;
    /** Where a command runs from (findBin): what's checked for being available is what's run. */
    find?: (bin: string) => string | undefined;
    log?: (msg: string) => void;
}

/** The setting as the user's settings have it: on unless turned off. */
export function keepAwakeSetting(): boolean {
    return loadScope("user", homedir()).keepAwake !== false;
}

export class KeepAwake {
    private working = new Set<unknown>();
    private held?: Inhibitor;
    /** It couldn't start, or ended by itself (refused): not tried again until the setting is turned off and on. */
    private failed = false;
    private exitHook = false;
    /** The command with its programs found, once they are: looked up once, for both available() and running it. */
    private found?: string[];

    constructor(private o: KeepAwakeOptions = {}) {}

    private get argv(): string[] | undefined {
        return inhibitorCommand(this.o.platform ?? process.platform, this.o.pid ?? process.pid);
    }

    /** The command to run, its program (and on Linux the cat it runs) as paths; undefined while its program isn't found. */
    private command(): string[] | undefined {
        if (this.found) return this.found;
        const argv = this.argv;
        if (!argv) return undefined;
        const find = this.o.find ?? ((bin: string) => findBin(bin));
        const bin = find(argv[0]!);
        if (!bin) return undefined;
        const rest = argv.slice(1);
        // systemd-inhibit runs its command by name from the PATH it was given, which may not be the one that found it.
        if (rest.at(-1) === "cat") rest[rest.length - 1] = find("cat") ?? "cat";
        return (this.found = [bin, ...rest]);
    }

    /** Whether `key` (a session: anything that tells it apart) is working now. Only a change does anything. */
    set(key: unknown, working: boolean) {
        if (working === this.working.has(key)) return;
        if (working) this.working.add(key);
        else this.working.delete(key);
        this.update();
    }

    /** Nothing that key held is working any more (sessions closed, a server stopping). */
    releaseAll(keys: Iterable<unknown>) {
        let changed = false;
        for (const k of keys) changed = this.working.delete(k) || changed;
        if (changed) this.update();
    }

    /** The setting changed: started or stopped to match, and one that failed is tried again. */
    refresh() {
        if (!this.enabled()) this.failed = false;
        this.update(true);
    }

    /** Whether it can work on this computer, as far as is known: false where there's nothing to run, it isn't installed, or it was refused. */
    available(): boolean {
        return !this.failed && Boolean(this.command());
    }

    /** Whether it's holding the computer awake now. */
    get holding(): boolean {
        return Boolean(this.held);
    }

    /** Lets go now (Cavvy is exiting). */
    stop() {
        const held = this.held;
        this.held = undefined;
        held?.stop();
    }

    private enabled(): boolean {
        if (!this.o.enabled && process.env.CAVVY_NO_KEEP_AWAKE === "1") return false;
        try {
            return (this.o.enabled ?? keepAwakeSetting)();
        } catch {
            return true;
        }
    }

    private update(reread = false) {
        if (!this.working.size) return this.stop();
        if (this.held) {
            if (reread && !this.enabled()) this.stop();
            return;
        }
        if (this.failed || !this.enabled()) return;
        const argv = this.command();
        if (!argv) {
            this.failed = true;
            if (this.argv) this.o.log?.(`Keeping the computer awake: ${this.argv[0]} isn't installed.`);
            return;
        }
        let held: Inhibitor;
        try {
            held = (this.o.spawn ?? spawnInhibitor)(argv);
        } catch (e) {
            this.failed = true;
            this.o.log?.(`Keeping the computer awake: couldn't run ${argv[0]}: ${(e as Error).message}`);
            return;
        }
        this.held = held;
        if (!this.exitHook) {
            this.exitHook = true;
            process.once("exit", () => this.stop());
        }
        void held.exited.then(
            () => this.ended(held),
            () => this.ended(held),
        );
    }

    /** It ended. Not stopped by Cavvy: refused (no permission, no session manager) or ended from outside. */
    private ended(held: Inhibitor) {
        if (this.held !== held) return;
        this.held = undefined;
        this.failed = true;
        this.o.log?.(`Keeping the computer awake: ${this.found?.[0]} ended by itself; not trying again.`);
    }
}

/** Cavvy's one keep-awake: every front end's sessions count in it. */
export const keepAwake = new KeepAwake();
