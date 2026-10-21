// The harness's skills on Claude Code and Codex: handed to each CLI so it runs
// them itself (src/backends/native-skills.ts). The helpers on their own, then
// whole turns through the real Agent with the fake CLIs (test/fixtures).

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, rmSync, utimesSync, writeFileSync } from "fs";
import { join } from "path";
import { isolate, tempDir } from "./helpers/isolate";

const { cleanup, home } = isolate();
const registry = await import("../src/providers/registry");
const { clientFor, forgetClient } = await import("../src/providers/models");
const { Agent } = await import("../src/agent/agent");
const { Session } = await import("../src/agent/session");
const { PermissionChecker } = await import("../src/permissions/checker");
const { BUILTIN_TOOLS } = await import("../src/tools/index");
const trust = await import("../src/config/trust");
const { loadSkills } = await import("../src/agent/skills");
const native = await import("../src/backends/native-skills");

type Skill = import("../src/agent/skills").Skill;
type AgentEvent = import("../src/agent/agent").AgentEvent;

const bin = tempDir("fake-native-skills-");
const LOG = join(bin, "log.jsonl");
function wrapper(name: string, fixture: string): string {
    const p = join(bin, name);
    writeFileSync(p, `#!/bin/sh\nexec "${process.execPath}" "${join(import.meta.dir, "fixtures", fixture)}" "$@"\n`);
    chmodSync(p, 0o755);
    return p;
}
const claudeBin = wrapper("claude", "fake-claude.ts");
const codexBin = wrapper("codex", "fake-codex.ts");

afterAll(() => {
    cleanup();
    rmSync(bin, { recursive: true, force: true });
    for (const k of Object.keys(process.env)) if (k.startsWith("FAKE_")) delete process.env[k];
});

let cwd: string;
beforeEach(() => {
    cwd = realpathSync(tempDir("native-skills-proj-"));
    rmSync(LOG, { force: true });
    process.env.FAKE_LOG = LOG;
    for (const k of ["FAKE_NO_SKILLS", "FAKE_CODEX_SKILL", "FAKE_SLASH_COMMANDS"]) delete process.env[k];
    for (const d of [join(home, "skills"), join(process.env.CLAUDE_CONFIG_DIR!, "skills")]) rmSync(d, { recursive: true, force: true });
    registry.saveAgentConfig("claude-code", { path: claudeBin });
    registry.saveAgentConfig("codex", { path: codexBin });
    forgetClient("claude-code");
    forgetClient("codex");
});

function skill(root: string, name: string, front: string, body: string): string {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), `---\n${front}\n---\n${body}\n`);
    return dir;
}
const userRoot = () => join(home, "skills");
const claudeRoot = () => join(process.env.CLAUDE_CONFIG_DIR!, "skills");

function fake(name: string, extra: Partial<Skill> = {}): Skill {
    const dir = skill(tempDir("fake-skill-"), name, `description: ${name} does things`, `Body of ${name}.`);
    return { name, description: `${name} does things`, modelInvocable: true, userInvocable: true, source: "user", file: join(dir, "SKILL.md"), dir, ...extra };
}

