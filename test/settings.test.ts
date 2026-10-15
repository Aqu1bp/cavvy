import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const iso = isolate();
const settings = await import("../src/config/settings");
const trust = await import("../src/config/trust");
const { expandCommand, loadCustomCommands } = await import("../src/commands/custom");
const { paths } = await import("../src/config/paths");
import type { Settings } from "../src/config/settings";

const ROOT = tempDir("harness-settings-");
afterAll(() => {
    rmSync(ROOT, { recursive: true, force: true });
    iso.cleanup();
});
let n = 0;
const project = () => {
    const d = join(ROOT, `proj${++n}`);
    mkdirSync(d, { recursive: true });
    return d;
};

function write(file: string, data: unknown) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, typeof data === "string" ? data : JSON.stringify(data, null, 2));
}
const read = (file: string) => JSON.parse(readFileSync(file, "utf-8"));

const USER: Settings = {
    model: "anthropic:user-model",
    effort: "low",
    autoCompact: true,
    permissions: { allow: ["Read"], deny: ["Bash(rm:*)"], defaultMode: "default", additionalDirectories: ["/from/user"] },
    env: { A: "user", B: "user" },
    mcpServers: { s1: { command: "user-s1" } },
    hooks: { PreToolUse: [{ command: "user-hook" }] },
};
const PROJECT: Settings = {
    model: "anthropic:project-model",
    permissions: { allow: ["Edit"], ask: ["Bash(git push:*)"], deny: ["Read(./.env)"], defaultMode: "acceptEdits", additionalDirectories: ["/from/project"] },
    env: { B: "project", C: "project" },
    mcpServers: { s1: { command: "project-s1" }, s2: { command: "project-s2" } },
    hooks: { PreToolUse: [{ command: "project-hook" }], Stop: [{ command: "project-stop" }] },
    enableAllProjectMcpServers: true,
};
const LOCAL: Settings = {
    model: "anthropic:local-model",
    autoCompact: false,
    permissions: { allow: ["WebFetch"], deny: ["Bash(curl:*)"], ask: ["Write"], allowBypass: true },
    env: { C: "local" },
};

