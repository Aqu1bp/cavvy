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
    /** The connection is down (or the session gone): every request fails. */
    down = false;
    /** Paths the chosen editor would open as a project: answered null, as fs.exists does. */
    projects = new Set<string>();
    /** Holds answers back until release() (a request in flight). */
    gate?: Promise<void>;
    cache: Cache;
    constructor(max?: number) {
        this.cache = new PathCache({
            max,
            ask: async (_id, paths) => {
                this.asked.push(paths);
                if (this.down) throw new Error("Disconnected");
                await this.gate;
                if (this.down) throw new Error("Disconnected");
                return paths.map((p) => (this.projects.has(p) ? null : (this.files.get(p) ?? null)));
            },
        });
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

describe("choosing another editor", () => {
    test("drops every answer, so links follow the new editor both ways", async () => {
        const w = new World();
        w.files.set("App.sln", "/p/App.sln");
        w.files.set("src/a.ts", "/p/src/a.ts");
        // None chosen: a solution isn't linked (some editor would open it as a project).
        w.projects.add("App.sln");
        const m = new Mounted(w, "Open App.sln and src/a.ts.");
        await w.settle();
        expect(m.html).not.toContain(`data-file="/p/App.sln"`);
        expect(m.html).toContain(`data-file="/p/src/a.ts"`);

        // VS Code chosen: it reads a .sln as text.
        w.projects.clear();
        w.cache.forget();
        await w.settle();
        expect(m.html).toContain(`data-file="/p/App.sln"`);

        // Rider chosen: the link that fs.open would now refuse goes away.
        w.projects.add("App.sln");
        w.cache.forget();
        await w.settle();
        expect(m.html).not.toContain(`data-file="/p/App.sln"`);
        expect(m.html).toContain(`data-file="/p/src/a.ts"`);
        expect(w.asked).toHaveLength(3);
    });

    test("an answer to a request made before the change isn't kept", async () => {
        const w = new World();
        w.files.set("App.sln", "/p/App.sln");
        w.projects.add("App.sln");
        let release!: () => void;
        w.gate = new Promise((r) => (release = r));
        const m = new Mounted(w, "App.sln");
        const inFlight = w.settle();
        await Promise.resolve();
        // The editor changes while the old request is out.
        w.projects.clear();
        w.cache.forget();
        w.gate = undefined;
        release();
        await inFlight;
        await w.settle();
        expect(m.html).toContain(`data-file="/p/App.sln"`);
    });
});

describe("a failed request", () => {
    test("isn't taken as missing: the paths wait and are asked again once the connection is back", async () => {
        const w = new World();
        w.files.set("src/a.ts", "/p/src/a.ts");
        w.down = true;
        const m = new Mounted(w, "See src/a.ts:4.");
        await w.settle();
        expect(w.asked).toHaveLength(1);
        expect(w.cache.lookup("s1")("src/a.ts")).toBeUndefined();
        expect(m.html).not.toContain("md-file");
        // Renders while it's down don't ask again (the scheduled lookup finds nothing to ask).
        m.render();
        m.render();
        expect(await w.settle()).toBeLessThan(30);
        expect(w.asked).toHaveLength(1);

        w.down = false;
        w.cache.retryFailed();
        await w.settle();
        expect(w.asked).toHaveLength(2);
        expect(m.html).toContain(`data-file="/p/src/a.ts" data-line="4"`);
    });

    test("a request that always fails (a session that's gone) is asked once per reconnect, never in a loop", async () => {
        const w = new World();
        w.down = true;
        const m = new Mounted(w, "See src/a.ts and lib/b.ts.");
        const other = new Mounted(w, "And docs/c.md.", "s2");
        await w.settle();
        const first = w.asked.length;
        // Everything else that makes replies render again: answers for another session, files changing.
        w.down = false;
        w.files.set("docs/c.md", "/p/docs/c.md");
        w.cache.forgetMissing("s2");
        other.render();
        await w.settle();
        w.down = true;
        w.cache.forgetMissing("s1");
        m.render();
        expect(await w.settle()).toBeLessThan(30);
        expect(w.asked.filter((b) => b.includes("src/a.ts"))).toHaveLength(1);
        // Each reconnect allows one more try, which fails again and stops.
        w.cache.retryFailed();
        expect(await w.settle()).toBeLessThan(30);
        w.cache.retryFailed();
        expect(await w.settle()).toBeLessThan(30);
        expect(w.asked.filter((b) => b.includes("src/a.ts"))).toHaveLength(3);
        expect(w.asked.length).toBeLessThanOrEqual(first + 4);
    });
});