const logLines = (): any[] => (existsSync(LOG) ? readFileSync(LOG, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const received = () => logLines().flatMap((l) => (l.received ? [l.received] : []));

describe("the folder the CLIs are given", () => {
    test("a Claude Code plugin whose skills link to each skill's own folder", () => {
        const a = fake("alpha");
        const dir = native.skillFolder([a], { plugin: true })!;
        expect(JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8")).name).toBe("harness");
        expect(lstatSync(join(dir, "skills", "alpha")).isSymbolicLink()).toBe(true);
        expect(readlinkSync(join(dir, "skills", "alpha"))).toBe(a.dir);
        expect(readFileSync(join(dir, "skills", "alpha", "SKILL.md"), "utf-8")).toContain("Body of alpha.");
    });

    test("the same skills give the same folder; an edited SKILL.md a new one", () => {
        const a = fake("alpha");
        const b = fake("beta");
        const first = native.skillFolder([a, b]);
        expect(native.skillFolder([b, a])).toBe(first);
        utimesSync(a.file, new Date(), new Date(Date.now() + 5000));
        const second = native.skillFolder([a, b]);
        expect(second).not.toBe(first);
        expect(existsSync(join(second!, "skills", "beta"))).toBe(true);
    });

    test("no skills, no folder", () => {
        expect(native.skillFolder([])).toBeUndefined();
    });

    test("${HARNESS_SKILL_DIR}, which neither CLI fills in, is filled in; the skill's other files are still beside it", () => {
        const s = fake("tools");
        writeFileSync(s.file, "---\ndescription: x\n---\nRun ${HARNESS_SKILL_DIR}/run.sh, or ${CLAUDE_SKILL_DIR}/run.sh.\n");
        writeFileSync(join(s.dir, "run.sh"), "echo hi\n");
        mkdirSync(join(s.dir, "refs"));
        const dir = native.skillFolder([s])!;
        const at = join(dir, "skills", "tools");
        expect(lstatSync(at).isDirectory()).toBe(true);
        expect(readFileSync(join(at, "SKILL.md"), "utf-8")).toContain(`Run ${s.dir}/run.sh, or ${s.dir}/run.sh.`);
        expect(readlinkSync(join(at, "run.sh"))).toBe(join(s.dir, "run.sh"));
        expect(readlinkSync(join(at, "refs"))).toBe(join(s.dir, "refs"));
    });

    test("a plugin's skill (plugin:name) gets a folder name every system allows", () => {
        const s = fake("lint", { name: "acme:lint", source: "plugin" });
        expect(existsSync(join(native.skillFolder([s])!, "skills", "acme__lint", "SKILL.md"))).toBe(true);
    });

    test("folders unused for a day are removed, without touching the skills they link to", () => {
        const a = fake("alpha");
        const c = fake("tools");
        writeFileSync(c.file, "---\ndescription: x\n---\n${HARNESS_SKILL_DIR}/run.sh\n");
        writeFileSync(join(c.dir, "run.sh"), "echo\n");
        const old = native.skillFolder([a, c])!;
        const recent = native.skillFolder([a])!;
        const dayAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
        utimesSync(old, dayAgo, dayAgo);
        native.skillFolder([c]);
        expect(existsSync(old)).toBe(false);
        expect(existsSync(recent)).toBe(true);
        expect(readFileSync(a.file, "utf-8")).toContain("Body of alpha.");
        expect(existsSync(join(c.dir, "run.sh"))).toBe(true);
    });

    test("a skill whose SKILL.md is gone is left out, the rest are there", () => {
        const a = fake("alpha");
        const gone = fake("gone");
        rmSync(gone.file);
        const dir = native.skillFolder([a, gone])!;
        expect(existsSync(join(dir, "skills", "alpha"))).toBe(true);
    });
});

describe("Claude Code", () => {
    test("is given only the skills it doesn't read itself", () => {
        const project = { ...fake("p1"), source: "project" as const };
        const mine = fake("u1");
        const ccOwn = { ...fake("c1"), dir: join(claudeRoot(), "c1") };
        const ccProject = { ...fake("c2"), dir: join(cwd, ".claude", "skills", "c2"), source: "project" as const };
        const plugin = { ...fake("x"), name: "acme:x", source: "plugin" as const };
        const all = [project, mine, ccOwn, ccProject, plugin];
        expect(native.forClaudeCode(all, cwd, true).map((s) => s.name)).toEqual(["p1", "u1"]);
        // Untrusted (by the user, the session's list may come from implicit trust), a project's skills aren't put in.
        expect(native.forClaudeCode(all, cwd, false).map((s) => s.name)).toEqual(["u1"]);
        // Another account's config folder: ~/.claude/skills isn't its own.
        expect(native.forClaudeCode(all, cwd, true, tempDir("other-account-")).map((s) => s.name)).toEqual(["p1", "u1", "c1"]);
        // What it calls each: its own as they are, ours as harness:<name>; a plugin's and an untrusted project's it doesn't have.
        expect([...native.claudeNames(all, [project, mine], cwd, true)]).toEqual([["c1", "c1"], ["c2", "c2"], ["p1", "harness:p1"], ["u1", "harness:u1"]]);
        expect([...native.claudeNames(all, [mine], cwd, false)]).toEqual([["c1", "c1"], ["u1", "harness:u1"]]);
    });

    const format = (s: Skill, args: string) => `<skill ${s.name}${args ? ` ${args}` : ""}>`;
    const ours = fake("deploy");
    const theirs = { ...fake("review"), dir: join(claudeRoot(), "review") };
    const quiet = fake("secret", { modelInvocable: false });
    const skills = [ours, theirs, quiet];
    const plugged = new Map([["deploy", "harness:deploy"], ["secret", "harness:secret"], ["review", "review"]]);

    test("/name runs one of ours as /harness:name, its own as typed", () => {
        expect(native.claudePrompt("/deploy prod now", "/deploy prod now", skills, plugged, format)).toBe("/harness:deploy prod now");
        expect(native.claudePrompt("/DEPLOY", "/DEPLOY", skills, plugged, format)).toBe("/harness:deploy");
        expect(native.claudePrompt("/review high", "/review high", skills, plugged, format)).toBe("/review high");
        expect(native.claudePrompt("/compact", "/compact", skills, plugged, format)).toBe("/compact");
        expect(native.claudePrompt("/usr/bin/foo is broken", "/usr/bin/foo is broken", skills, plugged, format)).toBe("/usr/bin/foo is broken");
    });

    test("a /name after the conversation so far can't run as a command: the skill's text goes in", () => {
        const prompt = "<conversation-so-far>…</conversation-so-far>\n\n/deploy prod";
        expect(native.claudePrompt(prompt, "/deploy prod", skills, plugged, format)).toBe("<conversation-so-far>…</conversation-so-far>\n\n<skill deploy prod>");
    });

    test("$name asks it to load the skill with its Skill tool; one the model may not load goes in as text", () => {
        expect(native.claudePrompt("use $deploy and $review.", "use $deploy and $review.", skills, plugged, format)).toBe(
            'use $deploy and $review.\n\nLoad the "harness:deploy" skill with the Skill tool and follow it.\n\nLoad the "review" skill with the Skill tool and follow it.',
        );
        expect(native.claudePrompt("try $secret", "try $secret", skills, plugged, format)).toBe("try $secret\n\n<skill secret>");
        expect(native.claudePrompt("costs $5, see $HOME", "costs $5, see $HOME", skills, plugged, format)).toBe("costs $5, see $HOME");
    });

    test("one it doesn't have (the plugin couldn't be made, an untrusted project's) goes in as text", () => {
        const none = new Map<string, string>();
        expect(native.claudePrompt("/deploy prod", "/deploy prod", skills, none, format)).toBe("<skill deploy prod>");
        expect(native.claudePrompt("try $deploy", "try $deploy", skills, none, format)).toBe("try $deploy\n\n<skill deploy>");
    });

    test("without the user's message (a hook's follow-up), the prompt is left alone", () => {
        expect(native.claudePrompt("/deploy", undefined, skills, plugged, format)).toBe("/deploy");
        expect(native.claudePrompt("/deploy", "something else", skills, plugged, format)).toBe("/deploy");
    });
});

describe("Codex", () => {
    const own = { name: "imagegen", path: "/codex/skills/imagegen/SKILL.md" };

    test("/name becomes $name, and each skill named is sent as a skill item", () => {
        const skills = [own, { name: "deploy", path: "/h/deploy/SKILL.md" }];
        expect(native.codexInput("/deploy prod", "/deploy prod", skills)).toEqual({ text: "$deploy prod", items: [{ type: "skill", name: "deploy", path: "/h/deploy/SKILL.md" }] });
        expect(native.codexInput("make $imagegen art, then $deploy; $imagegen again", "make $imagegen art, then $deploy; $imagegen again", skills).items.map((i) => i.name)).toEqual(["imagegen", "deploy"]);
        expect(native.codexInput("/unknown x and $HOME, $5", "/unknown x and $HOME, $5", skills)).toEqual({ text: "/unknown x and $HOME, $5", items: [] });
    });

    test("the conversation so far stays in front; a disabled skill isn't sent", () => {
        const skills = [{ ...own, enabled: false }, { name: "deploy", path: "/h/deploy/SKILL.md" }];
        expect(native.codexInput("earlier\n\n/deploy", "/deploy", skills).text).toBe("earlier\n\n$deploy");
        expect(native.codexInput("$imagegen", "$imagegen", skills).items).toEqual([]);
    });

    test("one of ours Codex didn't list (it skipped it, or it isn't registered) goes in as text", () => {
        const s = fake("nofront");
        writeFileSync(s.file, "Just do $ARGUMENTS.\n");
        expect(native.codexInput("/nofront it", "/nofront it", [own], [s])).toEqual({ text: "<skill name=\"nofront\">\nBase directory for this skill: " + s.dir + "\n\nJust do it.\n</skill>", items: [] });
        const mixed = native.codexInput("x $nofront and $imagegen", "x $nofront and $imagegen", [own], [s]);
        expect(mixed.items.map((i) => i.name)).toEqual(["imagegen"]);
        expect(mixed.text).toStartWith("x $nofront and $imagegen\n\n<skill name=\"nofront\">");
    });

    test("one of ours goes by its harness name too; Codex's own are listed for the menus", () => {
        const s = fake("lint", { name: "acme:lint", source: "plugin" });
        const folder = native.skillFolder([s])!;
        // Codex doesn't name them harness:<name> (it would, given Claude Code's plugin manifest).
        expect(existsSync(join(folder, ".claude-plugin"))).toBe(false);
        const listed = [own, { name: "lint", path: realpathSync(s.file) }];
        const { skills, own: theirs } = native.codexSkills(listed, [s], folder);
        expect(theirs).toEqual(["imagegen"]);
        expect(native.codexInput("$acme:lint now", "$acme:lint now", skills).items).toEqual([{ type: "skill", name: "lint", path: realpathSync(s.file) }]);
    });

    test("one whose SKILL.md the folder fills in is known by the folder's copy, where Codex reads it", () => {
        const s = fake("tools");
        writeFileSync(s.file, "---\ndescription: x\n---\nRun ${HARNESS_SKILL_DIR}/run.sh\n");
        const folder = native.skillFolder([s])!;
        const copy = realpathSync(native.skillFile(folder, s));
        expect(copy).not.toBe(realpathSync(s.file));
        const { skills, own } = native.codexSkills([{ name: "tools", path: copy }], [s], folder);
        expect(own).toEqual([]);
        expect(native.codexInput("/tools", "/tools", skills).items).toEqual([{ type: "skill", name: "tools", path: copy }]);
    });
});

async function runTurn(provider: "claude-code" | "codex", text: string, opts: { trusted?: boolean; skills?: () => Skill[] } = {}) {
    if (opts.trusted) trust.trustFolder(cwd);
    else trust.trustForSession(cwd);
    const events: AgentEvent[] = [];
    let mode: any = "default";
    const settings = {};
    const agent = new Agent({
        session: Session.create(cwd, { persist: false }),
        model: { provider, id: "default" } as any,
        client: await clientFor(provider),
        settings: () => settings,
        skills: opts.skills ?? (() => loadSkills(cwd, trust.isTrusted(cwd))),
        checker: new PermissionChecker(() => settings, cwd),
        tools: BUILTIN_TOOLS,
        mode: { get: () => mode, set: (m) => (mode = m) },
        toolState: { cwd, projectRoot: cwd, fileState: new Map(), todos: [], shells: new Map() },
        host: { drainQueued: () => [], emit: (e) => events.push(e), ui: {}, askPermission: async () => ({ allow: true }) as any },
    } as any);
    const reason = await agent.run([{ type: "text", text }], { signal: new AbortController().signal });
    return { reason, events };
}

describe("a whole turn", () => {
    test("Claude Code: our skills come as a plugin and /name runs one there; its menu list leaves them out", async () => {
        skill(userRoot(), "deploy", "description: Ship it", "Deploy steps.");
        skill(claudeRoot(), "review", "description: Its own", "Review steps.");
        const { events } = await runTurn("claude-code", "/deploy prod");
        const argv: string[] = logLines().find((l) => l.argv && l.argv.includes("--plugin-dir"))!.argv;
        const dir = argv[argv.indexOf("--plugin-dir") + 1]!;
        expect(existsSync(join(dir, "skills", "deploy", "SKILL.md"))).toBe(true);
        // Claude Code reads its own folder itself.
        expect(existsSync(join(dir, "skills", "review"))).toBe(false);
        const sent = received().filter((m) => m.type === "user").map((m) => m.message.content[0].text);
        expect(sent).toEqual(["/harness:deploy prod"]);
        const listed = events.flatMap((e) => (e.type === "cli_commands" ? e.names : []));
        expect(listed).toContain("code-review");
        expect(listed.some((n) => n.startsWith("harness:"))).toBe(false);
    });

    test("Claude Code in an untrusted folder: the user's own skills, not the project's", async () => {
        skill(userRoot(), "mine", "description: Mine", "Mine.");
        skill(join(cwd, ".harness", "skills"), "repo", "description: The repo's", "Repo.");
        await runTurn("claude-code", "hi");
        const argv: string[] = logLines().find((l) => l.argv && l.argv.includes("--plugin-dir"))!.argv;
        const dir = argv[argv.indexOf("--plugin-dir") + 1]!;
        expect(existsSync(join(dir, "skills", "mine"))).toBe(true);
        expect(existsSync(join(dir, "skills", "repo"))).toBe(false);
    });

    test("a project's skill under trust for this session only isn't registered, and still runs: its text is sent", async () => {
        // The session's list has it (the folder had nothing to protect when it was opened).
        skill(join(cwd, ".harness", "skills"), "repo", "description: The repo's", "Repo steps for $ARGUMENTS.");
        const skills = () => loadSkills(cwd, true);
        await runTurn("claude-code", "/repo now", { skills });
        expect(received().filter((m) => m.type === "user").map((m) => m.message.content[0].text)).toEqual(["Repo steps for now."].map((t) => expect.stringContaining(t)) as any);
        expect(logLines().some((l) => l.argv?.includes("--plugin-dir"))).toBe(false);
        rmSync(LOG, { force: true });
        await runTurn("codex", "/repo now", { skills });
        const roots = received().find((m) => m.method === "skills/extraRoots/set")!.params.extraRoots;
        expect(roots).toEqual([]);
        expect(received().find((m) => m.method === "turn/start")!.params.input[0].text).toContain("Repo steps for now.");
    });

    test("Claude Code with no skills of ours gets no plugin", async () => {
        await runTurn("claude-code", "hi");
        expect(logLines().some((l) => l.argv?.includes("--plugin-dir"))).toBe(false);
    });

    test("Codex: our skills are an extra skills root; /name and $name are skill items; its own skills reach the menus", async () => {
        process.env.FAKE_CODEX_SKILL = "imagegen";
        skill(userRoot(), "deploy", "description: Ship it", "Deploy steps.");
        skill(join(cwd, ".harness", "skills"), "repo", "description: The repo's", "Repo.");
        const { events } = await runTurn("codex", "/deploy prod with $imagegen", { trusted: true });
        const roots = received().find((m) => m.method === "skills/extraRoots/set")!.params.extraRoots;
        expect(roots).toHaveLength(1);
        expect(existsSync(join(roots[0], "deploy", "SKILL.md")) && existsSync(join(roots[0], "repo", "SKILL.md"))).toBe(true);
        const input = received().find((m) => m.method === "turn/start")!.params.input;
        expect(input[0].text).toEndWith("$deploy prod with $imagegen");
        expect(input.slice(1)).toEqual([
            { type: "skill", name: "deploy", path: realpathSync(join(userRoot(), "deploy", "SKILL.md")) },
            { type: "skill", name: "imagegen", path: "/codex/skills/imagegen/SKILL.md" },
        ]);
        // Set before the thread starts, so its first turn has them.
        const order = received().map((m) => m.method);
        expect(order.indexOf("skills/extraRoots/set")).toBeLessThan(order.indexOf("thread/start"));
        expect(events.flatMap((e) => (e.type === "cli_commands" ? e.names : []))).toEqual(["imagegen"]);
    });

    test("Codex in an untrusted folder: the project's skills aren't registered", async () => {
        skill(userRoot(), "mine", "description: Mine", "Mine.");
        skill(join(cwd, ".harness", "skills"), "repo", "description: The repo's", "Repo.");
        await runTurn("codex", "hi");
        const roots = received().find((m) => m.method === "skills/extraRoots/set")!.params.extraRoots;
        expect(existsSync(join(roots[0], "mine"))).toBe(true);
        expect(existsSync(join(roots[0], "repo"))).toBe(false);
    });

    test("an older Codex without the skills API: the skill's text is sent, as before", async () => {
        process.env.FAKE_NO_SKILLS = "1";
        skill(userRoot(), "deploy", "description: Ship it", "Deploy steps for $ARGUMENTS.");
        const { reason } = await runTurn("codex", "/deploy prod");
        expect(reason).not.toBe("error");
        const input = received().find((m) => m.method === "turn/start")!.params.input;
        expect(input[0].text).toContain("Deploy steps for prod.");
        expect(input).toHaveLength(1);
    });
});
