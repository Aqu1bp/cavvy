import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { editTree, ObjectReader } = await import("../src/agent/tree-edit");
const { gitArgv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

function git(cwd: string, args: string[], input?: string | Buffer): string {
    const r = Bun.spawnSync(gitArgv(["-c", "core.hooksPath=/dev/null", ...args]), { cwd, env: { PATH: process.env.PATH!, HOME: iso.home, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }, stdin: input === undefined ? "ignore" : typeof input === "string" ? Buffer.from(input) : input, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
}

/** A tree of `files` (path to contents), as git writes it from an index. */
function treeOf(cwd: string, files: Map<string, string>): string {
    git(cwd, ["read-tree", "--empty"]);
    const lines = [...files].map(([path, body]) => `100644 ${git(cwd, ["hash-object", "-w", "--stdin"], body).trim()}\t${path}\0`).join("");
    if (lines) git(cwd, ["update-index", "-z", "--index-info"], lines);
    return git(cwd, ["write-tree"]).trim();
}

test("a tree edited along the changed paths is the one git writes for the same files", async () => {
    const cwd = join(realpathSync(iso.home), "tree-edit");
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q"]);
    writeFileSync(join(cwd, ".keep"), "");
    // Names that sort differently as files and as folders ("a-b" against "a/"), deep folders, and swaps.
    const names = ["a", "a-b", "a.txt", "a/b", "a/b/c", "a/b/c/d.txt", "a/b-c", "a/x", "z", "z/é.txt", "z/y", "é"];
    let files = new Map<string, string>([["a/b/c/d.txt", "1"], ["a-b", "2"], ["z/y", "3"], ["é", "4"]]);
    let tree = treeOf(cwd, files);
    let seed = 7;
    const random = (n: number) => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed % n);
    const reader = new ObjectReader(cwd, {}, Date.now() + 60_000);
    try {
        for (let round = 0; round < 60; round++) {
            const next = new Map(files);
            for (let k = random(4) + 1; k > 0; k--) {
                const name = names[random(names.length)]!;
                if (next.has(name) && random(2)) next.delete(name);
                else {
                    // A file where a folder was (or the other way): what was in its way goes.
                    for (const p of [...next.keys()]) if (p.startsWith(`${name}/`) || name.startsWith(`${p}/`)) next.delete(p);
                    next.set(name, `round ${round}`);
                }
            }
            const edits = new Map<string, { mode: string; oid: string } | null>();
            for (const p of new Set([...files.keys(), ...next.keys()])) {
                if (!next.has(p)) edits.set(p, null);
                else if (next.get(p) !== files.get(p)) edits.set(p, { mode: "100644", oid: git(cwd, ["hash-object", "-w", "--stdin"], next.get(p)!).trim() });
            }
            const edited = await editTree(tree, edits, 20, (oid) => reader.read(oid, "tree"), async (body) => git(cwd, ["hash-object", "-w", "-t", "tree", "--stdin"], body).trim());
            expect([round, edited]).toEqual([round, treeOf(cwd, next)]);
            files = next;
            tree = edited;
        }
    } finally {
        reader.close();
    }
});

test("several objects read together come back whole, by id, without the ones the repository doesn't have", async () => {
    const cwd = join(realpathSync(iso.home), "read-all");
    mkdirSync(cwd, { recursive: true });
    git(cwd, ["init", "-q"]);
    // Big enough to come in many pieces; one ends in a newline, one is empty.
    const big = Buffer.alloc(3 * 1024 * 1024 + 7, "ab\n");
    const bodies = [big, Buffer.from("small\n"), Buffer.alloc(0)];
    const oids = bodies.map((b) => git(cwd, ["hash-object", "-w", "--stdin"], b).trim());
    const absent = "1".repeat(40);
    const reader = new ObjectReader(cwd, {}, Date.now() + 60_000);
    try {
        const got = await reader.readAll([oids[0]!, absent, oids[1]!, oids[2]!]);
        expect([...got.keys()]).toEqual([oids[0]!, oids[1]!, oids[2]!]);
        for (const [k, oid] of oids.entries()) expect([k, got.get(oid)!.type, got.get(oid)!.buf.equals(bodies[k]!)]).toEqual([k, "blob", true]);
        // And it goes on reading afterwards.
        expect((await reader.read(oids[1]!, "blob")).toString()).toBe("small\n");
    } finally {
        reader.close();
    }
});
