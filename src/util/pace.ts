/**
 * Long loops on the server's one thread (over a large repository's files, say) give the event loop a turn every few
 * milliseconds, so other sessions and the GUI's socket aren't held up behind them: check `due` every so often, and
 * `rest` when it is.
 */
export class Pace {
    private last = performance.now();
    constructor(private ms = 8) {}

    /** It's held the loop long enough to give it a turn. */
    get due(): boolean {
        return performance.now() - this.last > this.ms;
    }

    async rest(): Promise<void> {
        await new Promise((r) => setImmediate(r));
        this.last = performance.now();
    }
}
