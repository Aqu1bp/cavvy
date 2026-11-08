// cavvy-native (native/) against git itself: every object it reads, and every kind and size it reports, is what
// `git cat-file` says, from loose objects, packs (deltas included), alternates, and SHA-256 repositories.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { helperGone, NativeObjects, nativeBinary, nativeObjects, resetNativeObjects, type ObjectPlace } from "../src/agent/native-objects";

const bin = nativeBinary();
const dirs: string[] = [];
afterAll(() => {
    resetNativeObjects();
    for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function git(cwd: string, args: string[], input?: string, env: Record<string, string> = {}) {
    const r = Bun.spawnSync(["git", "-c", "user.email=me@example.com", "-c", "user.name=me", ...args], { cwd, env: { ...process.env, ...env }, stdin: input === undefined ? "ignore" : Buffer.from(input), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout;
}

/** A repository with history, some of it packed (with deltas), some loose. */
function repo(format: "sha1" | "sha256"): { root: string; oids: string[] } {
    const root = mkdtempSync(join(tmpdir(), "cavvy-native-"));
    dirs.push(root);
    git(root, ["init", "-q", `--object-format=${format}`]);
    for (let i = 0; i < 6; i++) {
        mkdirSync(join(root, `d${i % 2}`), { recursive: true });
        // Files that grow a little each commit: packed as deltas of each other.
        writeFileSync(join(root, `d${i % 2}`, "big.txt"), Array.from({ length: 400 + i }, (_, k) => `line ${k} of a file that changes ${i}`).join("\n"));
        writeFileSync(join(root, `f${i}.txt`), `file ${i}\n`);
        writeFileSync(join(root, "empty"), "");
        git(root, ["add", "-A"]);
        git(root, ["commit", "-qm", `commit ${i}`]);
        if (i === 3) git(root, ["gc", "-q", "--aggressive"]);
    }
    const oids = git(root, ["rev-list", "--objects", "--all"]).toString().split("\n").filter(Boolean).map((l) => l.split(" ")[0]!);
    return { root, oids };
}

function catFile(root: string, oids: string[], env: Record<string, string> = {}) {
    const out = new Map<string, { type: string; buf: Buffer }>();
    const all = git(root, ["cat-file", "--batch"], oids.join("\n") + "\n", env);
    let at = 0;
    for (const oid of oids) {
        const nl = all.indexOf(10, at);
        const [id, type, size] = all.toString("latin1", at, nl).split(" ");
        at = nl + 1;
        if (type === "missing") continue;
        out.set(id!, { type: type!, buf: Buffer.from(all.subarray(at, at + Number(size))) });
        at += Number(size) + 1;
    }
    return out;
}

describe.skipIf(!bin)("cavvy-native", () => {
    const helper = () => nativeObjects() as NativeObjects;
    const soon = () => Date.now() + 10_000;

    for (const format of ["sha1", "sha256"] as const) {
        test(`reads every object as git does (${format}: loose, packed, deltas)`, async () => {
            const { root, oids } = repo(format);
            const place: ObjectPlace = { objects: join(root, ".git", "objects"), alternates: [], hash: format };
            const want = catFile(root, oids);
            const got = await helper().read(place, oids, soon());
            expect(got.size).toBe(want.size);
            for (const [oid, o] of want) {
                expect(got.get(oid)?.type).toBe(o.type as never);
                expect(Buffer.compare(got.get(oid)!.buf, o.buf)).toBe(0);
            }
            const heads = await helper().header(place, oids, soon());
            for (const [oid, o] of want) expect(heads.get(oid)).toEqual({ type: o.type as never, size: o.buf.length });
        });
    }

    test("an object that isn't there is missing, in order with the rest", async () => {
        const { root, oids } = repo("sha1");
        const place: ObjectPlace = { objects: join(root, ".git", "objects"), alternates: [], hash: "sha1" };
        const absent = "0123456789abcdef0123456789abcdef01234567";
        const got = await helper().read(place, [oids[0]!, absent, oids[1]!], soon());
        expect([...got.keys()]).toEqual([oids[0]!, oids[1]!]);
        expect((await helper().header(place, [absent], soon())).size).toBe(0);
    });

    test("looks in the alternates after its own objects, as GIT_ALTERNATE_OBJECT_DIRECTORIES has git look", async () => {
        const { root, oids } = repo("sha1");
        const own = mkdtempSync(join(tmpdir(), "cavvy-native-own-"));
        dirs.push(own);
        // An object only in the session's own store (as a snapshot writes them), and the repository's as alternates.
        const env = { GIT_OBJECT_DIRECTORY: own, GIT_ALTERNATE_OBJECT_DIRECTORIES: join(root, ".git", "objects") };
        const mine = git(root, ["hash-object", "-w", "--stdin"], "only in the session's store\n", env).toString().trim();
        const place: ObjectPlace = { objects: own, alternates: [join(root, ".git", "objects")], hash: "sha1" };
        const want = catFile(root, [mine, ...oids], env);
        const got = await helper().read(place, [mine, ...oids], soon());
        expect(got.size).toBe(want.size);
        for (const [oid, o] of want) expect(Buffer.compare(got.get(oid)!.buf, o.buf)).toBe(0);
        // Not there without the store that has it.
        expect((await helper().read({ ...place, objects: join(root, ".git", "objects"), alternates: [] }, [mine], soon())).size).toBe(0);
    });

    test("objects written after the store was first read are found (new loose objects and new packs)", async () => {
        const { root } = repo("sha1");
        const place: ObjectPlace = { objects: join(root, ".git", "objects"), alternates: [], hash: "sha1" };
        await helper().read(place, [git(root, ["rev-parse", "HEAD"]).toString().trim()], soon());
        const loose = git(root, ["hash-object", "-w", "--stdin"], "written later\n").toString().trim();
        expect((await helper().read(place, [loose], soon())).get(loose)?.buf.toString()).toBe("written later\n");
        writeFileSync(join(root, "later.txt"), "packed later\n");
        git(root, ["add", "-A"]);
        git(root, ["commit", "-qm", "later"]);
        git(root, ["repack", "-adq"]);
        const blob = git(root, ["rev-parse", "HEAD:later.txt"]).toString().trim();
        expect((await helper().read(place, [blob], soon())).get(blob)?.buf.toString()).toBe("packed later\n");
    });

    test("many requests at once, from many places, are each answered with their own objects", async () => {
        const repos = [repo("sha1"), repo("sha1"), repo("sha256")];
        const asks = Array.from({ length: 60 }, (_, i) => {
            const r = repos[i % repos.length]!;
            const place: ObjectPlace = { objects: join(r.root, ".git", "objects"), alternates: [], hash: i % 3 === 2 ? "sha256" : "sha1" };
            const pick = r.oids.filter((_, k) => k % 7 === i % 7);
            return helper().read(place, pick, soon()).then((got) => ({ r, pick, got }));
        });
        for (const { r, pick, got } of await Promise.all(asks)) {
            const want = catFile(r.root, pick);
            for (const [oid, o] of want) expect(Buffer.compare(got.get(oid)!.buf, o.buf)).toBe(0);
        }
    });

    test("one that stops is started again for the next read, and a read it was answering says it went", async () => {
        const { root, oids } = repo("sha1");
        const place: ObjectPlace = { objects: join(root, ".git", "objects"), alternates: [], hash: "sha1" };
        const first = helper();
        first.close();
        await first.exited;
        const gone = await first.read(place, oids, soon()).then(() => undefined, (e: unknown) => e);
        expect(helperGone(gone)).toBe(true);
        const second = helper();
        expect(second).not.toBe(first);
        expect((await second.read(place, oids, soon())).size).toBe(oids.length);
    });

    test("CAVVY_NATIVE=0 turns it off", () => {
        const was = process.env.CAVVY_NATIVE;
        process.env.CAVVY_NATIVE = "0";
        try {
            expect(nativeBinary()).toBeUndefined();
        } finally {
            if (was === undefined) delete process.env.CAVVY_NATIVE;
            else process.env.CAVVY_NATIVE = was;
        }
    });

    /** A new pack holding exactly `ids`, their loose copies dropped (as a snapshot's large capture writes one). */
    const packOf = (cwd: string, objects: string, ids: string[]) => {
        git(cwd, ["pack-objects", "-q", join(objects, "pack", "pack")], ids.join("\n") + "\n");
        git(cwd, ["prune-packed"]);
    };

    test("a store keeps reading as packs are added to it, well past the 32 it had room for when first opened", async () => {
        const root = mkdtempSync(join(tmpdir(), "cavvy-native-packs-"));
        dirs.push(root);
        git(root, ["init", "-q"]);
        const objects = join(root, ".git", "objects");
        const place: ObjectPlace = { objects, alternates: [], hash: "sha1" };
        const ids: string[] = [];
        for (let i = 0; i < 70; i++) {
            const id = git(root, ["hash-object", "-w", "--stdin"], `pack ${i}\n`).toString().trim();
            packOf(root, objects, [id]);
            ids.push(id);
            // Read as it grows, so the store is open (and sized) before most of them exist.
            if (i === 2 || i === 69) expect((await helper().read(place, ids, soon())).size).toBe(ids.length);
        }
    }, 60_000);

    test("a large object comes back whole, without holding up the server's thread", async () => {
        const root = mkdtempSync(join(tmpdir(), "cavvy-native-big-"));
        dirs.push(root);
        git(root, ["init", "-q"]);
        const big = Buffer.alloc(64 * 1024 * 1024, "x");
        writeFileSync(join(root, "big.bin"), big);
        const id = git(root, ["hash-object", "-w", "big.bin"]).toString().trim();
        const place: ObjectPlace = { objects: join(root, ".git", "objects"), alternates: [], hash: "sha1" };
        let longest = 0, last = performance.now();
        const tick = setInterval(() => { const now = performance.now(); longest = Math.max(longest, now - last); last = now; }, 5);
        const started = performance.now();
        const got = (await helper().read(place, [id], soon())).get(id);
        clearInterval(tick);
        expect(got?.buf.equals(big)).toBe(true);
        // Joined once it's all in: a copy of what had come for every piece took 8 s for 72 MB, and held the thread.
        expect(performance.now() - started).toBeLessThan(4000);
        expect(longest).toBeLessThan(500);
    }, 60_000);

    test("objects that are only in the alternates don't make it look through the store's own packs again for each", async () => {
        const root = mkdtempSync(join(tmpdir(), "cavvy-native-alt-"));
        dirs.push(root);
        git(root, ["init", "-q"]);
        const repoObjects = join(root, ".git", "objects");
        const ids = git(root, ["hash-object", "-w", "--stdin-paths"], Array.from({ length: 3000 }, (_, i) => { const f = join(root, `f${i}`); writeFileSync(f, `content ${i}\n`); return f; }).join("\n") + "\n").toString().trim().split("\n");
        packOf(root, repoObjects, ids);
        // The session's own store, with a pack for each of 25 turns.
        const own = mkdtempSync(join(tmpdir(), "cavvy-native-own-"));
        dirs.push(own);
        git(own, ["init", "-q", "--bare"]);
        for (let i = 0; i < 25; i++) packOf(own, join(own, "objects"), [git(own, ["hash-object", "-w", "--stdin"], `turn ${i}\n`).toString().trim()]);
        const place: ObjectPlace = { objects: join(own, "objects"), alternates: [repoObjects], hash: "sha1" };
        await helper().header(place, ids.slice(0, 1), soon());
        const started = performance.now();
        let found = 0;
        for (let i = 0; i < ids.length; i += 64) found += (await helper().header(place, ids.slice(i, i + 64), soon())).size;
        expect(found).toBe(ids.length);
        // Each miss in its own store looked through its pack folder again: about 450 ms for these, 20 now.
        expect(performance.now() - started).toBeLessThan(250);
    }, 60_000);

    /**
     * A stand-in helper: it answers pings at once and every read `delay` ms later (with an error, which counts as an
     * answer), or never answers a read (`delay` -1), as when its workers are stuck.
     */
    function standIn(delay: number): string {
        const dir = mkdtempSync(join(tmpdir(), "cavvy-native-stand-in-"));
        dirs.push(dir);
        writeFileSync(
            join(dir, "stand-in.js"),
            `const delay = ${delay};
const frame = (id, body) => {
    const f = Buffer.alloc(8 + body.length);
    f.writeUInt32LE(id, 0);
    f.writeUInt32LE(body.length, 4);
    body.copy(f, 8);
    process.stdout.write(f);
};
let buf = "";
process.stdin.on("data", (d) => {
    buf += d;
    for (let i; (i = buf.indexOf("\\n")) >= 0; buf = buf.slice(i + 1)) {
        const m = JSON.parse(buf.slice(0, i));
        if (m.op === "ping") frame(m.id, Buffer.from([0]));
        else if (delay >= 0) setTimeout(() => frame(m.id, Buffer.concat([Buffer.from([1]), Buffer.from("late")])), delay);
    }
});
`,
        );
        const bin = join(dir, "cavvy-native");
        writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${join(dir, "stand-in.js")}"\n`, { mode: 0o755 });
        return bin;
    }

    test("one whose reads run out of time but are answered later stays, however often", async () => {
        const { root, oids } = repo("sha1");
        const place: ObjectPlace = { objects: join(root, ".git", "objects"), alternates: [], hash: "sha1" };
        const slow = new NativeObjects(standIn(150), { stuckMs: 400 });
        try {
            for (let i = 0; i < 6; i++) await expect(slow.read(place, oids, Date.now() + 20)).rejects.toThrow(/time budget/);
            // Past the time it's given to answer them: it did, late.
            await Bun.sleep(700);
            expect(slow.alive).toBe(true);
        } finally {
            slow.close();
        }
    });

    test("one that never answers its reads is let go, though it answers pings, and what it was answering goes to git", async () => {
        const { root, oids } = repo("sha1");
        const place: ObjectPlace = { objects: join(root, ".git", "objects"), alternates: [], hash: "sha1" };
        const stuck = new NativeObjects(standIn(-1), { stuckMs: 200 });
        const waiting = stuck.read(place, oids, Date.now() + 60_000);
        for (let i = 0; i < 3; i++) await expect(stuck.read(place, oids, Date.now() + 20)).rejects.toThrow(/time budget/);
        await stuck.ping();
        await stuck.exited;
        expect(stuck.alive).toBe(false);
        expect(helperGone(await waiting.catch((e: unknown) => e))).toBe(true);
    });

    test("two late reads it never answers aren't enough to let it go", async () => {
        const { root, oids } = repo("sha1");
        const place: ObjectPlace = { objects: join(root, ".git", "objects"), alternates: [], hash: "sha1" };
        const helperWithTwo = new NativeObjects(standIn(-1), { stuckMs: 200 });
        try {
            for (let i = 0; i < 2; i++) await expect(helperWithTwo.read(place, oids, Date.now() + 20)).rejects.toThrow(/time budget/);
            await Bun.sleep(400);
            expect(helperWithTwo.alive).toBe(true);
        } finally {
            helperWithTwo.close();
        }
    });

    test("a request it can't answer is an error for that request alone", async () => {
        const place: ObjectPlace = { objects: "/nonexistent/objects", alternates: [], hash: "sha1" };
        expect((await helper().read(place, ["0123456789abcdef0123456789abcdef01234567"], soon())).size).toBe(0);
        await expect(helper().read({ ...place, hash: "sha1" }, ["not-hex"], soon())).rejects.toThrow(/bad object id/);
        await helper().ping();
    });
});
