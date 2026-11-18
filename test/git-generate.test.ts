// Drafted git text (src/server/git-generate.ts): what a pull request's model is shown, how its reply and a branch name
// are read back; and a commit to a new branch (git-commit.ts newBranch), the one a draft name is for.
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate } from "./helpers/isolate";

const iso = isolate();
const { branchName, gitPrPrompt, parsePrText, prTemplate, slug } = await import("../src/server/git-generate");
const { gitCommit } = await import("../src/server/git-commit");
const { gitArgv, gitEnv } = await import("../src/util/git");
afterAll(() => iso.cleanup());

const IDENTITY = ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "user.name=Cavvy Test", "-c", "user.email=test@example.invalid"];
function git(cwd: string, ...args: string[]): string {
    const r = Bun.spawnSync(gitArgv([...IDENTITY, ...args]), { cwd, env: gitEnv(), stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
    return r.stdout.toString();
}
let n = 0;
function repo(): string {
    const dir = join(realpathSync(iso.home), `gen-${n++}`);
    mkdirSync(dir);
    git(dir, "init", "-q", "-b", "main");
    git(dir, "config", "user.name", "Cavvy Test");
    git(dir, "config", "user.email", "test@example.invalid");
    git(dir, "config", "commit.gpgsign", "false");
    return dir;
}
const write = (dir: string, path: string, body: string) => {
    mkdirSync(join(dir, path, ".."), { recursive: true });
    writeFileSync(join(dir, path), body);
};
const commit = (dir: string, message: string) => {
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "--allow-empty", "-m", message);
};

describe("pull request text", () => {
    test("the prompt: the branch's commits, its stat and diff, and the template; secrets redacted", async () => {
        const dir = repo();
        write(dir, "a.txt", "one\n");
        commit(dir, "Initial commit");
        git(dir, "switch", "-q", "-c", "feat/login");
        write(dir, "a.txt", "one\ntwo\n");
        commit(dir, "Add the second line\n\nBecause one wasn't enough.");
        const key = "sk-ant-api03-" + "x".repeat(90);
        write(dir, "b.txt", `token = "${key}"\n`);
        commit(dir, "Add b");
        write(dir, ".github/PULL_REQUEST_TEMPLATE.md", "## Summary\n\n<!-- what and why -->\n\n## Testing\n");
        const prompt = await gitPrPrompt(dir, "main");
        expect(prompt).toContain("- Add b");
        expect(prompt).toContain("- Add the second line\n\nBecause one wasn't enough.");
        expect(prompt).not.toContain("Initial commit");
        expect(prompt).toMatch(/a\.txt \| 1 \+/);
        expect(prompt).toContain("+two");
        expect(prompt).not.toContain(key);
        expect(prompt).toContain("The repository's pull request template:\n## Summary");
        // No base it can find: the last commit alone.
        const last = await gitPrPrompt(dir, "nowhere");
        expect(last).toContain("- Add b");
        expect(last).not.toContain("Add the second line");
        // A name that could be an option is never passed on.
        expect(await gitPrPrompt(dir, "--output=x")).toContain("- Add b");
    });

    test("the template: any case, in the root, .github or docs, or the first of a folder of them; not through a link", async () => {
        const a = repo();
        expect(await prTemplate(a)).toBeUndefined();
        write(a, "docs/pull_request_template.md", "docs one");
        expect(await prTemplate(a)).toBe("docs one");
        write(a, ".github/PULL_REQUEST_TEMPLATE/z.md", "z");
        write(a, ".github/PULL_REQUEST_TEMPLATE/feature.md", "feature");
        expect(await prTemplate(a)).toBe("feature");
        const b = repo();
        write(b, "elsewhere.md", "outside");
        symlinkSync(join(b, "elsewhere.md"), join(b, "pull_request_template.md"));
        expect(await prTemplate(b)).toBeUndefined();
    });

    test("the reply: its first line the title, the rest the description", () => {
        expect(parsePrText("Add SSO login\n\n## Summary\nAdds it.")).toEqual({ title: "Add SSO login", body: "## Summary\nAdds it." });
        expect(parsePrText("Title: \"Add SSO login\"\nBody")).toEqual({ title: "Add SSO login", body: "Body" });
        expect(parsePrText("# **Add SSO**\n\nx")).toEqual({ title: "Add SSO", body: "x" });
        expect(parsePrText("```markdown\nFix it\n\nDone.\n```")).toEqual({ title: "Fix it", body: "Done." });
        expect(parsePrText("Only a title")).toEqual({ title: "Only a title", body: "" });
        expect(parsePrText("  \n")).toBeUndefined();
    });
});

describe("branch names", () => {
    test("words made a branch name, after the prefix setting", () => {
        expect(branchName("fix-login-redirect", "cavvy/")).toBe("cavvy/fix-login-redirect");
        expect(branchName("Branch: `Fix Login Redirect`", "cavvy/")).toBe("cavvy/fix-login-redirect");
        expect(branchName("cavvy/fix-login", "cavvy/")).toBe("cavvy/fix-login");
        expect(branchName("feature/add sso", "")).toBe("feature-add-sso");
        expect(branchName("Añadir caché", "me-")).toBe("me-anadir-cache");
        expect(branchName("fix it", "team x/..bad/")).toBe("team-x/bad/fix-it");
        expect(branchName("!!!", "cavvy/")).toBeUndefined();
        expect(slug("one two three four five six seven eight nine ten eleven twelve", 20)).toBe("one-two-three-four");
    });

    test("committing to a new branch: the commit goes there, it's checked out, and the old branch stays", async () => {
        const dir = repo();
        write(dir, "a.txt", "one\n");
        commit(dir, "Initial commit");
        const before = git(dir, "rev-parse", "main").trim();
        write(dir, "a.txt", "one\ntwo\n");
        write(dir, "other.txt", "left alone\n");
        const done = await gitCommit(dir, ["a.txt"], "Add two", { expectedHead: { branch: "main", detached: false }, newBranch: "cavvy/add-two" });
        expect(done.branch).toBe("cavvy/add-two");
        expect(git(dir, "rev-parse", "main").trim()).toBe(before);
        expect(git(dir, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/cavvy/add-two");
        expect(git(dir, "rev-parse", "HEAD^").trim()).toBe(before);
        expect(git(dir, "status", "--porcelain")).toBe("?? other.txt\n");
        expect(readFileSync(join(dir, "a.txt"), "utf-8")).toBe("one\ntwo\n");
        // A name that's taken, or not a name: refused, nothing moves.
        write(dir, "a.txt", "three\n");
        await expect(gitCommit(dir, ["a.txt"], "Three", { newBranch: "main" })).rejects.toThrow(/already exists/);
        await expect(gitCommit(dir, ["a.txt"], "Three", { newBranch: "bad..name" })).rejects.toThrow(/isn't a valid branch name/);
        expect(git(dir, "symbolic-ref", "HEAD").trim()).toBe("refs/heads/cavvy/add-two");
        expect(git(dir, "status", "--porcelain")).toBe(" M a.txt\n?? other.txt\n");
    });
});