describe("settings scopes", () => {
    test("paths per scope", () => {
        const cwd = "/some/project";
        expect(settings.settingsPath("user", cwd)).toBe(join(iso.home, "settings.json"));
        expect(settings.settingsPath("project", cwd)).toBe("/some/project/.harness/settings.json");
        expect(settings.settingsPath("local", cwd)).toBe("/some/project/.harness/settings.local.json");
    });

    test("trusted: user < project < local; lists concatenate, objects merge", () => {
        const cwd = project();
        write(paths.userSettings(), USER);
        write(paths.projectSettings(cwd), PROJECT);
        write(paths.localSettings(cwd), LOCAL);
        const s = settings.loadSettings(cwd);
        expect(s).toEqual({
            model: "anthropic:local-model",
            effort: "low",
            autoCompact: false,
            enableAllProjectMcpServers: true,
            permissions: {
                allow: ["Read", "Edit", "WebFetch"],
                deny: ["Bash(rm:*)", "Read(./.env)", "Bash(curl:*)"],
                ask: ["Bash(git push:*)", "Write"],
                additionalDirectories: ["/from/user", "/from/project"],
                defaultMode: "acceptEdits",
                allowBypass: true,
            },
            env: { A: "user", B: "project", C: "local" },
            mcpServers: { s1: { command: "project-s1" }, s2: { command: "project-s2" } },
            hooks: { PreToolUse: [{ command: "user-hook" }, { command: "project-hook" }], Stop: [{ command: "project-stop" }] },
        });
        // trusted defaults to true
        expect(settings.loadSettings(cwd, { trusted: true })).toEqual(s);
        rmSync(paths.userSettings());
    });

    test("untrusted: project files contribute only deny/ask rules", () => {
        const cwd = project();
        write(paths.userSettings(), USER);
        write(paths.projectSettings(cwd), PROJECT);
        const s = settings.loadSettings(cwd, { trusted: false });
        expect(s.model).toBe("anthropic:user-model");
        expect(s.enableAllProjectMcpServers).toBeUndefined();
        expect(s.permissions).toEqual({
            allow: ["Read"],
            deny: ["Bash(rm:*)", "Read(./.env)"],
            ask: ["Bash(git push:*)"],
            defaultMode: "default",
            additionalDirectories: ["/from/user"],
        });
        expect(s.env).toEqual({ A: "user", B: "user" });
        expect(s.mcpServers).toEqual({ s1: { command: "user-s1" } });
        expect(s.hooks).toEqual({ PreToolUse: [{ command: "user-hook" }] });
        rmSync(paths.userSettings());
    });

    test("untrusted: deny/ask rules in settings.local.json still apply; its allow rules don't", () => {
        // /permissions offers "This project, just me" (local) in any folder, so a
        // deny rule saved there before trusting the folder must still be enforced.
        const cwd = project();
        write(paths.localSettings(cwd), LOCAL);
        const s = settings.loadSettings(cwd, { trusted: false });
        expect(s.permissions?.allow ?? []).not.toContain("WebFetch");
        expect(s.permissions?.allowBypass).toBeUndefined();
        expect(s.model).toBeUndefined();
        expect(s.permissions?.deny ?? []).toContain("Bash(curl:*)");
        expect(s.permissions?.ask ?? []).toContain("Write");
    });

    test("no files: empty settings", () => {
        const cwd = project();
        expect(settings.loadSettings(cwd)).toEqual({});
        expect(settings.loadSettings(cwd, { trusted: false })).toEqual({ permissions: {} });
    });

    test("JSON with comments is accepted; strings containing // are preserved", () => {
        const cwd = project();
        write(
            paths.projectSettings(cwd),
            `{
  // line comment
  "model": "openai:gpt-6-sol", /* block
  comment */
  "env": { "URL": "http://example.com//path", "Q": "a \\" // not a comment" }
}`,
        );
        expect(settings.loadScope("project", cwd)).toEqual({ model: "openai:gpt-6-sol", env: { URL: "http://example.com//path", Q: 'a " // not a comment' } });
    });

    test("invalid JSON warns and is treated as empty", () => {
        const cwd = project();
        write(paths.projectSettings(cwd), "{ not json");
        const orig = process.stderr.write.bind(process.stderr);
        const errs: string[] = [];
        process.stderr.write = ((chunk: string) => (errs.push(String(chunk)), true)) as typeof process.stderr.write;
        try {
            expect(settings.loadScope("project", cwd)).toEqual({});
        } finally {
            process.stderr.write = orig;
        }
        expect(errs.join("")).toContain("isn't valid JSON, so it's being ignored");
        expect(errs.join("")).toContain(paths.projectSettings(cwd));
    });
});

