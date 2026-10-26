import { afterAll, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { writeJson, readJson } = await import("../src/config/settings");

const ROOT = tempDir("cavvy-writejson-");
afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    iso.cleanup();
});
let n = 0;
const dir = () => {
    const d = join(ROOT, `d${++n}`);
    mkdirSync(d, { recursive: true });
    return d;
};
const leftovers = (d: string) => readdirSync(d).filter((f) => f.endsWith(".tmp"));
const mode = (f: string) => statSync(f).mode & 0o777;

describe("writeJson is atomic", () => {
    test("replaces the file by rename and leaves no temp file", () => {
        const d = dir();
        const f = join(d, "settings.json");
        writeJson(f, { a: 1 });
        const ino1 = statSync(f).ino;
        writeJson(f, { a: 2 });
        expect(statSync(f).ino).not.toBe(ino1);
        expect(JSON.parse(readFileSync(f, "utf-8"))).toEqual({ a: 2 });
        expect(readFileSync(f, "utf-8").endsWith("\n")).toBe(true);
        expect(readdirSync(d)).toEqual(["settings.json"]);
    });

    test("a new file gets the requested mode, 0600 stays 0600", () => {
        const d = dir();
        const secret = join(d, "providers.json");
        writeJson(secret, { k: "v" }, 0o600);
        expect(mode(secret)).toBe(0o600);
        writeJson(secret, { k: "w" }, 0o600);
        expect(mode(secret)).toBe(0o600);
        const plain = join(d, "plain.json");
        writeJson(plain, {});
        expect(mode(plain)).toBe(0o644);
    });

    test("an existing file keeps its mode", () => {
        const d = dir();
        const f = join(d, "settings.json");
        writeJson(f, { a: 1 });
        chmodSync(f, 0o600);
        writeJson(f, { a: 2 }); // default mode 0644
        expect(mode(f)).toBe(0o600);
    });

    test("a read-only existing file is not replaced", () => {
        const d = dir();
        const f = join(d, "gui.json");
        writeJson(f, { old: true });
        chmodSync(f, 0o400);
        expect(() => writeJson(f, { old: false })).toThrow();
        expect(JSON.parse(readFileSync(f, "utf-8"))).toEqual({ old: true });
        expect(mode(f)).toBe(0o400);
        expect(readdirSync(d)).toEqual(["gui.json"]);
    });

    test("a failed rename leaves the old content and no temp file", () => {
        const d = dir();
        const f = join(d, "settings.json");
        writeJson(f, { old: true });
        // A non-empty directory can't be replaced by rename, so the final step fails.
        const blocked = join(d, "blocked.json");
        mkdirSync(join(blocked, "inner"), { recursive: true });
        expect(() => writeJson(blocked, { a: 1 })).toThrow();
        expect(leftovers(d)).toEqual([]);
        expect(readJson<{ old: boolean }>(f)).toEqual({ old: true });
    });

    test("a temp file left by a crashed writer never shadows the target", () => {
        const d = dir();
        const f = join(d, "settings.json");
        writeJson(f, { old: true });
        // What a writer killed between the temp write and the rename leaves behind.
        writeFileSync(join(d, ".settings.json.99999.deadbeef.tmp"), '{"half":');
        expect(readJson<{ old: boolean }>(f)).toEqual({ old: true });
        writeJson(f, { old: false });
        expect(readJson<{ old: boolean }>(f)).toEqual({ old: false });
    });

    test("a symlinked target is written through and the link survives", () => {
        const d = dir();
        const real = join(d, "real");
        mkdirSync(real);
        const target = join(real, "settings.json");
        writeJson(target, { v: 1 });
        const link = join(d, "settings.json");
        symlinkSync(join("real", "settings.json"), link); // relative link
        writeJson(link, { v: 2 });
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(readlinkSync(link)).toBe(join("real", "settings.json"));
        expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ v: 2 });
        expect(leftovers(d)).toEqual([]);
        expect(leftovers(real)).toEqual([]);
        // A link to a link.
        const link2 = join(d, "outer.json");
        symlinkSync(link, link2);
        writeJson(link2, { v: 3 });
        expect(lstatSync(link2).isSymbolicLink()).toBe(true);
        expect(JSON.parse(readFileSync(target, "utf-8"))).toEqual({ v: 3 });
        // A dangling link: the file is created where it points.
        const dangling = join(d, "dangling.json");
        const newTarget = join(real, "new.json");
        symlinkSync(newTarget, dangling);
        writeJson(dangling, { v: 4 });
        expect(lstatSync(dangling).isSymbolicLink()).toBe(true);
        expect(existsSync(newTarget)).toBe(true);
        expect(JSON.parse(readFileSync(newTarget, "utf-8"))).toEqual({ v: 4 });
    });

    test("a relative link is resolved from its real directory, not through a symlinked parent", () => {
        const d = dir();
        // d/home/config -> d/mnt/private/subdir ; subdir/settings.json -> ../providers.json
        const sub = join(d, "mnt", "private", "subdir");
        mkdirSync(sub, { recursive: true });
        const real = join(d, "mnt", "private", "providers.json");
        writeJson(real, { v: 1 });
        symlinkSync("../providers.json", join(sub, "settings.json"));
        mkdirSync(join(d, "home"));
        symlinkSync(sub, join(d, "home", "config"));
        writeJson(join(d, "home", "config", "settings.json"), { v: 2 });
        expect(JSON.parse(readFileSync(real, "utf-8"))).toEqual({ v: 2 });
        expect(lstatSync(join(sub, "settings.json")).isSymbolicLink()).toBe(true);
        expect(existsSync(join(d, "home", "providers.json"))).toBe(false);
        expect(readdirSync(join(d, "home"))).toEqual(["config"]);
    });

    test("a new file honors the umask; an existing file keeps its mode regardless", () => {
        const d = dir();
        const old = process.umask(0o077);
        try {
            const f = join(d, "settings.local.json");
            writeJson(f, { a: 1 }); // asks for 0644
            expect(mode(f)).toBe(0o600);
            chmodSync(f, 0o640);
            writeJson(f, { a: 2 });
            expect(mode(f)).toBe(0o640);
        } finally {
            process.umask(old);
        }
    });

    test("a reader in another process never sees an empty or partial file", async () => {
        const d = dir();
        const f = join(d, "providers.json");
        const body = (i: number) => ({ i, pad: "x".repeat(200_000) });
        writeJson(f, body(0), 0o600);
        const reader = Bun.spawn(
            [
                process.execPath,
                "-e",
                `const fs=require("fs");const f=process.argv[1];let reads=0,bad=0;
                 const end=Date.now()+1500;
                 while(Date.now()<end){try{JSON.parse(fs.readFileSync(f,"utf-8"));reads++}catch(e){bad++}}
                 console.log(JSON.stringify({reads,bad}));`,
                f,
            ],
            { stdout: "pipe", stderr: "pipe" },
        );
        const end = Date.now() + 1500;
        let i = 1;
        while (Date.now() < end) {
            writeJson(f, body(i++), 0o600);
            await Bun.sleep(0);
        }
        const out = JSON.parse((await new Response(reader.stdout).text()).trim()) as { reads: number; bad: number };
        await reader.exited;
        expect(i).toBeGreaterThan(5);
        expect(out.reads).toBeGreaterThan(5);
        expect(out.bad).toBe(0);
        expect(leftovers(d)).toEqual([]);
    });
});
