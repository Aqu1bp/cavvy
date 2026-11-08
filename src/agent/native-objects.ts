// Git objects read through cavvy-native (native/): one process for the whole server, which every session's turn
// snapshots share, in place of a `git cat-file --batch` kept by each session and a `git cat-file --batch-check` for
// each lookup. Where it isn't there (not built, or CAVVY_NATIVE=0) or stops working, `nativeObjects()` says so and the
// callers use git, as before.
//
// The protocol is native/src/main.rs's: a JSON line a request; replies framed as u32 id, u32 length, then the body.

import { existsSync } from "fs";
import { delimiter, dirname, join, resolve } from "path";

export type ObjectKind = "commit" | "tree" | "blob" | "tag";
const KINDS: (ObjectKind | undefined)[] = [undefined, "commit", "tree", "blob", "tag"];

/** Where a read looks: as GIT_OBJECT_DIRECTORY and GIT_ALTERNATE_OBJECT_DIRECTORIES would have git look. */
export interface ObjectPlace {
    objects: string;
    alternates: string[];
    hash: "sha1" | "sha256";
}

/** The place git would read from with these variables set; undefined without GIT_OBJECT_DIRECTORY. */
export function placeOf(env: Record<string, string>, hash: "sha1" | "sha256"): ObjectPlace | undefined {
    if (!env.GIT_OBJECT_DIRECTORY) return undefined;
    return { objects: env.GIT_OBJECT_DIRECTORY, alternates: (env.GIT_ALTERNATE_OBJECT_DIRECTORIES ?? "").split(delimiter).filter(Boolean), hash };
}

/** The helper's executable: CAVVY_NATIVE_BIN, beside the server's own executable (the packaged app), or this checkout's build. */
export function nativeBinary(): string | undefined {
    if (process.env.CAVVY_NATIVE === "0") return undefined;
    const given = process.env.CAVVY_NATIVE_BIN;
    if (given) return existsSync(given) ? given : undefined;
    const name = process.platform === "win32" ? "cavvy-native.exe" : "cavvy-native";
    for (const p of [join(dirname(process.execPath), name), resolve(import.meta.dir, "../../native/target/release", name)]) if (existsSync(p)) return p;
    return undefined;
}

class Failed extends Error {}

/** One running helper. Requests are answered in any order, matched by id. */
export class NativeObjects {
    private proc: ReturnType<typeof Bun.spawn>;
    private pending = new Map<number, { resolve: (b: Buffer) => void; reject: (e: Error) => void }>();
    private nextId = 1;
    private buf = Buffer.alloc(0);
    private dead = false;
    readonly exited: Promise<number>;

    constructor(bin: string) {
        this.proc = Bun.spawn([bin], { stdin: "pipe", stdout: "pipe", stderr: "ignore", env: { PATH: process.env.PATH ?? "" } });
        this.exited = this.proc.exited.then((code) => {
            this.dead = true;
            for (const p of this.pending.values()) p.reject(new Failed("cavvy-native stopped"));
            this.pending.clear();
            return code;
        });
        this.idle();
        void this.pump();
    }

    get alive() {
        return !this.dead;
    }

    private async pump() {
        try {
            for await (const chunk of this.proc.stdout as ReadableStream<Uint8Array>) {
                this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : Buffer.from(chunk);
                while (this.buf.length >= 8) {
                    const id = this.buf.readUInt32LE(0), len = this.buf.readUInt32LE(4);
                    if (this.buf.length < 8 + len) break;
                    const body = this.buf.subarray(8, 8 + len);
                    this.buf = this.buf.subarray(8 + len);
                    const p = this.pending.get(id);
                    if (!p) continue;
                    this.pending.delete(id);
                    if (!this.pending.size) this.idle();
                    if (body[0] === 0) p.resolve(Buffer.from(body.subarray(1)));
                    else p.reject(new Error(body.subarray(1).toString("utf-8")));
                }
            }
        } catch {
            // it went away: exited settles the rest
        }
    }

    /** Nothing asked: it doesn't keep the server (or a script) running by itself. */
    private idle() {
        this.proc.unref();
        (this.proc.stdin as import("bun").FileSink).unref?.();
    }

    private busy() {
        this.proc.ref();
        (this.proc.stdin as import("bun").FileSink).ref?.();
    }