describe("permission rules", () => {
    test("addPermissionRule creates the file, dedupes, and keeps other keys", () => {
        const cwd = project();
        write(paths.projectSettings(cwd), { model: "keep:me", permissions: { defaultMode: "plan" } });
        settings.addPermissionRule("project", cwd, "allow", "Bash(git status)");
        settings.addPermissionRule("project", cwd, "allow", "Bash(git status)");
        settings.addPermissionRule("project", cwd, "deny", "WebFetch");
        expect(read(paths.projectSettings(cwd))).toEqual({ model: "keep:me", permissions: { defaultMode: "plan", allow: ["Bash(git status)"], deny: ["WebFetch"] } });
    });

    test("local scope also writes .harness/.gitignore (once)", () => {
        const cwd = project();
        settings.addPermissionRule("local", cwd, "ask", "Write");
        expect(read(paths.localSettings(cwd))).toEqual({ permissions: { ask: ["Write"] } });
        const gi = join(cwd, ".harness", ".gitignore");
        expect(readFileSync(gi, "utf-8")).toBe("settings.local.json\n");
        writeFileSync(gi, "custom\n");
        settings.addPermissionRule("local", cwd, "ask", "Edit");
        expect(readFileSync(gi, "utf-8")).toBe("custom\n");
        // project scope does not create it
        const other = project();
        settings.addPermissionRule("project", other, "ask", "Write");
        expect(existsSync(join(other, ".harness", ".gitignore"))).toBe(false);
    });

    test("user scope writes under HARNESS_HOME", () => {
        const cwd = project();
        settings.addPermissionRule("user", cwd, "deny", "Bash(sudo:*)");
        expect(read(paths.userSettings())).toEqual({ permissions: { deny: ["Bash(sudo:*)"] } });
        expect(paths.userSettings().startsWith(iso.home)).toBe(true);
        rmSync(paths.userSettings());
    });

    test("removePermissionRule removes the rule from every list", () => {
        const cwd = project();
        write(paths.localSettings(cwd), { permissions: { allow: ["X", "Y"], deny: ["X"], ask: ["Z"] } });
        expect(settings.removePermissionRule("local", cwd, "X")).toBe(true);
        expect(read(paths.localSettings(cwd))).toEqual({ permissions: { allow: ["Y"], deny: [], ask: ["Z"] } });
        expect(settings.removePermissionRule("local", cwd, "X")).toBe(false);
        expect(settings.removePermissionRule("local", project(), "nothing")).toBe(false);
    });

    test("a rule added to a scope shows up in loadSettings", () => {
        const cwd = project();
        settings.addPermissionRule("project", cwd, "deny", "Bash(rm -rf:*)");
        expect(settings.loadSettings(cwd).permissions?.deny).toEqual(["Bash(rm -rf:*)"]);
        expect(settings.loadSettings(cwd, { trusted: false }).permissions?.deny).toEqual(["Bash(rm -rf:*)"]);
    });
});

describe("folder trust", () => {
    const trustFile = () => join(iso.home, "trusted.json");

    test("trustFolder persists the folder (0600) and trust covers subfolders only", () => {
        const dir = project();
        expect(trust.isTrusted(dir)).toBe(false);
        trust.trustFolder(dir);
        expect(read(trustFile())).toEqual({ dirs: [dir] });
        expect(statSync(trustFile()).mode & 0o777).toBe(0o600);
        expect(trust.isTrusted(dir)).toBe(true);
        expect(trust.isTrusted(join(dir, "src", "deep"))).toBe(true);
        expect(trust.isTrusted(join(dir, "..", "proj-other"))).toBe(false);
        expect(trust.isTrusted(`${dir}-sibling`)).toBe(false);
        expect(trust.isTrusted(dirname(dir))).toBe(false);
        expect(trust.isTrusted(join(dir, "sub", "..", "..", "escape"))).toBe(false);
    });

    test("paths are normalized, deduplicated and sorted", () => {
        const a = project();
        const b = project();
        trust.trustFolder(`${b}/`);
        trust.trustFolder(join(a, "x", ".."));
        trust.trustFolder(a);
        const dirs: string[] = read(trustFile()).dirs;
        expect(dirs).toContain(a);
        expect(dirs).toContain(b);
        expect(dirs.filter((d) => d === a)).toHaveLength(1);
        expect([...dirs].sort()).toEqual(dirs);
    });

    test("trustForSession is not persisted", () => {
        const dir = project();
        trust.trustForSession(dir);
        expect(trust.isTrusted(dir)).toBe(true);
        expect(read(trustFile()).dirs).not.toContain(dir);
    });

    test("trustForSession covers that folder, not the projects inside it", () => {
        const parent = project();
        const child = join(parent, "repo");
        mkdirSync(child);
        trust.trustForSession(parent);
        expect(trust.isTrusted(parent)).toBe(true);
        expect(trust.isTrusted(child)).toBe(false);
        expect(trust.trustedByUser(parent)).toBe(false);
        // The user's own trust still covers what's inside.
        trust.trustFolder(parent);
        expect(trust.isTrusted(child)).toBe(true);
    });

    test("home and / are trusted for the session only (child process)", () => {
        const proc = Bun.spawnSync([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures", "trust-session-only.ts")], {
            cwd: ROOT,
            env: { ...process.env, HARNESS_HOME: project(), HARNESS_NO_KEYCHAIN: "1" },
        });
        expect(proc.stderr.toString()).toBe("");
        expect(proc.exitCode).toBe(0);
        const r = JSON.parse(proc.stdout.toString());
        expect(r.before).toEqual({ home: false, elsewhere: false });
        expect(r.afterHome).toEqual({ home: true, homeChild: true, elsewhere: false, file: null });
        expect(r.afterRoot).toEqual({ elsewhere: true, file: null });
    });

    test("projectConfigSummary lists what trust would unlock", () => {
        const cwd = project();
        expect(trust.projectConfigSummary(cwd)).toEqual([]);
        write(paths.projectSettings(cwd), {});
        write(paths.localSettings(cwd), {});
        write(paths.projectMcp(cwd), {});
        mkdirSync(paths.projectCommands(cwd), { recursive: true });
        mkdirSync(paths.projectAgents(cwd), { recursive: true });
        expect(trust.projectConfigSummary(cwd)).toEqual([".harness/settings.json", ".harness/settings.local.json", ".mcp.json", ".harness/commands/", ".harness/agents/"]);
    });
});

