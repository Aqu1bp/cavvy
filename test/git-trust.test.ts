import { afterAll, expect, test } from "bun:test";
import { chmodSync, existsSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const { gitBranch, gitSnapshot } = await import("../src/util/git");
const { environmentBlock } = await import("../src/agent/system-prompt");
const { trustFolder, trustForSession } = await import("../src/config/trust");
const { Engine } = await import("../src/server/engine");
const repo = tempDir("hostile-git-");
const plain = tempDir("not-git-");
afterAll(() => { iso.cleanup(); rmSync(repo, { recursive: true, force: true }); rmSync(plain, { recursive: true, force: true }); });
const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
function git(args: string[], input?: string) {
    const r = Bun.spawnSync(["git", ...args], { cwd: repo, env, stdin: input === undefined ? "ignore" : new TextEncoder().encode(input), stdout: "pipe", stderr: "pipe", timeout: 3000 });
    expect(r.exitCode).toBe(0);
    return r.stdout.toString().trim();
}
const markers = ["clean", "process", "smudge", "gpg"].map((n) => join(repo, `${n}.marker`));
const clear = () => markers.forEach((p) => rmSync(p, { force: true }));
const untouched = () => markers.forEach((p) => expect(existsSync(p)).toBe(false));
let mtime = 1_000_000;
function stale() {
    mtime += 10_000;
    for (const f of ["a", "b"]) {
        writeFileSync(join(repo, f), "contents\n");
        utimesSync(join(repo, f), new Date(mtime), new Date(mtime));
    }
}

test("opening an implicitly trusted repo never executes its filters or signature verifier", async () => {
    git(["init", "-b", "main"]);
    git(["config", "user.name", "Test"]);
    git(["config", "user.email", "test@example.invalid"]);
    writeFileSync(join(repo, ".gitattributes"), "a filter=x\nb filter=y\n");
    stale();
    git(["add", "."]);
    git(["-c", "commit.gpgsign=false", "commit", "-m", "fixture"]);
    const commit = git(["cat-file", "commit", "HEAD"]);
    const signed = commit.replace("\n\n", "\ngpgsig -----BEGIN PGP SIGNATURE-----\n fake\n -----END PGP SIGNATURE-----\n\n");
    git(["update-ref", "HEAD", git(["hash-object", "-t", "commit", "-w", "--stdin"], signed)]);
    for (const name of ["clean", "process", "smudge", "gpg"]) {
        const script = join(repo, `${name}.sh`);
        writeFileSync(script, `#!/bin/sh\ntouch '${join(repo, `${name}.marker`)}'\n${name === "process" || name === "gpg" ? "exit 1" : "cat"}\n`);
        chmodSync(script, 0o700);
        git(["config", name === "gpg" ? "gpg.program" : `filter.${name === "process" ? "y" : "x"}.${name}`, script]);
    }
    git(["config", "log.showSignature", "true"]);
    stale();
    git(["status", "--short"]);
    expect(existsSync(markers[0]!)).toBe(true);
    expect(existsSync(markers[1]!)).toBe(true);
    git(["log", "--oneline", "-n", "5"]);
    expect(existsSync(markers[3]!)).toBe(true);
    // Smudge runs on checkout, not status: prove that tripwire too.
    rmSync(join(repo, "a"));
    git(["checkout-index", "--force", "--", "a"]);
    expect(existsSync(markers[2]!)).toBe(true);
    clear();
    stale();
    trustForSession(repo);
    expect(gitBranch(repo)).toBe("main");
    expect(gitSnapshot(repo)).toMatchObject({ branch: "main", recentCommits: "" });
    expect(gitSnapshot(repo)?.status).toBeUndefined();
    const engine = new Engine({ listModels: async () => [] });
    try {
        expect(engine.inspectProject(repo).branch).toBe("main");
        untouched();
        const runtime = await engine.createSession(repo);
        expect(runtime.snapshot().state.branch).toBe("main");
        untouched();
        expect(environmentBlock(repo, { provider: "test", id: "test" }, true)).toContain("not read because this folder is not trusted by the user");
        untouched();
    } finally { await engine.stop(); }
    trustFolder(repo);
    const snapshot = gitSnapshot(repo)!;
    expect(snapshot.status).toBeDefined();
    expect(snapshot.recentCommits).toContain("fixture");
    expect(existsSync(markers[0]!)).toBe(true);
    expect(existsSync(markers[1]!)).toBe(true);
    expect(existsSync(markers[2]!)).toBe(false);
    expect(existsSync(markers[3]!)).toBe(false);
    // Branch-only callers remain branch-only even after trust.
    clear();
    stale();
    expect(engine.inspectProject(repo).branch).toBe("main");
    untouched();
    git(["-c", "core.hooksPath=/dev/null", "checkout", "--detach", "HEAD"]);
    expect(gitBranch(repo)).toBeUndefined();
    expect(gitSnapshot(repo)?.branch).toBeUndefined();
    expect(gitBranch(plain)).toBeUndefined();
    expect(gitSnapshot(plain)).toBeUndefined();
});