    private ask(op: "read" | "header" | "ping", place: ObjectPlace | undefined, oids: readonly string[], deadline: number): Promise<Buffer> {
        if (this.dead) return Promise.reject(new Failed("cavvy-native stopped"));
        const id = this.nextId++ >>> 0;
        if (this.nextId > 0xfffffff0) this.nextId = 1;
        return new Promise<Buffer>((res, rej) => {
            const timer = setTimeout(() => {
                if (this.pending.delete(id)) {
                    if (!this.pending.size) this.idle();
                    rej(new Error("Snapshot exceeded its time budget (2 seconds by default)."));
                }
            }, Math.max(0, deadline - Date.now()));
            this.pending.set(id, { resolve: (b) => (clearTimeout(timer), res(b)), reject: (e) => (clearTimeout(timer), rej(e)) });
            this.busy();
            const sink = this.proc.stdin as import("bun").FileSink;
            try {
                sink.write(JSON.stringify({ id, op, ...place, oids }) + "\n");
                void Promise.resolve(sink.flush()).catch(() => {});
            } catch {
                this.pending.delete(id);
                clearTimeout(timer);
                rej(new Failed("cavvy-native stopped"));
            }
        });
    }

    /** Each object found, by id: its kind and bytes (as `git cat-file --batch`). */
    async read(place: ObjectPlace, oids: readonly string[], deadline: number): Promise<Map<string, { type: ObjectKind; buf: Buffer }>> {
        const out = new Map<string, { type: ObjectKind; buf: Buffer }>();
        if (!oids.length) return out;
        const body = await this.ask("read", place, oids, deadline);
        let at = 0;
        for (const oid of oids) {
            const kind = KINDS[body[at]!], size = body.readUInt32LE(at + 1);
            at += 5;
            if (kind) out.set(oid, { type: kind, buf: body.subarray(at, at + size) });
            at += size;
        }
        return out;
    }

    /** Each object found, by id: its kind and size (as `git cat-file --batch-check`). */
    async header(place: ObjectPlace, oids: readonly string[], deadline: number): Promise<Map<string, { type: ObjectKind; size: number }>> {
        const out = new Map<string, { type: ObjectKind; size: number }>();
        if (!oids.length) return out;
        const body = await this.ask("header", place, oids, deadline);
        let at = 0;
        for (const oid of oids) {
            const kind = KINDS[body[at]!], size = Number(body.readBigUInt64LE(at + 1));
            at += 9;
            if (kind) out.set(oid, { type: kind, size });
        }
        return out;
    }

    async ping(deadline = Date.now() + 5000): Promise<void> {
        await this.ask("ping", undefined, [], deadline);
    }

    close() {
        try { (this.proc.stdin as import("bun").FileSink).end(); } catch {}
        this.proc.kill();
    }
}

let shared: NativeObjects | null | undefined;
let failures = 0;

/** The server's helper, started on first use (and again if it stopped, a few times at most); null where there's none. */
export function nativeObjects(): NativeObjects | null {
    if (shared?.alive) return shared;
    if (shared === null) return null;
    if (shared && ++failures > 3) return (shared = null);
    const bin = nativeBinary();
    if (!bin) return (shared = null);
    try {
        shared = new NativeObjects(bin);
    } catch {
        shared = null;
    }
    return shared;
}

/** For tests: forget the helper (closing it), so the next use looks again. */
export function resetNativeObjects() {
    if (shared) shared.close();
    shared = undefined;
    failures = 0;
}

/** Whether `e` is the helper having gone, rather than an answer from it: the caller tries git instead. */
export function helperGone(e: unknown): boolean {
    return e instanceof Failed;
}

/** What a snapshot reads objects with: a session's `git cat-file --batch` (tree-edit.ts ObjectReader), or this. */
export interface ObjectSource {
    read(oid: string, type: string): Promise<Buffer>;
    readAll(oids: readonly string[]): Promise<Map<string, { type: string; buf: Buffer }>>;
}

/** The helper, read from as a session's ObjectReader is. */
export class NativeReader implements ObjectSource {
    constructor(private native: NativeObjects, private place: ObjectPlace, private deadline: number) {}

    async read(oid: string, type: string): Promise<Buffer> {
        const o = (await this.native.read(this.place, [oid], this.deadline)).get(oid);
        if (!o || o.type !== type) throw new Error("Snapshot objects are missing or unreadable.");
        return o.buf;
    }

    readAll(oids: readonly string[]): Promise<Map<string, { type: string; buf: Buffer }>> {
        return this.native.read(this.place, oids, this.deadline);
    }
}
