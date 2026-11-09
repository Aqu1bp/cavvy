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

/**
 * Objects read one after another from one `git cat-file --batch-command`, each asked for once the last is in: a blob
 * that may be too big to want is asked about first, and its bytes only when they're wanted. Git older than 2.36 has
 * only --batch, which sends every blob asked for whole: that, where it's all there is.
 */
export class ObjectReader {
    /** Whether git has --batch-command: undefined until a reader's found out. */
    static batchCommand: boolean | undefined;
    private proc!: ReturnType<typeof Bun.spawn>;
    private reader!: { read(): Promise<{ value?: Uint8Array; done: boolean }>; releaseLock(): void };
    private command = false;
    /** Bytes git has sent. */
    received = 0;
    /** Whether `reader` holds its stdout (let go while idle). */
    private held = true;
    /** What's come in and not yet taken, in the pieces it came in (joined once, when taken). */
    private chunks: Buffer[] = [];
    private have = 0;
    private timer: ReturnType<typeof setTimeout>;
    /** Called once it's closed, by whoever closed it (its deadline included). */
    onClose?: () => void;

    constructor(private cwd: string, private env: Record<string, string>, deadline: number) {
        this.start(ObjectReader.batchCommand !== false);
        this.timer = setTimeout(() => this.close(), Math.max(0, deadline - Date.now()));
    }

    private start(command: boolean) {
        this.command = command;
        this.proc = Bun.spawn(gitArgv(["cat-file", command ? "--batch-command" : "--batch"]), { cwd: this.cwd, env: gitEnvironment({ privateEnv: this.env }), stdin: "pipe", stdout: "pipe", stderr: "ignore" });
        this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader() as unknown as ObjectReader["reader"];
        this.held = true;
    }

    /**
     * `f`, the requests it writes and the answers it reads. Where git stopped without a word as it started (an
     * older git, which doesn't know --batch-command, says why on stderr and exits): once more with --batch, which
     * says from then on whether that's what it was.
     */
    private async ask<T>(f: () => Promise<T>): Promise<T> {
        try {
            return await f();
        } catch (e) {
            if (!this.command || this.received || this.closed) throw e;
            // A git that won't start in this folder, or was stopped, isn't an old one.
            const code = await Promise.race([this.proc.exited, Bun.sleep(1000).then(() => undefined)]);
            if (!code || this.proc.signalCode || this.closed) throw e;
            try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
            this.chunks = [];
            this.have = 0;
            this.start(false);
            const out = await f();
            ObjectReader.batchCommand = false;
            return out;
        }
    }

    private async more() {
        if (!this.held) this.busy();
        const { value, done } = await this.reader.read();
        if (done || !value) throw new Error("Snapshot objects are missing or unreadable.");
        if (this.command && !this.received) ObjectReader.batchCommand = true;
        this.chunks.push(Buffer.from(value.buffer, value.byteOffset, value.byteLength));
        this.have += value.byteLength;
        this.received += value.byteLength;
    }

    /** Requests, written and sent: `contents` or `info` with --batch-command, the id alone (contents) with --batch. */
    private async send(oids: readonly string[], what: "contents" | "info" = "contents") {
        const stdin = this.proc.stdin as import("bun").FileSink;
        stdin.write(oids.map((o) => (this.command ? `${what} ${o}\n` : `${o}\n`)).join(""));
        await stdin.flush();
    }

