// The GUI's cache of which paths in replies are files (gui/src/lib/pathcache.ts),
// driven the way Markdown.tsx drives it: a mounted reply renders, holds the
// paths it shows, asks about the ones not known yet, and renders again when
// the cache changes. Checks that this settles (no loop of requests) when there
// are more paths than the cache keeps, and that a file named before it existed
// becomes a link once files may have changed, without anyone calling render.

import { describe, expect, test } from "bun:test";

const { MarkdownRenderer } = await import("../gui/src/lib/markdown");
const { PathCache, mayCreateFiles } = await import("../gui/src/lib/pathcache");

type Cache = InstanceType<typeof PathCache>;

/** Requests the cache made: a work queue standing in for setTimeout, and a log of what was asked. */
class World {
    queue: (() => Promise<void>)[] = [];
    asked: string[][] = [];
    files = new Map<string, string>();
    cache: Cache;
    constructor(max?: number) {
        this.cache = new PathCache({ max, ask: async (_id, paths) => (this.asked.push(paths), paths.map((p) => this.files.get(p) ?? null)) });
    }
    /** Runs queued requests until none are left; how many rounds that took (capped). */
    async settle(cap = 30): Promise<number> {
        let rounds = 0;
        while (this.queue.length && rounds < cap) {
            await Promise.all(this.queue.splice(0).map((f) => f()));
            rounds++;
        }
        return rounds;
    }
}

/** A reply on screen, wired like gui/src/components/blocks/Markdown.tsx. */
class Mounted {
    r = new MarkdownRenderer();
    html = "";
    private release?: () => void;
    private waiting = false;
    private off: () => void;
    constructor(
        private w: World,
        private text: string,
        private id = "s1",
    ) {
        // The memo reads the version signal only while the reply has paths unlinked.
        this.off = w.cache.onChange(() => this.r.watching && this.render());
        this.render();
    }
    render() {
        const segs = this.r.segments(this.text, false, this.w.cache.lookup(this.id));
        this.html = segs.map((s) => (s.kind === "html" ? s.html : "")).join("");
        // The effect: hold what's shown, then ask about what's unknown (one timer at a time).
        this.release?.();
        this.release = this.w.cache.hold(this.id, this.r.paths);
        if (this.r.pending.size && !this.waiting) {
            this.waiting = true;
            this.w.queue.push(async () => {
                this.waiting = false;
                await this.w.cache.resolve(this.id, this.r.pending);
            });
        }
    }
    unmount() {
        this.off();
        this.release?.();
    }
}

/** A reply naming `n` distinct missing files, in paragraphs of 100 (a block links at most 200). */
function reply(prefix: string, n: number): string {
    const paras: string[] = [];
    for (let i = 0; i < n; i += 100) paras.push(Array.from({ length: Math.min(100, n - i) }, (_, j) => `${prefix}/f${i + j}.ts`).join(" "));
    return paras.join("\n\n");
}

describe("more paths on screen than the cache keeps", () => {
    test("each is asked about once, and it settles", async () => {
        const w = new World(300);
        const ms = [new Mounted(w, reply("a", 400)), new Mounted(w, reply("b", 400))];
        const rounds = await w.settle();
        expect(rounds).toBeLessThanOrEqual(2);
        const all = w.asked.flat();
        expect(all).toHaveLength(800);
        expect(new Set(all).size).toBe(800);
        // Rendering again (any other answer arriving) asks nothing more: their answers are held.
        for (const m of ms) m.render();
        expect(await w.settle()).toBe(0);
        expect(w.asked.flat()).toHaveLength(800);
    });

    test("control: dropping the whole map when it's full, as before, never settles", async () => {
        const w = new World(300);
        const c = w.cache as unknown as { known: Map<string, Map<string, unknown>>; evict(id: string): void };
        c.evict = (id) => {
            if ((c.known.get(id)?.size ?? 0) > 300) c.known.set(id, new Map());
        };
        new Mounted(w, reply("a", 400));
        new Mounted(w, reply("b", 400));
        expect(await w.settle(12)).toBe(12);
        expect(w.asked.flat().length).toBeGreaterThan(1600);
    });

    test("answers nothing holds are evicted, oldest first; what's on screen stays", async () => {
        const w = new World(300);
        const a = new Mounted(w, reply("a", 200));
        await w.settle();
        a.unmount();
        const b = new Mounted(w, reply("b", 250));
        await w.settle();
        // a's 200 went (oldest, unheld); b's 250 are held and kept.
        expect(w.cache.size("s1")).toBe(250);
        expect(b.r.paths.size).toBe(250);
        for (const p of b.r.paths) expect(w.cache.lookup("s1")(p)).toBeNull();
        expect(w.cache.lookup("s1")("a/f0.ts")).toBeUndefined();
    });
});

describe("a file named before it existed", () => {
    test("becomes a link when ops say files may have changed, without anything else rendering", async () => {
        const w = new World();
        const m = new Mounted(w, "I'll put the helper in lib/new.ts:3.");
        await w.settle();
        expect(w.asked).toEqual([["lib/new.ts"]]);
        expect(m.html).not.toContain("md-file");

        // Nothing else happens: no polling, nothing asked again.
        expect(await w.settle()).toBe(0);

        // The agent writes it; the Write's diff arrives as a block.patch.
        w.files.set("lib/new.ts", "/p/lib/new.ts");
        const ops = [{ op: "block.patch", turnId: "t", blockId: "w1", patch: { status: "ok", diff: { path: "lib/new.ts" } } }];
        expect(mayCreateFiles(ops)).toBe(true);
        w.cache.forgetMissing("s1");
        await w.settle();
        expect(w.asked).toEqual([["lib/new.ts"], ["lib/new.ts"]]);
        expect(m.html).toContain(`data-file="/p/lib/new.ts" data-line="3"`);
    });

    test("a path that never appears is asked again once per such event, not in a loop", async () => {
        const w = new World();
        new Mounted(w, "See lib/never.ts and lib/also-never.ts.");
        await w.settle();
        w.cache.forgetMissing("s1");
        expect(await w.settle()).toBe(1);
        w.cache.forgetMissing("s1");
        expect(await w.settle()).toBe(1);
        expect(w.asked).toEqual([["lib/never.ts", "lib/also-never.ts"], ["lib/never.ts", "lib/also-never.ts"], ["lib/never.ts", "lib/also-never.ts"]]);
    });

    test("only replies on screen ask again; another session's answers are untouched", async () => {
        const w = new World();
        const m = new Mounted(w, "lib/gone.ts");
        new Mounted(w, "lib/other.ts", "s2");
        await w.settle();
        m.unmount();
        w.cache.forgetMissing("s1");
        expect(await w.settle()).toBe(0);
        expect(w.cache.lookup("s2")("lib/other.ts")).toBeNull();
    });

    test("which ops may have created files", () => {
        expect(mayCreateFiles([{ op: "turn.patch", patch: { status: "done" } }])).toBe(true);
        expect(mayCreateFiles([{ op: "turn.patch", patch: { status: "aborted" } }])).toBe(true);
        expect(mayCreateFiles([{ op: "turn.patch", patch: { status: "running" } }])).toBe(false);
        expect(mayCreateFiles([{ op: "turn.patch", patch: { usage: {} } }])).toBe(false);
        expect(mayCreateFiles([{ op: "agent.block.patch", patch: { diff: {} } }])).toBe(true);
        expect(mayCreateFiles([{ op: "block.patch", patch: { status: "ok", summary: "Read 3 lines" } }])).toBe(false);
        expect(mayCreateFiles([{ op: "append" }])).toBe(false);
    });
});
