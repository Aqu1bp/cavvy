// A Mac that's a server stays awake while it works. Left to itself a Mac with nobody at it goes to sleep (a Mac mini
// on its default settings does), which stops a build or an agent part way until someone wakes it. So while a session
// there is working, Cavvy holds what `caffeinate -i` holds: the system doesn't sleep for being idle. The display may
// still sleep, and a lid closing or the user choosing Sleep still does.
//
// Held from a turn's start until a minute after the last one ends, and past that for as long as a session has work
// that outlives its turn (a build left running in a shell, a sub-agent), looked at once a minute: that work ends
// without a word to anyone. The minute also means turns that follow one another (a queued message, an agent's loop)
// take it once, not each time. A session that only waits for an answer doesn't keep the Mac awake.

import { childEnv } from "../util/env";

/** What's holding the Mac awake. `gone`: settles if it ends by itself. */
export interface Held {
    kill(): void;
    gone?: Promise<unknown>;
}

/** `caffeinate`, for as long as this process lives (`-w`): a Cavvy that dies doesn't leave the Mac awake for good. */
function caffeinate(): Held | undefined {
    try {
        const proc = Bun.spawn(["/usr/bin/caffeinate", "-i", "-w", String(process.pid)], { stdin: "ignore", stdout: "ignore", stderr: "ignore", env: childEnv() });
        return { kill: () => proc.kill(), gone: proc.exited };
    } catch {
        // No such program, or it can't be started: the Mac sleeps when it would have.
        return undefined;
    }
}

export class WakeLock {
    private held?: Held;
    private timer?: ReturnType<typeof setTimeout>;
    private turns = false;

    constructor(
        private o: {
            /** A session has work under way, a turn or what one left running. */
            working: () => boolean;
            /** Tests bring their own. */
            hold?: () => Held | undefined;
            recheckMs?: number;
        },
    ) {}

    /** A turn started with none running (true), or the last one running ended. */
    turnsRunning(running: boolean) {
        this.turns = running;
        clearTimeout(this.timer);
        this.timer = undefined;
        if (running) this.hold();
        else this.later();
    }

    private hold() {
        if (this.held) return;
        const held = (this.o.hold ?? caffeinate)();
        this.held = held;
        // Ended by something else: held again the next time there's reason to.
        void held?.gone?.then(() => {
            if (this.held === held) this.held = undefined;
        });
    }

    /** Let go in a while, unless a turn has started by then; looked at again for as long as work goes on without one. */
    private later() {
        this.timer = setTimeout(() => {
            this.timer = undefined;
            if (this.turns) return;
            if (!this.o.working()) return this.release();
            this.hold();
            this.later();
        }, this.o.recheckMs ?? 60_000);
        this.timer.unref?.();
    }

    private release() {
        const held = this.held;
        this.held = undefined;
        held?.kill();
    }

    stop() {
        clearTimeout(this.timer);
        this.timer = undefined;
        this.turns = false;
        this.release();
    }
}