describe("custom commands", () => {
    test("$ARGUMENTS is replaced with the whole argument string", () => {
        expect(expandCommand("Review: $ARGUMENTS. Again: $ARGUMENTS", "the auth module")).toBe("Review: the auth module. Again: the auth module");
    });

    test("$1..$9 use shell-like word splitting with quotes", () => {
        expect(expandCommand("Compare $1 with $2 (third: $3)", `"foo bar" 'baz qux' plain`)).toBe("Compare foo bar with baz qux (third: plain)");
        expect(expandCommand("a=$1 b=$2", "only-one")).toBe("a=only-one b=");
        expect(expandCommand("$1-$2", `"" x`)).toBe("-x");
    });

    test("$10 and $1abc are not positional placeholders", () => {
        expect(expandCommand("x $10 $1abc $1.", "A")).toBe("x $10 $1abc A.");
    });

    test("arguments are appended when the body has no placeholder", () => {
        expect(expandCommand("Do the thing.", "with care")).toBe("Do the thing.\n\nArguments: with care");
        expect(expandCommand("Do the thing.", "")).toBe("Do the thing.");
        expect(expandCommand("Only $1 here", "a b")).toBe("Only a here");
    });

    test("$ in the arguments is inserted literally", () => {
        // String.replace treats $&, $$, $' in a replacement string as patterns,
        // and the positional pass then rewrites $N inside the inserted text.
        expect(expandCommand("Echo: $ARGUMENTS", "price is $5")).toBe("Echo: price is $5");
        expect(expandCommand("Echo: $ARGUMENTS", "costs $$ and $& here")).toBe("Echo: costs $$ and $& here");
        expect(expandCommand("Echo: $ARGUMENTS", "use $1 in bash")).toBe("Echo: use $1 in bash");
    });

    test("loadCustomCommands: user commands, namespacing, and project overrides only when trusted", () => {
        const cwd = project();
        write(join(paths.userCommands(), "review.md"), "---\ndescription: Review code\nargument-hint: [file]\n---\nReview $1 carefully.\n");
        write(join(paths.userCommands(), "git", "pr.md"), "Open a PR against $1\n");
        write(join(paths.projectCommands(cwd), "review.md"), "---\ndescription: Project review\n---\nProject-specific review of $ARGUMENTS\n");
        const untrusted = loadCustomCommands(cwd, false);
        expect(untrusted.map((c) => `${c.name}:${c.source}`)).toEqual(["git:pr:user", "review:user"]);
        expect(untrusted.find((c) => c.name === "review")).toMatchObject({ description: "Review code", argumentHint: "[file]", body: "Review $1 carefully." });
        expect(untrusted.find((c) => c.name === "git:pr")!.description).toBe("Open a PR against $1");
        const trusted = loadCustomCommands(cwd, true);
        expect(trusted.find((c) => c.name === "review")).toMatchObject({ source: "project", description: "Project review" });
        rmSync(paths.userCommands(), { recursive: true, force: true });
    });
});
