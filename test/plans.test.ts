import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, symlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, FAKE } from "./helpers/isolate";

const iso = isolate();
const { defaultPlanPath, implementPrompt, planTitle, slugify, writePlanFile, SAVE_MAX_BYTES } = await import("../src/server/plans");
const { Session, PLAN_MAX_CHARS } = await import("../src/agent/session");
const { registerSecret, unregisterSecret } = await import("../src/util/redact");
afterAll(() => iso.cleanup());
const root = realpathSync(iso.home);
const home = join(root, "home");
const cwd = join(root, "project");
const outside = join(root, "outside");
for (const dir of [home, cwd, outside]) mkdirSync(dir);
const save = (input: string, replace = false, text = "# Implement SSO") => writePlanFile({ cwd, home, input, text, replace });

describe("plan files without a server", () => {
    test("default path is private, collision-free, and separate from project files", () => {
        const options = { home, cwd, title: "Plan: Add SSO", date: new Date("2026-10-17T00:00:00Z") };
        const path = defaultPlanPath(options);
        expect(path).toBe(join(home, "plans", "project", "2026-10-17-plan-add-sso.md"));
        expect(save(path)).toBe(path);
        expect(statSync(path).mode & 0o777).toBe(0o600);
        expect(readFileSync(path, "utf8")).toBe("# Implement SSO\n");
        expect(defaultPlanPath(options)).toEndWith("-2.md");
    });

    test("project paths need explicit replacement", () => {
        const path = save("docs/plan.md");
        expect(path).toBe(join(cwd, "docs", "plan.md"));
        expect(() => save(path)).toThrow("already exists");
        writeFileSync(path, "original");
        expect(() => save(path)).toThrow("already exists");
        expect(readFileSync(path, "utf8")).toBe("original");
        save(path, true, "replacement");
        expect(readFileSync(path, "utf8")).toBe("replacement\n");
    });

    test("refuses traversal, external paths, Git metadata, and invalid names", () => {
        for (const path of ["../escape.md", "docs/../../escape.md", join(outside, "absolute.md"), ".git/x.md", "a/.GIT/x.md", "notes.txt", ".md"]) {
            expect(() => save(path)).toThrow();
        }
        expect(existsSync(join(root, "escape.md"))).toBe(false);
        expect(existsSync(join(outside, "absolute.md"))).toBe(false);
        expect(existsSync(join(cwd, ".git"))).toBe(false);
        expect(existsSync(join(cwd, "a"))).toBe(false);
        expect(() => save("huge.md", false, "x".repeat(SAVE_MAX_BYTES))).toThrow("too big");
        expect(existsSync(join(cwd, "huge.md"))).toBe(false);
    });

    test("refuses symlink files and parent directories, including replace", () => {
        symlinkSync(outside, join(cwd, "linked"));
        writeFileSync(join(outside, "existing.md"), "untouched");
        symlinkSync(join(outside, "existing.md"), join(cwd, "link.md"));
        symlinkSync(join(outside, "missing.md"), join(cwd, "dangling.md"));
        for (const path of ["linked/new.md", "link.md", "dangling.md"]) {
            expect(() => save(path)).toThrow();
            expect(() => save(path, true)).toThrow();
        }
        expect(readFileSync(join(outside, "existing.md"), "utf8")).toBe("untouched");
        expect(existsSync(join(outside, "new.md"))).toBe(false);
        expect(existsSync(join(outside, "missing.md"))).toBe(false);
    });

    test("a session rooted inside Git metadata cannot save there either", () => {
        const metadata = join(cwd, ".git", "nested");
        mkdirSync(metadata, { recursive: true });
        expect(() => writePlanFile({ cwd: metadata, home, input: "plan.md", text: "plan" })).toThrow(".git");
        expect(existsSync(join(metadata, "plan.md"))).toBe(false);
    });
});

test("plan titles and implementation context retain the source and worktree mapping", () => {
    expect(planTitle("Introduction\n# Plan: Add **SSO**\nSteps")).toBe("Add SSO");
    expect(slugify("Àdd SSO / authentication")).toBe("add-sso-authentication");
    const prompt = implementPrompt({ plan: "# Add SSO\nDo it", sessionId: "source-id", title: "Planning", from: "/repo/src", fromRoot: "/repo", path: "/repo/.claude/worktrees/sso", branch: "sso", base: "main", commit: "abcdef0123456789" });
    for (const text of ["Implement the plan", "source-id", "/repo/src", "Branch: sso", "main (abcdef012345)", "Paths in the plan under /repo mean the same files under /repo/.claude/worktrees/sso", "Uncommitted changes", "# Add SSO"]) expect(prompt).toContain(text);
});

test("plans and both link directions survive reload with secrets redacted", () => {
    registerSecret(FAKE.openai);
    try {
        const a = Session.create(cwd);
        const b = Session.create(cwd);
        for (const s of [a, b]) s.push({ role: "user", content: [{ type: "text", text: "plan" }] });
        a.addPlan("tool-id", `# Plan\n${FAKE.openai}`);
        const link = { folder: cwd, path: join(cwd, "worktree"), branch: "sso", base: "main", title: FAKE.openai, at: Date.now() };
        a.addPlanLink({ role: "to", session: b.meta.id, ...link, plan: "tool-id" });
        b.addPlanLink({ role: "from", session: a.meta.id, ...link });
        // A plan id that isn't a string isn't a link.
        b.addPlanLink({ role: "from", session: a.meta.id, ...link, plan: 7 as unknown as string });
        a.release();
        b.release();
        const reopened = [Session.load(a.path), Session.load(b.path)];
        expect(reopened[0]!.plans[0]!.text).not.toContain(FAKE.openai);
        expect(reopened[0]!.planLinks[0]).toMatchObject({ role: "to", session: b.meta.id, plan: "tool-id" });
        // From before links named their plan: still read.
        expect(reopened[1]!.planLinks[0]).toMatchObject({ role: "from", session: a.meta.id });
        expect(reopened[1]!.planLinks[0]!.plan).toBeUndefined();
        expect(reopened[1]!.planLinks).toHaveLength(1);
        for (const s of reopened) {
            expect(readFileSync(s.path, "utf8")).not.toContain(FAKE.openai);
            s.release();
        }
    } finally { unregisterSecret(FAKE.openai); }
});

test("the plan size cap cannot expose a truncated registered secret", () => {
    const secret = "qY7mT9aB3nK6vC8dF2sH5jL4";
    registerSecret(secret);
    try {
        const s = Session.create(cwd, { persist: false });
        const prefix = "x".repeat(PLAN_MAX_CHARS - 8);
        const plan = s.addPlan("large-plan", prefix + secret);
        expect(plan.text.length).toBeLessThanOrEqual(PLAN_MAX_CHARS);
        expect(plan.text).not.toContain(secret.slice(0, 8));
    } finally { unregisterSecret(secret); }
});
