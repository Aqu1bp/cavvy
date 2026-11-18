// Keeps the computer from going to sleep on its own while sessions work (the "keepAwake" setting, on by default), so
// a long run isn't cut off by a laptop left alone. Only idle sleep is held off: the display still sleeps, and closing
// the lid or choosing Sleep still does. It's one process held while anything works, started and stopped as the first
// session starts working and the last one stops: on macOS `caffeinate -i -w <pid>`, on Linux `systemd-inhibit` around
// a `cat` reading a pipe from Cavvy. Neither outlives Cavvy: caffeinate watches its pid, and the cat ends when the
// pipe closes, as it does when Cavvy ends however it ends; it's also stopped as Cavvy exits. Elsewhere there's nothing
// to start, and the setting says it isn't available.

import { homedir } from "os";
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
    /** Whether the command can be found (before it's first run). */
    installed?: (bin: string) => boolean;
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

    constructor(private o: KeepAwakeOptions = {}) {}

    private get argv(): string[] | undefined {
        return inhibitorCommand(this.o.platform ?? process.platform, this.o.pid ?? process.pid);
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
        const argv = this.argv;
        if (!argv || this.failed) return false;
        return (this.o.installed ?? ((bin) => Boolean(Bun.which(bin, { PATH: process.env.PATH ?? "" }))))(argv[0]!);
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
        const argv = this.argv;
        if (!argv) {
            this.failed = true;
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
        this.o.log?.(`Keeping the computer awake: ${this.argv?.[0]} ended by itself; not trying again.`);
    }
}

/** Cavvy's one keep-awake: every front end's sessions count in it. */
export const keepAwake = new KeepAwake();
