// A recorded ACP session (test/fixtures/protocol/<cli>-<version>-<case>.jsonl, from scripts/probes/acp-*.ts) played
// back to an AcpConnection: the agent's answers and updates, in their order, to what the connection sends. What the
// connection sends that the recording didn't have is kept in `extra` (and answered {} when it's a request).
//
// This module must not import anything from src.

import { readFileSync } from "fs";
import { join } from "path";

const FIXTURES = join(import.meta.dir, "..", "fixtures", "protocol");

export class Replay {
    private frames: { dir: "in" | "out"; frame: any }[];
    private pos = 0;
    private queue: Record<string, any>[] = [];
    private wake?: () => void;
    private closed = false;
    private ids = new Map<number, number>();
    readonly extra: any[] = [];
    readonly sent: any[] = [];
    readonly pid = 0;

    /** `stem`: the fixture's name without .jsonl ("grok-1.0.70-prompt-text"). */
    constructor(stem: string) {
        this.frames = readFileSync(join(FIXTURES, `${stem}.jsonl`), "utf-8")
            .trim()
            .split("\n")
            .map((l) => JSON.parse(l))
            .filter((l) => (l.dir === "in" || l.dir === "out") && typeof l.frame === "object");
        this.flush();
    }

    private push(m: Record<string, any>) {
        this.queue.push(m);
        this.wake?.();
    }

    /** The agent's frames up to the next one the client sent. */
    private flush() {
        while (this.pos < this.frames.length && this.frames[this.pos]!.dir === "in") {
            const f = { ...this.frames[this.pos++]!.frame };
            if (f.method === undefined && this.ids.has(f.id)) f.id = this.ids.get(f.id);
            this.push(f);
        }
        if (this.pos >= this.frames.length) this.end();
    }

    async send(m: any): Promise<boolean> {
        this.sent.push(m);
        const isMatch = (f: any) => (m.method === undefined ? f.method === undefined && f.id === m.id : f.method === m.method);
        // The recording's next frame of the same kind; never past a prompt (what follows it is that prompt's turn).
        let j = this.pos;
        while (j < this.frames.length && !(this.frames[j]!.dir === "out" && isMatch(this.frames[j]!.frame))) {
            if (this.frames[j]!.dir === "out" && this.frames[j]!.frame.method === "session/prompt" && m.method !== "session/prompt") j = this.frames.length;
            else j++;
        }
        if (j >= this.frames.length) {
            this.extra.push(m);
            if (m.method !== undefined && m.id !== undefined) this.push({ jsonrpc: "2.0", id: m.id, result: {} });
            return true;
        }
        if (m.id !== undefined && m.method !== undefined) this.ids.set(this.frames[j]!.frame.id, m.id);
        this.pos = j + 1;
        this.flush();
        return true;
    }

    end() {
        this.closed = true;
        this.wake?.();
    }

    async *messages(): AsyncGenerator<Record<string, any>> {
        for (;;) {
            if (this.queue.length) {
                yield this.queue.shift()!;
                continue;
            }
            if (this.closed) return;
            await new Promise<void>((r) => (this.wake = r));
            this.wake = undefined;
        }
    }

    stderr() {
        return "";
    }
}