    /** The next `n` bytes, waited for. */
    private async take(n: number): Promise<Buffer> {
        while (this.have < n) await this.more();
        const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks, this.have);
        const out = Buffer.from(all.subarray(0, n));
        this.chunks = all.length > n ? [all.subarray(n)] : [];
        this.have -= n;
        return out;
    }

    /** Past the next `n` bytes, without holding them. */
    private async skip(n: number) {
        while (n > 0) {
            if (!this.have) await this.more();
            const first = this.chunks[0]!, k = Math.min(n, first.length);
            if (k === first.length) this.chunks.shift();
            else this.chunks[0] = first.subarray(k);
            this.have -= k;
            n -= k;
        }
    }

    /** The next line, without its newline. */
    private async line(): Promise<string> {
        for (let seen = 0, k = 0; ; ) {
            for (; k < this.chunks.length; k++) {
                const nl = this.chunks[k]!.indexOf(10);
                if (nl >= 0) {
                    const line = await this.take(seen + nl + 1);
                    return line.toString("latin1", 0, line.length - 1);
                }
                seen += this.chunks[k]!.length;
            }
            await this.more();
        }
    }

    /** One object's header and body; undefined when the repository doesn't have it. A blob over `maxBlob` bytes, without its body. */
    private async next(oid: string, maxBlob = Infinity): Promise<{ type: string; buf?: Buffer } | undefined> {
        const [id, kind, size] = (await this.line()).split(" ");
        if (id !== oid) throw new Error("Snapshot objects are missing or unreadable.");
        if (kind === "missing" || size === undefined) return undefined;
        if (kind === "blob" && Number(size) > maxBlob) {
            await this.skip(Number(size) + 1);
            return { type: kind };
        }
        const body = await this.take(Number(size) + 1);
        return { type: kind!, buf: body.subarray(0, body.length - 1) };
    }

    async read(oid: string, type: string): Promise<Buffer> {
        const o = await this.ask(async () => {
            await this.send([oid]);
            return this.next(oid);
        });
        if (!o?.buf || o.type !== type) throw new Error("Snapshot objects are missing or unreadable.");
        return o.buf;
    }

    /**
     * Several at once, asked for together: those the repository has, by id; a blob over `maxBlob` bytes, without its
     * bytes (with --batch-command, git doesn't send them either: each is asked about first).
     */
    async readAll(oids: readonly string[], maxBlob?: number): Promise<Map<string, { type: string; buf?: Buffer }>> {
        if (!oids.length) return new Map();
        return this.ask(async () => {
            const out = new Map<string, { type: string; buf?: Buffer }>();
            let wanted = oids;
            if (this.command && maxBlob !== undefined) {
                await this.send(oids, "info");
                const fit: string[] = [];
                for (const oid of oids) {
                    const [id, kind, size] = (await this.line()).split(" ");
                    if (id !== oid) throw new Error("Snapshot objects are missing or unreadable.");
                    if (kind === "missing" || size === undefined) continue;
                    if (kind === "blob" && Number(size) > maxBlob) out.set(oid, { type: kind });
                    else fit.push(oid);
                }
                wanted = fit;
            }
            if (!wanted.length) return out;
            await this.send(wanted);
            for (const oid of wanted) {
                const o = await this.next(oid, maxBlob);
                if (o) out.set(oid, o);
            }
            // In the order asked for.
            return new Map(oids.filter((o) => out.has(o)).map((o) => [o, out.get(o)!]));
        });
    }

    /** Waiting to be asked again (kept between captures): it doesn't keep the process running by itself. */
    idle() {
        this.timer.unref?.();
        this.proc.unref();
        // Its pipes would keep the process alive too: a script's query is done, and it exits. What's been read and not
        // taken stays here (chunks); the stream is held again when it's next read.
        (this.proc.stdin as import("bun").FileSink).unref?.();
        if (this.held) {
            this.reader.releaseLock();
            this.held = false;
        }
    }

    /** Asked again: kept to while it reads. */
    busy() {
        this.proc.ref();
        (this.proc.stdin as import("bun").FileSink).ref?.();
        if (!this.held) {
            this.reader = (this.proc.stdout as ReadableStream<Uint8Array>).getReader() as unknown as ObjectReader["reader"];
            this.held = true;
        }
    }

    private closed = false;

    close() {
        this.closed = true;
        clearTimeout(this.timer);
        try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
        this.proc.kill();
        this.onClose?.();
    }
}
