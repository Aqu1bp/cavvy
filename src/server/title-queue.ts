// Session titles asked of one model together. On Claude Code or Codex each one-off request starts a CLI process of its
// own (seconds of CPU, most of it the CLI starting): with many sessions started at once (a run of worktrees, a morning's
// sessions reopened), one process each. The first request goes at once, as before; those that come while it runs wait
// for it and then go in one request, each answered by its line.

/** Asks for titles: one prompt alone (as a single request), or several at once (numbered, one title a line). */
export type TitleAsk = (prompts: string[]) => Promise<(string | undefined)[]>;

interface Waiting {
    prompt: string;
    ask: TitleAsk;
    done: (title: string | undefined) => void;
    fail: (e: unknown) => void;
}

export class TitleQueue {
    /** Keys with a request under way, and what's come for each meanwhile. */
    private queued = new Map<string, Waiting[]>();

    /** A title for `prompt`, asked with `ask` (or with another waiting request's, the same `key`: model and account). */
    title(key: string, prompt: string, ask: TitleAsk): Promise<string | undefined> {
        return new Promise((done, fail) => {
            const item: Waiting = { prompt, ask, done, fail };
            const waiting = this.queued.get(key);
            if (waiting) {
                waiting.push(item);
                return;
            }
            this.queued.set(key, []);
            void this.run(key, [item]);
        });
    }

    private async run(key: string, items: Waiting[]) {
        try {
            const titles = await items[0]!.ask(items.map((i) => i.prompt));
            items.forEach((item, i) => item.done(titles[i]));
        } catch (e) {
            for (const item of items) item.fail(e);
        }
        const next = this.queued.get(key) ?? [];
        if (!next.length) {
            this.queued.delete(key);
            return;
        }
        this.queued.set(key, []);
        void this.run(key, next);
    }
}

/** The request for several titles at once: each prompt numbered, a title a line back. */
export function numberedTitles(prompts: string[]): string {
    return prompts.map((p, i) => `<session number="${i + 1}">\n${p}\n</session>`).join("\n\n");
}

/** Each numbered line's title, by its number; undefined where a line is missing. */
export function titlesByNumber(reply: string, n: number): (string | undefined)[] {
    const out: (string | undefined)[] = Array.from({ length: n }, () => undefined);
    for (const line of reply.split("\n")) {
        const m = /^\s*(?:session\s+)?(\d+)\s*[.):-]\s*(.+?)\s*$/i.exec(line);
        if (!m) continue;
        const i = Number(m[1]) - 1;
        if (i >= 0 && i < n && out[i] === undefined) out[i] = m[2];
    }
    return out;
}
