// TEMPORARY probe for #138; deleted before merge.
import { linkSync, mkdtempSync, rmSync, statSync, unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { test } from "bun:test";

test("probe: inode reuse after the lock is unlinked", () => {
    const dir = mkdtempSync(join(tmpdir(), "probe-"));
    const lock = join(dir, "scripts.json.lock");
    const make = (n: number) => {
        const tmp = `${lock}.${n}`;
        writeFileSync(tmp, "1", { flag: "wx" });
        linkSync(tmp, lock);
        unlinkSync(tmp);
        return statSync(lock);
    };
    const rows: string[] = [];
    for (let i = 0; i < 20; i++) {
        const a = make(i);
        unlinkSync(lock);
        const b = make(i + 100);
        rows.push(`${a.ino}->${b.ino} dev ${a.dev}->${b.dev} same=${a.ino === b.ino && a.dev === b.dev}`);
        unlinkSync(lock);
    }
    // old test's sequence
    writeFileSync(lock, "1");
    const c = statSync(lock).ino;
    rmSync(lock);
    writeFileSync(lock, "1");
    rows.push(`rm+write ${c}->${statSync(lock).ino}`);
    throw new Error(`PROBE ${process.platform} ${tmpdir()}\n${rows.join("\n")}`);
});
