// A tree with some paths changed, worked out from the tree it was: only the trees on the way to a changed path are read
// and written again, the rest are the old tree's. A capture that looked at a few changed files (turn-snapshots.ts
// captureNarrowed) makes its tree this way, without a copy of Git's index to write.

import { gitEnvironment } from "../server/git-changes";
import { gitArgv } from "../util/git";

/** An entry to put at a path, or null to take it out. */
export type TreeEdit = { mode: string; oid: string } | null;

type Entry = { mode: string; oid: Buffer };

const TREE = "40000";

/** A tree's entries by name (as bytes, in a latin1 string: one char for each byte, so they sort as Git sorts them). */
export function parseTree(body: Buffer, hashBytes: number): Map<string, Entry> {
    const out = new Map<string, Entry>();
    let pos = 0;
    while (pos < body.length) {
        const sp = body.indexOf(0x20, pos);
        const nul = body.indexOf(0, sp);
        if (sp < 0 || nul < 0 || nul + 1 + hashBytes > body.length) throw new Error("Unrecognized tree object.");
        out.set(body.toString("latin1", sp + 1, nul), { mode: body.toString("latin1", pos, sp), oid: body.subarray(nul + 1, nul + 1 + hashBytes) });
        pos = nul + 1 + hashBytes;
    }
    return out;
}

/** A tree object's bytes, its entries in Git's order: by name, a tree's as if it ended in "/". */
export function formatTree(entries: Map<string, Entry>): Buffer {
    const key = (name: string, e: Entry) => name + (e.mode === TREE ? "/" : "\0");
    const sorted = [...entries].sort(([a, x], [b, y]) => (key(a, x) < key(b, y) ? -1 : 1));
    return Buffer.concat(sorted.flatMap(([name, e]) => [Buffer.from(`${e.mode} ${name}\0`, "latin1"), e.oid]));
}

/**
 * `base` with `edits` made (paths as Git has them, utf-8). `read` gives a tree's bytes; `write` stores new ones and
 * says their id. Throws where the edits don't fit the tree (a file put where a folder stays): the caller works the
 * tree out another way.
 */
export async function editTree(base: string, edits: Map<string, TreeEdit>, hashBytes: number, read: (oid: string) => Promise<Buffer>, write: (body: Buffer) => Promise<string>): Promise<string> {
    /** Each folder's direct edits, and its folders on the way to one. */
    const folders = new Map<string, { files: Map<string, TreeEdit>; dirs: Set<string> }>();
    const folder = (dir: string) => {
        let f = folders.get(dir);
        if (!f) folders.set(dir, (f = { files: new Map(), dirs: new Set() }));
        return f;
    };
    for (const [path, edit] of edits) {
        const bytes = Buffer.from(path, "utf-8").toString("latin1");
        const cut = bytes.lastIndexOf("/");
        let dir = cut < 0 ? "" : bytes.slice(0, cut);
        folder(dir).files.set(bytes.slice(cut + 1), edit);
        while (dir) {
            const up = dir.lastIndexOf("/");
            const parent = up < 0 ? "" : dir.slice(0, up);
            folder(parent).dirs.add(dir.slice(up + 1));
            dir = parent;
        }
    }
    /** The folder's tree again: its id, or undefined when nothing's left in it. */
    const build = async (dir: string, oid: Buffer | undefined): Promise<Buffer | undefined> => {
        const was = oid ? await read(oid.toString("hex")) : undefined;
        const entries = was ? parseTree(was, hashBytes) : new Map<string, Entry>();
        const f = folders.get(dir)!;
        // Files out first (a folder can take a file's place), then the folders, then files in.
        for (const [name, edit] of f.files) if (!edit && entries.get(name)?.mode !== TREE) entries.delete(name);
        for (const name of f.dirs) {
            const had = entries.get(name);
            const made = await build(dir ? `${dir}/${name}` : name, had?.mode === TREE ? had.oid : undefined);
            if (had && had.mode !== TREE) {
                if (made) throw new Error("A file and a folder at one path.");
                continue;
            }
            if (made) entries.set(name, { mode: TREE, oid: made });
            else entries.delete(name);
        }
        for (const [name, edit] of f.files) {
            if (!edit) continue;
            if (entries.get(name)?.mode === TREE) throw new Error("A file and a folder at one path.");
            entries.set(name, { mode: edit.mode.replace(/^0+/, ""), oid: Buffer.from(edit.oid, "hex") });
        }
        if (!entries.size && dir) return undefined;
        const body = formatTree(entries);
        // The same as it was (what was put in was already there): that tree, not written again.
        if (was && oid && body.equals(was)) return oid;
        return Buffer.from(await write(body), "hex");
    };
    return (await build("", Buffer.from(base, "hex")))!.toString("hex");
}

/** Objects read one after another from one `git cat-file --batch`, each asked for once the last is in. */
export class ObjectReader {
    private proc: ReturnType<typeof Bun.spawn>;
    private reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> };
    private buf = Buffer.alloc(0);
    private timer: ReturnType<typeof setTimeout>;

    constructor(cwd: string, env: Record<string, string>, deadline: number) {
        this.proc = Bun.spawn(gitArgv(["cat-file", "--batch"]), { cwd, env: gitEnvironment({ privateEnv: env }), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
        this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader() as unknown as ObjectReader["reader"];
        this.timer = setTimeout(() => this.close(), Math.max(0, deadline - Date.now()));
    }

    private async more() {
        const { value, done } = await this.reader.read();
        if (done || !value) throw new Error("Snapshot objects are missing or unreadable.");
        this.buf = this.buf.length ? Buffer.concat([this.buf, value]) : Buffer.from(value);
    }

    async read(oid: string, type: string): Promise<Buffer> {
        const stdin = this.proc.stdin as import("bun").FileSink;
        stdin.write(`${oid}\n`);
        await stdin.flush();
        let nl: number;
        while ((nl = this.buf.indexOf(10)) < 0) await this.more();
        const [id, kind, size] = this.buf.toString("latin1", 0, nl).split(" ");
        this.buf = this.buf.subarray(nl + 1);
        if (id !== oid || kind !== type) throw new Error("Snapshot objects are missing or unreadable.");
        const n = Number(size);
        while (this.buf.length < n + 1) await this.more();
        const body = Buffer.from(this.buf.subarray(0, n));
        this.buf = this.buf.subarray(n + 1);
        return body;
    }

    /** Waiting to be asked again (kept between captures): it doesn't keep the process running by itself. */
    idle() {
        this.timer.unref?.();
        this.proc.unref();
    }

    /** Asked again: kept to while it reads. */
    busy() {
        this.proc.ref();
    }

    close() {
        clearTimeout(this.timer);
        try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
        this.proc.kill();
    }
}
