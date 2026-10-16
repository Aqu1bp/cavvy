import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "fs";
import { join } from "path";

/** Isolate Git's config and install fixtures before importing application code. */
export function publishFixtures(home: string) {
    const saved = { ...process.env };
    const realGit = Bun.which("git")!;
    for (const key of Object.keys(process.env)) if (key.startsWith("GIT_") || key.startsWith("GH_") || key === "GITHUB_TOKEN") delete process.env[key];
    process.env.GIT_CONFIG_GLOBAL = "/dev/null";
    process.env.GIT_CONFIG_NOSYSTEM = "1";
    process.env.GIT_ALLOW_PROTOCOL = "file";
    const bin = join(home, "bin"); mkdirSync(bin);
    for (const [name, file] of [["gh", "fake-publish-gh.ts"], ["git", "fake-publish-git.ts"]]) {
        const path = join(bin, name!);
        writeFileSync(path, `#!${process.execPath} --no-env-file\nimport ${JSON.stringify(new URL(`../fixtures/${file}`, import.meta.url).href)};\n`);
        chmodSync(path, 0o755);
    }
    process.env.PATH = `${bin}:${saved.PATH}`;
    process.env.FAKE_PUBLISH_GIT = realGit;
    let count = 0;
    const git = (cwd: string, ...args: string[]) => {
        const r = Bun.spawnSync([realGit, "-c", "core.hooksPath=/dev/null", ...args], { cwd, env: { ...process.env, GIT_ALLOW_PROTOCOL: "file" }, stdout: "pipe", stderr: "pipe" });
        if (r.exitCode) throw new Error(r.stderr.toString());
        return r.stdout.toString().trimEnd();
    };
    const repo = (github = false) => {
        const cwd = join(realpathSync(home), `publish-${count++}`); mkdirSync(cwd);
        const remote = `${cwd}-remote`; mkdirSync(remote);
        git(remote, "init", "--bare", "-q", "-b", "main");
        git(cwd, "init", "-q", "-b", "main");
        git(cwd, "config", "user.name", "Harness Test"); git(cwd, "config", "user.email", "test@example.invalid"); git(cwd, "config", "commit.gpgsign", "false");
        git(cwd, "commit", "--allow-empty", "-qm", "Initial");
        git(cwd, "remote", "add", "origin", remote);
        git(cwd, "push", "-qu", "origin", "main");
        git(cwd, "checkout", "-qb", "feature");
        git(cwd, "commit", "--allow-empty", "-qm", "feat: publish from GUI\n\nDetails");
        process.env.FAKE_PUBLISH_REMOTE = remote;
        process.env.FAKE_PUBLISH_STATE = `${cwd}-pr.json`;
        delete process.env.FAKE_PUBLISH_MODE;
        delete process.env.FAKE_PUBLISH_MOVE_HEAD;
        if (github) git(cwd, "remote", "set-url", "origin", "https://github.com/example/project.git");
        return { cwd, remote, state: process.env.FAKE_PUBLISH_STATE };
    };
    return { git, repo, calls: (state: string, suffix = ".calls"): string[][] => {
        try { return readFileSync(state + suffix, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); } catch { return []; }
    }, cleanup: () => {
        for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
        Object.assign(process.env, saved);
    } };
}
