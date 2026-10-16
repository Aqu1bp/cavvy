/** RPC-sized pieces without splitting a Unicode surrogate pair during UTF-8 encoding. */
export function* terminalInputChunks(data: string): Generator<string> {
    for (let start = 0; start < data.length;) {
        let end = Math.min(start + 16_384, data.length);
        if (end < data.length && /[\uD800-\uDBFF]/.test(data[end - 1]!)) end--;
        yield data.slice(start, end);
        start = end;
    }
}

/**
 * What's typed while a shell is still being opened (a project script's
 * opening waits on the folder and git first). Held, then sent in order as soon
 * as the shell is open, so a Ctrl+C pressed meanwhile still reaches it (and
 * stops the script being typed); dropped if it doesn't open.
 */
export class EarlyInput {
    private held: string[] | undefined;
    private size = 0;

    /** The shell is being opened: hold what's typed. */
    begin() {
        this.held = [];
        this.size = 0;
    }

    /** True when `data` was held. */
    hold(data: string): boolean {
        if (!this.held) return false;
        // A terminal's worth of typing, not a flood.
        if (this.size + data.length <= 65_536) {
            this.held.push(data);
            this.size += data.length;
        }
        return true;
    }

    /** What was held, in order; nothing is held from now on. */
    take(): string {
        const all = this.held?.join("") ?? "";
        this.held = undefined;
        this.size = 0;
        return all;
    }
}
