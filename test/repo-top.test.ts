import { afterAll, expect, test } from "bun:test";
import { mkdirSync, realpathSync, rmSync, symlinkSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { topOf } = await import("../src/agent/turn-snapshots");
const { gitArgv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

const init = (cwd: string) => {
    mkdirSync(cwd, { recursive: true });
    expect(Bun.spawnSync(gitArgv(["init", "-q"]), { cwd, env: { PATH: process.env.PATH!, HOME: iso.home, GIT_CONFIG_NOSYSTEM: "1" } }).exitCode).toBe(0);
};

test("a folder's repository is what git says, asked again when a repository appears, goes, or is made again", () => {
    const outer = join(realpathSync(iso.home), "top");
    const deep = join(outer, "a/b/c");
    init(outer);
    mkdirSync(deep, { recursive: true });
    expect(topOf(deep)).toBe(outer);
    expect(topOf(deep)).toBe(outer);
    // Through a link: the same repository.
    symlinkSync(outer, join(iso.home, "top-link"));
    expect(topOf(join(iso.home, "top-link/a/b/c"))).toBe(outer);
    // One nearer, on the way up.
    init(join(outer, "a/b"));
    expect(topOf(deep)).toBe(join(outer, "a/b"));
    rmSync(join(outer, "a/b/.git"), { recursive: true });
    expect(topOf(deep)).toBe(outer);
    // Gone, then made again.
    rmSync(join(outer, ".git"), { recursive: true });
    expect(topOf(deep)).toBeUndefined();
    init(outer);
    expect(topOf(deep)).toBe(outer);
});
