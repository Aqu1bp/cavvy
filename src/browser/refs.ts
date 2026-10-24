// The short names ("e12") a snapshot gives page elements, so a call can say which one without coordinates. A ref is
// the number of a DOM node (its backendNodeId) in one tab, valid from the snapshot that listed it until the page
// changes: a navigation, or the user taking over, ends the generation. Numbers are never reused within a tab, so a
// ref from an earlier generation can't point at a different element in a later one.

export interface RefEntry {
    backendNodeId: number;
    role: string;
    name: string;
}

/** Past this many elements named in one generation (an endless feed), the numbering starts over. */
const MAX_NAMED = 20_000;

export class RefTable {
    private byNode = new Map<number, number>();
    private current = new Map<string, RefEntry>();
    private seq = 0;
    /** Refs up to this number were handed out in an earlier generation. */
    private staleThrough = 0;
    generation = 0;

    /** The ref for a node: the one it has in this generation, or the next. */
    refFor(node: number): string {
        if (this.byNode.size >= MAX_NAMED && !this.byNode.has(node)) this.invalidate();
        let n = this.byNode.get(node);
        if (n === undefined) this.byNode.set(node, (n = ++this.seq));
        return `e${n}`;
    }

    /** What a snapshot listed, replacing what the last one did: only the latest snapshot's refs resolve. */
    replace(entries: Map<string, RefEntry>) {
        this.current = entries;
    }

    /** The element a ref names; or, when it can't, why (to tell the agent). */
    resolve(raw: string): { entry: RefEntry } | { error: string } {
        const ref = raw.trim().replace(/^\[|\]$/g, "");
        const entry = this.current.get(ref);
        if (entry) return { entry };
        const n = /^e(\d+)$/.exec(ref)?.[1];
        const note = "Take a new snapshot (BrowserSnapshot) and use the refs it lists.";
        if (n === undefined) return { error: `"${raw}" isn't a ref: refs look like e12, and come from a snapshot. ${note}` };
        if (Number(n) <= this.staleThrough) return { error: `Ref ${ref} is stale: the page changed since the snapshot that listed it. ${note}` };
        return { error: `Unknown ref ${ref}: it isn't in the latest snapshot. ${note}` };
    }

    /** The page changed under the refs: none resolves until the next snapshot lists them again. */
    invalidate() {
        this.generation++;
        this.staleThrough = this.seq;
        this.byNode.clear();
        this.current = new Map();
    }

    get size(): number {
        return this.current.size;
    }
}
